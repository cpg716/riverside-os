import { useMemo, useState } from "react";
import {
  Barcode,
  CheckCircle2,
  CircleDollarSign,
  Printer,
  RefreshCw,
  ScanLine,
  Settings2,
} from "lucide-react";
import {
  checkReceiptPrinterConnection,
  printRawEscPosBase64,
  resolvePrinterAddress,
} from "../../lib/printerBridge";
import { isTauri } from "@tauri-apps/api/core";
import { useToast } from "../ui/ToastProviderLogic";

type PrinterKey = "receipt" | "tag" | "report";

type PrinterConfig = {
  key: PrinterKey;
  label: string;
  helper: string;
  ipStorageKey: string;
  portStorageKey?: string;
  defaultIp: string;
  defaultPort: string;
};

const PRINTERS: PrinterConfig[] = [
  {
    key: "receipt",
    label: "Receipt Station",
    helper: "Epson TM-m30III / ESC-POS receipts and Register #1 cash drawer",
    ipStorageKey: "ros.hardware.printer.receipt.ip",
    portStorageKey: "ros.hardware.printer.receipt.port",
    defaultIp: "127.0.0.1",
    defaultPort: "9100",
  },
  {
    key: "tag",
    label: "Clothing Tag Station",
    helper: "Zebra 2844 on the host PC for ZPL clothing tags",
    ipStorageKey: "ros.hardware.printer.tag.ip",
    defaultIp: "127.0.0.1",
    defaultPort: "9100",
  },
  {
    key: "report",
    label: "Reports Printer",
    helper: "Full-page reports and audit paperwork",
    ipStorageKey: "ros.hardware.printer.report.ip",
    defaultIp: "",
    defaultPort: "9100",
  },
];

