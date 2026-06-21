import { isTauri } from "@tauri-apps/api/core";
import {
  autoRoutePrint,
  describePrinterTarget,
  RIVERSIDE_TAG_PRINTER_LANGUAGE,
  resolvePrinterTarget,
  type HardwarePrinterTarget,
  type ThermalPrinterLanguage,
} from "../../lib/printerBridge";
import { openDesktopTextPreview } from "../../lib/desktopFileBridge";
import { printExistingWindowAsync } from "../../lib/browserPrint";

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
  /** Deprecated compatibility field. Tag Builder field text size controls printed price size. */
  priceSize: "standard" | "large";
  /** Overall tag composition layout. */
  tagLayout: TagLayoutId;
  footerText: string;
  /** Saved-layout compatibility field; no longer rendered. */
  accentStyle?: "classic" | "bold" | "minimal";
  /** Freeform field positions used by the Tag Builder. */
  customLayout?: CustomTagLayout;
  /** Separate freeform field positions used when sale/promo pricing is printed. */
  saleCustomLayout?: CustomTagLayout;
}

export type TagElementId =
  | "sku"
  | "productName"
  | "variation"
  | "brand"
  | "price"
  | "regularPrice"
  | "savings"
  | "barcode"
  | "footer";

export type TagElementDirection = "normal" | "rotated-left" | "rotated-right";
export type TagElementFontSize = "xs" | "sm" | "md" | "lg" | "xl" | "xxl" | "hero";

export interface TagElementLayout {
  id: TagElementId;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  direction: TagElementDirection;
  fontSize?: TagElementFontSize;
}

export interface CustomTagLayout {
  elements: Record<TagElementId, TagElementLayout>;
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
  customLayout: defaultCustomTagLayout(),
  saleCustomLayout: defaultSaleCustomTagLayout(),
};

export const TAG_ELEMENT_LABELS: Record<TagElementId, string> = {
  sku: "SKU",
  productName: "Product name",
  variation: "Variation",
  brand: "Brand",
  price: "Price",
  regularPrice: "Regular price",
  savings: "Savings",
  barcode: "Barcode",
  footer: "Footer",
};

export const TAG_ELEMENT_ORDER: TagElementId[] = [
  "sku",
  "productName",
  "variation",
  "brand",
  "regularPrice",
  "price",
  "savings",
  "barcode",
  "footer",
];

export const TAG_ELEMENT_FONT_SIZE_LABELS: Record<TagElementFontSize, string> = {
  xs: "XS",
  sm: "Small",
  md: "Medium",
  lg: "Large",
  xl: "XL",
  xxl: "XXL",
  hero: "Hero",
};

export const TAG_ELEMENT_FONT_SIZES: TagElementFontSize[] = ["xs", "sm", "md", "lg", "xl", "xxl", "hero"];

function defaultFontSizeForElement(id: TagElementId): TagElementFontSize {
  if (id === "price") return "xl";
  if (id === "productName") return "lg";
  if (id === "sku" || id === "variation") return "md";
  return "sm";
}

export function defaultCustomTagLayout(): CustomTagLayout {
  return {
    elements: {
      sku: { id: "sku", xPct: 6, yPct: 7, wPct: 28, hPct: 12, direction: "normal", fontSize: "md" },
      productName: { id: "productName", xPct: 6, yPct: 21, wPct: 68, hPct: 18, direction: "normal", fontSize: "lg" },
      variation: { id: "variation", xPct: 6, yPct: 42, wPct: 52, hPct: 12, direction: "normal", fontSize: "md" },
      brand: { id: "brand", xPct: 6, yPct: 56, wPct: 56, hPct: 10, direction: "normal", fontSize: "sm" },
      regularPrice: { id: "regularPrice", xPct: 6, yPct: 66, wPct: 32, hPct: 8, direction: "normal", fontSize: "sm" },
      price: { id: "price", xPct: 6, yPct: 75, wPct: 35, hPct: 18, direction: "normal", fontSize: "xl" },
      savings: { id: "savings", xPct: 42, yPct: 66, wPct: 24, hPct: 8, direction: "normal", fontSize: "sm" },
      barcode: { id: "barcode", xPct: 48, yPct: 72, wPct: 46, hPct: 16, direction: "normal" },
      footer: { id: "footer", xPct: 48, yPct: 91, wPct: 46, hPct: 7, direction: "normal", fontSize: "sm" },
    },
  };
}

