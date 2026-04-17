import { Loader2 } from "lucide-react";
import { centsToFixed2 } from "../../../lib/money";
import { type Customer } from "../CustomerSelector";

interface CartCheckoutButtonProps {
  collectTotalCents: number;
  onCheckoutClick: () => void;
  checkoutBusy: boolean;
  disabled: boolean;
  selectedCustomer: Customer | null;
}

export const CartCheckoutButton: React.FC<CartCheckoutButtonProps> = ({
  collectTotalCents,
  onCheckoutClick,
  checkoutBusy,
  disabled,
  selectedCustomer,
}) => {
  const hasItems = !disabled && collectTotalCents >= 0;

  return (
    <div className="shrink-0">
      <button
        type="button"
        data-testid="pos-checkout-button"
        disabled={disabled}
        onClick={onCheckoutClick}
        className={`ui-touch-target group relative flex h-[4rem] w-full items-center justify-between overflow-hidden rounded-2xl border-b-[5px] transition-all active:translate-y-0.5 active:scale-[0.98] shadow-2xl ${
          hasItems
            ? "bg-emerald-600 border-emerald-800 text-white hover:bg-emerald-500 shadow-emerald-500/30"
            : "bg-app-surface-2 border-app-border text-app-text-muted cursor-not-allowed opacity-50"
        }`}
      >
        <div className="flex-1 space-y-0.5 px-4 text-left">
          <div className="text-[10px] font-black uppercase tracking-widest opacity-80">
            {selectedCustomer
              ? `${selectedCustomer.first_name} ${selectedCustomer.last_name}`
              : "Retail Walk-in"}
          </div>
          <div className="text-[1.35rem] font-black italic tracking-tight">
            ${centsToFixed2(collectTotalCents)} <span className="text-xs uppercase not-italic opacity-70 ml-1">Due</span>
          </div>
        </div>

        <div className="flex h-full w-20 items-center justify-center border-l border-white/20 bg-black/5">
          <div
            className={`flex size-11 items-center justify-center rounded-full ring-2 transition-transform group-hover:scale-110 ${
              hasItems ? "bg-white/10 ring-white/30" : "bg-black/5 ring-black/10"
            }`}
          >
            {checkoutBusy ? (
              <Loader2 className="animate-spin" size={20} />
            ) : (
              <span className="font-black italic tracking-tighter text-sm uppercase">PAY</span>
            )}
          </div>
        </div>

        {hasItems && (
          <div className="absolute inset-0 bg-gradient-to-tr from-white/10 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </div>
  );
};
