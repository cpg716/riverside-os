import { useMemo, useState } from "react";

export interface AxisInput {
  name: string;
  optionsRaw: string;
}

export interface GeneratedMatrixRow {
  variation_values: Record<string, string>;
  variation_label: string;
  sku: string;
  stock_on_hand: number;
  retail_price_override?: string;
  cost_override?: string;
}

interface MatrixBuilderProps {
  onGenerated: (rows: GeneratedMatrixRow[], axes: string[]) => void;
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

export default function MatrixBuilder({ onGenerated }: MatrixBuilderProps) {
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
    const rows: GeneratedMatrixRow[] = combos.map((row, idx) => {
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

  return (
    <section className="rounded-xl border border-app-border bg-app-surface p-4">
      <h3 className="mb-3 text-sm font-black uppercase tracking-wider text-app-text">
        Variation Matrix Builder
      </h3>
      <div className="grid gap-3 md:grid-cols-3">
        {axes.map((axis, idx) => (
          <div key={idx} className="rounded-lg border border-app-border p-3">
            <input
              value={axis.name}
              onChange={(e) =>
                setAxes((prev) =>
                  prev.map((a, i) => (i === idx ? { ...a, name: e.target.value } : a)),
                )
              }
              className="ui-input mb-2 w-full py-1 text-sm"
              placeholder={`Axis ${idx + 1}`}
            />
            <textarea
              value={axis.optionsRaw}
              onChange={(e) =>
                setAxes((prev) =>
                  prev.map((a, i) =>
                    i === idx ? { ...a, optionsRaw: e.target.value } : a,
                  ),
                )
              }
              className="ui-input h-16 w-full py-1 text-sm"
              placeholder="Option1, Option2"
            />
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <input
          value={skuPrefix}
          onChange={(e) => setSkuPrefix(e.target.value)}
          className="ui-input py-2 text-sm"
          placeholder="SKU Prefix"
        />
        <input
          type="number"
          value={defaultStock}
          onChange={(e) => setDefaultStock(Number.parseInt(e.target.value || "0", 10))}
          className="ui-input py-2 text-sm"
          placeholder="Default Stock"
        />
        <button
          type="button"
          onClick={handleGenerate}
          className="ui-btn-primary text-sm normal-case tracking-normal font-bold"
        >
          Generate {combos.length} Variants
        </button>
      </div>
    </section>
  );
}