export function defaultSaleCustomTagLayout(): CustomTagLayout {
  return {
    elements: {
      sku: { id: "sku", xPct: 6, yPct: 6, wPct: 28, hPct: 10, direction: "normal", fontSize: "md" },
      productName: { id: "productName", xPct: 6, yPct: 18, wPct: 72, hPct: 18, direction: "normal", fontSize: "lg" },
      variation: { id: "variation", xPct: 6, yPct: 39, wPct: 52, hPct: 10, direction: "normal", fontSize: "md" },
      brand: { id: "brand", xPct: 6, yPct: 51, wPct: 56, hPct: 9, direction: "normal", fontSize: "sm" },
      regularPrice: { id: "regularPrice", xPct: 6, yPct: 64, wPct: 30, hPct: 8, direction: "normal", fontSize: "sm" },
      price: { id: "price", xPct: 6, yPct: 73, wPct: 36, hPct: 19, direction: "normal", fontSize: "xl" },
      savings: { id: "savings", xPct: 41, yPct: 64, wPct: 26, hPct: 8, direction: "normal", fontSize: "sm" },
      barcode: { id: "barcode", xPct: 49, yPct: 74, wPct: 45, hPct: 15, direction: "normal" },
      footer: { id: "footer", xPct: 49, yPct: 91, wPct: 45, hPct: 7, direction: "normal", fontSize: "sm" },
    },
  };
}

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
    .replace(/\u00b7/g, " - ")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, " ")
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
  const pH = 48;
  const pW = 48;
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
    const pH = 48;
    const pW = 48;
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

export function buildZplDocument(
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

function pctToDots(value: number, total: number): number {
  return Math.round((value / 100) * total);
}

function eplRotation(direction: TagElementDirection): 0 | 1 | 2 | 3 {
  if (direction === "rotated-left") return 3;
  if (direction === "rotated-right") return 1;
  return 0;
}

function customElementBox(layout: CustomTagLayout, id: TagElementId, width: number, height: number) {
  const element = layout.elements[id];
  const x = pctToDots(element.xPct, width);
  const y = pctToDots(element.yPct, height);
  const w = Math.max(8, pctToDots(element.wPct, width));
  const h = Math.max(8, pctToDots(element.hPct, height));
  return { element, x, y, w, h };
}

type EplTextFont = {
  font: 1 | 2 | 3 | 4 | 5;
  xMul: number;
  yMul: number;
  charWidth: number;
  charHeight: number;
};

function eplFontForSize(size: TagElementFontSize): EplTextFont {
  switch (size) {
    case "xs":
      return { font: 1, xMul: 1, yMul: 1, charWidth: 8, charHeight: 12 };
    case "sm":
      return { font: 2, xMul: 1, yMul: 1, charWidth: 10, charHeight: 16 };
    case "md":
      return { font: 3, xMul: 1, yMul: 1, charWidth: 12, charHeight: 20 };
    case "lg":
      return { font: 4, xMul: 1, yMul: 1, charWidth: 16, charHeight: 28 };
    case "xl":
      return { font: 5, xMul: 1, yMul: 1, charWidth: 20, charHeight: 40 };
    case "xxl":
      return { font: 5, xMul: 2, yMul: 1, charWidth: 30, charHeight: 40 };
    case "hero":
      return { font: 5, xMul: 2, yMul: 2, charWidth: 30, charHeight: 80 };
  }
}

function fontSizeRank(size: TagElementFontSize): number {
  return TAG_ELEMENT_FONT_SIZES.indexOf(size);
}

function fitEplTextFont(
  requested: TagElementFontSize,
  value: string,
  availableWidth: number,
  availableHeight: number,
  direction: TagElementDirection,
  options: { isPrice?: boolean } = {},
): EplTextFont {
  const text = escapeEplField(value);
  const sizeIndex = Math.max(0, fontSizeRank(requested));
  const printableWidth = Math.max(8, direction === "normal" ? availableWidth : availableHeight);
  const printableHeight = Math.max(8, direction === "normal" ? availableHeight : availableWidth);
  for (let i = sizeIndex; i >= 0; i -= 1) {
    const candidate = TAG_ELEMENT_FONT_SIZES[i] ?? "xs";
    const font = eplFontForSize(candidate);
    const compactTextLength = options.isPrice ? text.replace(/\s+/g, "").length : text.length;
    const estimatedWidth = Math.max(1, compactTextLength) * font.charWidth;
    if (estimatedWidth <= printableWidth && font.charHeight <= printableHeight + 12) {
      return font;
    }
  }
  return eplFontForSize("xs");
}

function wrapEplTextLines(value: string, maxChars: number): string[] {
  const limit = Math.max(1, maxChars);
  const words = escapeEplField(value).split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > limit) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += limit) {
        lines.push(word.slice(i, i + limit));
      }
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= limit) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [escapeEplField(value)];
}

