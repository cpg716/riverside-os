import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  CreditCard,
  Banknote,
  Landmark,
  CalendarDays,
  Gift,
  Trash2,
  CheckCircle2,
  Wallet,
  ScanLine,
  ScrollText,
  ShieldCheck,
  RotateCcw,
  Sparkles,
  Layers
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import StripeReaderSimulation from "./StripeReaderSimulation";
import NumericPinKeypad from "../ui/NumericPinKeypad";
import { centsToFixed2, parseMoneyToCents, calculateSwedishRounding } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import { 
  type AppliedPaymentLine, 
  type CheckoutOperatorContext, 
  type GiftCardType,
  type NexoTenderTab
} from "./types";

interface VaultedPaymentMethod {
  stripe_payment_method_id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

interface IntentRequestBody {
  amount_due: string;
  moto: boolean;
  customer_id: string | null;
  payment_method_id?: string;
  is_credit?: boolean;
}

const TAB_META: Record<
  NexoTenderTab,
  {
    label: string;
    method: string;
    icon: typeof CreditCard;
    idle: string;
    active: string;
    accent: string;
  }
> = {
  card_terminal: {
    label: "STRIPE CARD",
    method: "card_terminal",
    icon: CreditCard,
    idle: "bg-blue-500/5 border border-app-border text-app-text-muted hover:border-blue-500/40",
    active: "bg-blue-600 border border-transparent text-white shadow-lg",
    accent: "text-blue-500",
  },
  card_manual: {
    label: "STRIPE MANUAL",
    method: "card_manual",
    icon: CreditCard,
    idle: "bg-zinc-500/5 border border-app-border text-app-text-muted hover:border-zinc-500/40",
    active: "bg-zinc-800 border border-transparent text-white shadow-lg",
    accent: "text-zinc-500",
  },
  card_saved: {
    label: "STRIPE VAULT",
    method: "card_saved",
    icon: ShieldCheck,
    idle: "bg-indigo-500/5 border border-app-border text-app-text-muted hover:border-indigo-500/40",
    active: "bg-indigo-600 border border-transparent text-white shadow-lg",
    accent: "text-indigo-500",
  },
  card_credit: {
    label: "STRIPE CREDIT",
    method: "card_credit",
    icon: RotateCcw,
    idle: "bg-rose-500/5 border border-app-border text-app-text-muted hover:border-rose-500/40",
    active: "bg-rose-600 border border-transparent text-white shadow-lg",
    accent: "text-rose-500",
  },
  cash: {
    label: "CASH",
    method: "cash",
    icon: Banknote,
    idle: "bg-emerald-500/5 border border-app-border text-app-text-muted hover:border-emerald-500/40",
    active: "bg-emerald-600 border border-transparent text-white shadow-lg",
    accent: "text-emerald-500",
  },
  check: {
    label: "CHECK",
    method: "check",
    icon: ScrollText,
    idle: "bg-sky-500/5 border border-app-border text-app-text-muted hover:border-sky-500/40",
    active: "bg-sky-600 border border-transparent text-white shadow-lg",
    accent: "text-sky-500",
  },
  on_account_rms: {
    label: "RMS",
    method: "on_account_rms",
    icon: Landmark,
    idle: "bg-amber-500/5 border border-app-border text-app-text-muted hover:border-amber-500/40",
    active: "bg-amber-600 border border-transparent text-white shadow-lg",
    accent: "text-amber-500",
  },
  on_account_rms90: {
    label: "RMS90",
    method: "on_account_rms90",
    icon: CalendarDays,
    idle: "bg-indigo-500/5 border border-app-border text-app-text-muted hover:border-indigo-500/40",
    active: "bg-indigo-800 border border-transparent text-white shadow-lg",
    accent: "text-indigo-400",
  },
  gift_card: {
    label: "GIFT CARD",
    method: "gift_card",
    icon: Gift,
    idle: "bg-fuchsia-500/5 border border-app-border text-app-text-muted hover:border-fuchsia-500/40",
    active: "bg-fuchsia-600 border border-transparent text-white shadow-lg",
    accent: "text-fuchsia-500",
  },
  store_credit: {
    label: "STORE CREDIT",
    method: "store_credit",
    icon: Wallet,
    idle: "bg-violet-500/5 border border-app-border text-app-text-muted hover:border-violet-500/40",
    active: "bg-violet-600 border border-transparent text-white shadow-lg",
    accent: "text-violet-500",
  },
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface NexoCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  amountDueCents: number;
  stateTaxCents: number;
  localTaxCents: number;
  shippingCents: number;
  weddingLinked: boolean;
  customerId?: string | null;
  customerName?: string | null;
  authoritativeDepositCents?: number;
  profileBlocksCheckout: boolean;
  onOpenProfileGate: () => void;
  busy: boolean;
  onFinalize: (
    lines: AppliedPaymentLine[],
    operator: CheckoutOperatorContext,
    ledgerSignals: { 
      appliedDepositAmountCents: number;
      isTaxExempt: boolean;
      taxExemptReason?: string;
      roundingAdjustmentCents?: number;
      finalCashDueCents?: number;
    },
  ) => Promise<void>;
  allowStoreCredit?: boolean;
  appliedPayments: AppliedPaymentLine[];
  onAppliedPaymentsChange: Dispatch<SetStateAction<AppliedPaymentLine[]>>;
  depositLedgerAmount: string;
  onDepositLedgerAmountChange: (value: string) => void;
  checkoutOperator: CheckoutOperatorContext | null;
  allowDepositKeypad?: boolean;
  rmsPaymentCollectionMode?: boolean;
  allowDepositOnlyComplete?: boolean;
  takeawayDueCents?: number;
  hasLaterItems?: boolean;
  onOpenSplitDeposit?: () => void;
}

const GIFT_CARD_TYPES: GiftCardType[] = [
  "paid_liability",
  "loyalty_giveaway",
  "donated_giveaway",
];

function giftCardTypeLabel(t: GiftCardType): string {
  switch (t) {
    case "paid_liability": return "Paid";
    case "loyalty_giveaway": return "Loyalty";
    case "donated_giveaway": return "Donated";
    default: return t;
  }
}

export default function NexoCheckoutDrawer({
  isOpen,
  onClose,
  amountDueCents,
  stateTaxCents,
  localTaxCents,
  customerId,
  authoritativeDepositCents = 0,
  profileBlocksCheckout,
  onOpenProfileGate,
  busy,
  onFinalize,
  allowStoreCredit = false,
  appliedPayments: applied,
  onAppliedPaymentsChange: setApplied,
  depositLedgerAmount: appliedDepositAmount,
  onDepositLedgerAmountChange: setAppliedDepositAmount,
  checkoutOperator: operator,
  allowDepositKeypad = false,
  rmsPaymentCollectionMode = false,
  allowDepositOnlyComplete = false,
  takeawayDueCents = 0,
  shippingCents = 0,
  hasLaterItems = false,
  onOpenSplitDeposit,
}: NexoCheckoutDrawerProps) {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<NexoTenderTab>("card_terminal");
  const [keypad, setKeypad] = useState("");
  const [giftCardSubType, setGiftCardSubType] = useState<GiftCardType | null>("paid_liability");
  const [giftCardCode, setGiftCardCode] = useState("");
  const [checkNumber, setCheckNumber] = useState("");
  const [showStripeSimulation, setShowStripeSimulation] = useState(false);
  const [stripeIntent, setStripeIntent] = useState<{ intent_id?: string } | null>(null);

  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [taxExemptReason, setTaxExemptReason] = useState("Out of State");
  
  type VaultedMethod = {
    stripe_payment_method_id: string;
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
  };

  const [vaultedMethods, setVaultedMethods] = useState<VaultedMethod[]>([]);
  const [vaultedLoading, setVaultedLoading] = useState(false);
  const [selectedVaultedPmId, setSelectedVaultedPmId] = useState<string | null>(null);
  const pendingStripeCentsRef = useRef<number>(0);

  const tenderTabIds = useMemo(() => {
    const all = Object.keys(TAB_META) as NexoTenderTab[];
    let base = allowStoreCredit ? all : all.filter((id) => id !== "store_credit");
    if (rmsPaymentCollectionMode) {
      base = base.filter((id) => id === "cash" || id === "check");
    }
    if (!customerId) {
      base = base.filter((id) => id !== "card_saved");
    }
    if (amountDueCents >= 0) {
      base = base.filter((id) => id !== "card_credit");
    }
    return base;
  }, [allowStoreCredit, rmsPaymentCollectionMode, customerId, amountDueCents]);

  const paidSoFarCents = useMemo(() => applied.reduce((s, p) => s + p.amountCents, 0), [applied]);
  const depositDisplayCents = useMemo(() => Math.max(0, parseMoneyToCents(appliedDepositAmount.trim())), [appliedDepositAmount]);

  const effectiveStateTax = isTaxExempt ? 0 : stateTaxCents;
  const effectiveLocalTax = isTaxExempt ? 0 : localTaxCents;
  const effectiveTotalDue = isTaxExempt ? amountDueCents - (stateTaxCents + localTaxCents) : amountDueCents;

  const tw = Math.max(0, Math.round(takeawayDueCents));

  const remainingCents = useMemo(() => {
    // Financial Truth: If a deposit is set, that IS the target for this session.
    const targetCents = depositDisplayCents > 0 ? depositDisplayCents : effectiveTotalDue;
    return targetCents - paidSoFarCents;
  }, [effectiveTotalDue, paidSoFarCents, depositDisplayCents]);

  const cashRounding = useMemo(() => {
    if (tab !== "cash" || remainingCents === 0) return { adjustment: 0, rounded: remainingCents };
    // Preserving sign for refunds
    const absRem = Math.abs(remainingCents);
    const absRounded = calculateSwedishRounding(absRem);
    const rounded = remainingCents < 0 ? -absRounded : absRounded;
    return {
      adjustment: rounded - remainingCents,
      rounded
    };
  }, [tab, remainingCents]);

  const takeawaySatisfied = paidSoFarCents >= tw;
  
  // A sale is "Full Balance Paid" if we have reached or exceeded the target (for positive balances)
  // or reached or gone below the target (for negative balances/credits).
  const fullBalancePaid = useMemo(() => {
    const target = depositDisplayCents > 0 ? depositDisplayCents : effectiveTotalDue;
    if (target === 0) return true;
    if (target > 0) return paidSoFarCents >= target;
    // For negative targets (like a $50 refund), we are balanced once we have applied $50 or more of refund tenders.
    // e.g. paidSoFarCents = -5000, target = -5000 => true.
    return paidSoFarCents <= target;
  }, [effectiveTotalDue, paidSoFarCents, depositDisplayCents]);
  
  /** 
   * A sale is "Balanced" if:
   * 1. The full balance is paid with tenders.
   * 2. Any takeaway items are paid with tenders AND a deposit protocol is established for the remainder.
   */
  const balanced = fullBalancePaid || (takeawaySatisfied && hasLaterItems && (depositDisplayCents > 0 || allowDepositOnlyComplete));

  const canFinalize = balanced && operator != null && !busy;

  useEffect(() => {
    if (isOpen) {
      setKeypad("");
      setTab(rmsPaymentCollectionMode ? "cash" : (customerId && vaultedMethods.length > 0) ? "card_saved" : "card_terminal");
      setGiftCardCode("");
      setCheckNumber("");
      setShowStripeSimulation(false);
      setStripeIntent(null);
      pendingStripeCentsRef.current = 0;
      setIsTaxExempt(false);
      setTaxExemptReason("Out of State");
    }
  }, [isOpen, rmsPaymentCollectionMode, customerId, vaultedMethods.length]);

  useEffect(() => {
    if (isOpen && customerId) {
      setVaultedLoading(true);
      fetch(`${baseUrl}/api/payments/customers/${customerId}/payment-methods`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      })
        .then((res) => res.json())
        .then((data: VaultedPaymentMethod[]) => {
          setVaultedMethods(Array.isArray(data) ? data : []);
          if (Array.isArray(data) && data.length > 0) {
            setSelectedVaultedPmId(data[0].stripe_payment_method_id);
          }
        })
        .catch(() => setVaultedMethods([]))
        .finally(() => setVaultedLoading(false));
    } else {
      setVaultedMethods([]);
    }
  }, [isOpen, customerId, baseUrl, backofficeHeaders]);

