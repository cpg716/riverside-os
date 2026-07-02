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
import { createPortal } from "react-dom";
import { Command, Search } from "lucide-react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Customer } from "../pos/CustomerSelector";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { requestRosieSearchIntent, type RosieSearchShortcutId } from "../../lib/rosie";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import type { SidebarTabId } from "./sidebarSections";

function cn(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs));
}

const baseUrl = getBaseUrl();
const GLOBAL_SEARCH_PRODUCT_CAP = 8;

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

interface HelpSearchHit {
  id: string;
  manual_id: string;
  manual_title: string;
  section_slug: string;
  section_heading: string;
  excerpt: string;
}

interface OperationalSearchHit {
  id: string;
  domain: string;
  title: string;
  subtitle: string;
  route_tab: SidebarTabId;
  route_section: string | null;
  transaction_id: string | null;
  occurred_at: string | null;
}

interface ProductSearchGroup {
  productId: string;
  sku: string;
  productName: string;
  variationLabels: string[];
  matchedSkus: string[];
}

type SearchShortcutIntent =
  | "open_orders"
  | "transaction_records"
  | "inventory_cleanup"
  | "alterations_queue"
  | "pickup_queue"
  | "daily_sales"
  | "help_center"
  | "rosie"
  | "qbo_failed"
  | "receiving"
  | "physical_inventory"
  | "gift_cards"
  | "loyalty"
  | "appointments"
  | "reports"
  | "register_close"
  | "podium_inbox"
  | "meilisearch_status";

interface SearchShortcut {
  intent: SearchShortcutIntent;
  key: string;
  title: string;
  subtitle: string;
  tab: SidebarTabId;
  section?: string;
}

type SearchResultEntry =
  | { kind: "sku"; key: string; title: string; subtitle: string; meta: string }
  | { kind: "customer"; key: string; customer: Customer }
  | { kind: "order"; key: string; order: OrderSearchHit }
  | { kind: "shipment"; key: string; shipment: ShipmentSearchHit }
  | { kind: "product"; key: string; product: ProductSearchGroup }
  | { kind: "wedding"; key: string; wedding: WeddingSearchHit }
  | { kind: "alteration"; key: string; alteration: AlterationSearchHit }
  | { kind: "help"; key: string; help: HelpSearchHit }
  | { kind: "operational"; key: string; operational: OperationalSearchHit }
  | { kind: "shortcut"; key: string; shortcut: SearchShortcut };

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
  onSearchOpenHelp?: (query: string, manualId: string, sectionSlug: string) => void;
  onNavigateToTab?: (tab: SidebarTabId, section?: string) => void;
  variant?: "backoffice" | "pos";
}

function normalizedShortcutQuery(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ");
}

function isReceiptBarcodeQuery(q: string): boolean {
  return /^TXN-[A-Za-z0-9][A-Za-z0-9-]{2,}$/i.test(q.trim());
}

function normalizeReceiptBarcodeQuery(q: string): string {
  return q.trim().toLowerCase();
}

interface UniversalSearchResponse {
  sources_failed?: string[];
  customers?: Customer[];
  sku_hit?: { sku: string; name: string } | null;
  products?: ControlBoardRow[];
  orders?: OrderSearchHit[];
  shipments?: ShipmentSearchHit[];
  weddings?: WeddingSearchHit[];
  alterations?: AlterationSearchHit[];
  help_hits?: HelpSearchHit[];
  operational_hits?: OperationalSearchHit[];
  shortcuts?: { intent: SearchShortcutIntent }[];
}

const ROSIE_SEARCH_SHORTCUT_IDS: SearchShortcutIntent[] = [
  "open_orders",
  "inventory_cleanup",
  "alterations_queue",
  "pickup_queue",
  "daily_sales",
];

