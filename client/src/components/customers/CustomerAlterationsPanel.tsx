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
  Search,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

type AlterationRow = {
  id: string;
  customer_id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_code: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_address_line1: string | null;
  customer_city: string | null;
  customer_state: string | null;
  customer_postal_code: string | null;
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

const customerName = (row: AlterationRow) =>
  `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim() ||
  "Unassigned customer";

const rowMatchesSearch = (row: AlterationRow, search: string) => {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    row.id,
    customerName(row),
    row.customer_code,
    row.customer_phone,
    row.customer_email,
    row.customer_address_line1,
    row.customer_city,
    row.customer_state,
    row.customer_postal_code,
    row.item_description,
    row.work_requested,
    row.notes,
    row.source_sku,
    row.linked_transaction_display_id,
    row.source_transaction_id,
    alterationSourceLabel(row),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
};

export default function CustomerAlterationsPanel({
  apiAuth,
  customerId,
  highlightAlterationId,
  onHighlightConsumed,
}: {
  apiAuth: () => HeadersInit;
  customerId?: string | null;
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
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (customerId) params.set("customer_id", customerId);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`${baseUrl}/api/alterations${suffix}`, { headers: apiAuth() });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as AlterationRow[]);
    } catch {
      toast("Could not load alterations.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, customerId, debouncedSearch, toast]);

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
    return statusMatches && matchesSourceFilter(row) && matchesDueFilter(row) && rowMatchesSearch(row, search);
  });

  const summaryCards = [
    {
      id: "overdue",
      label: "Overdue",
      value: rows.filter((row) => isOverdue(row)).length,
      icon: AlertTriangle,
      tint: "ui-tint-danger",
      color: "text-app-danger",
      bg: "bg-app-danger/8",
      border: "border-app-danger/16",
      onClick: () => {
        setDueFilter("overdue");
        setFilter("all");
      },
    },
    {
      id: "due_today",
      label: "Due Today",
      value: rows.filter((row) => isDueToday(row)).length,
      icon: CalendarIcon,
      tint: "ui-tint-warning",
      color: "text-app-warning",
      bg: "bg-app-warning/8",
      border: "border-app-warning/16",
      onClick: () => {
        setDueFilter("due_today");
        setFilter("all");
      },
    },
    {
      id: "ready",
      label: "Ready for Pickup",
      value: rows.filter((row) => row.status === "ready").length,
      icon: CheckCircle2,
      tint: "ui-tint-success",
      color: "text-app-success",
      bg: "bg-app-success/8",
      border: "border-app-success/16",
      onClick: () => {
        setDueFilter("ready");
        setFilter("all");
      },
    },
    {
      id: "open",
      label: "Total Open",
      value: rows.filter((row) => row.status !== "picked_up").length,
      icon: Scissors,
      tint: "ui-tint-accent",
      color: "text-app-accent",
      bg: "bg-app-accent/8",
      border: "border-app-accent/16",
      onClick: () => {
        setDueFilter("all");
        setFilter("all");
      },
    },
  ];

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
      id: "in_work",
      title: "In Work",
      subtitle: "Garments currently being altered.",
      icon: Scissors,
      rows: visibleRows.filter(
        (row) => row.status === "in_work" && !isDueToday(row) && !isOverdue(row),
      ),
      tone: "text-violet-700 bg-violet-500/10 border-violet-500/20",
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
      className={`group relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border border-app-border bg-app-surface p-4 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 ${
        highlightAlterationId === r.id ? "ring-2 ring-app-accent shadow-2xl" : ""
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
           <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-sm font-black text-app-text shadow-inner">
              {r.customer_first_name?.[0]}{r.customer_last_name?.[0]}
           </div>
           <div className="min-w-0 flex-1">
              <p className="mb-0.5 truncate font-mono text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60">#{r.customer_code ?? "NO-CODE"}</p>
              <h4 className="line-clamp-2 break-words text-base font-black leading-tight text-app-text">
                {customerName(r)}
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

        <div className="hidden shrink-0 flex-col items-end gap-1 font-mono text-[10px] text-app-text-muted opacity-50 sm:flex">
           <span>ALT-{r.id.slice(0, 8).toUpperCase()}</span>
        </div>
      </div>

      {r.notes && (
        <div className="break-words rounded-xl border border-app-border/40 bg-app-surface-2/60 p-3 text-xs italic text-app-text/80 shadow-inner">
           {r.notes}
        </div>
      )}

      <div className="grid gap-3 rounded-xl border border-app-border/40 bg-app-surface-2/60 p-3 text-xs shadow-inner sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Garment
          </p>
          <p className="mt-1 break-words font-bold text-app-text">
            {r.item_description || "Garment not specified"}
          </p>
          {r.source_sku ? (
            <p className="mt-0.5 truncate font-mono text-[10px] text-app-text-muted">
              SKU {r.source_sku}
            </p>
          ) : null}
        </div>
        <div className="min-w-0">
          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Work Requested
          </p>
          <p className="mt-1 break-words font-bold text-app-text">
            {r.work_requested || "Work details not specified"}
          </p>
        </div>
        {sourceContextLabel(r) ? (
          <div className="break-words text-[10px] font-bold uppercase tracking-widest text-app-text-muted sm:col-span-2">
            {sourceContextLabel(r)}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border/40 pt-3">
         <p className="text-[9px] font-bold uppercase tracking-tighter text-app-text-muted">Created {new Date(r.created_at).toLocaleString()}</p>

         <div className="flex flex-wrap items-center justify-end gap-2">
            {["in_work", "ready", "picked_up"].map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy || r.status === s}
                onClick={() => void setStatus(r.id, s)}
                className={`rounded-xl border px-3 py-1.5 text-[9px] font-black uppercase tracking-tight transition-all ${
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
    <div className="ui-page flex min-h-0 flex-1 flex-col bg-transparent p-0">
      <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              data-testid={`alterations-summary-${card.id}`}
              onClick={card.onClick}
              className={`ui-card flex min-w-[200px] flex-1 items-center gap-4 p-4 text-left transition-all hover:-translate-y-0.5 hover:shadow-lg ${card.tint}`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${card.border} ${card.bg} shadow-sm`}
              >
                <Icon size={24} className={card.color} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                  {card.label}
                </p>
                <p className="text-2xl font-black tabular-nums text-app-text">
                  {card.value}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="px-4 sm:px-6">
        <div className="ui-card ui-tint-accent px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                Alteration Workflow
              </p>
              <p className="mt-1 text-sm font-semibold text-app-text">
                {customerId
                  ? "Customer alteration history and open garment work, searchable by garment, due date, source, and contact details."
                  : "Garment-based workbench for alteration attention by due date, status, and source item."}
              </p>
            </div>
            <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              {visibleRows.length} visible / {rows.length} loaded
            </span>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-8 animate-workspace-snap">
        <section className="ui-card flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-app-border bg-app-surface-2 px-5 py-4">
            <div className="relative min-w-[260px] flex-1">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-disabled"
              />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                data-testid="alterations-search"
                placeholder="SEARCH NAME, PHONE, GARMENT..."
                className="ui-input h-10 w-full rounded-xl pl-10 text-[10px] font-black uppercase tracking-widest"
                aria-label="Search alterations"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {DUE_FILTERS.map(f => (
                <button
                  key={f.value}
                  type="button"
                  data-testid={`alterations-due-filter-${f.value}`}
                  onClick={() => setDueFilter(f.value)}
                  className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                    dueFilter === f.value
                      ? "border-app-accent/20 bg-app-accent/10 text-app-accent"
                      : "border-app-border bg-app-surface-3 text-app-text-muted hover:bg-app-surface hover:text-app-text"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 border-b border-app-border bg-app-surface-3 px-5 py-4">
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

          <div className="flex items-center justify-between border-b border-app-border/40 px-5 py-3">
            <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
              Garment Workbench
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {visibleRows.length} visible
            </p>
          </div>
          
          <div className="min-h-0 flex-1 overflow-y-auto p-4 custom-scrollbar">
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
              <div className="grid items-start gap-4 xl:grid-cols-2 2xl:grid-cols-3">
                {workbenchSections.map((section) => {
                const Icon = section.icon;
                const isIntakeSection = section.id === "intake";
                return (
                  <section
                    key={section.id}
                    data-testid={`alteration-workbench-section-${section.id}`}
                    className={`flex min-w-0 flex-col rounded-2xl border border-app-border/60 bg-app-surface/80 p-4 shadow-sm ${
                      isIntakeSection
                        ? "h-[min(63vh,780px)] min-h-[360px] xl:col-span-2 2xl:col-span-3"
                        : "h-[min(42vh,520px)] min-h-[240px]"
                    }`}
                  >
                    <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border ${section.tone}`}>
                          <Icon size={17} />
                        </div>
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-black uppercase tracking-widest text-app-text">
                            {section.title}
                          </h4>
                          <p className="line-clamp-2 text-[10px] font-semibold leading-snug text-app-text-muted">
                            {section.subtitle}
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black tabular-nums text-app-text">
                        {section.rows.length}
                      </span>
                    </div>
                    {section.rows.length > 0 ? (
                      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                        {section.rows.map(renderAlterationCard)}
                      </div>
                    ) : (
                      <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2/70 px-4 py-3 text-xs font-semibold text-app-text-muted">
                        No garments in this section.
                      </p>
                    )}
                  </section>
                );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