function getStored(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

function escposBase64FromAscii(text: string) {
  const bytes = [
    0x1b, 0x40,
    ...Array.from(text).map((ch) => ch.charCodeAt(0) & 0xff),
    0x0a, 0x0a, 0x0a,
    0x1d, 0x56, 0x41, 0x00,
  ];
  return btoa(String.fromCharCode(...bytes));
}

export default function PrintersAndScannersPanel({
  mode = "backoffice",
}: {
  mode?: "backoffice" | "pos";
}) {
  const { toast } = useToast();
  const initialValues = useMemo(
    () =>
      Object.fromEntries(
        PRINTERS.flatMap((printer) => [
          [printer.ipStorageKey, getStored(printer.ipStorageKey, printer.defaultIp)],
          [
            printer.portStorageKey ?? `${printer.ipStorageKey}.port`,
            getStored(
              printer.portStorageKey ?? `${printer.ipStorageKey}.port`,
              printer.defaultPort,
            ),
          ],
        ]),
      ) as Record<string, string>,
    [],
  );
  const [values, setValues] = useState(initialValues);
  const [cashDrawerEnabled, setCashDrawerEnabled] = useState(
    () => getStored("ros.hardware.cashDrawer.enabled", "true") !== "false",
  );
  const [testing, setTesting] = useState<PrinterKey | null>(null);
  const [drawerTesting, setDrawerTesting] = useState(false);
  const [testPrinting, setTestPrinting] = useState(false);
  const [lastScan, setLastScan] = useState("");

  const saveValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    window.localStorage.setItem(key, value);
  };

  const saveCashDrawerEnabled = (enabled: boolean) => {
    setCashDrawerEnabled(enabled);
    window.localStorage.setItem("ros.hardware.cashDrawer.enabled", enabled ? "true" : "false");
  };

  const testPrinter = async (printer: PrinterConfig) => {
    setTesting(printer.key);
    try {
      if (printer.key === "receipt") {
        if (!isTauri()) {
          toast("Receipt settings saved. Live printer checks run in the Riverside desktop app.", "success");
          return;
        }
        await checkReceiptPrinterConnection(resolvePrinterAddress("receipt"));
      } else {
        const ip = values[printer.ipStorageKey]?.trim();
        if (!ip) {
          throw new Error(`${printer.label} IP is not configured.`);
        }
        toast(`${printer.label} saved. Live readiness checks are currently for receipt printers.`, "success");
        return;
      }
      toast(`${printer.label} responded.`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : `${printer.label} check failed`, "error");
    } finally {
      setTesting(null);
    }
  };

  const printTestReceipt = async () => {
    setTestPrinting(true);
    try {
      const printer = resolvePrinterAddress("receipt");
      const now = new Date().toLocaleString();
      await printRawEscPosBase64(
        escposBase64FromAscii(`Riverside OS\nRegister #1 printer test\n${now}\n\nEpson TM-m30III ESC/POS`),
        printer.ip,
        printer.port,
      );
      toast("Test receipt sent to the Epson station.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test receipt failed", "error");
    } finally {
      setTestPrinting(false);
    }
  };

  const openCashDrawerTest = async () => {
    setDrawerTesting(true);
    try {
      const printer = resolvePrinterAddress("receipt");
      await printRawEscPosBase64("G3AAMvo=", printer.ip, printer.port);
      toast("Cash drawer kick sent.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Cash drawer test failed", "error");
    } finally {
      setDrawerTesting(false);
    }
  };

  const receiptIp = values["ros.hardware.printer.receipt.ip"]?.trim() || "Not set";
  const receiptPort = values["ros.hardware.printer.receipt.port"]?.trim() || "9100";
  const tagIp = values["ros.hardware.printer.tag.ip"]?.trim() || "Not set";

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-accent/25 bg-app-accent/10 text-app-accent">
            <Settings2 className="h-7 w-7" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              {mode === "pos" ? "Register Hardware" : "Printers & Scanners"}
            </h2>
            <p className="max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
              {mode === "pos"
                ? "Register lane hardware lives on this device: Epson receipts, the attached cash drawer, Zebra clothing tags, and scanner input."
                : "Workstation hardware settings are stored on this device. Back Office and POS use the same keys, so updates here apply immediately to the current lane."}
            </p>
          </div>
        </div>
      </header>

      {mode === "pos" ? (
        <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {[
            ["Receipt", `${receiptIp}:${receiptPort}`, "Epson TM-m30III"],
            ["Drawer", cashDrawerEnabled ? "Cash/check only" : "Disabled", "Attached to receipt printer"],
            ["Tags", tagIp, "Zebra 2844 clothing tags"],
          ].map(([label, value, helper]) => (
            <div key={label} className="ui-card p-5">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {label}
              </p>
              <p className="mt-2 text-lg font-black tracking-tight text-app-text">
                {value}
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                {helper}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {PRINTERS.map((printer) => {
          const portKey = printer.portStorageKey ?? `${printer.ipStorageKey}.port`;
          const showPort = printer.key === "receipt";
          return (
            <div key={printer.key} className="ui-card flex flex-col gap-5 p-6">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                    <Printer className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                      {printer.label}
                    </h3>
                    <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                      {printer.helper}
                    </p>
                  </div>
                </div>
                {printer.key === "receipt" ? (
                  <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
                    Epson
                  </span>
                ) : printer.key === "tag" ? (
                  <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    Zebra 2844
                  </span>
                ) : null}
              </div>

              <div className={showPort ? "grid grid-cols-[1fr_7rem] gap-3" : "grid grid-cols-1 gap-3"}>
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Printer IP
                  </span>
                  <input
                    value={values[printer.ipStorageKey] ?? ""}
                    onChange={(e) => saveValue(printer.ipStorageKey, e.target.value)}
                    placeholder={printer.key === "report" ? "Optional" : "192.168.1.50"}
                    className="ui-input mt-2 w-full font-mono text-xs"
                  />
                </label>
                {showPort ? (
                  <label className="block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Port
                    </span>
                    <input
                      value={values[portKey] ?? ""}
                      onChange={(e) => saveValue(portKey, e.target.value)}
                      placeholder="9100"
                      className="ui-input mt-2 w-full font-mono text-xs"
                    />
                  </label>
                ) : null}
              </div>

              {printer.key === "receipt" ? (
                <label className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-4">
                  <input
                    type="checkbox"
                    checked={cashDrawerEnabled}
                    onChange={(e) => saveCashDrawerEnabled(e.target.checked)}
                    className="mt-1 h-4 w-4 accent-app-accent"
                  />
                  <span className="min-w-0">
                    <span className="block text-[10px] font-black uppercase tracking-widest text-app-text">
                      Open cash drawer on cash/check
                    </span>
                    <span className="mt-1 block text-xs font-semibold leading-relaxed text-app-text-muted">
                      Register #1 kicks the drawer through the Epson TM-m30III receipt printer only for CASH and CHECK tenders.
                    </span>
                  </span>
                </label>
              ) : null}

              <button
                type="button"
                onClick={() => void testPrinter(printer)}
                disabled={testing === printer.key}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50"
              >
                {testing === printer.key ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {printer.key === "receipt" ? "Check connection" : "Confirm setting"}
              </button>

              {mode === "pos" && printer.key === "receipt" ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => void printTestReceipt()}
                    disabled={testPrinting}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-bg px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-2 disabled:opacity-50"
                  >
                    {testPrinting ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <Printer className="h-4 w-4" />
                    )}
                    Print test
                  </button>
                  <button
                    type="button"
                    onClick={() => void openCashDrawerTest()}
                    disabled={drawerTesting || !cashDrawerEnabled}
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300"
                  >
                    {drawerTesting ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <CircleDollarSign className="h-4 w-4" />
                    )}
                    Open drawer
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </section>

      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="ui-card p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
              <ScanLine className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Scanner Test
              </h3>
              <p className="text-xs font-semibold text-app-text-muted">
                USB scanners on the host PC and Bluetooth scanners on iPad/phone should type into the focused field and press Enter.
              </p>
            </div>
          </div>
          <label className="mt-5 block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Scan or type barcode
            </span>
            <input
              value={lastScan}
              onChange={(e) => setLastScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && lastScan.trim()) {
                  toast(`Scanner captured ${lastScan.trim()}`, "success");
                }
              }}
              className="ui-input mt-2 w-full font-mono text-sm"
              placeholder="Focus here, then scan"
            />
          </label>
        </div>

        <div className="ui-card p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
              <Barcode className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Receipt Path
              </h3>
              <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                Standard receipts target Epson ESC/POS. Clothing tags target the Zebra 2844/ZPL station on the host PC.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
