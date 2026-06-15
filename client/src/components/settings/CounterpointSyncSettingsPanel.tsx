import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Database,
  RotateCcw,
  Upload,
  Download,
  ClipboardCopy,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import PromptModal from "../ui/PromptModal";
import ConfirmationModal from "../ui/ConfirmationModal";
import DuplicateReviewQueueSection from "../customers/DuplicateReviewQueueSection";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import RosieInsightSummary from "../help/RosieInsightSummary";
import type { Customer } from "../pos/CustomerSelector";

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

interface CounterpointImportRunSnapshot {
  id: string;
  run_kind: string;
  status: string;
  history_start: string;
  bridge_hostname: string | null;
  bridge_version: string | null;
  ros_base_url: string | null;
  source_fingerprint: string | null;
  preflight_passed: boolean;
  preflight_blockers: unknown;
  totals: unknown;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CounterpointImportPreflightRow {
  entity_key: string;
  label: string;
  source_count: number;
  source_sum: string | null;
  source_checksum: string | null;
  required: boolean;
  suspicious_min_count: number | null;
  status: string;
  message: string | null;
}

interface CounterpointImportCommandCenterSummary {
  generated_at: string;
  mode: string;
  required_history_start: string;
  token_configured: boolean;
  preflight_received: boolean;
  import_run_received: boolean;
  proof_scope: string;
  proof_scope_note: string;
  latest_preflight: CounterpointImportRunSnapshot | null;
  latest_import_run: CounterpointImportRunSnapshot | null;
  source_counts: CounterpointImportPreflightRow[];
  landing_rows: CounterpointLandingVerificationRow[];
  snapshot_reconciliation: CounterpointSnapshotReconciliationRow[];
  open_exception_count: number;
  fallback_landed_exception_count: number;
  staging_open_count: number;
  ready_for_import: boolean;
  ready_for_go_live_review: boolean;
  recommendation: string;
}

interface CounterpointImportExceptionRow {
  id: string;
  entity_key: string;
  source_key: string | null;
  severity: string;
  reason_code: string;
  message: string;
  suggested_fix: string | null;
  fallback_landed: boolean;
  ros_table: string | null;
  ros_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CounterpointSyncWorkbenchStatus {
  configured: boolean;
  reachable: boolean;
  message: string;
  error?: string;
  health?: {
    service?: string;
    hostname?: string;
    generated_at?: string;
    schema_version?: number;
    store_path?: string;
    store?: {
      path?: string;
      exists?: boolean;
      backup_exists?: boolean;
      last_write_at?: string | null;
      size_bytes?: number;
      format_version?: number;
      readable?: boolean;
      error?: string | null;
    };
    last_bridge_heartbeat?: {
      received_at?: string;
      bridge_hostname?: string;
      bridge_version?: string;
      phase?: string;
      target_sync_reachable?: boolean;
    } | null;
    summary?: {
      runs_count?: number;
      ready_sections?: number;
      imported_sections?: number;
      blocked_sections?: number;
      warnings?: number;
      blockers?: number;
    };
  };
}

interface CounterpointSyncRunSummary {
  sync_run_id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  sections_ready: number;
  warnings: number;
  blockers: number;
  source_batches?: number;
  imported_status: string;
}

interface CounterpointSyncRunSection {
  section: string;
  label: string;
  status: string;
  source_count: number;
  prepared_count: number;
  warnings: number;
  blockers: number;
  package_fingerprint: string | null;
  updated_at: string;
  approved_at: string | null;
  approved_by: string | null;
  imported_at?: string | null;
  ros_import_run_id?: string | null;
  ai_pending_suggestions?: number;
  ai_accepted_suggestions?: number;
  ai_applied_suggestions?: number;
  ai_manual_review_suggestions?: number;
}

interface CounterpointSyncPackage {
  sync_run_id: string;
  section: string;
  entity: string;
  schema_version: number;
  package_fingerprint: string;
  generated_at: string;
  source_counts: {
    raw: number;
    prepared: number;
    warnings: number;
    blockers: number;
  };
  payload: { rows?: unknown[]; [key: string]: unknown };
  exceptions: unknown[];
  provenance: unknown[];
}

interface CounterpointSyncRunDetail {
  run: CounterpointSyncRunSummary & { sections: CounterpointSyncRunSection[] };
}

interface PendingSyncImport {
  section: CounterpointSyncRunSection;
  pkg: CounterpointSyncPackage;
}

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
  onNavigateCustomers?: (section?: string) => void;
  onOpenWeddingParty?: (partyId: string) => void;
  onStartSaleInPos?: (customer: Customer) => void;
  onNavigateRegister?: () => void;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}

export default function CounterpointSyncSettingsPanel({
  onNavigateCustomers,
  onOpenWeddingParty,
  onStartSaleInPos,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenTransactionInBackoffice,
}: CounterpointSyncSettingsPanelProps = {}) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<StagingBatchRow[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [recoverBatch, setRecoverBatch] = useState<StagingBatchRow | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [inventoryAdvanceAttempted, setInventoryAdvanceAttempted] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"overview" | "pipeline" | "inbound" | "details" | "ai_review" | "customer_duplicates">(() => {
    if (typeof window === "undefined") return "overview";
    const saved = window.localStorage.getItem("counterpoint.statusSection");
    return saved === "details" ? saved : "overview";
  });

  const [workbenchState, setWorkbenchState] = useState<WorkbenchState | null>(null);

  const [dsHealth, setDsHealth] = useState<DataSourcesHealth | null>(null);
  const [csvUploading, setCsvUploading] = useState<string | null>(null);
  const [csvUploadProgress, setCsvUploadProgress] = useState<number>(0);
  const [csvUploadStatus, setCsvUploadStatus] = useState<string | null>(null);
  const lsFileRef = useRef<HTMLInputElement>(null);
  const cpFileRef = useRef<HTMLInputElement>(null);

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

  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);

  const [landingVerification, setLandingVerification] = useState<CounterpointLandingVerificationSummary | null>(null);
  const [commandCenter, setCommandCenter] = useState<CounterpointImportCommandCenterSummary | null>(null);
  const [importExceptions, setImportExceptions] = useState<CounterpointImportExceptionRow[]>([]);
  const [syncWorkbenchStatus, setSyncWorkbenchStatus] = useState<CounterpointSyncWorkbenchStatus | null>(null);
  const [syncRuns, setSyncRuns] = useState<CounterpointSyncRunSummary[]>([]);
  const [selectedSyncRunId, setSelectedSyncRunId] = useState<string>("");
  const [selectedSyncRun, setSelectedSyncRun] = useState<CounterpointSyncRunDetail | null>(null);
  const [syncPackage, setSyncPackage] = useState<CounterpointSyncPackage | null>(null);
  const [syncActionBusy, setSyncActionBusy] = useState<string | null>(null);
  const [pendingSyncImport, setPendingSyncImport] = useState<PendingSyncImport | null>(null);
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
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

