import React from "react";
import { warmUpPosAudio, playPosScanSuccess, type PosSoundProfile } from "../../lib/posAudio";
import { Volume2, Printer } from "lucide-react";


interface RegisterSettingsProps {
  sessionId?: string | null;
  cashierCode?: string | null;
  lifecycleStatus?: string | null;
  onRefreshMeta?: () => Promise<void>;
}

export default function RegisterSettings({ 
  sessionId,
  cashierCode,
  lifecycleStatus,
  onRefreshMeta
}: RegisterSettingsProps) {
  const [soundProfile, setSoundProfile] = React.useState<PosSoundProfile>(() => {
    const saved = window.localStorage.getItem("ros.pos.soundProfile");
    if (saved === "classic" || saved === "soft" || saved === "modern" || saved === "retro" || saved === "silent") {
      return saved;
    }
    return "classic";
  });

  const [receiptPrinterIp, setReceiptPrinterIp] = React.useState(() => window.localStorage.getItem("ros.pos.receiptPrinterIp") || "127.0.0.1");
  const [receiptPrinterPort, setReceiptPrinterPort] = React.useState(() => window.localStorage.getItem("ros.pos.receiptPrinterPort") || "9100");
  const [autoPrintReceipts, setAutoPrintReceipts] = React.useState(() => window.localStorage.getItem("ros.pos.autoPrintReceipts") === "true");
  
  const [reportPrinterName, setReportPrinterName] = React.useState(() => window.localStorage.getItem("ros.pos.reportPrinterName") || "Default");
  const [autoPrintReports, setAutoPrintReports] = React.useState(() => window.localStorage.getItem("ros.pos.autoPrintReports") === "true");

  const [busy, setBusy] = React.useState(false);

  const saveReceiptIp = (val: string) => { setReceiptPrinterIp(val); window.localStorage.setItem("ros.pos.receiptPrinterIp", val); };
  const saveReceiptPort = (val: string) => { setReceiptPrinterPort(val); window.localStorage.setItem("ros.pos.receiptPrinterPort", val); };
  const toggleAutoPrintReceipts = () => { const next = !autoPrintReceipts; setAutoPrintReceipts(next); window.localStorage.setItem("ros.pos.autoPrintReceipts", String(next)); };

  const saveReportPrinter = (val: string) => { setReportPrinterName(val); window.localStorage.setItem("ros.pos.reportPrinterName", val); };
  const toggleAutoPrintReports = () => { const next = !autoPrintReports; setAutoPrintReports(next); window.localStorage.setItem("ros.pos.autoPrintReports", String(next)); };

  const handleSoundChange = (val: PosSoundProfile) => {
    setSoundProfile(val);
    window.localStorage.setItem("ros.pos.soundProfile", val);
    if (val !== "silent") {
      warmUpPosAudio();
      setTimeout(() => {
        playPosScanSuccess();
      }, 50);
    }
  };

  const cancelReconciliation = async () => {
    if (!sessionId || !cashierCode) return;
    setBusy(true);
    try {
      const baseUrl = import.meta.env.VITE_API_BASE ?? "";
      const res = await fetch(`${baseUrl}/api/sessions/${sessionId}/begin-reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: false, cashier_code: cashierCode })
      });
      if (res.ok) {
        if (onRefreshMeta) await onRefreshMeta();
      }
    } catch (e) {
      console.error("Failed to cancel reconcile", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-app-bg text-app-text">
      <header className="shrink-0 border-b border-app-border bg-app-surface px-8 py-6 shadow-sm">
        <h2 className="text-2xl font-black tracking-tight italic">Terminal Overrides</h2>
        <p className="text-xs font-semibold uppercase tracking-widest text-app-text-muted mt-1">
          Hardware Bridging & Device Logic
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-8 space-y-10 no-scrollbar">
        <div className="mx-auto max-w-3xl space-y-12 pb-20">
          

          {/* New Reconciliation / Status Override */}
          {lifecycleStatus === 'reconciling' && (
            <section className="space-y-6 border-l-4 border-amber-500 pl-6 h-auto">
              <div>
                <h3 className="text-lg font-black tracking-tight text-amber-600">Session Lifecycle Recovery</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">The register is currently in RECONCILING mode.</p>
              </div>
              <div className="ui-card p-6 border-amber-500/30 bg-amber-500/5 space-y-4">
                 <p className="text-xs font-bold leading-relaxed text-amber-700">If the register is incorrectly stuck in reconcile mode (e.g. following a terminal crash), you can force it back to active state here.</p>
                 <button
                   type="button"
                   disabled={busy}
                   onClick={cancelReconciliation}
                   className="h-12 px-8 rounded-xl bg-amber-600 text-white font-black uppercase tracking-widest hover:bg-amber-500 active:scale-95 transition-all shadow-lg"
                 >
                   {busy ? "RESTORING..." : "CANCEL RECONCILIATION & RE-OPEN"}
                 </button>
              </div>
            </section>
          )}

          <section className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                 <Volume2 size={20} />
              </div>
              <div>
                <h3 className="text-lg font-black tracking-tight">Audio & Feedback</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Aural signals for high-velocity scanning</p>
              </div>
            </div>
            <div className="ui-card p-6 border-app-border space-y-6">
              <label className="flex flex-col gap-3">
                <span className="text-sm font-bold">Sound Profile</span>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                   {(['classic', 'modern', 'retro', 'soft', 'silent'] as PosSoundProfile[]).map(profile => (
                     <button
                        key={profile}
                        type="button"
                        onClick={() => handleSoundChange(profile)}
                        className={`flex flex-col items-center justify-center gap-2 rounded-xl border aspect-square p-2 transition-all ${soundProfile === profile ? 'border-app-text bg-app-accent/10 border-2 text-app-text' : 'border-app-border bg-app-surface text-app-text-muted shadow-sm hover:border-app-accent/40'}`}
                     >
                        <span className="text-[10px] font-black uppercase tracking-widest leading-none text-center">{profile}</span>
                        <div className={`h-1.5 w-1.5 rounded-full ${soundProfile === profile ? 'bg-app-text shadow-[0_0_8px_rgba(39,39,42,0.8)]' : 'bg-app-border'}`} />
                     </button>
                   ))}
                </div>
              </label>
            </div>
          </section>

          <section className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                 <Printer size={20} />
              </div>
              <div>
                <h3 className="text-lg font-black tracking-tight">Printer & Peripherals</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Assigned Hardware Nodes</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Receipt Printer (Thermal) */}
              <div className="ui-card p-6 border-app-border space-y-6">
                <div className="flex items-center justify-between border-b border-app-border pb-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Receipt Station (Thermal)</p>
                  <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                   <label className="flex flex-col gap-2">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Printer IP</span>
                      <input 
                        value={receiptPrinterIp} 
                        onChange={e => saveReceiptIp(e.target.value)}
                        placeholder="127.0.0.1"
                        className="ui-input font-mono text-xs"
                      />
                   </label>
                   <label className="flex flex-col gap-2">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">TCP Port</span>
                      <input 
                        value={receiptPrinterPort} 
                        onChange={e => saveReceiptPort(e.target.value)}
                        placeholder="9100"
                        className="ui-input font-mono text-xs"
                      />
                   </label>
                </div>
                <button 
                  type="button"
                  onClick={toggleAutoPrintReceipts}
                  className={`flex w-full items-center justify-between rounded-xl border p-4 transition-all ${autoPrintReceipts ? 'border-app-text bg-app-accent/10 border-2' : 'border-app-border bg-app-surface'}`}
                >
                   <div className="text-left">
                      <p className="text-sm font-black uppercase italic tracking-tighter">Auto-Print</p>
                      <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">Immediate thermal bridge</p>
                   </div>
                   <div className={`h-6 w-12 rounded-full p-1 transition-colors ${autoPrintReceipts ? 'bg-app-text shadow-inner' : 'bg-app-border'}`}>
                      <div className={`h-4 w-4 rounded-full bg-app-surface shadow-sm transition-transform ${autoPrintReceipts ? 'translate-x-6 shadow-lg' : 'translate-x-0'}`} />
                   </div>
                </button>
              </div>

              {/* Report Printer (Full Page) */}
              <div className="ui-card p-6 border-app-border space-y-6">
                <div className="flex items-center justify-between border-b border-app-border pb-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Report Station (Audit)</p>
                  <div className="h-2 w-2 rounded-full bg-blue-500/40" />
                </div>
                <label className="flex flex-col gap-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">System Printer Name</span>
                  <input 
                    value={reportPrinterName} 
                    onChange={e => saveReportPrinter(e.target.value)}
                    placeholder="e.g. Office LaserJet"
                    className="ui-input font-semibold text-sm"
                  />
                </label>
                <button 
                  type="button"
                  onClick={toggleAutoPrintReports}
                  className={`flex w-full items-center justify-between rounded-xl border p-4 transition-all ${autoPrintReports ? 'border-app-text bg-app-accent/10 border-2' : 'border-app-border bg-app-surface'}`}
                >
                   <div className="text-left">
                      <p className="text-sm font-black uppercase italic tracking-tighter">Auto-Print (Silent)</p>
                      <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">Bypass system dialog</p>
                   </div>
                   <div className={`h-6 w-12 rounded-full p-1 transition-colors ${autoPrintReports ? 'bg-app-text shadow-inner' : 'bg-app-border'}`}>
                      <div className={`h-4 w-4 rounded-full bg-app-surface shadow-sm transition-transform ${autoPrintReports ? 'translate-x-6 shadow-lg' : 'translate-x-0'}`} />
                   </div>
                </button>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
