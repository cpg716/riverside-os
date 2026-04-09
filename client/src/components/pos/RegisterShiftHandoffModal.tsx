import { useEffect, useState } from "react";
import { UserRoundCog, X } from "lucide-react";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface RegisterShiftHandoffModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessionId: string;
  onHandoffComplete: () => Promise<void>;
  /** Align Back Office staff headers with the new shift primary (4-digit code). */
  onAdoptShiftCredentials?: (cashierCode: string) => void;
}

export default function RegisterShiftHandoffModal({
  isOpen,
  onClose,
  sessionId,
  onHandoffComplete,
  onAdoptShiftCredentials,
}: RegisterShiftHandoffModalProps) {
  useShellBackdropLayer(isOpen);
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  useEffect(() => {
    if (!isOpen) return;
    setCredential("");
    setBusy(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = async () => {
    const code = credential.trim();
    if (code.length !== 4) {
      toast("Enter the new shift primary 4-digit staff code.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/shift-primary`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify({ cashier_code: code, pin: code }),
        },
      );
      const errData = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(errData.error ?? `Handoff failed (${res.status})`);
      }
      onAdoptShiftCredentials?.(code);
      await onHandoffComplete();
      toast("Shift primary updated.", "success");
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Handoff failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-overlay-backdrop flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-app-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
              <UserRoundCog size={20} aria-hidden />
            </div>
            <div>
              <h2 id={titleId} className="text-lg font-black tracking-tight text-app-text">
                Shift handoff
              </h2>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-app-text-muted">
                New primary on register (drawer stays open)
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ui-touch-target rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text-muted hover:text-app-text"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <p className="text-sm text-app-text-muted">
            Enter the 4-digit code of the staff member who is taking the register. They must use
            the same code as their PIN when a PIN is set.
          </p>
          <div className="flex flex-col items-center gap-3">
            <PinDots length={credential.length} maxDigits={4} />
            <NumericPinKeypad
              value={credential}
              onChange={setCredential}
              disabled={busy}
              maxDigits={4}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="ui-btn-secondary min-h-11 px-4"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || credential.trim().length !== 4}
              className="ui-btn-primary min-h-11 px-4"
            >
              {busy ? "Updating…" : "Confirm handoff"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