  const fetchCommandCenter = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/command-center`, {
        headers: headers(),
      });
      if (res.ok) {
        setCommandCenter((await res.json()) as CounterpointImportCommandCenterSummary);
      }
    } catch {
      setCommandCenter(null);
    }
  }, [baseUrl, headers, hasPermission]);

  const fetchSyncWorkbenchStatus = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/sync-workbench/status`, {
        headers: headers(),
      });
      if (res.ok) {
        setSyncWorkbenchStatus((await res.json()) as CounterpointSyncWorkbenchStatus);
      }
    } catch {
      setSyncWorkbenchStatus({
        configured: false,
        reachable: false,
        message: "Counterpoint SYNC app is not reachable.",
      });
    }
  }, [baseUrl, headers, hasPermission]);

  const fetchSyncRuns = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/sync-workbench/runs`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { runs?: CounterpointSyncRunSummary[] };
        const runs = data.runs ?? [];
        setSyncRuns(runs);
        setSelectedSyncRunId((current) => current || runs[0]?.sync_run_id || "");
      }
    } catch {
      setSyncRuns([]);
    }
  }, [baseUrl, headers, hasPermission]);

  const fetchSelectedSyncRun = useCallback(async (runId?: string) => {
    const id = runId ?? selectedSyncRunId;
    if (!id || !hasPermission("settings.admin")) {
      setSelectedSyncRun(null);
      return;
    }
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/sync-workbench/runs/${encodeURIComponent(id)}`,
        { headers: headers() },
      );
      if (res.ok) {
        setSelectedSyncRun((await res.json()) as CounterpointSyncRunDetail);
      }
    } catch {
      setSelectedSyncRun(null);
    }
  }, [baseUrl, headers, hasPermission, selectedSyncRunId]);

  const loadSyncPackage = useCallback(async (section: string) => {
    if (!selectedSyncRunId) return null;
    setSyncActionBusy(`package:${section}`);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/sync-workbench/runs/${encodeURIComponent(selectedSyncRunId)}/packages/${encodeURIComponent(section)}`,
        { headers: headers() },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not load SYNC package");
      const pkg = data as CounterpointSyncPackage;
      setSyncPackage(pkg);
      return pkg;
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load SYNC package", "error");
      return null;
    } finally {
      setSyncActionBusy(null);
    }
  }, [baseUrl, headers, selectedSyncRunId, toast]);

  const fetchImportExceptions = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/exceptions?limit=200`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { rows?: CounterpointImportExceptionRow[] };
        setImportExceptions(data.rows ?? []);
      }
    } catch {
      setImportExceptions([]);
    }
  }, [baseUrl, headers, hasPermission]);

  const fetchBatches = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches?limit=5000`,
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
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/workbench/state`, {
        headers: headers(),
      });
      if (res.ok) {
        setWorkbenchState((await res.json()) as WorkbenchState);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers, hasPermission]);

  const fetchDsHealth = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/workbench/data-sources-health`,
        { headers: headers() },
      );
      if (res.ok) setDsHealth((await res.json()) as DataSourcesHealth);
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
      fetchCommandCenter(),
      fetchSyncWorkbenchStatus(),
      fetchSyncRuns(),
      fetchImportExceptions(),
      fetchBatches(),
      fetchWorkbenchState(),
      fetchDsHealth(),
      fetchMergePreview(),
      fetchReviewScopes(),
      fetchReviewPacks(),
      fetchLandingVerification(),
      fetchResetPreview(),
    ]);
    setLoading(false);
  }, [
    fetchStatus,
    fetchCommandCenter,
    fetchSyncWorkbenchStatus,
    fetchSyncRuns,
    fetchImportExceptions,
    fetchBatches,
    fetchWorkbenchState,
    fetchDsHealth,
    fetchMergePreview,
    fetchReviewScopes,
    fetchReviewPacks,
    fetchLandingVerification,
    fetchResetPreview,
  ]);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    void fetchReviewSuggestions(selectedReviewPackId);
  }, [fetchReviewSuggestions, selectedReviewPackId]);

  useEffect(() => {
    void fetchSelectedSyncRun(selectedSyncRunId);
  }, [fetchSelectedSyncRun, selectedSyncRunId]);

  /* ── Event Handlers ── */

  const resolveImportException = useCallback(async (exceptionId: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/exceptions/${exceptionId}/resolve`,
        {
          method: "PATCH",
          headers: headers(),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not resolve import exception");
      }
      toast("Import exception marked resolved.", "success");
      void fetchImportExceptions();
      void fetchCommandCenter();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not resolve import exception", "error");
    }
  }, [baseUrl, fetchCommandCenter, fetchImportExceptions, headers, toast]);

  const runSyncPackagePreflight = useCallback(async (section: string) => {
    if (!selectedSyncRunId) return;
    setSyncActionBusy(`preflight:${section}`);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/sync-workbench/runs/${encodeURIComponent(selectedSyncRunId)}/sections/${encodeURIComponent(section)}/preflight`,
        {
          method: "POST",
          headers: headers(),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "ROS preflight failed");
      toast("ROS preflight recorded for selected SYNC package.", "success");
      void fetchCommandCenter();
    } catch (error) {
      toast(error instanceof Error ? error.message : "ROS preflight failed", "error");
    } finally {
      setSyncActionBusy(null);
    }
  }, [baseUrl, fetchCommandCenter, headers, selectedSyncRunId, toast]);

  const importSyncSection = useCallback(async () => {
    const pending = pendingSyncImport;
    if (!pending || !selectedSyncRunId) return;
    setSyncActionBusy(`import:${pending.section.section}`);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/sync-workbench/runs/${encodeURIComponent(selectedSyncRunId)}/sections/${encodeURIComponent(pending.section.section)}/import`,
        {
          method: "POST",
          headers: headers(),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not import selected SYNC package");
      toast("Selected SYNC package imported through ROS.", "success");
      if (data.sync_mark_imported_warning) {
        toast(`ROS import succeeded, but SYNC status was not updated: ${String(data.sync_mark_imported_warning)}`, "error");
      }
      setPendingSyncImport(null);
      void fetchCommandCenter();
      void fetchImportExceptions();
      void fetchSelectedSyncRun(selectedSyncRunId);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not import selected SYNC package", "error");
    } finally {
      setSyncActionBusy(null);
    }
  }, [
    baseUrl,
    fetchCommandCenter,
    fetchImportExceptions,
    fetchSelectedSyncRun,
    headers,
    pendingSyncImport,
    selectedSyncRunId,
    toast,
  ]);

  const prepareSyncImport = useCallback(async (section: CounterpointSyncRunSection) => {
    const pkg = await loadSyncPackage(section.section);
    if (!pkg) return;
    setPendingSyncImport({ section, pkg });
  }, [loadSyncPackage]);

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
      toast(`Suggestions saved: ${fmtNum(data.stored_suggestions ?? 0)} pending review.`, "success");
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
      await fetchWorkbenchState();
      await fetchCommandCenter();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not apply approved suggestions", "error");
    } finally {
      setReviewBusy(null);
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
        toast("Live ROS Counterpoint import tables wiped. Support queue state is reset.", "success");
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

  const recoverStaleBatch = async (batch: StagingBatchRow) => {
    setRecoveryBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${batch.id}/recover-stale`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers(),
          },
          body: JSON.stringify({ stale_after_minutes: 15 }),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(json?.error ?? "Unable to recover stale Counterpoint batch.");
      }
      setBatches((current) =>
        current.map((row) =>
          row.id === batch.id
            ? {
                ...row,
                status: "failed",
                recovered_at: new Date().toISOString(),
                recovered_by_staff_name: row.recovered_by_staff_name ?? "Chris G",
                recovery_reason:
                  row.recovery_reason ??
                  "Stale applying batch marked failed after operator recovery review; payload was not replayed.",
              }
            : row,
        ),
      );
      toast("Stale Counterpoint apply marked failed for review.", "success");
      setRecoverBatch(null);
      void fetchBatches();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Unable to recover stale Counterpoint batch.", "error");
    } finally {
      setRecoveryBusy(false);
    }
  };

  /* ── Calculations & Helpers ── */
  const proofScopeLabel =
    commandCenter?.proof_scope === "current_import_run"
      ? "Current import run"
      : commandCenter?.proof_scope === "preflight_only"
        ? "Preflight only"
        : "No import preflight";
  const stagingCountsByEntity = useMemo(() => {
    const rows = new Map<string, StagingEntityCountRow>();
    for (const count of status?.staging_entity_counts ?? []) {
      rows.set(count.entity, count);
    }
    return rows;
  }, [status?.staging_entity_counts]);
  const selectedReviewPack =
    reviewPacks.find((pack) => pack.pack_id === selectedReviewPackId) ?? reviewPacks[0] ?? null;
  const selectedReviewScope =
    reviewScopes.find((scope) => scope.scope === reviewScope) ?? reviewScopes.find((scope) => scope.scope === selectedReviewPack?.scope) ?? null;
  const selectedPackScope =
    selectedReviewPack == null
      ? null
      : reviewScopes.find((scope) => scope.scope === selectedReviewPack.scope) ?? null;
  const acceptedReviewSuggestionCount = reviewSuggestions.filter((s) => s.status === "accepted").length;
  const selectedSyncRunSummary =
    syncRuns.find((run) => run.sync_run_id === selectedSyncRunId) ?? syncRuns[0] ?? null;
  const selectedSyncSections = selectedSyncRun?.run.sections ?? [];
  const selectedSyncReadySections = selectedSyncSections.filter((section) =>
    ["ready", "ready_with_warnings", "imported"].includes(section.status),
  ).length;
  const selectedSyncImportedSections = selectedSyncSections.filter((section) => section.status === "imported").length;
  const syncHealth = syncWorkbenchStatus?.health;
  const syncStore = syncHealth?.store;
  const syncHeartbeat = syncHealth?.last_bridge_heartbeat;
  const latestPreflightForSelectedRun =
    commandCenter?.latest_preflight?.ros_base_url === `counterpoint-sync://${selectedSyncRunId}`
      ? commandCenter.latest_preflight
      : null;
  const loadedPackageSection = syncPackage?.section ?? null;
  const preflightStateForSection = (section: CounterpointSyncRunSection) => {
    if (!selectedSyncRunId) return { label: "No selected run", ready: false, changed: false };
    if (!section.package_fingerprint) return { label: "Missing fingerprint", ready: false, changed: false };
    if (!latestPreflightForSelectedRun?.source_fingerprint) {
      return { label: "Not run for selected run", ready: false, changed: false };
    }
    if (latestPreflightForSelectedRun.source_fingerprint !== section.package_fingerprint) {
      return { label: "Package changed after preflight", ready: false, changed: true };
    }
    if (!latestPreflightForSelectedRun.preflight_passed) {
      return { label: "Blocked by ROS preflight", ready: false, changed: false };
    }
    return { label: "Ready to import", ready: true, changed: false };
  };
  const importDisabledReasonForSection = (section: CounterpointSyncRunSection) => {
    const preflightState = preflightStateForSection(section);
    if (!selectedSyncRunId) return "Select a SYNC run first.";
    if (section.blockers > 0 || section.status === "blocked") return "Unresolved SYNC blockers.";
    if (!section.package_fingerprint) return "Missing package fingerprint.";
    if (loadedPackageSection === section.section && syncPackage?.schema_version !== 1) return "Unsupported package schema.";
    if (!preflightState.ready) return preflightState.label;
    return null;
  };
  const syncWorkbenchConnectionClass = syncWorkbenchStatus?.reachable
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
    : syncWorkbenchStatus?.configured
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200"
      : "border-red-500/25 bg-red-500/10 text-red-600";

  const catalogBatches = useMemo(() => batches.filter((b) => b.entity === "catalog"), [batches]);
  const inventoryBatches = useMemo(() => batches.filter((b) => b.entity === "inventory"), [batches]);
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
      message: `${label} has ${fmtNum(bridgeRows)} Bridge row(s), but no ROS landed proof is available for review.`,
    };
  };
  const inventoryProducts = workbenchState?.inventory_summary?.products ?? 0;
  const inventoryVariants = workbenchState?.inventory_summary?.variants ?? 0;
  const hasLandedInventory = inventoryProducts > 0 && inventoryVariants > 0;
  const catalogStagedRows = stagedRowsFor("catalog", catalogBatches);
  const inventoryStagedRows = stagedRowsFor("inventory", inventoryBatches);
  const bridgeReportedCatalogRows = bridgeRowsFor(["catalog", "inventory"]) + (dsHealth?.bridge_products ?? 0);
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
      ? `Bridge reported catalog/inventory rows, but ROS has ${fmtNum(inventoryProducts)} Counterpoint product(s) and ${fmtNum(inventoryVariants)} variant(s). Run or repair the direct import before approving catalog cleanup.`
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
  const bridgeReportedEntityCount = (status?.entity_runs ?? []).filter(
    (run) => (run.records_processed ?? 0) > 0,
  ).length;
  const recentIssueCount = status?.recent_issues?.filter((issue) => !issue.resolved).length ?? 0;
  const stagedReviewRows = [
    customerReviewReady,
    ticketReviewReady,
    giftCardReviewReady,
    openDocReviewReady,
    loyaltyReviewReady,
  ].reduce((sum, review) => sum + review.stagedRows, 0);
  const stagedImportRows = stagedReviewRows + catalogStagedRows + inventoryStagedRows;
  const bridgeRowsWithoutReviewSurface =
    bridgeReportedRows > 0 && !hasLandedInventory && stagedImportRows === 0 && !hasAnyCounterpointLandingProof;
  const missingProofEntityCount = bridgeRowsWithoutReviewSurface
    ? bridgeReportedEntityCount
    : recentIssueCount;

  const commandReconciliationByKey = useMemo(() => new Map(
    (commandCenter?.snapshot_reconciliation ?? []).map((row) => [row.key, row]),
  ), [commandCenter?.snapshot_reconciliation]);
  const importExceptionsByEntity = useMemo(() => {
    const map = new Map<string, { open: number; fallback: number }>();
    for (const row of importExceptions) {
      const current = map.get(row.entity_key) ?? { open: 0, fallback: 0 };
      if (row.status === "open") current.open += 1;
      if (row.status === "open" && row.fallback_landed) current.fallback += 1;
      map.set(row.entity_key, current);
    }
    return map;
  }, [importExceptions]);
  const commandCenterRows = useMemo(() => {
    const rows = commandCenter?.source_counts ?? [];
    return rows.map((source) => {
      const landed = commandReconciliationByKey.get(source.entity_key);
      const exceptions = importExceptionsByEntity.get(source.entity_key) ?? { open: 0, fallback: 0 };
      const sentByBridge = landed?.source_count ?? source.source_count;
      const ready =
        source.status === "ok" &&
        (landed?.passed ?? false) &&
        exceptions.open === 0;
      return {
        ...source,
        sentByBridge,
        landedCount: landed?.landed_count ?? 0,
        gap: landed?.count_difference ?? null,
        landedStatus: landed?.status ?? "waiting",
        failedCount: exceptions.open,
        fallbackCount: exceptions.fallback,
        ready,
      };
    });
  }, [commandCenter?.source_counts, commandReconciliationByKey, importExceptionsByEntity]);
  const commandLandedTotal = commandCenterRows.reduce((sum, row) => sum + Math.max(0, row.landedCount), 0);
  const counterpointTokenConfigured = status?.token_configured ?? commandCenter?.token_configured ?? false;
  const bridgeRuntimeState = status?.windows_sync_state ?? "offline";
  const bridgeConnectionLabel = !counterpointTokenConfigured
    ? "Token missing"
    : bridgeRuntimeState === "online"
      ? "Bridge online"
      : bridgeRuntimeState === "syncing"
        ? "Bridge syncing"
        : "Bridge offline";
  const bridgeConnectionClass = counterpointTokenConfigured && bridgeRuntimeState !== "offline"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
    : "border-red-500/25 bg-red-500/10 text-red-600";
  const bridgeHost = status?.bridge_hostname ?? commandCenter?.latest_preflight?.bridge_hostname ?? null;
  const bridgeVersion = status?.bridge_version ?? commandCenter?.latest_preflight?.bridge_version ?? null;
  const bridgeRuntimeNote = !counterpointTokenConfigured
    ? "NO-GO - Counterpoint sync token is not configured in Back Office Settings. The Bridge can listen locally, but ROS will reject health, heartbeat, preflight, and import requests until the saved ROS token matches the Bridge .env token."
    : status?.offline_reason ?? "ROS has accepted a recent Counterpoint Bridge heartbeat.";
  const stagingSummaryRows = [...stagingCountsByEntity.values()]
    .filter((row) => row.pending_rows > 0 || row.applying_rows > 0 || row.applied_rows > 0)
    .sort((a, b) => a.entity.localeCompare(b.entity));
  const selectedBatch = selectedBatchId == null
    ? null
    : batches.find((batch) => batch.id === selectedBatchId) ?? null;
  const isStaleApplyingBatch = (batch: StagingBatchRow) => {
    if (batch.status !== "applying" || !batch.apply_started_at) return false;
    const startedAt = new Date(batch.apply_started_at).getTime();
    return Number.isFinite(startedAt) && Date.now() - startedAt > 15 * 60 * 1000;
  };
  const batchStatusLabel = (batch: StagingBatchRow) => {
    if (batch.recovered_at) return "Recovered stale apply";
    if (isStaleApplyingBatch(batch)) return "Stale applying";
    return formatEntityLabel(batch.status);
  };

  const importFirstCommandCenterPanel = (
    <section className="ui-card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-black uppercase tracking-wide text-app-text">
            ROS Import Command Center
          </h4>
          <p className="mt-1 max-w-4xl text-xs text-app-text-muted">
            Connect to the standalone Counterpoint SYNC Workbench, select a prepared run, run ROS preflight, import approved sections, and review final proof.
          </p>
          <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Final validation and PostgreSQL import only
          </p>
          <p className="mt-2 text-xs font-semibold text-app-text-muted">
            Proof scope: <span className="text-app-text">{proofScopeLabel}</span>
            {commandCenter?.proof_scope_note ? ` - ${commandCenter.proof_scope_note}` : ""}
          </p>
        </div>
        <span className={`ui-pill text-[10px] ${
          commandCenter?.ready_for_import
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
            : "bg-red-500/10 text-red-600"
        }`}>
          {commandCenter?.ready_for_import ? "Preflight passed" : "Preflight blocked"}
        </span>
      </div>

      <div
        className={`rounded-lg border p-3 ${bridgeConnectionClass}`}
        data-testid="counterpoint-bridge-connection-status"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest">
              Bridge connection status
            </p>
            <p className="mt-1 text-xs font-semibold">
              {bridgeRuntimeNote}
            </p>
          </div>
          <span className="ui-pill border border-app-border bg-app-bg/70 text-[10px]">
            {bridgeConnectionLabel}
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-5">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Token</p>
            <p className="mt-1 font-bold text-app-text">{counterpointTokenConfigured ? "Configured" : "Missing"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">ROS heartbeat</p>
            <p className="mt-1 font-bold text-app-text">{status?.last_seen_at ? formatDate(status.last_seen_at) : "No accepted heartbeat"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">SYNC heartbeat</p>
            <p className="mt-1 font-bold text-app-text">{syncHeartbeat?.received_at ? formatDate(syncHeartbeat.received_at) : "No Bridge heartbeat at SYNC"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Bridge host</p>
            <p className="mt-1 font-bold text-app-text">{syncHeartbeat?.bridge_hostname ?? bridgeHost ?? "Unknown"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Browser/control API</p>
            <p className="mt-1 font-bold text-app-text">
              {status?.last_seen_at ? "Not required for SYNC handoff" : "Not reachable or not checked"}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Bridge version</p>
            <p className="mt-1 font-bold text-app-text">{syncHeartbeat?.bridge_version ?? bridgeVersion ?? "Not reported"}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-app-text">
          <span>Bridge heartbeat: {bridgeRuntimeState === "offline" ? "Offline" : "Online"}</span>
          <span>SYNC Workbench: {syncWorkbenchStatus?.reachable ? "Connected" : "Not reachable"}</span>
          <span>ROS preflight: {latestPreflightForSelectedRun ? "Run for selected run" : "Not run for selected run"}</span>
          <button
            type="button"
            onClick={() => void fetchAllData()}
            className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold"
          >
            Refresh statuses
          </button>
        </div>
      </div>

      <div
        className={`rounded-lg border p-3 ${syncWorkbenchConnectionClass}`}
        data-testid="counterpoint-sync-workbench-status"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest">
              Counterpoint SYNC app connection
            </p>
            <p className="mt-1 text-xs font-semibold">
              {syncWorkbenchStatus?.message ?? "Counterpoint SYNC app connection has not been checked."}
            </p>
            {syncWorkbenchStatus?.error ? (
              <p className="mt-1 text-[10px] font-bold">{syncWorkbenchStatus.error}</p>
            ) : null}
          </div>
          <span className="ui-pill border border-app-border bg-app-bg/70 text-[10px]">
            {syncWorkbenchStatus?.reachable ? "SYNC connected" : syncWorkbenchStatus?.configured ? "SYNC unreachable" : "SYNC not configured"}
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">SYNC host</p>
            <p className="mt-1 font-bold text-app-text">{syncHealth?.hostname ?? "Not reported"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">SYNC schema</p>
            <p className="mt-1 font-bold text-app-text">{syncStore?.format_version ?? syncHealth?.schema_version ?? "Not connected"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Store backup</p>
            <p className="mt-1 font-bold text-app-text">{syncStore?.backup_exists ? "Available" : "Not reported"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Store path</p>
            <p className="mt-1 break-all font-bold text-app-text">{syncStore?.path ?? syncHealth?.store_path ?? "Not reported"}</p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Direct SYNC to ROS ingest path
            </p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              Each area is imported only after ROS pulls the selected SYNC JSON package, runs preflight, and the operator confirms the section import.
            </p>
          </div>
          <span className="ui-pill bg-app-surface-2 text-[9px] text-app-text-muted">
            No CSV handoff into ROS
          </span>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2 xl:grid-cols-3">
          {[
            { label: "Customers", section: "customers", path: "Customer package -> customer import batch -> PostgreSQL" },
            { label: "Inventory", section: "inventory", path: "Inventory package -> inventory import batch -> PostgreSQL" },
            { label: "Ticket History / Sales Movement", section: "tickets", path: "Ticket package -> sales history import batch -> PostgreSQL" },
            { label: "Open Orders", section: "open_docs", path: "Open order package -> open-doc import batch -> PostgreSQL" },
            { label: "Gift Cards", section: "gift_cards", path: "Gift card package -> gift-card import batch -> PostgreSQL" },
            { label: "Loyalty Points", section: "loyalty_hist", path: "Loyalty package -> loyalty history import batch -> PostgreSQL" },
          ].map((item) => {
            const section = selectedSyncSections.find((row) => row.section === item.section);
            return (
              <div key={item.section} className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-black text-app-text">{item.label}</p>
                  <span className={`ui-pill text-[9px] ${
                    section?.status === "blocked"
                      ? "bg-red-500/10 text-red-600"
                      : section?.status === "ready" || section?.status === "ready_with_warnings" || section?.status === "imported"
                        ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                        : "bg-app-bg text-app-text-muted"
                  }`}>
                    {section ? formatEntityLabel(section.status) : "No selected package"}
                  </span>
                </div>
                <p className="mt-2 text-[11px] font-semibold text-app-text-muted">{item.path}</p>
                <p className="mt-2 text-[10px] font-bold text-app-text-muted">
                  Prepared: <span className="text-app-text">{fmtNum(section?.prepared_count ?? 0)}</span>
                  {" | "}
                  Warnings: <span className="text-app-text">{fmtNum(section?.warnings ?? 0)}</span>
                  {" | "}
                  Blockers: <span className="text-app-text">{fmtNum(section?.blockers ?? 0)}</span>
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Import runs from Counterpoint SYNC
            </p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              Select a prepared run, inspect section readiness, then run ROS preflight/import for approved sections.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              void fetchSyncWorkbenchStatus();
              void fetchSyncRuns();
              void fetchSelectedSyncRun(selectedSyncRunId);
            }}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh SYNC Runs
          </button>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(260px,0.35fr)_minmax(0,1fr)]">
          <div className="rounded-lg border border-app-border bg-app-surface-2/40 p-3">
            <label className="block">
              <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Prepared run
              </span>
              <select
                className="ui-input mt-1 text-xs"
                value={selectedSyncRunId}
                onChange={(event) => {
                  setSelectedSyncRunId(event.target.value);
                  setSyncPackage(null);
                }}
              >
                {syncRuns.length === 0 ? (
                  <option value="">No SYNC runs available</option>
                ) : null}
                {syncRuns.map((run) => (
                  <option key={run.sync_run_id} value={run.sync_run_id}>
                    {run.name} - {formatEntityLabel(run.status)}
                  </option>
                ))}
              </select>
            </label>
            {selectedSyncRunSummary ? (
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="col-span-2 rounded-md border border-app-border bg-app-bg/60 p-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Selected SYNC Run</p>
                  <p className="mt-1 break-all font-mono text-[10px] font-bold text-app-text">{selectedSyncRunSummary.sync_run_id}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Run status</p>
                  <p className="font-black text-app-text">{formatEntityLabel(selectedSyncRunSummary.status)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Source batches</p>
                  <p className="font-black tabular-nums text-app-text">{fmtNum(selectedSyncRunSummary.source_batches ?? 0)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Sections ready</p>
                  <p className="font-black tabular-nums text-app-text">{fmtNum(selectedSyncReadySections)}/{fmtNum(selectedSyncSections.length)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Imported</p>
                  <p className="font-black tabular-nums text-app-text">{fmtNum(selectedSyncImportedSections)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Warnings</p>
                  <p className="font-black tabular-nums text-app-text">{fmtNum(selectedSyncRunSummary.warnings)}</p>
                </div>
                <div>
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Blockers</p>
                  <p className="font-black tabular-nums text-app-text">{fmtNum(selectedSyncRunSummary.blockers)}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Updated</p>
                  <p className="font-bold text-app-text">{formatDate(selectedSyncRunSummary.updated_at)}</p>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs font-semibold text-app-text-muted">
                Start the standalone Counterpoint SYNC Workbench on the Main Hub and prepare a run before ROS approval.
              </p>
            )}
          </div>
          <div className="overflow-auto rounded-lg border border-app-border">
            <table className="w-full min-w-[1280px] text-left text-xs">
              <thead className="bg-app-surface-2">
                <tr className="border-b border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  <th className="px-3 py-2">Section</th>
                  <th className="px-3 py-2">SYNC status</th>
                  <th className="px-3 py-2 text-right">Source</th>
                  <th className="px-3 py-2 text-right">Prepared</th>
                  <th className="px-3 py-2 text-right">Warnings</th>
                  <th className="px-3 py-2 text-right">Blockers</th>
                  <th className="px-3 py-2">ROS preflight</th>
                  <th className="px-3 py-2">ROS import</th>
                  <th className="px-3 py-2">AI review</th>
                  <th className="px-3 py-2">Package</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {selectedSyncSections.map((section) => {
                  const blocked = section.blockers > 0 || section.status === "blocked";
                  const preflightState = preflightStateForSection(section);
                  const importDisabledReason = importDisabledReasonForSection(section);
                  return (
                    <tr key={section.section}>
                      <td className="px-3 py-2 font-bold text-app-text">{section.label ?? formatEntityLabel(section.section)}</td>
                      <td className="px-3 py-2">
                        <span className={`ui-pill text-[9px] ${
                          blocked
                            ? "bg-red-500/10 text-red-600"
                            : section.status === "ready_with_warnings"
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-200"
                              : ["ready", "imported"].includes(section.status)
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                                : "bg-app-surface-2 text-app-text-muted"
                        }`}>
                          {formatEntityLabel(section.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(section.source_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(section.prepared_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(section.warnings)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(section.blockers)}</td>
                      <td className="px-3 py-2">
                        <span className={`ui-pill text-[9px] ${
                          preflightState.ready
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                            : preflightState.changed
                              ? "bg-amber-500/15 text-amber-700 dark:text-amber-200"
                              : "bg-app-surface-2 text-app-text-muted"
                        }`}>
                          {preflightState.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-bold text-app-text">{section.imported_at ? "Imported" : "Not imported"}</p>
                        <p className="mt-0.5 text-[10px] text-app-text-muted">{section.imported_at ? formatDate(section.imported_at) : "No ROS import run"}</p>
                        {section.ros_import_run_id ? (
                          <p className="mt-0.5 break-all font-mono text-[9px] text-app-text-muted">{section.ros_import_run_id}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-[10px] font-semibold text-app-text-muted">
                        <p>Pending: <span className="font-black text-app-text">{fmtNum(section.ai_pending_suggestions ?? 0)}</span></p>
                        <p>Accepted: <span className="font-black text-app-text">{fmtNum(section.ai_accepted_suggestions ?? 0)}</span></p>
                        <p>Applied: <span className="font-black text-app-text">{fmtNum(section.ai_applied_suggestions ?? 0)}</span></p>
                        {section.ai_manual_review_suggestions ? (
                          <p className="text-amber-700 dark:text-amber-200">Manual review: {fmtNum(section.ai_manual_review_suggestions)}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <p className="mb-1 break-all font-mono text-[9px] text-app-text-muted">
                          {section.package_fingerprint ? section.package_fingerprint.slice(0, 16) : "No fingerprint"}
                        </p>
                        <button
                          type="button"
                          onClick={() => void loadSyncPackage(section.section)}
                          disabled={!section.package_fingerprint || syncActionBusy === `package:${section.section}`}
                          className="ui-btn-secondary px-2 py-1 text-[10px] font-bold disabled:opacity-50"
                        >
                          Preview package
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void runSyncPackagePreflight(section.section)}
                            disabled={blocked || !section.package_fingerprint || syncActionBusy != null}
                            title={blocked ? "Unresolved SYNC blockers." : undefined}
                            className="ui-btn-secondary px-2 py-1 text-[10px] font-bold disabled:opacity-50"
                          >
                            ROS Preflight
                          </button>
                          <button
                            type="button"
                            onClick={() => void prepareSyncImport(section)}
                            disabled={importDisabledReason != null || syncActionBusy != null}
                            title={importDisabledReason ?? "Import selected section through ROS."}
                            className="ui-btn-primary px-2 py-1 text-[10px] font-bold disabled:opacity-50"
                          >
                            Import Section
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {selectedSyncSections.length === 0 ? (
              <div className="p-4 text-xs font-semibold text-app-text-muted">
                No sections are available for the selected SYNC run.
              </div>
            ) : null}
          </div>
        </div>
        {syncPackage ? (
          <div className="mt-3 rounded-lg border border-app-border bg-app-surface-2/40 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Selected package preview
                </p>
                <p className="mt-1 text-xs font-bold text-app-text">
                  {formatEntityLabel(syncPackage.section)} - {syncPackage.package_fingerprint.slice(0, 16)}
                </p>
              </div>
              <span className="ui-pill text-[9px] bg-app-surface text-app-text-muted">
                Schema v{syncPackage.schema_version}
              </span>
            </div>
            <div className="mt-3 grid gap-2 text-xs md:grid-cols-4">
              <p>SYNC run: <span className="break-all font-mono font-black text-app-text">{syncPackage.sync_run_id}</span></p>
              <p>Section: <span className="font-black text-app-text">{syncPackage.section}</span></p>
              <p>Entity: <span className="font-black text-app-text">{syncPackage.entity}</span></p>
              <p>Generated: <span className="font-black text-app-text">{formatDate(syncPackage.generated_at)}</span></p>
              <p>Raw: <span className="font-black text-app-text">{fmtNum(syncPackage.source_counts.raw)}</span></p>
              <p>Prepared: <span className="font-black text-app-text">{fmtNum(syncPackage.source_counts.prepared)}</span></p>
              <p>Warnings: <span className="font-black text-app-text">{fmtNum(syncPackage.source_counts.warnings)}</span></p>
              <p>Blockers: <span className="font-black text-app-text">{fmtNum(syncPackage.source_counts.blockers)}</span></p>
              <p>Payload rows: <span className="font-black text-app-text">{fmtNum(syncPackage.payload.rows?.length ?? 0)}</span></p>
              <p>Exceptions: <span className="font-black text-app-text">{fmtNum(syncPackage.exceptions.length)}</span></p>
              <p>Provenance: <span className="font-black text-app-text">{fmtNum(syncPackage.provenance.length)}</span></p>
              <p>Fingerprint: <span className="break-all font-mono font-black text-app-text">{syncPackage.package_fingerprint}</span></p>
            </div>
            <details className="mt-3 rounded-md border border-app-border bg-app-bg/70 p-3">
              <summary className="cursor-pointer text-xs font-black uppercase tracking-widest text-app-text-muted">
                Advanced raw JSON
              </summary>
              <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-app-border bg-app-bg/80 p-3 text-[10px] text-app-text-muted">
                {JSON.stringify(syncPackage, null, 2)}
              </pre>
            </details>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { label: "Selected run sections", value: fmtNum(selectedSyncSections.length) },
          { label: "Selected run ready", value: fmtNum(selectedSyncReadySections) },
          { label: "Selected run imported", value: fmtNum(selectedSyncImportedSections) },
          { label: "Selected run warnings", value: fmtNum(selectedSyncRunSummary?.warnings ?? 0) },
          { label: "Selected run blockers", value: fmtNum(selectedSyncRunSummary?.blockers ?? 0) },
          { label: "Final proof scope", value: selectedSyncRunId ? "Selected run only" : "No run" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{stat.label}</p>
            <p className="mt-1 text-lg font-black text-app-text tabular-nums">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-app-border bg-app-surface-2/30 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              ROS preflight and final proof
            </p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              Selected-run proof is scoped by sync_run_id, ros_import_run_id, section, and package fingerprint. General diagnostics are below under Advanced Diagnostics.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void fetchAllData()}
              disabled={loading}
              className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh Proof
            </button>
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-5">
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">History floor</p>
            <p className="mt-1 font-bold text-app-text">{commandCenter?.required_history_start ?? "2018-01-01"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Latest preflight</p>
            <p className="mt-1 font-bold text-app-text">
              {latestPreflightForSelectedRun ? formatDate(latestPreflightForSelectedRun.created_at) : "Not run for selected run"}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Preflight fingerprint</p>
            <p className="mt-1 break-all font-mono text-[10px] font-bold text-app-text">{latestPreflightForSelectedRun?.source_fingerprint ?? "No selected-run preflight"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Latest import run</p>
            <p className="mt-1 font-bold text-app-text">
              {commandCenter?.latest_import_run
                ? `${commandCenter.latest_import_run.status} (${formatDate(commandCenter.latest_import_run.updated_at)})`
                : "Not run"}
            </p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Selected run id</p>
            <p className="mt-1 break-all font-mono text-[10px] font-bold text-app-text">{selectedSyncRunId || "No selected run"}</p>
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
          <div className="rounded-md border border-app-border bg-app-bg/60 p-3">
            <p className="font-black text-app-text">Inventory, catalog, and quantities</p>
            <p className="mt-1 text-app-text-muted">Catalog and inventory proof must land before use.</p>
          </div>
          <div className="rounded-md border border-app-border bg-app-bg/60 p-3">
            <p className="font-black text-app-text">Sales and movement history</p>
            <p className="mt-1 text-app-text-muted">Historical tickets remain review evidence, not tax filing proof.</p>
          </div>
        </div>
      </div>

      {stagingSummaryRows.length > 0 ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-200">
            Staging review
          </p>
          <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {stagingSummaryRows.map((row) => {
              const queuedRows = row.pending_rows + row.applying_rows;
              return (
                <div key={row.entity} className="rounded-md border border-app-border bg-app-bg/70 p-3 text-xs">
                  <p className="font-black text-app-text">{formatEntityLabel(row.entity)}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Queued in staging
                      </p>
                      <p className="mt-1 font-black tabular-nums text-app-text">{fmtNum(queuedRows)}</p>
                    </div>
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Applied from staging
                      </p>
                      <p className="mt-1 font-black tabular-nums text-app-text">{fmtNum(row.applied_rows)}</p>
                    </div>
                  </div>
                  {queuedRows > 0 ? (
                    <p className="mt-2 font-semibold text-amber-700 dark:text-amber-200">
                      No live write has happened yet.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Advanced Diagnostics
            </p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">
              Support-only diagnostics. Accumulated ROS state and staging rows are not scoped to the selected SYNC run. Use selected-run proof above for import sign-off.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchBatches()}
            className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>
        <div className="mt-3 overflow-auto rounded-lg border border-app-border">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="bg-app-surface-2">
              <tr className="border-b border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Replay</th>
                <th className="px-3 py-2">Recovered</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {batches.map((batch) => (
                <tr
                  key={batch.id}
                  className="cursor-pointer hover:bg-app-surface-2/60"
                  onClick={() => setSelectedBatchId(batch.id)}
                >
                  <td className="px-3 py-2 font-mono font-bold text-app-text">{batch.id}</td>
                  <td className="px-3 py-2">{formatEntityLabel(batch.entity)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtNum(batch.row_count)}</td>
                  <td className="px-3 py-2">{batchStatusLabel(batch)}</td>
                  <td className="px-3 py-2">
                    {batch.replay_count > 0 ? `Replay suppressed x${batch.replay_count}` : "No replay"}
                  </td>
                  <td className="px-3 py-2">
                    {batch.recovered_at ? `Recovered by ${batch.recovered_by_staff_name ?? "staff"}` : "Not recovered"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {batches.length === 0 ? (
            <div className="p-4 text-xs font-semibold text-app-text-muted">
              No staged batches are waiting for review.
            </div>
          ) : null}
        </div>
        {selectedBatch ? (
          <div className="mt-3 rounded-lg border border-app-border bg-app-surface-2/40 p-3 text-xs">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Apply claimed
                </p>
                <p className="mt-1 font-semibold text-app-text">
                  {batchStatusLabel(selectedBatch)}
                </p>
              </div>
              {isStaleApplyingBatch(selectedBatch) ? (
                <button
                  type="button"
                  onClick={() => setRecoverBatch(selectedBatch)}
                  className="ui-btn-secondary px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-500/10"
                >
                  Mark stale apply failed
                </button>
              ) : null}
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              <p>Operational decision guide</p>
              <p>What changed</p>
              <p>Replay visibility</p>
              <p>Recovery guidance</p>
              <p>Live write result</p>
              <p>Payload fingerprint: {selectedBatch.payload_fingerprint ?? "not captured"}</p>
            </div>
            {isStaleApplyingBatch(selectedBatch) ? (
              <div className="mt-3 space-y-1 font-semibold text-amber-700 dark:text-amber-200">
                <p>Safe recovery is available.</p>
                <p>Next safe action: Recovery review.</p>
                <p>Apply is active; wait before taking recovery action unless the claim is stale.</p>
                <p>Only stale recovery is available for this batch.</p>
              </div>
            ) : null}
            {selectedBatch.recovery_reason ? (
              <p className="mt-3 font-semibold text-app-text">
                Recovery note: {selectedBatch.recovery_reason}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="overflow-auto rounded-lg border border-app-border">
        <table className="w-full min-w-[920px] text-left text-xs">
          <thead className="bg-app-surface-2">
            <tr className="border-b border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2 text-right">Expected</th>
              <th className="px-3 py-2 text-right">Sent</th>
              <th className="px-3 py-2 text-right">Landed</th>
              <th className="px-3 py-2 text-right">Gap</th>
              <th className="px-3 py-2 text-right">Failed</th>
              <th className="px-3 py-2 text-right">Review-landed</th>
              <th className="px-3 py-2">Ready</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {commandCenterRows.map((row) => (
              <tr key={row.entity_key}>
                <td className="px-3 py-2">
                  <p className="font-bold text-app-text">{row.label}</p>
                  {row.message ? <p className="mt-1 text-[10px] text-red-600">{row.message}</p> : null}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.source_count)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.sentByBridge ?? 0)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.landedCount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{row.gap == null ? "Pending" : fmtNum(row.gap)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.failedCount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.fallbackCount)}</td>
                <td className="px-3 py-2">
                  <span className={`ui-pill text-[9px] ${
                    row.ready
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                      : row.status === "blocked"
                        ? "bg-red-500/10 text-red-600"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-200"
                  }`}>
                    {row.ready ? "Ready" : row.status === "blocked" ? "Blocked" : formatEntityLabel(row.landedStatus)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {commandCenterRows.length === 0 ? (
          <div className="p-4 text-xs font-semibold text-app-text-muted">
            Start the Counterpoint Bridge to run source-count preflight. Import cannot run until ROS receives count proof.
          </div>
        ) : null}
      </div>

      {importExceptions.length > 0 ? (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
          <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-200">
            Import exceptions
          </p>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {importExceptions.slice(0, 6).map((row) => (
              <div key={row.id} className="rounded-md border border-app-border bg-app-bg/60 p-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-bold text-app-text">
                    {formatEntityLabel(row.entity_key)} {row.source_key ? `#${row.source_key}` : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => void resolveImportException(row.id)}
                    className="ui-btn-secondary px-2 py-1 text-[10px] font-bold"
                  >
                    Resolve
                  </button>
                </div>
                <p className="mt-1 text-app-text-muted">{row.message}</p>
                {row.suggested_fix ? <p className="mt-1 font-semibold text-amber-700 dark:text-amber-200">{row.suggested_fix}</p> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );

  if (!hasPermission("settings.admin")) return null;

  return (
    <div className="space-y-6" data-testid="counterpoint-settings-panel">
      {/* ── Title Banner ── */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border pb-4">
        <div>
          <h3 className="text-2xl font-black italic tracking-tighter uppercase text-app-text">
            Counterpoint Import Command Center
          </h3>
          <p className="mt-1 text-xs text-app-text-muted max-w-3xl">
            ROS connects to the standalone Counterpoint SYNC Workbench, selects a prepared run, runs preflight, imports approved sections, and shows final proof.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWorkspaceView("overview")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "overview" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Import Command Center
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceView("details")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "details" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Advanced Diagnostics
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
        </div>
      </div>

      <IntegrationCredentialsCard
        baseUrl={baseUrl}
        integrationKey="counterpoint"
        title="Counterpoint SYNC Connection"
        description="Save the Main Hub SYNC Workbench URL/token and the Bridge token needed for the extractor to reach the preparation Workbench."
        fields={[
          {
            key: "sync_token",
            label: "Sync token",
            placeholder: counterpointTokenConfigured
              ? "Saved - enter only to replace"
              : "Paste the bridge sync token",
            help: "Generate one long random token, save it here, and paste the exact same value into the Bridge .env file on the Counterpoint host.",
            type: "password",
          },
          {
            key: "sync_workbench_url",
            label: "SYNC Workbench URL",
            placeholder: "http://127.0.0.1:3015",
            help: "Main Hub Counterpoint SYNC Workbench URL. ROS uses this server-side to list prepared runs and pull JSON packages.",
            type: "text",
          },
          {
            key: "sync_workbench_token",
            label: "SYNC Workbench token",
            placeholder: syncWorkbenchStatus?.configured
              ? "Saved - enter only to replace"
              : "Paste the SYNC Workbench token",
            help: "Must match COUNTERPOINT_SYNC_WORKBENCH_TOKEN in the Main Hub SYNC Workbench .env file.",
            type: "password",
          },
        ]}
        onSaved={fetchAllData}
      />

      {importFirstCommandCenterPanel}

      {workspaceView === "details" ? (
        <section className="ui-card space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-black uppercase tracking-wide text-app-text">
                Support diagnostics center
              </h4>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Deployment and recovery visibility
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                These diagnostics are not selected-run import proof.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const text = JSON.stringify({ status, commandCenter, batches }, null, 2);
                  void navigator.clipboard?.writeText(text).catch(() => undefined);
                }}
                className="ui-btn-secondary px-3 py-2 text-xs font-bold"
              >
                Copy support report
              </button>
              <button
                type="button"
                onClick={() => setResetPromptOpen(true)}
                className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-500/10"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset rehearsal data
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Counterpoint Support Diagnostics
            </p>
            <div className="mt-3 grid gap-2 md:grid-cols-4">
              <p>{bridgeRuntimeState === "offline" ? "Browser cannot reach Bridge controls" : "Browser can reach Bridge controls"}</p>
              <p>Current import run</p>
              <p>{(status?.staging_pending_count ?? batches.length) > 0 ? "Pending apply" : "No pending apply"}</p>
              <p>{recentIssueCount > 0 || bridgeRowsWithoutReviewSurface ? "Support review needed" : "Support review clear"}</p>
            </div>
          </div>

            <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Accumulated verification
                </p>
                <p className="mt-1 text-xs font-semibold text-app-text-muted">
                  Support-only reconciliation across ROS staging/import state. Use selected-run proof in the Import Command Center for sign-off.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInventoryAdvanceAttempted(true)}
                disabled={bridgeRowsWithoutReviewSurface}
                className="ui-btn-primary px-3 py-2 text-xs font-bold disabled:opacity-50"
              >
                Advance to inventory mapping
              </button>
            </div>

            {(status?.staging_pending_count ?? 0) > 0 || recentIssueCount > 0 || bridgeRowsWithoutReviewSurface ? (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs font-semibold text-amber-700 dark:text-amber-200">
                <p className="font-black">Sign-off blockers present</p>
                {(status?.staging_pending_count ?? 0) > 0 ? (
                  <p>{fmtNum(status?.staging_pending_count ?? 0)} staging batch(es) are pending review.</p>
                ) : null}
                {recentIssueCount > 0 ? <p>{fmtNum(recentIssueCount)} unresolved sync issue(s) remain.</p> : null}
                {missingProofEntityCount > 0 ? (
                  <p>{fmtNum(missingProofEntityCount)} entity row(s) have bridge-reported counts without ROS landed proof.</p>
                ) : null}
                {status?.entity_runs?.some((row) => row.last_error) || recentIssueCount > 0 ? (
                  <p>At least one bridge entity still shows an error in the latest visible run.</p>
                ) : null}
              </div>
            ) : null}

            {inventoryAdvanceAttempted && (status?.staging_pending_count ?? batches.length) > 0 && !hasLandedInventory ? (
              <div className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-xs font-semibold text-red-600">
                <p>One-time import is still waiting in staging</p>
                <p>Nothing has been loaded into ROS catalog tables yet.</p>
                <p>Previous catalog approval is stale.</p>
                <p>Previous inventory approval is stale.</p>
              </div>
            ) : null}

            <div className="rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs">
              <p className="font-black text-app-text">Limits and caveats</p>
              <p className="mt-1 text-app-text-muted">
                Imported Counterpoint ticket and open-doc rows preserve gross historical totals; imported line tax is non-authoritative and should not be treated as tax filing proof.
              </p>
            </div>

            <div className="overflow-auto rounded-lg border border-app-border">
              <div className="flex flex-wrap gap-2 border-b border-app-border bg-app-surface-2 p-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>Missing ROS landed proof</span>
                <span>Counts match</span>
                <span>ROS count lower</span>
                <span>Bridge only</span>
              </div>
              <table className="w-full min-w-[720px] text-left text-xs">
                <thead className="bg-app-surface-2">
                  <tr className="border-b border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    <th className="px-3 py-2">Entity</th>
                    <th className="px-3 py-2 text-right">Bridge rows sent</th>
                    <th className="px-3 py-2 text-right">ROS rows landed</th>
                    <th className="px-3 py-2">Proof status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {commandCenterRows.length > 0 ? commandCenterRows.map((row) => (
                    <tr key={`details-${row.entity_key}`}>
                      <td className="px-3 py-2 font-bold text-app-text">{row.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.sentByBridge ?? row.source_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(row.landedCount)}</td>
                      <td className="px-3 py-2">
                        {row.landedCount === 0
                          ? "Missing ROS landed proof"
                          : row.gap === 0
                            ? "Matched"
                            : row.gap && row.gap < 0
                              ? "Lower landed count"
                              : "Bridge-only variance"}
                      </td>
                    </tr>
                  )) : (
                    <tr>
                      <td className="px-3 py-2 font-bold text-app-text">Bridge only</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(bridgeReportedRows)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">0</td>
                      <td className="px-3 py-2">No landed proof</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <RosieInsightSummary
              surface="counterpoint_status"
              title="Counterpoint Sign-Off"
              mode="explain"
              getHeaders={headers}
              facts={{
                title: "Counterpoint Sign-Off",
                bullets: [
                  { id: "bridge_rows", label: `${fmtNum(bridgeReportedRows)} bridge rows sent`, severity: "info" },
                  { id: "ros_landed", label: `${fmtNum(commandLandedTotal)} ROS rows landed`, severity: "info" },
                  { id: "pending", label: `${fmtNum(status?.staging_pending_count ?? 0)} staging batch(es) pending`, severity: "warning" },
                ],
                disclaimers: [
                  "Do not approve sign-off or declare cutover safe from ROSIE output. Staff must use deterministic proof first.",
                ],
              }}
            />
          </div>
        </section>
      ) : null}

      {workspaceView === "customer_duplicates" ? (
        <section className="ui-card p-5">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Counterpoint Customer Duplicates
              </h4>
              <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
                Review possible duplicate customers after import. Keep separate records by dismissing the pair, or open All Customers to merge the two accounts through the existing customer merge workflow.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigateCustomers?.("all")}
              className="ui-btn-secondary px-3 py-2 text-xs font-bold"
            >
              Open All Customers
            </button>
          </div>
          <DuplicateReviewQueueSection
            onNavigateAllCustomers={() => onNavigateCustomers?.("all")}
            onOpenWeddingParty={onOpenWeddingParty ?? (() => undefined)}
            onStartSale={onStartSaleInPos ?? (() => undefined)}
            onNavigateRegister={onNavigateRegister}
            onAddToWedding={onAddToWedding}
            onBookAppointment={onBookAppointment}
            onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
          />
        </section>
      ) : null}

      {workspaceView === "ai_review" ? (
      <section className="ui-card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-black uppercase tracking-wide text-app-text">
              Counterpoint Transition Review Packs
            </h4>
            <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Counterpoint SYNC Review References
            </h4>
            <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
              Build Codex review packages from imported ROS data plus Lightspeed and Counterpoint CSV references. Riverside OS validates returned suggestions and only applies staff-approved catalog cleanup.
            </p>
          </div>
          <span className="ui-pill bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-200">
            Post-import cleanup
          </span>
        </div>

        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                CSV reference sources
              </p>
              <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
                CSV review and preparation belongs in the standalone Counterpoint SYNC Workbench. ROS only imports approved JSON packages after preflight.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void fetchDsHealth();
                void fetchMergePreview();
              }}
              disabled={mergeLoading}
              className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${mergeLoading ? "animate-spin" : ""}`} />
              Refresh References
            </button>
          </div>

          <input
            ref={lsFileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void handleCsvUpload(file, "lightspeed");
              event.target.value = "";
            }}
          />
          <input
            ref={cpFileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void handleCsvUpload(file, "counterpoint");
              event.target.value = "";
            }}
          />

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Imported catalog</p>
              <p className="mt-1 text-lg font-black tabular-nums text-app-text">{fmtNum(dsHealth?.bridge_products ?? 0)}</p>
              <p className="text-[10px] font-semibold text-app-text-muted">ROS imported products</p>
            </div>
            <div className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Lightspeed CSV</p>
              <p className="mt-1 text-lg font-black tabular-nums text-app-text">{fmtNum(dsHealth?.lightspeed_rows ?? 0)}</p>
              <p className="truncate text-[10px] font-semibold text-app-text-muted">{dsHealth?.lightspeed_file ?? "No file loaded"}</p>
            </div>
            <div className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Counterpoint CSV</p>
              <p className="mt-1 text-lg font-black tabular-nums text-app-text">{fmtNum(dsHealth?.cp_csv_rows ?? 0)}</p>
              <p className="truncate text-[10px] font-semibold text-app-text-muted">{dsHealth?.cp_csv_file ?? "No file loaded"}</p>
            </div>
            <div className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Compare issues</p>
              <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                {fmtNum((mergePreview?.name_conflicts ?? 0) + (mergePreview?.category_conflicts ?? 0) + (mergePreview?.price_conflicts ?? 0))}
              </p>
              <p className="text-[10px] font-semibold text-app-text-muted">
                {fmtNum(mergePreview?.conflicts.length ?? 0)} sampled conflicts
              </p>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => lsFileRef.current?.click()}
              disabled={csvUploading != null}
              className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              Load Lightspeed CSV
            </button>
            <button
              type="button"
              onClick={() => cpFileRef.current?.click()}
              disabled={csvUploading != null}
              className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" />
              Load Counterpoint CSV
            </button>
            {csvUploading ? (
              <span className="text-xs font-semibold text-app-text-muted">
                {csvUploadStatus ?? `Uploading ${csvUploading} CSV...`} {csvUploadProgress > 0 ? `${csvUploadProgress}%` : ""}
              </span>
            ) : null}
          </div>
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
                    Source hash, row keys, actions, categories, confidence, and forbidden fields are validated before suggestions are saved for staff review.
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
                      ? `${fmtNum(reviewSuggestions.length)} saved, ${fmtNum(acceptedReviewSuggestionCount)} accepted`
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
      ) : null}


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
                  Bridge-reported rows must have ROS landed proof before this import can be treated as ready.
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


      {/* ── Modals ── */}
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
      <ConfirmationModal
        isOpen={recoverBatch != null}
        onClose={() => setRecoverBatch(null)}
        onConfirm={() => {
          if (recoverBatch) void recoverStaleBatch(recoverBatch);
        }}
        title="Mark stale apply failed?"
        message="This marks the stale Counterpoint apply claim failed for operator review. It does not replay the payload."
        confirmLabel="Mark failed"
        variant="danger"
        loading={recoveryBusy}
      />
      <ConfirmationModal
        isOpen={pendingSyncImport != null}
        onClose={() => setPendingSyncImport(null)}
        onConfirm={() => void importSyncSection()}
        title="Import SYNC section?"
        message={
          pendingSyncImport
            ? `Import ${pendingSyncImport.section.label ?? formatEntityLabel(pendingSyncImport.section.section)} from selected SYNC run?\n\nRun: ${selectedSyncRunSummary?.name ?? selectedSyncRunId}\nSection: ${pendingSyncImport.section.section}\nRecords: ${fmtNum(pendingSyncImport.pkg.source_counts.prepared)}\nWarnings: ${fmtNum(pendingSyncImport.pkg.source_counts.warnings)}\nBlockers: ${fmtNum(pendingSyncImport.pkg.source_counts.blockers)}\n\nThis will write records into Riverside OS through the ROS Counterpoint import pipeline.`
            : ""
        }
        confirmLabel="Import Section"
        variant="info"
        loading={syncActionBusy?.startsWith("import:") ?? false}
      />
    </div>
  );
}
