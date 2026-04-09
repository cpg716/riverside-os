import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChevronRight, Search, WifiOff, RefreshCw, Menu } from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import { useOfflineSync } from "../../lib/offlineQueue";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import NotificationCenterBell from "../notifications/NotificationCenterBell";
import { HelpCenterTriggerButton } from "../help/HelpCenterDrawer";
import { BugReportTriggerButton } from "../bug-report/BugReportFlow";

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

interface HeaderProps {
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

export default function Header({
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
}: HeaderProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersHasMore, setCustomersHasMore] = useState(false);
  const [customerLoadMoreBusy, setCustomerLoadMoreBusy] = useState(false);
  const [skuHit, setSkuHit] = useState<{ sku: string; name: string } | null>(
    null,
  );
  const [products, setProducts] = useState<ControlBoardRow[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    backofficeHeaders,
    staffCode,
    clearStaffCredentials,
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
      setCustomersHasMore(false);
      setSkuHit(null);
      setProducts([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setSkuHit(null);
    const requests: Promise<void>[] = [];

    if (q.length >= 2) {
      setCustomersHasMore(false);
      requests.push(
        fetch(
          `${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=${GLOBAL_SEARCH_CUSTOMER_PAGE}&offset=0`,
          { headers: apiAuth() },
        ).then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as Customer[];
            setCustomers(data);
            setCustomersHasMore(data.length === GLOBAL_SEARCH_CUSTOMER_PAGE);
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

  const loadMoreCustomers = useCallback(async () => {
    if (!customersHasMore || customerLoadMoreBusy || loading) return;
    const q = query.trim();
    if (q.length < 2) return;
    setCustomerLoadMoreBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=${GLOBAL_SEARCH_CUSTOMER_PAGE}&offset=${customers.length}`,
        { headers: apiAuth() },
      );
      if (res.ok) {
        const data = (await res.json()) as Customer[];
        setCustomers((prev) => [...prev, ...data]);
        setCustomersHasMore(data.length === GLOBAL_SEARCH_CUSTOMER_PAGE);
      }
    } finally {
      setCustomerLoadMoreBusy(false);
    }
  }, [
    customersHasMore,
    customerLoadMoreBusy,
    loading,
    query,
    customers.length,
    apiAuth,
  ]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 2) {
      setCustomers([]);
      setCustomersHasMore(false);
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
    <header className="z-50 flex h-[76px] shrink-0 items-center gap-2 border-b border-app-border bg-app-surface px-4 sm:px-6">
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
            {i > 0 ? (
              <ChevronRight className="h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />
            ) : null}
            {seg.onClick ? (
              <button
                type="button"
                onClick={seg.onClick}
                className="truncate rounded px-1 text-left text-app-text hover:bg-app-surface-2"
              >
                {seg.label}
              </button>
            ) : (
              <span
                className={
                  i === segments.length - 1
                    ? "truncate font-bold text-app-text"
                    : "truncate"
                }
              >
                {seg.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div ref={wrapRef} className="relative mx-auto flex min-w-0 max-w-xl flex-1 justify-center">
        <div className="relative w-full">
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
            placeholder="Search customers, SKU, products…  (Cmd+K)"
            className="ui-input w-full rounded-xl bg-app-surface-2 py-2.5 pl-12 pr-4 font-medium"
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
            className="absolute left-0 right-0 top-full z-50 mt-2 max-h-80 overflow-auto rounded-2xl border border-app-border bg-app-surface py-2 shadow-xl"
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
                      ? "bg-app-surface-2 ring-1 ring-inset ring-app-border"
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
                  <span className="ui-type-instruction-muted text-xs">
                    {onSearchOpenProductDrawer
                      ? "Preview in drawer — open POS if needed"
                      : "Opens POS — add on Register via scanner"}
                  </span>
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
                          active
                            ? "bg-app-surface-2 ring-1 ring-inset ring-app-border"
                            : ""
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
                          {c.phone ? (
                            <span className="ml-2 text-xs text-app-text-muted">
                              {c.phone}
                            </span>
                          ) : null}
                        </button>
                        {onSearchOpenCustomerDrawer ? (
                          <button
                            type="button"
                            title="Open register with this customer"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              pickCustomerRegister(c);
                            }}
                            className="shrink-0 border-l border-app-border px-3 py-2 text-[10px] font-black uppercase tracking-tight text-app-text transition-colors hover:bg-app-surface-2"
                          >
                            Till
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                  {customersHasMore ? (
                    <div className="px-4 py-2">
                      <button
                        type="button"
                        disabled={customerLoadMoreBusy || loading}
                        onClick={() => void loadMoreCustomers()}
                        className="w-full rounded-lg border border-app-border bg-app-surface-2 py-2 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface disabled:opacity-50"
                      >
                        {customerLoadMoreBusy ? "Loading…" : "More customers"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {products.length > 0 ? (
                <div className="border-t border-app-border pt-2">
                  <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Inventory
                  </p>
                  {products.map((r, pi) => {
                    const idx = (skuHit ? 1 : 0) + customers.length + pi;
                    const active = highlightIndex === idx;
                    return (
                    <button
                      key={r.variant_id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      data-search-index={idx}
                      onMouseEnter={() => setHighlightIndex(idx)}
                      onClick={() => pickProduct(r)}
                      className={`w-full px-4 py-2 text-left ${
                        active
                          ? "bg-app-surface-2 ring-1 ring-inset ring-app-border"
                          : "hover:bg-app-surface-2"
                      }`}
                    >
                      <span className="font-mono text-xs font-bold text-app-text">
                        {r.sku}
                      </span>
                      <span className="ml-2 text-sm text-app-text-muted">
                        {r.product_name}
                        {r.variation_label ? ` · ${r.variation_label}` : ""}
                      </span>
                    </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {staffCode.trim() && !isRegisterOpen ? (
          <button
            type="button"
            onClick={() => clearStaffCredentials()}
            className="ui-btn-secondary max-sm:px-2 max-sm:py-1 max-sm:text-[9px] px-3 py-1.5 text-[10px] font-black uppercase tracking-widest"
          >
            Switch staff
          </button>
        ) : null}
        {onOpenHelp ? <HelpCenterTriggerButton onOpen={onOpenHelp} /> : null}
        {onOpenBugReport ? <BugReportTriggerButton onOpen={onOpenBugReport} /> : null}
        <NotificationCenterBell />
        {!isOnline && (
          <div
            className="flex max-w-[min(280px,40vw)] cursor-help items-center gap-1.5 rounded-full bg-red-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-red-700"
            title="Offline playbook: completed sales queue locally and sync when online. Register close, inventory edits, and Back Office need connectivity — finish open tasks first."
          >
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Offline Mode</span>
          </div>
        )}
        {queueCount > 0 && (
          <div
            className="flex max-w-[min(280px,40vw)] cursor-help items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-700"
            title="Queued checkouts retry when the connection returns. If a sale stays stuck, verify API and staff headers — do not re-charge the customer."
          >
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${isOnline ? "animate-spin" : ""}`} />
            <span className="truncate">
              {queueCount} Pending Sync{queueCount !== 1 && "s"}
            </span>
          </div>
        )}
      </div>
    </header>
  );
}
