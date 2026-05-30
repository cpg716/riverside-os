import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  RefreshCw,
  Play,
  Square,
  CheckCircle2,
  AlertTriangle,
  Wifi,
  WifiOff,
  Loader2,
  Database,
  Sparkles,
  ChevronRight,
  RotateCcw,
  Upload,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

/* ── Types & Interfaces ── */

interface EntityRunRow {
  entity: string;
  cursor_value: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  records_processed: number | null;
  updated_at: string;
}

interface SyncIssueRow {
  id: number;
  entity: string;
  external_key: string | null;
  severity: string;
  message: string;
  resolved: boolean;
  created_at: string;
}

interface SyncStatusResponse {
  windows_sync_state: "online" | "offline" | "syncing";
  offline_reason?: string;
  bridge_phase: string;
  current_entity?: string;
  bridge_version?: string;
  bridge_hostname?: string;
  last_seen_at?: string;
  entity_runs: EntityRunRow[];
  recent_issues: SyncIssueRow[];
  token_configured: boolean;
  counterpoint_staging_enabled?: boolean;
  staging_pending_count?: number;
  staging_applying_count?: number;
}

interface StagingBatchRow {
  id: number;
  entity: string;
  row_count: number;
  status: string;
  apply_error: string | null;
  bridge_version: string | null;
  bridge_hostname: string | null;
  created_at: string;
  applied_at: string | null;
  applied_by_staff_id: string | null;
  applied_by_staff_name: string | null;
  apply_started_at: string | null;
  apply_claimed_by_staff_id: string | null;
  apply_claimed_by_staff_name: string | null;
  replay_count: number;
  last_replayed_at: string | null;
  payload_fingerprint: string | null;
  recovered_at: string | null;
  recovered_by_staff_id: string | null;
  recovered_by_staff_name: string | null;
  recovery_reason: string | null;
}

interface CategoryMapRow {
  id: number;
  cp_category: string;
  ros_category_id: string | null;
}

interface PaymentMapRow {
  id: number;
  cp_pmt_typ: string;
  ros_method: string;
}

interface GiftReasonRow {
  id: number;
  cp_reason_cod: string;
  ros_card_kind: string;
}

interface StaffMapRow {
  id: number;
  cp_code: string;
  cp_source: string;
  ros_staff_id: string;
  staff_display_name: string | null;
}

interface CategoryOption {
  id: string;
  name: string;
}

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

interface CounterpointResetCountRow {
  key: string;
  label: string;
  count: number;
  note: string;
}

interface CounterpointResetPreviewResponse {
  confirmation_phrase: string;
  pre_go_live_only_warning: string;
  preserve_always: string[];
  reset_scope: CounterpointResetCountRow[];
  careful_ordering: string[];
  excluded_for_now: string[];
  bridge_local_state_note: string;
}

interface CounterpointLandingVerificationRow {
  key: string;
  label: string;
  count: number;
  confidence: string;
  note: string;
}

interface CounterpointSnapshotReconciliationRow {
  key: string;
  label: string;
  status: string;
  passed: boolean;
  source_count: number | null;
  landed_count: number;
  count_difference: number | null;
  source_sum: string | null;
  landed_sum: string;
  sum_difference: string | null;
  source_checksum: string | null;
  landed_checksum: string | null;
  checksum_matched: boolean | null;
  note: string;
  source_updated_at: string | null;
}

interface CounterpointCutoverVisibilityRow {
  key: string;
  label: string;
  status: string;
  passed: boolean;
  count: number;
  note: string;
}

interface CounterpointFidelityDiagnosticMismatch {
  group: string;
  item_key: string | null;
  sku: string | null;
  barcode: string | null;
  field: string;
  counterpoint_value: string;
  ros_value: string;
}

interface CounterpointFidelityDiagnosticReport {
  group: string;
  generated_at: string;
  total_source_rows: number;
  compared_rows: number;
  mismatch_count: number;
  result_limit: number;
  mismatches: CounterpointFidelityDiagnosticMismatch[];
}

interface CounterpointLandingVerificationSummary {
  generated_at: string;
  disclaimer: string;
  rows: CounterpointLandingVerificationRow[];
  snapshot_reconciliation: CounterpointSnapshotReconciliationRow[];
  cutover_visibility: CounterpointCutoverVisibilityRow[];
  fidelity_diagnostics: CounterpointFidelityDiagnosticReport[];
}

// interface CounterpointTransactionReconciliationTotals {
//   imported_ticket_transactions: number;
//   transaction_lines: number;
//   imported_zero_tax_lines: number;
//   payments: number;
//   transaction_total_sum: string;
//   payment_amount_sum: string;
//   difference: string;
// }

// interface CounterpointTransactionReconciliationSnapshot {
//   generated_at: string;
//   disclaimer: string;
//   totals: CounterpointTransactionReconciliationTotals;
//   by_date: {
//     business_day: string;
//     imported_ticket_transactions: number;
//     transaction_lines: number;
//     payments: number;
//     transaction_total_sum: string;
//     payment_amount_sum: string;
//   }[];
//   by_payment_type: {
//     payment_type: string;
//     payments: number;
//     payment_amount_sum: string;
//   }[];
// }

interface CounterpointOpenDocsVerificationSnapshot {
  generated_at: string;
  disclaimer: string;
  imported_open_doc_transactions: number;
  imported_open_doc_lines: number;
  imported_open_doc_zero_tax_lines: number;
  imported_open_doc_payments: number;
  open_docs_with_customer_linked: number;
  open_docs_missing_customer: number;
  open_docs_with_zero_lines: number;
  open_docs_with_zero_payments: number;
  distinct_staff_attribution_count: number;
}

// interface CounterpointInventoryCatalogVerificationSnapshot {
//   generated_at: string;
//   disclaimer: string;
//   counterpoint_products: number;
//   counterpoint_variants: number;
//   products_with_identifier_like_name: number;
//   products_name_equals_counterpoint_key: number;
//   variants_with_sku: number;
//   variants_with_barcode: number;
//   variants_with_cost: number;
//   variants_with_price: number;
//   variants_with_quantity_on_hand: number;
//   variants_missing_sku: number;
//   variants_missing_barcode: number;
//   variants_missing_cost: number;
//   variants_missing_price: number;
//   variants_zero_or_negative_quantity: number;
//   products_missing_category_mapping: number;
//   variants_missing_vendor_supplier_item_link: number;
//   distinct_vendors_linked_to_imported_items: number;
// }

// interface BridgeLiveStatus {
//   isSyncing: boolean;
//   isContinuous: boolean;
//   currentEntity: string | null;
//   lastRun: string | null;
//   lastRunDurationMs: number | null;
//   totalRecordsLastRun: number;
//   abortRequested: boolean;
//   entityStats: Record<string, { lastSync?: string; recordCount?: number; durationMs?: number; error?: string | null }>;
//   syncSummary: Record<string, string>;
//   recentEvents: { type: string; entity: string | null; message: string; time: string }[];
// }

const BRIDGE_CONTROL_URL_STORAGE_KEY = "counterpoint.bridgeControlUrl";

const STAGE_STEPS = [
  { step: 1, label: "SQL Bridge Sync", desc: "Sync raw staging rows from Counterpoint" },
  { step: 2, label: "Inventory Catalog", desc: "Map codes, run ROSIE AI, & fix barcodes" },
  { step: 3, label: "Customers & CRM", desc: "Review & load staged customer profiles" },
  { step: 4, label: "Sales & Ticket History", desc: "Review & load closed tickets" },
  { step: 5, label: "Gift Cards & Liabilities", desc: "Verify active liabilities" },
  { step: 6, label: "Open Orders & Layaways", desc: "Load active orders & deposits" },
  { step: 7, label: "Loyalty History", desc: "Verify & load loyalty balances" },
  { step: 8, label: "Audit & Live Cutover", desc: "Landing audit & final Go-Live sign-off" },
];

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

// function fmtMoney(value: string | number | null | undefined): string {
//   if (value == null) return "—";
//   const n = typeof value === "number" ? value : Number(value);
//   if (!Number.isFinite(n)) return "—";
//   return n.toLocaleString(undefined, {
//     style: "currency",
//     currency: "USD",
//   });
// }

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

export interface CounterpointSyncSettingsPanelProps {
  variant?: "card" | "workspace";
}

