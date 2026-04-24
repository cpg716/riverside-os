import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { 
  Loader2, 
  Scissors, 
  CheckCircle2, 
  Clock, 
  Package,
  Calendar as CalendarIcon,
  AlertTriangle,
  ClipboardList,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";

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
  linked_transaction_id: string | null;
  linked_transaction_display_id: string | null;
  source_type: string | null;
  item_description: string | null;
  work_requested: string | null;
  source_transaction_id: string | null;
  source_transaction_line_id: string | null;
  source_sku: string | null;
  charge_amount: string | number | null;
  intake_channel: string;
  source_snapshot: Record<string, unknown> | null;
  created_at: string;
};

const STATUS_FILTERS = ["all", "intake", "in_work", "ready", "picked_up"] as const;
const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "current_cart_item", label: "Current sale" },
  { value: "catalog_item", label: "Stock/catalog item" },
  { value: "existing_order", label: "Existing order" },
  { value: "past_transaction_line", label: "Past purchase" },
  { value: "custom_item", label: "Custom/manual item" },
] as const;
const DUE_FILTERS = [
  { value: "all", label: "All due dates" },
  { value: "due_today", label: "Due today" },
  { value: "overdue", label: "Overdue" },
  { value: "ready", label: "Ready" },
] as const;

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const isOpenWorkStatus = (status: string) => status !== "ready" && status !== "picked_up";
const fulfillmentLooksLikeOrder = (snapshot: Record<string, unknown> | null | undefined) => {
  const fulfillment = String(snapshot?.fulfillment ?? "").toLowerCase();
  return ["special_order", "wedding_order", "custom", "layaway", "order"].includes(fulfillment);
};
const isExistingOrderSource = (row: AlterationRow) =>
  row.source_type === "past_transaction_line" && fulfillmentLooksLikeOrder(row.source_snapshot);
const isDueToday = (row: AlterationRow, now = new Date()) => {
  if (!row.due_at || !isOpenWorkStatus(row.status)) return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() === startOfLocalDay(now).getTime();
};
const isOverdue = (row: AlterationRow, now = new Date()) => {
  if (!row.due_at || !isOpenWorkStatus(row.status)) return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() < startOfLocalDay(now).getTime();
};

const alterationSourceLabel = (row: Pick<AlterationRow, "source_type" | "source_snapshot">) => {
  if (row.source_type === "past_transaction_line" && fulfillmentLooksLikeOrder(row.source_snapshot)) {
    return "Existing order";
  }
  switch (row.source_type) {
    case "current_cart_item":
      return "Current sale";
    case "past_transaction_line":
      return "Past purchase";
    case "catalog_item":
      return "Stock/catalog item";
    case "custom_item":
      return "Custom/manual item";
    default:
      return "Custom/manual item";
  }
};