const SEARCH_SHORTCUTS: Record<SearchShortcutIntent, SearchShortcut> = {
  open_orders: {
    intent: "open_orders",
    key: "shortcut:open_orders",
    title: "Open Orders",
    subtitle: "Go to unfulfilled Special, Custom, and Wedding work.",
    tab: "orders",
    section: "open",
  },
  transaction_records: {
    intent: "transaction_records",
    key: "shortcut:transaction_records",
    title: "Transaction Records",
    subtitle: "Go to complete sale history and financial records.",
    tab: "orders",
    section: "all",
  },
  inventory_cleanup: {
    intent: "inventory_cleanup",
    key: "shortcut:inventory_cleanup",
    title: "Inventory Cleanup Review",
    subtitle: "Open stock guidance and reorder suggestions.",
    tab: "inventory",
    section: "intelligence",
  },
  alterations_queue: {
    intent: "alterations_queue",
    key: "shortcut:alterations_queue",
    title: "Alterations Queue",
    subtitle: "Open active alterations work.",
    tab: "alterations",
    section: "queue",
  },
  pickup_queue: {
    intent: "pickup_queue",
    key: "shortcut:pickup_queue",
    title: "Pickup Queue",
    subtitle: "Open fulfillment pickup work.",
    tab: "home",
    section: "fulfillment",
  },
  daily_sales: {
    intent: "daily_sales",
    key: "shortcut:daily_sales",
    title: "Daily Sales",
    subtitle: "Open today's sales activity.",
    tab: "home",
    section: "daily-sales",
  },
  help_center: {
    intent: "help_center",
    key: "shortcut:help_center",
    title: "Help Center",
    subtitle: "Open operational manuals and recovery procedures.",
    tab: "settings",
    section: "help-center",
  },
  rosie: {
    intent: "rosie",
    key: "shortcut:rosie",
    title: "ROSIE",
    subtitle: "Open governed operational assistance.",
    tab: "settings",
    section: "rosie",
  },
  qbo_failed: {
    intent: "qbo_failed",
    key: "shortcut:qbo_failed",
    title: "QBO Sync History",
    subtitle: "Review failed journals and accounting sync issues.",
    tab: "qbo",
    section: "history",
  },
  receiving: {
    intent: "receiving",
    key: "shortcut:receiving",
    title: "Receive Stock",
    subtitle: "Open receiving and interrupted stock intake work.",
    tab: "inventory",
    section: "receiving",
  },
  physical_inventory: {
    intent: "physical_inventory",
    key: "shortcut:physical_inventory",
    title: "Physical Inventory",
    subtitle: "Open physical inventory mismatch review.",
    tab: "inventory",
    section: "physical",
  },
  gift_cards: {
    intent: "gift_cards",
    key: "shortcut:gift_cards",
    title: "Gift Cards",
    subtitle: "Open gift card balances, issuance, and issue review.",
    tab: "gift-cards",
    section: "inventory",
  },
  loyalty: {
    intent: "loyalty",
    key: "shortcut:loyalty",
    title: "Loyalty",
    subtitle: "Open reward history, eligibility, and adjustments.",
    tab: "loyalty",
    section: "history",
  },
  appointments: {
    intent: "appointments",
    key: "shortcut:appointments",
    title: "Scheduler",
    subtitle: "Open appointments and calendar work.",
    tab: "appointments",
    section: "scheduler",
  },
  reports: {
    intent: "reports",
    key: "shortcut:reports",
    title: "Reports",
    subtitle: "Open operational and financial reporting.",
    tab: "reports",
  },
  register_close: {
    intent: "register_close",
    key: "shortcut:register_close",
    title: "Register Close",
    subtitle: "Open register operations and close/reconciliation work.",
    tab: "register",
  },
  podium_inbox: {
    intent: "podium_inbox",
    key: "shortcut:podium_inbox",
    title: "Podium Inbox",
    subtitle: "Open customer messages and reviews.",
    tab: "podium-inbox",
  },
  meilisearch_status: {
    intent: "meilisearch_status",
    key: "shortcut:meilisearch_status",
    title: "Meilisearch Status",
    subtitle: "Open search index health and rebuild controls.",
    tab: "settings",
    section: "meilisearch",
  },
};

