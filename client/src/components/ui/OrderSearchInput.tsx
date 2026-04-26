import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2, Package } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatMoney, parseMoney } from "../../lib/money";

interface OrderSearchResult {
  order_id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  customer_name: string | null;
  party_name: string | null;
  order_kind: string;
}

interface PagedOrdersResponse {
  items: OrderSearchResult[];
  total_count: number;
}

interface OrderSearchInputProps {
  onSelect: (order: OrderSearchResult) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  initialQuery?: string;
}

export default function OrderSearchInput({
  onSelect,
  placeholder = "Search orders by name, phone, or Short ID…",
  className = "",
  autoFocus = false,
  disabled,
  initialQuery = "",
}: OrderSearchInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<OrderSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const performSearch = useCallback(async (q: string) => {
    if (q.trim().length < 1) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      // Use the standard orders listing with search param
      const res = await fetch(
        `${baseUrl}/api/transactions?search=${encodeURIComponent(q)}&limit=10`,
        { headers: mergedPosStaffHeaders(backofficeHeaders) }
      );
      if (res.ok) {
        const data = await res.json() as PagedOrdersResponse;
        setResults(data.items || []);
      }
    } catch (err) {
      console.error("Order search failed", err);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setIsOpen(false);
      return;
    }
    setIsOpen(true);
    debounceRef.current = setTimeout(() => {
      void performSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, performSearch]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className={`relative ${className}`} ref={dropdownRef}>
      <div className="relative flex items-center">
        <div className="absolute left-3 text-app-text-muted">
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onFocus={() => query.trim() && setIsOpen(true)}
          disabled={disabled}
          className="ui-input w-full pl-10 pr-4 py-2 text-sm disabled:opacity-50"
        />
      </div>

      {isOpen && (results.length > 0 || loading) && (
        <div className="absolute z-50 mt-1 w-full max-h-80 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 ring-1 ring-black/5 border-b border-app-border/10">
          {loading && results.length === 0 ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Scanning records…</div>
          ) : results.length > 0 ? (
            <ul className="py-1">
              {results.map((o) => (
                <li key={o.order_id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(o);
                      setQuery(o.customer_name ?? o.order_id.slice(0, 8));
                      setResults([]);
                      setIsOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-app-accent/5 transition-colors border-b border-app-border/10 last:border-0"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-surface-2 border border-app-border/50 text-app-text font-black text-xs shadow-inner">
                       <Package size={16} className="text-app-text-muted" />
                    </div>
                    <div className="flex flex-col min-w-0 flex-1">
                       <div className="flex items-center justify-between gap-2">
                         <span className="text-sm font-black text-app-text truncate">
                           {o.customer_name ?? "Guest Checkout"}
                         </span>
                         <span className="text-[10px] font-black tabular-nums text-app-success bg-app-success/10 px-1.5 py-0.5 rounded-md border border-app-success/20">
                           ${formatMoney(parseMoney(o.total_price))}
                         </span>
                       </div>
                       <div className="flex items-center gap-2 mt-0.5">
                         <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                           #{o.order_id.slice(0, 8)}
                         </span>
                         {o.party_name && (
                           <span className="text-[9px] font-bold text-app-warning truncate border-l border-app-border pl-2">
                             {o.party_name}
                           </span>
                         )}
                         <span className={`text-[9px] font-black uppercase px-1 rounded ml-auto ${
                            o.status.toLowerCase() === "open" ? "text-app-info" : "text-app-text-muted"
                         }`}>
                           {o.status}
                         </span>
                       </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-center text-xs text-app-text-muted">No orders matched your search.</div>
          )}
        </div>
      )}
    </div>
  );
}
