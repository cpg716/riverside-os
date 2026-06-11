import { useMemo, useState } from "react";
import {
  Eye,
  LayoutTemplate,
  RotateCcw,
  Save,
  Tag,
  DollarSign,
  Type,
  Printer,
} from "lucide-react";
import {
  type InventoryTagItem,
  type InventoryTagPrintConfig,
  type TagLayoutId,
  TAG_LAYOUTS,
  buildInventoryTagFooterLine,
  getInventoryTagPrintConfig,
  openInventoryTagsPreviewWindow,
  openInventoryTagsWindow,
  saveInventoryTagPrintConfig,
} from "../inventory/labelPrint";
import { useToast } from "../ui/ToastProviderLogic";

const SAMPLE_ITEMS: InventoryTagItem[] = [
  {
    sku: "SUIT-4402-NVY-40R",
    productName: "Hudson Peak Stretch Suit",
    variation: "Navy / 40R",
    brand: "Riverside Black",
    price: "$249.00",
    regularPrice: null,
    salePrice: null,
  },
  {
    sku: "SHOE-220-BLK-11",
    productName: "Cap Toe Oxford",
    variation: "Black / 11",
    brand: "Riverside Formal",
    price: "$119.00",
    regularPrice: "$149.00",
    salePrice: "$119.00",
  },
];

const TEST_PRINT_ITEMS: InventoryTagItem[] = [
  {
    sku: "ROS-TEST-TAG",
    productName: "Riverside test tag",
    variation: "Printer check",
    brand: "RIVERSIDE",
    price: "$1.00",
    regularPrice: null,
    salePrice: null,
  },
];

function normalizeConfig(config: InventoryTagPrintConfig): InventoryTagPrintConfig {
  const widthInches = Number.isFinite(config.widthInches)
    ? Math.min(6, Math.max(2, config.widthInches))
    : 4;
  const heightInches = Number.isFinite(config.heightInches)
    ? Math.min(4, Math.max(1.25, config.heightInches))
    : 2.5;
  return {
    ...config,
    widthInches,
    heightInches,
    footerText: config.footerText.trim() || "Riverside Men's Shop",
  };
}

function parseDimensionInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ── Code 128-B barcode SVG (deterministic, proper encoding) ── */
const CODE128: Record<number, string> = {32:"212222",33:"222122",34:"222221",35:"121223",36:"121322",37:"131222",38:"122213",39:"122312",40:"132212",41:"221213",42:"221312",43:"231212",44:"112232",45:"122132",46:"122231",47:"113222",48:"123122",49:"123221",50:"223211",51:"221132",52:"221231",53:"213212",54:"223112",55:"312131",56:"311222",57:"312212",58:"322112",59:"322211",60:"212123",61:"212321",62:"232121",63:"111323",64:"131123",65:"131321",66:"112313",67:"132113",68:"132311",69:"211313",70:"231113",71:"231311",72:"112133",73:"112331",74:"132131",75:"113123",76:"113321",77:"133121",78:"313121",79:"211331",80:"231131",81:"213113",82:"213311",83:"213131",84:"311123",85:"311321",86:"331121",87:"312113",88:"312311",89:"332111",90:"314111",91:"221411",92:"431111",93:"111224",94:"111422",95:"121124",96:"121421",97:"141122",98:"141221",99:"112214",100:"112412",101:"122114",102:"122411",103:"142112",104:"142211",105:"241211",106:"221114",107:"413111",108:"241112",109:"134111",110:"111242",111:"121142",112:"121241",113:"114212",114:"124112",115:"124211",116:"411212",117:"421112",118:"421211",119:"212141",120:"214121",121:"412121",122:"111143",123:"111341",124:"131141",125:"114113",126:"114311",127:"411113",128:"411311"};

function encodeCode128(text: string): string {
  const startCode = 104;
  let checksum = startCode;
  let bars = CODE128[startCode];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) - 32;
    checksum += (i + 1) * c;
    bars += CODE128[c + 32];
  }
  bars += CODE128[checksum % 103];
  bars += CODE128[106];
  return bars;
}

