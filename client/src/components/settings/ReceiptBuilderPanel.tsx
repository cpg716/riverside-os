import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FileText, Image as ImageIcon, RefreshCw, Save } from "lucide-react";
import { transform } from "receiptline";
import RiversideReceiptLogo from "../../assets/images/logo1.png";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const EPSON_RECEIPT_CPL = 42;
const EPSON_RECEIPT_PAPER = "80mm";
const RECEIPT_LOGO_WIDTH_PX = 180;

export interface ReceiptConfig {
  store_name: string;
  show_address: boolean;
  show_phone: boolean;
  show_email: boolean;
  show_loyalty_earned: boolean;
  show_loyalty_balance: boolean;
  show_barcode: boolean;
  show_logo?: boolean;
  header_lines: string[];
  footer_lines: string[];
  timezone?: string;
  receipt_studio_project_json?: unknown;
  receipt_studio_exported_html?: string | null;
  receipt_thermal_mode?: string;
  receiptline_template?: string | null;
}

const DEFAULT_RECEIPTLINE_TEMPLATE = `{{LOGO_IMAGE}}
{{STORE_NAME}}
{{HEADER_LINES}}
{{RECEIPT_TITLE}}
{{RECEIPT_ID}}
{{RECEIPT_DATE}}
{{CUSTOMER_LINE}}
---
{{ITEM_LINES}}
{{PAYMENT_BLOCK}}
{{TOTAL_LINE}}
{{PAID_LINE}}
{{BALANCE_LINE}}
{{TENDER_LINE}}
{{STATUS_LINE}}
{{TAX_EXEMPT_LINE}}
---
{{FOOTER_LINES}}
{{CUT}}`;

function linesToText(lines: string[]) {
  return lines.join("\n");
}

function textToLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeReceiptlineText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function centeredLines(lines: string[]) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `^${escapeReceiptlineText(line)}`)
    .join("\n");
}

function receiptTemplateWithLogoSlot(template: string, showLogo: boolean) {
  if (!showLogo || template.includes("{{LOGO_IMAGE}}")) {
    return template;
  }
  return `{{LOGO_IMAGE}}\n${template}`;
}