  useEffect(() => {
    if (!isOpen) return;
    const c = Number.isFinite(authoritativeDepositCents) && authoritativeDepositCents > 0
        ? Math.round(authoritativeDepositCents)
        : 0;
    setAppliedDepositAmount(c > 0 ? centsToFixed2(c) : "");
  }, [authoritativeDepositCents, isOpen, setAppliedDepositAmount]);

  const applyDepositFromKeypad = useCallback(() => {
    if (!allowDepositKeypad) return;
    const c = parseMoneyToCents(keypad || "0");
    if (c <= 0) return;
    const maxPossibleDeposit = Math.max(0, amountDueCents - paidSoFarCents);
    const cap = Math.min(c, maxPossibleDeposit);
    setAppliedDepositAmount(centsToFixed2(cap));
    setKeypad("");
    toast("Deposit requirement established.", "info");
  }, [allowDepositKeypad, keypad, amountDueCents, paidSoFarCents, setAppliedDepositAmount, toast]);

  const handleStripeSuccess = useCallback((metadata?: { brand?: string; last4?: string }) => {
    const amtCents = pendingStripeCentsRef.current;
    if (amtCents <= 0) {
      setStripeIntent(null);
      return;
    }
    const meta = TAB_META[tab];

    setApplied((prev) => [
      ...prev,
      {
        id: newId(),
        method: meta.method,
        amountCents: amtCents,
        label: meta.label,
        metadata: {
          stripe_intent_id: stripeIntent?.intent_id,
          card_brand: metadata?.brand ?? null,
          card_last4: metadata?.last4 ?? null,
        },
      },
    ]);
    setKeypad("");
    setShowStripeSimulation(false);
    setStripeIntent(null);
    pendingStripeCentsRef.current = 0;
  }, [tab, stripeIntent?.intent_id, setApplied]);

