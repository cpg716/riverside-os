import { useEffect, useRef, useState } from "react";
import { Gift, X } from "lucide-react";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProvider";

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

export interface LoyaltyEligibleCustomer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  loyalty_points: number;
}

export function loyaltyEligibleDisplayName(c: LoyaltyEligibleCustomer): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export interface LoyaltyRedeemDialogProps {
  isOpen: boolean;
  customer: LoyaltyEligibleCustomer | null;
  rewardAmountRaw: string | number;
  pointThreshold: number;
  /** Staff BO headers or `mergedPosStaffHeaders(backofficeHeaders)` at register */
  getAuthHeaders: () => HeadersInit;
  /** Open register session when redeeming from POS (optional `session_id` on API body) */
  registerSessionId?: string | null;
  onClose: () => void;
  onSuccess: () => void;
}

export function LoyaltyRedeemDialog({
  isOpen,
  customer,
  rewardAmountRaw,
  pointThreshold,
  getAuthHeaders,
  registerSessionId = null,
  onClose,
  onSuccess,
}: LoyaltyRedeemDialogProps) {
  const { toast } = useToast();
  const rewardCents = parseMoneyToCents(rewardAmountRaw);
  const rewardDollars = parseMoney(rewardAmountRaw);
  const [applyAmount, setApplyAmount] = useState("0.00");
  const [cardCode, setCardCode] = useState("");
  const [notifySms, setNotifySms] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardInputRef = useRef<HTMLInputElement>(null);

  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: !busy,
    initialFocusRef: cardInputRef,
  });

  useEffect(() => {
    if (!isOpen || !customer) return;
    setApplyAmount(centsToFixed2(0));
    setCardCode("");
    setNotifySms(false);
    setNotifyEmail(false);
    setError(null);
  }, [isOpen, customer]);

  if (!isOpen || !customer) return null;

  const appliedCents = Math.min(
    Math.max(0, parseMoneyToCents(applyAmount)),
    rewardCents,
  );
  const remainderCents = rewardCents - appliedCents;
  const needsCard = remainderCents > 0;

  const submit = async () => {
    setError(null);
    if (needsCard && !cardCode.trim()) {
      setError(
        `Enter or scan a gift card code to load $${centsToFixed2(remainderCents)}.`,
      );
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/api/loyalty/redeem-reward`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          customer_id: customer.id,
          apply_to_sale: centsToFixed2(appliedCents),
          ...(needsCard ? { remainder_card_code: cardCode.trim() } : {}),
          notify_customer_sms: notifySms,
          notify_customer_email: notifyEmail,
          ...(registerSessionId ? { session_id: registerSessionId } : {}),
        }),
      });
      const data = (await res.json()) as { error?: string; new_balance?: number };
      if (!res.ok) {
        throw new Error(data.error ?? "Redemption failed");
      }
      toast(
        `Reward redeemed for ${loyaltyEligibleDisplayName(customer)}. New balance: ${data.new_balance?.toLocaleString() ?? "—"} pts.`,
        "success",
      );
      onSuccess();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Redemption failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-md rounded-2xl bg-app-surface shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="absolute right-4 top-4 text-app-text-muted hover:text-app-text disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="p-6">
          <div className="mb-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100">
              <Gift className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p id={titleId} className="text-sm font-black uppercase tracking-wide text-app-text">
                Redeem loyalty reward
              </p>
              <p className="text-xs text-app-text-muted">{loyaltyEligibleDisplayName(customer)}</p>
            </div>
          </div>

          <div className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm">
            <p className="font-semibold text-amber-900">
              {customer.loyalty_points.toLocaleString()} pts · deducts{" "}
              {pointThreshold.toLocaleString()} pts · ${centsToFixed2(rewardCents)} value
            </p>
            <p className="mt-1 text-xs text-amber-700">
              Apply part of the value to a sale (e.g. at register), or leave $0 to load the full
              reward onto a gift card.
            </p>
          </div>

          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-app-text-muted">
              Apply to sale ($)
            </span>
            <input
              type="number"
              min="0"
              max={rewardDollars}
              step="0.01"
              value={applyAmount}
              onChange={(e) => setApplyAmount(e.target.value)}
              className="ui-input w-full"
            />
          </label>

          <div className="mb-3 space-y-2 rounded-xl border border-app-border/60 bg-app-surface-2/50 px-3 py-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Notify customer (Podium)
            </p>
            <label className="flex items-center gap-2 text-xs font-semibold text-app-text">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-app-border"
                checked={notifySms}
                onChange={(e) => setNotifySms(e.target.checked)}
              />
              Send SMS
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold text-app-text">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-app-border"
                checked={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.checked)}
              />
              Send email
            </label>
            <p className="text-[10px] text-app-text-muted leading-snug">
              Sends only if Podium is enabled and the customer has opted in to operational SMS or
              email.
            </p>
          </div>

          {needsCard && (
            <label className="mb-3 block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-app-text-muted">
                Gift card for remainder (${centsToFixed2(remainderCents)})
              </span>
              <input
                ref={cardInputRef}
                type="text"
                placeholder="Scan or enter card code…"
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value)}
                className="ui-input w-full font-mono text-sm"
              />
            </label>
          )}

          {error && (
            <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn-secondary flex-1"
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="ui-btn-primary flex-1 border-b-8 border-emerald-800 bg-emerald-600"
            >
              {busy ? "Processing…" : appliedCents > 0 ? "Redeem" : "Load to card"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
