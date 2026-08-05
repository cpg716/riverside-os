import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  Package,
  Clock,
  AlertCircle,
  ArrowRight,
  CreditCard,
  Plus,
  Save,
  Trash2,
  ShieldCheck,
  Ban,
  Truck,
  Scissors,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import ManagerApprovalModal from "./ManagerApprovalModal";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import VariantSearchInput, {
  type VariantSearchResult,
} from "../ui/VariantSearchInput";
import VariantSelectionModal, {
  type ProductWithVariants,
  type VariantOption,
} from "./VariantSelectionModal";
import { isOrderStatus, REGISTER_ORDER_STATUS_SCOPE } from "./orderLoadStatus";
import { printReceiptPayload } from "../../lib/receiptPrint";
import type { OrderPaymentCartLine } from "./types";

export interface CustomerOrder {
  id: string;
  transaction_id?: string;
  customer_id?: string | null;
  display_id: string;
  order_payment_display_id?: string | null;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  order_kind: string;
  fulfillment_method?: string | null;
  is_rush: boolean;
  need_by_date: string | null;
  wedding_member_id?: string | null;
  party_name?: string | null;
}

export interface OrderItem {
  transaction_line_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned?: number;
  quantity_cancelled?: number;
  unit_price: string;
  fulfillment: string;
  order_lifecycle_status?: string | null;
  alteration_status?: string | null;
  is_fulfilled: boolean;
  is_rush?: boolean;
  need_by_date?: string | null;
}

export interface PickupSelection {
  order: CustomerOrder;
  items: OrderItem[];
}

interface ReadyAlteration {
  id: string;
  status: string;
  item_description: string | null;
  work_requested: string | null;
  due_at: string | null;
  source_type: string | null;
  source_sku: string | null;
  ticket_number: string | null;
  charge_amount: string | number | null;
}

interface OrderLoadModalProps {
  isOpen: boolean;
  customerId: string;
  customerName: string;
  registerSessionId?: string | null;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onClose: () => void;
  stagedOrderPayments?: OrderPaymentCartLine[];
  onMakePayment?: (order: CustomerOrder, amountCents: number) => void;
  onAddItemToOrder?: (order: CustomerOrder, sku: string) => Promise<boolean>;
  onUpdateOrderItem?: (
    order: CustomerOrder,
    item: OrderItem,
    patch: {
      quantity?: number;
      unit_price?: string;
      variant_id?: string;
      order_lifecycle_status?: string;
    },
  ) => Promise<boolean>;
  onDeleteOrderItem?: (
    order: CustomerOrder,
    item: OrderItem,
  ) => Promise<boolean>;
  onPickupToCart?: (
    selections: PickupSelection[],
    options?: { continueToPayment?: boolean },
  ) => Promise<boolean>;
  onCancelledToRefundCart?: (order: CustomerOrder) => Promise<boolean>;
  onRecordedRefundToCart?: (order: CustomerOrder) => Promise<boolean>;
}

interface OrderItemCancellationPreview {
  transaction_id: string;
  original_balance_due: string;
  cancellation_total: string;
  credit_applied_to_balance: string;
  revised_total: string;
  balance_due_after: string;
  refund_due: string;
  amount_paid: string;
  lines: Array<{
    transaction_line_id: string;
    product_name: string;
    sku: string;
    quantity: number;
    total_credit: string;
    inventory_disposition: string;
  }>;
}

const fulfillmentLabel = (fulfillment: string) => {
  switch (fulfillment) {
    case "wedding_order":
      return "Wedding Order";
    case "special_order":
      return "Special Order";
    case "custom":
      return "Custom Order";
    case "layaway":
      return "Layaway";
    case "takeaway":
      return "Takeaway";
    default:
      return "Fulfillment";
  }
};

type ReleaseMode = "pickup" | "ship";

const orderReleaseMode = (order?: CustomerOrder | null): ReleaseMode =>
  order?.fulfillment_method === "ship" ? "ship" : "pickup";

const releaseLabel = (mode: ReleaseMode) =>
  mode === "ship" ? "Ship" : "Pick Up";

const remainingOrderItemQuantity = (item: OrderItem) =>
  Math.max(0, item.quantity - Math.max(0, item.quantity_returned ?? 0));

const isFullyCancelledOrderItem = (item: OrderItem) =>
  (item.quantity_cancelled ?? 0) > 0 &&
  (item.quantity_cancelled ?? 0) >= item.quantity;

const isCompletedOrderItem = (item: OrderItem) =>
  item.is_fulfilled ||
  item.order_lifecycle_status === "picked_up" ||
  remainingOrderItemQuantity(item) === 0;