function BarcodeSvg({ text, className, style }: { text: string; className?: string; style?: React.CSSProperties }) {
  const bars = encodeCode128(text);
  let totalWidth = 0;
  for (let i = 0; i < bars.length; i++) totalWidth += parseInt(bars[i]);

  let x = 0;
  let d = "";
  for (let i = 0; i < bars.length; i++) {
    const w = parseInt(bars[i]);
    if (i % 2 === 0) d += `M${x} 0h${w}v50h-${w}z`;
    x += w;
  }

  return (
    <svg viewBox={`0 0 ${totalWidth} 50`} preserveAspectRatio="none" className={className} style={{ width: "100%", height: "100%", ...style }}>
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/* ── Preview sub-components ── */

/*
 * ── Tag preview architecture ──
 *
 * Every tag preview is a simple stacked list of lines inside a fixed-height box.
 * No flex tricks, no absolute positioning, no spacers.
 * Each line is a plain div with overflow-hidden and text-ellipsis.
 * The outer box clips anything that overflows.
 *
 * For layouts with a horizontal barcode (standard, price-hero, barcode-bottom):
 *   [content area] + [barcode strip at bottom]
 *
 * For layouts with a vertical barcode (barcode-left, barcode-right):
 *   [barcode column] + [content area]   (or reversed)
 *
 * Compact: two columns side by side.
 */

const TAG_PX = 300;
function tagH(c: InventoryTagPrintConfig): number {
  return Math.round(TAG_PX * (Math.max(1, c.heightInches || 2.5) / Math.max(2, c.widthInches || 4)));
}

function TagLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`truncate ${className ?? ""}`}>{children}</div>;
}

function InfoLines({ item, config }: { item: InventoryTagItem; config: InventoryTagPrintConfig }) {
  return (
    <>
      {config.showSku && <TagLine className="text-[11px] font-extrabold uppercase tracking-wide text-black">{item.sku}</TagLine>}
      {config.showProductName && <TagLine className="text-[14px] font-black leading-snug text-black">{item.productName}</TagLine>}
      {config.showVariation && <TagLine className="text-[11px] font-bold text-black">{item.variation}</TagLine>}
      {config.showBrand && item.brand && <TagLine className="text-[10px] font-bold uppercase tracking-wide text-black">{item.brand}</TagLine>}
    </>
  );
}

function PriceLines({ item, config, sizeOverride }: { item: InventoryTagItem; config: InventoryTagPrintConfig; sizeOverride?: string }) {
  if (!config.showPrice) return null;
  const isPromo = config.showPromoPrice && item.salePrice && item.regularPrice;
  const sz = sizeOverride ?? (config.priceSize === "large" ? "text-[24px]" : "text-[16px]");
  if (isPromo) {
    const rn = parseFloat(item.regularPrice!.replace(/[^0-9.]/g, ""));
    const sn = parseFloat(item.salePrice!.replace(/[^0-9.]/g, ""));
    const sav = isFinite(rn) && isFinite(sn) && rn > sn ? `$${(rn - sn).toFixed(2)}` : "";
    return (
      <div className="truncate">
        <span className="text-[10px] font-bold text-black line-through">Reg {item.regularPrice}</span>
        {sav && <span className="ml-1 text-[10px] font-bold text-black">You save {sav}</span>}
        <div className={`${sz} font-black text-black leading-none`}>{item.salePrice}</div>
      </div>
    );
  }
  const p = item.price?.trim();
  if (!p) return null;
  return <TagLine className={`${sz} font-black text-black`}>{p}</TagLine>;
}

function FooterLine({ text }: { text: string }) {
  return <TagLine className="text-[8px] font-bold uppercase tracking-widest text-black">{text}</TagLine>;
}

function HBarcodeRow({ sku }: { sku: string }) {
  return (
    <div className="flex items-center gap-1 border-t border-black/20 px-2 py-0.5" style={{ height: 32 }}>
      <BarcodeSvg text={sku} className="h-[22px] flex-1 text-black" />
      <span className="shrink-0 text-[10px] font-bold text-black">{sku}</span>
    </div>
  );
}

