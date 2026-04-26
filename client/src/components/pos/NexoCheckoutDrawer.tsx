import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Dispatch, SetStateAction } from "react";
import {
  CreditCard,
  Banknote,
  Landmark,
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

interface RmsChargeAccountChoice {
  link_id: string;
  corecredit_customer_id: string;
  corecredit_account_id: string;
  masked_account: string;
  status: string;
  is_primary: boolean;
  program_group?: string | null;
}

interface RmsChargeResolveResponse {
  resolution_status: "selected" | "multiple" | "blocked";
  selected_account?: RmsChargeAccountChoice | null;
  choices: RmsChargeAccountChoice[];
  blocking_error?: {
    code: string;
    message: string;
  } | null;
}

interface RmsChargeProgramOption {
  program_code: string;
  program_label: string;
  eligible: boolean;
  disclosure?: string | null;
}

interface RmsChargeAccountSummary {
  corecredit_customer_id: string;
  corecredit_account_id: string;
  masked_account: string;
  account_status: string;
  available_credit?: string | null;
  current_balance?: string | null;
  resolution_status?: string | null;
  source: string;
  recent_history?: Array<{
    created_at: string;
    record_kind: string;
    amount: string;
    payment_method: string;
    program_label?: string | null;
    masked_account?: string | null;
    order_short_ref?: string | null;
  }>;
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
  rms_charge: {
    label: "RMS CHARGE",
    method: "on_account_rms",
    icon: Landmark,
    idle: "bg-amber-500/5 border border-app-border text-app-text-muted hover:border-amber-500/40",
    active: "bg-amber-600 border border-transparent text-white shadow-lg",
    accent: "text-amber-500",
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
  const [rmsResolve, setRmsResolve] = useState<RmsChargeResolveResponse | null>(null);
  const [rmsSelectedAccount, setRmsSelectedAccount] = useState<RmsChargeAccountChoice | null>(null);
  const [rmsPrograms, setRmsPrograms] = useState<RmsChargeProgramOption[]>([]);
  const [rmsSelectedProgramCode, setRmsSelectedProgramCode] = useState<string | null>(null);
  const [rmsSummary, setRmsSummary] = useState<RmsChargeAccountSummary | null>(null);
  const [rmsLoading, setRmsLoading] = useState(false);
  const [rmsProgramPickerOpen, setRmsProgramPickerOpen] = useState(false);
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
      setRmsResolve(null);
      setRmsSelectedAccount(null);
      setRmsPrograms([]);
      setRmsSelectedProgramCode(null);
      setRmsSummary(null);
      setRmsProgramPickerOpen(false);
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

  const loadRmsProgramsAndSummary = useCallback(async (account: RmsChargeAccountChoice) => {
    if (!customerId) return;
    const params = new URLSearchParams({
      customer_id: customerId,
      account_id: account.corecredit_account_id,
    });
    const headers = mergedPosStaffHeaders(backofficeHeaders);
    const [programsRes, summaryRes] = await Promise.all([
      fetch(`${baseUrl}/api/pos/rms-charge/programs?${params.toString()}`, {
        headers,
      }),
      fetch(`${baseUrl}/api/pos/rms-charge/account-summary?${params.toString()}`, {
        headers,
      }),
    ]);

    if (!programsRes.ok) {
      const body = (await programsRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not load RMS Charge programs");
    }
    if (!summaryRes.ok) {
      const body = (await summaryRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not load RMS Charge summary");
    }

    const programs = (await programsRes.json()) as RmsChargeProgramOption[];
    const summary = (await summaryRes.json()) as RmsChargeAccountSummary;
    setRmsPrograms(Array.isArray(programs) ? programs : []);
    setRmsSummary(summary);
    setRmsSelectedProgramCode(null);
    setRmsProgramPickerOpen(
      Array.isArray(programs) && programs.some((program) => program.eligible),
    );
  }, [backofficeHeaders, baseUrl, customerId]);

  const resolveRmsAccount = useCallback(async (preferredAccountId?: string | null) => {
    if (!customerId) {
      setRmsResolve({
        resolution_status: "blocked",
        choices: [],
        blocking_error: {
          code: "customer_required",
          message: "Attach a customer before using RMS Charge.",
        },
      });
      setRmsSelectedAccount(null);
      setRmsPrograms([]);
      setRmsSelectedProgramCode(null);
      setRmsSummary(null);
      return;
    }

    setRmsLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/pos/rms-charge/resolve-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        },
        body: JSON.stringify({
          customer_id: customerId,
          preferred_account_id: preferredAccountId ?? undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as
        | RmsChargeResolveResponse
        | { error?: string };
      if (!res.ok) {
        throw new Error("error" in body ? body.error ?? "Could not resolve RMS Charge account" : "Could not resolve RMS Charge account");
      }
      const resolved = body as RmsChargeResolveResponse;
      setRmsResolve(resolved);
      if (resolved.resolution_status === "selected" && resolved.selected_account) {
        setRmsSelectedAccount(resolved.selected_account);
        await loadRmsProgramsAndSummary(resolved.selected_account);
      } else {
        setRmsSelectedAccount(null);
        setRmsPrograms([]);
        setRmsSelectedProgramCode(null);
        setRmsSummary(null);
        setRmsProgramPickerOpen(false);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not resolve RMS Charge account";
      setRmsResolve({
        resolution_status: "blocked",
        choices: [],
        blocking_error: {
          code: "resolve_failed",
          message,
        },
      });
      setRmsSelectedAccount(null);
      setRmsPrograms([]);
      setRmsSelectedProgramCode(null);
      setRmsSummary(null);
      setRmsProgramPickerOpen(false);
      toast(message, "error");
    } finally {
      setRmsLoading(false);
    }
  }, [backofficeHeaders, baseUrl, customerId, loadRmsProgramsAndSummary, toast]);

  useEffect(() => {
    if (!isOpen) return;
    if (rmsPaymentCollectionMode) {
      setRmsProgramPickerOpen(false);
      void resolveRmsAccount();
      return;
    }
    if (tab !== "rms_charge") {
      setRmsProgramPickerOpen(false);
      return;
    }
    void resolveRmsAccount();
  }, [isOpen, tab, rmsPaymentCollectionMode, resolveRmsAccount]);

  const rmsEligiblePrograms = useMemo(
    () => rmsPrograms.filter((program) => program.eligible),
    [rmsPrograms],
  );

  const rmsSelectedProgram = useMemo(
    () =>
      rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode) ?? null,
    [rmsPrograms, rmsSelectedProgramCode],
  );

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

    if (tab === "rms_charge") {
      if (!customerId) {
        toast("Attach a customer before using RMS Charge.", "error");
        return;
      }
      if (!rmsSelectedAccount) {
        toast("Select an RMS Charge account before adding payment.", "error");
        return;
      }
      const selectedProgram = rmsPrograms.find(
        (program) => program.program_code === rmsSelectedProgramCode,
      );
      if (!selectedProgram) {
        toast("Select an eligible RMS Charge program before adding payment.", "error");
        return;
      }
    }

    if (rmsPaymentCollectionMode) {
      if (!customerId) {
        toast("Attach a customer before collecting an RMS Charge payment.", "error");
        return;
      }
      if (!rmsSelectedAccount) {
        toast("Resolve the customer's RMS Charge account before adding payment.", "error");
        return;
      }
    }

    const isRmsCollectionTender = rmsPaymentCollectionMode && ["cash", "check"].includes(tab);

    setApplied((prev) => [
      ...prev,
      {
        id: newId(),
        method: meta.method,
        sub_type: tab === "gift_card" ? (giftCardSubType ?? "paid_liability") : undefined,
        gift_card_code: tab === "gift_card" ? giftCardCode.trim() : undefined,
        amountCents: amtCents,
        label:
          tab === "gift_card"
            ? `Gift Card (${giftCardTypeLabel(giftCardSubType ?? "paid_liability")})`
            : tab === "rms_charge"
              ? `RMS Charge${rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode)?.program_label ? ` • ${rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode)?.program_label}` : ""}`
              : meta.label,
        metadata:
          tab === "check"
            ? {
                check_number: checkNumber.trim() || null,
                ...(rmsPaymentCollectionMode
                  ? {
                      rms_charge_collection: true,
                      tender_family: "rms_charge",
                      masked_account: rmsSelectedAccount?.masked_account ?? undefined,
                      linked_corecredit_customer_id:
                        rmsSelectedAccount?.corecredit_customer_id ?? undefined,
                      linked_corecredit_account_id:
                        rmsSelectedAccount?.corecredit_account_id ?? undefined,
                      resolution_status:
                        rmsSummary?.resolution_status ??
                        rmsResolve?.resolution_status ??
                        "selected",
                    }
                  : {}),
              }
            : tab === "rms_charge"
              ? {
                  tender_family: "rms_charge",
                  program_code: rmsSelectedProgramCode ?? undefined,
                  program_label:
                    rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode)?.program_label ?? undefined,
                  masked_account: rmsSelectedAccount?.masked_account ?? undefined,
                  linked_corecredit_customer_id: rmsSelectedAccount?.corecredit_customer_id ?? undefined,
                  linked_corecredit_account_id: rmsSelectedAccount?.corecredit_account_id ?? undefined,
                  resolution_status:
                    rmsSummary?.resolution_status ??
                    rmsResolve?.resolution_status ??
                    "selected",
                }
              : isRmsCollectionTender
                ? {
                    ...(meta.method === "check"
                      ? { check_number: checkNumber.trim() || null }
                      : {}),
                    rms_charge_collection: true,
                    tender_family: "rms_charge",
                    masked_account: rmsSelectedAccount?.masked_account ?? undefined,
                    linked_corecredit_customer_id:
                      rmsSelectedAccount?.corecredit_customer_id ?? undefined,
                    linked_corecredit_account_id:
                      rmsSelectedAccount?.corecredit_account_id ?? undefined,
                    resolution_status:
                      rmsSummary?.resolution_status ??
                      rmsResolve?.resolution_status ??
                      "selected",
                  }
              : undefined,
      },
    ]);
    setKeypad("");
    setGiftCardCode("");
    setCheckNumber("");
  }, [giftCardSubType, giftCardCode, checkNumber, remainingCents, tab, baseUrl, backofficeHeaders, customerId, selectedVaultedPmId, vaultedMethods, handleStripeSuccess, toast, setApplied, rmsSelectedAccount, rmsPrograms, rmsSelectedProgramCode, rmsSummary, rmsResolve, rmsPaymentCollectionMode]);

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

  const payBalance = useCallback(() => {
    // We send the absolute value to the keypad for the cashier to confirm or adjust.
    const amt = tab === "cash" ? Math.abs(cashRounding.rounded) : Math.abs(remainingCents);
    setKeypad(centsToFixed2(amt));
  }, [cashRounding.rounded, remainingCents, tab]);

  const splitBalance = useCallback(() => {
    const sourceAmount =
      tab === "cash" ? Math.abs(cashRounding.rounded) : Math.abs(remainingCents);
    const halfAmount = Math.max(0, Math.round(sourceAmount / 2));
    setKeypad(centsToFixed2(halfAmount));
  }, [cashRounding.rounded, remainingCents, tab]);

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
           
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-6">
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

              <div className="flex w-full gap-3 sm:w-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text sm:px-6"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={!canFinalize || busy}
                  data-testid="pos-finalize-checkout"
                  title={completeDisabledReason}
                  onClick={handleFinalize}
                  className={`flex h-14 w-full items-center justify-center gap-2 rounded-2xl px-6 text-sm font-black uppercase tracking-[0.2em] transition-all sm:min-w-[170px] sm:w-auto sm:px-8 ${
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
      <div className="relative flex h-full flex-col bg-app-bg overflow-hidden">
        
        {busy && (
          <div className="absolute inset-0 z-50 bg-white/60 dark:bg-black/60 backdrop-blur-md flex flex-col items-center justify-center">
             <div className="h-20 w-20 rounded-full border-4 border-app-accent border-t-transparent animate-spin mb-6" />
             <p className="text-xl font-black uppercase italic tracking-wider text-app-text">Completing Transaction...</p>
          </div>
        )}

        {tab === "rms_charge" &&
          !rmsPaymentCollectionMode &&
          rmsProgramPickerOpen &&
          rmsSelectedAccount &&
          rmsEligiblePrograms.length > 0 && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm">
              <div
                data-testid="pos-rms-program-modal"
                className="w-full max-w-xl rounded-3xl border border-app-border bg-app-surface p-6 shadow-2xl"
              >
                <div className="mb-5">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    RMS Charge
                  </p>
                  <h3 className="mt-2 text-2xl font-black italic tracking-tight text-app-text">
                    Choose Plan
                  </h3>
                  <p className="mt-2 text-sm text-app-text-muted">
                    Select the customer's RMS Charge plan to continue.
                  </p>
                </div>

                <div className="mb-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Linked Account
                  </p>
                  <p className="mt-1 text-lg font-black italic text-app-text">
                    {rmsSelectedAccount.masked_account}
                  </p>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                    Account status: {rmsSummary?.account_status ?? rmsSelectedAccount.status}
                  </p>
                </div>

                <div className="grid gap-3">
                  {rmsEligiblePrograms.map((program) => (
                    <button
                      key={program.program_code}
                      type="button"
                      data-testid={`pos-rms-program-${program.program_code}`}
                      onClick={() => {
                        setRmsSelectedProgramCode(program.program_code);
                        setRmsProgramPickerOpen(false);
                      }}
                      className="rounded-2xl border border-app-border bg-app-bg px-4 py-4 text-left transition-all hover:border-app-accent hover:bg-app-accent/5"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-black uppercase tracking-wide text-app-text">
                          {program.program_label}
                        </span>
                        <span className="rounded-full bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent">
                          Choose
                        </span>
                      </div>
                      {program.disclosure ? (
                        <p className="mt-2 text-[11px] text-app-text-muted">
                          {program.disclosure}
                        </p>
                      ) : null}
                    </button>
                  ))}
                </div>

                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setRmsProgramPickerOpen(false);
                      setRmsSelectedProgramCode(null);
                      setTab("cash");
                    }}
                    className="rounded-xl border border-app-border bg-app-bg px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                  >
                    Cancel RMS Charge
                  </button>
                </div>
              </div>
            </div>
          )}

        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
          <div className="flex min-h-0 flex-1 flex-col items-stretch gap-4 lg:flex-row lg:items-start lg:justify-center lg:gap-5">
            
            {/* 1. Tender Tabs Matrix (Left) */}
            <div className="w-full shrink-0 pb-1 lg:w-48 lg:pb-4">
              <span className="text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted mb-2 px-1 opacity-60">Revenue Methods</span>
              <div className="no-scrollbar flex gap-2 overflow-x-auto lg:flex-col lg:overflow-y-auto lg:overflow-x-visible">
                {tenderTabIds.map((id) => {
                  const meta = TAB_META[id];
                  const Icon = meta.icon;
                  const isActive = tab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      data-testid={id === "rms_charge" ? "pos-tender-rms-charge" : undefined}
                      onClick={() => { setTab(id); setKeypad(""); }}
                      className={`flex h-14 min-w-[132px] items-center gap-3 rounded-2xl px-3 text-left shadow-sm transition-all sm:min-w-[160px] lg:h-16 lg:w-full lg:min-w-0 lg:gap-4 lg:px-4 ${isActive ? `${meta.active} scale-[1.02] z-10` : meta.idle}`}
                    >
                      <Icon size={20} className={isActive ? "" : "opacity-40"} />
                      <span className="truncate text-[10px] font-black uppercase tracking-widest lg:text-[11px]">{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-4">
              <div className="bg-app-surface border border-app-border rounded-2xl p-4 sm:p-5 shadow-sm flex flex-col">
                <div className="mb-5 flex flex-col gap-3 border-b border-app-border pb-4 sm:flex-row sm:items-end sm:justify-between">
                  <div className="flex flex-col gap-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted leading-none opacity-60">
                      Quick Amount
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={payBalance}
                        className="inline-flex items-center justify-center px-4 h-9 rounded-full bg-app-accent text-[10px] font-black text-white uppercase italic tracking-wider hover:brightness-110 active:scale-95 shadow-lg shadow-app-accent/20 transition-all border-b-2 border-app-accent-hover"
                      >
                        Pay Balance
                      </button>
                      <button
                        type="button"
                        onClick={splitBalance}
                        className="inline-flex items-center justify-center px-4 h-9 rounded-full border border-app-border bg-app-surface text-[10px] font-black uppercase italic tracking-wider text-app-text-muted hover:border-app-input-border hover:text-app-text active:scale-95 transition-all"
                      >
                        Split Balance
                      </button>
                    </div>
                  </div>
                  <div className="text-3xl font-black tabular-nums tracking-tighter italic leading-none text-app-text sm:text-4xl lg:text-5xl">
                    ${keypad || "0.00"}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex justify-center">
                    <div className="w-full max-w-md">
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
                        disabled={
                          keypadCents <= 0 ||
                          (tab === "gift_card" && giftCardCode.length < 4) ||
                          (tab === "rms_charge" &&
                            (!customerId ||
                              !rmsSelectedAccount ||
                              !rmsPrograms.some(
                                (program) =>
                                  program.program_code === rmsSelectedProgramCode &&
                                  program.eligible,
                              ))) ||
                          (rmsPaymentCollectionMode &&
                            (tab === "cash" || tab === "check") &&
                            (!customerId || !rmsSelectedAccount)) ||
                          busy
                        }
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

                {(tab === "gift_card" ||
                  tab === "card_saved" ||
                  tab === "check" ||
                  tab === "rms_charge" ||
                  (rmsPaymentCollectionMode && ["cash", "check"].includes(tab))) && (
                  <div className="mt-6 max-h-[42vh] overflow-y-auto border-t border-app-border pt-6 pr-1 animate-in slide-in-from-top-2 sm:max-h-[32vh]">
                    {tab === "rms_charge" && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-app-border bg-app-bg px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            How RMS Charge works
                          </p>
                          <div className="mt-2 space-y-1.5 text-[11px] font-medium leading-relaxed text-app-text-muted">
                            <p>RMS Charge always starts with an attached Riverside customer and a resolved linked RMS account.</p>
                            <p>New RMS charges also require an eligible plan before the payment line can be added.</p>
                            <p>RMS payments post against the selected RMS account. They are not the same thing as taking a standard retail cash or check tender.</p>
                          </div>
                        </div>
                        {!customerId ? (
                          <div className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm font-semibold text-amber-700">
                            Attach a customer before using RMS Charge.
                          </div>
                        ) : rmsLoading ? (
                          <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                            Resolving linked RMS Charge account…
                          </div>
                        ) : rmsResolve?.resolution_status === "blocked" ? (
                          <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 p-4 text-sm font-semibold text-rose-700">
                            {rmsResolve.blocking_error?.message ?? "RMS Charge is unavailable for this customer."}
                          </div>
                        ) : rmsResolve?.resolution_status === "multiple" ? (
                          <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Select Account
                            </p>
                            <div className="grid gap-2">
                              {rmsResolve.choices.map((choice) => (
                                <button
                                  key={choice.link_id}
                                  type="button"
                                  data-testid="pos-rms-account-choice"
                                  onClick={() => void resolveRmsAccount(choice.corecredit_account_id)}
                                  className="flex items-center justify-between rounded-xl border border-app-border bg-app-bg px-4 py-3 text-left transition-colors hover:border-app-accent"
                                >
                                  <div className="flex flex-col">
                                    <span className="text-sm font-black uppercase tracking-wide text-app-text">
                                      {choice.masked_account}
                                    </span>
                                    <span className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                      {choice.status}
                                    </span>
                                  </div>
                                  {choice.is_primary ? (
                                    <span className="rounded-full bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent">
                                      Primary
                                    </span>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : rmsSelectedAccount ? (
                          <div className="space-y-3">
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                              <div className="flex items-center justify-between gap-4">
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                    Linked Account
                                  </p>
                                  <p className="text-lg font-black italic text-app-text">
                                    {rmsSelectedAccount.masked_account}
                                  </p>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                    Status: {rmsSummary?.account_status ?? rmsSelectedAccount.status}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void resolveRmsAccount()}
                                  className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                                >
                                  Refresh
                                </button>
                              </div>
                              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                                <div className="rounded-lg bg-app-surface px-3 py-2">
                                  <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                    Available Credit
                                  </div>
                                  <div className="mt-1 font-black text-app-text">
                                    {rmsSummary?.available_credit ?? "Linked account"}
                                  </div>
                                </div>
                                <div className="rounded-lg bg-app-surface px-3 py-2">
                                  <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                    Current Balance
                                  </div>
                                  <div className="mt-1 font-black text-app-text">
                                    {rmsSummary?.current_balance ?? "Pending live sync"}
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-bg px-4 py-3">
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                    Selected Plan
                                  </p>
                                  <p className="mt-1 text-sm font-black uppercase tracking-wide text-app-text">
                                    {rmsSelectedProgram?.program_label ?? "Choose plan"}
                                  </p>
                                  {!rmsSelectedProgram ? (
                                    <p className="mt-1 text-[11px] text-amber-600">
                                      Choose a plan before continuing.
                                    </p>
                                  ) : rmsSelectedProgram.disclosure ? (
                                    <p className="mt-1 text-[11px] text-app-text-muted">
                                      {rmsSelectedProgram.disclosure}
                                    </p>
                                  ) : null}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setRmsProgramPickerOpen(true)}
                                  className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                                >
                                  {rmsSelectedProgram ? "Change Plan" : "Choose Plan"}
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}

                    {rmsPaymentCollectionMode && (tab === "cash" || tab === "check") && (
                      <div className="space-y-3 mb-4">
                        <div className="rounded-xl border border-app-border bg-app-bg px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            RMS payment rule
                          </p>
                          <p className="mt-2 text-[11px] font-medium leading-relaxed text-app-text-muted">
                            In RMS payment mode, this cash or check entry posts to the selected RMS account balance. Keep it separate from a normal retail payment on the sale.
                          </p>
                        </div>
                        {!customerId ? (
                          <div className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm font-semibold text-amber-700">
                            Attach a customer before collecting an RMS Charge payment.
                          </div>
                        ) : rmsLoading ? (
                          <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                            Resolving RMS Charge account…
                          </div>
                        ) : rmsResolve?.resolution_status === "blocked" ? (
                          <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 p-4 text-sm font-semibold text-rose-700">
                            {rmsResolve.blocking_error?.message ?? "RMS Charge payment collection is unavailable for this customer."}
                          </div>
                        ) : rmsResolve?.resolution_status === "multiple" ? (
                          <div className="space-y-2">
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Select RMS Account
                            </p>
                            <div className="grid gap-2">
                              {rmsResolve.choices.map((choice) => (
                                <button
                                  key={choice.link_id}
                                  type="button"
                                  data-testid="pos-rms-account-choice"
                                  onClick={() => void resolveRmsAccount(choice.corecredit_account_id)}
                                  className="flex items-center justify-between rounded-xl border border-app-border bg-app-bg px-4 py-3 text-left transition-colors hover:border-app-accent"
                                >
                                  <div className="flex flex-col">
                                    <span className="text-sm font-black uppercase tracking-wide text-app-text">
                                      {choice.masked_account}
                                    </span>
                                    <span className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                      {choice.status}
                                    </span>
                                  </div>
                                  {choice.is_primary ? (
                                    <span className="rounded-full bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent">
                                      Primary
                                    </span>
                                  ) : null}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : rmsSelectedAccount ? (
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                  RMS Payment Account
                                </p>
                                <p className="text-lg font-black italic text-app-text">
                                  {rmsSelectedAccount.masked_account}
                                </p>
                                <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                  Status: {rmsSummary?.account_status ?? rmsSelectedAccount.status}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => void resolveRmsAccount()}
                                className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                              >
                                Refresh
                              </button>
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3 text-[11px]">
                              <div className="rounded-lg bg-app-surface px-3 py-2">
                                <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                  Available Credit
                                </div>
                                <div className="mt-1 font-black text-app-text">
                                  {rmsSummary?.available_credit ?? "Linked account"}
                                </div>
                              </div>
                              <div className="rounded-lg bg-app-surface px-3 py-2">
                                <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                                  Current Balance
                                </div>
                                <div className="mt-1 font-black text-app-text">
                                  {rmsSummary?.current_balance ?? "Pending live sync"}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}

                    {tab === "gift_card" && (
                      <div className="flex flex-col sm:flex-row gap-4">
                        <div className="flex w-full gap-1 rounded-xl border border-app-border bg-app-bg p-1 sm:w-72">
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
            <div className="flex h-full min-h-0 w-full shrink-0 flex-col gap-4 lg:w-72">
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
                           {p.metadata?.program_label && p.metadata?.masked_account && (
                             <span className="text-[8px] font-mono text-zinc-500 truncate mt-0.5 opacity-60">
                               {p.metadata.program_label} · {p.metadata.masked_account}
                             </span>
                           )}
                           {p.metadata?.rms_charge_collection && p.metadata?.masked_account && !p.metadata?.program_label && (
                             <span className="text-[8px] font-mono text-zinc-500 truncate mt-0.5 opacity-60">
                               RMS Payment · {p.metadata.masked_account}
                             </span>
                           )}
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
                          <span className="text-[10px] font-black uppercase italic text-indigo-200">Deposit Due Today</span>
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
                        <span className="text-[8px] font-black uppercase tracking-[0.15em]">Collect Now</span>
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
          <StripeReaderSimulation
            amountCents={pendingStripeCentsRef.current}
            moto={tab === "card_manual"}
            onSuccess={handleStripeSuccess}
            onCancel={() => {
              setShowStripeSimulation(false);
              setStripeIntent(null);
              pendingStripeCentsRef.current = 0;
            }}
          />
        )}
      </div>
    </DetailDrawer>
  );
}
