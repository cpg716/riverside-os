import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useRef } from "react";
import {
  CheckCircle2,
  Lock,
  Loader2,
  RefreshCw,
  Upload,
  AlertTriangle,
  Database,
  Tags,
  Truck,
  Package,
  Hash,
  Sparkles,
  Printer,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";

/* ── Types ── */

interface StepDetail {
  status: string;
  approved_at: string | null;
}

interface InventorySummary {
  products: number;
  variants: number;
  categories: number;
  vendors: number;
  variants_missing_barcode: number;
  quarantine_count: number;
}

interface WorkbenchState {
  current_step: string | null;
  steps: Record<string, StepDetail>;
  inventory_summary: InventorySummary | null;
  can_reset: boolean;
}

interface SkuGapRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  current_sku: string;
  barcode: string | null;
  counterpoint_item_key: string | null;
  category_name: string | null;
  stock_on_hand: number;
  retail_price: string | null;
}

interface MergeConflictRow {
  item_no: string;
  field: string;
  ros_value: string | null;
  lightspeed_value: string | null;
  cp_csv_value: string | null;
  suggested_value: string | null;
}

interface MergePreview {
  total_ros_products: number;
  total_lightspeed_rows: number;
  total_cp_csv_rows: number;
  name_conflicts: number;
  category_conflicts: number;
  price_conflicts: number;
  conflicts: MergeConflictRow[];
}

interface AiSuggestion {
  item_no: string;
  suggested_name?: string;
  suggested_category?: string;
  confidence?: number;
  reasoning?: string;
}

interface DataSourcesHealth {
  bridge_products: number;
  lightspeed_rows: number;
  lightspeed_file: string | null;
  cp_csv_rows: number;
  cp_csv_file: string | null;
}

