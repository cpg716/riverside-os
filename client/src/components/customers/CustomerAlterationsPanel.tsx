import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { 
  Loader2, 
  Scissors, 
  CheckCircle2, 
  Clock, 
  Package,
  Calendar as CalendarIcon,
  UserPlus
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import CustomerSearchInput from "../ui/CustomerSearchInput";

const baseUrl = getBaseUrl();

type AlterationRow = {
  id: string;
  customer_id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_code: string | null;
  status: string;
  due_at: string | null;
  notes: string | null;
  created_at: string;
};

const STATUS_FILTERS = ["all", "intake", "in_work", "ready", "picked_up"] as const;

export default function CustomerAlterationsPanel({
  apiAuth,
  highlightAlterationId,
  onHighlightConsumed,
}: {
  apiAuth: () => HeadersInit;
  highlightAlterationId?: string | null;
  onHighlightConsumed?: () => void;
}) {
  const { toast } = useToast();
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [rows, setRows] = useState<AlterationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = filter !== "all" ? `?status=${filter}` : "";
      const res = await fetch(`${baseUrl}/api/alterations${q}`, { headers: apiAuth() });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as AlterationRow[]);
    } catch {
      toast("Could not load alterations.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, toast, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = highlightAlterationId?.trim();
    if (!id || rows.length === 0) return;
    if (!rows.some((r) => r.id === id)) return;
    const el = rowRefs.current[id];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    onHighlightConsumed?.();
  }, [highlightAlterationId, rows, onHighlightConsumed]);

  const createOrder = async () => {
    if (!selectedCustomerId) {
      toast("Select a customer first.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          customer_id: selectedCustomerId,
          notes: notes.trim() || null,
          due_at: dueAt ? new Date(dueAt).toISOString() : null,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Create failed", "error");
        return;
      }
      toast("Alteration order created", "success");
      setNotes("");
      setDueAt("");
      setSelectedCustomerId("");
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Update failed", "error");
        return;
      }
      toast(`Status updated to ${status.replace("_", " ")}`, "success");
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "intake": return "text-sky-600 bg-sky-500/10 border-sky-500/20";
      case "in_work": return "text-amber-600 bg-amber-500/10 border-amber-500/20";
      case "ready": return "text-emerald-600 bg-emerald-500/10 border-emerald-500/20";
      case "picked_up": return "text-app-text-muted bg-app-surface-3 border-app-border";
      default: return "text-app-text-muted bg-app-surface-3 border-app-border";
    }
  };

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col gap-6 p-6 overflow-hidden">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Scissors size={14} className="text-app-accent opacity-60" />
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
              Tailoring Workflow
            </p>
          </div>
          <h2 className="text-3xl font-black text-app-text tracking-tight">Alterations Hub</h2>
          <p className="mt-2 max-w-2xl text-xs font-semibold leading-relaxed text-app-text-muted">
            Standalone tailoring queue for intake, status, due dates, and notes. Register checkout-linked alteration revenue is handled separately.
          </p>
        </div>
        
        <div className="flex gap-2 bg-app-surface-2 p-1 rounded-2xl border border-app-border shadow-inner">
           {STATUS_FILTERS.map(f => (
             <button
               key={f}
               type="button"
               onClick={() => setFilter(f)}
               className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                 filter === f 
                  ? "bg-app-accent text-white shadow-lg shadow-app-accent/20" 
                  : "text-app-text-muted hover:text-app-text"
               }`}
             >
               {f.replace("_", " ")}
             </button>
           ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-h-0 flex-1">
        {/* Creation Panel */}
        <section className="lg:col-span-1 flex flex-col gap-4">
          <div className="rounded-[32px] border border-app-border bg-app-surface shadow-2xl p-6 ring-1 ring-black/5">
            <div className="flex items-center gap-3 mb-6">
               <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-accent/10 border border-app-accent/20 text-app-accent">
                 <UserPlus size={20} />
               </div>
               <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                 New Standalone Job
               </h3>
            </div>

            <div className="space-y-6">
                <div className="space-y-2">
                  <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Customer Search</span>
                  <CustomerSearchInput 
                    onSelect={(c) => setSelectedCustomerId(c.id)}
                    placeholder="Search by name or phone…"
                  />
                  {selectedCustomerId && (
                    <div className="mt-2 px-3 py-2 bg-emerald-500/5 border border-emerald-500/10 rounded-xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                       <CheckCircle2 size={12} className="text-emerald-600" />
                       <span className="text-[10px] font-black uppercase text-emerald-700">Customer Linked</span>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-4">
                  <label className="block space-y-2">
                    <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted flex items-center gap-2">
                      <CalendarIcon size={12} className="opacity-40" />
                      Target Due Date
                    </span>
                    <input
                      type="date"
                      value={dueAt}
                      onChange={(e) => setDueAt(e.target.value)}
                      className="ui-input w-full font-bold text-sm h-12 rounded-2xl bg-app-surface-2 border-transparent focus:border-app-accent"
                    />
                  </label>
                </div>

                <label className="block space-y-2">
                  <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">Job Notes</span>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Describe the alterations needed…"
                    className="ui-input mt-1 min-h-[120px] w-full text-sm rounded-2xl bg-app-surface-2 border-transparent focus:border-app-accent p-4"
                  />
                </label>

                <button
                  type="button"
                  disabled={busy || !selectedCustomerId}
                  onClick={() => void createOrder()}
                  className="ui-btn-primary w-full h-14 rounded-2xl border-b-8 border-app-accent-dark bg-app-accent text-[11px] font-black uppercase tracking-[0.2em] shadow-xl shadow-app-accent/20 transition-all hover:scale-[1.02] active:scale-[0.98] active:translate-y-1 active:border-b-2 disabled:opacity-50 disabled:grayscale"
                >
                  {busy ? <Loader2 size={18} className="animate-spin mx-auto" /> : "Initiate Work Order"}
                </button>
            </div>
          </div>
        </section>

        {/* List View */}
        <section className="lg:col-span-2 flex flex-col min-h-0 bg-app-surface-2/40 rounded-[40px] border border-app-border/40 p-6 shadow-inner ring-1 ring-black/[0.02]">
          <div className="flex items-center justify-between mb-4 px-2">
             <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
               Operational Queue ({rows.length})
             </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-2 -mr-2 space-y-3">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 opacity-40">
                <Loader2 size={32} className="animate-spin text-app-accent" />
                <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Hydrating queue…</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 grayscale opacity-30">
                <Package size={48} />
                <p className="text-sm font-black uppercase tracking-widest text-center">No active work orders matched filters.</p>
              </div>
            ) : (
              rows.map((r) => (
                <div
                  key={r.id}
                  ref={(el) => { rowRefs.current[r.id] = el; }}
                  className={`group relative flex flex-col gap-4 rounded-3xl border border-app-border bg-app-surface p-5 transition-all hover:shadow-2xl hover:shadow-black/5 hover:-translate-y-0.5 ${
                    highlightAlterationId === r.id ? "ring-2 ring-app-accent shadow-2xl" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-4">
                       <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-surface-2 border border-app-border shadow-inner font-black text-app-text text-sm">
                          {r.customer_first_name?.[0]}{r.customer_last_name?.[0]}
                       </div>
                       <div className="min-w-0">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-50 mb-0.5">#{r.customer_code}</p>
                          <h4 className="font-black text-app-text text-lg leading-none truncate">
                            {r.customer_first_name} {r.customer_last_name}
                          </h4>
                          <div className="flex items-center gap-3 mt-1.5">
                             <div className={`px-2 py-0.5 rounded-lg border text-[9px] font-black uppercase tracking-widest ${getStatusColor(r.status)}`}>
                                {r.status.replace("_", " ")}
                             </div>
                             {r.due_at && (
                               <div className="flex items-center gap-1.5 text-app-text-muted">
                                 <Clock size={12} className={new Date(r.due_at) < new Date() ? "text-red-500" : ""} />
                                 <span className="text-[10px] font-bold tabular-nums">
                                   Due {new Date(r.due_at).toLocaleDateString()}
                                 </span>
                               </div>
                             )}
                          </div>
                       </div>
                    </div>
                    
                    <div className="flex flex-col items-end gap-1 font-mono text-[10px] text-app-text-muted opacity-40">
                       <span>ORD-{r.id.slice(0, 8).toUpperCase()}</span>
                    </div>
                  </div>

                  {r.notes && (
                    <div className="rounded-xl bg-app-surface-2/60 border border-app-border/40 p-3 italic text-xs text-app-text/80 shadow-inner">
                       {r.notes}
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-app-border/40 pt-4">
                     <p className="text-[9px] font-bold text-app-text-muted uppercase tracking-tighter">Created {new Date(r.created_at).toLocaleString()}</p>
                     
                     <div className="flex items-center gap-2">
                        {["in_work", "ready", "picked_up"].map((s) => (
                          <button
                            key={s}
                            type="button"
                            disabled={busy || r.status === s}
                            onClick={() => void setStatus(r.id, s)}
                            className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-tight transition-all border ${
                              r.status === s 
                                ? "bg-app-accent text-white border-transparent" 
                                : "bg-app-surface-2 border-app-border text-app-text hover:bg-app-accent hover:text-white"
                            }`}
                          >
                            {s.replace("_", " ")}
                          </button>
                        ))}
                     </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
