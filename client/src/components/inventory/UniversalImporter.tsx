import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  ShieldCheck,
  Table,
  Zap,
} from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";

type Step = "mode" | "upload" | "map" | "review";

type ImportMode = "lightspeed" | "manual" | null;

interface Category {
  id: string;
  name: string;
}

interface ImportSummaryResponse {
  products_created: number;
  products_updated: number;
  variants_synced: number;
  rows_skipped: number;
}

type ImportRunState = "idle" | "running" | "success" | "error";

const LIGHTSPEED_PRESET: Record<string, string> = {
  product_identity: "handle",
  sku: "sku",
  barcode: "barcode",
  product_name: "name",
  retail_price: "retail_price",
  // Unit cost in X-Series is `supply_price` (numeric). Not `supplier_code` (vendor/style code text).
  unit_cost: "supply_price",
  stock_on_hand: "stock_on_hand",
  brand: "brand_name",
  category: "product_category",
  supplier: "supplier_name",
  supplier_code: "supplier_code",
};

const REQUIRED_MAPPING_FIELDS = [
  "product_identity",
  "sku",
  "product_name",
  "retail_price",
  "unit_cost",
  "brand",
] as const;
const OPTIONAL_MAPPING_FIELDS = [
  "barcode",
  "stock_on_hand",
  "category",
  "supplier",
  "supplier_code",
] as const;
const MAPPING_FIELDS = [
  ...REQUIRED_MAPPING_FIELDS,
  ...OPTIONAL_MAPPING_FIELDS,
] as (keyof typeof LIGHTSPEED_PRESET)[];

/** Alternate header labels Lightspeed may use; primary name is always `LIGHTSPEED_PRESET[field]` first. */
const LIGHTSPEED_HEADER_ALIASES: Record<string, string[]> = {
  product_identity: ["product_handle", "style_handle", "item_handle"],
  sku: ["system_sku", "item_sku"],
  barcode: ["barcode", "upc", "ean", "scan_code"],
  product_name: ["product_name", "item_name", "description"],
  retail_price: ["price", "default_price", "sell_price"],
  unit_cost: ["cost", "cost_price", "default_cost"],
  stock_on_hand: [
    "on_hand",
    "quantity_on_hand",
    "current_quantity",
    "qoh",
    "Invenrory_Riverside_Men's_Shop",
    "Inventory_Riverside_Men's_Shop",
  ],
  brand: ["brand", "vendor_brand"],
  category: [
    "category",
    "Product Category",
    "item_category",
    "primary_category",
    "Category Name",
  ],
  supplier: [
    "Supplier",
    "supplier",
    "Supplier Name",
    "vendor",
    "Vendor",
    "primary_supplier",
    "Primary Supplier",
    "distributor",
  ],
  supplier_code: ["Vendor Code", "vendor_code", "supplier_sku"],
};

/**
 * Lightspeed Quick-Sync: map only by case-insensitive exact header name (plus one X-Series stock rule).
 * No substring fuzzy matching — avoids collisions (e.g. supply_price vs supplier).
 */
function matchLightspeedColumn(
  headers: string[],
  field: (typeof MAPPING_FIELDS)[number],
): string {
  const preset = LIGHTSPEED_PRESET[field];
  const extras = LIGHTSPEED_HEADER_ALIASES[field] ?? [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const c of [preset, ...extras]) {
    const k = c.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      candidates.push(c);
    }
  }
  const byLower = new Map<string, string>();
  for (const h of headers) {
    const k = h.toLowerCase();
    if (!byLower.has(k)) byLower.set(k, h);
  }
  for (const c of candidates) {
    const hit = byLower.get(c.toLowerCase());
    if (hit) return hit;
  }
  // X-Series per-outlet quantity column is always `inventory_<OutletName>` — not always named `stock_on_hand`.
  if (field === "stock_on_hand") {
    const inv = headers.find((h) => h.toLowerCase().startsWith("inventory_"));
    if (inv) return inv;
  }
  return "";
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(text: string): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]!).map((h) =>
    h.replace(/^\uFEFF/, "").trim(),
  );
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]!);
    if (vals.every((v) => v === "")) continue;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      row[h] = vals[j] ?? "";
    });
    rows.push(row);
  }
  return { headers, rows };
}

