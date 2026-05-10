import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  RefreshCw,
  Monitor,
  Play,
  Square,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Wifi,
  WifiOff,
  Loader2,
  Inbox,
  Tags,
  CreditCard,
  Gift,
  Users,
  LayoutDashboard,
  Zap,
  Database,
  Package,
  FileText,
  Star,
  Truck,
  Hash,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import RosieInsightSummary from "../help/RosieInsightSummary";

type HubTab =
  | "status"
  | "import-console"
  | "inbound"
  | "categories"
  | "payments"
  | "gifts"
  | "staff";
type CounterpointStatusSection = "connect" | "signoff" | "details" | "advanced";

function isHubTab(value: string | null): value is HubTab {
  return (
    value === "status" ||
    value === "import-console" ||
    value === "inbound" ||
    value === "categories" ||
    value === "payments" ||
    value === "gifts" ||
    value === "staff"
  );
}

function isCounterpointStatusSection(
  value: string | null,
): value is CounterpointStatusSection {
  return value === "connect" || value === "signoff" || value === "details" || value === "advanced";
}

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
}

interface CounterpointQuarantineCount {
  key: string;
  count: number;
}

interface CounterpointQuarantineSummary {
  total_records: number;
  info_records: number;
  warning_records: number;
  quarantine_records: number;
  blocking_records: number;
  latest_created_at: string | null;
  by_severity: CounterpointQuarantineCount[];
  by_ingest_type: CounterpointQuarantineCount[];
}

interface CounterpointQuarantineRow {
  id: number;
  ingest_type: string;
  issue_type: string;
  severity: string;
  message: string;
  normalized_sku: string | null;
  counterpoint_item_key: string | null;
  family_key: string | null;
  option_values: unknown;
  source_reference: unknown;
  created_at: string;
}

interface CounterpointRegistryHealthSummary {
  status: "healthy" | "warning" | "needs_review" | string;
  counterpoint_products: number;
  counterpoint_variants: number;
  variants_with_counterpoint_item_key: number;
  variants_missing_counterpoint_item_key: number;
  duplicate_normalized_sku_values: number;
  duplicate_counterpoint_item_key_values: number;
  quarantine_record_count: number;
  latest_ingest_at: string | null;
}

interface CounterpointBarcodeAliasHealthSummary {
  total_aliases: number;
  active_aliases: number;
  duplicate_active_alias_conflicts: number;
  latest_created_at: string | null;
  by_type: CounterpointQuarantineCount[];
  by_status: CounterpointQuarantineCount[];
}

interface LightspeedNormalizationReferenceBatchSummary {
  id: string;
  source_file_name: string;
  source_file_hash: string;
  row_count: number;
  status: string;
  imported_at: string;
}

interface LightspeedNormalizationReferenceHealthSummary {
  active_batch: LightspeedNormalizationReferenceBatchSummary | null;
  row_count: number;
  b_sku_count: number;
  duplicate_b_sku_groups: number;
  latest_imported_at: string | null;
}

interface CounterpointQuarantineRowsResponse {
  rows: CounterpointQuarantineRow[];
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

interface CounterpointInventoryVerificationValues {
  sku: string;
  name: string | null;
  category: string | null;
  variant_label: string | null;
  supply_price: string | null;
  retail_price: string | null;
  inventory_quantity: string | null;
  supplier_name: string | null;
  supplier_code: string | null;
  item_key: string | null;
  catalog_handle: string | null;
}

interface CounterpointInventoryVerificationRow {
  sku: string;
  match_basis: string | null;
  status: string;
  mismatch_types: string[];
  csv: CounterpointInventoryVerificationValues;
  ros: CounterpointInventoryVerificationValues | null;
}

interface CounterpointInventoryVerificationSummary {
  csv_path: string;
  total_csv_skus: number;
  exact_match_count: number;
  mismatched_count: number;
  comparison_artifact_count: number;
  csv_source_issue_count: number;
  missing_in_ros_count: number;
  extra_in_ros_count: number;
  matched_count: number;
  name_mismatch_count: number;
  identifier_like_product_name_count: number;
  category_mismatch_count: number;
  variant_mismatch_count: number;
  ros_variant_label_missing_count: number;
  price_mismatch_count: number;
  cost_mismatch_count: number;
  inventory_mismatch_count: number;
  supplier_field_suspect_count: number;
  supplier_code_non_vendor_key_count: number;
  variant_group_split_count: number;
  parent_sku_variant_count: number;
  duplicate_variant_label_count: number;
  missing_vendor_count: number;
  vendor_mismatch_count: number;
  missing_vendor_item_link_count: number;
  extra_parent_scope_artifact_count: number;
  extra_key_present_scope_gap_count: number;
  extra_unexplained_count: number;
  expected_out_of_scope_exclusion_count: number;
  detailed_row_limit: number;
  detailed_rows_truncated: number;
  extra_rows_truncated: number;
}

interface CounterpointInventoryVerificationReport {
  summary: CounterpointInventoryVerificationSummary;
  mismatch_rows: CounterpointInventoryVerificationRow[];
  extra_rows: CounterpointInventoryVerificationRow[];
  critical_issues: string[];
}

interface CounterpointLandingVerificationRow {
  key: string;
  label: string;
  count: number;
  confidence: "direct" | "approximate" | string;
  note: string;
}

interface CounterpointSnapshotReconciliationRow {
  key: string;
  label: string;
  status: "pass" | "fail" | "missing_source" | string;
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
  status: "pass" | "fail" | string;
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

interface CounterpointTransactionReconciliationTotals {
  imported_ticket_transactions: number;
  transaction_lines: number;
  payments: number;
  transaction_total_sum: string;
  payment_amount_sum: string;
  difference: string;
}

interface CounterpointTransactionReconciliationByDateRow {
  business_day: string;
  imported_ticket_transactions: number;
  transaction_lines: number;
  payments: number;
  transaction_total_sum: string;
  payment_amount_sum: string;
}

interface CounterpointTransactionReconciliationByPaymentTypeRow {
  payment_type: string;
  payments: number;
  payment_amount_sum: string;
}

interface CounterpointTransactionReconciliationSnapshot {
  generated_at: string;
  disclaimer: string;
  totals: CounterpointTransactionReconciliationTotals;
  by_date: CounterpointTransactionReconciliationByDateRow[];
  by_payment_type: CounterpointTransactionReconciliationByPaymentTypeRow[];
}

interface CounterpointOpenDocsVerificationSnapshot {
  generated_at: string;
  disclaimer: string;
  imported_open_doc_transactions: number;
  imported_open_doc_lines: number;
  imported_open_doc_payments: number;
  open_docs_with_customer_linked: number;
  open_docs_missing_customer: number;
  open_docs_with_zero_lines: number;
  open_docs_with_zero_payments: number;
  distinct_staff_attribution_count: number;
}

interface CounterpointInventoryCatalogVerificationSnapshot {
  generated_at: string;
  disclaimer: string;
  counterpoint_products: number;
  counterpoint_variants: number;
  products_with_identifier_like_name: number;
  products_name_equals_counterpoint_key: number;
  variants_with_sku: number;
  variants_with_barcode: number;
  variants_with_cost: number;
  variants_with_price: number;
  variants_with_quantity_on_hand: number;
  variants_missing_sku: number;
  variants_missing_barcode: number;
  variants_missing_cost: number;
  variants_missing_price: number;
  variants_zero_or_negative_quantity: number;
  products_missing_category_mapping: number;
  variants_missing_vendor_supplier_item_link: number;
  distinct_vendors_linked_to_imported_items: number;
}

/* ── Bridge live status from :3002 ── */
const BRIDGE_LOCAL_URLS = ["http://127.0.0.1:3002", "http://localhost:3002"];
const BRIDGE_CONTROL_URL_STORAGE_KEY = "counterpoint.bridgeControlUrl";
const COUNTERPOINT_TAB_STORAGE_KEY = "counterpoint.settingsTab";
const COUNTERPOINT_STATUS_SECTION_STORAGE_KEY = "counterpoint.statusSection";

function normalizeBridgeControlUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

function bridgeControlUrls(bridgeHostname?: string | null, preferredUrl?: string): string[] {
  const urls = [
    normalizeBridgeControlUrl(preferredUrl ?? ""),
    ...BRIDGE_LOCAL_URLS,
  ].filter(Boolean);
  const host = bridgeHostname?.trim();
  if (host) {
    const candidates = [host];
    if (!host.includes(".")) candidates.push(`${host}.local`);
    for (const candidate of candidates) {
      urls.push(`http://${candidate}:3002`);
    }
  }
  return Array.from(new Set(urls));
}

async function fetchBridgeLocal(
  path: string,
  urls = BRIDGE_LOCAL_URLS,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown = null;
  for (const bridgeUrl of urls) {
    try {
      const res = await fetch(`${bridgeUrl}${path}`, init);
      if (res.ok) return res;
      lastError = new Error(`Bridge returned ${res.status} from ${bridgeUrl}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Could not reach Counterpoint bridge");
}

interface BridgeEntityStat {
  lastSync?: string;
  recordCount?: number;
  durationMs?: number;
  error?: string | null;
}

interface BridgeLiveStatus {
  isSyncing: boolean;
  isContinuous: boolean;
  currentEntity: string | null;
  lastRun: string | null;
  lastRunDurationMs: number | null;
  totalRecordsLastRun: number;
  abortRequested: boolean;
  entityStats: Record<string, BridgeEntityStat>;
  syncSummary: Record<string, string>;
  recentEvents: BridgeEvent[];
  error?: string;
  migrationPreflight?: BridgeMigrationPreflight;
}

interface BridgeEvent {
  type: "error" | "warning" | "complete" | "start" | "abort";
  entity: string | null;
  message: string;
  time: string;
  durationMs?: number;
  recordCount?: number;
  totalRecords?: number;
}

interface BridgeMigrationPreflight {
  migration_intent: string;
  source_input: string;
  destination_system_of_record: string;
  cp_import_since: string;
  run_once: boolean;
  bridge_continuous_mode: boolean;
  staging_enabled: boolean;
  sync_relaxed_dependencies: boolean;
  import_scope: {
    cp_import_scope: string | null;
    enabled_entities: string[];
    query_placeholders_use_cp_import_since: string[];
  };
  non_idempotent_entities: string[];
  rerun_warnings: string[];
  retirement_checklist: string[];
}

const ENTITY_DISPLAY: { key: string; label: string; icon: typeof Zap }[] = [
  { key: "staff", label: "Staff", icon: Users },
  { key: "sales_rep_stubs", label: "Sales Rep Stubs", icon: Users },
  { key: "vendors", label: "Vendors", icon: Truck },
  { key: "customers", label: "Customers", icon: Users },
  { key: "store_credit_opening", label: "Store Credits", icon: CreditCard },
  { key: "customer_notes", label: "Customer Notes", icon: FileText },
  { key: "category_masters", label: "Categories", icon: Tags },
  { key: "catalog", label: "Catalog", icon: Database },
  { key: "inventory", label: "Inventory", icon: Package },
  { key: "vendor_items", label: "Vendor Items", icon: Hash },
  { key: "gift_cards", label: "Gift Cards", icon: Gift },
  { key: "tickets", label: "Orders / Tickets", icon: FileText },
  { key: "open_docs", label: "Open Docs", icon: FileText },
  { key: "loyalty_hist", label: "Loyalty History", icon: Star },
  { key: "receiving_history", label: "Receiving History", icon: Truck },
  { key: "ticket_notes", label: "Ticket Notes", icon: FileText },
];

function fmtDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtMoney(value: string | number | null | undefined): string {
  if (value == null) return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatFreshnessLabel(iso: string | null | undefined): string {
  if (!iso) return "No bridge run summary yet";
  return `Fresh as of ${fmtTimeAgo(iso)}`;
}

function formatEntityLabel(entity: string): string {
  return (
    ENTITY_DISPLAY.find((entry) => entry.key === entity)?.label ??
    entity.replace(/_/g, " ")
  );
}

function formatReviewLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function diffMinutes(aIso: string | null | undefined, bIso: string | null | undefined): number | null {
  if (!aIso || !bIso) return null;
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round(Math.abs(a - b) / 60000);
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

const PAYMENT_METHOD_OPTIONS = [
  "cash",
  "check",
  "credit_card",
  "gift_card",
  "on_account",
  "store_credit",
];

const GIFT_KIND_OPTIONS = ["purchased", "loyalty_reward", "donated_giveaway", "promo_gift_card"];
const EXPECTED_COUNTERPOINT_MIGRATION_FLOOR = "2018-01-01";

const STATUS_SECTIONS: { key: CounterpointStatusSection; label: string; description: string }[] = [
  {
    key: "connect",
    label: "Connect & Run",
    description: "Bridge reachability, ROS heartbeat, and import controls.",
  },
  {
    key: "signoff",
    label: "Sign-off Checklist",
    description: "Landing, transaction, order, and catalog verification.",
  },
  {
    key: "details",
    label: "Run Details",
    description: "Entity counts, events, history, and issue drill-down.",
  },
  {
    key: "advanced",
    label: "Advanced",
    description: "Staging, preflight scope, rerun warnings, and reset.",
  },
];

const tabBtn = (active: boolean) =>
  `px-3 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg border transition-colors ${
    active
      ? "border-app-warning/40 bg-app-warning/15 text-app-warning"
      : "border-app-border text-app-text-muted hover:bg-app-surface/40"
  }`;

export type CounterpointSyncPanelVariant = "card" | "workspace";

export default function CounterpointSyncSettingsPanel(props?: {
  variant?: CounterpointSyncPanelVariant;
}) {
  const variant = props?.variant ?? "card";
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<HubTab>(() => {
    if (typeof window === "undefined") return "status";
    const saved = window.localStorage.getItem(COUNTERPOINT_TAB_STORAGE_KEY);
    return isHubTab(saved) ? saved : "status";
  });
  const [statusSection, setStatusSection] = useState<CounterpointStatusSection>(() => {
    if (typeof window === "undefined") return "connect";
    const saved = window.localStorage.getItem(COUNTERPOINT_STATUS_SECTION_STORAGE_KEY);
    return isCounterpointStatusSection(saved) ? saved : "connect";
  });
  const [status, setStatus] = useState<SyncStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [batches, setBatches] = useState<StagingBatchRow[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [selectedPayload, setSelectedPayload] = useState<unknown>(null);
  const [payloadLoading, setPayloadLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [stagingToggleBusy, setStagingToggleBusy] = useState(false);
  const [confirmStagingOff, setConfirmStagingOff] = useState(false);
  const [confirmApply, setConfirmApply] = useState<number | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);
  const [resetPreview, setResetPreview] = useState<CounterpointResetPreviewResponse | null>(null);
  const [resetPreviewLoading, setResetPreviewLoading] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetPromptOpen, setResetPromptOpen] = useState(false);
  const [inventoryVerification, setInventoryVerification] =
    useState<CounterpointInventoryVerificationReport | null>(null);
  const [inventoryVerificationLoading, setInventoryVerificationLoading] = useState(false);
  const [landingVerification, setLandingVerification] =
    useState<CounterpointLandingVerificationSummary | null>(null);
  const [landingVerificationLoading, setLandingVerificationLoading] = useState(false);
  const [transactionReconciliation, setTransactionReconciliation] =
    useState<CounterpointTransactionReconciliationSnapshot | null>(null);
  const [transactionReconciliationLoading, setTransactionReconciliationLoading] =
    useState(false);
  const [openDocsVerification, setOpenDocsVerification] =
    useState<CounterpointOpenDocsVerificationSnapshot | null>(null);
  const [openDocsVerificationLoading, setOpenDocsVerificationLoading] = useState(false);
  const [inventoryCatalogVerification, setInventoryCatalogVerification] =
    useState<CounterpointInventoryCatalogVerificationSnapshot | null>(null);
  const [inventoryCatalogVerificationLoading, setInventoryCatalogVerificationLoading] =
    useState(false);
  const [quarantineSummary, setQuarantineSummary] =
    useState<CounterpointQuarantineSummary | null>(null);
  const [quarantineRows, setQuarantineRows] = useState<CounterpointQuarantineRow[]>([]);
  const [registryHealth, setRegistryHealth] =
    useState<CounterpointRegistryHealthSummary | null>(null);
  const [aliasHealth, setAliasHealth] =
    useState<CounterpointBarcodeAliasHealthSummary | null>(null);
  const [lightspeedReferenceHealth, setLightspeedReferenceHealth] =
    useState<LightspeedNormalizationReferenceHealthSummary | null>(null);
  const [quarantineLoading, setQuarantineLoading] = useState(false);

  const [categoryRows, setCategoryRows] = useState<CategoryMapRow[]>([]);
  const [paymentRows, setPaymentRows] = useState<PaymentMapRow[]>([]);
  const [giftRows, setGiftRows] = useState<GiftReasonRow[]>([]);
  const [staffRows, setStaffRows] = useState<StaffMapRow[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<CategoryOption[]>([]);
  const [mapsLoading, setMapsLoading] = useState(false);

  /* ── Bridge live status ── */
  const [bridgeLive, setBridgeLive] = useState<BridgeLiveStatus | null>(null);
  const [bridgeOnline, setBridgeOnline] = useState(false);
  const [bridgeFailCount, setBridgeFailCount] = useState(0);
  const [runRequestBusy, setRunRequestBusy] = useState(false);
  const [bridgeControlUrl, setBridgeControlUrl] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(BRIDGE_CONTROL_URL_STORAGE_KEY) ?? "";
  });
  const [bridgeControlUrlDraft, setBridgeControlUrlDraft] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(BRIDGE_CONTROL_URL_STORAGE_KEY) ?? "";
  });
  const bridgePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bridgeUrls = useMemo(
    () => bridgeControlUrls(status?.bridge_hostname, bridgeControlUrl),
    [status?.bridge_hostname, bridgeControlUrl],
  );
  const serverBridgeActive =
    status?.windows_sync_state === "online" || status?.windows_sync_state === "syncing";
  const serverBridgeSyncing = status?.windows_sync_state === "syncing";
  const bridgeSyncing = bridgeLive?.isSyncing || serverBridgeSyncing;
  const bridgeCurrentEntity = bridgeLive?.currentEntity ?? status?.current_entity ?? null;

  const saveBridgeControlUrl = useCallback(() => {
    const normalized = normalizeBridgeControlUrl(bridgeControlUrlDraft);
    setBridgeControlUrl(normalized);
    setBridgeControlUrlDraft(normalized);
    if (typeof window !== "undefined") {
      if (normalized) {
        window.localStorage.setItem(BRIDGE_CONTROL_URL_STORAGE_KEY, normalized);
      } else {
        window.localStorage.removeItem(BRIDGE_CONTROL_URL_STORAGE_KEY);
      }
    }
    setBridgeFailCount(0);
    toast(normalized ? "Bridge control URL saved." : "Bridge control URL cleared.", "success");
  }, [bridgeControlUrlDraft, toast]);

  const fetchBridgeLive = useCallback(async () => {
    try {
      const res = await fetchBridgeLocal("/api/status", bridgeUrls, {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await res.json()) as BridgeLiveStatus;
      setBridgeLive(data);
      setBridgeOnline(true);
      setBridgeFailCount(0);
    } catch {
      setBridgeOnline(false);
      setBridgeFailCount((f) => f + 1);
    }
  }, [bridgeUrls]);

  // Poll bridge every 3s when on status tab, up to 3 failures
  useEffect(() => {
    if (tab !== "status" || bridgeFailCount >= 3) return;
    void fetchBridgeLive();
    bridgePollRef.current = setInterval(() => {
      void fetchBridgeLive();
    }, 3000);
    return () => {
      if (bridgePollRef.current) clearInterval(bridgePollRef.current);
    };
  }, [tab, fetchBridgeLive, bridgeFailCount]);

  const triggerBridgeSync = useCallback(async (entity?: string) => {
    setRunRequestBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/request-run`, {
        method: "POST",
        headers: {
          ...(backofficeHeaders() as Record<string, string>),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ entity: entity ?? null }),
      });
      if (!res.ok) throw new Error(`Request failed with ${res.status}`);
      toast(
        entity
          ? `Queued ${entity} import for the Counterpoint bridge.`
          : "Queued full import for the Counterpoint bridge.",
        "success",
      );
      setTimeout(() => void fetchBridgeLive(), 1000);
    } catch {
      toast("Could not queue a Counterpoint bridge run", "error");
    } finally {
      setRunRequestBusy(false);
    }
  }, [baseUrl, backofficeHeaders, toast, fetchBridgeLive]);

