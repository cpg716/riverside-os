import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { 
  ChevronRight, 
  Search, 
  Menu,
  Sun,
  Moon,
} from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import { useOfflineSync } from "../../lib/offlineQueue";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import NotificationCenterBell from "../notifications/NotificationCenterBell";
import { HelpCenterTriggerButton } from "../help/HelpCenterDrawer";
import { BugReportTriggerButton } from "../bug-report/BugReportFlow";
import { useTopBar } from "../../context/TopBarContextLogic";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import type { ThemeMode } from "../../App";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

const GLOBAL_SEARCH_CUSTOMER_PAGE = 40;

export interface BreadcrumbSegment {
  label: string;
  onClick?: () => void;
}

interface ControlBoardRow {
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
}

interface GlobalTopBarProps {
  segments: BreadcrumbSegment[];
  onNavigateRegister: () => void;
  onSelectCustomerForPos?: (customer: Customer) => void;
  /** When set, customer hits open the command-center drawer instead of jumping to the register. */
  onSearchOpenCustomerDrawer?: (customer: Customer) => void;
  /** SKU / product hits open a slide-over with scan resolution and pricing. */
  onSearchOpenProductDrawer?: (sku: string, hintName?: string) => void;
  /** Opens customer list filtered by wedding party name. */
  onSearchOpenWeddingPartyCustomers?: (partyQuery: string) => void;
  /** Toggles the responsive sidebar. */
  onToggleSidebar?: () => void;
  /** When false, show optional Back Office "Switch staff" (register not required for BO). */
  isRegisterOpen?: boolean;
  onOpenHelp?: () => void;
  onOpenBugReport?: () => void;
  themeMode: ThemeMode;
  onThemeToggle: () => void;
  cashierName?: string | null;
  cashierAvatarKey?: string | null;
}

function looksLikeSku(q: string): boolean {
  const t = q.trim();
  if (t.length < 2 || t.length > 64) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(t);
}

/** Server ranks parent (template) text hits before variant-only hits; keep one row per product for the palette. */
const GLOBAL_SEARCH_PRODUCT_CAP = 8;
const GLOBAL_SEARCH_CONTROL_BOARD_LIMIT = 48;

function pickDistinctProductRows(
  rows: ControlBoardRow[],
  maxProducts: number,
): ControlBoardRow[] {
  const seen = new Set<string>();
  const out: ControlBoardRow[] = [];
  for (const r of rows) {
    if (seen.has(r.product_id)) continue;
    seen.add(r.product_id);
    out.push(r);
    if (out.length >= maxProducts) break;
  }
  return out;
}

