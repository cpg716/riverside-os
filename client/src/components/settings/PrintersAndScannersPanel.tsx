import { useState, useEffect } from "react";
import { 
  Printer, 
  CheckCircle2, 
  Monitor, 
  Zap, 
  Search, 
  Barcode, 
  RefreshCw,
  XCircle,
  Activity,
  Server,
  Globe,
  MonitorCheck
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { isTauri } from "@tauri-apps/api/core";
import { autoRoutePrint } from "../../lib/printerBridge";

export default function PrintersAndScannersPanel() {
  const { toast } = useToast();
// Removed unused saved/busy state

  // Printer States
  const [receiptPrinterIp, setReceiptPrinterIp] = useState(
    () => window.localStorage.getItem("ros.hardware.printer.receipt.ip") || "127.0.0.1",
  );
  const [receiptPrinterPort, setReceiptPrinterPort] = useState(
    () => window.localStorage.getItem("ros.hardware.printer.receipt.port") || "9100",
  );
  const [tagPrinterIp, setTagPrinterIp] = useState(
    () => window.localStorage.getItem("ros.hardware.printer.tag.ip") || "127.0.0.1",
  );
  const [reportPrinterIp, setReportPrinterIp] = useState(
    () => window.localStorage.getItem("ros.hardware.printer.report.ip") || "",
  );

  // Scanner States
  const [mainScannerStatus, setMainScannerStatus] = useState<"connected" | "disconnected" | "checking">("checking");
  const [lastScan, setLastScan] = useState<string | null>(null);

  useEffect(() => {
    // Simulate scanner check
    const timer = setTimeout(() => setMainScannerStatus("connected"), 1500);
    return () => clearTimeout(timer);
  }, []);

  const saveConfig = (key: string, value: string, toastMsg: string) => {
    window.localStorage.setItem(key, value);
    toast(toastMsg, "success");
  };

  const handleTestPrint = async (type: "receipt" | "tag" | "report") => {
    try {
      const payload = type === "tag" 
        ? "^XA^FO50,50^A0N,50,50^FDRiverside Tag Test^FS^XZ" 
        : "Riverside POS Terminal Test\nStation: " + (window.location.hostname) + "\nType: " + type.toUpperCase() + "\nDate: " + (new Date().toLocaleString());
        
      await autoRoutePrint(type, payload, type === "tag" ? "zpl" : "escpos");
      toast(`Sent test ${type} to bridge...`, "success");
    } catch (err) {
      toast(`Bridge Error: ${String(err)}`, "error");
    }
  };

  const isTauriNative = isTauri();

  return (
    <div className="space-y-12">
      <header className="mb-10 flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
            Printers & Scanners
          </h2>
          <p className="text-sm text-app-text-muted mt-2 font-medium">
            Manage local hardware bridges, thermal stations, and input peripherals.
          </p>
        </div>

        <div className={`px-4 py-2 rounded-2xl flex items-center gap-3 border font-black text-[10px] uppercase tracking-widest ${
          isTauriNative ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : "bg-blue-500/10 text-blue-500 border-blue-500/20"
        }`}>
          {isTauriNative ? (
            <>
              <MonitorCheck size={16} />
              <span>Bridge Mode: Tauri Native (TCP)</span>
            </>
          ) : (
            <>
              <Globe size={16} />
              <span>Bridge Mode: PWA / Browser (Fetch)</span>
            </>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
        <div className="xl:col-span-8 space-y-10">
          {/* Thermal Receipt Printers */}
          <section className="ui-card p-10 border-l-4 border-emerald-500 shadow-2xl shadow-emerald-500/5">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="p-4 rounded-3xl bg-emerald-500/10 text-emerald-500">
                  <Printer size={32} />
                </div>
                <div>
                  <h3 className="text-2xl font-black uppercase tracking-tighter italic text-app-text">
                    Receipt Printer
                  </h3>
                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                    TCP/IP Station Bridging
                  </p>
                </div>
              </div>
              <button 
                onClick={() => handleTestPrint("receipt")}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-emerald-600 transition-colors"
              >
                <Zap size={14} /> Send Test
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                  Printer IP Address
                </label>
                <input
                  type="text"
                  value={receiptPrinterIp}
                  onChange={(e) => {
                    const val = e.target.value;
                    setReceiptPrinterIp(val);
                    saveConfig("ros.hardware.printer.receipt.ip", val, "Receipt IP updated");
                  }}
                  className="w-full bg-app-surface border-2 border-app-border rounded-2xl px-5 py-3 text-app-text font-black tracking-tight focus:border-emerald-500 outline-none transition-all"
                  placeholder="192.168.1.100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                  Printer Port
                </label>
                <input
                  type="text"
                  value={receiptPrinterPort}
                  onChange={(e) => {
                    const val = e.target.value;
                    setReceiptPrinterPort(val);
                    saveConfig("ros.hardware.printer.receipt.port", val, "Receipt Port updated");
                  }}
                  className="w-full bg-app-surface border-2 border-app-border rounded-2xl px-5 py-3 text-app-text font-black tracking-tight focus:border-emerald-500 outline-none transition-all"
                  placeholder="9100"
                />
              </div>
            </div>
          </section>

          {/* Tag / Label Printers */}
          <section className="ui-card p-10 border-l-4 border-blue-500 shadow-2xl shadow-blue-500/5">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="p-4 rounded-3xl bg-blue-500/10 text-blue-500">
                  <Barcode size={32} />
                </div>
                <div>
                  <h3 className="text-2xl font-black uppercase tracking-tighter italic text-app-text">
                    Tag / Label Printer
                  </h3>
                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                    Zebra / ZPL Station
                  </p>
                </div>
              </div>
              <button 
                onClick={() => handleTestPrint("tag")}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-xl font-black text-[10px] uppercase tracking-widest hover:bg-blue-600 transition-colors"
              >
                <Zap size={14} /> Send Sample
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                Zebra Station IP
              </label>
              <input
                type="text"
                value={tagPrinterIp}
                onChange={(e) => {
                  const val = e.target.value;
                  setTagPrinterIp(val);
                  saveConfig("ros.hardware.printer.tag.ip", val, "Tag Printer IP updated");
                }}
                className="w-full bg-app-surface border-2 border-app-border rounded-2xl px-5 py-3 text-app-text font-black tracking-tight focus:border-blue-500 outline-none transition-all"
                placeholder="192.168.1.101"
              />
            </div>
          </section>

          {/* Barcode Scanners */}
          <section className="ui-card p-10 border-l-4 border-amber-500 shadow-2xl shadow-amber-500/5">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-4">
                <div className="p-4 rounded-3xl bg-amber-500/10 text-amber-500">
                  <Search size={32} />
                </div>
                <div>
                  <h3 className="text-2xl font-black uppercase tracking-tighter italic text-app-text">
                    Barcode Scanners
                  </h3>
                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                    USB / Bluetooth HID
                  </p>
                </div>
              </div>
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest ${
                mainScannerStatus === "connected" ? "bg-emerald-500/20 text-emerald-500" : 
                mainScannerStatus === "disconnected" ? "bg-red-500/20 text-red-500" :
                "bg-amber-500/20 text-amber-500 animate-pulse"
              }`}>
                {mainScannerStatus === "connected" && <Activity size={10} />}
                {mainScannerStatus === "disconnected" && <XCircle size={10} />}
                {mainScannerStatus === "checking" && <RefreshCw size={10} className="animate-spin" />}
                {mainScannerStatus}
              </div>
            </div>

            <div className="bg-app-bg/50 rounded-2xl p-6 border-2 border-dashed border-app-border">
              <div className="flex flex-col items-center justify-center text-center py-4">
                <Barcode size={48} className="text-app-text-muted opacity-30 mb-4" />
                <h4 className="text-sm font-black uppercase tracking-widest text-app-text mb-2">
                  Scanner Input Test
                </h4>
                <p className="text-[11px] text-app-text-muted max-w-sm">
                  Click the field below and scan any barcode to verify your peripheral is correctly configured as an HID device.
                </p>
                
                <input
                  type="text"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setLastScan((e.target as HTMLInputElement).value);
                      (e.target as HTMLInputElement).value = "";
                      toast("Scan captured successfully", "success");
                    }
                  }}
                  className="mt-6 w-full max-w-md bg-app-surface border-2 border-app-border rounded-xl px-5 py-3 text-app-text font-mono text-center outline-none focus:border-amber-500 transition-all placeholder:font-sans placeholder:text-[10px] placeholder:uppercase placeholder:tracking-[0.2em]"
                  placeholder="Scan here for test..."
                />

                {lastScan && (
                  <div className="mt-6 animate-in fade-in slide-in-from-top-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-amber-500 mb-1">
                      Last Captured Value
                    </p>
                    <code className="text-lg font-black text-app-text block bg-amber-500/10 px-4 py-2 rounded-lg border border-amber-500/20">
                      {lastScan}
                    </code>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="xl:col-span-4 space-y-10">
          {/* System Print Station */}
          <section className="ui-card p-8 border-l-4 border-violet-500 shadow-2xl shadow-violet-500/5 h-full">
            <div className="flex items-center gap-4 mb-8">
              <div className="p-3 rounded-2xl bg-violet-500/10 text-violet-500">
                <Monitor size={24} />
              </div>
              <div>
                <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">
                  Reporting Station
                </h3>
                <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                  System Page Printing
                </p>
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                    Default Report Destination (IP)
                  </label>
                  <input
                    type="text"
                    value={reportPrinterIp}
                    onChange={(e) => {
                      const val = e.target.value;
                      setReportPrinterIp(val);
                      saveConfig("ros.hardware.printer.report.ip", val, "Report IP updated");
                    }}
                    className="w-full bg-app-surface border-2 border-app-border rounded-xl px-4 py-2 text-app-text font-black tracking-tight focus:border-violet-500 outline-none transition-all"
                    placeholder="192.168.1.50"
                  />
                </div>

                <div className="space-y-2 pt-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">
                    Output Method
                  </label>
                  <div className="flex flex-col gap-2">
                  <button className="flex items-center justify-between px-4 py-3 bg-app-surface border-2 border-violet-500 rounded-xl text-left transition-all group">
                    <div>
                      <span className="text-xs font-black text-app-text block">Local PDF / Preview</span>
                      <span className="text-[9px] text-app-text-muted uppercase font-bold">In-app window (Default)</span>
                    </div>
                    <CheckCircle2 size={16} className="text-violet-500" />
                  </button>
                  <button className="flex items-center justify-between px-4 py-3 bg-app-surface border-2 border-app-border rounded-xl text-left opacity-50 hover:opacity-100 transition-all">
                    <div>
                      <span className="text-xs font-black text-app-text block">System Print Dialog</span>
                      <span className="text-[9px] text-app-text-muted uppercase font-bold">Standard A4/Letter</span>
                    </div>
                  </button>
                </div>
              </div>
            </div>

              <div className="pt-4 border-t border-app-border/50">
                <div className="bg-app-bg/50 rounded-xl p-4 flex items-center gap-4">
                  <Server size={20} className="text-app-text-muted opacity-50" />
                  <div>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text block">Hardware Bridge</span>
                    <span className="text-[9px] font-bold text-emerald-500 uppercase">Status: Online</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Quick Tip */}
          <div className="p-6 rounded-3xl bg-app-accent/5 border-2 border-dashed border-app-accent/20">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-app-accent mb-2">Pro Tip: Station Isolation</h4>
            <p className="text-[10px] leading-relaxed text-app-text-muted italic">
              Hardware configurations are stored locally in this browser's cache. If you swap workstations, you'll need to re-verify the IP addresses for the local printers connected to that specific lane.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
