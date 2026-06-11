import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import { 
  Package, 
  Clock, 
  AlertTriangle, 
  CheckCircle2, 
  ArrowRight,
  TrendingUp,
  History,
  Printer,
  Search,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { openProfessionalTablePrint } from "../pos/zReportPrint";

const baseUrl = getBaseUrl();

type Urgency = "rush" | "due_soon" | "standard" | "blocked" | "ready";
type QueueSort = "priority" | "deadline" | "customer";

const urgencyRank: Record<Urgency, number> = {
  blocked: 0,
  rush: 1,
  due_soon: 2,
  ready: 3,
  standard: 4,
};

function deadlineRank(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

interface FulfillmentItem {
  order_id: string;
  order_short_id: string;
  booked_at: string;
  status: string;
  customer_name: string | null;
  item_count: number;
  fulfilled_item_count: number;
  urgency: Urgency;
  next_deadline: string | null;
  balance_due: number;
  wedding_party_id: string | null;
  wedding_party_name: string | null;
}

interface FulfillmentCommandCenterProps {
  onOpenTransaction: (orderId: string) => void;
  onOpenWeddingParty?: (partyId: string) => void;
  refreshSignal?: number;
}

export default function FulfillmentCommandCenter({ 
  onOpenTransaction, 
  onOpenWeddingParty,
  refreshSignal = 0 
}: FulfillmentCommandCenterProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [items, setItems] = useState<FulfillmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Urgency | "all">("all");
  const [queueRefreshError, setQueueRefreshError] = useState<string | null>(null);
  const [queueLastLoadedAt, setQueueLastLoadedAt] = useState<string | null>(null);
  const [queueSearch, setQueueSearch] = useState("");
  const [queueSort, setQueueSort] = useState<QueueSort>("priority");
  const [compactQueue, setCompactQueue] = useState(false);

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/transactions/fulfillment-queue`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (res.ok) {
        const data = await res.json();
        setItems(data);
        setQueueRefreshError(null);
        setQueueLastLoadedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      } else {
        setQueueRefreshError("Pickup queue could not refresh.");
      }
    } catch {
      setQueueRefreshError("Pickup queue could not refresh.");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue, refreshSignal]);

  const filteredItems = useMemo(() => {
    const needle = queueSearch.trim().toLowerCase();
    return items
      .filter((it) => filter === "all" || it.urgency === filter)
      .filter((it) => {
        if (!needle) return true;
        return [
          it.order_short_id,
          it.customer_name,
          it.wedding_party_name,
          it.status,
          it.urgency,
          it.next_deadline,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        if (queueSort === "customer") {
          return (a.customer_name ?? "Guest Customer").localeCompare(
            b.customer_name ?? "Guest Customer",
          );
        }
        if (queueSort === "deadline") {
          const aDeadline = deadlineRank(a.next_deadline);
          const bDeadline = deadlineRank(b.next_deadline);
          return aDeadline - bDeadline || urgencyRank[a.urgency] - urgencyRank[b.urgency];
        }
        return urgencyRank[a.urgency] - urgencyRank[b.urgency];
      });
  }, [filter, items, queueSearch, queueSort]);

  const stats = {
    ready: items.filter(i => i.urgency === "ready").length,
    rush: items.filter(i => i.urgency === "rush").length,
    due_soon: items.filter(i => i.urgency === "due_soon").length,
    blocked: items.filter(i => i.urgency === "blocked").length,
  };

  if (loading) return <div className="p-8 text-app-text-muted">Loading queue...</div>;

  return (
    <div className="flex flex-1 flex-col">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-6 border-b border-app-border bg-app-surface-2/30">
        <StatCard 
          label="Ready for Pickup" 
          count={stats.ready} 
          icon={<CheckCircle2 className="text-emerald-500" />} 
          active={filter === "ready"}
          onClick={() => setFilter(filter === "ready" ? "all" : "ready")}
        />
        <StatCard
          label="Rush Pickups"
          count={stats.rush} 
          icon={<AlertTriangle className="text-red-500" />} 
          active={filter === "rush"}
          onClick={() => setFilter(filter === "rush" ? "all" : "rush")}
        />
        <StatCard 
          label="Due Soon" 
          count={stats.due_soon} 
          icon={<Clock className="text-amber-500" />} 
          active={filter === "due_soon"}
          onClick={() => setFilter(filter === "due_soon" ? "all" : "due_soon")}
        />
        <StatCard 
          label="Stagnant / Blocked" 
          count={stats.blocked} 
          icon={<History className="text-app-text-muted" />} 
          active={filter === "blocked"}
          onClick={() => setFilter(filter === "blocked" ? "all" : "blocked")}
        />
      </div>

      {/* List Area */}
      <div className="flex-1 p-6">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-lg font-black uppercase tracking-[0.08em] text-app-text">
              Pickup Queue
            </h2>
            <p className="text-xs text-app-text-muted">
              Prioritized operational release view for safe pickups, blocked pickups, wedding risk, and rush work.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 sm:w-64">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
                aria-hidden
              />
              <input
                type="search"
                value={queueSearch}
                onChange={(event) => setQueueSearch(event.target.value)}
                placeholder="Find order or customer"
                className="ui-input h-10 w-full rounded-xl pl-9 pr-3 text-xs font-bold"
                aria-label="Search pickup queue"
              />
            </div>
            <select
              value={queueSort}
              onChange={(event) => setQueueSort(event.target.value as QueueSort)}
              className="ui-input h-10 rounded-xl px-3 text-[10px] font-black uppercase tracking-widest"
              aria-label="Sort pickup queue"
            >
              <option value="priority">Priority first</option>
              <option value="deadline">Need-by first</option>
              <option value="customer">Customer A-Z</option>
            </select>
             {filteredItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                     void openProfessionalTablePrint({
                        title: `Pickup Queue - ${filter.toUpperCase()}`,
                        subtitle: `Pickup and follow-up priority view`,
                        columns: ["order_short_id", "customer_name", "urgency", "next_deadline", "item_count"],
                        rows: filteredItems.map(i => ({
                           ...i,
                           customer_name: i.customer_name || "—"
                        }))
                     });
                  }}
                  className="flex items-center gap-2 text-[10px] font-black uppercase text-emerald-700 hover:text-emerald-500"
                >
                  <Printer size={12} />
                  Print Queue
                </button>
             )}
             <button
               type="button"
               onClick={() => setCompactQueue((value) => !value)}
               className={`rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
                 compactQueue
                   ? "border-app-accent bg-app-accent/10 text-app-accent"
                   : "border-app-border bg-app-surface text-app-text-muted hover:bg-app-surface-2"
               }`}
             >
               {compactQueue ? "Comfort View" : "Compact View"}
             </button>
             <span className="whitespace-nowrap text-xs font-bold text-app-text-muted">
               {filteredItems.length} / {items.length} items
             </span>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-app-border bg-app-surface px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Rush-condition pickup guidance
              </p>
              <p className="mt-1 text-sm font-semibold text-app-text">
                {stats.blocked > 0
                  ? "Blocked pickups first: do not release garments until balance, readiness, or lifecycle blockers are cleared."
                  : stats.rush > 0
                    ? "Rush pickups next: verify payment, readiness, fitting context, and customer identity before release."
                    : "Operate from ready pickups first; partial-ready work must stay explicit and item-level."}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center sm:min-w-72">
              {[
                ["Blocked", stats.blocked],
                ["Rush", stats.rush],
                ["Ready", stats.ready],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-app-border bg-app-bg px-3 py-2">
                  <p className="text-[8px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
                  <p className="mt-1 text-lg font-black tabular-nums text-app-text">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {queueRefreshError ? (
          <div className="mb-4 rounded-xl border border-app-warning/40 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-3">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-app-warning" />
                <div>
                  <p className="font-black">{queueRefreshError}</p>
                  <p className="text-xs text-app-text-muted">
                    {items.length > 0
                      ? `Showing last loaded pickup data${queueLastLoadedAt ? ` from ${queueLastLoadedAt}` : ""}. Retry is safe; no orders are changed by refreshing.`
                      : "No pickup data loaded. Retry is safe; do not treat the queue as clear until refresh succeeds."}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void loadQueue()}
                className="rounded-lg border border-app-warning/40 bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
              >
                Try Again
              </button>
            </div>
          </div>
        ) : null}

        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-app-text-muted">
            <Package size={48} className="mb-4 opacity-20" />
            <p className="font-bold">
              {queueRefreshError && items.length === 0
                ? "Pickup queue could not refresh."
                : queueSearch.trim()
                  ? "No pickup work matches this search."
                  : "No pickup records match this priority level."}
            </p>
            <p className="mt-2 max-w-sm text-center text-sm">
              {queueRefreshError && items.length === 0
                ? "Retry is safe; no orders were changed. Do not treat the queue as clear until refresh succeeds."
                : "This is a valid empty result for the current search and priority filter."}
            </p>
          </div>
        ) : (
          <div className={compactQueue ? "space-y-1.5" : "space-y-3"}>
            {filteredItems.map(item => (
              <QueueItem 
                key={item.order_id} 
                item={item} 
                compact={compactQueue}
                onOpen={() => onOpenTransaction(item.order_id)}
                onOpenWeddingParty={item.wedding_party_id && onOpenWeddingParty ? () => onOpenWeddingParty(item.wedding_party_id!) : undefined}
                onPrint={() => {
                  void openProfessionalTablePrint({
                    title: `Pickup Queue - ${item.order_short_id}`,
                    subtitle: "Single pickup follow-up row",
                    columns: ["order_short_id", "customer_name", "urgency", "next_deadline", "item_count"],
                    rows: [{
                      ...item,
                      customer_name: item.customer_name || "—",
                    }],
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, count, icon, active, onClick }: { 
  label: string; 
  count: number; 
  icon: React.ReactNode; 
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button 
      type="button"
      onClick={onClick}
      className={`flex items-center gap-4 rounded-[20px] border p-4 text-left transition-all ${
        active 
          ? "border-app-accent bg-app-accent/5 shadow-sm" 
          : "border-app-border bg-app-surface hover:bg-app-surface-2"
      }`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-surface-2">
        {icon}
      </div>
      <div>
        <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
          {label}
        </p>
        <p className="text-2xl font-black text-app-text leading-tight">{count}</p>
      </div>
    </button>
  );
}

function formatPickupMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Math.max(0, value));
}

function pickupReadiness(item: FulfillmentItem): { label: string; className: string } {
  if (item.urgency === "blocked") {
    return { label: "Blocked", className: "border-app-danger/30 bg-app-danger/10 text-app-danger" };
  }
  if (item.fulfilled_item_count > 0 && item.fulfilled_item_count < item.item_count) {
    return { label: "Partial", className: "border-app-warning/40 bg-app-warning/10 text-app-warning" };
  }
  if (item.urgency === "ready" || item.fulfilled_item_count >= item.item_count) {
    return { label: "Ready", className: "border-app-success/30 bg-app-success/10 text-app-success" };
  }
  return { label: "Needs review", className: "border-app-border bg-app-surface-2 text-app-text-muted" };
}

function pickupPaymentState(item: FulfillmentItem): { label: string; className: string } {
  if (item.balance_due > 0) {
    return {
      label: `Balance ${formatPickupMoney(item.balance_due)}`,
      className: "border-app-warning/40 bg-app-warning/10 text-app-warning",
    };
  }
  return { label: "Paid", className: "border-app-success/30 bg-app-success/10 text-app-success" };
}

function pickupFittingState(item: FulfillmentItem): { label: string; className: string } {
  if (item.wedding_party_name) {
    return {
      label: "Confirm fitting",
      className: "border-sky-400/30 bg-sky-400/10 text-sky-700",
    };
  }
  return { label: "Fitting N/A", className: "border-app-border bg-app-surface-2 text-app-text-muted" };
}

function pickupContext(item: FulfillmentItem): { label: string; className: string } {
  if (item.urgency === "rush") {
    return { label: "Rush pickup", className: "border-app-danger/30 bg-app-danger/10 text-app-danger" };
  }
  if (item.wedding_party_name) {
    return { label: "Wedding", className: "border-violet-400/30 bg-violet-400/10 text-violet-700" };
  }
  return { label: "Standard", className: "border-app-border bg-app-surface-2 text-app-text-muted" };
}

function pickupNextSafeAction(item: FulfillmentItem): string {
  if (item.balance_due > 0) return "Pickup blocked until balance is cleared.";
  if (item.urgency === "blocked") return "Open Transaction Record before releasing garments.";
  if (item.fulfilled_item_count > 0 && item.fulfilled_item_count < item.item_count) {
    return "Partial-ready: release only confirmed ready garments.";
  }
  if (item.wedding_party_name) return "Confirm fitting and wedding member before release.";
  if (item.urgency === "ready") return "Ready after ID and garment check.";
  return "Open Transaction Record for pickup readiness details.";
}

function pickupEscalation(item: FulfillmentItem): string {
  if (item.balance_due > 0) return "Requires payment collection before release.";
  if (item.urgency === "blocked") return "Requires manager review if staff believe release is still necessary.";
  if (item.urgency === "rush") return "Escalate if deadline conflicts with readiness.";
  if (item.wedding_party_name) return "Escalate wedding-risk mismatches before releasing partial work.";
  return "Standard release path.";
}

function QueueItem({
  item,
  compact,
  onOpen,
  onOpenWeddingParty,
  onPrint,
}: {
  item: FulfillmentItem;
  compact: boolean;
  onOpen: () => void;
  onOpenWeddingParty?: () => void;
  onPrint: () => void;
}) {
  const urgencyStyles = {
    rush: "bg-app-danger/10 text-app-danger border-app-danger/20",
    due_soon: "bg-app-warning/10 text-app-warning border-app-warning/20",
    ready: "bg-app-success/10 text-app-success border-app-success/20",
    blocked: "bg-app-surface-2 text-app-text-muted border-app-border",
    standard: "bg-app-surface-2 text-app-text-muted border-app-border",
  };
  const decisionStrip = [
    pickupPaymentState(item),
    pickupReadiness(item),
    pickupFittingState(item),
    pickupContext(item),
  ];

  return (
    <article
      className={`group flex w-full items-center gap-4 rounded-2xl border border-app-border bg-app-surface text-left transition-all hover:border-app-accent/40 ${
        compact ? "px-3 py-2" : "p-4"
      }`}
    >
      <div className={`flex shrink-0 flex-col items-center justify-center rounded-xl border font-black ${compact ? "h-10 w-10" : "h-12 w-12"} ${urgencyStyles[item.urgency]}`}>
        <span className="text-[10px] leading-none uppercase">Item</span>
        <span className={compact ? "text-base leading-tight" : "text-lg leading-tight"}>{item.item_count}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-black text-app-accent tracking-wider uppercase">
            #{item.order_short_id}
          </span>
          {item.wedding_party_name && (
            <span className="ui-pill bg-app-surface-2 text-app-text-muted text-[10px]">
              {item.wedding_party_name}
            </span>
          )}
          {item.urgency === "rush" && (
            <span className="ui-pill bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200 text-[10px] animate-pulse">
              RUSH
            </span>
          )}
        </div>
        <h4 className="font-black text-app-text truncate">
          {item.customer_name ?? "Guest Customer"}
        </h4>
        <div className={`flex items-center gap-3 text-xs font-bold text-app-text-muted ${compact ? "mt-0.5" : "mt-1"}`}>
          <span className="flex items-center gap-1">
            <TrendingUp size={12} />
            {item.fulfilled_item_count} / {item.item_count} Fulfilled
          </span>
          {item.next_deadline && (
            <span className="flex items-center gap-1">
              <Clock size={12} />
              Need by {item.next_deadline}
            </span>
          )}
        </div>
        <div className={`${compact ? "mt-2" : "mt-3"} flex flex-wrap items-center gap-1.5`}>
          {decisionStrip.map((entry) => (
            <span
              key={entry.label}
              className={`rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${entry.className}`}
            >
              {entry.label}
            </span>
          ))}
          <span className="min-w-0 rounded-full border border-app-border bg-app-bg px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Next: {pickupNextSafeAction(item)}
          </span>
          <span className="min-w-0 rounded-full border border-app-border bg-app-bg px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            Escalation: {pickupEscalation(item)}
          </span>
        </div>
      </div>

      <div className="shrink-0 text-right">
        <p className="text-sm font-black text-app-text">
          {item.balance_due > 0 ? `$${item.balance_due}` : "Paid"}
        </p>
        <div className="mt-1 flex justify-end gap-1">
          {onOpenWeddingParty && !compact ? (
            <button
              type="button"
              onClick={onOpenWeddingParty}
              className="rounded-lg border border-violet-300 bg-violet-50 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-violet-700 hover:bg-violet-100"
            >
              Readiness
            </button>
          ) : null}
          {!compact ? (
            <button
              type="button"
              onClick={onPrint}
              className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text-muted hover:text-app-text"
            >
              Print
            </button>
          ) : null}
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-lg border border-app-accent/30 bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-accent hover:bg-app-accent hover:text-white"
          >
            Open <ArrowRight size={10} />
          </button>
        </div>
      </div>
    </article>
  );
}
