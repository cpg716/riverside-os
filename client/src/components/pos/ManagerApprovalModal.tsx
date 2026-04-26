import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect } from "react";
import { X, ShieldCheck } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

const baseUrl = getBaseUrl();

interface ManagerApprovalModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApprove: (pin: string, managerId: string) => Promise<boolean | void>;
  title: string;
  message: string;
}

export default function ManagerApprovalModal({
  isOpen,
  onClose,
  onApprove,
  title,
  message,
}: ManagerApprovalModalProps) {
  const [pin, setPin] = useState("");
  const [selectedManagerId, setSelectedManagerId] = useState<string>(() => {
    return localStorage.getItem("ros_last_staff_id") || "";
  });
  const [roster, setRoster] = useState<
    { id: string; full_name: string; role?: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { backofficeHeaders } = useBackofficeAuth();
  useShellBackdropLayer(isOpen);

  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  useEffect(() => {
    if (!isOpen) return;
    setPin("");
    setError(null);
    setBusy(false);

    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
          headers: mergedPosStaffHeaders(backofficeHeaders),
        });
        if (res.ok) {
          const data = await res.json();
          setRoster(data.filter((s: { id: string; full_name: string; role?: string }) => s.role === "admin"));
        }
      } catch (e) {
        console.error("Could not load managers for approval", e);
      }
    })();
  }, [isOpen, backofficeHeaders]);

  const handleApprove = async () => {
    if (pin.length !== 4) {
      setError("Enter 4-digit PIN.");
      return;
    }
    if (!selectedManagerId) {
      setError("Select a manager.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const success = await onApprove(pin, selectedManagerId);
      if (success !== false) {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-none animate-in zoom-in-95 overflow-hidden rounded-t-3xl border-4 border-app-border bg-app-bg-alt/95 outline-none backdrop-blur-2xl duration-300 sm:max-w-sm sm:rounded-[32px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b-4 border-app-border px-6 py-5 bg-app-surface">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500 shadow-inner">
              <ShieldCheck size={24} aria-hidden />
            </div>
            <div>
              <h2
                id={titleId}
                className="text-lg font-black tracking-tight text-app-text italic"
              >
                {title}
              </h2>
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mt-0.5">
                Audit Authorization
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-surface border-4 border-app-border text-app-text-muted hover:text-app-text hover:border-amber-500 transition-all active:scale-90"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6 px-6 py-6">
          <p className="text-xs leading-relaxed text-app-text-muted text-center font-medium px-2">
            {message}
          </p>

          <div className="space-y-6">
            <div className="space-y-1.5 text-center">
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Approving Manager
              </label>
              <select
                className="ui-input w-full text-center font-black bg-white/5 border-app-border/40"
                value={selectedManagerId}
                onChange={(e) => {
                  setSelectedManagerId(e.target.value);
                  localStorage.setItem("ros_last_staff_id", e.target.value);
                }}
              >
                <option value="">-- Select Identity --</option>
                {roster.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-3 text-center">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted italic">
                Enter PIN to Authorize
              </p>
              <PinDots length={pin.length} maxDigits={4} />
              <NumericPinKeypad
                value={pin}
                onChange={(v) => {
                  setError(null);
                  setPin(v);
                }}
                onEnter={() => void handleApprove()}
                disabled={busy}
                maxDigits={4}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-xl border-4 border-red-500/20 bg-red-500/5 p-3 text-center text-[10px] font-black uppercase tracking-widest text-red-500 italic animate-in fade-in zoom-in-95">
              {error}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="ui-btn-secondary h-14 flex-1 text-xs font-black uppercase tracking-widest rounded-2xl border-4 border-app-border"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApprove}
              disabled={busy || pin.length !== 4 || !selectedManagerId}
              className="ui-btn-primary h-14 flex-[2] text-xs font-black uppercase tracking-widest rounded-2xl shadow-xl shadow-app-accent/20"
            >
              {busy ? "Signing…" : "Approve"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
