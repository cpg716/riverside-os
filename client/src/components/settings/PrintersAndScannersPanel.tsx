import { useMemo, useState } from "react";
import {
  Barcode,
  CheckCircle2,
  Printer,
  RefreshCw,
  ScanLine,
  Settings2,
} from "lucide-react";
import {
  checkReceiptPrinterConnection,
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

export default function PrintersAndScannersPanel() {
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

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-accent/25 bg-app-accent/10 text-app-accent">
            <Settings2 className="h-7 w-7" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              Printers & Scanners
            </h2>
            <p className="max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
              Workstation hardware settings are stored on this device. Back Office and POS use the same keys, so updates here apply immediately to the current lane.
            </p>
          </div>
        </div>
      </header>

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
