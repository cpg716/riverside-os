import { useMemo, useState } from "react";
import {
  Eye,
  LayoutTemplate,
  RotateCcw,
  Save,
  Tag,
} from "lucide-react";
import {
  type InventoryTagItem,
  type InventoryTagPrintConfig,
  getInventoryTagPrintConfig,
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
  },
  {
    sku: "SHOE-220-BLK-11",
    productName: "Cap Toe Oxford",
    variation: "Black / 11",
    brand: "Riverside Formal",
    price: "$119.00",
  },
];

const ACCENT_OPTIONS: Array<{
  value: InventoryTagPrintConfig["accentStyle"];
  label: string;
  description: string;
}> = [
  {
    value: "bold",
    label: "Bold",
    description: "Emerald-forward for strong floor visibility.",
  },
  {
    value: "classic",
    label: "Classic",
    description: "Dark stripe with a more traditional retail feel.",
  },
  {
    value: "minimal",
    label: "Minimal",
    description: "Quiet monochrome treatment for low-noise tagging.",
  },
];

function getAccentTokens(style: InventoryTagPrintConfig["accentStyle"]) {
  switch (style) {
    case "classic":
      return {
        shell: "border-slate-900/15 bg-white",
        stripe: "bg-gradient-to-br from-slate-900 via-slate-700 to-slate-500",
        chip: "border-cyan-200 bg-cyan-50 text-cyan-900",
        meta: "border-slate-200 bg-white/90 text-slate-700",
      };
    case "minimal":
      return {
        shell: "border-zinc-200 bg-white",
        stripe: "bg-zinc-200",
        chip: "border-zinc-200 bg-zinc-100 text-zinc-900",
        meta: "border-zinc-200 bg-zinc-50 text-zinc-700",
      };
    case "bold":
    default:
      return {
        shell: "border-emerald-200 bg-[radial-gradient(circle_at_top_left,_rgba(236,253,245,1)_0%,_rgba(255,255,255,1)_60%,_rgba(240,253,244,1)_100%)]",
        stripe: "bg-gradient-to-br from-emerald-900 via-emerald-600 to-emerald-300",
        chip: "border-emerald-950 bg-emerald-950 text-emerald-50",
        meta: "border-emerald-100 bg-white/90 text-emerald-900",
      };
  }
}

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
    footerText: config.footerText.trim() || "Riverside OS Inventory Tag",
  };
}

