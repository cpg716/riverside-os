import { createPortal } from "react-dom";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

interface PosRefundModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  amount: string;
  setAmount: (v: string) => void;
  method: string;
  setMethod: (v: string) => void;
  giftCode: string;
  setGiftCode: (v: string) => void;
}

export default function PosRefundModal({
  isOpen,
  onClose,
  onSubmit,
  busy,
  amount,
  setAmount,
  method,
  setMethod,
  giftCode,
  setGiftCode,
}: PosRefundModalProps) {
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: true,
  });

  if (!isOpen) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ui-modal-header">
          <h3 id={titleId} className="text-lg font-black text-app-text">
            Process refund
          </h3>
          <p className="ui-type-instruction-muted mt-1 text-xs">
            A register session must be open. Card methods trigger Stripe when a payment intent exists on the
            order. Gift card refunds require the card code.
          </p>
        </div>
        <div className="ui-modal-body space-y-4">
          <label className="block text-xs font-bold text-app-text-muted">
            Amount (USD)
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
              autoFocus
            />
          </label>
          <label className="block text-xs font-bold text-app-text-muted">
            Payment method
            <input
              type="text"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
              placeholder="cash, card_present, gift_card, …"
            />
          </label>
          {method.toLowerCase().includes("gift") && (
            <label className="block text-xs font-bold text-app-text-muted animate-in slide-in-from-top-2">
              Gift card code
              <input
                type="text"
                value={giftCode}
                onChange={(e) => setGiftCode(e.target.value)}
                className="ui-input mt-1 w-full text-sm font-mono"
              />
            </label>
          )}
        </div>
        <div className="ui-modal-footer flex gap-3">
          <button
            type="button"
            className="ui-btn-secondary flex-1 py-3 text-sm"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn-primary flex-1 py-3 text-sm"
            disabled={busy}
            onClick={onSubmit}
          >
            {busy ? "Processing…" : "Submit refund"}
          </button>
        </div>
      </div>
    </div>,
    root
  );
}