  const applyAmountToTab = useCallback(async (keypadCents: number) => {
    // Magnitude-based capping: we apply the keypad amount up to the magnitude of the remaining balance,
    // preserving the sign of the remaining balance.
    const absRem = Math.abs(remainingCents);
    const absKey = Math.abs(keypadCents);
    const appliedAbs = Math.min(absKey, absRem);
    const amtCents = remainingCents < 0 ? -appliedAbs : appliedAbs;

    if (amtCents === 0) return;
    const meta = TAB_META[tab];

    if (["card_terminal", "card_manual", "card_saved", "card_credit"].includes(tab)) {
      pendingStripeCentsRef.current = amtCents;
      const isMoto = tab === "card_manual";
      const isSaved = tab === "card_saved";
      const isCredit = tab === "card_credit";

      const allowOfflineCardSim =
        import.meta.env.DEV || import.meta.env.VITE_POS_OFFLINE_CARD_SIM === "true";

      try {
        const body: IntentRequestBody = {
          amount_due: centsToFixed2(amtCents),
          moto: isMoto,
          customer_id: customerId ?? null,
        };
        if (isSaved && selectedVaultedPmId) body.payment_method_id = selectedVaultedPmId;
        if (isCredit) body.is_credit = true;

        const res = await fetch(`${baseUrl}/api/payments/intent`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
           if (allowOfflineCardSim && !isSaved) {
             setStripeIntent({ intent_id: "offline_simulation" });
             setShowStripeSimulation(true);
             return;
           }
           const j = await res.json().catch(() => ({}));
           throw new Error(j.error || "Payment authorization failed");
        }

        const data = await res.json();
        if (isSaved) {
          const savedLast4 = vaultedMethods.find((m) => m.stripe_payment_method_id === selectedVaultedPmId)?.last4 ?? undefined;
          handleStripeSuccess({ last4: savedLast4 });
          toast("Vaulted card authorized.", "success");
          return;
        }

        setStripeIntent(data);
        setShowStripeSimulation(true);
      } catch (e) {
        if (allowOfflineCardSim && !isSaved) {
           setStripeIntent({ intent_id: "offline_simulation" });
           setShowStripeSimulation(true);
           return;
        }
        toast(e instanceof Error ? e.message : "Error initializing payment", "error");
      }
      return;
    }

    setApplied((prev) => [
      ...prev,
      {
        id: newId(),
        method: meta.method,
        sub_type: tab === "gift_card" ? (giftCardSubType ?? "paid_liability") : undefined,
        gift_card_code: tab === "gift_card" ? giftCardCode.trim() : undefined,
        amountCents: amtCents,
        label: tab === "gift_card" ? `Gift Card (${giftCardTypeLabel(giftCardSubType ?? "paid_liability")})` : meta.label,
        metadata: tab === "check" ? { check_number: checkNumber.trim() || null } : undefined,
      },
    ]);
    setKeypad("");
    setGiftCardCode("");
    setCheckNumber("");
  }, [giftCardSubType, giftCardCode, checkNumber, remainingCents, tab, baseUrl, backofficeHeaders, customerId, selectedVaultedPmId, vaultedMethods, handleStripeSuccess, toast, setApplied]);

