import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2, User } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";

interface CustomerSearchInputProps {
  onSelect: (customer: Customer) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  excludeCustomerId?: string;
  initialValue?: string;
  defaultValue?: string;
  disabled?: boolean;
}

export default function CustomerSearchInput({
  onSelect,
  placeholder = "Search customers by name, phone, email…",
  className = "",
  autoFocus = false,
  excludeCustomerId,
  initialValue = "",
  defaultValue,
  disabled,
}: CustomerSearchInputProps) {
  const effectiveInitial = defaultValue ?? initialValue;
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  
  const [query, setQuery] = useState(effectiveInitial);
  const [results, setResults] = useState<Customer[]>([]);
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
        `${baseUrl}/api/customers/browse?q=${encodeURIComponent(q)}&limit=20`,
        { headers: mergedPosStaffHeaders(backofficeHeaders) }
      );
      if (res.ok) {
        const data = await res.json() as Customer[];
        const filtered = Array.isArray(data) 
          ? (excludeCustomerId ? data.filter(c => c.id !== excludeCustomerId) : data)
          : [];
        setResults(filtered);
      }
    } catch (err) {
      console.error("Customer search failed", err);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders, excludeCustomerId]);

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
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
          {loading && results.length === 0 ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Searching…</div>
          ) : results.length > 0 ? (
            <ul className="py-1">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(c);
                      setQuery("");
                      setResults([]);
                      setIsOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-app-accent/5 transition-colors"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-app-surface-2">
                       <User size={14} className="text-app-text-muted" />
                    </div>
                    <div className="flex flex-col min-w-0">
                       <span className="text-sm font-bold text-app-text truncate">
                         {c.first_name} {c.last_name}
                       </span>
                       <span className="text-[10px] text-app-text-muted truncate">
                         {c.customer_code} {c.phone ? `· ${c.phone}` : ""} {c.email ? `· ${c.email}` : ""}
                       </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-center text-xs text-app-text-muted">No customers found.</div>
          )}
        </div>
      )}
    </div>
  );
}
