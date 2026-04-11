import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2, Users } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

export interface WeddingPartySearchResult {
  id: string;
  party_name: string | null;
  groom_name: string;
  bride_name: string | null;
  event_date: string;
}

interface PaginatedParties {
  data: { party: WeddingPartySearchResult }[];
  pagination: {
    total: number;
    total_pages: number;
  };
}

interface WeddingPartySearchInputProps {
  onSelect: (party: WeddingPartySearchResult) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}

export default function WeddingPartySearchInput({
  onSelect,
  placeholder = "Search wedding parties by name…",
  className = "",
  autoFocus = false,
  disabled,
}: WeddingPartySearchInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WeddingPartySearchResult[]>([]);
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
      const res = await fetch(
        `${baseUrl}/api/weddings/parties?search=${encodeURIComponent(q)}&limit=10`,
        { headers: mergedPosStaffHeaders(backofficeHeaders) }
      );
      if (res.ok) {
        const data = await res.json() as PaginatedParties;
        setResults(data.data.map(d => d.party));
      }
    } catch (err) {
      console.error("Wedding party search failed", err);
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
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 ring-1 ring-black/5">
          {loading && results.length === 0 ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Searching parties…</div>
          ) : results.length > 0 ? (
            <ul className="py-1">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(p);
                      setQuery(p.party_name || p.groom_name);
                      setResults([]);
                      setIsOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-app-accent/5 transition-colors border-b border-app-border/10 last:border-0"
                  >
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-surface-2 border border-app-border/50 text-app-text font-black text-xs shadow-inner">
                       <Users size={16} className="text-app-text-muted" />
                    </div>
                    <div className="flex flex-col min-w-0 flex-1">
                       <span className="text-sm font-black text-app-text truncate">
                         {p.party_name || "Unnamed Party"}
                       </span>
                       <div className="flex items-center gap-2 mt-0.5">
                         <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                           {p.groom_name} {p.bride_name ? `& ${p.bride_name}` : ""}
                         </span>
                         <span className="text-[10px] font-black text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded-md border border-amber-500/20 ml-auto tabular-nums leading-none">
                            {new Date(p.event_date).toLocaleDateString()}
                         </span>
                       </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-center text-xs text-app-text-muted">No wedding parties found.</div>
          )}
        </div>
      )}
    </div>
  );
}
