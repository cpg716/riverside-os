import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Sparkles,
  Layers,
  AlertTriangle,
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import NumericPinKeypad from "../ui/NumericPinKeypad";
import { centsToFixed2, parseMoneyToCents, calculateSwedishRounding } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import { 
  type AppliedPaymentLine, 
  type CheckoutOperatorContext, 
  type NexoTenderTab
} from "./types";

interface PaymentProviderSettings {
  active_provider: "helcim";
  helcim: {
    enabled: boolean;
    terminal_1_device_configured?: boolean;
    terminal_2_device_configured?: boolean;
    terminal_payments_ready: boolean;
    live_terminal_payments_ready: boolean;
    simulator_enabled?: boolean;
    terminal_1_device_code_suffix?: string | null;
    terminal_2_device_code_suffix?: string | null;
    api_base_host: string;
    missing_config: string[];
  };
  helcim_terminal_routing?: {
    terminals: Array<{
      key: "terminal_1" | "terminal_2";
      label: string;
      configured: boolean;
      in_use_by_register_lane?: number | null;
      active_attempt_id?: string | null;
    }>;
    registers: Array<{
      register_lane: number;
      default_terminal_key?: "terminal_1" | "terminal_2" | null;
      allowed_terminal_keys: Array<"terminal_1" | "terminal_2">;
      choice_required: boolean;
      non_default_override_requires_permission: boolean;
    }>;
  };
}

interface HelcimAttempt {
  id: string;
  status: "pending" | "approved" | "captured" | "canceled" | "failed" | "expired";
  amount_cents: number;
  currency: string;
  terminal_id?: string | null;
  selected_terminal_key?: "terminal_1" | "terminal_2" | null;
  terminal_route_source?: "default" | "required_choice" | "override" | null;
  provider_payment_id?: string | null;
  provider_transaction_id?: string | null;
  provider_auth_code?: string | null;
  provider_card_type?: string | null;
  card_brand?: string | null;
  card_last4?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  safe_message?: string | null;
  raw_audit_reference?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
}

function rmsSourceLabel(source?: string | null) {
  if (source === "corecard_live") return "Live CoreCard";
  if (source === "manual" || source === "local_fallback") return "Manual RMS Charge";
  if (source === "unavailable") return "Unavailable";
  return source || "Manual RMS Charge";
}

interface HelcimCard {
  id?: number | string | null;
  cardToken?: string | null;
  cardHolderName?: string | null;
  cardF6L4?: string | null;
  cardExpiry?: string | null;
  cardType?: string | null;
  default?: boolean | number | string | null;
  isDefault?: boolean | number | string | null;
}

interface HelcimCustomer {
  id?: number | string | null;
  customerCode?: string | null;
  cards?: HelcimCard[] | null;
}