  const stopBridgeSync = useCallback(async () => {
    try {
      await fetchBridgeLocal("/api/stop", bridgeUrls);
      toast("Stop requested — will halt after current entity finishes.", "info");
      setTimeout(() => void fetchBridgeLive(), 1000);
    } catch {
      toast("Could not reach the Counterpoint bridge controls", "error");
    }
  }, [toast, fetchBridgeLive, bridgeUrls]);

  const fetchStatus = useCallback(async (options?: { quiet?: boolean }) => {
    if (!hasPermission("settings.admin")) return;
    if (!options?.quiet) setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        setStatus((await res.json()) as SyncStatusResponse);
      } else {
        setStatus(null);
      }
    } catch {
      setStatus(null);
    } finally {
      if (!options?.quiet) setLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchResetPreview = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setResetPreviewLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/reset-preview`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        setResetPreview((await res.json()) as CounterpointResetPreviewResponse);
      } else {
        setResetPreview(null);
      }
    } catch {
      setResetPreview(null);
    } finally {
      setResetPreviewLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchInventoryVerification = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setInventoryVerificationLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/inventory-verification`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setInventoryVerification(
          (await res.json()) as CounterpointInventoryVerificationReport,
        );
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setInventoryVerification(null);
        toast(j.error ?? "Could not build inventory verification report", "error");
      }
    } catch {
      setInventoryVerification(null);
      toast("Could not build inventory verification report", "error");
    } finally {
      setInventoryVerificationLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission, toast]);

  const fetchLandingVerification = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setLandingVerificationLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/landing-verification`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setLandingVerification(
          (await res.json()) as CounterpointLandingVerificationSummary,
        );
      } else {
        setLandingVerification(null);
      }
    } catch {
      setLandingVerification(null);
    } finally {
      setLandingVerificationLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchTransactionReconciliation = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setTransactionReconciliationLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/transaction-reconciliation`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setTransactionReconciliation(
          (await res.json()) as CounterpointTransactionReconciliationSnapshot,
        );
      } else {
        setTransactionReconciliation(null);
      }
    } catch {
      setTransactionReconciliation(null);
    } finally {
      setTransactionReconciliationLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchOpenDocsVerification = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setOpenDocsVerificationLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/open-docs-verification`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setOpenDocsVerification(
          (await res.json()) as CounterpointOpenDocsVerificationSnapshot,
        );
      } else {
        setOpenDocsVerification(null);
      }
    } catch {
      setOpenDocsVerification(null);
    } finally {
      setOpenDocsVerificationLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchInventoryCatalogVerification = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setInventoryCatalogVerificationLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/inventory-catalog-verification`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setInventoryCatalogVerification(
          (await res.json()) as CounterpointInventoryCatalogVerificationSnapshot,
        );
      } else {
        setInventoryCatalogVerification(null);
      }
    } catch {
      setInventoryCatalogVerification(null);
    } finally {
      setInventoryCatalogVerificationLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchBatches = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches?limit=200`,
        { headers: backofficeHeaders() as Record<string, string> },
      );
      if (res.ok) {
        setBatches((await res.json()) as StagingBatchRow[]);
      }
    } catch {
      setBatches([]);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchQuarantineReview = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setQuarantineLoading(true);
    try {
      const headers = backofficeHeaders() as Record<string, string>;
      const [registryRes, aliasRes, lightspeedRes, summaryRes, rowsRes] = await Promise.all([
        fetch(`${baseUrl}/api/settings/counterpoint-sync/registry-health`, { headers }),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/aliases/health`, { headers }),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/lightspeed-reference/health`, {
          headers,
        }),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/quarantine/summary`, { headers }),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/quarantine/rows?limit=25`, {
          headers,
        }),
      ]);
      if (registryRes.ok) {
        setRegistryHealth((await registryRes.json()) as CounterpointRegistryHealthSummary);
      } else {
        setRegistryHealth(null);
      }
      if (aliasRes.ok) {
        setAliasHealth((await aliasRes.json()) as CounterpointBarcodeAliasHealthSummary);
      } else {
        setAliasHealth(null);
      }
      if (lightspeedRes.ok) {
        setLightspeedReferenceHealth(
          (await lightspeedRes.json()) as LightspeedNormalizationReferenceHealthSummary,
        );
      } else {
        setLightspeedReferenceHealth(null);
      }
      if (summaryRes.ok) {
        setQuarantineSummary((await summaryRes.json()) as CounterpointQuarantineSummary);
      } else {
        setQuarantineSummary(null);
      }
      if (rowsRes.ok) {
        const data = (await rowsRes.json()) as CounterpointQuarantineRowsResponse;
        setQuarantineRows(data.rows ?? []);
      } else {
        setQuarantineRows([]);
      }
    } catch {
      setRegistryHealth(null);
      setAliasHealth(null);
      setLightspeedReferenceHealth(null);
      setQuarantineSummary(null);
      setQuarantineRows([]);
    } finally {
      setQuarantineLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  const fetchCategoriesForPicker = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/categories`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const raw = (await res.json()) as { id: string; name: string }[];
        setCategoryOptions(raw.map((c) => ({ id: c.id, name: c.name })));
      }
    } catch {
      setCategoryOptions([]);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchMaps = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setMapsLoading(true);
    try {
      const h = backofficeHeaders() as Record<string, string>;
      const [c, p, g, s] = await Promise.all([
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/category`, {
          headers: h,
        }).catch(() => null),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/payment`, { headers: h }).catch(
          () => null,
        ),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/gift-reason`, {
          headers: h,
        }).catch(() => null),
        fetch(`${baseUrl}/api/settings/counterpoint-sync/maps/staff`, { headers: h }).catch(
          () => null,
        ),
      ]);
      if (c?.ok) setCategoryRows((await c.json()) as CategoryMapRow[]);
      if (p?.ok) setPaymentRows((await p.json()) as PaymentMapRow[]);
      if (g?.ok) setGiftRows((await g.json()) as GiftReasonRow[]);
      if (s?.ok) setStaffRows((await s.json()) as StaffMapRow[]);
    } finally {
      setMapsLoading(false);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  useEffect(() => {
    void fetchStatus();
    void fetchResetPreview();
    void fetchLandingVerification();
    void fetchTransactionReconciliation();
    void fetchOpenDocsVerification();
    void fetchInventoryCatalogVerification();
  }, [
    fetchStatus,
    fetchResetPreview,
    fetchLandingVerification,
    fetchTransactionReconciliation,
    fetchOpenDocsVerification,
    fetchInventoryCatalogVerification,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COUNTERPOINT_TAB_STORAGE_KEY, tab);
  }, [tab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COUNTERPOINT_STATUS_SECTION_STORAGE_KEY, statusSection);
  }, [statusSection]);

  useEffect(() => {
    if (tab !== "status") return;
    const interval = setInterval(() => {
      void fetchStatus({ quiet: true });
    }, 5000);
    return () => clearInterval(interval);
  }, [tab, fetchStatus]);

  useEffect(() => {
    if (tab === "inbound") void fetchBatches();
  }, [tab, fetchBatches]);

  useEffect(() => {
    if (tab !== "import-console") return;
    void fetchStatus({ quiet: true });
    void fetchQuarantineReview();
  }, [tab, fetchStatus, fetchQuarantineReview]);

  useEffect(() => {
    if (tab === "categories" || tab === "payments" || tab === "gifts" || tab === "staff") {
      void fetchMaps();
      if (tab === "categories") void fetchCategoriesForPicker();
    }
  }, [tab, fetchMaps, fetchCategoriesForPicker]);

  useEffect(() => {
    if (selectedBatchId == null) {
      setSelectedPayload(null);
      return;
    }
    setPayloadLoading(true);
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${selectedBatchId}/payload`,
          { headers: backofficeHeaders() as Record<string, string> },
        );
        if (res.ok) {
          setSelectedPayload(await res.json());
        } else {
          setSelectedPayload(null);
          toast("Could not load batch payload", "error");
        }
      } catch {
        setSelectedPayload(null);
      } finally {
        setPayloadLoading(false);
      }
    })();
  }, [selectedBatchId, baseUrl, backofficeHeaders, toast]);


  const setStagingEnabled = async (enabled: boolean) => {
    setStagingToggleBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/staging/enabled`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ staging_enabled: enabled }),
      });
      if (res.ok) {
        toast(
          enabled
            ? "Inbound staging is on. The bridge will queue batches until you Apply."
            : "Inbound staging is off. The bridge will post directly to live import endpoints.",
          "success",
        );
        await fetchStatus();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not update staging mode", "error");
      }
    } catch {
      toast("Could not update staging mode", "error");
    } finally {
      setStagingToggleBusy(false);
      setConfirmStagingOff(false);
    }
  };

  const applyBatch = async (id: number) => {
    setApplyBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/staging/batches/${id}/apply`,
        {
          method: "POST",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        toast("Batch applied to live data.", "success");
        setConfirmApply(null);
        await fetchBatches();
        await fetchStatus();
        await fetchLandingVerification();
        await fetchTransactionReconciliation();
        await fetchOpenDocsVerification();
        await fetchInventoryCatalogVerification();
        if (selectedBatchId === id) {
          setSelectedBatchId(null);
        }
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Apply failed", "error");
        await fetchBatches();
      }
    } catch {
      toast("Apply failed", "error");
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
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        toast("Batch discarded.", "success");
        setConfirmDiscard(null);
        await fetchBatches();
        if (selectedBatchId === id) setSelectedBatchId(null);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Discard failed", "error");
      }
    } catch {
      toast("Discard failed", "error");
    }
  };

  const resolveIssue = async (issueId: number) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/issues/${issueId}/resolve`,
        {
          method: "PATCH",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                recent_issues: prev.recent_issues.filter((i) => i.id !== issueId),
              }
            : prev,
        );
      }
    } catch {
      toast("Could not resolve issue", "error");
    }
  };

  const patchCategoryMap = async (id: number, rosCategoryId: string | null) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/counterpoint-sync/maps/category/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ ros_category_id: rosCategoryId }),
        },
      );
      if (res.ok) {
        toast("Category map updated.", "success");
        await fetchMaps();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Update failed", "error");
      }
    } catch {
      toast("Update failed", "error");
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
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ ros_method: rosMethod }),
        },
      );
      if (res.ok) {
        toast("Payment map updated.", "success");
        await fetchMaps();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Update failed", "error");
      }
    } catch {
      toast("Update failed", "error");
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
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ ros_card_kind: kind }),
        },
      );
      if (res.ok) {
        toast("Gift reason map updated.", "success");
        await fetchMaps();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Update failed", "error");
      }
    } catch {
      toast("Update failed", "error");
    }
  };

  const runBaselineReset = async (confirmationPhrase: string) => {
    setResetBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/counterpoint-sync/reset-baseline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ confirmation_phrase: confirmationPhrase }),
      });
      if (res.ok) {
        toast("Fresh Counterpoint migration baseline restored in ROS.", "success");
        await Promise.all([fetchStatus(), fetchResetPreview(), fetchBatches()]);
        setSelectedBatchId(null);
        return true;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      toast(j.error ?? "Baseline reset failed", "error");
      return false;
    } catch {
      toast("Baseline reset failed", "error");
      return false;
    } finally {
      setResetBusy(false);
    }
  };

  const stateColor = (s: string) => {
    if (s === "online") return "text-emerald-600";
    if (s === "syncing") return "text-sky-600";
    return "text-red-500";
  };

  const stateIcon = (s: string) => {
    if (s === "online") return <Wifi className="h-5 w-5 text-emerald-500" aria-hidden />;
    if (s === "syncing")
      return <Loader2 className="h-5 w-5 text-sky-500 animate-spin" aria-hidden />;
    return <WifiOff className="h-5 w-5 text-red-500" aria-hidden />;
  };

  const formatDate = (iso: string | null | undefined) => {
    if (!iso) return "—";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  if (!hasPermission("settings.admin")) return null;

  const stagingOn = status?.counterpoint_staging_enabled === true;
  const pendingN = status?.staging_pending_count ?? 0;
  const quarantineTotal = quarantineSummary?.total_records ?? 0;
  const quarantineSeverityRows = [
    { label: "Blocked", value: quarantineSummary?.blocking_records ?? 0, tone: "text-app-danger" },
    {
      label: "Needs review",
      value: quarantineSummary?.quarantine_records ?? 0,
      tone: "text-app-warning",
    },
    { label: "Warnings", value: quarantineSummary?.warning_records ?? 0, tone: "text-amber-600" },
    { label: "Info", value: quarantineSummary?.info_records ?? 0, tone: "text-app-text-muted" },
  ];
  const aliasReady =
    (aliasHealth?.active_aliases ?? 0) > 0 &&
    (aliasHealth?.duplicate_active_alias_conflicts ?? 0) === 0;
  const lightspeedReady =
    !!lightspeedReferenceHealth?.active_batch &&
    (lightspeedReferenceHealth?.b_sku_count ?? 0) > 0;
  const cleanupReady = aliasReady && lightspeedReady;
  const registryStatusLabel = !registryHealth
    ? "Unknown"
    : registryHealth.status === "healthy"
      ? "Healthy"
      : registryHealth.status === "warning"
        ? "Warning"
        : "Needs review";
  const registryStatusTone = !registryHealth
    ? "border-app-border bg-app-bg/60 text-app-text-muted"
    : registryHealth.status === "healthy"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : registryHealth.status === "warning"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-red-200 bg-red-50 text-red-700";
  const registryHealthRows = [
    {
      label: "CP products",
      value: registryHealth?.counterpoint_products,
      tone: "text-app-text",
    },
    {
      label: "CP variants",
      value: registryHealth?.counterpoint_variants,
      tone: "text-app-text",
    },
    {
      label: "With item key",
      value: registryHealth?.variants_with_counterpoint_item_key,
      tone: "text-emerald-600",
    },
    {
      label: "Missing item key",
      value: registryHealth?.variants_missing_counterpoint_item_key,
      tone:
        (registryHealth?.variants_missing_counterpoint_item_key ?? 0) > 0
          ? "text-amber-600"
          : "text-app-text",
    },
    {
      label: "Duplicate SKUs",
      value: registryHealth?.duplicate_normalized_sku_values,
      tone:
        (registryHealth?.duplicate_normalized_sku_values ?? 0) > 0
          ? "text-app-danger"
          : "text-app-text",
    },
    {
      label: "Duplicate item keys",
      value: registryHealth?.duplicate_counterpoint_item_key_values,
      tone:
        (registryHealth?.duplicate_counterpoint_item_key_values ?? 0) > 0
          ? "text-app-danger"
          : "text-app-text",
    },
    {
      label: "Needs review",
      value: registryHealth?.quarantine_record_count,
      tone:
        (registryHealth?.quarantine_record_count ?? 0) > 0
          ? "text-app-warning"
          : "text-app-text",
    },
  ];
  const migrationPreflight = bridgeLive?.migrationPreflight ?? null;
  const enabledEntities = migrationPreflight?.import_scope.enabled_entities ?? [];
  const nonIdempotentEntities = migrationPreflight?.non_idempotent_entities ?? [];
  const successfulServerRuns =
    status?.entity_runs.filter((run) => !!run.last_ok_at && !run.last_error).length ?? 0;
  const failedServerRuns = status?.entity_runs.filter((run) => !!run.last_error).length ?? 0;
  const rerunWarnings = migrationPreflight?.rerun_warnings ?? [];
  const showRerunWarning =
    rerunWarnings.length > 0 ||
    ((status?.entity_runs.length ?? 0) > 0 && nonIdempotentEntities.length > 0);
  const rosRunsByEntity = new Map(
    (status?.entity_runs ?? []).map((run) => [run.entity, run] as const),
  );
  const landingVerificationRows = landingVerification?.rows ?? [];
  const snapshotReconciliationRows = landingVerification?.snapshot_reconciliation ?? [];
  const cutoverVisibilityRows = landingVerification?.cutover_visibility ?? [];
  const fidelityDiagnostics = landingVerification?.fidelity_diagnostics ?? [];
  const landingRowsByKey = new Map(landingVerificationRows.map((row) => [row.key, row] as const));
  const snapshotRowsByKey = new Map(snapshotReconciliationRows.map((row) => [row.key, row] as const));
  const snapshotProofKeyByEntity: Record<string, string> = {
    customers: "customers",
    vendors: "counterpoint_vendors",
    category_masters: "counterpoint_categories",
    catalog: "catalog_products",
    inventory: "inventory_quantity_rows",
    gift_cards: "gift_cards",
    open_docs: "open_docs",
  };
  const landingProofKeyByEntity: Record<string, string> = {
    staff: "staff_records",
    vendors: "vendors",
    store_credit_opening: "store_credit_openings",
    category_masters: "category_maps",
    catalog: "products",
    vendor_items: "vendor_supplier_items",
    tickets: "closed_ticket_transactions",
    receiving_history: "receiving_history",
  };
  const latestRunEntities = Array.from(
    new Set([
      ...enabledEntities,
      ...Object.keys(bridgeLive?.entityStats ?? {}),
      ...(status?.entity_runs ?? []).map((run) => run.entity),
    ]),
  );
  const reconciliationRows = latestRunEntities.map((entity) => {
    const bridgeStat = bridgeLive?.entityStats?.[entity];
    const rosRun = rosRunsByEntity.get(entity);
    const snapshotProof = snapshotRowsByKey.get(snapshotProofKeyByEntity[entity]);
    const landingProof = landingRowsByKey.get(landingProofKeyByEntity[entity]);
    const bridgeCount = bridgeStat?.recordCount ?? snapshotProof?.source_count ?? null;
    const rosCount = snapshotProof?.landed_count ?? landingProof?.count ?? rosRun?.records_processed ?? null;
    const bridgeTime = bridgeStat?.lastSync ?? null;
    const rosTime = snapshotProof?.source_updated_at ?? rosRun?.last_ok_at ?? null;
    const minuteGap = diffMinutes(bridgeTime, rosTime);

    let comparisonLabel = "No latest proof";
    let comparisonTone = "text-app-text-muted";

    if (bridgeCount != null && rosCount != null && bridgeCount === rosCount) {
      comparisonLabel = "Counts match";
      comparisonTone = "text-emerald-600";
    } else if (bridgeCount != null && rosCount != null) {
      comparisonLabel = rosCount > bridgeCount ? "ROS count higher" : "ROS count lower";
      comparisonTone = "text-amber-600";
    } else if (bridgeCount != null) {
      comparisonLabel = "Bridge only";
      comparisonTone = "text-red-500";
    } else if (rosCount != null) {
      comparisonLabel = "ROS only";
      comparisonTone = "text-amber-600";
    }

    let note = "No current bridge or ROS count for this entity in the latest visible data.";
    if (bridgeCount != null && rosCount != null) {
      if (snapshotProof) {
        note = `ROS count uses ${snapshotProof.label.toLowerCase()} proof. ${snapshotProof.note}`;
      } else if (landingProof) {
        note = `ROS count uses landed-table proof: ${landingProof.note}.`;
      } else {
        note =
          minuteGap != null
            ? `Latest timestamps are ${minuteGap} minute(s) apart. ROS count is the last successful landed/apply count for this entity.`
            : "ROS count is the last successful landed/apply count for this entity.";
      }
    } else if (bridgeCount != null) {
      note = "Bridge reported rows for this entity, but ROS does not show a successful landed count yet.";
    } else if (rosCount != null) {
      note = "ROS shows a landed count for this entity, but the current bridge session does not expose a matching latest count.";
    }

    return {
      entity,
      bridgeCount,
      rosCount,
      bridgeTime,
      rosTime,
      rosError: rosRun?.last_error ?? null,
      comparisonLabel,
      comparisonTone,
      note,
    };
  });
  const unresolvedIssueCount = status?.recent_issues.length ?? 0;
  const entitiesMissingRosProof = reconciliationRows.filter(
    (row) => row.bridgeCount != null && row.rosCount == null,
  ).length;
  const mismatchedEntityCounts = reconciliationRows.filter(
    (row) =>
      row.bridgeCount != null &&
      row.rosCount != null &&
      row.bridgeCount !== row.rosCount,
  ).length;
  const signoffBlockers = [
    !bridgeLive?.lastRun ? "No bridge run summary is visible yet." : null,
    pendingN > 0 ? `${fmtNum(pendingN)} staging batch(es) are still pending Apply.` : null,
    unresolvedIssueCount > 0 ? `${fmtNum(unresolvedIssueCount)} unresolved sync issue(s) remain.` : null,
    entitiesMissingRosProof > 0
      ? `${fmtNum(entitiesMissingRosProof)} entity row(s) have bridge-reported counts without ROS landed proof.`
      : null,
    Object.values(bridgeLive?.entityStats ?? {}).some((stat) => !!stat?.error)
      ? "At least one bridge entity still shows an error in the latest visible run."
      : null,
  ].filter((item): item is string => !!item);
  const signoffWarnings = [
    mismatchedEntityCounts > 0
      ? `${fmtNum(mismatchedEntityCounts)} entity row(s) have bridge and ROS counts that do not match exactly.`
      : null,
    migrationPreflight?.staging_enabled
      ? "ROS landed counts may reflect Apply timing instead of the exact bridge send moment when staging is enabled."
      : null,
    "Where available, ROS landed counts use domain proof tables instead of rerun counters. Remaining entities may still use `counterpoint_sync_runs.records_processed`, which can include skipped or already-existing rows."
  ].filter((item): item is string => !!item);
  const resetScopeRows = resetPreview?.reset_scope ?? [];
  const resetTotalRows = resetScopeRows.reduce((sum, row) => sum + row.count, 0);
  const inventoryVerificationSummary = inventoryVerification?.summary ?? null;
  const inventoryVerificationMismatchRows =
    inventoryVerification?.mismatch_rows ?? [];
  const inventoryVerificationExtraRows = inventoryVerification?.extra_rows ?? [];
  const inventoryVerificationIssues = inventoryVerification?.critical_issues ?? [];
  const landingApproximateCount = landingVerificationRows.filter(
    (row) => row.confidence !== "direct",
  ).length;
  const transactionReconciliationTotals = transactionReconciliation?.totals ?? null;
  const transactionReconciliationDiff = transactionReconciliationTotals
    ? Number(transactionReconciliationTotals.difference)
    : 0;
  const hasTransactionTotalMismatch =
    Number.isFinite(transactionReconciliationDiff) &&
    Math.abs(transactionReconciliationDiff) > 0.005;
  const transactionReconciliationByDate =
    transactionReconciliation?.by_date.slice(0, 10) ?? [];
  const transactionReconciliationByPaymentType =
    transactionReconciliation?.by_payment_type ?? [];
  const openDocsWarningCount =
    (openDocsVerification?.open_docs_missing_customer ?? 0) +
    (openDocsVerification?.open_docs_with_zero_lines ?? 0) +
    (openDocsVerification?.open_docs_with_zero_payments ?? 0);
  const inventoryCatalogWarningCount =
    (inventoryCatalogVerification?.products_with_identifier_like_name ?? 0) +
    (inventoryCatalogVerification?.variants_missing_sku ?? 0) +
    (inventoryCatalogVerification?.variants_missing_barcode ?? 0) +
    (inventoryCatalogVerification?.variants_missing_cost ?? 0) +
    (inventoryCatalogVerification?.variants_missing_price ?? 0) +
    (inventoryCatalogVerification?.products_missing_category_mapping ?? 0) +
    (inventoryCatalogVerification?.variants_missing_vendor_supplier_item_link ?? 0);
  const inventoryCatalogCoverageRows = inventoryCatalogVerification
    ? [
        { label: "CP products", value: inventoryCatalogVerification.counterpoint_products },
        { label: "CP variants", value: inventoryCatalogVerification.counterpoint_variants },
        { label: "With SKU", value: inventoryCatalogVerification.variants_with_sku },
        { label: "With barcode", value: inventoryCatalogVerification.variants_with_barcode },
        { label: "With cost", value: inventoryCatalogVerification.variants_with_cost },
        { label: "With price", value: inventoryCatalogVerification.variants_with_price },
        {
          label: "Qty on hand",
          value: inventoryCatalogVerification.variants_with_quantity_on_hand,
        },
        {
          label: "Linked vendors",
          value: inventoryCatalogVerification.distinct_vendors_linked_to_imported_items,
        },
      ]
    : [];
  const inventoryCatalogWarningRows = inventoryCatalogVerification
    ? [
        { label: "Missing SKU", value: inventoryCatalogVerification.variants_missing_sku },
        {
          label: "Name is item #",
          value: inventoryCatalogVerification.products_with_identifier_like_name,
        },
        {
          label: "Name equals key",
          value: inventoryCatalogVerification.products_name_equals_counterpoint_key,
        },
        {
          label: "Missing barcode",
          value: inventoryCatalogVerification.variants_missing_barcode,
        },
        { label: "Missing cost", value: inventoryCatalogVerification.variants_missing_cost },
        { label: "Missing price", value: inventoryCatalogVerification.variants_missing_price },
        {
          label: "Zero/negative qty",
          value: inventoryCatalogVerification.variants_zero_or_negative_quantity,
        },
        {
          label: "Missing category",
          value: inventoryCatalogVerification.products_missing_category_mapping,
        },
        {
          label: "Missing vendor link",
          value: inventoryCatalogVerification.variants_missing_vendor_supplier_item_link,
        },
      ]
    : [];
  const inventoryVerificationWarningCount = inventoryVerificationSummary
    ? inventoryVerificationSummary.mismatched_count +
      inventoryVerificationSummary.missing_in_ros_count +
      inventoryVerificationSummary.extra_unexplained_count +
      inventoryVerificationSummary.identifier_like_product_name_count +
      inventoryVerificationIssues.length
    : null;
  const signoffChecklistRows = [
    {
      key: "landing",
      label: "Landing Verification",
      value: landingVerification ? `${fmtNum(landingVerificationRows.length)} domains` : "Not refreshed",
      warningCount: landingVerification ? landingApproximateCount : null,
      warningLabel: "weak/approximate domain(s)",
      ready: !!landingVerification && landingApproximateCount === 0,
      loading: landingVerificationLoading,
      actionLabel: "Refresh landing",
      onRefresh: fetchLandingVerification,
    },
    {
      key: "transactions",
      label: "Transaction Reconciliation",
      value: transactionReconciliationTotals
        ? fmtMoney(transactionReconciliationTotals.transaction_total_sum)
        : "Not refreshed",
      warningCount: transactionReconciliationTotals ? (hasTransactionTotalMismatch ? 1 : 0) : null,
      warningLabel: "total/payment mismatch",
      ready: !!transactionReconciliationTotals && !hasTransactionTotalMismatch,
      loading: transactionReconciliationLoading,
      actionLabel: "Refresh transactions",
      onRefresh: fetchTransactionReconciliation,
    },
    {
      key: "open-docs",
      label: "Open Docs / Orders",
      value: openDocsVerification
        ? `${fmtNum(openDocsVerification.imported_open_doc_transactions)} docs`
        : "Not refreshed",
      warningCount: openDocsVerification ? openDocsWarningCount : null,
      warningLabel: "structural warning(s)",
      ready: !!openDocsVerification && openDocsWarningCount === 0,
      loading: openDocsVerificationLoading,
      actionLabel: "Refresh open docs",
      onRefresh: fetchOpenDocsVerification,
    },
    {
      key: "catalog",
      label: "Inventory & Catalog",
      value: inventoryCatalogVerification
        ? `${fmtNum(inventoryCatalogVerification.counterpoint_products)} products`
        : "Not refreshed",
      warningCount: inventoryCatalogVerification ? inventoryCatalogWarningCount : null,
      warningLabel: "catalog warning(s)",
      ready: !!inventoryCatalogVerification && inventoryCatalogWarningCount === 0,
      loading: inventoryCatalogVerificationLoading,
      actionLabel: "Refresh catalog",
      onRefresh: fetchInventoryCatalogVerification,
    },
    {
      key: "csv-inventory",
      label: "Legacy Inventory Audit",
      value: inventoryVerificationSummary
        ? `${fmtNum(inventoryVerificationSummary.matched_count)} matched`
        : "Not run",
      warningCount: inventoryVerificationWarningCount,
      warningLabel: "legacy issue(s)",
      ready: !!inventoryVerificationSummary && inventoryVerificationWarningCount === 0,
      loading: inventoryVerificationLoading,
      actionLabel: "Run legacy audit",
      onRefresh: fetchInventoryVerification,
    },
  ];
  const issueSeveritySummary = Object.entries(
    (status?.recent_issues ?? []).reduce<Record<string, number>>((acc, issue) => {
      const key = issue.severity?.trim() || "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .map(([severity, count]) => `${fmtNum(count)} ${severity.toLowerCase()}`)
    .join(", ");
  const counterpointInsightFacts = {
    title: "Counterpoint Sign-off Explanation",
    bullets: [
      ...signoffBlockers.map((label, index) => ({
        id: `counterpoint-blocker-${index}`,
        label,
        severity: "warning",
      })),
      ...signoffWarnings.map((label, index) => ({
        id: `counterpoint-warning-${index}`,
        label,
        severity: "info",
      })),
      ...signoffChecklistRows.map((row) => ({
        id: `counterpoint-check-${row.key}`,
        label:
          row.warningCount == null
            ? `${row.label}: ${row.value}; needs refresh.`
            : row.warningCount > 0
              ? `${row.label}: ${row.value}; ${fmtNum(row.warningCount)} ${row.warningLabel}.`
              : `${row.label}: ${row.value}; no warnings shown.`,
        severity: row.warningCount == null || row.warningCount > 0 ? "warning" : "success",
      })),
      ...(unresolvedIssueCount > 0
        ? [{
            id: "counterpoint-unresolved-issues",
            label: `${fmtNum(unresolvedIssueCount)} unresolved sync issue(s) remain${
              issueSeveritySummary ? ` by severity: ${issueSeveritySummary}` : ""
            }.`,
            severity: "warning",
          }]
        : []),
    ],
    disclaimers: [
      "Explain the displayed Counterpoint checks only. Do not approve sign-off, reconcile, or declare cutover safe.",
    ],
  };

  const formatVerificationStatus = (statusValue: string) => {
    if (statusValue === "missing_in_ros") return "Missing in ROS";
    if (statusValue === "comparison_artifact") return "Comparison artifact";
    if (statusValue === "csv_source_issue") return "Source file issue";
    if (statusValue === "expected_out_of_scope_exclusion") return "Expected out-of-scope exclusion";
    if (statusValue === "extra_parent_scope_artifact") return "ROS parent-scope artifact";
    if (statusValue === "extra_key_present_scope_gap") return "ROS scope gap";
    if (statusValue === "extra_unexplained") return "Extra in ROS";
    if (statusValue === "mismatch") return "Mismatch";
    return statusValue.replace(/_/g, " ");
  };

  const formatMismatchType = (value: string) =>
    value.replace(/_/g, " ");

  const refreshButton = (
    <button
      type="button"
      disabled={loading}
      onClick={() => {
        void fetchStatus();
        void fetchResetPreview();
        void fetchLandingVerification();
      }}
      className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 shrink-0"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
      Refresh
    </button>
  );

  const tabStrip = (
    <div className="flex flex-wrap gap-2 min-w-0">
      <button type="button" className={tabBtn(tab === "status")} onClick={() => setTab("status")}>
        <span className="inline-flex items-center gap-1.5">
          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
          Status
        </span>
      </button>
      <button
        type="button"
        className={tabBtn(tab === "import-console")}
        onClick={() => setTab("import-console")}
      >
        <span className="inline-flex items-center gap-1.5">
          <Database className="h-3.5 w-3.5" aria-hidden />
          Import Console
          {(quarantineSummary?.total_records ?? 0) > 0 ? (
            <span className="ui-pill bg-amber-500/20 px-1.5 py-0 text-amber-800 dark:text-amber-100">
              {fmtNum(quarantineSummary?.total_records ?? 0)}
            </span>
          ) : null}
        </span>
      </button>
      <button type="button" className={tabBtn(tab === "inbound")} onClick={() => setTab("inbound")}>
        <span className="inline-flex items-center gap-1.5">
          <Inbox className="h-3.5 w-3.5" aria-hidden />
          Inbound queue
          {pendingN > 0 ? (
            <span className="ui-pill bg-amber-500/20 px-1.5 py-0 text-amber-800 dark:text-amber-100">
              {pendingN}
            </span>
          ) : null}
        </span>
      </button>
      <button
        type="button"
        className={tabBtn(tab === "categories")}
        onClick={() => setTab("categories")}
      >
        <span className="inline-flex items-center gap-1.5">
          <Tags className="h-3.5 w-3.5" aria-hidden />
          Categories
        </span>
      </button>
      <button type="button" className={tabBtn(tab === "payments")} onClick={() => setTab("payments")}>
        <span className="inline-flex items-center gap-1.5">
          <CreditCard className="h-3.5 w-3.5" aria-hidden />
          Payments
        </span>
      </button>
      <button type="button" className={tabBtn(tab === "gifts")} onClick={() => setTab("gifts")}>
        <span className="inline-flex items-center gap-1.5">
          <Gift className="h-3.5 w-3.5" aria-hidden />
          Gift reasons
        </span>
      </button>
      <button type="button" className={tabBtn(tab === "staff")} onClick={() => setTab("staff")}>
        <span className="inline-flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5" aria-hidden />
          Staff links
        </span>
      </button>
    </div>
  );

  const chrome = (
    <>
      {variant === "card" ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-500/15 text-orange-600">
                <Monitor className="h-6 w-6" aria-hidden />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Counterpoint integration
                </h3>
                <p className="text-xs text-app-text-muted mt-1 max-w-3xl leading-relaxed">
                  One-time Counterpoint migration status, inbound review queue, and import code maps.
                  Counterpoint is the source input; Riverside becomes the system of record after cutover.
                </p>
              </div>
            </div>
            {refreshButton}
          </div>
          <div className="mb-6">{tabStrip}</div>
        </>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6 min-w-0">
          {tabStrip}
          {refreshButton}
        </div>
      )}
    </>
  );

  const shellClass =
    variant === "workspace"
      ? "ui-card ui-tint-warning p-6 sm:p-8"
      : "ui-card ui-tint-warning p-8 max-w-6xl";

  return (
    <section
      className={shellClass}
      data-testid={variant === "workspace" ? "counterpoint-settings-panel" : undefined}
    >
      {chrome}

      {tab === "status" && (
        <>
          <div className="mb-4 rounded-xl border border-app-border bg-app-surface-2/40 p-3">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Status Sections
                </p>
                <p className="mt-1 text-xs text-app-text-muted">
                  Switch views here. All bridge controls, verification cards, run details, and reset tools are still available.
                </p>
              </div>
              <span className="ui-pill bg-app-warning/15 text-app-warning text-[9px]">
                Viewing {STATUS_SECTIONS.find((section) => section.key === statusSection)?.label}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              {STATUS_SECTIONS.map((section, index) => {
                const active = statusSection === section.key;
                return (
                  <button
                    key={section.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setStatusSection(section.key)}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? "border-app-warning/60 bg-app-warning/15 text-app-text shadow-sm"
                        : "border-app-border bg-app-bg/40 text-app-text-muted hover:border-app-warning/30 hover:bg-app-surface/50 hover:text-app-text"
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span
                          className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[9px] font-black ${
                            active
                              ? "border-app-warning/50 bg-app-warning/20 text-app-warning"
                              : "border-app-border bg-app-surface/50 text-app-text-muted"
                          }`}
                        >
                          {index + 1}
                        </span>
                        <span className="text-[10px] font-black uppercase tracking-widest">
                          {section.label}
                        </span>
                      </span>
                      <span className={`text-[9px] font-black uppercase tracking-widest ${active ? "text-app-warning" : "text-app-text-muted"}`}>
                        {active ? "Viewing" : "Open"}
                      </span>
                    </span>
                    <span className="mt-1 block text-[10px] leading-snug">
                      {section.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── Bridge Live Status ── */}
          {bridgeOnline && bridgeLive ? (
            <>
              {/* Run Control */}
              {(statusSection === "connect" || bridgeSyncing) && (
              <div className="ui-panel ui-tint-neutral p-4 mb-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      bridgeSyncing
                        ? "bg-app-warning/20 text-app-warning"
                        : "bg-app-success/15 text-app-success"
                    }`}>
                      {bridgeSyncing ? (
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                      ) : (
                        <Zap className="h-5 w-5" aria-hidden />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-black uppercase tracking-widest">
                        {bridgeSyncing ? (
                          <span className="text-app-warning">
                            Importing{bridgeCurrentEntity ? ` — ${bridgeCurrentEntity.replace(/_/g, " ")}` : ""}
                          </span>
                        ) : (
                          <span className="text-app-success">Bridge Idle</span>
                        )}
                      </p>
	                      <p className="text-[10px] text-app-text-muted mt-0.5">
	                        {formatFreshnessLabel(bridgeLive.lastRun)}
	                        {bridgeLive.lastRunDurationMs ? ` · ${fmtDuration(bridgeLive.lastRunDurationMs)}` : ""}
                        {bridgeLive.totalRecordsLastRun ? ` · ${fmtNum(bridgeLive.totalRecordsLastRun)} records` : ""}
	                      </p>
                        <p className="text-[10px] text-app-text-muted mt-1">
                          {bridgeSyncing
                            ? "The bridge is actively importing. Riverside landed counts update after each entity finishes."
                            : Object.values(bridgeLive.entityStats || {}).some((stat) => !!stat?.error)
                              ? "The latest visible bridge run includes errors. Review the failed entity rows and recent bridge events before rerunning."
                              : "Use the bridge run summary for import progress. Use ROS landed counts below as proof that rows were applied."}
                        </p>
	                    </div>
	                  </div>
                  {bridgeLive.isSyncing ? (
                    <button
                      type="button"
                      disabled={bridgeLive.abortRequested}
                      onClick={() => void stopBridgeSync()}
                      className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 rounded-xl border border-app-danger/30 bg-app-danger/10 text-app-danger hover:bg-app-danger/20 transition-colors disabled:opacity-50"
                    >
                      <Square className="h-3.5 w-3.5" aria-hidden />
                      {bridgeLive.abortRequested ? "Stopping…" : "Stop Import"}
                    </button>
                  ) : serverBridgeSyncing ? (
                    <button
                      type="button"
                      disabled
                      className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 rounded-xl border border-app-warning/30 bg-app-warning/10 text-app-warning disabled:opacity-80"
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Import Running
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={runRequestBusy}
                      onClick={() => void triggerBridgeSync()}
                      className="ui-btn-primary px-5 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 shadow-lg disabled:opacity-50"
                    >
                      {runRequestBusy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Play className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {runRequestBusy ? "Queuing…" : "Run Full Import"}
                    </button>
                  )}
                </div>

                {!bridgeSyncing && bridgeLive.lastRun && (
                  <div className="ui-panel ui-tint-danger p-3 mb-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                      Post-sign-off retirement reminder
                    </p>
                    <p className="mt-1 text-xs text-app-text-muted">
                      If this migration has already been accepted, do not start another import from
                      this screen. Stop the bridge on the Counterpoint host, remove any startup or
                      scheduled launch, and retire the bridge package or rotate the sync token.
                    </p>
                  </div>
                )}

                {/* Summary stats */}
	                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
	                  <div className="ui-metric-cell ui-tint-info p-3 text-center">
	                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Bridge Rows Last Run</p>
	                    <p className="text-lg font-black text-app-accent tabular-nums">{fmtNum(bridgeLive.totalRecordsLastRun || 0)}</p>
	                  </div>
                  <div className="ui-metric-cell ui-tint-neutral p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Duration</p>
                    <p className="text-lg font-black text-app-text tabular-nums">{fmtDuration(bridgeLive.lastRunDurationMs)}</p>
                  </div>
                  <div className="ui-metric-cell ui-tint-success p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Entities OK</p>
                    <p className="text-lg font-black text-app-success tabular-nums">
                      {Object.values(bridgeLive.entityStats || {}).filter(s => s.lastSync && !s.error).length}
                    </p>
                  </div>
                  <div className="ui-metric-cell ui-tint-danger p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Errors</p>
                    <p className={`text-lg font-black tabular-nums ${Object.values(bridgeLive.entityStats || {}).filter(s => s.error).length ? "text-app-danger" : "text-app-text-muted"}`}>
                      {Object.values(bridgeLive.entityStats || {}).filter(s => s.error).length}
                    </p>
                  </div>
                </div>
                <div className="mt-4 rounded-xl border border-app-border bg-app-bg/60 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Next Steps
                  </p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    After a bridge run, use these sections to prove the data landed and review any issues.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setStatusSection("signoff")}
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      Open Sign-off Checklist
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusSection("details")}
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      Open Run Details
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatusSection("advanced")}
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      Open Advanced / Reset
                    </button>
                  </div>
                </div>
              </div>
              )}

              {(statusSection === "details" || statusSection === "advanced") && migrationPreflight && (
                <>
                  <div className="ui-panel ui-tint-warning p-4 mb-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
                      One-time migration mode
                    </p>
                    <p className="text-xs text-app-text mt-2 leading-relaxed">
                      This bridge is being used for a controlled Counterpoint import, not a permanent
                      live integration. After the import is verified, stop and retire the bridge so
                      Riverside remains the only active system of record.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-6">
                    <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-3">
                      <div>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Preflight scope
                        </h4>
                        <p className="text-xs text-app-text-muted mt-1">
                          Read-only facts from the bridge runtime on this machine.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Import floor
                          </p>
                          <p className="mt-1 font-bold text-app-text">{migrationPreflight.cp_import_since}</p>
                          <p className="mt-2 text-[10px] text-app-text-muted">
                            Expected migration floor: {EXPECTED_COUNTERPOINT_MIGRATION_FLOOR}
                          </p>
                          {migrationPreflight.cp_import_since !== EXPECTED_COUNTERPOINT_MIGRATION_FLOOR ? (
                            <p className="mt-2 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                              This live bridge is scoped differently than the required 2018-01-01 historical floor.
                            </p>
                          ) : null}
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Bridge mode
                          </p>
                          <p className="mt-1 font-bold text-app-text">
                            {migrationPreflight.run_once ? "Single pass / launch" : "Repeat-capable"}
                          </p>
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Landing mode
                          </p>
                          <p className="mt-1 font-bold text-app-text">
                            {migrationPreflight.staging_enabled ? "ROS staging queue" : "Direct live import"}
                          </p>
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Relaxed deps
                          </p>
                          <p className="mt-1 font-bold text-app-text">
                            {migrationPreflight.sync_relaxed_dependencies ? "Enabled" : "Off"}
                          </p>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Enabled entities
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {enabledEntities.length > 0 ? (
                            enabledEntities.map((entity) => (
                              <span key={entity} className="ui-pill bg-app-bg/70 text-[10px]">
                                {formatEntityLabel(entity)}
                              </span>
                            ))
                          ) : (
                            <span className="text-xs text-app-text-muted">No `SYNC_*` entities enabled.</span>
                          )}
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Date-scoped history entities
                        </p>
                        <p className="mt-2 text-xs text-app-text-muted">
                          {migrationPreflight.import_scope.query_placeholders_use_cp_import_since.length > 0
                            ? migrationPreflight.import_scope.query_placeholders_use_cp_import_since
                                .map(formatEntityLabel)
                                .join(", ")
                            : "None exposed through __CP_IMPORT_SINCE__ placeholders."}
                        </p>
                      </div>
                      <p className="text-xs text-app-text-muted">
                        `RUN_ONCE=1` means one bridge pass per launch. Relaunching for validation or
                        cutover rehearsal is allowed; continuing to use the bridge after final accepted
                        cutover is not.
                      </p>
                    </div>

                    <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-3">
                      <div>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Post-import verification
                        </h4>
                        <p className="text-xs text-app-text-muted mt-1">
                          Use these proof points before you declare the migration complete.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Last bridge run
                          </p>
                          <p className="mt-1 font-bold text-app-text">
                            {bridgeLive.lastRun ? formatDate(bridgeLive.lastRun) : "No bridge run yet"}
                          </p>
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Bridge records
                          </p>
                          <p className="mt-1 font-bold text-app-text tabular-nums">
                            {fmtNum(bridgeLive.totalRecordsLastRun || 0)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            ROS entities OK
                          </p>
                          <p className="mt-1 font-bold text-emerald-600 tabular-nums">
                            {fmtNum(successfulServerRuns)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            Open issues
                          </p>
                          <p
                            className={`mt-1 font-bold tabular-nums ${
                              (status?.recent_issues.length ?? 0) > 0 ? "text-red-500" : "text-emerald-600"
                            }`}
                          >
                            {fmtNum(status?.recent_issues.length ?? 0)}
                          </p>
                        </div>
                      </div>
                      <ul className="space-y-2 text-xs text-app-text-muted">
                        <li>
                          Review <span className="font-bold text-app-text">Server sync history</span> for
                          landed entity counts and last successful timestamps.
                        </li>
                        <li>
                          Confirm <span className="font-bold text-app-text">Open sync issues</span> is
                          empty before sign-off.
                        </li>
                        <li>
                          {migrationPreflight.staging_enabled
                            ? `Confirm the inbound queue is empty after Apply. Pending batches: ${fmtNum(pendingN)}.`
                            : "Confirm the bridge wrote directly to live import routes and no staging batches remain pending."}
                        </li>
                        <li>
                          Failed ROS entity rows currently recorded:{" "}
                          <span className="font-bold text-app-text">{fmtNum(failedServerRuns)}</span>.
                        </li>
                      </ul>
                    </div>
                  </div>

                  {showRerunWarning && (
                    <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-4 mb-6">
                      <div className="flex items-start gap-3">
                        <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" aria-hidden />
                        <div className="min-w-0">
                          <p className="text-[10px] font-black uppercase tracking-widest text-red-600">
                            Rerun risk
                          </p>
                          <div className="mt-2 space-y-1 text-xs text-app-text-muted">
                            {rerunWarnings.map((warning, idx) => (
                              <p key={idx}>{warning}</p>
                            ))}
                            {rerunWarnings.length === 0 && nonIdempotentEntities.length > 0 ? (
                              <p>
                                Prior import history exists and these enabled entities are not idempotent:{" "}
                                {nonIdempotentEntities.map(formatEntityLabel).join(", ")}.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Sign-off reconciliation
                        </h4>
                        <p className="text-xs text-app-text-muted mt-1">
                          Latest bridge-reported rows versus the latest landed ROS count for the same entity.
                        </p>
                      </div>
                      <span
                        className={`ui-pill text-[10px] ${
                          signoffBlockers.length === 0
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                            : "bg-red-500/10 text-red-600"
                        }`}
                      >
                        {signoffBlockers.length === 0 ? "Ready for sign-off review" : "Sign-off blockers present"}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 mt-4 text-xs">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Latest bridge run
                        </p>
                        <p className="mt-1 font-bold text-app-text">
                          {bridgeLive.lastRun ? formatDate(bridgeLive.lastRun) : "No run visible"}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Entities in scope
                        </p>
                        <p className="mt-1 font-bold text-app-text tabular-nums">{fmtNum(latestRunEntities.length)}</p>
                      </div>
	                    <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
	                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
	                        Missing ROS landed proof
	                      </p>
                        <p
                          className={`mt-1 font-bold tabular-nums ${
                            entitiesMissingRosProof > 0 ? "text-red-500" : "text-emerald-600"
                          }`}
                        >
                          {fmtNum(entitiesMissingRosProof)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Count mismatches
                        </p>
                        <p
                          className={`mt-1 font-bold tabular-nums ${
                            mismatchedEntityCounts > 0 ? "text-amber-600" : "text-emerald-600"
                          }`}
                        >
                          {fmtNum(mismatchedEntityCounts)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 text-xs xl:grid-cols-2">
                      {signoffBlockers.length > 0 ? (
                        <div className="ui-metric-cell ui-tint-danger p-3">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                            Sign-off blockers
                          </p>
                          <div className="mt-2 space-y-1 text-app-text-muted">
                            {signoffBlockers.map((blocker) => (
                              <p key={blocker}>{blocker}</p>
                            ))}
                          </div>
                        </div>
                      ) : (
	                      <div className="ui-metric-cell ui-tint-success p-3">
	                        <p className="text-[10px] font-black uppercase tracking-widest text-app-success">
	                          No automatic blockers detected
	                        </p>
	                        <p className="mt-2 text-app-text-muted">
	                          The built-in proof surfaces do not show pending staging, unresolved issues,
	                          or missing ROS landed counts for the latest visible entity set. You can treat
                          this as a clean import signal, then confirm business totals in the downstream
                          workspace that uses the imported data.
	                        </p>
	                      </div>
                      )}

                      <div className="ui-metric-cell ui-tint-warning p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-warning">
                          Limits and caveats
                        </p>
                        <div className="mt-2 space-y-1 text-app-text-muted">
                          {signoffWarnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      </div>
                    </div>

	                    <div className="mt-4 overflow-x-auto overscroll-x-contain rounded-xl border border-app-border [-webkit-overflow-scrolling:touch]">
	                      <table className="w-full min-w-[860px] text-left text-xs">
                        <thead>
                          <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
	                            <th className="px-4 py-2">Entity</th>
	                            <th className="px-4 py-2 text-right">Bridge rows sent</th>
	                            <th className="px-4 py-2">Bridge time</th>
	                            <th className="px-4 py-2 text-right">ROS rows landed</th>
	                            <th className="px-4 py-2">Last landed OK</th>
	                            <th className="px-4 py-2">Comparison</th>
	                            <th className="px-4 py-2">Notes</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-app-border">
                          {reconciliationRows.map((row) => (
                            <tr key={row.entity} className="hover:bg-app-surface/20 transition-colors align-top">
                              <td className="px-4 py-2.5 font-bold text-app-text">
                                {formatEntityLabel(row.entity)}
                              </td>
                              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-app-text">
                                {fmtNum(row.bridgeCount)}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                {row.bridgeTime ? formatDate(row.bridgeTime) : "—"}
                              </td>
                              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-app-text">
                                {fmtNum(row.rosCount)}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                {row.rosTime ? formatDate(row.rosTime) : "—"}
                              </td>
                              <td className="px-4 py-2.5">
                                <span className={`text-[10px] font-black uppercase tracking-widest ${row.comparisonTone}`}>
                                  {row.comparisonLabel}
                                </span>
                                {row.rosError ? (
                                  <p className="mt-1 text-[10px] text-red-500 break-all">{row.rosError}</p>
                                ) : null}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                {row.note}
                              </td>
                            </tr>
                          ))}
	                        </tbody>
	                      </table>
	                    </div>

	                    <div className="mt-4">
	                      <p className="mb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
	                        Optional explanation of displayed checks only
	                      </p>
	                      <RosieInsightSummary
	                        surface="counterpoint_status"
	                        title="Counterpoint Sign-off"
	                        mode="explain"
	                        getHeaders={() => backofficeHeaders() as Record<string, string>}
	                        facts={counterpointInsightFacts}
	                      />
	                    </div>
	                  </div>

                  <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Migration complete / retire bridge
                    </h4>
                    <div className="mt-3 grid gap-2 text-xs text-app-text-muted xl:grid-cols-2">
                      {migrationPreflight.retirement_checklist.map((item) => (
                        <div key={item} className="flex items-start gap-2">
                          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden />
                          <p>{item}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {statusSection === "details" && (
                <>
              {/* Entity Breakdown */}
              <div className="mb-6">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                  Entity breakdown
                </h4>
                <div className="rounded-xl border border-app-border overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                        <th className="px-4 py-2 w-6"></th>
                        <th className="px-4 py-2">Entity</th>
	                            <th className="px-4 py-2 text-right">Bridge rows</th>
	                            <th className="px-4 py-2 text-right">Duration</th>
	                            <th className="px-4 py-2">Latest bridge update</th>
	                            <th className="px-4 py-2">Status</th>
                        <th className="px-4 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {ENTITY_DISPLAY.map(({ key, label, icon: Icon }) => {
                        const stat = bridgeLive?.entityStats?.[key];
                        const isRunning = bridgeCurrentEntity === key;
                        const hasError = !!stat?.error;
                        const isDone = !!stat?.lastSync && !hasError;
                        return (
                          <tr
                            key={key}
                            className={`transition-colors ${
                              isRunning ? "bg-orange-500/5" : hasError ? "bg-red-500/5" : "hover:bg-app-surface/20"
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <div className={`w-2 h-2 rounded-full ${
                                isRunning ? "bg-orange-500 animate-pulse" :
                                hasError ? "bg-red-500" :
                                isDone ? "bg-emerald-500" :
                                "bg-app-border"
                              }`} />
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="inline-flex items-center gap-2 font-bold text-app-text">
                                <Icon className="h-3.5 w-3.5 text-app-text-muted" aria-hidden />
                                {label}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums font-semibold">
                              {stat?.recordCount != null ? fmtNum(stat.recordCount) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-app-text-muted">
                              {stat?.durationMs != null ? fmtDuration(stat.durationMs) : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-app-text-muted text-[10px]">
                              {stat?.lastSync ? fmtTimeAgo(stat.lastSync) : "—"}
                            </td>
                            <td className="px-4 py-2.5">
                              {isRunning ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-orange-500">
                                  <Loader2 className="h-3 w-3 animate-spin" /> Running
                                </span>
	                              ) : hasError ? (
	                                <div className="max-w-[220px]">
	                                  <span className="text-[10px] font-bold text-red-500 max-w-[200px] truncate block" title={stat?.error ?? ""}>
	                                    {stat?.error?.slice(0, 60)}
	                                  </span>
	                                  <p className="mt-1 text-[9px] text-app-text-muted">
	                                    Fix the source issue, then rerun this entity only.
	                                  </p>
	                                </div>
	                              ) : isDone ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-500">
                                  <CheckCircle2 className="h-3 w-3" /> OK
                                </span>
                              ) : (
                                <span className="text-[10px] text-app-text-muted">Waiting</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5">
                              <button
                                type="button"
                                disabled={bridgeSyncing || runRequestBusy}
                                onClick={() => void triggerBridgeSync(key)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border bg-app-surface-1/50 text-[9px] font-black uppercase tracking-widest hover:bg-app-surface-2 transition-colors disabled:opacity-50"
                              >
                                {runRequestBusy ? (
                                  <Loader2 className="h-3 w-3 animate-spin text-app-text-muted" />
                                ) : (
                                  <RefreshCw className="h-3 w-3 text-app-text-muted" />
                                )}
                                {runRequestBusy ? "Queuing" : "Import"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Event Feed */}
              {bridgeLive.recentEvents?.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                    Recent bridge events
                  </h4>
                  <div className="rounded-xl border border-app-border bg-app-surface-2/30 overflow-hidden max-h-[300px] overflow-y-auto">
                    <table className="w-full text-left text-[10px]">
                      <tbody className="divide-y divide-app-border">
                        {[...bridgeLive.recentEvents].reverse().map((evt, idx) => {
                          const isErr = evt.type === "error";
                          const isWarn = evt.type === "warning";
                          const isStart = evt.type === "start";
                          const isAbort = evt.type === "abort";
                          return (
                            <tr key={idx} className="hover:bg-app-surface-2/50 transition-colors">
                              <td className="px-3 py-2 w-20 text-app-text-muted font-mono whitespace-nowrap">
                                {new Date(evt.time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                              </td>
                              <td className="px-3 py-2 w-32 font-bold text-app-text truncate">
                                {evt.entity ?? "system"}
                              </td>
                              <td className={`px-3 py-2 ${isErr ? "text-red-500 font-bold" : isWarn ? "text-amber-500 font-bold" : isStart ? "text-emerald-500 font-bold" : isAbort ? "text-orange-500 font-bold" : "text-app-text-muted"}`}>
                                {evt.message}
                                {evt.recordCount != null ? ` (${fmtNum(evt.recordCount)} records)` : ""}
                                {evt.totalRecords != null ? ` (${fmtNum(evt.totalRecords)} records total)` : ""}
                                {evt.durationMs != null ? ` in ${fmtDuration(evt.durationMs)}` : ""}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
                </>
              )}
            </>
          ) : (
            statusSection === "connect" ? (
            <>
              {/* Bridge Offline UI (Manual Retry) */}
              {!bridgeOnline && bridgeFailCount >= 3 && (
                <div className={`rounded-xl border p-6 mb-4 text-center ${
                  serverBridgeActive
                    ? "border-emerald-500/20 bg-emerald-500/5"
                    : "border-red-500/20 bg-red-500/5"
                }`}>
                  {serverBridgeActive ? (
                    <Wifi className="h-10 w-10 text-emerald-500/60 mx-auto mb-3" />
                  ) : (
                    <WifiOff className="h-10 w-10 text-red-500/50 mx-auto mb-3" />
                  )}
                  <p className="font-bold text-app-text">
                    {serverBridgeSyncing
                      ? "Bridge is importing through ROS"
                      : serverBridgeActive
                      ? "Bridge is connected through ROS"
                      : "Bridge controls are not reachable on this workstation"}
                  </p>
                  <p className="text-xs text-app-text-muted mt-1 mb-4">
                    {serverBridgeSyncing
                      ? "The Mac browser cannot reach the direct control port, but ROS is receiving bridge heartbeats and the import is already running."
                      : serverBridgeActive
                      ? "The Mac browser cannot reach the direct control port, but ROS is receiving bridge heartbeats. Run requests are queued through ROS."
                      : "Automatic checking stopped after 3 attempts to reach the bridge control port."}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {serverBridgeSyncing ? (
                      <button
                        type="button"
                        disabled
                        className="px-6 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 rounded-xl border border-app-warning/30 bg-app-warning/10 text-app-warning disabled:opacity-80"
                      >
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Import Running{bridgeCurrentEntity ? `: ${bridgeCurrentEntity.replace(/_/g, " ")}` : ""}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={runRequestBusy}
                        onClick={() => void triggerBridgeSync()}
                        className="ui-btn-primary px-6 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        {runRequestBusy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        {runRequestBusy ? "Queuing…" : "Run Full Import"}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setBridgeFailCount(0);
                      }}
                      className="ui-btn-secondary px-6 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Reconnect to Bridge
                    </button>
                  </div>
                </div>
              )}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-4 flex items-start gap-3">
                <WifiOff className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                <div className="text-xs">
                  <p className="font-bold text-app-text">Bridge controls are not reachable on this workstation</p>
                  <p className="text-app-text-muted mt-1">
                    The panel checks the bridge control port on this workstation and the latest ROS heartbeat host
                    {status?.bridge_hostname ? ` (${status.bridge_hostname})` : ""}.
                    {bridgeUrls.length > 0 ? ` Tried: ${bridgeUrls.join(", ")}.` : ""}
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      type="url"
                      value={bridgeControlUrlDraft}
                      onChange={(event) => setBridgeControlUrlDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveBridgeControlUrl();
                      }}
                      placeholder="http://10.64.70.163:3002"
                      className="min-w-0 flex-1 rounded-lg border border-app-border bg-app-surface-1/70 px-3 py-2 text-xs font-mono text-app-text outline-none focus:border-app-warning/60"
                    />
                    <button
                      type="button"
                      onClick={saveBridgeControlUrl}
                      className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      Save URL
                    </button>
                  </div>
                </div>
              </div>
            </>
            ) : null
          )}

          {/* ── ROS Server Status (existing) ── */}
          {status ? (
            <>
              {/* Staging mode */}
              {statusSection === "advanced" && (
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Inbound staging mode
                  </h4>
                  <span className={`text-xs font-bold ${stagingOn ? "text-emerald-600" : "text-app-text-muted"}`}>
                    {stagingOn ? "ON" : "OFF (direct import)"}
                  </span>
                </div>
                <p className="text-xs text-app-text-muted">
                  When on, the bridge queues batches for review. When off, data writes directly to live tables.
                </p>
                <button
                  type="button"
                  disabled={stagingToggleBusy}
                  onClick={() => {
                    if (stagingOn) setConfirmStagingOff(true);
                    else void setStagingEnabled(true);
                  }}
                  className={
                    stagingOn
                      ? "ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
                      : "ui-btn-primary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
                  }
                >
                  {stagingOn ? "Turn staging off" : "Turn staging on"}
                </button>
              </div>
              )}

              {/* Server bridge meta */}
              {statusSection === "connect" && (
                <div className="mb-4">
                  <IntegrationCredentialsCard
                    baseUrl={baseUrl}
                    integrationKey="counterpoint"
                    title="Counterpoint Bridge Credentials"
                    description="Save the bridge sync token here. The Windows bridge uses this token when posting Counterpoint updates into Riverside."
                    fields={[
                      {
                        key: "sync_token",
                        label: "Bridge sync token",
                        help: "Use the same value in the Counterpoint bridge configuration.",
                      },
                    ]}
                    onSaved={fetchStatus}
                  />
                </div>
              )}

              {/* Server bridge meta */}
              {statusSection === "connect" && (
              <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4 mb-4 flex flex-wrap items-center gap-4">
                {stateIcon(status.windows_sync_state)}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black uppercase tracking-widest">
                    <span className={stateColor(status.windows_sync_state)}>
                      Server: {status.windows_sync_state.toUpperCase()}
                    </span>
                  </p>
                  <p className="text-[10px] text-app-text-muted mt-1 font-mono">
                    {status.bridge_hostname && <span className="mr-3">Host: {status.bridge_hostname}</span>}
                    {status.bridge_version && <span className="mr-3">v{status.bridge_version}</span>}
                    {status.last_seen_at && <span>Last bridge activity: {formatDate(status.last_seen_at)}</span>}
                  </p>
                </div>
                {!status.token_configured && (
                  <span className="ui-pill bg-amber-500/15 text-amber-800 text-[9px]">Bridge token needed</span>
                )}
              </div>
              )}

              {statusSection === "signoff" && (
                <>
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Sign-off Checklist
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Refresh each proof surface after an import pass. Warnings mean review is needed;
                      they are not automatic financial close approval.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void fetchLandingVerification();
                      void fetchTransactionReconciliation();
                      void fetchOpenDocsVerification();
                      void fetchInventoryCatalogVerification();
                    }}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                    Refresh core checks
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-1 lg:grid-cols-5 gap-2">
                  {signoffChecklistRows.map((row) => {
                    const warningCount = row.warningCount;
                    const hasWarnings = warningCount != null && warningCount > 0;
                    const isReady = row.ready && !hasWarnings;
                    return (
                      <div
                        key={row.key}
                        className={`rounded-lg border p-3 ${
                          warningCount == null
                            ? "border-app-border bg-app-bg/60"
                            : hasWarnings
                              ? "border-amber-500/30 bg-amber-500/5"
                              : "border-emerald-500/25 bg-emerald-500/5"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {row.label}
                          </p>
                          {warningCount == null ? (
                            <Clock className="h-3.5 w-3.5 text-app-text-muted" aria-hidden />
                          ) : isReady ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                          ) : (
                            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden />
                          )}
                        </div>
                        <p className="mt-2 text-sm font-black text-app-text tabular-nums">
                          {row.value}
                        </p>
                        <p className="mt-1 text-[10px] text-app-text-muted">
                          {warningCount == null
                            ? "Needs refresh"
                            : `${fmtNum(warningCount)} ${row.warningLabel}`}
                        </p>
                        <button
                          type="button"
                          disabled={row.loading}
                          onClick={() => void row.onRefresh()}
                          className="mt-3 text-[9px] font-black uppercase tracking-widest text-app-accent hover:underline disabled:opacity-50"
                        >
                          {row.actionLabel}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Inventory &amp; Catalog Verification
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Catalog completeness check only. Does not verify physical inventory accuracy.
                    </p>
                    {inventoryCatalogVerification?.generated_at ? (
                      <p className="text-[10px] text-app-text-muted mt-1">
                        Generated {formatDate(inventoryCatalogVerification.generated_at)}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={inventoryCatalogVerificationLoading}
                    onClick={() => void fetchInventoryCatalogVerification()}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${inventoryCatalogVerificationLoading ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    Refresh catalog
                  </button>
                </div>

                {inventoryCatalogVerificationLoading && !inventoryCatalogVerification ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Loading catalog verification…
                  </p>
                ) : null}

                {inventoryCatalogVerification ? (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2 mt-4">
                      {inventoryCatalogCoverageRows.map((row) => (
                        <div
                          key={row.label}
                          className="rounded-lg border border-app-border bg-app-bg/60 p-3"
                        >
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {row.label}
                          </p>
                          <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                            {fmtNum(row.value)}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-2 mt-2">
                      {inventoryCatalogWarningRows.map((row) => {
                        const isWarning = row.value > 0;
                        return (
                          <div
                            key={row.label}
                            className={`rounded-lg border p-3 ${
                              isWarning
                                ? "border-amber-500/30 bg-amber-500/5"
                                : "border-app-border bg-app-bg/60"
                            }`}
                          >
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              {row.label}
                            </p>
                            <p
                              className={`mt-2 text-lg font-black tabular-nums ${
                                isWarning
                                  ? "text-amber-700 dark:text-amber-200"
                                  : "text-app-text"
                              }`}
                            >
                              {fmtNum(row.value)}
                            </p>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs text-app-text-muted">
                      <p>{inventoryCatalogVerification.disclaimer}</p>
                      {inventoryCatalogWarningCount > 0 ? (
                        <p className="mt-1 text-amber-700 dark:text-amber-200">
                          {fmtNum(inventoryCatalogWarningCount)} missing-data warning count(s) need
                          review across product names, SKU, barcode, cost, price, category, or
                          vendor links.
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : !inventoryCatalogVerificationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    No inventory/catalog verification snapshot is available yet.
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Open Docs / Orders Verification
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Open docs represent in-progress orders. This is a structural validation, not
                      financial reconciliation.
                    </p>
                    {openDocsVerification?.generated_at ? (
                      <p className="text-[10px] text-app-text-muted mt-1">
                        Generated {formatDate(openDocsVerification.generated_at)}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={openDocsVerificationLoading}
                    onClick={() => void fetchOpenDocsVerification()}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${openDocsVerificationLoading ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    Refresh open docs
                  </button>
                </div>

                {openDocsVerificationLoading && !openDocsVerification ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Loading open-doc verification…
                  </p>
                ) : null}

                {openDocsVerification ? (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2 mt-4">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Open docs
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(openDocsVerification.imported_open_doc_transactions)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Lines
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(openDocsVerification.imported_open_doc_lines)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Payments
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(openDocsVerification.imported_open_doc_payments)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Customer linked
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(openDocsVerification.open_docs_with_customer_linked)}
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-3 ${
                          openDocsVerification.open_docs_missing_customer > 0
                            ? "border-amber-500/30 bg-amber-500/5"
                            : "border-app-border bg-app-bg/60"
                        }`}
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Missing customer
                        </p>
                        <p
                          className={`mt-2 text-lg font-black tabular-nums ${
                            openDocsVerification.open_docs_missing_customer > 0
                              ? "text-amber-700 dark:text-amber-200"
                              : "text-app-text"
                          }`}
                        >
                          {fmtNum(openDocsVerification.open_docs_missing_customer)}
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-3 ${
                          openDocsVerification.open_docs_with_zero_lines > 0
                            ? "border-amber-500/30 bg-amber-500/5"
                            : "border-app-border bg-app-bg/60"
                        }`}
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Zero lines
                        </p>
                        <p
                          className={`mt-2 text-lg font-black tabular-nums ${
                            openDocsVerification.open_docs_with_zero_lines > 0
                              ? "text-amber-700 dark:text-amber-200"
                              : "text-app-text"
                          }`}
                        >
                          {fmtNum(openDocsVerification.open_docs_with_zero_lines)}
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-3 ${
                          openDocsVerification.open_docs_with_zero_payments > 0
                            ? "border-amber-500/30 bg-amber-500/5"
                            : "border-app-border bg-app-bg/60"
                        }`}
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Zero payments
                        </p>
                        <p
                          className={`mt-2 text-lg font-black tabular-nums ${
                            openDocsVerification.open_docs_with_zero_payments > 0
                              ? "text-amber-700 dark:text-amber-200"
                              : "text-app-text"
                          }`}
                        >
                          {fmtNum(openDocsVerification.open_docs_with_zero_payments)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Staff attributed
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(openDocsVerification.distinct_staff_attribution_count)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs text-app-text-muted">
                      <p>{openDocsVerification.disclaimer}</p>
                      {openDocsWarningCount > 0 ? (
                        <p className="mt-1 text-amber-700 dark:text-amber-200">
                          {fmtNum(openDocsWarningCount)} structural warning count(s) need review:
                          missing customer links, zero-line docs, or zero-payment docs.
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : !openDocsVerificationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    No open-doc verification snapshot is available yet.
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Transaction Reconciliation (Preview)
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Sanity check only for imported Counterpoint ticket transactions. This is not a
                      financial close, and imported tax is non-authoritative.
                    </p>
                    {transactionReconciliation?.generated_at ? (
                      <p className="text-[10px] text-app-text-muted mt-1">
                        Generated {formatDate(transactionReconciliation.generated_at)}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={transactionReconciliationLoading}
                    onClick={() => void fetchTransactionReconciliation()}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${transactionReconciliationLoading ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    Refresh preview
                  </button>
                </div>

                {transactionReconciliationLoading && !transactionReconciliation ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Loading transaction sanity check…
                  </p>
                ) : null}

                {transactionReconciliationTotals ? (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2 mt-4">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Imported tickets
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(transactionReconciliationTotals.imported_ticket_transactions)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Lines
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(transactionReconciliationTotals.transaction_lines)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Payments
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtNum(transactionReconciliationTotals.payments)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Ticket totals
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtMoney(transactionReconciliationTotals.transaction_total_sum)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Payment totals
                        </p>
                        <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                          {fmtMoney(transactionReconciliationTotals.payment_amount_sum)}
                        </p>
                      </div>
                      <div
                        className={`rounded-lg border p-3 ${
                          hasTransactionTotalMismatch
                            ? "border-amber-500/30 bg-amber-500/5"
                            : "border-app-border bg-app-bg/60"
                        }`}
                      >
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Difference
                        </p>
                        <p
                          className={`mt-2 text-lg font-black tabular-nums ${
                            hasTransactionTotalMismatch ? "text-amber-700 dark:text-amber-200" : "text-app-text"
                          }`}
                        >
                          {fmtMoney(transactionReconciliationTotals.difference)}
                        </p>
                        {hasTransactionTotalMismatch ? (
                          <p className="mt-1 text-[10px] text-amber-700 dark:text-amber-200">
                            Totals differ; review as a sanity-check warning.
                          </p>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs text-app-text-muted">
                      <p>{transactionReconciliation?.disclaimer}</p>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
                      <div className="rounded-xl border border-app-border overflow-x-auto">
                        <table className="w-full min-w-[620px] text-left text-xs">
                          <thead>
                            <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                              <th className="px-4 py-2">Business day</th>
                              <th className="px-4 py-2 text-right">Tickets</th>
                              <th className="px-4 py-2 text-right">Lines</th>
                              <th className="px-4 py-2 text-right">Payments</th>
                              <th className="px-4 py-2 text-right">Ticket total</th>
                              <th className="px-4 py-2 text-right">Payment total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-app-border">
                            {transactionReconciliationByDate.map((row) => (
                              <tr key={row.business_day} className="hover:bg-app-surface/20 transition-colors">
                                <td className="px-4 py-2.5 font-bold text-app-text">{row.business_day}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(row.imported_ticket_transactions)}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(row.transaction_lines)}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(row.payments)}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(row.transaction_total_sum)}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(row.payment_amount_sum)}</td>
                              </tr>
                            ))}
                            {transactionReconciliationByDate.length === 0 ? (
                              <tr>
                                <td className="px-4 py-3 text-app-text-muted" colSpan={6}>
                                  No imported ticket days found.
                                </td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>

                      <div className="rounded-xl border border-app-border overflow-x-auto">
                        <table className="w-full min-w-[420px] text-left text-xs">
                          <thead>
                            <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                              <th className="px-4 py-2">Payment type</th>
                              <th className="px-4 py-2 text-right">Payments</th>
                              <th className="px-4 py-2 text-right">Payment total</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-app-border">
                            {transactionReconciliationByPaymentType.map((row) => (
                              <tr key={row.payment_type} className="hover:bg-app-surface/20 transition-colors">
                                <td className="px-4 py-2.5 font-bold text-app-text">{row.payment_type}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtNum(row.payments)}</td>
                                <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(row.payment_amount_sum)}</td>
                              </tr>
                            ))}
                            {transactionReconciliationByPaymentType.length === 0 ? (
                              <tr>
                                <td className="px-4 py-3 text-app-text-muted" colSpan={3}>
                                  No imported ticket payments found.
                                </td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                ) : !transactionReconciliationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    No transaction sanity-check snapshot is available yet.
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Landing Verification
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Read-only ROS table counts for repeatable pre-go-live import review. These counts
                      are import proof, not full financial reconciliation.
                    </p>
                    {landingVerification?.generated_at ? (
                      <p className="text-[10px] text-app-text-muted mt-1">
                        Generated {formatDate(landingVerification.generated_at)}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={landingVerificationLoading}
                    onClick={() => void fetchLandingVerification()}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${landingVerificationLoading ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    Refresh counts
                  </button>
                </div>

                {landingVerificationLoading && !landingVerification ? (
                  <p className="mt-4 text-xs text-app-text-muted">Loading landed counts…</p>
                ) : null}

                {snapshotReconciliationRows.length > 0 ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
                    {snapshotReconciliationRows.map((row) => {
                      const isPass = row.passed;
                      const isMissing = row.status === "missing_source";
                      const hasChecksum = Boolean(row.source_checksum || row.landed_checksum);
                      return (
                        <div
                          key={row.key}
                          className={`rounded-lg border p-3 ${
                            isPass
                              ? "border-emerald-500/25 bg-emerald-500/5"
                              : "border-red-500/25 bg-red-500/5"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                {row.label}
                              </p>
                              <p className="mt-1 text-xs text-app-text-muted">{row.note}</p>
                            </div>
                            <span
                              className={`ui-pill text-[8px] ${
                                isPass
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                                  : "bg-red-500/10 text-red-600"
                              }`}
                            >
                              {isPass ? "Pass" : isMissing ? "No source proof" : "Fail"}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-3 text-[10px]">
                            <div className="rounded-md bg-app-bg/60 border border-app-border p-2">
                              <p className="font-black uppercase tracking-widest text-app-text-muted">
                                Source
                              </p>
                              <p className="mt-1 font-bold text-app-text tabular-nums">
                                {row.source_count == null ? "—" : fmtNum(row.source_count)}
                              </p>
                              <p className="text-app-text-muted tabular-nums">
                                {hasChecksum
                                  ? row.source_checksum
                                    ? `Checksum ${row.source_checksum.slice(0, 12)}`
                                    : "Checksum —"
                                  : row.source_sum ?? "—"}
                              </p>
                            </div>
                            <div className="rounded-md bg-app-bg/60 border border-app-border p-2">
                              <p className="font-black uppercase tracking-widest text-app-text-muted">
                                ROS Landed
                              </p>
                              <p className="mt-1 font-bold text-app-text tabular-nums">
                                {fmtNum(row.landed_count)}
                              </p>
                              <p className="text-app-text-muted tabular-nums">
                                {hasChecksum
                                  ? row.landed_checksum
                                    ? `Checksum ${row.landed_checksum.slice(0, 12)}`
                                    : "Checksum —"
                                  : row.landed_sum}
                              </p>
                            </div>
                          </div>
                          {row.source_updated_at ? (
                            <p className="mt-2 text-[10px] text-app-text-muted">
                              Source proof received {formatDate(row.source_updated_at)}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {fidelityDiagnostics.length > 0 ? (
                  <div className="mt-4 space-y-3">
                    {fidelityDiagnostics.map((report) => {
                      const passed = report.mismatch_count === 0;
                      const shown = report.mismatches.slice(0, report.result_limit);
                      return (
                        <div
                          key={report.group}
                          className={`rounded-lg border p-3 ${
                            passed
                              ? "border-emerald-500/25 bg-emerald-500/5"
                              : "border-red-500/25 bg-red-500/5"
                          }`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                {report.group.replaceAll("_", " ")}
                              </p>
                              <p className="mt-1 text-xs text-app-text-muted">
                                Compared {fmtNum(report.compared_rows)} of{" "}
                                {fmtNum(report.total_source_rows)} live source row(s).{" "}
                                {fmtNum(report.mismatch_count)} mismatch(es) found.
                              </p>
                            </div>
                            <span
                              className={`ui-pill text-[8px] ${
                                passed
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                                  : "bg-red-500/10 text-red-600"
                              }`}
                            >
                              {passed ? "Pass" : "Fail"}
                            </span>
                          </div>
                          {shown.length > 0 ? (
                            <div className="mt-3 overflow-x-auto">
                              <table className="min-w-full text-left text-[10px]">
                                <thead className="text-app-text-muted">
                                  <tr>
                                    <th className="px-2 py-1 font-black uppercase tracking-widest">Key</th>
                                    <th className="px-2 py-1 font-black uppercase tracking-widest">SKU</th>
                                    <th className="px-2 py-1 font-black uppercase tracking-widest">Field</th>
                                    <th className="px-2 py-1 font-black uppercase tracking-widest">Counterpoint</th>
                                    <th className="px-2 py-1 font-black uppercase tracking-widest">ROS</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {shown.map((row, idx) => (
                                    <tr key={`${report.group}-${idx}`} className="border-t border-app-border">
                                      <td className="px-2 py-1 tabular-nums">{row.item_key ?? "—"}</td>
                                      <td className="px-2 py-1 tabular-nums">{row.sku ?? "—"}</td>
                                      <td className="px-2 py-1">{row.field}</td>
                                      <td className="px-2 py-1 tabular-nums">{row.counterpoint_value || "—"}</td>
                                      <td className="px-2 py-1 tabular-nums">{row.ros_value || "—"}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {cutoverVisibilityRows.length > 0 ? (
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-4">
                    {cutoverVisibilityRows.map((row) => {
                      const isPass = row.passed;
                      return (
                        <div
                          key={row.key}
                          className={`rounded-lg border p-3 ${
                            isPass
                              ? "border-emerald-500/25 bg-emerald-500/5"
                              : "border-red-500/25 bg-red-500/5"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                {row.label}
                              </p>
                              <p className="mt-1 text-xs text-app-text-muted">{row.note}</p>
                            </div>
                            <span
                              className={`ui-pill text-[8px] ${
                                isPass
                                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"
                                  : "bg-red-500/10 text-red-600"
                              }`}
                            >
                              {isPass ? "Clear" : "Review"}
                            </span>
                          </div>
                          <p className="mt-3 text-lg font-black text-app-text tabular-nums">
                            {fmtNum(row.count)}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {landingVerificationRows.length > 0 ? (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 mt-4">
                      {landingVerificationRows.map((row) => {
                        const isApproximate = row.confidence !== "direct";
                        return (
                          <div
                            key={row.key}
                            className={`rounded-lg border p-3 ${
                              isApproximate
                                ? "border-amber-500/25 bg-amber-500/5"
                                : "border-app-border bg-app-bg/60"
                            }`}
                            title={row.note}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted leading-snug">
                                {row.label}
                              </p>
                              {isApproximate ? (
                                <span className="ui-pill bg-amber-500/15 text-[8px] text-amber-800 dark:text-amber-100">
                                  Approx
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                              {fmtNum(row.count)}
                            </p>
                            <p className="mt-1 text-[10px] text-app-text-muted leading-snug">
                              {row.note}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-3 text-xs text-app-text-muted">
                      <p>{landingVerification?.disclaimer}</p>
                      {landingApproximateCount > 0 ? (
                        <p className="mt-1">
                          {fmtNum(landingApproximateCount)} count(s) are marked approximate because
                          the table lacks dedicated Counterpoint provenance or the count is not a tender
                          reconciliation.
                        </p>
                      ) : null}
                    </div>
                  </>
                ) : !landingVerificationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    No landed count summary is available yet.
                  </p>
                ) : null}
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Legacy inventory file verification
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Legacy read-only comparison against a checked-in inventory file. This is not
                      the live Counterpoint cutover proof.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={inventoryVerificationLoading}
                    onClick={() => void fetchInventoryVerification()}
                    className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${inventoryVerificationLoading ? "animate-spin" : ""}`}
                      aria-hidden
                    />
                    {inventoryVerification ? "Refresh verification" : "Run verification"}
                  </button>
                </div>

                {!inventoryVerification && inventoryVerificationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Building legacy verification report…
                  </p>
                ) : null}

                {inventoryVerificationSummary ? (
                  <>
                    <div className="grid grid-cols-2 xl:grid-cols-5 gap-2 mt-4 text-xs">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Source SKUs
                        </p>
                        <p className="mt-1 font-bold text-app-text tabular-nums">
                          {fmtNum(inventoryVerificationSummary.total_csv_skus)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Matched
                        </p>
                        <p className="mt-1 font-bold text-emerald-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.matched_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Exact
                        </p>
                        <p className="mt-1 font-bold text-app-text tabular-nums">
                          {fmtNum(inventoryVerificationSummary.exact_match_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Mismatched
                        </p>
                        <p className="mt-1 font-bold text-amber-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.mismatched_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Missing in ROS
                        </p>
                        <p className="mt-1 font-bold text-red-500 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.missing_in_ros_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Extra in ROS
                        </p>
                        <p className="mt-1 font-bold text-red-500 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.extra_in_ros_count)}
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 xl:grid-cols-4 gap-2 mt-2 text-xs">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Out-of-scope exclusions
                        </p>
                        <p className="mt-1 font-bold text-sky-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.expected_out_of_scope_exclusion_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Comparison artifacts
                        </p>
                        <p className="mt-1 font-bold text-amber-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.comparison_artifact_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Source file issues
                        </p>
                        <p className="mt-1 font-bold text-amber-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.csv_source_issue_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Supplier field issues
                        </p>
                        <p className="mt-1 font-bold text-amber-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.supplier_field_suspect_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Variant group splits
                        </p>
                        <p className="mt-1 font-bold text-red-500 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.variant_group_split_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Vendor mismatches
                        </p>
                        <p className="mt-1 font-bold text-amber-600 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.vendor_mismatch_count)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Missing vendor links
                        </p>
                        <p className="mt-1 font-bold text-red-500 tabular-nums">
                          {fmtNum(inventoryVerificationSummary.missing_vendor_item_link_count)}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Mismatch classification counts
                      </p>
                      <div className="mt-2 grid grid-cols-2 xl:grid-cols-3 gap-2 text-xs text-app-text-muted">
                        <p>Name mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.name_mismatch_count)}</span></p>
                        <p>Identifier-like product name: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.identifier_like_product_name_count)}</span></p>
                        <p>Category mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.category_mismatch_count)}</span></p>
                        <p>Variant mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.variant_mismatch_count)}</span></p>
                        <p>ROS variant label missing: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.ros_variant_label_missing_count)}</span></p>
                        <p>Price mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.price_mismatch_count)}</span></p>
                        <p>Cost mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.cost_mismatch_count)}</span></p>
                        <p>Inventory mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.inventory_mismatch_count)}</span></p>
                        <p>Vendor mismatch: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.vendor_mismatch_count)}</span></p>
                        <p>Missing vendor: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.missing_vendor_count)}</span></p>
                        <p>Missing vendor item link: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.missing_vendor_item_link_count)}</span></p>
                        <p>Supplier code not a vendor key: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.supplier_code_non_vendor_key_count)}</span></p>
                      </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        ROS-only extra categories
                      </p>
                      <div className="mt-2 grid grid-cols-1 xl:grid-cols-3 gap-2 text-xs text-app-text-muted">
                        <p>Parent-scope artifacts: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.extra_parent_scope_artifact_count)}</span></p>
                        <p>Key-present scope gaps: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.extra_key_present_scope_gap_count)}</span></p>
                        <p>Unexplained extras: <span className="font-bold text-app-text tabular-nums">{fmtNum(inventoryVerificationSummary.extra_unexplained_count)}</span></p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
                      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-red-600">
                          Critical inventory integrity issues
                        </p>
                        <div className="mt-2 space-y-1 text-xs text-app-text-muted">
                          {inventoryVerificationIssues.length > 0 ? (
                            inventoryVerificationIssues.map((issue) => (
                              <p key={issue}>{issue}</p>
                            ))
                          ) : (
                            <p>No critical issues were detected in the current source-file comparison.</p>
                          )}
                        </div>
                      </div>
                      <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">
                          Report limits
                        </p>
                        <div className="mt-2 space-y-1 text-xs text-app-text-muted">
                          <p>Source file: {inventoryVerificationSummary.csv_path}</p>
                          <p>
                            Detailed mismatch rows shown:{" "}
                            <span className="font-bold text-app-text tabular-nums">
                              {fmtNum(inventoryVerificationMismatchRows.length)}
                            </span>
                            {inventoryVerificationSummary.detailed_rows_truncated > 0
                              ? ` (${fmtNum(
                                  inventoryVerificationSummary.detailed_rows_truncated,
                                )} more truncated at the server limit of ${fmtNum(
                                  inventoryVerificationSummary.detailed_row_limit,
                                )}).`
                              : "."}
                          </p>
                          <p>
                            Extra ROS rows shown:{" "}
                            <span className="font-bold text-app-text tabular-nums">
                              {fmtNum(inventoryVerificationExtraRows.length)}
                            </span>
                            {inventoryVerificationSummary.extra_rows_truncated > 0
                              ? ` (${fmtNum(
                                  inventoryVerificationSummary.extra_rows_truncated,
                                )} more truncated).`
                              : "."}
                          </p>
                          <p>
                            This is a read-only verification layer. It does not correct imported ROS
                            data.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-app-border overflow-x-auto">
                      <table className="w-full min-w-[1320px] text-left text-xs">
                        <thead>
                          <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                            <th className="px-4 py-2">SKU</th>
                            <th className="px-4 py-2">Status</th>
                            <th className="px-4 py-2">Mismatch type(s)</th>
                            <th className="px-4 py-2">Source</th>
                            <th className="px-4 py-2">ROS</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-app-border">
                          {inventoryVerificationMismatchRows.map((row) => (
                            <tr key={`${row.status}:${row.sku}:${row.match_basis ?? "none"}`} className="align-top hover:bg-app-surface/20 transition-colors">
                              <td className="px-4 py-2.5 font-bold text-app-text">
                                {row.sku}
                                {row.match_basis ? (
                                  <p className="mt-1 text-[10px] text-app-text-muted">
                                    Match basis: {row.match_basis}
                                  </p>
                                ) : null}
                              </td>
                              <td className="px-4 py-2.5">
                                <span
                                  className={`text-[10px] font-black uppercase tracking-widest ${
                                    row.status === "mismatch"
                                      ? "text-amber-600"
                                      : row.status === "comparison_artifact" ||
                                          row.status === "csv_source_issue"
                                        ? "text-sky-600"
                                        : "text-red-500"
                                  }`}
                                >
                                  {formatVerificationStatus(row.status)}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                {row.mismatch_types.map(formatMismatchType).join(", ")}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                <p>Name: {row.csv.name ?? "—"}</p>
                                <p>Category: {row.csv.category ?? "—"}</p>
                                <p>Variant: {row.csv.variant_label ?? "—"}</p>
                                <p>Retail: {row.csv.retail_price ?? "—"}</p>
                                <p>Cost: {row.csv.supply_price ?? "—"}</p>
                                <p>Qty: {row.csv.inventory_quantity ?? "—"}</p>
                                <p>Supplier: {row.csv.supplier_name ?? "—"} / {row.csv.supplier_code ?? "—"}</p>
                                <p>Item key: {row.csv.item_key ?? "—"}</p>
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                {row.ros ? (
                                  <>
                                    <p>Name: {row.ros.name ?? "—"}</p>
                                    <p>Category: {row.ros.category ?? "—"}</p>
                                    <p>Variant: {row.ros.variant_label ?? "—"}</p>
                                    <p>Retail: {row.ros.retail_price ?? "—"}</p>
                                    <p>Cost: {row.ros.supply_price ?? "—"}</p>
                                    <p>Qty: {row.ros.inventory_quantity ?? "—"}</p>
                                    <p>Supplier: {row.ros.supplier_name ?? "—"} / {row.ros.supplier_code ?? "—"}</p>
                                    <p>Item key: {row.ros.item_key ?? "—"}</p>
                                    <p>Handle: {row.ros.catalog_handle ?? "—"}</p>
                                  </>
                                ) : (
                                  <p>Missing in ROS.</p>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {inventoryVerificationExtraRows.length > 0 ? (
                      <div className="mt-4 rounded-xl border border-app-border overflow-x-auto">
                        <table className="w-full min-w-[920px] text-left text-xs">
                          <thead>
                            <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                              <th className="px-4 py-2">ROS-only SKU</th>
                              <th className="px-4 py-2">Status</th>
                              <th className="px-4 py-2">ROS values</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-app-border">
                            {inventoryVerificationExtraRows.map((row) => (
                              <tr key={`extra:${row.sku}`} className="align-top hover:bg-app-surface/20 transition-colors">
                                <td className="px-4 py-2.5 font-bold text-app-text">{row.sku}</td>
                                <td className="px-4 py-2.5">
                                  <span
                                    className={`text-[10px] font-black uppercase tracking-widest ${
                                      row.status === "extra_parent_scope_artifact" ||
                                      row.status === "extra_key_present_scope_gap"
                                        ? "text-sky-600"
                                        : "text-red-500"
                                    }`}
                                  >
                                    {formatVerificationStatus(row.status)}
                                  </span>
                                </td>
                                <td className="px-4 py-2.5 text-[10px] text-app-text-muted">
                                  <p>Name: {row.ros?.name ?? "—"}</p>
                                  <p>Category: {row.ros?.category ?? "—"}</p>
                                  <p>Variant: {row.ros?.variant_label ?? "—"}</p>
                                  <p>Retail: {row.ros?.retail_price ?? "—"}</p>
                                  <p>Cost: {row.ros?.supply_price ?? "—"}</p>
                                  <p>Qty: {row.ros?.inventory_quantity ?? "—"}</p>
                                  <p>Supplier: {row.ros?.supplier_name ?? "—"} / {row.ros?.supplier_code ?? "—"}</p>
                                  <p>Item key: {row.ros?.item_key ?? "—"}</p>
                                  <p>Handle: {row.ros?.catalog_handle ?? "—"}</p>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </>
                ) : !inventoryVerificationLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Run this legacy verification only when using a checked-in inventory file. Live
                    cutover proof is shown in Landing Verification and Inventory & Catalog
                    Verification.
                  </p>
                ) : null}
              </div>
                </>
              )}

              {statusSection === "advanced" && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 mb-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-red-600">
                      Fresh baseline reset
                    </h4>
                    <p className="text-xs text-app-text-muted mt-1 max-w-3xl">
                      Pre-go-live only. Use this when you need to clear imported Counterpoint business
                      data from ROS and rerun migration from a fresh baseline while keeping the
                      bootstrap/runtime shell intact.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={resetBusy || resetPreviewLoading || !resetPreview}
                    onClick={() => setResetPromptOpen(true)}
                    className="px-4 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/15 transition-colors disabled:opacity-50"
                  >
                    Reset baseline
                  </button>
                </div>

                {resetPreviewLoading ? (
                  <p className="mt-4 text-xs text-app-text-muted">Loading reset preview…</p>
                ) : resetPreview ? (
                  <>
                    <div className="mt-4 rounded-lg border border-red-500/20 bg-app-bg/60 p-3">
                      <p className="text-[10px] font-black uppercase tracking-widest text-red-600">
                        Destructive scope
                      </p>
                      <p className="mt-2 text-xs text-app-text-muted">
                        {resetPreview.pre_go_live_only_warning}
                      </p>
                      <p className="mt-2 text-xs text-app-text-muted">
                        Total reset-preview rows across the tracked scope:{" "}
                        <span className="font-bold text-app-text tabular-nums">
                          {fmtNum(resetTotalRows)}
                        </span>
                      </p>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Preserve always
                        </p>
                        <div className="mt-2 space-y-2 text-xs text-app-text-muted">
                          {resetPreview.preserve_always.map((item) => (
                            <div key={item} className="flex items-start gap-2">
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" aria-hidden />
                              <p>{item}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Excluded for now
                        </p>
                        <div className="mt-2 space-y-2 text-xs text-app-text-muted">
                          {resetPreview.excluded_for_now.map((item) => (
                            <div key={item} className="flex items-start gap-2">
                              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                              <p>{item}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 rounded-xl border border-app-border overflow-x-auto">
                      <table className="w-full min-w-[720px] text-left text-xs">
                        <thead>
                          <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                            <th className="px-4 py-2">Scope</th>
                            <th className="px-4 py-2 text-right">Rows</th>
                            <th className="px-4 py-2">Reset effect</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-app-border">
                          {resetScopeRows.map((row) => (
                            <tr key={row.key} className="align-top hover:bg-app-surface/20 transition-colors">
                              <td className="px-4 py-2.5 font-bold text-app-text">{row.label}</td>
                              <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-app-text">
                                {fmtNum(row.count)}
                              </td>
                              <td className="px-4 py-2.5 text-[10px] text-app-text-muted">{row.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-app-text-muted space-y-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-300">
                        Reset ordering notes
                      </p>
                      {resetPreview.careful_ordering.map((item) => (
                        <p key={item}>{item}</p>
                      ))}
                      <p>{resetPreview.bridge_local_state_note}</p>
                    </div>
                  </>
                ) : (
                  <p className="mt-4 text-xs text-app-text-muted">
                    Reset preview is unavailable right now.
                  </p>
                )}
              </div>
              )}

              {/* Server entity history */}
              {statusSection === "details" && (
                <>
              {status.entity_runs.length > 0 && (
                <div className="mb-6">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                    Server sync history
                  </h4>
                  <div className="rounded-xl border border-app-border overflow-x-auto">
                    <table className="w-full text-left text-xs min-w-[640px]">
                      <thead>
                        <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                          <th className="px-4 py-2">Entity</th>
                          <th className="px-4 py-2">Last OK</th>
                          <th className="px-4 py-2">Records</th>
                          <th className="px-4 py-2">Last error</th>
                          <th className="px-4 py-2">Cursor</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-app-border">
                        {status.entity_runs.map((run) => (
                          <tr key={run.entity} className="hover:bg-app-surface/20 transition-colors">
                            <td className="px-4 py-2.5 font-bold text-app-text">{run.entity}</td>
                            <td className="px-4 py-2.5">
                              <span className="inline-flex items-center gap-1.5">
                                {run.last_ok_at ? (
                                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                                ) : (
                                  <Clock className="h-3.5 w-3.5 text-app-text-muted" />
                                )}
                                {formatDate(run.last_ok_at)}
                              </span>
                            </td>
                            <td className="px-4 py-2.5">
                               {run.records_processed != null ? (
                                 <span className="font-bold text-app-text tabular-nums">{fmtNum(run.records_processed)}</span>
                               ) : (
                                 <span className="text-app-text-muted">—</span>
                               )}
                            </td>
                            <td className="px-4 py-2.5">
                              {run.last_error ? (
                                <span className="text-red-600 font-mono text-[10px] break-all">{run.last_error}</span>
                              ) : (
                                <span className="text-app-text-muted">—</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-[10px] text-app-text-muted">
                              {run.cursor_value ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Issues */}
              {status.recent_issues.length > 0 && (
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                    Open sync issues ({status.recent_issues.length})
                  </h4>
                  <div className="space-y-2">
                    {status.recent_issues.map((issue) => (
                      <div
                        key={issue.id}
                        className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface-2/40 p-3"
                      >
                        {issue.severity === "error" ? (
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
                        ) : (
                          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                        )}
                        <div className="min-w-0 flex-1 text-xs">
                          <span className="font-bold text-app-text">{issue.entity}</span>
                          {issue.external_key && (
                            <span className="ml-2 font-mono text-[10px] text-app-text-muted">{issue.external_key}</span>
                          )}
	                          <p className="text-app-text-muted mt-0.5">{issue.message}</p>
	                          <p className="text-[10px] text-app-text-muted mt-0.5">{formatDate(issue.created_at)}</p>
                              <p className="text-[10px] text-app-text-muted mt-1">
                                Review the matching entity row and recent bridge events before dismissing or rerunning.
                              </p>
	                        </div>
                        <button
                          type="button"
                          onClick={() => void resolveIssue(issue.id)}
                          className="text-[10px] font-bold uppercase tracking-wider text-app-accent hover:underline shrink-0"
                        >
                          Dismiss
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
                </>
              )}
            </>
          ) : loading ? (
            <p className="text-sm font-medium text-app-text-muted">Loading…</p>
          ) : (
	            <p className="text-sm font-bold text-app-text">
	              Could not load Counterpoint sync status. Verify your permissions, confirm the bridge PC is reachable, and refresh again.
	            </p>
          )}
        </>
      )}

      {tab === "import-console" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 xl:grid-cols-4 gap-3">
            <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Sync Health
              </p>
              <div className="mt-3 flex items-center gap-3">
                {status ? stateIcon(status.windows_sync_state) : <Clock className="h-5 w-5 text-app-text-muted" />}
                <div>
                  <p className={`text-sm font-black uppercase tracking-widest ${status ? stateColor(status.windows_sync_state) : "text-app-text-muted"}`}>
                    {status?.windows_sync_state ?? "Unknown"}
                  </p>
                  <p className="text-[10px] text-app-text-muted">
                    {status?.last_seen_at ? formatDate(status.last_seen_at) : "No recent bridge heartbeat"}
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Needs Review
              </p>
              <p className="mt-2 text-2xl font-black text-app-warning tabular-nums">
                {quarantineLoading ? "…" : fmtNum(quarantineTotal)}
              </p>
              <p className="mt-1 text-[10px] text-app-text-muted">
                Rows skipped from live writes and saved for review.
              </p>
            </div>
            <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Blocked Rows
              </p>
              <p className="mt-2 text-2xl font-black text-app-danger tabular-nums">
                {quarantineLoading ? "…" : fmtNum(quarantineSummary?.blocking_records ?? 0)}
              </p>
              <p className="mt-1 text-[10px] text-app-text-muted">
                Duplicate or conflicting identity rows did not write to inventory.
              </p>
            </div>
            <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Latest Review Row
              </p>
              <p className="mt-2 text-sm font-black text-app-text">
                {quarantineSummary?.latest_created_at
                  ? formatDate(quarantineSummary.latest_created_at)
                  : "None recorded"}
              </p>
              <p className="mt-1 text-[10px] text-app-text-muted">
                Source: <code>counterpoint_ingest_quarantine</code>
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Registry Health
                </h4>
                <p className="mt-1 text-xs text-app-text-muted">
                  Read-only structure check for the landed Counterpoint registry.
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${registryStatusTone}`}
              >
                {registryHealth ? registryStatusLabel : "Unknown"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4 2xl:grid-cols-8">
              {registryHealthRows.map((row) => (
                <div key={row.label} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    {row.label}
                  </p>
                  <p className={`mt-2 text-lg font-black tabular-nums ${row.tone}`}>
                    {quarantineLoading ? "…" : fmtNum(row.value)}
                  </p>
                </div>
              ))}
              <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Latest ingest
                </p>
                <p className="mt-2 text-xs font-black text-app-text">
                  {registryHealth?.latest_ingest_at
                    ? formatDate(registryHealth.latest_ingest_at)
                    : "None recorded"}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Cleanup Readiness
                </h4>
                <p className="mt-1 text-xs text-app-text-muted">
                  Counterpoint Sync prepares aliases and Lightspeed reference data. Inventory and Product Hub consume the prepared data.
                </p>
              </div>
              <span
                className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                  cleanupReady
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : "border-amber-200 bg-amber-50 text-amber-700"
                }`}
              >
                {cleanupReady ? "Ready" : "Not ready"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  B-SKU aliases
                </p>
                <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                  {quarantineLoading ? "…" : fmtNum(aliasHealth?.active_aliases ?? 0)}
                </p>
                <p className={`mt-1 text-[10px] ${aliasReady ? "text-emerald-600" : "text-app-warning"}`}>
                  {aliasReady ? "Active aliases are available." : "Run the alias rebuild command before cleanup review."}
                </p>
              </div>
              <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Lightspeed reference
                </p>
                <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                  {quarantineLoading ? "…" : fmtNum(lightspeedReferenceHealth?.b_sku_count ?? 0)}
                </p>
                <p className={`mt-1 text-[10px] ${lightspeedReady ? "text-emerald-600" : "text-app-warning"}`}>
                  {lightspeedReady
                    ? `Active batch: ${lightspeedReferenceHealth?.active_batch?.source_file_name ?? "loaded"}`
                    : "Import the Lightspeed reference CSV before cleanup review."}
                </p>
              </div>
              <div className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Reference checks
                </p>
                <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                  {fmtNum(
                    (aliasHealth?.duplicate_active_alias_conflicts ?? 0) +
                      (lightspeedReferenceHealth?.duplicate_b_sku_groups ?? 0),
                  )}
                </p>
                <p className="mt-1 text-[10px] text-app-text-muted">
                  Duplicate active aliases plus duplicate Lightspeed B-SKU groups.
                </p>
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-app-border bg-app-bg/60 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Required local bridge commands
              </p>
              <div className="mt-2 grid gap-2 text-[11px] text-app-text">
                <code className="block overflow-x-auto rounded-md bg-black/5 px-2 py-1">
                  node counterpoint-bridge/index.mjs aliases persist --csv export2026-05-07.csv --replace
                </code>
                <code className="block overflow-x-auto rounded-md bg-black/5 px-2 py-1">
                  node counterpoint-bridge/index.mjs lightspeed-reference import --csv "product-export (5).csv" --replace
                </code>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-4">
            <div className="space-y-4">
              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Review Counts
                    </h4>
                    <p className="mt-1 text-xs text-app-text-muted">
                      Counts are read-only. Clean rows continue through the existing import path.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={quarantineLoading}
                    onClick={() => void fetchQuarantineReview()}
                    className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${quarantineLoading ? "animate-spin" : ""}`} aria-hidden />
                    Refresh
                  </button>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {quarantineSeverityRows.map((row) => (
                    <div key={row.label} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {row.label}
                      </p>
                      <p className={`mt-2 text-lg font-black tabular-nums ${row.tone}`}>
                        {fmtNum(row.value)}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {(quarantineSummary?.by_ingest_type ?? []).map((row) => (
                    <div key={row.key} className="rounded-lg border border-app-border bg-app-bg/60 p-3">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {formatReviewLabel(row.key)}
                      </p>
                      <p className="mt-2 text-lg font-black text-app-text tabular-nums">
                        {fmtNum(row.count)}
                      </p>
                    </div>
                  ))}
                  {(quarantineSummary?.by_ingest_type.length ?? 0) === 0 ? (
                    <p className="col-span-2 text-xs text-app-text-muted">No review rows recorded.</p>
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/40 p-4">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Import Safety Context
                </h4>
                <div className="mt-3 grid gap-2 text-xs text-app-text-muted">
                  <p>
                    Counterpoint is authoritative for pre-launch inventory ownership. Lightspeed exports are normalization-only references.
                  </p>
                  <p>
                    Duplicate B-SKU groups and conflicting identity rows are skipped from live writes and saved for review.
                  </p>
                  <p>
                    Runbook: <code>docs/COUNTERPOINT_ONE_TIME_IMPORT.md</code>
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-app-border bg-app-surface-2/40 overflow-hidden">
              <div className="border-b border-app-border bg-app-bg/40 px-4 py-3">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Recent Rows Needing Review
                </h4>
                <p className="mt-1 text-xs text-app-text-muted">
                  This table does not approve, retry, import, or apply rows.
                </p>
              </div>
              <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                    <tr className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="px-3 py-2">When</th>
                      <th className="px-3 py-2">Review</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Family</th>
                      <th className="px-3 py-2">Message</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {quarantineRows.map((row) => (
                      <tr key={row.id}>
                        <td className="px-3 py-2 text-[10px] text-app-text-muted whitespace-nowrap">
                          {formatDate(row.created_at)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`font-black uppercase tracking-wider ${
                            row.severity === "BLOCKING"
                              ? "text-app-danger"
                              : row.severity === "QUARANTINE"
                                ? "text-app-warning"
                                : "text-amber-600"
                          }`}>
                            {row.severity === "BLOCKING" ? "Blocked" : "Needs review"}
                          </span>
                          <p className="mt-1 text-[10px] text-app-text-muted">
                            {formatReviewLabel(row.issue_type)}
                          </p>
                        </td>
                        <td className="px-3 py-2 capitalize">{row.ingest_type}</td>
                        <td className="px-3 py-2 font-mono text-[10px]">
                          {row.normalized_sku ?? "—"}
                        </td>
                        <td className="px-3 py-2 font-mono text-[10px]">
                          {row.family_key ?? row.counterpoint_item_key ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-app-text-muted">{row.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {quarantineRows.length === 0 ? (
                  <p className="p-4 text-xs text-app-text-muted">
                    No recent rows need review.
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "inbound" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 min-h-[320px]">
          <div className="rounded-xl border border-app-border overflow-hidden flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-app-border bg-app-bg/40 flex justify-between items-center">
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Batches
              </span>
              <button
                type="button"
                onClick={() => void fetchBatches()}
                className="text-[10px] font-bold text-app-accent uppercase"
              >
                Reload
              </button>
            </div>
            <div className="overflow-auto flex-1 max-h-[480px]">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-app-surface-2">
                  <tr className="text-[10px] uppercase font-black text-app-text-muted border-b border-app-border">
                    <th className="px-2 py-2">ID</th>
                    <th className="px-2 py-2">Entity</th>
                    <th className="px-2 py-2">Rows</th>
                    <th className="px-2 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {batches.map((b) => (
                    <tr
                      key={b.id}
                      className={`cursor-pointer hover:bg-app-surface/30 ${
                        selectedBatchId === b.id ? "bg-orange-500/10" : ""
                      }`}
                      onClick={() => setSelectedBatchId(b.id)}
                    >
                      <td className="px-2 py-2 font-mono">{b.id}</td>
                      <td className="px-2 py-2 font-bold">{b.entity}</td>
                      <td className="px-2 py-2">{b.row_count}</td>
                      <td className="px-2 py-2 capitalize">{b.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {batches.length === 0 && (
                <p className="p-4 text-xs text-app-text-muted">No staged batches yet.</p>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-app-border flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-app-border bg-app-bg/40 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Payload &amp; actions
            </div>
            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
              {selectedBatchId == null ? (
                <p className="text-xs text-app-text-muted">Select a batch.</p>
              ) : (
                <>
                  {(() => {
                    const batch = batches.find((b) => b.id === selectedBatchId);
                    return batch ? (
                      <div className="text-xs space-y-1">
                        {batch.apply_error && (
                          <p className="text-red-600 font-mono break-all">
                            Last error: {batch.apply_error}
                          </p>
                        )}
                        <p className="text-app-text-muted">
                          Received {formatDate(batch.created_at)}{" "}
                          {batch.bridge_version && `(bridge ${batch.bridge_version})`}
                        </p>
                      </div>
                    ) : null;
                  })()}
                  {payloadLoading ? (
                    <Loader2 className="h-5 w-5 animate-spin text-app-text-muted" />
                  ) : (
                    <pre className="text-[10px] font-mono bg-app-bg/80 border border-app-border rounded-lg p-2 overflow-auto max-h-64 whitespace-pre-wrap break-all">
                      {selectedPayload != null
                        ? JSON.stringify(selectedPayload, null, 2)
                        : "—"}
                    </pre>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={
                        !batches.find((b) => b.id === selectedBatchId && b.status === "pending")
                      }
                      onClick={() =>
                        selectedBatchId != null && setConfirmApply(selectedBatchId)
                      }
                      className="ui-btn-primary px-4 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
                    >
                      Apply to live data
                    </button>
                    <button
                      type="button"
                      disabled={
                        !batches.find((b) => b.id === selectedBatchId && b.status === "pending")
                      }
                      onClick={() =>
                        selectedBatchId != null && setConfirmDiscard(selectedBatchId)
                      }
                      className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
                    >
                      Discard
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "categories" && (
        <div className="rounded-xl border border-app-border overflow-hidden">
          {mapsLoading ? (
            <p className="p-4 text-sm text-app-text-muted">Loading maps…</p>
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-left text-xs min-w-[480px]">
                <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                  <tr className="text-[10px] uppercase font-black text-app-text-muted">
                    <th className="px-3 py-2">CP category</th>
                    <th className="px-3 py-2">ROS category</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {categoryRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-mono font-bold">{row.cp_category}</td>
                      <td className="px-3 py-2">
                        <select
                          className="ui-input text-xs max-w-xs"
                          value={row.ros_category_id ?? ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            void patchCategoryMap(row.id, v === "" ? null : v);
                          }}
                        >
                          <option value="">— Unmapped —</option>
                          {categoryOptions.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-app-text-muted text-[10px]">
                        {row.ros_category_id ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "payments" && (
        <div className="rounded-xl border border-app-border overflow-hidden">
          {mapsLoading ? (
            <p className="p-4 text-sm text-app-text-muted">Loading maps…</p>
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-left text-xs min-w-[400px]">
                <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                  <tr className="text-[10px] uppercase font-black text-app-text-muted">
                    <th className="px-3 py-2">CP payment type</th>
                    <th className="px-3 py-2">ROS method</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {paymentRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-mono font-bold">{row.cp_pmt_typ}</td>
                      <td className="px-3 py-2">
                        <select
                          className="ui-input text-xs max-w-xs"
                          value={row.ros_method}
                          onChange={(e) => void patchPaymentMap(row.id, e.target.value)}
                        >
                          {PAYMENT_METHOD_OPTIONS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "gifts" && (
        <div className="rounded-xl border border-app-border overflow-hidden">
          {mapsLoading ? (
            <p className="p-4 text-sm text-app-text-muted">Loading maps…</p>
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-left text-xs min-w-[400px]">
                <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                  <tr className="text-[10px] uppercase font-black text-app-text-muted">
                    <th className="px-3 py-2">CP reason code</th>
                    <th className="px-3 py-2">ROS card kind</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {giftRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-mono font-bold">{row.cp_reason_cod}</td>
                      <td className="px-3 py-2">
                        <select
                          className="ui-input text-xs max-w-xs"
                          value={row.ros_card_kind}
                          onChange={(e) => void patchGiftMap(row.id, e.target.value)}
                        >
                          {GIFT_KIND_OPTIONS.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "staff" && (
        <div className="rounded-xl border border-app-border overflow-hidden">
          {mapsLoading ? (
            <p className="p-4 text-sm text-app-text-muted">Loading maps…</p>
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-left text-xs min-w-[480px]">
                <thead className="sticky top-0 bg-app-surface-2 border-b border-app-border">
                  <tr className="text-[10px] uppercase font-black text-app-text-muted">
                    <th className="px-3 py-2">CP code</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Staff</th>
                    <th className="px-3 py-2">ROS staff id</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {staffRows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2 font-mono font-bold">{row.cp_code}</td>
                      <td className="px-3 py-2 capitalize">{row.cp_source}</td>
                      <td className="px-3 py-2">{row.staff_display_name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-[10px]">{row.ros_staff_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="p-3 text-[10px] text-app-text-muted border-t border-app-border">
                To change links, adjust Counterpoint staff sync from the bridge or database; this view
                is read-only for safety.
              </p>
            </div>
          )}
        </div>
      )}

      <ConfirmationModal
        isOpen={confirmStagingOff}
        onClose={() => setConfirmStagingOff(false)}
        onConfirm={() => void setStagingEnabled(false)}
        title="Turn off staging?"
        message="The bridge will resume posting directly to live import endpoints. Pending queued batches are not applied automatically."
        confirmLabel="Turn off"
        variant="danger"
        loading={stagingToggleBusy}
      />
      <ConfirmationModal
        isOpen={confirmApply != null}
        onClose={() => setConfirmApply(null)}
        onConfirm={() => confirmApply != null && void applyBatch(confirmApply)}
        title="Apply staged batch?"
        message="This runs the same import as the live bridge path on current ROS data."
        confirmLabel="Apply"
        variant="success"
        loading={applyBusy}
      />
      <ConfirmationModal
        isOpen={confirmDiscard != null}
        onClose={() => setConfirmDiscard(null)}
        onConfirm={() => confirmDiscard != null && void discardBatch(confirmDiscard)}
        title="Discard batch?"
        message="The staged payload will be marked discarded and cannot be applied."
        confirmLabel="Discard"
        variant="danger"
      />
      <PromptModal
        isOpen={resetPromptOpen}
        onClose={() => {
          if (!resetBusy) setResetPromptOpen(false);
        }}
        onSubmit={async (value) => {
          if (!resetPreview) return false;
          const ok = await runBaselineReset(value);
          return ok;
        }}
        title="Reset fresh baseline?"
        message={
          resetPreview
            ? `Pre-go-live only.\n\nThis removes imported Counterpoint business data and Counterpoint migration state from ROS while preserving bootstrap/runtime setup.\n\nType exactly:\n${resetPreview.confirmation_phrase}\n\nAfter the reset, clear the bridge-local cursor file too if you need a full replay from the Counterpoint PC.`
            : "Reset preview is unavailable."
        }
        placeholder={resetPreview?.confirmation_phrase ?? "RESET COUNTERPOINT BASELINE"}
        confirmLabel={resetBusy ? "Resetting…" : "Reset baseline"}
      />
    </section>
  );
}
