import { useEffect, useMemo, useState } from "react";
import { X, Package, Clock, AlertCircle, ArrowRight, CreditCard } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

export interface CustomerOrder {
  id: string;
  customer_id?: string | null;
  display_id: string;
  order_payment_display_id?: string | null;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  order_kind: string;
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
  is_fulfilled: boolean;
  is_rush?: boolean;
  need_by_date?: string | null;
}

interface OrderLoadModalProps {
  isOpen: boolean;
  customerId: string;
  customerName: string;
  registerSessionId?: string | null;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onClose: () => void;
  onCopyOrder: (order: CustomerOrder, items: OrderItem[]) => void;
  onMakePayment?: (order: CustomerOrder, amountCents: number) => void;
}

export default function OrderLoadModal({
  isOpen,
  customerId,
  customerName,
  registerSessionId,
  baseUrl,
  apiAuth,
  onClose,
  onCopyOrder,
  onMakePayment,
}: OrderLoadModalProps) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrderItems, setSelectedOrderItems] = useState<OrderItem[]>([]);
  const [viewingItemsOrderId, setViewingItemsOrderId] = useState<string | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<CustomerOrder | null>(null);
  const [paymentAmount, setPaymentAmount] = useState("");

  const fetchOrderItems = async (orderId: string) => {
    const params = new URLSearchParams();
    if (registerSessionId) params.set("register_session_id", registerSessionId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(`${baseUrl}/api/transactions/${orderId}/items${suffix}`, {
      headers: apiAuth(),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Could not load order items (${res.status})`);
    }
    const data = (await res.json()) as OrderItem[];
    return Array.isArray(data) ? data : [];
  };

  const loadOrderItems = async (orderId: string) => {
    setViewingItemsOrderId(orderId);
    try {
      const items = await fetchOrderItems(orderId);
      setSelectedOrderItems(items);
    } catch (e) {
      setSelectedOrderItems([]);
      toast(
        e instanceof Error ? e.message : "We couldn't load those order items. Please try again.",
        "error",
      );
    }
  };

  useEffect(() => {
    if (!isOpen || !customerId) return;
    setLoading(true);
    const params = new URLSearchParams({
      customer_id: customerId,
      limit: "25",
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
        setOrders(rows);
      })
      .catch(() => {
        setOrders([]);
        toast("We couldn't load this customer's orders. Please try again.", "error");
      })
      .finally(() => setLoading(false));
  }, [isOpen, customerId, registerSessionId, baseUrl, apiAuth, toast]);

  const formatCurrency = (amount: string) => formatUsdFromCents(parseMoneyToCents(amount));

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
    const isWedding = order.order_kind === "wedding_order" || Boolean(order.wedding_member_id);
    if (order.status === "fulfilled") return "Picked up";
    if (order.status === "pending_measurement") return "Waiting on measurements";
    if (isWedding && dueCents <= 0) return "Wedding balance paid";
    if (isWedding && paidCents > 0 && dueCents > 0) return "Wedding deposit received";
    if (paidCents > 0 && dueCents > 0) return "Deposit received";
    if (dueCents <= 0) return "Balance paid";
    return "Balance still due";
  };

  const lifecycleNote = (order: CustomerOrder) => {
    const isWedding = order.order_kind === "wedding_order" || Boolean(order.wedding_member_id);
    if (order.status === "fulfilled") {
      return isWedding
        ? "This wedding order is already completed at pickup."
        : "This order is already completed at pickup.";
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
        : "A deposit has been recorded. Collect the remaining balance only when the order is ready.";
    }
    return isWedding
      ? "No payment is on this wedding order yet. Confirm member readiness before collecting money or promising pickup."
      : "No payment is on the order yet. Confirm receiving and pickup status before collecting money.";
  };

  const copyOrderItems = async (order: CustomerOrder) => {
    try {
      const items = await fetchOrderItems(order.id);
      const unfulfilled = items.filter((item) => !item.is_fulfilled);
      if (unfulfilled.length === 0) {
        toast("All order lines are already marked complete.", "info");
        return;
      }
      onCopyOrder(order, unfulfilled);
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message
          : "We couldn't prepare this order for the register. Please try again.",
        "error",
      );
    }
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex w-[min(920px,calc(100vw-2rem))] max-h-[84vh] flex-col rounded-2xl border border-app-border bg-app-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Package size={20} className="text-blue-600" />
            <span className="font-black text-app-text">Customer Orders</span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-app-surface-2">
            <X size={20} />
          </button>
        </div>

        <div className="flex flex-col gap-2 border-b border-app-border bg-app-surface-2/30 px-5 py-2">
          <span className="text-xs text-app-text-muted">Customer</span>
          <span className="font-medium text-app-text">{customerName}</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <span className="animate-pulse text-app-text-muted">Loading orders...</span>
            </div>
          ) : orders.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertCircle size={32} className="text-app-text-muted" />
              <span className="text-app-text-muted">No open orders for this customer</span>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {orders.map((order) => (
                <div
                  key={order.id}
                  className="grid gap-4 rounded-xl border border-app-border bg-app-surface-2/50 p-4 xl:grid-cols-[minmax(0,1fr)_12rem]"
                >
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-app-text">
                        {order.display_id}
                      </span>
                      <span className="rounded bg-app-surface px-1.5 py-0.5 text-[10px] font-bold uppercase text-app-text-muted">
                        {order.order_kind === "wedding_order"
                          ? "Wedding"
                          : order.order_kind === "custom"
                            ? "Custom"
                            : "Order"}
                      </span>
                      {order.is_rush && (
                        <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-red-700">
                          RUSH
                        </span>
                      )}
                      {order.need_by_date && (
                        <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-700">
                          <Clock size={10} />
                          {formatDate(order.need_by_date)}
                        </span>
                      )}
                      {order.party_name && (
                        <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-rose-700">
                          {order.party_name}
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs text-app-text-muted sm:grid-cols-4">
                      <span>{formatDate(order.booked_at)}</span>
                      <span className="font-medium text-emerald-600">
                        Paid: {formatCurrency(order.amount_paid)}
                      </span>
                      <span className="font-medium text-amber-600">
                        Due: {formatCurrency(order.balance_due)}
                      </span>
                      <span className="uppercase">{lifecycleLabel(order)}</span>
                    </div>
                    <p className="text-[11px] font-semibold text-app-text-muted">
                      {lifecycleNote(order)}
                    </p>
                  </div>
                  <div className="grid shrink-0 grid-cols-1 gap-1 sm:grid-cols-3 xl:grid-cols-1">
                    {onMakePayment && parseMoneyToCents(order.balance_due) > 0 ? (
                      <button
                        type="button"
                        data-testid={`pos-order-make-payment-${order.display_id}`}
                        onClick={() => openPaymentEntry(order)}
                        className="flex h-9 items-center justify-center gap-1 rounded-lg border-2 border-violet-500/40 bg-violet-50 px-3 text-xs font-bold text-violet-700 transition-all hover:bg-violet-600 hover:text-white"
                      >
                        <CreditCard size={14} />
                        Make Payment
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => {
                        void loadOrderItems(order.id);
                      }}
                      className="flex h-9 items-center justify-center gap-1 rounded-lg border-2 border-blue-500/40 bg-blue-50 px-3 text-xs font-bold text-blue-700 transition-all hover:bg-blue-500 hover:text-white"
                    >
                      Review
                      <ArrowRight size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void copyOrderItems(order);
                      }}
                      className="flex h-9 items-center justify-center gap-1 rounded-lg border-2 border-emerald-600/40 bg-emerald-50 px-3 text-xs font-bold text-emerald-700 transition-all hover:bg-emerald-600 hover:text-white"
                    >
                      Copy to Register
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedOrderItems.length > 0 && (
            <div className="mt-4 border-t border-app-border pt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-app-text">
                  {selectedOrder?.display_id ?? "Order"} details
                </span>
                <button
                  onClick={() => {
                    setSelectedOrderItems([]);
                    setViewingItemsOrderId(null);
                  }}
                  className="text-xs text-app-text-muted hover:text-app-text"
                >
                  Close
                </button>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {selectedOrderItems.map((item) => (
                  <div
                    key={item.transaction_line_id}
                    className={`flex items-center justify-between rounded-lg border p-2 text-xs ${
                      item.is_fulfilled
                        ? "border-emerald-200 bg-emerald-50/50 opacity-60"
                        : "border-app-border bg-app-surface-2/30"
                    }`}
                  >
                    <div className="flex flex-1 flex-col">
                      <span className="font-medium text-app-text">{item.product_name}</span>
                      <span className="text-app-text-muted">
                        {item.sku} · {item.fulfillment === "wedding_order" ? "wedding order" : item.fulfillment}
                      </span>
                      {item.fulfillment === "wedding_order" && (
                        <span className="mt-1 text-[10px] font-bold uppercase tracking-widest text-rose-600">
                          Keep wedding payment and pickup work tied to the linked member.
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="font-medium text-app-text">
                        {formatCurrency(item.unit_price)}
                      </span>
                      <span className="text-app-text-muted">×{item.quantity}</span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
                Copying items starts a new register sale. It does not collect payment on the
                original order record.
              </p>
              {selectedOrder?.order_kind === "wedding_order" && (
                <p className="mt-2 text-[11px] font-semibold text-rose-700">
                  Keep payment, deposit follow-up, and pickup release tied to the linked wedding
                  member after this POS review.
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    if (!selectedOrder) return;
                    const unfulfilled = selectedOrderItems.filter((i) => !i.is_fulfilled);
                    onCopyOrder(selectedOrder, unfulfilled);
                  }}
                  className="flex-1 rounded-lg bg-blue-600 py-2 text-xs font-bold text-white"
                >
                  Copy Unfulfilled Items
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {paymentOrder ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm">
          <div
            className="w-full max-w-sm rounded-2xl border border-app-border bg-app-surface p-5 shadow-2xl"
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
      ) : null}
    </div>
  );
}