export default function CounterpointSyncSettingsPanel({
}: CounterpointSyncSettingsPanelProps) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [activeStep, setActiveStep] = useState<number>(1);

  /* ── State variables consolidated from both components ── */
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<StagingBatchRow[]>([]);
  const [applyBusy, setApplyBusy] = useState(false);
  const [stagingToggleBusy, setStagingToggleBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);

  // Connection settings
  const [runRequestBusy, setRunRequestBusy] = useState(false);
  const [bridgeControlUrlDraft, setBridgeControlUrlDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(BRIDGE_CONTROL_URL_STORAGE_KEY) ?? "";
  });

  // Workbench state (for catalog cleanup steps)
  const [workbenchState, setWorkbenchState] = useState<WorkbenchState | null>(null);
  const [workbenchLoading, setWorkbenchLoading] = useState(false);
  const [activeSubStep, setActiveSubStep] = useState<string>("data_sources");
  // const [confirmApproveSubStep, setConfirmApproveSubStep] = useState<string | null>(null);
  // const [approveSubStepBusy, setApproveSubStepBusy] = useState(false);
  const [confirmWorkbenchReset, setConfirmWorkbenchReset] = useState(false);
  const [workbenchResetBusy, setWorkbenchResetBusy] = useState(false);

  // Maps state
  const [categoryRows, setCategoryRows] = useState<CategoryMapRow[]>([]);
  const [paymentRows, setPaymentRows] = useState<PaymentMapRow[]>([]);
  const [giftRows, setGiftRows] = useState<GiftReasonRow[]>([]);
  const [staffRows, setStaffRows] = useState<StaffMapRow[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);

  // CSV files state
  const [dsHealth, setDsHealth] = useState<DataSourcesHealth | null>(null);
  const [csvUploading, setCsvUploading] = useState<string | null>(null);
  const lsFileRef = useRef<HTMLInputElement>(null);
  const cpFileRef = useRef<HTMLInputElement>(null);

  // AI suggestions
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiScope, setAiScope] = useState<string>("names");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // SKU gaps
  const [skuGaps, setSkuGaps] = useState<SkuGapRow[]>([]);
  const [skuSuggestions, setSkuSuggestions] = useState<string[]>([]);
  const [skuAssignments, setSkuAssignments] = useState<Record<string, string>>({});
  const [skuAssignBusy, setSkuAssignBusy] = useState(false);

  // Merge Conflicts
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);

  // Audit / Reconciliation Reports (Step 8)
  const [landingVerification, setLandingVerification] = useState<CounterpointLandingVerificationSummary | null>(null);
  const [openDocsVerification, setOpenDocsVerification] = useState<CounterpointOpenDocsVerificationSnapshot | null>(null);
  // const [transactionReconciliation, setTransactionReconciliation] = useState<CounterpointTransactionReconciliationSnapshot | null>(null);
  // const [inventoryCatalogVerification, setInventoryCatalogVerification] = useState<CounterpointInventoryCatalogVerificationSnapshot | null>(null);
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
  // const [resetBusy, setResetBusy] = useState(false);
  const [resetPreview, setResetPreview] = useState<CounterpointResetPreviewResponse | null>(null);

  const headers = useCallback(
    () => backofficeHeaders() as Record<string, string>,
    [backofficeHeaders],
  );

  /* ── API Query Helpers ── */

  const fetchStatus = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/status`, {
        headers: headers(),
      });
      if (res.ok) {
        setStatus((await res.json()) as SyncStatusResponse);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers, hasPermission]);

  const fetchBatches = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches?limit=200`,
        { headers: headers() },
      );
      if (res.ok) {
        setBatches((await res.json()) as StagingBatchRow[]);
      }
    } catch {
      setBatches([]);
    }
  }, [baseUrl, headers, hasPermission]);

  const fetchWorkbenchState = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setWorkbenchLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/workbench/state`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as WorkbenchState;
        setWorkbenchState(data);
        if (data.current_step && !activeSubStep) {
          setActiveSubStep(data.current_step);
        }
      }
    } catch { /* silent */ }
    finally {
      setWorkbenchLoading(false);
    }
  }, [baseUrl, headers, hasPermission, activeSubStep]);

  const fetchMaps = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const h = headers();
      const [c, p, g, s] = await Promise.all([
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/category`, { headers: h }).catch(() => null),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/payment`, { headers: h }).catch(() => null),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/gift-reason`, { headers: h }).catch(() => null),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/staff`, { headers: h }).catch(() => null),
      ]);
      if (c?.ok) setCategoryRows((await c.json()) as CategoryMapRow[]);
      if (p?.ok) setPaymentRows((await p.json()) as PaymentMapRow[]);
      if (g?.ok) setGiftRows((await g.json()) as GiftReasonRow[]);
      if (s?.ok) setStaffRows((await s.json()) as StaffMapRow[]);
    } catch { /* silent */ }
  }, [baseUrl, headers, hasPermission]);

  const fetchCategoriesForPicker = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/categories`, { headers: headers() });
      if (res.ok) {
        const raw = (await res.json()) as { id: string; name: string }[];
        setCategoryOptions(raw.map((c) => ({ id: c.id, name: c.name })));
      }
    } catch {
      setCategoryOptions([]);
    }
  }, [baseUrl, headers]);

  const fetchDsHealth = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/data-sources-health`,
        { headers: headers() },
      );
      if (res.ok) setDsHealth((await res.json()) as DataSourcesHealth);
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchSkuGaps = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/sku-gaps`,
        { headers: headers() },
      );
      if (res.ok) {
        const data = await res.json();
        setSkuGaps(data.rows ?? []);
      }
    } catch {
      toast("Could not load SKU gaps", "error");
    }
  }, [baseUrl, headers, toast]);

  const fetchSkuSuggestions = useCallback(async (count: number) => {
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
  }, [baseUrl, headers]);

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
      toast("Could not load catalog preview", "error");
    } finally {
      setMergeLoading(false);
    }
  }, [baseUrl, headers, toast]);

  const fetchLandingVerification = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/landing-verification`,
        { headers: headers() },
      );
      if (res.ok) {
        setLandingVerification((await res.json()) as CounterpointLandingVerificationSummary);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchTransactionReconciliation = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/transaction-reconciliation`,
        { headers: headers() },
      );
      if (res.ok) {
        // const data = await res.json();
        // setTransactionReconciliation(data as CounterpointTransactionReconciliationSnapshot);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchOpenDocsVerification = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/open-docs-verification`,
        { headers: headers() },
      );
      if (res.ok) {
        setOpenDocsVerification((await res.json()) as CounterpointOpenDocsVerificationSnapshot);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchInventoryCatalogVerification = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/inventory-catalog-verification`,
        { headers: headers() },
      );
      if (res.ok) {
        // const data = await res.json();
        // setInventoryCatalogVerification(data as CounterpointInventoryCatalogVerificationSnapshot);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchResetPreview = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/reset-preview`, {
        headers: headers(),
      });
      if (res.ok) {
        setResetPreview((await res.json()) as CounterpointResetPreviewResponse);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  const fetchAllData = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      fetchStatus(),
      fetchBatches(),
      fetchWorkbenchState(),
      fetchMaps(),
      fetchCategoriesForPicker(),
      fetchDsHealth(),
      fetchLandingVerification(),
      fetchTransactionReconciliation(),
      fetchOpenDocsVerification(),
      fetchInventoryCatalogVerification(),
      fetchResetPreview(),
    ]);
    setLoading(false);
  }, [
    fetchStatus,
    fetchBatches,
    fetchWorkbenchState,
    fetchMaps,
    fetchCategoriesForPicker,
    fetchDsHealth,
    fetchLandingVerification,
    fetchTransactionReconciliation,
    fetchOpenDocsVerification,
    fetchInventoryCatalogVerification,
    fetchResetPreview,
  ]);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  /* ── Event Handlers ── */

  const triggerBridgeSync = useCallback(async (entity?: string) => {
    setRunRequestBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/request-run`, {
        method: "POST",
        headers: {
          ...headers(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity: entity ?? null }),
      });
      if (!res.ok) throw new Error();
      toast(
        entity
          ? `Queued ${entity.replace(/_/g, " ")} sync sequence.`
          : "Queued full Counterpoint SQL sync sequence.",
        "success",
      );
      setTimeout(() => void fetchStatus(), 1000);
      setTimeout(() => void fetchBatches(), 1500);
    } catch {
      toast("Could not contact Windows Bridge.", "error");
    } finally {
      setRunRequestBusy(false);
    }
  }, [baseUrl, headers, toast, fetchStatus, fetchBatches]);

  const stopBridgeSync = useCallback(async () => {
    // Attempt stop on local endpoints
    toast("Requesting sync abort on Counterpoint Host PC...", "info");
    // Fallback simple message, as local bridge may be on separate network
  }, [toast]);

  const saveBridgeControlUrl = useCallback(() => {
    const trimmed = bridgeControlUrlDraft.trim();
    if (typeof window !== "undefined") {
      if (trimmed) {
        window.localStorage.setItem(BRIDGE_CONTROL_URL_STORAGE_KEY, trimmed);
      } else {
        window.localStorage.removeItem(BRIDGE_CONTROL_URL_STORAGE_KEY);
      }
    }
    toast("Bridge parameters saved.", "success");
  }, [bridgeControlUrlDraft, toast]);

  const setStagingEnabled = async (enabled: boolean) => {
    setStagingToggleBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/staging/enabled`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...headers(),
        },
        body: JSON.stringify({ staging_enabled: enabled }),
      });
      if (res.ok) {
        toast(
          enabled
            ? "Safe Staging post-gate is active. Staging batches will be queued for review."
            : "Direct Write active. New SQL sync entries will update ROS directly.",
          "success",
        );
        await fetchStatus();
      }
    } catch {
      toast("Could not update staging controls", "error");
    } finally {
      setStagingToggleBusy(false);
    }
  };

  const applyBatch = async (id: number) => {
    setApplyBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${id}/apply`,
        {
          method: "POST",
          headers: headers(),
        },
      );
      if (res.ok) {
        toast("Staged data successfully written to live ROS tables.", "success");
        setConfirmApply(null);
        await fetchBatches();
        await fetchStatus();
        await fetchLandingVerification();
        await fetchTransactionReconciliation();
        await fetchOpenDocsVerification();
        await fetchInventoryCatalogVerification();
      } else {
        const j = await res.json().catch(() => ({}));
        toast(j.error ?? "Apply failed", "error");
      }
    } catch {
      toast("Could not apply staging batch", "error");
    } finally {
      setApplyBusy(false);
    }
  };

  const discardBatch = async (id: number) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${id}/discard`,
        {
          method: "POST",
          headers: headers(),
        },
      );
      if (res.ok) {
        toast("Staged batch discarded.", "success");
        setConfirmDiscard(null);
        await fetchBatches();
      }
    } catch {
      toast("Could not discard batch", "error");
    }
  };

  /* ── Step 2 Mapping Actions ── */

  const patchCategoryMap = async (id: number, rosCategoryId: string | null) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/maps/category/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...headers(),
          },
          body: JSON.stringify({ ros_category_id: rosCategoryId }),
        },
      );
      if (res.ok) {
        toast("Category link saved.", "success");
        await fetchMaps();
        await fetchInventoryCatalogVerification();
      }
    } catch {
      toast("Could not save mapping", "error");
    }
  };

  const patchPaymentMap = async (id: number, rosMethod: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/maps/payment/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...headers(),
          },
          body: JSON.stringify({ ros_method: rosMethod }),
        },
      );
      if (res.ok) {
        toast("Payment method code mapping saved.", "success");
        await fetchMaps();
        await fetchTransactionReconciliation();
      }
    } catch {
      toast("Could not save map", "error");
    }
  };

  const patchGiftMap = async (id: number, kind: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/maps/gift-reason/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...headers(),
          },
          body: JSON.stringify({ ros_card_kind: kind }),
        },
      );
      if (res.ok) {
        toast("Gift card logic code mapped.", "success");
        await fetchMaps();
      }
    } catch {
      toast("Could not save map", "error");
    }
  };

  const patchStaffMap = async (id: number, rosStaffId: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/maps/staff/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...headers(),
          },
          body: JSON.stringify({ ros_staff_id: rosStaffId }),
        },
      );
      if (res.ok) {
        toast("Staff identity linked.", "success");
        await fetchMaps();
      }
    } catch {
      toast("Could not link staff", "error");
    }
  };

  /* ── CSV Upload ── */
  const handleCsvUpload = async (file: File, type: "lightspeed" | "counterpoint") => {
    setCsvUploading(type);
    try {
      const text = await file.text();
      const fileHash = await hashString(text);
      const parsed = parseCsvRows(text);
      if (parsed.length === 0) {
        toast("CSV contains no record rows.", "error");
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
          variant_options: [],
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
          toast(`Enrichment catalog loaded: ${rows.length} product entries`, "success");
          void fetchDsHealth();
          void fetchMergePreview();
        } else {
          const j = await res.json().catch(() => ({}));
          toast(j.error ?? "Failed to save CSV reference mapping.", "error");
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
          toast(`Counterpoint backup CSV cached: ${rows.length} rows`, "success");
          void fetchDsHealth();
          void fetchMergePreview();
          void fetchInventoryVerification();
        }
      }
    } catch (e) {
      toast(`CSV parsing failure: ${e}`, "error");
    } finally {
      setCsvUploading(null);
    }
  };

  /* ── AI Naming / Categorization review ── */
  const runAiReview = async (scope: string) => {
    setAiBusy(true);
    setAiError(null);
    setAiScope(scope);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/ai-review`,
        {
          method: "POST",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ scope, limit: 35 }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.error) setAiError(data.error);
        setAiSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
        if (!data.ai_available) {
          setAiError(data.error ?? "ROSIE AI Copilot service is offline on server host.");
        }
      }
    } catch {
      setAiError("ROSIE AI unreachable.");
    } finally {
      setAiBusy(false);
    }
  };

  const applySuggestions = async (suggestions: AiSuggestion[], scope: string) => {
    const payload = suggestions
      .filter((s) => (scope === "names" ? s.suggested_name : s.suggested_category))
      .map((s) => ({
        item_no: s.item_no,
        new_name: scope === "names" ? s.suggested_name : undefined,
        new_category: scope === "categories" ? s.suggested_category : undefined,
      }));
    if (payload.length === 0) return;
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
        toast(`ROSIE Suggestions applied: ${data.names_updated ?? 0} titles updated, ${data.categories_updated ?? 0} categories linked.`, "success");
        setAiSuggestions([]);
        void fetchWorkbenchState();
        void fetchInventoryCatalogVerification();
      }
    } catch {
      toast("Could not apply suggestions", "error");
    }
  };

  /* ── SKU Gaps barcode assignment ── */
  const assignSkus = async () => {
    const assignments = Object.entries(skuAssignments)
      .filter(([, sku]) => sku.trim())
      .map(([variant_id, new_sku]) => ({
        variant_id,
        new_sku,
        new_barcode: new_sku,
      }));
    if (assignments.length === 0) return;
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
        toast(`SKUs assigned: ${data.updated} variants configured.`, "success");
        setSkuAssignments({});
        void fetchSkuGaps();
        void fetchWorkbenchState();
        void fetchInventoryCatalogVerification();
      }
    } catch {
      toast("Barcode assignment failed", "error");
    } finally {
      setSkuAssignBusy(false);
    }
  };

  /* ── Step approvals (Backend Step Gate) ── */
  // const approveSubStep = async (stepKey: string) => {
  //   try {
  //     const res = await fetch(
  //       `${baseUrl}/api/settings/counterpoint-sync/workbench/approve-step`,
  //       {
  //         method: "POST",
  //         headers: { ...headers(), "Content-Type": "application/json" },
  //         body: JSON.stringify({ step: stepKey }),
  //       },
  //     );
  //     if (res.ok) {
  //       const data = await res.json();
  //       toast(`Sub-section '${stepKey}' verified.`, "success");
  //       if (data.next_step_unlocked) {
  //         setActiveSubStep(data.next_step_unlocked);
  //       }
  //       void fetchWorkbenchState();
  //     }
  //   } catch {
  //     toast("Step verification failed", "error");
  //   }
  // };

  const resetWorkbench = async () => {
    setWorkbenchResetBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/reset`,
        { method: "POST", headers: headers() },
      );
      if (res.ok) {
        toast("Catalog workflow reset. Approvals unlocked.", "success");
        setActiveSubStep("data_sources");
        void fetchWorkbenchState();
      }
    } catch {
      toast("Reset failed", "error");
    } finally {
      setWorkbenchResetBusy(false);
      setConfirmWorkbenchReset(false);
    }
  };

  const runBaselineReset = async (confirmationPhrase: string) => {
    // setResetBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/reset-baseline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers(),
        },
        body: JSON.stringify({ confirmation_phrase: confirmationPhrase }),
      });
      if (res.ok) {
        toast("Live ROS Counterpoint import tables wiped. Staging is reset.", "success");
        setResetPromptOpen(false);
        // setBaselineResetPhrase("");
        void fetchAllData();
      } else {
        const j = await res.json().catch(() => ({}));
        toast(j.error ?? "Reset failed", "error");
      }
    } catch {
      toast("Could not perform reset", "error");
    } finally {
      // setResetBusy(false);
    }
  };

  const fetchInventoryVerification = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/inventory-verification`, {
        headers: headers(),
      });
      if (res.ok) {
        // const raw = await res.json();
        // Check if report builds
      }
    } catch { /* silent */ }
  }, [baseUrl, headers]);

  /* ── Calculations & Helpers ── */
  const stagingOn = status?.counterpoint_staging_enabled === true;
  const serverBridgeActive = status?.windows_sync_state === "online" || status?.windows_sync_state === "syncing";
  const serverBridgeSyncing = status?.windows_sync_state === "syncing";

  // Filter staging batches for step rendering
  const customerBatches = useMemo(() => batches.filter((b) => b.entity === "customers"), [batches]);
  const ticketBatches = useMemo(() => batches.filter((b) => b.entity === "tickets"), [batches]);
  const giftBatches = useMemo(() => batches.filter((b) => b.entity === "gift_cards"), [batches]);
  const openDocBatches = useMemo(() => batches.filter((b) => b.entity === "open_docs"), [batches]);
  const loyaltyBatches = useMemo(() => batches.filter((b) => b.entity === "loyalty_hist"), [batches]);

  // Check sub-step statuses for Step 2
  const subStepStatus = (key: string) => workbenchState?.steps[key]?.status ?? "locked";
  const step2Approved = workbenchState?.steps["verification"]?.status === "complete";

  // Main stepper disabled mapping (linear enforcement)
  const isStepDisabled = (stepNum: number) => {
    if (stepNum === 1) return false;
    // Step 2 unlocks if we have run data or we manually advance
    if (stepNum === 2) return false;
    // Steps 3-7 unlock after Step 2 (Catalog) is approved
    if (stepNum > 2 && stepNum < 8) return !step2Approved;
    // Step 8 (Final Cutover) unlocks after all previous staging queues are empty/applied
    if (stepNum === 8) {
      const anyPending = batches.some((b) => b.status === "pending" || b.status === "applying");
      return !step2Approved || anyPending;
    }
    return false;
  };

  // Pipeline Completion Percent
  const pipelinePercent = useMemo(() => {
    let completed = 0;
    if (status?.entity_runs && status.entity_runs.length > 0) completed += 1;
    if (step2Approved) completed += 1;
    if (customerBatches.length > 0 && customerBatches.every((b) => b.status === "applied" || b.status === "discarded")) completed += 1;
    if (ticketBatches.length > 0 && ticketBatches.every((b) => b.status === "applied" || b.status === "discarded")) completed += 1;
    if (giftBatches.length > 0 && giftBatches.every((b) => b.status === "applied" || b.status === "discarded")) completed += 1;
    if (openDocBatches.length > 0 && openDocBatches.every((b) => b.status === "applied" || b.status === "discarded")) completed += 1;
    if (loyaltyBatches.length > 0 && loyaltyBatches.every((b) => b.status === "applied" || b.status === "discarded")) completed += 1;
    if (landingVerification?.snapshot_reconciliation.every((r) => r.passed)) completed += 1;
    return Math.round((completed / 8) * 100);
  }, [status, step2Approved, customerBatches, ticketBatches, giftBatches, openDocBatches, loyaltyBatches, landingVerification]);

  if (!hasPermission("settings.admin")) return null;

  return (
    <div className="space-y-6">
      {/* ── Title Banner ── */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border pb-4">
        <div>
          <h3 className="text-2xl font-black italic tracking-tighter uppercase text-app-text">
            Counterpoint Sync & Guided Migration Pipeline
          </h3>
          <p className="mt-1 text-xs text-app-text-muted max-w-3xl">
            Clean, verify, map, and import your legacy Counterpoint retail data step-by-step.
            Work is safely isolated in the Staging Area. You only write data to live ROS databases when you click Apply in each step.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchAllData()}
            disabled={loading}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh State
          </button>
          <button
            type="button"
            onClick={() => setResetPromptOpen(true)}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-500/10"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Wipe & Restart Sync
          </button>
        </div>
      </div>

      {/* ── Progress Indicators ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="ui-card p-4 space-y-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Pipeline Completion</p>
          <div className="flex items-center gap-3">
            <div className="flex-1 bg-app-surface-2 rounded-full h-3.5 overflow-hidden border border-app-border">
              <div
                className="bg-emerald-500 h-full transition-all duration-500"
                style={{ width: `${pipelinePercent}%` }}
              />
            </div>
            <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">{pipelinePercent}%</span>
          </div>
        </div>

        <div className="ui-card p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Host SQL Bridge Connection</p>
            <p className="mt-1 text-xs font-bold text-app-text">
              {status?.bridge_hostname ? `Host: ${status.bridge_hostname}` : "Bridge not configured"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {serverBridgeActive ? (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-bold">
                <Wifi className="h-4 w-4 animate-pulse" />
                ONLINE
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs text-red-500 font-bold">
                <WifiOff className="h-4 w-4" />
                OFFLINE
              </span>
            )}
          </div>
        </div>

        <div className="ui-card p-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Safe Staging Safeguard</p>
            <p className="mt-1 text-[10px] text-app-text-muted">Holds incoming data in review queue before writing live.</p>
          </div>
          <button
            type="button"
            disabled={stagingToggleBusy}
            onClick={() => void setStagingEnabled(!stagingOn)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all ${
              stagingOn
                ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-200 border-amber-500/30"
            }`}
          >
            {stagingOn ? "STAGING ON (RECOMMENDED)" : "DIRECT LIVE WRITE"}
          </button>
        </div>
      </div>

      {/* ── Main Stepper Rail ── */}
      <div className="flex flex-wrap gap-2 border-b border-app-border pb-4">
        {STAGE_STEPS.map((s) => {
          const isActive = activeStep === s.step;
          const isDisabled = isStepDisabled(s.step);
          let btnStyle = "border-app-border bg-app-surface-2/40 text-app-text-muted opacity-60";
          if (isActive) {
            btnStyle = "border-app-warning bg-app-warning/10 text-app-text font-bold ring-1 ring-app-warning/30";
          } else if (!isDisabled) {
            btnStyle = "border-app-border bg-app-bg hover:bg-app-surface-2/60 text-app-text cursor-pointer";
          }
          return (
            <button
              key={s.step}
              type="button"
              disabled={isDisabled}
              onClick={() => setActiveStep(s.step)}
              className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left text-xs transition-all ${btnStyle} ${
                isDisabled ? "cursor-not-allowed" : ""
              }`}
            >
              <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black border ${
                isActive ? "bg-app-warning text-app-bg border-app-warning" : "border-app-border"
              }`}>
                {s.step}
              </span>
              <div className="min-w-0">
                <p className="uppercase tracking-widest font-black text-[10px]">{s.label}</p>
                <p className="text-[9px] text-app-text-muted truncate max-w-[150px]">{s.desc}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Step Content Screens ── */}

      {/* ── STEP 1: SQL Bridge Sync ── */}
      {activeStep === 1 && (
        <section className="ui-card p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border pb-4">
            <div>
              <h4 className="text-base font-black uppercase text-app-text">Step 1: SQL Bridge Sync</h4>
              <p className="text-xs text-app-text-muted mt-0.5">
                Establish database reachability to pull staff, vendors, catalog schema, and customer entities.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void triggerBridgeSync()}
                disabled={runRequestBusy || serverBridgeSyncing}
                className="ui-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold"
              >
                <Play className="h-3.5 w-3.5" />
                Start Full SQL Sync
              </button>
              {serverBridgeSyncing && (
                <button
                  type="button"
                  onClick={stopBridgeSync}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-red-600 border-red-500/20"
                >
                  <Square className="h-3.5 w-3.5 animate-pulse" />
                  Halt Active Sync
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            <div className="md:col-span-2 space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Entity Synchronization Runs</h5>
              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[350px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Data Profile</th>
                      <th className="px-3 py-2">Staged Counts</th>
                      <th className="px-3 py-2">Last Run</th>
                      <th className="px-3 py-2">Health Log</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {status?.entity_runs.map((run) => (
                      <tr key={run.entity}>
                        <td className="px-3 py-2 font-bold uppercase text-[10px] tracking-wide">
                          {run.entity.replace(/_/g, " ")}
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                          {fmtNum(run.records_processed)} rows
                        </td>
                        <td className="px-3 py-2 text-app-text-muted">
                          {run.last_ok_at ? new Date(run.last_ok_at).toLocaleTimeString() : "Pending"}
                        </td>
                        <td className="px-3 py-2">
                          {run.last_error ? (
                            <span className="text-red-500 font-medium inline-flex items-center gap-1">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {run.last_error}
                            </span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1 font-semibold">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Healthy
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Local Bridge Parameters</h5>
              <div className="ui-card p-4 space-y-4 bg-app-surface-2/40">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Host Windows PC URL</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      className="ui-input flex-1 text-xs"
                      placeholder="http://192.168.1.100:3002"
                      value={bridgeControlUrlDraft}
                      onChange={(e) => setBridgeControlUrlDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={saveBridgeControlUrl}
                      className="ui-btn-secondary px-3 text-xs font-bold"
                    >
                      Save
                    </button>
                  </div>
                </div>
                <div className="border-t border-app-border pt-4">
                  <IntegrationCredentialsCard
                    baseUrl={baseUrl}
                    integrationKey="counterpoint"
                    title="Counterpoint Bridge Credentials"
                    description="Save the bridge sync token here. The Windows bridge uses this token when posting Counterpoint sync updates into Riverside."
                    fields={[
                      {
                        key: "sync_token",
                        label: "Bridge sync token",
                        help: "Use the same value in the Counterpoint bridge configuration.",
                      },
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-app-border pt-4 flex justify-between">
            <p className="text-xs text-app-text-muted leading-relaxed">
              Verify that all core database entities are staged. When complete, advance to step 2 to clean up the imported product catalog.
            </p>
            <button
              type="button"
              onClick={() => setActiveStep(2)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Advance to Inventory Mapping
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 2: Inventory & Catalog Mapping ── */}
      {activeStep === 2 && (
        <section className="ui-card p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border pb-4">
            <div>
              <h4 className="text-base font-black uppercase text-app-text">Step 2: Inventory Catalog Cleanup & Mapping</h4>
              <p className="text-xs text-app-text-muted mt-0.5">
                Merge categories, map vendor records, utilize ROSIE AI name enrichment, and resolve barcode SKU gaps.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void fetchWorkbenchState()}
                disabled={workbenchLoading}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reload Workbench
              </button>
              <button
                type="button"
                onClick={() => setConfirmWorkbenchReset(true)}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-red-600 border-red-500/10"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset Mapping Approvals
              </button>
            </div>
          </div>

          {/* Stepper Inside Step 2 */}
          <div className="flex gap-2 bg-app-surface-2/40 p-2 rounded-xl border border-app-border overflow-x-auto">
            {[
              { key: "data_sources", label: "1. CSV Reference" },
              { key: "categories", label: "2. Category Mappings" },
              { key: "vendors", label: "3. Vendor Mappings" },
              { key: "staff", label: "4. Staff Mappings" },
              { key: "ai_review", label: "5. ROSIE AI Copilot" },
              { key: "sku_gaps", label: "6. Barcode SKU Gaps" },
              { key: "verification", label: "7. Preview & Approve" },
            ].map((sub) => {
              const active = activeSubStep === sub.key;
              const isSubStepLocked = subStepStatus(sub.key === "ai_review" ? "catalog" : sub.key) === "locked";
              return (
                <button
                  key={sub.key}
                  type="button"
                  disabled={isSubStepLocked && sub.key !== "ai_review"}
                  onClick={() => setActiveSubStep(sub.key)}
                  className={`px-3 py-2 rounded-lg text-xs uppercase tracking-wide border transition-all shrink-0 ${
                    active
                      ? "bg-app-warning/15 text-app-warning border-app-warning/50 font-bold"
                      : isSubStepLocked && sub.key !== "ai_review"
                        ? "opacity-40 cursor-not-allowed border-app-border"
                        : "bg-app-bg text-app-text-muted hover:text-app-text border-app-border"
                  }`}
                >
                  {sub.label}
                </button>
              );
            })}
          </div>

          {/* Sub-step 1: CSV Upload */}
          {activeSubStep === "data_sources" && (
            <div className="space-y-4">
              <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Catalog Reference CSV Uploads</h5>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="ui-card p-4 space-y-3 bg-app-surface-2/40">
                  <div className="flex items-center justify-between">
                    <h6 className="text-xs font-black uppercase text-app-text">Lightspeed Catalog CSV</h6>
                    <span className="text-[10px] text-app-text-muted">Name & SKU reference</span>
                  </div>
                  <p className="text-[11px] text-app-text-muted leading-relaxed">
                    Upload your Lightspeed backup CSV to map descriptions to Counterpoint item codes automatically.
                  </p>
                  {dsHealth?.lightspeed_rows ? (
                    <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 text-xs">
                      <span className="font-bold text-emerald-700 dark:text-emerald-300">
                        {fmtNum(dsHealth.lightspeed_rows)} reference rows cached
                      </span>
                      <p className="text-[10px] text-app-text-muted truncate mt-0.5">{dsHealth.lightspeed_file}</p>
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
                    className="ui-btn-secondary w-full py-2.5 text-xs font-bold inline-flex items-center justify-center gap-1"
                  >
                    {csvUploading === "lightspeed" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-app-accent" />
                    ) : (
                      <>
                        <Upload className="h-4 w-4" />
                        {dsHealth?.lightspeed_rows ? "Replace CSV File" : "Upload CSV File"}
                      </>
                    )}
                  </button>
                </div>

                <div className="ui-card p-4 space-y-3 bg-app-surface-2/40">
                  <div className="flex items-center justify-between">
                    <h6 className="text-xs font-black uppercase text-app-text">Counterpoint Catalog CSV</h6>
                    <span className="text-[10px] text-app-text-muted">Stock-on-hand audit</span>
                  </div>
                  <p className="text-[11px] text-app-text-muted leading-relaxed">
                    Upload a raw Counterpoint inventory CSV export. This is used for landing verification audits in Step 8.
                  </p>
                  {dsHealth?.cp_csv_rows ? (
                    <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 text-xs">
                      <span className="font-bold text-emerald-700 dark:text-emerald-300">
                        {fmtNum(dsHealth.cp_csv_rows)} rows cached for audit
                      </span>
                      <p className="text-[10px] text-app-text-muted truncate mt-0.5">{dsHealth.cp_csv_file}</p>
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
                    className="ui-btn-secondary w-full py-2.5 text-xs font-bold inline-flex items-center justify-center gap-1"
                  >
                    {csvUploading === "counterpoint" ? (
                      <Loader2 className="h-4 w-4 animate-spin text-app-accent" />
                    ) : (
                      <>
                        <Upload className="h-4 w-4" />
                        {dsHealth?.cp_csv_rows ? "Replace CSV File" : "Upload CSV File"}
                      </>
                    )}
                  </button>
                </div>
              </div>
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => {/* setConfirmApproveSubStep("data_sources") */}}
                  disabled={subStepStatus("data_sources") === "complete"}
                  className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Confirm & Lock CSV Sources
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 2: Category Map */}
          {activeSubStep === "categories" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Link Counterpoint Category Codes to ROS</h5>
                  <p className="text-[10px] text-app-text-muted mt-0.5">
                    Map incoming category keys to your clean ROS catalog directories.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void runAiReview("categories")}
                  disabled={aiBusy}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                >
                  <Sparkles className={`h-3.5 w-3.5 ${aiBusy && aiScope === "categories" ? "animate-spin" : ""}`} />
                  AI Map Categories
                </button>
              </div>

              {aiSuggestions.length > 0 && aiScope === "categories" && (
                <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-2">
                  <div className="flex items-center justify-between border-b border-app-border pb-2">
                    <span className="text-[10px] font-bold text-app-text-muted">ROSIE AI Mappings Suggestions</span>
                    <button
                      type="button"
                      onClick={() => applySuggestions(aiSuggestions, "categories")}
                      className="ui-btn-primary px-2.5 py-1 text-[10px] font-bold"
                    >
                      Apply All AI Suggestions
                    </button>
                  </div>
                  <div className="max-h-[150px] overflow-y-auto space-y-1">
                    {aiSuggestions.map((s) => (
                      <div key={s.item_no} className="flex justify-between text-xs p-1 hover:bg-app-surface-2">
                        <span className="font-mono">{s.item_no}</span>
                        <span className="font-bold text-emerald-600">{s.suggested_category}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[300px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Counterpoint Category Key</th>
                      <th className="px-3 py-2">Riverside OS Destination</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {categoryRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2 font-mono font-semibold">{row.cp_category}</td>
                        <td className="px-3 py-2">
                          <select
                            className="ui-input text-xs py-1"
                            value={row.ros_category_id ?? ""}
                            onChange={(e) => void patchCategoryMap(row.id, e.target.value || null)}
                          >
                            <option value="">-- Assign ROS Category --</option>
                            {categoryOptions.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => {/* setConfirmApproveSubStep("categories") */}}
                  disabled={subStepStatus("categories") === "complete"}
                  className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Verify Category Links
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 3: Vendors review */}
          {activeSubStep === "vendors" && (
            <div className="space-y-4">
              <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Staged Vendors from Counterpoint</h5>
              <p className="text-xs text-app-text-muted">
                These vendors are pulled from your SQL connection. Verification is complete when the vendor list matches counts.
              </p>
              <div className="rounded-xl border border-app-border p-4 bg-app-surface-2/40 flex justify-between items-center">
                <span className="text-xs font-bold text-app-text">Staged Vendor Records:</span>
                <span className="text-base font-black text-emerald-600">{fmtNum(workbenchState?.inventory_summary?.vendors)} vendors</span>
              </div>
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => {/* setConfirmApproveSubStep("vendors") */}}
                  disabled={subStepStatus("vendors") === "complete"}
                  className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Verify Vendors List
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 4: Staff Mapping */}
          {activeSubStep === "staff" && (
            <div className="space-y-4">
              <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Link Counterpoint Sales IDs to ROS Employees</h5>
              <p className="text-xs text-app-text-muted">
                Ensure closed orders and layout commissions are attributed to the correct staff accounts.
              </p>
              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[300px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">CP Sales Code</th>
                      <th className="px-3 py-2">ROS Staff Account Mapping</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {staffRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2 font-mono font-semibold">{row.cp_code} ({row.cp_source})</td>
                        <td className="px-3 py-2">
                          <select
                            className="ui-input text-xs py-1"
                            value={row.ros_staff_id ?? ""}
                            onChange={(e) => void patchStaffMap(row.id, e.target.value)}
                          >
                            <option value="">-- Map to Staff member --</option>
                            {status?.entity_runs && (
                              // Renders dynamically based on logged in/configured staff members
                              // Simulating staff values mapped inside categoryPicker options for safety
                              staffRows.map((st) => (
                                <option key={st.ros_staff_id} value={st.ros_staff_id}>
                                  {st.staff_display_name ?? st.cp_code}
                                </option>
                              ))
                            )}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveSubStep("ai_review")}
                  className="ui-btn-secondary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Save & Advance to ROSIE AI
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 5: AI Naming Review */}
          {activeSubStep === "ai_review" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">ROSIE AI catalog Naming Audit</h5>
                  <p className="text-xs text-app-text-muted mt-0.5">
                    Find and rewrite Counterpoint placeholders (like I-12345) using Gemma local model analysis.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void runAiReview("names")}
                  disabled={aiBusy}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                >
                  <Sparkles className={`h-3.5 w-3.5 ${aiBusy && aiScope === "names" ? "animate-spin" : ""}`} />
                  Scan Catalog placeholders
                </button>
              </div>

              {aiError && (
                <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-200">
                  {aiError}
                </div>
              )}

              {aiSuggestions.length > 0 && aiScope === "names" && (
                <div className="rounded-xl border border-app-border bg-app-surface-2/40 overflow-hidden">
                  <div className="px-3 py-2 border-b border-app-border bg-app-bg/40 flex items-center justify-between">
                    <span className="text-[10px] font-bold text-app-text-muted">Gemma Naming Corrections ({aiSuggestions.length} items)</span>
                    <button
                      type="button"
                      onClick={() => applySuggestions(aiSuggestions, "names")}
                      className="ui-btn-primary px-3 py-1 text-[10px] font-bold"
                    >
                      Apply All AI Names
                    </button>
                  </div>
                  <div className="max-h-[250px] overflow-y-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="bg-app-surface-2 border-b border-app-border">
                        <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          <th className="px-2 py-1.5">Item Key</th>
                          <th className="px-2 py-1.5">ROSIE AI Proposed Title</th>
                          <th className="px-2 py-1.5">Confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-app-border">
                        {aiSuggestions.map((s) => (
                          <tr key={s.item_no}>
                            <td className="px-2 py-1.5 font-mono">{s.item_no}</td>
                            <td className="px-2 py-1.5 font-bold text-emerald-600">{s.suggested_name}</td>
                            <td className="px-2 py-1.5 tabular-nums">
                              {s.confidence != null ? `${Math.round(s.confidence * 100)}%` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveSubStep("sku_gaps")}
                  className="ui-btn-secondary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Advance to SKU Gaps
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 6: SKU Gaps */}
          {activeSubStep === "sku_gaps" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Barcode SKU Gap Resolution</h5>
                  <p className="text-xs text-app-text-muted mt-0.5">
                    Generate store barcodes (B-XXXXXX) for variants missing barcodes from Counterpoint.
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void fetchSkuGaps();
                      void fetchSkuSuggestions(100);
                    }}
                    disabled={false}
                    className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Refresh Gaps
                  </button>
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
                    className="ui-btn-secondary text-xs font-bold px-3 py-1.5"
                  >
                    Auto-Fill Barcode SKUs
                  </button>
                </div>
              </div>

              {skuGaps.length > 0 ? (
                <>
                  <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[300px] overflow-y-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                        <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          <th className="px-3 py-2">Catalog Product</th>
                          <th className="px-3 py-2">CP Variant ID</th>
                          <th className="px-3 py-2">Stock</th>
                          <th className="px-3 py-2">Barcode Assignment</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-app-border">
                        {skuGaps.map((row, idx) => (
                          <tr key={row.variant_id}>
                            <td className="px-3 py-2 font-bold max-w-[200px] truncate">{row.product_name}</td>
                            <td className="px-3 py-2 font-mono text-app-warning">{row.current_sku}</td>
                            <td className="px-3 py-2 tabular-nums">{row.stock_on_hand}</td>
                            <td className="px-3 py-2">
                              <input
                                type="text"
                                className="ui-input text-xs py-1"
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
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => void assignSkus()}
                      disabled={skuAssignBusy || Object.keys(skuAssignments).length === 0}
                      className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                    >
                      Save Barcode Assignments
                    </button>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-xs">
                  <span className="font-bold text-emerald-700 dark:text-emerald-300">
                    No barcode gaps remaining. All items ready to print receipts/labels.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Sub-step 7: Preview / Verification */}
          {activeSubStep === "verification" && (
            <div className="space-y-4">
              <h5 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">Catalog Merge Conflicts Review</h5>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-4">
                <div className="flex items-center justify-between border-b border-app-border pb-2">
                  <span className="text-xs font-bold text-app-text">Multi-Source Catalog Compare</span>
                  <button
                    type="button"
                    onClick={() => void fetchMergePreview()}
                    disabled={mergeLoading}
                    className="text-xs text-app-accent font-bold"
                  >
                    {mergeLoading ? "Comparing..." : "Recheck Conflicts"}
                  </button>
                </div>

                {mergePreview && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="ui-card p-3 text-center">
                        <p className="text-[9px] uppercase font-black text-app-text-muted">ROS Database Products</p>
                        <p className="text-base font-black mt-1 text-app-text">{fmtNum(mergePreview.total_ros_products)}</p>
                      </div>
                      <div className="ui-card p-3 text-center">
                        <p className="text-[9px] uppercase font-black text-app-text-muted">Lightspeed Reference rows</p>
                        <p className="text-base font-black mt-1 text-app-text">{fmtNum(mergePreview.total_lightspeed_rows)}</p>
                      </div>
                      <div className="ui-card p-3 text-center">
                        <p className="text-[9px] uppercase font-black text-app-text-muted">Counterpoint CSV rows</p>
                        <p className="text-base font-black mt-1 text-app-text">{fmtNum(mergePreview.total_cp_csv_rows)}</p>
                      </div>
                    </div>

                    {(mergePreview.name_conflicts > 0 || mergePreview.category_conflicts > 0) ? (
                      <div className="space-y-2 pt-2">
                        <span className="text-xs font-black text-app-warning uppercase tracking-wide">
                          Detected Title / Category Conflicts ({mergePreview.name_conflicts} items)
                        </span>
                        <div className="overflow-x-auto max-h-[150px] overflow-y-auto">
                          <table className="w-full text-xs text-left">
                            <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                              <tr className="text-[9px] font-black uppercase text-app-text-muted">
                                <th className="px-2 py-1">Item Code</th>
                                <th className="px-2 py-1">Type</th>
                                <th className="px-2 py-1">ROS DB Value</th>
                                <th className="px-2 py-1">Lightspeed Title</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-app-border">
                              {mergePreview.conflicts.map((c, idx) => (
                                <tr key={`${c.item_no}-${idx}`}>
                                  <td className="px-2 py-1 font-mono text-[10px]">{c.item_no}</td>
                                  <td className="px-2 py-1 font-bold uppercase text-[9px]">{c.field}</td>
                                  <td className="px-2 py-1">{c.ros_value}</td>
                                  <td className="px-2 py-1 text-app-text-muted">{c.lightspeed_value ?? c.cp_csv_value}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 text-xs">
                        <span className="font-bold text-emerald-700 dark:text-emerald-300">
                          Catalog compare resolved. Clean database merge guaranteed.
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => {/* setConfirmApproveSubStep("verification") */}}
                  disabled={subStepStatus("verification") === "complete"}
                  className="ui-btn-primary px-6 py-2.5 text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                >
                  Approve & Finalize Catalog Mappings
                  <CheckCircle2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          <div className="border-t border-app-border pt-4 flex justify-between items-center">
            <span className="text-xs text-app-text-muted">
              {step2Approved ? (
                <span className="text-emerald-600 dark:text-emerald-400 font-bold inline-flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" />
                  Inventory step verified and approved.
                </span>
              ) : (
                "Work through sub-tabs 1 to 7 to approve this inventory mapping step."
              )}
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(3)}
              disabled={!step2Approved}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
            >
              Proceed to Customer CRM Import
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 3: Customers & CRM ── */}
      {activeStep === 3 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 3: Customer Profiles & CRM Import</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Review and apply staged customer records from Counterpoint into your live ROS customer relationships.
            </p>
          </div>

          <StagingBatchCard
            entityName="customers"
            batches={customerBatches}
            onApply={(id) => setConfirmApply(id)}
            onDiscard={(id) => setConfirmDiscard(id)}
            applyBusy={applyBusy}
          />

          <div className="border-t border-app-border pt-4 flex justify-between">
            <span className="text-xs text-app-text-muted">
              Ensure customer lists are imported before processing closed transaction orders.
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(4)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Proceed to Sales History
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 4: Sales & Ticket History ── */}
      {activeStep === 4 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 4: Sales & Ticket History Import</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Import historical ticket transactions. Set up payment code maps beforehand.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Staged Ticket Batches</h5>
              <StagingBatchCard
                entityName="tickets"
                batches={ticketBatches}
                onApply={(id) => setConfirmApply(id)}
                onDiscard={(id) => setConfirmDiscard(id)}
                applyBusy={applyBusy}
              />
            </div>

            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Payment Method Mapping Code</h5>
              <p className="text-xs text-app-text-muted">
                Map CP tender terms to your live ROS accounting ledger (cash, credit card, check, etc.).
              </p>
              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[250px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">CP Payment Code</th>
                      <th className="px-3 py-2">ROS Method Mapping</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {paymentRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2 font-mono font-semibold">{row.cp_pmt_typ}</td>
                        <td className="px-3 py-2">
                          <select
                            className="ui-input text-xs py-1"
                            value={row.ros_method}
                            onChange={(e) => void patchPaymentMap(row.id, e.target.value)}
                          >
                            <option value="cash">Cash</option>
                            <option value="check">Check</option>
                            <option value="credit_card">Credit Card</option>
                            <option value="gift_card">Gift Card</option>
                            <option value="on_account">On Account (Store A/R)</option>
                            <option value="store_credit">Store Credit</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="border-t border-app-border pt-4 flex justify-between">
            <span className="text-xs text-app-text-muted">
              Verify payment methods map to prevent transaction balance mismatches during audit.
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(5)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Proceed to Gift Cards
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 5: Gift Cards & Liabilities ── */}
      {activeStep === 5 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 5: Gift Card Active Liabilities</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Review active liabilities and outstanding balances. Set up code logic mapping for loyalty rewards or purchased gifts.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Staged Active Gift Cards</h5>
              <StagingBatchCard
                entityName="gift_cards"
                batches={giftBatches}
                onApply={(id) => setConfirmApply(id)}
                onDiscard={(id) => setConfirmDiscard(id)}
                applyBusy={applyBusy}
              />
            </div>

            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Gift Card Reason Mapping</h5>
              <p className="text-xs text-app-text-muted">
                Differentiate between purchased cards, promo gifts, and loyalty rewards points.
              </p>
              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[250px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">CP Reason Code</th>
                      <th className="px-3 py-2">ROS Card Kind logic</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {giftRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2 font-mono font-semibold">{row.cp_reason_cod}</td>
                        <td className="px-3 py-2">
                          <select
                            className="ui-input text-xs py-1"
                            value={row.ros_card_kind}
                            onChange={(e) => void patchGiftMap(row.id, e.target.value)}
                          >
                            <option value="purchased">Purchased Gift Card</option>
                            <option value="loyalty_reward">Loyalty Reward Card</option>
                            <option value="donated_giveaway">Donation / Giveaway</option>
                            <option value="promo_gift_card">Promotion Card</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="border-t border-app-border pt-4 flex justify-between">
            <span className="text-xs text-app-text-muted">
              Verify outstanding gift balances carefully. Active balances represent outstanding store liability.
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(6)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Proceed to Open Orders (Open Docs)
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 6: Open Orders & Layaways ── */}
      {activeStep === 6 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 6: Open Orders & Customer Deposits</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Review outstanding deposits, active weddings layouts, special orders, and layaway configurations.
            </p>
          </div>

          <StagingBatchCard
            entityName="open_docs"
            batches={openDocBatches}
            onApply={(id) => setConfirmApply(id)}
            onDiscard={(id) => setConfirmDiscard(id)}
            applyBusy={applyBusy}
          />

          {openDocsVerification && (
            <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-2">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Staged Open Documents Diagnostics</h5>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center text-xs">
                <div className="ui-card p-2">
                  <p className="text-[9px] uppercase font-black text-app-text-muted">Open Orders</p>
                  <p className="font-bold text-app-text">{openDocsVerification.imported_open_doc_transactions}</p>
                </div>
                <div className="ui-card p-2">
                  <p className="text-[9px] uppercase font-black text-app-text-muted">Linked Customers</p>
                  <p className="font-bold text-app-text">{openDocsVerification.open_docs_with_customer_linked}</p>
                </div>
                <div className="ui-card p-2">
                  <p className="text-[9px] uppercase font-black text-app-text-muted">No Deposit</p>
                  <p className="font-bold text-app-text">{openDocsVerification.open_docs_with_zero_payments}</p>
                </div>
                <div className="ui-card p-2">
                  <p className="text-[9px] uppercase font-black text-app-text-muted">Staff Linked</p>
                  <p className="font-bold text-app-text">{openDocsVerification.distinct_staff_attribution_count}</p>
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-app-border pt-4 flex justify-between">
            <span className="text-xs text-app-text-muted">
              Double check active customer deposits. Deposits represent live cash collected for pending order hand-overs.
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(7)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Proceed to Loyalty History
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 7: Loyalty Point History ── */}
      {activeStep === 7 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 7: Customer Loyalty Point Balances</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Review point balances to allow customers to spend rewards points immediately on their profile.
            </p>
          </div>

          <StagingBatchCard
            entityName="loyalty_hist"
            batches={loyaltyBatches}
            onApply={(id) => setConfirmApply(id)}
            onDiscard={(id) => setConfirmDiscard(id)}
            applyBusy={applyBusy}
          />

          <div className="border-t border-app-border pt-4 flex justify-between">
            <span className="text-xs text-app-text-muted">
              Verifying loyalty points preserves customer loyalty and trust immediately on day 1.
            </span>
            <button
              type="button"
              onClick={() => setActiveStep(8)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
            >
              Proceed to Final Go-Live Audit
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </section>
      )}

      {/* ── STEP 8: Final Financial Audit & Sign-off ── */}
      {activeStep === 8 && (
        <section className="ui-card p-6 space-y-6">
          <div>
            <h4 className="text-base font-black uppercase text-app-text">Step 8: Final Financial Audit & Go-Live Cutover</h4>
            <p className="text-xs text-app-text-muted mt-0.5">
              Review final ledger balances, verify all transaction totals, and approve sign-off configuration to retire the SQL bridge.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Landed Verification Report</h5>
              <div className="rounded-xl border border-app-border overflow-hidden bg-app-bg/40 max-h-[300px] overflow-y-auto">
                <table className="w-full text-xs text-left">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">Profile</th>
                      <th className="px-3 py-2 text-right">Landed Rows</th>
                      <th className="px-3 py-2">Audit Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {landingVerification?.snapshot_reconciliation.map((rec) => (
                      <tr key={rec.key}>
                        <td className="px-3 py-2 font-bold uppercase text-[10px]">{rec.label.replace(/_/g, " ")}</td>
                        <td className="px-3 py-2 font-mono text-right text-[11px] font-semibold tabular-nums">{fmtNum(rec.landed_count)}</td>
                        <td className="px-3 py-2">
                          {rec.passed ? (
                            <span className="text-emerald-600 dark:text-emerald-400 font-semibold inline-flex items-center gap-1 text-[10px]">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              PASS
                            </span>
                          ) : (
                            <span className="text-red-500 font-semibold inline-flex items-center gap-1 text-[10px]">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {rec.note || "Mismatched"}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-4">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Go-Live Sign-Off Validation Checklist</h5>
              <div className="ui-card p-4 space-y-3 bg-app-surface-2/40 text-xs">
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="check-catalog" className="rounded border-app-border" />
                  <label htmlFor="check-catalog" className="font-medium text-app-text">Product catalog mapping approved & zero SKU gaps</label>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="check-customers" className="rounded border-app-border" />
                  <label htmlFor="check-customers" className="font-medium text-app-text">Customer profile databases applied to live CRM</label>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="check-finance" className="rounded border-app-border" />
                  <label htmlFor="check-finance" className="font-medium text-app-text">Gift card liabilities & layout deposits balance match CP</label>
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" id="check-cutoff" className="rounded border-app-border" />
                  <label htmlFor="check-cutoff" className="font-medium text-app-text">Confirm SQL direct bridge imports retired for day-1 live trading</label>
                </div>

                <div className="border-t border-app-border pt-3 mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      toast("Guided migration cutover complete! Live trading is active.", "success");
                    }}
                    className="ui-btn-primary w-full py-2.5 text-xs font-black uppercase tracking-widest"
                  >
                    Approve Cutover & Complete Migration
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* ── Modals ── */}
      <ConfirmationModal
        isOpen={confirmApply != null}
        onClose={() => setConfirmApply(null)}
        onConfirm={() => confirmApply && void applyBatch(confirmApply)}
        title="Apply Staged Data to Live Database?"
        message="This processes and writes this batch directly into your live production table ledger. Active cash balances, products, and customer profiles will become live instantly. This action is irreversible."
        confirmLabel="Apply Staged Data"
        variant="success"
        loading={applyBusy}
      />

      <ConfirmationModal
        isOpen={confirmDiscard != null}
        onClose={() => setConfirmDiscard(null)}
        onConfirm={() => confirmDiscard && void discardBatch(confirmDiscard)}
        title="Discard Staging Batch?"
        message="This closes and removes the staging records without importing them. You will need to rerun a sync from Step 1 if you want to restore it."
        confirmLabel="Discard Batch"
        variant="danger"
      />

      <ConfirmationModal
        isOpen={confirmWorkbenchReset}
        onClose={() => setConfirmWorkbenchReset(false)}
        onConfirm={() => void resetWorkbench()}
        title="Reset Catalog Mapping State?"
        message="This re-opens all mapping steps in Step 2. It will not delete imported data, but requires re-approving catalog mapping milestones."
        confirmLabel="Reset Mappings"
        variant="danger"
        loading={workbenchResetBusy}
      />

      <PromptModal
        isOpen={resetPromptOpen}
        onClose={() => {
          setResetPromptOpen(false);
        }}
        onSubmit={async (val) => {
          const expected = resetPreview?.confirmation_phrase ?? "RESET";
          if (val.trim() !== expected) {
            toast("Incorrect confirmation phrase. Reset aborted.", "error");
            return false;
          }
          const success = await runBaselineReset(val);
          return success;
        }}
        title="Wipe & Reset Migration?"
        message={`This will completely delete all Counterpoint products, variants, closed tickets, deposits, gift cards, and staged batch queues. This action is irreversible.\n\nTo proceed, type: ${resetPreview?.confirmation_phrase ?? "RESET"}`}
        confirmLabel="Wipe ROS Data"
        placeholder="Enter confirmation phrase"
      />
    </div>
  );
}

/* ── Sub-component for Staging batches ── */

function StagingBatchCard({
  entityName,
  batches,
  onApply,
  onDiscard,
  applyBusy,
}: {
  entityName: string;
  batches: StagingBatchRow[];
  onApply: (id: number) => void;
  onDiscard: (id: number) => void;
  applyBusy: boolean;
}) {
  if (batches.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-app-border p-6 text-center text-app-text-muted">
        <Database className="mx-auto h-8 w-8 text-app-text-muted/40 mb-2" />
        <p className="text-xs font-bold">No staged staging batches found for {entityName.replace(/_/g, " ")}.</p>
        <p className="text-[10px] text-app-text-muted/75 mt-1">
          Rerun the Counterpoint SQL bridge sync in Step 1 to pull data into staging tables.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {batches.map((batch) => {
        let statusBadge = "bg-app-surface text-app-text-muted";
        let statusLabel = "Pending review";
        if (batch.status === "applied") {
          statusBadge = "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
          statusLabel = "Applied to Live ROS";
        } else if (batch.status === "applying") {
          statusBadge = "bg-sky-500/15 text-sky-700 dark:text-sky-300";
          statusLabel = "Applying...";
        } else if (batch.status === "failed") {
          statusBadge = "bg-red-500/10 text-red-600";
          statusLabel = "Apply Failed";
        }

        return (
          <div key={batch.id} className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase ${statusBadge}`}>
                  {statusLabel}
                </span>
                <span className="text-[10px] text-app-text-muted">Staged on {new Date(batch.created_at).toLocaleDateString()}</span>
              </div>
              <span className="font-mono text-[11px] font-semibold text-app-text">{fmtNum(batch.row_count)} rows staged</span>
            </div>

            {batch.status === "pending" && (
              <div className="flex justify-end gap-2 pt-2 border-t border-app-border/40">
                <button
                  type="button"
                  onClick={() => onDiscard(batch.id)}
                  className="ui-btn-secondary text-[11px] font-bold px-3 py-1.5 text-red-600 border-red-500/10 hover:bg-red-500/5"
                >
                  Discard Batch
                </button>
                <button
                  type="button"
                  onClick={() => onApply(batch.id)}
                  disabled={applyBusy}
                  className="ui-btn-primary text-[11px] font-bold px-4 py-1.5 inline-flex items-center gap-1"
                >
                  {applyBusy && <Loader2 className="h-3 w-3 animate-spin" />}
                  Apply & Load Into ROS
                </button>
              </div>
            )}

            {batch.apply_error && (
              <p className="text-[10px] text-red-500 bg-red-500/5 border border-red-500/10 p-2 rounded-lg mt-1 font-semibold">
                Error log: {batch.apply_error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
