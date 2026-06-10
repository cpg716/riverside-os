import { isTauri } from "@tauri-apps/api/core";
import {
  autoRoutePrint,
  listSystemPrinters,
  resolvePrinterTarget,
  TAG_PRINTER_LANGUAGE_KEY,
  type HardwarePrinterTarget,
  type ThermalPrinterLanguage,
} from "../../lib/printerBridge";
import { openDesktopTextPreview } from "../../lib/desktopFileBridge";

export interface InventoryTagItem {
  sku: string;
  productName: string;
  variation: string;
  brand?: string | null;
  price?: string | null;
  /** Original retail price when item is on promotion. */
  regularPrice?: string | null;
  /** Active sale price when item is on promotion. */
  salePrice?: string | null;
}

/** Selects the overall tag composition. Each layout arranges the same data differently. */
export type TagLayoutId = "standard" | "price-hero" | "barcode-left" | "barcode-right" | "barcode-bottom" | "compact";

export interface TagLayoutOption {
  id: TagLayoutId;
  label: string;
  description: string;
}

export const TAG_LAYOUTS: TagLayoutOption[] = [
  { id: "standard",       label: "Standard",       description: "Product info fills the tag with a barcode along the bottom." },
  { id: "price-hero",     label: "Price First",    description: "Price dominates the tag — perfect for clearance and sales racks." },
  { id: "barcode-left",   label: "Barcode Left",   description: "Vertical barcode on the left edge with product info on the right." },
  { id: "barcode-right",  label: "Barcode Right",  description: "Vertical barcode on the right edge for handheld scanner access." },
  { id: "barcode-bottom", label: "Barcode Bottom", description: "Full-width barcode strip across the bottom of the tag." },
  { id: "compact",        label: "Compact",        description: "Dense two-column layout for smaller label stock." },
];

export interface InventoryTagPrintConfig {
  widthInches: number;
  heightInches: number;
  showSku: boolean;
  showProductName: boolean;
  showVariation: boolean;
  showBrand: boolean;
  showPrice: boolean;
  showBarcode: boolean;
  showPromoPrice: boolean;
  /** How prominent the price appears: "standard" or "large". */
  priceSize: "standard" | "large";
  /** Overall tag composition layout. */
  tagLayout: TagLayoutId;
  footerText: string;
  /** Legacy field kept for backward compat — no longer rendered. */
  accentStyle?: "classic" | "bold" | "minimal";
}

const STORAGE_KEY = "ros.inventory.tagPrintConfig";

const DEFAULT_CONFIG: InventoryTagPrintConfig = {
  widthInches: 2.25,
  heightInches: 1.25,
  showSku: true,
  showProductName: true,
  showVariation: true,
  showBrand: true,
  showPrice: true,
  showBarcode: true,
  showPromoPrice: true,
  priceSize: "large",
  tagLayout: "standard",
  footerText: "Riverside Men's Shop",
};

