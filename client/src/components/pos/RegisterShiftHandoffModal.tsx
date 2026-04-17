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
  const [roster, setRoster] = useState<{ id: string; full_name: string }[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          setRoster(data);
        }
      } catch (e) {
        console.error("Roster load failed", e);
      }
    })();
  }, [isOpen]);

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
      toast("Enter your 4-digit PIN.", "error");
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
        className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none rounded-[32px] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-app-border px-8 py-6 bg-app-surface-2">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent shadow-sm">
              <UserRoundCog size={24} aria-hidden />
            </div>
            <div>
              <h2 id={titleId} className="text-xl font-black tracking-tight text-app-text">
                Shift handoff
              </h2>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mt-0.5">
                Transfer register control
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-surface border border-app-border text-app-text-muted hover:text-app-text hover:border-app-accent transition-all active:scale-90"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-8 px-8 py-8">
          <p className="text-sm leading-relaxed text-app-text-muted text-center font-medium">
            Identify the staff member taking over this register and enter their PIN.
          </p>
          
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                New Primary Staff
              </label>
              <select
                className="ui-input w-full text-center font-bold"
                value={localStorage.getItem("ros_last_staff_id") || ""}
                onChange={(e) => localStorage.setItem("ros_last_staff_id", e.target.value)}
              >
                <option value="">-- Choose Name --</option>
                {roster.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-4 text-center">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Enter PIN
              </p>
              <PinDots length={credential.length} maxDigits={4} />
              <NumericPinKeypad
                value={credential}
                onChange={setCredential}
                onEnter={() => void submit()}
                disabled={busy}
                maxDigits={4}
              />
            </div>
          </div>

          <div className="flex gap-4 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="ui-btn-secondary h-14 flex-1 text-xs font-black uppercase tracking-widest rounded-2xl"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || credential.trim().length !== 4}
              className="ui-btn-primary h-14 flex-[2] text-xs font-black uppercase tracking-widest rounded-2xl shadow-glow-accent-sm"
            >
              {busy ? "Updating…" : "Confirm handoff"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
