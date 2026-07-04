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
  externalRefundReference: string;
  setExternalRefundReference: (v: string) => void;
  managerReason: string;
  setManagerReason: (v: string) => void;
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
  externalRefundReference,
  setExternalRefundReference,
  managerReason,
  setManagerReason,
}: PosRefundModalProps) {
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: true,
  });

  if (!isOpen) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;
  const manualHelcimRefund = method === "card_terminal_manual";

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none shadow-2xl"
      >
        <div className="ui-modal-header">
          <h3 id={titleId} className="text-lg font-black text-app-text">
            Process refund
          </h3>
          <p className="ui-type-instruction-muted mt-1 text-xs">
            A register session must be open. Helcim backend refunds record a refund already
            processed in Helcim and require Manager Access.
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
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="ui-input mt-1 w-full text-sm"
            >
              <option value="card_present">Card refund</option>
              <option value="card_terminal_manual">Helcim backend refund</option>
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="store_credit">Store credit</option>
              <option value="gift_card">Gift card</option>
            </select>
          </label>
          {manualHelcimRefund && (
            <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <label className="block text-xs font-bold text-app-text-muted">
                Helcim refund reference
                <input
                  type="text"
                  value={externalRefundReference}
                  onChange={(e) => setExternalRefundReference(e.target.value)}
                  className="ui-input mt-1 w-full text-sm font-mono"
                  placeholder="Helcim refund transaction/reference"
                />
              </label>
              <label className="block text-xs font-bold text-app-text-muted">
                Manager reason
                <textarea
                  value={managerReason}
                  onChange={(e) => setManagerReason(e.target.value)}
                  className="ui-input mt-1 min-h-20 w-full text-sm"
                  placeholder="Refund processed in Helcim backend"
                />
              </label>
            </div>
          )}
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
