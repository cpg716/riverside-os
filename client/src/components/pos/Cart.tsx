import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useScanner } from "../../hooks/useScanner";
import {
  Search,
  Trash2,
  Gift,
  Package,
  ArrowRight,
  Info,
  RotateCcw,
  Users,
  X,
  ArrowLeftRight,
  Truck,
  UserCircle,
  CreditCard,
  Clock,
} from "lucide-react";
import localforage from "localforage";
import CustomerSelector, { type Customer } from "./CustomerSelector";
import NexoCheckoutDrawer, {
  type AppliedPaymentLine,
  type CheckoutOperatorContext,
} from "./NexoCheckoutDrawer";
import RegisterCashAdjustModal from "./RegisterCashAdjustModal";
import RegisterGiftCardLoadModal from "./RegisterGiftCardLoadModal";
import PosCustomerMeasurementsDrawer from "./PosCustomerMeasurementsDrawer";
import ReceiptSummaryModal from "./ReceiptSummaryModal";
import VariantSelectionModal, { type ProductWithVariants } from "./VariantSelectionModal";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import { enqueueCheckout } from "../../lib/offlineQueue";
import { playPosScanSuccess, playPosScanError } from "../../lib/posAudio";
import {
  centsToFixed2,
  parseMoney,
  parseMoneyToCents,
} from "../../lib/money";
import {
  hydratePosRegisterAuthIfNeeded,
  mergedPosStaffHeaders,
} from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import ProductIntelligenceDrawer from "./ProductIntelligenceDrawer";
import PosSaleCashierSignInOverlay from "./PosSaleCashierSignInOverlay";
import CustomerRelationshipHubDrawer from "../customers/CustomerRelationshipHubDrawer";
import PosExchangeWizard from "./PosExchangeWizard";
import PosSuitSwapWizard from "./PosSuitSwapWizard";
import WeddingLookupDrawer, { type WeddingMember } from "./WeddingLookupDrawer";
import PosShippingModal, {
  type PosShippingSelection,
} from "./PosShippingModal";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import {
  deleteParkedSaleOnServer,
  fetchParkedSales,
  recallParkedSaleOnServer,
  type ServerParkedSale,
} from "../../lib/posParkedSales";

// --- Types ---
import CustomItemPromptModal from "./CustomItemPromptModal";

export interface ResolvedSkuItem {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  variation_label?: string | null;
  standard_retail_price: string | number;
  employee_price?: string | number;
  unit_cost: string | number;
  spiff_amount?: string | number;
  state_tax: string | number;
  local_tax: string | number;
  stock_on_hand?: number;
  vendor_sku?: string;
  /** Present when API includes it (promotions, prompts). */
  category_id?: string | null;
  primary_vendor_id?: string | null;
  /** Custom Work Order fields */
  custom_item_type?: string;
  is_rush?: boolean;
  need_by_date?: string | null;
  needs_gift_wrap?: boolean;
}

export type FulfillmentKind = "takeaway" | "special_order" | "wedding_order" | "layaway";

export interface CartLineItem extends ResolvedSkuItem {
  quantity: number;
  fulfillment: FulfillmentKind;
  /** Stable row identity (e.g. multiple POS gift card loads share the same internal SKU). */
  cart_row_id: string;
  /** Set on internal `pos_gift_card_load` lines; sent as `gift_card_load_code` at checkout. */
  gift_card_load_code?: string | null;
  price_override_reason?: string;
  original_unit_price?: string;
  salesperson_id?: string | null;
  /** When set, checkout sends `discount_event_id` and price must match event % off retail. */
  discount_event_id?: string | null;
}

function newCartRowId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function withEnsuredCartRowId(l: CartLineItem): CartLineItem {
  if (typeof l.cart_row_id === "string" && l.cart_row_id.trim()) return l;
  return { ...l, cart_row_id: newCartRowId() };
}

/** Valid RFC-style UUID string for `checkout_client_id` (server deserializes as `Uuid`; non-UUID → 422). */
function newCheckoutClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface CheckoutPaymentSplitPayload {
  payment_method: string;
  amount: string;
  sub_type?: "paid_liability" | "loyalty_giveaway" | "donated_giveaway";
  applied_deposit_amount?: string;
  gift_card_code?: string;
}

/** Active staff for POS salesperson pickers (commissions / attribution). */
export type PosStaffRow = {
  id: string;
  full_name: string;
  role?: string;
};

export interface CheckoutPayload {
  session_id: string;
  operator_staff_id: string;
  primary_salesperson_id: string | null;
  customer_id: string | null;
  wedding_member_id: string | null;
  payment_method: string;
  total_price: string;
  amount_paid: string;
  items: unknown[];
  actor_name?: string | null;
  payment_splits?: CheckoutPaymentSplitPayload[] | null;
  applied_deposit_amount?: string;
  wedding_disbursements?: {
    wedding_member_id: string;
    amount: string;
  }[];
  checkout_client_id?: string;
  /** Binds server `store_shipping_rate_quote` into checkout totals. */
  shipping_rate_quote_id?: string | null;
  /** Binds Order Urgency */
  is_rush?: boolean;
  need_by_date?: string | null;
}

interface CartProps {
  sessionId: string;
  cashierName?: string | null;
  cashierCode?: string | null;
  initialCustomer?: Customer | null;
  onInitialCustomerConsumed?: () => void;
  initialOrderId?: string | null;
  onInitialOrderConsumed?: () => void;
  managerMode?: boolean;
  initialWeddingLookupOpen?: boolean;
  /** From Wedding Manager: pre-link customer + wedding member for wedding_order checkout. */
  initialWeddingPosLink?: RosOpenRegisterFromWmDetail | null;
  onInitialWeddingPosLinkConsumed?: () => void;
  /** POS Inventory list: resolve SKU and add to cart after local sale state is hydrated. */
  pendingInventorySku?: string | null;
  onPendingInventorySkuConsumed?: () => void;
  /** After checkout succeeds (cart cleared); e.g. switch POS shell back to Register for next sale sign-in. */
  onSaleCompleted?: () => void;
  /** IANA zone from open register session — live clock only; receipt uses server time at checkout. */
  receiptTimezone?: string;
}

interface SearchResult extends ResolvedSkuItem {
  image_url?: string;
}

// --- Utils ---
function normalizeGiftCardSubType(
  v: AppliedPaymentLine["sub_type"],
): "paid_liability" | "loyalty_giveaway" | "donated_giveaway" | undefined {
  if (v === "paid_liability" || v === "loyalty_giveaway" || v === "donated_giveaway") return v;
  return undefined;
}

/** Activation / load-value gift card catalog lines — no retail commission; salesperson not required (see receipt bag-tag heuristic). */
function isGiftCardProductLine(line: Pick<CartLineItem, "name">): boolean {
  const n = String(line.name ?? "").toLowerCase();
  return n.includes("gift card") || n.includes("giftcard");
}

function cartLineKey(l: Pick<CartLineItem, "cart_row_id">): string {
  return l.cart_row_id;
}

function scanPayloadToResolvedItem(r: Record<string, unknown>): ResolvedSkuItem {
  return {
    product_id: String(r.product_id),
    variant_id: String(r.variant_id),
    sku: String(r.sku),
    name: String(r.name),
    variation_label: (r.variation_label as string | null | undefined) ?? undefined,
    standard_retail_price: (r.standard_retail_price as string | number) ?? 0,
    employee_price: r.employee_price as string | number | undefined,
    unit_cost: (r.unit_cost as string | number) ?? 0,
    spiff_amount: r.spiff_amount as string | number | undefined,
    stock_on_hand: typeof r.stock_on_hand === "number" ? r.stock_on_hand : undefined,
    state_tax: (r.state_tax as string | number) ?? 0,
    local_tax: (r.local_tax as string | number) ?? 0,
  };
}

/** Live register clock — same TZ as Settings receipt config (thermal line uses server time when the sale completes). */
function formatStoreClockLine(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      .replace(",", " ·");
  } catch {
    return d.toLocaleString("en-US");
  }
}

function PosRegisterLiveClock({ timeZone }: { timeZone: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div
      className="ml-auto min-w-0 max-w-[55%] shrink text-right sm:max-w-none"
      title="Store time zone matches receipt settings. The printed receipt uses the server time when you complete the sale."
    >
      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
        Store date and time
      </p>
      <p className="truncate font-mono text-xs font-black tabular-nums text-app-text">
        {formatStoreClockLine(now, timeZone)}
      </p>
    </div>
  );
}

/** POS control-board: keep enough variant rows that grouping by product still shows many distinct products. */
const POS_SEARCH_RESULT_CAP = 200;

