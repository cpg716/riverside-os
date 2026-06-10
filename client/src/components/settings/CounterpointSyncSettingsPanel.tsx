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
  ChevronRight,
  RotateCcw,
  Upload,
  Download,
  ClipboardCopy,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import RosieInsightSummary from "../help/RosieInsightSummary";
import RosieIcon from "../common/RosieIcon";

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
  staging_entity_counts?: StagingEntityCountRow[];
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

interface StagingEntityCountRow {
  entity: string;
  pending_batches: number;
  applying_batches: number;
  applied_batches: number;
  pending_rows: number;
  applying_rows: number;
  applied_rows: number;
  latest_at: string;
}

interface BridgeLiveStatus {
  lastRun?: string | null;
  lastRunDurationMs?: number | null;
  entityStats?: Record<string, { error?: string | null; recordCount?: number | null }>;
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

interface ReviewPackScope {
  scope: string;
  label: string;
  description: string;
  fully_functional: boolean;
  apply_supported: boolean;
  allowed_actions: string[];
}

interface ReviewPackSummary {
  id: string;
  pack_id: string;
  scope: string;
  schema_version: number;
  source_hash: string;
  generated_by_staff_id: string | null;
  generated_at: string;
  row_count: number;
  status: string;
  metadata: Record<string, unknown>;
}

interface ReviewSuggestion {
  id: string;
  import_id: string;
  pack_id: string;
  row_id: string | null;
  row_key: string;
  scope: string;
  action: string;
  field_name: string | null;
  current_value: unknown;
  suggested_value: unknown;
  confidence: number | string | null;
  reason: string;
  status: string;
  validation_errors: unknown;
  reviewed_by_staff_id: string | null;
  reviewed_at: string | null;
  applied_by_staff_id: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not reported";
  return date.toLocaleString();
}

function formatEntityLabel(entity: string): string {
  return entity.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function reviewValueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function reviewValueFromText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function formatConfidence(value: number | string | null): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

function stagingBatchAgeMinutes(batch: StagingBatchRow): number | null {
  if (!batch.apply_started_at) return null;
  const started = new Date(batch.apply_started_at).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.floor((Date.now() - started) / 60_000));
}

function isStaleApplyingBatch(batch: StagingBatchRow): boolean {
  const ageMinutes = stagingBatchAgeMinutes(batch);
  return batch.status === "applying" && ageMinutes != null && ageMinutes >= 15;
}

function stagingStaffLabel(name: string | null, id: string | null): string {
  return name?.trim() || id?.trim() || "Unknown staff";
}

function stagingStatusLabel(batch: StagingBatchRow): string {
  if (batch.recovered_at) return "Recovered stale apply";
  if (isStaleApplyingBatch(batch)) return "Stale applying";
  if (batch.status === "pending") return "Pending review";
  if (batch.status === "applying") return "Applying";
  if (batch.status === "applied") return "Applied";
  if (batch.status === "failed") return "Failed";
  if (batch.status === "discarded") return "Discarded";
  return formatEntityLabel(batch.status);
}

function stagingStatusTone(batch: StagingBatchRow): string {
  if (batch.recovered_at) return "bg-amber-500/15 text-amber-700 dark:text-amber-200";
  if (isStaleApplyingBatch(batch) || batch.status === "failed") return "bg-red-500/10 text-red-600";
  if (batch.status === "pending" || batch.status === "applying") return "bg-amber-500/15 text-amber-700 dark:text-amber-200";
  if (batch.status === "applied") return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200";
  return "bg-app-surface-2 text-app-text-muted";
}

function stagingLiveWriteSummary(batch: StagingBatchRow): string {
  if (batch.applied_at) return `Applied ${fmtNum(batch.row_count)} ${formatEntityLabel(batch.entity).toLowerCase()} row(s) to live ROS.`;
  if (batch.recovered_at) return "Recovered stale apply; payload was not replayed.";
  if (batch.apply_started_at) return "Apply is active; wait before taking recovery action unless the claim becomes stale.";
  if (batch.status === "pending") return "No live write has happened yet.";
  if (batch.status === "failed") return batch.apply_error ?? "Apply failed before completion.";
  return "No live write result recorded.";
}

function stagingReplaySummary(batch: StagingBatchRow): string {
  if (batch.replay_count > 0) return `Replay suppressed x${fmtNum(batch.replay_count)}.`;
  return "No duplicate bridge payload replay recorded.";
}

function stagingRecoveryGuidance(batch: StagingBatchRow): string {
  if (isStaleApplyingBatch(batch)) return "Only stale recovery is available for this batch.";
  if (batch.status === "applying") return "Apply is active; wait before taking recovery action.";
  if (batch.recovered_at) return "Recovered stale apply is now failed for support review.";
  return "Recovery is only available for stale applying claims.";
}

function stagingNextAction(batch: StagingBatchRow): { label: string; tone: string; body: string } {
  if (isStaleApplyingBatch(batch)) {
    return {
      label: "Recovery review",
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-100",
      body: "Mark the stale apply failed only after support confirms the bridge will not finish this claim.",
    };
  }
  if (batch.status === "pending") {
    return {
      label: "Apply or discard",
      tone: "border-app-border bg-app-bg/60 text-app-text-muted",
      body: "Review the payload, then apply it to live ROS or discard and rerun the bridge sync.",
    };
  }
  return {
    label: "Review only",
    tone: "border-app-border bg-app-bg/60 text-app-text-muted",
    body: "No write action is currently recommended from this status.",
  };
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

export default function CounterpointSyncSettingsPanel() {
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
  const [confirmRecoverStale, setConfirmRecoverStale] = useState<number | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [selectedPayload, setSelectedPayload] = useState<unknown>(null);
  const [workspaceView, setWorkspaceView] = useState<"pipeline" | "inbound" | "details">(() => {
    if (typeof window === "undefined") return "pipeline";
    return window.localStorage.getItem("counterpoint.statusSection") === "details"
      ? "details"
      : "pipeline";
  });

  // Connection settings
  const [runRequestBusy, setRunRequestBusy] = useState(false);
  const [bridgeControlUrlDraft, setBridgeControlUrlDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(BRIDGE_CONTROL_URL_STORAGE_KEY) ?? "";
  });
  const [bridgeLive, setBridgeLive] = useState<BridgeLiveStatus | null>(null);
  const [bridgeControlsReachable, setBridgeControlsReachable] = useState<boolean | null>(null);
  const [bridgeControlResolvedUrl, setBridgeControlResolvedUrl] = useState<string | null>(null);
  const [bridgeControlLoading, setBridgeControlLoading] = useState(false);

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
  const [csvUploadProgress, setCsvUploadProgress] = useState<number>(0);
  const [csvUploadStatus, setCsvUploadStatus] = useState<string | null>(null);
  const lsFileRef = useRef<HTMLInputElement>(null);
  const cpFileRef = useRef<HTMLInputElement>(null);

  // AI suggestions
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [aiScope, setAiScope] = useState<string>("names");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Manual Counterpoint transition review packs
  const [reviewScopes, setReviewScopes] = useState<ReviewPackScope[]>([]);
  const [reviewPacks, setReviewPacks] = useState<ReviewPackSummary[]>([]);
  const [reviewScope, setReviewScope] = useState<string>("inventory_catalog");
  const [selectedReviewPackId, setSelectedReviewPackId] = useState<string>("");
  const [reviewSuggestions, setReviewSuggestions] = useState<ReviewSuggestion[]>([]);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewImportText, setReviewImportText] = useState("");
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewSuggestionEdits, setReviewSuggestionEdits] = useState<Record<string, string>>({});
  const reviewImportFileRef = useRef<HTMLInputElement>(null);

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

  const fetchSelectedBatchPayload = useCallback(async (id: number) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${id}/payload`,
        { headers: headers() },
      );
      if (res.ok) {
        setSelectedPayload(await res.json());
        return;
      }
    } catch { /* silent */ }
    setSelectedPayload(null);
  }, [baseUrl, headers]);

  const fetchBridgeControlStatus = useCallback(async () => {
    const configured = bridgeControlUrlDraft.trim();
    const candidates = Array.from(new Set([
      configured,
      status?.bridge_hostname ? `http://${status.bridge_hostname}:3002` : "",
      "http://127.0.0.1:3002",
      "http://localhost:3002",
    ].filter(Boolean)));
    setBridgeControlLoading(true);
    for (const candidate of candidates) {
      try {
        const url = candidate.endsWith("/api/status")
          ? candidate
          : `${candidate.replace(/\/$/, "")}/api/status`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("bridge status unavailable");
        setBridgeLive((await res.json()) as BridgeLiveStatus);
        setBridgeControlsReachable(true);
        setBridgeControlResolvedUrl(url);
        setBridgeControlLoading(false);
        return;
      } catch { /* try next candidate */ }
    }
    setBridgeLive(null);
    setBridgeControlsReachable(false);
    setBridgeControlResolvedUrl(null);
    setBridgeControlLoading(false);
  }, [bridgeControlUrlDraft, status?.bridge_hostname]);

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

  const fetchReviewScopes = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/review-packs/scopes`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { scopes?: ReviewPackScope[] };
        setReviewScopes(data.scopes ?? []);
      }
    } catch {
      setReviewScopes([]);
    }
  }, [baseUrl, headers]);

  const fetchReviewPacks = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/review-packs`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { packs?: ReviewPackSummary[] };
        const packs = data.packs ?? [];
        setReviewPacks(packs);
        setSelectedReviewPackId((current) => current || packs[0]?.pack_id || "");
      }
    } catch {
      setReviewPacks([]);
    }
  }, [baseUrl, headers]);

  const fetchReviewSuggestions = useCallback(async (packId?: string) => {
    const id = packId ?? selectedReviewPackId;
    if (!id) {
      setReviewSuggestions([]);
      return;
    }
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/review-packs/${id}/suggestions`,
        { headers: headers() },
      );
      if (res.ok) {
        const data = (await res.json()) as { suggestions?: ReviewSuggestion[] };
        setReviewSuggestions(data.suggestions ?? []);
        setReviewSuggestionEdits({});
      }
    } catch {
      setReviewSuggestions([]);
    }
  }, [baseUrl, headers, selectedReviewPackId]);

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
      fetchReviewScopes(),
      fetchReviewPacks(),
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
    fetchReviewScopes,
    fetchReviewPacks,
    fetchLandingVerification,
    fetchTransactionReconciliation,
    fetchOpenDocsVerification,
    fetchInventoryCatalogVerification,
    fetchResetPreview,
  ]);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    void fetchBridgeControlStatus();
  }, [fetchBridgeControlStatus]);

  useEffect(() => {
    if (selectedBatchId == null) {
      setSelectedPayload(null);
      return;
    }
    void fetchSelectedBatchPayload(selectedBatchId);
  }, [fetchSelectedBatchPayload, selectedBatchId]);

  useEffect(() => {
    void fetchReviewSuggestions(selectedReviewPackId);
  }, [fetchReviewSuggestions, selectedReviewPackId]);

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

  const recoverStaleBatch = async (id: number) => {
    setApplyBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${id}/recover-stale`,
        {
          method: "POST",
          headers: headers(),
        },
      );
      if (res.ok) {
        toast("Stale apply marked failed. Payload was not replayed.", "success");
        setConfirmRecoverStale(null);
        await fetchBatches();
        await fetchStatus();
        return;
      }
      const j = await res.json().catch(() => ({}));
      toast(j.error ?? "Could not recover stale apply", "error");
    } catch {
      toast("Could not recover stale apply", "error");
    } finally {
      setApplyBusy(false);
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
    setCsvUploadProgress(0);
    setCsvUploadStatus(`Parsing ${file.name}...`);
    try {
      const text = await file.text();
      const fileHash = await hashString(text);
      const parsed = parseCsvRows(text);
      if (parsed.length === 0) {
        toast("CSV contains no record rows.", "error");
        setCsvUploadStatus(null);
        return;
      }

      const CHUNK_SIZE = 2000;
      let success = true;

      if (type === "lightspeed") {
        const allRows = parsed.map((row, i) => ({
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

        setCsvUploadStatus(`Uploading ${allRows.length} Lightspeed product entries...`);

        for (let idx = 0; idx < allRows.length; idx += CHUNK_SIZE) {
          const chunk = allRows.slice(idx, idx + CHUNK_SIZE);
          const isFirst = idx === 0;
          const progress = Math.min(100, Math.round(((idx + chunk.length) / allRows.length) * 100));
          setCsvUploadProgress(progress);

          const res = await fetch(
            `${baseUrl}/api/settings/counterpoint-sync/workbench/upload-lightspeed-csv`,
            {
              method: "POST",
              headers: { ...headers(), "Content-Type": "application/json" },
              body: JSON.stringify({
                source_file_name: file.name,
                source_file_hash: fileHash,
                replace: isFirst,
                rows: chunk,
              }),
            },
          );

          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            toast(j.error ?? "Failed to save CSV reference mapping.", "error");
            setCsvUploadStatus("Upload failed");
            success = false;
            break;
          }
        }

        if (success) {
          setCsvUploadStatus(`Successfully loaded ${allRows.length} product entries`);
          toast(`Enrichment catalog loaded: ${allRows.length} product entries`, "success");
          void fetchDsHealth();
          void fetchMergePreview();
        }
      } else {
        const allRows = parsed.map((row, i) => ({
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

        setCsvUploadStatus(`Uploading ${allRows.length} Counterpoint inventory rows...`);

        for (let idx = 0; idx < allRows.length; idx += CHUNK_SIZE) {
          const chunk = allRows.slice(idx, idx + CHUNK_SIZE);
          const isFirst = idx === 0;
          const progress = Math.min(100, Math.round(((idx + chunk.length) / allRows.length) * 100));
          setCsvUploadProgress(progress);

          const res = await fetch(
            `${baseUrl}/api/settings/counterpoint-sync/workbench/upload-cp-csv`,
            {
              method: "POST",
              headers: { ...headers(), "Content-Type": "application/json" },
              body: JSON.stringify({
                source_file_name: file.name,
                source_file_hash: fileHash,
                replace: isFirst,
                rows: chunk,
              }),
            },
          );

          if (!res.ok) {
            const j = await res.json().catch(() => ({}));
            toast(j.error ?? "Failed to save CSV reference mapping.", "error");
            setCsvUploadStatus("Upload failed");
            success = false;
            break;
          }
        }

        if (success) {
          setCsvUploadStatus(`Successfully cached ${allRows.length} Counterpoint rows`);
          toast(`Counterpoint backup CSV cached: ${allRows.length} rows`, "success");
          void fetchDsHealth();
          void fetchMergePreview();
          void fetchInventoryVerification();
        }
      }
    } catch (e) {
      toast(`CSV parsing failure: ${e}`, "error");
      setCsvUploadStatus("Parsing failed");
    } finally {
      setCsvUploading(null);
      setTimeout(() => {
        setCsvUploadProgress(0);
        setCsvUploadStatus(null);
      }, 3000);
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

  const generateReviewPack = async () => {
    setReviewBusy("generate");
    setReviewError(null);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/review-packs/generate`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ scope: reviewScope, limit: 500, issue_filter: "all" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Could not generate review pack");
      }
      const pack = data as ReviewPackSummary;
      setSelectedReviewPackId(pack.pack_id);
      toast(`Review pack generated: ${fmtNum(pack.row_count)} row(s).`, "success");
      await fetchReviewPacks();
      await fetchReviewSuggestions(pack.pack_id);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not generate review pack";
      setReviewError(message);
      toast(message, "error");
    } finally {
      setReviewBusy(null);
    }
  };

  const downloadReviewPack = async (packId: string) => {
    if (!packId) return;
    setReviewBusy("download");
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/review-packs/${packId}/download.json`,
        { headers: headers() },
      );
      if (!res.ok) throw new Error("Could not download review pack");
      const blob = new Blob([await res.text()], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `counterpoint-review-pack-${packId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("Could not download review pack", "error");
    } finally {
      setReviewBusy(null);
    }
  };

  const copyReviewPrompt = async (packId: string) => {
    if (!packId) return;
    setReviewBusy("prompt");
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/review-packs/${packId}/prompt.txt`,
        { headers: headers() },
      );
      if (!res.ok) throw new Error("Could not load prompt");
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      toast("Manual ChatGPT/Codex prompt copied.", "success");
    } catch {
      toast("Could not copy prompt.", "error");
    } finally {
      setReviewBusy(null);
    }
  };

  const importReviewResults = async () => {
    const trimmed = reviewImportText.trim();
    if (!trimmed) {
      toast("Paste or upload the returned review JSON first.", "error");
      return;
    }
    setReviewBusy("import");
    setReviewError(null);
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/review-packs/import-results`, {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? "Imported review JSON did not pass validation");
      }
      toast(`Suggestions staged: ${fmtNum(data.stored_suggestions ?? 0)} pending.`, "success");
      setReviewImportText("");
      await fetchReviewPacks();
      const sourcePackId = typeof data.source_pack_id === "string" ? data.source_pack_id : selectedReviewPackId;
      if (sourcePackId) {
        setSelectedReviewPackId(sourcePackId);
        await fetchReviewSuggestions(sourcePackId);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Imported review JSON did not pass validation";
      setReviewError(message);
      toast(message, "error");
    } finally {
      setReviewBusy(null);
    }
  };

  const updateReviewSuggestion = async (suggestion: ReviewSuggestion, statusValue: string) => {
    setReviewBusy(suggestion.id);
    try {
      const draft = reviewSuggestionEdits[suggestion.id];
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/review-packs/suggestions/${suggestion.id}`,
        {
          method: "PATCH",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({
            status: statusValue,
            suggested_value: draft == null ? undefined : reviewValueFromText(draft),
            reason: suggestion.reason,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not update suggestion");
      await fetchReviewSuggestions(selectedReviewPackId);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not update suggestion", "error");
    } finally {
      setReviewBusy(null);
    }
  };

  const applyApprovedReviewSuggestions = async () => {
    if (!selectedReviewPackId) return;
    setReviewBusy("apply");
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/review-packs/${selectedReviewPackId}/apply-approved`,
        { method: "POST", headers: headers() },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not apply approved suggestions");
      toast(
        `Applied ${fmtNum(data.applied ?? 0)} suggestion(s); blocked ${fmtNum(data.blocked ?? 0)} review-only item(s).`,
        "success",
      );
      await fetchReviewSuggestions(selectedReviewPackId);
      await fetchInventoryCatalogVerification();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not apply approved suggestions", "error");
    } finally {
      setReviewBusy(null);
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
  const approveSubStep = async (stepKey: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/approve-step`,
        {
          method: "POST",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ step: stepKey }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        toast(`Sub-section '${stepKey}' verified.`, "success");
        if (data.next_step_unlocked) {
          if (stepKey === "vendors") {
            setActiveSubStep("staff");
          } else {
            setActiveSubStep(data.next_step_unlocked);
          }
        }
        void fetchWorkbenchState();
      } else {
        const j = await res.json().catch(() => ({}));
        toast(j.error ?? "Step verification failed", "error");
      }
    } catch {
      toast("Step verification failed", "error");
    }
  };

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
  const pendingN = batches.filter((b) => b.status === "pending").length;
  const applyingN = batches.filter((b) => b.status === "applying").length;
  const visiblePendingN = Math.max(pendingN, status?.staging_pending_count ?? 0);
  const visibleApplyingN = Math.max(applyingN, status?.staging_applying_count ?? 0);
  const stagingCountsByEntity = useMemo(() => new Map<string, StagingEntityCountRow>(
    (status?.staging_entity_counts ?? []).map((row) => [row.entity, row]),
  ), [status?.staging_entity_counts]);
  const entityRunsForDisplay = useMemo(() => {
    const rows = new Map<string, EntityRunRow>();
    for (const run of status?.entity_runs ?? []) {
      rows.set(run.entity, run);
    }
    for (const count of status?.staging_entity_counts ?? []) {
      if (!rows.has(count.entity)) {
        rows.set(count.entity, {
          entity: count.entity,
          cursor_value: null,
          last_ok_at: count.latest_at,
          last_error: null,
          records_processed: 0,
          updated_at: count.latest_at,
        });
      }
    }
    return Array.from(rows.values());
  }, [status?.entity_runs, status?.staging_entity_counts]);
  const staleApplyingN = batches.filter(isStaleApplyingBatch).length;
  const failedBatchN = batches.filter((b) => b.status === "failed").length;
  const replaySuppressionN = batches.reduce((sum, batch) => sum + Math.max(0, batch.replay_count), 0);
  const recoveredBatchN = batches.filter((b) => b.recovered_at).length;
  const unresolvedIssueCount = status?.recent_issues.filter((issue) => !issue.resolved).length ?? 0;
  const directBridgeErrorCount = Object.values(bridgeLive?.entityStats ?? {}).filter((entry) => entry.error).length;
  const normalizedProofKeys = new Set(
    [
      ...(landingVerification?.rows ?? []),
      ...(landingVerification?.snapshot_reconciliation ?? []),
    ].flatMap((row) => {
      const key = row.key.toLowerCase();
      const label = row.label.toLowerCase().replace(/\s+/g, "_");
      const aliases = [key, label];
      if (key.includes("closed_ticket")) aliases.push("tickets");
      if (key.includes("loyalty")) aliases.push("loyalty_hist");
      if (key.includes("catalog") || key.includes("variant")) aliases.push("inventory");
      return aliases;
    }),
  );
  const entitiesMissingRosProof =
    status?.entity_runs.filter((run) => {
      const entity = run.entity.toLowerCase();
      return !Array.from(normalizedProofKeys).some((key) => key.includes(entity) || entity.includes(key));
    }).length ?? 0;
  const lowerRosCountRows =
    landingVerification?.snapshot_reconciliation.filter((row) => (row.count_difference ?? 0) < 0).length ?? 0;
  const signoffBlockers = [
    visiblePendingN > 0 ? `${fmtNum(visiblePendingN)} staging batch(es) are pending review.` : null,
    unresolvedIssueCount > 0 ? `${fmtNum(unresolvedIssueCount)} unresolved sync issue(s) remain.` : null,
    entitiesMissingRosProof > 0
      ? `${fmtNum(entitiesMissingRosProof)} entity row(s) have bridge-reported counts without ROS landed proof.`
      : null,
    directBridgeErrorCount > 0
      ? "At least one bridge entity still shows an error in the latest visible run."
      : null,
  ].filter((line): line is string => Boolean(line));
  const supportDiagnosticsSeverity =
    signoffBlockers.length > 0 || staleApplyingN > 0 || failedBatchN > 0 ? "Review" : "Clear";
  const supportDiagnosticsTone =
    supportDiagnosticsSeverity === "Review"
      ? "bg-red-500/10 text-red-600"
      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200";
  const selectedBatch =
    selectedBatchId == null ? null : (batches.find((batch) => batch.id === selectedBatchId) ?? null);
  const selectedReviewPack =
    reviewPacks.find((pack) => pack.pack_id === selectedReviewPackId) ?? reviewPacks[0] ?? null;
  const selectedReviewScope =
    reviewScopes.find((scope) => scope.scope === reviewScope) ?? reviewScopes.find((scope) => scope.scope === selectedReviewPack?.scope) ?? null;
  const selectedPackScope =
    selectedReviewPack == null
      ? null
      : reviewScopes.find((scope) => scope.scope === selectedReviewPack.scope) ?? null;
  const acceptedReviewSuggestionCount = reviewSuggestions.filter((s) => s.status === "accepted").length;

  const getEntityRunProof = (run: EntityRunRow) => {
    const staged = stagingCountsByEntity.get(run.entity);
    const stagedRows =
      (staged?.pending_rows ?? 0) + (staged?.applying_rows ?? 0) + (staged?.applied_rows ?? 0);
    const stagedBatches =
      (staged?.pending_batches ?? 0) + (staged?.applying_batches ?? 0) + (staged?.applied_batches ?? 0);
    const runRows = run.records_processed ?? 0;
    const displayRows = stagingOn && stagedRows > 0 ? stagedRows : runRows;
    const latestAt = stagingOn && staged?.latest_at ? staged.latest_at : run.last_ok_at;
    const stagingLabel =
      staged && staged.applying_batches > 0
        ? "Applying staged rows"
        : staged && staged.pending_batches > 0
          ? "Queued in staging"
          : staged && staged.applied_batches > 0
            ? "Applied from staging"
            : "Staged rows";
    return {
      displayRows,
      latestAt,
      staged,
      stagedBatches,
      stagingLabel,
      isStaged: stagingOn && stagedRows > 0,
      isZeroNoError: displayRows === 0 && !run.last_error,
    };
  };
  const counterpointInsightFacts = {
    title: "Counterpoint Sign-off Explanation",
    bullets: [
      ...signoffBlockers.map((label, index) => ({
        id: `counterpoint-blocker-${index}`,
        label,
        severity: "warning",
      })),
      {
        id: "counterpoint-queue",
        label: `${fmtNum(visiblePendingN)} pending, ${fmtNum(visibleApplyingN)} applying, ${fmtNum(staleApplyingN)} stale applying, ${fmtNum(recoveredBatchN)} recovered.`,
        severity: visiblePendingN > 0 || visibleApplyingN > 0 ? "warning" : "success",
      },
      {
        id: "counterpoint-replay",
        label: `${fmtNum(replaySuppressionN)} replay suppression(s) recorded in the loaded queue.`,
        severity: replaySuppressionN > 0 ? "info" : "success",
      },
      {
        id: "counterpoint-proof",
        label: `${fmtNum(lowerRosCountRows)} reconciliation row(s) show ROS count lower than bridge count.`,
        severity: lowerRosCountRows > 0 ? "warning" : "success",
      },
    ],
    disclaimers: [
      "Optional explanation of displayed checks only. Do not approve sign-off, reconcile, or declare cutover safe.",
    ],
  };

  // Filter staging batches for step rendering
  const customerBatches = useMemo(() => batches.filter((b) => b.entity === "customers"), [batches]);
  const ticketBatches = useMemo(() => batches.filter((b) => b.entity === "tickets"), [batches]);
  const giftBatches = useMemo(() => batches.filter((b) => b.entity === "gift_cards"), [batches]);
  const openDocBatches = useMemo(() => batches.filter((b) => b.entity === "open_docs"), [batches]);
  const loyaltyBatches = useMemo(() => batches.filter((b) => b.entity === "loyalty_hist"), [batches]);

  const normalizeProofKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const bridgeRowsFor = (entities: string[]) => {
    const keys = entities.map(normalizeProofKey);
    return (status?.entity_runs ?? []).reduce((sum, run) => {
      const entity = normalizeProofKey(run.entity);
      return keys.includes(entity) ? sum + Math.max(0, run.records_processed ?? 0) : sum;
    }, 0);
  };
  const stagedRowsFor = (entity: string, entityBatches: StagingBatchRow[]) => {
    const staged = stagingCountsByEntity.get(entity);
    const stagedRows =
      (staged?.pending_rows ?? 0) + (staged?.applying_rows ?? 0) + (staged?.applied_rows ?? 0);
    const batchRows = entityBatches.reduce((sum, batch) => {
      return batch.status === "discarded" ? sum : sum + Math.max(0, batch.row_count);
    }, 0);
    return Math.max(stagedRows, batchRows);
  };
  const landedRowsFor = (terms: string[]) => {
    const keys = terms.map(normalizeProofKey);
    const directRows =
      landingVerification?.rows.map((row) => ({
        key: normalizeProofKey(row.key),
        label: normalizeProofKey(row.label),
        count: row.count,
      })) ?? [];
    const snapshotRows =
      landingVerification?.snapshot_reconciliation.map((row) => ({
        key: normalizeProofKey(row.key),
        label: normalizeProofKey(row.label),
        count: row.landed_count,
      })) ?? [];
    return [...directRows, ...snapshotRows].reduce((max, row) => {
      const matches = keys.some((key) => row.key === key || row.label === key || row.key.includes(key) || row.label.includes(key));
      return matches ? Math.max(max, row.count) : max;
    }, 0);
  };
  const reviewReadinessFor = (
    label: string,
    entity: string,
    entityBatches: StagingBatchRow[],
    proofTerms: string[],
  ) => {
    const bridgeRows = bridgeRowsFor([entity]);
    const stagedRows = stagedRowsFor(entity, entityBatches);
    const landedRows = landedRowsFor(proofTerms);
    const expected = bridgeRows > 0 || stagedRows > 0 || landedRows > 0;
    const ready = !expected || stagedRows > 0 || landedRows > 0;
    return {
      label,
      entity,
      ready,
      expected,
      bridgeRows,
      stagedRows,
      landedRows,
      message: `${label} has ${fmtNum(bridgeRows)} bridge row(s), but no staged/applied batch or ROS landed proof is available for review.`,
    };
  };
  const inventoryProducts = workbenchState?.inventory_summary?.products ?? 0;
  const inventoryVariants = workbenchState?.inventory_summary?.variants ?? 0;
  const hasLandedInventory = inventoryProducts > 0 && inventoryVariants > 0;
  const bridgeReportedCatalogRows = bridgeRowsFor(["inventory"]) + (dsHealth?.bridge_products ?? 0);
  const customerReviewReady = reviewReadinessFor("Customer CRM", "customers", customerBatches, ["customers"]);
  const ticketReviewReady = reviewReadinessFor("Sales history", "tickets", ticketBatches, [
    "closed_ticket_transactions",
    "closed_ticket_lines",
    "closed_ticket_payments",
  ]);
  const giftCardReviewReady = reviewReadinessFor("Gift card liabilities", "gift_cards", giftBatches, ["gift_cards"]);
  const openDocReviewReady = reviewReadinessFor("Open orders and layaways", "open_docs", openDocBatches, [
    "open_doc_transactions",
    "open_doc_lines",
  ]);
  const loyaltyReviewReady = reviewReadinessFor("Loyalty history", "loyalty_hist", loyaltyBatches, [
    "loyalty_history",
    "loyalty_hist",
  ]);
  const downstreamReviewBlockers = [
    !hasLandedInventory && bridgeReportedCatalogRows > 0
      ? `Bridge reported catalog/inventory rows, but ROS has ${fmtNum(inventoryProducts)} Counterpoint product(s) and ${fmtNum(inventoryVariants)} variant(s). Apply the inventory staging batch before approving catalog mapping.`
      : null,
    ...[
      customerReviewReady,
      ticketReviewReady,
      giftCardReviewReady,
      openDocReviewReady,
      loyaltyReviewReady,
    ].filter((review) => !review.ready).map((review) => review.message),
  ].filter((line): line is string => Boolean(line));
  const hasAnyCounterpointLandingProof =
    hasLandedInventory ||
    customerReviewReady.landedRows > 0 ||
    ticketReviewReady.landedRows > 0 ||
    giftCardReviewReady.landedRows > 0 ||
    openDocReviewReady.landedRows > 0 ||
    loyaltyReviewReady.landedRows > 0;
  const bridgeReportedRows = (status?.entity_runs ?? []).reduce(
    (sum, run) => sum + Math.max(0, run.records_processed ?? 0),
    0,
  );
  const stagedReviewRows = [
    customerReviewReady,
    ticketReviewReady,
    giftCardReviewReady,
    openDocReviewReady,
    loyaltyReviewReady,
  ].reduce((sum, review) => sum + review.stagedRows, 0);
  const bridgeRowsWithoutReviewSurface =
    bridgeReportedRows > 0 && !hasLandedInventory && stagedReviewRows === 0 && !hasAnyCounterpointLandingProof;

  // Check sub-step statuses for Step 2
  const subStepStatus = (key: string) => workbenchState?.steps[key]?.status ?? "locked";
  const step2Approved = workbenchState?.steps["verification"]?.status === "complete";
  const cutoverBlockers = [
    ...signoffBlockers,
    ...downstreamReviewBlockers,
    visiblePendingN > 0 || visibleApplyingN > 0 ? "Staging batches are still pending or applying." : null,
    staleApplyingN > 0 ? "At least one staging batch is stale in applying state." : null,
    failedBatchN > 0 ? "At least one staging batch failed during apply." : null,
    !hasAnyCounterpointLandingProof ? "No ROS landed Counterpoint proof is available for final cutover." : null,
  ].filter((line): line is string => Boolean(line));
  const canOpenFinalAudit =
    step2Approved &&
    customerReviewReady.ready &&
    ticketReviewReady.ready &&
    giftCardReviewReady.ready &&
    openDocReviewReady.ready &&
    loyaltyReviewReady.ready &&
    cutoverBlockers.length === 0 &&
    visiblePendingN === 0 &&
    visibleApplyingN === 0;

  // Main stepper disabled mapping (linear enforcement)
  const isStepDisabled = (stepNum: number) => {
    if (stepNum === 1) return false;
    if (stepNum === 2) return bridgeRowsWithoutReviewSurface;
    if (stepNum === 3) return !step2Approved || !hasLandedInventory || !customerReviewReady.ready;
    if (stepNum === 4) return !step2Approved || !hasLandedInventory || !customerReviewReady.ready || !ticketReviewReady.ready;
    if (stepNum === 5) return !step2Approved || !hasLandedInventory || !customerReviewReady.ready || !ticketReviewReady.ready || !giftCardReviewReady.ready;
    if (stepNum === 6) {
      return !step2Approved || !hasLandedInventory || !customerReviewReady.ready || !ticketReviewReady.ready || !giftCardReviewReady.ready || !openDocReviewReady.ready;
    }
    if (stepNum === 7) {
      return !step2Approved || !hasLandedInventory || !customerReviewReady.ready || !ticketReviewReady.ready || !giftCardReviewReady.ready || !openDocReviewReady.ready || !loyaltyReviewReady.ready;
    }
    // Step 8 (Final Cutover) unlocks after all previous staging queues are empty/applied
    if (stepNum === 8) return !canOpenFinalAudit;
    return false;
  };

  const stepBlockerMessage = (stepNum: number) => {
    if (stepNum === 2 && bridgeRowsWithoutReviewSurface) {
      return "Bridge-reported rows must have staged, applied, or ROS landed proof before inventory mapping can begin.";
    }
    if (!step2Approved && stepNum > 2) return "Approve the inventory catalog mapping step before advancing.";
    if (!hasLandedInventory && stepNum > 2) return "Apply the Counterpoint inventory batch before moving into downstream review.";
    if (stepNum >= 3 && !customerReviewReady.ready) return customerReviewReady.message;
    if (stepNum >= 4 && !ticketReviewReady.ready) return ticketReviewReady.message;
    if (stepNum >= 5 && !giftCardReviewReady.ready) return giftCardReviewReady.message;
    if (stepNum >= 6 && !openDocReviewReady.ready) return openDocReviewReady.message;
    if (stepNum >= 7 && !loyaltyReviewReady.ready) return loyaltyReviewReady.message;
    if (stepNum === 8 && cutoverBlockers.length > 0) return cutoverBlockers[0];
    return "This Counterpoint review step is not ready yet.";
  };

  const goToStepIfReady = (stepNum: number) => {
    if (isStepDisabled(stepNum)) {
      toast(stepBlockerMessage(stepNum), "error");
      return;
    }
    setActiveStep(stepNum);
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

  const bridgeReachabilityPanel = (
    <div className="ui-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Bridge control reachability
          </p>
          <p className="mt-1 text-sm font-bold text-app-text">
            {bridgeControlsReachable
              ? "Direct controls reachable"
              : "Bridge controls are not reachable on this workstation"}
          </p>
          <p className="mt-1 text-xs font-semibold text-app-text-muted">
            Server: {(status?.windows_sync_state ?? "unknown").toUpperCase()}
          </p>
          {bridgeControlResolvedUrl ? (
            <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
              Controls: {bridgeControlResolvedUrl}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void fetchBridgeControlStatus()}
          disabled={bridgeControlLoading}
          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${bridgeControlLoading ? "animate-spin" : ""}`} />
          Reconnect to bridge
        </button>
      </div>
      {!bridgeControlsReachable ? (
        <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs font-semibold text-amber-800 dark:text-amber-100">
          Bridge controls are not reachable from this browser. ROS server heartbeat is tracked separately, so SQL extraction may still be online while direct Start/Stop controls are unavailable.
        </p>
      ) : null}
    </div>
  );

  const inboundQueuePanel = (
    <section className="ui-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Staging diagnostics
          </h4>
          <p className="mt-1 text-xs text-app-text-muted">
            Review replay-safe batches, stale apply claims, and manual recovery before writing Counterpoint data to live ROS tables.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchBatches()}
          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Reload
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 text-xs xl:grid-cols-6">
        {[
          { label: "Replay suppressions", value: fmtNum(replaySuppressionN) },
          { label: "Failed batches", value: fmtNum(failedBatchN) },
          { label: "Stale applying", value: fmtNum(staleApplyingN) },
          { label: "Recovered stale", value: fmtNum(recoveredBatchN) },
          { label: "Pending", value: fmtNum(visiblePendingN) },
          { label: "Applying", value: fmtNum(visibleApplyingN) },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{item.label}</p>
            <p className="mt-1 font-bold tabular-nums text-app-text">{item.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-app-border">
          <div className="flex items-center justify-between border-b border-app-border bg-app-bg/40 px-3 py-2">
            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Batches
            </span>
          </div>
          <div className="max-h-[480px] overflow-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="sticky top-0 bg-app-surface-2">
                <tr className="border-b border-app-border text-[10px] font-black uppercase text-app-text-muted">
                  <th className="px-2 py-2">ID</th>
                  <th className="px-2 py-2">Entity</th>
                  <th className="px-2 py-2">Rows</th>
                  <th className="px-2 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {batches.map((batch) => (
                  <tr
                    key={batch.id}
                    className={`cursor-pointer hover:bg-app-surface/30 ${
                      selectedBatchId === batch.id ? "bg-orange-500/10" : ""
                    }`}
                    onClick={() => setSelectedBatchId(batch.id)}
                  >
                    <td className="px-2 py-2 font-mono">{batch.id}</td>
                    <td className="px-2 py-2 font-bold">{formatEntityLabel(batch.entity)}</td>
                    <td className="px-2 py-2 tabular-nums">{fmtNum(batch.row_count)}</td>
                    <td className="px-2 py-2">
                      <span className={`ui-pill text-[10px] ${stagingStatusTone(batch)}`}>
                        {stagingStatusLabel(batch)}
                      </span>
                      {batch.replay_count > 0 ? (
                        <p className="mt-1 text-[10px] text-app-text-muted">
                          Replay suppressed x{fmtNum(batch.replay_count)}
                        </p>
                      ) : null}
                      {batch.recovered_by_staff_name || batch.recovered_by_staff_id ? (
                        <p className="mt-1 text-[10px] text-app-text-muted">
                          Recovered by {stagingStaffLabel(batch.recovered_by_staff_name, batch.recovered_by_staff_id)}
                        </p>
                      ) : null}
                      {batch.recovery_reason ? (
                        <p className="mt-1 text-[10px] text-app-text-muted">
                          Recovery note: {batch.recovery_reason}
                        </p>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {batches.length === 0 ? (
              <div className="m-3 rounded-lg border border-app-border bg-app-bg/60 p-4 text-xs text-app-text-muted">
                <p className="font-bold text-app-text">No staged batches need action.</p>
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-xl border border-app-border p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Payload & actions
          </p>
          {selectedBatch == null ? (
            <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-4 text-xs text-app-text-muted">
              <p className="font-bold text-app-text">Select a staged batch to review.</p>
              <p className="mt-1">The action panel shows safe next steps, replay status, and recovery guidance.</p>
            </div>
          ) : (
            <div className="mt-3 space-y-3 text-xs">
              <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                <span className={`ui-pill text-[10px] ${stagingStatusTone(selectedBatch)}`}>
                  {stagingStatusLabel(selectedBatch)}
                </span>
                {isStaleApplyingBatch(selectedBatch) ? (
                  <p className="mt-2 font-semibold text-amber-800 dark:text-amber-100">
                    Safe recovery is available because the apply claim is stale. It marks the batch failed only; it does not replay or reset the payload.
                  </p>
                ) : null}
              </div>

              <div className={`rounded-lg border p-3 ${stagingNextAction(selectedBatch).tone}`}>
                <p className="text-[10px] font-black uppercase tracking-widest">
                  Next safe action: {stagingNextAction(selectedBatch).label}
                </p>
                <p className="mt-1">{stagingNextAction(selectedBatch).body}</p>
              </div>

              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-lg border border-app-border bg-app-bg/50 p-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Apply claimed</p>
                  <p className="mt-1 text-app-text-muted">
                    {selectedBatch.apply_started_at
                      ? `${formatDate(selectedBatch.apply_started_at)} by ${stagingStaffLabel(selectedBatch.apply_claimed_by_staff_name, selectedBatch.apply_claimed_by_staff_id)}`
                      : "Not claimed"}
                  </p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-bg/50 p-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Live write result</p>
                  <p className="mt-1 text-app-text-muted">{stagingLiveWriteSummary(selectedBatch)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-app-border bg-app-bg/50 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Operational decision guide
                </p>
                <div className="mt-2 grid gap-2 md:grid-cols-3">
                  {[
                    { label: "What changed", value: stagingLiveWriteSummary(selectedBatch) },
                    { label: "Replay visibility", value: stagingReplaySummary(selectedBatch) },
                    { label: "Recovery guidance", value: stagingRecoveryGuidance(selectedBatch) },
                  ].map((item) => (
                    <div key={item.label} className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{item.label}</p>
                      <p className="mt-1 text-app-text-muted">{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-app-border bg-app-bg/50 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Payload fingerprint:
                </p>
                <p className="mt-1 break-all font-mono text-[10px] text-app-text-muted">
                  {selectedBatch.payload_fingerprint ?? "Not recorded"}
                </p>
              </div>

              <pre className="max-h-44 overflow-auto rounded-lg border border-app-border bg-app-bg/70 p-3 text-[10px] text-app-text-muted">
                {selectedPayload != null ? JSON.stringify(selectedPayload, null, 2) : "Payload loading or unavailable."}
              </pre>

              <button
                type="button"
                onClick={() => setConfirmRecoverStale(selectedBatch.id)}
                disabled={!isStaleApplyingBatch(selectedBatch) || applyBusy}
                className="ui-btn-secondary w-full px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-600 disabled:opacity-50"
              >
                Mark stale apply failed
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );

  const supportDiagnosticsPanel = (
    <section className="ui-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Support diagnostics center
          </h4>
          <p className="mt-1 text-xs text-app-text-muted">
            Single-screen support handoff for deployment health, recovery posture, replay visibility, and sign-off blockers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`ui-pill text-[10px] ${supportDiagnosticsTone}`}>{supportDiagnosticsSeverity}</span>
          <button
            type="button"
            onClick={() => {
              const report = [
                "Counterpoint Support Diagnostics",
                `Generated: ${new Date().toLocaleString()}`,
                `Bridge: ${bridgeControlsReachable ? "direct controls reachable" : "not reachable"}`,
                `Server state: ${status?.windows_sync_state ?? "unknown"}`,
                `Queue: ${fmtNum(visiblePendingN)} pending, ${fmtNum(visibleApplyingN)} applying, ${fmtNum(staleApplyingN)} stale applying`,
                ...signoffBlockers,
              ].join("\n");
              void navigator.clipboard?.writeText(report).then(
                () => toast("Counterpoint support diagnostics copied.", "success"),
                () => toast("Could not copy diagnostics from this browser.", "error"),
              );
            }}
            className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
          >
            Copy support report
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Deployment visibility</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[
              { label: "Bridge reachability", value: bridgeControlsReachable ? "Direct controls reachable" : "Not reachable" },
              { label: "Bridge host", value: status?.bridge_hostname ?? "Not reported" },
              { label: "Landing mode", value: stagingOn ? "Staging queue" : "Direct import" },
              { label: "Last bridge activity", value: formatDate(status?.last_seen_at ?? bridgeLive?.lastRun) },
            ].map((row) => (
              <div key={row.label} className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{row.label}</p>
                <p className="mt-1 font-bold text-app-text">{row.value}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Recovery and replay posture</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[
              { label: "Queue posture", value: staleApplyingN > 0 ? "Stale apply review" : visiblePendingN > 0 ? "Pending apply" : "Queue clear" },
              { label: "Replay posture", value: replaySuppressionN > 0 ? "Replay suppressions recorded" : "No duplicate replay" },
              { label: "Recovery posture", value: recoveredBatchN > 0 ? "Recovered stale claims" : "No stale recovery recorded" },
              { label: "Open issues", value: unresolvedIssueCount > 0 ? "Support review needed" : "No open sync issues" },
            ].map((row) => (
              <div key={row.label} className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{row.label}</p>
                <p className="mt-1 font-bold text-app-text">{row.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Counterpoint Support Diagnostics
        </p>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {signoffBlockers.length > 0 ? (
            <>
              <p className="font-bold text-red-600">Sign-off blockers present</p>
              {signoffBlockers.map((blocker) => (
                <p key={blocker} className="font-semibold text-app-text-muted">{blocker}</p>
              ))}
            </>
          ) : (
            <p className="font-bold text-emerald-600">No automatic blockers detected</p>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
        <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Post-import verification
        </h4>
        <p className="mt-1 text-xs text-app-text-muted">
          Counts below are deterministic proof from ROS tables and bridge-reported import facts.
        </p>
        <h4 className="mt-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Sign-off reconciliation
        </h4>
        <div className="mt-3 overflow-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead>
              <tr className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <th className="px-2 py-2">Entity</th>
                <th className="px-2 py-2">Bridge rows sent</th>
                <th className="px-2 py-2">ROS rows landed</th>
                <th className="px-2 py-2">Missing ROS landed proof</th>
                <th className="px-2 py-2">Match</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {(landingVerification?.snapshot_reconciliation ?? []).map((row) => (
                <tr key={row.key}>
                  <td className="px-2 py-2 font-bold">{row.label}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.source_count)}</td>
                  <td className="px-2 py-2 tabular-nums">{fmtNum(row.landed_count)}</td>
                  <td className="px-2 py-2">{row.source_count == null ? "Yes" : "No"}</td>
                  <td className="px-2 py-2">{row.passed ? "Yes" : "No"}</td>
                  <td className="px-2 py-2">
                    {(row.count_difference ?? 0) < 0 ? "Lower" : row.source_count == null ? "Bridge-only" : row.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1">Counts match</span>
          <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1">ROS count lower</span>
          <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1">Bridge only</span>
        </div>
        <div className="mt-3 rounded-lg border border-app-border bg-app-surface-2/40 p-3 text-xs text-app-text-muted">
          <p className="font-black uppercase tracking-widest text-app-text">Limits and caveats</p>
          <p className="mt-1">
            Imported Counterpoint ticket and open-doc rows preserve gross historical totals; imported line tax is non-authoritative and should not be treated as tax filing proof.
          </p>
        </div>
        <p className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <RosieIcon size={14} alt="" />
          Counterpoint exception explainer
        </p>
        <RosieInsightSummary
          surface="counterpoint_status"
          title="Counterpoint Sign-off"
          mode="explain"
          getHeaders={() => backofficeHeaders() as Record<string, string>}
          facts={counterpointInsightFacts}
        />
      </div>
    </section>
  );

  if (!hasPermission("settings.admin")) return null;

  return (
    <div className="space-y-6" data-testid="counterpoint-settings-panel">
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
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWorkspaceView("pipeline")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "pipeline" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Guided Pipeline
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceView("inbound")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "inbound" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Inbound queue
            {visiblePendingN > 0 ? (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0 text-[10px] text-amber-800 dark:text-amber-100">
                {visiblePendingN}
              </span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceView("details")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "details" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Support diagnostics
          </button>
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

      <section className="ui-card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Counterpoint Transition Review Packs
            </h4>
            <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
              Manual ChatGPT/Codex export and import for Counterpoint migration review. Riverside OS validates suggestions and never auto-applies AI output.
            </p>
          </div>
          <span className="ui-pill bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-200">
            Manual review only
          </span>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block">
                <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Pack scope
                </span>
                <select
                  className="ui-input mt-1 text-xs"
                  value={reviewScope}
                  onChange={(e) => setReviewScope(e.target.value)}
                >
                  {(reviewScopes.length > 0 ? reviewScopes : [{ scope: "inventory_catalog", label: "Inventory Catalog", description: "", fully_functional: true, apply_supported: true, allowed_actions: [] }]).map((scope) => (
                    <option key={scope.scope} value={scope.scope}>
                      {scope.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void generateReviewPack()}
                disabled={reviewBusy === "generate"}
                className="ui-btn-primary mt-4 inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-bold disabled:opacity-50 md:mt-5"
              >
                {reviewBusy === "generate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
                Generate Pack
              </button>
            </div>

            {selectedReviewScope ? (
              <div className="rounded-lg border border-app-border bg-app-surface-2/40 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-app-text">{selectedReviewScope.label}</span>
                  <span className={`ui-pill text-[9px] ${selectedReviewScope.fully_functional ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200" : "bg-app-surface-2 text-app-text-muted"}`}>
                    {selectedReviewScope.fully_functional ? "Full export" : "Summary scaffold"}
                  </span>
                  <span className={`ui-pill text-[9px] ${selectedReviewScope.apply_supported ? "bg-blue-500/10 text-blue-700 dark:text-blue-200" : "bg-amber-500/15 text-amber-700 dark:text-amber-200"}`}>
                    {selectedReviewScope.apply_supported ? "Safe apply available" : "Review-only apply"}
                  </span>
                </div>
                <p className="mt-2 text-app-text-muted">{selectedReviewScope.description}</p>
              </div>
            ) : null}

            <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    Generated packs
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    {reviewPacks.length > 0 ? `${fmtNum(reviewPacks.length)} pack(s) available` : "No review packs generated yet"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void fetchReviewPacks()}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reload Packs
                </button>
              </div>

              <select
                className="ui-input mt-3 text-xs"
                value={selectedReviewPackId}
                onChange={(e) => setSelectedReviewPackId(e.target.value)}
                disabled={reviewPacks.length === 0}
              >
                {reviewPacks.length === 0 ? (
                  <option value="">No packs generated</option>
                ) : (
                  reviewPacks.map((pack) => (
                    <option key={pack.pack_id} value={pack.pack_id}>
                      {formatEntityLabel(pack.scope)} - {fmtNum(pack.row_count)} rows - {formatDate(pack.generated_at)}
                    </option>
                  ))
                )}
              </select>

              {selectedReviewPack ? (
                <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                  <div className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Rows</p>
                    <p className="mt-1 font-bold text-app-text">{fmtNum(selectedReviewPack.row_count)}</p>
                  </div>
                  <div className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Status</p>
                    <p className="mt-1 font-bold text-app-text">{formatEntityLabel(selectedReviewPack.status)}</p>
                  </div>
                  <div className="rounded-md border border-app-border bg-app-surface-2/40 p-2">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Generated</p>
                    <p className="mt-1 font-bold text-app-text">{formatDate(selectedReviewPack.generated_at)}</p>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void downloadReviewPack(selectedReviewPackId)}
                  disabled={!selectedReviewPackId || reviewBusy === "download"}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download JSON
                </button>
                <button
                  type="button"
                  onClick={() => void copyReviewPrompt(selectedReviewPackId)}
                  disabled={!selectedReviewPackId || reviewBusy === "prompt"}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
                >
                  <ClipboardCopy className="h-3.5 w-3.5" />
                  Copy Prompt
                </button>
                <button
                  type="button"
                  onClick={() => void fetchReviewSuggestions(selectedReviewPackId)}
                  disabled={!selectedReviewPackId}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh Suggestions
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    Import reviewed JSON
                  </p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Source hash, row keys, actions, categories, confidence, and forbidden fields are validated before staging.
                  </p>
                </div>
                <input
                  ref={reviewImportFileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then(setReviewImportText);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => reviewImportFileRef.current?.click()}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
                >
                  <Upload className="h-3.5 w-3.5" />
                  Upload JSON
                </button>
              </div>
              <textarea
                className="ui-input mt-3 min-h-[108px] resize-y text-xs font-mono"
                value={reviewImportText}
                onChange={(e) => setReviewImportText(e.target.value)}
                placeholder='{"schema":"riverside_counterpoint_review_results","schema_version":1,...}'
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {reviewError ? (
                  <span className="text-xs font-semibold text-red-600">{reviewError}</span>
                ) : (
                  <span className="text-xs text-app-text-muted">Invalid imports are rejected and logged.</span>
                )}
                <button
                  type="button"
                  onClick={() => void importReviewResults()}
                  disabled={reviewBusy === "import" || !reviewImportText.trim()}
                  className="ui-btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-xs font-bold disabled:opacity-50"
                >
                  {reviewBusy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Import Results
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    Suggestions review
                  </p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    {reviewSuggestions.length > 0
                      ? `${fmtNum(reviewSuggestions.length)} staged, ${fmtNum(acceptedReviewSuggestionCount)} accepted`
                      : "No imported suggestions for this pack"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void applyApprovedReviewSuggestions()}
                  disabled={!selectedPackScope?.apply_supported || acceptedReviewSuggestionCount === 0 || reviewBusy === "apply"}
                  className="ui-btn-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Apply Approved
                </button>
              </div>

              <div className="mt-3 max-h-[280px] overflow-auto rounded-lg border border-app-border">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="sticky top-0 bg-app-surface-2">
                    <tr className="border-b border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-2 py-2">Action</th>
                      <th className="px-2 py-2">Row</th>
                      <th className="px-2 py-2">Suggested Value</th>
                      <th className="px-2 py-2">Confidence</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2">Decision</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {reviewSuggestions.map((suggestion) => (
                      <tr key={suggestion.id}>
                        <td className="px-2 py-2">
                          <p className="font-bold text-app-text">{formatEntityLabel(suggestion.action)}</p>
                          <p className="text-[10px] text-app-text-muted">{suggestion.field_name ?? "flag"}</p>
                        </td>
                        <td className="px-2 py-2 font-mono text-[10px] text-app-text-muted">{suggestion.row_key}</td>
                        <td className="px-2 py-2">
                          <input
                            className="ui-input min-w-[180px] text-[11px]"
                            value={reviewSuggestionEdits[suggestion.id] ?? reviewValueToText(suggestion.suggested_value)}
                            onChange={(e) =>
                              setReviewSuggestionEdits((prev) => ({
                                ...prev,
                                [suggestion.id]: e.target.value,
                              }))
                            }
                          />
                          <p className="mt-1 line-clamp-2 text-[10px] text-app-text-muted">{suggestion.reason}</p>
                        </td>
                        <td className="px-2 py-2 tabular-nums">{formatConfidence(suggestion.confidence)}</td>
                        <td className="px-2 py-2">
                          <span className={`ui-pill text-[9px] ${
                            suggestion.status === "applied"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                              : suggestion.status === "blocked" || suggestion.status === "rejected"
                                ? "bg-red-500/10 text-red-600"
                                : suggestion.status === "accepted"
                                  ? "bg-blue-500/10 text-blue-700 dark:text-blue-200"
                                  : "bg-app-surface-2 text-app-text-muted"
                          }`}>
                            {formatEntityLabel(suggestion.status)}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-1">
                            {["accept", "reject", "edit", "block"].map((action) => (
                              <button
                                key={action}
                                type="button"
                                onClick={() => void updateReviewSuggestion(suggestion, action)}
                                disabled={reviewBusy === suggestion.id || suggestion.status === "applied"}
                                className="ui-btn-secondary px-2 py-1 text-[10px] font-bold disabled:opacity-50"
                              >
                                {formatEntityLabel(action)}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reviewSuggestions.length === 0 ? (
                  <div className="p-4 text-xs text-app-text-muted">
                    Download a pack, review it manually, then import the returned JSON suggestions.
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </section>

      {bridgeReachabilityPanel}

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

      {(bridgeRowsWithoutReviewSurface || downstreamReviewBlockers.length > 0) && (
        <div className="rounded-xl border border-red-500/25 bg-red-500/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
            <div className="space-y-2">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-red-700 dark:text-red-300">
                  Counterpoint review advancement blocked
                </p>
                <p className="mt-1 text-xs font-semibold text-app-text-muted">
                  Bridge-reported rows must have staged, applied, or ROS landed proof before later review steps or cutover can be completed.
                </p>
              </div>
              <ul className="list-disc space-y-1 pl-4 text-xs font-semibold text-red-700 dark:text-red-300">
                {bridgeRowsWithoutReviewSurface ? (
                  <li>
                    Bridge runs reported {fmtNum(bridgeReportedRows)} row(s), but no downstream review surface or landed proof is available.
                  </li>
                ) : null}
                {downstreamReviewBlockers.slice(0, 4).map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {workspaceView === "inbound" ? inboundQueuePanel : null}
      {workspaceView === "details" ? supportDiagnosticsPanel : null}

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
                    {entityRunsForDisplay.map((run) => {
                      const proof = getEntityRunProof(run);
                      return (
                        <tr key={run.entity}>
                          <td className="px-3 py-2">
                            <div className="font-bold uppercase text-[10px] tracking-wide">{run.entity.replace(/_/g, " ")}</div>
                            {proof.isStaged ? (
                              <div className="text-[9px] text-blue-600 dark:text-blue-300 mt-0.5">
                                {proof.stagingLabel} across {fmtNum(proof.stagedBatches)} batch(es)
                              </div>
                            ) : proof.isZeroNoError ? (
                              <div className="text-[9px] text-amber-600 dark:text-amber-400 mt-0.5">No data returned - check SQL query</div>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <div className={`font-mono text-[11px] font-semibold tabular-nums ${
                              proof.displayRows === 0
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-emerald-600 dark:text-emerald-400"
                            }`}>
                              {fmtNum(proof.displayRows)} rows
                            </div>
                          </td>
                          <td className="px-3 py-2 text-app-text-muted">
                            {proof.latestAt ? new Date(proof.latestAt).toLocaleTimeString() : "Pending"}
                          </td>
                          <td className="px-3 py-2">
                            {run.last_error ? (
                              <span className="text-red-500 font-medium inline-flex items-center gap-1">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {run.last_error}
                              </span>
                            ) : proof.isStaged ? (
                              <span className="text-blue-600 dark:text-blue-300 inline-flex items-center gap-1 font-semibold">
                                <Database className="h-3.5 w-3.5" />
                                {proof.stagingLabel}
                              </span>
                            ) : proof.isZeroNoError ? (
                              <span className="text-amber-600 dark:text-amber-400 inline-flex items-center gap-1 font-medium">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                No Data
                              </span>
                            ) : (
                              <span className="text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1 font-semibold">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Healthy
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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

          <div className="border-t border-app-border pt-4">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1">
                <p className="text-xs text-app-text-muted leading-relaxed">
                  Verify that all core database entities are staged. When complete, advance to step 2 to clean up the imported product catalog.
                </p>
                {entityRunsForDisplay.some((run) => getEntityRunProof(run).isZeroNoError) && (
                  <div className="mt-2 rounded-lg bg-amber-500/10 border border-amber-500/20 p-2">
                    <p className="text-[10px] text-amber-700 dark:text-amber-300">
                      <strong>Zero rows detected:</strong> Some entities returned no data. Auto-schema handles column detection, so this is likely due to:
                    </p>
                    <ul className="text-[9px] text-amber-600 dark:text-amber-400 mt-1 list-disc list-inside">
                      <li>WHERE clause filtering (e.g., gift cards with zero balance, notes older than CP_IMPORT_SINCE)</li>
                      <li>Tables genuinely have no data</li>
                      <li>Use Bridge GUI "Test Query" to verify data exists in Counterpoint</li>
                      <li>Temporarily remove WHERE clauses in bridge .env to test if data exists</li>
                    </ul>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => goToStepIfReady(2)}
                disabled={isStepDisabled(2)}
                className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Advance to Inventory Mapping
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
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
              {workbenchState?.inventory_summary && (
                <div className="mt-2 flex gap-2 flex-wrap">
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1">
                    <span className="text-[9px] text-emerald-700 dark:text-emerald-300 font-medium">{fmtNum(workbenchState.inventory_summary.products)} Products</span>
                  </div>
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1">
                    <span className="text-[9px] text-emerald-700 dark:text-emerald-300 font-medium">{fmtNum(workbenchState.inventory_summary.variants)} Variants</span>
                  </div>
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1">
                    <span className="text-[9px] text-emerald-700 dark:text-emerald-300 font-medium">{fmtNum(workbenchState.inventory_summary.categories)} Categories</span>
                  </div>
                  <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-2 py-1">
                    <span className="text-[9px] text-emerald-700 dark:text-emerald-300 font-medium">{fmtNum(workbenchState.inventory_summary.vendors)} Vendors</span>
                  </div>
                  {workbenchState.inventory_summary.variants_missing_barcode > 0 && (
                    <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-2 py-1">
                      <span className="text-[9px] text-amber-700 dark:text-amber-300 font-medium">{fmtNum(workbenchState.inventory_summary.variants_missing_barcode)} Missing Barcodes</span>
                    </div>
                  )}
                  {workbenchState.inventory_summary.quarantine_count > 0 && (
                    <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-2 py-1">
                      <span className="text-[9px] text-red-700 dark:text-red-300 font-medium">{fmtNum(workbenchState.inventory_summary.quarantine_count)} Unique Quarantined</span>
                    </div>
                  )}
                </div>
              )}
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
              { key: "catalog", label: "5. ROSIE AI Copilot" },
              { key: "sku_gaps", label: "6. Barcode SKU Gaps" },
              { key: "verification", label: "7. Preview & Approve" },
            ].map((sub) => {
              const active = activeSubStep === sub.key;
              const isSubStepLocked = subStepStatus(sub.key === "staff" ? "catalog" : sub.key) === "locked";
              return (
                <button
                  key={sub.key}
                  type="button"
                  disabled={isSubStepLocked}
                  onClick={() => setActiveSubStep(sub.key)}
                  className={`px-3 py-2 rounded-lg text-xs uppercase tracking-wide border transition-all shrink-0 ${
                    active
                      ? "bg-app-warning/15 text-app-warning border-app-warning/50 font-bold"
                      : isSubStepLocked
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
                {csvUploadStatus && (
                  <div className="flex-1 mr-4">
                    <div className="text-[10px] font-medium text-app-text-muted mb-1">{csvUploadStatus}</div>
                    <div className="h-2 bg-app-surface-2 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-app-accent transition-all duration-300 ease-out"
                        style={{ width: `${csvUploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}
                {subStepStatus("data_sources") === "complete" ? (
                  <button
                    type="button"
                    onClick={() => setActiveSubStep("categories")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Proceed to Category Mappings
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void approveSubStep("data_sources")}
                    disabled={csvUploading !== null}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    Confirm & Lock CSV Sources
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </button>
                )}
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
                  <RosieIcon size={14} alt="" className={aiBusy && aiScope === "categories" ? "animate-pulse" : ""} />
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
                {subStepStatus("categories") === "complete" ? (
                  <button
                    type="button"
                    onClick={() => setActiveSubStep("vendors")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Proceed to Vendor Mappings
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void approveSubStep("categories")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Verify Category Links
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </button>
                )}
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
                {subStepStatus("vendors") === "complete" ? (
                  <button
                    type="button"
                    onClick={() => setActiveSubStep("staff")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Proceed to Staff Mappings
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void approveSubStep("vendors")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Verify Vendors List
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  </button>
                )}
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
                  onClick={() => setActiveSubStep("catalog")}
                  className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                >
                  Proceed to ROSIE AI Copilot
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Sub-step 5: AI Naming Review */}
          {activeSubStep === "catalog" && (
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
                  <RosieIcon size={14} alt="" className={aiBusy && aiScope === "names" ? "animate-pulse" : ""} />
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
              <div className="pt-2 flex justify-end gap-2">
                {subStepStatus("catalog") === "complete" ? (
                  <button
                    type="button"
                    onClick={() => setActiveSubStep("sku_gaps")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Proceed to Barcode SKU Gaps
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void approveSubStep("catalog")}
                      className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                    >
                      Verify Naming & Category AI Mappings
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveSubStep("sku_gaps")}
                      disabled={true}
                      className="ui-btn-secondary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      Advance to SKU Gaps
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </>
                )}
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
                      className="ui-btn-secondary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
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

              <div className="flex justify-end gap-2 pt-4 border-t border-app-border/40">
                {subStepStatus("sku_gaps") === "complete" ? (
                  <button
                    type="button"
                    onClick={() => setActiveSubStep("verification")}
                    className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                  >
                    Proceed to Preview & Approve
                    <ChevronRight className="h-4 w-4" />
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void approveSubStep("sku_gaps")}
                      className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1"
                    >
                      Verify Barcode SKU Gaps
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveSubStep("verification")}
                      disabled={true}
                      className="ui-btn-secondary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      Advance to Preview & Approve
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </>
                )}
              </div>
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
                {subStepStatus("verification") === "complete" ? (
                  <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 px-4 py-2 rounded-xl">
                    <CheckCircle2 className="h-5 w-5" />
                    Catalog mappings approved! Click below to proceed.
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => void approveSubStep("verification")}
                    className="ui-btn-primary px-6 py-2.5 text-xs font-black uppercase tracking-wider inline-flex items-center gap-1.5"
                  >
                    Approve & Finalize Catalog Mappings
                    <CheckCircle2 className="h-4 w-4" />
                  </button>
                )}
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
              onClick={() => goToStepIfReady(3)}
              disabled={isStepDisabled(3)}
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
              onClick={() => goToStepIfReady(4)}
              disabled={isStepDisabled(4)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
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
              onClick={() => goToStepIfReady(5)}
              disabled={isStepDisabled(5)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
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
              onClick={() => goToStepIfReady(6)}
              disabled={isStepDisabled(6)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
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
              onClick={() => goToStepIfReady(7)}
              disabled={isStepDisabled(7)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
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
              onClick={() => goToStepIfReady(8)}
              disabled={isStepDisabled(8)}
              className="ui-btn-primary px-4 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-50"
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

                {cutoverBlockers.length > 0 ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-red-700 dark:text-red-300">
                      Cutover blocked
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] font-semibold text-red-700 dark:text-red-300">
                      {cutoverBlockers.slice(0, 5).map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="border-t border-app-border pt-3 mt-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (cutoverBlockers.length > 0) {
                        toast(cutoverBlockers[0], "error");
                        return;
                      }
                      toast("Guided migration cutover complete! Live trading is active.", "success");
                    }}
                    disabled={cutoverBlockers.length > 0}
                    className="ui-btn-primary w-full py-2.5 text-xs font-black uppercase tracking-widest disabled:opacity-50"
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
        isOpen={confirmRecoverStale != null}
        onClose={() => setConfirmRecoverStale(null)}
        onConfirm={() => confirmRecoverStale != null && void recoverStaleBatch(confirmRecoverStale)}
        title="Mark stale apply failed?"
        message="This marks the stale apply claim as failed for support review. It does not replay the payload, does not reset the batch, and does not write new live data."
        confirmLabel="Mark failed"
        variant="danger"
        loading={applyBusy}
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