async function hashString(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseCsvRows(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headerLine = lines[0];
  const headers = headerLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  return lines.slice(1).map((line) => {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { values.push(current.trim()); current = ""; continue; }
      current += ch;
    }
    values.push(current.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

/* ── Steps config ── */

const STEPS = [
  { key: "data_sources", label: "Data Sources", icon: Database, description: "Connect bridge, upload CSVs" },
  { key: "categories", label: "Categories", icon: Tags, description: "Map CP categories → ROS" },
  { key: "vendors", label: "Vendors", icon: Truck, description: "Review imported vendors" },
  { key: "catalog", label: "Catalog & Inventory", icon: Package, description: "Products, variants, quantities" },
  { key: "sku_gaps", label: "SKU Gaps", icon: Hash, description: "Assign missing barcodes" },
  { key: "verification", label: "Verification", icon: CheckCircle2, description: "Landing checks & sign-off" },
];

function stepStatusIcon(status: string) {
  if (status === "complete") return <CheckCircle2 className="h-5 w-5 text-emerald-500" />;
  if (status === "locked") return <Lock className="h-5 w-5 text-app-text-muted/40" />;
  if (status === "in_progress") return <Loader2 className="h-5 w-5 text-app-accent animate-spin" />;
  return <ChevronRight className="h-5 w-5 text-app-warning" />;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

/* ── Component ── */

export default function InventoryMigrationWorkbench() {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [state, setState] = useState<WorkbenchState | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = useState<string | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // SKU gaps
  const [skuGaps, setSkuGaps] = useState<SkuGapRow[]>([]);
  const [skuGapsTotal, setSkuGapsTotal] = useState(0);
  const [skuGapsLoading, setSkuGapsLoading] = useState(false);
  const [skuSuggestions, setSkuSuggestions] = useState<string[]>([]);
  const [skuAssignments, setSkuAssignments] = useState<Record<string, string>>({});
  const [skuAssignBusy, setSkuAssignBusy] = useState(false);

  // Merge preview
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);

  // AI review
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiScope, setAiScope] = useState<string>("names");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Data sources health
  const [dsHealth, setDsHealth] = useState<DataSourcesHealth | null>(null);
  const [csvUploading, setCsvUploading] = useState<string | null>(null);
  const lsFileRef = useRef<HTMLInputElement>(null);
  const cpFileRef = useRef<HTMLInputElement>(null);

  const headers = useCallback(
    () => backofficeHeaders() as Record<string, string>,
    [backofficeHeaders],
  );

  /* ── Fetch workbench state ── */

  const fetchState = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/workbench/state`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as WorkbenchState;
        setState(data);
        if (!activeStep && data.current_step) {
          setActiveStep(data.current_step);
        }
      }
    } catch {
      toast("Could not load workbench state", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, headers, hasPermission, toast, activeStep]);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  /* ── Approve step ── */

  const approveStep = useCallback(
    async (step: string) => {
      setApproveBusy(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/counterpoint-sync/workbench/approve-step`,
          {
            method: "POST",
            headers: { ...headers(), "Content-Type": "application/json" },
            body: JSON.stringify({ step }),
          },
        );
        if (res.ok) {
          const data = await res.json();
          toast(`Step "${step}" approved.`, "success");
          if (data.next_step_unlocked) {
            setActiveStep(data.next_step_unlocked);
          }
          void fetchState();
        } else {
          const err = await res.json().catch(() => ({}));
          toast((err as { error?: string }).error ?? "Approve failed", "error");
        }
      } catch {
        toast("Could not approve step", "error");
      } finally {
        setApproveBusy(false);
        setConfirmApprove(null);
      }
    },
    [baseUrl, headers, toast, fetchState],
  );

  /* ── Reset workbench ── */

  const resetWorkbench = useCallback(async () => {
    setResetBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/reset`,
        { method: "POST", headers: headers() },
      );
      if (res.ok) {
        toast("Workbench reset to initial state.", "success");
        setActiveStep("data_sources");
        void fetchState();
      } else {
        toast("Reset failed", "error");
      }
    } catch {
      toast("Could not reset workbench", "error");
    } finally {
      setResetBusy(false);
      setConfirmReset(false);
    }
  }, [baseUrl, headers, toast, fetchState]);

  /* ── SKU gaps ── */

  const fetchSkuGaps = useCallback(async () => {
    setSkuGapsLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/sku-gaps`,
        { headers: headers() },
      );
      if (res.ok) {
        const data = await res.json();
        setSkuGaps(data.rows ?? []);
        setSkuGapsTotal(data.total_gaps ?? 0);
      }
    } catch {
      toast("Could not load SKU gaps", "error");
    } finally {
      setSkuGapsLoading(false);
    }
  }, [baseUrl, headers, toast]);

  const fetchSkuSuggestions = useCallback(
    async (count: number) => {
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/counterpoint-sync/workbench/sku-gaps/suggest-next?count=${count}`,
          { headers: headers() },
        );
        if (res.ok) {
          const data = await res.json();
          setSkuSuggestions(data.suggestions ?? []);
        }
      } catch { /* silent */ }
    },
    [baseUrl, headers],
  );

  const assignSkus = useCallback(async () => {
    const assignments = Object.entries(skuAssignments)
      .filter(([, sku]) => sku.trim())
      .map(([variant_id, new_sku]) => ({
        variant_id,
        new_sku,
        new_barcode: new_sku,
      }));
    if (assignments.length === 0) {
      toast("No SKU assignments to save", "info");
      return;
    }
    setSkuAssignBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/sku-gaps/assign`,
        {
          method: "PATCH",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ assignments }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        toast(`${data.updated} SKU(s) assigned.`, "success");
        setSkuAssignments({});
        void fetchSkuGaps();
      } else {
        toast("Assignment failed", "error");
      }
    } catch {
      toast("Could not assign SKUs", "error");
    } finally {
      setSkuAssignBusy(false);
    }
  }, [baseUrl, headers, toast, skuAssignments, fetchSkuGaps]);

  /* ── Merge preview ── */

  const fetchMergePreview = useCallback(async () => {
    setMergeLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/merge-preview?limit=100`,
        { headers: headers() },
      );
      if (res.ok) {
        setMergePreview((await res.json()) as MergePreview);
      }
    } catch {
      toast("Could not load merge preview", "error");
    } finally {
      setMergeLoading(false);
    }
  }, [baseUrl, headers, toast]);

  /* ── AI review ── */

  const runAiReview = useCallback(
    async (scope: string) => {
      setAiBusy(true);
      setAiError(null);
      setAiScope(scope);
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/counterpoint-sync/workbench/ai-review`,
          {
            method: "POST",
            headers: { ...headers(), "Content-Type": "application/json" },
            body: JSON.stringify({ scope, limit: 30 }),
          },
        );
        if (res.ok) {
          const data = await res.json();
          if (data.error) setAiError(data.error);
          const suggestions = Array.isArray(data.suggestions)
            ? (data.suggestions as AiSuggestion[])
            : [];
          setAiSuggestions(suggestions);
          if (!data.ai_available) {
            setAiError(data.error ?? "AI (Gemma) is not available on this server.");
          }
        }
      } catch {
        setAiError("Could not reach AI review endpoint");
      } finally {
        setAiBusy(false);
      }
    },
    [baseUrl, headers],
  );

  /* ── Data sources health ── */

  const fetchDsHealth = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/data-sources-health`,
        { headers: headers() },
      );
      if (res.ok) setDsHealth((await res.json()) as DataSourcesHealth);
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  /* ── CSV upload handlers ── */

  const handleCsvUpload = useCallback(
    async (file: File, type: "lightspeed" | "counterpoint") => {
      setCsvUploading(type);
      try {
        const text = await file.text();
        const fileHash = await hashString(text);
        const parsed = parseCsvRows(text);
        if (parsed.length === 0) {
          toast("CSV file is empty or has no data rows.", "error");
          return;
        }

        if (type === "lightspeed") {
          const rows = parsed.map((row, i) => ({
            sku: row["SKU"] || row["sku"] || row["Sku"] || "",
            handle: row["Handle"] || row["handle"] || null,
            name: row["Name"] || row["Title"] || row["name"] || row["Product Name"] || null,
            product_category: row["Category"] || row["category"] || row["Product Category"] || null,
            supplier_name: row["Supplier"] || row["supplier_name"] || row["Vendor"] || null,
            supplier_code: row["Supplier Code"] || row["supplier_code"] || null,
            brand_name: row["Brand"] || row["brand_name"] || null,
            tags: row["Tags"] || row["tags"] || null,
            variant_options: [] as { name: string | null; value: string | null }[],
            source_row_number: i + 2,
            source_row_hash: `${fileHash}-${i}`,
            raw_row: row,
          }));

          const res = await fetch(
            `${baseUrl}/api/settings/counterpoint-sync/workbench/upload-lightspeed-csv`,
            {
              method: "POST",
              headers: { ...headers(), "Content-Type": "application/json" },
              body: JSON.stringify({
                source_file_name: file.name,
                source_file_hash: fileHash,
                replace: true,
                rows,
              }),
            },
          );
          if (res.ok) {
            toast(`Lightspeed CSV uploaded: ${rows.length} rows`, "success");
            void fetchDsHealth();
          } else {
            const err = await res.json().catch(() => ({}));
            toast((err as { error?: string }).error ?? "Upload failed", "error");
          }
        } else {
          const rows = parsed.map((row, i) => ({
            item_no: row["Item No"] || row["ITEM_NO"] || row["item_no"] || row["ItemNo"] || row["Item #"] || "",
            description: row["Description"] || row["DESCR"] || row["description"] || null,
            long_description: row["Long Description"] || row["LONG_DESCR"] || null,
            category_code: row["Category"] || row["CATEG_COD"] || row["category_code"] || null,
            barcode: row["Barcode"] || row["UPC"] || row["barcode"] || null,
            retail_price: row["Price"] || row["PRC_1"] || row["retail_price"] ? parseFloat(row["Price"] || row["PRC_1"] || row["retail_price"] || "0") || null : null,
            unit_cost: row["Cost"] || row["COST"] || row["unit_cost"] ? parseFloat(row["Cost"] || row["COST"] || row["unit_cost"] || "0") || null : null,
            qty_on_hand: row["Qty"] || row["QTY_ON_HND"] || row["qty_on_hand"] ? parseInt(row["Qty"] || row["QTY_ON_HND"] || row["qty_on_hand"] || "0", 10) || null : null,
            vendor_no: row["Vendor"] || row["VEND_NO"] || row["vendor_no"] || null,
            is_grid: (row["Grid"] || row["IS_GRID"] || "").toUpperCase() === "Y" || null,
            source_row_number: i + 2,
            raw_row: row,
          }));

          const res = await fetch(
            `${baseUrl}/api/settings/counterpoint-sync/workbench/upload-cp-csv`,
            {
              method: "POST",
              headers: { ...headers(), "Content-Type": "application/json" },
              body: JSON.stringify({
                source_file_name: file.name,
                source_file_hash: fileHash,
                replace: true,
                rows,
              }),
            },
          );
          if (res.ok) {
            toast(`Counterpoint CSV uploaded: ${rows.length} rows`, "success");
            void fetchDsHealth();
          } else {
            const err = await res.json().catch(() => ({}));
            toast((err as { error?: string }).error ?? "Upload failed", "error");
          }
        }
      } catch (e) {
        toast(`CSV upload error: ${e}`, "error");
      } finally {
        setCsvUploading(null);
      }
    },
    [baseUrl, headers, toast, fetchDsHealth],
  );

  /* ── Apply AI suggestions ── */

  const applySuggestions = useCallback(
    async (suggestions: AiSuggestion[], scope: string) => {
      const payload = suggestions
        .filter((s) => (scope === "names" ? s.suggested_name : s.suggested_category))
        .map((s) => ({
          item_no: s.item_no,
          new_name: scope === "names" ? s.suggested_name : undefined,
          new_category: scope === "categories" ? s.suggested_category : undefined,
        }));
      if (payload.length === 0) {
        toast("No suggestions to apply", "info");
        return;
      }
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/counterpoint-sync/workbench/apply-suggestions`,
          {
            method: "POST",
            headers: { ...headers(), "Content-Type": "application/json" },
            body: JSON.stringify({ suggestions: payload }),
          },
        );
        if (res.ok) {
          const data = await res.json();
          toast(
            `Applied: ${data.names_updated ?? 0} names, ${data.categories_updated ?? 0} categories updated.`,
            "success",
          );
          setAiSuggestions([]);
          void fetchState();
        } else {
          toast("Apply failed", "error");
        }
      } catch {
        toast("Could not apply suggestions", "error");
      }
    },
    [baseUrl, headers, toast, fetchState],
  );

  /* ── Auto-load step data ── */

  useEffect(() => {
    if (activeStep === "data_sources" && !dsHealth) {
      void fetchDsHealth();
    }
    if (activeStep === "sku_gaps" && skuGaps.length === 0 && !skuGapsLoading) {
      void fetchSkuGaps();
    }
    if (activeStep === "catalog" && !mergePreview && !mergeLoading) {
      void fetchMergePreview();
    }
  }, [activeStep, dsHealth, fetchDsHealth, skuGaps.length, skuGapsLoading, fetchSkuGaps, mergePreview, mergeLoading, fetchMergePreview]);

  if (!hasPermission("settings.admin")) {
    return (
      <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-8 text-center text-app-text-muted">
        <Lock className="mx-auto h-8 w-8 mb-2" />
        <p className="font-bold">Manager access required for the Migration Workbench.</p>
      </div>
    );
  }

  const stepStatus = (key: string) => state?.steps[key]?.status ?? "locked";

  return (
    <section className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black italic tracking-tighter uppercase text-app-text">
            Inventory Migration Workbench
          </h2>
          <p className="mt-1 text-sm text-app-text-muted max-w-2xl">
            Step-by-step guided import from Counterpoint. Complete each step before moving to the next.
            Everything is deleteable and restartable.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void fetchState()}
            disabled={loading}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-600"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset All Steps
          </button>
        </div>
      </div>

      {/* ── Step rail ── */}
      <div className="flex flex-wrap gap-2">
        {STEPS.map((step) => {
          const status = stepStatus(step.key);
          const isActive = activeStep === step.key;
          const isClickable = status !== "locked";
          return (
            <button
              key={step.key}
              type="button"
              disabled={!isClickable}
              onClick={() => isClickable && setActiveStep(step.key)}
              className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-left transition-colors ${
                isActive
                  ? "border-app-warning/50 bg-app-warning/10"
                  : status === "locked"
                    ? "border-app-border/40 bg-app-bg/30 opacity-50 cursor-not-allowed"
                    : "border-app-border bg-app-surface-2/40 hover:bg-app-surface/40 cursor-pointer"
              }`}
            >
              {stepStatusIcon(status)}
              <div className="min-w-0">
                <p className={`text-xs font-black uppercase tracking-widest ${
                  isActive ? "text-app-warning" : "text-app-text"
                }`}>
                  {step.label}
                </p>
                <p className="text-[10px] text-app-text-muted truncate">{step.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Inventory summary strip ── */}
      {state?.inventory_summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
          {[
            { label: "Products", value: fmtNum(state.inventory_summary.products) },
            { label: "Variants", value: fmtNum(state.inventory_summary.variants) },
            { label: "Categories Mapped", value: fmtNum(state.inventory_summary.categories) },
            { label: "Vendors", value: fmtNum(state.inventory_summary.vendors) },
            {
              label: "Missing Barcode",
              value: fmtNum(state.inventory_summary.variants_missing_barcode),
              warn: (state.inventory_summary.variants_missing_barcode ?? 0) > 0,
            },
            {
              label: "Quarantined",
              value: fmtNum(state.inventory_summary.quarantine_count),
              warn: (state.inventory_summary.quarantine_count ?? 0) > 0,
            },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                {item.label}
              </p>
              <p className={`mt-1 text-lg font-black tabular-nums ${
                "warn" in item && item.warn ? "text-app-warning" : "text-app-text"
              }`}>
                {item.value}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Step content ── */}
      {activeStep === "data_sources" && (
        <StepCard
          title="Step 1: Data Sources"
          description="Connect the Counterpoint SQL bridge and upload reference CSVs."
          status={stepStatus("data_sources")}
          onApprove={() => setConfirmApprove("data_sources")}
        >
          <div className="grid gap-4 md:grid-cols-3">
            <SourceCard
              title="Counterpoint SQL Bridge"
              description="Live SQL connection from the Windows bridge."
              loaded={(dsHealth?.bridge_products ?? state?.inventory_summary?.products ?? 0) > 0}
              count={dsHealth?.bridge_products ?? state?.inventory_summary?.products}
              countLabel="products imported"
            />
            <div className={`rounded-xl border p-4 ${
              (dsHealth?.lightspeed_rows ?? 0) > 0
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-app-border bg-app-bg/60"
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {(dsHealth?.lightspeed_rows ?? 0) > 0 ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Upload className="h-4 w-4 text-app-text-muted" />
                )}
                <h4 className="text-xs font-black uppercase tracking-widest text-app-text">Lightspeed CSV</h4>
              </div>
              <p className="text-[10px] text-app-text-muted">Upload your Lightspeed product export for name & variation enrichment.</p>
              {(dsHealth?.lightspeed_rows ?? 0) > 0 ? (
                <div className="mt-2">
                  <p className="text-lg font-black tabular-nums text-emerald-700 dark:text-emerald-300">
                    {fmtNum(dsHealth?.lightspeed_rows)} <span className="text-xs font-normal">rows loaded</span>
                  </p>
                  <p className="text-[10px] text-app-text-muted truncate">{dsHealth?.lightspeed_file}</p>
                </div>
              ) : null}
              <input
                ref={lsFileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleCsvUpload(file, "lightspeed");
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => lsFileRef.current?.click()}
                disabled={csvUploading === "lightspeed"}
                className="mt-3 w-full rounded-lg border-2 border-dashed border-app-border p-3 text-center hover:border-app-accent/50 transition-colors disabled:opacity-50"
              >
                {csvUploading === "lightspeed" ? (
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-app-accent" />
                ) : (
                  <>
                    <Upload className="mx-auto h-5 w-5 text-app-text-muted/50 mb-1" />
                    <p className="text-[10px] font-bold text-app-text-muted">
                      {(dsHealth?.lightspeed_rows ?? 0) > 0 ? "Replace CSV" : "Click to upload"}
                    </p>
                  </>
                )}
              </button>
            </div>
            <div className={`rounded-xl border p-4 ${
              (dsHealth?.cp_csv_rows ?? 0) > 0
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "border-app-border bg-app-bg/60"
            }`}>
              <div className="flex items-center gap-2 mb-2">
                {(dsHealth?.cp_csv_rows ?? 0) > 0 ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Upload className="h-4 w-4 text-app-text-muted" />
                )}
                <h4 className="text-xs font-black uppercase tracking-widest text-app-text">Counterpoint CSV Export</h4>
              </div>
              <p className="text-[10px] text-app-text-muted">Upload a Counterpoint product export CSV as a verification reference.</p>
              {(dsHealth?.cp_csv_rows ?? 0) > 0 ? (
                <div className="mt-2">
                  <p className="text-lg font-black tabular-nums text-emerald-700 dark:text-emerald-300">
                    {fmtNum(dsHealth?.cp_csv_rows)} <span className="text-xs font-normal">rows loaded</span>
                  </p>
                  <p className="text-[10px] text-app-text-muted truncate">{dsHealth?.cp_csv_file}</p>
                </div>
              ) : null}
              <input
                ref={cpFileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleCsvUpload(file, "counterpoint");
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => cpFileRef.current?.click()}
                disabled={csvUploading === "counterpoint"}
                className="mt-3 w-full rounded-lg border-2 border-dashed border-app-border p-3 text-center hover:border-app-accent/50 transition-colors disabled:opacity-50"
              >
                {csvUploading === "counterpoint" ? (
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-app-accent" />
                ) : (
                  <>
                    <Upload className="mx-auto h-5 w-5 text-app-text-muted/50 mb-1" />
                    <p className="text-[10px] font-bold text-app-text-muted">
                      {(dsHealth?.cp_csv_rows ?? 0) > 0 ? "Replace CSV" : "Click to upload"}
                    </p>
                  </>
                )}
              </button>
            </div>
          </div>
        </StepCard>
      )}

      {activeStep === "categories" && (
        <StepCard
          title="Step 2: Categories"
          description="Review and map Counterpoint categories to Riverside OS categories by name."
          status={stepStatus("categories")}
          onApprove={() => setConfirmApprove("categories")}
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void runAiReview("categories")}
                disabled={aiBusy}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
              >
                <Sparkles className={`h-3.5 w-3.5 ${aiBusy && aiScope === "categories" ? "animate-spin" : ""}`} />
                AI Suggest Categories
              </button>
              <p className="text-xs text-app-text-muted">
                Use the existing Categories tab in the Counterpoint panel to map categories,
                then return here to approve.
              </p>
            </div>
            {aiSuggestions.length > 0 && aiScope === "categories" && (
              <AiSuggestionsPanel suggestions={aiSuggestions} scope="categories" onApply={applySuggestions} />
            )}
            {aiError && aiScope === "categories" && (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
                {aiError}
              </p>
            )}
          </div>
        </StepCard>
      )}

      {activeStep === "vendors" && (
        <StepCard
          title="Step 3: Vendors"
          description="Review imported vendor list."
          status={stepStatus("vendors")}
          onApprove={() => setConfirmApprove("vendors")}
        >
          <p className="text-sm text-app-text-muted">
            {fmtNum(state?.inventory_summary?.vendors)} vendors imported from Counterpoint.
            Review the vendor list in the main settings before approving.
          </p>
        </StepCard>
      )}

      {activeStep === "catalog" && (
        <StepCard
          title="Step 4: Catalog & Inventory"
          description="Review products, variants, and multi-source name/category conflicts."
          status={stepStatus("catalog")}
          onApprove={() => setConfirmApprove("catalog")}
        >
          <div className="space-y-4">
            {/* Multi-source merge preview */}
            <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
              <div className="flex items-center justify-between">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Multi-Source Comparison
                </h4>
                <button
                  type="button"
                  onClick={() => void fetchMergePreview()}
                  disabled={mergeLoading}
                  className="text-[10px] font-bold uppercase text-app-accent disabled:opacity-50"
                >
                  {mergeLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
              {mergePreview && (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <SummaryCard label="ROS Products" value={fmtNum(mergePreview.total_ros_products)} />
                    <SummaryCard label="Lightspeed Rows" value={fmtNum(mergePreview.total_lightspeed_rows)} />
                    <SummaryCard label="CP CSV Rows" value={fmtNum(mergePreview.total_cp_csv_rows)} />
                  </div>
                  {(mergePreview.name_conflicts > 0 || mergePreview.category_conflicts > 0 || mergePreview.price_conflicts > 0) && (
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap gap-2 text-xs font-bold">
                        {mergePreview.name_conflicts > 0 && (
                          <span className="rounded-full bg-app-warning/15 text-app-warning px-2 py-0.5">
                            {fmtNum(mergePreview.name_conflicts)} name
                          </span>
                        )}
                        {mergePreview.category_conflicts > 0 && (
                          <span className="rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-300 px-2 py-0.5">
                            {fmtNum(mergePreview.category_conflicts)} category
                          </span>
                        )}
                        {mergePreview.price_conflicts > 0 && (
                          <span className="rounded-full bg-red-500/15 text-red-600 dark:text-red-300 px-2 py-0.5">
                            {fmtNum(mergePreview.price_conflicts)} price
                          </span>
                        )}
                      </div>
                      <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                        <table className="w-full text-xs text-left">
                          <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                            <tr className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              <th className="px-2 py-1.5">Item</th>
                              <th className="px-2 py-1.5">Field</th>
                              <th className="px-2 py-1.5">ROS Value</th>
                              <th className="px-2 py-1.5">Lightspeed</th>
                              <th className="px-2 py-1.5">CP CSV</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-app-border">
                            {mergePreview.conflicts.slice(0, 100).map((c, i) => (
                              <tr key={`${c.item_no}-${c.field}-${i}`}>
                                <td className="px-2 py-1.5 font-mono text-[10px]">{c.item_no}</td>
                                <td className="px-2 py-1.5">
                                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase ${
                                    c.field === "name"
                                      ? "bg-app-warning/15 text-app-warning"
                                      : c.field === "category"
                                        ? "bg-blue-500/15 text-blue-600 dark:text-blue-300"
                                        : "bg-red-500/15 text-red-600 dark:text-red-300"
                                  }`}>
                                    {c.field}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5">{c.ros_value ?? "—"}</td>
                                <td className="px-2 py-1.5 text-app-text-muted">{c.lightspeed_value ?? "—"}</td>
                                <td className="px-2 py-1.5 text-app-text-muted">{c.cp_csv_value ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* AI name review */}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runAiReview("names")}
                disabled={aiBusy}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
              >
                <Sparkles className={`h-3.5 w-3.5 ${aiBusy && aiScope === "names" ? "animate-spin" : ""}`} />
                AI Review Names
              </button>
            </div>
            {aiSuggestions.length > 0 && aiScope === "names" && (
              <AiSuggestionsPanel suggestions={aiSuggestions} scope="names" onApply={applySuggestions} />
            )}
            {aiError && aiScope === "names" && (
              <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
                {aiError}
              </p>
            )}
          </div>
        </StepCard>
      )}

      {activeStep === "sku_gaps" && (
        <StepCard
          title="Step 5: SKU Gap Review"
          description="Items with only I-XXXXXX (no B-XXXXXX barcode). Assign new SKUs and print labels."
          status={stepStatus("sku_gaps")}
          onApprove={() => setConfirmApprove("sku_gaps")}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  void fetchSkuGaps();
                  void fetchSkuSuggestions(100);
                }}
                disabled={skuGapsLoading}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${skuGapsLoading ? "animate-spin" : ""}`} />
                {skuGapsLoading ? "Loading…" : "Reload Gaps"}
              </button>
              <span className="text-xs text-app-text-muted">
                {fmtNum(skuGapsTotal)} items missing barcodes
              </span>
            </div>

            {skuGaps.length > 0 && (
              <>
                <div className="overflow-x-auto max-h-[400px] overflow-y-auto rounded-xl border border-app-border">
                  <table className="w-full text-xs text-left min-w-[700px]">
                    <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                      <tr className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <th className="px-2 py-2">Product</th>
                        <th className="px-2 py-2">Current SKU</th>
                        <th className="px-2 py-2">Category</th>
                        <th className="px-2 py-2">Stock</th>
                        <th className="px-2 py-2 min-w-[140px]">New SKU</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {skuGaps.map((row, idx) => (
                        <tr key={row.variant_id}>
                          <td className="px-2 py-2 font-bold max-w-[200px] truncate">{row.product_name}</td>
                          <td className="px-2 py-2 font-mono text-[10px] text-app-warning">{row.current_sku}</td>
                          <td className="px-2 py-2 text-app-text-muted">{row.category_name ?? "—"}</td>
                          <td className="px-2 py-2 tabular-nums">{row.stock_on_hand}</td>
                          <td className="px-2 py-2">
                            <input
                              type="text"
                              className="ui-input text-xs w-full"
                              placeholder={skuSuggestions[idx] ?? "B-XXXXXX"}
                              value={skuAssignments[row.variant_id] ?? ""}
                              onChange={(e) =>
                                setSkuAssignments((prev) => ({
                                  ...prev,
                                  [row.variant_id]: e.target.value,
                                }))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const auto: Record<string, string> = {};
                      skuGaps.forEach((row, idx) => {
                        if (skuSuggestions[idx] && !skuAssignments[row.variant_id]) {
                          auto[row.variant_id] = skuSuggestions[idx];
                        }
                      });
                      setSkuAssignments((prev) => ({ ...prev, ...auto }));
                    }}
                    disabled={skuSuggestions.length === 0}
                    className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
                  >
                    Auto-fill Suggestions
                  </button>
                  <button
                    type="button"
                    onClick={() => void assignSkus()}
                    disabled={skuAssignBusy || Object.keys(skuAssignments).length === 0}
                    className="ui-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold"
                  >
                    {skuAssignBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Save Assignments
                  </button>
                  <button
                    type="button"
                    disabled
                    className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold opacity-50"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    Print Labels
                  </button>
                </div>
              </>
            )}
            {skuGaps.length === 0 && !skuGapsLoading && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs">
                <p className="font-bold text-emerald-700 dark:text-emerald-300">
                  No SKU gaps detected — all variants have proper barcodes.
                </p>
              </div>
            )}
          </div>
        </StepCard>
      )}

      {activeStep === "verification" && (
        <StepCard
          title="Step 6: Verification & Sign-Off"
          description="Confirm inventory data matches Counterpoint before proceeding to customers and transactions."
          status={stepStatus("verification")}
          onApprove={() => setConfirmApprove("verification")}
        >
          <div className="space-y-3">
            <p className="text-sm text-app-text-muted">
              Use the Sign-off Checklist in the Counterpoint Status panel to run landing verification,
              fidelity diagnostics, and transaction reconciliation. Return here to approve when all checks pass.
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              <VerificationCheckCard
                label="Category Coverage"
                description="All imported products have a mapped category"
                passed={state?.inventory_summary?.categories != null && state.inventory_summary.categories > 0}
              />
              <VerificationCheckCard
                label="SKU Integrity"
                description="No items with I-XXXXXX as their only identifier"
                passed={(state?.inventory_summary?.variants_missing_barcode ?? 1) === 0}
              />
              <VerificationCheckCard
                label="Quarantine Clear"
                description="No quarantined or blocked items remaining"
                passed={(state?.inventory_summary?.quarantine_count ?? 1) === 0}
              />
              <VerificationCheckCard
                label="Product Count"
                description="Products imported from Counterpoint"
                passed={(state?.inventory_summary?.products ?? 0) > 0}
              />
            </div>
          </div>
        </StepCard>
      )}

      {/* ── Modals ── */}
      <ConfirmationModal
        isOpen={confirmApprove != null}
        onClose={() => setConfirmApprove(null)}
        onConfirm={() => confirmApprove && void approveStep(confirmApprove)}
        title={`Approve ${confirmApprove ?? ""} step?`}
        message="This locks the step as complete and unlocks the next step in the migration flow."
        confirmLabel="Approve"
        variant="success"
        loading={approveBusy}
      />
      <ConfirmationModal
        isOpen={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => void resetWorkbench()}
        title="Reset Migration Workbench?"
        message="This resets all step approvals back to initial state. It does NOT delete imported data — use the Counterpoint baseline reset for that."
        confirmLabel="Reset Steps"
        variant="danger"
        loading={resetBusy}
      />
    </section>
  );
}

/* ── Sub-components ── */

function StepCard({
  title,
  description,
  status,
  onApprove,
  children,
}: {
  title: string;
  description: string;
  status: string;
  onApprove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">{title}</h3>
          <p className="mt-1 text-xs text-app-text-muted">{description}</p>
        </div>
        {status === "complete" ? (
          <span className="ui-pill text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-200">
            Approved
          </span>
        ) : status !== "locked" ? (
          <button
            type="button"
            onClick={onApprove}
            className="ui-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold"
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Approve Step
          </button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function SourceCard({
  title,
  description,
  loaded,
  count,
  countLabel,
  uploadHint,
}: {
  title: string;
  description: string;
  loaded: boolean;
  count?: number | null;
  countLabel?: string;
  uploadHint?: string;
}) {
  return (
    <div className={`rounded-xl border p-4 ${
      loaded
        ? "border-emerald-500/30 bg-emerald-500/5"
        : "border-app-border bg-app-bg/60"
    }`}>
      <div className="flex items-center gap-2 mb-2">
        {loaded ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <Upload className="h-4 w-4 text-app-text-muted" />
        )}
        <h4 className="text-xs font-black uppercase tracking-widest text-app-text">{title}</h4>
      </div>
      <p className="text-[10px] text-app-text-muted">{description}</p>
      {loaded && count != null && (
        <p className="mt-2 text-lg font-black tabular-nums text-emerald-700 dark:text-emerald-300">
          {fmtNum(count)} <span className="text-xs font-normal">{countLabel}</span>
        </p>
      )}
      {!loaded && uploadHint && (
        <div className="mt-3 rounded-lg border-2 border-dashed border-app-border p-4 text-center">
          <Upload className="mx-auto h-6 w-6 text-app-text-muted/50 mb-1" />
          <p className="text-[10px] text-app-text-muted">{uploadHint}</p>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-app-text">{value}</p>
    </div>
  );
}

function VerificationCheckCard({
  label,
  description,
  passed,
}: {
  label: string;
  description: string;
  passed: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${
      passed
        ? "border-emerald-500/25 bg-emerald-500/5"
        : "border-amber-500/25 bg-amber-500/5"
    }`}>
      <div className="flex items-center gap-2">
        {passed ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        )}
        <p className="text-xs font-bold text-app-text">{label}</p>
      </div>
      <p className="mt-1 text-[10px] text-app-text-muted">{description}</p>
    </div>
  );
}

function AiSuggestionsPanel({
  suggestions,
  scope,
  onApply,
}: {
  suggestions: AiSuggestion[];
  scope: string;
  onApply?: (suggestions: AiSuggestion[], scope: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="rounded-xl border border-app-border bg-app-surface-2/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-app-border bg-app-bg/40 flex items-center justify-between">
        <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          AI Suggestions ({scope}) — {suggestions.length} items
        </h4>
        {onApply && (
          <button
            type="button"
            onClick={() => onApply(suggestions, scope)}
            className="ui-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold"
          >
            <CheckCircle2 className="h-3 w-3" />
            Apply All
          </button>
        )}
      </div>
      <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
        <table className="w-full text-xs text-left">
          <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
            <tr className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <th className="px-2 py-1.5">Item</th>
              {scope === "names" && <th className="px-2 py-1.5">Suggested Name</th>}
              {scope === "categories" && <th className="px-2 py-1.5">Suggested Category</th>}
              <th className="px-2 py-1.5">Confidence</th>
              {scope === "names" && <th className="px-2 py-1.5">Reasoning</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {suggestions.map((s) => (
              <tr key={s.item_no}>
                <td className="px-2 py-1.5 font-mono text-[10px]">{s.item_no}</td>
                {scope === "names" && (
                  <td className="px-2 py-1.5 font-bold">{s.suggested_name ?? "—"}</td>
                )}
                {scope === "categories" && (
                  <td className="px-2 py-1.5 font-bold">{s.suggested_category ?? "—"}</td>
                )}
                <td className="px-2 py-1.5 tabular-nums">
                  {s.confidence != null ? `${Math.round(s.confidence * 100)}%` : "—"}
                </td>
                {scope === "names" && (
                  <td className="px-2 py-1.5 text-app-text-muted max-w-[200px] truncate">
                    {s.reasoning ?? "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