// --- Component ---
export default function Cart({
  sessionId,
  cashierName = null,
  initialCustomer = null,
  onInitialCustomerConsumed,
  initialOrderId = null,
  onInitialOrderConsumed,
  managerMode = false,
  initialWeddingLookupOpen = false,
  initialWeddingPosLink = null,
  onInitialWeddingPosLinkConsumed,
  pendingInventorySku = null,
  onPendingInventorySkuConsumed,
  onSaleCompleted,
  receiptTimezone: receiptTimezoneProp,
}: CartProps) {
  const receiptTimezone =
    typeof receiptTimezoneProp === "string" && receiptTimezoneProp.trim()
      ? receiptTimezoneProp.trim()
      : "America/New_York";
  const { toast } = useToast();
  const { backofficeHeaders, staffCode, staffPin, employeeCustomerId } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const [saleHydrated, setSaleHydrated] = useState(false);
  const [lines, setLines] = useState<CartLineItem[]>([]);
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [checkoutDrawerOpen, setCheckoutDrawerOpen] = useState(false);
  const [checkoutAppliedPayments, setCheckoutAppliedPayments] = useState<
    AppliedPaymentLine[]
  >([]);
  const [openDepositPrompt, setOpenDepositPrompt] = useState<{
    cents: number;
    payerName: string | null;
  } | null>(null);
  const openDepositSuppressedRef = useRef(false);
  const checkoutAppliedPaymentsRef = useRef(checkoutAppliedPayments);
  checkoutAppliedPaymentsRef.current = checkoutAppliedPayments;
  const [checkoutDepositLedger, setCheckoutDepositLedger] = useState("");
  const [checkoutOperator, setCheckoutOperator] = useState<CheckoutOperatorContext | null>(null);
  const [pickupConfirmed, setPickupConfirmed] = useState(false);

  // --- Search results grouping ---
  const [saleCashierCredential, setSaleCashierCredential] = useState("");
  const [saleCashierBusy, setSaleCashierBusy] = useState(false);
  const [saleCashierError, setSaleCashierError] = useState<string | null>(null);
  const [parkedListOpen, setParkedListOpen] = useState(false);
  const [parkedRows, setParkedRows] = useState<ServerParkedSale[]>([]);
  const [parkedCustomerPrompt, setParkedCustomerPrompt] = useState<{
    customerId: string;
    rows: ServerParkedSale[];
  } | null>(null);
  const prevCustomerIdForParkedRef = useRef<string | null>(null);
  const skippedParkedForCustomerRef = useRef<Set<string>>(new Set());
  const [cashAdjustOpen, setCashAdjustOpen] = useState(false);
  const [giftCardLoadOpen, setGiftCardLoadOpen] = useState(false);
  const [measDrawerOpen, setMeasDrawerOpen] = useState(false);
  const [customerProfileHubOpen, setCustomerProfileHubOpen] = useState(false);
  const [keypadBuffer, setKeypadBuffer] = useState("");
  const [keypadMode, setKeypadMode] = useState<"qty" | "price">("qty");
  const [intelligenceVariantId, setIntelligenceVariantId] = useState<string | null>(null);
  const [weddingDrawerOpen, setWeddingDrawerOpen] = useState(false);
  const [weddingDrawerPreferGroupPay, setWeddingDrawerPreferGroupPay] =
    useState(false);
  const [activeWeddingMember, setActiveWeddingMember] = useState<WeddingMember | null>(null);
  const [activeWeddingPartyName, setActiveWeddingPartyName] = useState<string | null>(null);
  const [disbursementMembers, setDisbursementMembers] = useState<WeddingMember[]>([]);

  useEffect(() => {
    if (initialWeddingLookupOpen) {
      setWeddingDrawerPreferGroupPay(false);
      setWeddingDrawerOpen(true);
    }
  }, [initialWeddingLookupOpen]);

  useEffect(() => {
    if (!selectedCustomer) setCustomerProfileHubOpen(false);
  }, [selectedCustomer]);

  useEffect(() => {
    if (!checkoutDrawerOpen) {
      openDepositSuppressedRef.current = false;
      setOpenDepositPrompt(null);
    }
  }, [checkoutDrawerOpen]);

  useEffect(() => {
    if (!checkoutDrawerOpen || !selectedCustomer?.id) return;
    if (openDepositSuppressedRef.current) return;
    if (checkoutAppliedPaymentsRef.current.some((p) => p.method === "open_deposit"))
      return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/${encodeURIComponent(selectedCustomer.id)}/open-deposit`,
          { headers: { ...apiAuth() } },
        );
        if (!res.ok || cancelled) return;
        if (
          checkoutAppliedPaymentsRef.current.some((p) => p.method === "open_deposit")
        )
          return;
        const data = (await res.json()) as {
          balance?: string | number;
          last_payer_display_name?: string | null;
        };
        const bal = Number(data.balance);
        if (!Number.isFinite(bal) || bal <= 0) return;
        const cents = Math.round(bal * 100);
        if (cents <= 0) return;
        const payer =
          typeof data.last_payer_display_name === "string" &&
          data.last_payer_display_name.trim()
            ? data.last_payer_display_name.trim()
            : null;
        setOpenDepositPrompt({ cents, payerName: payer });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkoutDrawerOpen, selectedCustomer?.id, baseUrl, apiAuth]);

  /** POS parked/checkout routes require session token in headers; mint if missing (full page load). */
  const ensurePosTokenForSession = useCallback(async (): Promise<boolean> => {
    const preHeaders = mergedPosStaffHeaders(backofficeHeaders);
    if (preHeaders["x-riverside-pos-session-token"]?.trim()) return true;
    return hydratePosRegisterAuthIfNeeded({
      baseUrl,
      sessionId,
      authHeaders: preHeaders,
      openerCashierCode: staffCode,
      openerPin: staffPin,
    });
  }, [backofficeHeaders, baseUrl, sessionId, staffCode, staffPin]);

  const ensureSaleCashier = useCallback((): boolean => {
    if (checkoutOperator) return true;
    toast("Sign in as cashier on the register sign-in screen first.", "error");
    return false;
  }, [checkoutOperator, toast]);

  const verifySaleCashier = useCallback(async () => {
    const code = saleCashierCredential.trim();
    if (code.length !== 4) {
      setSaleCashierError("Enter your 4-digit staff code");
      return;
    }
    setSaleCashierBusy(true);
    setSaleCashierError(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/verify-cashier-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cashier_code: code, pin: code }),
      });
      if (!res.ok) throw new Error("Code not accepted");
      const data = (await res.json()) as { staff_id: string; full_name: string };
      setCheckoutOperator({
        staffId: data.staff_id,
        fullName: data.full_name,
      });
      setSaleCashierCredential("");
      toast(`Cashier signed in for this sale — ${data.full_name}`, "success");
      window.requestAnimationFrame(() => searchInputRef.current?.focus());
    } catch (e) {
      setSaleCashierError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setSaleCashierBusy(false);
    }
  }, [baseUrl, saleCashierCredential, toast]);

  const resolveActorStaffId = useCallback(async (): Promise<string | null> => {
    if (checkoutOperator?.staffId) return checkoutOperator.staffId;
    try {
      const res = await fetch(`${baseUrl}/api/staff/effective-permissions`, {
        headers: apiAuth(),
      });
      if (!res.ok) return null;
      const d = (await res.json()) as { staff_id?: string };
      return typeof d.staff_id === "string" && d.staff_id.trim()
        ? d.staff_id.trim()
        : null;
    } catch {
      return null;
    }
  }, [checkoutOperator?.staffId, baseUrl, apiAuth]);

  const refreshParkedSales = useCallback(async () => {
    try {
      const rows = await fetchParkedSales(baseUrl, sessionId, apiAuth);
      setParkedRows(rows);
    } catch {
      setParkedRows([]);
    }
  }, [baseUrl, sessionId, apiAuth]);

  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const pendingExchangeOriginalOrderIdRef = useRef<string | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didInitialProductSearchFocusRef = useRef(false);
  const [exchangeWizardOpen, setExchangeWizardOpen] = useState(false);
  const [suitSwapWizardOpen, setSuitSwapWizardOpen] = useState(false);
  const [posShipping, setPosShipping] = useState<PosShippingSelection | null>(null);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);

  type ActiveDiscountEvent = {
    id: string;
    receipt_label: string;
    percent_off: string;
    scope_type: string;
    scope_category_id: string | null;
    scope_vendor_id: string | null;
  };
  const [activeDiscountEvents, setActiveDiscountEvents] = useState<ActiveDiscountEvent[]>([]);
  const [selectedDiscountEventId, setSelectedDiscountEventId] = useState("");
  const [eventVariantIds, setEventVariantIds] = useState<Set<string>>(new Set());
  const [showWalkinConfirm, setShowWalkinConfirm] = useState(false);
  const [activeVariationSelection, setActiveVariationSelection] = useState<ProductWithVariants | null>(null);
  /** When set, VariantSelectionModal updates this cart line instead of adding a new row. */
  const [variantSwapCartRowId, setVariantSwapCartRowId] = useState<string | null>(null);
  
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [pendingCustomItem, setPendingCustomItem] = useState<ResolvedSkuItem | null>(null);

  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showVoidAllConfirm, setShowVoidAllConfirm] = useState(false);
  const [discountPrompt, setDiscountPrompt] = useState<{
    variantId: string;
    nextPriceCents: number;
    originalPriceCents: number;
    reason: string;
  } | null>(null);
  const [roleMaxDiscountPct, setRoleMaxDiscountPct] = useState(30);

  type RmsPaymentLineMeta = {
    product_id: string;
    variant_id: string;
    sku: string;
    name: string;
  };
  type GiftCardLoadLineMeta = {
    product_id: string;
    variant_id: string;
    sku: string;
    name: string;
  };
  const [rmsPaymentMeta, setRmsPaymentMeta] = useState<RmsPaymentLineMeta | null>(
    null,
  );
  const [giftCardLoadMeta, setGiftCardLoadMeta] =
    useState<GiftCardLoadLineMeta | null>(null);

  const [posStaffList, setPosStaffList] = useState<PosStaffRow[]>([]);
  const [primarySalespersonId, setPrimarySalespersonId] = useState("");
  const [saleEpoch, setSaleEpoch] = useState(0);
  const primaryDefaultedRef = useRef(false);

  const commissionStaff = useMemo(
    () =>
      posStaffList.filter(
        (s) =>
          !s.role ||
          s.role === "salesperson" ||
          s.role === "admin",
      ),
    [posStaffList],
  );

  const primarySalespersonLabel = useMemo(() => {
    const id = primarySalespersonId.trim();
    if (!id) return "";
    return commissionStaff.find((s) => s.id === id)?.full_name ?? "";
  }, [commissionStaff, primarySalespersonId]);

  useEffect(() => {
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/pos/rms-payment-line-meta`, {
          headers: h,
        });
        if (!res.ok || cancelled) return;
        const m = (await res.json()) as RmsPaymentLineMeta;
        if (!cancelled) setRmsPaymentMeta(m);
      } catch {
        /* optional internal product */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiAuth]);

  useEffect(() => {
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/pos/gift-card-load-line-meta`, {
          headers: h,
        });
        if (!res.ok || cancelled) return;
        const m = (await res.json()) as GiftCardLoadLineMeta;
        if (!cancelled) setGiftCardLoadMeta(m);
      } catch {
        /* optional internal product */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiAuth]);

  const isRmsPaymentCart = useMemo(
    () =>
      !!rmsPaymentMeta &&
      lines.length === 1 &&
      lines[0]?.sku === rmsPaymentMeta.sku,
    [rmsPaymentMeta, lines],
  );

  const isGiftCardOnlyCart = useMemo(
    () =>
      lines.length > 0 && lines.every((l) => isGiftCardProductLine(l)),
    [lines],
  );

  const prevSessionIdForHydrateRef = useRef<string | null>(null);

  const clearCart = useCallback(() => {
    setLines([]);
    setSelectedCustomer(null);
    setActiveWeddingMember(null);
    setActiveWeddingPartyName(null);
    setSearch("");
    setSearchResults([]);
    setSelectedLineKey(null);
    setKeypadBuffer("");
    setDisbursementMembers([]);
    setCheckoutAppliedPayments([]);
    setCheckoutDepositLedger("");
    setPosShipping(null);
    setPrimarySalespersonId("");
    primaryDefaultedRef.current = false;
    setPickupConfirmed(false);
    setSaleEpoch((e) => e + 1);
  }, []);

  // --- Persistence ---
  // Block disk writes until we've read localforage; otherwise the first persist pass would
  // overwrite the saved sale with empty initial state when Cart remounts (e.g. leave Register tab).
  useLayoutEffect(() => {
    setSaleHydrated(false);
    const prev = prevSessionIdForHydrateRef.current;
    if (prev !== null && prev !== sessionId) {
      clearCart();
      setCheckoutOperator(null);
    }
    prevSessionIdForHydrateRef.current = sessionId;
  }, [sessionId, clearCart]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const saved = await localforage.getItem<unknown>("ros_pos_active_sale") as {
          sessionId: string;
          lines?: CartLineItem[];
          selectedCustomer?: Customer;
          activeWeddingMember?: WeddingMember;
          activeWeddingPartyName?: string;
          posShipping?: PosShippingSelection;
          primarySalespersonId?: string;
          checkoutOperator?: { staffId: string; fullName: string };
        } | null;
        if (cancelled) return;
        if (saved && saved.sessionId === sessionId) {
          const rawLines = (saved.lines || []) as CartLineItem[];
          if (rawLines.length === 0) {
            // Do not treat an empty cart as a resumable sale (avoids skipping cashier sign-in after refresh).
            await localforage.removeItem("ros_pos_active_sale");
          } else {
            const wm = saved.activeWeddingMember || null;
            setLines(
              rawLines.map((l) => {
                let f = l.fulfillment as FulfillmentKind | "custom" | "" | undefined;
                if (f == null || f === "") f = "takeaway";
                if (f === "custom") f = "special_order";
                if (f === "wedding_order" && !wm) f = "special_order";
                return withEnsuredCartRowId({
                  ...l,
                  fulfillment: f as FulfillmentKind,
                });
              }),
            );
            const raw = saved.selectedCustomer as Customer | null | undefined;
            setSelectedCustomer(
              raw
                ? {
                    ...raw,
                    customer_code: raw.customer_code ?? "",
                  }
                : null,
            );
            setActiveWeddingMember(saved.activeWeddingMember || null);
            setActiveWeddingPartyName(saved.activeWeddingPartyName || null);
            const sp = saved.posShipping as PosShippingSelection | null | undefined;
            if (
              sp &&
              typeof sp.rate_quote_id === "string" &&
              typeof sp.amount_cents === "number" &&
              sp.to_address
            ) {
              setPosShipping(sp);
            } else {
              setPosShipping(null);
            }
            const ps = saved.primarySalespersonId;
            if (typeof ps === "string" && ps.trim()) {
              setPrimarySalespersonId(ps.trim());
              primaryDefaultedRef.current = true;
            } else {
              primaryDefaultedRef.current = false;
            }
            const co = saved.checkoutOperator as
              | { staffId?: string; fullName?: string }
              | undefined;
            if (co?.staffId?.trim() && co?.fullName?.trim()) {
              setCheckoutOperator({
                staffId: co.staffId.trim(),
                fullName: co.fullName.trim(),
              });
            }
          }
        } else if (saved && saved.sessionId !== sessionId) {
          // Stale snapshot from another register session — drop in-memory sale.
          clearCart();
        } else {
          setPrimarySalespersonId("");
          primaryDefaultedRef.current = false;
        }
      } finally {
        if (!cancelled) setSaleHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, clearCart]);

  useEffect(() => {
    if (!saleHydrated) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/self/pricing-limits`, {
          headers: h,
        });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as { max_discount_percent?: string };
        const n = Number.parseFloat(j.max_discount_percent ?? "30");
        if (Number.isFinite(n)) setRoleMaxDiscountPct(n);
      } catch {
        /* keep default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiAuth, saleHydrated]);

  useEffect(() => {
    if (!saleHydrated) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/discount-events/active`, {
          headers: h,
        });
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as ActiveDiscountEvent[];
        setActiveDiscountEvents(
          j.map((ev) => ({
            ...ev,
            scope_type: ev.scope_type ?? "variants",
            scope_category_id: ev.scope_category_id ?? null,
            scope_vendor_id: ev.scope_vendor_id ?? null,
          })),
        );
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiAuth, saleHydrated]);

  useEffect(() => {
    if (!saleHydrated) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
          headers: h,
        });
        if (!res.ok || cancelled) return;
        const sl = (await res.json()) as PosStaffRow[];
        if (!cancelled) setPosStaffList(sl);
      } catch {
        if (!cancelled) setPosStaffList([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleHydrated, baseUrl, apiAuth]);

  useEffect(() => {
    if (!saleHydrated) return;
    if (primaryDefaultedRef.current) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const epRes = await fetch(`${baseUrl}/api/staff/effective-permissions`, {
          headers: h,
        });
        if (!epRes.ok || cancelled) return;
        const ep = (await epRes.json()) as { staff_id?: string; role?: string };
        if (cancelled) return;
        if (ep.role === "salesperson") {
          const id = ep.staff_id?.trim();
          if (id) {
            setPrimarySalespersonId(id);
            primaryDefaultedRef.current = true;
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleHydrated, baseUrl, apiAuth, saleEpoch]);

  useEffect(() => {
    if (!selectedDiscountEventId) {
      setEventVariantIds(new Set());
      return;
    }
    const ev = activeDiscountEvents.find((e) => e.id === selectedDiscountEventId);
    const scope = ev?.scope_type ?? "variants";
    if (scope !== "variants") {
      setEventVariantIds(new Set());
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/discount-events/${selectedDiscountEventId}/variants`,
          { headers: { ...apiAuth() } },
        );
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as { variant_id: string }[];
        setEventVariantIds(new Set(j.map((x) => x.variant_id)));
      } catch {
        if (!cancelled) setEventVariantIds(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, apiAuth, selectedDiscountEventId, activeDiscountEvents]);

  useEffect(() => {
    if (!saleHydrated) return;
    if (lines.length === 0) {
      void localforage.removeItem("ros_pos_active_sale");
      return;
    }
    void localforage.setItem("ros_pos_active_sale", {
      sessionId,
      lines,
      selectedCustomer,
      activeWeddingMember,
      activeWeddingPartyName,
      posShipping,
      primarySalespersonId,
      checkoutOperator,
    });
  }, [
    saleHydrated,
    lines,
    selectedCustomer,
    sessionId,
    activeWeddingMember,
    activeWeddingPartyName,
    posShipping,
    primarySalespersonId,
    checkoutOperator,
  ]);

  useEffect(() => {
    setLines((prev) =>
      prev.map((l) => {
        if (activeWeddingMember) {
          if (l.fulfillment === "special_order") return { ...l, fulfillment: "wedding_order" };
          return l;
        }
        if (l.fulfillment === "wedding_order") return { ...l, fulfillment: "special_order" };
        return l;
      }),
    );
  }, [activeWeddingMember]);

  useEffect(() => {
    if (!initialCustomer) return;
    setSelectedCustomer(initialCustomer);
    onInitialCustomerConsumed?.();
  }, [initialCustomer, onInitialCustomerConsumed]);

  useEffect(() => {
    if (!initialOrderId) return;
    onInitialOrderConsumed?.();
  }, [initialOrderId, onInitialOrderConsumed]);

  useEffect(() => {
    if (!initialWeddingPosLink?.member?.customer_id) return;
    const link = initialWeddingPosLink;
    const wm = link.member;
    const partyName = link.partyName?.trim() || "Wedding party";

    const minimalCustomer = (): Customer => ({
      id: wm.customer_id,
      customer_code: "",
      first_name: wm.first_name,
      last_name: wm.last_name,
      company_name: null,
      email: wm.customer_email ?? null,
      phone: wm.customer_phone ?? null,
    });

    const run = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/customers/${wm.customer_id}`, {
          headers: { ...apiAuth() },
        });
        if (res.ok) {
          const c = (await res.json()) as Customer & { id: string };
          setSelectedCustomer({
            id: String(c.id),
            customer_code: c.customer_code ?? "",
            first_name: c.first_name,
            last_name: c.last_name,
            company_name: c.company_name ?? null,
            email: c.email ?? null,
            phone: c.phone ?? null,
          });
        } else {
          setSelectedCustomer(minimalCustomer());
        }
      } catch {
        setSelectedCustomer(minimalCustomer());
      }

      setActiveWeddingMember({
        id: wm.id,
        first_name: wm.first_name,
        last_name: wm.last_name,
        role: wm.role,
        status: wm.status,
        measured: wm.measured,
        suit_ordered: wm.suit_ordered,
        customer_id: wm.customer_id,
        customer_email: wm.customer_email ?? undefined,
        customer_phone: wm.customer_phone ?? undefined,
        suit_variant_id: wm.suit_variant_id,
        is_free_suit_promo: Boolean(wm.is_free_suit_promo),
      });
      setActiveWeddingPartyName(partyName);

      // --- Auto-add Linked Suit to Cart ---
      if (wm.suit_variant_id) {
        try {
          const res = await fetch(`${baseUrl}/api/products/variants/${wm.suit_variant_id}`, {
            headers: { ...apiAuth() },
          });
          if (res.ok) {
            const v = (await res.json()) as ResolvedSkuItem;
            const isFree = Boolean(wm.is_free_suit_promo);
            const newItem: CartLineItem = {
              ...v,
              quantity: 1,
              fulfillment: "wedding_order",
              cart_row_id: newCartRowId(),
              ...(isFree ? {
                standard_retail_price: 0,
                original_unit_price: String(v.standard_retail_price),
                price_override_reason: "Wedding Promo (Free Suit Selection)"
              } : {})
            };
            setLines(prev => {
                if (prev.some(l => l.variant_id === v.variant_id)) return prev;
                return [...prev, newItem];
            });
            if (isFree) {
              toast(`Free Suit applied for ${wm.first_name} (Promo)`, "success");
            }
            toast(`Linked suit added to cart: ${v.name}`, "success");
          }
        } catch (err) {
          console.error("Failed to auto-add linked suit:", err);
        }
      }

      onInitialWeddingPosLinkConsumed?.();
    };

    void run();
  }, [initialWeddingPosLink, baseUrl, onInitialWeddingPosLinkConsumed, apiAuth, toast]);

  // --- Search Logic ---
  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }

    if (q.toLowerCase() === "payment") {
      try {
        let meta = rmsPaymentMeta;
        if (!meta) {
          const res = await fetch(`${baseUrl}/api/pos/rms-payment-line-meta`, {
            headers: apiAuth(),
          });
          if (!res.ok) {
            setSearchResults([]);
            toast(
              "RMS payment line is not available. Sign in or run migrations.",
              "error",
            );
            return;
          }
          const payload = (await res.json()) as RmsPaymentLineMeta | null;
          if (!payload) {
            setSearchResults([]);
            toast(
              "RMS payment line is not available. Ensure layout POS products are created.",
              "error",
            );
            return;
          }
          meta = payload;
          setRmsPaymentMeta(meta);
        }
        setSearchResults([
          {
            product_id: meta.product_id,
            variant_id: meta.variant_id,
            sku: meta.sku,
            name: meta.name,
            standard_retail_price: 0,
            unit_cost: 0,
            state_tax: 0,
            local_tax: 0,
            stock_on_hand: 0,
          },
        ]);
      } catch {
        setSearchResults([]);
        toast("Could not load RMS payment line.", "error");
      }
      return;
    }

    const requests: Promise<void>[] = [];
    const collected: SearchResult[] = [];

    // 1. Direct SKU/Scan resolution
    requests.push(
      fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
        headers: apiAuth(),
      }).then(async (res) => {
        if (res.ok) {
          const r = (await res.json()) as SearchResult;
          collected.push(r);
        }
      })
    );

    // 2. Control Board Fuzzy Search (cap variants so the dropdown can include many distinct products)
    requests.push(
      fetch(
        `${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=${POS_SEARCH_RESULT_CAP}`,
        {
          headers: apiAuth(),
        },
      ).then(async (res) => {
        if (res.ok) {
          const data = await res.json() as { rows: Array<Record<string, unknown>> };
          const mapped = (data.rows || []).map((r) => ({
            product_id: r.product_id,
            variant_id: r.variant_id,
            sku: r.sku,
            name: r.product_name,
            variation_label: r.variation_label,
            standard_retail_price: r.retail_price || 0,
            unit_cost: r.cost_price || 0,
            stock_on_hand: r.stock_on_hand || 0,
            state_tax: r.state_tax || 0,
            local_tax: r.local_tax || 0,
          }));
          collected.push(...(mapped as SearchResult[]));
        }
      }),
    );

    try {
      await Promise.all(requests);
      // Deduplicate by variant_id
      const seen = new Set<string>();
      const finalResults = collected.filter(it => {
        if (seen.has(it.variant_id)) return false;
        seen.add(it.variant_id);
        return true;
      });
      setSearchResults(finalResults);
    } catch (e) {
      console.error("POS Search Error", e);
    }
  }, [baseUrl, apiAuth, rmsPaymentMeta, toast]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
      return;
    }
    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current);
    }
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      void runSearch(search);
    }, 250);
    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
    };
  }, [search, runSearch]);

  const scannerOverlayOpen = useMemo(
    () =>
      !checkoutOperator ||
      checkoutDrawerOpen ||
      exchangeWizardOpen ||
      suitSwapWizardOpen ||
      weddingDrawerOpen ||
      measDrawerOpen ||
      customerProfileHubOpen ||
      cashAdjustOpen ||
      giftCardLoadOpen ||
      activeVariationSelection !== null ||
      showClearConfirm ||
      showWalkinConfirm ||
      showVoidAllConfirm ||
      discountPrompt !== null ||
      intelligenceVariantId !== null ||
      lastOrderId !== null,
    [
      checkoutOperator,
      checkoutDrawerOpen,
      exchangeWizardOpen,
      suitSwapWizardOpen,
      weddingDrawerOpen,
      measDrawerOpen,
      customerProfileHubOpen,
      cashAdjustOpen,
      giftCardLoadOpen,
      activeVariationSelection,
      showClearConfirm,
      showWalkinConfirm,
      showVoidAllConfirm,
      discountPrompt,
      intelligenceVariantId,
      lastOrderId,
    ],
  );

  /**
   * HID laser scanners: `useScanner` listens on document and ignores keydown when the target is
   * already an input/textarea (e.g. customer Quick Add). When focus is on the keypad or cart body,
   * scans are routed here into the product search field.
   */
  const handleLaserScan = useCallback(
    (code: string) => {
      if (!checkoutOperator) {
        toast(
          "Sign in as cashier on the register sign-in screen before scanning.",
          "error",
        );
        return;
      }
      const trimmed = code.trim();
      if (trimmed.length < 2) return;
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current);
        searchDebounceRef.current = null;
      }
      setSearch(trimmed);
      searchInputRef.current?.focus();
      void runSearch(trimmed);
    },
    [runSearch, checkoutOperator, toast],
  );

  useScanner({
    onScan: handleLaserScan,
    enabled: !scannerOverlayOpen && saleHydrated,
  });

  useEffect(() => {
    if (!saleHydrated) return;
    if (!checkoutOperator) {
      didInitialProductSearchFocusRef.current = false;
      return;
    }
    if (didInitialProductSearchFocusRef.current) return;
    didInitialProductSearchFocusRef.current = true;
    const id = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [saleHydrated, checkoutOperator]);

  // --- Cart Actions ---
  const addItem = (item: ResolvedSkuItem, priceOverride?: string) => {
    if (!checkoutOperator) {
      toast(
        "Sign in as cashier on the register sign-in screen before adding items.",
        "error",
      );
      return;
    }

    if (item.sku.toUpperCase().startsWith("CUSTOM") && !item.custom_item_type) {
      setPendingCustomItem(item);
      setCustomPromptOpen(true);
      return;
    }

    if (giftCardLoadMeta && item.sku === giftCardLoadMeta.sku) {
      toast(
        "Use the Gift card button to add a load amount and card code.",
        "error",
      );
      return;
    }
    if (rmsPaymentMeta && item.sku === rmsPaymentMeta.sku) {
      if (lines.some((l) => l.sku === rmsPaymentMeta.sku)) {
        toast("RMS CHARGE PAYMENT is already in the cart.", "error");
        return;
      }
      if (activeWeddingMember) {
        toast(
          "Clear the wedding party link before collecting an R2S payment.",
          "error",
        );
        return;
      }
      setActiveWeddingMember(null);
      setActiveWeddingPartyName(null);
      setDisbursementMembers([]);
    }
    setLines((prev) => {
      const existing = prev.find(
        (l) =>
          l.sku === item.sku &&
          l.fulfillment === "takeaway" &&
          !priceOverride &&
          !l.gift_card_load_code,
      );
      if (existing) {
        setSelectedLineKey(cartLineKey(existing));
        return prev.map((l) =>
          l.sku === item.sku &&
          l.fulfillment === "takeaway" &&
          !priceOverride &&
          !l.gift_card_load_code
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }

      const newLine: CartLineItem = {
        ...item,
        quantity: 1,
        fulfillment: "takeaway",
        cart_row_id: newCartRowId(),
      };

      if (rmsPaymentMeta && item.sku === rmsPaymentMeta.sku) {
        newLine.standard_retail_price = "0.00";
        newLine.state_tax = "0.00";
        newLine.local_tax = "0.00";
        newLine.original_unit_price = undefined;
        newLine.price_override_reason = undefined;
      }

      const cartUsesEmployeePrice =
        Boolean(employeeCustomerId) &&
        selectedCustomer?.id === employeeCustomerId &&
        !priceOverride &&
        item.employee_price != null &&
        String(item.employee_price).trim() !== "";
      if (cartUsesEmployeePrice) {
        newLine.standard_retail_price = centsToFixed2(
          parseMoneyToCents(item.employee_price),
        );
        newLine.original_unit_price = undefined;
        newLine.price_override_reason = undefined;
      }

      if (priceOverride) {
        newLine.standard_retail_price = centsToFixed2(
          parseMoneyToCents(priceOverride),
        );
        newLine.original_unit_price = centsToFixed2(
          parseMoneyToCents(item.standard_retail_price),
        );
        newLine.price_override_reason = "Initial Override";
      }

      setSelectedLineKey(cartLineKey(newLine));
      return [...prev, newLine];
    });
    setSearch("");
    setSearchResults([]);
    setActiveVariationSelection(null); 
    playPosScanSuccess();
  };

  const addGiftCardLoadToCart = useCallback(
    (code: string, amountCents: number) => {
      if (!checkoutOperator) {
        toast(
          "Sign in as cashier on the register sign-in screen before adding a gift card load.",
          "error",
        );
        return;
      }
      if (!giftCardLoadMeta) {
        toast(
          "Gift card load line is not configured. Run migrations or check API.",
          "error",
        );
        return;
      }
      const rowId = newCartRowId();
      const line: CartLineItem = {
        product_id: giftCardLoadMeta.product_id,
        variant_id: giftCardLoadMeta.variant_id,
        sku: giftCardLoadMeta.sku,
        name: giftCardLoadMeta.name,
        standard_retail_price: centsToFixed2(amountCents),
        unit_cost: "0.00",
        state_tax: "0.00",
        local_tax: "0.00",
        quantity: 1,
        fulfillment: "takeaway",
        cart_row_id: rowId,
        gift_card_load_code: code.trim().toUpperCase(),
        price_override_reason: "pos_gift_card_load",
        original_unit_price: "0.00",
      };
      setLines((prev) => [...prev, line]);
      setSelectedLineKey(rowId);
      setSearch("");
      setSearchResults([]);
      setGiftCardLoadOpen(false);
      playPosScanSuccess();
    },
    [giftCardLoadMeta, toast, checkoutOperator],
  );

  const addItemRef = useRef(addItem);
  addItemRef.current = addItem;

  useEffect(() => {
    const sku = pendingInventorySku?.trim();
    if (!sku || !saleHydrated) return;
    if (!checkoutOperator) {
      toast(
        "Sign in as cashier on the register sign-in screen before adding from inventory.",
        "error",
      );
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(sku)}`, {
          headers: apiAuth(),
        });
        if (cancelled) return;
        if (res.ok) {
          const r = (await res.json()) as Record<string, unknown>;
          addItemRef.current(scanPayloadToResolvedItem(r));
        } else {
          toast(`Could not add ${sku}`, "error");
          playPosScanError();
        }
      } catch {
        if (!cancelled) {
          toast("Could not add item from inventory", "error");
          playPosScanError();
        }
      } finally {
        if (!cancelled) onPendingInventorySkuConsumed?.();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    pendingInventorySku,
    saleHydrated,
    baseUrl,
    onPendingInventorySkuConsumed,
    toast,
    apiAuth,
    checkoutOperator,
  ]);

  const handleSearchResultClick = (item: SearchResult) => {
    if (!ensureSaleCashier()) return;
    const siblings = searchResults.filter(r => r.product_id === item.product_id);
    const exactSkuMatch = search.trim().toLowerCase() === item.sku.toLowerCase();

    if (siblings.length > 1 && !exactSkuMatch) {
       setActiveVariationSelection({
         product_id: item.product_id,
         name: item.name,
         variants: siblings.map(s => ({
           variant_id: s.variant_id,
           sku: s.sku,
           variation_label: s.variation_label || "Standard",
           stock_on_hand: s.stock_on_hand || 0,
           retail_price: String(s.standard_retail_price),
         }))
       });
    } else {
       addItem(item);
    }
  };

  const openLineProductBrowser = useCallback(
    async (line: CartLineItem) => {
      if (!ensureSaleCashier()) return;
      if (rmsPaymentMeta && line.sku === rmsPaymentMeta.sku) {
        setIntelligenceVariantId(line.variant_id);
        return;
      }
      if (giftCardLoadMeta && line.sku === giftCardLoadMeta.sku) {
        setIntelligenceVariantId(line.variant_id);
        return;
      }
      if (line.gift_card_load_code) {
        setIntelligenceVariantId(line.variant_id);
        return;
      }
      try {
        const res = await fetch(
          `${baseUrl}/api/products/control-board?product_id=${encodeURIComponent(line.product_id)}&limit=500`,
          { headers: apiAuth() },
        );
        if (!res.ok) {
          toast("Could not load variants for this line.", "error");
          return;
        }
        const data = (await res.json()) as { rows: Array<Record<string, unknown>> };
        const rows = data.rows || [];
        const seen = new Set<string>();
        const unique = rows.filter((r) => {
          const id = String(r.variant_id);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        if (unique.length <= 1) {
          setIntelligenceVariantId(line.variant_id);
          return;
        }
        setVariantSwapCartRowId(line.cart_row_id);
        setActiveVariationSelection({
          product_id: line.product_id,
          name: String(unique[0]?.product_name ?? line.name),
          variants: unique.map((r) => ({
            variant_id: String(r.variant_id),
            sku: String(r.sku),
            variation_label: r.variation_label ? String(r.variation_label) : "Standard",
            stock_on_hand: typeof r.stock_on_hand === "number" ? r.stock_on_hand : 0,
            retail_price: String(r.retail_price ?? 0),
          })),
        });
      } catch {
        toast("Could not load variants for this line.", "error");
      }
    },
    [
      apiAuth,
      baseUrl,
      giftCardLoadMeta,
      rmsPaymentMeta,
      toast,
      ensureSaleCashier,
    ],
  );

  const groupedSearchResults = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {};
    searchResults.forEach(r => {
      if (!groups[r.product_id]) groups[r.product_id] = [];
      groups[r.product_id].push(r);
    });
    return Object.values(groups).sort((a,b) => a[0].name.localeCompare(b[0].name));
  }, [searchResults]);

  const updateLineFulfillment = (rowId: string, next: FulfillmentKind) => {
    const line = lines.find((l) => l.cart_row_id === rowId);
    if (rmsPaymentMeta && line && line.sku === rmsPaymentMeta.sku && next !== "takeaway") {
      toast("R2S payment must stay on Take Now.", "info");
      return;
    }
    if (
      giftCardLoadMeta &&
      line &&
      line.sku === giftCardLoadMeta.sku &&
      next !== "takeaway"
    ) {
      toast("Gift card load must stay on Take Now.", "info");
      return;
    }
    setLines((prev) =>
      prev.map((l) =>
        l.cart_row_id === rowId ? { ...l, fulfillment: next } : l,
      ),
    );
    setSelectedLineKey(rowId);
  };

  const updateLineGiftWrapStatus = useCallback((rowId: string, status: boolean) => {
    setLines((prev) =>
      prev.map((l) =>
        l.cart_row_id === rowId ? { ...l, needs_gift_wrap: status } : l,
      ),
    );
    if (!status) toast("Gift wrap removed", "info");
    else toast("Gift wrap added", "success");
  }, [setLines, toast]);

  const updateLineSalesperson = useCallback((rowId: string, salespersonId: string) => {
    const v = salespersonId.trim();
    setLines((prev) =>
      prev.map((l) =>
        l.cart_row_id === rowId
          ? { ...l, salesperson_id: v ? v : undefined }
          : l,
      ),
    );
  }, []);

  const removeLine = (rowId: string) => {
    setLines((prev) => prev.filter((l) => l.cart_row_id !== rowId));
    setSelectedLineKey((cur) => (cur === rowId ? null : cur));
  };

  // --- Numpad Handling ---
  const handleNumpadKey = (key: string) => {
    if (!checkoutOperator) {
      toast(
        "Sign in as cashier on the register sign-in screen before using the keypad.",
        "error",
      );
      return;
    }
    if (!selectedLineKey) return;
    const line = lines.find((l) => cartLineKey(l) === selectedLineKey);
    if (!line) return;

    const isRmsPaymentLine =
      !!rmsPaymentMeta && line.sku === rmsPaymentMeta.sku;
    const isGiftCardLoadLine =
      !!giftCardLoadMeta && line.sku === giftCardLoadMeta.sku;

    if (key === "CLEAR") {
      setKeypadBuffer("");
      return;
    }
    if (key === "ENTER" || key === "%" || key === "$") {
      if (keypadMode === "qty") {
        const q = Math.floor(parseMoney(keypadBuffer));
        if (!Number.isFinite(q)) {
          setKeypadBuffer("");
          return;
        }
        if (isRmsPaymentLine && q !== 1) {
          toast("RMS CHARGE PAYMENT must stay quantity 1.", "info");
          setKeypadBuffer("");
          return;
        }
        if (isGiftCardLoadLine && q !== 1) {
          toast("POS GIFT CARD LOAD must stay quantity 1.", "info");
          setKeypadBuffer("");
          return;
        }
        setLines((prev) =>
          prev.map((l) =>
            cartLineKey(l) === selectedLineKey
              ? { ...l, quantity: Math.max(0, q) }
              : l,
          ),
        );
      } else {
        if (isRmsPaymentLine && key === "%") {
          toast(
            "Enter a dollar amount for R2S payment (tap $ or Apply).",
            "info",
          );
          setKeypadBuffer("");
          return;
        }
        if (isGiftCardLoadLine && key === "%") {
          toast(
            "Enter a dollar amount for the gift card load (tap $ or Apply).",
            "info",
          );
          setKeypadBuffer("");
          return;
        }
        const regCents = parseMoneyToCents(
          line.original_unit_price || line.standard_retail_price,
        );
        const saleCentsBefore = parseMoneyToCents(line.standard_retail_price);
        const pctIn = parseMoney(keypadBuffer);
        const newCents =
          key === "%"
            ? Math.round(regCents * (100 - pctIn) / 100)
            : parseMoneyToCents(keypadBuffer);
        if (!Number.isFinite(newCents) || newCents < 0) {
          setKeypadBuffer("");
          return;
        }

        const discountPct =
          regCents > 0 ? (1 - newCents / regCents) * 100 : 0;
        const reason =
          line.price_override_reason === "Initial Override"
            ? line.price_override_reason
            : "pos_manual_price";

        if (
          !isRmsPaymentLine &&
          !isGiftCardLoadLine &&
          discountPct > roleMaxDiscountPct + 0.01
        ) {
          setDiscountPrompt({
            variantId: line.variant_id,
            nextPriceCents: newCents,
            originalPriceCents: regCents,
            reason: reason || "pos_manual_price",
          });
          setKeypadBuffer("");
          return;
        }

        const taxRatio =
          saleCentsBefore > 0 ? newCents / saleCentsBefore : 1;
        const st = Math.max(
          0,
          Math.round(parseMoneyToCents(line.state_tax) * taxRatio),
        );
        const lt = Math.max(
          0,
          Math.round(parseMoneyToCents(line.local_tax) * taxRatio),
        );

        setLines((prev) =>
          prev.map((l) =>
            cartLineKey(l) === selectedLineKey
              ? isRmsPaymentLine
                ? {
                    ...l,
                    standard_retail_price: centsToFixed2(newCents),
                    original_unit_price: "0.00",
                    state_tax: "0.00",
                    local_tax: "0.00",
                    price_override_reason: "rms_charge_payment",
                    discount_event_id: undefined,
                  }
                : isGiftCardLoadLine
                  ? {
                      ...l,
                      standard_retail_price: centsToFixed2(newCents),
                      original_unit_price: "0.00",
                      state_tax: "0.00",
                      local_tax: "0.00",
                      price_override_reason: "pos_gift_card_load",
                      discount_event_id: undefined,
                    }
                  : {
                      ...l,
                      standard_retail_price: centsToFixed2(newCents),
                      original_unit_price: centsToFixed2(regCents),
                      state_tax: centsToFixed2(st),
                      local_tax: centsToFixed2(lt),
                      price_override_reason: reason,
                      discount_event_id: undefined,
                    }
              : l,
          ),
        );
      }
      setKeypadBuffer("");
      return;
    }
    setKeypadBuffer((prev) => prev + key);
  };

  const onExchangeContinue = useCallback(
    (args: { originalOrderId: string; customer: Customer | null }) => {
      pendingExchangeOriginalOrderIdRef.current = args.originalOrderId;
      const linkedCustomer = args.customer;
      if (!linkedCustomer) return;
      void (async () => {
        try {
          const res = await fetch(`${baseUrl}/api/customers/${linkedCustomer.id}`, {
            headers: { ...apiAuth() },
          });
          if (res.ok) {
            const c = (await res.json()) as Customer & { id: string };
            setSelectedCustomer({
              id: String(c.id),
              customer_code: c.customer_code ?? "",
              first_name: c.first_name,
              last_name: c.last_name,
              company_name: c.company_name ?? null,
              email: c.email ?? null,
              phone: c.phone ?? null,
            });
          } else {
            setSelectedCustomer(args.customer);
          }
        } catch {
          setSelectedCustomer(args.customer);
        }
      })();
    },
    [baseUrl, apiAuth],
  );

  const applyDiscountEventToSelectedLine = useCallback(() => {
    if (!selectedLineKey || !selectedDiscountEventId) {
      toast("Select a line and a discount event", "info");
      return;
    }
    const ev = activeDiscountEvents.find((e) => e.id === selectedDiscountEventId);
    if (!ev) return;
    const line = lines.find((l) => cartLineKey(l) === selectedLineKey);
    if (!line) return;
    if (rmsPaymentMeta && line.sku === rmsPaymentMeta.sku) {
      toast("Discount events do not apply to RMS CHARGE PAYMENT.", "info");
      return;
    }
    if (giftCardLoadMeta && line.sku === giftCardLoadMeta.sku) {
      toast("Discount events do not apply to POS GIFT CARD LOAD.", "info");
      return;
    }
    const sc = ev.scope_type ?? "variants";
    if (sc === "variants" && !eventVariantIds.has(line.variant_id)) {
      toast("This SKU is not in the selected event", "error");
      return;
    }
    if (
      sc === "category" &&
      ev.scope_category_id &&
      line.category_id !== ev.scope_category_id
    ) {
      toast("This line is not in the promotion category", "error");
      return;
    }
    if (
      sc === "vendor" &&
      ev.scope_vendor_id &&
      line.primary_vendor_id !== ev.scope_vendor_id
    ) {
      toast("This line is not from the promotion vendor", "error");
      return;
    }
    const pct = Number.parseFloat(ev.percent_off);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      toast("Invalid event percent", "error");
      return;
    }
    const oldP = parseMoneyToCents(line.standard_retail_price);
    if (oldP <= 0) return;
    const baseCents = line.original_unit_price
      ? parseMoneyToCents(line.original_unit_price)
      : oldP;
    const newP = Math.round((baseCents * (100 - pct)) / 100);
    const ratio = oldP > 0 ? newP / oldP : 1;
    const st = Math.max(
      0,
      Math.round(parseMoneyToCents(line.state_tax) * ratio),
    );
    const lt = Math.max(
      0,
      Math.round(parseMoneyToCents(line.local_tax) * ratio),
    );
    setLines((prev) =>
      prev.map((l) =>
        cartLineKey(l) === selectedLineKey
          ? {
              ...l,
              original_unit_price:
                l.original_unit_price ?? centsToFixed2(baseCents),
              standard_retail_price: centsToFixed2(newP),
              state_tax: centsToFixed2(st),
              local_tax: centsToFixed2(lt),
              price_override_reason: undefined,
              discount_event_id: selectedDiscountEventId,
            }
          : l,
      ),
    );
    toast(`${ev.receipt_label} discount applied`, "success");
  }, [
    activeDiscountEvents,
    eventVariantIds,
    giftCardLoadMeta,
    lines,
    rmsPaymentMeta,
    selectedDiscountEventId,
    selectedLineKey,
    toast,
  ]);

  const orderLaterFulfillment: FulfillmentKind = activeWeddingMember
    ? "wedding_order"
    : "special_order";

  const hasSpecialOrWeddingLines = useMemo(
    () => lines.some((l) => l.fulfillment !== "takeaway"),
    [lines],
  );

  const allowCheckoutDepositKeypad =
    hasSpecialOrWeddingLines && !isRmsPaymentCart;

  const allowDepositOnlyCompleteSale =
    allowCheckoutDepositKeypad && lines.length > 0;

  const sortedCartLines = useMemo(() => {
    const tagged = lines.map((l, i) => ({ l, i }));
    tagged.sort((a, b) => {
      const ra = a.l.fulfillment === "takeaway" ? 0 : 1;
      const rb = b.l.fulfillment === "takeaway" ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    });
    return tagged.map((t) => t.l);
  }, [lines]);

  useEffect(() => {
    skippedParkedForCustomerRef.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    void refreshParkedSales();
  }, [sessionId, refreshParkedSales]);

  useEffect(() => {
    const cid = selectedCustomer?.id ?? null;
    const prev = prevCustomerIdForParkedRef.current;
    prevCustomerIdForParkedRef.current = cid;

    if (!cid || !sessionId) return;
    if (cid === prev) return;

    const skipKey = `${sessionId}:${cid}`;
    if (skippedParkedForCustomerRef.current.has(skipKey)) return;

    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchParkedSales(baseUrl, sessionId, apiAuth, cid);
        if (cancelled || rows.length === 0) return;
        setParkedCustomerPrompt({ customerId: cid, rows });
      } catch {
        /* best-effort */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedCustomer?.id, sessionId, baseUrl, apiAuth]);

  const recallParkedSale = useCallback(
    async (parkId: string) => {
      if (lines.length > 0) {
        toast("Clear or park the current sale before recalling another.", "error");
        return;
      }
      const tok = await ensurePosTokenForSession();
      if (!tok) {
        toast(
          "This device is missing the register session token. Open or join the register, then try again.",
          "error",
        );
        return;
      }
      const actor = await resolveActorStaffId();
      if (!actor) {
        toast(
          "Sign in to Back Office or verify cashier to recall parked sales.",
          "error",
        );
        return;
      }
      let row = parkedRows.find((r) => r.id === parkId);
      if (!row) {
        try {
          const list = await fetchParkedSales(baseUrl, sessionId, apiAuth);
          row = list.find((r) => r.id === parkId);
        } catch {
          toast("Could not load parked sales", "error");
          return;
        }
      }
      if (!row) {
        toast("Parked sale not found", "error");
        return;
      }
      try {
        await recallParkedSaleOnServer(baseUrl, sessionId, parkId, apiAuth, actor);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Recall failed", "error");
        return;
      }
      const payload = row.payload_json;
      const rawLines = (payload.lines || []) as CartLineItem[];
      setLines(
        rawLines.map((l) => {
          let f = l.fulfillment as FulfillmentKind | "custom";
          if (f === "custom") f = "special_order";
          return withEnsuredCartRowId({
            ...l,
            fulfillment: f as FulfillmentKind,
          });
        }),
      );
      const raw = payload.selectedCustomer as Customer | null | undefined;
      setSelectedCustomer(
        raw
          ? {
              ...raw,
              customer_code: raw.customer_code ?? "",
            }
          : null,
      );
      setActiveWeddingMember(
        (payload.activeWeddingMember as WeddingMember | null) ?? null,
      );
      setActiveWeddingPartyName(payload.activeWeddingPartyName ?? null);
      setDisbursementMembers(
        (payload.disbursementMembers as WeddingMember[]) ?? [],
      );
      const parkedPrimary =
        typeof payload.primarySalespersonId === "string"
          ? payload.primarySalespersonId.trim()
          : "";
      setPrimarySalespersonId(parkedPrimary);
      primaryDefaultedRef.current = parkedPrimary.length > 0;
      await refreshParkedSales();
      setParkedListOpen(false);
      setParkedCustomerPrompt(null);
      toast("Parked sale restored to the register.", "success");
    },
    [
      lines.length,
      sessionId,
      toast,
      refreshParkedSales,
      parkedRows,
      resolveActorStaffId,
      baseUrl,
      apiAuth,
      ensurePosTokenForSession,
    ],
  );

  const deleteParkedSale = useCallback(
    async (parkId: string) => {
      const tok = await ensurePosTokenForSession();
      if (!tok) {
        toast(
          "This device is missing the register session token. Open or join the register, then try again.",
          "error",
        );
        return;
      }
      const actor = await resolveActorStaffId();
      if (!actor) {
        toast(
          "Sign in to Back Office or verify cashier to delete parked sales.",
          "error",
        );
        return;
      }
      try {
        await deleteParkedSaleOnServer(baseUrl, sessionId, parkId, apiAuth, actor);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Delete failed", "error");
        return;
      }
      setParkedCustomerPrompt((prev) => {
        if (!prev) return null;
        const rows = prev.rows.filter((r) => r.id !== parkId);
        if (rows.length === 0) return null;
        return { ...prev, rows };
      });
      await refreshParkedSales();
      toast("Parked sale removed", "info");
    },
    [
      sessionId,
      toast,
      refreshParkedSales,
      resolveActorStaffId,
      baseUrl,
      apiAuth,
      ensurePosTokenForSession,
    ],
  );

  const totals = useMemo(() => {
    const res = lines.reduce(
      (acc, l) => {
        const pC = parseMoneyToCents(l.standard_retail_price);
        const stC = parseMoneyToCents(l.state_tax);
        const ltC = parseMoneyToCents(l.local_tax);
        const qty = l.quantity;

        acc.subtotalCents += pC * qty;
        acc.stateTaxCents += stC * qty;
        acc.localTaxCents += ltC * qty;
        acc.totalPieces += qty;
        if (l.fulfillment === "takeaway") {
          acc.takeawayDueCents += (pC + stC + ltC) * qty;
        }
        return acc;
      },
      {
        subtotalCents: 0,
        stateTaxCents: 0,
        localTaxCents: 0,
        totalPieces: 0,
        takeawayDueCents: 0,
      },
    );

    let disbCents = 0;
    disbursementMembers.forEach((m) => {
      disbCents += parseMoneyToCents(m.balance_due || "0");
    });

    const taxCents = res.stateTaxCents + res.localTaxCents;
    const shipCents = posShipping?.amount_cents ?? 0;
    const orderTotalCents = res.subtotalCents + taxCents + shipCents;
    const collectTotalCents = orderTotalCents + disbCents;

    return {
      subtotalCents: res.subtotalCents,
      stateTaxCents: res.stateTaxCents,
      localTaxCents: res.localTaxCents,
      totalPieces: res.totalPieces,
      taxCents,
      orderTotalCents,
      collectTotalCents,
      shippingCents: shipCents,
      takeawayDueCents: res.takeawayDueCents + shipCents,
      /** Amount to collect (cart + party disbursements); Pay button + payment drawer. */
      totalCents: collectTotalCents,
    };
  }, [lines, disbursementMembers, posShipping]);

  const executeCheckout = async (
    applied: AppliedPaymentLine[], 
    op: CheckoutOperatorContext, 
    ledgerSignals: { appliedDepositAmountCents: number }
  ) => {
    if (!op?.staffId?.trim()) {
      toast(
        "Sign in as cashier on the register sign-in screen before completing payment.",
        "error",
      );
      return;
    }
    if (lines.length === 0 && disbursementMembers.length === 0) return toast("Cart is empty", "error");
    if (!navigator.onLine && posShipping) {
      toast(
        "Shipping requires an online connection. Clear shipping or try again when online.",
        "error",
      );
      return;
    }
    const gotToken = await ensurePosTokenForSession();
    if (!gotToken) {
      toast(
        "This device is missing the till session token. From POS, open or join the till (managers: join lane), or re-enter staff sign-in so the app can request a token.",
        "error",
      );
      return;
    }
    if (posShipping && lines.some(l => l.fulfillment === "takeaway")) {
      toast("Items marked as 'Takeaway' cannot be shipped. Switch fulfillment to Special Order.", "error");
      setCheckoutBusy(false);
      return;
    }

    setCheckoutBusy(true);
    let payment_splits: CheckoutPaymentSplitPayload[] = applied.map((p) => {
      const split: CheckoutPaymentSplitPayload = {
        payment_method: p.method,
        amount: centsToFixed2(p.amountCents),
      };
      const subtype = normalizeGiftCardSubType(p.sub_type);
      if (subtype) split.sub_type = subtype;
      if (p.method === "gift_card" && p.gift_card_code)
        split.gift_card_code = p.gift_card_code;
      return split;
    });

    const ledgerCents = Math.max(0, ledgerSignals.appliedDepositAmountCents);
    let sumPaidCents = applied.reduce((s, p) => s + p.amountCents, 0);

    if (ledgerCents > 0) {
      if (payment_splits.length > 0) {
        const first = payment_splits[0]!;
        const firstCents = parseMoneyToCents(first.amount);
        if (ledgerCents > firstCents) {
          setCheckoutBusy(false);
          toast(
            "Deposit release cannot exceed the first tender amount. Increase that tender or lower the deposit.",
            "error",
          );
          return;
        }
        payment_splits = [
          { ...first, applied_deposit_amount: centsToFixed2(ledgerCents) },
          ...payment_splits.slice(1),
        ];
      } else {
        payment_splits = [
          {
            payment_method: "deposit_ledger",
            amount: centsToFixed2(ledgerCents),
            applied_deposit_amount: centsToFixed2(ledgerCents),
          },
        ];
        sumPaidCents = ledgerCents;
      }
    }

    if (sumPaidCents > totals.collectTotalCents) {
      setCheckoutBusy(false);
      toast(
        `Collected total $${centsToFixed2(sumPaidCents)} is more than the amount due $${centsToFixed2(totals.collectTotalCents)}. Remove or lower a tender.`,
        "error",
      );
      return;
    }

    const checkoutClientId = newCheckoutClientId();

    const primaryTrim = primarySalespersonId.trim();
    const payload: CheckoutPayload = {
      session_id: sessionId,
      operator_staff_id: op.staffId,
      primary_salesperson_id: primaryTrim ? primaryTrim : null,
      customer_id: selectedCustomer?.id ?? null,
      wedding_member_id: activeWeddingMember?.id ?? null,
      payment_method:
        payment_splits.length === 1 ? payment_splits[0]!.payment_method : "split",
      total_price: centsToFixed2(totals.orderTotalCents),
      amount_paid: centsToFixed2(sumPaidCents),
      checkout_client_id: checkoutClientId,
      is_rush: lines.some(l => l.is_rush),
      need_by_date: lines.find(l => l.need_by_date)?.need_by_date || null,
      actor_name: op.fullName.trim() || cashierName?.trim() || null,
      payment_splits,
      applied_deposit_amount:
        ledgerSignals.appliedDepositAmountCents > 0
          ? centsToFixed2(ledgerSignals.appliedDepositAmountCents)
          : undefined,
      items: lines.map((l) => {
        const unitCents = parseMoneyToCents(l.standard_retail_price);
        const origCents =
          l.original_unit_price != null
            ? parseMoneyToCents(l.original_unit_price)
            : unitCents;
        const hasDifferentOriginal = origCents !== unitCents;
        const reasonForPayload =
          l.discount_event_id != null
            ? l.price_override_reason
            : hasDifferentOriginal
              ? l.price_override_reason?.trim() || "pos_manual_price"
              : l.price_override_reason;
        return {
          product_id: l.product_id, 
          variant_id: l.variant_id, 
          fulfillment: pickupConfirmed ? "takeaway" : (l.fulfillment ?? "takeaway"),
          quantity: l.quantity,
          unit_price: centsToFixed2(unitCents),
          original_unit_price: hasDifferentOriginal
            ? centsToFixed2(origCents)
            : undefined,
          price_override_reason: reasonForPayload,
          unit_cost: centsToFixed2(parseMoneyToCents(l.unit_cost)),
          state_tax: centsToFixed2(parseMoneyToCents(l.state_tax)), 
          local_tax: centsToFixed2(parseMoneyToCents(l.local_tax)),
          salesperson_id: l.salesperson_id?.trim() || null,
          custom_item_type: l.custom_item_type,
          is_rush: l.is_rush,
          need_by_date: l.need_by_date,
          needs_gift_wrap: l.needs_gift_wrap,
          ...(l.discount_event_id
            ? { discount_event_id: l.discount_event_id }
            : {}),
          ...(l.gift_card_load_code?.trim()
            ? {
                gift_card_load_code: l.gift_card_load_code.trim().toUpperCase(),
              }
            : {}),
        };
      }),
      wedding_disbursements: disbursementMembers.length > 0 ? disbursementMembers.map(m => ({
        wedding_member_id: m.id,
        amount: centsToFixed2(parseMoneyToCents(m.balance_due || "0")),
      })) : undefined,
      ...(posShipping
        ? { shipping_rate_quote_id: posShipping.rate_quote_id }
        : {}),
    };

    try {
      if (!navigator.onLine) {
        if (posShipping) {
          toast(
            "Cannot queue a sale with shipping while offline. Clear shipping or connect first.",
            "error",
          );
          return;
        }
        await enqueueCheckout(payload, apiAuth());
        toast("Sale saved on this device. It will sync when you are back online.", "info");
        setCheckoutDrawerOpen(false);
        clearCart();
        onSaleCompleted?.();
        return;
      }
      const res = await fetch(`${baseUrl}/api/orders/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = typeof b.error === "string" ? b.error.trim() : "";
        throw new Error(msg || `Checkout failed (${res.status})`);
      }

      const data = (await res.json()) as { order_id: string };
      const orig = pendingExchangeOriginalOrderIdRef.current;
      pendingExchangeOriginalOrderIdRef.current = null;
      if (orig && orig !== data.order_id) {
        try {
          const linkRes = await fetch(
            `${baseUrl}/api/orders/${encodeURIComponent(orig)}/exchange-link?register_session_id=${encodeURIComponent(sessionId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...apiAuth(),
              },
              body: JSON.stringify({ other_order_id: data.order_id }),
            },
          );
          if (!linkRes.ok) {
            const b = (await linkRes.json().catch(() => ({}))) as {
              error?: string;
            };
            toast(
              b.error ??
                "Could not link exchange in register. Link the two orders in Back Office Orders.",
              "error",
            );
          } else {
            toast("Exchange linked for reporting", "success");
          }
        } catch {
          toast(
            "Could not link exchange in register. Link the two orders in Back Office Orders.",
            "error",
          );
        }
      }
      setLastOrderId(data.order_id);
      toast("Checkout complete", "success");
      setCheckoutDrawerOpen(false);
      clearCart();
    } catch (e) {
      playPosScanError();
      const unreachable =
        e instanceof TypeError ||
        (e instanceof Error && /failed to fetch|networkerror|load failed/i.test(e.message));
      toast(
        unreachable
          ? "Cannot reach the Riverside API. Check connection or API address in Settings."
          : e instanceof Error && e.message
            ? e.message
            : "Checkout failed",
        "error",
      );
    } finally { 
      setCheckoutBusy(false); 
    }
  };

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-app-bg">
      {checkoutDrawerOpen ? (
        <div
          className="pointer-events-none absolute inset-0 z-[95] bg-black/25"
          aria-hidden
        />
      ) : null}
      <div className="relative z-0 flex min-h-0 flex-[2] flex-col overflow-hidden border-r border-app-border">
        <div className="shrink-0 border-b border-app-border bg-app-surface px-3 py-2 shadow-sm sm:px-4 lg:px-6 lg:py-3">
          <div className="space-y-2 rounded-2xl border border-app-border/90 bg-gradient-to-br from-app-surface via-app-surface to-app-surface-2/40 p-2.5 shadow-[0_14px_48px_-24px_rgba(0,0,0,0.18)] ring-1 ring-black/[0.04] dark:from-app-surface dark:via-app-surface dark:to-app-surface-2/25 dark:ring-white/[0.06]">
          {/* Wedding link badge */}
          {activeWeddingMember && (
            <div className="flex items-center justify-between rounded-xl border border-app-accent/30 bg-app-accent/5 p-2 animate-in slide-in-from-top duration-300">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-app-accent text-white shadow-lg shadow-app-accent/20">
                  <Users size={14} />
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-accent">
                    Wedding member linked
                  </p>
                  <p className="truncate text-xs font-black italic text-app-text-muted">
                    {activeWeddingMember.first_name} {activeWeddingMember.last_name} —{" "}
                    {activeWeddingPartyName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveWeddingMember(null);
                  setActiveWeddingPartyName(null);
                }}
                className="shrink-0 p-2 text-app-text-muted transition-colors hover:text-red-500"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Cashier + default salesperson on one row (after sign-in). Sign-in uses full-screen overlay (Back Office style). */}
          {checkoutOperator ? (
            <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-app-border/70 bg-app-surface-2/70 px-2.5 py-1.5">
              <div className="flex min-w-0 max-w-full items-center gap-2">
                <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Cashier:
                </span>
                <span className="min-w-0 truncate text-xs font-black text-app-text">
                  {checkoutOperator.fullName}
                </span>
                {lines.length === 0 ? (
                  <button
                    type="button"
                    className="ui-btn-secondary shrink-0 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest"
                    onClick={() => {
                      setCheckoutOperator(null);
                      setSaleCashierCredential("");
                      setSaleCashierError(null);
                    }}
                  >
                    Switch
                  </button>
                ) : null}
              </div>
              {!isGiftCardOnlyCart ? (
                <>
                  <div
                    className="hidden h-6 w-px shrink-0 bg-app-border/80 sm:block"
                    aria-hidden
                  />
                  <UserCircle
                    size={16}
                    className="hidden shrink-0 text-app-accent sm:block"
                    aria-hidden
                  />
                  <label className="flex min-w-0 max-w-full shrink-0 items-center gap-2 sm:max-w-[min(100%,16.5rem)]">
                    <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Salesperson
                    </span>
                    <span className="sr-only">
                      Default for commission on all lines unless a line overrides
                    </span>
                    <select
                      className="ui-input w-[min(100%,12.5rem)] min-w-0 max-w-[12.5rem] shrink-0 cursor-pointer py-1.5 text-xs font-bold text-app-text sm:w-52"
                      value={primarySalespersonId}
                      onChange={(e) => {
                        primaryDefaultedRef.current = true;
                        setPrimarySalespersonId(e.target.value);
                      }}
                    >
                      <option value="">Select…</option>
                      {commissionStaff.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.full_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {lines.some((l) => (l.salesperson_id?.trim() ?? "") !== "") ? (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-amber-800 ring-1 ring-amber-500/25 dark:text-amber-200">
                      Line overrides
                    </span>
                  ) : null}
                </>
              ) : null}
              <PosRegisterLiveClock timeZone={receiptTimezone} />
            </div>
          ) : null}

          {/* Product search */}
          <div className="relative w-full">
            <Search
              className="absolute left-3 top-1/2 size-[18px] -translate-y-1/2 text-app-text-muted"
              aria-hidden
            />
            <input
              ref={searchInputRef}
              type="text"
              data-testid="pos-product-search"
              placeholder="Search Name, SKU, or Supplier SKUs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (searchDebounceRef.current) {
                  clearTimeout(searchDebounceRef.current);
                  searchDebounceRef.current = null;
                }
                const q = search.trim();
                if (q.length < 2) return;
                e.preventDefault();
                void runSearch(search);
              }}
              className="ui-input h-11 w-full border-2 border-app-border pl-10 text-base font-black shadow-inner focus:border-app-accent"
            />
              {groupedSearchResults.length > 0 && (
                <div className="absolute left-0 right-0 top-full z-50 mt-2 max-h-[65vh] overflow-y-auto rounded-3xl border-2 border-app-text bg-app-surface p-3 shadow-[0_32px_96px_-16px_rgba(0,0,0,0.5)] transition-all no-scrollbar">
                  <div className="flex flex-col gap-2">
                    {groupedSearchResults.map((group) => {
                      const item = group[0];
                      const isExactSku = group.some(
                        (g) => g.sku.toLowerCase() === search.trim().toLowerCase(),
                      );
                      const variationCount = group.length;

                      return (
                        <button
                          key={item.product_id}
                          onClick={() =>
                            handleSearchResultClick(
                              group.find(
                                (g) =>
                                  g.sku.toLowerCase() ===
                                  search.trim().toLowerCase(),
                              ) || item,
                            )
                          }
                          className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border-2 p-4 text-left transition-all ${
                            isExactSku
                              ? "border-app-accent bg-app-accent/5"
                              : "border-app-border hover:border-app-border hover:bg-app-surface-2"
                          }`}
                        >
                          <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-sm transition-transform group-hover:scale-105">
                            {item.image_url ? (
                              <img
                                src={item.image_url}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            ) : (
                              <Package
                                className="m-auto h-full text-app-text-muted opacity-50"
                                size={24}
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 relative z-10">
                            <div className="mb-1 flex items-center gap-2">
                              <p className="truncate text-base font-black uppercase italic leading-tight tracking-tighter text-app-text">
                                {item.name}
                              </p>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-app-text-muted">
                                {variationCount > 1
                                  ? `${variationCount} Variations`
                                  : `SKU: ${item.sku}`}
                              </span>
                              {variationCount === 1 && (
                                <span
                                  className={`text-[10px] font-black uppercase tracking-widest ${
                                    (item.stock_on_hand || 0) > 0
                                      ? "text-emerald-600"
                                      : "text-red-500"
                                  }`}
                                >
                                  {item.stock_on_hand || 0} IN STOCK
                                </span>
                              )}
                            </div>
                            {variationCount > 1 && !isExactSku && (
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                {group.slice(0, 4).map((v) => (
                                  <span
                                    key={v.sku}
                                    className="rounded-lg bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted"
                                  >
                                    {v.variation_label || v.sku.slice(-4)}
                                  </span>
                                ))}
                                {variationCount > 4 && (
                                  <span className="rounded-lg bg-app-surface-2 px-2 py-1 text-[9px] font-black text-app-text-muted">
                                    +{variationCount - 4} More
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-xl font-black italic tracking-tighter text-app-text tabular-nums">
                              ${item.standard_retail_price}
                            </p>
                            <div className="mt-1 flex translate-x-2 items-center justify-end font-black text-app-accent opacity-0 transition-opacity group-hover:translate-x-0 group-hover:opacity-100">
                              <span className="text-[10px] uppercase tracking-tighter">
                                {variationCount > 1 && !isExactSku
                                  ? "Size Select"
                                  : "Add Cart"}
                              </span>
                              <ArrowRight size={14} />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
          </div>

          {/* Sale tools row */}
          <div className="flex flex-wrap items-center gap-1.5 border-t border-app-border/50 pt-2">
              <button
                type="button"
                onClick={() => {
                  setWeddingDrawerPreferGroupPay(false);
                  setWeddingDrawerOpen(true);
                }}
                className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 px-3 transition-all active:scale-95 ${activeWeddingMember ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20" : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-accent"}`}
              >
                <Users size={16} />
                <span className="text-[10px] font-black uppercase tracking-widest">
                  {activeWeddingMember ? "Switch" : "Wedding"}
                </span>
              </button>
              <div className="flex items-center gap-0.5 rounded-xl border-2 border-app-border bg-app-surface-2/80 p-0.5">
                <button
                  type="button"
                  data-testid="pos-exchange-wizard-trigger"
                  onClick={() => setExchangeWizardOpen(true)}
                  className="flex h-9 items-center justify-center gap-1.5 rounded-lg border-2 border-transparent bg-transparent px-3 text-app-text-muted transition-all hover:border-app-accent/40 hover:bg-app-surface hover:text-app-accent active:scale-95"
                >
                  <ArrowLeftRight size={16} />
                  <span className="text-[10px] font-black uppercase tracking-widest">
                    Exchange
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setLines(prev => prev.map(l => ({
                      ...l,
                      fulfillment: l.fulfillment === 'layaway' ? 'takeaway' : 'layaway'
                    })));
                  }}
                  className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border-2 px-3 transition-all active:scale-95 ${lines.some(l => l.fulfillment === 'layaway') ? "border-amber-500 bg-amber-50 text-amber-600" : "border-transparent bg-transparent text-app-text-muted hover:border-amber-500/40 hover:bg-app-surface hover:text-amber-700"}`}
                >
                  <Clock size={16} />
                  <span className="text-[10px] font-black uppercase tracking-widest">
                    Layaway
                  </span>
                </button>
              </div>
              <div className="min-w-[4px] flex-1" aria-hidden="true" />
              <button
                type="button"
                onClick={() => setGiftCardLoadOpen(true)}
                title="Enter load amount, then scan or type the card code"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-600/40 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-all hover:bg-emerald-600 hover:text-white"
              >
                <CreditCard size={16} className="shrink-0" aria-hidden />
                Gift Card
              </button>
              <button
                type="button"
                disabled={lines.length === 0 && !selectedCustomer}
                onClick={() => setShowClearConfirm(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-red-500 bg-red-50 px-3 text-[10px] font-black uppercase tracking-widest text-red-600 transition-all hover:bg-red-500 hover:text-white disabled:opacity-20"
              >
                <RotateCcw size={16} />
                Clear Sale
              </button>
          </div>
          </div>
        </div>

        {/* Scrollable line items — designed for 5-6 items visible */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2 no-scrollbar sm:p-3 lg:p-4">
          {lines.length > 0 ? (
            <div className="space-y-1.5">
              <p className="px-1 pt-0.5 text-[9px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Sale lines — tap qty or price, then use the keypad
              </p>
              {sortedCartLines.map((line) => (
                <CartItemRow
                  key={`${line.sku}-${line.fulfillment}`}
                  line={line}
                  orderLaterFulfillment={orderLaterFulfillment}
                  selectedLineKey={selectedLineKey}
                  setSelectedLineKey={setSelectedLineKey}
                  keypadMode={keypadMode}
                  setKeypadMode={setKeypadMode}
                  setKeypadBuffer={setKeypadBuffer}
                  updateLineFulfillment={updateLineFulfillment}
                  updateLineSalesperson={updateLineSalesperson}
                  updateLineGiftWrapStatus={updateLineGiftWrapStatus}
                  removeLine={removeLine}
                  onLineProductTitleClick={openLineProductBrowser}
                  commissionStaff={commissionStaff}
                  orderSalespersonLabel={primarySalespersonLabel}
                  hideLineSalesperson={isGiftCardOnlyCart}
                />
              ))}
            </div>
          ) : (
              <div className="flex flex-col items-center justify-center h-full opacity-40 text-app-text-muted">
                <Package size={64} strokeWidth={1} className="mb-4" />
                <p className="text-base font-black uppercase italic tracking-widest">
                  Cart is Empty
                </p>
             </div>
          )}

          {disbursementMembers.length > 0 && (
             <div className="space-y-3">
                <div className="flex items-center gap-3 px-2">
                  <div className="h-px flex-1 bg-gradient-to-r from-blue-500/50 to-transparent" />
                  <span className="text-[10px] font-black uppercase tracking-[0.3em] text-blue-600">Wedding Party Disbursements</span>
                  <div className="h-px flex-1 bg-gradient-to-l from-blue-500/50 to-transparent" />
                </div>
                {disbursementMembers.map(m => (
                  <div key={m.id} className="relative flex items-center justify-between gap-4 rounded-3xl border-2 border-blue-100 bg-blue-50/30 p-5 group animate-in slide-in-from-left duration-300">
                     <div className="flex items-center gap-4">
                        <div className="h-10 w-10 flex items-center justify-center rounded-2xl bg-blue-500 text-white font-black italic shadow-lg shadow-blue-500/20">
                           {m.first_name[0]}{m.last_name[0]}
                        </div>
                        <div>
                           <h4 className="text-sm font-black text-app-text leading-tight">{m.first_name} {m.last_name}</h4>
                           <p className="text-[9px] font-black uppercase tracking-widest text-blue-600">{m.role}</p>
                        </div>
                     </div>
                     <div className="text-right">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60 mb-1">Applying Amount</p>
                        <p className="text-xl font-black italic tracking-tighter text-blue-600">
                          $
                          {centsToFixed2(parseMoneyToCents(m.balance_due || "0"))}
                        </p>
                     </div>
                     <button 
                       onClick={() => setDisbursementMembers(prev => prev.filter(p => p.id !== m.id))}
                       className="absolute -top-2 -right-2 h-6 w-6 rounded-full bg-red-500 text-white flex items-center justify-center shadow-lg opacity-0 group-hover:opacity-100 transition-opacity"
                     >
                       <X size={12} />
                     </button>
                  </div>
                ))}
             </div>
          )}
        </div>
      </div>

      <aside
        className={`relative z-0 flex h-full min-h-0 w-[min(380px,100%)] min-w-[280px] max-w-[400px] shrink-0 flex-col overflow-hidden border-l border-app-border/80 bg-gradient-to-b from-app-surface via-app-surface-2/25 to-app-bg shadow-[-8px_0_32px_-12px_rgba(0,0,0,0.12)] lg:min-w-[300px] lg:max-w-[min(440px,34vw)] ${checkoutDrawerOpen ? "pointer-events-none select-none opacity-40" : ""}`}
        aria-label="Customer, sale totals and keypad"
      >
        {/* ── Customer selector (payment rail) ── */}
        <div className="shrink-0 border-b border-app-border/60 px-2.5 pt-2 pb-2">
          <CustomerSelector
            variant="posStrip"
            selectedCustomer={selectedCustomer}
            onSelect={(c) => setSelectedCustomer(c)}
            onViewCustomer={() => {
              setCustomerProfileHubOpen(true);
            }}
            onOpenMeasurements={() => setMeasDrawerOpen(true)}
            weddingMemberships={[]}
            showWalkInOption
          />
        </div>

        {/* ── Totals summary ── */}
        <div className="shrink-0 px-2.5 pt-2">
          <div className="rounded-2xl border border-app-border/50 bg-app-surface/80 px-3 py-2 shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
            <div className="mb-1.5 flex items-center justify-between gap-2 border-b border-app-border/40 pb-1.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/[0.12] px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-700 ring-1 ring-emerald-600/15 dark:text-emerald-400 dark:ring-emerald-500/20">
                  <Package size={11} className="shrink-0 opacity-90" aria-hidden />
                  {isRmsPaymentCart ? "R2S payment" : "Retail"}
                </span>
                <span className="font-mono text-[9px] font-bold text-app-text-muted">
                  #{sessionId.slice(-6)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {!isRmsPaymentCart && isGiftCardOnlyCart ? null : (
                  <>
                    {activeDiscountEvents.length > 0 ? (
                      <select
                        className="ui-input cursor-pointer py-1 text-[10px] font-semibold"
                        value={selectedDiscountEventId}
                        onChange={(e) => setSelectedDiscountEventId(e.target.value)}
                        title="Discount event"
                      >
                        <option value="">Event…</option>
                        {activeDiscountEvents.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.receipt_label} ({e.percent_off}%)
                          </option>
                        ))}
                      </select>
                    ) : null}
                    {activeDiscountEvents.length > 0 && selectedDiscountEventId ? (
                      <button
                        type="button"
                        disabled={!selectedLineKey || !selectedDiscountEventId}
                        onClick={() => applyDiscountEventToSelectedLine()}
                        className="ui-btn-secondary py-1 text-[9px] font-black uppercase tracking-widest"
                      >
                        Apply
                      </button>
                    ) : null}
                  </>
                )}
                {managerMode && lines.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowVoidAllConfirm(true)}
                    className="rounded-lg border border-red-500/35 bg-red-500/[0.06] px-2 py-1 text-[9px] font-black uppercase tracking-widest text-red-600 transition-colors hover:bg-red-500 hover:text-white"
                  >
                    Void all
                  </button>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-app-text-muted">
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-bold uppercase tracking-wide">
                <span>Subtotal</span>
                <span className="tabular-nums text-app-text">${centsToFixed2(totals.subtotalCents)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-bold uppercase tracking-wide">
                <span>Items</span>
                <span className="tabular-nums text-app-text">{totals.totalPieces}</span>
              </div>
              <div className="col-span-2 flex items-baseline justify-between gap-2 text-[10px] font-bold uppercase tracking-wide">
                <span>Tax (NYS / Erie)</span>
                <span className="tabular-nums text-app-text">${centsToFixed2(totals.taxCents)}</span>
              </div>
              {posShipping ? (
                <div className="col-span-2 flex items-start justify-between gap-2 rounded-lg bg-sky-500/10 px-2 py-1 text-sky-900 dark:text-sky-200">
                  <div className="min-w-0 text-[9px] font-black uppercase leading-snug tracking-wide">
                    <span className="block normal-case font-bold text-sky-950 dark:text-sky-100">
                      {posShipping.label}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2">
                      <button type="button" onClick={() => setShippingModalOpen(true)} className="text-[9px] font-bold text-app-accent underline">Edit</button>
                      <button type="button" onClick={() => setPosShipping(null)} className="text-[9px] font-bold text-red-600 underline">Clear</button>
                    </span>
                  </div>
                  <span className="shrink-0 text-xs font-black tabular-nums">${centsToFixed2(posShipping.amount_cents)}</span>
                </div>
              ) : (
                <div className="col-span-2 flex justify-end pt-0.5">
                  <button
                    type="button"
                    disabled={isRmsPaymentCart}
                    onClick={() => setShippingModalOpen(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-app-border/80 bg-app-surface-2/90 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text transition-colors hover:border-app-accent/40 hover:bg-app-accent/5 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Truck size={11} aria-hidden />
                    Shipping
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Keypad — uses all remaining space ── */}
        <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-2 pt-2">
          {/* Display / mode hint */}
          <div className="mb-1.5 shrink-0 rounded-xl border border-app-border/60 bg-app-surface-2/80 px-3 py-1.5">
            <p className="text-[9px] font-black uppercase leading-snug tracking-widest text-app-text-muted">
              {selectedLineKey
                ? keypadMode === "qty"
                  ? "Quantity — type amount, Apply"
                  : "Sale price — % off reg price, $ or Apply for dollars"
                : "Select a line, then tap Qty or Sale price"}
            </p>
            <p
              className="mt-0.5 text-right text-xl font-black tabular-nums text-app-text"
              aria-live="polite"
            >
              {selectedLineKey ? (keypadBuffer || "0") : "—"}
            </p>
          </div>

          {/* Keypad grid — fills remaining height */}
          <div className="min-h-0 flex-1 rounded-xl border border-app-border/50 bg-app-surface/60 p-1.5">
            <div className="grid h-full grid-cols-3 grid-rows-5 gap-1.5">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "CLEAR"].map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={!selectedLineKey}
                  onClick={() => handleNumpadKey(key)}
                  className={`flex items-center justify-center rounded-xl border text-lg font-black transition-all active:scale-95 disabled:opacity-30 ${key === "CLEAR" ? "border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/20" : "border-app-border/40 bg-app-surface-2/90 text-app-text hover:bg-app-surface active:bg-app-surface-2"}`}
                >
                  {key}
                </button>
              ))}
              {/* Row 5: %, $, Apply */}
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("%")}
                className="flex items-center justify-center rounded-xl bg-indigo-600 text-lg font-black text-white shadow-md shadow-indigo-500/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-30"
              >
                %
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("$")}
                className="flex items-center justify-center rounded-xl bg-indigo-600 text-lg font-black text-white shadow-md shadow-indigo-500/20 transition-all hover:bg-indigo-500 active:scale-95 disabled:opacity-30"
              >
                $
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("ENTER")}
                className="flex items-center justify-center rounded-xl border-b-[4px] border-emerald-800 bg-emerald-600 text-base font-black uppercase tracking-wide text-white shadow-lg shadow-emerald-500/25 transition-all hover:bg-emerald-500 active:translate-y-0.5 active:scale-95 active:border-b-2 disabled:opacity-30"
              >
                Apply
              </button>
            </div>
          </div>
        </div>

        {/* ── Pay button ── */}
        <div className="shrink-0 border-t border-app-border/70 bg-app-surface/95 p-2.5 shadow-[0_-10px_40px_-18px_rgba(0,0,0,0.15)] backdrop-blur-sm">
           <button 
             type="button" 
             disabled={lines.length === 0 || checkoutBusy} 
             onClick={() => {
               if (lines.length === 0) return toast("Cart is empty", "error");
               if (!ensureSaleCashier()) return;
               if (isRmsPaymentCart) {
                 if (!selectedCustomer) {
                   toast(
                     "Link a customer before collecting an R2S payment.",
                     "error",
                   );
                   return;
                 }
                 const amt = parseMoneyToCents(
                   lines[0]?.standard_retail_price ?? "0",
                 );
                 if (!Number.isFinite(amt) || amt <= 0) {
                   toast(
                     "Enter the payment amount on the keypad (Price), then Pay.",
                     "error",
                   );
                   return;
                 }
                 setCheckoutDrawerOpen(true);
                 return;
               }
               if (!isRmsPaymentCart && !isGiftCardOnlyCart) {
                 const hasAttribution =
                   primarySalespersonId.trim() !== "" ||
                   lines.some((l) => (l.salesperson_id?.trim() ?? "") !== "");
                 if (!hasAttribution) {
                   toast(
                     "Select a salesperson for this sale, or assign one on a line, so commissions can be calculated.",
                     "error",
                   );
                   return;
                 }
               }
               if (!selectedCustomer) {
                 setShowWalkinConfirm(true);
               } else {
                 setCheckoutDrawerOpen(true);
               }
             }}
             className={`ui-touch-target group relative flex h-[4.25rem] w-full items-center justify-between rounded-2xl border-b-[6px] transition-all active:scale-[0.98] active:translate-y-0.5 shadow-2xl ${lines.length > 0 ? 'bg-emerald-600 border-emerald-800 text-white hover:bg-emerald-500 shadow-emerald-500/40' : 'bg-app-surface-2 border-app-border text-app-text-muted cursor-not-allowed opacity-50'}`}
           >
             <div className="flex flex-col items-start pl-5">
                <span className="text-[9px] font-black uppercase tracking-[0.28em] opacity-70">
                  {selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name} — Pay` : "Walk-in — Pay"}
                </span>
                <span className="text-3xl font-black tabular-nums tracking-tighter italic">${centsToFixed2(totals.totalCents)}</span>
             </div>
             <div className="mr-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 transition-transform group-hover:scale-105">
                <span className="text-lg font-black uppercase italic">Pay</span>
             </div>
           </button>
        </div>
      </aside>

      <PosShippingModal
        open={shippingModalOpen}
        onClose={() => setShippingModalOpen(false)}
        baseUrl={baseUrl}
        getHeaders={apiAuth}
        selectedCustomer={selectedCustomer}
        current={posShipping}
        onApply={(next) => {
          setPosShipping(next);
          if (next && lines.some(l => l.fulfillment === "takeaway")) {
            setLines(prev => prev.map(l => ({
              ...l,
              fulfillment: l.fulfillment === "takeaway" ? "special_order" as const : l.fulfillment
            })));
            toast("Switched takeaway items to Special Order for shipping.", "info");
          }
        }}
      />

      <NexoCheckoutDrawer
        isOpen={checkoutDrawerOpen}
        onClose={() => setCheckoutDrawerOpen(false)}
        amountDueCents={totals.totalCents}
        stateTaxCents={totals.stateTaxCents}
        localTaxCents={totals.localTaxCents}
        weddingLinked={!!activeWeddingMember}
        customerId={selectedCustomer?.id}
        customerName={selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}` : undefined}
        authoritativeDepositCents={0}
        profileBlocksCheckout={false}
        onOpenProfileGate={() => {}}
        busy={checkoutBusy}
        onFinalize={executeCheckout}
        allowStoreCredit={!!selectedCustomer}
        appliedPayments={checkoutAppliedPayments}
        onAppliedPaymentsChange={setCheckoutAppliedPayments}
        depositLedgerAmount={checkoutDepositLedger}
        onDepositLedgerAmountChange={setCheckoutDepositLedger}
        checkoutOperator={checkoutOperator}
        allowDepositKeypad={allowCheckoutDepositKeypad}
        rmsPaymentCollectionMode={isRmsPaymentCart}
        allowDepositOnlyComplete={allowDepositOnlyCompleteSale}
        takeawayDueCents={totals.takeawayDueCents}
        shippingCents={totals.shippingCents}
        hasLaterItems={lines.some(l => l.fulfillment && l.fulfillment !== "takeaway")}
        pickupConfirmed={pickupConfirmed}
        onPickupConfirmedChange={setPickupConfirmed}
        onOpenSplitDeposit={() => {
          setWeddingDrawerPreferGroupPay(true);
          setWeddingDrawerOpen(true);
        }}
      />

      <ConfirmationModal
        isOpen={openDepositPrompt != null}
        onClose={() => {
          openDepositSuppressedRef.current = true;
          setOpenDepositPrompt(null);
        }}
        onConfirm={() => {
          if (!openDepositPrompt) return;
          const paid = checkoutAppliedPayments.reduce(
            (s, p) => s + p.amountCents,
            0,
          );
          const remaining = Math.max(0, totals.collectTotalCents - paid);
          const useCents = Math.min(openDepositPrompt.cents, remaining);
          if (useCents > 0) {
            setCheckoutAppliedPayments((prev) => [
              ...prev,
              {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                method: "open_deposit",
                amountCents: useCents,
                label: "Open deposit",
              },
            ]);
          }
          setOpenDepositPrompt(null);
        }}
        title="Use open deposit?"
        message={
          openDepositPrompt
            ? `${openDepositPrompt.payerName ? `${openDepositPrompt.payerName} paid` : "A party member paid"} a deposit held on this account (${centsToFixed2(openDepositPrompt.cents)} available). Apply it to this sale?`
            : ""
        }
        confirmLabel="Apply to sale"
        variant="info"
      />
      {parkedListOpen ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 font-sans">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setParkedListOpen(false)}
            aria-label="Close parked sales"
          />
          <div
            className="relative flex max-h-[min(560px,85vh)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="parked-sales-title"
          >
            <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
              <h2
                id="parked-sales-title"
                className="text-sm font-black uppercase tracking-widest text-app-text"
              >
                Parked sales
              </h2>
              <button
                type="button"
                onClick={() => setParkedListOpen(false)}
                className="ui-touch-target rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
              {parkedRows.length === 0 ? (
                <p className="py-8 text-center text-sm text-app-text-muted">
                  No parked sales for this register.
                </p>
              ) : (
                <ul className="space-y-2">
                  {parkedRows.map((p) => {
                    const lineCount = Array.isArray(p.payload_json?.lines)
                      ? p.payload_json.lines.length
                      : 0;
                    return (
                    <li
                      key={p.id}
                      className="rounded-xl border border-app-border bg-app-surface-2 p-3"
                    >
                      <p className="text-xs font-black text-app-text">{p.label}</p>
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                        {lineCount} line{lineCount === 1 ? "" : "s"} ·{" "}
                        {new Date(p.created_at).toLocaleString()}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void recallParkedSale(p.id)}
                          className="ui-btn-primary flex-1 py-2 text-[10px] font-black uppercase tracking-widest"
                        >
                          Recall
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteParkedSale(p.id)}
                          className="ui-btn-secondary flex-1 border-red-200 py-2 text-[10px] font-black uppercase tracking-widest text-red-600"
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
      {parkedCustomerPrompt ? (
        <div className="fixed inset-0 z-[115] flex items-center justify-center p-4 font-sans">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setParkedCustomerPrompt(null)}
            aria-label="Dismiss parked sale prompt"
          />
          <div
            className="relative w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="parked-customer-prompt-title"
          >
            <h2
              id="parked-customer-prompt-title"
              className="text-sm font-black uppercase tracking-widest text-app-text"
            >
              Parked sale for this customer
            </h2>
            <p className="mt-2 text-xs text-app-text-muted">
              {parkedCustomerPrompt.rows.length === 1
                ? "There is one parked sale linked to this customer on this register."
                : `There are ${parkedCustomerPrompt.rows.length} parked sales for this customer on this register.`}{" "}
              Choose how to proceed.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                className="ui-btn-primary py-3 text-[10px] font-black uppercase tracking-widest"
                onClick={() => {
                  const id = parkedCustomerPrompt.rows[0]?.id;
                  setParkedCustomerPrompt(null);
                  if (id) void recallParkedSale(id);
                }}
              >
                Continue parked sale
              </button>
              <button
                type="button"
                className="ui-btn-secondary py-3 text-[10px] font-black uppercase tracking-widest"
                onClick={() => {
                  setParkedCustomerPrompt(null);
                  void (async () => {
                    await refreshParkedSales();
                    setParkedListOpen(true);
                  })();
                }}
              >
                Open parked list
              </button>
              <button
                type="button"
                className="ui-btn-secondary py-3 text-[10px] font-black uppercase tracking-widest"
                onClick={() => {
                  skippedParkedForCustomerRef.current.add(
                    `${sessionId}:${parkedCustomerPrompt.customerId}`,
                  );
                  setParkedCustomerPrompt(null);
                }}
              >
                Skip for now
              </button>
              <button
                type="button"
                className="rounded-xl border-2 border-red-200 bg-red-50 py-3 text-[10px] font-black uppercase tracking-widest text-red-700 transition-colors hover:bg-red-100"
                onClick={() => {
                  const prompt = parkedCustomerPrompt;
                  setParkedCustomerPrompt(null);
                  void (async () => {
                    const tok = await ensurePosTokenForSession();
                    if (!tok) {
                      toast(
                        "This device is missing the register session token. Open or join the register, then try again.",
                        "error",
                      );
                      return;
                    }
                    const actor = await resolveActorStaffId();
                    if (!actor) {
                      toast(
                        "Sign in to Back Office or verify cashier to delete parked sales.",
                        "error",
                      );
                      return;
                    }
                    try {
                      for (const r of prompt.rows) {
                        await deleteParkedSaleOnServer(
                          baseUrl,
                          sessionId,
                          r.id,
                          apiAuth,
                          actor,
                        );
                      }
                    } catch (e) {
                      toast(
                        e instanceof Error ? e.message : "Could not delete parked sales",
                        "error",
                      );
                      return;
                    }
                    setParkedCustomerPrompt(null);
                    await refreshParkedSales();
                    toast("Parked sales removed. Start a new sale.", "success");
                  })();
                }}
              >
                Delete parked and start new
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {cashAdjustOpen && (
        <RegisterCashAdjustModal
          sessionId={sessionId}
          getAuthHeaders={apiAuth}
          onClose={() => setCashAdjustOpen(false)}
          onRecorded={() => {}}
        />
      )}
      <RegisterGiftCardLoadModal
        open={giftCardLoadOpen}
        onClose={() => setGiftCardLoadOpen(false)}
        getHeaders={apiAuth}
        onAddToCart={(code, amountCents) => addGiftCardLoadToCart(code, amountCents)}
      />
      {measDrawerOpen && selectedCustomer ? (
        <PosCustomerMeasurementsDrawer
          open={measDrawerOpen}
          customerId={selectedCustomer.id}
          customerLabel={`${selectedCustomer.first_name} ${selectedCustomer.last_name}`.trim()}
          getAuthHeaders={apiAuth}
          onClose={() => setMeasDrawerOpen(false)}
        />
      ) : null}
      {selectedCustomer ? (
        <CustomerRelationshipHubDrawer
          customer={selectedCustomer}
          open={customerProfileHubOpen}
          onClose={() => setCustomerProfileHubOpen(false)}
          onOpenWeddingParty={() => {
            setCustomerProfileHubOpen(false);
            setWeddingDrawerPreferGroupPay(false);
            setWeddingDrawerOpen(true);
          }}
          onStartSale={(c) => {
            setSelectedCustomer(c);
            setCustomerProfileHubOpen(false);
          }}
          navigateAfterStartSale={false}
          baseUrl={baseUrl}
        />
      ) : null}
      <VariantSelectionModal
        product={activeVariationSelection}
        onClose={() => {
          setActiveVariationSelection(null);
          setVariantSwapCartRowId(null);
        }}
        onSelect={(v, priceOverride) => {
          const swapId = variantSwapCartRowId;
          if (swapId) {
            void (async () => {
              try {
                const res = await fetch(
                  `${baseUrl}/api/inventory/scan/${encodeURIComponent(v.sku)}`,
                  { headers: apiAuth() },
                );
                if (!res.ok) {
                  toast("Could not resolve that SKU.", "error");
                  return;
                }
                const r = (await res.json()) as Record<string, unknown>;
                const item = scanPayloadToResolvedItem(r);
                setLines((prev) =>
                  prev.map((l) => {
                    if (l.cart_row_id !== swapId) return l;
                    const next: CartLineItem = {
                      ...item,
                      quantity: l.quantity,
                      fulfillment: l.fulfillment,
                      cart_row_id: l.cart_row_id,
                      salesperson_id: l.salesperson_id,
                      custom_item_type: l.custom_item_type,
                      is_rush: l.is_rush,
                      need_by_date: l.need_by_date,
                      needs_gift_wrap: l.needs_gift_wrap,
                    };
                    if (priceOverride) {
                      next.standard_retail_price = priceOverride;
                      next.original_unit_price = String(item.standard_retail_price);
                      next.price_override_reason = "pos_manual_price";
                    } else {
                      next.price_override_reason = undefined;
                      next.original_unit_price = undefined;
                    }
                    next.discount_event_id = undefined;
                    return next;
                  }),
                );
                setSelectedLineKey(swapId);
                toast("Variant updated", "success");
              } catch {
                toast("Could not update variant.", "error");
              } finally {
                setVariantSwapCartRowId(null);
                setActiveVariationSelection(null);
              }
            })();
            return;
          }
          const original = searchResults.find((r) => r.variant_id === v.variant_id);
          if (original) addItem(original, priceOverride);
          setActiveVariationSelection(null);
        }}
      />
      <ConfirmationModal
        isOpen={showWalkinConfirm}
        onClose={() => setShowWalkinConfirm(false)}
        onConfirm={() => {
          setShowWalkinConfirm(false);
          setCheckoutDrawerOpen(true);
        }}
        title="Checkout as Walk-in?"
        message="No customer is assigned to this sale. Confirming as a walk-in will skip loyalty points and wedding tracking."
        confirmLabel="Confirm Walk-in"
        variant="info"
      />

      <ConfirmationModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={() => {
          clearCart();
          setShowClearConfirm(false);
          toast("Cart cleared", "info");
        }}
        title="Clear Active Sale?"
        message="Are you sure you want to completely clear this transaction? All items and customer data will be removed."
        confirmLabel="Yes, Clear Sale"
        variant="danger"
      />

      <PromptModal
        isOpen={showVoidAllConfirm}
        onClose={() => setShowVoidAllConfirm(false)}
        title="Authorize void all"
        message="Clearing every line in the cart requires a manager PIN."
        placeholder="Enter manager PIN…"
        type="text"
        confirmLabel="Confirm void"
        onSubmit={async (pin) => {
          try {
            const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin, role: "Admin" }),
            });
            if (res.ok) {
              setLines([]);
              setSelectedLineKey(null);
              toast("Sale voided by manager", "success");
              return;
            }
            toast("Invalid manager PIN", "error");
            return false;
          } catch {
            toast("Authorization failed", "error");
            return false;
          }
        }}
      />

      <PosExchangeWizard
        open={exchangeWizardOpen}
        onClose={() => setExchangeWizardOpen(false)}
        sessionId={sessionId}
        baseUrl={baseUrl}
        apiAuth={() => ({ ...apiAuth() })}
        onContinueToReplacement={onExchangeContinue}
      />

      <PosSuitSwapWizard
        open={suitSwapWizardOpen}
        onClose={() => setSuitSwapWizardOpen(false)}
        sessionId={sessionId}
        baseUrl={baseUrl}
        apiAuth={() => ({ ...apiAuth() })}
      />

      <WeddingLookupDrawer 
        isOpen={weddingDrawerOpen}
        onClose={() => {
          setWeddingDrawerOpen(false);
          setWeddingDrawerPreferGroupPay(false);
        }}
        preferGroupPay={weddingDrawerPreferGroupPay}
        onPreferGroupPayConsumed={() => setWeddingDrawerPreferGroupPay(false)}
        onLinkMember={async (m, partyName) => {
          if (isRmsPaymentCart) {
            toast(
              "Remove the RMS CHARGE PAYMENT line before linking a wedding party.",
              "error",
            );
            return;
          }
          setActiveWeddingMember(m);
          setActiveWeddingPartyName(partyName);
          setWeddingDrawerOpen(false);
          toast(`Linked ${m.first_name} ${m.last_name}`, "success");
          
          try {
            const res = await fetch(`${baseUrl}/api/customers/${m.customer_id}`, {
              headers: { ...apiAuth() },
            });
            if (res.ok) {
              const c = await res.json();
              setSelectedCustomer(c);
            }
          } catch (e) {
            console.warn("Could not auto-select customer for wedding member", e);
          }

          // --- Auto-add Linked Suit to Cart (Manual Link) ---
          if (m.suit_variant_id) {
            try {
              const res = await fetch(`${baseUrl}/api/products/variants/${m.suit_variant_id}`, {
                headers: { ...apiAuth() },
              });
              if (res.ok) {
                const v = await res.json();
                const isFree = Boolean(m.is_free_suit_promo);
                const newItem = {
                  ...v,
                  quantity: 1,
                  fulfillment: "wedding_order",
                  cart_row_id: newCartRowId(),
                  ...(isFree ? {
                    standard_retail_price: 0,
                    original_unit_price: String(v.standard_retail_price),
                    price_override_reason: "Wedding Promo (Free Suit Selection)"
                  } : {})
                };
                setLines(prev => {
                  if (prev.some(l => l.variant_id === v.variant_id)) return prev;
                  return [...prev, newItem];
                });
                if (isFree) {
                  toast(`Free Suit applied for ${m.first_name} (Promo)`, "success");
                }
                toast(`Linked suit added to cart: ${v.name}`, "success");
              }
            } catch (err) {
              console.error("Failed to auto-add linked suit", err);
            }
          }
        }}
        onGroupPay={(members, partyName) => {
          if (isRmsPaymentCart) {
            toast(
              "Remove the RMS CHARGE PAYMENT line before group pay.",
              "error",
            );
            return;
          }
          setDisbursementMembers(members);
          setActiveWeddingPartyName(partyName);
          setWeddingDrawerOpen(false);
          toast(`Added ${members.length} members for payout`, "success");
        }}
      />

      <PromptModal
        isOpen={!!discountPrompt}
        onClose={() => setDiscountPrompt(null)}
        title="Override Authority"
        message={`Large discounts (>${roleMaxDiscountPct.toFixed(0)}%) require Manager PIN authorization for audit logging.`}
        placeholder="Enter Manager PIN..."
        type="text"
        confirmLabel="Authorize"
        onSubmit={async (pin) => {
          if (!discountPrompt) return false;
          try {
            const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin, role: "Admin" }),
            });
            if (res.ok) {
              setLines((prev) =>
                prev.map((l) =>
                  l.variant_id === discountPrompt.variantId
                    ? {
                        ...l,
                        standard_retail_price: centsToFixed2(
                          discountPrompt.nextPriceCents,
                        ),
                        original_unit_price: centsToFixed2(
                          discountPrompt.originalPriceCents,
                        ),
                        price_override_reason: `Manager authorized over ${roleMaxDiscountPct.toFixed(0)}%`,
                      }
                    : l,
                ),
              );
              toast("Override authorized", "success");
              return;
            }
            toast("Invalid Manager PIN", "error");
            return false;
          } catch {
            toast("Authorization failed", "error");
            return false;
          }
        }}
      />

      {intelligenceVariantId && (
        <ProductIntelligenceDrawer
          variantId={intelligenceVariantId}
          onClose={() => setIntelligenceVariantId(null)}
          onAddToSale={async (sku, priceOverride) => {
            let item: SearchResult | undefined = searchResults.find(
              (r) => r.sku === sku,
            );
            if (!item) {
              try {
                const res = await fetch(
                  `${baseUrl}/api/inventory/scan/${encodeURIComponent(sku)}`,
                  { headers: apiAuth() },
                );
                if (!res.ok) {
                  toast("Could not add item — try search or scan.", "error");
                  return;
                }
                const r = (await res.json()) as Record<string, unknown>;
                item = scanPayloadToResolvedItem(r) as SearchResult;
              } catch {
                toast("Could not add item.", "error");
                return;
              }
            }
            addItem(item, priceOverride);
          }}
        />
      )}

      <CustomItemPromptModal
        isOpen={customPromptOpen}
        onClose={() => {
          setCustomPromptOpen(false);
          setPendingCustomItem(null);
        }}
        onConfirm={(data) => {
          if (!pendingCustomItem) return;
          const updated = {
            ...pendingCustomItem,
            name: `${data.itemType} (CUSTOM)`,
            standard_retail_price: data.price,
            custom_item_type: data.itemType,
            is_rush: data.isRush,
            need_by_date: data.needByDate,
            needs_gift_wrap: data.needsGiftWrap,
          };
          setCustomPromptOpen(false);
          setPendingCustomItem(null);
          addItem(updated);
        }}
      />

      {lastOrderId && (
        <ReceiptSummaryModal
          orderId={lastOrderId}
          onClose={() => {
            setLastOrderId(null);
            setCheckoutOperator(null);
            onSaleCompleted?.();
          }}
          baseUrl={baseUrl}
          registerSessionId={sessionId}
          getAuthHeaders={apiAuth}
        />
      )}

      <PosSaleCashierSignInOverlay
        open={saleHydrated && !checkoutOperator}
        credential={saleCashierCredential}
        onCredentialChange={(v) => {
          setSaleCashierCredential(v);
          setSaleCashierError(null);
        }}
        error={saleCashierError}
        busy={saleCashierBusy}
        onVerify={() => void verifySaleCashier()}
      />
    </div>
  );
}

