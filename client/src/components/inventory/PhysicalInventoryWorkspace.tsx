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
  Archive,
  Barcode,
  Camera,
  CheckCircle,
  ChevronRight,
  ClipboardList,
  Edit3,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
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
import VariantSearchInput from "../inventory/VariantSearchInput";

const BASE_URL = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
  const map: Record<PISession["status"], { label: string; cls: string }> = {
    open: { label: "Open", cls: "bg-blue-100 text-blue-800" },
    reviewing: { label: "In Review", cls: "bg-amber-100 text-amber-800" },
    published: { label: "Published", cls: "bg-emerald-100 text-emerald-800" },
    cancelled: { label: "Cancelled", cls: "bg-app-surface-2 text-app-text-muted" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "bg-app-surface-2 text-app-text-muted" };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-widest ${cls}`}>
      {label}
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function PhysicalInventoryWorkspace() {
  const { backofficeHeaders } = useBackofficeAuth();
  const mergeH = useCallback(
    (extra?: HeadersInit): HeadersInit => {
      const base = new Headers(backofficeHeaders());
      if (extra) {
        new Headers(extra).forEach((v, k) => base.set(k, v));
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
      <div className="space-y-6">
        {/* Active session resume banner */}
        {activeSession && activeSession.status === "open" && (
          <div className="flex items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
            <div className="flex items-center gap-3">
              <ScanLine className="text-blue-600 shrink-0" size={22} />
              <div>
                <p className="text-sm font-black text-blue-900">
                  Active Session: {activeSession.session_number}
                </p>
                <p className="text-[11px] text-blue-600">
                  Last saved {fmt(activeSession.last_saved_at)} · {activeSession.total_counted ?? 0} items counted
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setPhase("counting"); void loadCounts(activeSession.id); }}
              className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-[11px] font-black uppercase tracking-widest text-white transition hover:bg-blue-700"
            >
              Resume <ChevronRight size={14} />
            </button>
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
        {!activeSession && (
          <div className="rounded-2xl border-2 border-dashed border-app-border p-6">
            {!showNewSession ? (
              <div className="text-center">
                <Package className="mx-auto mb-3 text-app-text-muted" size={36} />
                <p className="text-sm font-bold text-app-text-muted">No active inventory session</p>
                <button
                  type="button"
                  onClick={() => setShowNewSession(true)}
                  className="mt-4 flex items-center gap-2 rounded-xl bg-app-accent px-6 py-3 text-xs font-black uppercase tracking-widest text-white mx-auto transition hover:opacity-90"
                >
                  <Plus size={16} /> Start Physical Inventory
                </button>
              </div>
            ) : (
              <div className="space-y-4 max-w-lg">
                <h3 className="text-sm font-black uppercase tracking-wider text-app-text">
                  New Inventory Session
                </h3>
                <div>
                  <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Scope
                  </label>
                  <div className="flex gap-2">
                    {(["full", "category"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => { setNewScope(s); setNewCatIds([]); }}
                        className={`rounded-xl border px-4 py-2 text-xs font-black uppercase tracking-widest transition ${
                          newScope === s
                            ? "border-app-accent bg-app-accent text-white"
                            : "border-app-border bg-app-surface text-app-text-muted hover:border-app-input-border"
                        }`}
                      >
                        {s === "full" ? "Full Store" : "By Category"}
                      </button>
                    ))}
                  </div>
                </div>
                {newScope === "category" && (
                  <div>
                    <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Categories
                    </label>
                    <div className="max-h-40 overflow-y-auto space-y-1 rounded-xl border border-app-border p-2">
                      {categories.map((c) => (
                        <label key={c.id} className="flex items-center gap-2 rounded px-2 py-1 cursor-pointer hover:bg-app-surface-2">
                          <input
                            type="checkbox"
                            checked={newCatIds.includes(c.id)}
                            onChange={(e) =>
                              setNewCatIds((prev) =>
                                e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                              )
                            }
                            className="h-3.5 w-3.5 rounded border-app-input-border text-app-accent"
                          />
                          <span className="text-sm font-semibold text-app-text">{c.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-3 rounded-xl border border-app-border p-4 bg-app-surface-2/30">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Exclusion Filters</p>
                  <label className="flex items-center justify-between cursor-pointer group">
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-app-text">Exclude Reserved Stock</span>
                      <span className="text-[10px] text-app-text-muted">Subtract "Special/Wedding Order" quantities from expected count.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={newExcludeReserved}
                      onChange={(e) => setNewExcludeReserved(e.target.checked)}
                      className="h-4 w-4 rounded border-app-input-border text-app-accent focus:ring-app-accent"
                    />
                  </label>
                  <label className="flex items-center justify-between cursor-pointer group">
                    <div className="flex flex-col">
                      <span className="text-sm font-bold text-app-text">Exclude Layaway Stock</span>
                      <span className="text-[10px] text-app-text-muted">Subtract "Layaway" quantities from expected count.</span>
                    </div>
                    <input
                      type="checkbox"
                      checked={newExcludeLayaway}
                      onChange={(e) => setNewExcludeLayaway(e.target.checked)}
                      className="h-4 w-4 rounded border-app-input-border text-app-accent focus:ring-app-accent"
                    />
                  </label>
                </div>
                <div>
                  <label className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Notes (optional)
                  </label>
                  <textarea
                    value={newNotes}
                    onChange={(e) => setNewNotes(e.target.value)}
                    rows={2}
                    className="ui-input w-full resize-none"
                    placeholder="e.g. Q2 annual count — suits section first"
                  />
                </div>
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => void createSession()}
                    disabled={working || (newScope === "category" && newCatIds.length === 0)}
                    className="flex items-center gap-2 rounded-xl bg-app-accent px-5 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:opacity-90 disabled:opacity-40"
                  >
                    {working ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
                    Start Session
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowNewSession(false)}
                    className="rounded-xl border border-app-border px-4 py-2.5 text-xs font-bold text-app-text-muted transition hover:bg-app-surface-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Session History */}
        <div>
          <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Session History
          </h3>
          <div className="overflow-hidden rounded-2xl border border-app-border">
            {sessions.length === 0 ? (
              <p className="px-5 py-6 text-sm text-app-text-muted text-center">No inventory sessions yet.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-app-border bg-app-surface-2">
                  <tr>
                    {["Session", "Scope", "Status", "Started", "Items", ""].map((h) => (
                      <th key={h} className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {sessions.map((s) => (
                    <tr key={s.id} className="hover:bg-app-surface-2/70">
                      <td className="px-4 py-3 font-mono text-xs font-bold text-app-text">{s.session_number}</td>
                      <td className="px-4 py-3 text-xs font-bold text-app-text-muted capitalize">{s.scope}</td>
                      <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                      <td className="px-4 py-3 text-xs text-app-text-muted">{fmt(s.started_at)}</td>
                      <td className="px-4 py-3 font-bold text-app-text">{s.total_counted ?? 0}</td>
                      <td className="px-4 py-3">
                        {(s.status === "open" || s.status === "reviewing") && (
                          <button
                            type="button"
                            onClick={() => {
                              setActiveSession(s);
                              setShowCancelConfirm(true);
                            }}
                            className="text-red-400 hover:text-red-600"
                            title="Cancel session"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

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
      <div className="flex flex-col gap-4">
        {/* Header bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface px-5 py-4 shadow-sm">
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">
                Counting · {activeSession.session_number}
              </p>
              <p className="text-[11px] text-app-text-muted">
                {counts.length} items counted · Scope: {activeSession.scope}
              </p>
            </div>
            {/* Mode toggle */}
            <div className="flex overflow-hidden rounded-xl border border-app-border">
              {(["laser", "camera"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setScanMode(m)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${
                    scanMode === m
                      ? "bg-app-accent text-white"
                      : "bg-app-surface text-app-text-muted hover:bg-app-surface-2"
                  }`}
                >
                  {m === "laser" ? <Barcode size={13} /> : <Camera size={13} />}
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void saveSession()}
              className="flex items-center gap-1.5 rounded-xl border border-app-border px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition hover:bg-app-surface-2"
            >
              <Save size={13} /> Save for Today
            </button>
            <button
              type="button"
              onClick={() => void moveToReview()}
              disabled={counts.length === 0 || working}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white transition hover:bg-amber-600 disabled:opacity-40"
            >
              <ClipboardList size={13} /> Move to Review
            </button>
            <button
              type="button"
              onClick={() => void cancelSession()}
              className="rounded-xl border border-red-200 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-red-500 transition hover:bg-red-50"
              title="Cancel session"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Scan feedback flash */}
        {feedback && (
          <div
            className={`flex items-center gap-3 rounded-2xl px-5 py-3 text-sm font-black transition-all ${
              feedback.type === "success"
                ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                : feedback.type === "error"
                  ? "border border-red-200 bg-red-50 text-red-800"
                  : "border border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {feedback.type === "success" ? (
              <CheckCircle size={18} className="shrink-0" />
            ) : feedback.type === "error" ? (
              <AlertCircle size={18} className="shrink-0" />
            ) : (
              <AlertCircle size={18} className="shrink-0" />
            )}
            {feedback.message}
          </div>
        )}

        {/* Laser mode hint */}
        {scanMode === "laser" && (
          <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-4 py-2.5 text-xs text-blue-700">
            <Barcode size={15} className="shrink-0" />
            <span>
              <strong>Laser / HID mode active.</strong> Scan barcodes anywhere on
              the page — the system auto-detects scanner speed.
            </span>
          </div>
        )}

        {/* Camera scanner overlay */}
        {scanMode === "camera" && (
          <CameraScanner
            label="Physical Inventory — Camera Scan"
            onScan={(code) => void handleScan(code)}
            onClose={() => setScanMode("laser")}
          />
        )}

        {/* Search + count list */}
        <div className="flex flex-col gap-3 rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Inventory Lookup & Manual Entry</h3>
            <div className="flex-1 max-w-sm">
              <VariantSearchInput 
                onSelect={(v) => {
                  void handleScan(v.sku); // Re-use handleScan for standardized logic
                }}
                placeholder="Search to add product (Fuzzy lookup)…"
                className="w-full"
              />
            </div>
          </div>

          <div className="h-px bg-app-border" />

          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-app-surface-2 border border-app-border/50">
            <Search size={15} className="text-app-text-muted" />
            <input
              type="text"
              value={scanSearch}
              onChange={(e) => setScanSearch(e.target.value)}
              placeholder="Filter current counting list…"
              className="flex-1 text-sm bg-transparent outline-none placeholder:text-app-text-muted"
            />
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
          {counts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-app-text-muted">
              <ScanLine size={32} className="mb-3 opacity-40" />
              <p className="text-sm font-bold">No items scanned yet</p>
              <p className="text-xs">Start scanning barcodes to count inventory</p>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="border-b border-app-border bg-app-surface-2">
                <tr>
                  <th className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Item</th>
                  <th className="px-4 py-3 text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">Counted</th>
                  <th className="hidden sm:table-cell px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Last Scan</th>
                  <th className="hidden sm:table-cell px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Source</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {filteredCounts.map((c) => (
                  <tr key={c.id} className="hover:bg-app-surface-2/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="text-sm font-black text-app-text">{c.product_name}</p>
                      <p className="font-mono text-[10px] text-app-text-muted">{c.sku}{c.variation_label ? ` · ${c.variation_label}` : ""}</p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 font-black text-blue-800">
                        {c.counted_qty}
                      </span>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-3 text-xs text-app-text-muted">{fmt(c.last_scanned_at)}</td>
                    <td className="hidden sm:table-cell px-4 py-3">
                      <span className="inline-flex items-center gap-1 rounded-full bg-app-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase text-app-text-muted">
                        {c.scan_source === "camera" ? <Camera size={10} /> : <Barcode size={10} />}
                        {c.scan_source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <ConfirmationModal
          isOpen={showMoveConfirm}
          title="Move to Review?"
          message="Are you sure you want to move this inventory to the Review phase? You can still adjust quantities before publishing."
          confirmLabel="Move to Review"
          onConfirm={() => void handleConfirmMove()}
          onClose={() => setShowMoveConfirm(false)}
        />

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
  // Render: Review & Publish (Phase 3)
  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === "review" && activeSession) {
    return (
      <div className="flex flex-col gap-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-amber-700">
              Review · {activeSession.session_number}
            </p>
            <p className="text-[11px] text-amber-600">
              Adjust quantities if needed, then publish to apply all stock changes.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadReview(activeSession.id)}
              className="flex items-center gap-1.5 rounded-xl border border-amber-300 bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700 transition hover:bg-amber-100"
            >
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              type="button"
              onClick={() => setPublishConfirm(true)}
              disabled={working || reviewRows.length === 0}
              className="flex items-center gap-2 rounded-xl bg-app-accent px-5 py-2.5 text-[10px] font-black uppercase tracking-widest text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {working ? <Loader2 className="animate-spin" size={13} /> : <Archive size={13} />}
              Publish Inventory
            </button>
          </div>
        </div>

        <ConfirmationModal
          isOpen={publishConfirm}
          title="Publish Inventory?"
          message={
            reviewSummary 
              ? `Proceed with publishing ${reviewRows.length} variant reconciliations? (Items: ${reviewSummary.total_counted}, Shrinkage: ${reviewSummary.total_shrinkage}, Surplus: ${reviewSummary.total_surplus}). This action is permanent.`
              : "Proceed with publishing all variant reconciliations? This action is permanent."
          }
          confirmLabel="Confirm Publish"
          onConfirm={() => void publish()}
          onClose={() => setPublishConfirm(false)}
        />

        {/* Summary cards */}
        {reviewSummary && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: "Items Counted", value: reviewSummary.total_counted, icon: <ScanLine size={16} />, color: "text-app-text" },
              { label: "Shrinkage Units", value: reviewSummary.total_shrinkage, icon: <TrendingDown size={16} />, color: "text-red-600" },
              { label: "Surplus Units", value: reviewSummary.total_surplus, icon: <TrendingUp size={16} />, color: "text-emerald-600" },
              { label: "Adjusted", value: reviewRows.filter(r => r.review_status === "adjusted").length, icon: <Edit3 size={16} />, color: "text-violet-600" },
            ].map(({ label, value, icon, color }) => (
              <div key={label} className="rounded-2xl border border-app-border bg-app-surface p-4">
                <div className={`mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest ${color}`}>
                  {icon} {label}
                </div>
                <p className={`text-2xl font-black ${color}`}>{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Search */}
        <div className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2">
          <Search size={15} className="text-app-text-muted" />
          <input
            type="text"
            value={reviewSearch}
            onChange={(e) => setReviewSearch(e.target.value)}
            placeholder="Search by SKU or product name…"
            className="flex-1 text-sm outline-none placeholder:text-app-text-muted"
          />
        </div>

        {/* Review table */}
        <div className="w-full min-w-0 overflow-x-auto rounded-2xl border border-app-border bg-app-surface">
          <table className="w-full min-w-[560px] text-left text-sm md:min-w-[640px] xl:min-w-[700px]">
            <thead className="border-b border-app-border bg-app-surface-2">
              <tr>
                {["Item", "Snapshot", "Counted", "Sales−", "Final", "Delta", "Note / Adjust"].map((h) => (
                  <th key={h} className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {filteredReview.map((r) => {
                const isEditing = editingCountId === r.count_id;
                const deltaPos = r.delta > 0;
                const deltaNeg = r.delta < 0;
                return (
                  <tr key={r.count_id} className="hover:bg-app-surface-2/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-black text-app-text whitespace-nowrap">{r.product_name}</p>
                      <p className="font-mono text-[10px] text-app-text-muted">{r.sku}{r.variation_label ? ` · ${r.variation_label}` : ""}</p>
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-bold text-app-text-muted">
                      {r.stock_at_start}
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-bold text-app-text">
                      {r.counted_qty}
                      {r.adjusted_qty != null && (
                        <span className="ml-1 text-violet-600">→{r.adjusted_qty}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-app-text-muted">
                      {r.sales_since_start > 0 ? (
                        <span className="text-amber-600 font-bold">−{r.sales_since_start}</span>
                      ) : (
                        "0"
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-black text-app-text">
                      {r.final_stock}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`font-mono font-black ${deltaPos ? "text-emerald-600" : deltaNeg ? "text-red-500" : "text-app-text-muted"}`}>
                        {r.delta > 0 ? `+${r.delta}` : r.delta}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {isEditing ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            value={editQty}
                            onChange={(e) => setEditQty(e.target.value)}
                            className="w-16 rounded-lg border border-violet-300 p-1 text-center font-mono text-sm outline-none focus:ring-2 focus:ring-violet-400"
                            autoFocus
                          />
                          <input
                            type="text"
                            value={editNote}
                            onChange={(e) => setEditNote(e.target.value)}
                            placeholder="Note…"
                            className="min-w-0 flex-1 rounded-lg border border-app-border p-1 text-xs outline-none"
                          />
                          <button type="button" onClick={() => void applyAdjustment()} className="text-emerald-600 hover:text-emerald-800"><CheckCircle size={16} /></button>
                          <button type="button" onClick={() => setEditingCountId(null)} className="text-app-text-muted hover:text-app-text-muted"><X size={14} /></button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {r.review_note && (
                            <span className="truncate max-w-[120px] text-[10px] text-app-text-muted italic">{r.review_note}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => { setEditingCountId(r.count_id); setEditQty(String(r.adjusted_qty ?? r.counted_qty)); setEditNote(r.review_note ?? ""); }}
                            className="text-app-text-muted hover:text-violet-600 transition-colors"
                            title="Adjust quantity"
                          >
                            <Edit3 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

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

  return null;
}
