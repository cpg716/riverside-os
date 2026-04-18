import { useState } from "react";
import { Printer } from "lucide-react";
import {
  getInventoryTagPrintConfig,
  openInventoryTagsWindow,
  saveInventoryTagPrintConfig,
  type InventoryTagPrintConfig,
} from "../inventory/labelPrint";

export default function TagDesignerPanel() {
  const [inventoryTagConfig, setInventoryTagConfig] = useState<InventoryTagPrintConfig>(
    getInventoryTagPrintConfig(),
  );
  const [saved, setSaved] = useState(false);

  const persistInventoryTagConfig = (next: Partial<InventoryTagPrintConfig>) => {
    const updated = saveInventoryTagPrintConfig({
      ...inventoryTagConfig,
      ...next,
    });
    setInventoryTagConfig(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-12">
      <header className="mb-10">
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
          Tag Designer
        </h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">
          Configure physical inventory labels for thermal transfer and jewelry tag printers.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
        <div className="xl:col-span-12">
          <section className="ui-card p-8 border-l-4 border-emerald-600">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
              <div className="flex items-center gap-4">
                <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-600">
                  <Printer size={24} />
                </div>
                <div>
                  <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">
                    Inventory Tag Layout
                  </h3>
                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">
                    Zebra LP 2844 / GX Series compat
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {saved && (
                  <span className="text-[10px] text-emerald-500 font-black uppercase tracking-widest animate-in fade-in zoom-in duration-300">
                    Layout Saved
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    openInventoryTagsWindow([
                      {
                        sku: "SUIT-42R-NAVY",
                        productName: "Peak Lapel Dinner Jacket",
                        variation: "Navy / 42R",
                        brand: "Riverside Formal",
                        price: "$299.00",
                      },
                    ])
                  }
                  className="rounded-xl border border-app-border bg-app-surface px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent"
                >
                  Test Print Sample Tag
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Width (inches)
                    </span>
                    <input
                      type="number"
                      min="2"
                      max="6"
                      step="0.1"
                      value={inventoryTagConfig.widthInches}
                      onChange={(e) =>
                        persistInventoryTagConfig({
                          widthInches: Number.parseFloat(e.target.value) || 4,
                        })
                      }
                      className="ui-input mt-2 w-full font-black"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Height (inches)
                    </span>
                    <input
                      type="number"
                      min="1.25"
                      max="4"
                      step="0.05"
                      value={inventoryTagConfig.heightInches}
                      onChange={(e) =>
                        persistInventoryTagConfig({
                          heightInches:
                            Number.parseFloat(e.target.value) || 2.5,
                        })
                      }
                      className="ui-input mt-2 w-full font-black"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Footer Copy
                  </span>
                  <input
                    value={inventoryTagConfig.footerText}
                    onChange={(e) =>
                      persistInventoryTagConfig({
                        footerText: e.target.value,
                      })
                    }
                    className="ui-input mt-2 w-full font-black"
                    placeholder="Riverside OS Inventory Tag"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Visual Style
                  </span>
                  <select
                    value={inventoryTagConfig.accentStyle}
                    onChange={(e) =>
                      persistInventoryTagConfig({
                        accentStyle: e.target.value as InventoryTagPrintConfig["accentStyle"],
                      })
                    }
                    className="ui-input mt-2 w-full font-black"
                  >
                    <option value="bold">Bold retail</option>
                    <option value="classic">Classic thermal</option>
                    <option value="minimal">Minimal</option>
                  </select>
                </label>

                <div className="grid grid-cols-2 gap-3">
                  {[
                    ["showSku", "Show SKU"],
                    ["showProductName", "Show Title"],
                    ["showVariation", "Show Variation"],
                    ["showBrand", "Show Vendor/Brand"],
                    ["showPrice", "Show Price"],
                  ].map(([key, label]) => (
                    <label
                      key={key}
                      className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface/50 px-4 py-3 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(
                          inventoryTagConfig[
                            key as keyof InventoryTagPrintConfig
                          ],
                        )}
                        onChange={(e) =>
                          persistInventoryTagConfig({
                            [key]: e.target.checked,
                          } as Partial<InventoryTagPrintConfig>)
                        }
                      />
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
                        {label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="rounded-[2rem] border border-app-border/60 bg-app-bg/30 p-5">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Live Preview
                </p>
                <div className="mt-4 rounded-[1.5rem] border border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-emerald-100 p-5 shadow-inner">
                  <div className="flex min-h-[12rem] overflow-hidden rounded-[1.25rem] border border-emerald-200 bg-white shadow-xl">
                    <div className="w-6 shrink-0 bg-gradient-to-b from-emerald-700 via-emerald-500 to-emerald-300" />
                    <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                      {inventoryTagConfig.showSku ? (
                        <span className="inline-flex w-fit rounded-full bg-slate-900 px-3 py-1 text-[11px] font-black uppercase tracking-[0.18em] text-white font-mono">
                          SUIT-42R-NAVY
                        </span>
                      ) : null}
                      {inventoryTagConfig.showProductName ? (
                        <p className="text-2xl font-black tracking-tight text-slate-900 leading-none">
                          Peak Lapel Dinner Jacket
                        </p>
                      ) : null}
                      {inventoryTagConfig.showVariation ? (
                        <p className="text-sm font-bold text-slate-600">
                          Navy / 42R
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {inventoryTagConfig.showBrand ? (
                          <span className="rounded-full border border-slate-200 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-slate-600">
                            Riverside Formal
                          </span>
                        ) : null}
                        {inventoryTagConfig.showPrice ? (
                          <span className="rounded-full border border-slate-200 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-slate-600">
                            $299.00
                          </span>
                        ) : null}
                      </div>
                      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                        {inventoryTagConfig.footerText}
                      </p>
                    </div>
                  </div>
                  <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.18em] text-app-text-muted text-center">
                    Sized for the Zebra LP 2844 system print workflow.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
