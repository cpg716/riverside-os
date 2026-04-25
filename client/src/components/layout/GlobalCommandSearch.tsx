import { getBaseUrl } from "../../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Command, Search } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Customer } from "../pos/CustomerSelector";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import type { SidebarTabId } from "./sidebarSections";

function cn(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs));
}

const baseUrl = getBaseUrl();
const GLOBAL_SEARCH_CUSTOMER_PAGE = 40;
const GLOBAL_SEARCH_PRODUCT_CAP = 8;
const GLOBAL_SEARCH_CONTROL_BOARD_LIMIT = 48;

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
  customer_phone?: string | null;
  customer_email?: string | null;
  item_description?: string | null;
  work_requested?: string | null;
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

interface GlobalCommandSearchProps {
  onNavigateRegister: () => void;
  onSelectCustomerForPos?: (customer: Customer) => void;
  onSearchOpenCustomerDrawer?: (customer: Customer) => void;
  onSearchOpenProductDrawer?: (sku: string, hintName?: string) => void;
  onSearchOpenWeddingPartyCustomers?: (partyQuery: string) => void;
  onSearchOpenOrder?: (transactionId: string) => void;
  onSearchOpenShipment?: (shipmentId: string) => void;
  onSearchOpenWeddingParty?: (partyId: string) => void;
  onSearchOpenAlteration?: (alterationId: string) => void;
  onNavigateToTab?: (tab: SidebarTabId, section?: string) => void;
  variant?: "backoffice" | "pos";
}