export default function UniversalImporter() {
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const { backofficeHeaders } = useBackofficeAuth();
  const [step, setStep] = useState<Step>("mode");
  const [mode, setMode] = useState<ImportMode>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(false);
  const [runState, setRunState] = useState<ImportRunState>("idle");
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    const res = await fetch(apiUrl(baseUrl, "/api/categories"), {
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (res.ok) {
      setCategories((await res.json()) as Category[]);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setSummary(null);
    setRunState("idle");
    setCompletedAt(null);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      const { headers: h, rows: r } = parseCsv(text);
      setHeaders(h);
      setRows(r);
      if (r.length === 0) {
        setError("No data rows found in CSV.");
        return;
      }
      if (mode === "lightspeed") {
        const detected: Record<string, string> = {};
        for (const key of MAPPING_FIELDS) {
          detected[key] = matchLightspeedColumn(h, key);
        }
        setMapping(detected);
        setStep("review");
      } else {
        setMapping({});
        setStep("map");
      }
    };
    reader.readAsText(file);
  };

  const categoryColumnMapped = (mapping.category ?? "").trim() !== "";
  const hasCategoryFallback = categoryId.trim() !== "";
  const categoryOk = categoryColumnMapped || hasCategoryFallback;

  const mappingReady =
    REQUIRED_MAPPING_FIELDS.every((f) => (mapping[f] ?? "").trim() !== "") &&
    categoryOk;

  const runImport = async () => {
    if (!mappingReady || rows.length === 0) return;
    setLoading(true);
    setRunState("running");
    setError(null);
    try {
      // Let React paint "Syncing…" before JSON.stringify — large CSVs can block the main thread for seconds.
      await new Promise<void>((r) => setTimeout(r, 0));
      const payload = {
        ...(categoryId.trim()
          ? { category_id: categoryId.trim() }
          : {}),
        rows,
        mapping,
      };
      const bodyJson = JSON.stringify(payload);
      if (import.meta.env.DEV) {
        console.info(
          `[ROS] catalog import: ${rows.length} rows, ~${(bodyJson.length / 1024).toFixed(1)} KiB JSON — upload may take a while`,
        );
      }
      const res = await fetch(apiUrl(baseUrl, "/api/products/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: bodyJson,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Import failed");
      }
      setSummary(body as ImportSummaryResponse);
      setRunState("success");
      setCompletedAt(new Date().toLocaleString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setRunState("error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl overflow-y-auto p-6 lg:p-12">
      {step === "mode" && (
        <div className="grid gap-8 md:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setMode("lightspeed");
              setStep("upload");
            }}
            className="group rounded-[2.5rem] border-2 border-app-border bg-app-surface p-10 text-left shadow-xl transition-all hover:border-app-accent-2"
          >
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-app-accent-2/15 text-app-accent-2 transition-colors group-hover:bg-app-accent-2 group-hover:text-white">
              <Zap size={28} />
            </div>
            <h3 className="mb-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
              Lightspeed Quick-Sync
            </h3>
            <p className="text-sm leading-relaxed text-app-text-muted">
              X-Series export preset: handle, variant axes,{" "}
              <strong className="text-app-text">supply_price</strong> as unit
              cost, SKU, product_category, supplier_name as primary vendor, and{" "}
              <strong className="text-app-text">supplier_code</strong> as vendor
              code in Riverside (not cost).
            </p>
          </button>

          <button
            type="button"
            onClick={() => {
              setMode("manual");
              setStep("upload");
            }}
            className="group rounded-[2.5rem] border-2 border-app-border bg-app-surface p-10 text-left shadow-xl transition-all hover:border-app-text"
          >
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-app-surface-2 text-app-text-muted transition-colors group-hover:bg-app-text group-hover:text-white">
              <Table size={28} />
            </div>
            <h3 className="mb-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
              Universal Mapper
            </h3>
            <p className="text-sm leading-relaxed text-app-text-muted">
              Map any vendor CSV columns to Riverside identity, SKU, pricing,
              and cost.
            </p>
          </button>
        </div>
      )}

      {step === "upload" && (
        <div className="animate-in fade-in duration-300">
          <button
            type="button"
            onClick={() => {
              setStep("mode");
              setMode(null);
              setHeaders([]);
              setRows([]);
            }}
            className="mb-4 text-xs font-bold uppercase tracking-widest text-app-text-muted hover:text-app-accent-2"
          >
            ← Back
          </button>
          <div className="group relative flex flex-col items-center justify-center rounded-[3rem] border-4 border-dashed border-app-border bg-app-surface p-16 transition-all hover:border-app-accent-2 lg:p-20">
            <input
              type="file"
              accept=".csv,text/csv"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={handleFile}
            />
            <FileSpreadsheet className="mb-6 text-app-border transition-colors group-hover:text-app-accent-2" size={64} />
            <h2 className="text-2xl font-black uppercase text-app-text">
              Upload {mode === "lightspeed" ? "Lightspeed" : "Vendor"} CSV
            </h2>
            <p className="mt-2 font-medium tracking-tight text-app-text-muted">
              {rows.length > 0
                ? `${rows.length} data rows · ${headers.length} columns detected`
                : "Drop or tap to choose a file"}
            </p>
          </div>
        </div>
      )}

      {step === "map" && mode === "manual" && (
        <div className="grid animate-in fade-in gap-8 duration-300 lg:grid-cols-2">
          <button
            type="button"
            onClick={() => setStep("upload")}
            className="col-span-full text-left text-xs font-bold uppercase tracking-widest text-app-text-muted hover:text-app-accent-2"
          >
            ← Back to upload
          </button>
          <div className="space-y-4">
            <h3 className="mb-6 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Field mapping worksheet
            </h3>
            {MAPPING_FIELDS.map((field) => (
              <div
                key={field}
                className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm"
              >
                <label className="mb-2 block text-xs font-black uppercase tracking-tight text-app-text">
                  {field.replace(/_/g, " ")}
                  {OPTIONAL_MAPPING_FIELDS.includes(
                    field as (typeof OPTIONAL_MAPPING_FIELDS)[number],
                  ) ? (
                    <span className="ml-1 text-app-text-muted">(optional)</span>
                  ) : null}
                </label>
                <select
                  value={mapping[field] ?? ""}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  className="w-full rounded-lg border border-app-border bg-app-surface-2 p-2 text-xs font-bold text-app-accent-2 outline-none focus:ring-2 focus:ring-app-accent-2"
                >
                  <option value="">— Select CSV column —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <div className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
              <label className="mb-2 block text-xs font-black uppercase tracking-tight text-app-text">
                Fallback Riverside category
              </label>
              <p className="mb-2 text-[11px] leading-relaxed text-app-text-muted">
                Required if you do not map a CSV <strong>category</strong> column. Otherwise optional (used when a cell is empty or does not match a Riverside category name).
              </p>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full rounded-lg border border-app-border bg-app-surface-2 p-2 text-xs font-bold text-app-text outline-none focus:ring-2 focus:ring-app-accent-2"
              >
                <option value="">— None (category column only) —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              disabled={!mappingReady}
              onClick={() => setStep("review")}
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-app-accent py-4 text-xs font-black uppercase tracking-widest text-white disabled:opacity-40"
            >
              Proceed to review <ArrowRight size={16} />
            </button>
          </div>

          <div className="flex flex-col justify-center rounded-[2.5rem] border border-app-border bg-app-surface-2 p-10">
            <div className="mb-4 flex items-center gap-2 font-black uppercase tracking-widest text-app-accent-2 text-[10px]">
              <ShieldCheck size={16} /> Mapping intelligence
            </div>
            <p className="text-sm leading-relaxed text-app-text-muted">
              Map <strong className="text-app-text">product identity</strong>{" "}
              to the column that groups variants (Lightspeed{" "}
              <strong className="text-app-text">handle</strong>, or a style
              number). Map <strong className="text-app-text">category</strong>{" "}
              to match each row to a Riverside category by name, or use fallback
              only. SKUs become variants; category drives NYS clothing exemption
              at POS.
            </p>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="animate-in zoom-in rounded-[2rem] bg-app-text p-8 text-white shadow-2xl duration-300 lg:rounded-[3rem] lg:p-12">
          <button
            type="button"
            onClick={() =>
              setStep(mode === "lightspeed" ? "upload" : "map")
            }
            className="mb-6 text-left text-[10px] font-bold uppercase tracking-widest text-app-text-muted hover:text-white"
          >
            ← Back
          </button>

          <div className="mb-10 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-3xl font-black uppercase italic tracking-tighter">
                Review import
              </h2>
              <p className="font-medium text-app-text-muted">
                {rows.length} rows · {headers.length} columns ·{" "}
                {mode === "lightspeed" ? "Lightspeed preset" : "Manual map"}
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/50 bg-emerald-500/20 px-4 py-2 font-black uppercase tracking-widest text-emerald-400 text-[10px]">
              <CheckCircle2 size={14} /> Idempotent SKU sync
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {runState === "success" && summary ? (
            <div className="mb-6 rounded-2xl border border-emerald-400/50 bg-emerald-500/15 px-4 py-3">
              <p className="text-sm font-black uppercase tracking-widest text-emerald-200">
                Import complete
              </p>
              <p className="mt-1 text-xs text-emerald-100">
                Finished successfully{completedAt ? ` at ${completedAt}` : ""}. Catalog is updated and ready.
              </p>
            </div>
          ) : null}

          {summary && (
            <div className="mb-6 grid gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 sm:grid-cols-2">
              <p className="text-sm">
                <span className="font-bold text-app-text-muted">Products created </span>
                <span className="font-black text-emerald-400">{summary.products_created}</span>
              </p>
              <p className="text-sm">
                <span className="font-bold text-app-text-muted">Products updated </span>
                <span className="font-black text-app-accent-2">{summary.products_updated}</span>
              </p>
              <p className="text-sm">
                <span className="font-bold text-app-text-muted">Variants synced </span>
                <span className="font-black text-white">{summary.variants_synced}</span>
              </p>
              <p className="text-sm">
                <span className="font-bold text-app-text-muted">Rows skipped </span>
                <span className="font-black text-amber-300">{summary.rows_skipped}</span>
              </p>
            </div>
          )}

          <div className="mb-10 grid gap-6 lg:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <p className="mb-1 font-bold uppercase tracking-widest text-app-text-muted text-[10px]">
                Mapping
              </p>
              {mode === "lightspeed" ? (
                <p className="mt-2 text-sm font-semibold text-emerald-200">
                  Fixed Lightspeed mapping is active.
                </p>
              ) : null}
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-app-accent-2">
                {Object.entries(mapping).map(([k, v]) => (
                  <li key={k}>
                    {k}: {v}
                  </li>
                ))}
              </ul>
              {!mapping.stock_on_hand ? (
                <p className="mt-3 text-[11px] font-semibold text-amber-300">
                  Warning: stock column not detected. Map `stock_on_hand` manually if present.
                </p>
              ) : null}
              {!mapping.supplier ? (
                <p className="mt-3 text-[11px] font-semibold text-amber-300">
                  Warning: supplier column not detected. Map `supplier` to set primary vendor, or add it on the manual map.
                </p>
              ) : null}
              {!mapping.supplier_code ? (
                <p className="mt-3 text-[11px] font-semibold text-amber-300">
                  Optional: map `supplier_code` to store Lightspeed supplier code on the vendor record.
                </p>
              ) : null}
              {!categoryColumnMapped && !hasCategoryFallback ? (
                <p className="mt-3 text-[11px] font-semibold text-red-300">
                  Map a category CSV column or choose a fallback category before committing.
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
              <p className="mb-1 font-bold uppercase tracking-widest text-app-text-muted text-[10px]">
                Fallback category (optional)
              </p>
              <p className="mb-2 text-[11px] text-app-text-muted">
                Used for empty cells or when the CSV name does not match a Riverside category.
              </p>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="mt-2 w-full bg-transparent text-sm font-black text-white outline-none"
              >
                <option value="" className="text-app-text">
                  None
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id} className="text-app-text">
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {rows.length >= 2000 ? (
            <p className="mb-3 text-center text-[11px] font-semibold text-amber-200/90">
              Large file: import runs as one database transaction and can take several minutes. The
              API terminal logs start and finish for this request when the server receives it.
            </p>
          ) : null}
          <button
            type="button"
            disabled={loading || !mappingReady || rows.length === 0}
            onClick={() => void runImport()}
            className="w-full rounded-[1.5rem] bg-app-accent py-6 text-lg font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/30 transition-all hover:opacity-90 active:scale-[0.99] disabled:opacity-40"
          >
            {loading
              ? `Syncing… (${rows.length.toLocaleString()} rows)`
              : runState === "success"
                ? "Import complete"
                : "Commit inventory to catalog"}
          </button>
        </div>
      )}
    </div>
  );
}
