import { useState } from "react";
import { X, Flame, Calendar, Package, MapPin, Truck, CreditCard, Check, ArrowRight } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { type PosShipToForm } from "./types";
import {
  customOrderDetailEntries,
  customVendorLabel,
  type CustomOrderDetails,
} from "../../lib/customOrders";

export interface OrderOptions {
  isRush: boolean;
  needByDate: string | null;
  fulfillment: "pickup" | "ship";
  shipTo: PosShipToForm | null;
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
  savedCards?: Array<{
    stripe_payment_method_id: string;
    last4: string;
    brand: string;
  }>;
  onComplete: (options: OrderOptions) => void;
}

export default function OrderReviewModal({
  isOpen,
  onClose,
  items,
  customer: _customer,
  savedCards = [],
  onComplete,
}: OrderReviewModalProps) {
  void _customer; // reserved for future use
  const { toast } = useToast();
  
  const [isRush, setIsRush] = useState(false);
  const [needByDate, setNeedByDate] = useState<string | null>(null);
  const [fulfillment, setFulfillment] = useState<"pickup" | "ship">("pickup");
  const [shipTo, setShipTo] = useState<OrderOptions["shipTo"]>(null);
  const [saveCardForBalance, setSaveCardForBalance] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  if (!isOpen) return null;

  const orderTotal = items.reduce((sum, item) => {
    const price = parseFloat(item.standard_retail_price) * 100;
    return sum + price * item.quantity;
  }, 0);

  const handleContinue = () => {
    // Validate shipping address if needed
    if (fulfillment === "ship" && !shipTo) {
      toast("Enter shipping address", "error");
      return;
    }
    
    // If saving card, need to select one
    let storedCard: OrderOptions["storeCardForBalance"] = null;
    if (fulfillment === "ship" && saveCardForBalance) {
      if (!selectedCardId) {
        toast("Select or add a card for future charges", "error");
        return;
      }
      // Get selected card details
      const card = savedCards.find(c => c.stripe_payment_method_id === selectedCardId);
      if (card) {
        storedCard = {
          stripe_payment_method_id: card.stripe_payment_method_id,
          last4: card.last4,
        };
      }
    }

    onComplete({
      isRush,
      needByDate,
      fulfillment,
      shipTo: fulfillment === "ship" ? shipTo : null,
      storeCardForBalance: storedCard,
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
                    ? "border-red-500/50 bg-red-500/15 text-red-600"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <Flame size={18} className={isRush ? "animate-pulse" : ""} />
                Rush Order
              </button>
              
              <button
                type="button"
                onClick={() => {
                  const date = prompt("Due date (YYYY-MM-DD):", needByDate || "");
                  if (date !== null) setNeedByDate(date || null);
                }}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition-colors ${
                  needByDate
                    ? "border-amber-500/50 bg-amber-500/15 text-amber-600"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <Calendar size={18} />
                {needByDate || "Set Due Date"}
              </button>
            </div>
          </div>

          {/* Fulfillment Toggle */}
          <div className="mt-6 space-y-4">
            <h3 className="text-xs font-black uppercase tracking-wider text-app-text-muted">Fulfillment</h3>
            
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setFulfillment("pickup")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition-colors ${
                  fulfillment === "pickup"
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-600"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <MapPin size={18} />
                Pickup
              </button>
              
              <button
                type="button"
                onClick={() => setFulfillment("ship")}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl border py-3 text-sm font-bold transition-colors ${
                  fulfillment === "ship"
                    ? "border-blue-500/50 bg-blue-500/15 text-blue-600"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-border"
                }`}
              >
                <Truck size={18} />
                Ship
              </button>
            </div>

            {/* Shipping Address Form */}
            {fulfillment === "ship" && (
              <div className="mt-4 rounded-xl border border-app-border bg-app-surface-2 p-4 space-y-3">
                <h4 className="text-xs font-black uppercase tracking-wider text-app-text-muted">Shipping Address</h4>
                
                <input
                  type="text"
                  placeholder="Full Name"
                  className="ui-input w-full"
                  value={shipTo?.name || ""}
                  onChange={(e) => setShipTo(prev => prev ? { ...prev, name: e.target.value } : { name: e.target.value, street1: "", city: "", state: "", zip: "", country: "US" })}
                />
                <input
                  type="text"
                  placeholder="Street Address"
                  className="ui-input w-full"
                  value={shipTo?.street1 || ""}
                  onChange={(e) => setShipTo(prev => prev ? { ...prev, street1: e.target.value } : { name: "", street1: e.target.value, city: "", state: "", zip: "", country: "US" })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    placeholder="City"
                    className="ui-input"
                    value={shipTo?.city || ""}
                    onChange={(e) => setShipTo(prev => prev ? { ...prev, city: e.target.value } : { name: "", street1: "", city: e.target.value, state: "", zip: "", country: "US" })}
                  />
                  <input
                    type="text"
                    placeholder="State"
                    className="ui-input"
                    value={shipTo?.state || ""}
                    onChange={(e) => setShipTo(prev => prev ? { ...prev, state: e.target.value } : { name: "", street1: "", city: "", state: e.target.value, zip: "", country: "US" })}
                  />
                </div>
                <input
                  type="text"
                  placeholder="ZIP Code"
                  className="ui-input w-full"
                  value={shipTo?.zip || ""}
                  onChange={(e) => setShipTo(prev => prev ? { ...prev, zip: e.target.value } : { name: "", street1: "", city: "", state: "", zip: e.target.value, country: "US" })}
                />
              </div>
            )}

            {/* Save Card Option for Shipped Orders */}
            {fulfillment === "ship" && savedCards.length > 0 && (
              <div className="mt-4 space-y-3">
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-4">
                  <input
                    type="checkbox"
                    checked={saveCardForBalance}
                    onChange={(e) => setSaveCardForBalance(e.target.checked)}
                    className="h-5 w-5 rounded border-app-border accent-emerald-500"
                  />
                  <div className="flex-1">
                    <p className="text-sm font-bold text-app-text">Save card for balance + shipping</p>
                    <p className="text-xs text-app-text-muted">We'll charge the remaining balance when ready to ship</p>
                  </div>
                  <CreditCard size={20} className="text-app-text-muted" />
                </label>

                {saveCardForBalance && (
                  <div className="space-y-2 pl-2">
                    {savedCards.map((card) => (
                      <button
                        key={card.stripe_payment_method_id}
                        type="button"
                        onClick={() => setSelectedCardId(card.stripe_payment_method_id)}
                        className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                          selectedCardId === card.stripe_payment_method_id
                            ? "border-emerald-500 bg-emerald-500/10"
                            : "border-app-border bg-app-surface hover:border-app-border/80"
                        }`}
                      >
                        <div className="flex h-8 w-12 items-center justify-center rounded bg-app-surface-2">
                          <CreditCard size={16} className="text-app-text-muted" />
                        </div>
                        <div className="flex-1">
                          <p className="text-sm font-bold text-app-text">{card.brand}</p>
                          <p className="text-xs text-app-text-muted">•••• {card.last4}</p>
                        </div>
                        {selectedCardId === card.stripe_payment_method_id && (
                          <Check size={18} className="text-emerald-500" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
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
