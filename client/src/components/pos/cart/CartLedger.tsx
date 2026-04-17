import React from "react";
import { Package, Truck } from "lucide-react";
import { centsToFixed2 } from "../../../lib/money";
import { type ActiveDiscountEvent } from "../types";

interface CartLedgerProps {
  subtotalCents: number;
  stateTaxCents: number;
  localTaxCents: number;
  shippingCents: number;
  totalPieces: number;
  isRmsPaymentCart: boolean;
  sessionId: string;
  // Functional props
  isGiftCardOnlyCart: boolean;
  activeDiscountEvents: ActiveDiscountEvent[];
  selectedDiscountEventId: string;
  setSelectedDiscountEventId: (id: string) => void;
  applyDiscountEventToSelectedLine: () => void;
  selectedLineKey: string | null;
  managerMode: boolean;
  hasAccess: boolean;
  linesLength: number;
  clearCart: () => void;
  setCheckoutOperator: (v: import("../types").CheckoutOperatorContext | null) => void;
  setSalePinCredential: (v: string) => void;
  setSalePinError: (v: string | null) => void;
  setShowVoidAllConfirm: (v: boolean) => void;
  toast: (msg: string, type?: "success" | "error") => void;
  posShipping: { label: string; amount_cents: number } | null;
  setShippingModalOpen: (v: boolean) => void;
  setPosShipping: (v: import("../types").PosShippingSelection | null) => void;
}

export const CartLedger: React.FC<CartLedgerProps> = ({
  subtotalCents,
  stateTaxCents,
  localTaxCents,
  totalPieces,
  isRmsPaymentCart,
  sessionId,
  isGiftCardOnlyCart,
  activeDiscountEvents,
  selectedDiscountEventId,
  setSelectedDiscountEventId,
  applyDiscountEventToSelectedLine,
  selectedLineKey,
  managerMode,
  hasAccess,
  linesLength,
  clearCart,
  setCheckoutOperator,
  setSalePinCredential,
  setSalePinError,
  setShowVoidAllConfirm,
  toast,
  posShipping,
  setShippingModalOpen,
  setPosShipping,
}) => {
  return (
    <div className="rounded-2xl border border-app-border/50 bg-app-surface/80 px-3 py-1.5 shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
      <div className="mb-1 flex items-center justify-between gap-2 border-b border-app-border/40 pb-1">
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
          {managerMode && linesLength > 0 ? (
            <button
              type="button"
              onClick={() => {
                if (hasAccess) {
                  clearCart();
                  setCheckoutOperator(null);
                  setSalePinCredential("");
                  setSalePinError(null);
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

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-app-text-muted">
        <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <span>Subtotal</span>
          <span className="tabular-nums font-bold text-app-text">
            ${centsToFixed2(subtotalCents)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
          <span>Items</span>
          <span className="tabular-nums text-app-text">{totalPieces}</span>
        </div>
        <div className="col-span-2 mt-1 space-y-0.5 border-t border-app-border/30 pt-1">
          <div className="flex items-baseline justify-between gap-2 text-[9px] uppercase tracking-wide opacity-60">
            <span>NYS Tax</span>
            <span className="tabular-nums font-bold text-app-text-muted">
              ${centsToFixed2(stateTaxCents)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-[9px] uppercase tracking-wide opacity-60">
            <span>Local Tax</span>
            <span className="tabular-nums font-bold text-app-text-muted">
              ${centsToFixed2(localTaxCents)}
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-2 text-[9px] font-black uppercase tracking-wide">
            <span className="text-app-text">Total Tax</span>
            <span className="tabular-nums text-app-text">
              ${centsToFixed2(stateTaxCents + localTaxCents)}
            </span>
          </div>
        </div>

        {posShipping ? (
          <div className="col-span-2 flex items-start justify-between gap-2 rounded-lg bg-sky-500/10 px-2 py-1 text-sky-900 dark:text-sky-200">
            <div className="min-w-0 text-[9px] font-black uppercase leading-snug tracking-wide">
              <span className="block normal-case font-bold text-sky-950 dark:text-sky-100">
                {posShipping.label}
              </span>
              <span className="mt-0.5 flex flex-wrap gap-x-2">
                <button
                  type="button"
                  onClick={() => setShippingModalOpen(true)}
                  className="text-[9px] font-bold text-app-accent underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setPosShipping(null)}
                  className="text-[9px] font-bold text-red-600 underline"
                >
                  Clear
                </button>
              </span>
            </div>
            <span className="shrink-0 text-xs font-black tabular-nums">
              ${centsToFixed2(posShipping.amount_cents)}
            </span>
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
  );
};