function fitEplTextBlock(
  requested: TagElementFontSize,
  value: string,
  availableWidth: number,
  availableHeight: number,
  direction: TagElementDirection,
): { font: EplTextFont; lines: string[]; lineAdvance: number } {
  const sizeIndex = Math.max(0, fontSizeRank(requested));
  const printableWidth = Math.max(8, direction === "normal" ? availableWidth : availableHeight);
  const printableHeight = Math.max(8, direction === "normal" ? availableHeight : availableWidth);
  let fallback: { font: EplTextFont; lines: string[]; lineAdvance: number } | null = null;

  for (let i = sizeIndex; i >= 0; i -= 1) {
    const candidate = TAG_ELEMENT_FONT_SIZES[i] ?? "xs";
    const font = eplFontForSize(candidate);
    const maxChars = Math.max(1, Math.floor(printableWidth / font.charWidth));
    const lines = wrapEplTextLines(value, maxChars);
    const lineAdvance = Math.max(font.charHeight, Math.ceil(font.charHeight * 1.08));
    const requiredHeight = lines.length * lineAdvance;
    const block = { font, lines, lineAdvance };
    fallback = block;
    if (requiredHeight <= printableHeight + 4) {
      return block;
    }
  }

  return fallback ?? {
    font: eplFontForSize("xs"),
    lines: wrapEplTextLines(value, Math.max(1, Math.floor(printableWidth / eplFontForSize("xs").charWidth))),
    lineAdvance: eplFontForSize("xs").charHeight,
  };
}

function customTextValue(id: TagElementId, item: InventoryTagItem, config: InventoryTagPrintConfig, footer: string): string {
  switch (id) {
    case "sku":
      return config.showSku ? item.sku : "";
    case "productName":
      return config.showProductName ? item.productName : "";
    case "variation":
      return config.showVariation ? item.variation?.trim() || "Standard" : "";
    case "brand":
      return config.showBrand ? item.brand?.trim() || "" : "";
    case "price": {
      if (!config.showPrice) return "";
      const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
      return isPromo ? item.salePrice ?? "" : item.price?.trim() ?? "";
    }
    case "regularPrice": {
      const isPromo = config.showPrice && config.showPromoPrice && item.salePrice && item.regularPrice;
      return isPromo ? `Reg ${item.regularPrice}` : "";
    }
    case "savings": {
      const isPromo = config.showPrice && config.showPromoPrice && item.salePrice && item.regularPrice;
      if (!isPromo) return "";
      const regular = Number.parseFloat(item.regularPrice!.replace(/[^0-9.]/g, ""));
      const sale = Number.parseFloat(item.salePrice!.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(regular) || !Number.isFinite(sale) || regular <= sale) return "";
      return `Save $${(regular - sale).toFixed(2)}`;
    }
    case "footer":
      return footer;
    case "barcode":
      return config.showBarcode ? item.sku : "";
  }
}