const formatCharge = (amount: string | number | null | undefined) => {
  if (amount == null || amount === "") return "Free / included";
  const parsed = Number(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) return "Free / included";
  return `Charge noted: ${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(parsed)}`;
};

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
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [dueFilter, setDueFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations`, { headers: apiAuth() });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as AlterationRow[]);
    } catch {
      toast("Could not load alterations.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, toast]);

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

  const matchesSourceFilter = (row: AlterationRow) => {
    if (sourceFilter === "all") return true;
    if (sourceFilter === "existing_order") return isExistingOrderSource(row);
    if (sourceFilter === "past_transaction_line") {
      return row.source_type === "past_transaction_line" && !isExistingOrderSource(row);
    }
    return row.source_type === sourceFilter;
  };

  const matchesDueFilter = (row: AlterationRow) => {
    switch (dueFilter) {
      case "due_today":
        return isDueToday(row);
      case "overdue":
        return isOverdue(row);
      case "ready":
        return row.status === "ready";
      default:
        return true;
    }
  };

  const visibleRows = rows.filter((row) => {
    const statusMatches = filter === "all" || row.status === filter;
    return statusMatches && matchesSourceFilter(row) && matchesDueFilter(row);
  });

  const workbenchSections = [
    {
      id: "overdue",
      title: "Overdue",
      subtitle: "Open garment work past the promised due date.",
      icon: AlertTriangle,
      rows: visibleRows.filter((row) => isOverdue(row)),
      tone: "text-red-700 bg-red-500/10 border-red-500/20",
    },
    {
      id: "due_today",
      title: "Due Today",
      subtitle: "Open garment work due today.",
      icon: CalendarIcon,
      rows: visibleRows.filter((row) => isDueToday(row) && !isOverdue(row)),
      tone: "text-amber-700 bg-amber-500/10 border-amber-500/20",
    },
    {
      id: "ready",
      title: "Ready for Pickup",
      subtitle: "Completed alteration work waiting for the customer.",
      icon: CheckCircle2,
      rows: visibleRows.filter((row) => row.status === "ready"),
      tone: "text-emerald-700 bg-emerald-500/10 border-emerald-500/20",
    },
    {
      id: "intake",
      title: "Intake / Not Started",
      subtitle: "New alteration work that still needs tailor attention.",
      icon: ClipboardList,
      rows: visibleRows.filter(
        (row) => row.status === "intake" && !isDueToday(row) && !isOverdue(row),
      ),
      tone: "text-sky-700 bg-sky-500/10 border-sky-500/20",
    },
    {
      id: "in_work",
      title: "In Work",
      subtitle: "Garments currently being altered.",
      icon: Scissors,
      rows: visibleRows.filter(
        (row) => row.status === "in_work" && !isDueToday(row) && !isOverdue(row),
      ),
      tone: "text-violet-700 bg-violet-500/10 border-violet-500/20",
    },
  ];

  const sourceContextLabel = (row: AlterationRow) => {
    if (!row.source_transaction_id && !row.source_transaction_line_id) return null;
    const display = row.linked_transaction_display_id ?? row.source_transaction_id?.slice(0, 8).toUpperCase();
    return `Source ${display ?? "transaction"}${row.source_transaction_line_id ? " / garment line" : ""}`;
  };

  const renderAlterationCard = (r: AlterationRow) => (
    <div
      key={r.id}
      ref={(el) => { rowRefs.current[r.id] = el; }}
      data-testid="alteration-workbench-card"
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
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                 <div className={`px-2 py-0.5 rounded-lg border text-[9px] font-black uppercase tracking-widest ${getStatusColor(r.status)}`}>
                    {r.status.replace("_", " ")}
                 </div>
                 <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                   {alterationSourceLabel(r)}
                 </span>
                 <span className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-700">
                   {formatCharge(r.charge_amount)}
                 </span>
                 {r.due_at && (
                   <div className="flex items-center gap-1.5 text-app-text-muted">
                     <Clock size={12} className={isOverdue(r) ? "text-red-500" : ""} />
                     <span className="text-[10px] font-bold tabular-nums">
                       Due {new Date(r.due_at).toLocaleDateString()}
                     </span>
                   </div>
                 )}
              </div>
           </div>
        </div>

        <div className="flex flex-col items-end gap-1 font-mono text-[10px] text-app-text-muted opacity-40">
           <span>ALT-{r.id.slice(0, 8).toUpperCase()}</span>
        </div>
      </div>

      {r.notes && (
        <div className="rounded-xl bg-app-surface-2/60 border border-app-border/40 p-3 italic text-xs text-app-text/80 shadow-inner">
           {r.notes}
        </div>
      )}

      <div className="grid gap-2 rounded-xl border border-app-border/40 bg-app-surface-2/60 p-3 text-xs shadow-inner sm:grid-cols-2">
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Garment
          </p>
          <p className="mt-1 font-bold text-app-text">
            {r.item_description || "Garment not specified"}
          </p>
          {r.source_sku ? (
            <p className="mt-0.5 font-mono text-[10px] text-app-text-muted">
              SKU {r.source_sku}
            </p>
          ) : null}
        </div>
        <div>
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Work Requested
          </p>
          <p className="mt-1 font-bold text-app-text">
            {r.work_requested || "Work details not specified"}
          </p>
        </div>
        {sourceContextLabel(r) ? (
          <div className="sm:col-span-2 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
            {sourceContextLabel(r)}
          </div>
        ) : null}
      </div>

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
  );

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
            Garment-based workbench for alteration attention by due date, status, and source item. Order details appear only when they describe the source garment.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex gap-2 bg-app-surface-2 p-1 rounded-2xl border border-app-border shadow-inner">
             {DUE_FILTERS.map(f => (
               <button
                 key={f.value}
                 type="button"
                 data-testid={`alterations-due-filter-${f.value}`}
                 onClick={() => setDueFilter(f.value)}
                 className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                   dueFilter === f.value
                    ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                    : "text-app-text-muted hover:text-app-text"
                 }`}
               >
                 {f.label}
               </button>
             ))}
          </div>
          <div className="flex justify-end gap-2">
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              data-testid="alterations-source-filter"
              className="ui-input h-9 rounded-xl py-1 text-[10px] font-black uppercase tracking-widest"
              aria-label="Alteration source filter"
            >
              {SOURCE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              data-testid="alterations-status-filter"
              className="ui-input h-9 rounded-xl py-1 text-[10px] font-black uppercase tracking-widest"
              aria-label="Alteration status filter"
            >
              {STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {status.replace("_", " ")}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {/* List View */}
        <section className="flex h-full min-h-0 flex-col bg-app-surface-2/40 rounded-[40px] border border-app-border/40 p-6 shadow-inner ring-1 ring-black/[0.02]">
          <div className="flex items-center justify-between mb-4 px-2">
             <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
               Garment Workbench ({visibleRows.length})
             </h3>
             <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
               {rows.length} total loaded
             </p>
          </div>
          
          <div className="flex-1 overflow-y-auto pr-2 -mr-2 space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 opacity-40">
                <Loader2 size={32} className="animate-spin text-app-accent" />
                <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Hydrating queue…</p>
              </div>
            ) : visibleRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4 grayscale opacity-30">
                <Package size={48} />
                <p className="text-sm font-black uppercase tracking-widest text-center">No garment work matched these filters.</p>
              </div>
            ) : (
              workbenchSections.map((section) => {
                const Icon = section.icon;
                return (
                  <section
                    key={section.id}
                    data-testid={`alteration-workbench-section-${section.id}`}
                    className="rounded-3xl border border-app-border/60 bg-app-surface/70 p-4 shadow-sm"
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-2xl border ${section.tone}`}>
                          <Icon size={17} />
                        </div>
                        <div>
                          <h4 className="text-sm font-black uppercase tracking-widest text-app-text">
                            {section.title}
                          </h4>
                          <p className="text-[10px] font-semibold text-app-text-muted">
                            {section.subtitle}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black tabular-nums text-app-text">
                        {section.rows.length}
                      </span>
                    </div>
                    {section.rows.length > 0 ? (
                      <div className="space-y-3">
                        {section.rows.map(renderAlterationCard)}
                      </div>
                    ) : (
                      <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2/70 px-4 py-3 text-xs font-semibold text-app-text-muted">
                        No garments in this section.
                      </p>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
