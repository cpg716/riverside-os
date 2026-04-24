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
import {
  AlertCircle,
  Barcode,
  Camera,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Edit3,
  ListFilter,
  Loader2,
  Package,
  Plus,
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
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import VariantSearchInput from "../ui/VariantSearchInput";

const BASE_URL = getBaseUrl();

// ── Types ─────────────────────────────────────────────────────────────────────

interface PISession {
  id: string;
  session_number: string;
  status: "open" | "reviewing" | "published" | "cancelled";
  scope: "full" | "category";
  category_ids: string[];
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
  final_stock: number;
  delta: number;
  review_status: string;
  review_note: string | null;
}

interface ReviewSummary {
  total_counted: number;
  total_variants_in_scope: number;
  missing_variants: number;
  total_shrinkage: number;
  total_surplus: number;
}

interface ScanFeedback {
  type: "success" | "warning" | "error";
  message: string;
}

interface Category {
  id: string;
  name: string;
}

type Phase = "manager" | "counting" | "review";
type ScanMode = "laser" | "camera";

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

  // ── Counting state
  const [counts, setCounts] = useState<CountRow[]>([]);
  const [scanMode, setScanMode] = useState<ScanMode>("laser");
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [scanSearch, setScanSearch] = useState("");
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Review state
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [editingCountId, setEditingCountId] = useState<string | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editNote, setEditNote] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  // Re-using ConfirmationModal for publish confirm as well

  // ── New Session form state
  const [showNewSession, setShowNewSession] = useState(false);
  const [newScope, setNewScope] = useState<"full" | "category">("full");
  const [newCatIds, setNewCatIds] = useState<string[]>([]);
  const [newExcludeReserved, setNewExcludeReserved] = useState(false);
  const [newExcludeLayaway, setNewExcludeLayaway] = useState(false);
  const [newNotes, setNewNotes] = useState("");

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
        setPhase(data.status === "reviewing" ? "review" : "manager");
      }
    }
    if (listRes.ok) {
      const data = (await listRes.json()) as { sessions: PISession[] };
      setSessions(data.sessions);
    }
    if (catRes.ok) {
      setCategories((await catRes.json()) as Category[]);
    }
  }, [mergeH]);

  useEffect(() => { void loadData(); }, [loadData]);

  const loadCounts = useCallback(async (sessionId: string) => {
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${sessionId}`,
      { headers: mergeH() },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { session: PISession; counts: CountRow[] };
    setCounts(data.counts);
  }, [mergeH]);

  const loadReview = useCallback(async (sessionId: string) => {
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${sessionId}/review`,
      { headers: mergeH() },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { rows: ReviewRow[]; summary: ReviewSummary };
    setReviewRows(data.rows);
    setReviewSummary(data.summary);
  }, [mergeH]);

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

  const handleScan = useCallback(
    async (code: string) => {
      if (!activeSession || activeSession.status !== "open") return;

      // Resolve the code against inventory
      const resolveRes = await fetch(
        `${BASE_URL}/api/inventory/scan-resolve?code=${encodeURIComponent(code)}`,
      );

      if (!resolveRes.ok) {
        playScanError();
        showFeedback({ type: "error", message: `NOT FOUND: ${code}` });
        return;
      }

      const resolved = (await resolveRes.json()) as {
        variant_id: string;
        sku: string;
        product_name: string;
      };

      // Add to session count
      const countRes = await fetch(
        `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/counts`,
        {
          method: "POST",
          headers: mergeH({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            variant_id: resolved.variant_id,
            quantity: 1,
            source: scanMode,
          }),
        },
      );

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
            return next;
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
              scan_source: scanMode,
            },
            ...prev,
          ];
        });
      } else {
        playScanWarning();
        showFeedback({ type: "warning", message: "Count update failed" });
      }
    },
    [activeSession, scanMode, showFeedback, mergeH],
  );

  // Wire HID scanner hook — only active in counting phase with laser mode
  useScanner({
    onScan: (code) => void handleScan(code),
    enabled: phase === "counting" && scanMode === "laser",
  });

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
      setNewNotes("");
      setNewCatIds([]);
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
    }
  };

  const publish = async () => {
    if (!activeSession) return;
    setWorking(true);
    setPublishConfirm(false);
    const res = await fetch(
      `${BASE_URL}/api/inventory/physical/sessions/${activeSession.id}/publish`,
      { method: "POST", headers: mergeH() },
    );
    if (res.ok) {
      // result not used in UI yet
      setActiveSession((prev) => prev ? { ...prev, status: "published" } : prev);
      await loadData();
    } else {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Publish failed", "error");
    }
    setWorking(false);
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

  // ─────────────────────────────────────────────────────────────────────────────
   if (phase === "manager") {
    return (
      <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-6 duration-700">
        <div className="px-1">
          <h2 className="text-2xl font-black tracking-tight text-app-text">Physical Inventory</h2>
        </div>

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
                  Review and publish to apply stock changes.
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
            title="Registry Initialization"
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
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Session Logic</label>
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
                          {s === "full" ? "Full Catalog" : "Taxonomy Filter"}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Exclusion Logic</label>
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
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Internal Notes</label>
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
                    Initialize Count Session
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
          subtitle="Manage active and historical takes"
          icon={Settings}
        >
          <div className="overflow-hidden rounded-[2.5rem] border border-app-border/50 bg-app-surface shadow-sm">
            {sessions.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center opacity-40 text-center">
                <ClipboardList className="mb-3" size={32} />
                <p className="text-[10px] font-black uppercase tracking-[0.3em]">No count history</p>
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                  <tr>
                    <th className="px-6 py-4">Internal Serial</th>
                    <th className="px-6 py-4">Scope</th>
                    <th className="px-6 py-4">Status</th>
                    <th className="px-6 py-4">Initialization</th>
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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DashboardGridCard>

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
            <h2 className="text-2xl font-black tracking-tight text-app-text">Counting Phase · <span className="text-app-accent">#{activeSession.session_number}</span></h2>
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
                disabled={counts.length === 0 || working}
                className="flex items-center gap-2 h-full px-8 rounded-[20px] bg-amber-500 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-amber-500/20 hover:brightness-110 active:scale-95 transition-all disabled:opacity-40"
              >
                <ClipboardList size={14} /> Finish & Audit
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
              title="Scanner Console"
              subtitle={scanMode === 'laser' ? 'Point & Shoot Interface' : 'Mobile Vision Active'}
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
                        <p className="text-[10px] font-black uppercase tracking-widest opacity-60">Session Feedback</p>
                        <p className="text-xs font-black tracking-tight">{feedback.message}</p>
                     </div>
                   </div>
                 )}

                 <div className="space-y-4">
                   <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Manual Resource Injection</label>
                   <VariantSearchInput
                     onSelect={(v) => void handleScan(v.sku)}
                     placeholder="Search SKU or Product..."
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
          </div>

          <DashboardGridCard 
            title="Registry Feed"
            subtitle={`${counts.length} unique resources captured`}
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
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    <tr>
                      <th className="px-6 py-4">Resource</th>
                      <th className="px-6 py-4">SKU/Serial</th>
                      <th className="px-6 py-4 text-center">Volume</th>
                      <th className="px-6 py-4 text-right">Last Sync</th>
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
                          {new Date(c.last_scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                      </tr>
                    ))}
                    {filteredCounts.length === 0 && (
                      <tr className="opacity-40">
                        <td colSpan={4} className="px-6 py-20 text-center font-black uppercase tracking-[0.3em] text-[10px]">No resources captured in active filter</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </DashboardGridCard>
        </div>

        <ConfirmationModal
          isOpen={showMoveConfirm}
          title="Move to Audit?"
          message={`Are you sure you want to finish counting session ${activeSession.session_number}? You will transition to the review phase to reconcile discrepancies.`}
          confirmLabel="Procede to Audit"
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
            <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Audit & Reconciliation</h3>
            <h2 className="text-2xl font-black tracking-tight text-app-text">Review Phase · <span className="text-app-accent">#{activeSession.session_number}</span></h2>
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
              className="flex items-center gap-2 h-12 px-8 rounded-[20px] bg-emerald-600 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/20 hover:brightness-110 active:scale-95 transition-all"
            >
              <CheckCircle size={14} /> Commit Changes
            </button>
          </div>
        </div>

        {reviewSummary && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <DashboardStatsCard
              title="Scope Variants"
              value={reviewSummary.total_variants_in_scope}
              icon={Package}
              trend={{ value: "In review", label: "catalog" }}
            />
            <DashboardStatsCard
              title="Counted Resources"
              value={reviewSummary.total_counted}
              icon={ClipboardList}
              trend={{ value: "Aggregated", label: "volume" }}
            />
            <DashboardStatsCard
              title="Missing In Scope"
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
                Incomplete Scope Surfaced
              </p>
              <p className="text-sm font-bold leading-relaxed">
                {reviewSummary.missing_variants} in-scope SKU{reviewSummary.missing_variants === 1 ? "" : "s"} were never counted. They are now included in review and will reconcile to zero unless you resume counting or enter an override.
              </p>
            </div>
          </div>
        )}

        <DashboardGridCard 
          title="Discrepancy Audit"
          subtitle="Review variance between expected and counted levels"
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
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-app-surface-2 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                  <tr>
                    <th className="px-6 py-4">Resource Identity</th>
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
                </tbody>
              </table>
            </div>
          </div>
        </DashboardGridCard>

        <ConfirmationModal
          isOpen={publishConfirm}
          title="Apply Reconciled Logic?"
          message={
            reviewSummary 
              ? `Publishing session ${activeSession.session_number} will overwrite current inventory with reviewed levels. (${reviewSummary.total_variants_in_scope} scoped variants, ${reviewSummary.total_counted} counted, ${reviewSummary.missing_variants} missing in scope, delta ${reviewSummary.total_surplus - reviewSummary.total_shrinkage}). Permanent.`
              : `Publishing session ${activeSession.session_number} will overwrite the current catalog stock levels. Permanent.`
          }
          confirmLabel="Commit Changes"
          variant="info"
          onConfirm={() => void publish()}
          onClose={() => setPublishConfirm(false)}
        />

        {/* Edit Modal (Adjustment) */}
        {editingCountId && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-md bg-black/20 animate-in fade-in duration-300">
            <div className="w-full max-w-lg rounded-[3rem] border border-white/20 bg-app-surface p-10 shadow-2xl animate-in zoom-in duration-300">
              <div className="mb-8">
                <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Discrepancy Correction</h3>
                <h2 className="text-2xl font-black tracking-tight text-app-text">Adjust Counted Resource</h2>
              </div>
              
              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Manually Overridden Qty</label>
                  <input
                    type="number"
                    value={editQty}
                    onChange={(e) => setEditQty(e.target.value)}
                    className="w-full h-14 bg-app-bg shadow-inner border border-app-border rounded-2xl px-6 text-xl font-black focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40 ml-2">Audit Exception Note</label>
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
                    Abort
                  </button>
                </div>
              </div>
            </div>
          </div>
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
