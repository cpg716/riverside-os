import { Shield } from "lucide-react";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";

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
}: {
  open: boolean;
  credential: string;
  onCredentialChange: (v: string) => void;
  error: string | null;
  busy: boolean;
  onVerify: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[120] flex min-h-[100dvh] flex-col items-center justify-center bg-app-bg p-4 font-sans antialiased sm:p-6"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
        paddingTop: "max(1.5rem, env(safe-area-inset-top))",
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="pos-sale-cashier-title"
    >
      <div className="w-full max-w-md overflow-hidden rounded-[32px] border border-app-border/40 bg-app-surface shadow-2xl">
        <div className="border-b border-app-border bg-app-surface-2 px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-surface))] text-[var(--app-accent)]">
            <Shield className="h-8 w-8" aria-hidden />
          </div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Riverside OS · POS
          </p>
          <h1
            id="pos-sale-cashier-title"
            className="mt-2 text-2xl font-black tracking-tight text-app-text"
          >
            Cashier for this sale
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-app-text-muted">
            Enter your 4-digit staff code (same as Back Office). You will not be
            able to scan, search, or complete payment until you verify.
          </p>
        </div>
        <div className="space-y-5 px-8 py-8">
          {error ? (
            <p className="rounded-2xl border border-app-danger/20 bg-app-danger/5 px-4 py-3 text-center text-xs font-bold text-app-danger">
              {error}
            </p>
          ) : null}
          <div className="space-y-2">
            <p className="text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Staff code
            </p>
            <PinDots length={credential.length} className="py-1" />
            <NumericPinKeypad
              value={credential}
              onChange={(v) => {
                onCredentialChange(v);
              }}
              disabled={busy}
            />
          </div>
          <button
            type="button"
            disabled={busy || credential.length !== 4}
            onClick={() => onVerify()}
            className="ui-btn-primary h-14 w-full text-sm font-black disabled:opacity-50"
          >
            {busy ? "Verifying…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
