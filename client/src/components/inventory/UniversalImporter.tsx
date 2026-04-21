import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  ShieldCheck,
  Table,
  Loader2,
} from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import DashboardGridCard from "../ui/DashboardGridCard";

type Step = "mode" | "upload" | "map" | "review";

type ImportMode = "catalog_csv" | null;

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
  "category",
  "supplier",
  "supplier_code",
] as const;
const MAPPING_FIELDS = [
  ...REQUIRED_MAPPING_FIELDS,
  ...OPTIONAL_MAPPING_FIELDS,
] as string[];

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
  const baseUrl = getBaseUrl();
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
      setMapping({});
      setStep("map");
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
    <div className="mx-auto max-w-5xl overflow-y-auto px-6 py-12 lg:px-12 no-scrollbar animate-in fade-in slide-in-from-bottom-8 duration-700">
      <div className="mb-12 px-4">
        <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Data Ingestion Engine</h3>
        <h2 className="text-3xl font-black tracking-tight text-app-text">Catalog CSV Mapper</h2>
      </div>
      {step === "mode" && (
        <div className="grid gap-8 md:grid-cols-2">
          <button
            type="button"
            onClick={() => {
              setMode("catalog_csv");
              setStep("upload");
            }}
            className="group relative overflow-hidden rounded-[3rem] border border-app-border/40 bg-app-surface/20 p-12 text-left shadow-2xl transition-all hover:border-app-accent-2/60 hover:bg-app-accent-2/5 backdrop-blur-md"
          >
            <div className="relative z-10">
              <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-[24px] bg-app-accent-2/10 text-app-accent-2 transition-all group-hover:scale-110 group-hover:bg-app-accent-2 group-hover:text-white group-hover:shadow-lg group-hover:shadow-app-accent-2/20">
                <Table size={32} />
              </div>
              <h3 className="mb-3 text-2xl font-black uppercase italic tracking-tighter text-app-text">
                Catalog CSV
              </h3>
              <p className="text-sm leading-relaxed text-app-text-muted opacity-80">
                Map vendor catalog files into products, variants, categories, and vendor links without touching live on-hand stock.
              </p>
            </div>
            <div className="absolute -bottom-12 -right-12 h-48 w-48 rounded-full bg-app-accent-2/5 blur-3xl transition-all group-hover:bg-app-accent-2/10" />
          </button>

          <div className="group relative overflow-hidden rounded-[3rem] border border-app-border/40 bg-app-surface/20 p-12 text-left shadow-2xl backdrop-blur-md">
            <div className="relative z-10">
              <div className="mb-8 flex h-16 w-16 items-center justify-center rounded-[24px] bg-app-surface shadow-inner text-app-text-muted transition-all group-hover:scale-110 group-hover:bg-app-text group-hover:text-white group-hover:shadow-lg group-hover:shadow-black/20">
                <ShieldCheck size={32} />
              </div>
              <h3 className="mb-3 text-2xl font-black uppercase italic tracking-tighter text-app-text">
                Counterpoint Sync
              </h3>
              <p className="text-sm leading-relaxed text-app-text-muted opacity-80">
                Pre-launch inventory quantities now belong to Counterpoint sync. Use this CSV mapper for catalog structure only, then let Counterpoint stage authoritative stock.
              </p>
              <div className="mt-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-5">
                <p className="text-[11px] font-bold text-emerald-700">
                  Live on-hand is protected here by design. Use Settings → Counterpoint for initial inventory load.
                </p>
              </div>
            </div>
            <div className="absolute -bottom-12 -right-12 h-48 w-48 rounded-full bg-app-text/5 blur-3xl transition-all group-hover:bg-app-text/10" />
          </div>
        </div>
      )}

      {step === "upload" && (
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <button
            type="button"
            onClick={() => {
              setStep("mode");
              setMode(null);
              setHeaders([]);
              setRows([]);
            }}
            className="mb-6 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-accent transition-colors"
          >
            <ArrowRight size={14} className="rotate-180" /> Back to engine select
          </button>
          <div className="group relative flex flex-col items-center justify-center rounded-[4rem] border-4 border-dashed border-app-border/40 bg-app-surface/20 p-20 transition-all hover:border-app-accent-2/60 hover:bg-app-accent-2/5 backdrop-blur-md">
            <input
              type="file"
              accept=".csv,text/csv"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={handleFile}
            />
            <div className="mb-8 flex h-24 w-24 items-center justify-center rounded-[32px] bg-app-surface shadow-xl border border-app-border transition-all group-hover:scale-110 group-hover:border-app-accent-2/40">
              <FileSpreadsheet className="text-app-text-muted group-hover:text-app-accent-2 transition-colors" size={48} />
            </div>
            <h2 className="text-3xl font-black uppercase italic tracking-tighter text-app-text">
              Target Manifest
            </h2>
              <p className="mt-3 text-sm font-bold tracking-tight text-app-text-muted">
              {rows.length > 0
                ? `${rows.length.toLocaleString()} rows detected · Ready for logic mapping`
                : `Choose the vendor or source file`}
            </p>
          </div>
        </div>
      )}

      {step === "map" && mode === "catalog_csv" && (
        <div className="grid animate-in fade-in gap-8 duration-500 lg:grid-cols-2">
           <button
             type="button"
             onClick={() => setStep("upload")}
             className="col-span-full flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-accent-2 transition-colors"
           >
             <ArrowRight size={14} className="rotate-180" /> Back to Upload
           </button>
          
           <DashboardGridCard 
             title="Attribute Mapping"
             subtitle="Bind CSV headers to Riverside logic"
             icon={Table}
           >
            <div className="space-y-4">
              {MAPPING_FIELDS.map((field) => (
                <div
                  key={field}
                  className="rounded-2xl border border-app-border bg-app-surface/40 p-5 shadow-inner"
                >
                  <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text opacity-60">
                    {field.replace(/_/g, " ")}
                    {OPTIONAL_MAPPING_FIELDS.includes(
                      field as (typeof OPTIONAL_MAPPING_FIELDS)[number],
                    ) ? (
                      <span className="ml-2 lowercase opacity-40 font-bold">(optional)</span>
                    ) : null}
                  </label>
                  <select
                    value={mapping[field] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [field]: e.target.value }))
                    }
                    className="w-full h-11 rounded-xl border border-app-border bg-app-surface-2 px-4 text-xs font-black text-app-accent-2 outline-none focus:ring-2 focus:ring-app-accent-2/20 transition-all appearance-none cursor-pointer"
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
              
              <div className="rounded-2xl border border-dotted border-app-border bg-app-surface/20 p-6">
                <label className="mb-2 block text-[10px] font-black uppercase tracking-widest text-app-text opacity-60">
                  Global Taxonomy Fallback
                </label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                  className="w-full h-11 rounded-xl border border-app-border bg-app-surface-2 px-4 text-xs font-black text-app-text outline-none focus:ring-2 focus:ring-app-accent-2/20 transition-all"
                >
                  <option value="">— None (mapped column required) —</option>
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
                className="mt-6 flex w-full h-14 items-center justify-center gap-3 rounded-2xl bg-app-accent text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/30 hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
              >
                Proceed to reconciliation <ArrowRight size={16} />
              </button>
            </div>
           </DashboardGridCard>

          <div className="space-y-8">
            <div className="flex flex-col justify-center rounded-[3rem] border border-app-border/40 bg-app-bg/20 p-10 backdrop-blur-md">
              <div className="mb-6 flex items-center gap-3 font-black uppercase tracking-[0.3em] text-app-accent-2 text-[10px]">
                <ShieldCheck size={20} /> Logic engine hint
              </div>
              <div className="space-y-6 text-sm leading-relaxed text-app-text-muted">
                <p>
                  Map <strong className="text-app-text font-black">product identity</strong>{" "}
                  to the column that groups variants, such as a catalog handle or style
                  number.
                </p>
                <p>
                  The <strong className="text-app-text font-black">category</strong> binding
                  drives tax-exempt logic and POS organization. If the source file lacks a category column, 
                  the global fallback will be applied to all imported entities.
                </p>
                <div className="p-5 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
                  <p className="text-[11px] font-bold text-emerald-700">
                    Stock quantities are intentionally excluded. This tool updates catalog structure only; Counterpoint sync is the authoritative pre-launch inventory load.
                  </p>
                </div>
                <div className="p-5 rounded-2xl bg-amber-500/5 border border-amber-500/20">
                  <p className="text-[11px] font-bold text-amber-700">
                    SKUs are treated as unique variant identifiers. Duplicate SKUs in the source file will cause synchronization conflicts.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {step === "review" && (
        <div className="animate-in zoom-in group relative overflow-hidden rounded-[3rem] bg-app-text p-12 text-white shadow-[0_40px_100px_rgba(0,0,0,0.4)] transition-all duration-700">
           {/* Background glow */}
           <div className="absolute -top-40 -left-40 h-[600px] w-[600px] rounded-full bg-app-accent/10 blur-[120px] pointer-events-none" />
          
          <button
            type="button"
            onClick={() =>
              setStep("map")
            }
            className="relative z-10 mb-10 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-white transition-colors"
          >
            <ArrowRight size={14} className="rotate-180" /> Back to logic
          </button>

          <div className="relative z-10 mb-12 flex flex-wrap items-end justify-between gap-6">
            <div>
              <h2 className="text-4xl font-black uppercase italic tracking-tighter leading-none mb-2">
                Commit <span className="text-app-accent-2">Catalog Sync</span>
              </h2>
              <p className="font-bold text-app-text-muted tracking-wide">
                {rows.length.toLocaleString()} rows detected · Catalog-only field map
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-2xl border border-white/5 bg-white/5 px-6 py-3 font-black uppercase tracking-widest text-emerald-400 text-[9px] backdrop-blur-md">
              <CheckCircle2 size={16} /> Catalog-Only Transactional Sync
            </div>
          </div>

          {error && (
            <div className="relative z-10 mb-8 rounded-[2rem] border border-red-500/30 bg-red-500/10 p-10 text-sm text-red-200 backdrop-blur-md">
               <p className="text-[10px] font-black uppercase tracking-[0.2em] text-red-400 mb-2">Synchronization Failure</p>
              {error}
            </div>
          )}

          {runState === "success" && summary ? (
            <div className="relative z-10 mb-8 rounded-[2rem] border border-emerald-500/30 bg-emerald-500/10 p-10 backdrop-blur-md">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-400 mb-2">
                Transmission Success
              </p>
              <p className="text-lg font-black tracking-tight">
                Catalog data successfully synchronized{completedAt ? ` at ${completedAt}` : ""}.
              </p>
            </div>
          ) : null}

          {summary && (
            <div className="relative z-10 mb-12 grid gap-4 sm:grid-cols-4">
              <div className="p-6 rounded-[2rem] bg-white/5 border border-white/5 backdrop-blur-md">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40 mb-2">Created</p>
                <p className="text-3xl font-black text-emerald-400">{summary.products_created}</p>
              </div>
              <div className="p-6 rounded-[2rem] bg-white/5 border border-white/5 backdrop-blur-md">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40 mb-2">Updated</p>
                <p className="text-3xl font-black text-app-accent-2">{summary.products_updated}</p>
              </div>
              <div className="p-6 rounded-[2rem] bg-white/5 border border-white/5 backdrop-blur-md">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40 mb-2">Variants</p>
                <p className="text-3xl font-black">{summary.variants_synced}</p>
              </div>
              <div className="p-6 rounded-[2rem] bg-white/5 border border-white/5 backdrop-blur-md">
                <p className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40 mb-2">Skipped</p>
                <p className="text-3xl font-black text-amber-400">{summary.rows_skipped}</p>
              </div>
            </div>
          )}

          <div className="relative z-10 mb-12 grid gap-12 lg:grid-cols-2">
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                 <div className="w-1.5 h-6 rounded-full bg-app-accent-2 shadow-[0_0_12px_rgba(var(--app-accent-2),0.5)]" />
                 <h3 className="text-xs font-black uppercase tracking-[0.2em]">Logic Map Registry</h3>
              </div>
              <div className="grid grid-cols-2 gap-4">
                 {Object.entries(mapping).map(([k, v]) => (
                   <div key={k} className="flex flex-col p-4 rounded-xl bg-white/5 border border-white/5">
                      <span className="text-[8px] font-black uppercase tracking-widest opacity-40 mb-1">{k}</span>
                      <span className="text-[11px] font-bold text-app-accent-2 truncate">{v || "—"}</span>
                   </div>
                 ))}
              </div>
            </div>
            <div className="space-y-6">
              <div className="flex items-center gap-3">
                 <div className="w-1.5 h-6 rounded-full bg-app-accent shadow-[0_0_12px_rgba(var(--app-accent),0.5)]" />
                 <h3 className="text-xs font-black uppercase tracking-[0.2em]">Ingestion Parameters</h3>
              </div>
              <div className="space-y-4">
                <div className="p-6 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                  <p className="text-[10px] font-bold text-emerald-300 leading-relaxed italic">
                    This importer never changes live on-hand. Use Counterpoint sync for pre-launch inventory quantities, then Receiving and Physical Inventory for operational adjustments.
                  </p>
                </div>
                <div className="p-6 rounded-2xl bg-white/5 border border-white/5">
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] opacity-40 mb-3">Global Taxonomy Fallback</p>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="w-full bg-transparent text-sm font-black text-white outline-none cursor-pointer"
                  >
                    <option value="" className="text-app-text">Auto-detect from column</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id} className="text-app-text">{c.name}</option>
                    ))}
                  </select>
                </div>
                {rows.length >= 2000 && (
                  <div className="p-6 rounded-2xl bg-amber-500/10 border border-amber-500/20">
                     <p className="text-[10px] font-bold text-amber-300 leading-relaxed italic">
                       High-volume ingestion active. Database transaction may persist for several cycles. Do not close this terminal.
                     </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            disabled={loading || !mappingReady || rows.length === 0}
            onClick={() => void runImport()}
            className="relative z-10 w-full h-20 rounded-[2rem] bg-app-accent text-xl font-black uppercase tracking-[0.3em] overflow-hidden shadow-2xl shadow-app-accent/40 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40"
          >
            <div className="relative z-10 flex items-center justify-center gap-4">
              {loading && <Loader2 className="animate-spin" size={24} />}
              {loading
                ? `Syncing Catalog…`
                : runState === "success"
                ? "Catalog sync complete"
                : "Commit catalog changes"}
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