async function loadReceiptLogoBase64() {
  const image = new Image();
  image.decoding = "async";
  image.src = RiversideReceiptLogo;
  await image.decode();

  const scale = RECEIPT_LOGO_WIDTH_PX / image.naturalWidth;
  const canvas = document.createElement("canvas");
  canvas.width = RECEIPT_LOGO_WIDTH_PX;
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

export default function ReceiptBuilderPanel({ baseUrl }: { baseUrl: string }) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [cfg, setCfg] = useState<ReceiptConfig | null>(null);
  const [settingsReady, setSettingsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receiptLogoBase64, setReceiptLogoBase64] = useState("");

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

  useEffect(() => {
    let mounted = true;
    loadReceiptLogoBase64()
      .then((value) => {
        if (mounted) setReceiptLogoBase64(value);
      })
      .catch(() => {
        if (mounted) setReceiptLogoBase64("");
      });
    return () => {
      mounted = false;
    };
  }, []);

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

  const showLogo = cfg.show_logo !== false;
  const effectiveTemplate = receiptTemplateWithLogoSlot(
    cfg.receiptline_template?.trim() || DEFAULT_RECEIPTLINE_TEMPLATE,
    showLogo,
  );
  const getReceiptLineMarkup = () =>
    effectiveTemplate
      .replace(
        "{{LOGO_IMAGE}}",
        showLogo && receiptLogoBase64 ? `{image:${receiptLogoBase64}}` : "",
      )
      .replace("{{STORE_NAME}}", `^${escapeReceiptlineText(cfg.store_name)}`)
      .replace("{{HEADER_LINES}}", centeredLines(cfg.header_lines))
      .replace("{{RECEIPT_TITLE}}", "^^^RECEIPT")
      .replace("{{RECEIPT_ID}}", "^Receipt TXN-66736")
      .replace("{{RECEIPT_DATE}}", "^04/26/2026 02:14 AM")
      .replace("{{CUSTOMER_LINE}}", "Customer: Chris Garcia")
      .replace(
        "{{ITEM_LINES}}",
        [
          "1x 100% Lambswool Sweater | $83.80",
          "SKU I-1003713601",
          "Taken home today",
          cfg.show_loyalty_earned ? "Loyalty earned | 84 pts" : "",
          cfg.show_loyalty_balance ? "Loyalty balance | 1,240 pts" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .replace("{{PAYMENT_BLOCK}}", "")
      .replace("{{TOTAL_LINE}}", "^Total | ^$83.80")
      .replace("{{PAID_LINE}}", "Paid | $83.80")
      .replace("{{BALANCE_LINE}}", "")
      .replace("{{TENDER_LINE}}", "Tender | Cash")
      .replace("{{STATUS_LINE}}", "Status | Paid")
      .replace("{{TAX_EXEMPT_LINE}}", "")
      .replace("{{FOOTER_LINES}}", centeredLines(cfg.footer_lines))
      .replace("{{CUT}}", "=");

  const receiptLineSvg = transform(getReceiptLineMarkup(), {
    cpl: EPSON_RECEIPT_CPL,
    encoding: "cp437",
  });

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
              Standard Epson receipts use structured ESC/POS output for the TM-m30III. Edit the store identity, header and footer lines, and receipt sections that print on the customer copy.
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
              ReceiptLine markdown is the active Epson template. ROS merges sale data into this template, previews it as SVG, then prints it through the Epson ESC/POS path.
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
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <label className="block lg:col-span-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Identifier (Top Line)
                  </span>
                  <input
                    value={cfg.store_name}
                    onChange={(e) => setCfg({ ...cfg, store_name: e.target.value })}
                    className="ui-input mt-2 w-full text-lg font-black italic tracking-tighter"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Header Lines
                  </span>
                  <textarea
                    value={linesToText(cfg.header_lines)}
                    onChange={(e) =>
                      setCfg({ ...cfg, header_lines: textToLines(e.target.value) })
                    }
                    rows={5}
                    className="ui-input mt-2 min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
                    placeholder={"Open daily 10-6\nAlterations pickup at rear counter"}
                  />
                  <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                    One centered receipt line per row.
                  </p>
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Footer Lines
                  </span>
                  <textarea
                    value={linesToText(cfg.footer_lines)}
                    onChange={(e) =>
                      setCfg({ ...cfg, footer_lines: textToLines(e.target.value) })
                    }
                    rows={5}
                    className="ui-input mt-2 min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
                    placeholder={"Thank you for shopping with us!\nVisit us again soon."}
                  />
                  <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                    Prints at the bottom before the receipt cut.
                  </p>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[
                  ["show_logo", "Receipt Logo", "Top image"],
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

              <label className="block">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                  ReceiptLine Template
                </span>
                <textarea
                  value={effectiveTemplate}
                  onChange={(e) =>
                    setCfg({ ...cfg, receiptline_template: e.target.value })
                  }
                  rows={15}
                  spellCheck={false}
                  className="ui-input mt-2 min-h-72 w-full resize-y font-mono text-xs leading-relaxed"
                />
                <p className="mt-2 text-[10px] font-semibold leading-relaxed text-app-text-muted">
                  Tokens are replaced by ROS at print time. Keep line items, totals, and payment tokens in the template so receipts remain financially complete.
                </p>
                <div className="mt-3 flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-app-accent" aria-hidden />
                  <p className="text-[10px] font-semibold leading-relaxed text-app-text-muted">
                    The logo token prints a thermal-sized monochrome-friendly PNG at the top of the receipt. Use the Receipt Logo toggle to hide it without removing the token from the template.
                  </p>
                </div>
              </label>

              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Available Tokens
                </p>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-app-text-muted">
                  {"{{LOGO_IMAGE}} {{STORE_NAME}} {{HEADER_LINES}} {{RECEIPT_TITLE}} {{RECEIPT_ID}} {{RECEIPT_DATE}} {{CUSTOMER_LINE}} {{ITEM_LINES}} {{PAYMENT_BLOCK}} {{TOTAL_LINE}} {{PAID_LINE}} {{BALANCE_LINE}} {{TENDER_LINE}} {{STATUS_LINE}} {{TAX_EXEMPT_LINE}} {{FOOTER_LINES}} {{CUT}}"}
                </p>
              </div>
            </div>
          </section>
        </div>
        <div className="xl:col-span-5">
          <section className="ui-card h-full bg-app-surface/30 p-8">
            <h3 className="mb-6 text-[10px] font-black uppercase tracking-widest text-app-text">
              {EPSON_RECEIPT_PAPER} Epson preview
            </h3>
            <div className="flex justify-center overflow-x-auto rounded-[2rem] bg-[#f0f0f0] p-4 shadow-inner sm:p-6">
              <div
                className="receiptline-preview w-full max-w-[360px] [&_svg]:h-auto [&_svg]:w-full"
                dangerouslySetInnerHTML={{ __html: receiptLineSvg }}
              />
            </div>
            <p className="mt-6 text-center text-[10px] font-bold italic text-app-text-muted">
              Preview uses the {EPSON_RECEIPT_PAPER} Epson customer receipt
              layout. ReceiptLine formats text at {EPSON_RECEIPT_CPL} characters
              per line for this template.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
