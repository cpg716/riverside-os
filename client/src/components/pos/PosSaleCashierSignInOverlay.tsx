import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useState } from "react";
import { Shield, X } from "lucide-react";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffMiniSelector from "../ui/StaffMiniSelector";

const baseUrl = getBaseUrl();

/**
 * Full-screen gate for “cashier for this sale” — same visual language as
 * {@link ../layout/BackofficeSignInGate.tsx} (card + PIN keypad), separate from cart chrome.
 */
export default function PosSaleCashierSignInOverlay({
  open,
  credential,
  onCredentialChange,
  error,
  busy,
  onVerify,
  onCancel,
}: {
  open: boolean;
  credential: string;
  onCredentialChange: (v: string) => void;
  error: string | null;
  busy: boolean;
  onVerify: () => void;
  onCancel?: () => void;
}) {
  const [roster, setRoster] = useState<{ id: string; full_name: string }[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState<string>(() => {
    return localStorage.getItem("ros_last_staff_id") || "";
  });

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          setRoster(data);
        }
      } catch (e) {
        console.error("Could not load roster", e);
      }
    })();
  }, [open]);

  const handleStaffChange = (id: string) => {
    setSelectedStaffId(id);
    localStorage.setItem("ros_last_staff_id", id);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex min-h-[100dvh] flex-col items-center justify-center bg-app-bg p-4 font-sans antialiased sm:p-6"
      style={{
        paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        paddingTop: "max(1rem, env(safe-area-inset-top))",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-sale-cashier-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-[32px] border border-app-border/40 bg-app-surface shadow-2xl">
        <div className="relative border-b border-app-border bg-app-surface-2 px-8 py-6 text-center">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="absolute right-4 top-4 rounded-full border border-app-border/60 p-2 text-app-text-muted hover:bg-app-surface"
              aria-label="Cancel"
            >
              <X size={18} />
            </button>
          )}
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-surface))] text-[var(--app-accent)]">
            <Shield className="h-6 w-6" aria-hidden />
          </div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Riverside OS · POS
          </p>
          <h1
            id="pos-sale-cashier-title"
            className="mt-1 text-xl font-black tracking-tight text-app-text"
          >
            Sign-in for this sale
          </h1>
        </div>
        <div className="space-y-6 px-8 py-8">
          {error ? (
            <p className="rounded-2xl border border-app-danger/20 bg-app-danger/5 px-4 py-3 text-center text-xs font-bold text-app-danger">
              {error}
            </p>
          ) : null}

          <div className="space-y-3">
            <p className="text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Select Your Name
            </p>
            <div className="w-full">
              <StaffMiniSelector
                staff={roster.map((s) => ({ id: s.id, full_name: s.full_name }))}
                selectedId={selectedStaffId}
                onSelect={handleStaffChange}
                placeholder="Select staff member..."
                size="lg"
                showAvatar={true}
                className="w-full"
              />
            </div>
            {!selectedStaffId && (
              <p className="text-center text-[10px] font-bold text-amber-600">
                Please select a staff member first
              </p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              PIN
            </p>
            <PinDots length={credential.length} className="py-0.5" />
            <NumericPinKeypad
              value={credential}
              onChange={(v) => {
                onCredentialChange(v);
              }}
              onEnter={onVerify}
              disabled={busy}
            />
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                onCredentialChange("");
              }}
              className="ui-btn-secondary h-14 flex-1 text-sm font-black"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={busy || credential.length !== 4}
              onClick={() => onVerify()}
              className="ui-btn-primary h-14 flex-[2] text-sm font-black disabled:opacity-50"
            >
              {busy ? "…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
