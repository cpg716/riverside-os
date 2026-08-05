import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { transform } from "receiptline";
import RiversideReceiptLogo from "../../assets/images/riverside_logo.jpg";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  printReceiptBase64,
  receiptlineToEscposBase64,
} from "../../lib/receiptPrint";
import { receiptHtmlToPngBase64 } from "../../lib/receiptHtmlToPng";
import { useToast } from "../ui/ToastProviderLogic";
import { duplicateReceiptTokens } from "./receiptTemplateValidation";

const EPSON_RECEIPT_CPL = 48;
const EPSON_RECEIPT_PAPER = "80mm";
const RECEIPT_LOGO_WIDTH_PX = 384;
const RECEIPTLINE_FONT_B_ON = "{command:\\x1b\\x4d\\x01}";
const RECEIPTLINE_FONT_A_ON = "{command:\\x1b\\x4d\\x00}";

function previewTaxLines(
  localAmount: string,
  stateAmount: string,
  totalAmount: string,
) {
  return [
    RECEIPTLINE_FONT_B_ON,
    `4.75%: ${localAmount} 4.00%: ${stateAmount} Total Tax: ${totalAmount} |`,
    RECEIPTLINE_FONT_A_ON,
  ];
}

function compactReceiptLineTaxAmounts(markup: string): string {
  if (!markup.trim().startsWith("<svg") || typeof DOMParser === "undefined") {
    return markup;
  }
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  document.querySelectorAll("g[transform]").forEach((line) => {
    const text = line.textContent?.replace(/\s+/g, "") ?? "";
    if (/^(?:4\.75%|4\.00%|TotalTax):-?\$\d/.test(text)) {
      line.setAttribute("font-size", "16");
      line.setAttribute("fill", "#64748b");
    }
  });
  return document.documentElement.outerHTML;
}

type ReceiptPreviewScenario =
  "sale" | "mixed" | "pickup" | "return" | "exchange" | "gift";

const RECEIPT_PREVIEW_SCENARIOS: Array<{
  value: ReceiptPreviewScenario;
  label: string;
  description: string;
}> = [
  {
    value: "sale",
    label: "Retail sale",
    description: "A normal taken-today purchase.",
  },
  {
    value: "mixed",
    label: "Mixed transaction",
    description:
      "Taken today, pickup, shipping, fees, special/custom/wedding/layaway, and order payments.",
  },
  {
    value: "pickup",
    label: "Pickup and payment",
    description:
      "The dedicated picked-up template with prior and current payments.",
  },
  {
    value: "return",
    label: "Return / refund",
    description: "Returned merchandise and refund totals.",
  },
  {
    value: "exchange",
    label: "Return / exchange",
    description: "Returned and replacement merchandise together.",
  },
  {
    value: "gift",
    label: "Gift receipt",
    description: "Customer copy with prices and payments omitted.",
  },
];

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
  receiptline_pickup_template?: string | null;
}

const DEFAULT_RECEIPTLINE_TEMPLATE = `{{LOGO_IMAGE}}
{{HEADER_LINES}}
{{RECEIPT_TITLE}}
{{RECEIPT_ID}}
{{RECEIPT_DATE}}
{{CUSTOMER_LINE}}
{{SALESPERSON_LINE}}
{{CASHIER_LINE}}
{{REGISTER_LINE}}
---
{{ITEM_LINES}}
{{LOYALTY_EARNED}}
{{LOYALTY_BALANCE}}
{{PAYMENT_BLOCK}}
{{SUBTOTAL_LINE}}
{{TAX_LINE}}
{{TOTAL_SAVINGS_LINE}}
{{TOTAL_LINE}}
{{PAID_LINE}}
{{BALANCE_LINE}}
{{TENDER_LINE}}
{{GIFT_CARD_BALANCE}}
{{WEDDING_DEPOSIT_LINES}}
{{STATUS_LINE}}
{{TAX_EXEMPT_LINE}}
---
{{BARCODE_IMAGE}}
{{FOOTER_LINES}}
{{CUT}}`;

const DEFAULT_RECEIPTLINE_PICKUP_TEMPLATE = `{{LOGO_IMAGE}}
{{HEADER_LINES}}
{{RECEIPT_TITLE}}
{{RECEIPT_ID}}
{{RECEIPT_DATE}}
{{CUSTOMER_LINE}}
{{SALESPERSON_LINE}}
{{CASHIER_LINE}}
{{REGISTER_LINE}}
---
{{ITEM_LINES}}
---
{{PAYMENT_BLOCK}}
{{SUBTOTAL_LINE}}
{{TAX_LINE}}
{{TOTAL_SAVINGS_LINE}}
{{TOTAL_LINE}}
{{PAID_LINE}}
{{BALANCE_LINE}}
{{GIFT_CARD_BALANCE}}
{{WEDDING_DEPOSIT_LINES}}
{{STATUS_LINE}}
---
{{BARCODE_IMAGE}}
{{FOOTER_LINES}}
{{CUT}}`;

