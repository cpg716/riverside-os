import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

export interface VariantSearchResult {
  product_id: string;
  variant_id: string;
  sku: string;
  barcode?: string | null;
  vendor_upc?: string | null;
  catalog_handle?: string | null;
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
  productId?: string | null;
  expandParentMatches?: boolean;
}

export default function VariantSearchInput({
  onSelect,
  placeholder = "Search products by name or SKU…",
  className = "",
  autoFocus = false,
  productId = null,
  expandParentMatches = true,
}: VariantSearchInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VariantSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const performSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const requestId = ++requestRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const params = new URLSearchParams({
        search: q,
        limit: "200",
      });
      if (productId) params.set("product_id", productId);
      if (expandParentMatches) params.set("expand_parent_matches", "true");
      if (!productId) params.set("parent_rank_first", "true");
      const res = await fetch(
        `${baseUrl}/api/products/control-board?${params.toString()}`,
        { headers: mergedPosStaffHeaders(backofficeHeaders), signal: controller.signal }
      );
      if (!res.ok) throw new Error(`Product search failed with status ${res.status}`);
      const data = await res.json() as { rows: VariantSearchResult[] };
      if (requestId !== requestRef.current) return;
      setResults(data.rows || []);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (requestId !== requestRef.current) return;
      console.error("Variant search failed", err);
      setError("Product search is unavailable. Try again.");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [baseUrl, backofficeHeaders, expandParentMatches, productId]);

  useEffect(() => {
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setError(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setResults([]);
      setIsOpen(query.trim().length > 0);
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

  useEffect(() => () => {
    requestRef.current += 1;
    abortRef.current?.abort();
  }, []);

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

      {isOpen && query.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
          {loading ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Searching…</div>
          ) : error ? (
            <div className="p-4 text-center text-xs font-semibold text-app-danger">{error}</div>
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