function customTextFont(
  id: TagElementId,
  element: TagElementLayout,
  value: string,
  boxWidth: number,
  boxHeight: number,
): EplTextFont {
  const requested = element.fontSize ?? defaultFontSizeForElement(id);
  return fitEplTextFont(requested, value, boxWidth, boxHeight, element.direction, { isPrice: id === "price" });
}

function isPromoTag(item: InventoryTagItem, config: InventoryTagPrintConfig): boolean {
  return Boolean(config.showPromoPrice && item.salePrice && item.regularPrice);
}

function layoutForItem(item: InventoryTagItem, config: InventoryTagPrintConfig): CustomTagLayout {
  return normalizeCustomLayout(
    isPromoTag(item, config) ? config.saleCustomLayout : config.customLayout,
    isPromoTag(item, config) ? defaultSaleCustomTagLayout() : defaultCustomTagLayout(),
  );
}

function renderCustomEplTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const width = Math.round(clampDimension(config.widthInches, 2, 6, 4) * ZEBRA_2844_DPI);
  const height = Math.round(clampDimension(config.heightInches, 1.25, 4, 2.5) * ZEBRA_2844_DPI);
  const footer = buildInventoryTagFooterLine(config.footerText);
  const layout = layoutForItem(item, config);
  const parts = ["N", `q${width}`, `Q${height},24`, "D7", "S2"];

  for (const id of TAG_ELEMENT_ORDER) {
    const value = customTextValue(id, item, config, footer);
    if (!value) continue;
    const { element, x, y, w, h } = customElementBox(layout, id, width, height);
    const rotation = eplRotation(element.direction);
    if (id === "barcode") {
      const barcodeHeight = Math.max(18, Math.min(rotation === 0 ? h : w, 80));
      const narrowBar = Math.max(1, Math.min(2, Math.floor(w / 150) + 1));
      parts.push(`B${x},${y},${rotation},1,${narrowBar},2,${barcodeHeight},N,"${escapeEplField(value)}"`);
      continue;
    }
    if (id === "productName") {
      const requested = element.fontSize ?? defaultFontSizeForElement(id);
      const block = fitEplTextBlock(requested, value, w, h, element.direction);
      block.lines.forEach((line, index) => {
        if (!line) return;
        parts.push(eplText(x, y + index * block.lineAdvance, rotation, block.font.font, block.font.xMul, block.font.yMul, line));
      });
      continue;
    }
    const font = customTextFont(id, element, value, w, h);
    parts.push(eplText(x, y, rotation, font.font, font.xMul, font.yMul, value));
  }
  parts.push("P1");
  return `${parts.join("\r\n")}\r\n`;
}

function renderEplTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return renderCustomEplTag(item, config);
}

export function buildEplDocument(
  items: InventoryTagItem[],
  config: InventoryTagPrintConfig,
): string {
  return items.map((item) => renderEplTag(item, config)).join("");
}

function readConfiguredTagPrinterLanguage(): ThermalPrinterLanguage {
  return RIVERSIDE_TAG_PRINTER_LANGUAGE;
}

export function getInventoryTagPrinterLanguage(): ThermalPrinterLanguage {
  return readConfiguredTagPrinterLanguage();
}

function tagPrinterLanguageLabel(language: ThermalPrinterLanguage): string {
  return language === "epl" ? "EPL2" : "ZPL";
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

function clampPct(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, value));
}

