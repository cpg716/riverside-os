import React from "react";
import { warmUpPosAudio, playPosScanSuccess, type PosSoundProfile } from "../../lib/posAudio";
import { getBaseUrl } from "../../lib/apiConfig";
import { Volume2, Printer, DollarSign } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";


interface RegisterSettingsProps {
  sessionId?: string | null;
  cashierCode?: string | null;
  lifecycleStatus?: string | null;
  onRefreshMeta?: () => Promise<void>;
  onOpenPrintingSettings?: () => void;
}

export default function RegisterSettings({ 
  sessionId,
  cashierCode,
  lifecycleStatus,
  onRefreshMeta,
  onOpenPrintingSettings,
}: RegisterSettingsProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [soundProfile, setSoundProfile] = React.useState<PosSoundProfile>(() => {
    const saved = window.localStorage.getItem("ros.pos.soundProfile");
    if (saved === "classic" || saved === "soft" || saved === "modern" || saved === "retro" || saved === "silent") {
      return saved;
    }
    return "classic";
  });

  const [autoPrintReceipts, setAutoPrintReceipts] = React.useState(() => window.localStorage.getItem("ros.hardware.printer.receipt.autoPrint") === "true");

  // ── Cash Rounding (server-persisted) ────────────────────────────────────────
  const [cashRoundingEnabled, setCashRoundingEnabled] = React.useState<boolean>(false);
  const [cashRoundingLoading, setCashRoundingLoading] = React.useState(true);
  const [cashRoundingSaving, setCashRoundingSaving] = React.useState(false);

  React.useEffect(() => {
    const baseUrl = getBaseUrl();
    fetch(`${baseUrl}/api/settings/pos-station-config/public`)
      .then((r) => r.json())
      .then((data: { cash_rounding_enabled?: boolean }) => {
        setCashRoundingEnabled(data.cash_rounding_enabled ?? false);
      })
      .catch(() => {/* leave at false */})
      .finally(() => setCashRoundingLoading(false));
  }, []);

  const toggleCashRounding = async () => {
    const next = !cashRoundingEnabled;
    setCashRoundingSaving(true);
    try {
      const baseUrl = getBaseUrl();
      const res = await fetch(`${baseUrl}/api/settings/pos-station-config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        },
        body: JSON.stringify({ cash_rounding_enabled: next }),
      });
      if (res.ok) {
        setCashRoundingEnabled(next);
      }
    } catch (e) {
      console.error("Failed to save cash rounding setting", e);
    } finally {
      setCashRoundingSaving(false);
    }
  };
  // ────────────────────────────────────────────────────────────────────────────

  const [busy, setBusy] = React.useState(false);

  const toggleAutoPrintReceipts = () => { const next = !autoPrintReceipts; setAutoPrintReceipts(next); window.localStorage.setItem("ros.hardware.printer.receipt.autoPrint", String(next)); };

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
      const baseUrl = getBaseUrl();
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
    <div className="flex min-h-0 flex-1 flex-col bg-app-bg text-app-text">
      <header className="shrink-0 border-b border-app-border bg-app-surface px-4 py-4 shadow-sm sm:px-8 sm:py-6">
        <h2 className="text-2xl font-black tracking-tight italic">Register Settings</h2>
        <p className="text-xs font-semibold uppercase tracking-widest text-app-text-muted mt-1">
          Printers, scanners, and register feedback
        </p>
      </header>

      <div className="no-scrollbar flex-1 overflow-y-auto p-4 space-y-8 sm:p-8 sm:space-y-10">
        <div className="mx-auto max-w-3xl space-y-12 pb-20">
          

          {/* New Reconciliation / Status Override */}
          {lifecycleStatus === 'reconciling' && (
            <section className="space-y-6 border-l-4 border-amber-500 pl-6 h-auto">
              <div>
                <h3 className="text-lg font-black tracking-tight text-amber-600">Register Recovery</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">The register is currently waiting for close review.</p>
              </div>
              <div className="ui-card p-6 border-amber-500/30 bg-amber-500/5 space-y-4">
                 <p className="text-xs font-bold leading-relaxed text-amber-700">If the register is incorrectly stuck after a crash, restore it to active selling here.</p>
                 <button
                   type="button"
                   disabled={busy}
                   onClick={cancelReconciliation}
                   className="h-12 px-8 rounded-xl bg-amber-600 text-white font-black uppercase tracking-widest hover:bg-amber-500 active:scale-95 transition-all shadow-lg"
                 >
                   {busy ? "RESTORING..." : "RESTORE REGISTER FOR SELLING"}
                 </button>
              </div>
            </section>
          )}

          {/* ── Cash Rounding ─────────────────────────────────────────────── */}
          <section className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                <DollarSign size={20} />
              </div>
              <div>
                <h3 className="text-lg font-black tracking-tight">Cash Rounding</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Swedish-style rounding to nearest $0.05 on cash transactions</p>
              </div>
            </div>
            <div className="ui-card p-6 border-app-border space-y-4">
              <button
                type="button"
                id="toggle-cash-rounding"
                disabled={cashRoundingLoading || cashRoundingSaving}
                onClick={() => void toggleCashRounding()}
                className={`flex w-full items-center justify-between rounded-xl border p-4 transition-all disabled:opacity-60 ${cashRoundingEnabled ? 'border-app-text bg-app-accent/10 border-2' : 'border-app-border bg-app-surface'}`}
              >
                <div className="text-left">
                  <p className="text-sm font-black uppercase italic tracking-tighter">
                    Cash Rounding {cashRoundingEnabled ? "Enabled" : "Disabled"}
                  </p>
                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                    {cashRoundingEnabled
                      ? "Cash due amounts rounded to nearest $0.05"
                      : "Cash due shown at exact cent precision"}
                  </p>
                </div>
                <div className={`h-6 w-12 rounded-full p-1 transition-colors ${cashRoundingEnabled ? 'bg-app-text shadow-inner' : 'bg-app-border'}`}>
                  <div className={`h-4 w-4 rounded-full bg-app-surface shadow-sm transition-transform ${cashRoundingEnabled ? 'translate-x-6 shadow-lg' : 'translate-x-0'}`} />
                </div>
              </button>
              <p className="text-[11px] font-semibold leading-relaxed text-app-text-muted">
                When enabled, cash balance-due amounts are rounded to the nearest $0.05 (e.g. $14.97 → $14.95, $14.98 → $15.00).
                Card, gift card, and all other tender types always use exact amounts.
                This setting is store-wide and applies to all registers.
              </p>
            </div>
          </section>

          <section className="space-y-6">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 flex items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                 <Volume2 size={20} />
              </div>
              <div>
                <h3 className="text-lg font-black tracking-tight">Audio &amp; Feedback</h3>
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
                <h3 className="text-lg font-black tracking-tight">Printer &amp; Peripherals</h3>
                <p className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Receipt automation and workstation hardware setup</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="ui-card p-6 border-app-border space-y-6">
                <div className="flex items-center justify-between border-b border-app-border pb-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Receipt Automation</p>
                  <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                </div>
                <button 
                  type="button"
                  onClick={toggleAutoPrintReceipts}
                  className={`flex w-full items-center justify-between rounded-xl border p-4 transition-all ${autoPrintReceipts ? 'border-app-text bg-app-accent/10 border-2' : 'border-app-border bg-app-surface'}`}
                >
                   <div className="text-left">
                      <p className="text-sm font-black uppercase italic tracking-tighter">Auto-Print</p>
                      <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">Print customer receipts after checkout</p>
                   </div>
                   <div className={`h-6 w-12 rounded-full p-1 transition-colors ${autoPrintReceipts ? 'bg-app-text shadow-inner' : 'bg-app-border'}`}>
                      <div className={`h-4 w-4 rounded-full bg-app-surface shadow-sm transition-transform ${autoPrintReceipts ? 'translate-x-6 shadow-lg' : 'translate-x-0'}`} />
                   </div>
                </button>
              </div>

              <div className="ui-card p-6 border-app-border space-y-6">
                <div className="flex items-center justify-between border-b border-app-border pb-3">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Hardware Setup</p>
                  <div className="h-2 w-2 rounded-full bg-blue-500/40" />
                </div>
                <p className="text-xs font-semibold leading-relaxed text-app-text-muted">
                  Configure Receipt, Tag, and Reports printer targets from Printers &amp; Scanners so every print path uses the same station settings.
                </p>
                <button
                  type="button"
                  onClick={onOpenPrintingSettings}
                  disabled={!onOpenPrintingSettings}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50"
                >
                  Open Printers &amp; Scanners
                </button>
              </div>
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
