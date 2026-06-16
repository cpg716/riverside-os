import { isTauri } from "@tauri-apps/api/core";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eye,
  Move,
  Printer,
  RotateCcw,
  Save,
  Tag,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type CustomTagLayout,
  type InventoryTagItem,
  type InventoryTagPrintConfig,
  type TagElementDirection,
  type TagElementId,
  type TagElementLayout,
  TAG_ELEMENT_LABELS,
  TAG_ELEMENT_ORDER,
  buildInventoryTagFooterLine,
  defaultCustomTagLayout,
  defaultSaleCustomTagLayout,
  getInventoryTagPrintConfig,
  openInventoryTagsPreviewWindow,
  openInventoryTagsWindow,
  saveInventoryTagPrintConfig,
} from "../inventory/labelPrint";
import { useToast } from "../ui/ToastProviderLogic";

const TEST_PRINT_ITEM: InventoryTagItem = {
  sku: "B-123456",
  productName: "HSM SLACKS (Custom)",
  variation: "Standard",
  brand: "Hart Schaffner Marx",
  price: "$0.00",
  regularPrice: null,
  salePrice: null,
};

const SALE_TEST_PRINT_ITEM: InventoryTagItem = {
  ...TEST_PRINT_ITEM,
  price: "$119.00",
  regularPrice: "$149.00",
  salePrice: "$119.00",
};

const LP_2844_RETAIL_TAG_WIDTH = 2.25;
const LP_2844_RETAIL_TAG_HEIGHT = 1.25;

const CODE128: Record<number, string> = {32:"212222",33:"222122",34:"222221",35:"121223",36:"121322",37:"131222",38:"122213",39:"122312",40:"132212",41:"221213",42:"221312",43:"231212",44:"112232",45:"122132",46:"122231",47:"113222",48:"123122",49:"123221",50:"223211",51:"221132",52:"221231",53:"213212",54:"223112",55:"312131",56:"311222",57:"312212",58:"322112",59:"322211",60:"212123",61:"212321",62:"232121",63:"111323",64:"131123",65:"131321",66:"112313",67:"132113",68:"132311",69:"211313",70:"231113",71:"231311",72:"112133",73:"112331",74:"132131",75:"113123",76:"113321",77:"133121",78:"313121",79:"211331",80:"231131",81:"213113",82:"213311",83:"213131",84:"311123",85:"311321",86:"331121",87:"312113",88:"312311",89:"332111",90:"314111",91:"221411",92:"431111",93:"111224",94:"111422",95:"121124",96:"121421",97:"141122",98:"141221",99:"112214",100:"112412",101:"122114",102:"122411",103:"142112",104:"142211",105:"241211",106:"221114",107:"413111",108:"241112",109:"134111",110:"111242",111:"121142",112:"121241",113:"114212",114:"124112",115:"124211",116:"411212",117:"421112",118:"421211",119:"212141",120:"214121",121:"412121",122:"111143",123:"111341",124:"131141",125:"114113",126:"114311",127:"411113",128:"411311"};

function clampPct(value: number, min = 0, max = 100): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function normalizeConfig(config: InventoryTagPrintConfig): InventoryTagPrintConfig {
  const widthInches = Number.isFinite(config.widthInches)
    ? Math.min(6, Math.max(2, config.widthInches))
    : LP_2844_RETAIL_TAG_WIDTH;
  const heightInches = Number.isFinite(config.heightInches)
    ? Math.min(4, Math.max(1.25, config.heightInches))
    : LP_2844_RETAIL_TAG_HEIGHT;
  return {
    ...config,
    widthInches,
    heightInches,
    footerText: config.footerText.trim() || "Riverside Men's Shop",
    customLayout: config.customLayout ?? defaultCustomTagLayout(),
    saleCustomLayout: config.saleCustomLayout ?? defaultSaleCustomTagLayout(),
  };
}

function parseDimensionInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getLayout(config: InventoryTagPrintConfig, mode: "regular" | "sale"): CustomTagLayout {
  return mode === "sale"
    ? config.saleCustomLayout ?? defaultSaleCustomTagLayout()
    : config.customLayout ?? defaultCustomTagLayout();
}

function visibleField(id: TagElementId, config: InventoryTagPrintConfig): boolean {
  if (id === "sku") return config.showSku;
  if (id === "productName") return config.showProductName;
  if (id === "variation") return config.showVariation;
  if (id === "brand") return config.showBrand;
  if (id === "price") return config.showPrice;
  if (id === "regularPrice" || id === "savings") return config.showPrice && config.showPromoPrice;
  if (id === "barcode") return config.showBarcode;
  return true;
}