function normalizeCustomLayout(layout?: CustomTagLayout, fallback: CustomTagLayout = defaultCustomTagLayout()): CustomTagLayout {
  const source: Partial<Record<TagElementId, TagElementLayout>> = layout?.elements ?? {};
  const elements = { ...fallback.elements };
  for (const id of TAG_ELEMENT_ORDER) {
    const raw = source[id] ?? fallback.elements[id];
    const xPct = clampPct(raw.xPct, fallback.elements[id].xPct);
    const yPct = clampPct(raw.yPct, fallback.elements[id].yPct);
    const wPct = Math.min(100 - xPct, Math.max(3, clampPct(raw.wPct, fallback.elements[id].wPct)));
    const hPct = Math.min(100 - yPct, Math.max(3, clampPct(raw.hPct, fallback.elements[id].hPct)));
    const direction: TagElementDirection = raw.direction === "rotated-left" || raw.direction === "rotated-right"
      ? raw.direction
      : "normal";
    const fontSize: TagElementFontSize = TAG_ELEMENT_FONT_SIZES.includes(raw.fontSize as TagElementFontSize)
      ? raw.fontSize as TagElementFontSize
      : fallback.elements[id].fontSize ?? defaultFontSizeForElement(id);
    elements[id] = id === "barcode"
      ? { id, xPct, yPct, wPct, hPct, direction }
      : { id, xPct, yPct, wPct, hPct, direction, fontSize };
  }
  return {
    elements,
  };
}