function looksLikeSku(q: string): boolean {
  const t = q.trim();
  if (t.length < 2 || t.length > 64) return false;
  if (/\s/.test(t)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(t);
}

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

export default function GlobalCommandSearch({
  onNavigateRegister,
  onSelectCustomerForPos,
  onSearchOpenCustomerDrawer,
  onSearchOpenProductDrawer,
  onSearchOpenWeddingPartyCustomers,
  onSearchOpenOrder,
  onSearchOpenShipment,
  onSearchOpenWeddingParty,
  onSearchOpenAlteration,
  onNavigateToTab,
  variant = "backoffice",
}: GlobalCommandSearchProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [skuHit, setSkuHit] = useState<{ sku: string; name: string } | null>(null);
  const [products, setProducts] = useState<ProductSearchGroup[]>([]);
  const [orders, setOrders] = useState<OrderSearchHit[]>([]);
  const [shipments, setShipments] = useState<ShipmentSearchHit[]>([]);
  const [weddings, setWeddings] = useState<WeddingSearchHit[]>([]);
  const [alterations, setAlterations] = useState<AlterationSearchHit[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [commandHintVisible, setCommandHintVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const resetSearch = useCallback(() => {
    setQuery("");
    setHighlightIndex(-1);
    setCustomers([]);
    setSkuHit(null);
    setProducts([]);
    setOrders([]);
    setShipments([]);
    setWeddings([]);
    setAlterations([]);
    setLoading(false);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    resetSearch();
  }, [resetSearch]);

  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: closePalette,
    initialFocusRef: inputRef,
  });

  const isPosVariant = variant === "pos";

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
        ): item is { entry: Extract<SearchResultEntry, { kind: "customer" }>; index: number } =>
          item.entry.kind === "customer",
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
        ): item is { entry: Extract<SearchResultEntry, { kind: "shipment" }>; index: number } =>
          item.entry.kind === "shipment",
      ),
    [indexedEntries],
  );
  const productEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "product" }>; index: number } =>
          item.entry.kind === "product",
      ),
    [indexedEntries],
  );
  const weddingEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "wedding" }>; index: number } =>
          item.entry.kind === "wedding",
      ),
    [indexedEntries],
  );
  const alterationEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "alteration" }>; index: number } =>
          item.entry.kind === "alteration",
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

    requests.push(
      fetch(
        `${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=${GLOBAL_SEARCH_CUSTOMER_PAGE}&offset=0`,
        { headers: apiAuth() },
      ).then(async (res) => {
        if (res.ok) setCustomers((await res.json()) as Customer[]);
      }),
    );

    if (looksLikeSku(q) || q.length >= 3) {
      requests.push(
        fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
          headers: apiAuth(),
        }).then(async (res) => {
          if (res.ok) {
            const data = (await res.json()) as { sku: string; name: string };
            setSkuHit({ sku: data.sku, name: data.name });
          }
        }),
      );
    }

    requests.push(
      fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&parent_rank_first=true&limit=${GLOBAL_SEARCH_CONTROL_BOARD_LIMIT}`,
        { headers: apiAuth() },
      ).then(async (res) => {
        if (res.ok) {
          const data = (await res.json()) as { rows: ControlBoardRow[] };
          setProducts(groupProductRows(data.rows ?? [], GLOBAL_SEARCH_PRODUCT_CAP));
        }
      }),
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
          setAlterations(data.filter((row) => row.status !== "picked_up").slice(0, 8));
        }
      }),
    );

    try {
      await Promise.all(requests);
    } finally {
      setLoading(false);
    }
  }, [apiAuth]);

  const openPalette = useCallback((seed = "") => {
    setOpen(true);
    setCommandHintVisible(false);
    if (seed) setQuery(seed);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!open || query.trim().length < 2) {
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
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [open, query, runSearch]);

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(timeout);
  }, [open]);

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
    const el = listRef.current.querySelector(`[data-search-index="${highlightIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useEffect(() => {
    const onGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
      }
      if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        openPalette();
      }
    };

    document.addEventListener("keydown", onGlobalKeyDown);
    return () => document.removeEventListener("keydown", onGlobalKeyDown);
  }, [openPalette]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const pickCustomer = (c: Customer) => {
    closePalette();
    if (onSearchOpenCustomerDrawer) {
      onSearchOpenCustomerDrawer(c);
      return;
    }
    onNavigateRegister();
    onSelectCustomerForPos?.(c);
  };

  const pickCustomerRegister = (c: Customer) => {
    closePalette();
    onNavigateRegister();
    onSelectCustomerForPos?.(c);
  };

  const pickSku = () => {
    if (!skuHit) return;
    closePalette();
    if (onSearchOpenProductDrawer) {
      onSearchOpenProductDrawer(skuHit.sku, skuHit.name);
      return;
    }
    onNavigateRegister();
  };

  const pickProduct = (r: ProductSearchGroup) => {
    closePalette();
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
    closePalette();
    onSearchOpenOrder?.(transactionId);
  };

  const pickShipment = (shipmentId: string) => {
    closePalette();
    onSearchOpenShipment?.(shipmentId);
  };

  const pickWedding = (partyId: string) => {
    closePalette();
    onSearchOpenWeddingParty?.(partyId);
  };

  const pickAlteration = (alterationId: string) => {
    closePalette();
    onSearchOpenAlteration?.(alterationId);
  };

  const activateHighlighted = (e: KeyboardEvent<HTMLInputElement>, altRegister: boolean) => {
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
      closePalette();
      return;
    }

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
    <>
      <div
        className={cn(
          "order-3 flex min-w-0 items-center",
          isPosVariant
            ? "w-auto justify-start lg:order-none lg:flex-none"
            : "w-full justify-center lg:order-none lg:flex-1",
        )}
      >
        <button
          type="button"
          onClick={() => openPalette()}
          onMouseEnter={() => setCommandHintVisible(true)}
          onMouseLeave={() => setCommandHintVisible(false)}
          className={cn(
            "group relative flex items-center text-left shadow-sm transition-all duration-150 hover:border-app-accent/20 hover:bg-app-surface hover:shadow-md active:scale-[0.995]",
            isPosVariant
              ? "gap-2 rounded-2xl border border-app-border/70 bg-app-surface-2/95 px-3 py-2.5"
              : "w-full max-w-[16rem] gap-3 rounded-2xl border border-app-border/70 bg-app-surface-2/90 px-3.5 py-2.5 lg:w-auto",
          )}
          aria-label="Open universal search"
        >
          <div
            className={cn(
              "flex shrink-0 items-center justify-center rounded-xl bg-app-surface text-app-text-muted shadow-sm transition-colors group-hover:text-app-text",
              isPosVariant ? "h-9 w-9" : "h-9 w-9",
            )}
          >
            <Search size={17} aria-hidden />
          </div>
          <div className={cn("min-w-0", isPosVariant ? "hidden xl:block" : "flex-1")}>
            <p className="truncate text-sm font-bold text-app-text">
              {isPosVariant ? "Jump Search" : "Search"}
            </p>
            <p className="truncate text-xs text-app-text-muted">
              {isPosVariant
                ? "Customers, orders, SKU, weddings"
                : "Jump to customers, orders, inventory, and more"}
            </p>
          </div>
          <div
            className={cn(
              "shrink-0 items-center gap-1 rounded-xl border border-app-border/70 bg-app-surface px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted shadow-sm",
              isPosVariant ? "hidden 2xl:flex" : "hidden sm:flex",
            )}
          >
            <Command size={12} aria-hidden />
            <span>K</span>
          </div>
          {commandHintVisible ? (
            <div className="pointer-events-none absolute -bottom-10 right-0 hidden rounded-lg bg-app-text px-2.5 py-1 text-[10px] font-bold text-app-surface shadow-lg lg:block">
              {isPosVariant ? "Quick entity jump" : "Global jump search"}
            </div>
          ) : null}
        </button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-[110] flex items-start justify-center bg-black/35 px-4 py-6 backdrop-blur-[3px] sm:py-10">
          <button
            type="button"
            aria-label="Close universal search"
            className="absolute inset-0 cursor-default"
            onClick={closePalette}
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative z-[111] flex max-h-[min(88vh,56rem)] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-app-border bg-app-surface shadow-[0_30px_80px_-24px_rgba(15,23,42,0.35)] animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="border-b border-app-border bg-[color-mix(in_srgb,var(--app-surface)_88%,var(--app-surface-2))] px-4 py-4 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.24em] text-app-text-muted">
                    Universal Search
                  </p>
                  <p id={titleId} className="mt-1 text-sm font-semibold text-app-text">
                    Jump across Riverside without leaving your place.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closePalette}
                  className="hidden items-center gap-1 rounded-xl border border-app-border/70 bg-app-surface px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text sm:flex"
                  aria-label="Close universal search"
                >
                  <span>Esc</span>
                  <span className="opacity-40">close</span>
                </button>
              </div>

              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-app-text-muted" aria-hidden />
                <input
                  ref={inputRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Search customers, orders, inventory, weddings, shipments, alterations…"
                  className="ui-input w-full rounded-2xl border-transparent bg-app-surface-2 py-4 pl-12 pr-4 text-sm font-medium focus:border-app-accent/40 focus:bg-app-surface"
                  aria-autocomplete="list"
                  aria-expanded={query.trim().length >= 2}
                  aria-controls="global-command-search-results"
                  role="combobox"
                  aria-label="Universal search"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span className="rounded-full border border-app-border/70 bg-app-surface px-2.5 py-1">
                  Search here
                </span>
                <span className="rounded-full border border-app-border/70 bg-app-surface px-2.5 py-1">
                  Enter opens result
                </span>
                {onSearchOpenCustomerDrawer ? (
                  <span className="rounded-full border border-app-border/70 bg-app-surface px-2.5 py-1">
                    Alt+Enter sends customer to register
                  </span>
                ) : null}
                {onNavigateToTab ? (
                  <span className="rounded-full border border-app-border/70 bg-app-surface px-2.5 py-1">
                    / opens quickly
                  </span>
                ) : null}
              </div>
            </div>

            <div
              ref={listRef}
              id="global-command-search-results"
              role="listbox"
              aria-label="Search results"
              className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-4"
            >
              {query.trim().length < 2 ? (
                <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-[24px] border border-dashed border-app-border/70 bg-app-surface-2/60 px-6 text-center">
                  <Search size={40} className="mb-4 text-app-text-muted/70" aria-hidden />
                  <p className="text-sm font-black uppercase tracking-widest text-app-text">
                    Search Across Riverside
                  </p>
                  <p className="mt-2 max-w-lg text-sm font-medium text-app-text-muted">
                    Use this to jump between customers, orders, inventory, weddings, shipments, and alterations when you know the person, SKU, code, or party name but not the section.
                  </p>
                </div>
              ) : loading ? (
                <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-[24px] bg-app-surface-2/60 px-6 text-center">
                  <Search size={34} className="mb-4 animate-pulse text-app-accent/70" aria-hidden />
                  <p className="text-sm font-black uppercase tracking-widest text-app-text">Working…</p>
                  <p className="mt-2 text-sm font-medium text-app-text-muted">
                    Checking every major workspace for matches.
                  </p>
                </div>
              ) : resultEntries.length === 0 ? (
                <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-[24px] bg-app-surface-2/60 px-6 text-center">
                  <Search size={40} className="mb-4 text-app-text-muted/70" aria-hidden />
                  <p className="text-sm font-black uppercase tracking-widest text-app-text">
                    No matches found
                  </p>
                  <p className="mt-2 max-w-lg text-sm font-medium text-app-text-muted">
                    Try a broader name, order number, SKU, wedding party name, or shipment tracking value.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {onSearchOpenWeddingPartyCustomers ? (
                    <div className="rounded-2xl border border-app-border/70 bg-app-surface-2/70 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          const term = query.trim();
                          if (!term) return;
                          closePalette();
                          onSearchOpenWeddingPartyCustomers(term);
                        }}
                        className="inline-flex items-center rounded-full border border-app-accent/25 bg-app-accent/8 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent"
                      >
                        Wedding party customer list: "{query.trim()}"
                      </button>
                    </div>
                  ) : null}

                  <ResultSection title="Exact SKU" visible={skuEntries.length > 0}>
                    {skuEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={pickSku}
                      >
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {entry.meta}
                        </span>
                        <span className="font-mono text-sm font-bold text-app-text">{entry.title}</span>
                        <span className="text-xs text-app-text-muted">{entry.subtitle}</span>
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Customers" visible={customerEntries.length > 0}>
                    {customerEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickCustomer(entry.customer)}
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
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Orders" visible={orderEntries.length > 0}>
                    {orderEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickOrder(entry.order.transaction_id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-app-text">{entry.order.display_id}</span>
                          <span className="rounded-full border border-app-border/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
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
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Shipping" visible={shipmentEntries.length > 0}>
                    {shipmentEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickShipment(entry.shipment.id)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-app-text">
                            {entry.shipment.tracking_number ?? entry.shipment.id.slice(0, 8)}
                          </span>
                          <span className="rounded-full border border-app-border/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
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
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Inventory" visible={productEntries.length > 0}>
                    {productEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickProduct(entry.product)}
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
                            {entry.product.variationLabels.slice(0, 4).map((label) => (
                              <span
                                key={`${entry.product.productId}-${label}`}
                                className="rounded-full border border-app-border/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted"
                              >
                                {label}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Weddings" visible={weddingEntries.length > 0}>
                    {weddingEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickWedding(entry.wedding.id)}
                      >
                        <span className="font-semibold text-app-text">{entry.wedding.party_name}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          ROS &gt; Weddings &gt; Wedding Manager
                        </span>
                        <span className="text-xs text-app-text-muted">
                          {entry.wedding.groom_name ?? "No groom name"} · {fmtDateShort(entry.wedding.event_date)}
                        </span>
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Alterations" visible={alterationEntries.length > 0}>
                    {alterationEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickAlteration(entry.alteration.id)}
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
                          {entry.alteration.item_description ? ` · ${entry.alteration.item_description}` : ""}
                          {entry.alteration.customer_phone ?? entry.alteration.customer_email
                            ? ` · ${entry.alteration.customer_phone ?? entry.alteration.customer_email}`
                            : ""}
                        </span>
                      </ResultButton>
                    ))}
                  </ResultSection>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ResultSection({
  title,
  visible,
  children,
}: {
  title: string;
  visible: boolean;
  children: ReactNode;
}) {
  if (!visible) return null;
  return (
    <div className="rounded-[22px] border border-app-border/70 bg-app-surface shadow-sm">
      <p className="border-b border-app-border/70 px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
        {title}
      </p>
      <div className="divide-y divide-app-border/60">{children}</div>
    </div>
  );
}

function ResultButton({
  index,
  highlightIndex,
  onMouseEnter,
  onClick,
  children,
}: {
  index: number;
  highlightIndex: number;
  onMouseEnter: () => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={highlightIndex === index}
      data-search-index={index}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition-colors",
        highlightIndex === index ? "bg-app-surface-2" : "hover:bg-app-surface-2/70",
      )}
    >
      {children}
    </button>
  );
}
