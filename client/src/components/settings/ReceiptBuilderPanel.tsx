import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Image as ImageIcon, RefreshCw, RotateCcw, Save } from "lucide-react";
import { transform } from "receiptline";
import RiversideReceiptLogo from "../../assets/images/riverside_logo.jpg";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { printRawEscPosBase64, resolvePrinterAddress } from "../../lib/printerBridge";
import { useToast } from "../ui/ToastProviderLogic";

const EPSON_RECEIPT_CPL = 42;
const EPSON_RECEIPT_PAPER = "80mm";
const RECEIPT_LOGO_WIDTH_PX = 384;

export interface ReceiptConfig {
  store_name: string;
  show_address: boolean;
  show_phone: boolean;
  show_email: boolean;
  show_loyalty_earned: boolean;
  show_loyalty_balance: boolean;
  show_barcode: boolean;
  show_logo?: boolean;
  store_address?: string;
  store_phone?: string;
  store_email?: string;
  header_lines: string[];
  footer_lines: string[];
  timezone?: string;
  receipt_studio_project_json?: unknown;
  receipt_studio_exported_html?: string | null;
  receipt_thermal_mode?: string;
  receiptline_template?: string | null;
}

const DEFAULT_RECEIPTLINE_TEMPLATE = `{{LOGO_IMAGE}}
{{HEADER_LINES}}
{{RECEIPT_TITLE}}
{{RECEIPT_ID}}
{{RECEIPT_DATE}}
{{CUSTOMER_LINE}}
{{SALESPERSON_LINE}}
{{CASHIER_LINE}}
---
{{ITEM_LINES}}
{{LOYALTY_EARNED}}
{{LOYALTY_BALANCE}}
{{PAYMENT_BLOCK}}
{{TOTAL_LINE}}
{{PAID_LINE}}
{{BALANCE_LINE}}
{{TENDER_LINE}}
{{STATUS_LINE}}
{{TAX_EXEMPT_LINE}}
---
{{BARCODE_IMAGE}}
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
    .map((line) => `| ${escapeReceiptlineText(line)} |`)
    .join("\n");
}

function binaryStringToBase64(value: string) {
  let binary = "";
  for (let i = 0; i < value.length; i += 1) {
    binary += String.fromCharCode(value.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}

function receiptTemplateWithSlots(template: string, showLogo: boolean, showBarcode: boolean) {
  let next = template;
  if (showLogo && !next.includes("{{LOGO_IMAGE}}")) {
    next = `{{LOGO_IMAGE}}\n${next}`;
  }
  if (showBarcode && !next.includes("{{BARCODE_IMAGE}}")) {
    if (next.includes("{{FOOTER_LINES}}")) {
      // Use replace with a function or just replace the first occurrence to be safe
      const parts = next.split("{{FOOTER_LINES}}");
      next = parts[0] + "{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}" + parts.slice(1).join("{{FOOTER_LINES}}");
    } else {
      next = `${next}\n{{BARCODE_IMAGE}}`;
    }
  }
  return next;
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
  const [testPrinting, setTestPrinting] = useState(false);
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
  const effectiveTemplate = receiptTemplateWithSlots(
    cfg.receiptline_template?.trim() || DEFAULT_RECEIPTLINE_TEMPLATE,
    showLogo,
    cfg.show_barcode === true,
  );
  const headerLineValues = [
    cfg.show_address ? cfg.store_address?.trim() || "2760 Delaware Ave, Buffalo, NY" : "",
    cfg.show_phone ? cfg.store_phone?.trim() || "(716) 876-2424" : "",
    cfg.show_email ? cfg.store_email?.trim() || "service@riversidemensshop.com" : "",
    ...cfg.header_lines,
  ].filter(Boolean);
  const getReceiptLineMarkup = () =>
    effectiveTemplate
      .replaceAll(
        "{{LOGO_IMAGE}}",
        showLogo && receiptLogoBase64 ? `{image:${receiptLogoBase64}}` : "",
      )
      .replaceAll("{{STORE_NAME}}", `| ^^${escapeReceiptlineText(cfg.store_name)} |`)
      .replaceAll("{{HEADER_LINES}}", centeredLines(headerLineValues))
      .replaceAll("{{RECEIPT_TITLE}}", "| ^^^RECEIPT |")
      .replaceAll("{{RECEIPT_ID}}", "| Receipt TXN-66736 |")
      .replaceAll("{{RECEIPT_DATE}}", "| 04/26/2026 02:14 AM |")
      .replaceAll("{{CUSTOMER_LINE}}", "Customer: Chris Garcia")
      .replaceAll("{{SALESPERSON_LINE}}", "Salesperson: Taylor M.")
      .replaceAll("{{CASHIER_LINE}}", "Cashier: Alex B.")
      .replaceAll(
        "{{ITEM_LINES}}",
        [
          "^^^Taken Today",
          "1x 100% Lambswool Sweater",
          "SKU I-1003713601 | $83.80",
          "Reg $104.75 Sale $83.80 (20% Discount)",
          "",
          "^^^PICKED UP",
          "1x Tuxedo Shirt",
          "SKU I-40092182 | $65.00",
          "",
          "^^^SHIPPED",
          "1x Silk Tie",
          "SKU I-50012345 | $45.00",
          "",
          "^^^Special Order",
          "NOTICE: Size 42R requested",
          "1x Custom Navy Blazer",
          "SKU I-2004829302 | $295.00",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .replaceAll("{{LOYALTY_EARNED}}", cfg.show_loyalty_earned ? "Loyalty earned | 84 pts" : "")
      .replaceAll("{{LOYALTY_BALANCE}}", cfg.show_loyalty_balance ? "Loyalty balance | 1,240 pts" : "")
      .replaceAll("{{PAYMENT_BLOCK}}", "")
      .replaceAll("{{TOTAL_LINE}}", "Total | ^^$83.80")
      .replaceAll("{{PAID_LINE}}", "Paid | $83.80")
      .replaceAll("{{BALANCE_LINE}}", "")
      .replaceAll("{{TENDER_LINE}}", "Tender | Cash")
      .replaceAll("{{STATUS_LINE}}", "Status | Paid")
      .replaceAll("{{TAX_EXEMPT_LINE}}", "")
      .replaceAll("{{BARCODE_IMAGE}}", cfg.show_barcode ? "{code:TXN-66736;option:code128,hri}" : "")
      .replaceAll("{{FOOTER_LINES}}", centeredLines(cfg.footer_lines))
      .replaceAll("{{CUT}}", "=");

  const requiredTokens = ["{{ITEM_LINES}}", "{{TOTAL_LINE}}", "{{PAID_LINE}}", "{{TENDER_LINE}}"];
  const missingRequiredTokens = requiredTokens.filter((token) => !effectiveTemplate.includes(token));

  const printTestReceipt = async () => {
    setTestPrinting(true);
    try {
      const command = transform(getReceiptLineMarkup(), {
        cpl: EPSON_RECEIPT_CPL,
        encoding: "cp437",
        command: "escpos",
        cutting: true,
      });
      const printer = resolvePrinterAddress("receipt");
      await printRawEscPosBase64(binaryStringToBase64(String(command)), printer.ip, printer.port);
      toast("Test receipt sent to the Epson receipt printer.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test receipt failed", "error");
    } finally {
      setTestPrinting(false);
    }
  };

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
              <button
                type="button"
                onClick={() => void printTestReceipt()}
                disabled={testPrinting}
                className="flex h-10 items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-5 text-[10px] font-black uppercase tracking-widest text-emerald-700 transition-all hover:bg-emerald-500/15 disabled:opacity-50 dark:text-emerald-300"
              >
                {testPrinting ? (
                  <RefreshCw className="h-3 w-3 animate-spin" />
                ) : (
                  <FileText size={14} />
                )}
                Print Test
              </button>
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <label className="block lg:col-span-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Identifier
                  </span>
                  <input
                    value={cfg.store_name}
                    onChange={(e) => setCfg({ ...cfg, store_name: e.target.value })}
                    className="ui-input mt-2 w-full text-lg font-black italic tracking-tighter"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Address
                  </span>
                  <input
                    value={cfg.store_address ?? ""}
                    onChange={(e) => setCfg({ ...cfg, store_address: e.target.value })}
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="2760 Delaware Ave, Buffalo, NY"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Phone
                  </span>
                  <input
                    value={cfg.store_phone ?? ""}
                    onChange={(e) => setCfg({ ...cfg, store_phone: e.target.value })}
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="(716) 876-2424"
                  />
                </label>

                <label className="block lg:col-span-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Email
                  </span>
                  <input
                    value={cfg.store_email ?? ""}
                    onChange={(e) => setCfg({ ...cfg, store_email: e.target.value })}
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="service@riversidemensshop.com"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Extra Header Lines
                  </span>
                  <textarea
                    value={linesToText(cfg.header_lines)}
                    onChange={(e) =>
                      setCfg({ ...cfg, header_lines: textToLines(e.target.value) })
                    }
                    rows={4}
                    className="ui-input mt-2 min-h-28 w-full resize-y font-mono text-xs leading-relaxed"
                    placeholder={"Open daily 10-6\nAlterations pickup at rear counter"}
                  />
                  <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                    Optional centered service notes below the store contact lines.
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
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    ["Logo", "{{LOGO_IMAGE}}"],
                    ["Header", "{{HEADER_LINES}}"],
                    ["Items", "{{ITEM_LINES}}"],
                    ["Totals", "{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}"],
                    ["Barcode", "{{BARCODE_IMAGE}}"],
                    ["Cut", "{{CUT}}"],
                  ].map(([label, token]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const tokens = token.split("\n");
                        let newTemplate = effectiveTemplate.trimEnd();
                        tokens.forEach(t => {
                          if (!newTemplate.includes(t)) {
                            newTemplate += `\n${t}`;
                          }
                        });
                        setCfg({
                          ...cfg,
                          receiptline_template: newTemplate,
                        });
                      }}
                      className="rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-app-text transition-colors hover:border-app-accent"
                    >
                      Add {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() =>
                      setCfg({ ...cfg, receiptline_template: DEFAULT_RECEIPTLINE_TEMPLATE })
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-amber-700 transition-colors hover:bg-amber-500/15"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset Standard
                  </button>
                </div>
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
                {missingRequiredTokens.length > 0 ? (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
                    <p className="text-[10px] font-bold leading-relaxed text-amber-800">
                      Missing financial receipt tokens: {missingRequiredTokens.join(", ")}.
                    </p>
                  </div>
                ) : null}
                {requiredTokens.some(t => effectiveTemplate.split(t).length > 2) ? (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border border-app-accent/30 bg-app-accent/10 p-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-app-accent" aria-hidden />
                    <p className="text-[10px] font-bold leading-relaxed text-app-accent">
                      Tip: Duplicate tokens detected. This will cause sections to repeat on the receipt as shown in the preview.
                    </p>
                  </div>
                ) : null}
                <div className="mt-3 flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-app-accent" aria-hidden />
                  <p className="text-[10px] font-semibold leading-relaxed text-app-text-muted">
                    The logo token prints the full Riverside Men's Shop logo lockup at the top of the receipt. Use the Receipt Logo toggle to hide it without removing the token from the template.
                  </p>
                </div>
              </label>

              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Available Tokens
                </p>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-app-text-muted">
                  {"{{LOGO_IMAGE}} {{STORE_NAME}} {{HEADER_LINES}} {{RECEIPT_TITLE}} {{RECEIPT_ID}} {{RECEIPT_DATE}} {{CUSTOMER_LINE}} {{SALESPERSON_LINE}} {{CASHIER_LINE}} {{ITEM_LINES}} {{LOYALTY_EARNED}} {{LOYALTY_BALANCE}} {{PAYMENT_BLOCK}} {{TOTAL_LINE}} {{PAID_LINE}} {{BALANCE_LINE}} {{TENDER_LINE}} {{STATUS_LINE}} {{TAX_EXEMPT_LINE}} {{BARCODE_IMAGE}} {{FOOTER_LINES}} {{CUT}}"}
                </p>
              </div>
            </div>
          </section>
        </div>
        <div className="xl:col-span-5">
          <section className="ui-card sticky top-24 h-fit bg-app-surface/30 p-8">
            <h3 className="mb-6 text-[10px] font-black uppercase tracking-widest text-app-text">
              {EPSON_RECEIPT_PAPER} Epson preview
            </h3>
            <div className="mb-4 rounded-2xl border border-app-border bg-white p-4">
              <img
                src={RiversideReceiptLogo}
                alt="Riverside Men's Shop receipt logo"
                className="mx-auto max-h-20 w-full max-w-sm object-contain"
              />
              <p className="mt-3 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Active receipt logo
              </p>
            </div>
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
