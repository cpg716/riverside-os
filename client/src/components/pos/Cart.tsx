import { getBaseUrl } from "../../lib/apiConfig";
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
  X,
  ArrowLeftRight,
  Truck,
  UserCircle,
  Clock,
  Zap,
  Package,
  ScanSearch,
  Scissors,
  CreditCard,
  Pencil,
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
import { customOrderItemTypeForSku } from "../../lib/customOrders";
import CustomItemPromptModal from "./CustomItemPromptModal";
import OrderLoadModal, { type CustomerOrder } from "./OrderLoadModal";
import OrderReviewModal from "./OrderReviewModal";
import PosAlterationIntakeModal from "./PosAlterationIntakeModal";
import ManagerApprovalModal from "./ManagerApprovalModal";
import PromptModal from "../ui/PromptModal";

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
  type PosOrderOptions,
  type PendingAlterationIntake,
  type OrderPaymentCartLine
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

const WEDDINGS_ICON = getAppIcon("weddings");
const GIFT_CARDS_ICON = getAppIcon("giftCards");
const ORDER_HISTORY_ICON = getAppIcon("orderHistory");
const ALTERATION_SERVICE_PRODUCT_ID = "b7c0a006-0006-4006-8006-000000000006";
const ALTERATION_SERVICE_VARIANT_ID = "b7c0a007-0007-4007-8007-000000000007";
const ALTERATION_SERVICE_SKU = "ROS-ALTERATION-SERVICE";

interface OpenDepositPrompt {
  cents: number;
  payerName: string | null;
  customerId: string;
}

interface HandoffOrderDetail {
  transaction_id: string;
  transaction_display_id?: string;
  fulfillment_method?: string;
  shipping_amount_usd?: string | null;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    email?: string | null;
    phone?: string | null;
    customer_code?: string | null;
    company_name?: string | null;
  } | null;
  items: Array<{
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
  }>;
}

