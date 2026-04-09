import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import {
  Search,
  Clock,
  History,
  Loader2,
  AlertCircle,
  ChevronRight,
  RefreshCw,
  User,
} from "lucide-react";

interface LayawayRow {
  order_id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  customer_name: string | null;
  item_count: number;
  order_kind: string;
}

interface LayawayListResponse {
  items: LayawayRow[];
  total_count: number;
}

export interface LayawayWorkspaceProps {
  registerSessionId?: string | null;
  onOpenOrder?: (orderId: string) => void;
}

export default function LayawayWorkspace({
  onOpenOrder,
}: LayawayWorkspaceProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders) as Record<string, string>,
    [backofficeHeaders]
  );

  const [tab, setTab] = useState<"open" | "history">("open");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<LayawayRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  const loadLayaways = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const showClosed = tab === "history";
      const q = query.trim();
      const url = new URL(`${baseUrl}/api/orders`);
      url.searchParams.set("kind_filter", "layaway");
      url.searchParams.set("show_closed", showClosed ? "true" : "false");
      if (q) url.searchParams.set("search", q);
      url.searchParams.set("limit", "50");

      const res = await fetch(url.toString(), {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("Could not load layaways");
      const data = (await res.json()) as LayawayListResponse;
      setItems(data.items);
      setTotalCount(data.total_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiAuth, baseUrl, tab, query]);

  useEffect(() => {
    void loadLayaways();
  }, [loadLayaways]);

  const getDaysOld = (bookedAt: string) => {
    const booked = new Date(bookedAt);
    const now = new Date();
    const diff = now.getTime() - booked.getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-surface">
      {/* Header & Controls */}
      <div className="shrink-0 border-b border-app-border px-4 py-4 sm:px-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black tracking-tight text-app-text sm:text-xl">
              Layaway Management
            </h2>
            <p className="text-[11px] text-app-text-muted sm:text-xs">
              Manage reserved inventory and payment plans. 25% minimum deposit required for new layaways.
            </p>
          </div>
          <div className="flex gap-1 rounded-xl bg-app-surface-2 p-1">
            <button
              type="button"
              onClick={() => setTab("open")}
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all sm:flex-none sm:px-4 sm:text-xs ${
                tab === "open"
                  ? "bg-app-surface text-app-accent shadow-sm"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              <Clock className="h-4 w-4 shrink-0" />
              Open
            </button>
            <button
              type="button"
              onClick={() => setTab("history")}
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wide transition-all sm:flex-none sm:px-4 sm:text-xs ${
                tab === "history"
                  ? "bg-app-surface text-app-accent shadow-sm"
                  : "text-app-text-muted hover:text-app-text"
              }`}
            >
              <History className="h-4 w-4 shrink-0" />
              History
            </button>
          </div>
        </div>

        <form 
            onSubmit={(e) => { e.preventDefault(); void loadLayaways(); }}
            className="flex gap-2"
        >
          <div className="group relative flex-1">
            <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by customer name or order ID…"
              className="ui-input h-12 w-full rounded-2xl bg-app-surface-2 pl-12 pr-4 text-sm font-bold shadow-inner focus:bg-app-surface sm:text-base"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="flex h-12 items-center gap-2 rounded-2xl bg-app-accent px-6 text-[10px] font-black uppercase tracking-widest text-white shadow-lg active:scale-95 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Search"}
          </button>
        </form>
      </div>

      {/* Main List Area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {error ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <AlertCircle className="mb-4 h-12 w-12 text-red-500" />
            <p className="text-lg font-black text-app-text">{error}</p>
            <button 
                onClick={() => void loadLayaways()}
                className="mt-4 ui-btn-secondary"
            >
                Try again
            </button>
          </div>
        ) : loading && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 opacity-50">
            <Loader2 className="h-12 w-12 animate-spin text-app-accent" />
            <p className="mt-4 font-bold text-app-text">Loading layaways…</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-app-text-muted opacity-50">
            <Clock className="h-24 w-24" />
            <p className="mt-4 text-xl font-bold">No {tab === "open" ? "open" : "historical"} layaways found</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {items.map((r) => {
              const daysOld = getDaysOld(r.booked_at);
              const isOverdue = daysOld > 90 && tab === "open";
              
              return (
                <div 
                  key={r.order_id}
                  className={`group relative flex flex-col gap-4 rounded-3xl border border-app-border bg-app-surface-2 p-5 transition-all hover:border-app-accent/40 hover:bg-app-surface hover:shadow-xl sm:flex-row sm:items-center ${isOverdue ? 'border-amber-200 bg-amber-50/30' : ''}`}
                >
                  {/* Status Indicator Bar */}
                  <div className={`absolute left-0 top-6 bottom-6 w-1 rounded-r-full ${
                    r.status === 'open' ? 'bg-amber-500' : 'bg-app-success'
                  }`} />

                  <div className="flex flex-1 flex-col gap-1 pl-4">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            Order {r.order_id.slice(0, 8)}
                        </span>
                        {isOverdue && (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase text-amber-700">
                                90+ Days Old
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <User className="h-4 w-4 text-app-text-muted" />
                        <h4 className="text-lg font-black text-app-text">
                            {r.customer_name ?? "Walk-in Customer"}
                        </h4>
                    </div>
                    <p className="text-xs text-app-text-muted">
                        Started {new Date(r.booked_at).toLocaleDateString()} ({daysOld} days old)
                        · {r.item_count} items
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-6 sm:px-4">
                    <div className="text-right">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Original</p>
                        <p className="text-lg font-bold text-app-text">
                            ${centsToFixed2(parseMoneyToCents(r.total_price))}
                        </p>
                    </div>
                    <div className="text-right">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Paid</p>
                        <p className="text-lg font-bold text-emerald-600">
                            ${centsToFixed2(parseMoneyToCents(r.amount_paid))}
                        </p>
                    </div>
                    <div className="text-right">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Balance Due</p>
                        <p className="text-xl font-black text-app-accent tabular-nums">
                            ${centsToFixed2(parseMoneyToCents(r.balance_due))}
                        </p>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center justify-end sm:pl-4">
                    <button
                        type="button"
                        onClick={() => onOpenOrder?.(r.order_id)}
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-app-surface border border-app-border px-6 text-[10px] font-black uppercase tracking-widest text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95 sm:w-auto"
                    >
                        View Order
                        <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Summary Footer */}
      <div className="shrink-0 border-t border-app-border bg-app-surface-2 px-6 py-3">
        <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-app-text-muted">
                Showing {items.length} of {totalCount} matching layaways
            </p>
            <button 
                onClick={() => void loadLayaways()}
                className="flex items-center gap-1.5 text-xs font-black uppercase tracking-widest text-app-accent hover:underline"
            >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                Refresh List
            </button>
        </div>
      </div>
    </div>
  );
}
