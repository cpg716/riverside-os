import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquareReply, X } from "lucide-react";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";

export default function PodiumResponderPinModal({
  isOpen,
  staffName,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  staffName: string;
  onClose: () => void;
  onConfirm: (pin: string) => Promise<void>;
}) {
  useShellBackdropLayer(isOpen);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSubmitKeyRef = useRef<string | null>(null);
  const submitRef = useRef<() => void>(() => undefined);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  useEffect(() => {
    if (!isOpen) return;
    setPin("");
    setError(null);
    setBusy(false);
    autoSubmitKeyRef.current = null;
  }, [isOpen, staffName]);

  const submit = async () => {
    const credential = pin.trim();
    if (credential.length !== 4) {
      setError("Enter the selected staff member's 4-digit Access PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onConfirm(credential);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Access PIN could not be verified.");
      setPin("");
      autoSubmitKeyRef.current = null;
    } finally {
      setBusy(false);
    }
  };
  submitRef.current = () => {
    void submit();
  };

  useEffect(() => {
    const credential = pin.trim();
    if (credential.length !== 4) {
      autoSubmitKeyRef.current = null;
      return;
    }
    if (!isOpen || busy) return;
    const key = `${staffName}:${credential}`;
    if (autoSubmitKeyRef.current === key) return;
    autoSubmitKeyRef.current = key;
    submitRef.current();
  }, [busy, isOpen, pin, staffName]);

  if (!isOpen) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-none overflow-hidden rounded-t-3xl outline-none sm:max-w-md sm:rounded-[32px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-app-border bg-app-surface-2 px-7 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent">
              <MessageSquareReply size={22} aria-hidden />
            </div>
            <div>
              <h2 id={titleId} className="text-lg font-black tracking-tight text-app-text">
                Reply as {staffName}
              </h2>
              <p className="mt-0.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Remember for this conversation
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-app-border bg-app-surface text-app-text-muted hover:text-app-text disabled:opacity-50"
            aria-label="Cancel responder change"
          >
            <X size={19} aria-hidden />
          </button>
        </div>

        <div className="space-y-5 px-7 py-6">
          <p className="text-center text-sm font-semibold leading-relaxed text-app-text-muted">
            {staffName} enters their Access PIN once. Future replies in this conversation keep their name until someone changes it.
          </p>
          <PinDots length={pin.length} maxDigits={4} />
          <NumericPinKeypad
            value={pin}
            onChange={setPin}
            onEnter={() => submitRef.current()}
            disabled={busy}
            maxDigits={4}
            compact
          />
          {error ? (
            <p role="alert" className="text-center text-sm font-bold text-red-500">
              {error}
            </p>
          ) : null}
          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="ui-btn-secondary h-12 flex-1 rounded-2xl text-xs font-black uppercase tracking-widest"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || pin.trim().length !== 4}
              className="ui-btn-primary h-12 flex-[1.5] rounded-2xl text-xs font-black uppercase tracking-widest disabled:opacity-50"
            >
              {busy ? "Verifying…" : "Use this name"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    root,
  );
}
