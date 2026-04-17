import React from "react";
import {
  Users,
  ArrowLeftRight,
  Clock,
  CreditCard,
  RotateCcw,
  Zap,
  History,
} from "lucide-react";

interface CartToolRowProps {
  activeWeddingMember: any;
  onWeddingClick: () => void;
  onExchangeClick: () => void;
  onLayawayToggle: () => void;
  isLayawayActive: boolean;
  onGiftCardClick: () => void;
  onParkSaleClick: () => void;
  onClearSaleClick: () => void;
  onOptionsClick: () => void;
  onOrdersClick: () => void;
  isCartEmpty: boolean;
  isCustomerSelected: boolean;
}

export const CartToolRow: React.FC<CartToolRowProps> = ({
  activeWeddingMember,
  onWeddingClick,
  onExchangeClick,
  onLayawayToggle,
  isLayawayActive,
  onGiftCardClick,
  onParkSaleClick,
  onClearSaleClick,
  onOptionsClick,
  onOrdersClick,
  isCartEmpty,
  isCustomerSelected,
}) => {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-app-border/50 pt-2">
      <button
        type="button"
        onClick={onWeddingClick}
        className={`flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 px-3 transition-all active:scale-95 ${
          activeWeddingMember
            ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
            : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-accent hover:text-app-accent"
        }`}
      >
        <Users size={16} />
        <span className="text-[10px] font-black uppercase tracking-widest">
          {activeWeddingMember ? "Switch" : "Wedding"}
        </span>
      </button>

      <div className="flex items-center gap-0.5 rounded-xl border-2 border-app-border bg-app-surface-2/80 p-0.5">
        <button
          type="button"
          onClick={onExchangeClick}
          className="flex h-9 items-center justify-center gap-1.5 rounded-lg border-2 border-transparent bg-transparent px-3 text-app-text-muted transition-all hover:border-app-accent/40 hover:bg-app-surface hover:text-app-accent active:scale-95"
        >
          <ArrowLeftRight size={16} />
          <span className="text-[10px] font-black uppercase tracking-widest">
            Exchange
          </span>
        </button>
        <button
          type="button"
          onClick={onLayawayToggle}
          className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border-2 px-3 transition-all active:scale-95 ${
            isLayawayActive
              ? "border-amber-500 bg-amber-50 text-amber-600"
              : "border-transparent bg-transparent text-app-text-muted hover:border-amber-500/40 hover:bg-app-surface hover:text-amber-700"
          }`}
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
        onClick={onGiftCardClick}
        title="Enter load amount, then scan or type the card code"
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-600/40 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-all hover:bg-emerald-600 hover:text-white"
      >
        <CreditCard size={16} className="shrink-0" aria-hidden />
        Gift Card
      </button>

      <button
        type="button"
        disabled={isCartEmpty}
        onClick={onParkSaleClick}
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-app-accent/40 bg-app-accent/5 px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-all hover:bg-app-accent hover:text-white disabled:opacity-20"
      >
        <Clock size={16} />
        Park Sale
      </button>

      <button
        type="button"
        disabled={isCartEmpty && !isCustomerSelected}
        onClick={onClearSaleClick}
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-red-500 bg-red-50 px-3 text-[10px] font-black uppercase tracking-widest text-red-600 transition-all hover:bg-red-500 hover:text-white disabled:opacity-20"
      >
        <RotateCcw size={16} />
        Clear Sale
      </button>

      <button
        type="button"
        disabled={isCartEmpty}
        onClick={onOptionsClick}
        title="Set Rush, Fulfillment, or Shipping details"
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-emerald-600/40 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-all hover:bg-emerald-600 hover:text-white disabled:opacity-20"
      >
        <Zap size={16} className="shrink-0" aria-hidden />
        Options
      </button>

      <button
        type="button"
        disabled={!isCustomerSelected}
        onClick={onOrdersClick}
        title={
          isCustomerSelected
            ? "View previous orders for this customer"
            : "Select a customer to view orders"
        }
        className="flex h-10 items-center justify-center gap-1.5 rounded-xl border-2 border-indigo-600/40 bg-indigo-50 px-3 text-[10px] font-black uppercase tracking-widest text-indigo-800 transition-all hover:bg-indigo-600 hover:text-white disabled:opacity-20"
      >
        <History size={16} className="shrink-0" aria-hidden />
        Orders
      </button>
    </div>
  );
};
