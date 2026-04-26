import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileText, RefreshCw, Save } from "lucide-react";
import { transform } from "receiptline";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

export interface ReceiptConfig {
  store_name: string;
  show_address: boolean;
  show_phone: boolean;
  show_email: boolean;
  show_loyalty_earned: boolean;
  show_loyalty_balance: boolean;
  show_barcode: boolean;
  header_lines: string[];
  footer_lines: string[];
  timezone?: string;
  receipt_studio_project_json?: unknown;
  receipt_studio_exported_html?: string | null;
  receipt_thermal_mode?: string;
}

export default function ReceiptBuilderPanel({ baseUrl }: { baseUrl: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ReceiptConfig | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setSettingsReady(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
      } else {
        setCfg(null);
        toast("Could not load receipt settings", "error");
      }
    } catch {
      setCfg(null);
      toast("Could not load receipt settings", "error");
    } finally {
      setSettingsReady(true);
    }
  }, [baseUrl, backofficeHeaders, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveReceiptSettings = async () => {
    if (!cfg) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ ...cfg, receipt_thermal_mode: "escpos" }),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast("Epson receipt settings applied", "success");
      } else {
        toast("Failed to save settings", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!settingsReady || cfg == null) {
    return (
      <p className="text-sm font-medium text-app-text-muted">
        Loading receipt settings...
      </p>
    );
  }

  const getReceiptLineMarkup = () => {
    return `${cfg.store_name}
{address: ${cfg.show_address ? "Enabled" : "Disabled"}}
{phone: ${cfg.show_phone ? "Enabled" : "Disabled"}}
^^^RECEIPT
---
Item A | $10.00
Item B | $20.00
---
Total | $30.00
---
Thank you for shopping at
${cfg.store_name}
    `;
  };

  const receiptLineSvg = transform(getReceiptLineMarkup(), { cpl: 42, encoding: "cp437" });

  return (
    <div className="space-y-8">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-accent/25 bg-gradient-to-br from-app-accent/15 to-transparent text-app-accent">
            <FileText className="h-7 w-7" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              Receipt Settings
            </h2>
            <p className="max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
              Standard Epson receipts use structured ESC/POS output for the TM-m30III. Use this panel for receipt header, footer, and section visibility.
            </p>
          </div>
        </div>
      </header>

      <section className="ui-card p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
              Primary Engine
            </h3>
            <p className="max-w-2xl text-xs font-semibold leading-relaxed text-app-text-muted">
              Epson ESC/POS is the active production receipt path. HTML designer modes are no longer exposed for register receipts.
            </p>
          </div>
          <span className="w-fit rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
            Standard Epson
          </span>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <section className="ui-card h-full border-l-4 border-app-text p-8">
            <div className="mb-8 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="rounded-2xl bg-app-text p-3 text-white shadow-lg">
                  <FileText size={24} />
                </div>
                <div>
                  <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">
                    Standard Print Config
                  </h3>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    Header text & line toggles
                  </p>
                </div>
              </div>
              <button
                onClick={saveReceiptSettings}
                disabled={busy}
                className="flex h-10 items-center gap-2 rounded-xl bg-app-text px-6 text-[10px] font-black uppercase tracking-widest text-white transition-all hover:bg-black/80 disabled:opacity-50"
              >
                {busy ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                Apply
              </button>
            </div>

            <div className="space-y-6">
              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                  Store Identifier (Header)
                </span>
                <input
                  value={cfg.store_name}
                  onChange={(e) => setCfg({ ...cfg, store_name: e.target.value })}
                  className="ui-input mt-2 w-full text-lg font-black italic tracking-tighter"
                />
              </label>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[
                  ["show_address", "Store Address", "123 Main St..."],
                  ["show_phone", "Phone Number", "(555) 123..."],
                  ["show_email", "Email Contact", "sales@..."],
                  ["show_barcode", "Order Barcode", "CODE-128"],
                  ["show_loyalty_earned", "Loyalty Rewards", "Earned Points"],
                  ["show_loyalty_balance", "Points Balance", "Total Tier"],
                ].map(([k, label, sub]) => (
                  <label
                    key={k}
                    className="group flex cursor-pointer items-center gap-3 rounded-xl border border-app-border p-3 transition-all hover:border-app-accent"
                  >
                    <div
                      className={`flex h-5 w-5 items-center justify-center rounded border-2 transition-all ${cfg[k as keyof ReceiptConfig] === true ? "border-app-accent bg-app-accent text-white" : "border-app-border group-hover:border-app-accent"}`}
                    >
                      {cfg[k as keyof ReceiptConfig] === true ? (
                        <CheckCircle2 size={12} />
                      ) : null}
                    </div>
                    <input
                      type="checkbox"
                      checked={cfg[k as keyof ReceiptConfig] === true}
                      onChange={(e) =>
                        setCfg({ ...cfg, [k]: e.target.checked } as ReceiptConfig)
                      }
                      className="sr-only"
                    />
                    <div>
                      <p className="text-[10px] font-black uppercase leading-none tracking-widest text-app-text">
                        {label}
                      </p>
                      <p className="mt-1 text-[9px] font-bold text-app-text-muted opacity-60">
                        {sub}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </section>
        </div>
        <div className="xl:col-span-5">
          <section className="ui-card h-full bg-app-surface/30 p-8">
            <h3 className="mb-6 text-[10px] font-black uppercase tracking-widest text-app-text">
              Thermal Preview (Epson)
            </h3>
            <div className="flex justify-center overflow-hidden rounded-[2rem] bg-[#f0f0f0] p-8 shadow-inner">
              <div
                dangerouslySetInnerHTML={{ __html: receiptLineSvg }}
                style={{ transform: "scale(1.2)", transformOrigin: "top center" }}
              />
            </div>
            <p className="mt-6 text-center text-[10px] font-bold italic text-app-text-muted">
              Preview approximates the standard 42-column Epson receipt layout.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
