import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useScanner } from "../../hooks/useScanner";
import {
  Search,
  RotateCcw,
  Users,
  X,
  ArrowLeftRight,
  Truck,
  UserCircle,
  CreditCard,
  Clock,
  Zap,
  Package,
  History,
} from "lucide-react";
import CustomerSelector, { type Customer } from "./CustomerSelector";
import NexoCheckoutDrawer from "./NexoCheckoutDrawer";
import RegisterCashAdjustModal from "./RegisterCashAdjustModal";
import RegisterGiftCardLoadModal from "./RegisterGiftCardLoadModal";
import PosCustomerMeasurementsDrawer from "./PosCustomerMeasurementsDrawer";
import ReceiptSummaryModal from "./ReceiptSummaryModal";
import VariantSelectionModal, { type ProductWithVariants } from "./VariantSelectionModal";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import {
  centsToFixed2,
  parseMoneyToCents,
} from "../../lib/money";
import {
  getPosRegisterAuth,
  hydratePosRegisterAuthIfNeeded,
  mergedPosStaffHeaders,
} from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import ProductIntelligenceDrawer from "./ProductIntelligenceDrawer";
import PosSaleCashierSignInOverlay from "./PosSaleCashierSignInOverlay";
import { CustomerRelationshipHubDrawer } from "../customers/CustomerRelationshipHubDrawer";
import PosExchangeWizard from "./PosExchangeWizard";
import PosSuitSwapWizard from "./PosSuitSwapWizard";
import WeddingLookupDrawer, { type WeddingMember } from "./WeddingLookupDrawer";
import PosShippingModal, {
  type PosShippingSelection,
} from "./PosShippingModal";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import { newCartRowId, scanPayloadToResolvedItem } from "../../lib/posUtils";
import CustomItemPromptModal from "./CustomItemPromptModal";
import OrderLoadModal, { type OrderItem } from "./OrderLoadModal";
import OrderReviewModal from "./OrderReviewModal";
import ManagerApprovalModal from "./ManagerApprovalModal";

export type { CheckoutPayload } from "./types";

// --- POS Modularization ---
import { 
  type ResolvedSkuItem, 
  type CartLineItem, 
  type FulfillmentKind, 
  type PosStaffRow,
  type ActiveDiscountEvent,
  type RmsPaymentLineMeta,
  type GiftCardLoadLineMeta,
  type AppliedPaymentLine,
  type CheckoutOperatorContext,
  type PosOrderOptions
} from "./types";
import { PosRegisterLiveClock } from "./cart/PosRegisterLiveClock";
import { PosSearchResultList, type SearchResult } from "./cart/PosSearchResultList";
import { useCartPersistence } from "../../hooks/useCartPersistence";
import { usePosSearch } from "../../hooks/usePosSearch";
import { useCartActions } from "../../hooks/useCartActions";
import { calculateNysErieTaxStringsForUnit } from "../../lib/tax";
import { useCartCheckout } from "../../hooks/useCartCheckout";
import { useParkedSales } from "../../hooks/useParkedSales";
import { deleteParkedSaleOnServer } from "../../lib/posParkedSales";
import StaffMiniSelector from "../ui/StaffMiniSelector";
import { CartItemRow } from "./cart/CartItemRow";

interface OpenDepositPrompt {
  cents: number;
  payerName: string | null;
  customerId: string;
}

interface CartProps {
  sessionId: string;
  cashierName?: string | null;
  cashierCode?: string | null;
  initialCustomer?: Customer | null;
  onInitialCustomerConsumed?: () => void;
  initialOrderId?: string | null;
  onInitialOrderConsumed?: () => void;
  initialWeddingLookupOpen?: boolean;
  managerMode?: boolean;
  /** From Wedding Manager: pre-link customer + wedding member for wedding_order checkout. */
  initialWeddingPosLink?: RosOpenRegisterFromWmDetail | null;
  onInitialWeddingPosLinkConsumed?: () => void;
  /** After checkout succeeds (cart cleared); e.g. switch POS shell back to Register for next sale sign-in. */
  onSaleCompleted?: () => void;
  onExitPosMode?: () => void;
  pendingInventorySku?: string | null;
  onPendingInventorySkuConsumed?: () => void;
  /** IANA zone from open register session — live clock only; receipt uses server time at checkout. */
  receiptTimezone?: string;
}

// Helpers relocated to posUtils.ts or hooks