function fieldValue(
  id: TagElementId,
  item: InventoryTagItem,
  config: InventoryTagPrintConfig,
  footer: string,
): string {
  if (!visibleField(id, config)) return "";
  if (id === "sku") return item.sku;
  if (id === "productName") return item.productName;
  if (id === "variation") return item.variation?.trim() || "Standard";
  if (id === "brand") return item.brand?.trim() || "";
  if (id === "price") return item.salePrice?.trim() || item.price?.trim() || "";
  if (id === "regularPrice") return item.salePrice && item.regularPrice ? `Reg ${item.regularPrice}` : "";
  if (id === "savings") {
    if (!item.salePrice || !item.regularPrice) return "";
    const regular = Number.parseFloat(item.regularPrice.replace(/[^0-9.]/g, ""));
    const sale = Number.parseFloat(item.salePrice.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(regular) || !Number.isFinite(sale) || regular <= sale) return "";
    return `Save $${(regular - sale).toFixed(2)}`;
  }
  if (id === "barcode") return item.sku;
  return footer;
}

function encodeCode128(text: string): string {
  const startCode = 104;
  let checksum = startCode;
  let bars = CODE128[startCode] ?? "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const normalized = code >= 32 && code <= 128 ? code : 32;
    const value = normalized - 32;
    checksum += (i + 1) * value;
    bars += CODE128[value + 32] ?? CODE128[32];
  }
  bars += CODE128[checksum % 103] ?? "";
  bars += CODE128[106] ?? "";
  return bars;
}