const ZEBRA_2844_DPI = 203;
/** Store-local calendar date stamped on every tag at print time. */
export function formatInventoryTagPrintDate(at: Date = new Date()): string {
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Footer label plus automatic print date (e.g. "Riverside Men's Shop · May 20, 2026"). */
export function buildInventoryTagFooterLine(
  footerText: string,
  at: Date = new Date(),
): string {
  const label = footerText.trim();
  const date = formatInventoryTagPrintDate(at);
  if (!label) return date;
  return `${label} · ${date}`;
}

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

function escapeEplField(value: string): string {
  return value
    .replace(/["\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function zplTextBlock(parts: string[], x: number, y: number, item: InventoryTagItem, config: InventoryTagPrintConfig, textChars: number): number {
  const nameLines = config.showProductName ? wrapText(item.productName || item.sku, textChars, 2) : [];
  const variation = item.variation?.trim() || "Standard";
  const sku = escapeZplField(item.sku);

  // Match font sizes to live preview (11px, 14px, 11px, 10px) converted to ZPL dots at 203 DPI
  // 11px ≈ 22 dots, 14px ≈ 28 dots, 10px ≈ 20 dots
  if (config.showSku) { parts.push(zplField(x, y, 22, 20, sku)); y += 30; }
  for (const line of nameLines) { parts.push(zplField(x, y, 28, 26, line)); y += 34; }
  if (config.showVariation) { parts.push(zplField(x, y + 2, 22, 20, escapeZplField(variation))); y += 28; }
  if (config.showBrand && item.brand) { parts.push(zplField(x, y + 2, 20, 18, escapeZplField(item.brand))); y += 26; }
  return y;
}

function zplPriceBlock(parts: string[], x: number, y: number, maxY: number, item: InventoryTagItem, config: InventoryTagPrintConfig): void {
  if (!config.showPrice) return;
  const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
  // Match font sizes to live preview (24px/16px) converted to ZPL dots at 203 DPI
  // 24px ≈ 48 dots, 16px ≈ 32 dots, 10px ≈ 20 dots
  const pH = config.priceSize === "large" ? 48 : 32;
  const pW = config.priceSize === "large" ? 48 : 32;
  const pY = Math.max(y + 8, maxY - pH - 28);
  if (isPromo) {
    parts.push(zplField(x, pY - 20, 20, 18, `Reg ${escapeZplField(item.regularPrice!)}`));
    parts.push(zplField(x, pY, pH, pW, escapeZplField(item.salePrice!)));
  } else if (item.price) {
    parts.push(zplField(x, pY, pH, pW, escapeZplField(item.price)));
  }
}

function renderZplTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const width = Math.round(clampDimension(config.widthInches, 2, 6, 4) * ZEBRA_2844_DPI);
  const height = Math.round(clampDimension(config.heightInches, 1.25, 4, 2.5) * ZEBRA_2844_DPI);
  const m = Math.max(16, Math.round(width * 0.03));
  const sku = escapeZplField(item.sku);
  const footer = buildInventoryTagFooterLine(config.footerText);
  const layout = config.tagLayout || "standard";

  const parts = [`^XA`, `^PW${width}`, `^LL${height}`, "^CI28"];

  if (layout === "barcode-left") {
    const bcZone = config.showBarcode ? Math.round(width * 0.15) : 0;
    const textX = m + bcZone;
    const bodyW = width - textX - m;
    const chars = Math.max(14, Math.floor(bodyW / 20));
    const y = zplTextBlock(parts, textX, m, item, config, chars);
    zplPriceBlock(parts, textX, y, height - 32, item, config);
    if (config.showBarcode && sku) {
      parts.push(`^FO${m},${m}^A0R,20,18^FD${sku}^FS`);
      // Match HTML preview barcode height of 22px ≈ 44 dots at 203 DPI
      const bcH = 44;
      parts.push(`^FO${m + 22},${m}^BY2^BCR,${bcH},N,N,N^FD${sku}^FS`);
    }
  } else if (layout === "barcode-right") {
    const bcZone = config.showBarcode ? Math.round(width * 0.15) : 0;
    const bodyW = width - m * 2 - bcZone;
    const chars = Math.max(14, Math.floor(bodyW / 20));
    const y = zplTextBlock(parts, m, m, item, config, chars);
    zplPriceBlock(parts, m, y, height - 32, item, config);
    if (config.showBarcode && sku) {
      const lblX = width - bcZone - 4;
      parts.push(`^FO${lblX},${m}^A0R,20,18^FD${sku}^FS`);
      // Match HTML preview barcode height of 22px ≈ 44 dots at 203 DPI
      const bcH = 44;
      const bcX = lblX + 22;
      parts.push(`^FO${bcX},${m}^BY2^BCR,${bcH},N,N,N^FD${sku}^FS`);
    }
  } else if (layout === "price-hero") {
    const pH = config.priceSize === "large" ? 48 : 32;
    const pW = config.priceSize === "large" ? 48 : 32;
    let y = m;
    if (config.showPrice) {
      const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
      if (isPromo) {
        parts.push(zplField(m, y, 20, 18, `Reg ${escapeZplField(item.regularPrice!)}`));
        y += 24;
        parts.push(zplField(m, y, pH, pW, escapeZplField(item.salePrice!)));
      } else if (item.price) {
        parts.push(zplField(m, y, pH, pW, escapeZplField(item.price)));
      }
      y += pH + 8;
    }
    const chars = Math.max(14, Math.floor((width - m * 2) / 20));
    zplTextBlock(parts, m, y, item, config, chars);
    if (config.showBarcode && sku) {
      // Match HTML preview barcode height of 22px ≈ 44 dots at 203 DPI
      const bcH = 44;
      parts.push(`^FO${m},${height - bcH - 24}^BY2^BCN,${bcH},Y,N,N^FD${sku}^FS`);
    }
  } else if (layout === "compact") {
    const halfW = Math.round(width * 0.55);
    const chars = Math.max(10, Math.floor((halfW - m) / 20));
    const y = zplTextBlock(parts, m, m, item, config, chars);
    const rightX = halfW + 8;
    zplPriceBlock(parts, rightX, m, height - 32, item, config);
    if (config.showBarcode && sku) {
      // Match HTML preview barcode height of 22px ≈ 44 dots at 203 DPI
      const bcH = 44;
      parts.push(`^FO${rightX},${height - bcH - 24}^BY2^BCN,${bcH},Y,N,N^FD${sku}^FS`);
    }
    void y;
  } else {
    const chars = Math.max(14, Math.floor((width - m * 2) / 20));
    const y = zplTextBlock(parts, m, m, item, config, chars);
    // Match HTML preview barcode height of 22px ≈ 44 dots at 203 DPI
    const bcH = config.showBarcode ? 44 : 0;
    const bcReserve = config.showBarcode ? bcH + 28 : 0;
    zplPriceBlock(parts, m, y, height - bcReserve - 24, item, config);
    if (config.showBarcode && sku) {
      parts.push(`^FO${m},${height - bcH - 22}^BY2^BCN,${bcH},Y,N,N^FD${sku}^FS`);
    }
  }

  if (footer) { parts.push(zplField(m, height - 22, 16, 14, footer)); }
  parts.push("^XZ");
  return parts.join("\n");
}

function buildZplDocument(
  items: InventoryTagItem[],
  config: InventoryTagPrintConfig,
): string {
  return items.map((item) => renderZplTag(item, config)).join("\n");
}

function eplText(
  x: number,
  y: number,
  rotation: 0 | 1 | 2 | 3,
  font: 1 | 2 | 3 | 4 | 5,
  xMul: number,
  yMul: number,
  value: string,
) {
  return `A${x},${y},${rotation},${font},${xMul},${yMul},N,"${escapeEplField(value)}"`;
}

function eplTextBlock(
  parts: string[],
  x: number,
  y: number,
  item: InventoryTagItem,
  config: InventoryTagPrintConfig,
  textChars: number,
): number {
  const nameLines = config.showProductName ? wrapText(item.productName || item.sku, textChars, 2) : [];
  const variation = item.variation?.trim() || "Standard";
  if (config.showSku) {
    parts.push(eplText(x, y, 0, 2, 1, 1, item.sku));
    y += 24;
  }
  for (const line of nameLines) {
    parts.push(eplText(x, y, 0, 3, 1, 1, line));
    y += 28;
  }
  if (config.showVariation) {
    parts.push(eplText(x, y, 0, 2, 1, 1, variation));
    y += 24;
  }
  if (config.showBrand && item.brand) {
    parts.push(eplText(x, y, 0, 1, 1, 1, item.brand));
    y += 20;
  }
  return y;
}

function eplPriceBlock(
  parts: string[],
  x: number,
  y: number,
  maxY: number,
  item: InventoryTagItem,
  config: InventoryTagPrintConfig,
) {
  if (!config.showPrice) return;
  const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
  const pY = Math.max(y + 4, maxY - 48);
  if (isPromo) {
    parts.push(eplText(x, Math.max(y, pY - 22), 0, 1, 1, 1, `Reg ${item.regularPrice!}`));
    parts.push(eplText(x, pY, 0, 5, 1, config.priceSize === "large" ? 2 : 1, item.salePrice!));
  } else if (item.price) {
    parts.push(eplText(x, pY, 0, 5, 1, config.priceSize === "large" ? 2 : 1, item.price));
  }
}

function renderEplTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const width = Math.round(clampDimension(config.widthInches, 2, 6, 4) * ZEBRA_2844_DPI);
  const height = Math.round(clampDimension(config.heightInches, 1.25, 4, 2.5) * ZEBRA_2844_DPI);
  const m = Math.max(12, Math.round(width * 0.03));
  const footer = buildInventoryTagFooterLine(config.footerText);
  const layout = config.tagLayout || "standard";
  const sku = escapeEplField(item.sku);
  const parts = ["N", `q${width}`, `Q${height},24`, "D7", "S2"];

  if (layout === "barcode-left") {
    const bcZone = config.showBarcode ? Math.round(width * 0.18) : 0;
    const textX = m + bcZone;
    const y = eplTextBlock(parts, textX, m, item, config, Math.max(14, Math.floor((width - textX - m) / 17)));
    eplPriceBlock(parts, textX, y, height - 30, item, config);
    if (config.showBarcode && sku) {
      parts.push(eplText(m, m, 1, 1, 1, 1, sku));
      parts.push(`B${m + 18},${m},1,1A,2,2,44,B,"${sku}"`);
    }
  } else if (layout === "barcode-right") {
    const bcZone = config.showBarcode ? Math.round(width * 0.18) : 0;
    const bodyW = width - m * 2 - bcZone;
    const y = eplTextBlock(parts, m, m, item, config, Math.max(14, Math.floor(bodyW / 17)));
    eplPriceBlock(parts, m, y, height - 30, item, config);
    if (config.showBarcode && sku) {
      const bcX = width - bcZone;
      parts.push(eplText(bcX, m, 1, 1, 1, 1, sku));
      parts.push(`B${bcX + 18},${m},1,1A,2,2,44,B,"${sku}"`);
    }
  } else if (layout === "price-hero") {
    let y = m;
    if (config.showPrice) {
      eplPriceBlock(parts, m, y, m + 58, item, config);
      y += 76;
    }
    eplTextBlock(parts, m, y, item, config, Math.max(14, Math.floor((width - m * 2) / 17)));
    if (config.showBarcode && sku) {
      parts.push(`B${m},${height - 72},0,1A,2,2,44,B,"${sku}"`);
    }
  } else if (layout === "compact") {
    const rightX = Math.round(width * 0.56);
    eplTextBlock(parts, m, m, item, config, Math.max(10, Math.floor((rightX - m) / 17)));
    eplPriceBlock(parts, rightX, m, height - 30, item, config);
    if (config.showBarcode && sku) {
      parts.push(`B${rightX},${height - 72},0,1A,2,2,38,B,"${sku}"`);
    }
  } else {
    const y = eplTextBlock(parts, m, m, item, config, Math.max(14, Math.floor((width - m * 2) / 17)));
    const barcodeReserve = config.showBarcode ? 74 : 0;
    eplPriceBlock(parts, m, y, height - barcodeReserve - 18, item, config);
    if (config.showBarcode && sku) {
      parts.push(`B${m},${height - 72},0,1A,2,2,44,B,"${sku}"`);
    }
  }

  if (footer) {
    parts.push(eplText(m, height - 20, 0, 1, 1, 1, footer));
  }
  parts.push("P1");
  return parts.join("\n");
}

function buildEplDocument(
  items: InventoryTagItem[],
  config: InventoryTagPrintConfig,
): string {
  return items.map((item) => renderEplTag(item, config)).join("\n");
}

function inferTagPrinterLanguage(): ThermalPrinterLanguage {
  const configured = window.localStorage.getItem(TAG_PRINTER_LANGUAGE_KEY);
  if (configured === "zpl" || configured === "epl") return configured;

  const target = resolvePrinterTarget("tag");
  if (target.mode === "system") {
    const name = target.printerName.toLowerCase();
    const looksLikeClassic2844 =
      /\b(?:lp|tlp)\s*2844\b/.test(name) || /\bzebra\s+2844\b/.test(name);
    const explicitlyZpl =
      name.includes("2844-z") ||
      name.includes("zpl") ||
      /\b(?:zd|gk|gx|zt)\d+/.test(name);
    if (looksLikeClassic2844 && !explicitlyZpl) {
      return "epl";
    }
  }

  return "zpl";
}

export function getInventoryTagPrinterLanguage(): ThermalPrinterLanguage {
  if (typeof window === "undefined") return "zpl";
  return inferTagPrinterLanguage();
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

function computeSavings(regular: string, sale: string): string {
  const regNum = parseFloat(regular.replace(/[^0-9.]/g, ""));
  const saleNum = parseFloat(sale.replace(/[^0-9.]/g, ""));
  if (!isFinite(regNum) || !isFinite(saleNum) || regNum <= saleNum) return "";
  return `$${(regNum - saleNum).toFixed(2)}`;
}

function priceHtml(item: InventoryTagItem, config: InventoryTagPrintConfig, sizeOverride?: string): string {
  if (!config.showPrice) return "";
  const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
  const sz = sizeOverride ?? (config.priceSize === "large" ? "28px" : "16px");
  if (isPromo) {
    const savings = computeSavings(item.regularPrice!, item.salePrice!);
    return `<div class="t-price-block"><div class="t-price-reg"><s>${escapeHtml(item.regularPrice!)}</s></div><div class="t-price-sale" style="font-size:${sz}">${escapeHtml(item.salePrice!)}</div>${savings ? `<div class="t-savings">You save ${escapeHtml(savings)}</div>` : ""}</div>`;
  }
  const p = item.price?.trim() || "";
  if (!p) return "";
  return `<div class="t-price" style="font-size:${sz}">${escapeHtml(p)}</div>`;
}

function barcodeHtml(sku: string, orient: "h" | "v"): string {
  if (orient === "v") {
    return `<div class="t-bc t-bc-v"><div class="t-bc-v-lbl">${escapeHtml(sku)}</div><div class="t-bc-v-bars"><svg class="t-bc-svg" data-sku="${escapeHtml(sku)}"></svg></div></div>`;
  }
  return `<div class="t-bc t-bc-h"><svg class="t-bc-svg" data-sku="${escapeHtml(sku)}"></svg><div class="t-bc-lbl">${escapeHtml(sku)}</div></div>`;
}

function skuHtml(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return config.showSku ? `<div class="t-sku">${escapeHtml(item.sku)}</div>` : "";
}
function nameHtml(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return config.showProductName ? `<div class="t-name">${escapeHtml(item.productName)}</div>` : "";
}
function variationHtml(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return config.showVariation ? `<div class="t-var">${escapeHtml(item.variation?.trim() || "Standard")}</div>` : "";
}
function brandHtml(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const b = item.brand?.trim();
  return config.showBrand && b ? `<div class="t-brand">${escapeHtml(b)}</div>` : "";
}
function footerHtml(config: InventoryTagPrintConfig): string {
  return `<div class="t-footer">${escapeHtml(buildInventoryTagFooterLine(config.footerText))}</div>`;
}

function renderTagStandard(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return `<section class="tag-page"><div class="tag-shell tag-standard">
    <div class="t-body">${skuHtml(item, config)}${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${priceHtml(item, config)}${footerHtml(config)}</div>
    ${config.showBarcode ? `<div class="t-bc-row">${barcodeHtml(item.sku, "h")}</div>` : ""}
  </div></section>`;
}

function renderTagPriceHero(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const sz = config.priceSize === "large" ? "36px" : "24px";
  return `<section class="tag-page"><div class="tag-shell tag-price-hero">
    <div class="t-top">${priceHtml(item, config, sz)}</div>
    <div class="t-body">${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${skuHtml(item, config)}${footerHtml(config)}</div>
    ${config.showBarcode ? `<div class="t-bc-row">${barcodeHtml(item.sku, "h")}</div>` : ""}
  </div></section>`;
}

function renderTagBarcodeLeft(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return `<section class="tag-page"><div class="tag-shell tag-bc-left">
    ${config.showBarcode ? `<div class="t-bc-col">${barcodeHtml(item.sku, "v")}</div>` : ""}
    <div class="t-body">${skuHtml(item, config)}${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${priceHtml(item, config)}${footerHtml(config)}</div>
  </div></section>`;
}

function renderTagBarcodeRight(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return `<section class="tag-page"><div class="tag-shell tag-bc-right">
    <div class="t-body">${skuHtml(item, config)}${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${priceHtml(item, config)}${footerHtml(config)}</div>
    ${config.showBarcode ? `<div class="t-bc-col">${barcodeHtml(item.sku, "v")}</div>` : ""}
  </div></section>`;
}

function renderTagBarcodeBottom(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return `<section class="tag-page"><div class="tag-shell tag-bc-bottom">
    <div class="t-body">${skuHtml(item, config)}${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${priceHtml(item, config)}${footerHtml(config)}</div>
    ${config.showBarcode ? `<div class="t-bc-row t-bc-row-lg">${barcodeHtml(item.sku, "h")}</div>` : ""}
  </div></section>`;
}

function renderTagCompact(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return `<section class="tag-page"><div class="tag-shell tag-compact">
    <div class="t-col-left">${nameHtml(item, config)}${variationHtml(item, config)}${brandHtml(item, config)}${skuHtml(item, config)}</div>
    <div class="t-col-right">${priceHtml(item, config)}${config.showBarcode ? barcodeHtml(item.sku, "h") : ""}${footerHtml(config)}</div>
  </div></section>`;
}

function renderTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  switch (config.tagLayout) {
    case "price-hero": return renderTagPriceHero(item, config);
    case "barcode-left": return renderTagBarcodeLeft(item, config);
    case "barcode-right": return renderTagBarcodeRight(item, config);
    case "barcode-bottom": return renderTagBarcodeBottom(item, config);
    case "compact": return renderTagCompact(item, config);
    default: return renderTagStandard(item, config);
  }
}

function generateBarcodeSvgScript(): string {
  return `<script>
(function(){
  var C={32:212222,33:222122,34:222221,35:121223,36:121322,37:131222,38:122213,39:122312,40:132212,41:221213,42:221312,43:231212,44:112232,45:122132,46:122231,47:113222,48:123122,49:123221,50:223211,51:221132,52:221231,53:213212,54:223112,55:312131,56:311222,57:312212,58:322112,59:322211,60:212123,61:212321,62:232121,63:111323,64:131123,65:131321,66:112313,67:132113,68:132311,69:211313,70:231113,71:231311,72:112133,73:112331,74:132131,75:113123,76:113321,77:133121,78:313121,79:211331,80:231131,81:213113,82:213311,83:213131,84:311123,85:311321,86:331121,87:312113,88:312311,89:332111,90:314111,91:221411,92:431111,93:111224,94:111422,95:121124,96:121421,97:141122,98:141221,99:112214,100:112412,101:122114,102:122411,103:142112,104:142211,105:241211,106:221114,107:413111,108:241112,109:134111,110:111242,111:121142,112:121241,113:114212,114:124112,115:124211,116:411212,117:421112,118:421211,119:212141,120:214121,121:412121,122:111143,123:111341,124:131141,125:114113,126:114311,127:411113,128:411311};
  function enc(t){var s=104,cs=s,b=C[s]+'';for(var i=0;i<t.length;i++){var c=t.charCodeAt(i)-32;cs+=(i+1)*c;b+=C[c+32];}b+=C[cs%103];b+=C[106];return b;}
  document.querySelectorAll('.t-bc-svg').forEach(function(svg){
    var sku=svg.getAttribute('data-sku');if(!sku)return;
    var bars=enc(sku),tw=0;for(var i=0;i<bars.length;i++)tw+=parseInt(bars[i]);
    svg.setAttribute('viewBox','0 0 '+tw+' 50');svg.setAttribute('preserveAspectRatio','none');
    var x=0,d='';for(var i=0;i<bars.length;i++){var w=parseInt(bars[i]);if(i%2===0)d+='M'+x+' 0h'+w+'v50h-'+w+'z';x+=w;}
    var p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',d);p.setAttribute('fill','#000');svg.appendChild(p);
  });
})();
</script>`;
}

function buildDocument(items: InventoryTagItem[], config: InventoryTagPrintConfig): string {
  const pages = items.map((i) => renderTag(i, config)).join("\n");
  // Match font sizes exactly to live preview in TagDesignerPanel
  const pSz = config.priceSize === "large" ? "24px" : "16px";
  const hIn = Math.max(1, config.heightInches - 0.12);

  // Use fixed pixel width for screen display to match live preview (300px)
  const TAG_PX = 300;
  const tagPxWidth = TAG_PX;
  const tagPxHeight = Math.round(TAG_PX * (Math.max(1, config.heightInches) / Math.max(2, config.widthInches)));

  return `<!DOCTYPE html><html><head><title>Inventory tags (${items.length})</title>
<style>
@page{size:${config.widthInches}in ${config.heightInches}in;margin:0.04in;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{font-family:Inter,Outfit,"Aptos","Segoe UI",sans-serif;color:#000;background:#fff;margin:0;padding:0;}
body{display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px;}
.tag-page{page-break-after:always;width:${tagPxWidth}px;height:${tagPxHeight}px;flex-shrink:0;}
.tag-page:last-child{page-break-after:auto;}
.tag-shell{display:flex;flex-direction:column;height:100%;border:1px solid #000;overflow:hidden;}
.t-body{flex:1;display:flex;flex-direction:column;gap:2px;padding:6px 10px 4px;min-width:0;overflow:hidden;}
.t-sku{font:800 11px/1.2 inherit;letter-spacing:.05em;text-transform:uppercase;color:#000;}
.t-name{font:900 14px/1.15 inherit;letter-spacing:-.01em;color:#000;}
.t-var{font:700 11px/1.2 inherit;color:#000;}
.t-brand{font:700 10px/1.2 inherit;text-transform:uppercase;letter-spacing:.05em;color:#000;}
.t-price{font:900 ${pSz}/1 inherit;letter-spacing:-.01em;margin-top:auto;color:#000;}
.t-price-block{margin-top:auto;}
.t-price-reg{font:700 10px/1.2 inherit;color:#000;}
.t-price-reg s{text-decoration:line-through;}
.t-price-sale{font:900 ${pSz}/1 inherit;letter-spacing:-.01em;color:#000;}
.t-savings{font:700 10px/1.2 inherit;color:#000;}
.t-footer{font:700 8px/1.2 inherit;letter-spacing:.1em;text-transform:uppercase;color:#000;margin-top:auto;padding-top:2px;}
/* Barcode horizontal row - match live preview px-2 py-0.5 */
.t-bc-row{display:flex;align-items:center;gap:4px;padding:2px 8px;border-top:1px solid rgba(0,0,0,0.2);height:32px;}
.t-bc-row-lg{padding:2px 8px;}
.t-bc.t-bc-h{display:flex;align-items:center;gap:4px;flex:1;min-width:0;}
.t-bc.t-bc-h .t-bc-svg{flex:1;height:22px;display:block;}
.t-bc-row-lg .t-bc-h .t-bc-svg{height:22px;}
.t-bc.t-bc-h .t-bc-lbl{font:700 10px/1 inherit;letter-spacing:.04em;white-space:nowrap;color:#000;}
/* Barcode vertical column (barcode-left and barcode-right layouts) */
.tag-bc-right{flex-direction:row!important;}
.tag-bc-right>.t-body{flex:1;}
.tag-bc-left{flex-direction:row!important;}
.tag-bc-left>.t-body{flex:1;}
.tag-bc-left .t-bc-col{border-left:none;border-right:1px solid #000;}
.t-bc-col{display:flex;border-left:1px solid #000;}
.t-bc.t-bc-v{display:flex;height:100%;}
.t-bc-v-lbl{width:0.18in;display:flex;align-items:center;justify-content:center;background:#f8f8f8;writing-mode:vertical-rl;transform:rotate(180deg);font:700 10px/1 inherit;letter-spacing:.05em;white-space:nowrap;color:#000;}
.t-bc-v-bars{width:0.38in;display:flex;align-items:center;justify-content:center;padding:4px 2px;writing-mode:vertical-rl;transform:rotate(180deg);}
.t-bc-v-bars .t-bc-svg{width:100%;height:100%;display:block;}
/* Price Hero */
.tag-price-hero .t-top{padding:6px 10px 0;display:flex;align-items:baseline;gap:6px;}
/* Compact two-col */
.tag-compact{flex-direction:row!important;}
.tag-compact .t-col-left{flex:1.1;display:flex;flex-direction:column;gap:2px;padding:6px 8px 4px;min-width:0;overflow:hidden;}
.tag-compact .t-col-right{flex:0.9;display:flex;flex-direction:column;gap:4px;padding:6px 8px 4px;border-left:1px solid #ddd;align-items:flex-end;justify-content:space-between;text-align:right;}
.tag-compact .t-bc.t-bc-h{flex-direction:column;align-items:flex-end;}
.tag-compact .t-bc.t-bc-h .t-bc-svg{width:100%;height:28px;flex:none;}
@media print{
  body{padding:0;gap:0;}
  .tag-page{width:${config.widthInches}in;height:${hIn}in;page-break-after:always;}
}
</style></head><body>${pages}${config.showBarcode ? generateBarcodeSvgScript() : ""}<script>
window.addEventListener('load',function(){
  window.setTimeout(function(){ window.focus(); window['print'](); },250);
});
</script></body></html>`;
}

export type InventoryTagPrintResult = "direct" | "browser";

/** Single inventory tag routed to the configured tag station. */
export async function openSingleInventoryTag(
  item: InventoryTagItem,
): Promise<InventoryTagPrintResult> {
  return openInventoryTagsWindow([item]);
}

/** Browser preview/system-dialog fallback for tag layouts. */
export async function openInventoryTagsPreviewWindow(
  items: InventoryTagItem[],
  overrideConfig?: Partial<InventoryTagPrintConfig>,
): Promise<InventoryTagPrintResult> {
  if (items.length === 0) return "browser";
  const config = {
    ...getInventoryTagPrintConfig(),
    ...overrideConfig,
  };
  const html = buildDocument(items, config);

  if (isTauri()) {
    await openDesktopTextPreview("riverside-tag-preview.html", html);
    return "browser";
  }

  // Browser/PWA: use window.open approach with appropriate size
  const w = window.open("", "_blank", "width=350,height=500");
  if (!w) {
    throw new Error("Tag print preview was blocked. Please allow popups for Riverside and try again.");
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  return "browser";
}

function isDefaultLoopbackTagTarget(target: HardwarePrinterTarget): boolean {
  if (target.mode !== "network") return false;
  const storedMode = window.localStorage.getItem("ros.hardware.printer.tag.mode");
  const storedIp = window.localStorage.getItem("ros.hardware.printer.tag.ip")?.trim();
  if (storedMode === "system") return false;
  if (storedIp && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(storedIp)) {
    return false;
  }
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.ip);
}

async function resolveDesktopTagPrintTarget(): Promise<HardwarePrinterTarget> {
  const target = resolvePrinterTarget("tag");
  if (!isTauri() || !isDefaultLoopbackTagTarget(target)) {
    return target;
  }

  const printers = await listSystemPrinters().catch(() => []);
  const zebraPrinter = printers.find((printer) =>
    /\b(?:zebra|lp\s*2844|tlp\s*2844|2844)\b/i.test(printer.name),
  );
  if (!zebraPrinter) {
    return target;
  }

  return {
    mode: "system",
    printerName: zebraPrinter.name,
  };
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
    const language = getInventoryTagPrinterLanguage();
    const payload = language === "epl"
      ? buildEplDocument(items, config)
      : buildZplDocument(items, config);
    const target = await resolveDesktopTagPrintTarget();
    await autoRoutePrint("tag", payload, language, target);
    return "direct";
  } catch (directError) {
    console.warn("Direct Zebra tag print failed; opening browser print fallback", directError);
    try {
      return await openInventoryTagsPreviewWindow(items, config);
    } catch (previewError) {
      const directMessage = directError instanceof Error ? directError.message : String(directError);
      const previewMessage = previewError instanceof Error ? previewError.message : String(previewError);
      throw new Error(`Tag print failed: ${directMessage}. Print preview also failed: ${previewMessage}`);
    }
  }
}
