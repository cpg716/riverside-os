import { useState } from "react";
import { X, Flame, Calendar, Package, MapPin, ArrowRight } from "lucide-react";
import {
  customOrderDetailEntries,
  customVendorLabel,
  type CustomOrderDetails,
} from "../../lib/customOrders";

export interface OrderOptions {
  isRush: boolean;
  needByDate: string | null;
  fulfillment: "pickup";
  shipTo: null;
  storeCardForBalance: {
    stripe_payment_method_id: string;
    last4: string;
  } | null;
}

interface CartLineItem {
  cart_row_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  variation_label: string | null;
  standard_retail_price: string;
  quantity: number;
  fulfillment: string;
  custom_item_type?: string | null;
  custom_order_details?: CustomOrderDetails | null;
}

interface Customer {
  id: string;
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
}

interface OrderReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartLineItem[];
  customer?: Customer | null;
  onComplete: (options: OrderOptions) => void;
}

export default function OrderReviewModal({
  isOpen,
  onClose,
  items,
  customer: _customer,
  onComplete,
}: OrderReviewModalProps) {
  void _customer; // reserved for future use
  
  const [isRush, setIsRush] = useState(false);
  const [needByDate, setNeedByDate] = useState<string | null>(null);

  if (!isOpen) return null;

  const orderTotal = items.reduce((sum, item) => {
    const price = parseFloat(item.standard_retail_price) * 100;
    return sum + price * item.quantity;
  }, 0);

  const handleContinue = () => {
    onComplete({
      isRush,
      needByDate,
      fulfillment: "pickup",
      shipTo: null,
      storeCardForBalance: null,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-3xl border border-app-border bg-app-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-app-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/20">
              <Package size={20} className="text-amber-500" />
            </div>
            <div>
              <h2 className="text-lg font-black text-app-text">Review Order</h2>
              <p className="text-xs text-app-text-muted">{items.length} items to fulfill</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-app-border text-app-text-muted transition-colors hover:bg-app-surface-2"
          >
            <X size={20} />
          </button>
        </div>

        {/* Order Items */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-3">
            {items.map((item) => (
              <div
                key={item.cart_row_id}
                className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-app-border bg-app-surface">
                  <Package size={16} className="text-app-text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-app-text">{item.name}</p>
                  <div className="flex items-center gap-2 text-xs text-app-text-muted">
                    <span className="font-mono uppercase">{item.sku}</span>
                    {item.variation_label && (
                      <span className="rounded bg-app-surface px-1.5 py-0.5">{item.variation_label}</span>
                    )}
                    <span>×{item.quantity}</span>
                  </div>
                  {item.custom_item_type && (
                    <div className="mt-2 space-y-0.5 rounded-xl border border-app-border/70 bg-app-surface px-2 py-2 text-[10px] font-semibold text-app-text-muted">
                      <p className="font-black uppercase tracking-widest text-app-text">
                        {item.custom_item_type}
                      </p>
                      {item.custom_order_details?.vendor_form_family && (
                        <p className="font-black uppercase tracking-widest text-app-text">
                          {customVendorLabel(item.custom_order_details.vendor_form_family)}
                        </p>
                      )}
                      {customOrderDetailEntries(item.custom_order_details)
                        .slice(0, 6)
                        .map((entry) => (
                          <p key={entry.label}>
                            {entry.label}: {entry.value}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-app-text">
                    ${(parseFloat(item.standard_retail_price) * item.quantity).toFixed(2)}
                  </p>
                  <p className="text-xs uppercase text-app-text-muted">
                    {item.fulfillment === "wedding_order" ? "Wedding" : item.fulfillment}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Priority Options */}
          <div className="mt-6 space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-app-text-muted">Priority</h3>
            
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setIsRush(!isRush)}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition-colors ${
                  isRush
                    ? "border-app-danger/50 bg-app-danger/15 text-app-danger"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <Flame size={18} className={isRush ? "animate-pulse" : ""} />
                Rush Order
              </button>
              
              <label
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition-colors ${
                  needByDate
                    ? "border-app-warning/50 bg-app-warning/15 text-app-warning"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <Calendar size={18} />
                <span>{needByDate || "Set Due Date"}</span>
                <input
                  type="date"
                  value={needByDate || ""}
                  onChange={(event) => setNeedByDate(event.target.value || null)}
                  className="sr-only"
                  aria-label="Need by date"
                />
              </label>
            </div>
          </div>

          {/* Fulfillment Summary */}
          <div className="mt-6 space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-app-text-muted">Pickup / Release</h3>
            
            <div className="rounded-xl border border-app-success/40 bg-app-success/10 p-4">
              <div className="flex items-center gap-2 text-sm font-black text-app-success">
                <MapPin size={18} />
                Pickup / store release
              </div>
              <p className="mt-2 text-xs font-semibold text-app-text-muted">
                To ship this current sale, use the cart&apos;s Ship current sale action so rates,
                address, and shipment tracking stay together.
              </p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-app-border px-6 py-4">
          <div>
            <p className="text-xs text-app-text-muted">Order Total</p>
            <p className="text-2xl font-black text-app-text">${(orderTotal / 100).toFixed(2)}</p>
          </div>
          <button
            type="button"
            onClick={handleContinue}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 px-8 py-4 text-lg font-bold text-white shadow-lg transition-all hover:bg-emerald-500 active:scale-98"
          >
            Continue to Payment
            <ArrowRight size={20} />
          </button>
        </div>
      </div>
    </div>
  );
}