export default function OrderLoadModal({
  isOpen,
  customerId,
  customerName,
  registerSessionId,
  baseUrl,
  apiAuth,
  onClose,
  stagedOrderPayments = [],
  onMakePayment,
  onAddItemToOrder,
  onUpdateOrderItem,
  onDeleteOrderItem,
  onPickupToCart,
  onCancelledToRefundCart,
  onRecordedRefundToCart,
}: OrderLoadModalProps) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [alterations, setAlterations] = useState<ReadyAlteration[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrderItems, setSelectedOrderItems] = useState<OrderItem[]>([]);
  const [viewingItemsOrderId, setViewingItemsOrderId] = useState<string | null>(
    null,
  );
  const [paymentOrder, setPaymentOrder] = useState<CustomerOrder | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [addSku, setAddSku] = useState("");
  const [orderMutationBusy, setOrderMutationBusy] = useState(false);
  const [variantPicker, setVariantPicker] = useState<{
    item: OrderItem;
    product: ProductWithVariants;
  } | null>(null);
  const [variantUpdateConfirmation, setVariantUpdateConfirmation] = useState<{
    transactionLineId: string;
    before: string;
    after: string;
    retainedPrice: string;
  } | null>(null);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupPaymentDecision, setPickupPaymentDecision] = useState<{
    balanceDueCents: number;
    stagedPaymentCents: number;
    remainingBalanceCents: number;
  } | null>(null);
  const [pickupConfirm, setPickupConfirm] = useState<{
    mode: ReleaseMode;
    order: CustomerOrder;
    items: OrderItem[];
    blockedItems: OrderItem[];
  } | null>(null);
  const [cancelOrder, setCancelOrder] = useState<CustomerOrder | null>(null);
  const [cancelRefundLoadPending, setCancelRefundLoadPending] = useState(false);
  const [cancelItem, setCancelItem] = useState<OrderItem | null>(null);
  const [cancelItemReason, setCancelItemReason] = useState("");
  const [cancelItemPreview, setCancelItemPreview] =
    useState<OrderItemCancellationPreview | null>(null);
  const [cancelItemError, setCancelItemError] = useState<string | null>(null);
  const [lastCancellationResult, setLastCancellationResult] =
    useState<OrderItemCancellationPreview | null>(null);
  const [lastCancellationHandoffError, setLastCancellationHandoffError] =
    useState<string | null>(null);
  const [pickupSelection, setPickupSelection] = useState<
    Record<string, boolean>
  >({});
  const [pickupBasket, setPickupBasket] = useState<PickupSelection[]>([]);
  const [lineDrafts, setLineDrafts] = useState<
    Record<
      string,
      {
        quantity: string;
        unit_price: string;
        variant_id: string;
        sku: string;
        variation_label: string | null;
        order_lifecycle_status: string;
      }
    >
  >({});

  const fetchOrderItems = async (orderId: string) => {
    const params = new URLSearchParams();
    if (registerSessionId) params.set("register_session_id", registerSessionId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(
      `${baseUrl}/api/transactions/${orderId}/items${suffix}`,
      {
        headers: apiAuth(),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        body.error || `Could not load order lines (${res.status})`,
      );
    }
    const data = (await res.json()) as OrderItem[];
    return Array.isArray(data) ? data : [];
  };

  const loadOrderItems = async (orderId: string) => {
    setViewingItemsOrderId(orderId);
    try {
      const items = await fetchOrderItems(orderId);
      setSelectedOrderItems(items);
      const activeItems = items.filter(
        (item) => !isFullyCancelledOrderItem(item),
      );
      const allCompleted =
        activeItems.length > 0 &&
        activeItems.every(
          (item) =>
            item.is_fulfilled || item.order_lifecycle_status === "picked_up",
        );
      setOrders((previous) =>
        previous.map((order) =>
          order.id === orderId && allCompleted
            ? { ...order, status: "fulfilled" }
            : order,
        ),
      );
      setPickupSelection(
        Object.fromEntries(
          items
            .filter((item) => !isCompletedOrderItem(item))
            .map((item) => [item.transaction_line_id, true]),
        ),
      );
      setLineDrafts(
        Object.fromEntries(
          items.map((item) => [
            item.transaction_line_id,
            {
              quantity: String(item.quantity),
              unit_price: item.unit_price,
              variant_id: item.variant_id,
              sku: item.sku,
              variation_label: item.variation_label,
              order_lifecycle_status: item.order_lifecycle_status ?? "ntbo",
            },
          ]),
        ),
      );
    } catch (e) {
      setSelectedOrderItems([]);
      setPickupSelection({});
      setLineDrafts({});
      toast(
        e instanceof Error
          ? e.message
          : "We couldn't load those order lines. Please try again.",
        "error",
      );
    }
  };

  useEffect(() => {
    if (!isOpen || !customerId) return;
    setPickupBasket([]);
    setPickupPaymentDecision(null);
    setSelectedOrderItems([]);
    setViewingItemsOrderId(null);
    setLastCancellationResult(null);
    setLastCancellationHandoffError(null);
    setLoading(true);
    const params = new URLSearchParams({
      customer_id: customerId,
      limit: "25",
      record_scope: "orders",
      status_scope: REGISTER_ORDER_STATUS_SCOPE,
    });
    if (registerSessionId) params.set("register_session_id", registerSessionId);
    const orderRequest = fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
      headers: apiAuth(),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load customer orders");
        return r.json();
      })
      .then((data) => {
        const rows = Array.isArray(data?.items) ? data.items : [];
        setOrders(
          rows.map((row: CustomerOrder) => ({
            ...row,
            id: row.id ?? row.transaction_id,
          })),
        );
      })
      .catch(() => {
        setOrders([]);
        toast(
          "We couldn't load this customer's orders. Please try again.",
          "error",
        );
      })
      .finally(() => setLoading(false));
    const alterationRequest = fetch(
      `${baseUrl}/api/alterations?${new URLSearchParams({ customer_id: customerId, limit: "200" }).toString()}`,
      { headers: apiAuth() },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error("Could not load customer alterations");
        return r.json();
      })
      .then((rows) => setAlterations(
        (Array.isArray(rows) ? rows : []).filter((row: ReadyAlteration) => row.status !== "picked_up"),
      ))
      .catch(() => setAlterations([]));
    void Promise.all([orderRequest, alterationRequest]);
  }, [isOpen, customerId, registerSessionId, baseUrl, apiAuth, toast]);

  const pickupAlteration = async (alteration: ReadyAlteration) => {
    if (!registerSessionId) {
      toast("Open a Register session before completing an alteration pickup.", "error");
      return;
    }
    setPickupBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${alteration.id}/pickup`, {
        method: "POST",
        headers: { ...apiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ register_session_id: registerSessionId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Alteration pickup could not be completed.", "error");
        return;
      }
      setAlterations((rows) => rows.filter((row) => row.id !== alteration.id));
      const receipt = await fetch(`${baseUrl}/api/alterations/${alteration.id}/pickup-receipt?${new URLSearchParams({ register_session_id: registerSessionId }).toString()}`, {
        headers: apiAuth(),
      });
      if (receipt.ok) {
        const data = (await receipt.json()) as { escpos_base64?: string; receiptline_markdown?: string };
        await printReceiptPayload({ escposBase64: data.escpos_base64, receiptlineMarkdown: data.receiptline_markdown }, { cpl: 42 });
      }
      toast("Alteration pickup completed at this Register.", "success");
    } catch {
      toast("Alteration pickup could not be completed. Check the Register connection.", "error");
    } finally {
      setPickupBusy(false);
    }
  };

  const formatCurrency = (amount: string) =>
    formatUsdFromCents(parseMoneyToCents(amount));

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString();
  };

  const selectedOrder = useMemo(
    () => orders.find((order) => order.id === viewingItemsOrderId) ?? null,
    [orders, viewingItemsOrderId],
  );

  const lifecycleLabel = (order: CustomerOrder) => {
    const paidCents = parseMoneyToCents(order.amount_paid);
    const dueCents = parseMoneyToCents(order.balance_due);
    const isWedding =
      order.order_kind === "wedding_order" || Boolean(order.wedding_member_id);
    if (isOrderStatus(order.status, "fulfilled")) return "Picked up";
    if (isOrderStatus(order.status, "pending_measurement"))
      return "Waiting on measurements";
    if (isWedding && dueCents <= 0) return "Wedding balance paid";
    if (isWedding && paidCents > 0 && dueCents > 0)
      return "Wedding deposit received";
    if (paidCents > 0 && dueCents > 0) return "Deposit received";
    if (dueCents <= 0) return "Balance paid";
    return "Balance still due";
  };

  const lifecycleNote = (order: CustomerOrder) => {
    const isWedding =
      order.order_kind === "wedding_order" || Boolean(order.wedding_member_id);
    if (isOrderStatus(order.status, "fulfilled")) {
      return isWedding
        ? "This wedding order is already completed at pickup."
        : "These items are already marked picked up.";
    }
    if (isOrderStatus(order.status, "pending_measurement")) {
      return isWedding
        ? "Do not promise pickup until measurements, booking details, and wedding-member follow-up are complete."
        : "Do not promise pickup until measurements and booking details are complete.";
    }
    if (parseMoneyToCents(order.balance_due) <= 0) {
      return isWedding
        ? "Payment is complete, but pickup release still stays with the linked wedding member workflow."
        : "Payment is complete, but the order team still controls when it is ready for pickup.";
    }
    if (parseMoneyToCents(order.amount_paid) > 0) {
      return isWedding
        ? "A wedding deposit has been recorded. Collect the remaining balance only when the linked member is ready for pickup."
        : "A deposit has been recorded on this order. Collect the remaining balance only when the order is ready.";
    }
    return isWedding
      ? "No payment is on this wedding order yet. Confirm member readiness before collecting money or promising pickup."
      : "No payment is on this order yet. Confirm receiving and pickup status before collecting money.";
  };

  const lineLifecycleLabel = (
    status?: string | null,
    alterationStatus?: string | null,
  ) => {
    if (status === "received" && alterationStatus) {
      if (alterationStatus === "intake") {
        return "Scheduled for Alterations";
      }
      if (
        alterationStatus === "in_work" ||
        alterationStatus === "verify_completed"
      ) {
        return "In Alterations";
      }
    }
    switch (status) {
      case "needs_measurements":
        return "Needs Measurements";
      case "ntbo":
        return "Need to be ordered (NTBO)";
      case "ordered":
        return "Ordered";
      case "received":
        return "Received";
      case "ready_for_pickup":
        return "Ready for Pickup";
      case "picked_up":
        return "Picked Up";
      default:
        return "Order Review";
    }
  };

  const submitShipment = async (
    order: CustomerOrder,
    items: OrderItem[],
    overrideReadiness: boolean,
    managerApproval?: { managerStaffId: string; managerPin: string },
  ): Promise<boolean> => {
    const ids = items
      .map((item) => item.transaction_line_id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      toast("No open order lines are available to ship.", "error");
      return false;
    }
    setPickupBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/transactions/${order.id}/ship`,
        {
          method: "POST",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify({
            shipped_item_ids: ids,
            actor: "Register Customer Orders",
            override_readiness: overrideReadiness,
            override_reason: overrideReadiness
              ? "Register shipment override: staff confirmed shipment before ready status."
              : undefined,
            readiness_override_manager_staff_id:
              managerApproval?.managerStaffId,
            readiness_override_manager_pin: managerApproval?.managerPin,
            register_session_id: registerSessionId ?? undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          body.error ??
            "Shipment could not be completed.",
          "error",
        );
        return false;
      }
      toast(
        overrideReadiness
          ? "Shipment completed with override recorded."
          : "Shipment completed.",
        "success",
      );
      setPickupConfirm(null);
      await loadOrderItems(order.id);
      setLoading(true);
      const params = new URLSearchParams({
        customer_id: customerId,
        limit: "25",
        record_scope: "orders",
        status_scope: REGISTER_ORDER_STATUS_SCOPE,
      });
      if (registerSessionId)
        params.set("register_session_id", registerSessionId);
      const ordersRes = await fetch(
        `${baseUrl}/api/transactions?${params.toString()}`,
        {
          headers: apiAuth(),
        },
      );
      if (ordersRes.ok) {
        const data = await ordersRes.json();
        const rows = Array.isArray(data?.items) ? data.items : [];
        setOrders(
          rows.map((row: CustomerOrder) => ({
            ...row,
            id: row.id ?? row.transaction_id,
          })),
        );
      }
      return true;
    } finally {
      setLoading(false);
      setPickupBusy(false);
    }
  };

  const openReleaseFlow = async (order: CustomerOrder, oneItem?: OrderItem) => {
    const mode = orderReleaseMode(order);
    setPickupBusy(true);
    try {
      const loadedItems = oneItem ? [oneItem] : await fetchOrderItems(order.id);
      const openItems = loadedItems.filter((item) => !isCompletedOrderItem(item));
      if (openItems.length === 0) {
        toast(
          `No open order lines are available to ${releaseLabel(mode).toLowerCase()}.`,
          "info",
        );
        return;
      }
      if (mode === "pickup") {
        if (!onPickupToCart) {
          toast(
            "Pickup must be loaded into the Register cart and finished through Sale Complete.",
            "error",
          );
          return;
        }
        addToPickupBasket(order, openItems);
        return;
      }
      const blockedItems = openItems.filter(
        (item) => item.order_lifecycle_status !== "ready_for_pickup",
      );
      if (blockedItems.length > 0) {
        setPickupConfirm({ mode, order, items: openItems, blockedItems });
        return;
      }
      await submitShipment(order, openItems, false);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : `${releaseLabel(mode)} could not be started.`,
        "error",
      );
    } finally {
      setPickupBusy(false);
    }
  };

  const openReleaseSelection = async (order: CustomerOrder) => {
    const mode = orderReleaseMode(order);
    setPickupBusy(true);
    try {
      await loadOrderItems(order.id);
      toast(
        mode === "ship"
          ? "Select the order lines being shipped, then release shipment."
          : "Select the order lines being picked up, then release pickup.",
        "info",
      );
    } finally {
      setPickupBusy(false);
    }
  };

  const addToPickupBasket = (order: CustomerOrder, items: OrderItem[]) => {
    const openItems = items.filter(
      (item) => !isCompletedOrderItem(item) && item.transaction_line_id,
    );
    if (openItems.length === 0) {
      toast("Select at least one open order line for pickup.", "error");
      return;
    }
    const unreadyCount = openItems.filter(
      (item) => item.order_lifecycle_status !== "ready_for_pickup",
    ).length;
    setPickupBasket((previous) => [
      ...previous.filter((entry) => entry.order.id !== order.id),
      { order, items: openItems },
    ]);
    toast(
      `${openItems.length} item(s) from ${order.display_id} staged for the Register cart.${
        unreadyCount > 0
          ? ` ${unreadyCount} item(s) will require Manager Access before completion.`
          : ""
      } Nothing is marked picked up until the cart reaches Sale Complete.`,
      "success",
    );
  };

  const startPickupBasket = async (
    allowUnpaidBalance = false,
    continueToPayment = false,
  ) => {
    if (!onPickupToCart || pickupBasket.length === 0) return;
    const stagedPaymentByTransaction = new Map(
      stagedOrderPayments.map((payment) => [
        payment.target_transaction_id,
        parseMoneyToCents(payment.amount),
      ]),
    );
    const balanceDueCents = pickupBasket.reduce(
      (sum, entry) => sum + parseMoneyToCents(entry.order.balance_due),
      0,
    );
    const stagedPaymentCents = pickupBasket.reduce(
      (sum, entry) =>
        sum + (stagedPaymentByTransaction.get(entry.order.id) ?? 0),
      0,
    );
    const remainingBalanceCents = Math.max(
      0,
      balanceDueCents - stagedPaymentCents,
    );
    if (!allowUnpaidBalance && remainingBalanceCents > 0) {
      setPickupPaymentDecision({
        balanceDueCents,
        stagedPaymentCents,
        remainingBalanceCents,
      });
      return;
    }
    setPickupBusy(true);
    try {
      const loaded = await onPickupToCart(pickupBasket, {
        continueToPayment,
      });
      if (loaded) {
        setPickupBasket([]);
        setPickupConfirm(null);
        onClose();
      }
    } finally {
      setPickupBusy(false);
    }
  };

  const payPickupBalanceNow = () => {
    if (!onMakePayment) {
      toast("Transaction payment is unavailable for this pickup.", "error");
      return;
    }
    for (const entry of pickupBasket) {
      const balanceDueCents = parseMoneyToCents(entry.order.balance_due);
      if (balanceDueCents > 0) {
        onMakePayment(entry.order, balanceDueCents);
      }
    }
    setPickupPaymentDecision(null);
    void startPickupBasket(true, true);
  };

  const skipPickupPaymentForNow = () => {
    setPickupPaymentDecision(null);
    void startPickupBasket(true);
  };

  const pickupPaymentDecisionMessage = pickupPaymentDecision
    ? [
        pickupPaymentDecision.stagedPaymentCents > 0
          ? [
              `Order balance due: ${formatUsdFromCents(pickupPaymentDecision.balanceDueCents)}`,
              `Already staged in this cart: ${formatUsdFromCents(pickupPaymentDecision.stagedPaymentCents)}`,
              `Additional payment needed: ${formatUsdFromCents(pickupPaymentDecision.remainingBalanceCents)}`,
            ].join("\n")
          : `Balance remaining: ${formatUsdFromCents(pickupPaymentDecision.remainingBalanceCents)}`,
        "",
        "Paying stages the full balance with this pickup and continues directly to tender. Skipping keeps the balance open. Manager Access will be requested at Complete Pickup only if recorded payments do not cover the merchandise being released.",
      ].join("\n")
    : "";

  const releaseSelectedLines = async () => {
    if (!selectedOrder) return;
    const mode = orderReleaseMode(selectedOrder);
    const selected = selectedOrderItems.filter(
      (item) => !isCompletedOrderItem(item) && pickupSelection[item.transaction_line_id],
    );
    if (selected.length === 0) {
      toast(
        `Select at least one open order line to ${releaseLabel(mode).toLowerCase()}.`,
        "error",
      );
      return;
    }
    if (mode === "pickup") {
      if (!onPickupToCart) {
        toast(
          "Pickup must be loaded into the Register cart and finished through Sale Complete.",
          "error",
        );
        return;
      }
      addToPickupBasket(selectedOrder, selected);
      return;
    }
    const blockedItems = selected.filter(
      (item) => item.order_lifecycle_status !== "ready_for_pickup",
    );
    if (blockedItems.length > 0) {
      setPickupConfirm({
        mode,
        order: selectedOrder,
        items: selected,
        blockedItems,
      });
      return;
    }
    await submitShipment(selectedOrder, selected, false);
  };

  const openPaymentEntry = (order: CustomerOrder) => {
    const dueCents = parseMoneyToCents(order.balance_due);
    if (dueCents <= 0) {
      toast("That order does not have a balance due.", "info");
      return;
    }
    setPaymentOrder(order);
    setPaymentAmount(centsToFixed2(dueCents));
  };

  const submitPaymentEntry = () => {
    if (!paymentOrder) return;
    const amountCents = parseMoneyToCents(paymentAmount);
    const dueCents = parseMoneyToCents(paymentOrder.balance_due);
    if (amountCents <= 0) {
      toast("Enter an order payment amount greater than $0.00.", "error");
      return;
    }
    if (amountCents > dueCents) {
      toast("Order payment cannot be more than the balance due.", "error");
      return;
    }
    onMakePayment?.(paymentOrder, amountCents);
    setPaymentOrder(null);
    setPaymentAmount("");
  };

  const addSkuToSelectedOrder = async () => {
    if (!selectedOrder || !onAddItemToOrder) return;
    const sku = addSku.trim();
    if (!sku) {
      toast("Scan or enter a SKU before adding it to this order.", "info");
      return;
    }
    setOrderMutationBusy(true);
    try {
      const ok = await onAddItemToOrder(selectedOrder, sku);
      if (ok) {
        setAddSku("");
        if (selectedOrder.id) await loadOrderItems(selectedOrder.id);
      }
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const addVariantToSelectedOrder = async (variant: VariantSearchResult) => {
    if (!selectedOrder) return;
    setOrderMutationBusy(true);
    try {
      const matchingOpenLines = selectedOrderItems.filter(
        (item) => item.product_id === variant.product_id && !isCompletedOrderItem(item),
      );
      if (matchingOpenLines.length === 1 && onUpdateOrderItem) {
        const existingLine = matchingOpenLines[0];
        const ok = await onUpdateOrderItem(selectedOrder, existingLine, {
          variant_id: variant.variant_id,
        });
        if (ok && selectedOrder.id) await loadOrderItems(selectedOrder.id);
        return;
      }
      if (!onAddItemToOrder) return;
      const ok = await onAddItemToOrder(selectedOrder, variant.sku);
      if (ok && selectedOrder.id) await loadOrderItems(selectedOrder.id);
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const saveLineDraft = async (item: OrderItem) => {
    if (!selectedOrder || !onUpdateOrderItem) return;
    const draft = lineDrafts[item.transaction_line_id] ?? {
      quantity: String(item.quantity),
      unit_price: item.unit_price,
      variant_id: item.variant_id,
      sku: item.sku,
      variation_label: item.variation_label,
      order_lifecycle_status: item.order_lifecycle_status ?? "ntbo",
    };
    const quantity = Number.parseInt(draft.quantity, 10);
    const priceCents = parseMoneyToCents(draft.unit_price);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      toast("Quantity must be at least 1.", "error");
      return;
    }
    if (priceCents < 0) {
      toast("Price cannot be negative.", "error");
      return;
    }
    setOrderMutationBusy(true);
    try {
      const ok = await onUpdateOrderItem(selectedOrder, item, {
        quantity,
        unit_price: centsToFixed2(priceCents),
        variant_id:
          draft.variant_id !== item.variant_id ? draft.variant_id : undefined,
        order_lifecycle_status:
          draft.order_lifecycle_status !==
          (item.order_lifecycle_status ?? "ntbo")
            ? draft.order_lifecycle_status
            : undefined,
      });
      if (ok && selectedOrder.id) await loadOrderItems(selectedOrder.id);
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const deleteLine = async (item: OrderItem) => {
    if (!selectedOrder || !onDeleteOrderItem) return;
    setOrderMutationBusy(true);
    try {
      const ok = await onDeleteOrderItem(selectedOrder, item);
      if (ok && selectedOrder.id) await loadOrderItems(selectedOrder.id);
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const openCancelItem = (item: OrderItem) => {
    setCancelItem(item);
    setCancelItemReason("");
    setCancelItemPreview(null);
    setCancelItemError(null);
  };

  const cancellationRequest = () => ({
    lines: cancelItem
      ? [
          {
            transaction_line_id: cancelItem.transaction_line_id,
            quantity: remainingOrderItemQuantity(cancelItem),
          },
        ]
      : [],
    reason: cancelItemReason.trim(),
  });

  const reviewItemCancellation = async () => {
    if (!selectedOrder || !cancelItem) return;
    setOrderMutationBusy(true);
    setCancelItemError(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/transactions/${selectedOrder.id}/order-line-cancellations/preview`,
        {
          method: "POST",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify(cancellationRequest()),
        },
      );
      const body = (await res.json().catch(() => ({}))) as
        | OrderItemCancellationPreview
        | { error?: string };
      if (!res.ok) {
        setCancelItemPreview(null);
        setCancelItemError(
          "error" in body && body.error
            ? body.error
            : "Riverside could not review this cancellation.",
        );
        return;
      }
      setCancelItemPreview(body as OrderItemCancellationPreview);
    } catch {
      setCancelItemError(
        "The Main Hub could not be reached. No Order item was cancelled.",
      );
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const confirmItemCancellation = async () => {
    if (
      !selectedOrder ||
      !cancelItem ||
      !cancelItemPreview ||
      cancelItemReason.trim().length < 12
    )
      return;
    setOrderMutationBusy(true);
    setCancelItemError(null);
    setLastCancellationHandoffError(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/transactions/${selectedOrder.id}/order-line-cancellations`,
        {
          method: "POST",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify(cancellationRequest()),
        },
      );
      const body = (await res.json().catch(() => ({}))) as
        | OrderItemCancellationPreview
        | { error?: string };
      if (!res.ok) {
        setCancelItemError(
          "error" in body && body.error
            ? body.error
            : "Riverside did not cancel this Order item.",
        );
        return;
      }
      const result = body as OrderItemCancellationPreview;
      const refreshedOrder: CustomerOrder = {
        ...selectedOrder,
        total_price: result.revised_total,
        amount_paid: result.amount_paid,
        balance_due: result.balance_due_after,
      };
      setOrders((current) =>
        current.map((order) =>
          order.id === selectedOrder.id ? refreshedOrder : order,
        ),
      );
      await loadOrderItems(selectedOrder.id);
      setLastCancellationResult(result);
      setCancelItem(null);
      setCancelItemPreview(null);
      setCancelItemReason("");

      if (parseMoneyToCents(result.refund_due) > 0) {
        toast(
          `Item cancelled. ${formatCurrency(result.refund_due)} is actually due back to the customer. Complete the refund sources in Pay.`,
          "success",
        );
        if (onRecordedRefundToCart) {
          const refundLoaded = await onRecordedRefundToCart(refreshedOrder);
          if (refundLoaded) {
            onClose();
          } else {
            setLastCancellationHandoffError(
              "The cancellation was recorded, but its refund could not be loaded into Pay. Reopen this Transaction Record and retry the refund handoff; do not cancel the item again.",
            );
          }
        } else {
          setLastCancellationHandoffError(
            "The cancellation was recorded, but this Register cannot load its refund into Pay. Reopen the Transaction Record from a Register before taking any refund action.",
          );
        }
      } else {
        toast(
          parseMoneyToCents(result.balance_due_after) > 0
            ? `Item cancelled. Its credit reduced the Order balance to ${formatCurrency(result.balance_due_after)}; no refund is due.`
            : "Item cancelled. The revised Order is paid in full and no refund is due.",
          "success",
        );
      }
    } catch {
      setCancelItemError(
        "The Main Hub did not confirm the result. Refresh Customer Orders before retrying.",
      );
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const openVariantPicker = async (item: OrderItem) => {
    if (!selectedOrder || !onUpdateOrderItem || isCompletedOrderItem(item)) return;
    setOrderMutationBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/products/pos-variants/${encodeURIComponent(item.product_id)}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("Could not load the available sizes and variations.");
      const body = (await res.json()) as Array<Record<string, unknown>>;
      const variants: VariantOption[] = body
        .map((variant) => ({
          variant_id: String(variant.variant_id ?? ""),
          sku: String(variant.sku ?? ""),
          variation_label:
            typeof variant.variation_label === "string" && variant.variation_label.trim()
              ? variant.variation_label
              : "Standard",
          stock_on_hand: Number(variant.stock_on_hand ?? 0),
          retail_price: String(variant.retail_price ?? item.unit_price),
        }))
        .filter((variant) => variant.variant_id && variant.sku);
      if (variants.length === 0) throw new Error("No selectable sizes or variations were found for this item.");
      if (!variants.some((variant) => variant.variant_id === item.variant_id)) {
        variants.unshift({
          variant_id: item.variant_id,
          sku: item.sku,
          variation_label: item.variation_label ?? "Standard",
          stock_on_hand: 0,
          retail_price: item.unit_price,
        });
      }
      setVariantPicker({
        item,
        product: {
          product_id: item.product_id,
          name: item.product_name,
          variants,
        },
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load item variations.", "error");
    } finally {
      setOrderMutationBusy(false);
    }
  };

  const runCancelOrder = async () => {
    if (!cancelOrder) return;
    setOrderMutationBusy(true);
    try {
      const paidCents = parseMoneyToCents(cancelOrder.amount_paid);
      if (paidCents <= 0) {
        const res = await fetch(`${baseUrl}/api/transactions/${cancelOrder.id}`, {
          method: "PATCH",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        });
        if (!res.ok) {
          const raw = await res.text();
          const body = (() => {
            try {
              return JSON.parse(raw) as { error?: string };
            } catch {
              return {};
            }
          })();
          toast((body.error ?? raw.trim()) || "Order could not be cancelled.", "error");
          return;
        }
        setOrders((prev) =>
          prev.map((order) =>
            order.id === cancelOrder.id
              ? { ...order, status: "cancelled" }
              : order,
          ),
        );
        toast("Unpaid order cancelled. No customer refund is due.", "success");
      } else {
        const refundLoaded = onCancelledToRefundCart
          ? await onCancelledToRefundCart(cancelOrder)
          : false;
        if (!refundLoaded) {
          setCancelRefundLoadPending(true);
          toast(
            "The cancellation was not recorded because its refund could not be staged. Keep this window open and use Retry Refund Load.",
            "error",
          );
          return;
        }
        toast(
          "Cancellation refund staged. Nothing changes until Record Sale completes and the Sale Complete screen appears.",
          "success",
        );
        onClose();
      }
      setCancelRefundLoadPending(false);
      setCancelOrder(null);
      setSelectedOrderItems([]);
      setViewingItemsOrderId(null);
      setPickupSelection({});
    } finally {
      setOrderMutationBusy(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        className="ui-modal flex max-h-[96dvh] w-full max-w-none animate-workspace-snap flex-col overflow-hidden rounded-t-3xl outline-none sm:max-h-[90vh] sm:w-[min(1080px,calc(100vw-2rem))] sm:rounded-3xl"
      >
        <div className="ui-modal-header flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-app-accent/20 bg-app-accent/10 text-app-accent">
              <Package size={22} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Register Order Lookup
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-app-text">
                Customer Orders
              </h2>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close customer orders"
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-text-muted transition-colors hover:text-app-text"
          >
            <X size={20} />
          </button>
        </div>

        <div className="border-b border-app-border bg-app-surface-2/50 px-5 py-4 sm:px-6">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Customer
          </p>
          <p className="mt-1 truncate text-lg font-black text-app-text">
            {customerName}
          </p>
          <p className="mt-2 max-w-3xl text-xs font-semibold text-app-text-muted">
            Build one cart across this customer's orders: add payments, select
            pickup items, or combine both before continuing to the Register.
          </p>
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto p-4 sm:p-6">
          {alterations.length > 0 ? (
            <section className="mb-5 rounded-2xl border border-app-accent/25 bg-app-accent/5 p-4">
              <div className="flex items-center gap-2">
                <Scissors size={16} className="text-app-accent" />
                <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
                  Alterations in custody
                </h3>
              </div>
              <div className="mt-3 grid gap-2">
                {alterations.map((alteration) => {
                  const ready = alteration.status === "ready";
                  return (
                    <div key={alteration.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface p-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-app-accent/30 bg-app-accent/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-accent">ALTERATIONS</span>
                          <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${ready ? "border-app-success/30 bg-app-success/10 text-app-success" : "border-app-warning/30 bg-app-warning/10 text-app-warning"}`}>
                            {ready ? "Ready for pickup" : "In custody"}
                          </span>
                          {alteration.due_at ? <span className="text-[10px] font-bold text-app-text-muted">Due {formatDate(alteration.due_at)}</span> : null}
                        </div>
                        <p className="mt-1 text-sm font-black text-app-text">{alteration.item_description ?? alteration.source_sku ?? "Customer garment"}</p>
                        <p className="text-xs font-semibold text-app-text-muted">{alteration.work_requested ?? "Alteration work"}{alteration.ticket_number ? ` · Ticket ${alteration.ticket_number}` : ""}</p>
                      </div>
                      <button type="button" disabled={pickupBusy} onClick={() => void pickupAlteration(alteration)} className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50">
                        Pick Up & Print
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
          {loading ? (
            <div className="flex min-h-48 items-center justify-center rounded-2xl border border-dashed border-app-border bg-app-surface-2 text-center">
              <span className="animate-pulse text-sm font-black uppercase tracking-widest text-app-text-muted">
                Loading customer orders
              </span>
            </div>
          ) : orders.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-app-border bg-app-surface-2 p-8 text-center">
              <AlertCircle size={34} className="text-app-text-muted" />
              <span className="text-sm font-black uppercase tracking-widest text-app-text-muted">
                No customer orders found
              </span>
            </div>
          ) : (
            <div className="grid gap-3">
              {orders.map((order) => (
                <div
                  key={order.id ?? order.display_id}
                  className="ui-panel grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_13rem]"
                >
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-black text-app-text">
                        {order.display_id}
                      </span>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {order.order_kind === "wedding_order"
                          ? "Wedding"
                          : order.order_kind === "custom"
                            ? "Custom"
                            : "Order"}
                      </span>
                      {order.is_rush && (
                        <span className="rounded-full border border-app-danger/20 bg-app-danger/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-danger">
                          RUSH
                        </span>
                      )}
                      {order.need_by_date && (
                        <span className="flex items-center gap-1 rounded-full border border-app-warning/25 bg-app-warning/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-warning">
                          <Clock size={10} />
                          {formatDate(order.need_by_date)}
                        </span>
                      )}
                      {order.party_name && (
                        <span className="rounded-full border border-app-danger/20 bg-app-danger/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-danger">
                          {order.party_name}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                      <div className="ui-metric-cell px-3 py-2">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Booked
                        </p>
                        <p className="mt-1 font-black text-app-text">
                          {formatDate(order.booked_at)}
                        </p>
                      </div>
                      <div className="ui-metric-cell px-3 py-2">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Paid
                        </p>
                        <p className="mt-1 font-black text-app-success">
                          {formatCurrency(order.amount_paid)}
                        </p>
                      </div>
                      <div className="ui-metric-cell px-3 py-2">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Due
                        </p>
                        <p className="mt-1 font-black text-app-warning">
                          {formatCurrency(order.balance_due)}
                        </p>
                      </div>
                      <div className="ui-metric-cell px-3 py-2">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Status
                        </p>
                        <p className="mt-1 font-black text-app-text">
                          {lifecycleLabel(order)}
                        </p>
                      </div>
                    </div>
                    <p className="mt-2 text-xs font-semibold leading-relaxed text-app-text-muted">
                      {lifecycleNote(order)}
                    </p>
                  </div>
                  <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
                    {onMakePayment &&
                    parseMoneyToCents(order.balance_due) > 0 ? (
                      <button
                        type="button"
                        data-testid={`pos-order-make-payment-${order.display_id}`}
                        onClick={() => openPaymentEntry(order)}
                        className="ui-btn-primary flex min-h-11 items-center justify-center gap-2 px-3 text-[10px]"
                      >
                        <CreditCard size={14} />
                        Add Payment
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`pos-order-${orderReleaseMode(order)}-${order.display_id}`}
                      onClick={() => void openReleaseSelection(order)}
                      disabled={
                        pickupBusy || isOrderStatus(order.status, "fulfilled")
                      }
                      className="flex min-h-11 items-center justify-center gap-2 rounded-xl border-b-4 border-app-success bg-app-success px-3 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:opacity-90 disabled:opacity-50"
                    >
                      {orderReleaseMode(order) === "ship" ? (
                        <Truck size={14} />
                      ) : (
                        <ShieldCheck size={14} />
                      )}
                      {releaseLabel(orderReleaseMode(order))}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (order.id) void loadOrderItems(order.id);
                      }}
                      className="ui-btn-secondary flex min-h-11 items-center justify-center gap-2 px-3 text-[10px]"
                    >
                      View Order Details
                      <ArrowRight size={14} />
                    </button>
                    <button
                      type="button"
                      disabled={
                        orderMutationBusy ||
                        isOrderStatus(order.status, "cancelled") ||
                        isOrderStatus(order.status, "fulfilled")
                      }
                      onClick={() => {
                        setCancelRefundLoadPending(false);
                        setCancelOrder(order);
                      }}
                      className="flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-danger/20 bg-app-danger/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
                    >
                      <Ban size={14} />
                      Cancel
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {pickupBasket.length > 0 || stagedOrderPayments.length > 0 ? (
            <section className="mt-5 rounded-2xl border border-app-success/30 bg-app-success/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-success">
                    Order work in this cart
                  </p>
                  <p className="mt-1 text-sm font-semibold text-app-text">
                    {stagedOrderPayments.length} payment
                    {stagedOrderPayments.length === 1 ? "" : "s"} and{" "}
                    {pickupBasket.reduce(
                      (sum, entry) => sum + entry.items.length,
                      0,
                    )}{" "}
                    pickup item
                    {pickupBasket.reduce(
                      (sum, entry) => sum + entry.items.length,
                      0,
                    ) === 1
                      ? ""
                      : "s"}{" "}
                    staged
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    pickupBasket.length > 0
                      ? void startPickupBasket()
                      : onClose()
                  }
                  disabled={pickupBusy}
                  className="flex min-h-10 items-center justify-center gap-2 rounded-xl border-b-4 border-app-success bg-app-success px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg disabled:cursor-wait disabled:opacity-50"
                >
                  <ShieldCheck size={14} />
                  {pickupBasket.length > 0
                    ? "Continue with Pickup"
                    : "Continue to Cart"}
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {stagedOrderPayments.map((payment) => (
                  <span
                    key={payment.target_transaction_id}
                    className="rounded-full border border-violet-500/30 bg-app-surface px-3 py-1 text-[10px] font-black uppercase tracking-widest text-violet-700"
                  >
                    {payment.target_display_id} ·{" "}
                    {formatUsdFromCents(parseMoneyToCents(payment.amount))}{" "}
                    payment
                  </span>
                ))}
                {pickupBasket.map((entry) => (
                  <button
                    key={entry.order.id}
                    type="button"
                    onClick={() => setPickupBasket((previous) => previous.filter((item) => item.order.id !== entry.order.id))}
                    className="rounded-full border border-app-success/30 bg-app-surface px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-success"
                    title="Remove this order from the pickup basket"
                  >
                    {entry.order.display_id} · {entry.items.length} item(s) ×
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs font-semibold text-app-text-muted">
                Add work from another order before continuing. Each payment
                allocation and pickup release remains tied to its source order.
              </p>
            </section>
          ) : null}

          {selectedOrderItems.length > 0 && (
            <div className="mt-5 rounded-2xl border border-app-border bg-app-surface p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="font-black text-app-text">
                  {selectedOrder?.display_id ?? "Order"} lines
                </span>
                <button
                  onClick={() => {
                    setSelectedOrderItems([]);
                    setViewingItemsOrderId(null);
                    setPickupSelection({});
                  }}
                  className="text-xs font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                >
                  Close
                </button>
              </div>
              {lastCancellationResult &&
              lastCancellationResult.transaction_id === selectedOrder?.id ? (
                <div
                  role="status"
                  className="mb-3 rounded-xl border border-app-info/30 bg-app-info/10 p-3 text-xs font-semibold text-app-text"
                >
                  <p className="font-black text-app-info">
                    Cancellation recorded —{" "}
                    {formatCurrency(lastCancellationResult.cancellation_total)} credit
                  </p>
                  {parseMoneyToCents(lastCancellationResult.refund_due) > 0 ? (
                    <p className="mt-1">
                      {formatCurrency(lastCancellationResult.credit_applied_to_balance)} reduced the unpaid balance and {formatCurrency(lastCancellationResult.refund_due)} is due back to the customer in Pay.
                    </p>
                  ) : parseMoneyToCents(lastCancellationResult.balance_due_after) > 0 ? (
                    <p className="mt-1">
                      The credit reduced the unpaid balance. {formatCurrency(lastCancellationResult.balance_due_after)} remains due, so no customer refund was created.
                    </p>
                  ) : (
                    <p className="mt-1">
                      The credit cleared the unpaid balance. No customer refund is due. Cancelled items remain listed below for the Transaction Record.
                    </p>
                  )}
                  {lastCancellationHandoffError ? (
                    <p className="mt-2 font-bold text-app-danger">
                      {lastCancellationHandoffError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={
                    pickupBusy || selectedOrderItems.every(isCompletedOrderItem)
                  }
                  onClick={() => void releaseSelectedLines()}
                  className="flex min-h-10 items-center justify-center gap-2 rounded-xl border-b-4 border-app-success bg-app-success px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:opacity-90 disabled:opacity-50"
                >
                  {orderReleaseMode(selectedOrder) === "ship" ? (
                    <Truck size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  {orderReleaseMode(selectedOrder) === "pickup"
                    ? "Add Selected to Cart"
                    : "Ship Selected"}
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 text-[10px]"
                  onClick={() =>
                    setPickupSelection(
                      Object.fromEntries(
                        selectedOrderItems
                          .filter((item) => !isCompletedOrderItem(item))
                          .map((item) => [item.transaction_line_id, true]),
                      ),
                    )
                  }
                >
                  Select All Open
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 text-[10px]"
                  onClick={() => setPickupSelection({})}
                >
                  Clear
                </button>
              </div>
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {selectedOrderItems.map((item) => {
                  const fullyCancelled = isFullyCancelledOrderItem(item);
                  return (
                  <div
                    key={item.transaction_line_id}
                    className={`flex flex-col gap-3 rounded-xl border p-3 text-xs ${
                      fullyCancelled
                        ? "border-app-danger/30 bg-app-danger/5"
                        : isCompletedOrderItem(item)
                          ? "border-emerald-200 bg-emerald-50/50 opacity-60"
                        : "border-app-border bg-app-surface-2/30"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex flex-1 flex-col">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.product_name}`}
                            disabled={isCompletedOrderItem(item)}
                            checked={Boolean(
                              pickupSelection[item.transaction_line_id],
                            )}
                            onChange={(e) =>
                              setPickupSelection((prev) => ({
                                ...prev,
                                [item.transaction_line_id]: e.target.checked,
                              }))
                            }
                            className="mt-1 h-5 w-5 rounded border-app-border text-app-success focus:ring-app-success/30 disabled:opacity-40"
                          />
                          <span className="text-left font-medium text-app-text">
                            {item.product_name}
                          </span>
                        </div>
                        <span className="text-app-text-muted">
                          {lineDrafts[item.transaction_line_id]?.sku ??
                            item.sku}{" "}
                          ·{" "}
                          {lineDrafts[item.transaction_line_id]
                            ?.variation_label ??
                            item.variation_label ??
                            "Standard"}{" "}
                          · {fulfillmentLabel(item.fulfillment)}
                        </span>
                        <span
                          className={`mt-2 w-fit rounded-full border px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                            fullyCancelled
                              ? "border-app-danger/30 bg-app-danger/10 text-app-danger"
                              : item.order_lifecycle_status ===
                                  "needs_measurements" ||
                                (item.order_lifecycle_status === "received" &&
                                  item.alteration_status)
                              ? "border-app-warning/25 bg-app-warning/10 text-app-warning"
                              : "border-app-border bg-app-surface text-app-text-muted"
                          }`}
                        >
                          {fullyCancelled
                            ? `Cancelled · ${item.quantity_cancelled ?? item.quantity} of ${item.quantity}`
                            : lineLifecycleLabel(
                                item.order_lifecycle_status,
                                item.alteration_status,
                              )}
                        </span>
                        {item.fulfillment === "wedding_order" && (
                          <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-rose-600">
                            Keep wedding payment and pickup work tied to the
                            linked member.
                          </span>
                        )}
                        {variantUpdateConfirmation?.transactionLineId === item.transaction_line_id ? (
                          <div
                            aria-live="polite"
                            className="mt-3 rounded-xl border border-app-success/30 bg-app-success/10 p-3 text-app-success"
                          >
                            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest">
                              <CheckCircle2 size={14} />
                              Item selection updated
                            </div>
                            <p className="mt-1 text-xs font-semibold">
                              {variantUpdateConfirmation.before} → {variantUpdateConfirmation.after}
                            </p>
                            <p className="mt-1 text-[11px] font-bold">
                              Customer price retained at {variantUpdateConfirmation.retainedPrice}.
                            </p>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-col items-end">
                        {selectedOrder && !isCompletedOrderItem(item) ? (
                          <button
                            type="button"
                            disabled={pickupBusy}
                            onClick={() =>
                              void openReleaseFlow(selectedOrder, item)
                            }
                            className="mb-2 flex min-h-9 items-center justify-center gap-2 rounded-lg border border-app-success/25 bg-app-success/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-success disabled:opacity-50"
                          >
                            {orderReleaseMode(selectedOrder) === "ship" ? (
                              <Truck size={12} />
                            ) : (
                              <ShieldCheck size={12} />
                            )}
                            {orderReleaseMode(selectedOrder) === "pickup"
                              ? "Add Pickup Line"
                              : "Ship Line"}
                          </button>
                        ) : null}
                        {onUpdateOrderItem && !isCompletedOrderItem(item) ? (
                          <div className="grid w-full gap-2 sm:w-[24rem] sm:grid-cols-[4rem_minmax(0,1fr)]">
                            <div className="col-span-2 rounded-xl border border-app-accent/25 bg-app-accent/5 p-3 text-left">
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-accent">
                                Current item selection
                              </p>
                              <p className="mt-1 font-black text-app-text">
                                {item.variation_label ?? "Standard"}
                              </p>
                              <p className="text-[10px] font-semibold text-app-text-muted">
                                SKU {item.sku} · Customer price {formatCurrency(item.unit_price)}
                              </p>
                              <button
                                type="button"
                                disabled={orderMutationBusy}
                                onClick={() => void openVariantPicker(item)}
                                className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-app-accent bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:bg-app-accent/10 disabled:opacity-50"
                              >
                                <RefreshCw size={13} />
                                Update Item
                              </button>
                              <button
                                type="button"
                                data-testid={`pos-order-cancel-item-${item.transaction_line_id}`}
                                disabled={orderMutationBusy}
                                onClick={() => openCancelItem(item)}
                                className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-app-danger/30 bg-app-danger/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-danger transition-colors hover:bg-app-danger/15 disabled:opacity-50"
                              >
                                <Ban size={13} />
                                Cancel Item
                              </button>
                            </div>
                            <input
                              aria-label={`Quantity for ${item.sku}`}
                              value={
                                lineDrafts[item.transaction_line_id]
                                  ?.quantity ?? String(item.quantity)
                              }
                              onChange={(e) =>
                                setLineDrafts((prev) => ({
                                  ...prev,
                                  [item.transaction_line_id]: {
                                    ...prev[item.transaction_line_id],
                                    quantity: e.target.value,
                                    unit_price:
                                      prev[item.transaction_line_id]
                                        ?.unit_price ?? item.unit_price,
                                    variant_id:
                                      prev[item.transaction_line_id]
                                        ?.variant_id ?? item.variant_id,
                                    sku:
                                      prev[item.transaction_line_id]?.sku ??
                                      item.sku,
                                    variation_label:
                                      prev[item.transaction_line_id]
                                        ?.variation_label ??
                                      item.variation_label,
                                    order_lifecycle_status:
                                      prev[item.transaction_line_id]
                                        ?.order_lifecycle_status ??
                                      item.order_lifecycle_status ??
                                      "ntbo",
                                  },
                                }))
                              }
                              inputMode="numeric"
                              className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-right font-black text-app-text"
                            />
                            <input
                              aria-label={`Price for ${item.sku}`}
                              value={
                                lineDrafts[item.transaction_line_id]
                                  ?.unit_price ?? item.unit_price
                              }
                              onChange={(e) =>
                                setLineDrafts((prev) => ({
                                  ...prev,
                                  [item.transaction_line_id]: {
                                    ...prev[item.transaction_line_id],
                                    quantity:
                                      prev[item.transaction_line_id]
                                        ?.quantity ?? String(item.quantity),
                                    unit_price: e.target.value,
                                    variant_id:
                                      prev[item.transaction_line_id]
                                        ?.variant_id ?? item.variant_id,
                                    sku:
                                      prev[item.transaction_line_id]?.sku ??
                                      item.sku,
                                    variation_label:
                                      prev[item.transaction_line_id]
                                        ?.variation_label ??
                                      item.variation_label,
                                    order_lifecycle_status:
                                      prev[item.transaction_line_id]
                                        ?.order_lifecycle_status ??
                                      item.order_lifecycle_status ??
                                      "ntbo",
                                  },
                                }))
                              }
                              inputMode="decimal"
                              className="rounded-lg border border-app-border bg-app-surface px-2 py-1 text-right font-black text-app-text"
                            />
                            <select
                              aria-label={`Lifecycle for ${item.sku}`}
                              value={
                                lineDrafts[item.transaction_line_id]
                                  ?.order_lifecycle_status ??
                                item.order_lifecycle_status ??
                                "ntbo"
                              }
                              onChange={(e) =>
                                setLineDrafts((prev) => ({
                                  ...prev,
                                  [item.transaction_line_id]: {
                                    quantity:
                                      prev[item.transaction_line_id]
                                        ?.quantity ?? String(item.quantity),
                                    unit_price:
                                      prev[item.transaction_line_id]
                                        ?.unit_price ?? item.unit_price,
                                    variant_id:
                                      prev[item.transaction_line_id]
                                        ?.variant_id ?? item.variant_id,
                                    sku:
                                      prev[item.transaction_line_id]?.sku ??
                                      item.sku,
                                    variation_label:
                                      prev[item.transaction_line_id]
                                        ?.variation_label ??
                                      item.variation_label,
                                    order_lifecycle_status: e.target.value,
                                  },
                                }))
                              }
                              className="col-span-2 rounded-lg border border-app-border bg-app-surface px-2 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
                            >
                              <option value="needs_measurements">
                                Needs Measurements
                              </option>
                              <option value="ntbo">Ready to Order</option>
                            </select>
                            <button
                              type="button"
                              disabled={orderMutationBusy}
                              onClick={() => void saveLineDraft(item)}
                              className="ui-btn-secondary col-span-2 flex min-h-9 items-center justify-center gap-2 px-2 text-[10px] disabled:opacity-50"
                            >
                              <Save size={12} />
                              Save Line
                            </button>
                            {onDeleteOrderItem &&
                            selectedOrder &&
                            parseMoneyToCents(selectedOrder.amount_paid) <= 0 ? (
                              <button
                                type="button"
                                disabled={orderMutationBusy}
                                onClick={() => void deleteLine(item)}
                                className="col-span-2 flex min-h-9 items-center justify-center gap-2 rounded-lg border border-app-danger/20 bg-app-danger/10 px-2 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
                              >
                                <Trash2 size={12} />
                                Delete Unpaid Line
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <>
                            <span className="font-medium text-app-text">
                              {formatCurrency(item.unit_price)}
                            </span>
                            <span className="text-app-text-muted">
                              ×{item.quantity}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
                Add or save lines to update the original order. Existing order
                work stays tied to this Transaction Record and does not start a
                new register sale.
              </p>
              {selectedOrder?.order_kind === "wedding_order" && (
                <p className="mt-2 text-[11px] font-semibold text-rose-700">
                  Keep payment, deposit follow-up, and pickup release tied to
                  the linked wedding member after this POS review.
                </p>
              )}
              <div className="mt-3 flex flex-col gap-2">
                {onAddItemToOrder && (
                  <>
                    <VariantSearchInput
                      placeholder="Search products by name or SKU to add"
                      onSelect={(variant) =>
                        void addVariantToSelectedOrder(variant)
                      }
                    />
                    <div className="flex gap-2">
                      <input
                        value={addSku}
                        onChange={(e) => setAddSku(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addSkuToSelectedOrder();
                        }}
                        placeholder="Scan SKU to add"
                        className="ui-input min-w-0 flex-1 text-xs font-semibold"
                      />
                      <button
                        type="button"
                        disabled={orderMutationBusy}
                        onClick={() => void addSkuToSelectedOrder()}
                        className="ui-btn-primary flex items-center gap-2 px-3 text-xs disabled:opacity-50"
                      >
                        <Plus size={14} />
                        Add to Order
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {paymentOrder && (
        <div className="ui-overlay-backdrop !z-[210]">
          <div
            className="ui-modal w-full max-w-none rounded-t-3xl p-5 shadow-2xl sm:max-w-sm sm:rounded-3xl"
            data-testid="pos-order-payment-entry-modal"
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
                  Existing Order Payment
                </p>
                <h3 className="text-lg font-black text-app-text">
                  {paymentOrder.display_id}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setPaymentOrder(null)}
                className="rounded-lg p-1 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                aria-label="Close order payment entry"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mb-4 rounded-xl border border-app-border bg-app-surface-2/60 p-3 text-sm">
              <div className="flex justify-between gap-3 text-app-text-muted">
                <span>Balance due</span>
                <span className="font-black tabular-nums text-app-text">
                  {formatCurrency(paymentOrder.balance_due)}
                </span>
              </div>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Payment amount
            </label>
            <input
              data-testid="pos-order-payment-amount"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              inputMode="decimal"
              autoFocus
              className="mt-1 w-full rounded-xl border border-app-border bg-app-surface px-3 py-3 text-2xl font-black tabular-nums text-app-text outline-none focus:border-app-accent focus:ring-2 focus:ring-app-accent/20"
            />
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => setPaymentOrder(null)}
                className="flex-1 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-app-text"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="pos-order-payment-add-to-cart"
                onClick={submitPaymentEntry}
                className="flex-1 rounded-xl border-b-4 border-violet-800 bg-violet-600 px-4 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-violet-600/25 active:translate-y-0.5 active:border-b-2"
              >
                Add Payment
              </button>
            </div>
          </div>
        </div>
      )}
      <VariantSelectionModal
        product={variantPicker?.product ?? null}
        actionLabel="Update Item"
        layerClassName="z-[220]"
        allowPriceOverride={false}
        initialVariantId={variantPicker?.item.variant_id}
        preservedUnitPrice={
          variantPicker ? formatCurrency(variantPicker.item.unit_price) : undefined
        }
        onClose={() => setVariantPicker(null)}
        onSelect={(variant) => {
          const selection = variantPicker;
          if (!selection || !selectedOrder || !onUpdateOrderItem) return;
          void (async () => {
            setOrderMutationBusy(true);
            try {
              const ok = await onUpdateOrderItem(selectedOrder, selection.item, {
                variant_id: variant.variant_id,
              });
              if (ok && selectedOrder.id) await loadOrderItems(selectedOrder.id);
              if (ok) {
                setVariantUpdateConfirmation({
                  transactionLineId: selection.item.transaction_line_id,
                  before: `${selection.item.sku} · ${selection.item.variation_label ?? "Standard"}`,
                  after: `${variant.sku} · ${variant.variation_label}`,
                  retainedPrice: formatCurrency(selection.item.unit_price),
                });
                setVariantPicker(null);
              }
            } finally {
              setOrderMutationBusy(false);
            }
          })();
        }}
      />
      {pickupConfirm && (
        <ManagerApprovalModal
          isOpen={true}
          title={`Manager Access: ${releaseLabel(pickupConfirm.mode)} Override`}
          message={`${pickupConfirm.blockedItems.length} line(s) are not marked Ready for Pickup. Manager Access is required because this release moves ${pickupConfirm.mode}, inventory, and revenue recognition.`}
          onApprove={(pin, managerId) =>
            submitShipment(
              pickupConfirm.order,
              pickupConfirm.items,
              true,
              { managerStaffId: managerId, managerPin: pin },
            )
          }
          onClose={() => {
            if (!pickupBusy) setPickupConfirm(null);
          }}
        />
      )}
      <ConfirmationModal
        isOpen={pickupPaymentDecision != null}
        title="Pay at Pickup?"
        message={pickupPaymentDecisionMessage}
        confirmLabel="Pay Balance Now"
        cancelLabel="Skip Payment for Now"
        onConfirm={payPickupBalanceNow}
        onCancel={skipPickupPaymentForNow}
        onClose={() => setPickupPaymentDecision(null)}
        variant="info"
      />
      {cancelOrder && (
        <ConfirmationModal
          isOpen={true}
          title={cancelRefundLoadPending ? "Refund Not Staged" : "Cancel Order?"}
          message={
            cancelRefundLoadPending
              ? "Nothing was changed on the Transaction Record. Retry loading the cancellation refund into this Register."
              : "If money was paid, Riverside will stage negative items in this Register. Status, inventory, balances, refund, and audit will change together only after Record Sale succeeds."
          }
          confirmLabel={
            orderMutationBusy
              ? cancelRefundLoadPending
                ? "Loading..."
                : "Cancelling..."
              : cancelRefundLoadPending
                ? "Retry Refund Load"
                : "Cancel Order"
          }
          onConfirm={() => void runCancelOrder()}
          onClose={() => {
            if (!orderMutationBusy && !cancelRefundLoadPending) setCancelOrder(null);
          }}
          variant="danger"
        />
      )}
      {cancelItem && selectedOrder ? (
        <div className="ui-overlay-backdrop !z-[300] flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="register-cancel-item-title"
            className="ui-modal flex max-h-[92vh] w-full max-w-2xl flex-col"
          >
            <div className="ui-modal-header flex items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                  Customer Orders
                </p>
                <h2
                  id="register-cancel-item-title"
                  className="mt-1 text-xl font-black text-app-text"
                >
                  Cancel Item
                </h2>
                <p className="mt-2 text-sm font-bold text-app-text">
                  {cancelItem.product_name}
                </p>
                <p className="text-xs font-semibold text-app-text-muted">
                  {cancelItem.sku} · Qty {remainingOrderItemQuantity(cancelItem)} · {selectedOrder.display_id}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close item cancellation"
                disabled={orderMutationBusy}
                onClick={() => {
                  setCancelItem(null);
                  setCancelItemPreview(null);
                  setCancelItemError(null);
                }}
                className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2"
              >
                <X size={20} />
              </button>
            </div>

            <div className="ui-modal-body min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
              <p className="rounded-xl border border-app-info/25 bg-app-info/10 p-3 text-sm font-semibold text-app-text">
                Riverside removes the item from this Order, releases its customer inventory hold when applicable, and applies the item credit to any unpaid balance first. Only a real overpayment becomes a refund.
              </p>

              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Cancellation reason
                <textarea
                  value={cancelItemReason}
                  disabled={orderMutationBusy}
                  onChange={(event) => {
                    setCancelItemReason(event.target.value);
                    setCancelItemPreview(null);
                    setCancelItemError(null);
                  }}
                  placeholder="Why is this Order item being cancelled? (minimum 12 characters)"
                  className="mt-1 min-h-24 w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm font-semibold normal-case tracking-normal text-app-text"
                />
              </label>

              {cancelItemPreview ? (
                <div className="space-y-3 rounded-2xl border border-app-border bg-app-surface-2 p-4">
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ["Balance Before", cancelItemPreview.original_balance_due],
                      ["Item Credit", cancelItemPreview.cancellation_total],
                      ["Balance After", cancelItemPreview.balance_due_after],
                      ["Refund Due", cancelItemPreview.refund_due],
                    ].map(([label, amount]) => (
                      <div key={label} className="rounded-xl border border-app-border bg-app-surface p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {label}
                        </p>
                        <p className="mt-1 font-mono text-base font-black text-app-text">
                          {formatCurrency(amount)}
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm font-bold text-app-text">
                    {parseMoneyToCents(cancelItemPreview.refund_due) > 0
                      ? `${formatCurrency(cancelItemPreview.credit_applied_to_balance)} applies to the prior balance. ${formatCurrency(cancelItemPreview.refund_due)} must be completed through Pay.`
                      : `${formatCurrency(cancelItemPreview.credit_applied_to_balance)} reduces the prior balance. No money will be sent to the customer.`}
                  </p>
                  <p className="rounded-lg border border-app-success/20 bg-app-success/10 p-3 text-xs font-semibold text-app-text">
                    {cancelItemPreview.lines[0]?.inventory_disposition}
                  </p>
                </div>
              ) : null}

              {cancelItemError ? (
                <p className="rounded-xl border border-app-danger/25 bg-app-danger/10 p-3 text-sm font-bold text-app-danger">
                  {cancelItemError}
                </p>
              ) : null}
            </div>

            <div className="ui-modal-footer flex gap-3">
              <button
                type="button"
                disabled={orderMutationBusy}
                onClick={() => {
                  setCancelItem(null);
                  setCancelItemPreview(null);
                  setCancelItemError(null);
                }}
                className="ui-btn-secondary flex-1"
              >
                Keep Item
              </button>
              {cancelItemPreview ? (
                <button
                  type="button"
                  disabled={
                    orderMutationBusy || cancelItemReason.trim().length < 12
                  }
                  onClick={() => void confirmItemCancellation()}
                  className="flex-1 rounded-xl border-b-4 border-app-danger bg-app-danger px-4 py-3 text-[10px] font-black uppercase tracking-widest text-white disabled:opacity-50"
                >
                  {orderMutationBusy
                    ? "Cancelling…"
                    : parseMoneyToCents(cancelItemPreview.refund_due) > 0
                      ? "Cancel Item & Continue to Refund"
                      : "Confirm Item Cancellation"}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={orderMutationBusy}
                  onClick={() => void reviewItemCancellation()}
                  className="ui-btn-primary flex-1"
                >
                  {orderMutationBusy ? "Reviewing…" : "Review Balance & Refund"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    document.getElementById("drawer-root")!,
  );
}
