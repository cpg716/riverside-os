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
  Hash,
  Wallet,
  ScanLine,
  ScrollText,
  ShieldCheck,
  RotateCcw,
  RefreshCw,
  Lock,
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import StripeReaderSimulation from "./StripeReaderSimulation";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";

export type NexoTenderTab =
  | "card_terminal"
  | "card_manual"
  | "card_saved"
  | "card_credit"
  | "cash"
  | "check"
  | "on_account_rms"
  | "on_account_rms90"
  | "gift_card"
  | "store_credit";

export type GiftCardType =
  | "paid_liability"
  | "loyalty_giveaway"
  | "donated_giveaway";

export interface AppliedPaymentLine {
  id: string;
  method: string;
  sub_type?: GiftCardType;
  gift_card_code?: string;
  /** Tender amount in integer cents (source of truth for checkout splits). */
  amountCents: number;
  label: string;
  metadata?: { stripe_intent_id?: string };
}

const TAB_META: Record<
  NexoTenderTab,
  {
    label: string;
    method: string;
    icon: typeof CreditCard;
    idle: string;
    active: string;
  }
> = {
  card_terminal: {
    label: "Card Reader",
    method: "card_terminal",
    icon: CreditCard,
    idle: "border-2 border-blue-400/80 bg-blue-100 text-blue-950 shadow-sm hover:border-blue-500 hover:bg-blue-50",
    active:
      "border-2 border-blue-900 bg-blue-600 text-white shadow-lg ring-2 ring-blue-400/50",
  },
  card_manual: {
    label: "Manual Card",
    method: "card_manual",
    icon: CreditCard,
    idle: "border-2 border-slate-400/80 bg-slate-100 text-slate-950 shadow-sm hover:border-slate-500 hover:bg-slate-50",
    active:
      "border-2 border-slate-900 bg-slate-600 text-white shadow-lg ring-2 ring-slate-400/50",
  },
  card_saved: {
    label: "Saved Card",
    method: "card_saved",
    icon: ShieldCheck,
    idle: "border-2 border-indigo-400/80 bg-indigo-100 text-indigo-950 shadow-sm hover:border-indigo-500 hover:bg-indigo-50",
    active:
      "border-2 border-indigo-900 bg-indigo-600 text-white shadow-lg ring-2 ring-indigo-400/50",
  },
  card_credit: {
    label: "Stripe Credit",
    method: "card_credit",
    icon: RotateCcw,
    idle: "border-2 border-rose-400/80 bg-rose-100 text-rose-950 shadow-sm hover:border-rose-500 hover:bg-rose-50",
    active:
      "border-2 border-rose-900 bg-rose-600 text-white shadow-lg ring-2 ring-rose-400/50",
  },
  cash: {
    label: "Cash",
    method: "cash",
    icon: Banknote,
    idle: "border-2 border-emerald-500/80 bg-emerald-100 text-emerald-950 shadow-sm hover:border-emerald-600 hover:bg-emerald-50",
    active:
      "border-2 border-emerald-900 bg-emerald-600 text-white shadow-lg ring-2 ring-emerald-400/50",
  },
  check: {
    label: "Check",
    method: "check",
    icon: ScrollText,
    idle: "border-2 border-sky-500/80 bg-sky-100 text-sky-950 shadow-sm hover:border-sky-600 hover:bg-sky-50",
    active:
      "border-2 border-sky-900 bg-sky-600 text-white shadow-lg ring-2 ring-sky-300/60",
  },
  on_account_rms: {
    label: "RMS Charge",
    method: "on_account_rms",
    icon: Landmark,
    idle: "border-2 border-amber-500/80 bg-amber-100 text-amber-950 shadow-sm hover:border-amber-600 hover:bg-amber-50",
    active:
      "border-2 border-amber-900 bg-amber-600 text-white shadow-lg ring-2 ring-amber-300/55",
  },
  on_account_rms90: {
    label: "RMS90 Plan",
    method: "on_account_rms90",
    icon: CalendarDays,
    idle: "border-2 border-indigo-500/80 bg-indigo-100 text-indigo-950 shadow-sm hover:border-indigo-600 hover:bg-indigo-50",
    active:
      "border-2 border-indigo-900 bg-indigo-600 text-white shadow-lg ring-2 ring-indigo-300/50",
  },
  gift_card: {
    label: "Gift Card",
    method: "gift_card",
    icon: Gift,
    idle: "border-2 border-fuchsia-500/80 bg-fuchsia-100 text-fuchsia-950 shadow-sm hover:border-fuchsia-600 hover:bg-fuchsia-50",
    active:
      "border-2 border-fuchsia-950 bg-app-accent text-white shadow-lg ring-2 ring-fuchsia-300/50",
  },
  store_credit: {
    label: "Store credit",
    method: "store_credit",
    icon: Wallet,
    idle: "border-2 border-violet-500/80 bg-violet-100 text-violet-950 shadow-sm hover:border-violet-600 hover:bg-violet-50",
    active:
      "border-2 border-violet-900 bg-violet-600 text-white shadow-lg ring-2 ring-violet-300/50",
  },
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface CheckoutOperatorContext {
  staffId: string;
  fullName: string;
}

export interface NexoCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Grand total due in integer cents. */
  amountDueCents: number;
  stateTaxCents: number;
  localTaxCents: number;
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
    ledgerSignals: { appliedDepositAmountCents: number },
  ) => Promise<void>;
  /** When false, the store credit tender tab is hidden (requires a linked customer at checkout). */
  allowStoreCredit?: boolean;
  /**
   * Lifted from Cart so tenders / deposit / operator survive drawer close (DetailDrawer unmounts children).
   */
  appliedPayments: AppliedPaymentLine[];
  onAppliedPaymentsChange: Dispatch<SetStateAction<AppliedPaymentLine[]>>;
  depositLedgerAmount: string;
  onDepositLedgerAmountChange: (value: string) => void;
  checkoutOperator: CheckoutOperatorContext | null;
  /** Show deposit keypad flow (Register: only when any line is order-later). */
  allowDepositKeypad?: boolean;
  backdropClassName?: string;
  /** R2S RMS payment collection: only cash and check tenders. */
  rmsPaymentCollectionMode?: boolean;
  /** Special / wedding orders only: allow Complete Sale with ledger deposit and no tenders (mixed carts require takeaway paid with tenders first). */
  allowDepositOnlyComplete?: boolean;
  /** Takeaway lines subtotal + tax (cents); deposit ledger cannot satisfy this portion. */
  takeawayDueCents?: number;
  /** Shipping fee charged on the order (cents). */
  shippingCents?: number;
  /** Whether the cart contains items marked for later fulfillment (Order/Layaway). */
  hasLaterItems?: boolean;
  /** Whether the user has confirmed they want to pick up everything now (only relevant for zero balance). */
  pickupConfirmed?: boolean;
  onPickupConfirmedChange?: (confirmed: boolean) => void;
  /** Open wedding lookup in group-pay mode to split deposits across party members. */
  onOpenSplitDeposit?: () => void;
}

