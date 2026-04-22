import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback } from "react";
import { 
  Package, 
  Clock, 
  AlertTriangle, 
  CheckCircle2, 
  ArrowRight,
  TrendingUp,
  History,
  Printer,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { openProfessionalTablePrint } from "../pos/zReportPrint";

const baseUrl = getBaseUrl();

type Urgency = "rush" | "due_soon" | "standard" | "blocked" | "ready";

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
  wedding_party_name: string | null;
}

interface FulfillmentCommandCenterProps {
  onOpenTransaction: (orderId: string) => void;
  refreshSignal?: number;
}

export default function FulfillmentCommandCenter({ 
  onOpenTransaction, 
  refreshSignal = 0 
}: FulfillmentCommandCenterProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [items, setItems] = useState<FulfillmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Urgency | "all">("all");

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/transactions/fulfillment-queue`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (res.ok) {
        const data = await res.json();
        setItems(data);
      }
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue, refreshSignal]);

  const filteredItems = items.filter(it => filter === "all" || it.urgency === filter);

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
          label="Rush Orders" 
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
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black uppercase tracking-[0.08em] text-app-text">
              Pickup Queue
            </h2>
            <p className="text-xs text-app-text-muted">
              Prioritized order follow-up for pickup readiness, rush work, and blocked items.
            </p>
          </div>
          <div className="flex items-center gap-4">
             {filteredItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                     openProfessionalTablePrint({
                        title: `Pickup Queue - ${filter.toUpperCase()}`,
                        subtitle: `Order pickup and follow-up priority view`,
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
             <span className="text-xs font-bold text-app-text-muted">
               {filteredItems.length} items
             </span>
          </div>
        </div>

        {filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-app-text-muted">
            <Package size={48} className="mb-4 opacity-20" />
            <p className="font-bold">No orders match this priority level.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredItems.map(item => (
              <QueueItem 
                key={item.order_id} 
                item={item} 
                onClick={() => onOpenTransaction(item.order_id)} 
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

function QueueItem({ item, onClick }: { item: FulfillmentItem; onClick: () => void }) {
  const urgencyStyles = {
    rush: "bg-red-500/10 text-red-600 border-red-500/20",
    due_soon: "bg-amber-500/10 text-amber-600 border-amber-500/20",
    ready: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    blocked: "bg-app-surface-2 text-app-text-muted border-app-border",
    standard: "bg-app-surface-2 text-app-text-muted border-app-border",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-2xl border border-app-border bg-app-surface p-4 text-left transition-all hover:border-app-accent/40"
    >
      <div className={`flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl border font-black ${urgencyStyles[item.urgency]}`}>
        <span className="text-[10px] leading-none uppercase">Item</span>
        <span className="text-lg leading-tight">{item.item_count}</span>
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
        <div className="flex items-center gap-3 mt-1 text-xs font-bold text-app-text-muted">
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
      </div>

      <div className="text-right shrink-0">
        <p className="text-sm font-black text-app-text">
          {item.balance_due > 0 ? `$${item.balance_due}` : "Paid"}
        </p>
        <span className="flex items-center justify-end gap-1 text-[10px] font-black uppercase text-app-text-muted group-hover:text-app-accent">
          View <ArrowRight size={10} />
        </span>
      </div>
    </button>
  );
}