export function getInventoryTagPrintConfig(): InventoryTagPrintConfig {
  const stored = readStoredConfig();
  const merged = {
    ...DEFAULT_CONFIG,
    ...stored,
  };
  return {
    ...merged,
    customLayout: normalizeCustomLayout(merged.customLayout),
    saleCustomLayout: normalizeCustomLayout(merged.saleCustomLayout, defaultSaleCustomTagLayout()),
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
    customLayout: normalizeCustomLayout(next.customLayout),
    saleCustomLayout: normalizeCustomLayout(next.saleCustomLayout, defaultSaleCustomTagLayout()),
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

function barcodeHtml(sku: string, orient: "h" | "v"): string {
  if (orient === "v") {
    return `<div class="t-bc t-bc-v"><div class="t-bc-v-lbl">${escapeHtml(sku)}</div><div class="t-bc-v-bars"><svg class="t-bc-svg" data-sku="${escapeHtml(sku)}"></svg></div></div>`;
  }
  return `<div class="t-bc t-bc-h"><svg class="t-bc-svg" data-sku="${escapeHtml(sku)}"></svg><div class="t-bc-lbl">${escapeHtml(sku)}</div></div>`;
}

function htmlFontSizeForElement(id: TagElementId, element: TagElementLayout): string {
  const requested = element.fontSize ?? defaultFontSizeForElement(id);
  switch (requested) {
    case "xs": return "9px";
    case "sm": return "10px";
    case "md": return "12px";
    case "lg": return "16px";
    case "xl": return "24px";
    case "xxl": return "34px";
    case "hero": return "48px";
  }
}

function customHtmlElement(id: TagElementId, item: InventoryTagItem, config: InventoryTagPrintConfig, footer: string): string {
  const layout = layoutForItem(item, config);
  const el = layout.elements[id];
  const value = customTextValue(id, item, config, footer);
  if (!value) return "";
  const rotate = el.direction === "rotated-left"
    ? "rotate(-90deg)"
    : el.direction === "rotated-right"
      ? "rotate(90deg)"
      : "none";
  const fontSize = id === "barcode" ? "" : `font-size:${htmlFontSizeForElement(id, el)};`;
  const style = `left:${el.xPct}%;top:${el.yPct}%;width:${el.wPct}%;height:${el.hPct}%;transform:${rotate};${fontSize}`;
  if (id === "barcode") {
    return `<div class="t-custom-el t-custom-barcode" style="${style}">${barcodeHtml(value, "h")}</div>`;
  }
  const cls = id === "price" ? "t-custom-price" : id === "productName" ? "t-custom-name" : "t-custom-text";
  return `<div class="t-custom-el ${cls}" style="${style}">${escapeHtml(value)}</div>`;
}

function renderTagCustom(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  const footer = buildInventoryTagFooterLine(config.footerText);
  return `<section class="tag-page"><div class="tag-shell tag-custom">
    ${TAG_ELEMENT_ORDER.map((id) => customHtmlElement(id, item, config, footer)).join("")}
  </div></section>`;
}

function renderTag(item: InventoryTagItem, config: InventoryTagPrintConfig): string {
  return renderTagCustom(item, config);
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
.tag-custom{position:relative;display:block;}
.t-custom-el{position:absolute;overflow:hidden;transform-origin:center center;color:#000;}
.t-custom-text{font:800 11px/1.1 inherit;letter-spacing:.02em;}
.t-custom-name{font:900 14px/1.05 inherit;white-space:normal;overflow-wrap:anywhere;}
.t-custom-price{font-weight:900;line-height:1;letter-spacing:-.01em;}
.t-custom-barcode .t-bc{width:100%;height:100%;}
.t-custom-barcode .t-bc-svg{width:100%;height:100%;display:block;}
.t-custom-barcode .t-bc-lbl{display:none;}
.t-body{flex:1;display:flex;flex-direction:column;gap:2px;padding:6px 10px 4px;min-width:0;overflow:hidden;}
.t-sku{font:800 11px/1.2 inherit;letter-spacing:.05em;text-transform:uppercase;color:#000;}
.t-name{font:900 14px/1.15 inherit;letter-spacing:-.01em;color:#000;}
.t-var{font:700 11px/1.2 inherit;color:#000;}
.t-brand{font:700 10px/1.2 inherit;text-transform:uppercase;letter-spacing:.05em;color:#000;}
.t-price{font:900 24px/1 inherit;letter-spacing:-.01em;margin-top:auto;color:#000;}
.t-price-block{margin-top:auto;}
.t-price-reg{font:700 10px/1.2 inherit;color:#000;}
.t-price-reg s{text-decoration:line-through;}
.t-price-sale{font:900 24px/1 inherit;letter-spacing:-.01em;color:#000;}
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
</style></head><body>${pages}${config.showBarcode ? generateBarcodeSvgScript() : ""}</body></html>`;
}

export type InventoryTagPrintResult =
  | {
      route: "direct";
      markShelfLabeled: true;
      message: string;
    }
  | {
      route: "preview";
      markShelfLabeled: false;
      message: string;
      directError?: string;
      printDialogOpened: boolean;
    };

/** Single inventory tag routed to the configured tag station. */
export async function openSingleInventoryTag(
  item: InventoryTagItem,
): Promise<InventoryTagPrintResult> {
  return openInventoryTagsWindow([item], undefined, {
    allowPreviewFallback: false,
  });
}

/** Browser preview/system-dialog fallback for tag layouts. */
export async function openInventoryTagsPreviewWindow(
  items: InventoryTagItem[],
  overrideConfig?: Partial<InventoryTagPrintConfig>,
  options: { autoPrint?: boolean; directError?: string } = {},
): Promise<InventoryTagPrintResult> {
  if (items.length === 0) {
    return {
      route: "preview",
      markShelfLabeled: false,
      message: "No tags were selected.",
      printDialogOpened: false,
    };
  }
  const config = {
    ...getInventoryTagPrintConfig(),
    ...overrideConfig,
  };
  const html = buildDocument(items, config);

  if (isTauri()) {
    await openDesktopTextPreview("riverside-tag-preview.html", html);
    return {
      route: "preview",
      markShelfLabeled: false,
      message: "Tag preview opened. No tag was confirmed printed; print manually from the preview.",
      directError: options.directError,
      printDialogOpened: false,
    };
  }

  // Browser/PWA: use window.open approach with appropriate size
  const w = window.open("", "_blank", "width=350,height=500");
  if (!w) {
    throw new Error("Tag print preview was blocked. Please allow popups for Riverside and try again.");
  }
  w.document.write(html);
  w.document.close();
  if (options.autoPrint) {
    await printExistingWindowAsync(w);
  } else {
    w.focus();
  }
  return {
    route: "preview",
    markShelfLabeled: false,
    message: options.autoPrint
      ? "Tag preview opened after direct print failed. No tag was confirmed printed; finish printing from the preview or system dialog."
      : "Tag preview opened. No tag was confirmed printed; print manually from the preview.",
    directError: options.directError,
    printDialogOpened: options.autoPrint === true,
  };
}

function isDefaultLoopbackTagTarget(target: HardwarePrinterTarget): boolean {
  if (target.mode !== "network") return false;
  const storedMode = window.localStorage.getItem("ros.hardware.printer.tag.mode");
  const storedIp = window.localStorage.getItem("ros.hardware.printer.tag.ip")?.trim();
  if (storedMode === "system") return false;
  if (storedIp && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(storedIp)) {
    return false;
  }
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(target.ip.trim());
}

function resolveTagPrintTarget(): HardwarePrinterTarget {
  const target = resolvePrinterTarget("tag");
  if (target.mode === "system") {
    if (!target.printerName.trim()) {
      throw new Error("Choose an installed Tag printer in Printers & Scanners before printing tags.");
    }
    return target;
  }

  if (isDefaultLoopbackTagTarget(target)) {
    throw new Error(
      "Choose an installed Tag printer or a non-loopback Tag printer address in Printers & Scanners before printing tags.",
    );
  }
  if (!target.ip.trim()) {
    throw new Error("Choose a Tag printer address in Printers & Scanners before printing tags.");
  }
  return target;
}

type InventoryTagPrintOptions = {
  allowPreviewFallback?: boolean;
};

/** Multi-label Zebra/ZPL dispatch using the configured Tag Station. */
export async function openInventoryTagsWindow(
  items: InventoryTagItem[],
  overrideConfig?: Partial<InventoryTagPrintConfig>,
  options: InventoryTagPrintOptions = {},
): Promise<InventoryTagPrintResult> {
  if (items.length === 0) {
    return {
      route: "preview",
      markShelfLabeled: false,
      message: "No tags were selected.",
      printDialogOpened: false,
    };
  }
  const config = {
    ...getInventoryTagPrintConfig(),
    ...overrideConfig,
  };

  const target = resolveTagPrintTarget();
  const language = getInventoryTagPrinterLanguage();
  const payload = language === "epl"
    ? buildEplDocument(items, config)
    : buildZplDocument(items, config);

  try {
    const result = (await autoRoutePrint("tag", payload, language, target)) as
      | { target?: string }
      | undefined;
    return {
      route: "direct",
      markShelfLabeled: true,
      message: `sent to ${result?.target ?? describePrinterTarget(target)} using ${tagPrinterLanguageLabel(language)}.`,
    };
  } catch (directError) {
    const directMessage = directError instanceof Error ? directError.message : String(directError);
    const allowPreviewFallback = options.allowPreviewFallback ?? !isTauri();
    if (!allowPreviewFallback) {
      throw new Error(`Tag print failed: ${directMessage}`);
    }
    console.warn("Direct Zebra tag print failed; opening print fallback", directError);
    try {
      return await openInventoryTagsPreviewWindow(items, config, {
        autoPrint: true,
        directError: directMessage,
      });
    } catch (previewError) {
      const previewMessage = previewError instanceof Error ? previewError.message : String(previewError);
      throw new Error(`Tag print failed: ${directMessage}. Print preview also failed: ${previewMessage}`);
    }
  }
}