const GIFT_CARD_TYPES: GiftCardType[] = [
  "paid_liability",
  "loyalty_giveaway",
  "donated_giveaway",
];

function giftCardTypeLabel(t: GiftCardType): string {
  switch (t) {
    case "paid_liability":
      return "Paid";
    case "loyalty_giveaway":
      return "Loyalty";
    case "donated_giveaway":
      return "Donated";
    default:
      return t;
  }
}

export default function NexoCheckoutDrawer({
  isOpen,
  onClose,
  amountDueCents,
  stateTaxCents,
  localTaxCents,
  weddingLinked,
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
  backdropClassName,
  rmsPaymentCollectionMode = false,
  allowDepositOnlyComplete = false,
  takeawayDueCents = 0,
  shippingCents = 0,
  hasLaterItems = false,
  pickupConfirmed = false,
  onPickupConfirmedChange,
  onOpenSplitDeposit,
}: NexoCheckoutDrawerProps) {
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<NexoTenderTab>("card_terminal");
  const [keypad, setKeypad] = useState("");
  const [giftCardSubType, setGiftCardSubType] = useState<GiftCardType | null>(
    "paid_liability",
  );
  const [giftCardCode, setGiftCardCode] = useState("");
  const [showStripeSimulation, setShowStripeSimulation] = useState(false);
  const [stripeIntent, setStripeIntent] = useState<{
    intent_id?: string;
  } | null>(null);
  type VaultedMethod = {
    stripe_payment_method_id: string;
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
    funding?: string | null;
  };

  const [vaultedMethods, setVaultedMethods] = useState<VaultedMethod[]>([]);
  const [vaultedLoading, setVaultedLoading] = useState(false);
  const [selectedVaultedPmId, setSelectedVaultedPmId] = useState<string | null>(
    null,
  );
  const pendingStripeCentsRef = useRef<number>(0);

  const tenderTabIds = useMemo(() => {
    const all = Object.keys(TAB_META) as NexoTenderTab[];
    let base = allowStoreCredit
      ? all
      : all.filter((id) => id !== "store_credit");
    if (rmsPaymentCollectionMode) {
      base = base.filter((id) => id === "cash" || id === "check");
    }
    // Filter saved card if no customer
    if (!customerId) {
      base = base.filter((id) => id !== "card_saved");
    }
    // Only show card_credit if grand total is negative
    if (amountDueCents >= 0) {
      base = base.filter((id) => id !== "card_credit");
    }
    return base;
  }, [allowStoreCredit, rmsPaymentCollectionMode, customerId, amountDueCents]);

  const paidSoFarCents = useMemo(
    () => applied.reduce((s, p) => s + p.amountCents, 0),
    [applied],
  );
  const depositDisplayCents = useMemo(
    () => Math.max(0, parseMoneyToCents(appliedDepositAmount.trim())),
    [appliedDepositAmount],
  );

  const tw = Math.max(0, Math.round(takeawayDueCents));

  const remainingCents = useMemo(() => {
    if (
      allowDepositOnlyComplete &&
      allowDepositKeypad &&
      depositDisplayCents > 0
    ) {
      return Math.max(0, depositDisplayCents + tw - paidSoFarCents);
    }
    return Math.max(0, amountDueCents - paidSoFarCents);
  }, [
    allowDepositOnlyComplete,
    allowDepositKeypad,
    depositDisplayCents,
    tw,
    amountDueCents,
    paidSoFarCents,
  ]);

  const paymentBalanced = remainingCents <= 0 && paidSoFarCents > 0;
  /** Deposit-only completion: no tenders required when the deposit ledger covers the full balance (no takeaway items to pay for today). */
  const depositOnlyBalanced =
    allowDepositOnlyComplete &&
    allowDepositKeypad &&
    depositDisplayCents > 0 &&
    tw <= 0 &&
    paidSoFarCents === 0;

  const canFinalize =
    (paymentBalanced || depositOnlyBalanced) && operator != null && !busy;

  const drawerWasOpenRef = useRef(false);
  useEffect(() => {
    const was = drawerWasOpenRef.current;
    if (isOpen && !was) {
      setKeypad("");
      setTab(rmsPaymentCollectionMode ? "cash" : "card_terminal");
      setGiftCardSubType("paid_liability");
      setGiftCardCode("");
      setShowStripeSimulation(false);
      setStripeIntent(null);
      pendingStripeCentsRef.current = 0;
      setSelectedVaultedPmId(null);
    }
    drawerWasOpenRef.current = isOpen;
  }, [isOpen, rmsPaymentCollectionMode]);

  useEffect(() => {
    if (isOpen && customerId) {
      setVaultedLoading(true);
      fetch(`${baseUrl}/api/payments/customers/${customerId}/payment-methods`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      })
        .then((res) => res.json())
        .then((data) => {
          setVaultedMethods(Array.isArray(data) ? data : []);
          if (Array.isArray(data) && data.length > 0) {
            setTab("card_saved");
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
    if (allowStoreCredit || tab !== "store_credit") return;
    setTab("card_terminal");
  }, [allowStoreCredit, tab]);

  useEffect(() => {
    if (!isOpen || !rmsPaymentCollectionMode) return;
    if (tab !== "cash" && tab !== "check") setTab("cash");
  }, [isOpen, rmsPaymentCollectionMode, tab]);

  useEffect(() => {
    if (!isOpen) return;
    const c =
      Number.isFinite(authoritativeDepositCents) &&
      authoritativeDepositCents > 0
        ? Math.round(authoritativeDepositCents)
        : 0;
    setAppliedDepositAmount(c > 0 ? centsToFixed2(c) : "");
  }, [authoritativeDepositCents, isOpen, setAppliedDepositAmount]);

  const appendDigit = (d: string) => {
    if (d === "." && keypad.includes(".")) return;
    if (keypad === "0" && d !== ".") setKeypad(d);
    else setKeypad((k) => (k + d).slice(0, 12));
  };
  const backspace = () => setKeypad((k) => k.slice(0, -1));

  const applyDepositFromKeypad = useCallback(() => {
    if (!allowDepositKeypad) return;
    const c = parseMoneyToCents(keypad || "0");
    if (c <= 0) return;
    const maxDeposit = Math.max(0, amountDueCents - paidSoFarCents);
    const cap = Math.min(c, maxDeposit);
    setAppliedDepositAmount(centsToFixed2(cap));
    setKeypad("");
    toast("Deposit amount applied to balance", "info");
  }, [
    allowDepositKeypad,
    keypad,
    amountDueCents,
    paidSoFarCents,
    setAppliedDepositAmount,
    toast,
  ]);

  const handleStripeSuccess = useCallback(
    (metadata?: { brand?: string; last4?: string }) => {
      const amtCents = pendingStripeCentsRef.current;
      if (amtCents <= 0) {
        setStripeIntent(null);
        return;
      }
      const meta =
        tab === "card_saved"
          ? TAB_META.card_saved
          : tab === "card_credit"
            ? TAB_META.card_credit
            : tab === "card_manual"
              ? TAB_META.card_manual
              : TAB_META.card_terminal;

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
    },
    [tab, stripeIntent?.intent_id, setApplied],
  );

  const applyAmountToTab = useCallback(
    async (keypadCents: number) => {
      const amtCents = Math.min(Math.max(0, keypadCents), remainingCents);
      if (amtCents <= 0) return;
      const meta = TAB_META[tab];

      if (
        tab === "card_terminal" ||
        tab === "card_manual" ||
        tab === "card_saved" ||
        tab === "card_credit"
      ) {
        pendingStripeCentsRef.current = amtCents;
        const isMoto = tab === "card_manual";
        const isSaved = tab === "card_saved";
        const isCredit = tab === "card_credit";

        const allowOfflineCardSim =
          import.meta.env.DEV ||
          import.meta.env.VITE_POS_OFFLINE_CARD_SIM === "true";
        const openOfflineSimulation = () => {
          toast(
            "Stripe reader unavailable — using training card simulation.",
            "info",
          );
          setStripeIntent({ intent_id: "offline_simulation" });
          setShowStripeSimulation(true);
        };

        try {
          const body: {
            amount_due: string;
            moto: boolean;
            customer_id: string | null;
            payment_method_id?: string;
            is_credit?: boolean;
          } = {
            amount_due: centsToFixed2(amtCents),
            moto: isMoto,
            customer_id: customerId ?? null,
          };
          if (isSaved && selectedVaultedPmId) {
            body.payment_method_id = selectedVaultedPmId;
          }
          if (isCredit) {
            body.is_credit = true;
          }

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
              openOfflineSimulation();
              return;
            }
            let apiMsg: string | undefined;
            try {
              const j = (await res.json()) as { error?: string };
              apiMsg = j.error?.trim();
            } catch {
              /* ignore */
            }
            throw new Error(apiMsg || "Payment intent could not be created");
          }

          const data = await res.json();

          if (isSaved) {
            // Saved cards are finalized off-session on the server.
            // If the call succeeded, it means the charge passed.
            const savedLast4 =
              vaultedMethods.find(
                (m) => m.stripe_payment_method_id === selectedVaultedPmId,
              )?.last4 ?? undefined;
            handleStripeSuccess({
              last4: savedLast4,
            });
            toast("Saved card processed successfully", "success");
            return;
          }

          setStripeIntent(data);
          setShowStripeSimulation(true);
          return;
        } catch (e) {
          if (allowOfflineCardSim && !isSaved) {
            openOfflineSimulation();
            return;
          }
          toast(e instanceof Error ? e.message : "Stripe error", "error");
          pendingStripeCentsRef.current = 0;
        }
        return;
      }

      const gcType = giftCardSubType ?? "paid_liability";
      const gcCode =
        tab === "gift_card" && giftCardCode.trim()
          ? giftCardCode.trim()
          : undefined;

      setApplied((prev) => [
        ...prev,
        {
          id: newId(),
          method: meta.method,
          sub_type: tab === "gift_card" ? gcType : undefined,
          gift_card_code: gcCode,
          amountCents: amtCents,
          label:
            tab === "gift_card"
              ? gcType === "loyalty_giveaway"
                ? "Gift card (loyalty)"
                : gcType === "donated_giveaway"
                  ? "Gift card (donated)"
                  : "Gift card"
              : meta.label,
        },
      ]);
      setKeypad("");
      if (tab === "gift_card") setGiftCardCode("");
    },
    [
      giftCardSubType,
      giftCardCode,
      remainingCents,
      tab,
      baseUrl,
      backofficeHeaders,
      customerId,
      selectedVaultedPmId,
      vaultedMethods,
      handleStripeSuccess,
      toast,
      setApplied,
    ],
  );

  const removePaymentLine = async (line: AppliedPaymentLine) => {
    const intentId = line.metadata?.stripe_intent_id?.trim();
    if (
      line.method === "card_terminal" &&
      intentId &&
      intentId !== "offline_simulation"
    ) {
      try {
        const res = await fetch(`${baseUrl}/api/payments/intent/cancel`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify({ intent_id: intentId }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
        };
        if (!res.ok) {
          toast(
            j.error?.trim() ||
              "Could not void this card authorization. If a charge cleared, refund or void in Stripe.",
            "error",
          );
        } else if (j.status === "cancelled") {
          toast("Card authorization voided", "info");
        }
      } catch {
        toast(
          "Could not reach the server to void the authorization; tender removed from the ledger.",
          "error",
        );
      }
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
    await onFinalize(applied, operator, {
      appliedDepositAmountCents: Math.max(0, depositCents),
    });
  };

  const keypadCents = parseMoneyToCents(keypad || "0");
  const taxTotalCents = stateTaxCents + localTaxCents;
  const canApplyCurrentTab =
    tab !== "gift_card" ||
    (!!giftCardSubType && giftCardCode.trim().length >= 4);

  const completeDisabledReason = useMemo(() => {
    if (busy) return "Finalizing…";
    if (!paymentBalanced && !depositOnlyBalanced) {
      if (allowDepositOnlyComplete && depositDisplayCents <= 0) {
        return "Pay the balance with tenders, or set a deposit on the keypad and tap Apply deposit";
      }
      return "Apply tenders until balance remaining is $0.00";
    }
    if (!operator)
      return "Sign in on the register screen to start this sale (cashier for order)";
    return "";
  }, [
    busy,
    paymentBalanced,
    depositOnlyBalanced,
    allowDepositOnlyComplete,
    depositDisplayCents,
    operator,
  ]);

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Payment Ledger"
      subtitle="Finalize Transaction"
      titleClassName="text-app-text font-black tracking-tighter italic uppercase"
      panelMaxClassName="max-w-2xl"
      noPadding
      contentContained
      backdropClassName={
        backdropClassName ??
        "absolute inset-0 bg-black/50 transition-opacity duration-200"
      }
      footer={
        <button
          type="button"
          disabled={!canFinalize || busy}
          title={!canFinalize && !busy ? completeDisabledReason : undefined}
          onClick={() => void handleFinalize()}
          className={`ui-touch-target group relative h-16 w-full overflow-hidden rounded-2xl border-b-4 transition-all active:scale-[0.98] active:translate-y-1 ${canFinalize && !busy ? "border-emerald-800 bg-emerald-600 text-white shadow-xl shadow-emerald-500/40 hover:bg-emerald-500" : "border-app-input-border bg-app-surface-2 text-app-text-muted"}`}
        >
          <div className="flex items-center justify-center gap-4">
            <div
              className={`flex-shrink-0 transition-transform ${busy ? "animate-spin" : ""}`}
            >
              <CheckCircle2 size={24} />
            </div>
            <span className="text-xl font-black uppercase italic leading-none tracking-widest">
              {busy ? "Finalizing..." : "Complete Sale"}
            </span>
          </div>
        </button>
      }
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-app-bg px-4 pt-1">
        {/* Tenders + balance only — may scroll on very short viewports; keypad is pinned below (never scrolls). */}
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-y-contain pb-2 pt-0.5">
          <div className="flex flex-col space-y-2">
            {weddingLinked ? (
              <p className="truncate rounded-xl border border-app-accent/25 bg-app-accent/5 px-3 py-2 text-center text-xs font-semibold leading-snug text-app-accent normal-case">
                Wedding linked — payouts from cart
              </p>
            ) : null}

            <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
              {tenderTabIds.map((id) => {
                const meta = TAB_META[id];
                const Icon = meta.icon;
                const isActive = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setTab(id);
                    }}
                    className={`group relative flex min-h-[2.85rem] flex-col items-center justify-center gap-0.5 rounded-xl p-1.5 transition-all active:scale-[0.98] sm:min-h-[3.25rem] sm:gap-1 sm:p-2 ${isActive ? `translate-y-[-1px] ${meta.active}` : meta.idle}`}
                  >
                    <Icon
                      size={20}
                      className={
                        isActive ? "text-white drop-shadow-sm" : "opacity-90"
                      }
                    />
                    <span
                      className={`text-center text-[9px] font-black uppercase leading-tight tracking-wide ${isActive ? "text-white" : ""}`}
                    >
                      {meta.label}
                    </span>
                    {isActive ? (
                      <div className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-emerald-500 shadow-sm">
                        <CheckCircle2 size={9} className="text-white" />
                      </div>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <div className="rounded-2xl border border-app-border bg-app-surface p-3 shadow-sm">
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Balance remaining
                </span>
                <span
                  className={`text-xl font-black italic tracking-tighter tabular-nums sm:text-2xl ${remainingCents > 0 ? "text-app-text" : "text-emerald-600"}`}
                >
                  ${centsToFixed2(remainingCents)}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 border-t border-app-border pt-2 text-app-text-muted">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold uppercase leading-tight tracking-widest">
                    NYS state (4%)
                  </span>
                  <span className="tabular-nums text-sm font-black text-app-text">
                    ${centsToFixed2(stateTaxCents)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-bold uppercase leading-tight tracking-widest">
                    Local Erie (4.75%)
                  </span>
                  <span className="tabular-nums text-sm font-black text-app-text">
                    ${centsToFixed2(localTaxCents)}
                  </span>
                </div>
              </div>
              <div className="mt-1.5 flex justify-end border-t border-app-border pt-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <span className="tabular-nums text-app-text">
                  Tax total ${centsToFixed2(taxTotalCents)}
                </span>
              </div>
              {shippingCents > 0 && (
                <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-app-border pt-1.5">
                  <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    Shipping fee
                  </span>
                  <span className="tabular-nums text-sm font-black text-sky-600 dark:text-sky-400">
                    ${centsToFixed2(shippingCents)}
                  </span>
                </div>
              )}
              <p className="ui-type-instruction-muted mt-1.5 hidden text-xs leading-snug md:block">
                Totals match POS line math (NYS Pub. 718-C: eligible
                clothing/footwear under $110 may shift state vs local on the
                receipt).
              </p>
              {allowDepositKeypad ? (
                <div className="mt-2 border-t border-app-border pt-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Deposit (ledger)
                    </span>
                    <span className="text-sm font-black tabular-nums text-app-text">
                      ${appliedDepositAmount.trim() || "0.00"}
                    </span>
                  </div>
                  <p className="ui-type-instruction-muted mt-1 text-xs leading-snug">
                    Enter amount on the keypad, then use{" "}
                    <span className="font-semibold ui-caution-text">
                      Apply deposit
                    </span>{" "}
                    below (or pay in full with Apply payment).
                  </p>
                </div>
              ) : null}

              {hasLaterItems && remainingCents <= 0 && (
                <div className="mt-2 border-t-2 border-emerald-500/30 bg-emerald-50/50 p-2.5 dark:bg-emerald-950/20">
                  <label className="flex cursor-pointer items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400">
                        Pickup confirmation
                      </span>
                      <span className="text-xs font-bold leading-none text-app-text">
                        Customer taking all items home now?
                      </span>
                    </div>
                    <div
                      onClick={() =>
                        onPickupConfirmedChange?.(!pickupConfirmed)
                      }
                      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${pickupConfirmed ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"}`}
                    >
                      <div
                        className={`absolute left-1 top-1 h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${pickupConfirmed ? "translate-x-5" : "translate-x-0"}`}
                      />
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Amount entry, keypad, tender actions — fixed strip (not inside summary scroll). */}
        <div className="shrink-0 border-t border-app-border/60 bg-app-bg pb-1 pt-2">
          <div className="isolate grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(220px,1fr)_11rem] sm:gap-3 lg:grid-cols-[minmax(260px,1fr)_12rem]">
            <div className="flex min-w-0 flex-col space-y-2">
              <div className="group relative shrink-0">
                <div className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                  <Hash size={16} className="text-app-text-muted" />
                  <span className="text-[10px] font-black text-app-text-muted">
                    AMOUNT
                  </span>
                </div>
                <div className="flex h-[3.75rem] items-center justify-end rounded-xl bg-app-surface-2 px-4 ring-2 ring-app-border transition-all group-focus-within:bg-app-surface group-focus-within:ring-app-accent sm:h-[4.25rem]">
                  <span className="text-3xl font-black tabular-nums tracking-tighter text-app-text sm:text-4xl">
                    ${keypad || "0"}
                  </span>
                </div>
                {tab === "cash" &&
                  keypadCents > remainingCents &&
                  remainingCents > 0 && (
                    <div className="mt-1 flex justify-end text-[10px] font-black uppercase tracking-widest text-emerald-600">
                      Change due: ${centsToFixed2(keypadCents - remainingCents)}
                    </div>
                  )}
              </div>

              {tab === "gift_card" ? (
                <div className="animate-in slide-in-from-top-2 space-y-2 duration-200">
                  <div className="flex gap-0.5 rounded-lg border border-app-border bg-app-surface-2 p-0.5">
                    {GIFT_CARD_TYPES.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setGiftCardSubType(t)}
                        className={`flex-1 rounded-md py-1.5 text-[9px] font-black uppercase leading-tight tracking-wide transition-all sm:text-[10px] ${giftCardSubType === t ? "bg-app-accent text-white shadow-sm" : "text-app-text-muted hover:text-app-text"}`}
                      >
                        {giftCardTypeLabel(t)}
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <ScanLine
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-app-accent"
                      size={14}
                      aria-hidden
                    />
                    <input
                      value={giftCardCode}
                      onChange={(e) =>
                        setGiftCardCode(e.target.value.toUpperCase())
                      }
                      placeholder="Scan or enter code"
                      autoComplete="off"
                      className="ui-input h-10 w-full pl-9 pr-3 text-[11px] font-black uppercase tracking-widest"
                    />
                  </div>
                  <p className="ui-type-instruction-muted text-[11px] leading-snug">
                    Min 4 characters for gift card tender
                  </p>
                </div>
              ) : null}

              {tab === "card_saved" ? (
                <div className="animate-in slide-in-from-top-2 space-y-2 duration-200">
                  <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Select Saved Card
                      </span>
                      {vaultedLoading && (
                        <RefreshCw
                          size={12}
                          className="animate-spin text-app-accent"
                        />
                      )}
                    </div>
                    {vaultedMethods.length > 0 ? (
                      <div className="space-y-1.5">
                        {vaultedMethods.map((m) => (
                          <button
                            key={m.stripe_payment_method_id}
                            type="button"
                            onClick={() =>
                              setSelectedVaultedPmId(m.stripe_payment_method_id)
                            }
                            className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 transition-all ${
                              selectedVaultedPmId === m.stripe_payment_method_id
                                ? "border-indigo-500 bg-indigo-500/10"
                                : "border-app-border bg-app-surface hover:border-app-input-border"
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <div className="rounded bg-white/10 p-1 text-app-text">
                                <CreditCard size={14} />
                              </div>
                              <div className="text-left">
                                <p className="text-[10px] font-black uppercase tracking-wide text-app-text">
                                  {m.brand} •••• {m.last4}
                                </p>
                                <p className="text-[8px] font-bold text-app-text-muted">
                                  EXPIRES {m.exp_month}/{m.exp_year}
                                </p>
                              </div>
                            </div>
                            {selectedVaultedPmId ===
                              m.stripe_payment_method_id && (
                              <CheckCircle2
                                size={14}
                                className="text-indigo-500"
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="py-4 text-center text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        No saved cards found for this customer.
                      </div>
                    )}
                  </div>
                  <p className="text-center text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                    <Lock size={8} className="inline mr-1" />
                    Charged securely via Stripe Vault
                  </p>
                </div>
              ) : null}

              {tab === "card_credit" ? (
                <div className="animate-in slide-in-from-top-2 space-y-2 duration-200">
                  <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 text-center">
                    <div className="mb-2 flex justify-center">
                      <div className="rounded-full bg-rose-500/20 p-2 text-rose-500">
                        <RotateCcw size={20} />
                      </div>
                    </div>
                    <h4 className="text-[11px] font-black uppercase tracking-widest text-rose-500">
                      Unlinked Stripe Credit
                    </h4>
                    <p className="mt-1 text-[10px] font-medium leading-tight text-app-text-muted">
                      This will record a financial credit in ROS and QBO.
                    </p>
                  </div>
                </div>
              ) : null}

              <div className="grid min-h-0 min-w-[240px] shrink-0 grid-cols-3 gap-2 sm:min-w-[280px]">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"].map(
                  (d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => appendDigit(d)}
                      className="flex h-[3.35rem] min-h-[3.35rem] items-center justify-center rounded-xl bg-app-surface text-2xl font-black text-app-text shadow-sm ring-2 ring-app-border transition-all hover:bg-app-surface-2 hover:ring-app-input-border active:scale-[0.98] sm:h-[3.75rem] sm:min-h-[3.75rem] sm:text-3xl"
                    >
                      {d}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  onClick={backspace}
                  className="flex h-[3.35rem] min-h-[3.35rem] items-center justify-center rounded-xl bg-app-surface-2 text-xs font-black uppercase tracking-wider text-red-600 ring-2 ring-app-border transition-all hover:bg-red-50 active:scale-[0.98] sm:h-[3.75rem] sm:min-h-[3.75rem]"
                >
                  DEL
                </button>
              </div>

              {remainingCents > 0 ? (
                <div className="flex shrink-0 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setKeypad(centsToFixed2(remainingCents))}
                    className="h-12 min-w-0 flex-1 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 text-[10px] font-black uppercase tracking-widest text-white shadow-md transition-all hover:bg-emerald-500 active:scale-[0.99]"
                  >
                    Pay balance (${centsToFixed2(remainingCents)})
                  </button>
                  {tab === "cash"
                    ? [20, 50, 100].map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setKeypad(String(n))}
                          className="h-12 w-14 rounded-xl bg-zinc-200 text-xs font-black text-zinc-900 ring-2 ring-zinc-400/80 transition-all hover:bg-zinc-100 active:scale-[0.98] dark:bg-zinc-700 dark:text-white dark:ring-zinc-500"
                        >
                          ${n}
                        </button>
                      ))
                    : null}
                </div>
              ) : null}
            </div>

            <div className="flex w-full min-w-0 shrink-0 flex-col gap-2 lg:w-auto lg:max-w-[13rem] lg:justify-self-end">
              <div className="relative flex h-[6.5rem] flex-col overflow-hidden rounded-2xl bg-zinc-900 text-white shadow-inner ring-1 ring-black/20 dark:bg-zinc-950 sm:h-[7.25rem]">
                <div className="pointer-events-none absolute right-0 top-0 p-4 opacity-5">
                  <CreditCard size={72} />
                </div>
                <p className="shrink-0 border-b border-white/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-400 sm:py-2">
                  Payments on this sale
                </p>
                <div className="no-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-y-contain px-3 pb-2 pt-1.5">
                  {applied.length === 0 && !(depositDisplayCents > 0) ? (
                    <div className="flex flex-col items-center justify-center px-1 py-3">
                      <p className="text-center text-[10px] font-bold uppercase leading-snug tracking-widest text-zinc-400">
                        No payments applied
                      </p>
                    </div>
                  ) : null}
                  {applied.map((p) => (
                    <div
                      key={p.id}
                      className="relative z-[1] flex items-center justify-between gap-1 rounded-lg border border-white/15 bg-white/10 px-2 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[10px] font-black uppercase leading-tight tracking-wide text-white">
                          {p.label}
                        </p>
                        {p.gift_card_code ? (
                          <p className="font-mono text-[9px] text-zinc-300">
                            {p.gift_card_code}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="font-black italic tabular-nums text-white">
                          ${centsToFixed2(p.amountCents)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void removePaymentLine(p)}
                          className="relative z-[2] rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/10 hover:text-red-400"
                          aria-label="Remove tender"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  ))}
                  {depositDisplayCents > 0 ? (
                    <div className="flex items-center justify-between rounded-lg border border-indigo-400/40 bg-indigo-600/25 px-2 py-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-indigo-100">
                        Deposit (ledger)
                      </span>
                      <span className="font-black italic tabular-nums text-indigo-50">
                        ${centsToFixed2(depositDisplayCents)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex items-baseline justify-between gap-2 px-0.5">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Total tendered
                </span>
                <span className="text-lg font-black tabular-nums text-app-text">
                  ${centsToFixed2(paidSoFarCents)}
                </span>
              </div>

              <div className="flex w-full shrink-0 flex-col gap-2">
                <button
                  type="button"
                  disabled={keypadCents <= 0 || !canApplyCurrentTab || busy}
                  onClick={() => void applyAmountToTab(keypadCents)}
                  className="ui-touch-target flex min-h-[4.25rem] w-full shrink-0 items-center justify-center gap-3 rounded-2xl border-b-[6px] border-emerald-900 bg-emerald-600 px-4 text-sm font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-500/35 transition-all hover:bg-emerald-500 active:scale-[0.99] disabled:opacity-30"
                >
                  <CheckCircle2 size={22} />
                  Apply payment ${centsToFixed2(keypadCents)}
                </button>
                {allowDepositKeypad ? (
                  <button
                    type="button"
                    disabled={keypadCents <= 0 || busy}
                    onClick={() => applyDepositFromKeypad()}
                    className="ui-touch-target flex min-h-[3.5rem] w-full shrink-0 items-center justify-center gap-2 rounded-2xl border-b-[5px] border-amber-900 bg-amber-600 px-4 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-amber-500/30 transition-all hover:bg-amber-500 active:scale-[0.99] disabled:opacity-30"
                  >
                    <CheckCircle2 size={18} />
                    Apply deposit (${centsToFixed2(keypadCents)})
                  </button>
                ) : null}
                {allowDepositKeypad && onOpenSplitDeposit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onOpenSplitDeposit()}
                    className="ui-touch-target flex min-h-[3rem] w-full shrink-0 items-center justify-center rounded-xl border-2 border-blue-400/60 bg-blue-500/10 px-3 text-[10px] font-black uppercase tracking-widest text-blue-900 transition-all hover:bg-blue-500/20 active:scale-[0.99] disabled:opacity-30 dark:text-blue-200"
                  >
                    Split deposit (wedding party)
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {showStripeSimulation ? (
          <div className="pointer-events-auto absolute inset-0 z-[100] flex animate-in items-center justify-center bg-black/90 p-6 backdrop-blur-xl fade-in duration-300">
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
        ) : null}
      </div>
    </DetailDrawer>
  );
}