function buildSearchShortcuts(q: string, canNavigate: boolean): SearchShortcut[] {
  if (!canNavigate) return [];
  const normalized = normalizedShortcutQuery(q);
  if (!normalized) return [];
  const words = new Set(normalized.split(" "));
  const hasOrderWord = words.has("order") || words.has("orders");
  const hasTransactionWord =
    words.has("transaction") ||
    words.has("transactions") ||
    (words.has("sale") && words.has("history")) ||
    (words.has("sales") && words.has("history"));
  if (
    hasTransactionWord &&
    (words.has("record") ||
      words.has("records") ||
      words.has("history") ||
      normalized === "transactions" ||
      normalized === "transaction records" ||
      normalized === "sales history")
  ) {
    return [SEARCH_SHORTCUTS.transaction_records];
  }
  const wantsOpenOrders =
    hasOrderWord &&
    (words.has("open") ||
      normalized === "orders" ||
      normalized === "order lookup" ||
      normalized === "find orders");

  if (!wantsOpenOrders) return [];

  return [SEARCH_SHORTCUTS.open_orders];
}

function mergeSearchShortcuts(
  deterministic: SearchShortcut[],
  backendShortcutIds: SearchShortcutIntent[],
): SearchShortcut[] {
  const seen = new Set(deterministic.map((shortcut) => shortcut.intent));
  const backendShortcuts: SearchShortcut[] = [];
  for (const id of backendShortcutIds) {
    const shortcut = SEARCH_SHORTCUTS[id];
    if (shortcut && !seen.has(shortcut.intent)) {
      seen.add(shortcut.intent);
      backendShortcuts.push(shortcut);
    }
  }
  return [...deterministic, ...backendShortcuts];
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
  onSearchOpenHelp,
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
  const [helpHits, setHelpHits] = useState<HelpSearchHit[]>([]);
  const [operationalHits, setOperationalHits] = useState<OperationalSearchHit[]>([]);
  const [backendShortcutIds, setBackendShortcutIds] = useState<SearchShortcutIntent[]>([]);
  const [rosieShortcutIds, setRosieShortcutIds] = useState<SearchShortcutIntent[]>([]);
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [commandHintVisible, setCommandHintVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSearchQueryRef = useRef("");

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
    setHelpHits([]);
    setOperationalHits([]);
    setBackendShortcutIds([]);
    setFailedSources([]);
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
  const shortcuts = useMemo(
    () =>
      mergeSearchShortcuts(
        buildSearchShortcuts(query, Boolean(onNavigateToTab)),
        [...backendShortcutIds, ...rosieShortcutIds],
      ),
    [backendShortcutIds, rosieShortcutIds, onNavigateToTab, query],
  );

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
      ...helpHits.slice(0, 6).map((help) => ({
        kind: "help" as const,
        key: `help:${help.id}`,
        help,
      })),
      ...operationalHits.slice(0, 8).map((operational) => ({
        kind: "operational" as const,
        key: `operational:${operational.domain}:${operational.id}`,
        operational,
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
      ...shortcuts.map((shortcut) => ({
        kind: "shortcut" as const,
        key: shortcut.key,
        shortcut,
      })),
    ],
    [
      alterations,
      customers,
      helpHits,
      operationalHits,
      orders,
      products,
      shipments,
      shortcuts,
      skuHit,
      weddings,
    ],
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
  const helpEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "help" }>; index: number } =>
          item.entry.kind === "help",
      ),
    [indexedEntries],
  );
  const operationalEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is {
          entry: Extract<SearchResultEntry, { kind: "operational" }>;
          index: number;
        } => item.entry.kind === "operational",
      ),
    [indexedEntries],
  );
  const shortcutEntries = useMemo(
    () =>
      indexedEntries.filter(
        (
          item,
        ): item is { entry: Extract<SearchResultEntry, { kind: "shortcut" }>; index: number } =>
          item.entry.kind === "shortcut",
      ),
    [indexedEntries],
  );

  const pickCount = resultEntries.length;

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    const clearResults = () => {
      setCustomers([]);
      setSkuHit(null);
      setProducts([]);
      setOrders([]);
      setShipments([]);
      setWeddings([]);
      setAlterations([]);
      setHelpHits([]);
      setOperationalHits([]);
      setBackendShortcutIds([]);
      setRosieShortcutIds([]);
      setFailedSources([]);
    };

    if (q.length < 2) {
      clearResults();
      setLoading(false);
      return;
    }

    activeSearchQueryRef.current = q;
    setLoading(true);
    clearResults();

    try {
      const res = await fetch(
        `${baseUrl}/api/search/universal?q=${encodeURIComponent(q)}&limit=8`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("Universal search failed");
      const data = (await res.json()) as UniversalSearchResponse;
      if (activeSearchQueryRef.current === q) {
        setCustomers(data.customers ?? []);
        setSkuHit(data.sku_hit ?? null);
        setProducts(groupProductRows(data.products ?? [], GLOBAL_SEARCH_PRODUCT_CAP));
        setOrders(data.orders ?? []);
        setShipments(data.shipments ?? []);
        setWeddings(data.weddings ?? []);
        setAlterations((data.alterations ?? []).filter((row) => row.status !== "picked_up"));
        setHelpHits(data.help_hits ?? []);
        setOperationalHits(data.operational_hits ?? []);
        setBackendShortcutIds((data.shortcuts ?? []).map((shortcut) => shortcut.intent));
        setFailedSources(data.sources_failed ?? []);

        if (isReceiptBarcodeQuery(q) && onSearchOpenOrder) {
          const needle = normalizeReceiptBarcodeQuery(q);
          const exactOrder = (data.orders ?? []).find(
            (order) => order.display_id.trim().toLowerCase() === needle,
          );
          if (exactOrder) {
            closePalette();
            onSearchOpenOrder(exactOrder.transaction_id);
            return;
          }
        }
      }

      if (q.length >= 3 && activeSearchQueryRef.current === q) {
        try {
          const response = await requestRosieSearchIntent(
            {
              query: q,
              available_shortcuts: ROSIE_SEARCH_SHORTCUT_IDS.map((id) => ({
                id: id as RosieSearchShortcutId,
                label: SEARCH_SHORTCUTS[id].title,
                description: SEARCH_SHORTCUTS[id].subtitle,
              })),
            },
            { headers: apiAuth() },
          );
          if (activeSearchQueryRef.current === q) {
            setRosieShortcutIds(response.status === "available" ? response.shortcut_ids : []);
          }
        } catch {
          // ignore rosie failure
        }
      }
    } catch {
      if (activeSearchQueryRef.current === q) {
        setFailedSources(["Universal Search"]);
      }
    } finally {
      if (activeSearchQueryRef.current === q) {
        setLoading(false);
      }
    }
  }, [apiAuth, closePalette, onSearchOpenOrder]);

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
      setHelpHits([]);
      setOperationalHits([]);
      setBackendShortcutIds([]);
      setRosieShortcutIds([]);
      setFailedSources([]);
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

  const pickHelp = (hit: HelpSearchHit) => {
    closePalette();
    onSearchOpenHelp?.(query.trim(), hit.manual_id, hit.section_slug);
  };

  const pickOperational = (hit: OperationalSearchHit) => {
    closePalette();
    if (hit.transaction_id) {
      onSearchOpenOrder?.(hit.transaction_id);
      return;
    }
    onNavigateToTab?.(hit.route_tab, hit.route_section ?? undefined);
  };

  const pickShortcut = (shortcut: SearchShortcut) => {
    closePalette();
    onNavigateToTab?.(shortcut.tab, shortcut.section);
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
      case "help":
        pickHelp(entry.help);
        return;
      case "operational":
        pickOperational(entry.operational);
        return;
      case "shortcut":
        pickShortcut(entry.shortcut);
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
          "flex min-w-0 items-center",
          isPosVariant
            ? "w-auto justify-start lg:w-full lg:max-w-[20rem]"
            : "w-auto justify-start lg:w-full lg:max-w-[22rem] lg:justify-center",
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
              ? "h-10 w-10 justify-center gap-2 rounded-xl border border-app-border/70 bg-app-surface-2/95 px-0 lg:w-full lg:justify-start lg:px-2.5"
              : "h-10 w-10 justify-center gap-2 rounded-xl border border-app-border/70 bg-app-surface-2/90 px-0 lg:w-full lg:justify-start lg:px-2.5",
          )}
          aria-label="Open universal search"
        >
          <div
            className={cn(
              "flex shrink-0 items-center justify-center rounded-xl bg-app-surface text-app-text-muted shadow-sm transition-colors group-hover:text-app-text",
              isPosVariant ? "h-7 w-7" : "h-7 w-7",
            )}
          >
            <Search size={16} aria-hidden />
          </div>
          <div className="hidden min-w-0 lg:block">
            <p className="truncate text-xs font-bold text-app-text">
              Search
            </p>
            <p className="truncate text-[11px] text-app-text-muted">
              {isPosVariant ? "Customers, orders, transactions, SKU" : "Jump to customers..."}
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-1 rounded-xl border border-app-border/70 bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted shadow-sm xl:flex">
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

      {open && createPortal(
        <div className="ui-overlay-backdrop !z-[200]">
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
            className="ui-modal relative w-full max-w-4xl flex flex-col max-h-[min(88vh,56rem)] animate-in zoom-in-95 duration-200"
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
                  placeholder="Search customers, Transaction Records, orders, inventory, weddings…"
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
              {failedSources.length > 0 && query.trim().length >= 2 && !loading ? (
                <div className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-semibold text-amber-800 dark:text-amber-100">
                  Some search sources did not respond: {failedSources.join(", ")}. Results shown may be incomplete.
                </div>
              ) : null}
              {query.trim().length < 2 ? (
                <div className="flex h-full min-h-[18rem] flex-col items-center justify-center rounded-[24px] border border-dashed border-app-border/70 bg-app-surface-2/60 px-6 text-center">
                  <Search size={40} className="mb-4 text-app-text-muted/70" aria-hidden />
                  <p className="text-sm font-black uppercase tracking-widest text-app-text">
                    Search Across Riverside
                  </p>
                  <p className="mt-2 max-w-lg text-sm font-medium text-app-text-muted">
                    Use this to jump between customers, Transaction Records, open orders, inventory, weddings, shipments, and alterations when you know the person, SKU, code, or party name but not the section.
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
                    {failedSources.length > 0 ? "Search incomplete" : "No matches found"}
                  </p>
                  <p className="mt-2 max-w-lg text-sm font-medium text-app-text-muted">
                    {failedSources.length > 0
                      ? "Try again before treating this as no match. Some lookup sources did not respond."
                      : "Try a broader name, Transaction Record #, order number, SKU, wedding party name, or shipment tracking value."}
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

                  <ResultSection title="Transaction Records" visible={orderEntries.length > 0}>
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
                          ROS &gt; Transaction Records
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

                  <ResultSection title="Help & Procedures" visible={helpEntries.length > 0}>
                    {helpEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickHelp(entry.help)}
                      >
                        <span className="font-semibold text-app-text">{entry.help.manual_title}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          ROS &gt; Help Center &gt; {entry.help.section_heading}
                        </span>
                        <span className="line-clamp-2 text-xs text-app-text-muted">
                          {entry.help.excerpt}
                        </span>
                      </ResultButton>
                    ))}
                  </ResultSection>

                  <ResultSection title="Operational Records" visible={operationalEntries.length > 0}>
                    {operationalEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickOperational(entry.operational)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-app-text">
                            {entry.operational.title}
                          </span>
                          <span className="rounded-full border border-app-border/70 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {entry.operational.domain}
                          </span>
                        </div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          ROS &gt; {entry.operational.domain}
                        </span>
                        <span className="line-clamp-2 text-xs text-app-text-muted">
                          {entry.operational.subtitle || "Open the related workflow"}
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

                  <ResultSection title="Suggested Searches" visible={shortcutEntries.length > 0}>
                    {shortcutEntries.map(({ entry, index }) => (
                      <ResultButton
                        key={entry.key}
                        index={index}
                        highlightIndex={highlightIndex}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => pickShortcut(entry.shortcut)}
                      >
                        <span className="font-semibold text-app-text">{entry.shortcut.title}</span>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Shortcut
                        </span>
                        <span className="text-xs text-app-text-muted">{entry.shortcut.subtitle}</span>
                      </ResultButton>
                    ))}
                  </ResultSection>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}
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
