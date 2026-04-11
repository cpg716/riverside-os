import { useEffect, useRef, useState } from "react";
import { Gift, X, Plus, Award, User, ShoppingCart, CreditCard, Sparkles, TrendingDown, AlertTriangle } from "lucide-react";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";

const BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

import {
  type LoyaltyEligibleCustomer,
  loyaltyEligibleDisplayName,
} from "./LoyaltyLogic";

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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-500">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-lg overflow-hidden rounded-[48px] border border-white/10 bg-app-surface shadow-[0_32px_128px_rgba(0,0,0,0.8)] animate-in zoom-in-95 duration-500 ring-1 ring-white/5"
      >
        {/* Animated Elite Background */}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(var(--app-accent-rgb),0.2),transparent_70%)] opacity-50" />
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/[0.03] to-purple-500/[0.03] pointer-events-none" />
        
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="absolute right-8 top-8 z-20 p-3 rounded-2xl bg-white/5 text-app-text-muted hover:bg-white/10 hover:text-white transition-all disabled:opacity-50 border border-white/5 backdrop-blur-xl"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="relative p-10">
          <div className="mb-10 flex items-center gap-6">
            <div className="relative">
                <div className="flex h-16 w-16 items-center justify-center rounded-[24px] bg-amber-500/10 border border-amber-500/20 text-amber-500 shadow-lg">
                  <Award className="h-8 w-8 animate-pulse" />
                </div>
                <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/40">
                    <Sparkles size={12} className="animate-spin-slow" />
                </div>
            </div>
            <div className="min-w-0">
              <p id={titleId} className="text-2xl font-black uppercase tracking-tight text-app-text">
                Redeem Elite Reward
              </p>
              <div className="flex items-center gap-2 mt-1">
                <User size={12} className="text-app-text-muted opacity-40" />
                <p className="text-xs font-bold text-app-text-muted opacity-60 truncate tracking-tight">
                  {loyaltyEligibleDisplayName(customer)}
                </p>
              </div>
            </div>
          </div>

          {/* Points/Reward Summary - High Impact Glassmorphism */}
          <div className="mb-10 overflow-hidden rounded-[40px] border border-amber-500/40 bg-white/[0.02] p-8 shadow-inner relative group/pool">
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-500/40 to-transparent" />
            
            <div className="flex items-end justify-between relative z-10">
              <div className="space-y-1">
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-amber-600/70">Member Balance</p>
                <div className="flex items-baseline gap-2">
                    <p className="text-5xl font-black tabular-nums text-app-text tracking-tighter">
                      {customer.loyalty_points.toLocaleString()}
                    </p>
                    <span className="text-xs font-black uppercase tracking-widest text-app-text-muted opacity-40 italic">pts</span>
                </div>
              </div>
              <div className="text-right space-y-1">
                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-emerald-600/70">Unlocked Value</p>
                <div className="flex items-baseline justify-end gap-1">
                    <p className="text-5xl font-black tabular-nums text-emerald-500 tracking-tighter">
                      ${centsToFixed2(rewardCents)}
                    </p>
                    <span className="text-xs font-black uppercase tracking-widest text-emerald-600/40 italic">usd</span>
                </div>
              </div>
            </div>
            
            <div className="mt-8 flex items-center gap-3 rounded-2xl bg-amber-500/[0.04] p-4 border border-amber-500/10 transition-all duration-500 group-hover/pool:bg-amber-500/[0.08]">
               <div className="p-2 rounded-xl bg-amber-500/20 text-amber-500">
                   <TrendingDown size={16} strokeWidth={3} />
               </div>
               <p className="text-[11px] font-black uppercase tracking-[0.05em] text-amber-800 leading-tight">
                This transaction will deduct <span className="underline decoration-amber-500/30 underline-offset-4">{pointThreshold.toLocaleString()} pts</span> from their digital vault.
               </p>
            </div>
          </div>

          <div className="space-y-8">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                <label className="block space-y-2 group/input">
                  <div className="flex items-center gap-2 px-1">
                    <ShoppingCart size={12} className="text-app-text-muted opacity-40 group-focus-within/input:text-emerald-500 group-focus-within/input:opacity-100 transition-all" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted group-focus-within/input:text-app-text transition-all">
                        Apply to sale
                    </span>
                  </div>
                  <div className="relative">
                      <input
                        type="number"
                        min="0"
                        max={rewardDollars}
                        step="0.01"
                        value={applyAmount}
                        onChange={(e) => setApplyAmount(e.target.value)}
                        className="ui-input w-full bg-app-surface-2/60 text-center text-3xl font-black tabular-nums tracking-tighter border-2 border-transparent focus:border-emerald-500 ring-offset-app-surface transition-all h-20 rounded-[24px]"
                      />
                      <div className="absolute left-6 top-1/2 -translate-y-1/2 text-app-text-muted opacity-20 text-xl font-black">$</div>
                  </div>
                  <p className="px-1 text-[9px] font-bold text-app-text-muted opacity-60 italic text-center">
                    Enter $0.00 to fully convert to a Gift Card.
                  </p>
                </label>

                {needsCard ? (
                  <label className="block animate-in fade-in slide-in-from-right-4 duration-500 space-y-2 group/card">
                    <div className="flex items-center gap-2 px-1">
                        <CreditCard size={12} className="text-app-text-muted opacity-40 group-focus-within/card:text-amber-500 group-focus-within/card:opacity-100 transition-all" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted group-focus-within/card:text-app-text transition-all">
                            Load remainder (${centsToFixed2(remainderCents)})
                        </span>
                    </div>
                    <div className="relative">
                      <input
                        ref={cardInputRef}
                        type="text"
                        placeholder="Scan Card Code..."
                        value={cardCode}
                        onChange={(e) => setCardCode(e.target.value)}
                        className="ui-input w-full pl-14 font-mono text-lg font-black tracking-[0.2em] uppercase placeholder:text-[10px] placeholder:tracking-widest h-20 rounded-[24px] focus:ring-amber-500 focus:border-amber-500"
                      />
                      <Plus className="absolute left-6 top-1/2 -translate-y-1/2 h-6 w-6 text-app-text-muted opacity-40" />
                    </div>
                  </label>
                ) : (
                    <div className="flex flex-col items-center justify-center p-6 rounded-[24px] bg-emerald-500/[0.03] border border-dashed border-emerald-500/20 animate-in fade-in duration-700">
                        <Gift className="text-emerald-500 mb-2 opacity-40" size={32} />
                        <p className="text-[10px] font-black uppercase tracking-widest text-emerald-600/70 text-center">Reward Fully Leveraged<br/>on active sale</p>
                    </div>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4 rounded-[28px] bg-app-surface-2 p-5 border border-app-border/40 shadow-inner">
              <p className="col-span-2 mb-1 px-1 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
                Fulfillment Notifications
              </p>
              <label className="flex items-center gap-3 rounded-[18px] bg-app-surface px-4 py-3 border border-app-border cursor-pointer transition-all hover:border-emerald-500/40 hover:bg-emerald-500/[0.02] group shadow-sm active:scale-[0.98]">
                <input
                  type="checkbox"
                  className="h-5 w-5 rounded-lg border-app-border text-emerald-600 focus:ring-emerald-500 transition-all"
                  checked={notifySms}
                  onChange={(e) => setNotifySms(e.target.checked)}
                />
                <span className="text-[11px] font-black uppercase tracking-widest text-app-text group-hover:text-emerald-600 transition-colors">SMS Bundle</span>
              </label>
              <label className="flex items-center gap-3 rounded-[18px] bg-app-surface px-4 py-3 border border-app-border cursor-pointer transition-all hover:border-sky-500/40 hover:bg-sky-500/[0.02] group shadow-sm active:scale-[0.98]">
                <input
                  type="checkbox"
                  className="h-5 w-5 rounded-lg border-app-border text-sky-600 focus:ring-sky-500 transition-all"
                  checked={notifyEmail}
                  onChange={(e) => setNotifyEmail(e.target.checked)}
                />
                <span className="text-[11px] font-black uppercase tracking-widest text-app-text group-hover:text-sky-600 transition-colors">Digital Receipt</span>
              </label>
            </div>

            {error && (
              <div className="p-5 rounded-[24px] bg-red-500/10 border border-red-500/20 animate-in shake-in duration-500 flex items-center gap-3 text-red-600">
                <AlertTriangle size={18} />
                <p className="text-xs font-black uppercase tracking-tight">{error}</p>
              </div>
            )}

            <div className="flex gap-4 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="ui-btn-secondary flex-1 rounded-[24px] h-16 text-xs font-black uppercase tracking-[0.2em] border-2 border-app-border/50 hover:bg-app-surface-3 transition-all"
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className="flex-[2] rounded-[24px] h-16 border-b-8 border-emerald-800 bg-emerald-600 text-[11px] font-black uppercase tracking-[0.25em] text-white shadow-[0_12px_48px_rgba(16,185,129,0.3)] transition-all hover:scale-[1.02] hover:brightness-110 active:scale-[0.98] active:translate-y-1 active:border-b-2 disabled:opacity-50 disabled:grayscale"
              >
                {busy ? "Processing Reward..." : (
                  <div className="flex items-center justify-center gap-3">
                    <Sparkles size={20} className="text-emerald-300" />
                    {appliedCents > 0 ? "Commit Fulfillment" : "Issue Gift Card"}
                  </div>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
