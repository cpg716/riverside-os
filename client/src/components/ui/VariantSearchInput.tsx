import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

export interface VariantSearchResult {
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label?: string | null;
  retail_price?: string | number;
  cost_price?: string | number;
}

interface VariantSearchInputProps {
  onSelect: (variant: VariantSearchResult) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

export default function VariantSearchInput({
  onSelect,
  placeholder = "Search products by name or SKU…",
  className = "",
  autoFocus = false,
}: VariantSearchInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VariantSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const performSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=20`,
        { headers: mergedPosStaffHeaders(backofficeHeaders) }
      );
      if (res.ok) {
        const data = await res.json() as { rows: VariantSearchResult[] };
        setResults(data.rows || []);
      }
    } catch (err) {
      console.error("Variant search failed", err);
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
          className="ui-input w-full pl-10 pr-4 py-2 text-sm"
        />
      </div>

      {isOpen && (results.length > 0 || loading) && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
          {loading && results.length === 0 ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Searching…</div>
          ) : results.length > 0 ? (
            <ul className="py-1">
              {results.map((r) => (
                <li key={r.variant_id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(r);
                      setQuery("");
                      setResults([]);
                      setIsOpen(false);
                    }}
                    className="flex w-full flex-col items-start px-4 py-2 text-left hover:bg-app-accent/5 transition-colors"
                  >
                    <div className="flex w-full justify-between items-baseline gap-2">
                       <span className="text-sm font-bold text-app-text">{r.product_name}</span>
                       <span className="font-mono text-[10px] text-app-text-muted">{r.sku}</span>
                    </div>
                    {r.variation_label && (
                      <span className="text-[10px] uppercase font-black tracking-widest text-app-text-muted">
                        {r.variation_label}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-center text-xs text-app-text-muted">No products found.</div>
          )}
        </div>
      )}
    </div>
  );
}