// --- Inner Components ---

interface CartItemRowProps {
  line: CartLineItem;
  orderLaterFulfillment: FulfillmentKind;
  selectedLineKey: string | null;
  setSelectedLineKey: (key: string | null) => void;
  keypadMode: "qty" | "price";
  setKeypadMode: (mode: "qty" | "price") => void;
  setKeypadBuffer: (v: string) => void;
  updateLineFulfillment: (rowId: string, next: FulfillmentKind) => void;
  updateLineSalesperson: (rowId: string, salespersonId: string) => void;
  removeLine: (rowId: string) => void;
  onLineProductTitleClick: (line: CartLineItem) => void;
  orderSalespersonLabel: string;
  hideLineSalesperson?: boolean;
  updateLineGiftWrapStatus: (rowId: string, status: boolean) => void;
  commissionStaff: PosStaffRow[];
}

function CartItemRow({
  line,
  orderLaterFulfillment,
  selectedLineKey,
  setSelectedLineKey,
  keypadMode,
  setKeypadMode,
  setKeypadBuffer,
  updateLineFulfillment,
  updateLineSalesperson,
  removeLine,
  onLineProductTitleClick,
  commissionStaff,
  orderSalespersonLabel,
  hideLineSalesperson = false,
  updateLineGiftWrapStatus,
}: CartItemRowProps) {
  const lk = cartLineKey(line);
  const isSelected = selectedLineKey === lk;
  const regCents = parseMoneyToCents(
    line.original_unit_price ?? line.standard_retail_price,
  );
  const saleCents = parseMoneyToCents(line.standard_retail_price);
  const showRegSale =
    line.original_unit_price != null && regCents > saleCents;
  const offPct =
    showRegSale && regCents > 0
      ? Math.round((1 - saleCents / regCents) * 100)
      : 0;

  const laterLabel =
    orderLaterFulfillment === "wedding_order"
      ? "Wedding order"
      : "Order";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setSelectedLineKey(lk)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setSelectedLineKey(lk);
        }
      }}
      className={`relative flex cursor-pointer items-stretch gap-2 rounded-xl border-2 p-2 transition-all ${
        isSelected
          ? "border-app-accent bg-app-accent/[0.06] shadow-md shadow-app-accent/10 ring-2 ring-app-accent/25"
          : "border-app-border bg-app-surface hover:bg-app-surface-2"
      }`}
    >
      {isSelected ? (
        <div className="absolute bottom-1.5 start-0 top-1.5 w-1 rounded-full bg-app-accent" />
      ) : null}

      {/* Inline start: product info */}
      <div className="min-w-0 flex-1 ps-2">
        {/* Title row */}
        <div className="flex items-center justify-between gap-1">
          <button
            type="button"
            className="group/name min-w-0 flex-1 text-start"
            onClick={(e) => {
              e.stopPropagation();
              onLineProductTitleClick(line);
            }}
          >
            <div className="flex items-center gap-1">
              <h4 className="truncate text-sm font-black uppercase italic leading-tight tracking-tighter text-app-text group-hover/name:text-app-accent">
                {line.name}
              </h4>
              <Info size={12} className="shrink-0 text-app-text-muted opacity-0 transition-opacity group-hover/name:opacity-100" aria-hidden />
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeLine(line.cart_row_id); }}
            className="shrink-0 rounded-lg p-1.5 text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-600"
            aria-label="Remove line"
          >
            <Trash2 size={17} strokeWidth={2.25} />
          </button>
        </div>

        {/* SKU / variation / salesperson row */}
        <div
          className="mt-1 flex flex-wrap items-center gap-1.5"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-xs font-black uppercase tracking-wide text-app-text">
            {line.sku}
          </span>
          {line.gift_card_load_code ? (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs font-black text-emerald-900 dark:text-emerald-200">
              #{line.gift_card_load_code}
            </span>
          ) : null}
          {line.variation_label ? (
            <span className="rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-xs font-black uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
              {line.variation_label}
            </span>
          ) : null}
          {!hideLineSalesperson ? (
            <label className="flex min-w-0 items-center gap-1">
              <span className="sr-only">Line salesperson</span>
              <span className="shrink-0 text-[9px] font-black uppercase tracking-widest text-app-text-muted">Line</span>
              <select
                className="ui-input max-w-[9rem] cursor-pointer py-1 text-[10px] font-bold"
                value={line.salesperson_id ?? ""}
                onChange={(e) => updateLineSalesperson(line.cart_row_id, e.target.value)}
              >
                <option value="">
                  Same as sale{orderSalespersonLabel ? ` (${orderSalespersonLabel})` : ""}
                </option>
                {commissionStaff.map((s) => (
                  <option key={s.id} value={s.id}>{s.full_name}</option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>

      {/* Inline end: fulfillment + qty/price buttons */}
      <div
        className="flex shrink-0 flex-col gap-1.5"
        style={{ minWidth: "8.5rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Take now / Order later toggle */}
        <div className="flex rounded-lg border-2 border-app-border bg-app-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => updateLineFulfillment(line.cart_row_id, "takeaway")}
            className={`min-h-[32px] flex-1 rounded-md px-1.5 py-1 text-[9px] font-black uppercase tracking-wide transition-all ${
              line.fulfillment === "takeaway"
                ? "bg-zinc-900 text-white shadow-sm dark:bg-white dark:text-zinc-900"
                : "bg-transparent text-app-text"
            }`}
          >
            Take now
          </button>
          <button
            type="button"
            onClick={() => updateLineFulfillment(line.cart_row_id, orderLaterFulfillment)}
            className={`min-h-[32px] flex-1 rounded-md px-1.5 py-1 text-[9px] font-black uppercase tracking-wide transition-all ${
              line.fulfillment === orderLaterFulfillment
                ? "bg-amber-500 text-white shadow-sm"
                : "bg-transparent text-app-text"
            }`}
          >
            {laterLabel}
          </button>
        </div>

        {/* Gift Wrap Toggle */}
        <button
          type="button"
          onClick={() => updateLineGiftWrapStatus(line.cart_row_id, !line.needs_gift_wrap)}
          className={`group flex items-center justify-between rounded-lg border-2 px-2 py-1.5 transition-all active:scale-[0.97] ${
            line.needs_gift_wrap
              ? "border-emerald-500 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : "border-app-border bg-app-surface text-app-text-muted hover:border-app-accent/30 hover:bg-app-accent/5 hover:text-app-text"
          }`}
        >
          <div className="flex items-center gap-1.5 overflow-hidden">
            <Gift
              size={13}
              className={`shrink-0 transition-transform ${
                line.needs_gift_wrap ? "scale-110" : "opacity-60 group-hover:scale-110 group-hover:opacity-100"
              }`}
            />
            <span className="truncate text-[9px] font-black uppercase tracking-widest">
              Gift Wrap
            </span>
          </div>
          <div
            className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
              line.needs_gift_wrap ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-zinc-300 dark:bg-zinc-700"
            }`}
          />
        </button>

        {/* Qty / Price tap targets */}
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => {
              setSelectedLineKey(lk);
              setKeypadMode("qty");
              setKeypadBuffer("");
            }}
            className={`flex min-h-[40px] w-12 flex-col items-center justify-center rounded-lg border-2 px-1 transition-all ${
              keypadMode === "qty" && isSelected
                ? "border-app-accent bg-app-accent text-white shadow-md"
                : "border-app-border bg-app-surface-2 text-app-text"
            }`}
          >
            <span className={`text-[9px] font-black uppercase tracking-widest ${keypadMode === "qty" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
              Qty
            </span>
            <span className="text-base font-black tabular-nums leading-none">
              {line.quantity}
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedLineKey(lk);
              setKeypadMode("price");
              setKeypadBuffer("");
            }}
            className={`flex min-h-[40px] flex-1 flex-col items-end justify-center rounded-lg border-2 px-2 text-right transition-all ${
              keypadMode === "price" && isSelected
                ? "border-app-accent bg-app-accent text-white shadow-md"
                : "border-app-border bg-app-surface-2 text-app-text"
            }`}
          >
            <span className={`text-[9px] font-black uppercase tracking-widest ${keypadMode === "price" && isSelected ? "text-white/80" : "text-app-text-muted"}`}>
              Sale
            </span>
            {showRegSale ? (
              <div className="flex flex-col items-end leading-tight">
                <span className={`text-[10px] font-bold tabular-nums line-through ${keypadMode === "price" && isSelected ? "text-white/70" : "text-app-text-muted"}`}>
                  ${centsToFixed2(regCents)}
                </span>
                <span className="text-sm font-black tabular-nums">
                  ${centsToFixed2(saleCents)}
                </span>
                {offPct > 0 ? (
                  <span className={`text-[9px] font-black ${keypadMode === "price" && isSelected ? "text-white/90" : "text-emerald-600 dark:text-emerald-400"}`}>
                    −{offPct}%
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="text-sm font-black tabular-nums">
                ${centsToFixed2(saleCents)}
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