function parseDimensionInput(
  value: string,
  fallback: number,
): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function TagDesignerPanel() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<InventoryTagPrintConfig>(() =>
    getInventoryTagPrintConfig(),
  );

  const normalizedDraft = useMemo(() => normalizeConfig(draft), [draft]);
  const savedConfig = useMemo(() => getInventoryTagPrintConfig(), []);
  const [baselineConfig, setBaselineConfig] = useState<InventoryTagPrintConfig>(
    savedConfig,
  );

  const hasChanges =
    JSON.stringify(normalizedDraft) !== JSON.stringify(baselineConfig);

  const updateDraft = <K extends keyof InventoryTagPrintConfig>(
    key: K,
    value: InventoryTagPrintConfig[K],
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    const next = saveInventoryTagPrintConfig(draft);
    setDraft(next);
    setBaselineConfig(next);
    toast("Tag designer settings saved.", "success");
  };

  const handleReset = () => {
    const reset = getInventoryTagPrintConfig();
    setDraft(reset);
    setBaselineConfig(reset);
    toast("Tag designer restored to saved settings.", "info");
  };

  const handlePreview = () => {
    openInventoryTagsWindow(SAMPLE_ITEMS, normalizedDraft);
    toast("Opened a live tag preview in a new window.", "success");
  };

  const previewAccent = getAccentTokens(normalizedDraft.accentStyle);

  return (
    <section className="space-y-6 p-6">
      <header className="space-y-3">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-emerald-900">
          <Tag size={14} />
          Tag designer
        </div>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl space-y-2">
            <h2 className="text-3xl font-black uppercase tracking-tight text-app-text">
              Inventory tag layouts
            </h2>
            <p className="text-sm font-medium text-app-text-muted">
              These settings drive the retail price-tag output used by inventory
              print actions. Configure the live tag format here once so floor
              teams get the same result everywhere.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePreview}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition-colors hover:border-app-input-border hover:bg-app-surface-2"
            >
              <Eye size={16} />
              Preview tags
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-2 text-sm font-bold text-app-text transition-colors hover:border-app-input-border hover:bg-app-surface-2"
            >
              <RotateCcw size={16} />
              Revert
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="inline-flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-sm font-black text-white shadow-sm transition-colors hover:brightness-110"
            >
              <Save size={16} />
              Save settings
            </button>
          </div>
        </div>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-app-text-muted">
          {hasChanges
            ? "Unsaved changes are ready to apply to future inventory tag prints."
            : "Saved settings are active for inventory tag prints."}
        </p>
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div className="space-y-6">
          <section className="ui-card space-y-5 p-5">
            <div className="flex items-center gap-2">
              <LayoutTemplate size={18} className="text-app-accent" />
              <div>
                <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">
                  Layout basics
                </h3>
                <p className="text-sm text-app-text-muted">
                  Control physical tag size and the information that prints on
                  every label.
                </p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">
                  Width (inches)
                </span>
                <input
                  type="number"
                  min="2"
                  max="6"
                  step="0.25"
                  value={draft.widthInches}
                  onChange={(e) =>
                    updateDraft(
                      "widthInches",
                      parseDimensionInput(e.target.value, draft.widthInches),
                    )
                  }
                  className="ui-input w-full"
                />
              </label>
              <label className="space-y-2">
                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">
                  Height (inches)
                </span>
                <input
                  type="number"
                  min="1.25"
                  max="4"
                  step="0.25"
                  value={draft.heightInches}
                  onChange={(e) =>
                    updateDraft(
                      "heightInches",
                      parseDimensionInput(e.target.value, draft.heightInches),
                    )
                  }
                  className="ui-input w-full"
                />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  ["showSku", "Show SKU"],
                  ["showProductName", "Show product name"],
                  ["showVariation", "Show variation"],
                  ["showBrand", "Show brand"],
                  ["showPrice", "Show price"],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center justify-between rounded-2xl border border-app-border bg-app-surface p-4"
                >
                  <div>
                    <p className="text-sm font-bold text-app-text">{label}</p>
                    <p className="text-xs text-app-text-muted">
                      {key === "showSku"
                        ? "Helpful for quick rack identification."
                        : key === "showProductName"
                          ? "Primary line for the product title."
                          : key === "showVariation"
                            ? "Color, size, or fit details."
                            : key === "showBrand"
                              ? "Optional vendor or collection stamp."
                              : "Retail ticket price on the tag."}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft[key]}
                    onChange={(e) => updateDraft(key, e.target.checked)}
                    className="h-4 w-4 rounded border-app-input-border text-app-accent"
                  />
                </label>
              ))}
            </div>

            <label className="space-y-2">
              <span className="text-[11px] font-black uppercase tracking-[0.14em] text-app-text-muted">
                Footer text
              </span>
              <input
                type="text"
                value={draft.footerText}
                onChange={(e) => updateDraft("footerText", e.target.value)}
                className="ui-input w-full"
                placeholder="Riverside OS Inventory Tag"
              />
            </label>
          </section>

          <section className="ui-card space-y-4 p-5">
            <div>
              <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">
                Visual treatment
              </h3>
              <p className="mt-1 text-sm text-app-text-muted">
                Pick the accent style that best matches your current shop-floor
                printing aesthetic.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {ACCENT_OPTIONS.map((option) => {
                const active = draft.accentStyle === option.value;
                const accent = getAccentTokens(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateDraft("accentStyle", option.value)}
                    className={`rounded-2xl border p-4 text-left transition-all ${
                      active
                        ? "border-app-accent bg-app-surface-2 shadow-sm"
                        : "border-app-border bg-app-surface hover:border-app-input-border"
                    }`}
                  >
                    <div
                      className={`mb-3 flex h-24 overflow-hidden rounded-xl border ${accent.shell}`}
                    >
                      <div className={`w-5 ${accent.stripe}`} />
                      <div className="flex flex-1 flex-col gap-2 p-3">
                        <div
                          className={`w-fit rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-[0.14em] ${accent.chip}`}
                        >
                          SKU
                        </div>
                        <div className="h-3 rounded bg-black/10" />
                        <div className="h-2 w-2/3 rounded bg-black/10" />
                        <div className="mt-auto h-2 w-1/2 rounded bg-black/10" />
                      </div>
                    </div>
                    <p className="text-sm font-bold text-app-text">
                      {option.label}
                    </p>
                    <p className="mt-1 text-xs text-app-text-muted">
                      {option.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="ui-card sticky top-6 space-y-5 p-5">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.16em] text-app-text">
              Live preview
            </h3>
            <p className="mt-1 text-sm text-app-text-muted">
              This mirrors the current settings that Inventory bulk-print uses.
            </p>
          </div>

          <div className="rounded-3xl border border-app-border bg-app-surface p-4 shadow-[0_18px_40px_-28px_rgba(20,20,20,0.35)]">
            <div className="grid gap-4">
              {SAMPLE_ITEMS.map((item) => (
                <div
                  key={item.sku}
                  className={`flex min-h-[210px] overflow-hidden rounded-[26px] border ${previewAccent.shell}`}
                >
                  <div className={`w-8 shrink-0 ${previewAccent.stripe}`} />
                  <div className="flex flex-1 flex-col gap-3 p-4">
                    {normalizedDraft.showSku ? (
                      <div
                        className={`w-fit rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.14em] ${previewAccent.chip}`}
                      >
                        {item.sku}
                      </div>
                    ) : null}
                    {normalizedDraft.showProductName ? (
                      <div className="text-[22px] font-black leading-[1.02] tracking-[-0.03em] text-slate-900">
                        {item.productName}
                      </div>
                    ) : null}
                    {normalizedDraft.showVariation ? (
                      <div className="text-sm font-bold text-slate-600">
                        {item.variation}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      {normalizedDraft.showBrand && item.brand ? (
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${previewAccent.meta}`}
                        >
                          {item.brand}
                        </span>
                      ) : null}
                      {normalizedDraft.showPrice && item.price ? (
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${previewAccent.meta}`}
                        >
                          {item.price}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-auto text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                      {normalizedDraft.footerText}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-sm text-app-text-muted">
            <p className="font-bold text-app-text">How this is applied</p>
            <p className="mt-2">
              Inventory list and control-board tag printing already read this
              shared configuration. Saving here updates the live tag layout
              without changing receipt printing or printer hardware setup.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
