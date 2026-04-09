import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FileText, RefreshCw } from "lucide-react";
import ReceiptStudioEditor, { type ReceiptStudioApi } from "./ReceiptStudioEditor";
import { RECEIPT_TEMPLATE_PRESETS } from "./receiptTemplatePresets";
import { GRAPESJS_STUDIO_LICENSE_KEY } from "../../lib/grapesjsStudioLicense";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { useToast } from "../ui/ToastProvider";

type ReceiptBuilderApiConfig = {
  receipt_studio_project_json?: unknown;
  receipt_studio_exported_html?: string | null;
  receipt_thermal_mode?: string;
};

export default function ReceiptBuilderPanel({ baseUrl }: { baseUrl: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ReceiptBuilderApiConfig | null>(null);
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
        setCfg((await res.json()) as ReceiptBuilderApiConfig);
      } else {
        setCfg({});
        toast("Could not load receipt settings", "error");
      }
    } catch {
      setCfg({});
      toast("Could not load receipt settings", "error");
    } finally {
      setSettingsReady(true);
    }
  }, [baseUrl, backofficeHeaders, toast]);

  useEffect(() => {
    void load();
  }, [load]);

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
        setCfg((await res.json()) as ReceiptBuilderApiConfig);
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
        setCfg((await res.json()) as ReceiptBuilderApiConfig);
        toast("Register print mode updated", "success");
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
      if (!w) toast("Popup blocked — allow popups for preview", "error");
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
        setCfg((await res.json()) as ReceiptBuilderApiConfig);
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
        setCfg((await res.json()) as ReceiptBuilderApiConfig);
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
        Loading receipt builder…
      </p>
    );
  }

  const thermal =
    cfg.receipt_thermal_mode === "studio_html"
      ? "studio_html"
      : cfg.receipt_thermal_mode === "escpos_raster"
        ? "escpos_raster"
        : "zpl";

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
              Document-mode Studio with an <strong className="text-app-text">Epson TM-m30III</strong>{" "}
              576px device, printable preset, and <strong className="text-app-text">Receipt</strong>{" "}
              blocks. Tokens like{" "}
              <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                {"{{ROS_STORE_NAME}}"}
              </code>{" "}
              merge on the server. <strong className="text-app-text">Epson raster</strong> prints HTML →
              PNG → ESC/POS (not ZPL).
            </p>
          </div>
        </div>
      </header>

      <section className="ui-card p-6 max-w-2xl space-y-4">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
          Register print mode
        </h3>
        <p className="text-xs text-app-text-muted leading-relaxed">
          <strong className="text-app-text">Zebra ZPL</strong> — legacy server template.{" "}
          <strong className="text-app-text">Studio HTML</strong> — system print dialog.{" "}
          <strong className="text-app-text">Epson TM raster</strong> — merged HTML is rasterized in the
          client, converted to ESC/POS on the server, then sent to TCP port 9100 (TM-m30III / ESC/POS).
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <label className="flex items-center gap-2 text-sm font-bold">
            <input
              type="radio"
              name="ros-thermal-mode"
              checked={thermal === "zpl"}
              onChange={() => void saveThermalMode("zpl")}
              disabled={busy}
            />
            Zebra ZPL
          </label>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input
              type="radio"
              name="ros-thermal-mode"
              checked={thermal === "studio_html"}
              onChange={() => void saveThermalMode("studio_html")}
              disabled={busy}
            />
            Studio HTML (browser print)
          </label>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input
              type="radio"
              name="ros-thermal-mode"
              checked={thermal === "escpos_raster"}
              onChange={() => void saveThermalMode("escpos_raster")}
              disabled={busy}
            />
            Epson TM raster (ESC/POS)
          </label>
        </div>
      </section>

      <section className="ui-card p-4 max-w-xl space-y-2">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
          Start from template
        </h3>
        <p className="text-xs text-app-text-muted">
          Applies a preset layout to saved project JSON (use Save in Studio or wait for autosave to
          refresh exported HTML).
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
            <option value="current">Choose template…</option>
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
  );
}