function BarcodeSvg({ text }: { text: string }) {
  const bars = encodeCode128(text);
  let totalWidth = 0;
  for (let i = 0; i < bars.length; i += 1) totalWidth += Number.parseInt(bars[i] ?? "0", 10);

  let x = 0;
  let d = "";
  for (let i = 0; i < bars.length; i += 1) {
    const w = Number.parseInt(bars[i] ?? "0", 10);
    if (i % 2 === 0) d += `M${x} 0h${w}v50h-${w}z`;
    x += w;
  }

  return (
    <svg viewBox={`0 0 ${totalWidth} 50`} preserveAspectRatio="none" className="h-full w-full text-black">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

function elementStyle(element: TagElementLayout): CSSProperties {
  const rotate = element.direction === "rotated-left"
    ? "rotate(-90deg)"
    : element.direction === "rotated-right"
      ? "rotate(90deg)"
      : undefined;
  return {
    left: `${element.xPct}%`,
    top: `${element.yPct}%`,
    width: `${element.wPct}%`,
    height: `${element.hPct}%`,
    transform: rotate,
  };
}

function elementClass(id: TagElementId, config: InventoryTagPrintConfig): string {
  if (id === "price") {
    return config.priceSize === "large"
      ? "text-[34px] font-black leading-none"
      : "text-[22px] font-black leading-none";
  }
  if (id === "productName") return "text-[16px] font-black leading-tight";
  if (id === "regularPrice" || id === "savings") return "text-[10px] font-black uppercase leading-tight";
  if (id === "brand" || id === "footer") return "text-[10px] font-extrabold leading-tight";
  return "text-[12px] font-extrabold leading-tight";
}

type DragState = {
  id: TagElementId;
  startX: number;
  startY: number;
  start: TagElementLayout;
  rect: DOMRect;
};

export default function TagDesignerPanel() {
  const { toast } = useToast();
  const previewRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [selectedId, setSelectedId] = useState<TagElementId>("price");
  const [previewMode, setPreviewMode] = useState<"regular" | "sale">("regular");
  const [draft, setDraft] = useState<InventoryTagPrintConfig>(() => getInventoryTagPrintConfig());
  const savedConfig = useMemo(() => getInventoryTagPrintConfig(), []);
  const [baselineConfig, setBaselineConfig] = useState<InventoryTagPrintConfig>(savedConfig);

  const normalizedDraft = useMemo(() => normalizeConfig(draft), [draft]);
  const layout = getLayout(normalizedDraft, previewMode);
  const selectedElement = layout.elements[selectedId];
  const footerLine = buildInventoryTagFooterLine(normalizedDraft.footerText);
  const previewItem = previewMode === "sale" ? SALE_TEST_PRINT_ITEM : TEST_PRINT_ITEM;
  const hasChanges = JSON.stringify(normalizedDraft) !== JSON.stringify(baselineConfig);
  const desktopApp = isTauri();

  const updateDraft = <K extends keyof InventoryTagPrintConfig>(key: K, value: InventoryTagPrintConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const updateElement = (id: TagElementId, patch: Partial<TagElementLayout>) => {
    setDraft((prev) => {
      const layoutKey = previewMode === "sale" ? "saleCustomLayout" : "customLayout";
      const current = getLayout(prev, previewMode);
      const existing = current.elements[id];
      const nextX = clampPct(patch.xPct ?? existing.xPct);
      const nextY = clampPct(patch.yPct ?? existing.yPct);
      const nextW = Math.min(100 - nextX, Math.max(3, clampPct(patch.wPct ?? existing.wPct)));
      const nextH = Math.min(100 - nextY, Math.max(3, clampPct(patch.hPct ?? existing.hPct)));
      return {
        ...prev,
        [layoutKey]: {
          elements: {
            ...current.elements,
            [id]: {
              ...existing,
              ...patch,
              id,
              xPct: nextX,
              yPct: nextY,
              wPct: nextW,
              hPct: nextH,
            },
          },
        },
      };
    });
  };

  const moveElement = (id: TagElementId, dx: number, dy: number) => {
    const element = getLayout(normalizedDraft, previewMode).elements[id];
    updateElement(id, { xPct: element.xPct + dx, yPct: element.yPct + dy });
  };

  const resetBuilder = () => {
    setDraft((prev) => previewMode === "sale"
      ? { ...prev, saleCustomLayout: defaultSaleCustomTagLayout() }
      : { ...prev, customLayout: defaultCustomTagLayout() });
    setSelectedId("price");
    toast(`${previewMode === "sale" ? "Sale" : "Regular"} tag layout reset to the starter arrangement.`, "info");
  };

  const useRetailTagSize = () => {
    setDraft((prev) => ({
      ...prev,
      widthInches: LP_2844_RETAIL_TAG_WIDTH,
      heightInches: LP_2844_RETAIL_TAG_HEIGHT,
    }));
  };

  const handleSave = () => {
    const next = saveInventoryTagPrintConfig(normalizedDraft);
    setDraft(next);
    setBaselineConfig(next);
    toast("Tag layout saved.", "success");
  };

  const handleResetSaved = () => {
    const restored = getInventoryTagPrintConfig();
    setDraft(restored);
    setBaselineConfig(restored);
    toast("Restored to your last saved tag layout.", "info");
  };

  const handlePreview = async () => {
    if (desktopApp) {
      toast("The live preview is shown here. Print test tag sends this exact saved builder layout to the tag printer.", "info");
      return;
    }
    try {
      await openInventoryTagsPreviewWindow([previewItem], normalizedDraft);
      toast("Print preview opened.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error || "Print preview failed."), "error");
    }
  };

  const handlePrint = async () => {
    try {
      const saved = saveInventoryTagPrintConfig(normalizedDraft);
      setDraft(saved);
      setBaselineConfig(saved);
      const result = await openInventoryTagsWindow([previewItem], saved, {
        allowPreviewFallback: false,
      });
      toast(result.route === "direct" ? `Layout saved. Test tag ${result.message}` : result.message, result.route === "direct" ? "success" : "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Test tag print failed.", "error");
    }
  };

  const onElementPointerDown = (event: PointerEvent<HTMLButtonElement>, id: TagElementId) => {
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedId(id);
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      start: getLayout(normalizedDraft, previewMode).elements[id],
      rect,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dxPct = ((event.clientX - drag.startX) / drag.rect.width) * 100;
    const dyPct = ((event.clientY - drag.startY) / drag.rect.height) * 100;
    updateElement(drag.id, {
      xPct: drag.start.xPct + dxPct,
      yPct: drag.start.yPct + dyPct,
    });
  };

  const stopDrag = () => {
    dragRef.current = null;
  };

  const previewStyle: CSSProperties = {
    aspectRatio: `${normalizedDraft.widthInches} / ${normalizedDraft.heightInches}`,
  };

  return (
    <section className="space-y-6 p-6">
      <header className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-900">
          <Tag size={14} /> Tag builder
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-2">
            <h2 className="text-3xl font-black uppercase tracking-tight text-app-text">Price tag builder</h2>
            <p className="text-sm font-medium text-app-text-muted">
              Move each field exactly where it should print. This builder layout is the tag print layout.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void handlePrint()} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text hover:border-app-input-border hover:bg-app-surface-2">
              <Printer size={16} /> Save & print test tag
            </button>
            {!desktopApp ? (
              <button type="button" onClick={() => void handlePreview()} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text hover:border-app-input-border hover:bg-app-surface-2">
                <Eye size={16} /> Print preview
              </button>
            ) : null}
            <button type="button" onClick={handleResetSaved} className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text hover:border-app-input-border hover:bg-app-surface-2">
              <RotateCcw size={16} /> Undo changes
            </button>
            <button type="button" onClick={handleSave} className="inline-flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-sm font-black text-white shadow-sm hover:brightness-110">
              <Save size={16} /> Save layout
            </button>
          </div>
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-app-text-muted">
          {hasChanges ? "Unsaved changes. Save before printing real item tags." : "Saved builder layout is active for tag printing."}
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-6">
          <section className="ui-card space-y-4 p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Live tag canvas</h3>
                <p className="mt-1 text-sm text-app-text-muted">Click a field, drag it, then fine-tune position and size on the right.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => setPreviewMode("regular")} className={`rounded-xl border px-3 py-2 text-xs font-black uppercase tracking-[0.14em] ${previewMode === "regular" ? "border-app-accent bg-app-accent text-white" : "border-app-border bg-app-surface text-app-text hover:bg-app-surface-2"}`}>
                  Regular tag
                </button>
                <button type="button" onClick={() => setPreviewMode("sale")} className={`rounded-xl border px-3 py-2 text-xs font-black uppercase tracking-[0.14em] ${previewMode === "sale" ? "border-app-accent bg-app-accent text-white" : "border-app-border bg-app-surface text-app-text hover:bg-app-surface-2"}`}>
                  Sale tag
                </button>
                <button type="button" onClick={useRetailTagSize} className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-app-text hover:bg-app-surface-2">
                  LP 2844 size
                </button>
                <button type="button" onClick={resetBuilder} className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-app-text hover:bg-app-surface-2">
                  Reset starter
                </button>
              </div>
            </div>

            <div className="rounded-2xl border border-app-border bg-slate-100 p-4">
              <div
                ref={previewRef}
                role="application"
                aria-label="Editable tag preview"
                className="relative mx-auto w-full max-w-[760px] overflow-hidden rounded border border-black bg-white text-black shadow-sm"
                style={previewStyle}
                onPointerMove={onPointerMove}
                onPointerUp={stopDrag}
                onPointerLeave={stopDrag}
              >
                {TAG_ELEMENT_ORDER.map((id) => {
                  const value = fieldValue(id, previewItem, normalizedDraft, footerLine);
                  if (!value) return null;
                  const element = layout.elements[id];
                  const active = selectedId === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onPointerDown={(event) => onElementPointerDown(event, id)}
                      onClick={() => setSelectedId(id)}
                      className={`absolute overflow-hidden border text-left ${active ? "border-app-accent bg-app-accent/10" : "border-dashed border-slate-300 bg-transparent"} ${id === "barcode" ? "p-0.5" : "px-1 py-0.5"} ${elementClass(id, normalizedDraft)}`}
                      style={elementStyle(element)}
                    >
                      {id === "barcode" ? <BarcodeSvg text={value} /> : value}
                    </button>
                  );
                })}
                <div className="pointer-events-none absolute inset-0 border border-dashed border-black/15" />
              </div>
            </div>
          </section>

          <section className="ui-card space-y-4 p-5">
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Tag size</h3>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">Width inches</span>
                <input type="number" min="2" max="6" step="0.05" value={draft.widthInches} onChange={(e) => updateDraft("widthInches", parseDimensionInput(e.target.value, draft.widthInches))} className="ui-input w-full" />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">Height inches</span>
                <input type="number" min="1.25" max="4" step="0.05" value={draft.heightInches} onChange={(e) => updateDraft("heightInches", parseDimensionInput(e.target.value, draft.heightInches))} className="ui-input w-full" />
              </label>
            </div>
            {normalizedDraft.widthInches <= 2.5 && normalizedDraft.heightInches > 1.5 ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                This height can feed more than one physical tag on common Riverside stock.
              </div>
            ) : null}
          </section>

          <section className="ui-card space-y-4 p-5">
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Printed fields</h3>
            <div className="grid gap-2 md:grid-cols-2">
              {([
                ["showSku", "SKU"],
                ["showProductName", "Product name"],
                ["showVariation", "Variation"],
                ["showBrand", "Brand"],
                ["showPrice", "Price"],
                ["showBarcode", "Barcode"],
                ["showPromoPrice", "Sale pricing"],
              ] as [keyof InventoryTagPrintConfig, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface px-3 py-2.5">
                  <span className="text-sm font-bold text-app-text">{label}</span>
                  <input type="checkbox" checked={!!draft[key]} onChange={(e) => updateDraft(key, e.target.checked as never)} className="h-4 w-4 rounded border-app-input-border text-app-accent" />
                </label>
              ))}
            </div>
          </section>
        </div>

        <aside className="ui-card sticky top-6 space-y-5 p-5">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">Selected field</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {TAG_ELEMENT_ORDER.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedId(id)}
                  className={`rounded-xl border px-3 py-2 text-left text-xs font-black uppercase tracking-[0.12em] ${selectedId === id ? "border-app-accent bg-app-accent text-white" : "border-app-border bg-app-surface text-app-text hover:bg-app-surface-2"}`}
                >
                  {TAG_ELEMENT_LABELS[id]}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <div className="mb-3 flex items-center gap-2 text-sm font-black text-app-text">
              <Move size={16} /> {TAG_ELEMENT_LABELS[selectedId]}
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([
                ["xPct", "X"],
                ["yPct", "Y"],
                ["wPct", "Width"],
                ["hPct", "Height"],
              ] as [keyof TagElementLayout, string][]).map(([key, label]) => (
                <label key={key} className="space-y-1">
                  <span className="text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">{label} %</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    value={Number(selectedElement[key])}
                    onChange={(event) => updateElement(selectedId, { [key]: Number.parseFloat(event.target.value) } as Partial<TagElementLayout>)}
                    className="ui-input w-full"
                  />
                </label>
              ))}
            </div>
            <label className="mt-3 block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">Direction</span>
              <select value={selectedElement.direction} onChange={(event) => updateElement(selectedId, { direction: event.target.value as TagElementDirection })} className="ui-input w-full">
                <option value="normal">Normal</option>
                <option value="rotated-left">Rotate left</option>
                <option value="rotated-right">Rotate right</option>
              </select>
            </label>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <span />
              <button type="button" onClick={() => moveElement(selectedId, 0, -1)} className="rounded-lg border border-app-border bg-app-surface p-2 text-app-text hover:bg-app-surface"><ArrowUp size={16} className="mx-auto" /></button>
              <span />
              <button type="button" onClick={() => moveElement(selectedId, -1, 0)} className="rounded-lg border border-app-border bg-app-surface p-2 text-app-text hover:bg-app-surface"><ArrowLeft size={16} className="mx-auto" /></button>
              <button type="button" onClick={() => updateElement(selectedId, defaultCustomTagLayout().elements[selectedId])} className="rounded-lg border border-app-border bg-app-surface px-2 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-app-text hover:bg-app-surface">Reset</button>
              <button type="button" onClick={() => moveElement(selectedId, 1, 0)} className="rounded-lg border border-app-border bg-app-surface p-2 text-app-text hover:bg-app-surface"><ArrowRight size={16} className="mx-auto" /></button>
              <span />
              <button type="button" onClick={() => moveElement(selectedId, 0, 1)} className="rounded-lg border border-app-border bg-app-surface p-2 text-app-text hover:bg-app-surface"><ArrowDown size={16} className="mx-auto" /></button>
              <span />
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
            <h4 className="text-xs font-black uppercase tracking-[0.16em] text-app-text">Price and footer</h4>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => updateDraft("priceSize", "large")} className={`rounded-xl border px-3 py-2 text-sm font-black ${draft.priceSize === "large" ? "border-app-accent bg-app-accent text-white" : "border-app-border bg-app-surface text-app-text"}`}>Large</button>
              <button type="button" onClick={() => updateDraft("priceSize", "standard")} className={`rounded-xl border px-3 py-2 text-sm font-black ${draft.priceSize === "standard" ? "border-app-accent bg-app-accent text-white" : "border-app-border bg-app-surface text-app-text"}`}>Standard</button>
            </div>
            <label className="block space-y-1">
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">Footer</span>
              <input type="text" value={draft.footerText} onChange={(e) => updateDraft("footerText", e.target.value)} className="ui-input w-full" placeholder="Riverside Men's Shop" />
            </label>
          </div>
        </aside>
      </div>
    </section>
  );
}
