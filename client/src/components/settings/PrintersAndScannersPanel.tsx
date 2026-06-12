import { useEffect, useMemo, useState } from "react";
import {
  Barcode,
  CheckCircle2,
  CircleDollarSign,
  Printer,
  RefreshCw,
  ScanLine,
  Settings2,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import {
  TAG_PRINTER_LANGUAGE_KEY,
  checkReceiptPrinterConnection,
  describePrinterTarget,
  listSystemPrinters,
  resolvePrinterTarget,
  type SystemPrinter,
} from "../../lib/printerBridge";
import { printReceiptBase64, printReceiptText } from "../../lib/receiptPrint";
import { isTauri } from "@tauri-apps/api/core";
import { useToast } from "../ui/ToastProviderLogic";

type PrinterKey = "receipt" | "tag" | "report";

type PrinterConfig = {
  key: PrinterKey;
  label: string;
  helper: string;
  supportsNetwork: boolean;
  ipStorageKey: string;
  portStorageKey?: string;
  modeStorageKey: string;
  systemStorageKey: string;
  defaultIp: string;
  defaultPort: string;
};

const PRINTERS: PrinterConfig[] = [
  {
    key: "receipt",
    label: "Receipt Station",
    helper: "Epson TM-m30III / ESC-POS receipts and Register #1 cash drawer",
    supportsNetwork: true,
    ipStorageKey: "ros.hardware.printer.receipt.ip",
    portStorageKey: "ros.hardware.printer.receipt.port",
    modeStorageKey: "ros.hardware.printer.receipt.mode",
    systemStorageKey: "ros.hardware.printer.receipt.systemName",
    defaultIp: "127.0.0.1",
    defaultPort: "9100",
  },
  {
    key: "tag",
    label: "Clothing Tag Station",
    helper: "Zebra 2844 on the host PC for clothing tags",
    supportsNetwork: true,
    ipStorageKey: "ros.hardware.printer.tag.ip",
    portStorageKey: "ros.hardware.printer.tag.port",
    modeStorageKey: "ros.hardware.printer.tag.mode",
    systemStorageKey: "ros.hardware.printer.tag.systemName",
    defaultIp: "127.0.0.1",
    defaultPort: "9100",
  },
  {
    key: "report",
    label: "Reports Printer",
    helper: "Full-page reports and audit paperwork from an installed Windows printer",
    supportsNetwork: false,
    ipStorageKey: "ros.hardware.printer.report.ip",
    portStorageKey: "ros.hardware.printer.report.port",
    modeStorageKey: "ros.hardware.printer.report.mode",
    systemStorageKey: "ros.hardware.printer.report.systemName",
    defaultIp: "",
    defaultPort: "9100",
  },
];

function getStored(key: string, fallback: string) {
  if (typeof window === "undefined") return fallback;
  return window.localStorage.getItem(key) ?? fallback;
}

export default function PrintersAndScannersPanel({
  mode = "backoffice",
  posSessionId = null,
  posCashierCode = null,
}: {
  mode?: "backoffice" | "pos";
  posSessionId?: string | null;
  posCashierCode?: string | null;
}) {
  const { toast } = useToast();
  const initialValues = useMemo(
    () =>
      Object.fromEntries([
        ...PRINTERS.flatMap((printer) => [
          [
            printer.modeStorageKey,
            printer.supportsNetwork ? getStored(printer.modeStorageKey, "network") : "system",
          ],
          [printer.systemStorageKey, getStored(printer.systemStorageKey, "")],
          [printer.ipStorageKey, getStored(printer.ipStorageKey, printer.defaultIp)],
          [
            printer.portStorageKey ?? `${printer.ipStorageKey}.port`,
            getStored(
              printer.portStorageKey ?? `${printer.ipStorageKey}.port`,
              printer.defaultPort,
            ),
          ],
        ]),
        [TAG_PRINTER_LANGUAGE_KEY, getStored(TAG_PRINTER_LANGUAGE_KEY, "auto")],
      ]) as Record<string, string>,
    [],
  );
  const [values, setValues] = useState(initialValues);
  const [cashDrawerEnabled, setCashDrawerEnabled] = useState(
    () => getStored("ros.hardware.cashDrawer.enabled", "true") !== "false",
  );
  const [testing, setTesting] = useState<PrinterKey | null>(null);
  const [drawerTesting, setDrawerTesting] = useState(false);
  const [drawerAuthOpen, setDrawerAuthOpen] = useState(false);
  const [drawerPin, setDrawerPin] = useState("");
  const [drawerReason, setDrawerReason] = useState("Manual drawer open");
  const [testPrinting, setTestPrinting] = useState(false);
  const [lastScan, setLastScan] = useState("");
  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[]>([]);
  const [loadingSystemPrinters, setLoadingSystemPrinters] = useState(false);

  const saveValue = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    window.localStorage.setItem(key, value);
  };

  const saveCashDrawerEnabled = (enabled: boolean) => {
    setCashDrawerEnabled(enabled);
    window.localStorage.setItem("ros.hardware.cashDrawer.enabled", enabled ? "true" : "false");
  };

  const refreshSystemPrinters = async () => {
    if (!isTauri()) {
      setSystemPrinters([]);
      return;
    }
    setLoadingSystemPrinters(true);
    try {
      setSystemPrinters(await listSystemPrinters());
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not load installed printers", "error");
    } finally {
      setLoadingSystemPrinters(false);
    }
  };

  useEffect(() => {
    void refreshSystemPrinters();
    for (const printer of PRINTERS) {
      if (!printer.supportsNetwork) {
        window.localStorage.setItem(printer.modeStorageKey, "system");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const testPrinter = async (printer: PrinterConfig) => {
    setTesting(printer.key);
    try {
      if (printer.key === "receipt") {
        await checkReceiptPrinterConnection(resolvePrinterTarget("receipt"));
      } else {
        const mode =
          !printer.supportsNetwork || values[printer.modeStorageKey] === "system"
            ? "system"
            : "network";
        if (mode === "system") {
          await checkReceiptPrinterConnection(resolvePrinterTarget(printer.key));
          toast(`${printer.label} is available on this station.`, "success");
          return;
        }
        const ip = values[printer.ipStorageKey]?.trim();
        if (!ip) {
          throw new Error(`${printer.label} address is not configured.`);
        }
        if (printer.key === "tag") {
          await checkReceiptPrinterConnection(resolvePrinterTarget("tag"));
          toast(`${printer.label} responded.`, "success");
          return;
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
      const now = new Date().toLocaleString();
      await printReceiptText(`Riverside OS\nRegister #1 printer test\n${now}\n\nEpson TM-m30III ESC/POS`);
      toast("Test receipt sent to the receipt station.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test receipt failed", "error");
    } finally {
      setTestPrinting(false);
    }
  };

  const openCashDrawerTest = async () => {
    if (!posSessionId || !posCashierCode) {
      toast("Open Register #1 before using manual drawer open.", "error");
      return;
    }
    const reason = drawerReason.trim();
    if (!reason) {
      toast("Enter a reason for the manual drawer open.", "error");
      return;
    }
    if (!drawerPin.trim()) {
      toast("Enter your Access PIN before opening the drawer.", "error");
      return;
    }
    setDrawerTesting(true);
    try {
      const res = await fetch(
        `${getBaseUrl()}/api/sessions/${encodeURIComponent(posSessionId)}/drawer-opens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cashier_code: posCashierCode,
            pin: drawerPin.trim(),
            reason,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Manual drawer open was not authorized.");
      }
      await printReceiptBase64("G3AAMvo=");
      setDrawerPin("");
      setDrawerAuthOpen(false);
      toast("Cash drawer opened and recorded for the Z-report.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Cash drawer test failed", "error");
    } finally {
      setDrawerTesting(false);
    }
  };

  const receiptTarget = describePrinterTarget(resolvePrinterTarget("receipt"));
  const tagTarget = describePrinterTarget(resolvePrinterTarget("tag"));

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
            ["Receipt", receiptTarget, "Epson TM-m30III"],
            ["Drawer", cashDrawerEnabled ? "Cash/check only" : "Disabled", "Attached to receipt printer"],
            ["Tags", tagTarget, "Zebra 2844 clothing tags"],
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
          const targetMode =
            !printer.supportsNetwork || values[printer.modeStorageKey] === "system"
              ? "system"
              : "network";
          const showPort = targetMode === "network";
          return (
            <div
              key={printer.key}
              data-testid={`printer-card-${printer.key}`}
              className="ui-card flex flex-col gap-5 p-6"
            >
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

              <div className="grid grid-cols-1 gap-3">
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Printer setup
                  </span>
                  <select
                    value={targetMode}
                    onChange={(e) => saveValue(printer.modeStorageKey, e.target.value)}
                    className="ui-input mt-2 w-full text-sm font-bold"
                  >
                    <option value="system">Installed printer on this PC</option>
                    {printer.supportsNetwork ? (
                      <option value="network">Network address</option>
                    ) : null}
                  </select>
                </label>
                {targetMode === "system" ? (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <label className="block min-w-0">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Installed printer
                      </span>
                      <select
                        value={values[printer.systemStorageKey] ?? ""}
                        onChange={(e) => saveValue(printer.systemStorageKey, e.target.value)}
                        className="ui-input mt-2 w-full text-sm font-bold"
                      >
                        <option value="">Choose printer</option>
                        {systemPrinters.map((systemPrinter) => (
                          <option key={systemPrinter.name} value={systemPrinter.name}>
                            {systemPrinter.name}
                            {systemPrinter.is_default ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      onClick={() => void refreshSystemPrinters()}
                      disabled={loadingSystemPrinters}
                      className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 px-3 text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50"
                      aria-label="Refresh installed printers"
                    >
                      <RefreshCw className={`h-4 w-4 ${loadingSystemPrinters ? "animate-spin" : ""}`} />
                    </button>
                  </div>
                ) : (
                  <div className={showPort ? "grid grid-cols-[1fr_7rem] gap-3" : "grid grid-cols-1 gap-3"}>
                    <label className="block">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Printer address
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
                )}
              </div>

              {printer.key === "tag" ? (
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Printer language
                  </span>
                  <select
                    value={values[TAG_PRINTER_LANGUAGE_KEY] ?? "auto"}
                    onChange={(e) => saveValue(TAG_PRINTER_LANGUAGE_KEY, e.target.value)}
                    className="ui-input mt-2 w-full text-sm font-bold"
                  >
                    <option value="auto">Auto-detect LP/TLP 2844</option>
                    <option value="epl">EPL / Zebra LP 2844</option>
                    <option value="zpl">ZPL II / newer Zebra</option>
                  </select>
                </label>
              ) : null}

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
                {printer.key === "receipt" || printer.key === "report"
                  ? "Check connection"
                  : "Confirm setting"}
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
                    onClick={() => setDrawerAuthOpen((open) => !open)}
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
              {mode === "pos" && printer.key === "receipt" && drawerAuthOpen ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                    Manual drawer open
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    Requires your Access PIN and appears on the Z-report. Sales still open the drawer automatically only for cash/check.
                  </p>
                  <label className="mt-3 block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Reason
                    </span>
                    <input
                      value={drawerReason}
                      onChange={(e) => setDrawerReason(e.target.value)}
                      className="ui-input mt-2 w-full text-sm"
                      placeholder="Cash count, change check, manager review..."
                    />
                  </label>
                  <label className="mt-3 block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Access PIN
                    </span>
                    <input
                      type="password"
                      inputMode="numeric"
                      value={drawerPin}
                      onChange={(e) => setDrawerPin(e.target.value)}
                      className="ui-input mt-2 w-full font-mono text-sm"
                      placeholder="4-digit PIN"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void openCashDrawerTest()}
                    disabled={drawerTesting || !cashDrawerEnabled}
                    className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-colors hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300"
                  >
                    {drawerTesting ? (
                      <RefreshCw className="h-4 w-4 animate-spin" />
                    ) : (
                      <CircleDollarSign className="h-4 w-4" />
                    )}
                    Authorize and open drawer
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
                Standard receipts target Epson ESC/POS. Clothing tags target the Zebra tag station on the host PC.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
