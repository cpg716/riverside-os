import { useCallback, useEffect, useRef, useState } from "react";
import { Search, Loader2, User } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { staffAvatarUrl } from "../../lib/staffAvatars";

export interface StaffSearchResult {
  id: string;
  full_name: string;
  role: string;
  avatar_key: string;
}

interface StaffSearchInputProps {
  onSelect: (staff: StaffSearchResult) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  excludeIds?: string[];
}

export default function StaffSearchInput({
  onSelect,
  placeholder = "Search staff by name…",
  className = "",
  autoFocus = false,
  disabled,
  excludeIds = [],
}: StaffSearchInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StaffSearchResult[]>([]);
  const [allStaff, setAllStaff] = useState<StaffSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load staff once on focus or mount
  const loadStaff = useCallback(async () => {
    if (allStaff.length > 0) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
        headers: mergedPosStaffHeaders(backofficeHeaders)
      });
      if (res.ok) {
        const data = await res.json() as StaffSearchResult[];
        setAllStaff(data);
      }
    } catch (err) {
      console.error("Staff load failed", err);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders, allStaff.length]);

  useEffect(() => {
    const q = query.toLowerCase().trim();
    if (!q) {
      setResults([]);
      return;
    }
    const filtered = allStaff.filter(s => 
      !excludeIds.includes(s.id) && 
      s.full_name.toLowerCase().includes(q)
    );
    setResults(filtered);
  }, [query, allStaff, excludeIds]);

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
          onFocus={() => {
            void loadStaff();
            setIsOpen(true);
          }}
          disabled={disabled}
          className="ui-input w-full pl-10 pr-4 py-2 text-sm disabled:opacity-50"
        />
      </div>

      {isOpen && (results.length > 0 || (loading && allStaff.length === 0)) && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-xl border border-app-border bg-app-surface shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200 ring-1 ring-black/5">
          {loading && allStaff.length === 0 ? (
            <div className="p-4 text-center text-xs text-app-text-muted">Loading roster…</div>
          ) : results.length > 0 ? (
            <ul className="py-1">
              {results.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(s);
                      setQuery("");
                      setResults([]);
                      setIsOpen(false);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-app-accent/5 transition-colors border-b border-app-border/10 last:border-0"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-app-border/50 overflow-hidden bg-app-surface-2 shadow-inner">
                       {s.avatar_key ? (
                         <img src={staffAvatarUrl(s.avatar_key)} alt="" className="h-full w-full object-cover" />
                       ) : (
                         <User size={14} className="text-app-text-muted" />
                       )}
                    </div>
                    <div className="flex flex-col min-w-0 flex-1">
                       <span className="text-sm font-black text-app-text truncate">
                         {s.full_name}
                       </span>
                       <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                         {s.role.replace(/_/g, " ")}
                       </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : query.trim() ? (
            <div className="p-4 text-center text-xs text-app-text-muted">No staff found.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
