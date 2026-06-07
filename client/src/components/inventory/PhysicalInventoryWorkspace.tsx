import { getBaseUrl } from "../../lib/apiConfig";
/**
 * PhysicalInventoryWorkspace — multi-phase physical inventory management.
 * Phases: Session Manager → Counting → Review & Publish
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Barcode,
  Camera,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Edit3,
  FileText,
  ListFilter,
  Loader2,
  Package,
  Plus,
  Printer,
  Save,
  ScanLine,
  Search,
  Settings,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import DashboardGridCard from "../ui/DashboardGridCard";
import DashboardStatsCard from "../ui/DashboardStatsCard";
import CameraScanner from "./CameraScanner";
import { useScanner } from "../../hooks/useScanner";
import {
  playScanSuccess,
  playScanError,
  playScanWarning,
  warmUpAudio,
} from "../../lib/scanSounds";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import ManagerApprovalModal from "../pos/ManagerApprovalModal";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import VariantSearchInput from "../ui/VariantSearchInput";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { printTextReport } from "../../lib/printerBridge";

const BASE_URL = getBaseUrl();

// ── Types ─────────────────────────────────────────────────────────────────────

interface PISession {
  id: string;
  session_number: string;
  status: "open" | "reviewing" | "published" | "cancelled";
  scope: "full" | "category";
  category_ids: string[];
  baseline_type: "normal" | "first_inventory" | "baseline_correction";
  started_at: string;
  last_saved_at: string;
  published_at: string | null;
  notes: string | null;
  total_counted?: number;
}

interface CountRow {
  id: string;
  session_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  counted_qty: number;
  adjusted_qty: number | null;
  review_status: string;
  review_note: string | null;
  last_scanned_at: string;
  scan_source: string;
}

interface ReviewRow {
  count_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  stock_at_start: number;
  counted_qty: number;
  adjusted_qty: number | null;
  effective_qty: number;
  sales_since_start: number;
  sales_after_count: number;
  final_stock: number;
  delta: number;
  unit_cost: string | number;
  accounting_impact: string | number;
  review_status: string;
  review_note: string | null;
}

interface ReviewSummary {
  total_counted: number;
  total_variants_in_scope: number;
  missing_variants: number;
  total_shrinkage: number;
  total_surplus: number;
  zero_cost_movement_count: number;
  non_sale_movement_count: number;
  accounting_impact: string | number;
  rows_matching_filter?: number;
  rows_returned?: number;
  rows_hidden?: number;
  row_limit?: number;
}

interface ScanFeedback {
  type: "success" | "warning" | "error";
  message: string;
}

interface PublishOutcome {
  status: "success" | "error";
  message: string;
  detail: string;
  completedAt: string;
}

interface Category {
  id: string;
  name: string;
}

interface DiscoveredItem {
  id: string;
  session_id: string;
  scanned_code: string;
  scan_source: "laser" | "camera" | "manual";
  first_scanned_at: string;
  last_scanned_at: string;
  scan_count: number;
  status: "pending" | "resolved" | "ignored";
  resolved_variant_id: string | null;
  resolved_sku: string | null;
  resolved_product_name: string | null;
  resolution_note: string | null;
}

interface OfflinePhysicalScan {
  id: string;
  session_id: string;
  session_number: string;
  code: string;
  source: ScanMode;
  queued_at: string;
  attempts: number;
}

interface PhysicalInventoryReport {
  session: PISession;
  approvals: Record<string, unknown>[];
  variance_rows: Record<string, unknown>[];
  scan_rows: Record<string, unknown>[];
  discovered_rows: Record<string, unknown>[];
  accounting_rows: Record<string, unknown>[];
}

type Phase = "manager" | "counting" | "review";
type ScanMode = "laser" | "camera";
type BaselineType = "normal" | "first_inventory" | "baseline_correction";
type WorkspaceReportTab = "variance_rows" | "scan_rows" | "discovered_rows" | "accounting_rows" | "approvals";

const COUNT_FEED_LIMIT = 500;
const REVIEW_ROW_LIMIT = 500;
const OFFLINE_SCAN_QUEUE_KEY = "ros.physical_inventory.offline_scans.v1";
const PHYSICAL_REPORT_TABS: { id: WorkspaceReportTab; label: string }[] = [
  { id: "variance_rows", label: "Variance" },
  { id: "scan_rows", label: "Scan Stream" },
  { id: "discovered_rows", label: "Discovered" },
  { id: "accounting_rows", label: "Accounting" },
  { id: "approvals", label: "Signoff" },
];

// ── Utilities ─────────────────────────────────────────────────────────────────

function fmt(dt: string) {
  return new Date(dt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function newClientScanId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const nibble = char === "x" ? value : (value & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

function loadOfflinePhysicalScans(): OfflinePhysicalScan[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OFFLINE_SCAN_QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as OfflinePhysicalScan[];
    return Array.isArray(parsed) ? parsed.filter((row) => row?.id && row?.code) : [];
  } catch {
    return [];
  }
}

function saveOfflinePhysicalScans(rows: OfflinePhysicalScan[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(OFFLINE_SCAN_QUEUE_KEY, JSON.stringify(rows.slice(-1000)));
}

function formatMaybeMoney(value: string | number | null | undefined): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "$0.00";
  return numeric.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function titleizeKey(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatReportCell(value: unknown, key: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  if (/cost|amount|impact|total|value/.test(key)) return formatMaybeMoney(text);
  if (/(_at|date)$/.test(key)) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleString();
  }
  return text.replace(/_/g, " ");
}

function reportRowsText(rows: Record<string, unknown>[]): string {
  const columns = rows.length > 0 ? Object.keys(rows[0]).filter((key) => key !== "variance_summary") : [];
  if (rows.length === 0 || columns.length === 0) {
    return "No rows.\n";
  }
  const header = columns.map(titleizeKey).join("\t");
  const body = rows
    .map((row) => columns.map((key) => formatReportCell(row[key], key).replace(/\s+/g, " ").trim()).join("\t"))
    .join("\n");
  return `${header}\n${body}\n`;
}

function buildPhysicalInventoryPrintText(report: PhysicalInventoryReport): string {
  const startedAt = report.session.started_at ? fmt(report.session.started_at) : "";
  const sections = PHYSICAL_REPORT_TABS.map(
    (tab) => `${tab.label.toUpperCase()}\n${"-".repeat(tab.label.length)}\n${reportRowsText(report[tab.id] ?? [])}`,
  ).join("\n");

  return [
    "Riverside Men's Shop",
    "Physical Inventory Reports",
    `Session: ${report.session.session_number}`,
    `Status: ${report.session.status}`,
    `Area: ${report.session.scope}`,
    startedAt ? `Started: ${startedAt}` : "",
    `Printed: ${fmt(new Date().toISOString())}`,
    "",
    sections,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function ReportTable({
  rows,
  emptyLabel,
}: {
  rows: Record<string, unknown>[];
  emptyLabel: string;
}) {
  const columns = rows.length > 0 ? Object.keys(rows[0]).filter((key) => key !== "variance_summary") : [];
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-app-border bg-app-surface px-5 py-10 text-center text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted">
        {emptyLabel}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-app-border bg-app-surface">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <tr>
            {columns.map((key) => (
              <th key={key} className="whitespace-nowrap px-4 py-3">
                {titleizeKey(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-app-border/50">
          {rows.slice(0, 250).map((row, index) => (
            <tr key={index} className="hover:bg-app-surface-2/60">
              {columns.map((key) => (
                <td key={key} className="max-w-[280px] px-4 py-3 font-semibold text-app-text-muted">
                  <span className="line-clamp-2">{formatReportCell(row[key], key)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: PISession["status"] }) {
  const map: Record<PISession["status"], { label: string; cls: string; dot: string }> = {
    open: { label: "Open", cls: "bg-blue-500/10 text-blue-500 border border-blue-500/20", dot: "bg-blue-500" },
    reviewing: { label: "In Review", cls: "bg-amber-500/10 text-amber-600 border border-amber-500/20", dot: "bg-amber-500" },
    published: { label: "Published", cls: "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20", dot: "bg-emerald-500" },
    cancelled: { label: "Cancelled", cls: "bg-app-surface-2 text-app-text-muted border border-app-border", dot: "bg-app-text-muted" },
  };
  const { label, cls, dot } = map[status] ?? { label: status, cls: "bg-app-surface-2 text-app-text-muted border border-app-border", dot: "bg-app-text-muted" };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[9px] font-black uppercase tracking-widest ${cls}`}>
      <div className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function PhysicalInventoryWorkspace(): React.JSX.Element {
  const { backofficeHeaders } = useBackofficeAuth();
  const isScannerRoute =
    typeof window !== "undefined" &&
    (window.location.pathname.replace(/\/+$/, "") || "/") === "/physical-inventory/scanner";
  const scannerUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/physical-inventory/scanner`
      : "/physical-inventory/scanner";
  const mergeH = useCallback(
    (extra?: HeadersInit): HeadersInit => {
      const base = new Headers(backofficeHeaders());
      if (extra) {
        new Headers(extra).forEach((v: string, k: string) => base.set(k, v));
      }
      return base;
    },
    [backofficeHeaders],
  );

  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase>("manager");
  const [activeSession, setActiveSession] = useState<PISession | null>(null);
  const [sessions, setSessions] = useState<PISession[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [working, setWorking] = useState(false);

  // -- Confirmation states
  const [showMoveConfirm, setShowMoveConfirm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [managerPublishOpen, setManagerPublishOpen] = useState(false);

  // ── Counting state
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [discoveredItems, setDiscoveredItems] = useState<DiscoveredItem[]>([]);
  const [scanMode, setScanMode] = useState<ScanMode>("laser");
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [scanSearch, setScanSearch] = useState("");
  const [offlineScans, setOfflineScans] = useState<OfflinePhysicalScan[]>(() =>
    loadOfflinePhysicalScans(),
  );
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offlineScansRef = useRef<OfflinePhysicalScan[]>(offlineScans);
  const flushingOfflineRef = useRef(false);

  // ── Review state
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [reviewLoadError, setReviewLoadError] = useState<string | null>(null);
  const [lastReviewLoadedAt, setLastReviewLoadedAt] = useState<string | null>(null);
  const [publishOutcome, setPublishOutcome] = useState<PublishOutcome | null>(null);
  const [editingCountId, setEditingCountId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editNote, setEditNote] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  // Re-using ConfirmationModal for publish confirm as well

  // ── New Session form state
  const [showNewSession, setShowNewSession] = useState(false);
  const [newScope, setNewScope] = useState<"full" | "category">("full");
  const [newBaselineType, setNewBaselineType] = useState<BaselineType>("normal");
  const [newCatIds, setNewCatIds] = useState<string[]>([]);
  const [newExcludeReserved, setNewExcludeReserved] = useState(false);
  const [newExcludeLayaway, setNewExcludeLayaway] = useState(false);
  const [newNotes, setNewNotes] = useState("");
  const [reportSessionId, setReportSessionId] = useState<string | null>(null);
  const [workspaceReport, setWorkspaceReport] = useState<PhysicalInventoryReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportLoadError, setReportLoadError] = useState<string | null>(null);
  const [reportTab, setReportTab] = useState<WorkspaceReportTab>("variance_rows");
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");

  // ─────────────────────────────────────────────────────────────────────────────
  // Data loading
  // ─────────────────────────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const [activeRes, listRes, catRes] = await Promise.all([
      fetch(`${BASE_URL}/api/inventory/physical/sessions/active`, {
        headers: mergeH(),
      }),
      fetch(`${BASE_URL}/api/inventory/physical/sessions`, { headers: mergeH() }),
      fetch(`${BASE_URL}/api/categories`, { headers: mergeH() }),
    ]);

    if (activeRes.ok) {
      const data = await activeRes.json() as PISession | null;
      setActiveSession(data ?? null);
      if (data && (data.status === "open" || data.status === "reviewing")) {
        setPhase(data.status === "reviewing" ? "review" : isScannerRoute ? "counting" : "manager");
      }
    }
    if (listRes.ok) {
      const data = (await listRes.json()) as { sessions: PISession[] };
      setSessions(data.sessions);
    }
    if (catRes.ok) {
      setCategories((await catRes.json()) as Category[]);
    }
  }, [isScannerRoute, mergeH]);

  useEffect(() => { void loadData(); }, [loadData]);

  const loadDiscovered = useCallback(async (sessionId: string) => {
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${sessionId}/discovered`,
      { headers: mergeH() },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { items: DiscoveredItem[] };
    setDiscoveredItems(data.items);
  }, [mergeH]);

  const loadCounts = useCallback(async (sessionId: string) => {
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${sessionId}?limit=${COUNT_FEED_LIMIT}`,
      { headers: mergeH() },
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      session: PISession;
      counts: CountRow[];
      count_total?: number;
    };
    setCounts(data.counts);
    setActiveSession((prev) =>
      prev?.id === sessionId
        ? { ...prev, total_counted: data.count_total ?? data.counts.length }
        : prev,
    );
    await loadDiscovered(sessionId);
  }, [loadDiscovered, mergeH]);

  const loadReview = useCallback(async (sessionId: string, query = "") => {
    try {
      const params = new URLSearchParams({
        limit: String(REVIEW_ROW_LIMIT),
      });
      const trimmedQuery = query.trim();
      if (trimmedQuery) params.set("q", trimmedQuery);
      const res = await fetch(
        `${BASE_URL}/api/inventory/physical/sessions/${sessionId}/review?${params.toString()}`,
        { headers: mergeH() },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not refresh count review.");
      }
      const data = (await res.json()) as { rows: ReviewRow[]; summary: ReviewSummary };
      setReviewRows(data.rows);
      setReviewSummary(data.summary);
      setReviewLoadError(null);
      setLastReviewLoadedAt(new Date().toLocaleString());
      await loadDiscovered(sessionId);
    } catch (error) {
      setReviewLoadError(
        error instanceof Error ? error.message : "Could not refresh count review.",
      );
    }
  }, [loadDiscovered, mergeH]);

  const loadWorkspaceReport = useCallback(async (sessionId: string) => {
    setReportLoading(true);
    setReportLoadError(null);
    setReportSessionId(sessionId);
    try {
      const res = await fetch(
        `${BASE_URL}/api/inventory/physical/sessions/${sessionId}/reports`,
        { headers: mergeH() },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load physical inventory reports.");
      }
      setWorkspaceReport((await res.json()) as PhysicalInventoryReport);
    } catch (error) {
      setWorkspaceReport(null);
      setReportLoadError(
        error instanceof Error ? error.message : "Could not load physical inventory reports.",
      );
    } finally {
      setReportLoading(false);
    }
  }, [mergeH]);

  const currentReportRows = useMemo(() => {
    if (!workspaceReport) return [];
    return workspaceReport[reportTab] ?? [];
  }, [reportTab, workspaceReport]);
  const handlePrintWorkspaceReport = useCallback(async () => {
    if (!workspaceReport) {
      toast("Choose a physical inventory session before printing reports.", "error");
      return;
    }
    try {
      await printTextReport(buildPhysicalInventoryPrintText(workspaceReport));
      toast("Physical Inventory reports sent to the Reports printer.", "success");
    } catch (error) {
      console.error("Physical Inventory report print failed", error);
      toast(error instanceof Error ? error.message : "Physical Inventory report print failed.", "error");
    }
  }, [toast, workspaceReport]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Feedback flash
  // ─────────────────────────────────────────────────────────────────────────────

  const showFeedback = useCallback((fb: ScanFeedback) => {
    setFeedback(fb);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2200);
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────
  // Scanning
  // ─────────────────────────────────────────────────────────────────────────────

  const enqueueOfflineScan = useCallback((
    code: string,
    source: ScanMode,
    clientScanId = newClientScanId(),
  ) => {
    if (!activeSession) return;
    const row: OfflinePhysicalScan = {
      id: clientScanId,
      session_id: activeSession.id,
      session_number: activeSession.session_number,
      code,
      source,
      queued_at: new Date().toISOString(),
      attempts: 0,
    };
    setOfflineScans((prev) => {
      if (prev.some((existing) => existing.id === row.id)) return prev;
      const next = [...prev, row].slice(-1000);
      saveOfflinePhysicalScans(next);
      return next;
    });
    playScanWarning();
    showFeedback({
      type: "warning",
      message: `QUEUED OFFLINE: ${code}`,
    });
  }, [activeSession, showFeedback]);

  const updateDiscoveredItem = useCallback(async (
    item: DiscoveredItem,
    status: "resolved" | "ignored",
  ) => {
    if (!activeSession) return;
    let resolvedVariantId: string | null = null;
    if (status === "resolved") {
      const resolveRes = await fetch(
        `${BASE_URL}/api/inventory/scan-resolve?code=${encodeURIComponent(item.scanned_code)}`,
        { headers: mergeH() },
      );
      if (!resolveRes.ok) {
        toast("Create or update the item barcode/SKU before marking it resolved.", "error");
        return;
      }
      const resolved = (await resolveRes.json()) as { variant_id: string };
      resolvedVariantId = resolved.variant_id;
    }

    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/discovered/${item.id}`,
      {
        method: "PATCH",
        headers: mergeH({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          status,
          resolved_variant_id: resolvedVariantId,
          resolution_note:
            status === "resolved"
              ? "Catalog item resolved from scanner workspace."
              : "Reviewed and excluded from this count.",
        }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast(body.error ?? "Could not update discovered scan.", "error");
      return;
    }
    const updated = (await res.json()) as DiscoveredItem;
    setDiscoveredItems((prev) =>
      prev.map((row) => row.id === updated.id ? updated : row),
    );
    toast(status === "resolved" ? "Discovered scan resolved." : "Discovered scan ignored.", "success");
  }, [activeSession, mergeH, toast]);

  const submitScan = useCallback(
    async (
      code: string,
      source: ScanMode,
      clientScanId = newClientScanId(),
      queueOnNetworkFailure = true,
    ) => {
      if (!activeSession || activeSession.status !== "open") return false;

      // Resolve the code against inventory
      let resolveRes: Response;
      try {
        resolveRes = await fetch(
          `${BASE_URL}/api/inventory/scan-resolve?code=${encodeURIComponent(code)}`,
          { headers: mergeH() },
        );
      } catch {
        if (queueOnNetworkFailure) enqueueOfflineScan(code, source, clientScanId);
        return false;
      }

      if (!resolveRes.ok) {
        let discoveredRes: Response;
        try {
          discoveredRes = await fetch(
            `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/discovered`,
            {
              method: "POST",
              headers: mergeH({ "Content-Type": "application/json" }),
              body: JSON.stringify({
                scanned_code: code,
                source,
              }),
            },
          );
        } catch {
          if (queueOnNetworkFailure) enqueueOfflineScan(code, source, clientScanId);
          return false;
        }
        if (!discoveredRes.ok) {
          playScanError();
          showFeedback({ type: "error", message: `NOT FOUND: ${code}` });
          return false;
        }
        const item = (await discoveredRes.json()) as DiscoveredItem;
        setDiscoveredItems((prev) => {
          const idx = prev.findIndex((row) => row.id === item.id);
          if (idx === -1) return [item, ...prev];
          const next = [...prev];
          next[idx] = item;
          return next;
        });
        playScanWarning();
        showFeedback({
          type: "warning",
          message: `UNKNOWN CAPTURED: ${code} · Review before publish`,
        });
        return true;
      }

      const resolved = (await resolveRes.json()) as {
        variant_id: string;
        sku: string;
        product_name: string;
      };

      // Add to session count
      let countRes: Response;
      try {
        countRes = await fetch(
          `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/counts`,
          {
            method: "POST",
            headers: mergeH({ "Content-Type": "application/json" }),
            body: JSON.stringify({
              variant_id: resolved.variant_id,
              quantity: 1,
              source,
              client_scan_id: clientScanId,
            }),
          },
        );
      } catch {
        if (queueOnNetworkFailure) enqueueOfflineScan(code, source, clientScanId);
        return false;
      }

      if (countRes.ok) {
        const { counted_qty } = (await countRes.json()) as { counted_qty: number };
        playScanSuccess();
        showFeedback({
          type: "success",
          message: `${resolved.product_name} · Qty: ${counted_qty}`,
        });
        // Update local counts list
        setCounts((prev) => {
          const idx = prev.findIndex((c) => c.variant_id === resolved.variant_id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], counted_qty, last_scanned_at: new Date().toISOString() };
            return next.slice(0, COUNT_FEED_LIMIT);
          }
          return [
            {
              id: crypto.randomUUID(),
              session_id: activeSession.id,
              variant_id: resolved.variant_id,
              sku: resolved.sku,
              product_name: resolved.product_name,
              variation_label: null,
              counted_qty,
              adjusted_qty: null,
              review_status: "pending",
              review_note: null,
              last_scanned_at: new Date().toISOString(),
              scan_source: source,
            },
            ...prev,
          ].slice(0, COUNT_FEED_LIMIT);
        });
        return true;
      } else {
        playScanWarning();
        showFeedback({ type: "warning", message: "Count update failed" });
        return false;
      }
    },
    [activeSession, enqueueOfflineScan, mergeH, showFeedback],
  );

  const flushOfflineScans = useCallback(async () => {
    if (!activeSession || activeSession.status !== "open" || flushingOfflineRef.current) return;
    const pending = loadOfflinePhysicalScans()
      .filter((row) => row.session_id === activeSession.id)
      .slice(0, 25);
    if (pending.length === 0) return;
    flushingOfflineRef.current = true;
    let replayed = 0;
    try {
      for (const row of pending) {
        const ok = await submitScan(row.code, row.source, row.id, false);
        setOfflineScans((prev) => {
          const next = ok
            ? prev.filter((existing) => existing.id !== row.id)
            : prev.map((existing) =>
                existing.id === row.id
                  ? { ...existing, attempts: existing.attempts + 1 }
                  : existing,
              );
          saveOfflinePhysicalScans(next);
          return next;
        });
        if (!ok) break;
        replayed += 1;
      }
      if (replayed > 0) {
        toast(`${replayed} queued physical inventory scan${replayed === 1 ? "" : "s"} replayed.`, "success");
      }
    } finally {
      flushingOfflineRef.current = false;
    }
  }, [activeSession, submitScan, toast]);

  const handleScan = useCallback(
    async (code: string) => {
      await submitScan(code, scanMode);
    },
    [scanMode, submitScan],
  );

  // Wire HID scanner hook — only active in counting phase with laser mode
  useScanner({
    onScan: (code) => void handleScan(code),
    enabled: phase === "counting" && scanMode === "laser",
  });

  useEffect(() => {
    offlineScansRef.current = offlineScans;
  }, [offlineScans]);

  useEffect(() => {
    const handleOnline = () => {
      void flushOfflineScans();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [flushOfflineScans]);

  useEffect(() => {
    if (
      activeSession?.status === "open" &&
      phase === "counting" &&
      offlineScansRef.current.some((row) => row.session_id === activeSession.id) &&
      navigator.onLine !== false
    ) {
      void flushOfflineScans();
    }
  }, [activeSession, flushOfflineScans, phase]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Session Actions
  // ─────────────────────────────────────────────────────────────────────────────

  const createSession = async () => {
    if (newScope === "category" && newCatIds.length === 0) return;
    setWorking(true);
    warmUpAudio();
    const res = await fetch(`${BASE_URL}/api/inventory/physical/sessions`, {
      method: "POST",
      headers: mergeH({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        scope: newScope,
        baseline_type: newBaselineType,
        category_ids: newCatIds,
        exclude_reserved: newExcludeReserved,
        exclude_layaway: newExcludeLayaway,
        notes: newNotes.trim() || null,
      }),
    });
    if (res.ok) {
      const session = (await res.json()) as PISession;
      setActiveSession(session);
      setShowNewSession(false);
      setPhase("counting");
      setCounts([]);
      setDiscoveredItems([]);
      setNewNotes("");
      setNewCatIds([]);
      setNewBaselineType("normal");
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Could not start session", "error");
    }
    setWorking(false);
  };

  const saveSession = async () => {
    if (!activeSession) return;
    await fetch(`${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/save`, {
      method: "POST",
      headers: mergeH(),
    });
    showFeedback({ type: "success", message: "Session saved for today" });
  };

  const moveToReview = async () => {
    if (!activeSession) return;
    setShowMoveConfirm(true);
  };

  const handleConfirmMove = async () => {
    if (!activeSession) return;
    setShowMoveConfirm(false);
    setWorking(true);
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/move-to-review`,
      { method: "POST", headers: mergeH() },
    );
    if (res.ok) {
      setActiveSession((prev) => prev ? { ...prev, status: "reviewing" } : prev);
      await loadReview(activeSession.id);
      setPhase("review");
      setPublishOutcome(null);
    }
    setWorking(false);
  };

  const cancelSession = async () => {
    if (!activeSession) return;
    setShowCancelConfirm(true);
  };

  const handleConfirmCancel = async () => {
    if (!activeSession) return;
    setShowCancelConfirm(false);
    setWorking(true);
    await fetch(`${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}`, {
      method: "DELETE",
      headers: mergeH(),
    });
    setActiveSession(null);
    setPhase("manager");
    await loadData();
    setWorking(false);
  };

  const applyAdjustment = async () => {
    if (!activeSession || !editingCountId) return;
    const qty = parseInt(editQty, 10);
    if (!Number.isFinite(qty) || qty < 0) return;
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/counts/${editingCountId}`,
      {
        method: "PATCH",
        headers: mergeH({ "Content-Type": "application/json" }),
        body: JSON.stringify({ adjusted_qty: qty, note: editNote.trim() || null }),
      },
    );
    if (res.ok) {
      setEditingCountId(null);
      await loadReview(activeSession.id);
      setPublishOutcome(null);
    }
  };

  const publishWithApproval = async (managerPin: string, managerStaffId: string) => {
    if (!activeSession) return;
    setWorking(true);
    setPublishConfirm(false);
    setManagerPublishOpen(false);
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/publish`,
      {
        method: "POST",
        headers: mergeH({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          manager_staff_id: managerStaffId,
          manager_pin: managerPin,
          approval_note: `Manager Access signoff for ${activeSession.session_number}`,
        }),
      },
    );
    if (res.ok) {
      const publishedAt = new Date().toLocaleString();
      const reviewedItems = reviewSummary?.total_variants_in_scope ?? reviewRows.length;
      const countedItems = reviewSummary?.total_counted ?? 0;
      const missingItems = reviewSummary?.missing_variants ?? 0;
      setActiveSession((prev) => prev ? { ...prev, status: "published" } : prev);
      setPublishOutcome({
        status: "success",
        message: "Publish completed. Live inventory was updated from the reviewed counts.",
        detail: `${reviewedItems.toLocaleString()} item${reviewedItems === 1 ? "" : "s"} reviewed, ${countedItems.toLocaleString()} counted, ${missingItems.toLocaleString()} missing from count. Publish does not rerun receiving or sales activity.`,
        completedAt: publishedAt,
      });
      await loadData();
      await loadWorkspaceReport(activeSession.id);
      setPhase("manager");
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      const message = err.error ?? "Publish failed";
      setPublishOutcome({
        status: "error",
        message: "Publish did not finish.",
        detail: `${message} Review is still available. Retry only after confirming the review data is current.`,
        completedAt: new Date().toLocaleString(),
      });
      toast(message, "error");
    }
    setWorking(false);
    return res.ok;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Resume active session on mount
  // ─────────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (activeSession && phase === "counting") {
      void loadCounts(activeSession.id);
    }
    if (activeSession?.status === "reviewing" && phase === "review") {
      void loadReview(activeSession.id);
    }
  }, [activeSession, phase, loadCounts, loadReview]);

  useEffect(() => {
    if (!activeSession || activeSession.status !== "reviewing" || phase !== "review") return;
    const handle = window.setTimeout(() => {
      void loadReview(activeSession.id, reviewSearch);
    }, 350);
    return () => window.clearTimeout(handle);
  }, [activeSession, loadReview, phase, reviewSearch]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Filtered views
  // ─────────────────────────────────────────────────────────────────────────────

  const filteredCounts = useMemo(() => {
    if (!scanSearch.trim()) return counts;
    const q = scanSearch.toLowerCase();
    return counts.filter(
      (c) =>
        c.sku.toLowerCase().includes(q) ||
        c.product_name.toLowerCase().includes(q),
    );
  }, [counts, scanSearch]);

  const filteredReview = useMemo(() => {
    if (!reviewSearch.trim()) return reviewRows;
    const q = reviewSearch.toLowerCase();
    return reviewRows.filter(
      (r) =>
        r.sku.toLowerCase().includes(q) ||
        r.product_name.toLowerCase().includes(q),
    );
  }, [reviewRows, reviewSearch]);

  const unresolvedReviewCount = useMemo(
    () =>
      reviewRows.filter(
        (row) =>
          row.review_status === "pending" &&
          (row.delta !== 0 || row.counted_qty === 0),
      ).length,
    [reviewRows],
  );
  const pendingDiscoveredCount = useMemo(
    () => discoveredItems.filter((item) => item.status === "pending").length,
    [discoveredItems],
  );
  const sessionOfflineScans = useMemo(
    () => offlineScans.filter((row) => row.session_id === activeSession?.id),
    [activeSession?.id, offlineScans],
  );
  const zeroCostMovementCount = reviewSummary?.zero_cost_movement_count ?? 0;
  const nonSaleMovementCount = reviewSummary?.non_sale_movement_count ?? 0;
  const publishBlocked =
    pendingDiscoveredCount > 0 ||
    zeroCostMovementCount > 0 ||
    nonSaleMovementCount > 0 ||
    sessionOfflineScans.length > 0;
  const reviewDelta = reviewSummary
    ? reviewSummary.total_surplus - reviewSummary.total_shrinkage
    : 0;

  const root = document.getElementById("drawer-root");
  const workspaceReportPanel = (
    <DashboardGridCard
      title="Physical Inventory Reports"
      subtitle="Session reports stay with the count workspace"
      icon={FileText}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-black text-app-text">
              {workspaceReport?.session.session_number ?? "Select a session"}
            </p>
            <p className="text-[11px] font-semibold text-app-text-muted">
              Variance, raw scans, discovered scans, accounting impact, and Manager Access signoff.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!workspaceReport}
              onClick={handlePrintWorkspaceReport}
              className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 disabled:opacity-40"
            >
              <Printer size={13} />
              Print All
            </button>
            {PHYSICAL_REPORT_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setReportTab(tab.id)}
                className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
                  reportTab === tab.id
                    ? "border-app-accent bg-app-accent text-white"
                    : "border-app-border bg-app-surface text-app-text-muted hover:bg-app-surface-2"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {reportLoading ? (
          <div className="flex items-center justify-center gap-3 rounded-2xl border border-app-border bg-app-surface px-5 py-10 text-sm font-bold text-app-text-muted">
            <Loader2 className="animate-spin" size={18} />
            Loading physical inventory reports
          </div>
        ) : reportLoadError ? (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-sm font-bold text-red-700">
            {reportLoadError}
          </div>
        ) : workspaceReport ? (
          <ReportTable rows={currentReportRows} emptyLabel="No rows for this report" />
        ) : (
          <ReportTable rows={[]} emptyLabel="Choose Reports from a count session" />
        )}

        {reportSessionId && workspaceReport ? (
          <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-[11px] font-semibold text-app-text-muted">
            These report rows are supplied by the Physical Inventory API and can be used as a Metabase source without adding them to the global Reports workspace.
          </div>
        ) : null}
      </div>
    </DashboardGridCard>
  );

  // ─────────────────────────────────────────────────────────────────────────────
   if (phase === "manager") {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-6 duration-700">
        <div className="px-1">
          <h2 className="text-2xl font-black tracking-tight text-app-text">Physical Inventory</h2>
        </div>

        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-sm text-amber-900">
          <p className="text-[11px] font-black uppercase tracking-widest">
            Pilot count rule
          </p>
          <p className="mt-1 font-bold leading-relaxed">
            Sales can continue during a physical inventory count. Receiving is paused store-wide until the session is published or canceled.
          </p>
          <p className="mt-1 text-xs font-semibold">
            Publish only after the manager confirms count sheets, uncounted items, and any receiving hold are resolved.
          </p>
        </div>

        <div className="rounded-2xl border border-app-border bg-app-surface px-5 py-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                Scanner PWA
              </p>
              <p className="mt-1 break-all font-mono text-xs font-bold text-app-text">
                {scannerUrl}
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Use this on iPad camera scanning, iPad Bluetooth scanners, or a PC USB scanner. Keyboard-style scanners should send Enter after each code.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(scannerUrl);
                toast("Physical Inventory Scanner URL copied.", "success");
              }}
              className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface"
            >
              Copy URL
            </button>
          </div>
        </div>

        {publishOutcome ? (
          <div
            className={`flex items-start gap-3 rounded-2xl border px-5 py-4 ${
              publishOutcome.status === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                : "border-red-500/30 bg-red-500/10 text-red-700"
            }`}
          >
            {publishOutcome.status === "success" ? (
              <CheckCircle className="mt-0.5 shrink-0" size={18} />
            ) : (
              <AlertCircle className="mt-0.5 shrink-0" size={18} />
            )}
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest">
                {publishOutcome.status === "success" ? "Publish completed" : "Publish did not finish"}
              </p>
              <p className="mt-1 text-sm font-bold leading-relaxed">{publishOutcome.message}</p>
              <p className="mt-1 text-xs font-semibold opacity-80">
                {publishOutcome.detail} · {publishOutcome.completedAt}
              </p>
            </div>
          </div>
        ) : null}

        {/* Active session resume banner */}
        {activeSession && activeSession.status === "open" && (
          <div className="group relative overflow-hidden flex items-center justify-between rounded-[2.5rem] border border-blue-500/20 bg-blue-500/5 px-8 py-6 backdrop-blur-md">
            <div className="flex items-center gap-5 relative z-10">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-500/10 text-blue-500 shadow-lg shadow-blue-500/10">
                <ScanLine size={24} />
              </div>
              <div>
                <p className="text-lg font-black text-app-text tracking-tight">
                  Active Session <span className="text-blue-500 italic">#{activeSession.session_number}</span>
                </p>
                <p className="text-[11px] font-bold text-app-text-muted mt-0.5 opacity-60">
                  Last heartbeat {fmt(activeSession.last_saved_at)} · {activeSession.total_counted ?? 0} items in count
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setPhase("counting"); void loadCounts(activeSession.id); }}
              className="relative z-10 flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-blue-600/20 hover:brightness-110 active:scale-95 transition-all"
            >
              Resume Scanners <ChevronRight size={14} />
            </button>
            <div className="absolute -right-20 -bottom-20 h-64 w-64 rounded-full bg-blue-500/5 blur-3xl" />
          </div>
        )}

        {/* Reviewing session banner */}
        {activeSession && activeSession.status === "reviewing" && (
          <div className="flex items-center justify-between rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
            <div className="flex items-center gap-3">
              <ClipboardList className="text-amber-700 shrink-0" size={22} />
              <div>
                <p className="text-sm font-black text-amber-900">
                  Session in Review: {activeSession.session_number}
                </p>
                <p className="text-[11px] text-amber-700">
                  Review and publish to apply stock changes. Pilot watch: this count remains unresolved until published or canceled.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setPhase("review"); void loadReview(activeSession.id); }}
              className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-white transition hover:bg-amber-700"
            >
              Go to Review <ChevronRight size={14} />
            </button>
          </div>
        )}

        {/* Start new session */}
        {/* Start new session */}
        {!activeSession && (
          <DashboardGridCard
            title="Count Setup"
            subtitle="Start a new physical inventory session"
            icon={Plus}
          >
            {!showNewSession ? (
              <div className="py-20 flex flex-col items-center justify-center text-center">
                <div className="mb-6 h-20 w-20 flex items-center justify-center rounded-[32px] bg-app-surface border border-app-border shadow-2xl">
                  <Package className="text-app-text-muted opacity-40" size={40} />
                </div>
                <h4 className="text-xl font-black tracking-tight text-app-text mb-2">No active count session</h4>
                <p className="text-xs font-bold text-app-text-muted opacity-60 mb-8 max-w-[280px]">
                  Initialize a full store or category-specific stock take to audit current levels.
                </p>
                <button
                  type="button"
                  onClick={() => { setShowNewSession(true); warmUpAudio(); }}
                  className="flex items-center gap-2 rounded-2xl bg-app-accent px-8 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/30 hover:brightness-110 active:scale-95 transition-all"
                >
                  <Plus size={16} /> New Inventory Session
                </button>
              </div>
            ) : (
              <div className="space-y-8 max-w-2xl mx-auto">
                <div className="grid gap-8 md:grid-cols-2">
                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Count area</label>
                    <div className="flex gap-3">
                      {(["full", "category"] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => { setNewScope(s); setNewCatIds([]); }}
                          className={`flex-1 h-14 rounded-2xl border text-[10px] font-black uppercase tracking-widest transition-all ${
                            newScope === s
                              ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
                              : "border-app-border/70 bg-app-surface text-app-text-muted shadow-sm hover:border-app-text/30 hover:bg-app-surface-2"
                          }`}
                        >
                          {s === "full" ? "Full store" : "Category"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Inventory reason</label>
                    <select
                      value={newBaselineType}
                      onChange={(e) => setNewBaselineType(e.target.value as BaselineType)}
                      className="ui-input h-14 w-full rounded-2xl px-4 text-xs font-black uppercase tracking-widest"
                    >
                      <option value="normal">Normal count</option>
                      <option value="first_inventory">First inventory cleanup</option>
                      <option value="baseline_correction">Baseline correction</option>
                    </select>
                  </div>

                  <div className="space-y-4 md:col-span-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Leave out from count</label>
                    <div className="grid grid-cols-2 gap-3">
                       <button
                         type="button"
                         onClick={() => setNewExcludeReserved(!newExcludeReserved)}
                         className={`h-14 rounded-2xl border text-[9px] font-black uppercase tracking-widest transition-all ${
                           newExcludeReserved ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-app-border/70 bg-app-surface text-app-text-muted shadow-sm"
                         }`}
                       >
                         Reserved
                       </button>
                       <button
                         type="button"
                         onClick={() => setNewExcludeLayaway(!newExcludeLayaway)}
                         className={`h-14 rounded-2xl border text-[9px] font-black uppercase tracking-widest transition-all ${
                           newExcludeLayaway ? "border-amber-500/50 bg-amber-500/10 text-amber-600" : "border-app-border/70 bg-app-surface text-app-text-muted shadow-sm"
                         }`}
                       >
                         Layaway
                       </button>
                    </div>
                  </div>
                </div>

                {newScope === "category" && (
                  <div className="space-y-4 animate-in slide-in-from-top-4 duration-300">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Target Categories</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-48 overflow-y-auto no-scrollbar p-1">
                      {categories.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => 
                            setNewCatIds((prev) =>
                              prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id]
                            )
                          }
                          className={`px-4 py-3 rounded-xl border text-[10px] font-bold text-left transition-all ${
                            newCatIds.includes(c.id) ? "border-app-accent bg-app-accent/10 text-app-text" : "border-app-border/70 bg-app-surface text-app-text-muted shadow-sm hover:bg-app-surface-2"
                          }`}
                        >
                          {c.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-4">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Notes</label>
                  <textarea
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    rows={2}
                    className="ui-input w-full rounded-2xl px-5 py-4 text-xs font-bold focus:ring-4 focus:ring-app-accent/10 resize-none"
                    placeholder="Reference period or specific instruction..."
                  />
                </div>

                <div className="flex gap-4 pt-4">
                  <button
                    type="button"
                    onClick={() => void createSession()}
                    disabled={working || (newScope === "category" && newCatIds.length === 0)}
                    className="flex-1 h-14 flex items-center justify-center gap-3 rounded-2xl bg-app-accent text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/30 hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
                  >
                    {working ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle size={16} />}
                    Start Count
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowNewSession(false)}
                    className="h-14 px-8 rounded-2xl border border-app-border/70 bg-app-surface text-[11px] font-black uppercase tracking-[0.2em] text-app-text-muted shadow-sm hover:bg-app-surface-2 transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </DashboardGridCard>
        )}

        {/* Session History */}
        <DashboardGridCard
          title="Session Manager"
          subtitle="Resume, review, or cancel inventory counts"
          icon={Settings}
        >
          <div className="overflow-hidden rounded-[2.5rem] border border-app-border/50 bg-app-surface shadow-sm">
            {sessions.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center opacity-40 text-center">
                <ClipboardList className="mb-3" size={32} />
                <p className="text-[10px] font-black uppercase tracking-[0.3em]">No count history</p>
              </div>
            ) : isCompactLayout ? (
              <div className="space-y-2 p-3" data-testid="physical-session-cards">
                {sessions.map((s) => (
                  <article
                    key={s.id}
                    className="rounded-xl border border-app-border bg-app-surface-2/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-sm font-black text-app-accent">
                          {s.session_number}
                        </p>
                        <p className="mt-1 text-[11px] font-semibold capitalize text-app-text-muted">
                          {s.scope} area
                        </p>
                      </div>
                      <StatusBadge status={s.status} />
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-app-text">
                      <p>
                        <span className="font-black text-app-text-muted">Started:</span>{" "}
                        {fmt(s.started_at)}
                      </p>
                      <p className="text-right">
                        <span className="font-black text-app-text-muted">Items:</span>{" "}
                        {s.total_counted ?? 0}
                      </p>
                    </div>
                    {s.status === "open" || s.status === "reviewing" ? (
                      <div className="mt-3 flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void loadWorkspaceReport(s.id)}
                          className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                        >
                          Reports
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveSession(s);
                            setShowCancelConfirm(true);
                          }}
                          className="rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-red-600"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          onClick={() => void loadWorkspaceReport(s.id)}
                          className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                        >
                          Reports
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <table className="w-full text-left text-xs" data-testid="physical-session-table">
                <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                  <tr>
                    <th className="px-6 py-4">Count #</th>
                    <th className="px-6 py-4">Area</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Started</th>
                    <th className="px-6 py-4">Items</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/40">
                  {sessions.map((s) => (
                    <tr key={s.id} className="group hover:bg-app-surface-2/60 transition-colors">
                      <td className="px-6 py-4 font-mono font-black text-app-accent">{s.session_number}</td>
                      <td className="px-6 py-4 font-bold text-app-text-muted capitalize">{s.scope}</td>
                      <td className="px-6 py-4"><StatusBadge status={s.status} /></td>
                      <td className="px-6 py-4 text-app-text-muted opacity-60">{fmt(s.started_at)}</td>
                      <td className="px-6 py-4 font-black text-app-text">{s.total_counted ?? 0}</td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void loadWorkspaceReport(s.id)}
                          className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2"
                        >
                          Reports
                        </button>
                        {(s.status === "open" || s.status === "reviewing") && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSession(s);
                              setShowCancelConfirm(true);
                            }}
                            className="p-2 text-red-500/40 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                            title="Cancel session"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
	        </DashboardGridCard>

        {workspaceReportPanel}

	        <ConfirmationModal
          isOpen={showCancelConfirm}
          title="Cancel Session?"
          message={`Are you sure you want to cancel session ${activeSession?.session_number}? This action cannot be undone and no stock changes will be made.`}
          confirmLabel="Cancel Session"
          variant="danger"
          onConfirm={() => void handleConfirmCancel()}
          onClose={() => setShowCancelConfirm(false)}
        />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Counting Phase (Phase 2)
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === "counting" && activeSession) {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-6 duration-700">
        <div className="flex flex-wrap items-center justify-between gap-6 px-1">
          <div>
            <h2 className="text-2xl font-black tracking-tight text-app-text">Active Count · <span className="text-app-accent">#{activeSession.session_number}</span></h2>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex h-12 overflow-hidden rounded-[20px] border border-app-border/60 bg-app-surface shadow-xl shadow-black/5 p-1">
              {(["laser", "camera"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setScanMode(m); warmUpAudio(); }}
                  className={`flex h-full items-center gap-2 rounded-[14px] px-6 text-[10px] font-black uppercase tracking-widest transition-all ${
                    scanMode === m
                      ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                      : "text-app-text-muted hover:bg-app-surface-2/60"
                  }`}
                >
                  {m === "laser" ? <Barcode size={14} /> : <Camera size={14} />}
                  {m}
                </button>
              ))}
            </div>
            
            <div className="flex h-12 gap-2">
              <button
                type="button"
                onClick={() => void saveSession()}
                className="flex items-center gap-2 h-full px-6 rounded-[20px] bg-app-surface border border-app-border/40 text-[10px] font-black uppercase tracking-widest text-app-text shadow-xl shadow-black/5 hover:bg-app-surface-2 transition-all"
              >
                <Save size={14} className="text-app-accent" /> Save
              </button>
              <button
                type="button"
                onClick={() => void moveToReview()}
                disabled={counts.length === 0 || working || sessionOfflineScans.length > 0}
                className="flex items-center gap-2 h-full px-8 rounded-[20px] bg-amber-500 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-amber-500/20 hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
              >
	                <ClipboardList size={14} /> Review Count
              </button>
              <button
                type="button"
                onClick={() => void cancelSession()}
                className="flex items-center justify-center w-12 h-full rounded-[20px] border border-red-500/20 bg-red-500/5 text-red-500 hover:bg-red-500/10 transition-all"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        </div>

        <div className="grid gap-8 lg:grid-cols-[400px_1fr]">
          <div className="space-y-8">
            <DashboardGridCard 
              title="Scanner"
              subtitle={scanMode === 'laser' ? 'Laser scanner ready' : 'Camera scanner ready'}
              icon={ScanLine}
            >
              <div className="space-y-6">
                 {scanMode === "camera" && (
                   <div className="overflow-hidden rounded-[2.5rem] border border-app-border bg-black shadow-2xl aspect-[4/3] relative">
                      <CameraScanner 
                        label="Physical Inventory" 
                        onScan={(code) => void handleScan(code)} 
                        onClose={() => setScanMode("laser")} 
                      />
                   </div>
                 )}

                 {feedback && (
                   <div className={`flex items-center gap-4 rounded-2xl border p-5 animate-in zoom-in duration-300 ${
                     feedback.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600' :
                     feedback.type === 'warning' ? 'bg-amber-500/10 border-amber-500/20 text-amber-600' :
                     'bg-red-500/10 border-red-500/20 text-red-600'
                   }`}>
                     {feedback.type === 'success' ? <CheckCircle size={20} /> : <AlertCircle size={20} />}
                     <div className="flex flex-col">
	                        <p className="text-[10px] font-black uppercase tracking-widest opacity-60">Scan result</p>
                        <p className="text-xs font-black tracking-tight">{feedback.message}</p>
                     </div>
                   </div>
                 )}

                 {sessionOfflineScans.length > 0 ? (
                   <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-amber-700">
                     <p className="text-[10px] font-black uppercase tracking-widest">
                       Offline scan queue
                     </p>
                     <p className="mt-1 text-xs font-bold leading-relaxed">
                       {sessionOfflineScans.length} scan{sessionOfflineScans.length === 1 ? "" : "s"} are saved on this device and must replay before review.
                     </p>
                     <button
                       type="button"
                       onClick={() => void flushOfflineScans()}
                       className="mt-3 rounded-xl border border-amber-500/30 bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
                     >
                       Retry Queue
                     </button>
                   </div>
                 ) : null}

                 <div className="space-y-4">
	                   <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Add item by lookup</label>
                   <VariantSearchInput
                     onSelect={(v) => void handleScan(v.sku)}
	                     placeholder="Search SKU or product..."
                   />
                 </div>

                 <div className="flex items-center gap-4 rounded-2xl border border-app-border/60 bg-app-surface-2 px-5 py-5 shadow-sm">
                   <AlertCircle className="text-app-text-muted opacity-40" size={18} />
                   <p className="text-[11px] font-bold text-app-text-muted leading-relaxed">
                     Scanning automatically increments the count by <span className="text-app-accent">1</span>. To adjust large quantities, use the manual edit tool in Review phase.
                   </p>
                 </div>
              </div>
            </DashboardGridCard>

            <DashboardGridCard
              title="Discovered Scans"
              subtitle={`${pendingDiscoveredCount} pending unknown code${pendingDiscoveredCount === 1 ? "" : "s"}`}
              icon={AlertCircle}
            >
              <div className="space-y-2">
                {discoveredItems.length === 0 ? (
                  <p className="rounded-2xl border border-app-border bg-app-surface px-4 py-8 text-center text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted">
                    No unknown scans captured
                  </p>
                ) : (
                  discoveredItems.slice(0, 12).map((item) => (
                    <div
                      key={item.id}
                      className="rounded-2xl border border-app-border bg-app-surface px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm font-black text-app-text">
                            {item.scanned_code}
                          </p>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                            {item.scan_source} · {item.scan_count} scan{item.scan_count === 1 ? "" : "s"} · {item.status}
                          </p>
                        </div>
                        <StatusBadge status={item.status === "pending" ? "reviewing" : "published"} />
                      </div>
                      {item.status === "pending" ? (
                        <div className="mt-3 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void updateDiscoveredItem(item, "resolved")}
                            className="rounded-lg bg-app-accent px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white"
                          >
                            Resolve
                          </button>
                          <button
                            type="button"
                            onClick={() => void updateDiscoveredItem(item, "ignored")}
                            className="rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                          >
                            Ignore
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </DashboardGridCard>
          </div>

          <DashboardGridCard 
	            title="Recent Count Feed"
	            subtitle={`Showing ${counts.length.toLocaleString()} recent row${counts.length === 1 ? "" : "s"}${activeSession.total_counted ? ` of ${activeSession.total_counted.toLocaleString()} counted` : ""}`}
            icon={ListFilter}
          >
            <div className="absolute top-4 right-6 w-64 z-10">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted opacity-40" size={14} />
              <input
                value={scanSearch}
                onChange={(e) => setScanSearch(e.target.value)}
                placeholder="Filter active feed..."
                className="ui-input h-10 w-full rounded-xl border-app-border/70 bg-app-surface pl-10 pr-4 text-xs font-bold focus:ring-4 focus:ring-app-accent/10"
              />
            </div>
          <div className="overflow-hidden rounded-[2.5rem] border border-app-border/50 bg-app-surface shadow-sm">
            {isCompactLayout ? (
              <div className="space-y-2 p-3" data-testid="physical-count-cards">
                {filteredCounts.length === 0 ? (
                  <p className="px-3 py-10 text-center text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40">
	                    No items in active filter
                  </p>
                ) : (
                  filteredCounts.map((c) => (
                    <article
                      key={c.id}
                      className="rounded-xl border border-app-border bg-app-surface-2/60 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-black uppercase italic tracking-tight text-app-text">
                            {c.product_name}
                          </p>
                          <p className="truncate text-[10px] text-app-text-muted">
                            {c.variation_label}
                          </p>
                          <p className="mt-1 font-mono text-xs font-bold text-app-text-muted">
                            {c.sku}
                          </p>
                        </div>
                        <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-app-accent/10 px-2 text-xs font-black text-app-accent">
                          {c.counted_qty}
                        </span>
                      </div>
                      <p className="mt-2 text-right text-[10px] italic text-app-text-muted opacity-60">
                        {new Date(c.last_scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </p>
                    </article>
                  ))
                )}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid="physical-count-table">
                  <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    <tr>
	                      <th className="px-6 py-4">Item</th>
                      <th className="px-6 py-4">SKU/Serial</th>
	                      <th className="px-6 py-4 text-center">Count</th>
	                      <th className="px-6 py-4 text-right">Last scanned</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border/40">
                    {filteredCounts.map((c) => (
                      <tr key={c.id} className="group hover:bg-app-surface-2/60 transition-colors">
                        <td className="px-6 py-4">
                          <p className="font-black uppercase italic tracking-tighter text-app-text group-hover:text-app-accent transition-colors">{c.product_name}</p>
                          <p className="text-[10px] text-app-text-muted opacity-60">{c.variation_label}</p>
                        </td>
                        <td className="px-6 py-4 font-mono font-bold text-app-text-muted">{c.sku}</td>
                        <td className="px-6 py-4 text-center">
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-app-accent/10 font-black text-app-accent shadow-sm">
                            {c.counted_qty}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right text-[10px] text-app-text-muted opacity-40 italic">
                          {new Date(c.last_scanned_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                        </td>
                      </tr>
                    ))}
                    {filteredCounts.length === 0 && (
                      <tr className="opacity-40">
	                        <td colSpan={4} className="px-6 py-20 text-center font-black uppercase tracking-[0.3em] text-[10px]">No items in active filter</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </DashboardGridCard>
        </div>

        <ConfirmationModal
          isOpen={showMoveConfirm}
	          title="Review this count?"
	          message={`Are you sure you want to finish counting session ${activeSession.session_number}? You will move to review before any stock changes are applied.`}
	          confirmLabel="Review Count"
          onConfirm={() => void handleConfirmMove()}
          onClose={() => setShowMoveConfirm(false)}
        />

        <ConfirmationModal
          isOpen={showCancelConfirm}
          title="Cancel Session?"
          message={`Are you sure you want to cancel session ${activeSession.session_number}? This action cannot be undone and no stock changes will be made.`}
          confirmLabel="Cancel Session"
          variant="danger"
          onConfirm={() => void handleConfirmCancel()}
          onClose={() => setShowCancelConfirm(false)}
        />
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render: Review & Publish (Phase 3)
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === "review" && activeSession) {
    return (
      <div className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
        <div className="flex flex-wrap items-center justify-between gap-6 px-2">
          <div>
            <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Count Review</h3>
	            <h2 className="text-2xl font-black tracking-tight text-app-text">Review Phase · Review Count <span className="text-app-accent">#{activeSession.session_number}</span></h2>
            <p className="mt-2 max-w-2xl text-sm font-semibold text-app-text-muted">
              Review differences before publish. Sales during the count are deducted in review; receiving must stay paused until publish or cancel.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => { setPhase("counting"); warmUpAudio(); }}
              className="flex items-center gap-2 h-12 px-6 rounded-[20px] bg-app-surface border border-app-border/40 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 transition-all"
            >
              <ChevronRight size={14} className="rotate-180" /> Resume Counting
            </button>
            <button
              type="button"
              onClick={() => setPublishConfirm(true)}
              disabled={publishBlocked || working}
              className="flex items-center gap-2 h-12 px-8 rounded-[20px] bg-emerald-600 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/20 hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
            >
              <CheckCircle size={14} /> Publish Reviewed Counts
            </button>
          </div>
        </div>

        {reviewLoadError ? (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-5 py-4 text-amber-700">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 shrink-0" size={18} />
              <div>
                <p className="text-[11px] font-black uppercase tracking-widest">Could not refresh count review</p>
                <p className="mt-1 text-sm font-bold leading-relaxed">
                  {reviewRows.length > 0
                    ? `Showing last loaded review${lastReviewLoadedAt ? ` from ${lastReviewLoadedAt}` : ""}. Retry is safe; do not publish until the review is current.`
                    : "No review rows are loaded. Retry before treating this count as ready to publish."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void loadReview(activeSession.id, reviewSearch)}
              className="rounded-xl border border-amber-500/30 bg-app-surface px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
            >
              Try Again
            </button>
          </div>
        ) : null}

        {publishOutcome ? (
          <div
            className={`flex items-start gap-3 rounded-2xl border px-5 py-4 ${
              publishOutcome.status === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
                : "border-red-500/30 bg-red-500/10 text-red-700"
            }`}
          >
            {publishOutcome.status === "success" ? (
              <CheckCircle className="mt-0.5 shrink-0" size={18} />
            ) : (
              <AlertCircle className="mt-0.5 shrink-0" size={18} />
            )}
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest">
                {publishOutcome.status === "success" ? "Publish completed" : "Publish did not finish"}
              </p>
              <p className="mt-1 text-sm font-bold leading-relaxed">{publishOutcome.message}</p>
              <p className="mt-1 text-xs font-semibold opacity-80">
                {publishOutcome.detail} · {publishOutcome.completedAt}
              </p>
            </div>
          </div>
        ) : null}

        {reviewSummary ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              [
                "What changed if published",
                `${reviewSummary.total_variants_in_scope.toLocaleString()} item${reviewSummary.total_variants_in_scope === 1 ? "" : "s"} will be checked against reviewed counts.`,
              ],
              [
                "Review status",
                unresolvedReviewCount > 0
                  ? `${unresolvedReviewCount.toLocaleString()} review item${unresolvedReviewCount === 1 ? "" : "s"} still need attention.`
                  : "No unresolved review differences are loaded.",
              ],
              [
                "Inventory impact",
                `Net change ${reviewDelta > 0 ? `+${reviewDelta}` : reviewDelta}. Missing count rows publish as zero unless corrected first.`,
              ],
              [
                "Safe recovery",
                "Resume counting or edit review rows before publish. Retrying refresh is safe and does not update live stock.",
              ],
              [
                "Receiving hold",
                "Do not receive purchase orders until this session is published or canceled.",
              ],
              [
                "Pilot follow-up",
                "Unpublished review sessions are pending operational work until a manager publishes or cancels them.",
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-app-border bg-app-surface px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
                <p className="mt-2 text-sm font-semibold text-app-text">{value}</p>
              </div>
            ))}
          </div>
        ) : null}

        {reviewSummary && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <DashboardStatsCard
              title="Items In Area"
              value={reviewSummary.total_variants_in_scope}
              icon={Package}
              trend={{ value: "In review", label: "catalog" }}
            />
            <DashboardStatsCard
              title="Counted Items"
              value={reviewSummary.total_counted}
              icon={ClipboardList}
              trend={{ value: "Aggregated", label: "volume" }}
            />
            <DashboardStatsCard
              title="Missing From Count"
              value={reviewSummary.missing_variants}
              icon={AlertCircle}
              trend={{ value: "Needs review", label: "uncounted", isUp: false }}
              color="orange"
            />
            <DashboardStatsCard
              title="Total Shrinkage"
              value={reviewSummary.total_shrinkage}
              icon={TrendingDown}
              trend={{ value: "Stock-out", label: "reconciled", isUp: false }}
              color="rose"
            />
            <DashboardStatsCard
              title="Surplus Assets"
              value={reviewSummary.total_surplus}
              icon={TrendingUp}
              trend={{ value: "Found", label: "resources", isUp: true }}
              color="green"
            />
          </div>
        )}

        {reviewSummary && reviewSummary.missing_variants > 0 && (
          <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 px-5 py-4 text-amber-700">
            <AlertCircle className="mt-0.5 shrink-0" size={18} />
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest opacity-70">
                Uncounted Items Found
              </p>
              <p className="text-sm font-bold leading-relaxed">
                {reviewSummary.missing_variants} SKU{reviewSummary.missing_variants === 1 ? "" : "s"} in this area were never counted. They are now included in review and will be set to zero unless you resume counting or enter an override.
              </p>
            </div>
          </div>
        )}

        {publishBlocked ? (
          <div className="flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-5 py-4 text-red-700">
            <AlertCircle className="mt-0.5 shrink-0" size={18} />
            <div>
              <p className="text-[11px] font-black uppercase tracking-widest">
                Publish blocked
              </p>
              <p className="mt-1 text-sm font-bold leading-relaxed">
                {pendingDiscoveredCount > 0
                  ? `${pendingDiscoveredCount} discovered scan${pendingDiscoveredCount === 1 ? "" : "s"} must be resolved or ignored. `
                  : ""}
                {zeroCostMovementCount > 0
                  ? `${zeroCostMovementCount} movement row${zeroCostMovementCount === 1 ? "" : "s"} need unit cost before accounting impact can be posted. `
                  : ""}
                {nonSaleMovementCount > 0
                  ? `${nonSaleMovementCount} non-sale inventory movement${nonSaleMovementCount === 1 ? "" : "s"} happened during the count; restart or reconcile before publish. `
                  : ""}
                {sessionOfflineScans.length > 0
                  ? `${sessionOfflineScans.length} queued offline scan${sessionOfflineScans.length === 1 ? "" : "s"} must replay before publish.`
                  : ""}
              </p>
            </div>
          </div>
        ) : null}

        <DashboardGridCard
          title="Count Differences"
          subtitle={
              reviewSummary?.rows_hidden
                ? `Showing ${reviewSummary.rows_returned?.toLocaleString() ?? REVIEW_ROW_LIMIT.toLocaleString()} of ${reviewSummary.rows_matching_filter?.toLocaleString() ?? reviewSummary.total_variants_in_scope.toLocaleString()} matching rows. Publish evaluates the full session.`
                : "Review expected stock against counted stock"
            }
          icon={ListFilter}
        >
          <div className="absolute top-4 right-6 w-64 z-10">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted opacity-40" size={14} />
            <input
              value={reviewSearch}
              onChange={(e) => setReviewSearch(e.target.value)}
              placeholder="Filter audit log..."
              className="ui-input h-10 w-full rounded-xl border-app-border/70 bg-app-surface pl-10 pr-4 text-xs font-bold focus:ring-4 focus:ring-app-accent/10"
            />
          </div>
          <div className="overflow-hidden rounded-[2.5rem] border border-app-border/50 bg-app-surface shadow-sm">
            {isCompactLayout ? (
              <div className="space-y-2 p-3" data-testid="physical-review-cards">
                {filteredReview.map((r) => (
                  <article
                    key={r.variant_id}
                    className="rounded-xl border border-app-border bg-app-surface-2/60 p-3"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-black uppercase italic tracking-tight text-app-text">
                          {r.product_name}
                        </p>
                        <p className="truncate text-[10px] text-app-text-muted">
                          {r.sku} · {r.variation_label}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCountId(r.count_id);
                          setEditQty(String(r.adjusted_qty ?? r.counted_qty));
                          setEditNote(r.review_note ?? "");
                        }}
                        className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface hover:text-app-accent"
                      >
                        <Edit3 size={16} />
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <p><span className="font-black text-app-text-muted">Expected:</span> {r.stock_at_start}</p>
                      <p><span className="font-black text-app-text-muted">Counted:</span> {r.counted_qty}</p>
                      <p><span className="font-black text-app-text-muted">Sales Since:</span> {r.sales_since_start}</p>
                      <p className="text-right">
                        <span className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-lg text-[10px] font-black uppercase tracking-widest ${
                          r.delta === 0 ? "bg-app-surface-2 text-app-text-muted" :
                          r.delta < 0 ? "bg-rose-500/10 text-rose-500 border border-rose-500/20" :
                          "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20"
                        }`}>
                          {r.delta > 0 ? `+${r.delta}` : r.delta}
                        </span>
                      </p>
                    </div>
                  </article>
                ))}
                {filteredReview.length === 0 ? (
                  <p className="px-3 py-10 text-center text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40">
                    No discrepancies in active filter
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs" data-testid="physical-review-table">
                <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
	                  <tr>
	                    <th className="px-6 py-4">Item</th>
                    <th className="px-6 py-4 text-center">Expected</th>
                    <th className="px-6 py-4 text-center text-app-accent">Counted</th>
                    <th className="px-6 py-4 text-center">Sales Since</th>
                    <th className="px-6 py-4 text-right">Variance</th>
                    <th className="px-6 py-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/40">
                  {filteredReview.map((r) => (
                    <tr key={r.variant_id} className="group hover:bg-app-surface-2/60 transition-colors">
                      <td className="px-6 py-4">
                        <p className="font-black uppercase italic tracking-tighter text-app-text group-hover:text-app-accent transition-colors">{r.product_name}</p>
                        <p className="text-[10px] text-app-text-muted opacity-60">{r.sku} · {r.variation_label}</p>
                      </td>
                      <td className="px-6 py-4 text-center font-bold text-app-text-muted">{r.stock_at_start}</td>
                      <td className="px-6 py-4 text-center font-black text-app-accent">
                        {r.counted_qty}
                        {r.adjusted_qty != null && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 text-[10px]">→{r.adjusted_qty}</span>
                        )}
                        {r.counted_qty === 0 && r.adjusted_qty == null && (
                          <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 text-[10px]">
                            not counted
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center font-bold text-app-text-muted opacity-60">{r.sales_since_start}</td>
                      <td className="px-6 py-4 text-right">
                         <span className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-xl text-[10px] font-black uppercase tracking-widest ${
                           r.delta === 0 ? 'bg-app-surface-2 text-app-text-muted' :
                           r.delta < 0 ? 'bg-rose-500/10 text-rose-500 border border-rose-500/20' :
                           'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20'
                         }`}>
                           {r.delta > 0 ? `+${r.delta}` : r.delta}
                         </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCountId(r.count_id);
                            setEditQty(String(r.adjusted_qty ?? r.counted_qty));
                            setEditNote(r.review_note ?? "");
                          }}
                          className="p-2 text-app-text-muted opacity-40 hover:text-app-accent hover:opacity-100 transition-all"
                        >
                          <Edit3 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredReview.length === 0 ? (
                    <tr className="opacity-40">
                      <td colSpan={6} className="px-6 py-20 text-center font-black uppercase tracking-[0.3em] text-[10px]">
                        No discrepancies in active filter
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            )}
          </div>
        </DashboardGridCard>

        {workspaceReportPanel}

        <div className="sticky bottom-4 z-20 rounded-2xl border border-app-border bg-app-surface/95 p-3 shadow-2xl shadow-black/15 backdrop-blur">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-semibold text-app-text-muted">
              {unresolvedReviewCount > 0
                ? `${unresolvedReviewCount.toLocaleString()} count difference${unresolvedReviewCount === 1 ? "" : "s"} still need attention before publishing.`
                : "No unresolved count differences are loaded. Publish when the review matches the count sheets; until then, this remains pending work."}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setPhase("counting"); warmUpAudio(); }}
                className="ui-btn-secondary min-h-11 px-4 text-[10px] font-black uppercase tracking-widest"
              >
                Resume Counting
              </button>
              <button
                type="button"
                onClick={() => setPublishConfirm(true)}
                disabled={publishBlocked || working}
                className="ui-btn-primary min-h-11 px-4 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
              >
                Publish Counts
              </button>
            </div>
          </div>
        </div>

        <ConfirmationModal
          isOpen={publishConfirm}
          title="Apply Reviewed Counts?"
          message={
            reviewSummary 
              ? `Publishing session ${activeSession.session_number} updates live inventory from the reviewed count levels. ${reviewSummary.total_variants_in_scope} items are in scope, ${reviewSummary.total_counted} were counted, ${reviewSummary.missing_variants} are missing from count, and the net change is ${reviewSummary.total_surplus - reviewSummary.total_shrinkage}. Sales during the count are accounted for in review, but receiving must have stayed paused.`
              : `Publishing session ${activeSession.session_number} updates live inventory from the reviewed count levels. Sales during the count are accounted for in review, but receiving must have stayed paused.`
          }
          confirmLabel="Publish Reviewed Counts"
          variant="info"
          onConfirm={() => {
            setPublishConfirm(false);
            setManagerPublishOpen(true);
          }}
          onClose={() => setPublishConfirm(false)}
        />

        <ManagerApprovalModal
          isOpen={managerPublishOpen}
          title="Publish Physical Inventory"
          message="Manager Access is required to publish reviewed counts and update live stock. This signoff is saved with the session reports."
          onClose={() => setManagerPublishOpen(false)}
          onApprove={(pin, managerId) => publishWithApproval(pin, managerId)}
        />

        {/* Edit Modal (Adjustment) */}
        {editingCountId && root && createPortal(
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 backdrop-blur-md bg-black/20 animate-in fade-in duration-300">
            <div className="w-full max-w-lg rounded-[3rem] border border-white/20 bg-app-surface p-10 shadow-2xl animate-in zoom-in duration-300">
              <div className="mb-8">
	                <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Count correction</h3>
	                <h2 className="text-2xl font-black tracking-tight text-app-text">Correct Count</h2>
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
	                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Corrected quantity</label>
                  <input
                    type="number"
                    value={editQty}
                    onChange={(e) => setEditQty(e.target.value)}
                    className="w-full h-14 bg-app-bg shadow-inner border border-app-border rounded-2xl px-6 text-xl font-black focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
	                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Reason</label>
                  <textarea
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    rows={3}
                    className="w-full bg-app-bg shadow-inner border border-app-border rounded-2xl px-6 py-4 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all outline-none resize-none"
                    placeholder="Reason for adjustment..."
                  />
                </div>
                <div className="flex gap-4 pt-4">
                  <button
                    type="button"
                    onClick={() => void applyAdjustment()}
                    className="flex-1 h-14 flex items-center justify-center gap-3 rounded-2xl bg-app-accent text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/30 hover:brightness-110 active:scale-95 transition-all"
                  >
                    Save Correction
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingCountId(null)}
                    className="h-14 px-8 rounded-2xl border border-app-border bg-app-surface-2 text-[11px] font-black uppercase tracking-[0.2em] text-app-text-muted hover:bg-app-surface transition-all"
                  >
	                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>,
          root
        )}

        <ConfirmationModal
          isOpen={showCancelConfirm}
          title="Cancel Session?"
          message={`Are you sure you want to cancel session ${activeSession?.session_number}? This action cannot be undone and no stock changes will be made.`}
          confirmLabel="Cancel Session"
          variant="danger"
          onConfirm={() => void handleConfirmCancel()}
          onClose={() => setShowCancelConfirm(false)}
        />
      </div>
    );
  }

  return <></>;
}
