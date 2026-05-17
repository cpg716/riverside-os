import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldCheck } from "lucide-react";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import ManagerApprovalModal from "./ManagerApprovalModal";

export interface PosVoidTransactionTarget {
  transactionId: string;
  receiptLabel: string;
  customerLabel: string;
  amountLabel: string;
  paymentSummary?: string | null;
  fulfillmentLabel?: string | null;
}

interface PosVoidTransactionModalProps {
  open: boolean;
  target: PosVoidTransactionTarget | null;
  busy: boolean;
  onClose: () => void;
  onVoid: (args: {
    managerStaffId: string;
    managerPin: string;
    reason: string;
  }) => Promise<boolean>;
}

export default function PosVoidTransactionModal({
  open,
  target,
  busy,
  onClose,
  onVoid,
}: PosVoidTransactionModalProps) {
  const [reason, setReason] = useState("");
  const [managerOpen, setManagerOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useShellBackdropLayer(open || managerOpen);

  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !busy && !managerOpen,
  });

  const trimmedReason = reason.trim();
  const impactLines = useMemo(
    () => [
      "The original Transaction Record, receipt, tenders, timestamps, and staff history stay visible.",
      "Eligible takeaway items are returned to stock. Order-style items stay in their audit trail.",
      "The refund queue opens for the paid balance. Card refunds still use the original provider record.",
      "QBO and register close stay traceable through the void record and refund payment rows.",
    ],
    [],
  );

  if (!open || !target) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <>
      <div className="ui-overlay-backdrop !z-[200]" onClick={busy ? undefined : onClose}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal w-full max-w-2xl animate-in zoom-in-95 overflow-hidden outline-none shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="ui-modal-header">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-app-danger/20 bg-app-danger/10 text-app-danger">
                <AlertTriangle size={22} aria-hidden />
              </div>
              <div>
                <h3 id={titleId} className="text-lg font-black text-app-text">
                  Void Transaction
                </h3>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                  Use this only when the completed sale must be reversed. This does not delete the sale.
                </p>
              </div>
            </div>
          </div>

          <div className="ui-modal-body space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="ui-metric-cell ui-tint-neutral px-3 py-3">
                <p className="text-xs font-bold text-app-text-muted">Receipt</p>
                <p className="mt-1 font-mono text-sm font-black text-app-text">{target.receiptLabel}</p>
              </div>
              <div className="ui-metric-cell ui-tint-neutral px-3 py-3">
                <p className="text-xs font-bold text-app-text-muted">Customer</p>
                <p className="mt-1 text-sm font-black text-app-text">{target.customerLabel}</p>
              </div>
              <div className="ui-metric-cell ui-tint-danger px-3 py-3">
                <p className="text-xs font-bold text-app-danger">Paid balance</p>
                <p className="mt-1 text-sm font-black text-app-text">{target.amountLabel}</p>
              </div>
            </div>

            <div className="rounded-xl border border-app-warning/25 bg-app-warning/10 px-4 py-3">
              <div className="flex items-start gap-2">
                <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-app-warning" aria-hidden />
                <div className="space-y-1.5">
                  <p className="text-xs font-black uppercase text-app-text">What will happen</p>
                  {impactLines.map((line) => (
                    <p key={line} className="flex gap-2 text-xs font-semibold leading-relaxed text-app-text-muted">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-success" aria-hidden />
                      <span>{line}</span>
                    </p>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
                <p className="text-xs font-bold text-app-text-muted">Tender reversal</p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  {target.paymentSummary || "Tender details will be read from the Transaction Record."}
                </p>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
                <p className="text-xs font-bold text-app-text-muted">Inventory handling</p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  {target.fulfillmentLabel || "Line fulfillment decides restock handling."}
                </p>
              </div>
            </div>

            <label className="block text-xs font-bold text-app-text-muted">
              Reason for void
              <textarea
                value={reason}
                onChange={(event) => {
                  setLocalError(null);
                  setReason(event.target.value);
                }}
                className="ui-input mt-1 min-h-24 w-full resize-y text-sm"
                placeholder="Example: Customer changed mind before leaving store; manager approved full reversal."
              />
            </label>

            {localError ? (
              <div className="rounded-xl border border-app-danger/25 bg-app-danger/10 px-4 py-3 text-xs font-bold text-app-danger">
                {localError}
              </div>
            ) : null}
          </div>

          <div className="ui-modal-footer flex flex-col-reverse gap-3 sm:flex-row">
            <button
              type="button"
              className="ui-btn-secondary flex-1 py-3 text-sm"
              disabled={busy}
              onClick={onClose}
            >
              Keep Transaction
            </button>
            <button
              type="button"
              className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-app-danger/35 bg-app-danger/10 px-4 py-3 text-sm font-black text-app-danger transition hover:bg-app-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                if (trimmedReason.length < 3) {
                  setLocalError("Enter the reason before requesting Manager Access.");
                  return;
                }
                setManagerOpen(true);
              }}
            >
              <ShieldCheck size={16} aria-hidden />
              Continue to Manager Access
            </button>
          </div>
        </div>
      </div>

      <ManagerApprovalModal
        isOpen={managerOpen}
        onClose={() => setManagerOpen(false)}
        title="Authorize Transaction Void"
        message="Manager Access is required because this will mark the completed sale voided, open the reversal workflow, and write a permanent audit record."
        onApprove={async (pin, managerId) => {
          const ok = await onVoid({
            managerStaffId: managerId,
            managerPin: pin,
            reason: trimmedReason,
          });
          if (ok) {
            setManagerOpen(false);
            setReason("");
          }
          return ok;
        }}
      />
    </>,
    root,
  );
}