function linesToText(lines: string[]) {
  return lines.join("\n");
}

function textToLines(value: string) {
  return value.split(/\r?\n/);
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

function receiptTemplateWithSlots(
  template: string,
  showLogo: boolean,
  showBarcode: boolean,
) {
  let next = template;
  if (showLogo && !next.includes("{{LOGO_IMAGE}}")) {
    next = `{{LOGO_IMAGE}}\n${next}`;
  }
  if (showBarcode && !next.includes("{{BARCODE_IMAGE}}")) {
    if (next.includes("{{FOOTER_LINES}}")) {
      // Use replace with a function or just replace the first occurrence to be safe
      const parts = next.split("{{FOOTER_LINES}}");
      next =
        parts[0] +
        "{{BARCODE_IMAGE}}\n{{FOOTER_LINES}}" +
        parts.slice(1).join("{{FOOTER_LINES}}");
    } else {
      next = `${next}\n{{BARCODE_IMAGE}}`;
    }
  }
  if (!next.includes("{{RECEIPT_DATE}}")) {
    next = next.includes("{{RECEIPT_ID}}")
      ? next.replace("{{RECEIPT_ID}}", "{{RECEIPT_ID}}\n{{RECEIPT_DATE}}")
      : `{{RECEIPT_DATE}}\n${next}`;
  }
  if (!next.includes("{{REGISTER_LINE}}")) {
    next = next.includes("{{CASHIER_LINE}}")
      ? next.replace("{{CASHIER_LINE}}", "{{CASHIER_LINE}}\n{{REGISTER_LINE}}")
      : `${next}\n{{REGISTER_LINE}}`;
  }
  ["{{SUBTOTAL_LINE}}", "{{TAX_LINE}}", "{{TOTAL_SAVINGS_LINE}}"].forEach(
    (token) => {
      if (!next.includes(token)) {
        next = next.includes("{{TOTAL_LINE}}")
          ? next.replace("{{TOTAL_LINE}}", `${token}\n{{TOTAL_LINE}}`)
          : `${next}\n${token}`;
      }
    },
  );
  if (!next.includes("{{WEDDING_DEPOSIT_LINES}}")) {
    next = next.includes("{{STATUS_LINE}}")
      ? next.replace(
          "{{STATUS_LINE}}",
          "{{WEDDING_DEPOSIT_LINES}}\n{{STATUS_LINE}}",
        )
      : `${next}\n{{WEDDING_DEPOSIT_LINES}}`;
  }
  if (!next.includes("{{PAYMENT_BLOCK}}")) {
    if (next.includes("{{PAYMENT_HISTORY_BLOCK}}")) {
      next = next.replace(
        "{{PAYMENT_HISTORY_BLOCK}}",
        "{{PAYMENT_BLOCK}}\n{{PAYMENT_HISTORY_BLOCK}}",
      );
    } else if (next.includes("{{SUBTOTAL_LINE}}")) {
      next = next.replace(
        "{{SUBTOTAL_LINE}}",
        "{{PAYMENT_BLOCK}}\n{{SUBTOTAL_LINE}}",
      );
    } else {
      next = `${next}\n{{PAYMENT_BLOCK}}`;
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
  const [testDelivery, setTestDelivery] = useState<"email" | "sms" | null>(
    null,
  );
  const [testEmail, setTestEmail] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [receiptLogoBase64, setReceiptLogoBase64] = useState("");
  const [activeTab, setActiveTab] = useState<"standard" | "pickup">("standard");
  const [previewScenario, setPreviewScenario] =
    useState<ReceiptPreviewScenario>("mixed");

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
  const standardEffectiveTemplate = receiptTemplateWithSlots(
    cfg.receiptline_template?.trim() || DEFAULT_RECEIPTLINE_TEMPLATE,
    showLogo,
    cfg.show_barcode === true,
  );
  const pickupEffectiveTemplate = receiptTemplateWithSlots(
    cfg.receiptline_pickup_template?.trim() ||
      DEFAULT_RECEIPTLINE_PICKUP_TEMPLATE,
    showLogo,
    cfg.show_barcode === true,
  );
  const effectiveTemplate =
    activeTab === "standard"
      ? standardEffectiveTemplate
      : pickupEffectiveTemplate;
  const headerLineValues = [
    cfg.show_address
      ? cfg.store_address?.trim() || "6470 Transit Rd, Depew, NY"
      : "",
    cfg.show_phone ? cfg.store_phone?.trim() || "(716) 833-8401" : "",
    cfg.show_email ? cfg.store_email?.trim() || "info@riversidemens.com" : "",
    ...cfg.header_lines,
  ].filter(Boolean);
  const isGiftPreview = previewScenario === "gift";
  const previewTitle =
    previewScenario === "return"
      ? "RETURN / REFUND"
      : previewScenario === "exchange"
        ? "RETURN / EXCHANGE"
        : isGiftPreview
          ? "GIFT RECEIPT"
          : "RECEIPT";
  const previewItemLines = (() => {
    switch (previewScenario) {
      case "sale":
        return [
          "^^^Taken Today",
          '"100% Lambswool Sweater" |',
          "Variation: Medium / Navy |",
          "| SKU I-1003713601 | $83.80",
          "Reg $104.75 Sale $83.80 (20% Discount) |",
          ...previewTaxLines("$3.98", "$0.00", "$3.98"),
        ].join("\n");
      case "pickup":
        return [
          '"Tuxedo Jacket" |',
          "Variation: 42R / Black |",
          "Order Date: 04/10/2026 01:15 PM |",
          "| SKU I-40092180 | $350.00",
          ...previewTaxLines("$16.63", "$14.00", "$30.63"),
          "",
          '"Tuxedo Pants" |',
          "Variation: 34 / Black |",
          "Order Date: 04/10/2026 01:15 PM |",
          "| SKU I-40092181 | $150.00",
          ...previewTaxLines("$7.13", "$6.00", "$13.13"),
        ].join("\n");
      case "return":
        return [
          "^^^RETURNED / REFUNDED",
          '"100% Lambswool Sweater" |',
          "Variation: Medium / Navy |",
          "| SKU I-1003713601 | -$83.80",
          ...previewTaxLines("-$3.98", "$0.00", "-$3.98"),
        ].join("\n");
      case "exchange":
        return [
          "^^^EXCHANGED",
          '"Tuxedo Shirt - White" |',
          "Variation: 16.5 / 34-35 |",
          "| SKU I-40092182 | -$65.00",
          ...previewTaxLines("-$3.09", "$0.00", "-$3.09"),
          "",
          "^^^Taken Today",
          '"Tuxedo Shirt - Ivory" |',
          "Variation: 16.5 / 34-35 |",
          "| SKU I-40092183 | $70.00",
          ...previewTaxLines("$3.33", "$0.00", "$3.33"),
        ].join("\n");
      case "gift":
        return [
          "^^^Taken Today",
          '"100% Lambswool Sweater" |',
          "Variation: Medium / Navy |",
          "| SKU I-1003713601 |",
        ].join("\n");
      case "mixed":
        return [
          "^^^Taken Today",
          '"100% Lambswool Sweater" |',
          "Variation: Medium / Navy |",
          "| SKU I-1003713601 | $83.80",
          "Reg $104.75 Sale $83.80 (20% Discount) |",
          ...previewTaxLines("$3.98", "$0.00", "$3.98"),
          "",
          "^^^PICKED UP",
          '"Tuxedo Shirt" |',
          "Variation: 16.5 / 34-35 / White |",
          "Order Date: 04/10/2026 01:15 PM |",
          "| SKU I-40092182 | $65.00",
          ...previewTaxLines("$3.09", "$0.00", "$3.09"),
          "",
          "^^^SHIPPED",
          '"Silk Tie" |',
          "Variation: Burgundy |",
          "| SKU I-50012345 | $45.00",
          ...previewTaxLines("$2.14", "$1.80", "$3.94"),
          "",
          "^^^Special Order",
          '"Navy Blazer" |',
          "Variation: 42R / Navy |",
          "| SKU I-2004829302 | $295.00",
          ...previewTaxLines("$14.01", "$11.80", "$25.81"),
          "",
          "^^^Custom Order",
          '"Made-to-Measure Suit" |',
          "| SKU CUSTOM-MTM | $895.00",
          ...previewTaxLines("$42.51", "$35.80", "$78.31"),
          "",
          "^^^Wedding Order",
          '"Groomsman Suit" |',
          "Variation: 40R / Charcoal |",
          "| SKU I-30088420 | $260.00",
          ...previewTaxLines("$12.35", "$10.40", "$22.75"),
          "",
          "^^^Layaway",
          '"Overcoat" |',
          "Variation: 42 / Camel |",
          "| SKU I-60022410 | $325.00",
          ...previewTaxLines("$15.44", "$13.00", "$28.44"),
          "",
          "^^^Alterations",
          '"ALTERATION FEE" |',
          "Hem trousers |",
          "| SKU ROS-ALTERATION-FEE | $18.00",
          ...previewTaxLines("$0.00", "$0.00", "$0.00"),
          "",
          "^^^Shipping",
          '"SHIPPING FEE" |',
          "| SKU ROS-SHIPPING-FEE | $12.00",
          ...previewTaxLines("$0.00", "$0.00", "$0.00"),
        ].join("\n");
    }
  })();
  const previewFinancialLines = (() => {
    switch (previewScenario) {
      case "pickup":
        return {
          subtotal: "Subtotal | $500.00",
          tax: "Sales Tax | $43.76",
          savings: "",
          total: "Total | ^^$543.76",
          paid: "Paid | $543.76",
          tender: "Tender CC | $250.00",
        };
      case "return":
        return {
          subtotal: "Subtotal | -$83.80",
          tax: "Sales Tax | -$3.98",
          savings: "",
          total: "Refund Total | ^^$87.78",
          paid: "Refunded | $87.78",
          tender: "Refund CC | $87.78",
        };
      case "exchange":
        return {
          subtotal: "Subtotal | $5.00",
          tax: "Sales Tax | $0.24",
          savings: "",
          total: "Balance Due | ^^$5.24",
          paid: "Paid | $5.24",
          tender: "Tender Cash | $5.24",
        };
      case "mixed":
        return {
          subtotal: "Subtotal | $1,998.80",
          tax: "Sales Tax | $166.32",
          savings: "Total Savings | $20.95",
          total: "Total | ^^$2,165.12",
          paid: "Paid | $2,165.12",
          tender: "Tender Cash | $425.00\nTender CC | $1,665.12",
        };
      case "gift":
        return {
          subtotal: "",
          tax: "",
          savings: "",
          total: "",
          paid: "",
          tender: "",
        };
      case "sale":
        return {
          subtotal: "Subtotal | $83.80",
          tax: "Sales Tax | $3.98",
          savings: "Total Savings | $20.95",
          total: "Total | ^^$87.78",
          paid: "Paid | $87.78",
          tender: "Tender Cash | $87.78",
        };
    }
  })();
  const getReceiptLineMarkup = () =>
    effectiveTemplate
      .replaceAll(
        "{{LOGO_IMAGE}}",
        showLogo && receiptLogoBase64 ? `{image:${receiptLogoBase64}}` : "",
      )
      .replaceAll(
        "{{STORE_NAME}}",
        `| ^^${escapeReceiptlineText(cfg.store_name)} |`,
      )
      .replaceAll("{{HEADER_LINES}}", centeredLines(headerLineValues))
      .replaceAll("{{RECEIPT_TITLE}}", `| ^^^${previewTitle} |`)
      .replaceAll("{{RECEIPT_ID}}", "| Receipt TXN-66736 |")
      .replaceAll("{{RECEIPT_DATE}}", "| 04/26/2026 02:14 AM |")
      .replaceAll(
        "{{CUSTOMER_LINE}}",
        [
          "Customer: Chris Garcia",
          "Phone: (716) 555-0199",
          "Customer #: CHRIS-42DF",
        ].join("\n"),
      )
      .replaceAll("{{SALESPERSON_LINE}}", "Salesperson: Taylor M.")
      .replaceAll("{{CASHIER_LINE}}", "Staff: Alex B.")
      .replaceAll("{{REGISTER_LINE}}", "Register #1")
      .replaceAll("{{ITEM_LINES}}", previewItemLines)
      .replaceAll(
        "{{LOYALTY_EARNED}}",
        !isGiftPreview && cfg.show_loyalty_earned
          ? "Loyalty earned | 84 pts"
          : "",
      )
      .replaceAll(
        "{{LOYALTY_BALANCE}}",
        !isGiftPreview && cfg.show_loyalty_balance
          ? "Loyalty balance | 1,240 pts"
          : "",
      )
      .replaceAll(
        "{{PAYMENT_BLOCK}}",
        previewScenario === "mixed"
          ? [
              "---",
              "Order payment",
              "Order | TXN-566027",
              "Applied today | $140.00",
              "Paid today - Cash | $425.00",
              "Paid today - CC | $1,665.12",
              "Balance remaining | $120.00",
              "Status | Balance due",
            ].join("\n")
          : previewScenario === "pickup"
            ? [
                "Order payment",
                "Order | TXN-566027",
                "Previously paid | $292.50",
                "Paid today - CC | $250.00",
                "Balance remaining | $0.00",
                "Status | Paid in full",
              ].join("\n")
            : "",
      )
      .replaceAll("{{PAYMENT_HISTORY_BLOCK}}", "")
      .replaceAll("{{SUBTOTAL_LINE}}", previewFinancialLines.subtotal)
      .replaceAll("{{TAX_LINE}}", previewFinancialLines.tax)
      .replaceAll("{{TOTAL_SAVINGS_LINE}}", previewFinancialLines.savings)
      .replaceAll("{{TOTAL_LINE}}", previewFinancialLines.total)
      .replaceAll("{{PAID_LINE}}", previewFinancialLines.paid)
      .replaceAll("{{BALANCE_LINE}}", "")
      .replaceAll(
        "{{TENDER_LINE}}",
        previewScenario === "mixed" || previewScenario === "pickup"
          ? ""
          : previewFinancialLines.tender,
      )
      .replaceAll(
        "{{GIFT_CARD_BALANCE}}",
        previewScenario === "mixed" ? "Gift Card Balance | $25.00" : "",
      )
      .replaceAll(
        "{{WEDDING_DEPOSIT_LINES}}",
        previewScenario === "mixed"
          ? "Wedding Deposit Applied | $75.00\n  Paid by Jordan Garcia · Garcia Wedding"
          : "",
      )
      .replaceAll(
        "{{STATUS_LINE}}",
        isGiftPreview
          ? ""
          : previewScenario === "return"
            ? "Status | Refunded"
            : "Status | Complete",
      )
      .replaceAll("{{TAX_EXEMPT_LINE}}", "")
      .replaceAll(
        "{{BARCODE_IMAGE}}",
        cfg.show_barcode ? "{code:TXN-66736;option:code128,hri}" : "",
      )
      .replaceAll("{{FOOTER_LINES}}", centeredLines(cfg.footer_lines))
      .replaceAll("{{CUT}}", "=");

  const commonRequiredTokens = [
    "{{RECEIPT_TITLE}}",
    "{{RECEIPT_ID}}",
    "{{RECEIPT_DATE}}",
    "{{CUSTOMER_LINE}}",
    "{{SALESPERSON_LINE}}",
    "{{CASHIER_LINE}}",
    "{{REGISTER_LINE}}",
    "{{ITEM_LINES}}",
    "{{PAYMENT_BLOCK}}",
    "{{SUBTOTAL_LINE}}",
    "{{TAX_LINE}}",
    "{{TOTAL_LINE}}",
    "{{PAID_LINE}}",
    "{{BALANCE_LINE}}",
    "{{STATUS_LINE}}",
  ];
  const requiredTokens = [
    ...commonRequiredTokens,
    ...(activeTab === "standard"
      ? ["{{TENDER_LINE}}"]
      : ["{{PAYMENT_HISTORY_BLOCK}}"]),
  ];
  const missingRequiredTokens = requiredTokens.filter(
    (token) => !effectiveTemplate.includes(token),
  );
  const standardMissingTokens = [
    ...commonRequiredTokens,
    "{{TENDER_LINE}}",
  ].filter((token) => !standardEffectiveTemplate.includes(token));
  const pickupMissingTokens = [
    ...commonRequiredTokens,
    "{{PAYMENT_HISTORY_BLOCK}}",
  ].filter((token) => !pickupEffectiveTemplate.includes(token));
  const standardDuplicateTokens = duplicateReceiptTokens(
    standardEffectiveTemplate,
  );
  const pickupDuplicateTokens = duplicateReceiptTokens(pickupEffectiveTemplate);
  const duplicateRequiredTokens =
    activeTab === "standard" ? standardDuplicateTokens : pickupDuplicateTokens;
  const hasInvalidSavedTemplate =
    standardMissingTokens.length > 0 ||
    pickupMissingTokens.length > 0 ||
    standardDuplicateTokens.length > 0 ||
    pickupDuplicateTokens.length > 0;
  const activeTemplateInvalid =
    missingRequiredTokens.length > 0 || duplicateRequiredTokens.length > 0;

  const printTestReceipt = async () => {
    setTestPrinting(true);
    try {
      const printableBase64 = receiptlineToEscposBase64(
        getReceiptLineMarkup(),
        {
          cpl: EPSON_RECEIPT_CPL,
        },
      );
      await printReceiptBase64(printableBase64);
      toast("Test receipt sent to the Epson receipt printer.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Test receipt failed", "error");
    } finally {
      setTestPrinting(false);
    }
  };

  const sendTestReceipt = async (channel: "email" | "sms") => {
    const destination =
      channel === "email" ? testEmail.trim() : testPhone.trim();
    if (!destination) {
      toast(
        `Enter a test ${channel === "email" ? "email address" : "phone number"}.`,
        "error",
      );
      return;
    }
    setTestDelivery(channel);
    try {
      const headers = {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      };
      const pngBase64 = await receiptHtmlToPngBase64(
        `<div style="width:576px;background:#fff;padding:16px;color:#111">${receiptLineSvg}</div>`,
      );
      const payload =
        channel === "email"
          ? {
              to_email: destination,
              subject: "Riverside receipt builder test",
              png_base64: pngBase64,
            }
          : {
              to_phone: destination,
              body: `${cfg.store_name} — Receipt builder test (image attached).`,
              png_base64: pngBase64,
            };
      const res = await fetch(
        `${baseUrl}/api/settings/receipt/test-${channel}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        },
      );
      const responseBody = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(responseBody.error ?? `Test ${channel} failed`);
      }
      toast(
        `Test receipt ${channel === "email" ? "email" : "text"} sent.`,
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error ? error.message : `Test ${channel} failed`,
        "error",
      );
    } finally {
      setTestDelivery(null);
    }
  };

  const receiptLineSvg = compactReceiptLineTaxAmounts(
    String(
      transform(getReceiptLineMarkup(), {
        cpl: EPSON_RECEIPT_CPL,
        encoding: "cp437",
      }),
    ),
  );

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
              Standard Epson receipts use structured ESC/POS output for the
              TM-m30III. Edit the store identity, header and footer lines, and
              receipt sections that print on the customer copy.
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
              ReceiptLine markdown is the active Epson template. ROS merges sale
              data into this template, previews it as SVG, then prints it
              through the Epson ESC/POS path.
            </p>
          </div>
          <span className="w-fit rounded-full border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
            Standard Epson
          </span>
        </div>
      </section>

      <section className="ui-card p-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] lg:items-end">
          <div>
            <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">
              Preview transaction
            </h3>
            <p className="mt-2 max-w-2xl text-xs font-semibold leading-relaxed text-app-text-muted">
              Select the customer receipt situation you want to inspect. Mixed
              transaction combines the major fulfillment and fee sections on one
              receipt.
            </p>
          </div>
          <label className="block">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Receipt type
            </span>
            <select
              value={previewScenario}
              onChange={(event) => {
                const nextScenario = event.target
                  .value as ReceiptPreviewScenario;
                setPreviewScenario(nextScenario);
                setActiveTab(nextScenario === "pickup" ? "pickup" : "standard");
              }}
              className="ui-input mt-2 w-full text-sm font-bold"
            >
              {RECEIPT_PREVIEW_SCENARIOS.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label} — {scenario.description}
                </option>
              ))}
            </select>
          </label>
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
                disabled={busy || hasInvalidSavedTemplate}
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
                disabled={testPrinting || activeTemplateInvalid}
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

            <div className="mt-6 rounded-xl border border-app-border bg-app-surface-2 p-4">
              <div className="mb-3">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Delivery tests
                </h4>
                <p className="mt-1 text-[10px] font-semibold leading-relaxed text-app-text-muted">
                  Sends the receipt currently shown in this builder. Email uses
                  Store Email; text sends an attached PNG through Podium MMS.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <input
                    type="email"
                    value={testEmail}
                    onChange={(event) => setTestEmail(event.target.value)}
                    className="ui-input w-full text-xs"
                    placeholder="test@example.com"
                    aria-label="Test receipt email address"
                  />
                  <button
                    type="button"
                    onClick={() => void sendTestReceipt("email")}
                    disabled={testDelivery !== null || activeTemplateInvalid}
                    className="ui-btn-secondary inline-flex h-10 w-full items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    {testDelivery === "email" ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : null}
                    Send Test Email
                  </button>
                </div>
                <div className="space-y-2">
                  <input
                    type="tel"
                    value={testPhone}
                    onChange={(event) => setTestPhone(event.target.value)}
                    className="ui-input w-full text-xs"
                    placeholder="(716) 555-0199"
                    aria-label="Test receipt phone number"
                  />
                  <button
                    type="button"
                    onClick={() => void sendTestReceipt("sms")}
                    disabled={testDelivery !== null || activeTemplateInvalid}
                    className="ui-btn-secondary inline-flex h-10 w-full items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    {testDelivery === "sms" ? (
                      <RefreshCw className="h-3 w-3 animate-spin" />
                    ) : null}
                    Send Test Text
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                <label className="block lg:col-span-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Identifier
                  </span>
                  <input
                    value={cfg.store_name}
                    onChange={(e) =>
                      setCfg({ ...cfg, store_name: e.target.value })
                    }
                    className="ui-input mt-2 w-full text-lg font-black italic tracking-tighter"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Address
                  </span>
                  <input
                    value={cfg.store_address ?? ""}
                    onChange={(e) =>
                      setCfg({ ...cfg, store_address: e.target.value })
                    }
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="6470 Transit Rd, Depew, NY"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Phone
                  </span>
                  <input
                    value={cfg.store_phone ?? ""}
                    onChange={(e) =>
                      setCfg({ ...cfg, store_phone: e.target.value })
                    }
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="(716) 833-8401"
                  />
                </label>

                <label className="block lg:col-span-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Store Email
                  </span>
                  <input
                    value={cfg.store_email ?? ""}
                    onChange={(e) =>
                      setCfg({ ...cfg, store_email: e.target.value })
                    }
                    className="ui-input mt-2 w-full text-sm font-bold"
                    placeholder="info@riversidemens.com"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Extra Header Lines
                  </span>
                  <textarea
                    value={linesToText(cfg.header_lines)}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        header_lines: textToLines(e.target.value),
                      })
                    }
                    rows={4}
                    className="ui-input mt-2 min-h-28 w-full resize-y font-mono text-xs leading-relaxed"
                    placeholder={
                      "Open daily 10-6\nAlterations pickup at rear counter"
                    }
                  />
                  <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                    Optional centered service notes below the store contact
                    lines.
                  </p>
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Footer Lines
                  </span>
                  <textarea
                    value={linesToText(cfg.footer_lines)}
                    onChange={(e) =>
                      setCfg({
                        ...cfg,
                        footer_lines: textToLines(e.target.value),
                      })
                    }
                    rows={5}
                    className="ui-input mt-2 min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
                    placeholder={
                      "Thank you for shopping with us!\nVisit us again soon."
                    }
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
                        setCfg({
                          ...cfg,
                          [k]: e.target.checked,
                        } as ReceiptConfig)
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

              <div className="flex border-b border-app-border mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("standard");
                    if (previewScenario === "pickup")
                      setPreviewScenario("mixed");
                  }}
                  className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${
                    activeTab === "standard"
                      ? "border-app-accent text-app-accent font-black"
                      : "border-transparent text-app-text-muted hover:text-app-text font-bold"
                  }`}
                >
                  Standard Template
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveTab("pickup");
                    setPreviewScenario("pickup");
                  }}
                  className={`px-4 py-2 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all ${
                    activeTab === "pickup"
                      ? "border-app-accent text-app-accent font-black"
                      : "border-transparent text-app-text-muted hover:text-app-text font-bold"
                  }`}
                >
                  Picked Up Template
                </button>
              </div>

              <div className="block">
                <label
                  htmlFor="receipt-template-editor"
                  className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60"
                >
                  {activeTab === "standard"
                    ? "Standard Receipt Template"
                    : "Picked Up Receipt Template"}
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  {[
                    ["Logo", "{{LOGO_IMAGE}}"],
                    ["Store Name", "{{STORE_NAME}}"],
                    ["Header", "{{HEADER_LINES}}"],
                    ["Receipt Title", "{{RECEIPT_TITLE}}"],
                    ["Transaction #", "{{RECEIPT_ID}}"],
                    ["Date", "{{RECEIPT_DATE}}"],
                    ["Customer", "{{CUSTOMER_LINE}}"],
                    ["Staff", "{{SALESPERSON_LINE}}\n{{CASHIER_LINE}}"],
                    ["Register", "{{REGISTER_LINE}}"],
                    ["Items", "{{ITEM_LINES}}"],
                    ["Loyalty", "{{LOYALTY_EARNED}}\n{{LOYALTY_BALANCE}}"],
                    [
                      "Totals",
                      "{{SUBTOTAL_LINE}}\n{{TAX_LINE}}\n{{TOTAL_SAVINGS_LINE}}\n{{TOTAL_LINE}}\n{{PAID_LINE}}\n{{BALANCE_LINE}}",
                    ],
                    ["Order Payments", "{{PAYMENT_BLOCK}}"],
                    ["Tender", "{{TENDER_LINE}}"],
                    ["Gift Card Balance", "{{GIFT_CARD_BALANCE}}"],
                    ["Wedding Deposits", "{{WEDDING_DEPOSIT_LINES}}"],
                    ["Status", "{{STATUS_LINE}}"],
                    ["Tax Exempt", "{{TAX_EXEMPT_LINE}}"],
                    ["Barcode", "{{BARCODE_IMAGE}}"],
                    ["Footer", "{{FOOTER_LINES}}"],
                    ["Cut", "{{CUT}}"],
                  ].map(([label, token]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => {
                        const tokens = token.split("\n");
                        let newTemplate = effectiveTemplate.trimEnd();
                        tokens.forEach((t) => {
                          if (!newTemplate.includes(t)) {
                            newTemplate += `\n${t}`;
                          }
                        });
                        setCfg({
                          ...cfg,
                          [activeTab === "standard"
                            ? "receiptline_template"
                            : "receiptline_pickup_template"]: newTemplate,
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
                      setCfg({
                        ...cfg,
                        [activeTab === "standard"
                          ? "receiptline_template"
                          : "receiptline_pickup_template"]:
                          activeTab === "standard"
                            ? DEFAULT_RECEIPTLINE_TEMPLATE
                            : DEFAULT_RECEIPTLINE_PICKUP_TEMPLATE,
                      })
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[9px] font-black uppercase tracking-widest text-amber-700 transition-colors hover:bg-amber-500/15"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reset {activeTab === "standard" ? "Standard" : "Picked Up"}
                  </button>
                </div>
                <textarea
                  id="receipt-template-editor"
                  value={effectiveTemplate}
                  onChange={(e) =>
                    setCfg({
                      ...cfg,
                      [activeTab === "standard"
                        ? "receiptline_template"
                        : "receiptline_pickup_template"]: e.target.value,
                    })
                  }
                  rows={15}
                  spellCheck={false}
                  className="ui-input mt-2 min-h-72 w-full resize-y font-mono text-xs leading-relaxed"
                />
                <p className="mt-2 text-[10px] font-semibold leading-relaxed text-app-text-muted">
                  Type any fixed text directly into the template. Tokens are
                  replaced by ROS at print time; the add buttons above expose
                  every supported receipt field. Keep line items, totals, and
                  payment tokens so receipts remain financially complete.
                </p>
                {missingRequiredTokens.length > 0 ? (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                      aria-hidden
                    />
                    <p className="text-[10px] font-bold leading-relaxed text-amber-800">
                      Restore required receipt fields before applying, printing,
                      or sending: {missingRequiredTokens.join(", ")}.
                    </p>
                  </div>
                ) : null}
                {!activeTemplateInvalid && hasInvalidSavedTemplate ? (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-amber-700"
                      aria-hidden
                    />
                    <p className="text-[10px] font-bold leading-relaxed text-amber-800">
                      Apply is unavailable until the{" "}
                      {standardMissingTokens.length > 0 ||
                      standardDuplicateTokens.length > 0
                        ? "Standard"
                        : "Picked Up"}{" "}
                      template is restored. Open that tab to see the fields that
                      need attention.
                    </p>
                  </div>
                ) : null}
                {duplicateRequiredTokens.length > 0 ? (
                  <div className="mt-3 flex items-start gap-3 rounded-xl border border-app-accent/30 bg-app-accent/10 p-3">
                    <AlertTriangle
                      className="mt-0.5 h-4 w-4 shrink-0 text-app-accent"
                      aria-hidden
                    />
                    <p className="text-[10px] font-bold leading-relaxed text-app-accent">
                      Remove duplicate receipt fields before applying, printing,
                      or sending: {duplicateRequiredTokens.join(", ")}.
                    </p>
                  </div>
                ) : null}
                <div className="mt-3 flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <ImageIcon
                    className="mt-0.5 h-4 w-4 shrink-0 text-app-accent"
                    aria-hidden
                  />
                  <p className="text-[10px] font-semibold leading-relaxed text-app-text-muted">
                    The logo token prints the full Riverside Men's Shop logo
                    lockup at the top of the receipt. Use the Receipt Logo
                    toggle to hide it without removing the token from the
                    template.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Available Tokens
                </p>
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-app-text-muted">
                  {
                    "{{LOGO_IMAGE}} {{STORE_NAME}} {{HEADER_LINES}} {{RECEIPT_TITLE}} {{RECEIPT_ID}} {{RECEIPT_DATE}} {{CUSTOMER_LINE}} {{SALESPERSON_LINE}} {{CASHIER_LINE}} {{REGISTER_LINE}} {{ITEM_LINES}} {{LOYALTY_EARNED}} {{LOYALTY_BALANCE}} {{PAYMENT_BLOCK}} {{PAYMENT_HISTORY_BLOCK}} {{SUBTOTAL_LINE}} {{TAX_LINE}} {{TOTAL_SAVINGS_LINE}} {{TOTAL_LINE}} {{PAID_LINE}} {{BALANCE_LINE}} {{TENDER_LINE}} {{GIFT_CARD_BALANCE}} {{WEDDING_DEPOSIT_LINES}} {{STATUS_LINE}} {{TAX_EXEMPT_LINE}} {{BARCODE_IMAGE}} {{FOOTER_LINES}} {{CUT}}"
                  }
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
            <div className="mb-4 rounded-2xl border border-app-border bg-app-surface p-4">
              <img
                src={RiversideReceiptLogo}
                alt="Riverside Men's Shop receipt logo"
                className="mx-auto max-h-20 w-full max-w-sm object-contain"
              />
              <p className="mt-3 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Active receipt logo
              </p>
            </div>
            <div className="flex justify-center overflow-x-auto rounded-[2rem] bg-white p-4 shadow-inner sm:p-6">
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