function firstHelcimCustomers(value: unknown): HelcimCustomer[] {
  if (Array.isArray(value)) return value as HelcimCustomer[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data as HelcimCustomer[];
  if (Array.isArray(record.customers)) return record.customers as HelcimCustomer[];
  return [];
}

function helcimCardLabel(card: HelcimCard): string {
  const last = String(card.cardF6L4 ?? "").replace(/\D/g, "").slice(-4);
  const brand = String(card.cardType ?? "Card").trim() || "Card";
  const expiry = String(card.cardExpiry ?? "").trim();
  return `${brand}${last ? ` • ${last}` : ""}${expiry ? ` • ${expiry}` : ""}`;
}

function terminalLabel(key: "terminal_1" | "terminal_2"): string {
  return key === "terminal_1" ? "Terminal 1" : "Terminal 2";
}

function terminalNumber(key: "terminal_1" | "terminal_2"): string {
  return key === "terminal_1" ? "1" : "2";
}

function isStaleHelcimSessionError(message: string): boolean {
  return message.toLowerCase().includes("does not belong to this register session");
}

const HELCIM_UNVERIFIED_OUTCOME_MESSAGE =
  "Card outcome is unresolved. Do not start another card attempt until Payments Health or support confirms the outcome.";

function helcimAttemptStatusLabel(status: HelcimAttempt["status"]): string {
  if (status === "pending") return "Waiting on Terminal";
  if (status === "approved" || status === "captured") return "Card Approved";
  if (status === "failed") return "Declined";
  if (status === "canceled") return "Canceled";
  return "Outcome Unresolved";
}

function helcimAttemptTerminalName(attempt: HelcimAttempt): string {
  if (attempt.selected_terminal_key) return terminalLabel(attempt.selected_terminal_key);
  return attempt.terminal_id ? `Terminal ${attempt.terminal_id}` : "Terminal not ready";
}

function helcimAttemptAgeLabel(attempt: HelcimAttempt): string {
  const started = new Date(attempt.created_at).getTime();
  if (!Number.isFinite(started)) return "Age not ready";
  const ended = attempt.completed_at ? new Date(attempt.completed_at).getTime() : Date.now();
  const elapsedMs = Math.max(0, (Number.isFinite(ended) ? ended : Date.now()) - started);
  const elapsedMinutes = Math.floor(elapsedMs / 60000);
  if (elapsedMinutes < 1) return "Less than 1 min";
  if (elapsedMinutes < 60) return `${elapsedMinutes} min`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  const remainingMinutes = elapsedMinutes % 60;
  return remainingMinutes > 0 ? `${elapsedHours} hr ${remainingMinutes} min` : `${elapsedHours} hr`;
}

function helcimAttemptSafeNextAction(attempt: HelcimAttempt): string {
  if (attempt.status === "pending") return "Wait for the terminal, then check the status.";
  if (attempt.status === "approved" || attempt.status === "captured") {
    return "Card approved. Finish checkout so ROS records the payment.";
  }
  if (attempt.status === "failed") return "Card was declined. Start a new attempt only if the customer wants to try again.";
  if (attempt.status === "canceled") return "Canceled on terminal. Start a new attempt only if the customer still wants to pay by card.";
  return HELCIM_UNVERIFIED_OUTCOME_MESSAGE;
}

function helcimAttemptDetail(attempt: HelcimAttempt): string {
  if (attempt.status === "pending") {
    return `Sent to ${helcimAttemptTerminalName(attempt)}.`;
  }

  if (attempt.status === "approved" || attempt.status === "captured") {
    return "Card approved by processor. Finish checkout so ROS records the payment.";
  }

  if (attempt.status === "expired") return HELCIM_UNVERIFIED_OUTCOME_MESSAGE;

  return attempt.error_message ?? "Card attempt was not approved.";
}

function normalizeRegisterLane(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4
    ? value
    : null;
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
  source?: string | null;
  fallback_used?: boolean;
  warning_code?: string | null;
  credential_source?: string | null;
  last_corecard_request_at?: string | null;
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
  fallback_used?: boolean;
  warning_code?: string | null;
  credential_source?: string | null;
  last_corecard_request_at?: string | null;
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
    label: "CARD READER",
    method: "card_terminal",
    icon: CreditCard,
    idle: "bg-blue-500/5 border border-app-border text-app-text-muted hover:border-blue-500/40",
    active: "bg-blue-600 border border-transparent text-white shadow-lg",
    accent: "text-blue-500",
  },
  card_manual: {
    label: "MANUAL CARD",
    method: "card_manual",
    icon: CreditCard,
    idle: "bg-zinc-500/5 border border-app-border text-app-text-muted hover:border-zinc-500/40",
    active: "bg-zinc-800 border border-transparent text-white shadow-lg",
    accent: "text-zinc-500",
  },
  card_saved: {
    label: "SAVED CARD",
    method: "card_saved",
    icon: CreditCard,
    idle: "bg-indigo-500/5 border border-app-border text-app-text-muted hover:border-indigo-500/40",
    active: "bg-indigo-600 border border-transparent text-white shadow-lg",
    accent: "text-indigo-500",
  },
  card_credit: {
    label: "CARD REFUND",
    method: "card_credit",
    icon: CreditCard,
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

function customerTaxExemptReason(taxId?: string | null): string {
  const id = taxId?.trim();
  return id ? `Customer tax exempt (${id})` : "Customer tax exempt";
}

export interface NexoCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  activeRegisterLane?: number | null;
  amountDueCents: number;
  stateTaxCents: number;
  localTaxCents: number;
  shippingCents: number;
  weddingLinked: boolean;
  customerId?: string | null;
  customerName?: string | null;
  customerCode?: string | null;
  customerTaxExempt?: boolean;
  customerTaxExemptId?: string | null;
  originalHelcimTransactionIdForRefund?: string | number | null;
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

export default function NexoCheckoutDrawer({
  isOpen,
  onClose,
  activeRegisterLane = null,
  amountDueCents,
  stateTaxCents,
  localTaxCents,
  customerId,
  customerCode,
  customerTaxExempt = false,
  customerTaxExemptId = null,
  originalHelcimTransactionIdForRefund = null,
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
  const [giftCardCode, setGiftCardCode] = useState("");
  const giftCardInputRef = useRef<HTMLInputElement | null>(null);
  const completeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [checkNumber, setCheckNumber] = useState("");
  const [refundOriginalTransactionId, setRefundOriginalTransactionId] = useState("");
  const [providerSettings, setProviderSettings] = useState<PaymentProviderSettings | null>(null);
  const [providerSettingsLoading, setProviderSettingsLoading] = useState(false);
  const [providerSettingsError, setProviderSettingsError] = useState<string | null>(null);
  const [helcimAttempt, setHelcimAttempt] = useState<HelcimAttempt | null>(null);
  const [helcimUnverifiedNotice, setHelcimUnverifiedNotice] = useState<string | null>(null);
  const [helcimAttemptLoading, setHelcimAttemptLoading] = useState(false);
  const [helcimCards, setHelcimCards] = useState<HelcimCard[]>([]);
  const [selectedHelcimCardToken, setSelectedHelcimCardToken] = useState<string>("");
  const [helcimCardsLoading, setHelcimCardsLoading] = useState(false);
  const [selectedTerminalKey, setSelectedTerminalKey] = useState<"terminal_1" | "terminal_2" | "">("");
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false);
  const [terminalOverrideConfirmed, setTerminalOverrideConfirmed] = useState(false);

  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [taxExemptReason, setTaxExemptReason] = useState("Out of State");
  const [taxExemptNote, setTaxExemptNote] = useState("");
  
  const [rmsResolve, setRmsResolve] = useState<RmsChargeResolveResponse | null>(null);
  const [rmsSelectedAccount, setRmsSelectedAccount] = useState<RmsChargeAccountChoice | null>(null);
  const [rmsPrograms, setRmsPrograms] = useState<RmsChargeProgramOption[]>([]);
  const [rmsSelectedProgramCode, setRmsSelectedProgramCode] = useState<string | null>(null);
  const [rmsReferenceNumber, setRmsReferenceNumber] = useState("");
  const [rmsSummary, setRmsSummary] = useState<RmsChargeAccountSummary | null>(null);
  const [rmsLoading, setRmsLoading] = useState(false);
  const [rmsProgramPickerOpen, setRmsProgramPickerOpen] = useState(false);

  useEffect(() => {
    if (!isOpen || tab !== "gift_card") return;
    const frame = window.requestAnimationFrame(() => {
      giftCardInputRef.current?.focus();
      giftCardInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, tab]);
  const pendingHelcimCentsRef = useRef<number>(0);
  const pendingHelcimTenderRef = useRef<{
    method: "card_terminal" | "card_manual" | "card_credit";
    label: string;
  }>({ method: "card_terminal", label: "HELCIM CARD" });
  const registerLane = useMemo(() => normalizeRegisterLane(activeRegisterLane), [activeRegisterLane]);
  const registerLaneUnavailable = registerLane === null;
  const registerTerminalRoute = useMemo(
    () =>
      providerSettings?.helcim_terminal_routing?.registers.find(
        (route) => route.register_lane === registerLane,
      ) ?? null,
    [providerSettings?.helcim_terminal_routing?.registers, registerLane],
  );
  const terminalStatuses = providerSettings?.helcim_terminal_routing?.terminals ?? [];
  const selectedTerminalIsDefault =
    Boolean(selectedTerminalKey) &&
    registerTerminalRoute?.default_terminal_key === selectedTerminalKey;
  const selectedTerminalNeedsOverride =
    Boolean(selectedTerminalKey) &&
    Boolean(registerTerminalRoute?.default_terminal_key) &&
    !selectedTerminalIsDefault &&
    Boolean(registerTerminalRoute?.non_default_override_requires_permission);
  const selectedTerminalStatus = selectedTerminalKey
    ? terminalStatuses.find((terminal) => terminal.key === selectedTerminalKey)
    : null;
  const selectedTerminalInUseBy = selectedTerminalStatus?.in_use_by_register_lane;
  const selectedTerminalInUseByCurrentRegister =
    selectedTerminalInUseBy != null && registerLane != null && selectedTerminalInUseBy === registerLane;
  const selectedTerminalInUseByOtherRegister =
    selectedTerminalInUseBy != null && !selectedTerminalInUseByCurrentRegister;
  const selectedTerminalActiveAttemptId = selectedTerminalStatus?.active_attempt_id ?? null;
  const helcimAttemptOutcomeUnverified = helcimAttempt?.status === "expired" || Boolean(helcimUnverifiedNotice);
  const helcimAttemptRetryUnavailable =
    helcimAttempt?.status === "pending" || helcimAttemptOutcomeUnverified;
  const terminalSelectionReady =
    providerSettings?.active_provider === "helcim" &&
    providerSettings.helcim.enabled &&
    providerSettings.helcim.terminal_payments_ready &&
    !registerLaneUnavailable &&
    Boolean(registerTerminalRoute) &&
    Boolean(selectedTerminalKey) &&
    Boolean(selectedTerminalStatus?.configured) &&
    !selectedTerminalInUseByOtherRegister &&
    !helcimAttemptRetryUnavailable &&
    (!selectedTerminalNeedsOverride || terminalOverrideConfirmed);
  const terminalStatusText = providerSettingsLoading
    ? "Checking"
    : providerSettingsError
      ? "Unavailable"
      : !providerSettings?.helcim.enabled
        ? "Not configured"
        : !providerSettings.helcim.terminal_payments_ready
          ? "Setup needed"
          : registerLaneUnavailable
            ? "No register"
            : !registerTerminalRoute
              ? "Routing missing"
              : !selectedTerminalKey
                ? "Choose terminal"
                : selectedTerminalInUseByOtherRegister
                  ? `In use R${selectedTerminalInUseBy}`
                  : selectedTerminalInUseByCurrentRegister
                    ? "Active here"
                  : helcimAttemptOutcomeUnverified
                    ? "Review needed"
                  : selectedTerminalNeedsOverride && !terminalOverrideConfirmed
                    ? "Confirm terminal"
                    : "Ready";
  const tenderTabIds = useMemo(() => {
    const all = Object.keys(TAB_META) as NexoTenderTab[];
    const isRefundCheckout = amountDueCents < 0;
    let base = allowStoreCredit ? all : all.filter((id) => id !== "store_credit");
    if (rmsPaymentCollectionMode) {
      base = base.filter((id) => id === "cash" || id === "check");
    }
    if (isRefundCheckout) {
      base = base.filter((id) => !["card_terminal", "card_manual", "card_saved"].includes(id));
    } else {
      base = base.filter((id) => id !== "card_credit");
    }
    return base;
  }, [allowStoreCredit, amountDueCents, rmsPaymentCollectionMode]);

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

  const cashRoundedBalanceSettled =
    tab === "cash" && remainingCents !== 0 && cashRounding.rounded === 0;
  const taxExemptNoteRequired =
    isTaxExempt &&
    !taxExemptReason.startsWith("Customer tax exempt") &&
    taxExemptNote.trim().length === 0;
  const taxExemptLedgerReason = useMemo(() => {
    if (!isTaxExempt) return undefined;
    const note = taxExemptNote.trim();
    return note ? `${taxExemptReason} - ${note}` : taxExemptReason;
  }, [isTaxExempt, taxExemptNote, taxExemptReason]);

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

  const balanceSettled = fullBalancePaid || cashRoundedBalanceSettled;
  
  /** 
   * A sale is "Balanced" if:
   * 1. The full balance is paid with tenders.
   * 2. Any takeaway items are paid with tenders AND a deposit protocol is established for the remainder.
   */
  const balanced = balanceSettled || (takeawaySatisfied && hasLaterItems && (depositDisplayCents > 0 || allowDepositOnlyComplete));

  const canFinalize = balanced && operator != null && !busy && !taxExemptNoteRequired;

  useEffect(() => {
    if (!isOpen || !canFinalize) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const tagName = active.tagName.toLowerCase();
      if (
        tagName === "input" ||
        tagName === "textarea" ||
        tagName === "select" ||
        active.isContentEditable
      ) {
        return;
      }
    }
    const frame = window.requestAnimationFrame(() => {
      completeButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canFinalize, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setKeypad("");
      setTab(amountDueCents < 0 ? "card_credit" : rmsPaymentCollectionMode ? "cash" : "card_terminal");
      setGiftCardCode("");
      setCheckNumber("");
      setRefundOriginalTransactionId(
        originalHelcimTransactionIdForRefund == null
          ? ""
          : String(originalHelcimTransactionIdForRefund),
      );
      setHelcimAttempt(null);
      setHelcimUnverifiedNotice(null);
      pendingHelcimCentsRef.current = 0;
      pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
      setIsTaxExempt(customerTaxExempt);
      setTaxExemptReason(customerTaxExempt ? customerTaxExemptReason(customerTaxExemptId) : "Out of State");
      setTaxExemptNote("");
      setRmsResolve(null);
      setRmsSelectedAccount(null);
      setRmsPrograms([]);
      setRmsSelectedProgramCode(null);
      setRmsReferenceNumber("");
      setRmsSummary(null);
      setRmsProgramPickerOpen(false);
      setSelectedTerminalKey("");
      setTerminalOverrideConfirmed(false);
    }
  }, [amountDueCents, isOpen, originalHelcimTransactionIdForRefund, rmsPaymentCollectionMode, customerTaxExempt, customerTaxExemptId]);

  useEffect(() => {
    if (!isOpen) return;
    setProviderSettingsLoading(true);
    setProviderSettingsError(null);
    fetch(`${baseUrl}/api/payments/providers/active`, {
      headers: mergedPosStaffHeaders(backofficeHeaders),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Could not load payment provider.");
        }
        return res.json() as Promise<PaymentProviderSettings>;
      })
      .then((settings) => setProviderSettings(settings))
      .catch((error) => {
        setProviderSettings(null);
        setProviderSettingsError(
          error instanceof Error
            ? error.message
            : "Could not load payment provider.",
        );
      })
      .finally(() => setProviderSettingsLoading(false));
  }, [backofficeHeaders, baseUrl, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setTerminalOverrideConfirmed(false);
    if (!registerTerminalRoute) {
      setSelectedTerminalKey("");
      return;
    }
    if (registerTerminalRoute.choice_required) {
      setSelectedTerminalKey((current) =>
        current && registerTerminalRoute.allowed_terminal_keys.includes(current)
          ? current
          : "",
      );
      return;
    }
    setSelectedTerminalKey(registerTerminalRoute.default_terminal_key ?? "");
  }, [isOpen, registerTerminalRoute]);

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
        throw new Error("error" in body ? body.error ?? "Could not check RMS Charge" : "Could not check RMS Charge");
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
        error instanceof Error ? error.message : "Could not check RMS Charge";
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

  const addApprovedHelcimAttempt = useCallback(
    (
      attempt: HelcimAttempt,
      method: "card_terminal" | "card_manual" | "card_saved" | "card_credit" = "card_terminal",
      label = "HELCIM CARD",
    ) => {
      const isRefundAttempt =
        method === "card_credit" ||
        attempt.raw_audit_reference?.startsWith("helcim:terminalRefund") === true;
      const amtCents =
        pendingHelcimCentsRef.current ||
        (isRefundAttempt ? -Math.abs(attempt.amount_cents) : attempt.amount_cents);
      if (amtCents === 0) return;
      setApplied((prev) => [
        ...prev,
        {
          id: newId(),
          method: isRefundAttempt ? "card_credit" : method,
          amountCents: amtCents,
          label: isRefundAttempt ? "HELCIM REFUND" : label,
          metadata: {
            payment_provider: "helcim",
            payment_provider_attempt_id: attempt.id,
            provider_status: attempt.status,
            provider_payment_id: attempt.provider_payment_id ?? undefined,
            provider_transaction_id: attempt.provider_transaction_id ?? undefined,
            provider_terminal_id: attempt.terminal_id ?? undefined,
            selected_terminal_key: attempt.selected_terminal_key ?? undefined,
            terminal_route_source: attempt.terminal_route_source ?? undefined,
            provider_auth_code: attempt.provider_auth_code ?? undefined,
            provider_card_type: attempt.provider_card_type ?? undefined,
            card_brand: attempt.card_brand ?? undefined,
            card_last4: attempt.card_last4 ?? undefined,
          },
        },
      ]);
      setKeypad("");
      setHelcimAttempt(null);
      setHelcimUnverifiedNotice(null);
      pendingHelcimCentsRef.current = 0;
      pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
    },
    [setApplied],
  );

  const loadHelcimCards = useCallback(async () => {
    const code = customerCode?.trim();
    if (!code) {
      setHelcimCards([]);
      setSelectedHelcimCardToken("");
      return;
    }
    setHelcimCardsLoading(true);
    try {
      const params = new URLSearchParams({
        customer_code: code,
        include_cards: "true",
      });
      const res = await fetch(`${baseUrl}/api/payments/providers/helcim/customers?${params}`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      const body = (await res.json().catch(() => ({}))) as unknown;
      if (!res.ok) {
        const message =
          body && typeof body === "object" && "error" in body
            ? String((body as { error?: string }).error ?? "Could not load Helcim cards.")
            : "Could not load Helcim cards.";
        throw new Error(message);
      }
      const customer = firstHelcimCustomers(body)[0];
      const cards = Array.isArray(customer?.cards) ? customer.cards : [];
      setHelcimCards(cards);
      const defaultCard =
        cards.find((card) => card.default === true || card.default === 1 || card.isDefault === true || card.isDefault === 1) ??
        cards[0];
      setSelectedHelcimCardToken(defaultCard?.cardToken ?? "");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load Helcim cards.";
      setHelcimCards([]);
      setSelectedHelcimCardToken("");
      toast(message, "error");
    } finally {
      setHelcimCardsLoading(false);
    }
  }, [backofficeHeaders, baseUrl, customerCode, toast]);

  useEffect(() => {
    if (!isOpen || tab !== "card_saved") return;
    void loadHelcimCards();
  }, [isOpen, loadHelcimCards, tab]);

  const refreshHelcimAttempt = useCallback(
    async (
      attemptId: string,
      options: { quietStaleSession?: boolean } = {},
    ) => {
      setHelcimAttemptLoading(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/payments/providers/helcim/attempts/${attemptId}`,
          { headers: mergedPosStaffHeaders(backofficeHeaders) },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Could not check card status.");
        }
        const attempt = (await res.json()) as HelcimAttempt;
        setHelcimAttempt(attempt);
        setHelcimUnverifiedNotice(null);
        if (attempt.status === "approved" || attempt.status === "captured") {
          addApprovedHelcimAttempt(
            attempt,
            pendingHelcimTenderRef.current.method,
            pendingHelcimTenderRef.current.label,
          );
          toast("Card approved. Finish checkout so ROS records the payment.", "success");
        } else if (["failed", "canceled", "expired"].includes(attempt.status)) {
          pendingHelcimCentsRef.current = 0;
          pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
          toast(attempt.status === "expired" ? HELCIM_UNVERIFIED_OUTCOME_MESSAGE : attempt.error_message ?? "Card attempt was not approved.", "error");
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not check card status.";
        if (isStaleHelcimSessionError(message)) {
          setHelcimUnverifiedNotice(HELCIM_UNVERIFIED_OUTCOME_MESSAGE);
          if (!options.quietStaleSession) {
            toast(HELCIM_UNVERIFIED_OUTCOME_MESSAGE, "error");
          }
          return;
        }
        toast(message, "error");
      } finally {
        setHelcimAttemptLoading(false);
      }
    },
    [addApprovedHelcimAttempt, backofficeHeaders, baseUrl, toast],
  );

  useEffect(() => {
    if (!isOpen || !selectedTerminalInUseByCurrentRegister || !selectedTerminalActiveAttemptId) {
      return;
    }
    if (helcimAttempt?.id === selectedTerminalActiveAttemptId) {
      return;
    }
    void refreshHelcimAttempt(selectedTerminalActiveAttemptId, {
      quietStaleSession: true,
    });
  }, [
    helcimAttempt?.id,
    isOpen,
    refreshHelcimAttempt,
    selectedTerminalActiveAttemptId,
    selectedTerminalInUseByCurrentRegister,
  ]);

  const simulateHelcimAttempt = useCallback(
    async (attemptId: string, outcome: "approve" | "decline" | "cancel") => {
      setHelcimAttemptLoading(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/payments/providers/helcim/attempts/${attemptId}/simulate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...mergedPosStaffHeaders(backofficeHeaders),
            },
            body: JSON.stringify({ outcome }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Could not simulate Helcim payment.");
        }
        const attempt = (await res.json()) as HelcimAttempt;
        setHelcimAttempt(attempt);
        setHelcimUnverifiedNotice(null);
        if (attempt.status === "approved" || attempt.status === "captured") {
          addApprovedHelcimAttempt(
            attempt,
            pendingHelcimTenderRef.current.method,
            pendingHelcimTenderRef.current.label,
          );
          toast("Card approved. Finish checkout so ROS records the payment.", "success");
        } else if (["failed", "canceled", "expired"].includes(attempt.status)) {
          pendingHelcimCentsRef.current = 0;
          pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
          toast(attempt.status === "expired" ? HELCIM_UNVERIFIED_OUTCOME_MESSAGE : attempt.error_message ?? "Card attempt was not approved.", "info");
        }
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Could not simulate Helcim payment.",
          "error",
        );
      } finally {
        setHelcimAttemptLoading(false);
      }
    },
    [addApprovedHelcimAttempt, backofficeHeaders, baseUrl, toast],
  );

  const handlePendingTerminalCancel = useCallback(() => {
    if (!helcimAttempt || helcimAttempt.status !== "pending") return;
    if (providerSettings?.helcim.simulator_enabled) {
      void simulateHelcimAttempt(helcimAttempt.id, "cancel");
      return;
    }
    const label = helcimAttempt.selected_terminal_key
      ? terminalLabel(helcimAttempt.selected_terminal_key)
      : selectedTerminalKey
        ? terminalLabel(selectedTerminalKey)
        : "the terminal";
    toast(`Cancel on ${label}, then tap Check. Riverside will release the terminal when Helcim reports the cancel.`, "info");
  }, [helcimAttempt, providerSettings?.helcim.simulator_enabled, selectedTerminalKey, simulateHelcimAttempt, toast]);

  const releasePendingTerminalAttempt = useCallback(async () => {
    const attemptId =
      helcimAttempt?.status === "pending"
        ? helcimAttempt.id
        : selectedTerminalInUseByCurrentRegister
          ? selectedTerminalActiveAttemptId
          : null;
    if (!attemptId) {
      setTab("cash");
      setTerminalPickerOpen(false);
      return;
    }
    setHelcimAttemptLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/payments/providers/helcim/attempts/${attemptId}/release`,
        {
          method: "POST",
          headers: mergedPosStaffHeaders(backofficeHeaders),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not release the Helcim terminal attempt.");
      }
      const attempt = (await res.json()) as HelcimAttempt;
      setHelcimAttempt(attempt);
      pendingHelcimCentsRef.current = 0;
      pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
      setHelcimUnverifiedNotice(HELCIM_UNVERIFIED_OUTCOME_MESSAGE);
      setTab("cash");
      setTerminalPickerOpen(false);
      toast(HELCIM_UNVERIFIED_OUTCOME_MESSAGE, "error");
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not release the Helcim terminal attempt.",
        "error",
      );
    } finally {
      setHelcimAttemptLoading(false);
    }
  }, [
    backofficeHeaders,
    baseUrl,
    helcimAttempt?.id,
    helcimAttempt?.status,
    selectedTerminalActiveAttemptId,
    selectedTerminalInUseByCurrentRegister,
    toast,
  ]);

  const chargeSavedHelcimCard = useCallback(
    async (amtCents: number) => {
      const cardToken = selectedHelcimCardToken.trim();
      const code = customerCode?.trim();
      if (!cardToken) {
        toast("Select a Helcim saved card first.", "error");
        return;
      }
      setHelcimAttemptLoading(true);
      try {
        const res = await fetch(`${baseUrl}/api/payments/providers/helcim/card-token/purchase`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify({
            amount_cents: amtCents,
            card_token: cardToken,
            currency: "usd",
            customer_code: code || undefined,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as
          | HelcimAttempt
          | { error?: string };
        if (!res.ok || !("status" in body)) {
          throw new Error(
            "error" in body ? body.error ?? "Helcim saved card failed." : "Helcim saved card failed.",
          );
        }
        setHelcimAttempt(body);
        setHelcimUnverifiedNotice(null);
        if (body.status === "approved" || body.status === "captured") {
          pendingHelcimCentsRef.current = amtCents;
          addApprovedHelcimAttempt(body, "card_saved", "HELCIM VAULT");
          toast("Card approved. Finish checkout so ROS records the payment.", "success");
        } else {
          toast(body.error_message ?? "Helcim saved card was not approved.", "error");
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not charge Helcim saved card.", "error");
      } finally {
        setHelcimAttemptLoading(false);
      }
    },
    [
      addApprovedHelcimAttempt,
      backofficeHeaders,
      baseUrl,
      customerCode,
      selectedHelcimCardToken,
      toast,
    ],
  );

  useEffect(() => {
    if (!isOpen || helcimAttempt?.status !== "pending" || helcimAttemptLoading) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshHelcimAttempt(helcimAttempt.id);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [
    helcimAttempt?.id,
    helcimAttempt?.status,
    helcimAttemptLoading,
    isOpen,
    refreshHelcimAttempt,
  ]);

  const applyAmountToTab = useCallback(async (keypadCents: number) => {
    // Magnitude-based capping: we apply the keypad amount up to the magnitude of the remaining balance,
    // preserving the sign of the remaining balance.
    const absRem = Math.abs(remainingCents);
    const absKey = Math.abs(keypadCents);
    const cashRoundedAbsRem = Math.abs(cashRounding.rounded);
    const maxApplicableAbs = tab === "cash" ? cashRoundedAbsRem : absRem;
    const appliedAbs = Math.min(absKey, maxApplicableAbs);
    const amtCents = remainingCents < 0 ? -appliedAbs : appliedAbs;
    const cashChangeDueCents =
      tab === "cash" && remainingCents > 0 && absKey > cashRoundedAbsRem
        ? absKey - cashRoundedAbsRem
        : 0;

    if (amtCents === 0) return;

    if (["card_terminal", "card_manual", "card_saved", "card_credit"].includes(tab)) {
      if (providerSettingsLoading || !providerSettings) {
        toast("Confirm Helcim status before starting card payment.", "error");
        return;
      }
      if (providerSettingsError) {
        toast(providerSettingsError, "error");
        return;
      }
      if (!providerSettings.helcim.enabled) {
        toast("Helcim is not configured in Settings.", "error");
        return;
      }
      if (
        (tab === "card_terminal" || tab === "card_manual" || tab === "card_credit") &&
        !providerSettings.helcim.terminal_payments_ready
      ) {
        toast("Helcim terminal payments are not ready. Confirm Terminal 1 and Terminal 2 in Settings.", "error");
        return;
      }
      if (amtCents <= 0 && tab !== "card_credit") {
        toast("Helcim refunds are not enabled yet.", "error");
        return;
      }
      if (tab === "card_saved") {
        if (!customerCode?.trim()) {
          toast("Attach a customer before using Helcim saved cards.", "error");
          return;
        }
        await chargeSavedHelcimCard(amtCents);
        return;
      }
      if (tab !== "card_terminal" && tab !== "card_manual" && tab !== "card_credit") {
        toast("Use Helcim terminal, terminal refund, or saved card.", "error");
        return;
      }
      if (helcimAttempt?.status === "pending") {
        toast("A card outcome is still waiting on the terminal.", "error");
        return;
      }
      if (helcimAttemptOutcomeUnverified) {
        toast(HELCIM_UNVERIFIED_OUTCOME_MESSAGE, "error");
        return;
      }
      if (registerLaneUnavailable) {
        toast("Active register lane is unavailable. Reopen or rejoin the register before using a Helcim terminal.", "error");
        return;
      }
      if (!registerTerminalRoute) {
        toast("Terminal routing is not available for this register.", "error");
        return;
      }
      if (!selectedTerminalKey) {
        toast("Choose Terminal 1 or Terminal 2 before starting card payment.", "error");
        return;
      }
      if (selectedTerminalInUseByOtherRegister) {
        toast(`Selected terminal is in use by Register #${selectedTerminalInUseBy}.`, "error");
        return;
      }
      if (selectedTerminalNeedsOverride && !terminalOverrideConfirmed) {
        toast("Confirm the non-default terminal before starting card payment.", "error");
        return;
      }
      if (tab === "card_credit") {
        const originalTransactionId = Number.parseInt(refundOriginalTransactionId.trim(), 10);
        if (!Number.isFinite(originalTransactionId) || originalTransactionId <= 0) {
          toast("Enter the original Helcim transaction ID before starting the terminal refund.", "error");
          return;
        }

        try {
          pendingHelcimCentsRef.current = amtCents;
          pendingHelcimTenderRef.current = {
            method: "card_credit",
            label: "HELCIM REFUND",
          };
          const res = await fetch(`${baseUrl}/api/payments/providers/helcim/terminal/refund`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...mergedPosStaffHeaders(backofficeHeaders),
            },
            body: JSON.stringify({
              amount_cents: Math.abs(amtCents),
              original_transaction_id: originalTransactionId,
              currency: "usd",
              selected_terminal_key: selectedTerminalKey,
              terminal_override_reason: selectedTerminalNeedsOverride
                ? `Register #${registerLane ?? "unknown"} selected ${terminalLabel(selectedTerminalKey)}`
                : undefined,
            }),
          });
          const body = (await res.json().catch(() => ({}))) as
            | HelcimAttempt
            | { error?: string };
          if (!res.ok) {
            throw new Error(
              "error" in body ? body.error ?? "Helcim terminal refund failed." : "Helcim terminal refund failed.",
            );
          }
          const attempt = body as HelcimAttempt;
          setHelcimAttempt(attempt);
          setHelcimUnverifiedNotice(null);
          setKeypad("");
          toast("Refund sent to terminal. Waiting for the card outcome.", "info");
        } catch (error) {
          pendingHelcimCentsRef.current = 0;
          pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
          toast(
            error instanceof Error ? error.message : "Error initializing Helcim refund",
            "error",
          );
        }
        return;
      }

      try {
        const tenderMethod = tab === "card_manual" ? "card_manual" : "card_terminal";
        pendingHelcimTenderRef.current = {
          method: tenderMethod,
          label: tenderMethod === "card_manual" ? "HELCIM KEYED" : "HELCIM CARD",
        };
        const res = await fetch(`${baseUrl}/api/payments/providers/helcim/purchase`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...mergedPosStaffHeaders(backofficeHeaders),
          },
          body: JSON.stringify({
            amount_cents: amtCents,
            currency: "usd",
            selected_terminal_key: selectedTerminalKey,
            terminal_override_reason: selectedTerminalNeedsOverride
              ? `Register #${registerLane ?? "unknown"} selected ${terminalLabel(selectedTerminalKey)}`
              : undefined,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as
          | HelcimAttempt
          | { error?: string };
        if (!res.ok) {
          throw new Error("error" in body ? body.error ?? "Helcim payment failed." : "Helcim payment failed.");
        }
        const attempt = body as HelcimAttempt;
        pendingHelcimCentsRef.current = amtCents;
        setHelcimAttempt(attempt);
        setHelcimUnverifiedNotice(null);
        setKeypad("");
        toast(
          tenderMethod === "card_manual"
            ? "Sent to terminal. Key the card on the terminal and wait for the card outcome."
            : "Sent to terminal. Waiting for the card outcome.",
          "info",
        );
      } catch (error) {
        pendingHelcimTenderRef.current = { method: "card_terminal", label: "HELCIM CARD" };
        toast(
          error instanceof Error ? error.message : "Error initializing Helcim payment",
          "error",
        );
      }
      return;
    }
    const meta = TAB_META[tab];

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
        toast("Check the customer's RMS Charge account before adding payment.", "error");
        return;
      }
    }

    const isRmsCollectionTender = rmsPaymentCollectionMode && ["cash", "check"].includes(tab);

    setApplied((prev) => [
      ...prev,
      {
        id: newId(),
        method: meta.method,
        gift_card_code: tab === "gift_card" ? giftCardCode.trim() : undefined,
        amountCents: amtCents,
        label:
          tab === "gift_card"
            ? "Gift Card"
            : tab === "rms_charge"
              ? `RMS Charge Sale${rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode)?.program_label ? ` • ${rmsPrograms.find((program) => program.program_code === rmsSelectedProgramCode)?.program_label}` : ""}`
              : meta.label,
        metadata:
          tab === "cash" && cashChangeDueCents > 0
            ? {
                cash_tendered_cents: absKey,
                change_due_cents: cashChangeDueCents,
              }
            : tab === "check"
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
                      source_mode: "manual",
                      rms_charge_source: "manual",
                      reference_number: rmsReferenceNumber.trim() || undefined,
                      host_reference: rmsReferenceNumber.trim() || undefined,
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
                  source_mode: "manual",
                  rms_charge_source: "manual",
                  reference_number: rmsReferenceNumber.trim() || undefined,
                  host_reference: rmsReferenceNumber.trim() || undefined,
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
                    source_mode: "manual",
                    rms_charge_source: "manual",
                    reference_number: rmsReferenceNumber.trim() || undefined,
                    host_reference: rmsReferenceNumber.trim() || undefined,
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
    setRmsReferenceNumber("");
  }, [giftCardCode, checkNumber, remainingCents, cashRounding.rounded, tab, providerSettings, providerSettingsLoading, providerSettingsError, helcimAttempt?.status, helcimAttemptOutcomeUnverified, registerLaneUnavailable, registerTerminalRoute, selectedTerminalKey, selectedTerminalInUseBy, selectedTerminalInUseByOtherRegister, selectedTerminalNeedsOverride, terminalOverrideConfirmed, registerLane, refundOriginalTransactionId, baseUrl, backofficeHeaders, customerId, customerCode, toast, setApplied, rmsSelectedAccount, rmsPrograms, rmsSelectedProgramCode, rmsReferenceNumber, rmsSummary, rmsResolve, rmsPaymentCollectionMode, chargeSavedHelcimCard]);

  const removePaymentLine = async (line: AppliedPaymentLine) => {
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
      taxExemptReason: taxExemptLedgerReason,
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
    if (taxExemptNoteRequired) return "Enter the tax exempt note or reference number.";
    if (!operator) return "No cashier verified.";
    return "";
  }, [busy, balanced, takeawaySatisfied, tw, taxExemptNoteRequired, operator]);
  const activeTerminalAttemptIdForRefresh =
    helcimAttempt?.id ??
    (selectedTerminalInUseByCurrentRegister ? selectedTerminalActiveAttemptId : null);
  const terminalRecoveryState = (() => {
    if (providerSettingsError) {
      return {
        title: "Could not refresh payment terminal status",
        detail: providerSettingsError,
        action: "Try the status check again. Use a non-card tender only if store policy allows degraded checkout.",
        escalation: "Requires manager review if card payments remain unavailable.",
        tone: "danger",
      };
    }
    if (helcimUnverifiedNotice || helcimAttempt?.status === "expired") {
      return {
        title: "Card outcome needs review",
        detail: helcimUnverifiedNotice ?? HELCIM_UNVERIFIED_OUTCOME_MESSAGE,
        action: "Do not retry the card until terminal status is checked or support confirms the outcome.",
        escalation: "Requires Payments Health review before another card attempt.",
        tone: "danger",
      };
    }
    if (helcimAttempt?.status === "pending") {
      return {
        title: "Waiting on payment terminal",
        detail: helcimAttemptDetail(helcimAttempt),
        action: "Do not start another card attempt. Customer should finish or cancel on the terminal, then check the status.",
        escalation: "Start another card attempt only after the card outcome is approved, declined, or canceled.",
        tone: "warning",
      };
    }
    if (helcimAttempt && ["failed", "canceled"].includes(helcimAttempt.status)) {
      return {
        title: helcimAttemptStatusLabel(helcimAttempt.status),
        detail: helcimAttemptDetail(helcimAttempt),
        action: helcimAttemptSafeNextAction(helcimAttempt),
        escalation:
          helcimAttempt.status === "failed"
            ? "Start another card attempt only if the customer approves another attempt."
            : "Start another card attempt only after the customer confirms the terminal was canceled.",
        tone: "warning",
      };
    }
    if (registerLaneUnavailable) {
      return {
        title: "Register is not ready for terminal payments",
        detail: "This checkout is not attached to an open register lane.",
        action: "Reopen or rejoin the register before taking a terminal payment.",
        escalation: "Requires manager help if the register cannot be reopened cleanly.",
        tone: "warning",
      };
    }
    if (selectedTerminalInUseByOtherRegister) {
      return {
        title: "Selected terminal is in use",
        detail: `Terminal is currently tied to Register #${selectedTerminalInUseBy}.`,
        action: "Choose an available terminal or use an approved non-card tender.",
        escalation: "Do not force-release another register's terminal under line pressure.",
        tone: "warning",
      };
    }
    if (
      providerSettings?.active_provider === "helcim" &&
      providerSettings.helcim.enabled &&
      !providerSettings.helcim.terminal_payments_ready
    ) {
      return {
        title: "Terminal payments are not ready",
        detail: "Helcim is configured, but live terminal payments are not ready from the loaded provider settings.",
        action: "Check terminal setup before taking card payments. Cash/check tenders are still available if store policy allows.",
        escalation: "Degraded but operational; escalate if customers need card payment now.",
        tone: "warning",
      };
    }
    if (selectedTerminalNeedsOverride && !terminalOverrideConfirmed) {
      return {
        title: "Non-default terminal needs confirmation",
        detail: "Manager Access confirmation is required before sending this checkout to the selected terminal.",
        action: "Confirm the terminal override or choose the register default terminal.",
        escalation: "Requires Manager Access before routing payment to a non-default terminal.",
        tone: "info",
      };
    }
    return null;
  })();
  const terminalRecoveryTone =
    terminalRecoveryState?.tone === "danger"
      ? "border-app-danger/35 bg-app-danger/10 text-app-danger"
      : terminalRecoveryState?.tone === "warning"
        ? "border-app-warning/40 bg-app-warning/10 text-app-warning"
        : "border-app-info/30 bg-app-info/10 text-app-info";
  const terminalHeaderAction = (
    <div className="relative">
      <button
        type="button"
        onClick={() => setTerminalPickerOpen((open) => !open)}
        className="flex min-h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 text-left shadow-sm transition-colors hover:bg-app-bg"
        aria-expanded={terminalPickerOpen}
      >
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            terminalSelectionReady ? "bg-app-success" : "bg-app-danger"
          }`}
          aria-hidden="true"
        />
        <span className="hidden min-w-0 sm:block">
          <span className="block max-w-36 truncate text-[11px] font-black uppercase tracking-wide text-app-text">
            Terminal: {selectedTerminalKey ? `(${terminalNumber(selectedTerminalKey)})` : terminalStatusText}
          </span>
          <span className="block text-[8px] font-black uppercase tracking-widest text-app-text-muted">
            Change terminal
          </span>
        </span>
      </button>

      {terminalPickerOpen && (
        <div className="absolute right-0 top-12 z-[220] w-80 rounded-2xl border border-app-border bg-app-surface p-3 text-xs shadow-2xl">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {registerLane ? `Register #${registerLane}` : "Register"} Terminal
              </p>
              <p className="mt-1 text-sm font-black text-app-text">{terminalStatusText}</p>
            </div>
            {helcimAttempt?.status === "pending" && (
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={helcimAttemptLoading}
                  onClick={() => void refreshHelcimAttempt(helcimAttempt.id)}
                  className="min-h-9 rounded-lg border border-app-border bg-app-bg px-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted disabled:opacity-50"
                >
                  {helcimAttemptLoading ? "Checking" : "Check Status"}
                </button>
                <button
                  type="button"
                  disabled={helcimAttemptLoading}
                  onClick={handlePendingTerminalCancel}
                  className="min-h-9 rounded-lg border border-app-danger/25 bg-app-danger/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {providerSettingsError ? (
            <p className="mb-3 rounded-lg bg-app-danger/10 px-3 py-2 font-bold text-app-danger">
              {providerSettingsError}
            </p>
          ) : null}

          {registerLaneUnavailable ? (
            <p className="mb-3 rounded-lg bg-app-warning/10 px-3 py-2 font-bold text-app-warning">
              Reopen or rejoin the register before using a Helcim terminal.
            </p>
          ) : null}

          <div className="grid gap-2">
            {(["terminal_1", "terminal_2"] as const).map((key) => {
              const status = terminalStatuses.find((terminal) => terminal.key === key);
              const inUseBy = status?.in_use_by_register_lane;
              const configured = Boolean(status?.configured);
              const disabled =
                registerLaneUnavailable ||
                !registerTerminalRoute ||
                !configured ||
                (inUseBy != null && inUseBy !== registerLane) ||
                helcimAttemptRetryUnavailable;
              const isDefault = registerTerminalRoute?.default_terminal_key === key;
              const statusText = registerLaneUnavailable
                ? "Register unavailable"
                : !configured
                  ? "Not configured"
                  : inUseBy != null && inUseBy === registerLane
                    ? "Active on this register"
                    : inUseBy
                      ? `In use by Register #${inUseBy}`
                    : "Ready";
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setSelectedTerminalKey(key);
                    setTerminalOverrideConfirmed(false);
                  }}
                  className={`min-h-12 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selectedTerminalKey === key
                      ? "border-app-accent bg-app-accent-soft text-app-text"
                      : "border-app-border bg-app-bg text-app-text-muted hover:border-app-input-border"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-black text-app-text">{terminalLabel(key)}</span>
                    {isDefault && (
                      <span className="rounded-full bg-app-surface-2 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Default
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] font-bold text-app-text-muted">{statusText}</div>
                </button>
              );
            })}
          </div>

          {selectedTerminalNeedsOverride && (
            <label className="mt-3 flex items-center gap-2 rounded-lg bg-app-warning/10 px-3 py-2 text-[11px] font-bold text-app-warning">
              <input
                type="checkbox"
                checked={terminalOverrideConfirmed}
                onChange={(event) => setTerminalOverrideConfirmed(event.target.checked)}
                className="h-4 w-4 accent-app-accent"
              />
              Confirm Manager Access for non-default terminal use.
            </label>
          )}

          {helcimAttempt && (
            <p
              className={[
                "mt-3 rounded-lg px-3 py-2 font-bold",
                helcimAttempt.status === "pending"
                  ? "bg-app-info/10 text-app-info"
                  : ["failed", "canceled", "expired"].includes(helcimAttempt.status)
                    ? "bg-app-danger/10 text-app-danger"
                    : "bg-app-success/10 text-app-success",
              ].join(" ")}
            >
              {helcimAttemptSafeNextAction(helcimAttempt)}
            </p>
          )}

          {!helcimAttempt && helcimUnverifiedNotice && (
            <p className="mt-3 rounded-lg bg-app-danger/10 px-3 py-2 font-bold text-app-danger">
              {helcimUnverifiedNotice}
            </p>
          )}

          {providerSettings?.helcim.simulator_enabled && helcimAttempt?.status === "pending" && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                type="button"
                disabled={helcimAttemptLoading}
                onClick={() => void simulateHelcimAttempt(helcimAttempt.id, "approve")}
                className="min-h-9 rounded-lg border border-app-success/30 bg-app-success/10 px-2 text-[9px] font-black uppercase tracking-widest text-app-success disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={helcimAttemptLoading}
                onClick={() => void simulateHelcimAttempt(helcimAttempt.id, "decline")}
                className="min-h-9 rounded-lg border border-app-danger/30 bg-app-danger/10 px-2 text-[9px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
              >
                Decline
              </button>
              <button
                type="button"
                disabled={helcimAttemptLoading}
                onClick={() => void simulateHelcimAttempt(helcimAttempt.id, "cancel")}
                className="min-h-9 rounded-lg border border-app-border bg-app-bg px-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Checkout"
      subtitle="Collect Payment & Record Sale"
      panelMaxClassName="max-w-5xl"
      noPadding
      contentContained
      headerActions={terminalHeaderAction}
      footer={
        <div className="flex flex-col items-center justify-between gap-3 bg-app-surface sm:flex-row sm:gap-5">
            <div className="flex items-center gap-6">
               <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500 mb-1 leading-none">Balance Due</span>
                  <span className={`text-4xl font-black tabular-nums tracking-tighter italic sm:text-5xl ${balanceSettled ? "text-emerald-500" : "text-app-text"}`}>
                    ${centsToFixed2(Math.abs(tab === "cash" ? cashRounding.rounded : remainingCents))}
                  </span>
                  {canFinalize ? (
                    <span className="mt-1 text-[10px] font-black uppercase tracking-widest text-emerald-600">
                      Ready to record
                    </span>
                  ) : null}
                  {tab === "cash" && cashRounding.adjustment !== 0 && (
                    <span className="text-[10px] font-black uppercase text-amber-500 mt-1">
                      Original Due ${centsToFixed2(Math.abs(remainingCents))} ({cashRounding.adjustment > 0 ? "+" : ""}{centsToFixed2(cashRounding.adjustment)})
                    </span>
                  )}
                  {remainingCents < 0 && !fullBalancePaid && (
                    <span className="text-[10px] font-black uppercase text-rose-500 mt-1">Due to Customer</span>
                  )}
                  {depositDisplayCents > 0 && depositDisplayCents !== amountDueCents && (
                    <span className="text-[10px] font-black uppercase text-indigo-500 mt-1">
                      Collecting partial payment; remaining balance stays on transaction.
                    </span>
                  )}
               </div>
            </div>
           
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:gap-6">
              {/* Tax Exempt Toggle Column */}
              <div className="flex flex-col gap-1 items-end">
                <button
                  type="button"
                  onClick={() => setIsTaxExempt(!isTaxExempt)}
                  className={`flex min-h-10 items-center gap-2 rounded-xl border px-3 transition-all ${
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
                  <div className="flex w-52 flex-col gap-1.5">
                    <select
                      value={taxExemptReason}
                      onChange={(e) => setTaxExemptReason(e.target.value)}
                      className="min-h-11 w-full rounded-lg border border-rose-200 bg-rose-50/50 px-3 text-xs font-bold text-rose-700 outline-none"
                    >
                      {taxExemptReason.startsWith("Customer tax exempt") ? (
                        <option value={taxExemptReason}>{taxExemptReason}</option>
                      ) : null}
                      <option value="Out of State">Out of State</option>
                      <option value="Exempt Organization">Exempt Org</option>
                      <option value="Resale">Resale</option>
                      <option value="Diplomat">Diplomat</option>
                      <option value="Other">Other</option>
                    </select>
                    <input
                      value={taxExemptNote}
                      onChange={(e) => setTaxExemptNote(e.target.value)}
                      placeholder={
                        taxExemptReason.startsWith("Customer tax exempt")
                          ? "Sale note"
                          : "ID / certificate / note"
                      }
                      className="min-h-10 w-full rounded-lg border border-rose-200 bg-rose-50/50 px-3 text-xs font-bold text-rose-700 outline-none placeholder:text-rose-400"
                    />
                  </div>
                )}
              </div>

              <div className="hidden md:flex flex-col text-right min-w-[120px]">
                 <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1 leading-none opacity-60">Cashier</span>
                 <span className="text-sm font-bold uppercase text-app-text truncate">{operator?.fullName || "SYSTEM"}</span>
              </div>

              <div className="flex w-full gap-3 sm:w-auto">
                <button
                  type="button"
                  onClick={onClose}
                  className="min-h-11 px-4 py-2 text-xs font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text sm:px-6"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  ref={completeButtonRef}
                  disabled={!canFinalize || busy}
                  data-testid="pos-finalize-checkout"
                  title={completeDisabledReason}
                  onClick={handleFinalize}
                  className={`flex h-12 w-full items-center justify-center gap-2 rounded-2xl px-6 text-sm font-black uppercase tracking-[0.2em] transition-all sm:min-w-[210px] sm:w-auto ${
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
                      <span className="whitespace-nowrap">Record Sale</span>
                    </>
                  )}
                </button>
              </div>
            </div>
         </div>
      }
    >
      <div className="relative flex h-full flex-col overflow-hidden bg-app-bg">
        
        {busy && (
          <div className="absolute inset-0 z-50 bg-white/60 dark:bg-black/60 backdrop-blur-md flex flex-col items-center justify-center">
             <div className="h-20 w-20 rounded-full border-4 border-app-accent border-t-transparent animate-spin mb-6" />
             <p className="text-xl font-black uppercase italic tracking-wider text-app-text">Recording Sale...</p>
          </div>
        )}

        {terminalRecoveryState ? (
          <div className={`m-3 mb-0 rounded-2xl border px-4 py-3 shadow-sm sm:m-4 sm:mb-0 ${terminalRecoveryTone}`}>
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex min-w-0 gap-3">
                <AlertTriangle size={20} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-[0.2em]">
                    Card outcome review
                  </p>
                  <h3 className="mt-1 text-sm font-black uppercase tracking-wide">
                    {terminalRecoveryState.title}
                  </h3>
                  <p className="mt-1 text-xs font-semibold opacity-85">
                    {terminalRecoveryState.detail}
                  </p>
                  <p className="mt-1 text-xs font-black opacity-90">
                    Next action: {terminalRecoveryState.action}
                  </p>
                  <p className="mt-1 text-xs font-black opacity-90">
                    Review: {terminalRecoveryState.escalation}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                <button
                  type="button"
                  onClick={() => {
                    if (activeTerminalAttemptIdForRefresh) {
                      void refreshHelcimAttempt(activeTerminalAttemptIdForRefresh);
                    } else {
                      setTerminalPickerOpen(true);
                    }
                  }}
                  disabled={helcimAttemptLoading}
                  className="min-h-10 rounded-xl border border-current/30 bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-text disabled:opacity-50"
                >
                  {helcimAttemptLoading ? "Checking" : activeTerminalAttemptIdForRefresh ? "Check Status" : "Review Terminal"}
                </button>
                {helcimAttempt?.status === "pending" ? (
                  <button
                    type="button"
                    onClick={handlePendingTerminalCancel}
                    disabled={helcimAttemptLoading}
                    className="min-h-10 rounded-xl border border-app-danger/30 bg-app-danger/10 px-3 text-[10px] font-black uppercase tracking-widest text-app-danger disabled:opacity-50"
                  >
                    Cancel Terminal
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void releasePendingTerminalAttempt()}
                  disabled={helcimAttemptLoading}
                  className="min-h-10 rounded-xl border border-current/30 bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-text"
                >
                  Mark Unresolved
                </button>
              </div>
            </div>
          </div>
        ) : null}

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
                    RMS Charge Sale
                  </p>
                  <h3 className="mt-2 text-2xl font-black italic tracking-tight text-app-text">
                    Choose Program
                  </h3>
                  <p className="mt-2 text-sm text-app-text-muted">
                    Select the customer's RMS Charge program to continue.
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

        <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-4">
          <div className="flex min-h-0 flex-1 flex-col items-stretch gap-3 lg:flex-row lg:items-start lg:justify-center lg:gap-4">
            
            {/* 1. Tender Tabs Matrix (Left) */}
            <div className="w-full shrink-0 pb-1 lg:w-48 lg:pb-4">
              <span className="text-[10px] font-black uppercase tracking-[0.25em] text-app-text-muted mb-2 px-1 opacity-60">Payment Method</span>
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

            <div className="flex-1 min-w-0 flex flex-col gap-3">
              <div className="bg-app-surface border border-app-border rounded-2xl p-3 sm:p-4 shadow-sm flex flex-col">
                <div className="mb-3 flex flex-col gap-3 border-b border-app-border pb-3 sm:flex-row sm:items-end sm:justify-between">
                  <div className="flex flex-col gap-2">
                    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted leading-none opacity-60">
                      Amount to Collect
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={payBalance}
                        className="inline-flex min-h-11 items-center justify-center rounded-full border-b-2 border-app-accent-hover bg-app-accent px-4 text-xs font-black uppercase tracking-wide text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95"
                      >
                        Full Balance
                      </button>
                      <button
                        type="button"
                        onClick={splitBalance}
                        className="inline-flex min-h-11 items-center justify-center rounded-full border border-app-border bg-app-surface px-4 text-xs font-black uppercase tracking-wide text-app-text-muted transition-all hover:border-app-input-border hover:text-app-text active:scale-95"
                      >
                        Split Payment
                      </button>
                    </div>
                  </div>
                  <div className="text-3xl font-black tabular-nums tracking-tighter italic leading-none text-app-text sm:text-4xl lg:text-5xl">
                    ${keypad || "0.00"}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  {tab === "card_manual" && (
                    <div className="rounded-xl border border-app-border bg-app-bg px-4 py-3 text-xs font-semibold text-app-text-muted">
                      <span className="font-black uppercase tracking-widest text-app-text">
                        Helcim terminal keyed card
                      </span>
                      <p className="mt-1">
                        Use the selected Helcim terminal for phone orders. Staff key the card on the
                        terminal; ROS does not collect card numbers or CVV.
                      </p>
                    </div>
                  )}

                  {tab === "card_credit" && (
                    <div className="rounded-xl border border-app-border bg-app-bg px-4 py-3 text-xs font-semibold text-app-text-muted">
                      <span className="font-black uppercase tracking-widest text-app-text">
                        Helcim terminal refund
                      </span>
                      <p className="mt-1">
                        Send the refund to the selected Helcim terminal. ROS records the refund only
                        after Helcim approval is confirmed.
                      </p>
                      <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Original Helcim transaction ID
                        <input
                          type="text"
                          inputMode="numeric"
                          value={refundOriginalTransactionId}
                          onChange={(event) => setRefundOriginalTransactionId(event.target.value)}
                          className="mt-1 min-h-10 w-full rounded-xl border border-app-border bg-app-surface px-3 text-sm font-bold text-app-text outline-none transition-colors focus:border-app-accent"
                        />
                      </label>
                    </div>
                  )}

                  {tab === "card_saved" && (
                    <div className="rounded-xl border border-app-border bg-app-bg px-4 py-3 text-xs font-semibold text-app-text-muted">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <span className="font-black uppercase tracking-widest text-app-text">
                            Helcim saved card
                          </span>
                          <p className="mt-1">
                            {customerCode
                              ? `Customer #${customerCode}`
                              : "Attach a customer before using saved cards."}
                          </p>
                        </div>
                        <button
                          type="button"
                          disabled={!customerCode || helcimCardsLoading}
                          onClick={() => void loadHelcimCards()}
                          className="min-h-10 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-2 disabled:opacity-50"
                        >
                          {helcimCardsLoading ? "Loading..." : "Refresh"}
                        </button>
                      </div>
                      {customerCode && !helcimCardsLoading && helcimCards.length === 0 && (
                        <p className="mt-2 rounded-lg bg-app-warning/10 px-3 py-2 text-app-warning">
                          No Helcim saved cards were found for this customer.
                        </p>
                      )}
                      {helcimCards.length > 0 && (
                        <select
                          value={selectedHelcimCardToken}
                          onChange={(event) => setSelectedHelcimCardToken(event.target.value)}
                          className="mt-3 min-h-11 w-full rounded-xl border border-app-border bg-app-surface px-3 text-sm font-bold text-app-text outline-none transition-colors focus:border-app-accent"
                        >
                          {helcimCards.map((card) => (
                            <option
                              key={String(card.id ?? card.cardToken)}
                              value={card.cardToken ?? ""}
                            >
                              {helcimCardLabel(card)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}

                  <div className="flex justify-center">
                    <div className="w-full max-w-lg">
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
                          (tab === "card_terminal" &&
                            (providerSettingsLoading ||
                              providerSettingsError !== null ||
                              (providerSettings?.active_provider === "helcim" &&
                                (!providerSettings.helcim.enabled ||
                                  !providerSettings.helcim.terminal_payments_ready ||
                                  registerLaneUnavailable ||
                                  !registerTerminalRoute ||
                                  !selectedTerminalKey ||
                                  (selectedTerminalNeedsOverride && !terminalOverrideConfirmed) ||
                                  helcimAttemptRetryUnavailable)))) ||
                          (tab === "card_manual" &&
                            (providerSettingsLoading ||
                              providerSettingsError !== null ||
                              helcimAttemptLoading ||
                              (providerSettings?.active_provider === "helcim" &&
                                (!providerSettings.helcim.enabled ||
                                  !providerSettings.helcim.terminal_payments_ready ||
                                  registerLaneUnavailable ||
                                  !registerTerminalRoute ||
                                  !selectedTerminalKey ||
                                  (selectedTerminalNeedsOverride && !terminalOverrideConfirmed) ||
                                  helcimAttemptRetryUnavailable)))) ||
                          (tab === "card_credit" &&
                            (providerSettingsLoading ||
                              providerSettingsError !== null ||
                              helcimAttemptLoading ||
                              refundOriginalTransactionId.trim().length === 0 ||
                              (providerSettings?.active_provider === "helcim" &&
                                (!providerSettings.helcim.enabled ||
                                  !providerSettings.helcim.terminal_payments_ready ||
                                  registerLaneUnavailable ||
                                  !registerTerminalRoute ||
                                  !selectedTerminalKey ||
                                  (selectedTerminalNeedsOverride && !terminalOverrideConfirmed) ||
                                  helcimAttemptRetryUnavailable)))) ||
                          (tab === "card_saved" &&
                            (providerSettingsLoading ||
                              providerSettingsError !== null ||
                              helcimCardsLoading ||
                              helcimAttemptLoading ||
                              !selectedHelcimCardToken ||
                              (providerSettings?.active_provider === "helcim" &&
                                !providerSettings.helcim.enabled))) ||
                          busy
                        }
                        onClick={() => void applyAmountToTab(keypadCents)}
                        className="h-12 rounded-xl bg-emerald-600 text-white font-black uppercase italic tracking-widest shadow-md hover:brightness-110 active:translate-y-0.5 disabled:opacity-30 transition-all text-xs border-b-4 border-emerald-800"
                      >
                        Add Payment
                      </button>
                      
                      {allowDepositKeypad ? (
                        <button
                          type="button"
                          disabled={keypadCents <= 0 || busy}
                          onClick={() => applyDepositFromKeypad()}
                          className="h-12 rounded-xl bg-indigo-600 text-white font-black uppercase italic tracking-widest shadow-md hover:brightness-110 active:translate-y-0.5 disabled:opacity-30 transition-all text-xs border-b-4 border-indigo-800"
                        >
                          Set Deposit
                        </button>
                      ) : (
                        <div className="h-12 rounded-xl border border-app-border/40 bg-app-bg opacity-30 flex items-center justify-center">
                          <span className="text-[8px] font-black uppercase opacity-40">Retail Only</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {(tab === "gift_card" ||
                  tab === "check" ||
                  tab === "rms_charge" ||
                  (rmsPaymentCollectionMode && ["cash", "check"].includes(tab))) && (
                  <div className="mt-4 border-t border-app-border pt-4 animate-in slide-in-from-top-2">
                    {tab === "rms_charge" && (
                      <div className="space-y-2">
                        <div className="rounded-xl border border-app-border bg-app-bg px-3 py-2">
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            RMS Charge
                          </p>
                          <p className="mt-1 text-[11px] font-semibold leading-snug text-app-text-muted">
                            Charge today's sale to approved private-label credit. Choose an eligible program before adding payment.
                          </p>
                        </div>
                        {!customerId ? (
                          <div className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-3 text-sm font-semibold text-amber-700">
                            Attach a customer before using RMS Charge.
                          </div>
                        ) : rmsLoading ? (
                          <div className="rounded-xl border border-app-border bg-app-bg p-3 text-sm text-app-text-muted">
                            Checking RMS Charge…
                          </div>
                        ) : rmsResolve?.resolution_status === "blocked" ? (
                          <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 p-3 text-sm font-semibold text-rose-700">
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
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
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
                                    <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                      Workflow: {rmsSourceLabel(rmsSummary?.source)}
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
                                    {rmsSummary?.current_balance ?? "Linked account"}
                                  </div>
                                </div>
                              </div>
                            </div>

                            <label className="block rounded-xl border border-app-border bg-app-bg px-3 py-2">
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Reference Number
                              </span>
                              <input
                                value={rmsReferenceNumber}
                                onChange={(event) => setRmsReferenceNumber(event.target.value)}
                                placeholder="Approval or reference"
                                className="ui-input mt-2 h-11 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-black uppercase tracking-wide text-app-text focus:border-app-accent"
                              />
                            </label>

                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-bg px-3 py-2">
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                    Selected Program
                                  </p>
                                    <p className="mt-1 text-sm font-black uppercase tracking-wide text-app-text">
                                      {rmsSelectedProgram?.program_label ?? "Choose program"}
                                    </p>
                                    {rmsSelectedProgram ? (
                                      <p className="mt-1 text-[11px] text-app-text-muted">
                                        {rmsSourceLabel(rmsSelectedProgram.source)}
                                      </p>
                                    ) : null}
                                  {!rmsSelectedProgram ? (
                                    <p className="mt-1 text-[11px] text-amber-600">
                                      Choose a program before continuing.
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
                                  {rmsSelectedProgram ? "Change Program" : "Choose Program"}
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
                            RMS Charge Payment
                          </p>
                          <p className="mt-2 text-[11px] font-medium leading-relaxed text-app-text-muted">
                            This cash or check payment lowers the selected RMS Charge balance. Keep it separate from a normal sale payment.
                          </p>
                        </div>
                        {!customerId ? (
                          <div className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm font-semibold text-amber-700">
                            Attach a customer before collecting an RMS Charge payment.
                          </div>
                        ) : rmsLoading ? (
                          <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                            Checking RMS Charge…
                          </div>
                        ) : rmsResolve?.resolution_status === "blocked" ? (
                          <div className="rounded-xl border border-rose-300/40 bg-rose-500/10 p-4 text-sm font-semibold text-rose-700">
                            {rmsResolve.blocking_error?.message ?? "RMS Charge payment is unavailable for this customer."}
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
                          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                            <div className="flex items-center justify-between gap-4">
                              <div>
                                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                  RMS Charge Payment
                                </p>
                                <p className="text-lg font-black italic text-app-text">
                                  {rmsSelectedAccount.masked_account}
                                </p>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                    Status: {rmsSummary?.account_status ?? rmsSelectedAccount.status}
                                  </p>
                                  <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                                    Workflow: {rmsSourceLabel(rmsSummary?.source)}
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
                                  {rmsSummary?.current_balance ?? "Linked account"}
                                </div>
                              </div>
                            </div>
                            <label className="mt-3 block rounded-xl border border-app-border bg-app-bg px-4 py-3">
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Reference Number
                              </span>
                              <input
                                value={rmsReferenceNumber}
                                onChange={(event) => setRmsReferenceNumber(event.target.value)}
                                placeholder="Approval or reference"
                                className="ui-input mt-2 h-11 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm font-black uppercase tracking-wide text-app-text focus:border-app-accent"
                              />
                            </label>
                          </div>
                        ) : null}
                      </div>
                    )}

                    {tab === "gift_card" && (
                      <div className="flex flex-col gap-2">
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Scan Gift Card</span>
                        <div className="relative">
                          <ScanLine size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" />
                          <input
                            ref={giftCardInputRef}
                            value={giftCardCode}
                            onChange={e => setGiftCardCode(e.target.value.toUpperCase())}
                            placeholder="GIFT CARD #"
                            className="ui-input h-14 w-full rounded-xl border border-app-border bg-app-bg pl-12 pr-4 text-lg font-black uppercase tracking-widest focus:border-app-accent"
                          />
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

                  </div>
                )}
              </div>
            </div>

            {/* 3. Payment status and sale summary (Right) */}
            <div className="flex h-full min-h-0 w-full shrink-0 flex-col gap-4 lg:w-72">
              <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-white shadow-xl flex flex-col min-h-0 flex-1">
                <div className="flex items-center justify-between mb-3">
                   <h5 className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500 italic opacity-80">Payment Status</h5>
                   <Sparkles size={14} className="text-emerald-500 opacity-40 shrink-0" />
                </div>

                <div className="flex-1 space-y-1.5 overflow-y-auto no-scrollbar mb-3">
                   {applied.length === 0 && depositDisplayCents === 0 && !helcimAttempt && !helcimUnverifiedNotice && (
                     <div className="flex h-full flex-col items-center justify-center py-6 text-center opacity-30">
                        <Wallet size={24} strokeWidth={1} />
                        <p className="mt-2 px-6 text-xs font-black uppercase tracking-wide leading-tight">
                          No payments added yet
                        </p>
                        {remainingCents > 0 && (
                          <p className="mt-1 px-6 text-xs font-semibold leading-snug">
                            Select a tender, enter the amount, then add payment.
                          </p>
                        )}
                     </div>
                   )}
                   {!helcimAttempt && helcimUnverifiedNotice && (
                     <div className="rounded-xl border border-rose-400/25 bg-rose-400/10 p-3">
                       <p className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-500">
                         Terminal Outcome
                       </p>
                       <p className="mt-1 text-xs font-black uppercase tracking-wide text-white">
                         Outcome Unresolved
                       </p>
                       <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-300">
                         {helcimUnverifiedNotice}
                       </p>
                     </div>
                   )}
                   {helcimAttempt && (
                     <div
                       className={[
                         "rounded-xl border p-3",
                         helcimAttempt.status === "pending"
                           ? "border-sky-400/20 bg-sky-400/10"
                           : ["failed", "canceled", "expired"].includes(helcimAttempt.status)
                             ? "border-rose-400/25 bg-rose-400/10"
                             : "border-emerald-400/25 bg-emerald-400/10",
                       ].join(" ")}
                     >
                       <div className="flex items-start justify-between gap-3">
                         <div className="flex min-w-0 gap-2.5">
                           <span
                             className={[
                               "mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                               helcimAttempt.status === "pending"
                                 ? "bg-sky-400"
                                 : ["failed", "canceled", "expired"].includes(helcimAttempt.status)
                                   ? "bg-rose-400"
                                   : "bg-emerald-400",
                             ].join(" ")}
                             aria-hidden="true"
                           />
                           <div className="min-w-0">
                             <p className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-500">
                               Terminal Outcome
                             </p>
                             <p className="mt-1 truncate text-xs font-black uppercase tracking-wide text-white">
                               {helcimAttemptStatusLabel(helcimAttempt.status)}
                             </p>
                             <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-300">
                               {helcimAttemptDetail(helcimAttempt)}
                             </p>
                             <p className="mt-1 text-[10px] font-semibold leading-snug text-zinc-400">
                               ${centsToFixed2(helcimAttempt.amount_cents)} · {helcimAttemptTerminalName(helcimAttempt)} · Age {helcimAttemptAgeLabel(helcimAttempt)}
                             </p>
                             <p className="mt-1 text-[10px] font-bold leading-snug text-zinc-300">
                               Next: {helcimAttemptSafeNextAction(helcimAttempt)}
                             </p>
                             {helcimAttempt.error_code && (
                               <p className="mt-1 truncate font-mono text-[10px] font-bold text-zinc-400">
                                 Error code: {helcimAttempt.error_code}
                               </p>
                             )}
                           </div>
                         </div>
                         {helcimAttempt.status === "pending" && (
                           <div className="flex shrink-0 flex-col gap-2">
                             <button
                               type="button"
                               disabled={helcimAttemptLoading}
                               onClick={() => void refreshHelcimAttempt(helcimAttempt.id)}
                               className="min-h-9 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[9px] font-black uppercase tracking-widest text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
                             >
                               {helcimAttemptLoading ? "Checking" : "Check Status"}
                             </button>
                             <button
                               type="button"
                               disabled={helcimAttemptLoading}
                               onClick={handlePendingTerminalCancel}
                               className="min-h-9 rounded-lg border border-rose-400/25 bg-rose-400/10 px-2.5 text-[9px] font-black uppercase tracking-widest text-rose-200 transition-colors hover:bg-rose-400/15 disabled:opacity-50"
                             >
                               Cancel
                             </button>
                           </div>
                         )}
                       </div>
                     </div>
                   )}
                   {applied.map(p => (
                     <div key={p.id} className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-800/40 border border-white/5 group transition-all hover:bg-zinc-800/80">
                        <div className="flex flex-col min-w-0">
                           <span className="truncate text-xs font-black uppercase">{p.label}</span>
                           {p.metadata?.check_number && <span className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">Check #{p.metadata.check_number}</span>}
                           {p.gift_card_code && <span className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">{p.gift_card_code}</span>}
                           {p.metadata?.program_label && p.metadata?.masked_account && (
                             <span className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
                               {p.metadata.program_label} · {p.metadata.masked_account}
                             </span>
                           )}
                           {p.metadata?.rms_charge_collection && p.metadata?.masked_account && !p.metadata?.program_label && (
                             <span className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">
                               RMS Payment · {p.metadata.masked_account}
                             </span>
                           )}
                        </div>
                        <div className="flex items-center gap-2.5 ml-2">
                           <span className="text-[11px] font-black tabular-nums tracking-tight opacity-90">${centsToFixed2(p.amountCents)}</span>
                           <button onClick={() => void removePaymentLine(p)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-zinc-400 transition-all hover:bg-rose-500/10 hover:text-rose-400" aria-label={`Remove ${p.label} payment`}><Trash2 size={14} /></button>
                        </div>
                     </div>
                   ))}
                   {depositDisplayCents > 0 && (
                     <div className="flex flex-col gap-2">
                       <div className="flex items-center justify-between p-2.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                          <span className="text-[10px] font-black uppercase italic text-indigo-200">Partial Payment Today</span>
                          <span className="text-[11px] font-black tabular-nums text-white opacity-90">${centsToFixed2(depositDisplayCents)}</span>
                       </div>
                       {onOpenSplitDeposit && (
                         <button
                           type="button"
                           disabled={busy}
                           onClick={() => onOpenSplitDeposit()}
                           className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 py-2 text-indigo-300 transition-all hover:bg-indigo-500/10"
                         >
                            <Layers size={12} />
                            <span className="text-xs font-black uppercase tracking-wide">Split Deposit Payer</span>
                         </button>
                       )}
                     </div>
                   )}
                </div>

                <div className="border-t border-white/5 pt-3 space-y-1.5 opacity-90">
                   {depositDisplayCents > 0 && depositDisplayCents !== amountDueCents && (
                     <div className="flex items-center justify-between text-zinc-500">
                        <span className="text-xs font-black uppercase tracking-wide">Due Now</span>
                        <span className="text-xs font-bold tabular-nums">${centsToFixed2(depositDisplayCents)}</span>
                     </div>
                   )}
                   <div className="flex items-center justify-between pt-1">
                      <span className={`text-2xl font-black tabular-nums italic tracking-tighter ${balanceSettled ? "text-emerald-500" : "text-white"}`}>
                        {balanceSettled ? "READY" : `$${centsToFixed2(Math.abs(tab === "cash" ? cashRounding.rounded : remainingCents))}`}
                      </span>
                   </div>
                </div>
              </div>

              <div className="bg-app-surface border border-app-border rounded-xl p-3.5 space-y-2.5 shadow-sm overflow-hidden mt-auto">
                <span className="text-xs font-black uppercase tracking-wide text-app-text-muted opacity-70">Sale Summary</span>
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-app-text-muted">Merchandise</span>
                    <span className="font-bold tabular-nums text-app-text opacity-70">${centsToFixed2(amountDueCents - (stateTaxCents + localTaxCents + shippingCents))}</span>
                  </div>
                  {shippingCents > 0 && (
                    <div className="flex justify-between text-xs">
                      <span className="text-app-text-muted">Shipping</span>
                      <span className="font-bold tabular-nums text-app-text opacity-70">${centsToFixed2(shippingCents)}</span>
                    </div>
                  )}
                  
                  <div className="flex items-center justify-between border-b border-app-border/30 pb-1 text-xs font-bold uppercase tracking-wide">
                    <span className="text-app-text-muted">State Tax</span>
                    <span className={isTaxExempt ? "text-rose-500 line-through opacity-50" : "text-app-text"}>
                      ${centsToFixed2(effectiveStateTax)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between border-b border-app-border/30 pb-1 text-xs font-bold uppercase tracking-wide">
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
      </div>
    </DetailDrawer>
  );
}