  const removePaymentLine = async (line: AppliedPaymentLine) => {
    const intentId = line.metadata?.stripe_intent_id?.trim();
    if (line.method === "card_terminal" && intentId && intentId !== "offline_simulation") {
      try {
        await fetch(`${baseUrl}/api/payments/intent/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...mergedPosStaffHeaders(backofficeHeaders) },
          body: JSON.stringify({ intent_id: intentId }),
        });
      } catch { /* ignore best effort */ }
    }
    setApplied((prev) => prev.filter((row) => row.id !== line.id));
  };

  const handleFinalize = async () => {
    if (!operator) return;
    if (profileBlocksCheckout) {
      onOpenProfileGate();
      return;
    }
    if (!canFinalize) return;
    const depositCents = parseMoneyToCents(appliedDepositAmount.trim());
    
    // Calculate final rounding if last payment was not explicitly added or if we are at full balance
    const finalRoundingCents = (tab === "cash" && remainingCents !== 0) ? cashRounding.adjustment : 0;
    const finalCashDue = (tab === "cash" && remainingCents !== 0) ? cashRounding.rounded : undefined;

    await onFinalize(applied, operator, {
      appliedDepositAmountCents: Math.max(0, depositCents),
      isTaxExempt,
      taxExemptReason: isTaxExempt ? taxExemptReason : undefined,
      roundingAdjustmentCents: finalRoundingCents,
      finalCashDueCents: finalCashDue,
    });
  };

  const payFullBalance = () => {
    // We send the absolute value to the keypad for the user to confirm/edit.
    const amt = tab === "cash" ? Math.abs(cashRounding.rounded) : Math.abs(remainingCents);
    setKeypad(centsToFixed2(amt));
  };

  const keypadCents = parseMoneyToCents(keypad || "0");
  const completeDisabledReason = useMemo(() => {
    if (busy) return "Completing sale...";
    if (!balanced) {
      if (tw > 0 && !takeawaySatisfied) return `Tenders must cover takeaway total ($${centsToFixed2(tw)})`;
      return "Balance remaining or deposit protocol required.";
    }
    if (!operator) return "No cashier verified.";
    return "";
  }, [busy, balanced, takeawaySatisfied, tw, operator]);

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Checkout"
      subtitle="Finalize Payment & Complete Sale"
      panelMaxClassName="max-w-5xl"
      noPadding
      contentContained
      footer={
        <div className="bg-app-surface border-t border-app-border p-6 flex flex-col sm:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-8">
               <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-1 leading-none">Balance Due</span>
                  <span className={`text-5xl font-black tabular-nums tracking-tighter italic ${fullBalancePaid ? "text-emerald-500" : "text-app-text"}`}>
                    ${centsToFixed2(Math.abs(tab === "cash" ? cashRounding.rounded : remainingCents))}
                  </span>
                  {tab === "cash" && cashRounding.adjustment !== 0 && (
                    <span className="text-[10px] font-black uppercase text-amber-500 mt-1">
                      Original Due ${centsToFixed2(Math.abs(remainingCents))} ({cashRounding.adjustment > 0 ? "+" : ""}{centsToFixed2(cashRounding.adjustment)})
                    </span>
                  )}
                  {remainingCents < 0 && !fullBalancePaid && (
                    <span className="text-[10px] font-black uppercase text-rose-500 mt-1">Due to Customer</span>
                  )}
               </div>
            </div>
           
            <div className="flex items-center gap-6 w-full sm:w-auto">
              {/* Tax Exempt Toggle Column */}
              <div className="flex flex-col gap-1 items-end">
                <button
                  type="button"
                  onClick={() => setIsTaxExempt(!isTaxExempt)}
                  className={`flex h-9 items-center gap-2 rounded-xl border px-3 transition-all ${
                    isTaxExempt 
                      ? "border-rose-500 bg-rose-500/10 text-rose-600 shadow-sm" 
                      : "border-app-border bg-app-surface-2 text-app-text-muted hover:border-app-input-border"
                  }`}
                >
                  <div className={`h-3.5 w-3.5 rounded-md border flex items-center justify-center transition-colors ${isTaxExempt ? "bg-rose-500 border-rose-500" : "border-app-border"}`}>
                    {isTaxExempt && <CheckCircle2 className="h-2.5 w-2.5 text-white" />}
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-widest">Tax Exempt</span>
                </button>
                
                {isTaxExempt && (
                  <select
                    value={taxExemptReason}
                    onChange={(e) => setTaxExemptReason(e.target.value)}
                    className="h-7 w-32 rounded-lg border border-rose-200 bg-rose-50/50 px-2 text-[9px] font-black uppercase tracking-tight text-rose-700 outline-none"
                  >
                    <option value="Out of State">Out of State</option>
                    <option value="Exempt Organization">Exempt Org</option>
                    <option value="Resale">Resale</option>
                    <option value="Diplomat">Diplomat</option>
                    <option value="Other">Other</option>
                  </select>
                )}
              </div>

              <div className="hidden md:flex flex-col text-right min-w-[120px]">
                 <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1 leading-none opacity-60">Verified Admin</span>
                 <span className="text-sm font-bold uppercase text-app-text truncate">{operator?.fullName || "SYSTEM"}</span>
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-6 py-2 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canFinalize || busy}
                  title={completeDisabledReason}
                  onClick={handleFinalize}
                  className={`h-14 min-w-[170px] rounded-2xl flex items-center justify-center gap-2 px-8 text-sm font-black uppercase tracking-[0.2em] transition-all ${
                    canFinalize 
                      ? "bg-app-accent text-white shadow-xl shadow-app-accent/30 hover:brightness-110 active:scale-[0.98]" 
                      : "bg-zinc-800 text-zinc-600 cursor-not-allowed"
                  }`}
                >
                  {busy ? (
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                  ) : (
                    <>
                      <CheckCircle2 className="h-5 w-5" />
                      <span>Finalize</span>
                    </>
                  )}
                </button>
              </div>
            </div>
         </div>
      }
    >
      <div className="flex flex-col h-full bg-app-bg overflow-hidden relative">
        
        {busy && (
          <div className="absolute inset-0 z-50 bg-white/60 dark:bg-black/60 backdrop-blur-md flex flex-col items-center justify-center">
             <div className="h-20 w-20 rounded-full border-4 border-app-accent border-t-transparent animate-spin mb-6" />
             <p className="text-xl font-black uppercase italic tracking-wider text-app-text">Completing Transaction...</p>
          </div>
        )}

        <div className="flex-1 p-4 sm:p-5 flex flex-col min-h-0">
          <div className="flex items-start justify-center gap-5 min-h-0 flex-1">
            
            {/* 1. Tender Tabs Matrix (Left) */}
            <div className="w-48 shrink-0 flex flex-col gap-2 overflow-y-auto no-scrollbar pb-4">
              <span className="text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted mb-2 px-1 opacity-60">Revenue Methods</span>
              {tenderTabIds.map((id) => {
                const meta = TAB_META[id];
                const Icon = meta.icon;
                const isActive = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => { setTab(id); setKeypad(""); }}
                    className={`flex items-center gap-4 px-4 h-16 rounded-2xl transition-all w-full text-left shadow-sm ${isActive ? meta.active + " scale-[1.02] z-10" : meta.idle}`}
                  >
                    <Icon size={20} className={isActive ? "" : "opacity-40"} />
                    <span className="text-[11px] font-black uppercase tracking-widest truncate">{meta.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-4">
              <div className="bg-app-surface border border-app-border rounded-2xl p-4 sm:p-5 shadow-sm flex flex-col">
                <div className="flex items-end justify-between border-b border-app-border pb-4 mb-5">
                  <div className="flex flex-col gap-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted leading-none opacity-60">Entry Node</span>
                    <button 
                      type="button" 
                      onClick={payFullBalance}
                      className="inline-flex items-center justify-center px-4 h-9 rounded-full bg-app-accent text-[10px] font-black text-white uppercase italic tracking-wider hover:brightness-110 active:scale-95 shadow-lg shadow-app-accent/20 transition-all border-b-2 border-app-accent-hover"
                    >
                      Pay Full Balance
                    </button>
                  </div>
                  <div className="text-5xl font-black tabular-nums tracking-tighter italic text-app-text leading-none">
                    ${keypad || "0.00"}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex justify-center">
                    <div className="w-96">
                      <NumericPinKeypad
                        value={keypad}
                        onChange={setKeypad}
                        showDecimal
                        maxDigits={12}
                        className="w-full"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={keypadCents <= 0 || (tab === 'gift_card' && giftCardCode.length < 4) || busy}
                        onClick={() => void applyAmountToTab(keypadCents)}
                        className="h-14 rounded-xl bg-emerald-600 text-white font-black uppercase italic tracking-widest shadow-md hover:brightness-110 active:translate-y-0.5 disabled:opacity-30 transition-all text-xs border-b-4 border-emerald-800"
                      >
                        Add Payment
                      </button>
                      
                      {allowDepositKeypad ? (
                        <button
                          type="button"
                          disabled={keypadCents <= 0 || busy}
                          onClick={() => applyDepositFromKeypad()}
                          className="h-14 rounded-xl bg-indigo-600 text-white font-black uppercase italic tracking-widest shadow-md hover:brightness-110 active:translate-y-0.5 disabled:opacity-30 transition-all text-xs border-b-4 border-indigo-800"
                        >
                          Set Deposit
                        </button>
                      ) : (
                        <div className="h-14 rounded-xl border border-app-border/40 bg-app-bg opacity-30 flex items-center justify-center">
                          <span className="text-[8px] font-black uppercase opacity-40">Retail Only</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {(tab === "gift_card" || tab === "card_saved" || tab === "check") && (
                  <div className="mt-6 pt-6 border-t border-app-border animate-in slide-in-from-top-2">
                    {tab === "gift_card" && (
                      <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex gap-1 p-1 bg-app-bg border border-app-border rounded-xl w-72">
                          {GIFT_CARD_TYPES.map(t => (
                            <button key={t} type="button" onClick={() => setGiftCardSubType(t)} className={`flex-1 h-10 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${giftCardSubType === t ? "bg-app-accent text-white" : "text-app-text-muted hover:text-app-text"}`}>{giftCardTypeLabel(t)}</button>
                          ))}
                        </div>
                        <div className="relative flex-1">
                          <ScanLine size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" />
                          <input value={giftCardCode} onChange={e => setGiftCardCode(e.target.value.toUpperCase())} placeholder="GIFT CARD CODE" className="ui-input h-10 w-full pl-12 pr-4 rounded-xl bg-app-bg border border-app-border text-xs font-black tracking-widest uppercase focus:border-app-accent" />
                        </div>
                      </div>
                    )}

                    {tab === "check" && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Authentication Check</span>
                        <div className="relative">
                          <Landmark size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" />
                          <input 
                            value={checkNumber} 
                            onChange={e => setCheckNumber(e.target.value)} 
                            placeholder="CHECK #" 
                            className="ui-input h-14 w-full pl-12 pr-4 rounded-xl bg-app-bg border border-app-border text-lg font-black tracking-widest uppercase focus:border-app-accent" 
                          />
                        </div>
                      </div>
                    )}

                    {tab === "card_saved" && (
                      <div className="grid grid-cols-2 gap-3 max-h-48 overflow-y-auto no-scrollbar">
                        {vaultedMethods.map(m => (
                          <button key={m.stripe_payment_method_id} onClick={() => setSelectedVaultedPmId(m.stripe_payment_method_id)} className={`flex items-center justify-between p-4 rounded-xl border transition-all ${selectedVaultedPmId === m.stripe_payment_method_id ? 'bg-indigo-600 border-transparent text-white' : 'bg-app-bg border-app-border hover:border-indigo-400'}`}>
                             <div className="flex flex-col text-left">
                               <span className="text-xs font-black uppercase italic leading-none">{m.brand} • {m.last4}</span>
                               <span className="text-[9px] font-bold opacity-60 mt-1 uppercase">Expires {m.exp_month}/{m.exp_year}</span>
                             </div>
                             {selectedVaultedPmId === m.stripe_payment_method_id && <CheckCircle2 size={18} />}
                          </button>
                        ))}
                        {vaultedMethods.length === 0 && !vaultedLoading && <p className="text-[10px] italic text-app-text-muted">No vaulted cards found.</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 3. Ledger & Summary (Right) */}
            <div className="w-72 shrink-0 flex flex-col gap-4 h-full min-h-0">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-white shadow-xl flex flex-col min-h-0 flex-1">
                <div className="flex items-center justify-between mb-3">
                   <h5 className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 italic opacity-80">Ledger Flow</h5>
                   <Sparkles size={14} className="text-emerald-500 opacity-40 shrink-0" />
                </div>

                <div className="flex-1 space-y-1.5 overflow-y-auto no-scrollbar mb-3">
                   {applied.length === 0 && depositDisplayCents === 0 && (
                     <div className="flex flex-col items-center justify-center h-full opacity-10 py-6 text-center">
                        <Wallet size={24} strokeWidth={1} />
                        <p className="text-[8px] font-black uppercase tracking-widest mt-2 px-6 leading-tight">Zero Shards Detected</p>
                     </div>
                   )}
                   {applied.map(p => (
                     <div key={p.id} className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 border border-white/5 group transition-all hover:bg-zinc-800/80">
                        <div className="flex flex-col min-w-0">
                           <span className="text-[10px] font-black uppercase italic truncate">{p.label}</span>
                           {p.metadata?.check_number && <span className="text-[8px] font-mono text-zinc-500 truncate mt-0.5 opacity-60">Check #{p.metadata.check_number}</span>}
                           {p.gift_card_code && <span className="text-[8px] font-mono text-zinc-500 truncate mt-0.5 opacity-60">{p.gift_card_code}</span>}
                        </div>
                        <div className="flex items-center gap-2.5 ml-2">
                           <span className="text-[11px] font-black tabular-nums tracking-tight opacity-90">${centsToFixed2(p.amountCents)}</span>
                           <button onClick={() => void removePaymentLine(p)} className="text-zinc-500 hover:text-rose-500 transition-all opacity-0 group-hover:opacity-100"><Trash2 size={12} /></button>
                        </div>
                     </div>
                   ))}
                   {depositDisplayCents > 0 && (
                     <div className="flex flex-col gap-2">
                       <div className="flex items-center justify-between p-2.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                          <span className="text-[10px] font-black uppercase italic text-indigo-200">Required Deposit</span>
                          <span className="text-[11px] font-black tabular-nums text-white opacity-90">${centsToFixed2(depositDisplayCents)}</span>
                       </div>
                       {onOpenSplitDeposit && (
                         <button
                           type="button"
                           disabled={busy}
                           onClick={() => onOpenSplitDeposit()}
                           className="flex items-center justify-center gap-2 py-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/5 text-indigo-300 hover:bg-indigo-500/10 transition-all w-full"
                         >
                            <Layers size={12} />
                            <span className="text-[9px] font-black uppercase tracking-wider">Configure Split Payer</span>
                         </button>
                       )}
                     </div>
                   )}
                </div>

                <div className="border-t border-white/5 pt-3 space-y-1.5 opacity-90">
                   {depositDisplayCents > 0 && depositDisplayCents !== amountDueCents && (
                     <div className="flex items-center justify-between text-zinc-500">
                        <span className="text-[8px] font-black uppercase tracking-[0.15em]">Today's Target</span>
                        <span className="text-xs font-bold tabular-nums">${centsToFixed2(depositDisplayCents)}</span>
                     </div>
                   )}
                   <div className="flex items-center justify-between pt-1">
                      <span className={`text-2xl font-black tabular-nums italic tracking-tighter ${fullBalancePaid ? "text-emerald-500" : "text-white"}`}>
                        {fullBalancePaid ? "BALANCED" : `$${centsToFixed2(Math.abs(tab === "cash" ? cashRounding.rounded : remainingCents))}`}
                      </span>
                   </div>
                </div>
              </div>

              <div className="bg-app-surface border border-app-border rounded-xl p-3.5 space-y-2.5 shadow-sm overflow-hidden mt-auto">
                <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Revenue Protocol</span>
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-app-text-muted">Net Retail Subtotal</span>
                    <span className="font-bold tabular-nums text-app-text opacity-70">${centsToFixed2(amountDueCents - (stateTaxCents + localTaxCents + shippingCents))}</span>
                  </div>
                  {shippingCents > 0 && (
                    <div className="flex justify-between text-[10px]">
                      <span className="text-app-text-muted">Shipping & Logistics</span>
                      <span className="font-bold tabular-nums text-app-text opacity-70">${centsToFixed2(shippingCents)}</span>
                    </div>
                  )}
                  
                  <div className="flex items-center justify-between border-b border-app-border/30 pb-1 text-[10px] font-bold uppercase tracking-widest">
                    <span className="text-app-text-muted">State Tax</span>
                    <span className={isTaxExempt ? "text-rose-500 line-through opacity-50" : "text-app-text"}>
                      ${centsToFixed2(effectiveStateTax)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-b border-app-border/30 pb-1 text-[10px] font-bold uppercase tracking-widest">
                    <span className="text-app-text-muted">Local Tax</span>
                    <span className={isTaxExempt ? "text-rose-500 line-through opacity-50" : "text-app-text"}>
                      ${centsToFixed2(effectiveLocalTax)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>

        {showStripeSimulation && (
          <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-6 sm:p-12 animate-in fade-in duration-300">
            <StripeReaderSimulation
              amountCents={pendingStripeCentsRef.current}
              moto={tab === "card_manual"}
              onSuccess={(meta) => handleStripeSuccess(meta)}
              onCancel={() => {
                setShowStripeSimulation(false);
                setStripeIntent(null);
                pendingStripeCentsRef.current = 0;
              }}
            />
          </div>
        )}
      </div>
    </DetailDrawer>
  );
}