// --- Component ---
export default function Cart({
  sessionId,
  cashierName = null,
  initialCustomer = null,
  onInitialCustomerConsumed,
  initialOrderId = null,
  onInitialOrderConsumed,
  managerMode = false,
  // initialWeddingLookupOpen removed
  initialWeddingPosLink = null,
  onInitialWeddingPosLinkConsumed,
  onSaleCompleted,
  onExitPosMode,
  receiptTimezone: receiptTimezoneProp,
}: CartProps) {
  const receiptTimezone =
    typeof receiptTimezoneProp === "string" && receiptTimezoneProp.trim()
      ? receiptTimezoneProp.trim()
      : "America/New_York";
  const { toast } = useToast();
  const { 
    backofficeHeaders, 
    staffRole,
    staffPin,
    staffCode,
    employeeCustomerId
  } = useBackofficeAuth();

  const hasAccess = staffRole === "admin";
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  // --- External States (managed by hooks) ---
  const [rmsPaymentMeta, setRmsPaymentMeta] = useState<RmsPaymentLineMeta | null>(null);
  const [giftCardLoadMeta, setGiftCardLoadMeta] = useState<GiftCardLoadLineMeta | null>(null);
  const [primarySalespersonId, setPrimarySalespersonId] = useState("");
  const [checkoutOperator, setCheckoutOperator] = useState<CheckoutOperatorContext | null>(null);
  const [posShipping, setPosShipping] = useState<PosShippingSelection | null>(null);
  const [checkoutAppliedPayments, setCheckoutAppliedPayments] = useState<AppliedPaymentLine[]>([]);
  const [checkoutDepositLedger, setCheckoutDepositLedger] = useState("");
  const [pickupConfirmed, setPickupConfirmed] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [activeWeddingMember, setActiveWeddingMember] = useState<WeddingMember | null>(null);
  const [activeWeddingPartyName, setActiveWeddingPartyName] = useState<string | null>(null);
  const [disbursementMembers, setDisbursementMembers] = useState<WeddingMember[]>([]);

  const [roleMaxDiscountPct, setRoleMaxDiscountPct] = useState(30);
  const [salePinCredential, setSalePinCredential] = useState("");
  const [salePinError, setSalePinError] = useState<string | null>(null);
  const [lastTransactionId, setLastTransactionId] = useState<string | null>(null);

  // --- UI States (Restored to Cart.tsx) ---
  const [checkoutDrawerOpen, setCheckoutDrawerOpen] = useState(false);
  const [weddingDrawerOpen, setWeddingDrawerOpen] = useState(false);
  const [weddingDrawerPreferGroupPay, setWeddingDrawerPreferGroupPay] = useState(false);
  const [measDrawerOpen, setMeasDrawerOpen] = useState(false);
  const [orderLoadOpen, setOrderLoadOpen] = useState(false);
  const [orderReviewOpen, setOrderReviewOpen] = useState(false);
  const [customerProfileHubOpen, setCustomerProfileHubOpen] = useState(false);
  const [checkoutOrderOptions, setCheckoutOrderOptions] = useState<PosOrderOptions | null>(null);
  const [cashAdjustOpen, setCashAdjustOpen] = useState(false);
  const [suitSwapWizardOpen, setSuitSwapWizardOpen] = useState(false);
  const [openDepositPrompt, setOpenDepositPrompt] = useState<OpenDepositPrompt | null>(null);
  const [intelligenceVariantId, setIntelligenceVariantId] = useState<string | null>(null);
  const openDepositSuppressedRef = useRef(false);

  const [activeDiscountEvents, setActiveDiscountEvents] = useState<ActiveDiscountEvent[]>([]);
  const [selectedDiscountEventId, setSelectedDiscountEventId] = useState("");

  useEffect(() => {
    fetch(`${baseUrl}/api/discount-events/active`, { headers: apiAuth() as Record<string, string> })
      .then(r => r.json())
      .then(data => setActiveDiscountEvents(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [baseUrl, apiAuth]);

  // --- Search Hook ---
  const {
    search,
    setSearch,
    searchResults,
    setSearchResults,
    groupedSearchResults,
    runSearch,
  } = usePosSearch({
    baseUrl,
    apiAuth,
    rmsPaymentMeta,
    setRmsPaymentMeta,
    toast,
  });

  // --- Cart Actions Hook ---
  const [customPromptOpen, setCustomPromptOpen] = useState(false);
  const [pendingCustomItem, setPendingCustomItem] = useState<ResolvedSkuItem | null>(null);
  const [giftCardLoadOpen, setGiftCardLoadOpen] = useState(false);

  const {
    lines,
    setLines,
    selectedLineKey,
    setSelectedLineKey,
    addItem,
    addGiftCardLoadToCart,
    removeLine,
    updateLineFulfillment,
    updateLineSalesperson,
    updateLineGiftWrapStatus,
    handleNumpadKey: hookHandleNumpadKey,
    applyDiscountEvent: hookApplyDiscountEvent,
    ensureSaleCashier,
    keypadMode,
    setKeypadMode,
    keypadBuffer,
    setKeypadBuffer,
    handleLaserScan,
    handleSearchResultClick,
    onExchangeContinue,
    clearCart,
  } = useCartActions({
    checkoutOperator,
    rmsPaymentMeta,
    giftCardLoadMeta,
    activeWeddingMember,
    employeeCustomerId,
    selectedCustomer,
    setSelectedCustomer,
    toast,
    setSearch,
    setSearchResults,
    setActiveWeddingMember,
    setActiveWeddingPartyName,
    setDisbursementMembers,
    setPendingCustomItem,
    setCustomPromptOpen,
    setGiftCardLoadOpen,
    setPrimarySalespersonId,
    setCheckoutAppliedPayments,
    setCheckoutDepositLedger,
    setPosShipping,
    setPickupConfirmed,
    baseUrl,
    apiAuth,
  });

  const handleNumpadKey = useCallback((key: string) => {
    if (key === "ENTER" && keypadMode === "price" && selectedLineKey) {
      const line = lines.find(l => l.cart_row_id === selectedLineKey);
      if (line) {
        const nextAmtCents = parseMoneyToCents(keypadBuffer);
        const originalAmtCents = parseMoneyToCents(line.original_unit_price || line.standard_retail_price);
        
        if (nextAmtCents < originalAmtCents) {
          const discountPct = ((originalAmtCents - nextAmtCents) / originalAmtCents) * 100;
          if (discountPct > roleMaxDiscountPct && !hasAccess) {
             setDiscountPrompt({
               variantId: line.variant_id ?? "",
               nextPriceCents: nextAmtCents,
               originalPriceCents: originalAmtCents,
               reason: "Large discount threshold exceeded"
             });
             setKeypadBuffer("");
             return;
          }
        }
      }
    }
    hookHandleNumpadKey(key);
  }, [keypadMode, selectedLineKey, lines, keypadBuffer, roleMaxDiscountPct, hasAccess, hookHandleNumpadKey, setKeypadBuffer]);

  const applyDiscountEvent = useCallback((event: ActiveDiscountEvent) => {
    if (!selectedLineKey) return;
    const pct = parseFloat(event.percent_off);
    if (pct > roleMaxDiscountPct && !hasAccess) {
      const line = lines.find(l => l.cart_row_id === selectedLineKey);
      if (line) {
        const baseCents = parseMoneyToCents(line.original_unit_price || line.standard_retail_price);
        const nextCents = Math.round(baseCents * (1 - pct / 100));
        setDiscountPrompt({
          variantId: line.variant_id ?? "",
          nextPriceCents: nextCents,
          originalPriceCents: baseCents,
          reason: `Discount Event: ${event.receipt_label}`
        });
        return;
      }
    }
    hookApplyDiscountEvent(event);
  }, [selectedLineKey, roleMaxDiscountPct, hasAccess, lines, hookApplyDiscountEvent]);

  const openLineProductBrowser = useCallback((line: CartLineItem) => {
    setIntelligenceVariantId(line.variant_id);
  }, []);

  const applyDiscountEventToSelectedLine = useCallback(() => {
    const event = activeDiscountEvents.find((e) => e.id === selectedDiscountEventId);
    if (event) {
      applyDiscountEvent(event);
      setSelectedDiscountEventId("");
    }
  }, [activeDiscountEvents, selectedDiscountEventId, applyDiscountEvent]);

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
      totalCents: collectTotalCents,
    };
  }, [lines, disbursementMembers, posShipping]);

  const isRmsPaymentCart = useMemo(() => lines.some(l => rmsPaymentMeta && l.sku === rmsPaymentMeta.sku), [lines, rmsPaymentMeta]);
  const isGiftCardOnlyCart = useMemo(() => lines.length > 0 && lines.every(l => !!l.gift_card_load_code), [lines]);

  const ensurePosTokenForSession = useCallback(async () => {
    const success = await hydratePosRegisterAuthIfNeeded({
      baseUrl,
      sessionId,
      authHeaders: apiAuth(),
      openerCashierCode: staffCode || undefined,
      openerPin: staffPin || undefined
    });
    if (!success) return null;
    return getPosRegisterAuth()?.token ?? null;
  }, [baseUrl, sessionId, apiAuth, staffCode, staffPin]);

  const resolveActorStaffId = useCallback(async () => {
    return (backofficeHeaders() as Record<string, string>)["x-riverside-staff-id"] || null;
  }, [backofficeHeaders]);

  // --- Checkout Hook ---
  const { 
    executeCheckout, 
    checkoutBusy, 
    lastTransactionId: checkoutTransactionId 
  } = useCartCheckout({
    sessionId,
    baseUrl,
    apiAuth,
    lines,
    selectedCustomer,
    activeWeddingMember,
    cashierName,
    primarySalespersonId,
    disbursementMembers,
    posShipping,
    pickupConfirmed,
    totals,
    toast,
    clearCart,
    onSaleCompleted,
    ensurePosTokenForSession,
  });
  useEffect(() => {
    if (checkoutTransactionId) {
      setLastTransactionId(checkoutTransactionId);
      setCheckoutDrawerOpen(false);
    }
  }, [checkoutTransactionId]);

  // --- Parked Sales Hook ---
  const {
    parkedRows,
    parkedListOpen,
    setParkedListOpen,
    parkedCustomerPrompt,
    setParkedCustomerPrompt,
    refreshParkedSales,
    recallParkedSale,
    parkSale,
    deleteParkedSale,
    primaryDefaultedRef,
    skippedParkedForCustomerRef,
  } = useParkedSales({
    sessionId,
    baseUrl,
    apiAuth,
    selectedCustomer,
    lines,
    toast,
    ensurePosTokenForSession,
    resolveActorStaffId,
    setLines,
    setSelectedCustomer,
    setActiveWeddingMember,
    setActiveWeddingPartyName,
    setDisbursementMembers,
    setPrimarySalespersonId,
    primarySalespersonId,
    clearCart,
    activeWeddingMember,
    activeWeddingPartyName,
    disbursementMembers,
  });

  // --- Persistence Hook ---
  const { saleHydrated } = useCartPersistence({
    sessionId,
    lines,
    selectedCustomer,
    activeWeddingMember,
    activeWeddingPartyName,
    posShipping,
    primarySalespersonId,
    checkoutOperator,
    setLines,
    setSelectedCustomer,
    setActiveWeddingMember,
    setActiveWeddingPartyName,
    setPosShipping,
    setPrimarySalespersonId,
    setCheckoutOperator,
    clearCart,
  });


  // pendingExchangeOriginalOrderIdRef removed
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didInitialProductSearchFocusRef = useRef(false);
  const [exchangeWizardOpen, setExchangeWizardOpen] = useState(false);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);
  
  // --- Staff PIN Verification Logic ---
  const [salePinBusy, setSalePinBusy] = useState(false);

  const verifySalePin = useCallback(async () => {
    if (!salePinCredential) {
      setSalePinError("Please enter PIN");
      return;
    }
    setSalePinBusy(true);
    setSalePinError(null);
    try {
      const selectedStaffId = localStorage.getItem("ros_last_staff_id");
      const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ 
          pin: salePinCredential,
          staff_id: selectedStaffId || undefined
        }),
      });
      if (res.ok) {
        const staff = await res.json();
        setCheckoutOperator({ staffId: staff.staff_id, fullName: staff.full_name });
        setSalePinCredential("");
        toast(`Signed in as ${staff.full_name}`, "success");
      } else {
        const errJson = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setSalePinError("Authentication service endpoint not found (404). Contact support.");
        } else if (res.status === 401 || res.status === 403) {
          setSalePinError(errJson.error ?? "Invalid PIN.");
        } else {
          setSalePinError(errJson.error ?? `Server error (${res.status}).`);
        }
      }
    } catch {
      setSalePinError("Auth server unreachable.");
    } finally {
      setSalePinBusy(false);
    }
  }, [salePinCredential, baseUrl, apiAuth, toast]);
  // eventVariantIds removed
  const [showWalkinConfirm, setShowWalkinConfirm] = useState(false);
  const [activeVariationSelection, setActiveVariationSelection] = useState<ProductWithVariants | null>(null);
  const [variantSwapCartRowId, setVariantSwapCartRowId] = useState<string | null>(null);
  
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showVoidAllConfirm, setShowVoidAllConfirm] = useState(false);
  const [discountPrompt, setDiscountPrompt] = useState<{
    variantId: string;
    nextPriceCents: number;
    originalPriceCents: number;
    reason: string;
  } | null>(null);
  // roleMaxDiscountPct moved up

  const [posStaffList, setPosStaffList] = useState<PosStaffRow[]>([]);


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

  // --- Initialization & Data Sync ---
  useEffect(() => {
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/pos/rms-payment-line-meta`, { headers: h });
        if (!res.ok || cancelled) return;
        setRmsPaymentMeta(await res.json() as RmsPaymentLineMeta);
      } catch { /* optional */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, apiAuth]);

  useEffect(() => {
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/pos/gift-card-load-line-meta`, { headers: h });
        if (!res.ok || cancelled) return;
        setGiftCardLoadMeta(await res.json() as GiftCardLoadLineMeta);
      } catch { /* optional */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, apiAuth]);

  useEffect(() => {
    if (!saleHydrated) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/self/pricing-limits`, { headers: h });
        if (!res.ok || cancelled) return;
        const j = await res.json() as { max_discount_percent?: string };
        const n = Number.parseFloat(j.max_discount_percent ?? "30");
        if (Number.isFinite(n)) setRoleMaxDiscountPct(n);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [baseUrl, apiAuth, saleHydrated]);

  useEffect(() => {
    if (!saleHydrated) return;
    let cancelled = false;
    const h = apiAuth();
    if (!h["x-riverside-pos-session-token"] && !h["x-riverside-staff-pin"]) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, { headers: h });
        if (!res.ok || cancelled) return;
        const sl = await res.json() as PosStaffRow[];
        if (!cancelled) setPosStaffList(sl);
      } catch { if (!cancelled) setPosStaffList([]); }
    })();
    return () => { cancelled = true; };
  }, [saleHydrated, baseUrl, apiAuth]);

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
  }, [activeWeddingMember, setLines]);

  useEffect(() => {
    if (!initialCustomer) return;
    setSelectedCustomer(initialCustomer);
    onInitialCustomerConsumed?.();
  }, [initialCustomer, onInitialCustomerConsumed, setSelectedCustomer]);

  useEffect(() => {
    if (!initialOrderId) return;
    onInitialOrderConsumed?.();
  }, [initialOrderId, onInitialOrderConsumed]);

  useEffect(() => {
    if (!initialWeddingPosLink?.member?.customer_id) return;
    const link = initialWeddingPosLink;
    const wm = link.member;
    const partyName = link.partyName?.trim() || "Wedding party";

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
        }
      } catch {
        /* best effort */
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
            if (isFree) toast(`Free Suit applied for ${wm.first_name}`, "success");
          }
        } catch {
          /* best effort */
        }
      }

      onInitialWeddingPosLinkConsumed?.();
    };

    void run();
  }, [initialWeddingPosLink, baseUrl, onInitialWeddingPosLinkConsumed, apiAuth, toast, setLines, setSelectedCustomer, setActiveWeddingMember, setActiveWeddingPartyName]);

  // --- Search Coordination ---
  const onSearchResultClick = (item: SearchResult) => {
    handleSearchResultClick(item, searchResults, search, setActiveVariationSelection);
  };

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
      lastTransactionId !== null,
    [
      checkoutOperator, checkoutDrawerOpen, exchangeWizardOpen, suitSwapWizardOpen,
      weddingDrawerOpen, measDrawerOpen, customerProfileHubOpen, cashAdjustOpen,
      giftCardLoadOpen, activeVariationSelection, showClearConfirm, showWalkinConfirm,
      showVoidAllConfirm, discountPrompt, intelligenceVariantId, lastTransactionId,
    ],
  );

  useScanner({
    onScan: (code) => handleLaserScan(code, runSearch),
    enabled: !scannerOverlayOpen && saleHydrated,
  });

  useEffect(() => {
    if (!saleHydrated || !checkoutOperator) {
      if (!checkoutOperator) didInitialProductSearchFocusRef.current = false;
      return;
    }
    if (didInitialProductSearchFocusRef.current) return;
    didInitialProductSearchFocusRef.current = true;
    const id = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [saleHydrated, checkoutOperator]);

  const orderLaterFulfillment: FulfillmentKind = activeWeddingMember
    ? "wedding_order"
    : "special_order";

  const hasSpecialOrWeddingLines = useMemo(
    () => lines.some((l) => l.fulfillment !== "takeaway"),
    [lines],
  );

  const allowCheckoutDepositKeypad = hasSpecialOrWeddingLines && !isRmsPaymentCart;
  const allowDepositOnlyCompleteSale = allowCheckoutDepositKeypad && lines.length > 0;

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

  return (
    <div className="relative flex h-full w-full bg-app-bg overflow-hidden">
      {checkoutDrawerOpen ? (
        <div
          className="pointer-events-none absolute inset-0 z-[95] bg-black/25"
          aria-hidden
        />
      ) : null}
      <div className="relative z-0 flex flex-[2] flex-col border-r border-app-border">
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
                      setSalePinCredential("");
                      setSalePinError(null);
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
                  <label className="flex min-w-0 max-w-full shrink-0 items-center gap-2 sm:max-w-[min(100%,22.5rem)]">
                    <span className="shrink-0 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Salesperson
                    </span>
                    <span className="sr-only">
                      Default for commission on all lines unless a line overrides
                    </span>
                    <StaffMiniSelector
                      staff={commissionStaff}
                      selectedId={primarySalespersonId}
                      onSelect={(id) => {
                        primaryDefaultedRef.current = true;
                        setPrimarySalespersonId(id);
                      }}
                      placeholder="Select Salesperson..."
                      className="min-w-[12rem]"
                    />
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
              onChange={(e) => {
                setSearch(e.target.value);
                if (e.target.value === "") {
                  setSearchResults([]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const q = search.trim();
                if (q.length < 2) return;
                e.preventDefault();
                void runSearch(search);
              }}
              className="ui-input h-11 w-full border-2 border-app-border pl-10 text-base font-black shadow-inner focus:border-app-accent"
            />
            <PosSearchResultList
              search={search}
              groupedSearchResults={groupedSearchResults}
              onSearchResultClick={onSearchResultClick}
            />
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
                data-testid="pos-action-gift-card"
                onClick={() => setGiftCardLoadOpen(true)}
                title="Enter load amount, then scan or type the card code"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-600/40 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-all hover:bg-emerald-600 hover:text-white"
              >
                <CreditCard size={16} className="shrink-0" aria-hidden />
                Gift Card
              </button>
              <button
                type="button"
                disabled={lines.length === 0}
                onClick={() => {
                   const label = selectedCustomer ? `Sale for ${selectedCustomer.first_name} ${selectedCustomer.last_name}` : "Untitled Sale";
                   const res = window.prompt("Enter a label for this parked sale:", label);
                   if (res !== null) void parkSale(res);
                }}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-accent/40 bg-app-accent/5 px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-all hover:bg-app-accent hover:text-white disabled:opacity-20"
              >
                <Clock size={16} />
                Park Sale
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
              <button
                type="button"
                onClick={() => setOrderReviewOpen(true)}
                disabled={lines.length === 0}
                title="Set Rush, Fulfillment, or Shipping details"
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-600/40 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-all hover:bg-emerald-600 hover:text-white disabled:opacity-20"
              >
                <Zap size={16} className="shrink-0" aria-hidden />
                Options
              </button>
              <button
                type="button"
                disabled={!selectedCustomer}
                onClick={() => setOrderLoadOpen(true)}
                title={selectedCustomer ? "View previous orders for this customer" : "Select a customer to view orders"}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-indigo-600/40 bg-indigo-50 px-3 text-[10px] font-black uppercase tracking-widest text-indigo-800 transition-all hover:bg-indigo-600 hover:text-white disabled:opacity-20"
              >
                <History size={16} className="shrink-0" aria-hidden />
                Orders
              </button>
          </div>
          </div>
        </div>

        {/* Scrollable line items — designed for 5-6 items visible */}
        <div className="flex-1 p-2 sm:p-3 lg:p-4">
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
        className={`relative z-0 flex h-full w-[min(380px,100%)] min-w-[280px] max-w-[400px] shrink-0 flex-col border-l border-app-border/80 bg-gradient-to-b from-app-surface via-app-surface-2/25 to-app-bg shadow-[-8px_0_32px_-12px_rgba(0,0,0,0.12)] lg:min-w-[300px] lg:max-w-[min(440px,34vw)] ${checkoutDrawerOpen ? "pointer-events-none select-none opacity-40" : ""}`}
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
            hasParkedSales={parkedRows.length > 0}
            onOpenParkedSales={() => setParkedListOpen(true)}
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
                    onClick={() => {
                      if (hasAccess) {
                        clearCart();
                        toast("Active sale voided", "success");
                      } else {
                        setShowVoidAllConfirm(true);
                      }
                    }}
                    className="rounded-lg border border-red-500/35 bg-red-500/[0.06] px-2 py-1 text-[9px] font-black uppercase tracking-widest text-red-600 transition-colors hover:bg-red-500 hover:text-white"
                  >
                    Void all
                  </button>
                ) : null}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-app-text-muted">
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>Subtotal</span>
                <span className="tabular-nums font-bold text-app-text">${centsToFixed2(totals.subtotalCents)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                <span>Items</span>
                <span className="tabular-nums text-app-text">{totals.totalPieces}</span>
              </div>
              <div className="col-span-2 space-y-1 pt-1 border-t border-app-border/30 mt-1">
                <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide opacity-60">
                  <span>NYS Tax</span>
                  <span className="tabular-nums font-bold text-app-text-muted">${centsToFixed2(totals.stateTaxCents)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide opacity-60">
                  <span>Local Tax</span>
                  <span className="tabular-nums font-bold text-app-text-muted">${centsToFixed2(totals.localTaxCents)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-wide">
                  <span className="text-app-text">Total Tax</span>
                  <span className="tabular-nums text-app-text">${centsToFixed2(totals.taxCents)}</span>
                </div>
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

          <div className="min-h-0 flex-1 rounded-2xl border border-app-border/40 bg-app-surface/60 p-2 shadow-inner">
            <div className="grid h-full grid-cols-3 grid-rows-5 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "CLEAR"].map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={!selectedLineKey}
                  onClick={() => handleNumpadKey(key)}
                  className={`flex items-center justify-center rounded-xl border-b-4 text-xl font-black transition-all active:scale-95 disabled:opacity-30 ${key === "CLEAR" ? "border-red-900/40 bg-red-600/10 text-red-600 hover:bg-red-600/20 active:translate-y-0.5" : "border-app-border/40 bg-app-surface-2/95 text-app-text hover:bg-app-surface active:translate-y-0.5"}`}
                >
                  {key}
                </button>
              ))}
              {/* Row 5: %, $, Apply */}
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("%")}
                className="flex items-center justify-center rounded-xl bg-indigo-600 border-b-4 border-indigo-900 text-xl font-black text-white shadow-xl shadow-indigo-500/20 transition-all hover:bg-indigo-500 active:translate-y-0.5 active:scale-95 disabled:opacity-30"
              >
                %
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("$")}
                className="flex items-center justify-center rounded-xl bg-indigo-600 border-b-4 border-indigo-900 text-xl font-black text-white shadow-xl shadow-indigo-500/20 transition-all hover:bg-indigo-500 active:translate-y-0.5 active:scale-95 disabled:opacity-30"
              >
                $
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("ENTER")}
                className="flex items-center justify-center rounded-xl border-b-[6px] border-emerald-800 bg-emerald-600 text-base font-black uppercase tracking-widest text-white shadow-2xl shadow-emerald-500/25 transition-all hover:bg-emerald-500 active:translate-y-0.5 active:scale-95 active:border-b-2 disabled:opacity-30"
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

               if (hasSpecialOrWeddingLines && !orderReviewOpen) {
                 setOrderReviewOpen(true);
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
        shippingCents={totals.shippingCents}
        weddingLinked={!!activeWeddingMember}
        customerId={selectedCustomer?.id}
        customerName={selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}` : undefined}
        authoritativeDepositCents={0}
        profileBlocksCheckout={false}
        onOpenProfileGate={() => {}}
        busy={checkoutBusy}
        onFinalize={(applied, op, ledger) => executeCheckout(applied, op, ledger, checkoutOrderOptions || undefined)}
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
        hasLaterItems={lines.some(l => l.fulfillment && l.fulfillment !== "takeaway")}
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
                    const lines = (p.payload_json?.lines || []) as CartLineItem[];
                    const lineCount = lines.length;
                    const subtotalCents = lines.reduce((acc, l) => {
                       return acc + parseMoneyToCents(l.standard_retail_price || "0") * (l.quantity || 1);
                    }, 0);
                    const cust = p.payload_json?.selectedCustomer as Customer | null;
                    const customerName = cust ? `${cust.first_name} ${cust.last_name}` : "Unknown Customer";

                    return (
                    <li
                      key={p.id}
                      className="rounded-xl border border-app-border bg-app-surface-2 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-black uppercase tracking-tight text-app-text">
                            {customerName}
                          </p>
                          <p className="mt-0.5 text-[9px] font-black uppercase tracking-widest text-app-accent opacity-80">
                            TRX #{p.id.slice(-6).toUpperCase()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-black italic tracking-tighter text-app-text">
                            ${centsToFixed2(subtotalCents)}
                          </p>
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {lineCount} item{lineCount === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void recallParkedSale(p.id)}
                          className="ui-btn-primary flex-1 py-1.5 text-[9px] font-black uppercase tracking-widest"
                        >
                          Recall
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteParkedSale(p.id)}
                          className="ui-btn-secondary flex-1 border-red-200 py-1.5 text-[9px] font-black uppercase tracking-widest text-red-600"
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
          onStartSale={(c: Customer) => {
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

      <ManagerApprovalModal
        isOpen={showVoidAllConfirm}
        onClose={() => setShowVoidAllConfirm(false)}
        title="Authorize Void All"
        message="Clearing every line in the cart requires a manager PIN for audit logging."
        onApprove={async (pin) => {
          try {
            const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({ 
                pin, 
                role: "Admin",
                authorize_action: "pos_sale_void_all",
                authorize_metadata: {
                  item_count: lines.length,
                  subtotal: totals.subtotalCents,
                  cart_summary: lines.map(l => `${l.quantity}x ${l.sku}`).join(", ")
                }
              }),
            });
            if (res.ok) {
              clearCart();
              setShowVoidAllConfirm(false);
              toast("All items voided", "success");
              return true;
            } else {
              const err = await res.json().catch(() => ({}));
              toast(err.error ?? "Manager authorization failed.", "error");
              return false;
            }
          } catch {
            toast("Authorization server unreachable.", "error");
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

      <ManagerApprovalModal
        isOpen={!!discountPrompt}
        onClose={() => setDiscountPrompt(null)}
        title="Override Authority"
        message={`Large discounts (>${roleMaxDiscountPct.toFixed(0)}%) require Manager PIN authorization for audit logging.`}
        onApprove={async (pin) => {
          if (!discountPrompt) return false;
          try {
            const res = await fetch(`${baseUrl}/api/auth/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                pin, 
                role: "Admin",
                authorize_action: "pos_price_override",
                authorize_metadata: {
                  variant_id: discountPrompt.variantId,
                  original_cents: discountPrompt.originalPriceCents,
                  next_cents: discountPrompt.nextPriceCents,
                  reason: discountPrompt.reason,
                  discount_pct: Math.round((1 - discountPrompt.nextPriceCents / discountPrompt.originalPriceCents) * 100)
                }
              }),
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
              return true;
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
          const cents = parseMoneyToCents(data.price);
          const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(data.taxCategory, cents);
          const updated: CartLineItem = {
            ...pendingCustomItem,
            name: `${data.itemType} (CUSTOM)`,
            standard_retail_price: data.price,
            unit_cost: data.cost,
            fulfillment: "custom",
            tax_category: data.taxCategory,
            state_tax: stateTax,
            local_tax: localTax,
            custom_item_type: data.itemType,
            quantity: 1,
            cart_row_id: newCartRowId(),
            is_rush: data.isRush,
            need_by_date: data.needByDate,
            needs_gift_wrap: data.needsGiftWrap,
          };
          setCustomPromptOpen(false);
          setPendingCustomItem(null);
          addItem(updated);
        }}
      />

      {lastTransactionId && (
        <ReceiptSummaryModal
          transactionId={lastTransactionId}
          onClose={() => {
            setLastTransactionId(null);
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
        credential={salePinCredential}
        onCredentialChange={(v) => {
          setSalePinCredential(v);
          setSalePinError(null);
        }}
        error={salePinError}
        busy={salePinBusy}
        onVerify={() => void verifySalePin()}
        onCancel={onExitPosMode}
      />

      {selectedCustomer && (
        <>
          <OrderLoadModal
            isOpen={orderLoadOpen}
            onClose={() => setOrderLoadOpen(false)}
            customerId={selectedCustomer.id}
            customerName={`${selectedCustomer.first_name} ${selectedCustomer.last_name}`}
            baseUrl={baseUrl}
            apiAuth={apiAuth}
            onSelectOrder={(order, mode) => {
              void (async () => {
                try {
                  const res = await fetch(`${baseUrl}/api/transactions/${order.id}/items`, {
                    headers: apiAuth(),
                  });
                  if (!res.ok) throw new Error("Could not fetch order items");
                  const items = (await res.json()) as OrderItem[];
                  
                  // Clear cart and setup for recall
                  clearCart();
                  setOrderLoadOpen(false);
                  
                  items.forEach(item => {
                    addItem({
                      product_id: item.product_id,
                      variant_id: item.variant_id,
                      sku: item.sku,
                      name: item.product_name,
                      variation_label: item.variation_label || "",
                      standard_retail_price: parseMoneyToCents(item.unit_price),
                      unit_cost: 0,
                      state_tax: 0,
                      local_tax: 0,
                    }, undefined, item.fulfillment as FulfillmentKind);
                    // Explicitly apply metadata since addItem doesn't expose it as a direct arg yet for recall
                    setLines(prev => prev.map(l => {
                      if (l.sku === item.sku && l.variant_id === item.variant_id && !l.is_rush && !l.need_by_date) {
                        return { ...l, is_rush: item.is_rush, need_by_date: item.need_by_date };
                      }
                      return l;
                    }));
                  });

                  if (mode === "ship") {
                    setOrderReviewOpen(true); // Open review to set address
                  }
                  
                  toast(`Order ${order.id.slice(-6)} recalled for ${mode}`, "success");
                } catch (e) {
                  toast(e instanceof Error ? e.message : "Recall failed", "error");
                }
              })();
            }}
            onSelectItems={(_unusedOrderId, items) => {
              // Load items into cart
              setOrderLoadOpen(false);
              items.forEach(item => {
                addItem({
                  product_id: item.product_id,
                  variant_id: item.variant_id,
                  sku: item.sku,
                  name: item.product_name,
                  variation_label: item.variation_label || "",
                  standard_retail_price: parseMoneyToCents(item.unit_price),
                  unit_cost: 0,
                  state_tax: 0,
                  local_tax: 0,
                  // ResolvedSkuItem doesn't strictly need these but we keep defaults
                }, undefined, item.fulfillment as FulfillmentKind);
                // Explicitly apply metadata
                setLines(prev => prev.map(l => {
                  if (l.sku === item.sku && l.variant_id === item.variant_id && !l.is_rush && !l.need_by_date) {
                    return { ...l, is_rush: item.is_rush, need_by_date: item.need_by_date };
                  }
                  return l;
                }));
              });
              toast(`Loaded ${items.length} items from order`, "success");
            }}
          />

          <OrderReviewModal
            isOpen={orderReviewOpen}
            onClose={() => setOrderReviewOpen(false)}
            items={lines.map(l => ({
              cart_row_id: l.cart_row_id,
              product_id: l.product_id,
              variant_id: l.variant_id ?? "",
              sku: l.sku,
              name: l.name,
              variation_label: l.variation_label ?? null,
              standard_retail_price: String(l.standard_retail_price),
              quantity: l.quantity,
              fulfillment: l.fulfillment,
            }))}
            customer={selectedCustomer ? {
              id: selectedCustomer.id,
              first_name: selectedCustomer.first_name,
              last_name: selectedCustomer.last_name,
              email: selectedCustomer.email ?? undefined,
              phone: selectedCustomer.phone ?? undefined,
            } : null}
            onComplete={(options) => {
              setCheckoutOrderOptions({
                is_rush: options.isRush,
                need_by_date: options.needByDate,
                fulfillment_mode: options.fulfillment,
                ship_to: options.shipTo ? {
                  name: options.shipTo.name,
                  street1: options.shipTo.street1,
                  city: options.shipTo.city,
                  state: options.shipTo.state,
                  zip: options.shipTo.zip,
                  country: options.shipTo.country || "US",
                } : null,
                stripe_payment_method_id: options.storeCardForBalance?.stripe_payment_method_id || null,
              });
              setOrderReviewOpen(false);
              setCheckoutDrawerOpen(true);
            }}
          />

        </>
      )}
    </div>
  );
}


