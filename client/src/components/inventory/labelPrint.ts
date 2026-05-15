import { autoRoutePrint } from "../../lib/printerBridge";

export interface InventoryTagItem {
  sku: string;
  productName: string;
  variation: string;
  brand?: string | null;
  price?: string | null;
}

export interface InventoryTagPrintConfig {
  widthInches: number;
  heightInches: number;
  showSku: boolean;
  showProductName: boolean;
  showVariation: boolean;
  showBrand: boolean;
  showPrice: boolean;
  accentStyle: "classic" | "bold" | "minimal";
  footerText: string;
}

const STORAGE_KEY = "ros.inventory.tagPrintConfig";

const DEFAULT_CONFIG: InventoryTagPrintConfig = {
  widthInches: 4,
  heightInches: 2.5,
  showSku: true,
  showProductName: true,
  showVariation: true,
  showBrand: false,
  showPrice: false,
  accentStyle: "bold",
  footerText: "Riverside OS Inventory Tag",
};

const ZEBRA_2844_DPI = 203;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeZplField(value: string): string {
  return value.replace(/[\^~\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function wrapText(value: string, maxChars: number, maxLines: number): string[] {
  const words = escapeZplField(value).split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word.length > maxChars ? word.slice(0, maxChars) : word;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

function zplField(x: number, y: number, height: number, width: number, value: string) {
  return `^FO${x},${y}^A0N,${height},${width}^FD${escapeZplField(value)}^FS`;
}

function renderZplTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const width = Math.round(clampDimension(config.widthInches, 2, 6, 4) * ZEBRA_2844_DPI);
  const height = Math.round(clampDimension(config.heightInches, 1.25, 4, 2.5) * ZEBRA_2844_DPI);
  const margin = Math.max(18, Math.round(width * 0.035));
  const bodyWidth = width - margin * 2;
  const textChars = Math.max(18, Math.floor(bodyWidth / 22));
  const nameLines = config.showProductName
    ? wrapText(item.productName || item.sku, textChars, 2)
    : [];
  const variation = item.variation?.trim() || "Standard";
  const meta = [
    config.showVariation ? variation : null,
    config.showBrand && item.brand ? item.brand : null,
    config.showPrice && item.price ? item.price : null,
  ]
    .filter(Boolean)
    .join("  ");
  const footer = config.footerText.trim();
  const sku = escapeZplField(item.sku);

  let y = margin;
  const parts = [`^XA`, `^PW${width}`, `^LL${height}`, "^CI28"];

  if (config.accentStyle !== "minimal") {
    parts.push(`^FO0,0^GB${Math.max(10, Math.round(width * 0.035))},${height},0^FS`);
  }

  if (config.showSku) {
    parts.push(zplField(margin, y, 28, 28, sku));
    y += 42;
  }

  for (const line of nameLines) {
    parts.push(zplField(margin, y, 38, 34, line));
    y += 44;
  }

  if (meta) {
    parts.push(zplField(margin, y + 4, 24, 22, meta));
  }

  const barcodeHeight = Math.min(82, Math.max(50, Math.floor(height * 0.16)));
  const barcodeY = Math.max(y + 48, height - barcodeHeight - 86);
  if (sku) {
    parts.push(`^FO${margin},${barcodeY}^BY2,2,${barcodeHeight}^BCN,${barcodeHeight},Y,N,N^FD${sku}^FS`);
  }

  if (footer) {
    parts.push(zplField(margin, height - 28, 18, 18, footer));
  }

  parts.push("^XZ");
  return parts.join("\n");
}

function buildZplDocument(
  items: InventoryTagItem[],
  config: InventoryTagPrintConfig,
): string {
  return items.map((item) => renderZplTag(item, config)).join("\n");
}

function readStoredConfig(): Partial<InventoryTagPrintConfig> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Partial<InventoryTagPrintConfig>;
  } catch {
    return null;
  }
}

export function getInventoryTagPrintConfig(): InventoryTagPrintConfig {
  const stored = readStoredConfig();
  return {
    ...DEFAULT_CONFIG,
    ...stored,
  };
}

export function saveInventoryTagPrintConfig(
  next: InventoryTagPrintConfig,
): InventoryTagPrintConfig {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...next,
    widthInches: clampDimension(next.widthInches, 2, 6, DEFAULT_CONFIG.widthInches),
    heightInches: clampDimension(
      next.heightInches,
      1.25,
      4,
      DEFAULT_CONFIG.heightInches,
    ),
    footerText: next.footerText.trim() || DEFAULT_CONFIG.footerText,
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

function clampDimension(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function getAccentClasses(style: InventoryTagPrintConfig["accentStyle"]) {
  switch (style) {
    case "classic":
      return {
        shell: "border:1px solid #0f172a;background:#ffffff;",
        chip: "background:#ecfeff;color:#0f766e;border:1px solid #99f6e4;",
        band:
          "background:linear-gradient(135deg,#0f172a 0%,#334155 100%);",
      };
    case "minimal":
      return {
        shell: "border:1px solid #d4d4d8;background:#ffffff;",
        chip: "background:#f4f4f5;color:#18181b;border:1px solid #e4e4e7;",
        band: "background:#e4e4e7;",
      };
    case "bold":
    default:
      return {
        shell:
          "border:1px solid #d1fae5;background:radial-gradient(circle at top left,#ecfdf5 0%,#ffffff 58%,#f0fdf4 100%);",
        chip: "background:#022c22;color:#ecfdf5;border:1px solid #064e3b;",
        band:
          "background:linear-gradient(135deg,#065f46 0%,#10b981 55%,#6ee7b7 100%);",
      };
  }
}

function renderTag(
  item: InventoryTagItem,
  config: InventoryTagPrintConfig,
): string {
  const accent = getAccentClasses(config.accentStyle);
  const variation = item.variation?.trim() || "Standard";
  const price = item.price?.trim() || "";
  const brand = item.brand?.trim() || "";
  const footer = config.footerText.trim();

  return `<section class="tag-page">
  <div class="tag-shell" style="${accent.shell}">
    <div class="tag-band" style="${accent.band}"></div>
    <div class="tag-main">
      ${
        config.showSku
          ? `<div class="tag-chip" style="${accent.chip}">${escapeHtml(item.sku)}</div>`
          : ""
      }
      ${
        config.showProductName
          ? `<div class="tag-name">${escapeHtml(item.productName)}</div>`
          : ""
      }
      ${
        config.showVariation
          ? `<div class="tag-variation">${escapeHtml(variation)}</div>`
          : ""
      }
      <div class="tag-meta">
        ${
          config.showBrand && brand
            ? `<span class="tag-meta-pill">${escapeHtml(brand)}</span>`
            : ""
        }
        ${
          config.showPrice && price
            ? `<span class="tag-meta-pill">${escapeHtml(price)}</span>`
            : ""
        }
      </div>
      <div class="tag-footer">${escapeHtml(footer)}</div>
    </div>
  </div>
</section>`;
}

function buildDocument(
  items: InventoryTagItem[],
  config: InventoryTagPrintConfig,
): string {
  const pages = items.map((item) => renderTag(item, config)).join("\n");
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Inventory tags (${items.length})</title>
    <style>
      @page { size: ${config.widthInches}in ${config.heightInches}in; margin: 0.08in; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 0;
        font-family: Inter, Outfit, "Aptos", "Segoe UI", sans-serif;
        color: #0f172a;
        background: #ffffff;
      }
      .tag-page {
        page-break-after: always;
        width: 100%;
        min-height: ${Math.max(1, config.heightInches - 0.16)}in;
      }
      .tag-page:last-child { page-break-after: auto; }
      .tag-shell {
        position: relative;
        display: flex;
        min-height: ${Math.max(1, config.heightInches - 0.16)}in;
        border-radius: 18px;
        overflow: hidden;
      }
      .tag-band {
        width: 0.28in;
        min-width: 0.28in;
      }
      .tag-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 8px;
        padding: 12px 12px 10px;
      }
      .tag-chip {
        align-self: flex-start;
        border-radius: 999px;
        padding: 4px 9px;
        font-size: 13px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .tag-name {
        font-size: 21px;
        line-height: 1.05;
        font-weight: 900;
        letter-spacing: -0.03em;
      }
      .tag-variation {
        font-size: 14px;
        line-height: 1.15;
        font-weight: 700;
        color: #334155;
      }
      .tag-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .tag-meta-pill {
        border-radius: 999px;
        border: 1px solid #cbd5e1;
        background: rgba(255,255,255,0.9);
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #334155;
      }
      .tag-footer {
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #64748b;
      }
    </style>
  </head>
  <body>${pages}</body>
</html>`;
}

export type InventoryTagPrintResult = "direct" | "browser";

/** Single inventory tag routed to the configured tag station. */
export async function openSingleInventoryTag(
  item: InventoryTagItem,
): Promise<InventoryTagPrintResult> {
  return openInventoryTagsWindow([item]);
}

/** Browser preview/system-dialog fallback for tag layouts. */
export function openInventoryTagsPreviewWindow(
  items: InventoryTagItem[],
  overrideConfig?: Partial<InventoryTagPrintConfig>,
): void {
  if (items.length === 0) return;
  const config = {
    ...getInventoryTagPrintConfig(),
    ...overrideConfig,
  };
  const w = window.open("", "_blank", "width=520,height=420");
  if (!w) return;
  w.document.write(buildDocument(items, config));
  w.document.close();
  w.focus();
  w.print();
}

/** Multi-label Zebra/ZPL dispatch using the configured Tag Station. */
export async function openInventoryTagsWindow(
  items: InventoryTagItem[],
  overrideConfig?: Partial<InventoryTagPrintConfig>,
): Promise<InventoryTagPrintResult> {
  if (items.length === 0) return "browser";
  const config = {
    ...getInventoryTagPrintConfig(),
    ...overrideConfig,
  };

  try {
    await autoRoutePrint("tag", buildZplDocument(items, config), "zpl");
    return "direct";
  } catch (error) {
    console.warn("Direct Zebra tag print failed; opening browser print fallback", error);
    openInventoryTagsPreviewWindow(items, config);
    return "browser";
  }
}
