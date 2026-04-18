import {
  useCallback,
  useEffect,
  useMemo,
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
  LogOut,
  Users,
  User,
  ShieldCheck,
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
import type { SidebarTabId } from "./sidebarSections";


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

interface OrderSearchHit {
  transaction_id: string;
  display_id: string;
  customer_name: string | null;
  status: string;
  order_kind: string;
  party_name?: string | null;
  counterpoint_customer_code?: string | null;
}

interface ShipmentSearchHit {
  id: string;
  source: string;
  status: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  tracking_number: string | null;
  carrier: string | null;
  service_name: string | null;
  dest_summary: string | null;
}

interface WeddingSearchHit {
  id: string;
  party_name: string;
  groom_name: string | null;
  event_date: string | null;
}

interface AlterationSearchHit {
  id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_code: string | null;
  status: string;
  due_at: string | null;
}

interface ProductSearchGroup {
  productId: string;
  sku: string;
  productName: string;
  variationLabels: string[];
  matchedSkus: string[];
}

type SearchResultEntry =
  | { kind: "sku"; key: string; title: string; subtitle: string; meta: string }
  | { kind: "customer"; key: string; customer: Customer }
  | { kind: "order"; key: string; order: OrderSearchHit }
  | { kind: "shipment"; key: string; shipment: ShipmentSearchHit }
  | { kind: "product"; key: string; product: ProductSearchGroup }
  | { kind: "wedding"; key: string; wedding: WeddingSearchHit }
  | { kind: "alteration"; key: string; alteration: AlterationSearchHit };

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
  onSearchOpenOrder?: (transactionId: string) => void;
  onSearchOpenShipment?: (shipmentId: string) => void;
  onSearchOpenWeddingParty?: (partyId: string) => void;
  onSearchOpenAlteration?: (alterationId: string) => void;
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
  onNavigateToTab?: (tab: SidebarTabId, section?: string) => void;
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

function groupProductRows(
  rows: ControlBoardRow[],
  maxProducts: number,
): ProductSearchGroup[] {
  const out: ProductSearchGroup[] = [];
  const seen = new Map<string, ProductSearchGroup>();
  for (const r of rows) {
    let group = seen.get(r.product_id);
    if (!group) {
      group = {
        productId: r.product_id,
        sku: r.sku,
        productName: r.product_name,
        variationLabels: [],
        matchedSkus: [],
      };
      seen.set(r.product_id, group);
      out.push(group);
    }
    if (r.variation_label && !group.variationLabels.includes(r.variation_label)) {
      group.variationLabels.push(r.variation_label);
    }
    if (!group.matchedSkus.includes(r.sku)) {
      group.matchedSkus.push(r.sku);
    }
  }
  return out.slice(0, maxProducts);
}

function humanizeStatus(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "Unknown";
  return raw.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function humanizeOrderKind(kind: string | null | undefined): string {
  switch (kind) {
    case "regular_order":
      return "Order";
    case "special_order":
      return "Special Order";
    case "custom":
    case "custom_order":
      return "Custom";
    case "wedding_order":
      return "Wedding";
    case "layaway":
      return "Layaway";
    default:
      return humanizeStatus(kind);
  }
}

function fmtDateShort(value: string | null | undefined): string {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function GlobalTopBar({
  segments,
  onNavigateRegister,
  onSelectCustomerForPos,
  onSearchOpenCustomerDrawer,
  onSearchOpenProductDrawer,
  onSearchOpenWeddingPartyCustomers,
  onSearchOpenOrder,
  onSearchOpenShipment,
  onSearchOpenWeddingParty,
  onSearchOpenAlteration,
  onToggleSidebar,
  isRegisterOpen = false,
  onOpenHelp,
  onOpenBugReport,
  themeMode,
  onThemeToggle,
  cashierName,
  cashierAvatarKey,
  onNavigateToTab,
}: GlobalTopBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [skuHit, setSkuHit] = useState<{ sku: string; name: string } | null>(
    null,
  );
  const [products, setProducts] = useState<ProductSearchGroup[]>([]);
  const [orders, setOrders] = useState<OrderSearchHit[]>([]);
  const [shipments, setShipments] = useState<ShipmentSearchHit[]>([]);
  const [weddings, setWeddings] = useState<WeddingSearchHit[]>([]);
  const [alterations, setAlterations] = useState<AlterationSearchHit[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
  
  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  const resultEntries = useMemo<SearchResultEntry[]>(
    () => [
      ...(skuHit
        ? [
            {
              kind: "sku" as const,
              key: `sku:${skuHit.sku}`,
              title: skuHit.sku,
              subtitle: skuHit.name,
              meta: "ROS > Inventory > Exact SKU",
            },
          ]
        : []),
      ...customers.slice(0, 8).map((customer) => ({
        kind: "customer" as const,
        key: `customer:${customer.id}`,
        customer,
      })),
      ...orders.slice(0, 8).map((order) => ({
        kind: "order" as const,
        key: `order:${order.transaction_id}`,
        order,
      })),
      ...shipments.slice(0, 8).map((shipment) => ({
        kind: "shipment" as const,
        key: `shipment:${shipment.id}`,
        shipment,
      })),
      ...products.map((product) => ({
        kind: "product" as const,
        key: `product:${product.productId}`,
        product,
      })),
      ...weddings.slice(0, 8).map((wedding) => ({
        kind: "wedding" as const,
        key: `wedding:${wedding.id}`,
        wedding,
      })),
      ...alterations.slice(0, 8).map((alteration) => ({
        kind: "alteration" as const,
        key: `alteration:${alteration.id}`,
        alteration,
      })),
    ],
    [alterations, customers, orders, products, shipments, skuHit, weddings],
  );
  const indexedEntries = useMemo(
    () => resultEntries.map((entry, index) => ({ entry, index })),
    [resultEntries],
  );
  const skuEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "sku" }>; index: number } =>
          item.entry.kind === "sku",
      ),
    [indexedEntries],
  );
  const customerEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "customer" }>;
          index: number;
        } => item.entry.kind === "customer",
      ),
    [indexedEntries],
  );
  const orderEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "order" }>; index: number } =>
          item.entry.kind === "order",
      ),
    [indexedEntries],
  );
  const shipmentEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "shipment" }>;
          index: number;
        } => item.entry.kind === "shipment",
      ),
    [indexedEntries],
  );
  const productEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "product" }>;
          index: number;
        } => item.entry.kind === "product",
      ),
    [indexedEntries],
  );
  const weddingEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "wedding" }>;
          index: number;
        } => item.entry.kind === "wedding",
      ),
    [indexedEntries],
  );
  const alterationEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "alteration" }>;
          index: number;
        } => item.entry.kind === "alteration",
      ),
    [indexedEntries],
  );

  const pickCount = resultEntries.length;

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setCustomers([]);
      setSkuHit(null);
      setProducts([]);
      setOrders([]);
      setShipments([]);
      setWeddings([]);
      setAlterations([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setCustomers([]);
    setSkuHit(null);
    setProducts([]);
    setOrders([]);
    setShipments([]);
    setWeddings([]);
    setAlterations([]);
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
          setProducts(groupProductRows(data.rows ?? [], GLOBAL_SEARCH_PRODUCT_CAP));
        }
      })
    );

    requests.push(
      fetch(
        `${baseUrl}/api/transactions?search=${encodeURIComponent(q)}&show_closed=true&limit=8&offset=0`,
        { headers: apiAuth() },
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { items?: OrderSearchHit[] };
          setOrders(data.items ?? []);
        }
      }),
    );

    requests.push(
      fetch(`${baseUrl}/api/shipments?search=${encodeURIComponent(q)}&limit=8`, {
        headers: apiAuth(),
      }).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { items?: ShipmentSearchHit[] };
          setShipments(data.items ?? []);
        }
      }),
    );

    requests.push(
      fetch(
        `${baseUrl}/api/weddings/parties?search=${encodeURIComponent(q)}&page=1&limit=8`,
        { headers: apiAuth() },
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { data?: WeddingSearchHit[] };
          setWeddings(data.data ?? []);
        }
      }),
    );

    requests.push(
      fetch(`${baseUrl}/api/alterations?search=${encodeURIComponent(q)}`, {
        headers: apiAuth(),
      }).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as AlterationSearchHit[];
          setAlterations(data.slice(0, 8));
        }
      }),
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
      setOrders([]);
      setShipments([]);
      setWeddings([]);
      setAlterations([]);
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

  const pickProduct = (r: ProductSearchGroup) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    if (onSearchOpenProductDrawer) {
      onSearchOpenProductDrawer(
        r.sku,
        `${r.productName}${r.variationLabels[0] ? ` · ${r.variationLabels[0]}` : ""}`,
      );
      return;
    }
    onNavigateRegister();
  };

  const pickOrder = (transactionId: string) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    onSearchOpenOrder?.(transactionId);
  };

  const pickShipment = (shipmentId: string) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    onSearchOpenShipment?.(shipmentId);
  };

  const pickWedding = (partyId: string) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    onSearchOpenWeddingParty?.(partyId);
  };

  const pickAlteration = (alterationId: string) => {
    setOpen(false);
    setQuery("");
    setHighlightIndex(-1);
    onSearchOpenAlteration?.(alterationId);
  };

  const activateHighlighted = (e: KeyboardEvent, altRegister: boolean) => {
    if (pickCount === 0 || loading) return;
    const entry = resultEntries[highlightIndex >= 0 ? highlightIndex : 0];
    if (!entry) return;
    e.preventDefault();
    switch (entry.kind) {
      case "sku":
        pickSku();
        return;
      case "customer":
        if (altRegister && onSearchOpenCustomerDrawer) {
          pickCustomerRegister(entry.customer);
        } else {
          pickCustomer(entry.customer);
        }
        return;
      case "order":
        pickOrder(entry.order.transaction_id);
        return;
      case "shipment":
        pickShipment(entry.shipment.id);
        return;
      case "product":
        pickProduct(entry.product);
        return;
      case "wedding":
        pickWedding(entry.wedding.id);
        return;
      case "alteration":
        pickAlteration(entry.alteration.id);
        return;
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
              {!loading && resultEntries.length === 0 ? (
                <p className="px-4 py-3 text-sm text-app-text-muted">No matches.</p>
              ) : null}
              {resultEntries.length > 0 ? (
                <div className="space-y-2">
                  {skuEntries.map(({ entry, index }) => (
                      <button
                        key={entry.key}
                        type="button"
                        role="option"
                        aria-selected={highlightIndex === index}
                        data-search-index={index}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickSku()}
                        className={cn(
                          "flex w-full flex-col items-start gap-0.5 border-t border-app-border px-4 py-2.5 text-left",
                          highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                        )}
                      >
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {entry.meta}
                        </span>
                        <span className="font-mono text-sm font-bold text-app-text">{entry.title}</span>
                        <span className="text-xs text-app-text-muted">{entry.subtitle}</span>
                      </button>
                    ))}

                  {customers.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Customers
                      </p>
                      {customerEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickCustomer(entry.customer)}
                            className={cn(
                              "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-app-text">
                                {entry.customer.first_name} {entry.customer.last_name}
                              </span>
                              {entry.customer.customer_code ? (
                                <span className="font-mono text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
                                  {entry.customer.customer_code}
                                </span>
                              ) : null}
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Customers &gt; Profile
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {entry.customer.phone ?? entry.customer.email ?? "No contact info"}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}

                  {orders.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Orders
                      </p>
                      {orderEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickOrder(entry.order.transaction_id)}
                            className={cn(
                              "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-app-text">{entry.order.display_id}</span>
                              <span className="rounded-full border border-app-border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                {humanizeOrderKind(entry.order.order_kind)}
                              </span>
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Orders
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {entry.order.customer_name ??
                                (entry.order.counterpoint_customer_code
                                  ? `CP: ${entry.order.counterpoint_customer_code}`
                                  : "No customer")}
                              {" · "}
                              {humanizeStatus(entry.order.status)}
                              {entry.order.party_name ? ` · ${entry.order.party_name}` : ""}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}

                  {shipments.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Shipping
                      </p>
                      {shipmentEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickShipment(entry.shipment.id)}
                            className={cn(
                              "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-app-text">
                                {entry.shipment.tracking_number ?? entry.shipment.id.slice(0, 8)}
                              </span>
                              <span className="rounded-full border border-app-border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                {humanizeStatus(entry.shipment.status)}
                              </span>
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Shipping
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {[entry.shipment.customer_first_name, entry.shipment.customer_last_name]
                                .filter(Boolean)
                                .join(" ") || "No customer"}
                              {entry.shipment.dest_summary ? ` · ${entry.shipment.dest_summary}` : ""}
                              {entry.shipment.carrier ? ` · ${entry.shipment.carrier}` : ""}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}

                  {products.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Inventory
                      </p>
                      {productEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickProduct(entry.product)}
                            className={cn(
                              "flex w-full flex-col items-start gap-1 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <span className="font-semibold text-app-text">{entry.product.productName}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Inventory &gt; Product Hub
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {entry.product.matchedSkus.slice(0, 2).join(" · ")}
                            </span>
                            {entry.product.variationLabels.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {entry.product.variationLabels.slice(0, 4).map((label: string) => (
                                  <span
                                    key={`${entry.product.productId}-${label}`}
                                    className="rounded-full border border-app-border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted"
                                  >
                                    {label}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </button>
                        ))}
                    </div>
                  ) : null}

                  {weddings.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Weddings
                      </p>
                      {weddingEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickWedding(entry.wedding.id)}
                            className={cn(
                              "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <span className="font-semibold text-app-text">{entry.wedding.party_name}</span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Weddings &gt; Wedding Manager
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {entry.wedding.groom_name ?? "No groom name"} · {fmtDateShort(entry.wedding.event_date)}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}

                  {alterations.length > 0 ? (
                    <div className="border-t border-app-border pt-2">
                      <p className="px-4 pb-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Alterations
                      </p>
                      {alterationEntries.map(({ entry, index }) => (
                          <button
                            key={entry.key}
                            type="button"
                            role="option"
                            aria-selected={highlightIndex === index}
                            data-search-index={index}
                            onMouseEnter={() => setHighlightIndex(index)}
                            onClick={() => pickAlteration(entry.alteration.id)}
                            className={cn(
                              "flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left",
                              highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2",
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-app-text">
                                {[entry.alteration.customer_first_name, entry.alteration.customer_last_name]
                                  .filter(Boolean)
                                  .join(" ") || "Alteration"}
                              </span>
                              {entry.alteration.customer_code ? (
                                <span className="font-mono text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
                                  {entry.alteration.customer_code}
                                </span>
                              ) : null}
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              ROS &gt; Alterations
                            </span>
                            <span className="text-xs text-app-text-muted">
                              {humanizeStatus(entry.alteration.status)} · Due {fmtDateShort(entry.alteration.due_at)}
                            </span>
                          </button>
                        ))}
                    </div>
                  ) : null}
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
            {isTailscaleRemote && (
              <div 
                className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-500 text-[10px] font-black uppercase tracking-widest animate-in fade-in slide-in-from-right-2"
                title="Connected via Tailscale Remote Access"
              >
                <ShieldCheck size={12} className="shrink-0" />
                Remote Node
              </div>
            )}
            <div className="text-right hidden sm:block">
            <p className="text-xs font-bold text-app-text leading-tight">
              {staffDisplayName || (isRegisterOpen ? (cashierName || "Cashier") : "User")}
            </p>
            <div className="flex items-center justify-end gap-1.5">
               <div className={cn("h-1.5 w-1.5 rounded-full", isRegisterOpen ? "bg-emerald-500" : "bg-rose-500")} />
               <p className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                 Till {isRegisterOpen ? "Open" : "Closed"}
               </p>
            </div>
          </div>
          
          <div className="relative" ref={userMenuRef}>
            <button
               type="button"
               onClick={() => setUserMenuOpen(!userMenuOpen)}
               className={cn(
                 "flex h-11 w-11 items-center justify-center rounded-2xl border-2 overflow-hidden transition-all",
                 isRegisterOpen ? "border-emerald-500/20" : "border-app-border hover:border-app-accent/40",
                 userMenuOpen && "border-app-accent ring-4 ring-app-accent/10"
               )}
               aria-expanded={userMenuOpen}
               aria-haspopup="true"
            >
              <img 
                src={staffAvatarUrl(staffAvatarKey || (isRegisterOpen ? cashierAvatarKey : null))} 
                alt="" 
                className="h-full w-full object-cover" 
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-[100] mt-2 w-56 origin-top-right rounded-2xl border border-app-border bg-app-surface p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                <div className="px-3 py-2 border-b border-app-border mb-1.5">
                   <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Identity</p>
                   <p className="text-xs font-black truncate text-app-text">{staffDisplayName || "Authenticated Staff"}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    if (onNavigateToTab) {
                      onNavigateToTab("settings", "profile");
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-app-text hover:bg-app-surface-2 transition-all active:scale-95"
                >
                  <User size={16} className="text-app-accent" />
                  <span>My Profile</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    clearStaffCredentials();
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-app-text hover:bg-app-surface-2 transition-all active:scale-95"
                >
                  <Users size={16} className="text-app-accent" />
                  <span>Change Staff Member</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    clearStaffCredentials();
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-rose-500 hover:bg-rose-500/5 transition-all active:scale-95"
                >
                  <LogOut size={16} />
                  <span>Logout</span>
                </button>
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
