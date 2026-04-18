import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FileText, RefreshCw, Save, CheckCircle2 } from "lucide-react";
import ReceiptStudioEditor, { type ReceiptStudioApi } from "./ReceiptStudioEditor";
import { RECEIPT_TEMPLATE_PRESETS } from "./receiptTemplatePresets";
import { GRAPESJS_STUDIO_LICENSE_KEY } from "../../lib/grapesjsStudioLicense";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { transform } from "receiptline";

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
  const studioRef = useRef<ReceiptStudioApi | null>(null);
  const [studioMountKey, setStudioMountKey] = useState(0);

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
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast("Standard settings applied", "success");
      } else {
        toast("Failed to save settings", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const persistStudio = async (project: unknown) => {
    const html = studioRef.current ? await studioRef.current.exportHtml() : null;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        receipt_studio_project_json: project,
      };
      if (html != null && html.length > 0) {
        body.receipt_studio_exported_html = html;
      }
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast("Receipt layout saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(typeof j.error === "string" ? j.error : "Save failed", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const saveThermalMode = async (mode: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ receipt_thermal_mode: mode }),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast(`Mode switched to ${mode}`, "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(typeof j.error === "string" ? j.error : "Update failed", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const openSamplePreview = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt/preview-html`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        toast("Preview failed", "error");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank", "noopener,noreferrer");
      if (!w) toast("Popup blocked \u2014 allow popups for preview", "error");
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch {
      toast("Preview failed", "error");
    }
  };

  const applyTemplatePreset = async (presetId: string) => {
    if (presetId === "current") return;
    const preset = RECEIPT_TEMPLATE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          receipt_studio_project_json: preset.project,
        }),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast(`Applied template: ${preset.label}`, "success");
        setStudioMountKey((k) => k + 1);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(typeof j.error === "string" ? j.error : "Template apply failed", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const resyncExportedHtml = async () => {
    if (!studioRef.current) return;
    const html = await studioRef.current.exportHtml();
    if (!html) {
      toast("Could not export HTML", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          receipt_studio_exported_html: html,
        }),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        toast("Exported HTML synced", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(typeof j.error === "string" ? j.error : "Sync failed", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  if (!settingsReady || cfg == null) {
    return (
      <p className="text-sm font-medium text-app-text-muted">
        Loading receipt builder\u2026
      </p>
    );
  }

  const thermal =
    cfg.receipt_thermal_mode === "studio_html"
      ? "studio_html"
      : cfg.receipt_thermal_mode === "escpos_raster"
        ? "escpos_raster"
        : "zpl";

  // ReceiptLine preview generator
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
              Receipt Builder
            </h2>
            <p className="text-sm font-medium text-app-text-muted leading-relaxed max-w-3xl">
              Choose between the high-performance <strong className="text-app-text">Visual Builder</strong> or the reliable <strong className="text-app-text">Standard Logic</strong>.
            </p>
          </div>
        </div>
      </header>

      <section className="ui-card p-6 space-y-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="space-y-1">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
              Primary Engine
            </h3>
            <p className="text-xs text-app-text-muted leading-relaxed max-w-lg">
              <strong className="text-app-text">Standard (ZPL)</strong> uses a server-side template for maximum speed. 
              <strong className="text-app-text">Studio (HTML/Raster)</strong> allows for pixel-perfect drag-and-drop layouts.
            </p>
          </div>
          <div className="flex bg-app-bg/50 p-1 rounded-xl border border-app-border w-fit">
            {[
              { id: "zpl", label: "Standard (ZPL)" },
              { id: "studio_html", label: "Studio (HTML)" },
              { id: "escpos_raster", label: "Studio (Epson Raster)" },
            ].map((m) => (
              <button
                key={m.id}
                onClick={() => void saveThermalMode(m.id)}
                className={`px-4 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${thermal === m.id ? "bg-app-text text-white shadow-lg" : "text-app-text-muted hover:text-app-text"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      {thermal === "zpl" ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
          <div className="xl:col-span-7">
            <section className="ui-card p-8 border-l-4 border-app-text h-full">
              <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-2xl bg-app-text text-white shadow-lg">
                    <FileText size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">
                      Standard Print Config
                    </h3>
                    <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                      Header text & line toggles
                    </p>
                  </div>
                </div>
                <button
                  onClick={saveReceiptSettings}
                  disabled={busy}
                  className="h-10 px-6 rounded-xl bg-app-text text-white text-[10px] font-black uppercase tracking-widest hover:bg-black/80 transition-all flex items-center gap-2"
                >
                  {busy ? (
                    <RefreshCw className="w-3 h-3 animate-spin" />
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
                    onChange={(e) =>
                      setCfg({ ...cfg, store_name: e.target.value })
                    }
                    className="ui-input mt-2 w-full font-black text-lg tracking-tighter italic"
                  />
                </label>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    [
                      "show_address",
                      "Store Address",
                      "123 Main St...",
                    ],
                    ["show_phone", "Phone Number", "(555) 123..."],
                    ["show_email", "Email Contact", "sales@..."],
                    ["show_barcode", "Order Barcode", "CODE-128"],
                    [
                      "show_loyalty_earned",
                      "Loyalty Rewards",
                      "Earned Points",
                    ],
                    [
                      "show_loyalty_balance",
                      "Points Balance",
                      "Total Tier",
                    ],
                  ].map(([k, label, sub]) => (
                    <label
                      key={k}
                      className="flex items-center gap-3 p-3 rounded-xl border border-app-border hover:border-app-accent cursor-pointer group transition-all"
                    >
                      <div
                        className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-all ${cfg[k as keyof ReceiptConfig] === true ? "bg-app-accent border-app-accent text-white" : "border-app-border group-hover:border-app-accent"}`}
                      >
                        {cfg[k as keyof ReceiptConfig] === true ? (
                          <CheckCircle2 size={12} />
                        ) : null}
                      </div>
                      <input
                        type="checkbox"
                        checked={
                          cfg[k as keyof ReceiptConfig] === true
                        }
                        onChange={(e) =>
                          setCfg({ ...cfg, [k]: e.target.checked } as ReceiptConfig)
                        }
                        className="sr-only"
                      />
                      <div>
                        <p className="text-[10px] font-black uppercase text-app-text tracking-widest leading-none">
                          {label}
                        </p>
                        <p className="text-[9px] text-app-text-muted mt-1 opacity-60 font-bold">
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
             <section className="ui-card p-8 h-full bg-app-surface/30">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text mb-6">
                  Thermal Preview (CLI Style)
                </h3>
                <div className="bg-[#f0f0f0] p-8 rounded-[2rem] shadow-inner overflow-hidden flex justify-center">
                   <div 
                    dangerouslySetInnerHTML={{ __html: receiptLineSvg }} 
                    style={{ transform: "scale(1.2)", transformOrigin: "top center" }}
                   />
                </div>
                <p className="text-[10px] font-bold text-app-text-muted mt-6 text-center italic">
                  Preview generated via ReceiptLine for high-fidelity ZPL simulation.
                </p>
             </section>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <section className="ui-card p-4 max-w-xl space-y-2 flex-1">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
                Start from template
              </h3>
              <p className="text-xs text-app-text-muted">
                Applies a preset layout to saved project JSON.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="ui-input max-w-xs text-xs font-bold"
                  defaultValue="current"
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "current") void applyTemplatePreset(v);
                    e.target.value = "current";
                  }}
                  disabled={busy}
                  aria-label="Apply receipt layout template"
                >
                  <option value="current">Choose template\u2026</option>
                  {RECEIPT_TEMPLATE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
            </section>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void openSamplePreview()}
                disabled={busy}
                className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                <Eye className="h-3.5 w-3.5" aria-hidden />
                Preview sample merge
              </button>
              <button
                type="button"
                onClick={() => void resyncExportedHtml()}
                disabled={busy}
                className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
                Sync HTML only
              </button>
              <button
                type="button"
                onClick={() => setStudioMountKey((k) => k + 1)}
                disabled={busy}
                className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Reload editor
              </button>
            </div>
          </div>

          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted leading-relaxed max-w-4xl">
            Tokens:{" "}
            <code className="font-mono normal-case text-[10px]">
              {"{{ROS_STORE_NAME}} {{ROS_RECEIPT_TITLE}} {{ROS_ORDER_ID}} {{ROS_ORDER_DATE}} {{ROS_CUSTOMER_NAME}} {{ROS_ITEMS_TABLE}} {{ROS_PAYMENT_SUMMARY}} {{ROS_TOTAL}} {{ROS_AMOUNT_PAID}} {{ROS_BALANCE_DUE}} {{ROS_STATUS}} {{ROS_HEADER_LINES}} {{ROS_FOOTER_LINES}}"}
            </code>
          </p>

          <ReceiptStudioEditor
            key={studioMountKey}
            licenseKey={GRAPESJS_STUDIO_LICENSE_KEY}
            projectJson={cfg.receipt_studio_project_json ?? null}
            onSaveProject={async (p) => {
              await persistStudio(p);
            }}
            onEditorReady={(api) => {
              studioRef.current = api;
            }}
          />
        </div>
      )}
    </div>
  );
}
