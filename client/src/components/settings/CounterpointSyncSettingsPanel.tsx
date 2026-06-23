import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  RefreshCw,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import PromptModal from "../ui/PromptModal";
import DuplicateReviewQueueSection from "../customers/DuplicateReviewQueueSection";
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
  staging_entity_counts?: StagingEntityCountRow[];
  staging_pending_count?: number;
  staging_applying_count?: number;
  staging_open_count?: number;
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

interface ImportReviewState {
  current_step: string | null;
  steps: Record<string, StepDetail>;
  inventory_summary: InventorySummary | null;
  can_reset: boolean;
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
  required: boolean;
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
  metadata: unknown;
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
  ready_for_import: boolean;
  ready_for_go_live_review: boolean;
  recommendation: string;
}

interface CounterpointImportExceptionRow {
  id: string;
  import_run_id: string | null;
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

function formatImportRunKind(runKind: string | null | undefined): string {
  switch (runKind) {
    case "incremental_update":
      return "Update since last run";
    case "fix_rerun":
      return "Fix rerun";
    case "go_live":
      return "Go-live import";
    case "full_rehearsal":
    case "rehearsal":
      return "Full import / recheck all";
    default:
      return "No import run yet";
  }
}

function importRunRequestedEntity(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as { requested_entity?: unknown }).requested_entity;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "full") return null;
  return trimmed;
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
  const [workspaceView, setWorkspaceView] = useState<"overview" | "pipeline" | "inbound" | "details" | "customer_duplicates">(() => {
    if (typeof window === "undefined") return "overview";
    const saved = window.localStorage.getItem("counterpoint.statusSection");
    return saved === "details" || saved === "customer_duplicates" ? saved : "overview";
  });

  const [importReviewState, setImportReviewState] = useState<ImportReviewState | null>(null);

  const [landingVerification, setLandingVerification] = useState<CounterpointLandingVerificationSummary | null>(null);
  const [commandCenter, setCommandCenter] = useState<CounterpointImportCommandCenterSummary | null>(null);
  const [importExceptions, setImportExceptions] = useState<CounterpointImportExceptionRow[]>([]);
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

  const fetchImportExceptions = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    if (!commandCenter?.latest_import_run?.id) {
      setImportExceptions([]);
      return;
    }
    try {
      const params = new URLSearchParams({ limit: "200" });
      params.set("import_run_id", commandCenter.latest_import_run.id);
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/exceptions?${params}`, {
        headers: headers(),
      });
      if (res.ok) {
        const data = (await res.json()) as { rows?: CounterpointImportExceptionRow[] };
        setImportExceptions(data.rows ?? []);
      }
    } catch {
      setImportExceptions([]);
    }
  }, [baseUrl, commandCenter?.latest_import_run?.id, headers, hasPermission]);

  const fetchImportReviewState = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/workbench/state`, {
        headers: headers(),
      });
      if (res.ok) {
        setImportReviewState((await res.json()) as ImportReviewState);
      }
    } catch { /* silent */ }
  }, [baseUrl, headers, hasPermission]);

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
      fetchImportExceptions(),
      fetchImportReviewState(),
      fetchLandingVerification(),
      fetchResetPreview(),
    ]);
    setLoading(false);
  }, [
    fetchStatus,
    fetchCommandCenter,
    fetchImportExceptions,
    fetchImportReviewState,
    fetchLandingVerification,
    fetchResetPreview,
  ]);

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    void fetchImportExceptions();
  }, [fetchImportExceptions]);

  /* ── Event Handlers ── */

  const recheckImportException = useCallback(async (exceptionId: string) => {
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
        throw new Error(data.reason ?? data.error ?? "Exception still needs repair before it can be closed.");
      }
      const data = await res.json().catch(() => ({}));
      toast(data.reason ?? "Exception reconciled against landed ROS data.", "success");
      void fetchImportExceptions();
      void fetchCommandCenter();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Exception still needs repair before it can be closed.", "error");
    }
  }, [baseUrl, fetchCommandCenter, fetchImportExceptions, headers, toast]);

  const runBaselineReset = async (confirmationPhrase: string): Promise<boolean> => {
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
        toast("Live ROS Counterpoint import data wiped. Migration proof and exceptions are reset.", "success");
        setResetPromptOpen(false);
        // setBaselineResetPhrase("");
        void fetchAllData();
        return true;
      } else {
        const j = await res.json().catch(() => ({}));
        toast(j.error ?? "Reset failed", "error");
        return false;
      }
    } catch {
      toast("Could not perform reset", "error");
      return false;
    } finally {
      // setResetBusy(false);
    }
  };

  /* ── Calculations & Helpers ── */
  const proofScopeLabel =
    commandCenter?.proof_scope === "current_import_run"
      ? "Current import run"
      : commandCenter?.proof_scope === "preflight_only"
        ? "Preflight only"
        : "No import preflight";
  const normalizeProofKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const bridgeRowsFor = (entities: string[]) => {
    const keys = entities.map(normalizeProofKey);
    return (status?.entity_runs ?? []).reduce((sum, run) => {
      const entity = normalizeProofKey(run.entity);
      return keys.includes(entity) ? sum + Math.max(0, run.records_processed ?? 0) : sum;
    }, 0);
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
    proofTerms: string[],
  ) => {
    const bridgeRows = bridgeRowsFor([entity]);
    const landedRows = landedRowsFor(proofTerms);
    const expected = bridgeRows > 0 || landedRows > 0;
    const ready = !expected || landedRows > 0;
    return {
      label,
      entity,
      ready,
      expected,
      bridgeRows,
      landedRows,
      message: `${label} has ${fmtNum(bridgeRows)} Bridge row(s), but no ROS landed proof is available for review.`,
    };
  };
  const inventoryProducts = importReviewState?.inventory_summary?.products ?? 0;
  const inventoryVariants = importReviewState?.inventory_summary?.variants ?? 0;
  const hasLandedInventory = inventoryProducts > 0 && inventoryVariants > 0;
  const bridgeReportedCatalogRows = bridgeRowsFor(["catalog", "inventory"]);
  const customerReviewReady = reviewReadinessFor("Customer CRM", "customers", ["customers"]);
  const ticketReviewReady = reviewReadinessFor("Sales history", "tickets", [
    "closed_ticket_transactions",
    "closed_ticket_lines",
    "closed_ticket_payments",
  ]);
  const giftCardReviewReady = reviewReadinessFor("Gift card liabilities", "gift_cards", ["gift_cards"]);
  const openDocReviewReady = reviewReadinessFor("Open orders and layaways", "open_docs", [
    "open_doc_transactions",
    "open_doc_lines",
  ]);
  const loyaltyReviewReady = reviewReadinessFor("Loyalty history", "loyalty_hist", [
    "loyalty_history",
    "loyalty_hist",
  ]);
  const downstreamReviewBlockers = [
    !hasLandedInventory && bridgeReportedCatalogRows > 0
      ? `Bridge reported catalog/inventory rows, but ROS has ${fmtNum(inventoryProducts)} Counterpoint product(s) and ${fmtNum(inventoryVariants)} variant(s). Run or repair the direct import before go-live sign-off.`
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
  const bridgeRowsWithoutReviewSurface =
    bridgeReportedRows > 0 && !hasLandedInventory && !hasAnyCounterpointLandingProof;
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
      if (row.status === "open" && row.severity === "blocked") current.open += 1;
      if (row.status === "open" && row.fallback_landed) current.fallback += 1;
      map.set(row.entity_key, current);
    }
    return map;
  }, [importExceptions]);
  const stagingRowsByEntity = useMemo(() => {
    const rows = new Map<string, StagingEntityCountRow>();
    for (const count of status?.staging_entity_counts ?? []) {
      rows.set(count.entity, count);
    }
    return rows;
  }, [status?.staging_entity_counts]);
  const commandCenterRows = useMemo(() => {
    const rows = commandCenter?.source_counts ?? [];
    return rows.map((source) => {
      const landed = commandReconciliationByKey.get(source.entity_key);
      const exceptions = importExceptionsByEntity.get(source.entity_key) ?? { open: 0, fallback: 0 };
      const staging = stagingRowsByEntity.get(source.entity_key);
      const sentByBridge = landed?.source_count ?? source.source_count;
      const ready =
        (source.status === "ok" || !source.required) &&
        (landed?.passed ?? false) &&
        exceptions.open === 0;
      return {
        ...source,
        sentByBridge,
        landedCount: landed?.landed_count ?? 0,
        queuedRows: (staging?.pending_rows ?? 0) + (staging?.applying_rows ?? 0),
        appliedRows: staging?.applied_rows ?? 0,
        gap: landed?.count_difference ?? null,
        landedStatus: landed?.status ?? "waiting",
        failedCount: exceptions.open,
        fallbackCount: exceptions.fallback,
        ready,
      };
    });
  }, [commandCenter?.source_counts, commandReconciliationByKey, importExceptionsByEntity, stagingRowsByEntity]);
  const commandLandedTotal = commandCenterRows.reduce((sum, row) => sum + Math.max(0, row.landedCount), 0);
  const commandFailedTotal = commandCenterRows.reduce((sum, row) => sum + Math.max(0, row.failedCount), 0);
  const commandNotReadyTotal = commandCenterRows.filter((row) => row.required && !row.ready).length;
  const bridgeSentButNotLanded = bridgeReportedRows > 0 && commandLandedTotal === 0;
  const bridgeRuntimeState = status?.windows_sync_state ?? "offline";
  const bridgeConnectionLabel = bridgeRuntimeState === "online"
      ? "Bridge online"
      : bridgeRuntimeState === "syncing"
        ? "Bridge syncing"
        : "Bridge offline";
  const bridgeConnectionClass = bridgeRuntimeState !== "offline"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
    : "border-red-500/25 bg-red-500/10 text-red-600";
  const bridgeHost = status?.bridge_hostname ?? commandCenter?.latest_preflight?.bridge_hostname ?? null;
  const bridgeVersion = status?.bridge_version ?? commandCenter?.latest_preflight?.bridge_version ?? null;
  const latestImportRunKindLabel = formatImportRunKind(commandCenter?.latest_import_run?.run_kind);
  const latestImportRunEntity = importRunRequestedEntity(commandCenter?.latest_import_run?.metadata);
  const latestImportRunLabel = latestImportRunEntity
    ? `${latestImportRunKindLabel}: ${formatEntityLabel(latestImportRunEntity)}`
    : latestImportRunKindLabel;
  const bridgeRuntimeNote =
    status?.offline_reason ?? "Bridge status is tracked from Main Hub ROS intake heartbeat.";
  const requiredRowsNeedingReview = commandCenterRows.filter((row) => row.required && !row.ready);
  const firstRequiredIssue = requiredRowsNeedingReview[0] ?? null;
  const firstOpenException = importExceptions.find((row) => row.status === "open") ?? null;
  const importNextStep = useMemo(() => {
    if (bridgeRuntimeState === "offline") {
      return {
        tone: "red",
        title: "Next: start the Bridge on the Counterpoint PC",
        body: "ROS is not receiving the Bridge heartbeat. Start the Bridge, confirm Main Hub ROS is ready, then run Full Import / Recheck All.",
        actions: ["Start Bridge", "Check Main Hub ROS", "Run Full Import"],
      };
    }

    if (!commandCenter?.preflight_received) {
      return {
        tone: "amber",
        title: "Next: run Full Import / Recheck All",
        body: "The Bridge is online, but ROS has not received Counterpoint source-count proof yet.",
        actions: ["Run Full Import in Bridge", "Wait for source counts", "Refresh Import & Proof"],
      };
    }

    if (!commandCenter.ready_for_import) {
      return {
        tone: "red",
        title: "Next: fix preflight blockers",
        body: "Counterpoint source-count proof is blocked. Fix the listed SQL, mapping, or source-data issue before importing.",
        actions: ["Open Bridge Process Console", "Fix the blocker shown there", "Run Full Import again"],
      };
    }

    if (bridgeSentButNotLanded) {
      return {
        tone: "amber",
        title: "Next: wait for ROS landed proof",
        body: "The Bridge sent rows, but ROS has not written landed proof yet. Keep Bridge and Main Hub online, then refresh this page.",
        actions: ["Keep Bridge running", "Refresh Import & Proof", "Use Support Diagnostics only if proof stays empty"],
      };
    }

    if (firstOpenException) {
      return {
        tone: "red",
        title: `Next: fix ${formatEntityLabel(firstOpenException.entity_key)} exception`,
        body: firstOpenException.suggested_fix ?? firstOpenException.message,
        actions: ["Review the exception card below", "Fix the missing source/mapping/linkage", "Rerun the affected import area"],
      };
    }

    if (firstRequiredIssue) {
      return {
        tone: "amber",
        title: `Next: review ${firstRequiredIssue.label}`,
        body: "This required area is not ready for sign-off. Review its gap, failed count, or landed proof status before finalizing.",
        actions: ["Open the row in the proof table", "Fix or rerun the affected area", "Confirm the row becomes Ready"],
      };
    }

    if (commandCenter?.ready_for_go_live_review && commandCenterRows.length > 0) {
      return {
        tone: "green",
        title: "Next: final go-live sign-off",
        body: "Required import areas are ready in this proof view. Review customer duplicates and final business checks before cutover.",
        actions: ["Review Customer Duplicates", "Confirm open orders and deposits", "Complete go-live sign-off"],
      };
    }

    return {
      tone: "amber",
      title: "Next: refresh import proof",
      body: "ROS has partial import state, but it is not ready for sign-off yet.",
      actions: ["Refresh Import & Proof", "Review any yellow or red rows", "Rerun the affected import area if needed"],
    };
  }, [
    bridgeRuntimeState,
    bridgeSentButNotLanded,
    commandCenter?.preflight_received,
    commandCenter?.ready_for_go_live_review,
    commandCenter?.ready_for_import,
    commandCenterRows.length,
    firstOpenException,
    firstRequiredIssue,
  ]);
  const importNextStepClass = importNextStep.tone === "green"
    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100"
    : importNextStep.tone === "red"
      ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-200"
      : "border-amber-500/25 bg-amber-500/10 text-amber-900 dark:text-amber-100";

  const importFirstCommandCenterPanel = (
    <section className="ui-card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
	          <h4 className="text-sm font-black uppercase tracking-wide text-app-text">
	            ROS Import Command Center
	          </h4>
	          <p className="mt-1 max-w-4xl text-xs text-app-text-muted">
	            First run the Bridge import, then review proof and exceptions here.
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

      <div className="grid gap-2 text-xs md:grid-cols-4">
        {[
          ["1", "Connect Bridge", "Counterpoint SQL and Main Hub ROS must both be ready."],
          ["2", "Run Import", "Bridge sends Counterpoint rows into ROS for proof and import."],
          ["3", "Review Proof", "Use landed rows, exceptions, and blockers for sign-off."],
          ["4", "Finish Go-Live Review", "Resolve listed exceptions and confirm every required area is Ready."],
        ].map(([step, title, detail]) => (
          <div key={step} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Step {step}</p>
            <p className="mt-1 font-black text-app-text">{title}</p>
            <p className="mt-1 text-[11px] font-semibold text-app-text-muted">{detail}</p>
          </div>
        ))}
      </div>

      <div className={`rounded-lg border p-4 text-xs ${importNextStepClass}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest">Current next step</p>
            <p className="mt-1 text-sm font-black">{importNextStep.title}</p>
            <p className="mt-1 max-w-3xl font-semibold">{importNextStep.body}</p>
          </div>
          <span className="ui-pill border border-app-border bg-app-bg/70 text-[10px] text-app-text">
            {commandNotReadyTotal > 0
              ? `${fmtNum(commandNotReadyTotal)} area(s) need review`
              : commandCenterRows.length > 0
                ? "Proof ready"
                : "Waiting for proof"}
          </span>
        </div>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          {importNextStep.actions.map((action, index) => (
            <div key={`${action}-${index}`} className="rounded-md border border-app-border bg-app-bg/60 p-2">
              <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Do {index + 1}</p>
              <p className="mt-1 font-bold text-app-text">{action}</p>
            </div>
          ))}
        </div>
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
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-3 xl:grid-cols-6">
	          <div>
	            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Mode</p>
	            <p className="mt-1 font-bold text-app-text">Direct ROS intake</p>
	          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">ROS heartbeat</p>
            <p className="mt-1 font-bold text-app-text">{status?.last_seen_at ? formatDate(status.last_seen_at) : "No accepted heartbeat"}</p>
          </div>
		          <div>
		            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Bridge heartbeat</p>
		            <p className="mt-1 font-bold text-app-text">{status?.last_seen_at ? formatDate(status.last_seen_at) : "Not received"}</p>
		          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Bridge host</p>
            <p className="mt-1 font-bold text-app-text">{bridgeHost ?? "Unknown"}</p>
          </div>
	          <div>
	            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Browser/control API</p>
	            <p className="mt-1 font-bold text-app-text">
	              {status?.last_seen_at ? "Not required for ROS intake" : "Not reachable or not checked"}
	            </p>
	          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Bridge version</p>
            <p className="mt-1 font-bold text-app-text">{bridgeVersion ?? "Not reported"}</p>
          </div>
          <div>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">Latest import mode</p>
            <p className="mt-1 font-bold text-app-text">{latestImportRunLabel}</p>
          </div>
        </div>
	        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-app-text">
	          <span>Bridge heartbeat: {bridgeRuntimeState === "offline" ? "Offline" : "Online"}</span>
	          <span>Main Hub ROS intake: {status?.last_seen_at ? "Receiving heartbeat" : "No accepted heartbeat"}</span>
	          <span>ROS staging: {fmtNum(status?.staging_open_count ?? 0)} open row(s)</span>
	          <span>Go-live path: Bridge imports directly into ROS</span>
	          <button
	            type="button"
	            onClick={() => void fetchAllData()}
            className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold"
          >
            Refresh statuses
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
	            ROS business-area import path
	          </p>
	          <p className="mt-1 text-xs font-semibold text-app-text-muted">
	            Each area is received by ROS, checked against proof and exceptions, then written through the existing Counterpoint import services.
	          </p>
	        </div>
	        <span className="ui-pill bg-app-surface-2 text-[9px] text-app-text-muted">
	          Direct ROS import
	        </span>
        </div>
        <div className="mt-3 grid gap-2 text-xs md:grid-cols-2 xl:grid-cols-3">
          {[
	          { label: "Customers", section: "customers", path: "Bridge -> ROS customer import -> PostgreSQL" },
	          { label: "Inventory", section: "inventory", path: "Bridge -> ROS inventory import -> PostgreSQL" },
	          { label: "Ticket History / Sales Movement", section: "tickets", path: "Bridge -> ROS sales history import -> PostgreSQL" },
	          { label: "Open Orders", section: "open_docs", path: "Bridge -> ROS open-doc import -> PostgreSQL" },
	          { label: "Gift Cards", section: "gift_cards", path: "Bridge -> ROS gift-card import -> PostgreSQL" },
	          { label: "Loyalty Points", section: "loyalty_hist", path: "Bridge -> ROS loyalty import -> PostgreSQL" },
          ].map((item) => (
              <div key={item.section} className="rounded-md border border-app-border bg-app-surface-2/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-black text-app-text">{item.label}</p>
                  <span className="ui-pill bg-app-bg text-[9px] text-app-text-muted">
                    Direct import
                  </span>
                </div>
                <p className="mt-2 text-[11px] font-semibold text-app-text-muted">{item.path}</p>
              </div>
          ))}
        </div>
      </div>

      <div className={`rounded-lg border p-3 text-xs ${
        commandNotReadyTotal > 0
          ? "border-amber-500/25 bg-amber-500/10 text-amber-900 dark:text-amber-100"
          : "border-emerald-500/20 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100"
      }`}>
        <p className="text-[10px] font-black uppercase tracking-widest">
          Bridge sent vs ROS landed
        </p>
        <p className="mt-1 font-semibold">
          Sent means the Bridge posted Counterpoint rows to Main Hub ROS. Landed means ROS wrote and linked those rows for proof. Go-live is not ready until required rows are landed, exceptions are resolved, and readiness is Ready.
        </p>
        {bridgeSentButNotLanded ? (
          <p className="mt-2 font-bold">
            Bridge has sent rows, but ROS has no landed proof yet. Keep the Bridge and Main Hub online, refresh Import & Proof, and review Support Diagnostics only if this does not progress.
          </p>
        ) : commandNotReadyTotal > 0 ? (
          <p className="mt-2 font-bold">
            ROS has landed proof for this import, but {fmtNum(commandNotReadyTotal)} required area(s) are not ready and {fmtNum(commandFailedTotal)} current-run blocker(s) still need review before sign-off.
          </p>
        ) : commandCenterRows.length > 0 ? (
          <p className="mt-2 font-bold">
            All listed import areas are ready in this proof view.
          </p>
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
                  <p className="font-bold text-app-text">
                    {row.label}
                    {!row.required ? (
                      <span className="ml-2 ui-pill bg-app-surface-2 text-[9px] text-app-text-muted">
                        Optional
                      </span>
                    ) : null}
                  </p>
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
                      : !row.required
                        ? "bg-app-surface-2 text-app-text-muted"
                      : row.status === "blocked"
                        ? "bg-red-500/10 text-red-600"
                        : "bg-amber-500/15 text-amber-700 dark:text-amber-200"
                  }`}>
                    {row.ready
                      ? row.appliedRows > 0
                        ? "Applied from ROS support queue"
                        : "Ready"
                      : row.queuedRows > 0
                        ? "Queued in ROS support queue"
                        : row.landedCount > 0 && row.gap !== 0
                          ? "Proof needs review"
                          : row.sentByBridge > 0
                            ? "No live write has happened yet."
                            : !row.required
                              ? "Optional"
                              : row.status === "blocked"
                                ? "Blocked"
                                : formatEntityLabel(row.landedStatus)}
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
                    onClick={() => void recheckImportException(row.id)}
                    className="ui-btn-secondary px-2 py-1 text-[10px] font-bold"
                  >
                    Recheck
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
            Run the Bridge import, review ROS proof, resolve exceptions, and confirm readiness.
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
            1 Import & Proof
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceView("customer_duplicates")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "customer_duplicates" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            2 Customer Duplicates
          </button>
          <button
            type="button"
            onClick={() => setWorkspaceView("details")}
            className={`ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold ${
              workspaceView === "details" ? "ring-2 ring-app-accent/30" : ""
            }`}
          >
            Support Diagnostics
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
                  const text = JSON.stringify({ status, commandCenter, importExceptions }, null, 2);
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
                Reset Counterpoint import
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
              <p>{commandNotReadyTotal > 0 ? "Proof needs review" : "Proof ready"}</p>
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
                  Support-only reconciliation across ROS support/import state. Use the current import proof in Import & Proof for sign-off.
                </p>
              </div>
            </div>

            {recentIssueCount > 0 || bridgeRowsWithoutReviewSurface ? (
              <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs font-semibold text-amber-700 dark:text-amber-200">
                <p className="font-black">Sign-off blockers present</p>
                {recentIssueCount > 0 ? <p>{fmtNum(recentIssueCount)} unresolved sync issue(s) remain.</p> : null}
                {missingProofEntityCount > 0 ? (
                  <p>{fmtNum(missingProofEntityCount)} entity row(s) have bridge-reported counts without ROS landed proof.</p>
                ) : null}
                {status?.entity_runs?.some((row) => row.last_error) || recentIssueCount > 0 ? (
                  <p>At least one bridge entity still shows an error in the latest visible run.</p>
                ) : null}
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
        title="Reset Counterpoint Import?"
        message={`This clears imported Counterpoint products, variants, customers, orders, deposits, gift cards, loyalty, import proof, exceptions, quarantine, and stale review state. It keeps Riverside setup and reviewed Counterpoint mapping configuration. This action is irreversible.\n\nTo proceed, type: ${resetPreview?.confirmation_phrase ?? "RESET"}`}
        confirmLabel="Reset Import"
        placeholder="Enter confirmation phrase"
      />
    </div>
  );
}