export default function GlobalTopBar({
  segments,
  onNavigateRegister,
  onSelectCustomerForPos,
  onSearchOpenCustomerDrawer,
  onSearchOpenProductDrawer,
  onSearchOpenWeddingPartyCustomers,
  onToggleSidebar,
  isRegisterOpen = false,
  onOpenHelp,
  onOpenBugReport,
  themeMode,
  onThemeToggle,
  cashierName,
  cashierAvatarKey,
}: GlobalTopBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [skuHit, setSkuHit] = useState<{ sku: string; name: string } | null>(
    null,
  );
  const [products, setProducts] = useState<ControlBoardRow[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { slotContent } = useTopBar();

  const {
    backofficeHeaders,
    clearStaffCredentials,
    staffDisplayName,
    staffAvatarKey
  } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const { isOnline, queueCount } = useOfflineSync(baseUrl, apiAuth);

  const pickCount =
    (skuHit ? 1 : 0) + customers.length + products.length;

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setCustomers([]);
      setSkuHit(null);
      setProducts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSkuHit(null);
    const requests: Promise<void>[] = [];

    if (q.length >= 2) {
      requests.push(
        fetch(
          `${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=${GLOBAL_SEARCH_CUSTOMER_PAGE}&offset=0`,
          { headers: apiAuth() },
        ).then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as Customer[];
            setCustomers(data);
          }
        }),
      );
    }

    if (looksLikeSku(q) || q.length >= 3) {
      requests.push(
        fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
          headers: apiAuth(),
        }).then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as {
              sku: string;
              name: string;
            };
            setSkuHit({ sku: data.sku, name: data.name });
          }
        })
      );
    }

    requests.push(
      fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&parent_rank_first=true&limit=${GLOBAL_SEARCH_CONTROL_BOARD_LIMIT}`,
        { headers: apiAuth() }
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { rows: ControlBoardRow[] };
          setProducts(
            pickDistinctProductRows(
              data.rows ?? [],
              GLOBAL_SEARCH_PRODUCT_CAP
            )
          );
        }
      })
    );

    try {
      await Promise.all(requests);
    } finally {
      setLoading(false);
    }
  }, [apiAuth]);



  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setCustomers([]);
      setSkuHit(null);
      setProducts([]);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      void runSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, runSearch]);

  useEffect(() => {
    if (pickCount === 0) {
      setHighlightIndex(-1);
      return;
    }
    setHighlightIndex((prev) => {
      if (prev < 0) return 0;
      if (prev >= pickCount) return pickCount - 1;
      return prev;
    });
  }, [pickCount]);

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(
      `[data-search-index="${highlightIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    
    const onGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onGlobalKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onGlobalKeyDown);
    };
  }, []);

  const pickCustomer = (c: Customer) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    if (onSearchOpenCustomerDrawer) {
      onSearchOpenCustomerDrawer(c);
      return;
    }
    onNavigateRegister();
    onSelectCustomerForPos?.(c);
  };

  const pickCustomerRegister = (c: Customer) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    onNavigateRegister();
    onSelectCustomerForPos?.(c);
  };

  const pickSku = () => {
    if (!skuHit) return;
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    if (onSearchOpenProductDrawer) {
      onSearchOpenProductDrawer(skuHit.sku, skuHit.name);
      return;
    }
    onNavigateRegister();
  };

  const pickProduct = (r: ControlBoardRow) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    if (onSearchOpenProductDrawer) {
      onSearchOpenProductDrawer(
        r.sku,
        `${r.product_name}${r.variation_label ? ` · ${r.variation_label}` : ""}`,
      );
      return;
    }
    onNavigateRegister();
  };

  const activateHighlighted = (e: KeyboardEvent, altRegister: boolean) => {
    if (pickCount === 0 || loading) return;
    const i = highlightIndex >= 0 ? highlightIndex : 0;
    let cursor = 0;
    if (skuHit) {
      if (i === cursor) {
        e.preventDefault();
        pickSku();
        return;
      }
      cursor += 1;
    }
    for (const c of customers) {
      if (i === cursor) {
        e.preventDefault();
        if (altRegister && onSearchOpenCustomerDrawer) {
          pickCustomerRegister(c);
        } else {
          pickCustomer(c);
        }
        return;
      }
      cursor += 1;
    }
    for (const r of products) {
      if (i === cursor) {
        e.preventDefault();
        pickProduct(r);
        return;
      }
      cursor += 1;
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setHighlightIndex(-1);
      return;
    }

    const panelOpen = open && query.trim().length >= 2;
    if (!panelOpen || loading) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => {
        if (pickCount === 0) return -1;
        if (prev < 0) return 0;
        return Math.min(prev + 1, pickCount - 1);
      });
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => {
        if (pickCount === 0) return -1;
        if (prev <= 0) return -1;
        return prev - 1;
      });
      return;
    }

    if (e.key === "Enter") {
      activateHighlighted(e, e.altKey);
    }
  };

  return (
    <header className="sticky top-0 z-50 flex h-[84px] shrink-0 items-center gap-6 border-b border-app-border bg-app-surface/90 backdrop-blur-md px-4 sm:px-8">
      <div className="flex h-full items-center gap-4 min-w-[240px]">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSidebar();
            }}
            className="ui-touch-target flex shrink-0 items-center justify-center rounded-xl bg-app-surface-2 text-app-text-muted hover:bg-app-surface hover:text-app-text md:hidden"
            aria-label="Toggle menu"
          >
            <Menu size={20} />
          </button>
        )}
        <nav
          className="hidden min-w-0 shrink-0 items-center gap-1 text-sm font-semibold text-app-text-muted md:flex"
          aria-label="Breadcrumb"
        >
          {segments.map((seg, i) => (
            <span key={`${seg.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />
              )}
              {seg.onClick ? (
                <button
                  type="button"
                  onClick={seg.onClick}
                  className="truncate rounded px-2 py-1 text-left text-app-text hover:bg-app-accent/10 hover:text-app-accent transition-colors"
                >
                  {seg.label}
                </button>
              ) : (
                <span
                  className={cn(
                    "truncate px-2",
                    i === segments.length - 1
                      ? "font-bold text-app-text"
                      : "text-app-text-muted/60"
                  )}
                >
                  {seg.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      </div>

      <div ref={wrapRef} className="relative flex flex-1 items-center justify-center min-w-0">
        <div className="relative w-full max-w-xl transition-all duration-300 focus-within:max-w-2xl">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-app-text-muted" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onSearchKeyDown}
            placeholder="Universal Search… (Cmd+K)"
            className="ui-input w-full rounded-2xl bg-app-surface-2 py-3 pl-12 pr-4 font-medium border-transparent focus:bg-app-surface focus:border-app-accent/50 focus:ring-0"
            aria-autocomplete="list"
            aria-expanded={open && query.trim().length >= 2}
            aria-controls="global-search-results"
            role="combobox"
          />
          {open && query.trim().length >= 2 ? (
            <div
              ref={listRef}
              id="global-search-results"
              role="listbox"
              aria-label="Search results"
              className="absolute left-0 right-0 top-full z-50 mt-2 max-h-80 overflow-auto rounded-2xl border border-app-border bg-app-surface py-2 shadow-2xl animate-in fade-in zoom-in-95 duration-200"
            >
              {onSearchOpenCustomerDrawer && customers.length > 0 ? (
                <p className="border-b border-app-border px-4 py-1.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">
                  ↑↓ highlight · Enter profile · Alt+Enter till
                </p>
              ) : null}
              {onSearchOpenWeddingPartyCustomers ? (
                <div className="border-b border-app-border px-3 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      const term = query.trim();
                      if (!term) return;
                      setOpen(false);
                      setQuery("");
                      setHighlightIndex(-1);
                      onSearchOpenWeddingPartyCustomers(term);
                    }}
                    className="inline-flex items-center rounded-full border border-app-accent/35 bg-app-accent/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent"
                  >
                    Wedding party customer list: "{query.trim()}"
                  </button>
                </div>
              ) : null}
              {loading ? (
                <p className="px-4 py-3 text-sm text-app-text-muted">Working…</p>
              ) : null}
              {!loading && !customers.length && !skuHit && !products.length ? (
                <p className="px-4 py-3 text-sm text-app-text-muted">No matches.</p>
              ) : null}
              {skuHit ? (
                <button
                  type="button"
                  role="option"
                  aria-selected={highlightIndex === 0}
                  data-search-index={0}
                  onMouseEnter={() => setHighlightIndex(0)}
                  onClick={() => pickSku()}
                  className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left ${
                    highlightIndex === 0
                      ? "bg-app-surface-2"
                      : "hover:bg-app-surface-2"
                  }`}
                >
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    SKU
                  </span>
                  <span className="font-mono text-sm font-bold text-app-text">
                    {skuHit.sku}
                  </span>
                  <span className="text-xs text-app-text-muted">{skuHit.name}</span>
                </button>
              ) : null}
              {customers.length > 0 ? (
                <div className="border-t border-app-border pt-2">
                  <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Customers
                  </p>
                  {customers.map((c, ci) => {
                    const idx = (skuHit ? 1 : 0) + ci;
                    const active = highlightIndex === idx;
                    return (
                      <div
                        key={c.id}
                        role="option"
                        aria-selected={active}
                        data-search-index={idx}
                        onMouseEnter={() => setHighlightIndex(idx)}
                        className={`flex w-full items-stretch gap-0 border-b border-app-border last:border-0 ${
                          active ? "bg-app-surface-2" : ""
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => pickCustomer(c)}
                          className="min-w-0 flex-1 px-4 py-2.5 text-left hover:bg-app-surface-2"
                        >
                          <span className="font-semibold text-app-text">
                            {c.first_name} {c.last_name}
                          </span>
                          {c.customer_code ? (
                            <span className="ml-2 font-mono text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
                              {c.customer_code}
                            </span>
                          ) : null}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-3 min-w-[400px]">
        {/* Dynamic Slot Region */}
        <div className="flex items-center gap-4 px-4 border-r border-app-border mr-2 empty:hidden">
          {slotContent}
        </div>

        {/* Global Action Cluster */}
        <div className="flex items-center gap-1.5 border-r border-app-border pr-4 mr-2">
          {onOpenHelp ? <HelpCenterTriggerButton onOpen={onOpenHelp} /> : null}
          {onOpenBugReport ? <BugReportTriggerButton onOpen={onOpenBugReport} /> : null}
          
          <button
            type="button"
            onClick={onThemeToggle}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all active:scale-95"
            title={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "light" ? <Moon size={20} /> : <Sun size={20} />}
          </button>

          <NotificationCenterBell />
        </div>

        {/* User Profile Hookup */}
        <div className="flex items-center gap-3 pl-2">
          <div className="text-right hidden sm:block">
            <p className="text-xs font-bold text-app-text leading-tight">
              {isRegisterOpen ? (cashierName || staffDisplayName || "Cashier") : (staffDisplayName || "User")}
            </p>
            <div className="flex items-center justify-end gap-1.5">
               <div className={cn("h-1.5 w-1.5 rounded-full", isRegisterOpen ? "bg-emerald-500" : "bg-rose-500")} />
               <p className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                 Till {isRegisterOpen ? "Open" : "Closed"}
               </p>
            </div>
          </div>
          
          <div className="relative group">
            <button
               type="button"
               disabled={isRegisterOpen}
               onClick={() => !isRegisterOpen && clearStaffCredentials()}
               className={cn(
                 "flex h-11 w-11 items-center justify-center rounded-2xl border-2 overflow-hidden transition-all",
                 isRegisterOpen ? "border-emerald-500/20" : "border-app-border hover:border-app-accent/40"
               )}
            >
              <img 
                src={staffAvatarUrl(isRegisterOpen ? (cashierAvatarKey || staffAvatarKey) : staffAvatarKey)} 
                alt="" 
                className="h-full w-full object-cover" 
              />
            </button>
            {!isRegisterOpen && (
              <div className="absolute top-full right-0 mt-2 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity">
                <div className="bg-app-surface border border-app-border rounded-lg shadow-xl px-3 py-1.5 text-[9px] font-bold uppercase tracking-widest whitespace-nowrap">
                  Click to log out / switch
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Status Indicators */}
        <div className="flex items-center gap-2">
          {!isOnline && (
            <div className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" title="Offline Mode" />
          )}
          {queueCount > 0 && (
            <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" title={`${queueCount} Pending Syncs`} />
          )}
        </div>
      </div>
    </header>
  );
}

function cn(...inputs: (string | boolean | undefined | null | Record<string, boolean>)[]) {
  return inputs
    .filter(Boolean)
    .map((x) => {
      if (typeof x === "object" && x !== null) {
        return Object.entries(x as Record<string, boolean>)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(" ");
      }
      return x;
    })
    .join(" ");
}
