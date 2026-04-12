import { useState, useEffect } from "react";
import { X, Package, Clock, AlertCircle, ArrowRight } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";

interface CustomerOrder {
  id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  is_rush: boolean;
  need_by_date: string | null;
}

interface OrderItem {
  order_item_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  unit_price: string;
  fulfillment: string;
  is_fulfilled: boolean;
}

interface OrderLoadModalProps {
  isOpen: boolean;
  customerId: string;
  customerName: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onClose: () => void;
  onSelectOrder: (order: CustomerOrder, mode: "pickup" | "ship") => void;
  onSelectItems: (orderId: string, items: OrderItem[]) => void;
}

export default function OrderLoadModal({
  isOpen,
  customerId,
  customerName,
  baseUrl,
  apiAuth,
  onClose,
  onSelectOrder,
  onSelectItems,
}: OrderLoadModalProps) {
  const { toast } = useToast();
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrderItems, setSelectedOrderItems] = useState<OrderItem[]>([]);
  const [viewingItemsOrderId, setViewingItemsOrderId] = useState<string | null>(null);

  const loadOrderItems = (orderId: string) => {
    setViewingItemsOrderId(orderId);
    fetch(`${baseUrl}/api/orders/order-items/${orderId}`, {
      headers: apiAuth(),
    })
      .then((r) => r.json())
      .then((data) => {
        setSelectedOrderItems(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        setSelectedOrderItems([]);
        toast("Failed to load items", "error");
      });
  };

  useEffect(() => {
    if (!isOpen || !customerId) return;
    setLoading(true);
    fetch(`${baseUrl}/api/orders/by-customer/${customerId}`, {
      headers: apiAuth(),
    })
      .then((r) => r.json())
      .then((data) => {
        setOrders(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        setOrders([]);
        toast("Failed to load orders", "error");
      })
      .finally(() => setLoading(false));
  }, [isOpen, customerId, baseUrl, apiAuth, toast]);

  const formatCurrency = (cents: string) => {
    const c = parseInt(cents) || 0;
    return `$${(c / 100).toFixed(2)}`;
  };

  const formatDate = (iso: string) => {
    return new Date(iso).toLocaleDateString();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="flex w-[500px] max-h-[80vh] flex-col rounded-2xl border border-app-border bg-app-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Package size={20} className="text-blue-600" />
            <span className="font-black text-app-text">Open Orders</span>
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
            <div className="flex flex-col gap-2">
              {orders.map((order) => (
                <div
                  key={order.id}
                  className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface-2/50 p-3"
                >
                  <div className="flex flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-app-text">
                        {formatCurrency(order.total_price)}
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
                    </div>
                    <div className="flex items-center gap-3 text-xs text-app-text-muted">
                      <span>{formatDate(order.booked_at)}</span>
                      <span
                        className={`font-medium ${
                          order.balance_due !== "0"
                            ? "text-amber-600"
                            : "text-emerald-600"
                        }`}
                      >
                        Due: {formatCurrency(order.balance_due)}
                      </span>
                      <span className="uppercase">{order.status}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => loadOrderItems(order.id)}
                      className="flex h-9 items-center gap-1 rounded-lg border-2 border-blue-500/40 bg-blue-50 px-3 text-xs font-bold text-blue-700 transition-all hover:bg-blue-500 hover:text-white"
                    >
                      Items
                      <ArrowRight size={14} />
                    </button>
                    <button
                      onClick={() => onSelectOrder(order, "pickup")}
                      className="flex h-9 items-center gap-1 rounded-lg border-2 border-emerald-600/40 bg-emerald-50 px-3 text-xs font-bold text-emerald-700 transition-all hover:bg-emerald-600 hover:text-white"
                    >
                      Pickup
                    </button>
                    <button
                      onClick={() => onSelectOrder(order, "ship")}
                      className="flex h-9 items-center gap-1 rounded-lg border-2 border-purple-500/40 bg-purple-50 px-3 text-xs font-bold text-purple-700 transition-all hover:bg-purple-500 hover:text-white"
                    >
                      Ship
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedOrderItems.length > 0 && (
            <div className="mt-4 border-t border-app-border pt-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-app-text">Order Items</span>
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
                    key={item.order_item_id}
                    className={`flex items-center justify-between rounded-lg border p-2 text-xs ${
                      item.is_fulfilled
                        ? "border-emerald-200 bg-emerald-50/50 opacity-60"
                        : "border-app-border bg-app-surface-2/30"
                    }`}
                  >
                    <div className="flex flex-1 flex-col">
                      <span className="font-medium text-app-text">{item.product_name}</span>
                      <span className="text-app-text-muted">
                        {item.sku} · {item.fulfillment}
                      </span>
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
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    const unfulfilled = selectedOrderItems.filter((i) => !i.is_fulfilled);
                    onSelectItems(viewingItemsOrderId!, unfulfilled);
                  }}
                  className="flex-1 rounded-lg bg-blue-600 py-2 text-xs font-bold text-white"
                >
                  Add All to Cart
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}