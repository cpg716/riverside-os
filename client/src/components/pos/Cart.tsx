import { getBaseUrl } from "../../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useScanner } from "../../hooks/useScanner";
import {
  Search,
  RotateCcw,
  X,
  ArrowLeftRight,
  Truck,
  Clock,
  Zap,
  Package,
  ScanSearch,
  Scissors,
  CreditCard,
  Pencil,
  AlertTriangle,
  Printer,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import CustomerSelector, { type Customer } from "./CustomerSelector";
import NexoCheckoutDrawer from "./NexoCheckoutDrawer";
import RegisterCashAdjustModal from "./RegisterCashAdjustModal";
import RegisterGiftCardLoadModal from "./RegisterGiftCardLoadModal";
import RegisterRmsPaymentModal from "./RegisterRmsPaymentModal";
import RegisterStaffAccountPaymentModal from "./RegisterStaffAccountPaymentModal";
import PosCustomerMeasurementsDrawer from "./PosCustomerMeasurementsDrawer";
import ReceiptSummaryModal from "./ReceiptSummaryModal";
import VariantSelectionModal, { type ProductWithVariants } from "./VariantSelectionModal";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import {
  centsToFixed2,
  parseMoneyToCents,
} from "../../lib/money";
import { isNonTaxableServiceLine } from "../../lib/cartTax";
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
import WeddingLookupDrawer, { type WeddingMember } from "./WeddingLookupDrawer";
import PosShippingModal, {
  type PosShippingSelection,
} from "./PosShippingModal";
import type { WeddingMembership } from "./customerProfileTypes";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import { newCartRowId, scanPayloadToResolvedItem } from "../../lib/posUtils";
import { customOrderItemTypeForSku, isCustomOrderSku } from "../../lib/customOrders";
import CustomItemPromptModal from "./CustomItemPromptModal";
import OrderLoadModal, { type CustomerOrder, type OrderItem } from "./OrderLoadModal";
import OrderReviewModal from "./OrderReviewModal";
import PosAlterationIntakeModal from "./PosAlterationIntakeModal";
import ManagerApprovalModal from "./ManagerApprovalModal";
import PromptModal from "../ui/PromptModal";
import PosSuitSwapWizard from "./PosSuitSwapWizard";
import { hasApprovedProviderPayment } from "./paymentLineGuards";

export type { CheckoutPayload } from "./types";

// --- POS Modularization ---
import {
  type ResolvedSkuItem,
  type CartLineItem,
  type FulfillmentKind,
  type OrderLifecycleStatus,
  type PosStaffRow,
  type ActiveDiscountEvent,
  type RmsPaymentLineMeta,
  type StaffAccountPaymentLineMeta,
  type GiftCardLoadLineMeta,
  type AppliedPaymentLine,
  type CheckoutOperatorContext,
  type PosOrderOptions,
  type PendingAlterationIntake,
  type OrderPaymentCartLine,
  type CartTotals
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
import { getAppIcon } from "../../lib/icons";
import {
  heldOpenDepositNoticeMessage,
  type HeldOpenDeposit,
} from "./openDeposit";

const WEDDINGS_ICON = getAppIcon("weddings");
const GIFT_CARDS_ICON = getAppIcon("giftCards");
const ORDER_HISTORY_ICON = getAppIcon("orderHistory");
const ALTERATION_SERVICE_PRODUCT_ID = "b7c0a006-0006-4006-8006-000000000006";
const ALTERATION_SERVICE_VARIANT_ID = "b7c0a007-0007-4007-8007-000000000007";
const ALTERATION_SERVICE_SKU = "ROS-ALTERATION-SERVICE";

interface ExchangeReturnHandoffLine {
  transaction_line_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label?: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_cost: string | number;
  state_tax_cents?: number;
  local_tax_cents?: number;
  tax_cents: number;
  reason?: "refund" | "exchange";
  restock?: boolean | null;
}

function allocateCentsByWeight(
  components: Array<{ key: "subtotal" | "stateTax" | "localTax"; cents: number }>,
  capCents: number,
): Record<"subtotal" | "stateTax" | "localTax", number> {
  const totalCents = components.reduce((sum, component) => sum + Math.max(0, component.cents), 0);
  const cap = Math.max(0, Math.min(capCents, totalCents));
  if (cap <= 0 || totalCents <= 0) {
    return { subtotal: 0, stateTax: 0, localTax: 0 };
  }
  if (cap === totalCents) {
    return {
      subtotal: components.find((component) => component.key === "subtotal")?.cents ?? 0,
      stateTax: components.find((component) => component.key === "stateTax")?.cents ?? 0,
      localTax: components.find((component) => component.key === "localTax")?.cents ?? 0,
    };
  }

  const weighted = components.map((component) => {
    const raw = (Math.max(0, component.cents) * cap) / totalCents;
    return {
      ...component,
      floor: Math.floor(raw),
      remainder: raw - Math.floor(raw),
    };
  });
  let remaining = cap - weighted.reduce((sum, component) => sum + component.floor, 0);
  weighted
    .sort((a, b) => b.remainder - a.remainder)
    .forEach((component) => {
      if (remaining <= 0) return;
      component.floor += 1;
      remaining -= 1;
    });

  return weighted.reduce(
    (acc, component) => ({
      ...acc,
      [component.key]: component.floor,
    }),
    { subtotal: 0, stateTax: 0, localTax: 0 } as Record<"subtotal" | "stateTax" | "localTax", number>,
  );
}

function exchangeReturnCreditComponents(
  returnedLines: ExchangeReturnHandoffLine[],
  creditCapCents: number,
): { subtotalCents: number; stateTaxCents: number; localTaxCents: number; totalCents: number } {
  const subtotalCents = returnedLines.reduce(
    (sum, line) => sum + Math.max(0, line.unit_price_cents) * Math.max(0, line.quantity),
    0,
  );
  const stateTaxCents = returnedLines.reduce(
    (sum, line) => sum + Math.max(0, line.state_tax_cents ?? 0) * Math.max(0, line.quantity),
    0,
  );
  const localTaxCents = returnedLines.reduce(
    (sum, line) => sum + Math.max(0, line.local_tax_cents ?? 0) * Math.max(0, line.quantity),
    0,
  );
  const allocated = allocateCentsByWeight(
    [
      { key: "subtotal", cents: subtotalCents },
      { key: "stateTax", cents: stateTaxCents },
      { key: "localTax", cents: localTaxCents },
    ],
    creditCapCents,
  );
  return {
    subtotalCents: allocated.subtotal,
    stateTaxCents: allocated.stateTax,
    localTaxCents: allocated.localTax,
    totalCents: allocated.subtotal + allocated.stateTax + allocated.localTax,
  };
}

function calculateStandaloneLineTotals(lines: CartLineItem[]): CartTotals {
  const res = lines.reduce(
    (acc, line) => {
      const quantity = line.quantity;
      const priceCents = parseMoneyToCents(line.standard_retail_price);
      const forceNonTaxable = isNonTaxableServiceLine(line);
      const stateTaxCents = forceNonTaxable ? 0 : parseMoneyToCents(line.state_tax);
      const localTaxCents = forceNonTaxable ? 0 : parseMoneyToCents(line.local_tax);
      acc.subtotalCents += priceCents * quantity;
      acc.stateTaxCents += stateTaxCents * quantity;
      acc.localTaxCents += localTaxCents * quantity;
      if (line.line_type !== "alteration_service") {
        acc.totalPieces += quantity;
      }
      if (line.fulfillment === "takeaway") {
        acc.takeawayDueCents += (priceCents + stateTaxCents + localTaxCents) * quantity;
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
  const taxCents = res.stateTaxCents + res.localTaxCents;
  const orderTotalCents = res.subtotalCents + taxCents;
  return {
    subtotalCents: res.subtotalCents,
    stateTaxCents: res.stateTaxCents,
    localTaxCents: res.localTaxCents,
    totalPieces: res.totalPieces,
    taxCents,
    orderTotalCents,
    orderPaymentCents: 0,
    collectTotalCents: orderTotalCents,
    shippingCents: 0,
    takeawayDueCents: res.takeawayDueCents,
    totalCents: orderTotalCents,
  };
}

function weddingDisbursementAmountCents(member: WeddingMember): number {
  return parseMoneyToCents(member.split_deposit_amount ?? member.balance_due ?? "0");
}

interface ExchangeReturnHandoff {
  originalTransactionId: string;
  customer: Customer | null;
  receiptLabel?: string;
  returnedLines?: ExchangeReturnHandoffLine[];
  refundAmountCents?: number;
  action?: "refund" | "exchange";
}

interface HandoffOrderDetail {
  transaction_id: string;
  transaction_display_id?: string;
  primary_salesperson_id?: string | null;
  fulfillment_method?: string;
  shipping_amount_usd?: string | null;
  total_price?: string;
  amount_paid?: string;
  balance_due?: string;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    email?: string | null;
    phone?: string | null;
    customer_code?: string | null;
    company_name?: string | null;
  } | null;
  linked_alterations?: Array<{
    id: string;
    status: string;
    item_description?: string | null;
    work_requested: string;
    source_sku?: string | null;
    ticket_number?: string | null;
    source_transaction_line_id?: string | null;
    picked_up_at?: string | null;
  }>;
  items: Array<{
    transaction_line_id: string;
    product_id: string;
    variant_id: string;
    sku: string;
    product_name: string;
    variation_label?: string | null;
    quantity: number;
    unit_price: string;
    unit_cost?: string;
    state_tax?: string;
    local_tax?: string;
    fulfillment: FulfillmentKind;
    is_fulfilled: boolean;
    is_internal?: boolean;
    custom_item_type?: string | null;
    custom_order_details?: ResolvedSkuItem["custom_order_details"];
    order_lifecycle_status?: string;
    salesperson_id?: string | null;
  }>;
}

interface WeddingPurchaseItem extends ResolvedSkuItem {
  available_stock?: number;
  reserved_stock?: number;
  source: string;
  already_tracked: boolean;
}

interface WeddingChecklistItem {
  id: string;
  description: string;
  quantity: number;
  status: string;
  notes?: string | null;
}

interface WeddingPurchaseMembership {
  wedding_member_id: string;
  wedding_party_id: string;
  transaction_id?: string | null;
  party_name: string;
  event_date: string;
  role: string;
  status: string;
  active: boolean;
  measured: boolean;
  suit_ordered: boolean;
  customer_id: string;
  first_name?: string | null;
  last_name?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  is_free_suit_promo: boolean;
  purchase_items: WeddingPurchaseItem[];
  checklist_items: WeddingChecklistItem[];
}

interface WeddingPurchaseContext {
  memberships: WeddingPurchaseMembership[];
}

interface CartProps {
  sessionId: string;
  registerLane?: number | null;
  cashierName?: string | null;
  cashierCode?: string | null;
  initialCustomer?: Customer | null;
  onInitialCustomerConsumed?: () => void;
  initialTransactionId?: string | null;
  onInitialTransactionConsumed?: () => void;
  /** When true, loading the transaction is for pickup flow - will auto-add balance payment and call pickup API after checkout */
  initialTransactionForPickup?: boolean;
  initialTransactionForRefund?: boolean;
  initialTransactionReturnLineId?: string | null;
  initialWeddingLookupOpen?: boolean;
  /** From Wedding Manager: pre-link customer + wedding member for wedding_order checkout. */
  initialWeddingPosLink?: RosOpenRegisterFromWmDetail | null;
  onInitialWeddingPosLinkConsumed?: () => void;
  /** After checkout succeeds (cart cleared); e.g. switch POS shell back to Register for next sale sign-in. */
  onSaleCompleted?: () => void;
  onRegisterTransactionCommitted?: () => void;
  onExitPosMode?: () => void;
  pendingInventorySku?: string | null;
  onPendingInventorySkuConsumed?: () => void;
  onCartInteraction?: () => void;
  /** IANA zone from open register session — live clock only; receipt uses server time at checkout. */
  receiptTimezone?: string;
  onOpenWeddingParty?: (partyId: string) => void;
}


// Helpers relocated to posUtils.ts or hooks

// --- Component ---
export default function Cart({
  sessionId,
  registerLane = null,
  cashierName = null,
  initialCustomer = null,
  onInitialCustomerConsumed,
  initialTransactionId = null,
  onInitialTransactionConsumed,
  initialTransactionForPickup = false,
  initialTransactionForRefund = false,
  initialTransactionReturnLineId = null,
  // initialWeddingLookupOpen removed
  initialWeddingPosLink = null,
  onInitialWeddingPosLinkConsumed,
	  onSaleCompleted,
	  onRegisterTransactionCommitted,
	  onExitPosMode,
	  pendingInventorySku = null,
	  onPendingInventorySkuConsumed,
	  onCartInteraction,
	  receiptTimezone: receiptTimezoneProp,
	  onOpenWeddingParty,
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
  } = useBackofficeAuth();

  const hasAccess = staffRole === "admin";
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();

  // --- External States (managed by hooks) ---
  const [rmsPaymentMeta, setRmsPaymentMeta] = useState<RmsPaymentLineMeta | null>(null);
  const [staffAccountPaymentMeta, setStaffAccountPaymentMeta] = useState<StaffAccountPaymentLineMeta | null>(null);
  const [giftCardLoadMeta, setGiftCardLoadMeta] = useState<GiftCardLoadLineMeta | null>(null);
  const [primarySalespersonId, setPrimarySalespersonId] = useState("");
  const [checkoutOperator, setCheckoutOperator] = useState<CheckoutOperatorContext | null>(null);
  const [posShipping, setPosShipping] = useState<PosShippingSelection | null>(null);
  const [checkoutAppliedPayments, setCheckoutAppliedPayments] = useState<AppliedPaymentLine[]>([]);
  const [checkoutDepositLedger, setCheckoutDepositLedger] = useState("");
  const approvedProviderPaymentInCheckout = useMemo(
    () => hasApprovedProviderPayment(checkoutAppliedPayments),
    [checkoutAppliedPayments],
  );
  const [saleDateTimeLocal, setSaleDateTimeLocal] = useState<string | null>(null);
  const [pickupConfirmed, setPickupConfirmed] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const isEmployeeSale = selectedCustomer?.employee_discount_eligible === true;
  const [activeWeddingMember, setActiveWeddingMember] = useState<WeddingMember | null>(null);
  const [activeWeddingPartyName, setActiveWeddingPartyName] = useState<string | null>(null);
  const [disbursementMembers, setDisbursementMembers] = useState<WeddingMember[]>([]);
  const [weddingPurchaseContext, setWeddingPurchaseContext] = useState<WeddingPurchaseContext | null>(null);
  const [weddingPurchaseLoading, setWeddingPurchaseLoading] = useState(false);

  const [roleMaxDiscountPct, setRoleMaxDiscountPct] = useState(30);
  const [salePinCredential, setSalePinCredential] = useState("");
  const [salePinError, setSalePinError] = useState<string | null>(null);
  const [lastTransactionId, setLastTransactionId] = useState<string | null>(null);
  const [pickupTransactionId, setPickupTransactionId] = useState<string | null>(null);
  const [pickupPaidAmountCents, setPickupPaidAmountCents] = useState<number>(0);
  const [pickupReadyAlterations, setPickupReadyAlterations] = useState<NonNullable<HandoffOrderDetail["linked_alterations"]>>([]);

  // --- UI States (Restored to Cart.tsx) ---
  const [checkoutDrawerOpen, setCheckoutDrawerOpen] = useState(false);
  const [belowCostApprovalPromptOpen, setBelowCostApprovalPromptOpen] =
    useState(false);
  const [belowCostApproval, setBelowCostApproval] = useState<{
    approvedByStaffId: string;
    lineSignature: string;
    reason: string;
  } | null>(null);
  const [weddingDrawerOpen, setWeddingDrawerOpen] = useState(false);
  const [weddingDrawerPreferGroupPay, setWeddingDrawerPreferGroupPay] = useState(false);
  const [measDrawerOpen, setMeasDrawerOpen] = useState(false);
  const [orderLoadOpen, setOrderLoadOpen] = useState(false);
  const [orderReviewOpen, setOrderReviewOpen] = useState(false);
  const [alterationIntakeOpen, setAlterationIntakeOpen] = useState(false);
  const [editingAlterationIntake, setEditingAlterationIntake] = useState<PendingAlterationIntake | null>(null);
  const [sourceRemovalPrompt, setSourceRemovalPrompt] = useState<{
    line: CartLineItem;
    intakes: PendingAlterationIntake[];
  } | null>(null);
  const [pendingAlterationIntakes, setPendingAlterationIntakes] = useState<PendingAlterationIntake[]>([]);
  const [orderPaymentLines, setOrderPaymentLines] = useState<OrderPaymentCartLine[]>([]);
  const [editingOrderPaymentLine, setEditingOrderPaymentLine] = useState<OrderPaymentCartLine | null>(null);
  const [editingOrderPaymentAmount, setEditingOrderPaymentAmount] = useState("");
  const [lastReceiptOrderPaymentLines, setLastReceiptOrderPaymentLines] = useState<OrderPaymentCartLine[]>([]);
  const [customerProfileHubOpen, setCustomerProfileHubOpen] = useState(false);
  const [checkoutOrderOptions, setCheckoutOrderOptions] = useState<PosOrderOptions | null>(null);
  const [cashAdjustOpen, setCashAdjustOpen] = useState(false);
  const [heldOpenDeposit, setHeldOpenDeposit] = useState<HeldOpenDeposit | null>(null);
  const [openDepositNotice, setOpenDepositNotice] = useState<HeldOpenDeposit | null>(null);
  const [intelligenceVariantId, setIntelligenceVariantId] = useState<string | null>(null);
  const [intelligenceLine, setIntelligenceLine] = useState<CartLineItem | null>(null);
  const [showPrintRetryPanel, setShowPrintRetryPanel] = useState(false);
  const [activeDiscountEvents, setActiveDiscountEvents] = useState<ActiveDiscountEvent[]>([]);
  const [selectedDiscountEventId, setSelectedDiscountEventId] = useState("");
  const [exchangeWizardInitialTransactionId, setExchangeWizardInitialTransactionId] = useState<string | null>(null);

  // --- Offline queue & print retry badges ---
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [offlineBlockedCount, setOfflineBlockedCount] = useState(0);
  const [failedPrintCount, setFailedPrintCount] = useState(0);

  useEffect(() => {
    const poll = async () => {
      try {
        const { getCheckoutQueueSummary } = await import("../../lib/offlineQueue");
        const summary = await getCheckoutQueueSummary();
        setOfflineQueueCount(summary.totalCount);
        setOfflineBlockedCount(summary.blockedCount);
      } catch { /* ignore */ }
      try {
        const { getFailedPrintJobs } = await import("../../lib/printRetryQueue");
        const jobs = await getFailedPrintJobs();
        setFailedPrintCount(jobs.length);
      } catch { /* ignore */ }
    };
    void poll();
    const interval = setInterval(poll, 10000);
    const onQueueChange = () => void poll();
    window.addEventListener("queue_changed", onQueueChange);
    window.addEventListener("print_queue_changed", onQueueChange);
    return () => {
      clearInterval(interval);
      window.removeEventListener("queue_changed", onQueueChange);
      window.removeEventListener("print_queue_changed", onQueueChange);
    };
  }, []);

  useEffect(() => {
    fetch(`${baseUrl}/api/discount-events/active`, { headers: apiAuth() as Record<string, string> })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setActiveDiscountEvents(Array.isArray(data) ? data : []))
      .catch(() => {
        toast("Discount events unavailable. Verify network or contact manager.", "error");
      });
  }, [baseUrl, apiAuth, toast]);

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
  const [rmsPaymentOpen, setRmsPaymentOpen] = useState(false);
  const [staffAccountPaymentOpen, setStaffAccountPaymentOpen] = useState(false);
  const [parkSalePromptOpen, setParkSalePromptOpen] = useState(false);
  const [parkSaleDraftLabel, setParkSaleDraftLabel] = useState("");
  const [feePromptKind, setFeePromptKind] = useState<"alterations" | "shipping" | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const requestProductSearchFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, []);

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
    toggleLineTaxCategory,
    updateLineOrderLifecycleStatus,
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
    staffAccountPaymentMeta,
    giftCardLoadMeta,
    activeWeddingMember,
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
    setGiftCardLoadMeta,
    setPrimarySalespersonId,
    setCheckoutAppliedPayments,
    setCheckoutDepositLedger,
    setPosShipping,
    setPickupConfirmed,
    onReadyForNextScan: requestProductSearchFocus,
    baseUrl,
    apiAuth,
  });

  const addFeeShortcut = useCallback(async (rawAmount: string) => {
    const amountCents = parseMoneyToCents(rawAmount);
    if (amountCents <= 0) {
      toast("Enter an amount greater than $0.00.", "error");
      return false;
    }

    if (feePromptKind === "alterations") {
      setLines((prev) => [
        ...prev,
        {
          product_id: ALTERATION_SERVICE_PRODUCT_ID,
          variant_id: ALTERATION_SERVICE_VARIANT_ID,
          sku: ALTERATION_SERVICE_SKU,
          name: "ALTERATIONS FEE",
          variation_label: "Standalone fee",
          standard_retail_price: centsToFixed2(amountCents),
          unit_cost: "0.00",
          state_tax: "0.00",
          local_tax: "0.00",
          tax_category: "service",
          quantity: 1,
          fulfillment: "takeaway",
          cart_row_id: newCartRowId(),
          line_type: "merchandise",
          price_override_reason: "alteration_service",
          original_unit_price: "0.00",
          custom_item_type: "alteration_service",
        },
      ]);
      setFeePromptKind(null);
      toast("Non-taxable alterations fee added.", "success");
      return true;
    }

    if (feePromptKind === "shipping") {
      try {
        const response = await fetch(`${baseUrl}/api/pos/shipping/manual-quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            amount_usd: centsToFixed2(amountCents),
            label: "Shipping",
            fee_only: true,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          rate_quote_id?: string;
          amount_usd?: string | number;
          carrier?: string;
          service_name?: string;
        };
        if (!response.ok || !body.rate_quote_id) {
          toast(body.error ?? "Could not add the shipping fee.", "error");
          return false;
        }
        setPosShipping({
          rate_quote_id: body.rate_quote_id,
          amount_cents: parseMoneyToCents(body.amount_usd ?? centsToFixed2(amountCents)),
          label: body.service_name || "Shipping",
          to_address: null,
          fee_only: true,
        });
        setFeePromptKind(null);
        toast("Non-taxable shipping fee added.", "success");
        return true;
      } catch {
        toast("Main Hub connection failed while adding the shipping fee.", "error");
        return false;
      }
    }

    return false;
  }, [apiAuth, baseUrl, feePromptKind, setLines, toast]);

  const [pendingReturnLineDrafts, setPendingReturnLineDrafts] = useState<
    Record<string, ExchangeReturnHandoffLine[]>
  >({});

  const isRmsPaymentCart = useMemo(
    () => lines.some((l) => rmsPaymentMeta && l.sku === rmsPaymentMeta.sku),
    [lines, rmsPaymentMeta],
  );

  const updateSelectedCustomerSnapshot = useCallback((customer: Customer) => {
    setSelectedCustomer((current) => {
      if (!current || current.id !== customer.id) return current;
      return {
        ...current,
        ...customer,
      };
    });
  }, []);

  const resetSaleDateTime = useCallback(() => {
    setSaleDateTimeLocal(null);
  }, []);

  const clearCartAndAlterations = useCallback(() => {
    clearCart();
    setPendingReturnLineDrafts({});
    resetSaleDateTime();
    setPendingAlterationIntakes([]);
    setEditingAlterationIntake(null);
    setOrderPaymentLines([]);
    setEditingOrderPaymentLine(null);
    setEditingOrderPaymentAmount("");
    setManagerOverrideApproved(false);
    setManagerOverrideReason("");
    setPickupTransactionId(null);
    setPickupPaidAmountCents(0);
    setPickupReadyAlterations([]);
  }, [clearCart, resetSaleDateTime]);

  const selectedCustomerId = selectedCustomer?.id ?? null;
  const previousSelectedCustomerId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (
      previousSelectedCustomerId.current !== undefined &&
      previousSelectedCustomerId.current !== selectedCustomerId
    ) {
      resetSaleDateTime();
    }
    previousSelectedCustomerId.current = selectedCustomerId;
  }, [resetSaleDateTime, selectedCustomerId]);

  const handleExchangeReturnHandoff = useCallback((args: ExchangeReturnHandoff) => {
    onExchangeContinue({
      originalTransactionId: args.originalTransactionId,
      customer: args.customer,
    });

    const returnedLines = args.returnedLines ?? [];
    setPendingReturnLineDrafts((prev) => ({
      ...prev,
      [args.originalTransactionId]: returnedLines,
    }));

    const selectedReturnGrossCents = returnedLines.reduce(
      (sum, line) =>
        sum +
        (Math.max(0, line.unit_price_cents) +
          Math.max(0, line.state_tax_cents ?? 0) +
          Math.max(0, line.local_tax_cents ?? 0)) *
          Math.max(0, line.quantity),
      0,
    );
    const refundAmountCents = Math.max(
      0,
      Math.min(Math.round(args.refundAmountCents ?? selectedReturnGrossCents), selectedReturnGrossCents),
    );
    const returnCredit = exchangeReturnCreditComponents(returnedLines, refundAmountCents);
    const firstReturnLine = returnedLines[0];
    if (!firstReturnLine) return;
    if (refundAmountCents <= 0 && args.action !== "exchange") return;

    const receiptLabel = args.receiptLabel ?? args.originalTransactionId.slice(0, 8).toUpperCase();
    const rowId = newCartRowId();
    const lineLabel =
      firstReturnLine.product_name +
      (args.returnedLines && args.returnedLines.length > 1
        ? ` + ${args.returnedLines.length - 1} more`
        : "");

    const returnCreditLine: CartLineItem = {
      product_id: firstReturnLine.product_id,
      variant_id: firstReturnLine.variant_id,
      sku: `RETURN-${receiptLabel}`,
      name:
        args.action === "exchange" && refundAmountCents <= 0
          ? `Exchange return ${receiptLabel}`
          : args.action === "exchange"
            ? `Exchange credit ${receiptLabel}`
            : `Refund credit ${receiptLabel}`,
      variation_label: lineLabel,
      standard_retail_price: centsToFixed2(returnCredit.subtotalCents),
      unit_cost: firstReturnLine.unit_cost ?? "0.00",
      state_tax: centsToFixed2(returnCredit.stateTaxCents),
      local_tax: centsToFixed2(returnCredit.localTaxCents),
      tax_category: "other",
      quantity: -1,
      fulfillment: "takeaway",
      cart_row_id: rowId,
      price_override_reason: "pending_return_refund",
      original_unit_price: centsToFixed2(returnCredit.subtotalCents),
      return_tender_original_transaction_id: args.originalTransactionId,
      return_tender_receipt_label: receiptLabel,
      return_tender_refund_cents: returnCredit.totalCents,
    };

    setLines((prev) => [
      ...prev.filter((line) => line.return_tender_original_transaction_id !== args.originalTransactionId),
      returnCreditLine,
    ]);
    setSelectedLineKey(rowId);
    setCheckoutAppliedPayments([]);
    setCheckoutDepositLedger("");
    setOrderPaymentLines([]);
    setEditingOrderPaymentLine(null);
    setEditingOrderPaymentAmount("");
    setPosShipping(null);
    if (args.action === "refund") {
      setCheckoutDrawerOpen(true);
      toast(`Refund credit for ${receiptLabel} moved to Pay. Select the refund tender to finish.`, "success");
    } else if (refundAmountCents <= 0) {
      toast(`Return from ${receiptLabel} is staged. Add replacement items, then Pay to settle the exchange.`, "success");
    } else {
      toast(`Return credit for ${receiptLabel} is in the cart. Add replacement items, then Pay to settle the exchange.`, "success");
    }
  }, [
    onExchangeContinue,
    setLines,
    setSelectedLineKey,
    setCheckoutAppliedPayments,
    setCheckoutDepositLedger,
    setPosShipping,
    setCheckoutDrawerOpen,
    toast,
  ]);

  useEffect(() => {
    const customerId = selectedCustomer?.id ?? null;
    setCheckoutAppliedPayments((prev) =>
      prev.some((payment) => payment.method === "open_deposit")
        ? prev.filter((payment) => payment.method !== "open_deposit")
        : prev,
    );
    setPendingAlterationIntakes((prev) => {
      const next = customerId ? prev.filter((intake) => intake.customer_id === customerId) : [];
      return next.length === prev.length ? prev : next;
    });
    setOrderPaymentLines((prev) => {
      const next = customerId ? prev.filter((line) => line.customer_id === customerId) : [];
      return next.length === prev.length ? prev : next;
    });
  }, [selectedCustomer?.id]);

  useEffect(() => {
    const customerId = selectedCustomer?.id;
    setHeldOpenDeposit(null);
    setOpenDepositNotice(null);
    if (!customerId) return;

    let cancelled = false;
    fetch(`${baseUrl}/api/customers/${customerId}/open-deposit`, {
      headers: { ...apiAuth() },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          balance?: string | number;
          last_payer_display_name?: string | null;
          last_credit_amount?: string | number | null;
        };
      })
      .then((payload) => {
        if (cancelled) return;
        const balanceCents = Math.max(0, parseMoneyToCents(payload.balance ?? "0"));
        if (balanceCents <= 0) return;
        const deposit: HeldOpenDeposit = {
          customerId,
          balanceCents,
          lastPayerName: payload.last_payer_display_name?.trim() || null,
          lastCreditCents:
            payload.last_credit_amount == null
              ? null
              : Math.max(0, parseMoneyToCents(payload.last_credit_amount)),
        };
        setHeldOpenDeposit(deposit);
        setOpenDepositNotice(deposit);
      })
      .catch(() => {
        if (!cancelled) {
          toast("Wedding deposit balance unavailable. Verify the connection before taking payment.", "error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [apiAuth, baseUrl, selectedCustomer?.id, toast]);

  useEffect(() => {
    const customerId = selectedCustomer?.id;
    if (!customerId) {
      setWeddingPurchaseContext(null);
      setWeddingPurchaseLoading(false);
      return;
    }

    let cancelled = false;
    setWeddingPurchaseLoading(true);
    fetch(`${baseUrl}/api/weddings/customers/${customerId}/purchase-context`, {
      headers: { ...apiAuth() },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as WeddingPurchaseContext;
      })
      .then((payload) => {
        if (cancelled) return;
        setWeddingPurchaseContext(payload);
      })
      .catch(() => {
        if (!cancelled) {
          setWeddingPurchaseContext(null);
          toast("Wedding context unavailable. Verify network or contact manager.", "error");
        }
      })
      .finally(() => {
        if (!cancelled) setWeddingPurchaseLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [apiAuth, baseUrl, selectedCustomer?.id, toast]);

  const weddingMemberships = useMemo<WeddingMembership[]>(
    () =>
      (weddingPurchaseContext?.memberships ?? []).map((membership) => ({
        wedding_member_id: membership.wedding_member_id,
        wedding_party_id: membership.wedding_party_id,
        order_id: membership.transaction_id ?? null,
        party_name: membership.party_name,
        event_date: membership.event_date,
        role: membership.role,
        status: membership.status,
        active: membership.active,
      })),
    [weddingPurchaseContext],
  );

  const activateWeddingMembership = useCallback(
    (membership: WeddingPurchaseMembership, item?: WeddingPurchaseItem) => {
      setActiveWeddingMember({
        id: membership.wedding_member_id,
        first_name: membership.first_name ?? selectedCustomer?.first_name ?? "Wedding",
        last_name: membership.last_name ?? selectedCustomer?.last_name ?? "Member",
        role: membership.role,
        status: membership.status,
        measured: membership.measured,
        suit_ordered: membership.suit_ordered,
        customer_id: membership.customer_id,
        customer_email: membership.customer_email ?? undefined,
        customer_phone: membership.customer_phone ?? undefined,
        suit_variant_id: item?.variant_id ?? null,
        is_free_suit_promo: membership.is_free_suit_promo,
      });
      setActiveWeddingPartyName(membership.party_name);
    },
    [selectedCustomer?.first_name, selectedCustomer?.last_name],
  );

  const addWeddingPurchaseItem = useCallback(
    (
      membership: WeddingPurchaseMembership,
      item: WeddingPurchaseItem,
      mode: "takeaway" | "order" | "needs_measurements",
    ) => {
      if (!checkoutOperator) {
        toast("Verify Staff Access on the register sign-in screen before adding wedding items.", "error");
        return;
      }
      if (isRmsPaymentCart) {
        toast("Remove the RMS CHARGE PAYMENT line before adding wedding items.", "error");
        return;
      }
      if (lines.some((line) => line.variant_id === item.variant_id)) {
        toast("That wedding item is already in the cart.", "info");
        return;
      }

      activateWeddingMembership(membership, item);
      const isFree = Boolean(membership.is_free_suit_promo);
      const line: CartLineItem = {
        ...item,
        quantity: 1,
        fulfillment: mode === "takeaway" ? "takeaway" : "wedding_order",
        cart_row_id: newCartRowId(),
        order_lifecycle_status: mode === "needs_measurements" ? "needs_measurements" : undefined,
        ...(isFree
          ? {
              standard_retail_price: "0.00",
              original_unit_price: String(item.standard_retail_price),
              price_override_reason: "Wedding Promo (Free Suit Selection)",
            }
          : {}),
      };
      setLines((prev) => [...prev, line]);
      setSelectedLineKey(line.cart_row_id);
      toast(
        mode === "takeaway"
          ? "Wedding item added for take-now sale."
          : mode === "needs_measurements"
            ? "Wedding item added and marked needs measurements."
            : "Wedding item added for ordering.",
        "success",
      );
    },
    [
      activateWeddingMembership,
      checkoutOperator,
      isRmsPaymentCart,
      lines,
      setLines,
      setSelectedLineKey,
      toast,
    ],
  );

  useEffect(() => {
    const intakeIds = new Set(pendingAlterationIntakes.map((intake) => intake.id));
    setLines((prev) => {
      const next = prev.filter(
        (line) =>
          line.line_type !== "alteration_service" ||
          (line.alteration_intake_id ? intakeIds.has(line.alteration_intake_id) : false),
      );
      return next.length === prev.length ? prev : next;
    });
  }, [pendingAlterationIntakes, setLines]);

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
    if (line.line_type === "alteration_service") return;
    setIntelligenceLine(line);
    setIntelligenceVariantId(line.variant_id);
  }, []);

  const upsertAlterationCartLine = useCallback((intake: PendingAlterationIntake) => {
    const chargeCents =
      intake.charge_amount && intake.charge_amount.trim()
        ? parseMoneyToCents(intake.charge_amount)
        : 0;
    const rowId = intake.alteration_cart_row_id || newCartRowId();
    const serviceLine: CartLineItem = {
      product_id: ALTERATION_SERVICE_PRODUCT_ID,
      variant_id: ALTERATION_SERVICE_VARIANT_ID,
      sku: ALTERATION_SERVICE_SKU,
      name: `Alteration: ${intake.work_requested}`,
      variation_label: intake.item_description,
      standard_retail_price: centsToFixed2(chargeCents),
      unit_cost: "0.00",
      state_tax: "0.00",
      local_tax: "0.00",
      tax_category: "service",
      quantity: 1,
      fulfillment: "takeaway",
      cart_row_id: rowId,
      line_type: "alteration_service",
      alteration_intake_id: intake.id,
      alteration_source_cart_row_id: intake.cart_row_id ?? null,
      price_override_reason: "alteration_service",
      original_unit_price: "0.00",
      custom_item_type: "alteration_service",
    };
    const normalizedIntake = { ...intake, alteration_cart_row_id: rowId };
    setLines((prev) => {
      const existing = prev.findIndex(
        (line) =>
          line.line_type === "alteration_service" &&
          line.alteration_intake_id === intake.id,
      );
      if (existing >= 0) {
        return prev.map((line, index) => (index === existing ? serviceLine : line));
      }
      return [...prev, serviceLine];
    });
    setPendingAlterationIntakes((prev) => {
      const existing = prev.findIndex((row) => row.id === intake.id);
      if (existing >= 0) {
        return prev.map((row, index) => (index === existing ? normalizedIntake : row));
      }
      return [...prev, normalizedIntake];
    });
    setSelectedLineKey(rowId);
  }, [setLines, setSelectedLineKey]);

  const removeAlterationIntake = useCallback((intakeId: string) => {
    setPendingAlterationIntakes((prev) => prev.filter((intake) => intake.id !== intakeId));
    setLines((prev) =>
      prev.filter(
        (line) =>
          line.line_type !== "alteration_service" ||
          line.alteration_intake_id !== intakeId,
      ),
    );
  }, [setLines]);

  const removeLineWithAlterationHandling = useCallback((rowId: string) => {
    const line = lines.find((candidate) => candidate.cart_row_id === rowId);
    if (!line) return;
    if (line.line_type === "alteration_service") {
      if (line.alteration_intake_id) removeAlterationIntake(line.alteration_intake_id);
      else removeLine(rowId);
      return;
    }
    const attached = pendingAlterationIntakes.filter(
      (intake) => intake.source_type === "current_cart_item" && intake.cart_row_id === rowId,
    );
    if (attached.length > 0) {
      setSourceRemovalPrompt({ line, intakes: attached });
      return;
    }
    removeLine(rowId);
  }, [lines, pendingAlterationIntakes, removeAlterationIntake, removeLine]);

  const removeSourceLineAndAttachedAlterations = useCallback(() => {
    if (!sourceRemovalPrompt) return;
    const attachedIds = new Set(sourceRemovalPrompt.intakes.map((intake) => intake.id));
    removeLine(sourceRemovalPrompt.line.cart_row_id);
    setPendingAlterationIntakes((prev) => prev.filter((intake) => !attachedIds.has(intake.id)));
    setLines((prev) =>
      prev.filter(
        (line) =>
          line.line_type !== "alteration_service" ||
          !line.alteration_intake_id ||
          !attachedIds.has(line.alteration_intake_id),
      ),
    );
    setSourceRemovalPrompt(null);
  }, [removeLine, setLines, sourceRemovalPrompt]);

  const addOrderPaymentLine = useCallback((order: CustomerOrder, amountCents: number) => {
    if (!selectedCustomer) {
      toast("Select a customer before adding a transaction payment.", "error");
      return;
    }
    const orderCustomerId = order.customer_id ?? selectedCustomer.id;
    if (orderCustomerId !== selectedCustomer.id) {
      toast("That Transaction Record belongs to a different customer. Select the matching customer first.", "error");
      return;
    }
    const balanceCents = parseMoneyToCents(order.balance_due);
    if (amountCents <= 0) {
      toast("Enter a transaction payment amount greater than $0.00.", "error");
      return;
    }
    if (amountCents > balanceCents) {
      toast("Transaction payment cannot be more than the balance due.", "error");
      return;
    }
    const orderPaymentDisplayId = order.order_payment_display_id || order.display_id;
    const nextLine: OrderPaymentCartLine = {
      line_type: "order_payment",
      cart_row_id: newCartRowId(),
      target_transaction_id: order.id,
      target_display_id: orderPaymentDisplayId,
      customer_id: selectedCustomer.id,
      customer_name: `${selectedCustomer.first_name} ${selectedCustomer.last_name}`.trim(),
      amount: centsToFixed2(amountCents),
      balance_before: centsToFixed2(balanceCents),
      projected_balance_after: centsToFixed2(Math.max(0, balanceCents - amountCents)),
    };
    setOrderPaymentLines((prev) => {
      const existing = prev.find((line) => line.target_transaction_id === order.id);
      if (!existing) return [...prev, nextLine];
      toast(`Updated payment amount for ${orderPaymentDisplayId}.`, "info");
      return prev.map((line) =>
        line.target_transaction_id === order.id
          ? { ...nextLine, cart_row_id: line.cart_row_id }
          : line,
      );
    });
    setPickupPaidAmountCents(parseMoneyToCents(order.amount_paid ?? "0"));
    toast(`Transaction payment for ${orderPaymentDisplayId} added to this sale.`, "success");
  }, [selectedCustomer, toast]);

  const addItemToExistingOrder = useCallback(async (order: CustomerOrder, sku: string) => {
    try {
      const scanRes = await fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(sku)}`, {
        headers: apiAuth(),
      });
      if (!scanRes.ok) {
        toast("We couldn't find that SKU. Try scanning it again or search inventory first.", "error");
        return false;
      }
      const resolved = scanPayloadToResolvedItem((await scanRes.json()) as Record<string, unknown>);
      const fulfillment =
        isCustomOrderSku(resolved.sku) || resolved.custom_item_type
          ? "custom"
          : order.order_kind === "wedding_order" || order.wedding_member_id
            ? "wedding_order"
            : "special_order";
      const addRes = await fetch(`${baseUrl}/api/transactions/${order.id}/items`, {
        method: "POST",
        headers: {
          ...apiAuth(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          product_id: resolved.product_id,
          variant_id: resolved.variant_id,
          fulfillment,
          quantity: 1,
          unit_price: centsToFixed2(parseMoneyToCents(resolved.standard_retail_price)),
          unit_cost: centsToFixed2(parseMoneyToCents(resolved.unit_cost)),
          state_tax: centsToFixed2(parseMoneyToCents(resolved.state_tax)),
          local_tax: centsToFixed2(parseMoneyToCents(resolved.local_tax)),
          salesperson_id: primarySalespersonId || undefined,
        }),
      });
      if (!addRes.ok) {
        const payload = (await addRes.json().catch(() => ({}))) as { error?: string };
        toast(payload.error || "We couldn't add that item to the Transaction Record.", "error");
        return false;
      }
      toast("Item added to the original Transaction Record. Booked totals were updated for that record.", "success");
      return true;
    } catch {
      toast("We couldn't add that item to the Transaction Record. Please try again.", "error");
      return false;
    }
  }, [apiAuth, baseUrl, primarySalespersonId, toast]);

  const updateExistingOrderItem = useCallback(
    async (
      order: CustomerOrder,
      item: OrderItem,
      patch: { quantity?: number; unit_price?: string; variant_id?: string; order_lifecycle_status?: string },
    ) => {
      try {
        const res = await fetch(
          `${baseUrl}/api/transactions/${order.id}/items/${item.transaction_line_id}`,
          {
            method: "PATCH",
            headers: {
              ...apiAuth(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(patch),
          },
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          toast(payload.error || "We couldn't update that Transaction Record line.", "error");
          return false;
        }
        toast("Transaction Record line updated. Booked totals were refreshed for that record.", "success");
        return true;
      } catch {
        toast("We couldn't update that Transaction Record line. Please try again.", "error");
        return false;
      }
    },
    [apiAuth, baseUrl, toast],
  );

  const deleteExistingOrderItem = useCallback(
    async (order: CustomerOrder, item: OrderItem) => {
      try {
        const res = await fetch(
          `${baseUrl}/api/transactions/${order.id}/items/${item.transaction_line_id}`,
          {
            method: "DELETE",
            headers: apiAuth(),
          },
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { error?: string };
          toast(payload.error || "We couldn't delete that Transaction Record line.", "error");
          return false;
        }
        toast("Transaction Record line deleted. Booked totals were refreshed for that record.", "success");
        return true;
      } catch {
        toast("We couldn't delete that Transaction Record line. Please try again.", "error");
        return false;
      }
    },
    [apiAuth, baseUrl, toast],
  );

  const openOrderPaymentEdit = useCallback((line: OrderPaymentCartLine) => {
    setEditingOrderPaymentLine(line);
    setEditingOrderPaymentAmount(line.amount);
  }, []);

  const saveOrderPaymentEdit = useCallback(() => {
    if (!editingOrderPaymentLine) return;
    const amountCents = parseMoneyToCents(editingOrderPaymentAmount);
    const balanceCents = parseMoneyToCents(editingOrderPaymentLine.balance_before);
    if (amountCents <= 0) {
      toast("Enter a transaction payment amount greater than $0.00.", "error");
      return;
    }
    if (amountCents > balanceCents) {
      toast("Transaction payment cannot be more than the balance due.", "error");
      return;
    }
    setOrderPaymentLines((prev) =>
      prev.map((line) =>
        line.cart_row_id === editingOrderPaymentLine.cart_row_id
          ? {
              ...line,
              amount: centsToFixed2(amountCents),
              projected_balance_after: centsToFixed2(Math.max(0, balanceCents - amountCents)),
            }
          : line,
      ),
    );
    setEditingOrderPaymentLine(null);
    setEditingOrderPaymentAmount("");
  }, [editingOrderPaymentAmount, editingOrderPaymentLine, toast]);

  const keepAlterationsAsCustomAndRemoveSource = useCallback(() => {
    if (!sourceRemovalPrompt) return;
    const attachedIds = new Set(sourceRemovalPrompt.intakes.map((intake) => intake.id));
    setPendingAlterationIntakes((prev) =>
      prev.map((intake) =>
        attachedIds.has(intake.id)
          ? {
              ...intake,
              source_type: "custom_item",
              cart_row_id: null,
              source_product_id: null,
              source_variant_id: null,
              source_sku: null,
            }
          : intake,
      ),
    );
    setLines((prev) =>
      prev.map((line) =>
        line.line_type === "alteration_service" &&
        line.alteration_intake_id &&
        attachedIds.has(line.alteration_intake_id)
          ? { ...line, alteration_source_cart_row_id: null }
          : line,
      ),
    );
    removeLine(sourceRemovalPrompt.line.cart_row_id);
    setSourceRemovalPrompt(null);
  }, [removeLine, setLines, sourceRemovalPrompt]);

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
        if (l.transaction_line_id) {
          return acc;
        }

        const pC = parseMoneyToCents(l.standard_retail_price);
        const forceNonTaxable = isNonTaxableServiceLine(l);
        const stC = forceNonTaxable ? 0 : parseMoneyToCents(l.state_tax);
        const ltC = forceNonTaxable ? 0 : parseMoneyToCents(l.local_tax);
        const qty = l.quantity;

        acc.subtotalCents += pC * qty;
        acc.stateTaxCents += stC * qty;
        acc.localTaxCents += ltC * qty;
        if (l.line_type !== "alteration_service") {
          acc.totalPieces += qty;
        }
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
      disbCents += weddingDisbursementAmountCents(m);
    });
    const orderPaymentCents = orderPaymentLines.reduce(
      (sum, line) => sum + parseMoneyToCents(line.amount),
      0,
    );

    const taxCents = res.stateTaxCents + res.localTaxCents;
    const shipCents = posShipping?.amount_cents ?? 0;
    const orderTotalCents = res.subtotalCents + taxCents + shipCents;
    const collectTotalCents = orderTotalCents + disbCents + orderPaymentCents;

    return {
      subtotalCents: res.subtotalCents,
      stateTaxCents: res.stateTaxCents,
      localTaxCents: res.localTaxCents,
      totalPieces: res.totalPieces,
      taxCents,
      orderTotalCents,
      orderPaymentCents,
      collectTotalCents,
      shippingCents: shipCents,
      takeawayDueCents: res.takeawayDueCents + shipCents,
      totalCents: collectTotalCents,
    };
  }, [lines, disbursementMembers, orderPaymentLines, posShipping]);

  const isGiftCardOnlyCart = useMemo(() => lines.length > 0 && lines.every(l => !!l.gift_card_load_code), [lines]);
  const hasCheckoutWork = lines.length > 0 || orderPaymentLines.length > 0 || disbursementMembers.length > 0 || Boolean(posShipping);
  const pendingReturnTender = useMemo(() => {
    const returnLines = lines.filter((line) => line.return_tender_original_transaction_id);
    if (returnLines.length === 0) return null;
    const originalTransactionId = returnLines[0].return_tender_original_transaction_id ?? "";
    if (!originalTransactionId) return null;
    const refundAmountCents = returnLines.reduce((sum, line) => {
      if (typeof line.return_tender_refund_cents === "number" && line.return_tender_refund_cents > 0) {
        return sum + line.return_tender_refund_cents;
      }
      const lineCents =
        parseMoneyToCents(line.standard_retail_price) * line.quantity +
        parseMoneyToCents(line.state_tax) * line.quantity +
        parseMoneyToCents(line.local_tax) * line.quantity;
      return sum + Math.abs(lineCents);
    }, 0);
    return {
      originalTransactionId,
      receiptLabel: returnLines[0].return_tender_receipt_label ?? originalTransactionId.slice(0, 8).toUpperCase(),
      refundAmountCents,
      returnLines: pendingReturnLineDrafts[originalTransactionId] ?? [],
      returnOnly: returnLines.length === lines.length && orderPaymentLines.length === 0,
    };
  }, [lines, orderPaymentLines.length, pendingReturnLineDrafts]);
  useEffect(() => {
    if (!pendingReturnTender || orderPaymentLines.length === 0) return;
    setOrderPaymentLines([]);
    setEditingOrderPaymentLine(null);
    setEditingOrderPaymentAmount("");
  }, [orderPaymentLines.length, pendingReturnTender]);
  const hasSalespersonAttribution = useCallback(() => {
    if (isEmployeeSale) return true;
    return (
      primarySalespersonId.trim() !== "" ||
      lines.some((l) => (l.salesperson_id?.trim() ?? "") !== "")
    );
  }, [isEmployeeSale, lines, primarySalespersonId]);

  const belowCostManualDiscountLines = useMemo(() => {
    const automaticReasons = new Set([
      "customer profile discount",
      "employee discount",
      "custom_order_booking",
      "pending_return_refund",
      "alteration_service",
      "wedding promo (free suit selection)",
    ]);
    return lines
      .filter((line) => {
        const reason = line.price_override_reason?.trim();
        if (!reason || automaticReasons.has(reason.toLowerCase())) return false;
        if (line.discount_event_id) return false;
        if (line.gift_card_load_code) return false;
        if (line.quantity <= 0) return false;
        if (line.line_type === "alteration_service" || line.fulfillment === "custom") {
          return false;
        }
        const unitCents = parseMoneyToCents(line.standard_retail_price);
        const costCents = parseMoneyToCents(line.unit_cost);
        return costCents <= 0 || unitCents < costCents;
      })
      .map((line) => ({
        cartRowId: line.cart_row_id,
        variantId: line.variant_id,
        sku: line.sku,
        name: line.name,
        reason: line.price_override_reason?.trim() || "Manual discount",
        unitCents: parseMoneyToCents(line.standard_retail_price),
        costCents: parseMoneyToCents(line.unit_cost),
      }));
  }, [lines]);

  const belowCostLineSignature = useMemo(
    () =>
      belowCostManualDiscountLines
        .map(
          (line) =>
            `${line.cartRowId}:${line.variantId}:${line.unitCents}:${line.costCents}:${line.reason}`,
        )
        .join("|"),
    [belowCostManualDiscountLines],
  );

  useEffect(() => {
    if (
      belowCostApproval &&
      belowCostApproval.lineSignature !== belowCostLineSignature
    ) {
      setBelowCostApproval(null);
    }
  }, [belowCostApproval, belowCostLineSignature]);

  const activeBelowCostApproval =
    belowCostApproval?.lineSignature === belowCostLineSignature
      ? belowCostApproval
      : null;

  const openCheckoutDrawerWithGuard = useCallback(() => {
    if (belowCostManualDiscountLines.length > 0 && !activeBelowCostApproval) {
      setBelowCostApprovalPromptOpen(true);
      return;
    }
    setCheckoutDrawerOpen(true);
  }, [activeBelowCostApproval, belowCostManualDiscountLines.length]);

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
    return (
      checkoutOperator?.staffId ||
      (backofficeHeaders() as Record<string, string>)["x-riverside-staff-id"] ||
      null
    );
  }, [backofficeHeaders, checkoutOperator?.staffId]);

  const requestPickupPaymentOverride = useCallback((message: string) => {
    return new Promise<NonNullable<PosOrderOptions["pickupPaymentOverride"]> | null>((resolve) => {
      setPickupDepositApprovalRequest((previous) => {
        previous?.resolve(null);
        return { message, resolve };
      });
    });
  }, []);

  // --- Checkout Hook ---
  const {
    executeCheckout,
    checkoutBusy,
    lastTransactionId: checkoutTransactionId,
    lastCashChangeDueCents,
    lastReceiptTransactionLineIds,
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
    pendingAlterationIntakes,
    orderPaymentLines,
    pickupAlterationIds: pickupReadyAlterations.map((alteration) => alteration.id),
    pickupConfirmed,
    pickupTransactionId,
    belowCostApproval: activeBelowCostApproval
      ? {
          approvedByStaffId: activeBelowCostApproval.approvedByStaffId,
          reason: activeBelowCostApproval.reason,
          lineSignature: activeBelowCostApproval.lineSignature,
        }
      : null,
    saleDateTimeLocal,
    totals,
    toast,
    clearCart: clearCartAndAlterations,
    onSaleCompleted,
    ensurePosTokenForSession,
    requestPickupPaymentOverride,
  });
  useEffect(() => {
    if (checkoutTransactionId) {
      setLastTransactionId(checkoutTransactionId);
      setCheckoutDrawerOpen(false);
      resetSaleDateTime();
      onRegisterTransactionCommitted?.();
    }
  }, [checkoutTransactionId, onRegisterTransactionCommitted, resetSaleDateTime]);

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
    clearCart: clearCartAndAlterations,
    isReady: !!checkoutOperator,
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
    disbursementMembers,
    posShipping,
    primarySalespersonId,
    checkoutOperator,
    pendingAlterationIntakes,
    orderPaymentLines,
    setLines,
    setSelectedCustomer,
    setActiveWeddingMember,
    setActiveWeddingPartyName,
    setDisbursementMembers,
    setPosShipping,
    setPrimarySalespersonId,
    setCheckoutOperator,
    setPendingAlterationIntakes,
    setOrderPaymentLines,
    clearCart: clearCartAndAlterations,
  });

  useEffect(() => {
    const sku = pendingInventorySku?.trim();
    if (!sku || !saleHydrated || !checkoutOperator) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/inventory/scan/${encodeURIComponent(sku)}`,
          { headers: apiAuth() },
        );
        if (!res.ok) {
          toast("We couldn't add that inventory item to the sale. Try searching again or scan the SKU.", "error");
          return;
        }
        const payload = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        addItem(scanPayloadToResolvedItem(payload) as SearchResult);
      } catch {
        if (!cancelled) {
          toast("We couldn't add that inventory item to the sale. Please try again.", "error");
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
    checkoutOperator,
    baseUrl,
    apiAuth,
    addItem,
    toast,
    onPendingInventorySkuConsumed,
  ]);

  // pendingExchangeOriginalOrderIdRef removed
  const actionRibbonRef = useRef<HTMLDivElement | null>(null);
  const didInitialProductSearchFocusRef = useRef(false);
  const initialTransactionApplyingRef = useRef<string | null>(null);
  const initialTransactionAppliedRef = useRef<string | null>(null);
  const [actionRibbonCanScrollLeft, setActionRibbonCanScrollLeft] = useState(false);
  const [actionRibbonCanScrollRight, setActionRibbonCanScrollRight] = useState(false);
  const [exchangeWizardOpen, setExchangeWizardOpen] = useState(false);
  const [exchangeWizardInitialReturnLineId, setExchangeWizardInitialReturnLineId] = useState<string | null>(null);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);

  const updateActionRibbonScrollState = useCallback(() => {
    const ribbon = actionRibbonRef.current;
    if (!ribbon) {
      setActionRibbonCanScrollLeft(false);
      setActionRibbonCanScrollRight(false);
      return;
    }
    const maxScrollLeft = ribbon.scrollWidth - ribbon.clientWidth;
    setActionRibbonCanScrollLeft(ribbon.scrollLeft > 1);
    setActionRibbonCanScrollRight(ribbon.scrollLeft < maxScrollLeft - 1);
  }, []);

  const scrollActionRibbon = useCallback((direction: "left" | "right" | "start" | "end") => {
    const ribbon = actionRibbonRef.current;
    if (!ribbon) return;
    if (direction === "start" || direction === "end") {
      ribbon.scrollTo({
        left: direction === "start" ? 0 : ribbon.scrollWidth,
        behavior: "smooth",
      });
      window.requestAnimationFrame(updateActionRibbonScrollState);
      return;
    }
    ribbon.scrollBy({
      left: direction === "left" ? -ribbon.clientWidth * 0.75 : ribbon.clientWidth * 0.75,
      behavior: "smooth",
    });
    window.requestAnimationFrame(updateActionRibbonScrollState);
  }, [updateActionRibbonScrollState]);

  useEffect(() => {
    updateActionRibbonScrollState();
    const ribbon = actionRibbonRef.current;
    if (!ribbon) return;
    const handleResize = () => updateActionRibbonScrollState();
    ribbon.addEventListener("scroll", updateActionRibbonScrollState, { passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      ribbon.removeEventListener("scroll", updateActionRibbonScrollState);
      window.removeEventListener("resize", handleResize);
    };
  }, [updateActionRibbonScrollState]);

  const handleTransactionBarcode = useCallback(async (receiptCode: string) => {
    try {
      const normalizedCode = receiptCode.trim();
      const shortId = normalizedCode.replace(/^TXN-/i, "");
      const res = await fetch(`${baseUrl}/api/transactions?search=${encodeURIComponent(normalizedCode)}&limit=5`, { headers: apiAuth() as Record<string, string> });
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const txn = items.find((i: { transaction_id: string; display_id: string; status: string; customer_id?: string }) =>
        (i.display_id || "").toLowerCase() === normalizedCode.toLowerCase() ||
        (i.transaction_id || "").toLowerCase().startsWith(shortId.toLowerCase()) ||
        (i.display_id || "").toLowerCase().includes(shortId.toLowerCase())
      );
      if (!txn) {
        toast("Receipt barcode not found in the system.", "error");
        return;
      }
      if ((txn.status || "").toLowerCase() === "fulfilled") {
        setExchangeWizardInitialTransactionId(txn.transaction_id);
        setExchangeWizardInitialReturnLineId(null);
        setExchangeWizardOpen(true);
      } else {
        if (txn.customer_id) {
          const cRes = await fetch(`${baseUrl}/api/customers/${txn.customer_id}`, { headers: apiAuth() as Record<string, string> });
          if (cRes.ok) {
            const c = await cRes.json();
            setSelectedCustomer({
              id: String(c.id),
              first_name: c.first_name,
              last_name: c.last_name,
              customer_code: c.customer_code ?? "",
              company_name: c.company_name ?? null,
              email: c.email ?? null,
              phone: c.phone ?? null,
              profile_discount_percent: c.profile_discount_percent,
              employee_discount_eligible: c.employee_discount_eligible,
              tax_exempt: c.tax_exempt,
              tax_exempt_id: c.tax_exempt_id,
            });
            setOrderLoadOpen(true);
          } else {
            toast("Could not load the customer for this transaction.", "error");
          }
        } else {
          toast("Transaction has no customer attached.", "error");
        }
      }
    } catch {
      toast("Failed to look up receipt barcode", "error");
    }
  }, [baseUrl, apiAuth, toast, setSelectedCustomer]);

  // --- Staff PIN Verification Logic ---
  const [salePinBusy, setSalePinBusy] = useState(false);

  const verifySalePin = useCallback(async () => {
    if (!salePinCredential) {
      setSalePinError("Please enter your Access PIN.");
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
        await res.json().catch(() => ({}));
        if (res.status === 404) {
          setSalePinError("Staff sign-in is unavailable. Try again or call a manager.");
        } else if (res.status === 401 || res.status === 403) {
          setSalePinError("Invalid Access PIN.");
        } else {
          setSalePinError("Staff sign-in is unavailable. Try again or call a manager.");
        }
      }
    } catch {
      setSalePinError("Staff sign-in is unavailable. Try again or call a manager.");
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
  const [showReadinessOverrideModal, setShowReadinessOverrideModal] = useState(false);
  const [managerOverrideApproved, setManagerOverrideApproved] = useState(false);
  const [managerOverrideReason, setManagerOverrideReason] = useState("");
  const [pickupDepositApprovalRequest, setPickupDepositApprovalRequest] = useState<{
    message: string;
    resolve: (approval: NonNullable<PosOrderOptions["pickupPaymentOverride"]> | null) => void;
  } | null>(null);
  const [discountPrompt, setDiscountPrompt] = useState<{
    variantId: string;
    nextPriceCents: number;
    originalPriceCents: number;
    reason: string;
  } | null>(null);
  const [suitSwapWizardOpen, setSuitSwapWizardOpen] = useState(false);
  const [showSuitSwapApproval, setShowSuitSwapApproval] = useState(false);
  // roleMaxDiscountPct moved up

  const [posStaffList, setPosStaffList] = useState<PosStaffRow[]>([]);


  const commissionStaff = useMemo(
    () => posStaffList.filter((s) => s.role === "salesperson"),
    [posStaffList],
  );

  const primarySalespersonLabel = useMemo(() => {
    const id = primarySalespersonId.trim();
    if (!id) return "";
    return commissionStaff.find((s) => s.id === id)?.full_name ?? "";
  }, [commissionStaff, primarySalespersonId]);

  const hasLineSalespersonOverrides = useMemo(
    () => lines.some((line) => (line.salesperson_id?.trim() ?? "") !== ""),
    [lines],
  );

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
      } catch {
        console.warn("POS pre-fetch: RMS payment line meta unavailable");
      }
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
      } catch {
        console.warn("POS pre-fetch: gift card load line meta unavailable");
      }
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
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos?include_system_attribution=true`, { headers: h });
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

  const loadTransactionIntoRegister = useCallback(
    async (
      transactionId: string,
      forPickup: boolean = false,
      forRefund: boolean = false,
      pickupLineIds?: string[],
      returnLineId?: string | null,
    ) => {
      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        toast("We couldn't load that transaction into the register. Please try again.", "error");
        return false;
      }

      const detail = (await res.json()) as HandoffOrderDetail;

      if (forRefund) {
        if (!detail.customer) {
          toast("This Transaction Record has no customer attached, so it cannot be loaded for refund.", "error");
          return false;
        }

        setSelectedCustomer({
          id: detail.customer.id,
          customer_code: detail.customer.customer_code ?? "",
          first_name: detail.customer.first_name,
          last_name: detail.customer.last_name,
          company_name: detail.customer.company_name ?? null,
          email: detail.customer.email ?? null,
          phone: detail.customer.phone ?? null,
        });

        // Clear everything else
        setLines([]);
        setCheckoutAppliedPayments([]);
        setCheckoutDepositLedger("");
        setOrderPaymentLines([]);
        setEditingOrderPaymentLine(null);
        setEditingOrderPaymentAmount("");
        setPosShipping(null);

        if (returnLineId) {
          setExchangeWizardInitialTransactionId(detail.transaction_id);
          setExchangeWizardInitialReturnLineId(returnLineId);
          setExchangeWizardOpen(true);
          toast("Return item loaded. Confirm the quantity and choose refund or exchange.", "success");
          return true;
        }

        const refundAmountCents = parseMoneyToCents(detail.amount_paid ?? "0");
        if (refundAmountCents <= 0) {
          toast("No refundable paid amount exists on this transaction.", "error");
          return false;
        }

        const receiptLabel = detail.transaction_display_id ?? detail.transaction_id.slice(0, 8).toUpperCase();
        const rowId = newCartRowId();

        const firstItem = detail.items?.[0];
        const productId = firstItem?.product_id || "00000000-0000-0000-0000-000000000000";
        const variantId = firstItem?.variant_id || "00000000-0000-0000-0000-000000000000";
        const itemLabel = firstItem ? firstItem.product_name : "Voided transaction items";

        const refundCreditLine: CartLineItem = {
          product_id: productId,
          variant_id: variantId,
          sku: `RETURN-${receiptLabel}`,
          name: `Refund credit ${receiptLabel}`,
          variation_label: itemLabel,
          standard_retail_price: centsToFixed2(refundAmountCents),
          unit_cost: "0.00",
          state_tax: "0.00",
          local_tax: "0.00",
          tax_category: "other",
          quantity: -1,
          fulfillment: "takeaway",
          cart_row_id: rowId,
          price_override_reason: "pending_return_refund",
          original_unit_price: centsToFixed2(refundAmountCents),
          return_tender_original_transaction_id: detail.transaction_id,
          return_tender_receipt_label: receiptLabel,
          return_tender_refund_cents: refundAmountCents,
        };

        setLines([refundCreditLine]);
        setSelectedLineKey(rowId);

        setCheckoutDrawerOpen(true);
        toast(`Refund credit for ${receiptLabel} loaded. Select the refund tender to finish the void.`, "success");
        return true;
      }

      const requestedPickupLineIds = new Set(
        forPickup ? (pickupLineIds ?? []).filter(Boolean) : [],
      );
      const unfulfilled = (detail.items ?? []).filter(
        (item) =>
          !item.is_fulfilled &&
          !item.is_internal &&
          (requestedPickupLineIds.size === 0 ||
            requestedPickupLineIds.has(item.transaction_line_id)),
      );

      if (unfulfilled.length === 0) {
        if (forPickup) {
          setPickupTransactionId(null);
          setManagerOverrideApproved(false);
          setManagerOverrideReason("");
          toast(
            "This order has no open lines available for pickup. It may already be picked up or closed.",
            "info",
          );
          return false;
        }
        setExchangeWizardOpen(false);
        setExchangeWizardInitialTransactionId(null);
        setExchangeWizardInitialReturnLineId(null);
        toast(
          "This order has no open order lines to load. Use the Register Return button only if the customer is returning or exchanging items.",
          "info",
        );
        return false;
      }

      if (!detail.customer) {
        toast("This Transaction Record has no customer attached, so it cannot be reopened from the customer order menu.", "error");
        return false;
      }

      setSelectedCustomer({
        id: detail.customer.id,
        customer_code: detail.customer.customer_code ?? "",
        first_name: detail.customer.first_name,
        last_name: detail.customer.last_name,
        company_name: detail.customer.company_name ?? null,
        email: detail.customer.email ?? null,
        phone: detail.customer.phone ?? null,
      });

      if (forPickup) {
        // Pickup mode: load unfulfilled items into cart
        setExchangeWizardOpen(false);
        setExchangeWizardInitialTransactionId(null);
        setExchangeWizardInitialReturnLineId(null);
        setPickupTransactionId(detail.transaction_id);
        setPickupPaidAmountCents(parseMoneyToCents(detail.amount_paid ?? "0"));
        setPickupReadyAlterations((detail.linked_alterations ?? []).filter((alteration) => alteration.status === "ready"));
        setManagerOverrideApproved(false);
        setManagerOverrideReason("");
        const balanceDueCents = parseMoneyToCents(detail.balance_due ?? "0");

        if (detail.primary_salesperson_id) {
          setPrimarySalespersonId(detail.primary_salesperson_id);
        }

        // Add unfulfilled items to cart
        const cartLines: CartLineItem[] = unfulfilled.map((item) => ({
          product_id: item.product_id,
          variant_id: item.variant_id,
          sku: item.sku,
          name: item.product_name,
          variation_label: item.variation_label ?? null,
          standard_retail_price: item.unit_price,
          unit_cost: item.unit_cost ?? "0.00",
          state_tax: item.state_tax ?? "0.00",
          local_tax: item.local_tax ?? "0.00",
          tax_category: "other",
          quantity: item.quantity,
          fulfillment: item.fulfillment as FulfillmentKind,
          cart_row_id: newCartRowId(),
          transaction_line_id: item.transaction_line_id,
          salesperson_id: item.salesperson_id || null,
          line_type: item.custom_item_type === "alteration_service" ? "alteration_service" : "merchandise",
          custom_item_type: item.custom_item_type || undefined,
          custom_order_details: item.custom_order_details ?? null,
          order_lifecycle_status: item.order_lifecycle_status as OrderLifecycleStatus | undefined,
        }));

        setLines(cartLines);

        // If balance due, add order payment line
        if (balanceDueCents > 0) {
          const customerName = `${detail.customer.first_name} ${detail.customer.last_name}`.trim();
          const orderPaymentLine: OrderPaymentCartLine = {
            line_type: "order_payment",
            cart_row_id: newCartRowId(),
            target_transaction_id: detail.transaction_id,
            target_display_id: detail.transaction_display_id ?? detail.transaction_id.slice(0, 8).toUpperCase(),
            customer_id: detail.customer.id,
            customer_name: customerName || detail.customer.first_name || "Customer",
            amount: centsToFixed2(balanceDueCents),
            balance_before: detail.balance_due ?? "0.00",
            projected_balance_after: "0.00",
          };
          setOrderPaymentLines([orderPaymentLine]);
        } else {
          setOrderPaymentLines([]);
        }

        toast(
          `Loaded ${unfulfilled.length} pickup item(s) from ${detail.transaction_display_id ?? "transaction"}. ${balanceDueCents > 0 ? "Balance due added to cart." : "No balance due."}`,
          "success",
        );
        return true;
      }

      // Normal mode: open OrderLoadModal
      setPickupReadyAlterations([]);
      setOrderLoadOpen(true);
      toast(
        `Opened ${detail.transaction_display_id ?? "transaction"} in Customer Orders. Add payments or edit the original order there; ROS will not start a new sale for this order.`,
        "info",
      );
      return true;
    },
    [
      apiAuth,
      baseUrl,
      setSelectedCustomer,
      toast,
      setLines,
      setOrderPaymentLines,
      setPrimarySalespersonId,
      setSelectedLineKey,
      setCheckoutDrawerOpen,
      setCheckoutAppliedPayments,
      setCheckoutDepositLedger,
      setEditingOrderPaymentLine,
      setEditingOrderPaymentAmount,
      setPosShipping,
    ],
  );

  const handleManagerApproveReadiness = useCallback(async (pin: string, managerId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          pin,
          staff_id: managerId,
          authorize_action: "pos_pickup_readiness_override",
          authorize_metadata: {
            transaction_id: pickupTransactionId,
            item_count: lines.filter(l => l.transaction_line_id && l.order_lifecycle_status !== "ready_for_pickup").length,
          }
        }),
      });
      if (res.ok) {
        setManagerOverrideApproved(true);
        setManagerOverrideReason("Register pickup override: manager approved release for unready items.");
        setShowReadinessOverrideModal(false);
        // Open checkout drawer
        setCheckoutDrawerOpen(true);
        toast("Manager override approved", "success");
        return true;
      } else {
        toast("Manager approval failed. Check the Access PIN and try again.", "error");
        return false;
      }
    } catch {
      toast("Manager approval is unavailable. Try again or call a manager.", "error");
      return false;
    }
  }, [baseUrl, apiAuth, pickupTransactionId, lines, toast]);

  const closePickupPaymentOverride = useCallback(() => {
    setPickupDepositApprovalRequest((request) => {
      request?.resolve(null);
      return null;
    });
  }, []);

  const handleManagerApprovePickupPayment = useCallback(async (pin: string, managerId: string) => {
    const request = pickupDepositApprovalRequest;
    if (!request) return false;
    const reason = "Manager approved pickup release with remaining open items below the standard 50% deposit.";
    try {
      const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          pin,
          staff_id: managerId,
          authorize_action: "pos_pickup_payment_override",
          authorize_metadata: {
            transaction_id: pickupTransactionId,
            reason,
          },
        }),
      });
      if (!res.ok) {
        toast("Manager approval failed. Check the Access PIN and try again.", "error");
        return false;
      }
      request.resolve({
        managerStaffId: managerId,
        managerPin: pin,
        reason,
      });
      setPickupDepositApprovalRequest(null);
      toast("Manager payment override approved", "success");
      return true;
    } catch {
      toast("Manager approval failed. Check the Main Hub connection and try again.", "error");
      return false;
    }
  }, [apiAuth, baseUrl, pickupDepositApprovalRequest, pickupTransactionId, toast]);

  useEffect(() => {
    if (!initialTransactionId) {
      return;
    }
    if (!saleHydrated) return;
    const initialTransactionApplyKey = [
      initialTransactionId,
      initialTransactionForPickup ? "pickup" : "open",
      initialTransactionForRefund ? "refund" : "sale",
      initialTransactionReturnLineId ?? "",
    ].join(":");
    if (
      initialTransactionApplyingRef.current === initialTransactionApplyKey ||
      initialTransactionAppliedRef.current === initialTransactionApplyKey
    ) {
      return;
    }
    initialTransactionApplyingRef.current = initialTransactionApplyKey;
    void (async () => {
      await loadTransactionIntoRegister(
        initialTransactionId,
        initialTransactionForPickup,
        initialTransactionForRefund,
        undefined,
        initialTransactionReturnLineId,
      );
      initialTransactionAppliedRef.current = initialTransactionApplyKey;
      if (initialTransactionApplyingRef.current === initialTransactionApplyKey) {
        initialTransactionApplyingRef.current = null;
      }
      onInitialTransactionConsumed?.();
    })();
  }, [initialTransactionId, initialTransactionForPickup, initialTransactionForRefund, initialTransactionReturnLineId, loadTransactionIntoRegister, onInitialTransactionConsumed, saleHydrated]);

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
            profile_discount_percent: c.profile_discount_percent,
            employee_discount_eligible: c.employee_discount_eligible,
            tax_exempt: c.tax_exempt,
            tax_exempt_id: c.tax_exempt_id,
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
    if (item.sku === "ROS-ALTERATION-FEE" || item.sku === "ROS-SHIPPING-FEE") {
      setSearch("");
      setSearchResults([]);
      setFeePromptKind(item.sku === "ROS-ALTERATION-FEE" ? "alterations" : "shipping");
      return;
    }
    handleSearchResultClick(item, searchResults, search, setActiveVariationSelection);
  };

  const scannerOverlayOpen = useMemo(
    () =>
      !checkoutOperator ||
      checkoutDrawerOpen ||
      exchangeWizardOpen ||
      weddingDrawerOpen ||
      measDrawerOpen ||
      customerProfileHubOpen ||
      cashAdjustOpen ||
      giftCardLoadOpen ||
      feePromptKind !== null ||
      activeVariationSelection !== null ||
      showClearConfirm ||
      showWalkinConfirm ||
      showVoidAllConfirm ||
      discountPrompt !== null ||
      intelligenceVariantId !== null ||
      lastTransactionId !== null,
    [
      checkoutOperator, checkoutDrawerOpen, exchangeWizardOpen,
      weddingDrawerOpen, measDrawerOpen, customerProfileHubOpen, cashAdjustOpen,
      giftCardLoadOpen, feePromptKind, activeVariationSelection, showClearConfirm, showWalkinConfirm,
      showVoidAllConfirm, discountPrompt, intelligenceVariantId, lastTransactionId,
    ],
  );

  useScanner({
    onScan: (code) => {
      const trimmed = code.trim();
      const txnMatch = trimmed.match(/^TXN-[A-Za-z0-9][A-Za-z0-9-]{2,}$/i);
      if (txnMatch) {
         void handleTransactionBarcode(trimmed);
      } else {
         handleLaserScan(code, runSearch);
      }
    },
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

  const focusProductSearch = useCallback(() => {
    if (!saleHydrated || !checkoutOperator || scannerOverlayOpen) return;
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [saleHydrated, checkoutOperator, scannerOverlayOpen]);

  useEffect(() => {
    if (!saleHydrated || !checkoutOperator) return;
    const refocusSearch = () => {
      if (document.visibilityState !== "visible") return;
      focusProductSearch();
    };
    window.addEventListener("focus", refocusSearch);
    document.addEventListener("visibilitychange", refocusSearch);
    return () => {
      window.removeEventListener("focus", refocusSearch);
      document.removeEventListener("visibilitychange", refocusSearch);
    };
  }, [saleHydrated, checkoutOperator, focusProductSearch]);

  useEffect(() => {
    if (!saleHydrated || !checkoutOperator || scannerOverlayOpen) return;

    const handleSearchShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tagName = target.tagName.toLowerCase();
        if (
          tagName === "input" ||
          tagName === "textarea" ||
          tagName === "select" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      if (event.key !== "/") return;
      event.preventDefault();
      focusProductSearch();
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [saleHydrated, checkoutOperator, scannerOverlayOpen, focusProductSearch]);

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
    <div
      className="relative grid h-full min-h-0 w-full overflow-hidden bg-app-bg lg:[grid-template-columns:minmax(0,1fr)_clamp(300px,28vw,376px)]"
      data-testid="pos-register-cart-shell"
      data-sale-hydrated={saleHydrated ? "true" : "false"}
      data-cashier-blocked={!checkoutOperator ? "true" : "false"}
      data-register-ready={saleHydrated && !!checkoutOperator ? "true" : "false"}
      onPointerDownCapture={() => onCartInteraction?.()}
      onFocusCapture={() => onCartInteraction?.()}
    >
      {checkoutDrawerOpen ? (
        <div
          className="pointer-events-none absolute inset-0 z-[95] bg-black/25"
          aria-hidden
        />
      ) : null}
      <div className="relative z-0 flex min-h-0 min-w-0 flex-col border-r border-app-border">
        <div className="shrink-0 border-b border-app-border bg-app-surface px-3 py-2 shadow-sm sm:px-4 lg:px-6 lg:py-3">
          <div className="space-y-2 rounded-2xl border border-app-border/90 bg-[color-mix(in_srgb,var(--app-surface)_90%,var(--app-surface-2))] p-2.5 shadow-[0_14px_40px_-24px_rgba(15,23,42,0.22)]">
            {/* Wedding link badge */}
            {activeWeddingMember && (
              <div className="flex items-center justify-between rounded-xl border border-app-accent/30 bg-app-accent/5 p-2 animate-in slide-in-from-top duration-300">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-app-accent text-white shadow-lg shadow-app-accent/20">
                  <WEDDINGS_ICON size={14} />
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

          {(activeWeddingMember || parkedRows.length > 0 || pendingAlterationIntakes.length > 0 || pickupReadyAlterations.length > 0 || offlineQueueCount > 0 || failedPrintCount > 0) ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-app-border/70 bg-app-surface px-2.5 py-1.5 text-[10px] font-bold text-app-text-muted">
              {activeWeddingMember ? (
                <span className="inline-flex items-center gap-1 rounded-lg border border-app-accent/25 bg-app-accent/10 px-2 py-1 font-black uppercase tracking-widest text-app-accent">
                  <WEDDINGS_ICON size={12} aria-hidden />
                  {activeWeddingMember.first_name} {activeWeddingMember.last_name}
                </span>
              ) : null}
              {parkedRows.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setParkedListOpen(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                >
                  <Clock size={12} aria-hidden />
                  {parkedRows.length} parked
                </button>
              ) : null}
              {pendingAlterationIntakes.length > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-lg border border-app-accent/20 bg-app-accent/10 px-2 py-1 font-black uppercase tracking-widest text-app-accent">
                  <Scissors size={12} aria-hidden />
                  {pendingAlterationIntakes.length} intake{pendingAlterationIntakes.length === 1 ? "" : "s"} pending checkout
                </span>
              ) : null}
              {pickupReadyAlterations.length > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-lg border border-app-success/25 bg-app-success/10 px-2 py-1 font-black uppercase tracking-widest text-app-success">
                  <Scissors size={12} aria-hidden />
                  {pickupReadyAlterations.length} alteration pickup{pickupReadyAlterations.length === 1 ? "" : "s"} included
                </span>
              ) : null}
              {offlineQueueCount > 0 ? (
                <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 font-black uppercase tracking-widest ${offlineBlockedCount > 0 ? "border-app-danger/25 bg-app-danger/10 text-app-danger" : "border-app-warning/25 bg-app-warning/10 text-app-warning"}`}>
                  <AlertTriangle size={12} aria-hidden />
                  {offlineBlockedCount > 0
                    ? `${offlineBlockedCount} checkout recovery item${offlineBlockedCount === 1 ? "" : "s"}`
                    : `${offlineQueueCount} syncing`}
                </span>
              ) : null}
              {failedPrintCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowPrintRetryPanel(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-app-danger/25 bg-app-danger/10 px-2 py-1 font-black uppercase tracking-widest text-app-danger hover:bg-app-danger/20"
                >
                  <Printer size={12} aria-hidden />
                  {failedPrintCount} print retry
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Staff Access + default salesperson on one row after sign-in. */}
          {checkoutOperator ? (
            <div className="flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border/70 bg-app-surface-2/70 px-3 py-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Staff:
                </span>
                <span className="min-w-0 truncate text-xs font-black text-app-text">
                  {checkoutOperator.fullName}
                </span>
                {lines.length === 0 ? (
                  <button
                    type="button"
                    className="ui-btn-secondary h-8 shrink-0 px-2 text-[9px] font-black uppercase tracking-widest"
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
                isEmployeeSale ? (
                  <div className="flex min-w-[18rem] flex-1 items-center justify-center gap-2">
                    <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Salesperson:
                    </span>
                    <span className="inline-flex h-9 min-w-[12rem] items-center justify-center rounded-xl border-2 border-app-success/25 bg-app-success/10 px-4 text-sm font-black uppercase tracking-widest text-app-success">
                      Employee Sale
                    </span>
                  </div>
                ) : (
                  <label className="flex min-w-[18rem] flex-1 items-center justify-center gap-2">
                    <span className="shrink-0 text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Salesperson:
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
                      displayLabel={hasLineSalespersonOverrides ? "SPLIT" : undefined}
                      className="min-w-[12rem]"
                    />
                  </label>
                )
              ) : null}
              <PosRegisterLiveClock
                timeZone={receiptTimezone}
                overrideLocalDateTime={saleDateTimeLocal}
                onOverrideChange={setSaleDateTimeLocal}
              />
            </div>
          ) : null}

          {/* Product search */}
          <div
            className="relative w-full rounded-2xl border border-app-border bg-app-surface p-1.5 shadow-sm"
            onBlur={(event) => {
              const nextFocus = event.relatedTarget;
              if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) {
                return;
              }
              setSearchResults([]);
            }}
          >
            <Search
              className="absolute left-5 top-1/2 size-[22px] -translate-y-1/2 text-app-accent"
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
                runSearch(search).then(results => {
                  if (!results) return;
                  const exact = results.filter(r => r.sku.toLowerCase() === q.toLowerCase() || r.vendor_sku?.toLowerCase() === q.toLowerCase());
                  if (exact.length === 1) {
                    addItem(exact[0]);
                  }
                }).catch(() => {});
              }}
              className="ui-input h-14 w-full rounded-xl border-2 border-app-border bg-app-surface-2 pl-12 pr-32 text-lg font-black shadow-inner focus:border-app-accent focus:bg-app-surface"
            />
            <button
              type="button"
              onClick={focusProductSearch}
              title="Focus product search (/)"
              className="ui-touch-target absolute right-3 top-1/2 z-10 flex min-h-11 -translate-y-1/2 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
            >
              <ScanSearch size={13} aria-hidden />
              Focus /
            </button>
            <PosSearchResultList
              search={search}
              groupedSearchResults={groupedSearchResults}
              onSearchResultClick={onSearchResultClick}
            />
          </div>

          {/* Sale tools row */}
          <div className="flex items-center gap-3 border-t border-app-border/50 pt-3">
            <button
              type="button"
              aria-label="Scroll cart actions left"
              onClick={() => scrollActionRibbon("left")}
              disabled={!actionRibbonCanScrollLeft}
              className="ui-touch-target flex h-16 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-text shadow-sm transition-all hover:bg-app-surface disabled:cursor-not-allowed disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-70"
            >
              <ChevronLeft size={22} aria-hidden />
            </button>
            <div
              ref={actionRibbonRef}
              role="toolbar"
              aria-label="Cart actions"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  scrollActionRibbon("left");
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  scrollActionRibbon("right");
                } else if (event.key === "Home") {
                  event.preventDefault();
                  scrollActionRibbon("start");
                } else if (event.key === "End") {
                  event.preventDefault();
                  scrollActionRibbon("end");
                }
              }}
              className="flex min-w-0 flex-1 gap-3 overflow-x-auto rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-app-accent/60"
            >
              <button
                type="button"
                onClick={() => {
                  setWeddingDrawerPreferGroupPay(false);
                  setWeddingDrawerOpen(true);
                }}
                className={`ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border px-2 text-center shadow-sm ring-1 ring-black/5 transition-all active:scale-95 dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px] ${activeWeddingMember ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20" : "border-app-border bg-app-surface-2 text-app-text hover:border-app-accent hover:bg-app-surface hover:text-app-accent"}`}
              >
                <WEDDINGS_ICON size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  {activeWeddingMember ? "Switch" : "Wedding"}
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-alteration-intake-trigger"
                onClick={() => {
                  if (!selectedCustomer) {
                    toast("Select or create a customer before starting an alteration.", "error");
                    return;
                  }
                  setEditingAlterationIntake(null);
                  setAlterationIntakeOpen(true);
                }}
                title={selectedCustomer ? "Start alteration intake" : "Select a customer to start alteration intake"}
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-accent/60 bg-app-accent/10 px-2 text-center text-app-accent shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-accent hover:text-white active:scale-95 dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <Scissors size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Alteration
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-action-custom-order"
                onClick={() => {
                  if (!ensureSaleCashier()) return;
                  if (!selectedCustomer) {
                    toast("Select or create a customer before starting a custom order.", "error");
                    return;
                  }
                  setPendingCustomItem(null);
                  setCustomPromptOpen(true);
                }}
                title={selectedCustomer ? "Start a custom order" : "Select a customer to start a custom order"}
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-warning/60 bg-app-warning/10 px-2 text-center text-app-warning shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-warning hover:text-white active:scale-95 dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <Pencil size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Custom
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-exchange-wizard-trigger"
                onClick={() => setExchangeWizardOpen(true)}
                title="Exchange or return"
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-2 text-center text-app-text shadow-sm ring-1 ring-black/5 transition-all hover:border-app-accent/40 hover:bg-app-surface hover:text-app-accent active:scale-95 dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <ArrowLeftRight size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Return
                </span>
              </button>
              <button
                type="button"
                disabled={!selectedCustomer}
                onClick={() => setOrderLoadOpen(true)}
                title={selectedCustomer ? "View customer open orders" : "Select a customer to view open orders"}
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-info/60 bg-app-info/10 px-2 text-center text-app-info shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-info hover:text-white disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-80 disabled:shadow-none disabled:hover:bg-app-surface-3 disabled:hover:text-app-text-muted dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <ORDER_HISTORY_ICON size={20} className="shrink-0" aria-hidden />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Orders
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-action-gift-card"
                onClick={() => setGiftCardLoadOpen(true)}
                title="Enter load amount, then scan or type the card code"
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-success/60 bg-app-success/10 px-2 text-center text-app-success shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-success hover:text-white dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <GIFT_CARDS_ICON size={20} className="shrink-0" aria-hidden />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Gift Card
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-action-rms-payment"
                onClick={async () => {
                  if (!ensureSaleCashier()) return;
                  let meta = rmsPaymentMeta;
                  if (!meta) {
                    try {
                      const res = await fetch(`${baseUrl}/api/pos/rms-payment-line-meta`, { headers: apiAuth() });
                      if (!res.ok) {
                        toast("RMS payment line is not available. Sign in or run migrations.", "error");
                        return;
                      }
                      const payload = (await res.json()) as RmsPaymentLineMeta | null;
                      if (!payload) {
                        toast("RMS payment line is not available. Ensure layout POS products are created.", "error");
                        return;
                      }
                      meta = payload;
                      setRmsPaymentMeta(meta);
                    } catch {
                      toast("RMS payment line is not available. Ensure layout POS products are created.", "error");
                      return;
                    }
                  }
                  setRmsPaymentOpen(true);
                }}
                title="Add an RMS Charge Payment to collect payment on customer account"
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-violet-500/60 bg-violet-500/10 px-2 text-center text-violet-600 shadow-sm ring-1 ring-black/5 transition-all hover:bg-violet-600 hover:text-white dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <CreditCard size={20} className="shrink-0" aria-hidden />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  RMS Pay
                </span>
              </button>
              <button
                type="button"
                data-testid="pos-action-staff-account-payment"
                onClick={async () => {
                  if (!ensureSaleCashier()) return;
                  let meta = staffAccountPaymentMeta;
                  if (!meta) {
                    try {
                      const res = await fetch(`${baseUrl}/api/pos/staff-account-payment-line-meta`, { headers: apiAuth() });
                      if (!res.ok) {
                        toast("Staff Account payment line is not available. Sign in or run migrations.", "error");
                        return;
                      }
                      const payload = (await res.json()) as StaffAccountPaymentLineMeta | null;
                      if (!payload) {
                        toast("Staff Account payment line is not available. Ensure layout POS products are created.", "error");
                        return;
                      }
                      meta = payload;
                      setStaffAccountPaymentMeta(meta);
                    } catch {
                      toast("Staff Account payment line is not available. Ensure layout POS products are created.", "error");
                      return;
                    }
                  }
                  setStaffAccountPaymentOpen(true);
                }}
                title="Collect payment on a linked employee Staff Account"
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-cyan-600/60 bg-cyan-600/10 px-2 text-center text-cyan-700 shadow-sm ring-1 ring-black/5 transition-all hover:bg-cyan-700 hover:text-white dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <CreditCard size={20} className="shrink-0" aria-hidden />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Staff Pay
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
                className={`ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border px-2 text-center shadow-sm ring-1 ring-black/5 transition-all active:scale-95 dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px] ${lines.some(l => l.fulfillment === 'layaway') ? "border-app-warning bg-app-warning/10 text-app-warning" : "border-app-border bg-app-surface-2 text-app-text hover:border-app-warning/50 hover:bg-app-surface hover:text-app-warning"}`}
              >
                <Clock size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Layaway
                </span>
              </button>
              <button
                type="button"
                onClick={() => setOrderReviewOpen(true)}
                disabled={lines.length === 0}
                title="Set rush and pickup/order details. Use Shipping to ship this current sale."
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-success/60 bg-app-success/10 px-2 text-center text-app-success shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-success hover:text-white disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-80 disabled:shadow-none disabled:hover:bg-app-surface-3 disabled:hover:text-app-text-muted dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <Zap size={20} className="shrink-0" aria-hidden />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Options
                </span>
              </button>
              <button
                type="button"
                disabled={lines.length === 0}
                onClick={() => {
                   if (approvedProviderPaymentInCheckout) {
                     toast("This sale has an approved card payment. Record the sale before parking it.", "error");
                     return;
                   }
                   const label = selectedCustomer ? `Sale for ${selectedCustomer.first_name} ${selectedCustomer.last_name}` : "Untitled Sale";
                   setParkSaleDraftLabel(label);
                   setParkSalePromptOpen(true);
                }}
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-accent/60 bg-app-accent/10 px-2 text-center text-app-accent shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-accent hover:text-white disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-80 disabled:shadow-none disabled:hover:bg-app-surface-3 disabled:hover:text-app-text-muted dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <Clock size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Park Sale
                </span>
              </button>
              <button
                type="button"
                disabled={lines.length === 0 && !selectedCustomer}
                onClick={() => {
                  if (approvedProviderPaymentInCheckout) {
                    toast("This sale has an approved card payment. Record the sale instead of clearing it.", "error");
                    return;
                  }
                  setShowClearConfirm(true);
                }}
                className="ui-touch-target flex min-h-[86px] flex-[1_0_104px] flex-col items-center justify-center gap-2 rounded-xl border border-app-danger/60 bg-app-danger/10 px-2 text-center text-app-danger shadow-sm ring-1 ring-black/5 transition-all hover:bg-app-danger hover:text-white disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-80 disabled:shadow-none disabled:hover:bg-app-surface-3 disabled:hover:text-app-text-muted dark:ring-white/10 sm:flex-[1_0_116px] xl:min-h-[94px] xl:flex-[1_0_125px]"
              >
                <RotateCcw size={20} />
                <span className="text-[10px] font-black uppercase leading-[12px] tracking-widest">
                  Clear Sale
                </span>
              </button>
            </div>
            <button
              type="button"
              aria-label="Scroll cart actions right"
              onClick={() => scrollActionRibbon("right")}
              disabled={!actionRibbonCanScrollRight}
              className="ui-touch-target flex h-16 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-text shadow-sm transition-all hover:bg-app-surface disabled:cursor-not-allowed disabled:bg-app-surface-3 disabled:text-app-text-muted disabled:opacity-70"
            >
              <ChevronRight size={22} aria-hidden />
            </button>
          </div>
          {pendingAlterationIntakes.length > 0 ? (
            <div
              data-testid="pos-pending-alterations-summary"
              className="rounded-xl border border-app-accent/25 bg-app-accent/10 px-3 py-2 text-xs font-bold text-app-text"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Scissors size={14} className="text-app-accent" />
                  {pendingAlterationIntakes.length} alteration intake
                  {pendingAlterationIntakes.length === 1 ? "" : "s"} attached to current cart
                </span>
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Next: finish checkout to create tailor queue work
                </span>
              </div>
            </div>
          ) : null}
          {pickupReadyAlterations.length > 0 ? (
            <div
              data-testid="pos-pickup-ready-alterations-summary"
              className="rounded-xl border border-app-success/25 bg-app-success/10 px-3 py-2 text-xs font-bold text-app-text"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Scissors size={14} className="text-app-success" />
                  {pickupReadyAlterations.length} ready alteration pickup
                  {pickupReadyAlterations.length === 1 ? "" : "s"} will be completed with this order
                </span>
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Next: complete pickup
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {pickupReadyAlterations.slice(0, 3).map((alteration) => (
                  <span key={alteration.id} className="rounded-lg bg-app-surface/80 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {alteration.ticket_number ? `Ticket ${alteration.ticket_number}` : alteration.source_sku ?? "Alteration"} · {alteration.work_requested}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          </div>
        </div>

        {/* Scrollable line items — designed for 5-6 items visible */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2 sm:p-3 lg:p-4">
          {lines.length > 0 ? (
            <div className="space-y-1.5">
              <p className="px-1 pt-0.5 text-[9px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Sale lines — tap qty or price, then use the keypad
              </p>
              {sortedCartLines.map((line) => (
                <CartItemRow
                  key={line.cart_row_id}
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
                  toggleLineTaxCategory={toggleLineTaxCategory}
                  removeLine={removeLineWithAlterationHandling}
                  onEditAlterationLine={(intakeId) => {
                    const intake = pendingAlterationIntakes.find((row) => row.id === intakeId);
                    if (!intake) return;
                    setEditingAlterationIntake(intake);
                    setAlterationIntakeOpen(true);
                  }}
                  onLineProductTitleClick={openLineProductBrowser}
                  commissionStaff={commissionStaff}
                  orderSalespersonId={primarySalespersonId}
                  orderSalespersonLabel={primarySalespersonLabel}
                  hideLineSalesperson={isGiftCardOnlyCart || isEmployeeSale}
                />
              ))}
            </div>
          ) : orderPaymentLines.length > 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center text-app-text-muted/80">
                <CreditCard size={64} strokeWidth={1} className="mb-4 text-violet-600" />
                <p className="text-base font-black uppercase italic tracking-widest">
                  Payment Only
                </p>
                <p className="mt-2 max-w-[22rem] text-sm font-medium normal-case tracking-normal text-app-text-muted">
                  Existing transaction payments are ready below. No new merchandise is being sold.
                </p>
             </div>
          ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center text-app-text-muted/80">
                <Package size={64} strokeWidth={1} className="mb-4" />
                <p className="text-base font-black uppercase italic tracking-widest">
                  Cart is Empty
                </p>
                <p className="mt-2 max-w-[20rem] text-sm font-medium normal-case tracking-normal text-app-text-muted">
                  Search or scan an item to begin this sale.
                </p>
             </div>
          )}

          {orderPaymentLines.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 px-2">
                <div className="h-px flex-1 bg-gradient-to-r from-violet-500/35 to-transparent" />
                <span className="text-[10px] font-black uppercase tracking-[0.3em] text-violet-600">
                  Existing Transaction Payments
                </span>
                <div className="h-px flex-1 bg-gradient-to-l from-violet-500/35 to-transparent" />
              </div>
              {orderPaymentLines.map((line) => (
                <div
                  key={line.cart_row_id}
                  data-testid="pos-order-payment-cart-line"
                  className="group relative flex items-center justify-between gap-4 rounded-2xl border border-violet-500/20 bg-violet-500/8 p-4 shadow-sm"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-600/20">
                      <CreditCard size={18} />
                    </div>
                    <div className="min-w-0">
                      <h4 className="truncate text-sm font-black text-app-text">
                        Payment toward {line.target_display_id}
                      </h4>
                      <p className="text-[10px] font-bold text-app-text-muted">
                        Remaining after payment: ${line.projected_balance_after}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <div className="text-right">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Applying
                      </p>
                      <p className="text-xl font-black italic tabular-nums text-violet-700">
                        ${line.amount}
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid="pos-order-payment-edit"
                      onClick={() => openOrderPaymentEdit(line)}
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-app-border bg-app-surface text-app-text transition-colors hover:border-violet-500/40 hover:bg-violet-50 hover:text-violet-700"
                      aria-label={`Edit payment on ${line.target_display_id}`}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      data-testid="pos-order-payment-remove"
                      onClick={() =>
                        setOrderPaymentLines((prev) =>
                          prev.filter((candidate) => candidate.cart_row_id !== line.cart_row_id),
                        )
                      }
                      className="flex h-9 w-9 items-center justify-center rounded-xl border border-app-danger/30 bg-app-danger/10 text-app-danger transition-colors hover:bg-app-danger hover:text-white"
                      aria-label={`Remove payment on ${line.target_display_id}`}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {disbursementMembers.length > 0 && (
             <div className="space-y-3">
                <div className="flex items-center gap-3 px-2">
                  <div className="h-px flex-1 bg-gradient-to-r from-app-info/30 to-transparent" />
                  <span className="text-[10px] font-black uppercase tracking-[0.3em] text-app-info">Wedding Party Disbursements</span>
                  <div className="h-px flex-1 bg-gradient-to-l from-app-info/30 to-transparent" />
                </div>
                {disbursementMembers.map(m => (
                  <div key={m.id} className="group relative flex items-center justify-between gap-4 rounded-3xl border border-app-info/16 bg-app-info/6 p-5 animate-in slide-in-from-left duration-300">
                     <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-info text-white font-black italic shadow-lg shadow-app-info/20">
                           {m.first_name[0]}{m.last_name[0]}
                        </div>
                        <div>
                           <h4 className="text-sm font-black text-app-text leading-tight">{m.first_name} {m.last_name}</h4>
                           <p className="text-[9px] font-black uppercase tracking-widest text-app-info">{m.role}</p>
                        </div>
                     </div>
                     <div className="text-right">
                        <p className="mb-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted/80">Applying Amount</p>
                        <p className="text-xl font-black italic tracking-tighter text-app-info">
                          $
                          {centsToFixed2(weddingDisbursementAmountCents(m))}
                        </p>
                     </div>
                     <button
                       type="button"
                       aria-label={`Remove ${m.first_name} ${m.last_name} from wedding party payment`}
                       onClick={() => setDisbursementMembers(prev => prev.filter(p => p.id !== m.id))}
                       className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-danger/30 bg-app-danger/10 text-app-danger shadow-sm transition-colors hover:bg-app-danger hover:text-white"
                     >
                       <X size={16} />
                     </button>
                  </div>
                ))}
             </div>
          )}
        </div>
      </div>

      <aside
        className={`relative z-0 flex h-full min-h-0 w-full flex-col overflow-y-auto overscroll-contain border-l border-app-border/80 bg-[color-mix(in_srgb,var(--app-surface-2)_84%,var(--app-bg))] shadow-[-8px_0_32px_-12px_rgba(15,23,42,0.18)] ${checkoutDrawerOpen ? "pointer-events-none select-none opacity-40" : ""}`}
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
            weddingMemberships={weddingMemberships}
            onOpenWeddingParty={onOpenWeddingParty}
            showWalkInOption
            hasParkedSales={parkedRows.length > 0}
            onOpenParkedSales={() => setParkedListOpen(true)}
          />
        </div>

        {weddingPurchaseLoading ? (
          <div className="shrink-0 border-b border-app-border/50 px-2.5 py-2">
            <div className="rounded-2xl border border-app-info/20 bg-app-info/5 px-3 py-2 text-[11px] font-bold text-app-info">
              Checking wedding checklist...
            </div>
          </div>
        ) : weddingPurchaseContext?.memberships.length ? (
          <div className="shrink-0 border-b border-app-border/50 px-2.5 py-2">
            <div className="space-y-2 rounded-2xl border border-app-accent/25 bg-app-accent/8 p-3 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-accent">
                    Wedding Checklist
                  </p>
                  <p className="mt-0.5 text-[11px] font-semibold leading-snug text-app-text-muted">
                    Add this member's required items, or mark an item for measurements before ordering.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const firstPartyId = weddingPurchaseContext.memberships[0]?.wedding_party_id;
                    if (firstPartyId) onOpenWeddingParty?.(firstPartyId);
                  }}
                  className="shrink-0 rounded-lg border border-app-border/70 bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted hover:border-app-accent hover:text-app-accent"
                >
                  Open
                </button>
              </div>
              <div className="space-y-2">
                {weddingPurchaseContext.memberships.map((membership) => (
                  <div
                    key={membership.wedding_member_id}
                    className="rounded-xl border border-app-border/70 bg-app-surface p-2"
                  >
                    <div className="mb-2 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-black text-app-text">{membership.party_name}</p>
                        <p className="text-[10px] font-bold uppercase tracking-wide text-app-text-muted">
                          {membership.role || "Member"} · {membership.event_date}
                        </p>
                      </div>
                      {!membership.measured ? (
                        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-800 ring-1 ring-amber-200">
                          Measure
                        </span>
                      ) : null}
                    </div>
                    {membership.purchase_items.length ? (
                      <div className="space-y-2">
                        {membership.purchase_items.map((item) => {
                          const inCart = lines.some((line) => line.variant_id === item.variant_id);
                          const tracked = item.already_tracked;
                          const takeNowAvailable = (item.available_stock ?? item.stock_on_hand ?? 0) > 0;
                          const itemLocked = tracked || inCart;
                          return (
                            <div
                              key={`${membership.wedding_member_id}-${item.variant_id}`}
                              className="rounded-xl border border-app-border/60 bg-app-surface-2 p-2"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-black text-app-text">{item.name}</p>
                                  <p className="truncate text-[10px] font-semibold text-app-text-muted">
                                    {item.variation_label || item.sku} · Stock {item.available_stock ?? item.stock_on_hand ?? 0}
                                  </p>
                                </div>
                                <span className="shrink-0 text-xs font-black text-app-text">
                                  ${centsToFixed2(parseMoneyToCents(item.standard_retail_price))}
                                </span>
                              </div>
                              {tracked ? (
                                <p className="mt-2 rounded-lg bg-app-success/10 px-2 py-1 text-[10px] font-bold text-app-success">
                                  Already tracked for this wedding member.
                                </p>
                              ) : inCart ? (
                                <p className="mt-2 rounded-lg bg-app-info/10 px-2 py-1 text-[10px] font-bold text-app-info">
                                  In the current cart.
                                </p>
                              ) : (
                                <div className="mt-2 grid grid-cols-3 gap-1.5">
                                  <button
                                    type="button"
                                    disabled={itemLocked || !takeNowAvailable}
                                    onClick={() => addWeddingPurchaseItem(membership, item, "takeaway")}
                                    className="rounded-lg border border-app-border bg-app-surface px-1.5 py-1.5 text-[9px] font-black uppercase tracking-wide text-app-text-muted hover:border-app-success hover:text-app-success disabled:cursor-not-allowed disabled:opacity-45"
                                  >
                                    Take now
                                  </button>
                                  <button
                                    type="button"
                                    disabled={itemLocked}
                                    onClick={() => addWeddingPurchaseItem(membership, item, "order")}
                                    className="rounded-lg border border-app-border bg-app-surface px-1.5 py-1.5 text-[9px] font-black uppercase tracking-wide text-app-text-muted hover:border-app-accent hover:text-app-accent disabled:cursor-not-allowed disabled:opacity-45"
                                  >
                                    Order
                                  </button>
                                  <button
                                    type="button"
                                    disabled={itemLocked}
                                    onClick={() => addWeddingPurchaseItem(membership, item, "needs_measurements")}
                                    className="rounded-lg border border-amber-200 bg-amber-50 px-1.5 py-1.5 text-[9px] font-black uppercase tracking-wide text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-45"
                                  >
                                    Measure
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="rounded-lg bg-app-surface-2 px-2 py-1.5 text-[10px] font-semibold text-app-text-muted">
                        No linked product is set yet. Open the wedding party to choose the exact item.
                      </p>
                    )}
                    {membership.checklist_items.length ? (
                      <div className="mt-2 space-y-1.5">
                        {membership.checklist_items.map((checklistItem) => (
                          <div
                            key={checklistItem.id}
                            className="rounded-lg border border-dashed border-app-border/80 bg-app-surface-2 px-2 py-1.5"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-[11px] font-black text-app-text">
                                  {checklistItem.quantity}x {checklistItem.description}
                                </p>
                                {checklistItem.notes ? (
                                  <p className="truncate text-[10px] font-semibold text-app-text-muted">
                                    {checklistItem.notes}
                                  </p>
                                ) : null}
                              </div>
                              <span className="shrink-0 rounded-full bg-app-surface px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-app-text-muted ring-1 ring-app-border">
                                Checklist
                              </span>
                            </div>
                            <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                              Not linked to a sellable product yet. Open the wedding party if this should be added to the sale.
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* ── Totals summary ── */}
        <div className="shrink-0 px-2.5 pt-2">
          <div className="rounded-2xl border border-app-border/60 bg-app-surface px-4 py-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-app-border/40 pb-2">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-app-success/8 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-app-success ring-1 ring-app-success/12">
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
                        className="ui-btn-secondary py-1 text-[9px] font-black uppercase tracking-widest focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/25 disabled:cursor-not-allowed"
                      >
                        Apply
                      </button>
                    ) : null}
                  </>
                )}
                {lines.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (hasAccess) {
                        clearCartAndAlterations();
                        toast("Sale cleared.", "success");
                      } else {
                        setShowVoidAllConfirm(true);
                      }
                    }}
                    className="rounded-lg border border-app-danger/25 bg-app-danger/8 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-danger transition-all duration-150 hover:bg-app-danger/12 hover:text-app-text active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-danger/20"
                  >
                    Void all
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    if (hasAccess) {
                      setSuitSwapWizardOpen(true);
                    } else {
                      setShowSuitSwapApproval(true);
                    }
                  }}
                  className="rounded-lg border border-app-accent/25 bg-app-accent/8 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent transition-all duration-150 hover:bg-app-accent/12 hover:text-app-text active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20"
                >
                  Suit Swap
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-app-text-muted">
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>Subtotal</span>
                <span className="tabular-nums font-bold text-app-text">${centsToFixed2(totals.subtotalCents)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>Items</span>
                <span className="tabular-nums text-app-text">{totals.totalPieces}</span>
              </div>
              <div className="col-span-2 mt-2 space-y-1.5 border-t border-app-border/30 pt-2">
                <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-app-text-muted">
                  <span>NYS Tax</span>
                  <span className="tabular-nums font-bold text-app-text-muted">${centsToFixed2(totals.stateTaxCents)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wide text-app-text-muted">
                  <span>Local Tax</span>
                  <span className="tabular-nums font-bold text-app-text-muted">${centsToFixed2(totals.localTaxCents)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-wide">
                  <span className="text-app-text">Total Tax</span>
                  <span className="tabular-nums text-app-text">${centsToFixed2(totals.taxCents)}</span>
                </div>
              </div>
              {posShipping ? (
                <div className="col-span-2 flex items-start justify-between gap-2 rounded-lg bg-app-info/8 px-2 py-1 ui-info-text">
                  <div className="min-w-0 text-[9px] font-black uppercase leading-snug tracking-wide">
                    <span className="block normal-case font-bold text-app-text">
                      {posShipping.label}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2">
                      <button type="button" onClick={() => setShippingModalOpen(true)} className="text-[9px] font-bold text-app-accent underline transition-colors duration-150 hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20">Edit</button>
                      <button type="button" onClick={() => setPosShipping(null)} className="text-[9px] font-bold text-red-600 underline transition-colors duration-150 hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/20">Clear</button>
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
                    className="inline-flex items-center gap-1 rounded-full border border-app-border/80 bg-app-surface-2/90 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text transition-all duration-150 hover:border-app-accent/40 hover:bg-app-accent/5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20 disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Truck size={11} aria-hidden />
                    Ship current sale
                  </button>
                </div>
              )}
              {totals.orderPaymentCents > 0 ? (
                <div className="col-span-2 flex items-baseline justify-between gap-2 rounded-lg bg-violet-500/8 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-violet-700">
                  <span>Existing transaction payments</span>
                  <span className="tabular-nums">${centsToFixed2(totals.orderPaymentCents)}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ── Keypad — uses all remaining space ── */}
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-2 sm:px-2.5">
          {/* Display / mode hint */}
          <div className="mb-2 shrink-0 rounded-xl border border-app-border/60 bg-app-surface-2/80 px-3 py-2">
            <p className="text-[9px] font-black uppercase leading-snug tracking-widest text-app-text-muted">
              {selectedLineKey
                ? keypadMode === "qty"
                  ? "Quantity — use - for negative, Apply"
                  : "Sale price — % off reg price, $ or Apply for dollars"
                : "Select a line, then tap Qty or Sale price"}
            </p>
            <p
              className={`mt-0.5 text-right text-lg font-black tabular-nums sm:text-xl ${
                keypadMode === "qty" && keypadBuffer.startsWith("-") ? "text-app-danger" : "text-app-text"
              }`}
              aria-live="polite"
            >
              {selectedLineKey ? (keypadBuffer || "0") : "—"}
            </p>
          </div>

          <div className="min-h-0 flex-1 rounded-2xl border border-app-border/40 bg-app-surface-2 p-2 shadow-inner">
            <div className="grid h-full grid-cols-3 grid-rows-5 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "CLEAR"].map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={!selectedLineKey}
                  onClick={() => handleNumpadKey(key)}
                  className={`flex cursor-pointer items-center justify-center rounded-xl border-b-4 text-lg font-black transition-all duration-150 active:translate-y-0.5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20 disabled:cursor-not-allowed disabled:opacity-35 sm:text-xl ${key === "CLEAR" ? "border-app-danger/35 bg-app-danger/10 text-app-danger hover:bg-app-danger/18 focus-visible:ring-app-danger/20" : "border-app-border/40 bg-app-surface text-app-text hover:bg-app-surface-3"}`}
                >
                  {key}
                </button>
              ))}
              {/* Row 5: %, $, Apply */}
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey(keypadMode === "qty" ? "-" : "%")}
                className={`flex cursor-pointer items-center justify-center rounded-xl border-b-4 text-lg font-black text-white shadow-xl transition-all duration-150 hover:brightness-110 active:translate-y-0.5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-35 sm:text-xl ${
                  keypadMode === "qty"
                    ? "border-app-danger bg-app-danger shadow-app-danger/20 focus-visible:ring-app-danger/25"
                    : "border-app-info bg-app-info shadow-app-info/20 focus-visible:ring-app-info/25"
                }`}
              >
                {keypadMode === "qty" ? "-" : "%"}
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("$")}
                className="flex cursor-pointer items-center justify-center rounded-xl border-b-4 border-app-info bg-app-info text-lg font-black text-white shadow-xl shadow-app-info/20 transition-all duration-150 hover:brightness-110 active:translate-y-0.5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-info/25 disabled:cursor-not-allowed disabled:opacity-35 sm:text-xl"
              >
                $
              </button>
              <button
                type="button"
                disabled={!selectedLineKey}
                onClick={() => handleNumpadKey("ENTER")}
                className="flex cursor-pointer items-center justify-center rounded-xl border-b-[6px] border-app-success bg-app-success text-base font-black uppercase tracking-widest text-white shadow-2xl shadow-app-success/25 transition-all duration-150 hover:brightness-110 active:translate-y-0.5 active:scale-95 active:border-b-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-success/25 disabled:cursor-not-allowed disabled:opacity-35"
              >
                Apply
              </button>
            </div>
          </div>
        </div>

        {/* ── Pay button ── */}
        <div className="sticky bottom-0 z-10 shrink-0 border-t border-app-border/70 bg-app-surface/95 p-2.5 shadow-[0_-10px_40px_-18px_rgba(0,0,0,0.15)] backdrop-blur-sm">
           <button
             type="button"
             data-testid="pos-pay-button"
             disabled={!hasCheckoutWork || checkoutBusy}
             onClick={async () => {
               if (!hasCheckoutWork) return toast("Add at least one item, transaction payment, or wedding group payment before checking out.", "error");
                if (!ensureSaleCashier()) return;
               if (pendingReturnTender?.returnOnly) {
                 openCheckoutDrawerWithGuard();
                 return;
               }
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
                 openCheckoutDrawerWithGuard();
                 return;
               }

               if (pickupTransactionId) {
                  const unreadyPickupLines = lines.filter(
                    (l) => l.transaction_line_id && l.order_lifecycle_status !== "ready_for_pickup"
                  );
                  if (unreadyPickupLines.length > 0 && !managerOverrideApproved) {
                    setShowReadinessOverrideModal(true);
                    return;
                  }
                  if (totals.totalCents === 0 && checkoutOperator) {
                    await executeCheckout(
                      [],
                      checkoutOperator,
                      {
                        appliedDepositAmountCents: 0,
                        isTaxExempt: false,
                      },
                      {
                        overrideReadiness: managerOverrideApproved,
                        overrideReason: managerOverrideReason || undefined,
                      },
                    );
                    return;
                  }
                }

               if (lines.length > 0 && hasSpecialOrWeddingLines && !orderReviewOpen) {
                 setOrderReviewOpen(true);
                 return;
               }

               if (lines.length > 0 && !isRmsPaymentCart && !isGiftCardOnlyCart) {
                 if (!hasSalespersonAttribution()) {
                   toast(
                     "Select a salesperson for this sale, or assign one on a line, so commissions can be calculated.",
                     "error",
                   );
                   return;
                 }
               }
               if (pendingReturnTender && !selectedCustomer) {
                 toast("Keep the original customer selected before settling an exchange.", "error");
                 return;
               }
               if (!selectedCustomer) {
                 setShowWalkinConfirm(true);
               } else {
                 openCheckoutDrawerWithGuard();
               }
             }}
             className={`ui-touch-target group relative flex h-[4.25rem] w-full items-center justify-between rounded-2xl border-b-[6px] transition-all duration-150 active:translate-y-0.5 active:scale-[0.98] shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-success/25 ${hasCheckoutWork ? 'bg-app-success border-app-success text-white hover:brightness-110 shadow-app-success/40' : 'bg-app-surface-2 border-app-border text-app-text-muted cursor-not-allowed opacity-50'}`}
           >
             <div className="flex flex-col items-start pl-3 sm:pl-5">
                <span className="text-[9px] font-black uppercase tracking-[0.28em] opacity-70">
                  {pickupTransactionId && totals.totalCents === 0
                    ? (selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name} — Pickup` : "Pickup")
                    : (selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name} — Pay` : "Walk-in — Pay")}
                </span>
                <span className="text-2xl font-black tabular-nums tracking-tighter italic sm:text-3xl">
                  {pickupTransactionId && totals.totalCents === 0 ? "Complete Pickup" : `$${centsToFixed2(totals.totalCents)}`}
                </span>
             </div>
             <div className="mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-app-surface/20 transition-transform group-hover:scale-105 sm:mr-4 sm:h-11 sm:w-11">
                <span className="text-lg font-black uppercase italic">
                  {pickupTransactionId && totals.totalCents === 0 ? "Pick" : "Pay"}
                </span>
             </div>
           </button>
        </div>
      </aside>

      {editingOrderPaymentLine && createPortal(
        <div className="ui-overlay-backdrop !z-[200]">
          <div
            className="ui-modal w-full max-w-sm p-6"
            data-testid="pos-order-payment-edit-modal"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
                  Edit Transaction Payment
                </p>
                <h3 className="text-lg font-black text-app-text">
                  {editingOrderPaymentLine.target_display_id}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingOrderPaymentLine(null);
                  setEditingOrderPaymentAmount("");
                }}
                className="rounded-lg p-1 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                aria-label="Close transaction payment edit"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mb-4 rounded-xl border border-app-border bg-app-surface-2/60 p-3 text-sm">
              <div className="flex justify-between gap-3 text-app-text-muted">
                <span>Balance before payment</span>
                <span className="font-black tabular-nums text-app-text">
                  ${editingOrderPaymentLine.balance_before}
                </span>
              </div>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Payment amount
            </label>
            <input
              data-testid="pos-order-payment-edit-amount"
              value={editingOrderPaymentAmount}
              onChange={(e) => setEditingOrderPaymentAmount(e.target.value)}
              inputMode="decimal"
              autoFocus
              className="mt-1 w-full rounded-xl border border-app-border bg-app-surface px-3 py-3 text-2xl font-black tabular-nums text-app-text outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent/20"
            />
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditingOrderPaymentLine(null);
                  setEditingOrderPaymentAmount("");
                }}
                className="flex-1 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-app-text"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="pos-order-payment-edit-save"
                onClick={saveOrderPaymentEdit}
                className="flex-1 rounded-xl border-b-4 border-violet-800 bg-violet-600 px-4 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-violet-600/25 active:translate-y-0.5 active:border-b-2"
              >
                Update
              </button>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}

      <PosShippingModal
        open={shippingModalOpen}
        onClose={() => setShippingModalOpen(false)}
        baseUrl={baseUrl}
        getHeaders={apiAuth}
        registerSessionId={sessionId}
        selectedCustomer={selectedCustomer}
        current={posShipping}
        onApply={(next) => {
          setPosShipping(next);
        }}
      />

      <NexoCheckoutDrawer
        isOpen={checkoutDrawerOpen}
        onClose={() => setCheckoutDrawerOpen(false)}
        registerSessionId={sessionId}
        activeRegisterLane={registerLane}
        amountDueCents={totals.totalCents}
        stateTaxCents={totals.stateTaxCents}
        localTaxCents={totals.localTaxCents}
        shippingCents={totals.shippingCents}
        weddingLinked={!!activeWeddingMember}
        customerId={selectedCustomer?.id}
        customerName={selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}` : undefined}
        customerCode={selectedCustomer?.customer_code ?? null}
        customerTaxExempt={selectedCustomer?.tax_exempt ?? false}
        customerTaxExemptId={selectedCustomer?.tax_exempt_id ?? null}
        returnOnlyRefundMode={pendingReturnTender?.returnOnly ?? false}
        authoritativeDepositCents={0}
        existingPaidAmountCents={pickupPaidAmountCents}
        heldOpenDeposit={heldOpenDeposit}
        currentSaleAmountCents={totals.orderTotalCents}
        openDepositExternalAllocations={
          disbursementMembers.length > 0 || orderPaymentLines.length > 0
        }
        profileBlocksCheckout={false}
        onOpenProfileGate={() => {}}
        busy={checkoutBusy}
        onFinalize={async (applied, op, ledger) => {
          if (pendingReturnTender) {
            if (!pendingReturnTender.returnOnly) {
              if (posShipping || orderPaymentLines.length > 0 || disbursementMembers.length > 0 || pendingAlterationIntakes.length > 0) {
                toast("Clear shipping, order payments, wedding disbursements, and alteration intake before settling an exchange.", "error");
                return;
              }
              if (!selectedCustomer) {
                toast("Keep the original customer selected before settling an exchange.", "error");
                return;
              }
              if (ledger.appliedDepositAmountCents > 0) {
                toast("Deposit collection cannot be mixed with exchange-credit settlement.", "error");
                return;
              }
              const replacementLines = lines.filter((line) => !line.return_tender_original_transaction_id);
              if (replacementLines.length === 0) {
                toast("Add replacement items before continuing an exchange, or refund the customer only.", "error");
                return;
              }
              if (!hasSalespersonAttribution()) {
                toast(
                  "Select a salesperson for the replacement sale, or assign one on a line, so commissions can be calculated.",
                  "error",
                );
                return;
              }
              const replacementTotals = calculateStandaloneLineTotals(replacementLines);
              if (replacementTotals.orderTotalCents <= 0) {
                toast("Replacement sale total must be positive before settling an exchange.", "error");
                return;
              }
              const exchangeCreditAppliedCents = Math.min(
                pendingReturnTender.refundAmountCents,
                replacementTotals.orderTotalCents,
              );
              const roundingAdjustmentCents = ledger.roundingAdjustmentCents ?? 0;
              const totalAppliedCents = applied.reduce((sum, payment) => sum + payment.amountCents, 0);
              if (totalAppliedCents !== totals.totalCents + roundingAdjustmentCents) {
                toast("Payment amount must match the net exchange balance before finishing.", "error");
                return;
              }
              const refundTenders = applied.filter((payment) => payment.amountCents < 0);
              if (totals.totalCents < 0) {
                const cashRoundsToZero =
                  ledger.tenderMethod === "cash" &&
                  ledger.finalCashDueCents === 0 &&
                  roundingAdjustmentCents !== 0;
                if (!cashRoundsToZero && (refundTenders.length !== 1 || applied.length !== 1)) {
                  toast("Use one refund tender for the remaining exchange credit.", "error");
                  return;
                }
                if (cashRoundsToZero && applied.length > 0) {
                  toast("Clear payment lines when the cash refund rounds to $0.00.", "error");
                  return;
                }
                if (refundTenders[0]?.method.toLowerCase().includes("card")) {
                  toast("Card refund remainders must use the original provider refund flow.", "error");
                  return;
                }
              } else if (refundTenders.length > 0) {
                toast("Refund tender is only allowed when the exchange leaves money owed to the customer.", "error");
                return;
              }

              const exchangeCreditPayment: AppliedPaymentLine = {
                id: `exchange-credit-${pendingReturnTender.originalTransactionId}`,
                method: "exchange_credit",
                amountCents: exchangeCreditAppliedCents,
                label: "Exchange credit",
                metadata: {
                  original_transaction_id: pendingReturnTender.originalTransactionId,
                  receipt_label: pendingReturnTender.receiptLabel,
                  kind: "exchange_credit_applied",
                },
              };
              const checkoutApplied = [
                ...(exchangeCreditAppliedCents > 0 ? [exchangeCreditPayment] : []),
                ...(totals.totalCents > 0 ? applied.filter((payment) => payment.amountCents > 0) : []),
              ];
              const replacementTransactionId = await executeCheckout(
                checkoutApplied,
                op,
                {
                  ...ledger,
                  appliedDepositAmountCents: 0,
                },
                checkoutOrderOptions || undefined,
                {
                  linesOverride: replacementLines,
                  totalsOverride: replacementTotals,
                  clearAfterCheckout: false,
                  emitSaleCompleted: false,
                  showSuccessToast: false,
                },
              );
              if (!replacementTransactionId) return;

              const zeroCashRefundTender: AppliedPaymentLine | null =
                ledger.tenderMethod === "cash" &&
                ledger.finalCashDueCents === 0 &&
                roundingAdjustmentCents !== 0
                  ? {
                      id: `cash-rounding-refund-${pendingReturnTender.originalTransactionId}`,
                      method: "cash",
                      amountCents: 0,
                      label: "Cash refund",
                    }
                  : null;
              const refundTender = refundTenders[0] ?? zeroCashRefundTender;
              const refundRemainderCents = pendingReturnTender.refundAmountCents - exchangeCreditAppliedCents;
              try {
                const settlementRes = await fetch(
                  `${baseUrl}/api/transactions/${encodeURIComponent(pendingReturnTender.originalTransactionId)}/exchange-settlement`,
                  {
                    method: "POST",
                    headers: {
                      ...apiAuth(),
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      session_id: sessionId,
                      replacement_transaction_id: replacementTransactionId,
                      exchange_credit_amount: centsToFixed2(exchangeCreditAppliedCents),
                      return_lines: pendingReturnTender.returnLines.map((line) => ({
                        transaction_line_id: line.transaction_line_id,
                        quantity: line.quantity,
                        reason: line.reason ?? "exchange",
                        restock: line.restock ?? undefined,
                      })),
                      refund_remainder: refundTender
                        ? {
                            payment_method: refundTender.method,
                            amount: centsToFixed2(refundRemainderCents),
                            tender_amount: centsToFixed2(Math.abs(refundTender.amountCents)),
                            rounding_adjustment: centsToFixed2(roundingAdjustmentCents),
                            final_cash_due: ledger.finalCashDueCents != null ? centsToFixed2(ledger.finalCashDueCents) : undefined,
                            gift_card_code: refundTender.gift_card_code,
                          }
                        : undefined,
                    }),
                  },
                );
                if (!settlementRes.ok) {
                  const payload = (await settlementRes.json().catch(() => ({}))) as { error?: string };
                  toast(payload.error ?? "Exchange settlement failed after recording the replacement sale.", "error");
                  return;
                }
                setLastReceiptOrderPaymentLines([]);
                clearCartAndAlterations();
                setCheckoutDrawerOpen(false);
                toast(`Exchange settled for ${pendingReturnTender.receiptLabel}.`, "success");
              } catch {
                toast("Exchange settlement failed. Check the API connection before retrying.", "error");
              }
              return;
            }
            const totalAppliedCents = applied.reduce((sum, payment) => sum + payment.amountCents, 0);
            const roundingAdjustmentCents = ledger.roundingAdjustmentCents ?? 0;
            if (totalAppliedCents !== -pendingReturnTender.refundAmountCents + roundingAdjustmentCents) {
              toast(
                `Refund tender must equal -$${centsToFixed2(pendingReturnTender.refundAmountCents)} before finishing.`,
                "error",
              );
              return;
            }
            const cashRoundsToZero =
              ledger.tenderMethod === "cash" &&
              ledger.finalCashDueCents === 0 &&
              roundingAdjustmentCents !== 0;
            if (!cashRoundsToZero && applied.length !== 1) {
              toast("Use one refund tender for this return so the original Transaction Record stays clear.", "error");
              return;
            }
            if (cashRoundsToZero && applied.length > 0) {
              toast("Clear payment lines when the cash refund rounds to $0.00.", "error");
              return;
            }
            if (applied.some((payment) => payment.method.toLowerCase().includes("card"))) {
              toast(
                "Card refund tender still needs the original provider flow. Use cash, check, gift card, or store credit here.",
                "error",
              );
              return;
            }
            const primaryTender =
              applied[0] ??
              (cashRoundsToZero
                ? ({
                    id: `cash-rounding-refund-${pendingReturnTender.originalTransactionId}`,
                    method: "cash",
                    amountCents: 0,
                    label: "Cash refund",
                  } satisfies AppliedPaymentLine)
                : undefined);
            if (!primaryTender) {
              toast("Select a refund tender before finishing.", "error");
              return;
            }
            try {
              const refundRes = await fetch(
                `${baseUrl}/api/transactions/${encodeURIComponent(pendingReturnTender.originalTransactionId)}/refunds/process`,
                {
                  method: "POST",
                  headers: {
                    ...apiAuth(),
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    session_id: sessionId,
                    payment_method: primaryTender.method,
                    amount: centsToFixed2(pendingReturnTender.refundAmountCents),
                    tender_amount: centsToFixed2(Math.abs(totalAppliedCents)),
                    rounding_adjustment: centsToFixed2(roundingAdjustmentCents),
                    final_cash_due: ledger.finalCashDueCents != null ? centsToFixed2(ledger.finalCashDueCents) : undefined,
                    gift_card_code: primaryTender.gift_card_code,
                    return_lines: pendingReturnTender.returnLines.map((line) => ({
                      transaction_line_id: line.transaction_line_id,
                      quantity: line.quantity,
                      reason: line.reason ?? "refund",
                      restock: line.restock ?? undefined,
                    })),
                  }),
                },
              );
              if (!refundRes.ok) {
                const payload = (await refundRes.json().catch(() => ({}))) as { error?: string };
                toast(payload.error ?? "Refund failed. Check tender and try again.", "error");
                return;
              }
              setLastReceiptOrderPaymentLines([]);
              clearCartAndAlterations();
              setCheckoutDrawerOpen(false);
              toast(`Refund completed for ${pendingReturnTender.receiptLabel}.`, "success");
            } catch {
              toast("Refund failed. Check the API connection and try again.", "error");
            }
            return;
          }
          if (lines.length > 0 && !isRmsPaymentCart && !isGiftCardOnlyCart && !hasSalespersonAttribution()) {
            toast(
              "Select a salesperson for this sale, or assign one on a line, so commissions can be calculated.",
              "error",
            );
            return;
          }
          setLastReceiptOrderPaymentLines(orderPaymentLines);
          await executeCheckout(applied, op, ledger, {
            ...(checkoutOrderOptions || {}),
            overrideReadiness: managerOverrideApproved,
            overrideReason: managerOverrideReason || undefined,
          });
        }}
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
        isOpen={openDepositNotice != null}
        onClose={() => setOpenDepositNotice(null)}
        onConfirm={() => setOpenDepositNotice(null)}
        title="Wedding deposit available"
        message={openDepositNotice ? heldOpenDepositNoticeMessage(openDepositNotice) : ""}
        confirmLabel="Got it"
        cancelLabel="Close"
        variant="info"
      />
      {parkedListOpen && document.getElementById("drawer-root")
        ? createPortal(
            <div className="ui-overlay-backdrop !z-[200]">
              <div
                className="relative flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border border-app-border bg-app-surface shadow-2xl sm:max-h-[min(560px,85vh)] sm:max-w-md sm:rounded-2xl"
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
                                  Draft sale #{p.id.slice(-6).toUpperCase()}
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
            </div>,
            document.getElementById("drawer-root")!,
          )
        : null}
      {parkedCustomerPrompt && document.getElementById("drawer-root")
        ? createPortal(
            <div className="ui-overlay-backdrop !z-[200]">
              <div
                className="absolute inset-0 bg-black/50"
                aria-hidden="true"
              />
              <div
                className="relative w-full max-w-none rounded-t-3xl border border-app-border bg-app-surface p-5 shadow-2xl sm:max-w-md sm:rounded-2xl"
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
                            "This register is not ready. Open or join the register, then try again.",
                            "error",
                          );
                          return;
                        }
                        // Use the merged headers logic to resolve actor if possible,
                        // but the original code used resolveActorStaffId() which I should keep if it exists.
                        const actor = await resolveActorStaffId();
                        if (!actor) {
                          toast(
                            "Sign in to Back Office or verify Staff Access to delete parked sales.",
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
                          console.error("Could not delete parked sales", e);
                          toast(
                            "Could not delete parked sales. Try again.",
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
            </div>,
            document.getElementById("drawer-root")!,
          )
        : null}
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
      <RegisterRmsPaymentModal
        open={rmsPaymentOpen}
        onClose={() => setRmsPaymentOpen(false)}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={(c) => setSelectedCustomer(c)}
        onAddToCart={async (amountCents) => {
          if (!rmsPaymentMeta) return;
          addItem({
            product_id: rmsPaymentMeta.product_id,
            variant_id: rmsPaymentMeta.variant_id,
            sku: rmsPaymentMeta.sku,
            name: rmsPaymentMeta.name,
            standard_retail_price: 0,
            unit_cost: 0,
            state_tax: 0,
            local_tax: 0,
            stock_on_hand: 0,
            vendor_sku: "",
          }, centsToFixed2(amountCents));
        }}
        weddingMemberships={weddingMemberships}
        onOpenWeddingParty={onOpenWeddingParty}
      />
      <RegisterStaffAccountPaymentModal
        open={staffAccountPaymentOpen}
        onClose={() => setStaffAccountPaymentOpen(false)}
        selectedCustomer={selectedCustomer}
        onSelectCustomer={(c) => setSelectedCustomer(c)}
        onAddToCart={async (amountCents) => {
          if (!staffAccountPaymentMeta) return;
          addItem({
            product_id: staffAccountPaymentMeta.product_id,
            variant_id: staffAccountPaymentMeta.variant_id,
            sku: staffAccountPaymentMeta.sku,
            name: staffAccountPaymentMeta.name,
            standard_retail_price: 0,
            unit_cost: 0,
            state_tax: 0,
            local_tax: 0,
            stock_on_hand: 0,
            vendor_sku: "",
          }, centsToFixed2(amountCents), "takeaway");
        }}
        weddingMemberships={weddingMemberships}
        onOpenWeddingParty={onOpenWeddingParty}
      />
      <ConfirmationModal
        isOpen={Boolean(sourceRemovalPrompt)}
        onClose={keepAlterationsAsCustomAndRemoveSource}
        onConfirm={removeSourceLineAndAttachedAlterations}
        title="Remove attached alteration?"
        message={
          sourceRemovalPrompt
            ? `${sourceRemovalPrompt.line.name} has ${sourceRemovalPrompt.intakes.length} attached alteration line${sourceRemovalPrompt.intakes.length === 1 ? "" : "s"}.\n\nRemove the alteration too, or keep it as a custom/manual item.`
            : ""
        }
        confirmLabel="Remove alteration too"
        cancelLabel="Keep as custom item"
        variant="danger"
      />
      <PosAlterationIntakeModal
        open={alterationIntakeOpen}
        customer={selectedCustomer}
        cartLines={lines.filter((line) => line.line_type !== "alteration_service")}
        baseUrl={baseUrl}
        apiAuth={apiAuth}
        editingIntake={editingAlterationIntake}
        onClose={() => {
          setAlterationIntakeOpen(false);
          setEditingAlterationIntake(null);
        }}
        onSavedStandalone={() => {
          setAlterationIntakeOpen(false);
          setEditingAlterationIntake(null);
        }}
        onSavePending={(intake) => {
          upsertAlterationCartLine(intake);
          setAlterationIntakeOpen(false);
          setEditingAlterationIntake(null);
        }}
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
          onSwitchCustomer={(c: Customer) => {
            setSelectedCustomer(c);
          }}
          onCustomerUpdated={updateSelectedCustomerSnapshot}
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
                      custom_order_details: l.custom_order_details,
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
          if (original) {
            addItem(original, priceOverride);
            setActiveVariationSelection(null);
            return;
          }
          void (async () => {
            try {
              const res = await fetch(
                `${baseUrl}/api/inventory/scan/${encodeURIComponent(v.sku)}`,
                { headers: apiAuth() },
              );
              if (!res.ok) {
                toast("Could not resolve that SKU. Scan it directly or search again.", "error");
                return;
              }
              addItem(scanPayloadToResolvedItem((await res.json()) as Record<string, unknown>), priceOverride);
              setActiveVariationSelection(null);
            } catch {
              toast("Could not add that variation to the sale.", "error");
            }
          })();
        }}
      />
      <ConfirmationModal
        isOpen={showWalkinConfirm}
        onClose={() => setShowWalkinConfirm(false)}
        onConfirm={() => {
          setShowWalkinConfirm(false);
          openCheckoutDrawerWithGuard();
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
          if (approvedProviderPaymentInCheckout) {
            setShowClearConfirm(false);
            toast("This sale has an approved card payment and cannot be cleared.", "error");
            return;
          }
          clearCartAndAlterations();
          setShowClearConfirm(false);
          toast("Cart cleared", "info");
        }}
        title="Clear Active Sale?"
        message="Are you sure you want to completely clear this transaction? All items and customer data will be removed."
        confirmLabel="Yes, Clear Sale"
        variant="danger"
      />

      <PromptModal
        isOpen={feePromptKind !== null}
        onClose={() => setFeePromptKind(null)}
        onSubmit={addFeeShortcut}
        title={feePromptKind === "shipping" ? "Add Shipping Fee" : "Add Alterations Fee"}
        message={
          feePromptKind === "shipping"
            ? "Enter the shipping fee. This fee is non-taxable and does not create a shipment. Use Ship Current Sale when an address, carrier, and tracking workflow are needed."
            : "Enter the standalone alterations fee. This line is non-taxable and does not create an alterations work order."
        }
        placeholder="0.00"
        type="numeric"
        confirmLabel="Add Fee"
      />

      <PromptModal
        isOpen={parkSalePromptOpen}
        onClose={() => setParkSalePromptOpen(false)}
        onSubmit={async (value) => {
          const label = value.trim();
          if (!label) {
            toast("Enter a label before parking this sale.", "error");
            return false;
          }
          return parkSale(label);
        }}
        title="Park Sale"
        message="Name this parked sale so another staff member can find it quickly."
        placeholder="Sale label"
        defaultValue={parkSaleDraftLabel}
        confirmLabel="Park Sale"
      />

      <ManagerApprovalModal
        isOpen={showVoidAllConfirm}
        onClose={() => setShowVoidAllConfirm(false)}
        title="Authorize Void All"
        message="Clearing every line in the cart requires Manager Access for audit logging."
        onApprove={async (pin, managerId) => {
          try {
            const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                pin,
                staff_id: managerId,
                authorize_action: "pos_sale_void_all",
                authorize_metadata: {
                  item_count: lines.length,
                  subtotal: totals.subtotalCents,
                  customer_id: selectedCustomer?.id ?? null,
                  register_session_id: sessionId,
                  cart_summary: lines.map(l => `${l.quantity}x ${l.sku}`).join(", ")
                }
              }),
            });
            if (res.ok) {
              clearCartAndAlterations();
              setShowVoidAllConfirm(false);
              toast("All items voided", "success");
              return true;
            } else {
              await res.json().catch(() => ({}));
              toast("Manager approval failed. Check the Access PIN and try again.", "error");
              return false;
            }
          } catch {
            toast("Manager approval is unavailable. Try again or call a manager.", "error");
            return false;
          }
        }}
      />

       <ManagerApprovalModal
        isOpen={showReadinessOverrideModal}
        onClose={() => setShowReadinessOverrideModal(false)}
        title="Authorize Pickup Readiness Override"
        message="This pickup contains items not marked Ready for Pickup. Manager Access is required to override the readiness check."
        onApprove={handleManagerApproveReadiness}
      />

      <ManagerApprovalModal
        isOpen={pickupDepositApprovalRequest != null}
        onClose={closePickupPaymentOverride}
        title="Authorize Pickup Payment Override"
        message={
          pickupDepositApprovalRequest?.message ??
          "Remaining open items are below the standard deposit after this pickup. Manager Access is required to approve release."
        }
        onApprove={handleManagerApprovePickupPayment}
      />

      <ManagerApprovalModal
        isOpen={showSuitSwapApproval}
        onClose={() => setShowSuitSwapApproval(false)}
        title="Authorize Suit Component Swap"
        message="Suit/component swaps modify inventory and financial records. Manager Access is required for audit logging."
        onApprove={async (pin, managerId) => {
          try {
            const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                pin,
                staff_id: managerId,
                authorize_action: "pos_suit_component_swap",
                authorize_metadata: {
                  register_session_id: sessionId,
                  customer_id: selectedCustomer?.id ?? null,
                }
              }),
            });
            if (res.ok) {
              setShowSuitSwapApproval(false);
              setSuitSwapWizardOpen(true);
              return true;
            } else {
              await res.json().catch(() => ({}));
              toast("Manager approval failed. Check the Access PIN and try again.", "error");
              return false;
            }
          } catch {
            toast("Manager approval is unavailable. Try again or call a manager.", "error");
            return false;
          }
        }}
      />

      <PosSuitSwapWizard
        open={suitSwapWizardOpen}
        onClose={() => setSuitSwapWizardOpen(false)}
        sessionId={sessionId}
        baseUrl={baseUrl}
        apiAuth={() => ({ ...apiAuth() })}
      />

      <PosExchangeWizard
        open={exchangeWizardOpen}
        initialTransactionId={exchangeWizardInitialTransactionId}
        initialReturnLineId={exchangeWizardInitialReturnLineId}
        customer={selectedCustomer}
        onClose={() => {
          setExchangeWizardOpen(false);
          setExchangeWizardInitialTransactionId(null);
          setExchangeWizardInitialReturnLineId(null);
        }}
        sessionId={sessionId}
        baseUrl={baseUrl}
        apiAuth={() => ({ ...apiAuth() })}
        onContinueToReplacement={handleExchangeReturnHandoff}
      />



      <WeddingLookupDrawer
        isOpen={weddingDrawerOpen}
        onClose={() => {
          setWeddingDrawerOpen(false);
          setWeddingDrawerPreferGroupPay(false);
        }}
        preferGroupPay={weddingDrawerPreferGroupPay}
        onPreferGroupPayConsumed={() => setWeddingDrawerPreferGroupPay(false)}
        onOpenFullParty={onOpenWeddingParty}
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
          toast(`Added ${members.length} members for split deposit`, "success");
        }}
      />

      <ManagerApprovalModal
        isOpen={!!discountPrompt}
        onClose={() => setDiscountPrompt(null)}
        title="Override Authority"
        message={`Large discounts (>${roleMaxDiscountPct.toFixed(0)}%) require Manager Access authorization for audit logging.`}
        onApprove={async (pin, managerId) => {
          if (!discountPrompt) return false;
          try {
            const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                pin,
                staff_id: managerId,
                authorize_action: "pos_price_override",
                authorize_metadata: {
                  variant_id: discountPrompt.variantId,
                  original_cents: discountPrompt.originalPriceCents,
                  next_cents: discountPrompt.nextPriceCents,
                  reason: discountPrompt.reason,
                  customer_id: selectedCustomer?.id ?? null,
                  register_session_id: sessionId,
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
            toast("Invalid Manager Access PIN.", "error");
            return false;
          } catch {
            toast("We couldn't verify manager approval. Please try again.", "error");
            return false;
          }
        }}
      />

      <ManagerApprovalModal
        isOpen={belowCostApprovalPromptOpen}
        onClose={() => setBelowCostApprovalPromptOpen(false)}
        title="Below-Cost Approval"
        message={`${belowCostManualDiscountLines.length} manual discount line${belowCostManualDiscountLines.length === 1 ? "" : "s"} are below cost or missing cost. Manager Access is required before checkout.`}
        onApprove={async (pin, managerId) => {
          try {
            const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                pin,
                staff_id: managerId,
                authorize_action: "pos_below_cost_manual_discount",
                authorize_metadata: {
                  line_count: belowCostManualDiscountLines.length,
                  line_signature: belowCostLineSignature,
                  customer_id: selectedCustomer?.id ?? null,
                  register_session_id: sessionId,
                  lines: belowCostManualDiscountLines.map((line) => ({
                    variant_id: line.variantId,
                    sku: line.sku,
                    unit_cents: line.unitCents,
                    cost_cents: line.costCents,
                    reason: line.reason,
                  })),
                },
              }),
            });
            if (!res.ok) {
              toast("Manager approval failed. Check the Access PIN and try again.", "error");
              return false;
            }
            const staff = (await res.json()) as { staff_id?: string };
            setBelowCostApproval({
              approvedByStaffId: staff.staff_id ?? managerId,
              lineSignature: belowCostLineSignature,
              reason: "Manager approved below-cost manual discount",
            });
            setBelowCostApprovalPromptOpen(false);
            toast("Below-cost discount approved. Continue to Pay.", "success");
            setCheckoutDrawerOpen(true);
            return true;
          } catch {
            toast("Manager approval is unavailable. Try again or call a manager.", "error");
            return false;
          }
        }}
      />

      {intelligenceVariantId && (
        <ProductIntelligenceDrawer
          variantId={intelligenceVariantId}
          currentUnitPrice={intelligenceLine?.standard_retail_price ?? null}
          regularUnitPrice={
            intelligenceLine?.original_unit_price ??
            intelligenceLine?.catalog_standard_retail_price ??
            null
          }
          onClose={() => {
            setIntelligenceVariantId(null);
            setIntelligenceLine(null);
          }}
        />
      )}

      <CustomItemPromptModal
        isOpen={customPromptOpen}
        sku={pendingCustomItem?.sku ?? null}
        onClose={() => {
          setCustomPromptOpen(false);
          setPendingCustomItem(null);
        }}
        onConfirm={async (data) => {
          let customItem = pendingCustomItem;
          if (!customItem || customItem.sku !== data.customSku) {
            try {
              const res = await fetch(
                `${baseUrl}/api/inventory/scan/${encodeURIComponent(data.customSku)}`,
                { headers: apiAuth() },
              );
              if (!res.ok) {
                toast(
                  `${data.itemType} custom catalog item is not configured. Check Custom SKU ${data.customSku}.`,
                  "error",
                );
                return false;
              }
              customItem = scanPayloadToResolvedItem((await res.json()) as Record<string, unknown>);
            } catch {
              toast(`Could not load Custom SKU ${data.customSku}. Try again.`, "error");
              return false;
            }
          }
          const resolvedItemType =
            customOrderItemTypeForSku(customItem.sku) ?? data.itemType;
          const cents = parseMoneyToCents(data.price);
          const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(data.taxCategory, cents);
          const updated: CartLineItem = {
            ...customItem,
            name:
              customOrderItemTypeForSku(customItem.sku) != null
                ? customItem.name
                : `${resolvedItemType} (Custom)`,
            standard_retail_price: data.price,
            unit_cost: "0.00",
            fulfillment: "custom",
            tax_category: data.taxCategory,
            state_tax: stateTax,
            local_tax: localTax,
            custom_item_type: resolvedItemType,
            custom_order_details: data.customOrderDetails ?? null,
            quantity: 1,
            cart_row_id: newCartRowId(),
            price_override_reason: "custom_order_booking",
            original_unit_price: String(customItem.standard_retail_price),
            is_rush: data.isRush,
            need_by_date: data.needByDate,
            needs_gift_wrap: data.needsGiftWrap,
          };
          setCustomPromptOpen(false);
          setPendingCustomItem(null);
          addItem(updated);
          return true;
        }}
      />

      {lastTransactionId && (
        <ReceiptSummaryModal
          transactionId={lastTransactionId}
          onClose={() => {
            setLastTransactionId(null);
            setCheckoutOperator(null);
            setLastReceiptOrderPaymentLines([]);
            setSelectedCustomer(null);
            onSaleCompleted?.();
          }}
          baseUrl={baseUrl}
          registerSessionId={sessionId}
          getAuthHeaders={apiAuth}
          orderPaymentLines={lastReceiptOrderPaymentLines}
          cashChangeDueCents={lastCashChangeDueCents}
          receiptTransactionLineIds={lastReceiptTransactionLineIds}
          autoPrintOnOpen
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
            registerSessionId={sessionId}
            baseUrl={baseUrl}
            apiAuth={apiAuth}
            onMakePayment={addOrderPaymentLine}
            onAddItemToOrder={addItemToExistingOrder}
            onUpdateOrderItem={updateExistingOrderItem}
            onDeleteOrderItem={deleteExistingOrderItem}
            onPickupToCart={async (order, items) => {
              const ids = items
                .map((item) => item.transaction_line_id)
                .filter((id): id is string => Boolean(id));
              return loadTransactionIntoRegister(order.id, true, false, ids);
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
              is_rush: l.is_rush,
              need_by_date: l.need_by_date ?? null,
              order_lifecycle_status: l.order_lifecycle_status,
            }))}
            customer={selectedCustomer ? {
              id: selectedCustomer.id,
              first_name: selectedCustomer.first_name,
              last_name: selectedCustomer.last_name,
              email: selectedCustomer.email ?? undefined,
              phone: selectedCustomer.phone ?? undefined,
            } : null}
            onComplete={(options) => {
              if (lines.length > 0 && !isRmsPaymentCart && !isGiftCardOnlyCart && !hasSalespersonAttribution()) {
                toast(
                  "Select a salesperson for this sale, or assign one on a line, so commissions can be calculated.",
                  "error",
                );
                return;
              }
              setCheckoutOrderOptions({
                is_rush: options.isRush,
                need_by_date: options.needByDate,
                fulfillment_mode: options.fulfillment,
                ship_to: null,
              });
              setOrderReviewOpen(false);
              openCheckoutDrawerWithGuard();
            }}
            onUpdateLineLifecycleStatus={updateLineOrderLifecycleStatus}
          />

        </>
      )}

      {showPrintRetryPanel && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Retry Failed Prints</h3>
              <button onClick={() => setShowPrintRetryPanel(false)} className="p-1 text-app-text-muted hover:text-app-text">
                <X size={18} />
              </button>
            </div>
            <PrintRetryList onRetry={() => {
              setShowPrintRetryPanel(false);
              void (async () => {
                const { getFailedPrintJobs } = await import("../../lib/printRetryQueue");
                const jobs = await getFailedPrintJobs();
                setFailedPrintCount(jobs.length);
              })();
            }} />
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}
    </div>
  );
}

function PrintRetryList({ onRetry }: { onRetry: () => void }) {
  const [jobs, setJobs] = useState<{ id: string; label: string; transactionId: string; timestamp: number; attempts: number; printableBase64: string }[]>([]);
  const { toast } = useToast();

  useEffect(() => {
    void (async () => {
      const { getFailedPrintJobs } = await import("../../lib/printRetryQueue");
      setJobs(await getFailedPrintJobs());
    })();
  }, []);

  const retry = async (job: { id: string; label: string; transactionId: string; timestamp: number; attempts: number; printableBase64?: string }) => {
    try {
      const { removeFailedPrintJob, incrementPrintAttempt } = await import("../../lib/printRetryQueue");
      const { printReceiptBase64 } = await import("../../lib/receiptPrint");
      await incrementPrintAttempt(job.id);
      if (!job.printableBase64) throw new Error("Missing print payload");
      await printReceiptBase64(job.printableBase64);
      await removeFailedPrintJob(job.id);
      toast(`Re-printed ${job.label}`, "success");
      setJobs((prev) => prev.filter((j) => j.id !== job.id));
      onRetry();
    } catch (e) {
      toast(String(e) || "Print retry failed", "error");
    }
  };

  const dismiss = async (id: string) => {
    const { removeFailedPrintJob } = await import("../../lib/printRetryQueue");
    await removeFailedPrintJob(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
    onRetry();
  };

  if (jobs.length === 0) {
    return <p className="text-center text-sm text-app-text-muted">No failed prints to retry.</p>;
  }

  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {jobs.map((job) => (
        <div key={job.id} className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 p-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-black text-app-text">{job.label}</p>
            <p className="text-[10px] text-app-text-muted">Tx: {job.transactionId.slice(-8)} · Attempts: {job.attempts}</p>
          </div>
          <button
            onClick={() => void retry(job)}
            className="ui-btn-secondary shrink-0 px-3 py-1.5 text-[10px] font-black uppercase"
          >
            Retry
          </button>
          <button
            onClick={() => void dismiss(job.id)}
            className="shrink-0 p-1.5 text-app-text-muted hover:text-app-danger"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
