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
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import VariantSearchInput, {
  type VariantSearchResult,
} from "../ui/VariantSearchInput";

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

interface OrderLoadModalProps {
  isOpen: boolean;
  customerId: string;
  customerName: string;
  registerSessionId?: string | null;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onClose: () => void;
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
  onPickupToCart?: (selections: PickupSelection[]) => Promise<boolean>;
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

export default function OrderLoadModal({
  isOpen,
  customerId,
  customerName,
  registerSessionId,
  baseUrl,
  apiAuth,
  onClose,
  onMakePayment,
  onAddItemToOrder,
  onUpdateOrderItem,
  onDeleteOrderItem,
  onPickupToCart,
}: OrderLoadModalProps) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrderItems, setSelectedOrderItems] = useState<OrderItem[]>([]);
  const [viewingItemsOrderId, setViewingItemsOrderId] = useState<string | null>(
    null,
  );
  const [paymentOrder, setPaymentOrder] = useState<CustomerOrder | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [addSku, setAddSku] = useState("");
  const [orderMutationBusy, setOrderMutationBusy] = useState(false);
  const [pickupBusy, setPickupBusy] = useState(false);
  const [pickupConfirm, setPickupConfirm] = useState<{
    mode: ReleaseMode;
    order: CustomerOrder;
    items: OrderItem[];
    blockedItems: OrderItem[];
  } | null>(null);
  const [cancelOrder, setCancelOrder] = useState<CustomerOrder | null>(null);
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
      setPickupSelection(
        Object.fromEntries(
          items
            .filter((item) => !item.is_fulfilled)
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
    setSelectedOrderItems([]);
    setViewingItemsOrderId(null);
    setLoading(true);
    const params = new URLSearchParams({
      customer_id: customerId,
      limit: "25",
      record_scope: "orders",
      status_scope: "open",
    });
    if (registerSessionId) params.set("register_session_id", registerSessionId);
    fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
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
  }, [isOpen, customerId, registerSessionId, baseUrl, apiAuth, toast]);

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
    if (order.status === "fulfilled") return "Picked up";
    if (order.status === "pending_measurement")
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
    if (order.status === "fulfilled") {
      return isWedding
        ? "This wedding order is already completed at pickup."
        : "These items are already marked picked up.";
    }
    if (order.status === "pending_measurement") {
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

  const submitRelease = async (
    order: CustomerOrder,
    items: OrderItem[],
    overrideReadiness: boolean,
    mode: ReleaseMode = orderReleaseMode(order),
  ) => {
    const ids = items
      .map((item) => item.transaction_line_id)
      .filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      toast(`No open order lines are available to ${releaseLabel(mode).toLowerCase()}.`, "error");
      return;
    }
    setPickupBusy(true);
    try {
      const endpoint = mode === "ship" ? "ship" : "pickup";
      const itemKey =
        mode === "ship" ? "shipped_item_ids" : "delivered_item_ids";
      const res = await fetch(
        `${baseUrl}/api/transactions/${order.id}/${endpoint}`,
        {
          method: "POST",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify({
            [itemKey]: ids,
            actor: "Register Customer Orders",
            override_readiness: overrideReadiness,
            override_reason: overrideReadiness
              ? `Register ${mode} override: customer received item before ready status; staff confirmed release.`
              : undefined,
            register_session_id: registerSessionId ?? undefined,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          body.error ??
            `${releaseLabel(mode)} could not be completed.`,
          "error",
        );
        return;
      }
      toast(
        overrideReadiness
          ? `${releaseLabel(mode)} completed with override recorded.`
          : `${releaseLabel(mode)} completed.`,
        "success",
      );
      setPickupConfirm(null);
      await loadOrderItems(order.id);
      setLoading(true);
      const params = new URLSearchParams({
        customer_id: customerId,
        limit: "25",
        record_scope: "orders",
        status_scope: "all",
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
      const openItems = loadedItems.filter((item) => !item.is_fulfilled);
      if (openItems.length === 0) {
        toast(
          `No open order lines are available to ${releaseLabel(mode).toLowerCase()}.`,
          "info",
        );
        return;
      }
      const blockedItems = openItems.filter(
        (item) => item.order_lifecycle_status !== "ready_for_pickup",
      );
      if (blockedItems.length > 0) {
        setPickupConfirm({ mode, order, items: openItems, blockedItems });
        return;
      }
      if (mode === "pickup" && onPickupToCart) {
        addToPickupBasket(order, openItems);
        return;
      }
      await submitRelease(order, openItems, false, mode);
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
      (item) => !item.is_fulfilled && item.transaction_line_id,
    );
    if (openItems.length === 0) {
      toast("Select at least one open order line for pickup.", "error");
      return;
    }
    if (openItems.some((item) => item.order_lifecycle_status !== "ready_for_pickup")) {
      toast("Only items marked Ready for Pickup can be added to a multi-order pickup. Use the manager override on a single order for unready items.", "error");
      return;
    }
    setPickupBasket((previous) => [
      ...previous.filter((entry) => entry.order.id !== order.id),
      { order, items: openItems },
    ]);
    toast(`${openItems.length} item(s) from ${order.display_id} added to pickup. Select another order or start pickup.`, "success");
  };

  const startPickupBasket = async () => {
    if (!onPickupToCart || pickupBasket.length === 0) return;
    setPickupBusy(true);
    try {
      const loaded = await onPickupToCart(pickupBasket);
      if (loaded) {
        setPickupBasket([]);
        setPickupConfirm(null);
        onClose();
      }
    } finally {
      setPickupBusy(false);
    }
  };

  const releaseSelectedLines = async () => {
    if (!selectedOrder) return;
    const mode = orderReleaseMode(selectedOrder);
    const selected = selectedOrderItems.filter(
      (item) => !item.is_fulfilled && pickupSelection[item.transaction_line_id],
    );
    if (selected.length === 0) {
      toast(
        `Select at least one open order line to ${releaseLabel(mode).toLowerCase()}.`,
        "error",
      );
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
    if (mode === "pickup" && onPickupToCart) {
      addToPickupBasket(selectedOrder, selected);
      return;
    }
    await submitRelease(selectedOrder, selected, false, mode);
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
    onClose();
  };

  const addSkuToSelectedOrder = async () => {
    if (!selectedOrder || !onAddItemToOrder) return;
    const sku = addSku.trim();
    if (!sku) {
      toast("Scan or enter a SKU before adding it to this order.", "error");
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
    if (!selectedOrder || !onAddItemToOrder) return;
    setOrderMutationBusy(true);
    try {
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

  const runCancelOrder = async () => {
    if (!cancelOrder) return;
    setOrderMutationBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${cancelOrder.id}`, {
        method: "PATCH",
        headers: { ...apiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Order could not be cancelled.", "error");
        return;
      }
      toast(
        "Order cancelled. Any refund due was queued for Register refund processing.",
        "info",
      );
      setCancelOrder(null);
      setSelectedOrderItems([]);
      setViewingItemsOrderId(null);
      setPickupSelection({});
      setOrders((prev) =>
        prev.map((order) =>
          order.id === cancelOrder.id
            ? { ...order, status: "cancelled" }
            : order,
        ),
      );
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
        </div>

        <div className="ui-modal-body flex-1 overflow-y-auto p-4 sm:p-6">
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
                        Payment Only
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid={`pos-order-${orderReleaseMode(order)}-${order.display_id}`}
                      onClick={() => void openReleaseSelection(order)}
                      disabled={pickupBusy || order.status === "fulfilled"}
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
                        order.status === "cancelled" ||
                        order.status === "fulfilled"
                      }
                      onClick={() => setCancelOrder(order)}
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

          {pickupBasket.length > 0 && onPickupToCart ? (
            <section className="mt-5 rounded-2xl border border-app-success/30 bg-app-success/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-success">
                    Pickup basket
                  </p>
                  <p className="mt-1 text-sm font-semibold text-app-text">
                    {pickupBasket.reduce((sum, entry) => sum + entry.items.length, 0)} item(s) from {pickupBasket.length} order(s)
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void startPickupBasket()}
                  disabled={pickupBusy}
                  className="flex min-h-10 items-center justify-center gap-2 rounded-xl border-b-4 border-app-success bg-app-success px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg disabled:cursor-wait disabled:opacity-50"
                >
                  <ShieldCheck size={14} />
                  Start Pickup
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
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
                Select another order below to add more items. Payment and pickup release remain tracked per order.
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
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={
                    pickupBusy ||
                    selectedOrderItems.every((item) => item.is_fulfilled)
                  }
                  onClick={() => void releaseSelectedLines()}
                  className="flex min-h-10 items-center justify-center gap-2 rounded-xl border-b-4 border-app-success bg-app-success px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg transition-all hover:opacity-90 disabled:opacity-50"
                >
                  {orderReleaseMode(selectedOrder) === "ship" ? (
                    <Truck size={14} />
                  ) : (
                    <ShieldCheck size={14} />
                  )}
                  {releaseLabel(orderReleaseMode(selectedOrder))} Selected
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 text-[10px]"
                  onClick={() =>
                    setPickupSelection(
                      Object.fromEntries(
                        selectedOrderItems
                          .filter((item) => !item.is_fulfilled)
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
                {selectedOrderItems.map((item) => (
                  <div
                    key={item.transaction_line_id}
                    className={`flex flex-col gap-3 rounded-xl border p-3 text-xs ${
                      item.is_fulfilled
                        ? "border-emerald-200 bg-emerald-50/50 opacity-60"
                        : "border-app-border bg-app-surface-2/30"
                    }`}
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex flex-1 flex-col">
                        <label className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            disabled={item.is_fulfilled}
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
                          <span className="font-medium text-app-text">
                            {item.product_name}
                          </span>
                        </label>
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
                            item.order_lifecycle_status ===
                              "needs_measurements" ||
                            (item.order_lifecycle_status === "received" &&
                              item.alteration_status)
                              ? "border-app-warning/25 bg-app-warning/10 text-app-warning"
                              : "border-app-border bg-app-surface text-app-text-muted"
                          }`}
                        >
                          {lineLifecycleLabel(
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
                      </div>
                      <div className="flex flex-col items-end">
                        {selectedOrder && !item.is_fulfilled ? (
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
                            {releaseLabel(orderReleaseMode(selectedOrder))} Line
                          </button>
                        ) : null}
                        {onUpdateOrderItem && !item.is_fulfilled ? (
                          <div className="grid w-full gap-2 sm:w-[24rem] sm:grid-cols-[4rem_minmax(0,1fr)]">
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
                            <div className="col-span-2">
                              <VariantSearchInput
                                placeholder="Search this item for the correct size or variation"
                                onSelect={(variant) => {
                                  if (variant.product_id !== item.product_id) {
                                    toast(
                                      "Use Delete and Add when changing to a different item.",
                                      "error",
                                    );
                                    return;
                                  }
                                  setLineDrafts((prev) => ({
                                    ...prev,
                                    [item.transaction_line_id]: {
                                      quantity:
                                        prev[item.transaction_line_id]
                                          ?.quantity ?? String(item.quantity),
                                      unit_price:
                                        prev[item.transaction_line_id]
                                          ?.unit_price ?? item.unit_price,
                                      variant_id: variant.variant_id,
                                      sku: variant.sku,
                                      variation_label:
                                        variant.variation_label ?? null,
                                      order_lifecycle_status:
                                        prev[item.transaction_line_id]
                                          ?.order_lifecycle_status ??
                                        item.order_lifecycle_status ??
                                        "ntbo",
                                    },
                                  }));
                                }}
                              />
                            </div>
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
                            {onDeleteOrderItem ? (
                              <button
                                type="button"
                                disabled={orderMutationBusy}
                                onClick={() => void deleteLine(item)}
                                className="col-span-2 flex min-h-9 items-center justify-center gap-2 rounded-lg border border-app-danger/20 bg-app-danger/10 px-2 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
                              >
                                <Trash2 size={12} />
                                Delete Line
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
                ))}
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
      {pickupConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={`${releaseLabel(pickupConfirm.mode)} Readiness Override?`}
          message={`${pickupConfirm.blockedItems.length} line(s) are not marked Ready for Pickup. Continue only if staff verified the customer is receiving the item now; this records an override and moves ${pickupConfirm.mode}/inventory/recognition.`}
          confirmLabel={
            pickupBusy
              ? "Releasing..."
              : `Release ${releaseLabel(pickupConfirm.mode)}`
          }
          onConfirm={() =>
            void submitRelease(
              pickupConfirm.order,
              pickupConfirm.items,
              true,
              pickupConfirm.mode,
            )
          }
          onClose={() => {
            if (!pickupBusy) setPickupConfirm(null);
          }}
          variant="info"
        />
      )}
      {cancelOrder && (
        <ConfirmationModal
          isOpen={true}
          title="Cancel Order?"
          message="This will cancel the Transaction Record and queue any paid deposits or payments for refund processing. It does not silently refund money."
          confirmLabel={orderMutationBusy ? "Cancelling..." : "Cancel Order"}
          onConfirm={() => void runCancelOrder()}
          onClose={() => {
            if (!orderMutationBusy) setCancelOrder(null);
          }}
          variant="danger"
        />
      )}
    </div>,
    document.getElementById("drawer-root")!,
  );
}
