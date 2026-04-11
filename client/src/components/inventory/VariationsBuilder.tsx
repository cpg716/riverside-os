import { useMemo, useState } from "react";
import { 
  Settings2, 
  Trash2, 
  Plus, 
  Hash, 
  Box, 
  Zap
} from "lucide-react";

export interface AxisInput {
  name: string;
  optionsRaw: string;
}

export interface GeneratedVariationRow {
  variation_values: Record<string, string>;
  variation_label: string;
  sku: string;
  stock_on_hand: number;
  retail_price_override?: string;
  cost_override?: string;
}

interface VariationsBuilderProps {
  onGenerated: (rows: GeneratedVariationRow[], axes: string[]) => void;
}

function cartesian(input: Record<string, string[]>): Record<string, string>[] {
  const entries = Object.entries(input);
  if (entries.length === 0) return [];
  let acc: Record<string, string>[] = [{}];
  for (const [axis, options] of entries) {
    const next: Record<string, string>[] = [];
    for (const row of acc) {
      for (const option of options) {
        next.push({ ...row, [axis]: option });
      }
    }
    acc = next;
  }
  return acc;
}

export default function VariationsBuilder({ onGenerated }: VariationsBuilderProps) {
  const [axes, setAxes] = useState<AxisInput[]>([
    { name: "Model", optionsRaw: "Slim, Classic" },
    { name: "Color", optionsRaw: "Navy, Charcoal" },
    { name: "Size", optionsRaw: "38R, 40R, 42R" },
  ]);
  const [skuPrefix, setSkuPrefix] = useState("SKU");
  const [defaultStock, setDefaultStock] = useState(0);

  const parsed = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const axis of axes) {
      const name = axis.name.trim();
      if (!name) continue;
      const options = axis.optionsRaw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (options.length > 0) out[name] = options;
    }
    return out;
  }, [axes]);

  const combos = useMemo(() => cartesian(parsed), [parsed]);

  const handleGenerate = () => {
    const axisNames = Object.keys(parsed);
    const rows: GeneratedVariationRow[] = combos.map((row, idx) => {
      const values = axisNames.map((k) => row[k]);
      return {
        variation_values: row,
        variation_label: values.join(" / "),
        sku: `${skuPrefix}-${idx + 1}`.toUpperCase(),
        stock_on_hand: defaultStock,
      };
    });
    onGenerated(rows, axisNames);
  };

  const addAxis = () => {
    if (axes.length >= 5) return;
    setAxes([...axes, { name: "", optionsRaw: "" }]);
  };

  const removeAxis = (idx: number) => {
    setAxes(prev => prev.filter((_, i) => i !== idx));
  };

  return (
    <section className="rounded-[2.5rem] border border-app-border bg-app-surface p-8 shadow-sm">
      <div className="mb-6 flex items-center justify-between">
         <div>
           <h2 className="text-2xl font-black italic tracking-tighter text-app-text uppercase">Matrix Constructor</h2>
           <p className="text-xs font-bold text-app-text-muted mt-1 uppercase tracking-widest">Define axes and attributes for combinatorial SKU generation</p>
         </div>
         <div className="h-12 w-12 rounded-2xl bg-app-accent-2/10 flex items-center justify-center text-app-accent-2">
            <Settings2 size={24} />
         </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {axes.map((axis, idx) => (
          <div key={idx} className="group relative rounded-3xl border border-app-border bg-app-surface-2 p-5 transition-all hover:border-app-accent-2/40 hover:shadow-xl">
            <div className="flex items-center justify-between mb-3">
               <div className="flex items-center gap-2">
                  <div className="h-6 w-6 rounded-lg bg-app-surface border border-app-border flex items-center justify-center text-[10px] font-black italic">
                    {idx + 1}
                  </div>
                  <input
                    value={axis.name}
                    onChange={(e) =>
                        setAxes((prev) =>
                        prev.map((a, i) => (i === idx ? { ...a, name: e.target.value } : a)),
                        )
                    }
                    className="bg-transparent text-xs font-black uppercase tracking-widest text-app-text outline-none placeholder:text-app-text-muted/30 w-full"
                    placeholder={`e.g. Fit Type`}
                  />
               </div>
               <button 
                 onClick={() => removeAxis(idx)}
                 className="p-1.5 rounded-lg text-app-text-muted hover:bg-red-50 hover:text-red-600 transition-all opacity-0 group-hover:opacity-100"
               >
                 <Trash2 size={14} />
               </button>
            </div>
            
            <textarea
              value={axis.optionsRaw}
              onChange={(e) =>
                setAxes((prev) =>
                  prev.map((a, i) =>
                    i === idx ? { ...a, optionsRaw: e.target.value } : a,
                  ),
                )
              }
              className="ui-input h-24 w-full py-3 text-xs font-bold resize-none leading-relaxed"
              placeholder="Separate options with commas (e.g. Slim, Modern, Regular)"
            />
          </div>
        ))}
        
        {axes.length < 5 && (
            <button
                type="button"
                onClick={addAxis}
                className="flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-app-border bg-app-surface-2/40 py-8 text-app-text-muted hover:border-app-accent-2 hover:bg-app-accent-2/5 hover:text-app-accent-2 transition-all group"
            >
                <Plus size={24} className="mb-2 group-hover:scale-110 transition-transform" />
                <span className="text-[10px] font-black uppercase tracking-widest">Add Attribute Axis</span>
            </button>
        )}
      </div>

      <div className="mt-8 pt-8 border-t border-app-border flex flex-wrap items-center justify-between gap-6">
        <div className="flex flex-wrap items-center gap-6">
            <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-1">
                    <Hash size={10} /> SKU Template Prefix
                </label>
                <input
                    value={skuPrefix}
                    onChange={(e) => setSkuPrefix(e.target.value)}
                    className="ui-input h-12 w-48 text-sm font-black uppercase"
                />
            </div>
            <div className="space-y-1.5">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-1">
                    <Box size={10} /> Initial SOH (Standard)
                </label>
                <input
                    type="number"
                    value={defaultStock}
                    onChange={(e) => setDefaultStock(Number.parseInt(e.target.value || "0", 10))}
                    className="ui-input h-12 w-32 text-sm font-black tabular-nums"
                />
            </div>
        </div>

        <div className="flex items-center gap-4">
            <div className="text-right">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Projections</p>
                <p className="text-lg font-black text-app-text leading-tight italic">
                   {combos.length === 0 ? "0 Variants" : `${combos.length} Discrete SKUs`}
                </p>
            </div>
            <button
                type="button"
                disabled={combos.length === 0}
                onClick={handleGenerate}
                className="h-14 px-10 rounded-2xl bg-app-accent text-white text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-app-accent/20 hover:brightness-110 active:scale-95 transition-all disabled:opacity-20 flex items-center gap-2 group"
            >
                <Zap size={16} className="group-hover:animate-pulse" />
                Materialize Matrix
            </button>
        </div>
      </div>
    </section>
  );
}
