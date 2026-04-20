import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useRef } from "react";
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

type HubTab = "status" | "inbound" | "categories" | "payments" | "gifts" | "staff";

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

/* ── Bridge live status from :3002 ── */
const BRIDGE_LOCAL_URL = "http://localhost:3002";

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

const ENTITY_DISPLAY: { key: string; label: string; icon: typeof Zap }[] = [
  { key: "staff", label: "Staff", icon: Users },
  { key: "vendors", label: "Vendors", icon: Truck },
  { key: "customers", label: "Customers", icon: Users },
  { key: "store_credit_opening", label: "Store Credits", icon: CreditCard },
  { key: "category_masters", label: "Categories", icon: Tags },
  { key: "catalog", label: "Catalog", icon: Database },
  { key: "inventory", label: "Inventory", icon: Package },
  { key: "vendor_items", label: "Vendor Items", icon: Hash },
  { key: "gift_cards", label: "Gift Cards", icon: Gift },
  { key: "tickets", label: "Orders / Tickets", icon: FileText },
  { key: "open_docs", label: "Open Docs", icon: FileText },
  { key: "loyalty_hist", label: "Loyalty History", icon: Star },
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

function fmtTimeAgo(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

const GIFT_KIND_OPTIONS = ["purchased", "loyalty_giveaway", "promotional"];

const tabBtn = (active: boolean) =>
  `px-3 py-2 text-[10px] font-black uppercase tracking-widest rounded-lg border transition-colors ${
    active
      ? "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300"
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

  const [tab, setTab] = useState<HubTab>("status");
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
  const bridgePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBridgeLive = useCallback(async () => {
    try {
      const res = await fetch(`${BRIDGE_LOCAL_URL}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = (await res.json()) as BridgeLiveStatus;
        setBridgeLive(data);
        setBridgeOnline(true);
        setBridgeFailCount(0);
      } else {
        setBridgeOnline(false);
        setBridgeFailCount((f) => f + 1);
      }
    } catch {
      setBridgeOnline(false);
      setBridgeFailCount((f) => f + 1);
    }
  }, []);

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
    try {
      await fetch(`${BRIDGE_LOCAL_URL}/api/trigger-entity?name=${entity ?? "full"}`);
      toast(entity ? `Pulling ${entity}…` : "Full sync started.", "success");
      setTimeout(() => void fetchBridgeLive(), 1000);
    } catch {
      toast("Could not reach bridge at localhost:3002", "error");
    }
  }, [toast, fetchBridgeLive]);

  const stopBridgeSync = useCallback(async () => {
    try {
      await fetch(`${BRIDGE_LOCAL_URL}/api/stop`);
      toast("Stop requested — will halt after current entity finishes.", "info");
      setTimeout(() => void fetchBridgeLive(), 1000);
    } catch {
      toast("Could not reach bridge at localhost:3002", "error");
    }
  }, [toast, fetchBridgeLive]);

  const fetchStatus = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setLoading(true);
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
      setLoading(false);
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
  }, [fetchStatus]);

  useEffect(() => {
    if (tab === "inbound") void fetchBatches();
  }, [tab, fetchBatches]);

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

  const refreshButton = (
    <button
      type="button"
      disabled={loading}
      onClick={() => void fetchStatus()}
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
                  Bridge status, inbound review queue, and code maps. Enable staging so batches land in
                  the queue for Apply; otherwise the bridge writes directly to live tables.
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
      ? "rounded-2xl border border-app-border bg-app-surface p-6 sm:p-8 shadow-sm"
      : "ui-card p-8 max-w-6xl border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-transparent";

  return (
    <section
      className={shellClass}
      data-testid={variant === "workspace" ? "counterpoint-settings-panel" : undefined}
    >
      {chrome}

      {tab === "status" && (
        <>
          {/* ── Bridge Live Status ── */}
          {bridgeOnline && bridgeLive ? (
            <>
              {/* Run Control */}
              <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4 mb-4">
                <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                      bridgeLive.isSyncing
                        ? "bg-orange-500/20 text-orange-500"
                        : "bg-emerald-500/15 text-emerald-500"
                    }`}>
                      {bridgeLive.isSyncing ? (
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                      ) : (
                        <Zap className="h-5 w-5" aria-hidden />
                      )}
                    </div>
                    <div>
                      <p className="text-sm font-black uppercase tracking-widest">
                        {bridgeLive.isSyncing ? (
                          <span className="text-orange-500">
                            Syncing{bridgeLive.currentEntity ? ` — ${bridgeLive.currentEntity.replace(/_/g, " ")}` : ""}
                          </span>
                        ) : (
                          <span className="text-emerald-500">Bridge Idle</span>
                        )}
                      </p>
                      <p className="text-[10px] text-app-text-muted mt-0.5">
                        {bridgeLive.lastRun ? `Last run: ${fmtTimeAgo(bridgeLive.lastRun)}` : "No runs yet"}
                        {bridgeLive.lastRunDurationMs ? ` · ${fmtDuration(bridgeLive.lastRunDurationMs)}` : ""}
                        {bridgeLive.totalRecordsLastRun ? ` · ${fmtNum(bridgeLive.totalRecordsLastRun)} records` : ""}
                      </p>
                    </div>
                  </div>
                  {bridgeLive.isSyncing ? (
                    <button
                      type="button"
                      disabled={bridgeLive.abortRequested}
                      onClick={() => void stopBridgeSync()}
                      className="px-5 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                    >
                      <Square className="h-3.5 w-3.5" aria-hidden />
                      {bridgeLive.abortRequested ? "Stopping…" : "Stop Sync"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void triggerBridgeSync()}
                      className="ui-btn-primary px-5 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2 shadow-lg"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden />
                      Run Full Sync
                    </button>
                  )}
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-lg bg-app-bg/60 border border-app-border p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Total Records</p>
                    <p className="text-lg font-black text-app-accent tabular-nums">{fmtNum(bridgeLive.totalRecordsLastRun || 0)}</p>
                  </div>
                  <div className="rounded-lg bg-app-bg/60 border border-app-border p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Duration</p>
                    <p className="text-lg font-black text-app-text tabular-nums">{fmtDuration(bridgeLive.lastRunDurationMs)}</p>
                  </div>
                  <div className="rounded-lg bg-app-bg/60 border border-app-border p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Entities OK</p>
                    <p className="text-lg font-black text-emerald-500 tabular-nums">
                      {Object.values(bridgeLive.entityStats || {}).filter(s => s.lastSync && !s.error).length}
                    </p>
                  </div>
                  <div className="rounded-lg bg-app-bg/60 border border-app-border p-3 text-center">
                    <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">Errors</p>
                    <p className={`text-lg font-black tabular-nums ${Object.values(bridgeLive.entityStats || {}).filter(s => s.error).length ? "text-red-500" : "text-app-text-muted"}`}>
                      {Object.values(bridgeLive.entityStats || {}).filter(s => s.error).length}
                    </p>
                  </div>
                </div>
              </div>

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
                        <th className="px-4 py-2 text-right">Records</th>
                        <th className="px-4 py-2 text-right">Duration</th>
                        <th className="px-4 py-2">Last sync</th>
                        <th className="px-4 py-2">Status</th>
                        <th className="px-4 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {ENTITY_DISPLAY.map(({ key, label, icon: Icon }) => {
                        const stat = bridgeLive?.entityStats?.[key];
                        const isRunning = bridgeLive.currentEntity === key;
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
                                <span className="text-[10px] font-bold text-red-500 max-w-[200px] truncate block" title={stat?.error ?? ""}>
                                  {stat?.error?.slice(0, 60)}
                                </span>
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
                                disabled={bridgeLive.isSyncing}
                                onClick={() => void triggerBridgeSync(key)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border bg-app-surface-1/50 text-[9px] font-black uppercase tracking-widest hover:bg-app-surface-2 transition-colors disabled:opacity-50"
                              >
                                <RefreshCw className="h-3 w-3 text-app-text-muted" />
                                Sync
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
          ) : (
            <>
              {/* Bridge Offline UI (Manual Retry) */}
              {!bridgeOnline && bridgeFailCount >= 3 && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-6 mb-4 text-center">
                  <WifiOff className="h-10 w-10 text-red-500/50 mx-auto mb-3" />
                  <p className="font-bold text-app-text">Bridge unreachable at localhost:3002</p>
                  <p className="text-xs text-app-text-muted mt-1 mb-4">
                    Automatic checking stopped after 3 attempts.
                  </p>
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
              )}
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 mb-4 flex items-start gap-3">
                <WifiOff className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" aria-hidden />
                <div className="text-xs">
                  <p className="font-bold text-app-text">Bridge not reachable at localhost:3002</p>
                  <p className="text-app-text-muted mt-1">Start the Counterpoint bridge to see live sync status, record counts, and run controls.</p>
                </div>
              </div>
            </>
          )}

          {/* ── ROS Server Status (existing) ── */}
          {status ? (
            <>
              {/* Staging mode */}
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

              {/* Server bridge meta */}
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
                    {status.last_seen_at && <span>Last heartbeat: {formatDate(status.last_seen_at)}</span>}
                  </p>
                </div>
                {!status.token_configured && (
                  <span className="ui-pill bg-amber-500/15 text-amber-800 text-[9px]">COUNTERPOINT_SYNC_TOKEN not set</span>
                )}
              </div>

              {/* Server entity history */}
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
          ) : loading ? (
            <p className="text-sm font-medium text-app-text-muted">Loading…</p>
          ) : (
            <p className="text-sm font-bold text-app-text">
              Could not load Counterpoint sync status. Check permissions or network.
            </p>
          )}
        </>
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
    </section>
  );
}