function VBarcodeCol({ sku, side }: { sku: string; side: "left" | "right" }) {
  const border = side === "left" ? "border-r" : "border-l";
  return (
    <div className={`flex ${border} border-black/20 bg-white`} style={{ width: 56 }}>
      <div className="flex w-[16px] items-center justify-center">
        <span className="text-[8px] font-extrabold tracking-wider text-black whitespace-nowrap" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>{sku}</span>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div style={{ width: "140%", transform: "rotate(90deg)" }}>
            <BarcodeSvg text={sku} className="text-black" style={{ height: 36 }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── 6 layout renderers ── */

const tagCls = "rounded border border-black bg-white overflow-hidden";

/** Standard: info top, price+footer bottom, barcode strip at very bottom */
function TagPreviewStandard({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={tagCls} style={{ height: tagH(config) }}>
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
          <div><InfoLines item={item} config={config} /></div>
          <div><PriceLines item={item} config={config} /><FooterLine text={footer} /></div>
        </div>
        {config.showBarcode && <HBarcodeRow sku={item.sku} />}
      </div>
    </div>
  );
}

/** Price Hero: price banner at top, info+footer fill rest, barcode at bottom */
function TagPreviewPriceHero({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={tagCls} style={{ height: tagH(config) }}>
      <div className="flex h-full flex-col">
        <div className="shrink-0 border-b border-black/10 px-1.5 py-1">
          <PriceLines item={item} config={config} sizeOverride={config.priceSize === "large" ? "text-[24px]" : "text-[16px]"} />
        </div>
        <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
          <div><InfoLines item={item} config={config} /></div>
          <FooterLine text={footer} />
        </div>
        {config.showBarcode && <HBarcodeRow sku={item.sku} />}
      </div>
    </div>
  );
}

/** Barcode Left: vertical barcode on left, content fills rest */
function TagPreviewBarcodeLeft({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={`flex ${tagCls}`} style={{ height: tagH(config) }}>
      {config.showBarcode && <VBarcodeCol sku={item.sku} side="left" />}
      <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
        <div><InfoLines item={item} config={config} /></div>
        <div><PriceLines item={item} config={config} /><FooterLine text={footer} /></div>
      </div>
    </div>
  );
}

/** Barcode Right: content on left, vertical barcode on right */
function TagPreviewBarcodeRight({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={`flex ${tagCls}`} style={{ height: tagH(config) }}>
      <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
        <div><InfoLines item={item} config={config} /></div>
        <div><PriceLines item={item} config={config} /><FooterLine text={footer} /></div>
      </div>
      {config.showBarcode && <VBarcodeCol sku={item.sku} side="right" />}
    </div>
  );
}

/** Barcode Bottom: like standard but barcode strip is full-width at bottom */
function TagPreviewBarcodeBottom({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={tagCls} style={{ height: tagH(config) }}>
      <div className="flex h-full flex-col">
        <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
          <div><InfoLines item={item} config={config} /></div>
          <div><PriceLines item={item} config={config} /><FooterLine text={footer} /></div>
        </div>
        {config.showBarcode && <HBarcodeRow sku={item.sku} />}
      </div>
    </div>
  );
}

/** Compact: two-column, info left, price+barcode right */
function TagPreviewCompact({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  return (
    <div className={`flex ${tagCls}`} style={{ height: tagH(config) }}>
      <div className="flex flex-1 flex-col justify-between overflow-hidden p-1.5">
        <div><InfoLines item={item} config={config} /></div>
        <FooterLine text={footer} />
      </div>
      <div className="flex flex-col justify-between overflow-hidden border-l border-black/20 p-1.5 text-right" style={{ width: "40%" }}>
        <PriceLines item={item} config={config} />
        {config.showBarcode && (
          <div>
            <BarcodeSvg text={item.sku} className="h-[22px] w-full text-black" />
            <div className="text-[9px] font-bold text-black">{item.sku}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function TagPreview({ item, config, footer }: { item: InventoryTagItem; config: InventoryTagPrintConfig; footer: string }) {
  switch (config.tagLayout) {
    case "price-hero": return <TagPreviewPriceHero item={item} config={config} footer={footer} />;
    case "barcode-left": return <TagPreviewBarcodeLeft item={item} config={config} footer={footer} />;
    case "barcode-right": return <TagPreviewBarcodeRight item={item} config={config} footer={footer} />;
    case "barcode-bottom": return <TagPreviewBarcodeBottom item={item} config={config} footer={footer} />;
    case "compact": return <TagPreviewCompact item={item} config={config} footer={footer} />;
    default: return <TagPreviewStandard item={item} config={config} footer={footer} />;
  }
}

/* ── Layout picker thumbnails ── */

function LayoutThumb({ id }: { id: TagLayoutId }) {
  const bar = <div className="h-[6px] rounded-sm bg-slate-300" />;
  const bc = <div className="flex gap-px">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-[8px] bg-slate-400" style={{ width: i % 2 === 0 ? 2 : 1 }} />)}</div>;
  switch (id) {
    case "standard":
      return <div className="flex h-full flex-col justify-between gap-1 p-1.5"><div className="space-y-1">{bar}<div className="h-[4px] w-3/4 rounded-sm bg-slate-200" />{bar}</div><div className="mt-auto">{bc}</div></div>;
    case "price-hero":
      return <div className="flex h-full flex-col gap-1 p-1.5"><div className="h-[10px] w-2/3 rounded-sm bg-slate-500" /><div className="space-y-1">{bar}<div className="h-[4px] w-3/4 rounded-sm bg-slate-200" /></div><div className="mt-auto">{bc}</div></div>;
    case "barcode-left":
      return <div className="flex h-full gap-1 p-1.5"><div className="flex w-3 flex-col items-center gap-px py-0.5">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="w-full bg-slate-400" style={{ height: i % 2 === 0 ? 2 : 1 }} />)}</div><div className="flex flex-1 flex-col gap-1">{bar}{bar}<div className="h-[4px] w-2/3 rounded-sm bg-slate-200" /></div></div>;
    case "barcode-right":
      return <div className="flex h-full gap-1 p-1.5"><div className="flex flex-1 flex-col gap-1">{bar}{bar}<div className="h-[4px] w-2/3 rounded-sm bg-slate-200" /></div><div className="flex w-3 flex-col items-center gap-px py-0.5">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="w-full bg-slate-400" style={{ height: i % 2 === 0 ? 2 : 1 }} />)}</div></div>;
    case "barcode-bottom":
      return <div className="flex h-full flex-col gap-1 p-1.5"><div className="flex-1 space-y-1">{bar}{bar}<div className="h-[4px] w-2/3 rounded-sm bg-slate-200" /></div><div className="mt-auto border-t border-slate-200 pt-1">{bc}</div></div>;
    case "compact":
      return <div className="flex h-full gap-1 p-1.5"><div className="flex flex-1 flex-col gap-1">{bar}<div className="h-[4px] w-3/4 rounded-sm bg-slate-200" /></div><div className="flex w-[40%] flex-col items-end gap-1 border-l border-slate-200 pl-1"><div className="h-[8px] w-full rounded-sm bg-slate-400" />{bc}</div></div>;
  }
}

/* ── Main panel ── */

export default function TagDesignerPanel() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<InventoryTagPrintConfig>(() => getInventoryTagPrintConfig());

  const normalizedDraft = useMemo(() => normalizeConfig(draft), [draft]);
  const savedConfig = useMemo(() => getInventoryTagPrintConfig(), []);
  const [baselineConfig, setBaselineConfig] = useState<InventoryTagPrintConfig>(savedConfig);

  const hasChanges = JSON.stringify(normalizedDraft) !== JSON.stringify(baselineConfig);

  const updateDraft = <K extends keyof InventoryTagPrintConfig>(key: K, value: InventoryTagPrintConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => { const next = saveInventoryTagPrintConfig(draft); setDraft(next); setBaselineConfig(next); toast("Tag layout saved.", "success"); };
  const handleReset = () => { const r = getInventoryTagPrintConfig(); setDraft(r); setBaselineConfig(r); toast("Restored to your last saved layout.", "info"); };
  const handlePreview = async () => {
    try {
      await openInventoryTagsPreviewWindow(SAMPLE_ITEMS, normalizedDraft);
      toast("Print preview opened.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Print preview failed.", "error");
    }
  };
  const handlePrint = async () => {
    try {
      const result = await openInventoryTagsWindow(TEST_PRINT_ITEMS, normalizedDraft);
      if (result.route === "direct") {
        toast("Test tag sent to the tag station.", "success");
      } else {
        toast(result.message, "info");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Test tag print failed.", "error");
    }
  };

  const previewFooterLine = buildInventoryTagFooterLine(normalizedDraft.footerText);

  return (
    <section className="space-y-6 p-6">
      {/* Header */}
      <header className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-900">
          <Tag size={14} /> Tag designer
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-2">
            <h2 className="text-3xl font-black uppercase tracking-tight text-app-text">Price tag layout</h2>
            <p className="text-sm font-medium text-app-text-muted">
              Design your price tags here. Changes apply everywhere tags are printed &mdash; inventory lists,
              control boards, and quick-print buttons. Optimized for Zebra 2844 thermal printers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void handlePrint()} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition-colors hover:border-app-input-border hover:bg-app-surface-2"><Printer size={16} /> Print test tag</button>
            <button type="button" onClick={() => void handlePreview()} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition-colors hover:border-app-input-border hover:bg-app-surface-2"><Eye size={16} /> Print preview</button>
            <button type="button" onClick={handleReset} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition-colors hover:border-app-input-border hover:bg-app-surface-2"><RotateCcw size={16} /> Undo changes</button>
            <button type="button" onClick={handleSave} className="inline-flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-sm font-black text-white shadow-sm transition-colors hover:brightness-110"><Save size={16} /> Save layout</button>
          </div>
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-app-text-muted">
          {hasChanges ? "You have unsaved changes. Save to apply them to all future prints." : "Your saved layout is active for all tag printing."}
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div className="space-y-6">

          {/* ── 1. Tag layout picker ── */}
          <section className="ui-card space-y-4 p-5">
            <div className="flex items-center gap-2">
              <LayoutTemplate size={18} className="text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Choose a layout</h3>
                <p className="text-sm text-app-text-muted">Pick how the information and barcode are arranged on each tag.</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 lg:grid-cols-6">
              {TAG_LAYOUTS.map((lo) => {
                const active = normalizedDraft.tagLayout === lo.id;
                return (
                  <button
                    key={lo.id}
                    type="button"
                    onClick={() => updateDraft("tagLayout", lo.id)}
                    className={`group rounded-xl border p-1 text-left transition-all ${active ? "border-app-accent bg-app-surface-2 shadow ring-1 ring-app-accent/30" : "border-app-border bg-app-surface hover:border-app-input-border"}`}
                  >
                    <div className={`mb-1.5 h-[52px] overflow-hidden rounded-lg border ${active ? "border-app-accent/40 bg-app-surface" : "border-slate-200 bg-slate-50"}`}>
                      <LayoutThumb id={lo.id} />
                    </div>
                    <p className="px-0.5 text-[10px] font-bold text-app-text">{lo.label}</p>
                    <p className="px-0.5 text-[9px] leading-snug text-app-text-muted">{lo.description}</p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── 2. Tag dimensions ── */}
          <section className="ui-card space-y-4 p-5">
            <div className="flex items-center gap-2">
              <Tag size={18} className="text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Tag size</h3>
                <p className="text-sm text-app-text-muted">Set the physical dimensions of your label stock.</p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">Width (inches)</span>
                <input type="number" min="2" max="6" step="0.25" value={draft.widthInches} onChange={(e) => updateDraft("widthInches", parseDimensionInput(e.target.value, draft.widthInches))} className="ui-input w-full" />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">Height (inches)</span>
                <input type="number" min="1.25" max="4" step="0.25" value={draft.heightInches} onChange={(e) => updateDraft("heightInches", parseDimensionInput(e.target.value, draft.heightInches))} className="ui-input w-full" />
              </label>
            </div>
          </section>

          {/* ── 3. What to show ── */}
          <section className="ui-card space-y-4 p-5">
            <div className="flex items-center gap-2">
              <Type size={18} className="text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">What to print</h3>
                <p className="text-sm text-app-text-muted">Toggle the information that appears on every label.</p>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {([
                ["showSku", "SKU code", "Item identifier for searching and rack finding."],
                ["showProductName", "Product name", "The main title of the item."],
                ["showVariation", "Size & color", "Specific variant like color and size."],
                ["showBrand", "Brand name", "Vendor or collection name."],
                ["showPrice", "Price", "Retail price of the item."],
                ["showBarcode", "Scannable barcode", "Code 128 barcode for handheld scanners."],
                ["showPromoPrice", "Sale pricing", "Shows regular price, sale price, and savings."],
              ] as [keyof InventoryTagPrintConfig, string, string][]).map(([key, label, hint]) => (
                <label key={key} className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface px-3 py-2.5">
                  <div><p className="text-sm font-bold text-app-text">{label}</p><p className="text-[11px] text-app-text-muted">{hint}</p></div>
                  <input type="checkbox" checked={!!draft[key]} onChange={(e) => updateDraft(key, e.target.checked as never)} className="h-4 w-4 rounded border-app-input-border text-app-accent" />
                </label>
              ))}
            </div>
          </section>

          {/* ── 4. Price display ── */}
          <section className="ui-card space-y-4 p-5">
            <div className="flex items-center gap-2">
              <DollarSign size={18} className="text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Price size</h3>
                <p className="text-sm text-app-text-muted">How big should the price appear?</p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {([["large", "Large & bold", "$249.00", "text-2xl", "Easy to read at a glance — great for the sales floor."], ["standard", "Standard", "$249.00", "text-base", "Price blends with the rest of the tag info."]] as const).map(([val, title, ex, sz, desc]) => (
                <button key={val} type="button" onClick={() => updateDraft("priceSize", val)} className={`rounded-xl border p-3 text-left transition-all ${draft.priceSize === val ? "border-app-accent bg-app-surface-2 shadow-sm" : "border-app-border bg-app-surface hover:border-app-input-border"}`}>
                  <p className={`${sz} font-black text-slate-900`}>{ex}</p>
                  <p className="mt-1.5 text-sm font-bold text-app-text">{title}</p>
                  <p className="text-[11px] text-app-text-muted">{desc}</p>
                </button>
              ))}
            </div>
          </section>

          {/* ── 5. Footer ── */}
          <section className="ui-card space-y-4 p-5">
            <div>
              <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Footer &amp; branding</h3>
              <p className="mt-1 text-sm text-app-text-muted">The small text printed at the bottom of every tag.</p>
            </div>
            <label className="space-y-1.5">
              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">Shop name or message</span>
              <input type="text" value={draft.footerText} onChange={(e) => updateDraft("footerText", e.target.value)} className="ui-input w-full" placeholder="Riverside Men's Shop" />
              <p className="text-[11px] text-app-text-muted">Today's date is automatically added after this text on every printed tag.</p>
            </label>
          </section>
        </div>

        {/* ── Live preview sidebar ── */}
        <aside className="ui-card sticky top-6 space-y-4 p-5">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Live preview</h3>
            <p className="mt-1 text-sm text-app-text-muted">
              Exactly how your tags will look on the Zebra 2844. Changes update instantly.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm">
            <div className="grid gap-2.5">
              {SAMPLE_ITEMS.map((item) => (
                <TagPreview key={item.sku} item={item} config={normalizedDraft} footer={previewFooterLine} />
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3 text-sm text-app-text-muted">
            <p className="font-bold text-app-text">How this works</p>
            <p className="mt-1.5 text-[12px]">
              Every tag printed from inventory screens, control boards, and quick-print buttons uses this layout.
              Saving here updates all future prints without changing receipt or hardware settings.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