interface CartProps {
  sessionId: string;
  cashierName?: string | null;
  cashierCode?: string | null;
  initialCustomer?: Customer | null;
  onInitialCustomerConsumed?: () => void;
  initialTransactionId?: string | null;
  onInitialTransactionConsumed?: () => void;
  initialWeddingLookupOpen?: boolean;
  managerMode?: boolean;
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
  cashierName = null,
  initialCustomer = null,
  onInitialCustomerConsumed,
  initialTransactionId = null,
  onInitialTransactionConsumed,
  managerMode = false,
  // initialWeddingLookupOpen removed
  initialWeddingPosLink = null,
  onInitialWeddingPosLinkConsumed,
  onSaleCompleted,
  onRegisterTransactionCommitted,
  onExitPosMode,
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
    employeeCustomerId
  } = useBackofficeAuth();

  const hasAccess = staffRole === "admin";
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();

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
  const [suitSwapWizardOpen, setSuitSwapWizardOpen] = useState(false);
  const [openDepositPrompt, setOpenDepositPrompt] = useState<OpenDepositPrompt | null>(null);
  const [intelligenceVariantId, setIntelligenceVariantId] = useState<string | null>(null);
  const openDepositSuppressedRef = useRef(false);

  const [activeDiscountEvents, setActiveDiscountEvents] = useState<ActiveDiscountEvent[]>([]);
  const [selectedDiscountEventId, setSelectedDiscountEventId] = useState("");
  const [exchangeWizardInitialTransactionId, setExchangeWizardInitialTransactionId] = useState<string | null>(null);

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
  const [parkSalePromptOpen, setParkSalePromptOpen] = useState(false);
  const [parkSaleDraftLabel, setParkSaleDraftLabel] = useState("");

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

  const clearCartAndAlterations = useCallback(() => {
    clearCart();
    setPendingAlterationIntakes([]);
    setEditingAlterationIntake(null);
    setOrderPaymentLines([]);
    setEditingOrderPaymentLine(null);
    setEditingOrderPaymentAmount("");
  }, [clearCart]);

  useEffect(() => {
    const customerId = selectedCustomer?.id ?? null;
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
      tax_category: "other",
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
      toast("Select a customer before adding an order payment.", "error");
      return;
    }
    const orderCustomerId = order.customer_id ?? selectedCustomer.id;
    if (orderCustomerId !== selectedCustomer.id) {
      toast("That order belongs to a different customer. Select the matching customer first.", "error");
      return;
    }
    const balanceCents = parseMoneyToCents(order.balance_due);
    if (amountCents <= 0) {
      toast("Enter an order payment amount greater than $0.00.", "error");
      return;
    }
    if (amountCents > balanceCents) {
      toast("Order payment cannot be more than the balance due.", "error");
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
    toast(`Payment for ${orderPaymentDisplayId} added to this sale.`, "success");
  }, [selectedCustomer, toast]);

  const openOrderPaymentEdit = useCallback((line: OrderPaymentCartLine) => {
    setEditingOrderPaymentLine(line);
    setEditingOrderPaymentAmount(line.amount);
  }, []);

  const saveOrderPaymentEdit = useCallback(() => {
    if (!editingOrderPaymentLine) return;
    const amountCents = parseMoneyToCents(editingOrderPaymentAmount);
    const balanceCents = parseMoneyToCents(editingOrderPaymentLine.balance_before);
    if (amountCents <= 0) {
      toast("Enter an order payment amount greater than $0.00.", "error");
      return;
    }
    if (amountCents > balanceCents) {
      toast("Order payment cannot be more than the balance due.", "error");
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
        const pC = parseMoneyToCents(l.standard_retail_price);
        const stC = parseMoneyToCents(l.state_tax);
        const ltC = parseMoneyToCents(l.local_tax);
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
      disbCents += parseMoneyToCents(m.balance_due || "0");
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

  const isRmsPaymentCart = useMemo(() => lines.some(l => rmsPaymentMeta && l.sku === rmsPaymentMeta.sku), [lines, rmsPaymentMeta]);
  const isGiftCardOnlyCart = useMemo(() => lines.length > 0 && lines.every(l => !!l.gift_card_load_code), [lines]);
  const hasCheckoutWork = lines.length > 0 || orderPaymentLines.length > 0;

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
    pendingAlterationIntakes,
    orderPaymentLines,
    pickupConfirmed,
    totals,
    toast,
    clearCart: clearCartAndAlterations,
    onSaleCompleted,
    ensurePosTokenForSession,
  });
  useEffect(() => {
    if (checkoutTransactionId) {
      setLastTransactionId(checkoutTransactionId);
      setCheckoutDrawerOpen(false);
      onRegisterTransactionCommitted?.();
    }
  }, [checkoutTransactionId, onRegisterTransactionCommitted]);

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
    pendingAlterationIntakes,
    orderPaymentLines,
    setLines,
    setSelectedCustomer,
    setActiveWeddingMember,
    setActiveWeddingPartyName,
    setPosShipping,
    setPrimarySalespersonId,
    setCheckoutOperator,
    setPendingAlterationIntakes,
    setOrderPaymentLines,
    clearCart: clearCartAndAlterations,
  });


  // pendingExchangeOriginalOrderIdRef removed
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const didInitialProductSearchFocusRef = useRef(false);
  const initialTransactionApplyingRef = useRef<string | null>(null);
  const initialTransactionAppliedRef = useRef<string | null>(null);
  const [exchangeWizardOpen, setExchangeWizardOpen] = useState(false);
  const [shippingModalOpen, setShippingModalOpen] = useState(false);

  const handleTransactionBarcode = useCallback(async (shortId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/transactions?search=${encodeURIComponent(shortId)}&limit=5`, { headers: apiAuth() as Record<string, string> });
      if (!res.ok) throw new Error("API error");
      const data = await res.json();
      const items = Array.isArray(data.items) ? data.items : [];
      const txn = items.find((i: { transaction_id: string; display_id: string; status: string; customer_id?: string }) => 
        (i.transaction_id || "").toLowerCase().startsWith(shortId.toLowerCase()) ||
        (i.display_id || "").toLowerCase().includes(shortId.toLowerCase())
      );
      if (!txn) {
        toast("Receipt barcode not found in the system.", "error");
        return;
      }
      if ((txn.status || "").toLowerCase() === "fulfilled") {
        setExchangeWizardInitialTransactionId(txn.transaction_id);
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
              phone: c.phone ?? null
            });
            setOrderLoadOpen(true);
          } else {
            toast("Could not load the customer for this order.", "error");
          }
        } else {
          toast("Order has no customer attached.", "error");
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

  const loadTransactionIntoRegister = useCallback(
    async (transactionId: string) => {
      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        toast("We couldn't load that transaction into the register. Please try again.", "error");
        return false;
      }

      const detail = (await res.json()) as HandoffOrderDetail;
      const unfulfilled = (detail.items ?? []).filter(
        (item) => !item.is_fulfilled && !item.is_internal,
      );

      if (unfulfilled.length === 0) {
        toast("All transaction lines are already marked complete.", "info");
        return false;
      }

      clearCartAndAlterations();
      setActiveWeddingMember(null);
      setActiveWeddingPartyName(null);
      setDisbursementMembers([]);
      setPosShipping(null);
      setCheckoutOrderOptions(null);
      setSelectedLineKey(null);

      if (detail.customer) {
        setSelectedCustomer({
          id: detail.customer.id,
          customer_code: detail.customer.customer_code ?? "",
          first_name: detail.customer.first_name,
          last_name: detail.customer.last_name,
          company_name: detail.customer.company_name ?? null,
          email: detail.customer.email ?? null,
          phone: detail.customer.phone ?? null,
        });
      } else {
        setSelectedCustomer(null);
      }

      setLines(
        unfulfilled.map((item) => ({
          product_id: item.product_id,
          variant_id: item.variant_id,
          sku: item.sku,
          name: item.product_name,
          variation_label: item.variation_label ?? "",
          standard_retail_price: item.unit_price,
          unit_cost: item.unit_cost ?? "0",
          state_tax: item.state_tax ?? "0",
          local_tax: item.local_tax ?? "0",
          quantity: Math.max(1, item.quantity),
          fulfillment: item.fulfillment,
          cart_row_id: newCartRowId(),
          custom_item_type: item.custom_item_type ?? undefined,
          custom_order_details: item.custom_order_details ?? null,
        })),
      );

      if (detail.fulfillment_method === "ship" || parseMoneyToCents(detail.shipping_amount_usd ?? "0") > 0) {
        toast(
          `Loaded ${detail.transaction_display_id ?? "order"} into the register. Review shipping details before checkout because this handoff starts a new sale.`,
          "info",
        );
      } else {
        toast(
          `Loaded ${detail.transaction_display_id ?? "order"} into the register. This starts a new sale and does not collect payment on the original order.`,
          "info",
        );
      }
      return true;
    },
    [apiAuth, baseUrl, clearCartAndAlterations, setActiveWeddingMember, setActiveWeddingPartyName, setCheckoutOrderOptions, setDisbursementMembers, setLines, setPosShipping, setSelectedLineKey, toast],
  );

  useEffect(() => {
    if (!initialTransactionId) {
      return;
    }
    if (!saleHydrated) return;
    if (
      initialTransactionApplyingRef.current === initialTransactionId ||
      initialTransactionAppliedRef.current === initialTransactionId
    ) {
      return;
    }
    initialTransactionApplyingRef.current = initialTransactionId;
    void (async () => {
      await loadTransactionIntoRegister(initialTransactionId);
      initialTransactionAppliedRef.current = initialTransactionId;
      if (initialTransactionApplyingRef.current === initialTransactionId) {
        initialTransactionApplyingRef.current = null;
      }
      onInitialTransactionConsumed?.();
    })();
  }, [initialTransactionId, loadTransactionIntoRegister, onInitialTransactionConsumed, saleHydrated]);

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
    onScan: (code) => {
      const trimmed = code.trim();
      const txnMatch = trimmed.match(/^TXN-([0-9A-Fa-f]{8})$/i);
      if (txnMatch) {
         void handleTransactionBarcode(txnMatch[1]);
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
      className="relative grid h-full w-full bg-app-bg overflow-y-auto lg:overflow-hidden lg:[grid-template-columns:minmax(0,1fr)_clamp(300px,28vw,376px)]"
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
      <div className="relative z-0 flex min-w-0 flex-col border-r border-app-border">
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
                  <div className="hidden h-6 w-px shrink-0 bg-app-border/80 sm:block" aria-hidden />
                  <UserCircle
                    size={16}
                    className="hidden shrink-0 text-app-accent sm:block"
                    aria-hidden
                  />
                  <label className="flex min-w-0 max-w-full basis-full items-center gap-2 sm:basis-auto sm:max-w-[min(100%,22.5rem)]">
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
                      className="w-full sm:min-w-[12rem]"
                    />
                  </label>
                  {lines.some((l) => (l.salesperson_id?.trim() ?? "") !== "") ? (
                    <span className="shrink-0 rounded-full bg-app-warning/12 px-2 py-1 text-[9px] font-black uppercase tracking-wide text-app-warning ring-1 ring-app-warning/20">
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
              className="ui-input h-11 w-full border-2 border-app-border pl-10 pr-28 text-base font-black shadow-inner focus:border-app-accent"
            />
            <button
              type="button"
              onClick={focusProductSearch}
              title="Focus product search (/)"
              className="ui-touch-target absolute right-1.5 top-1/2 z-10 flex min-h-10 -translate-y-1/2 items-center gap-1 rounded-lg border border-app-border bg-app-surface-2 px-3 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text"
            >
              <ScanSearch size={12} aria-hidden />
              Focus /
            </button>
            <PosSearchResultList
              search={search}
              groupedSearchResults={groupedSearchResults}
              onSearchResultClick={onSearchResultClick}
            />
          </div>

          {/* Sale tools row */}
          <div className="flex flex-wrap items-center gap-2 border-t border-app-border/50 pt-2">
              <button
                type="button"
                onClick={() => {
                  setWeddingDrawerPreferGroupPay(false);
                  setWeddingDrawerOpen(true);
                }}
                className={`ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 px-3 transition-all active:scale-95 ${activeWeddingMember ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20" : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-accent"}`}
              >
                <WEDDINGS_ICON size={16} />
                <span className="text-[10px] font-black uppercase tracking-widest">
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
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-accent/40 bg-app-accent/5 px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-all hover:bg-app-accent hover:text-white active:scale-95"
              >
                <Scissors size={16} />
                Alteration
              </button>
              <button
                type="button"
                data-testid="pos-exchange-wizard-trigger"
                onClick={() => setExchangeWizardOpen(true)}
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-border bg-app-surface-2 px-3 text-app-text-muted transition-all hover:border-app-accent/40 hover:bg-app-surface hover:text-app-accent active:scale-95"
              >
                <ArrowLeftRight size={16} />
                <span className="text-[10px] font-black uppercase tracking-widest">
                  Exchange / Return
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
                className={`ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 px-3 transition-all active:scale-95 ${lines.some(l => l.fulfillment === 'layaway') ? "border-app-warning bg-app-warning/10 text-app-warning" : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-warning/35 hover:bg-app-surface hover:text-app-warning"}`}
              >
                <Clock size={16} />
                <span className="text-[10px] font-black uppercase tracking-widest">
                  Layaway
                </span>
              </button>
              <div className="min-w-[8px] flex-1" aria-hidden="true" />
              <button
                type="button"
                data-testid="pos-action-gift-card"
                onClick={() => setGiftCardLoadOpen(true)}
                title="Enter load amount, then scan or type the card code"
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-success/35 bg-app-success/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-success transition-all hover:bg-app-success hover:text-white"
              >
                <GIFT_CARDS_ICON size={16} className="shrink-0" aria-hidden />
                Gift Card
              </button>
              <button
                type="button"
                disabled={lines.length === 0}
                onClick={() => {
                   const label = selectedCustomer ? `Sale for ${selectedCustomer.first_name} ${selectedCustomer.last_name}` : "Untitled Sale";
                   setParkSaleDraftLabel(label);
                   setParkSalePromptOpen(true);
                }}
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-accent/40 bg-app-accent/5 px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-all hover:bg-app-accent hover:text-white disabled:opacity-20"
              >
                <Clock size={16} />
                Park Sale
              </button>
              <button
                type="button"
                disabled={lines.length === 0 && !selectedCustomer}
                onClick={() => setShowClearConfirm(true)}
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-danger/35 bg-app-danger/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-danger transition-all hover:bg-app-danger hover:text-white disabled:opacity-20"
              >
                <RotateCcw size={16} />
                Clear Sale
              </button>
              <button
                type="button"
                onClick={() => setOrderReviewOpen(true)}
                disabled={lines.length === 0}
                title="Set rush and pickup/order details. Use Shipping to ship this current sale."
                className="ui-touch-target flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-success/35 bg-app-success/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-success transition-all hover:bg-app-success hover:text-white disabled:opacity-20"
              >
                <Zap size={16} className="shrink-0" aria-hidden />
                Options
              </button>
              <button
                type="button"
                disabled={!selectedCustomer}
                onClick={() => setOrderLoadOpen(true)}
                title={selectedCustomer ? "View previous orders for this customer" : "Select a customer to view orders"}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-info/35 bg-app-info/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-info transition-all hover:bg-app-info hover:text-white disabled:opacity-20"
              >
                <ORDER_HISTORY_ICON size={16} className="shrink-0" aria-hidden />
                Orders
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
                  Will link to checkout
                </span>
              </div>
            </div>
          ) : null}
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
                  removeLine={removeLineWithAlterationHandling}
                  onEditAlterationLine={(intakeId) => {
                    const intake = pendingAlterationIntakes.find((row) => row.id === intakeId);
                    if (!intake) return;
                    setEditingAlterationIntake(intake);
                    setAlterationIntakeOpen(true);
                  }}
                  onLineProductTitleClick={openLineProductBrowser}
                  commissionStaff={commissionStaff}
                  orderSalespersonLabel={primarySalespersonLabel}
                  hideLineSalesperson={isGiftCardOnlyCart}
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
                  Existing order payments are ready below. No new merchandise is being sold.
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
                  Existing Order Payments
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
                        Payment on {line.target_display_id}
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
                          {centsToFixed2(parseMoneyToCents(m.balance_due || "0"))}
                        </p>
                     </div>
                     <button 
                       onClick={() => setDisbursementMembers(prev => prev.filter(p => p.id !== m.id))}
                    className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-app-danger/90 text-white shadow-lg opacity-0 transition-opacity group-hover:opacity-100"
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
        className={`relative z-0 flex h-full min-h-0 w-full flex-col overflow-hidden border-l border-app-border/80 bg-[color-mix(in_srgb,var(--app-surface-2)_84%,var(--app-bg))] shadow-[-8px_0_32px_-12px_rgba(15,23,42,0.18)] ${checkoutDrawerOpen ? "pointer-events-none select-none opacity-40" : ""}`}
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
                {managerMode && lines.length > 0 ? (
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
                  <span>Existing order payments</span>
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
                  ? "Quantity — type amount, Apply"
                  : "Sale price — % off reg price, $ or Apply for dollars"
                : "Select a line, then tap Qty or Sale price"}
            </p>
            <p
              className="mt-0.5 text-right text-lg font-black tabular-nums text-app-text sm:text-xl"
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
                onClick={() => handleNumpadKey("%")}
                className="flex cursor-pointer items-center justify-center rounded-xl border-b-4 border-app-info bg-app-info text-lg font-black text-white shadow-xl shadow-app-info/20 transition-all duration-150 hover:brightness-110 active:translate-y-0.5 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-info/25 disabled:cursor-not-allowed disabled:opacity-35 sm:text-xl"
              >
                %
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
        <div className="shrink-0 border-t border-app-border/70 bg-app-surface/95 p-2.5 shadow-[0_-10px_40px_-18px_rgba(0,0,0,0.15)] backdrop-blur-sm">
           <button 
             type="button" 
             data-testid="pos-pay-button"
             disabled={!hasCheckoutWork || checkoutBusy}
             onClick={() => {
               if (!hasCheckoutWork) return toast("Add at least one item or order payment before checking out.", "error");
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

               if (lines.length > 0 && hasSpecialOrWeddingLines && !orderReviewOpen) {
                 setOrderReviewOpen(true);
                 return;
               }

               if (lines.length > 0 && !isRmsPaymentCart && !isGiftCardOnlyCart) {
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
             className={`ui-touch-target group relative flex h-[4.25rem] w-full items-center justify-between rounded-2xl border-b-[6px] transition-all duration-150 active:translate-y-0.5 active:scale-[0.98] shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-success/25 ${hasCheckoutWork ? 'bg-app-success border-app-success text-white hover:brightness-110 shadow-app-success/40' : 'bg-app-surface-2 border-app-border text-app-text-muted cursor-not-allowed opacity-50'}`}
           >
             <div className="flex flex-col items-start pl-3 sm:pl-5">
                <span className="text-[9px] font-black uppercase tracking-[0.28em] opacity-70">
                  {selectedCustomer ? `${selectedCustomer.first_name} ${selectedCustomer.last_name} — Pay` : "Walk-in — Pay"}
                </span>
                <span className="text-2xl font-black tabular-nums tracking-tighter italic sm:text-3xl">${centsToFixed2(totals.totalCents)}</span>
             </div>
             <div className="mr-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/20 transition-transform group-hover:scale-105 sm:mr-4 sm:h-11 sm:w-11">
                <span className="text-lg font-black uppercase italic">Pay</span>
             </div>
           </button>
        </div>
      </aside>

      {editingOrderPaymentLine ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:px-4">
          <div
            className="w-full max-w-none rounded-t-3xl border border-app-border bg-app-surface p-5 shadow-2xl sm:max-w-sm sm:rounded-2xl"
            data-testid="pos-order-payment-edit-modal"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
                  Edit Order Payment
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
                aria-label="Close order payment edit"
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
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
        onFinalize={async (applied, op, ledger) => {
          setLastReceiptOrderPaymentLines(orderPaymentLines);
          await executeCheckout(applied, op, ledger, checkoutOrderOptions || undefined);
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
        <div className="fixed inset-0 z-[110] flex items-end justify-center p-0 font-sans sm:items-center sm:p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setParkedListOpen(false)}
            aria-label="Close parked sales"
          />
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
        <div className="fixed inset-0 z-[115] flex items-end justify-center p-0 font-sans sm:items-center sm:p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={() => setParkedCustomerPrompt(null)}
            aria-label="Dismiss parked sale prompt"
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
        message="Name this parked sale so another cashier can find it quickly."
        placeholder="Sale label"
        defaultValue={parkSaleDraftLabel}
        confirmLabel="Park Sale"
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
              clearCartAndAlterations();
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
        initialTransactionId={exchangeWizardInitialTransactionId}
        customer={selectedCustomer}
        onClose={() => {
          setExchangeWizardOpen(false);
          setExchangeWizardInitialTransactionId(null);
        }}
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
            toast("We couldn't verify manager approval. Please try again.", "error");
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
                  toast("We couldn't add that item. Try searching again or scan the SKU.", "error");
                  return;
                }
                const r = (await res.json()) as Record<string, unknown>;
                item = scanPayloadToResolvedItem(r) as SearchResult;
              } catch {
                toast("We couldn't add that item. Please try again.", "error");
                return;
              }
            }
            addItem(item, priceOverride);
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
        onConfirm={(data) => {
          if (!pendingCustomItem) return;
          const resolvedItemType =
            customOrderItemTypeForSku(pendingCustomItem.sku) ?? data.itemType;
          const cents = parseMoneyToCents(data.price);
          const { stateTax, localTax } = calculateNysErieTaxStringsForUnit(data.taxCategory, cents);
          const updated: CartLineItem = {
            ...pendingCustomItem,
            name:
              customOrderItemTypeForSku(pendingCustomItem.sku) != null
                ? pendingCustomItem.name
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
            original_unit_price: String(pendingCustomItem.standard_retail_price),
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
            setLastReceiptOrderPaymentLines([]);
            onSaleCompleted?.();
          }}
          baseUrl={baseUrl}
          registerSessionId={sessionId}
          getAuthHeaders={apiAuth}
          orderPaymentLines={lastReceiptOrderPaymentLines}
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
            onCopyOrder={(order, items) => {
              void (async () => {
                try {
                  // Clear cart and setup for recall
                  clearCartAndAlterations();
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
                  toast(
                    `Unfulfilled lines from ${order.display_id} were copied into the register. This starts a new sale and does not collect payment on the original order.`,
                    "info",
                  );
                } catch (e) {
                  toast(
                    e instanceof Error
                      ? e.message
                      : "We couldn't copy that order into the register. Please try again.",
                    "error",
                  );
                }
              })();
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
                ship_to: null,
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
