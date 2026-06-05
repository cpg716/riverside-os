import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CreditCard, Loader2, X, AlertCircle, RefreshCw } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import CustomerSelector, { type Customer } from "./CustomerSelector";
import type { WeddingMembership } from "./customerProfileTypes";

const NUM_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "del"];

interface RmsChargeAccountChoice {
  link_id: string;
  masked_account: string;
  status: string;
  is_primary: boolean;
  available_credit?: string | null;
  current_balance?: string | null;
  source?: string | null;
}

interface RmsChargeAccountSummary {
  masked_account: string;
  account_status: string;
  available_credit?: string | null;
  current_balance?: string | null;
  source: string;
}

interface RmsChargeResolveResponse {
  resolution_status: "selected" | "multiple" | "blocked";
  selected_account?: RmsChargeAccountChoice | null;
  choices: RmsChargeAccountChoice[];
  blocking_error?: {
    code: string;
    message: string;
  } | null;
  summary?: RmsChargeAccountSummary | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  selectedCustomer: Customer | null;
  onSelectCustomer: (customer: Customer | null) => void;
  onAddToCart: (amountCents: number) => Promise<void>;
  weddingMemberships: WeddingMembership[];
  onOpenWeddingParty?: (partyId: string) => void;
}

export default function RegisterRmsPaymentModal({
  open,
  onClose,
  selectedCustomer,
  onSelectCustomer,
  onAddToCart,
  weddingMemberships,
  onOpenWeddingParty,
}: Props) {
  const { toast } = useToast();
  const baseUrl = getBaseUrl();
  const { backofficeHeaders } = useBackofficeAuth();
  useShellBackdropLayer(open);
  const [amountBuffer, setAmountBuffer] = useState("");
  const [busy, setBusy] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [blockingError, setBlockingError] = useState<string | null>(null);

  const [account, setAccount] = useState<RmsChargeAccountChoice | null>(null);
  const [choices, setChoices] = useState<RmsChargeAccountChoice[]>([]);
  const [summary, setSummary] = useState<RmsChargeAccountSummary | null>(null);

  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  const clearSummary = useCallback(() => {
    setAccount(null);
    setChoices([]);
    setSummary(null);
    setLookupError(null);
    setBlockingError(null);
  }, []);

  const loadSummary = useCallback(async (selectedAcc: RmsChargeAccountChoice) => {
    setSummary({
      masked_account: selectedAcc.masked_account,
      account_status: selectedAcc.status,
      available_credit: selectedAcc.available_credit ?? null,
      current_balance: selectedAcc.current_balance ?? null,
      source: selectedAcc.source ?? "manual",
    });
  }, []);

  const resolveAccount = useCallback(async () => {
    if (!selectedCustomer) {
      clearSummary();
      return;
    }
    setLookupLoading(true);
    setLookupError(null);
    setBlockingError(null);

    try {
      const params = new URLSearchParams({ customer_id: selectedCustomer.id });
      const res = await fetch(`${baseUrl}/api/pos/rms-charge/resolve-account?${params.toString()}`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      const data = (await res.json().catch(() => ({}))) as RmsChargeResolveResponse & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error ?? "Could not check RMS Charge account.");
      }
      setChoices(data.choices ?? []);
      if (data.resolution_status === "blocked") {
        setBlockingError(data.blocking_error?.message ?? "RMS Charge is unavailable for this customer.");
        return;
      }
      if (data.resolution_status === "selected" && data.selected_account) {
        setAccount(data.selected_account);
        setSummary(data.summary ?? {
          masked_account: data.selected_account.masked_account,
          account_status: data.selected_account.status,
          available_credit: data.selected_account.available_credit ?? null,
          current_balance: data.selected_account.current_balance ?? null,
          source: data.selected_account.source ?? "manual",
        });
      }
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : "Could not check RMS Charge account.");
    } finally {
      setLookupLoading(false);
    }
  }, [backofficeHeaders, baseUrl, selectedCustomer, clearSummary]);

  useEffect(() => {
    if (!open) return;
    setAmountBuffer("");
    setBusy(false);
    clearSummary();
    if (selectedCustomer) {
      void resolveAccount();
    }
  }, [open, selectedCustomer, clearSummary, resolveAccount]);

  const appendAmountKey = useCallback((key: string) => {
    setAmountBuffer((prev) => {
      if (key === "del") {
        return prev.slice(0, -1);
      }
      if (key === ".") {
        if (prev.includes(".")) return prev;
        return prev.length === 0 ? "0." : `${prev}.`;
      }
      if (prev === "0" && key !== ".") return key;
      const next = prev + key;
      const parts = next.split(".");
      if (parts.length > 1 && parts[1] && parts[1].length > 2) return prev;
      return next;
    });
  }, []);

  const clearAmount = useCallback(() => setAmountBuffer(""), []);

  const submit = useCallback(async () => {
    const cents = parseMoneyToCents(amountBuffer.trim() || "0");
    if (!Number.isFinite(cents) || cents <= 0) {
      toast("Enter a payment amount greater than zero.", "error");
      return;
    }
    if (!selectedCustomer) {
      toast("Attach a customer before adding a payment.", "error");
      return;
    }
    if (blockingError) {
      toast("Cannot collect payment: Account is currently restricted.", "error");
      return;
    }
    if (!account) {
      toast("Ensure the customer has a linked RMS Charge account.", "error");
      return;
    }
    setBusy(true);
    try {
      await onAddToCart(cents);
      toast("RMS payment line added to cart.", "success");
      onClose();
    } finally {
      setBusy(false);
    }
  }, [amountBuffer, selectedCustomer, blockingError, account, toast, onAddToCart, onClose]);

  useEffect(() => {
    if (!open || busy) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "9") {
        appendAmountKey(e.key);
      } else if (e.key === ".") {
        appendAmountKey(".");
      } else if (e.key === "Backspace") {
        appendAmountKey("del");
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, busy, appendAmountKey, submit]);

  if (!open) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const displayAmount = `$${centsToFixed2(parseMoneyToCents(amountBuffer || "0"))}`;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal relative flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl outline-none sm:max-h-[90vh] sm:w-[min(44rem,calc(100vw-1.25rem))] sm:rounded-3xl"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-app-border/70 bg-app-surface-2 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg shadow-violet-600/20">
              <CreditCard className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h2
                id={titleId}
                className="text-lg font-black uppercase tracking-tight text-app-text"
              >
                RMS Payment
              </h2>
              <p className="text-[10px] font-bold uppercase tracking-wide text-app-text-muted">
                Collect payment on customer outstanding account
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2"
            aria-label="Close"
          >
            <X size={22} aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-4 sm:grid-cols-2 sm:gap-6 sm:overflow-hidden sm:p-6">
          {/* Left Column: Keypad & Input */}
          <div className="flex min-h-0 flex-col gap-3">
            <p className="text-xs leading-snug text-app-text-muted">
              Select a customer, enter the amount to pay, and add the line to the cart.
              The account balance will be updated once checkout completes.
            </p>
            <div>
              <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Payment amount
              </p>
              <div className="mb-3 flex h-16 items-center justify-between rounded-2xl border-2 border-app-border/80 bg-app-surface-2/80 px-4 shadow-inner">
                <span className="text-[10px] font-black uppercase text-app-text-muted">
                  Amount
                </span>
                <span className="text-3xl font-black tabular-nums text-app-text">
                  {displayAmount}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {NUM_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    onClick={() => appendAmountKey(k)}
                    className="flex h-12 items-center justify-center rounded-xl border border-app-border/60 bg-app-surface-2 text-lg font-black text-app-text transition-colors hover:bg-app-surface sm:h-[3.25rem] sm:text-xl"
                  >
                    {k === "del" ? "DEL" : k}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={clearAmount}
                  className="col-span-3 flex h-11 items-center justify-center rounded-xl bg-app-danger/10 text-xs font-black uppercase tracking-widest text-app-danger transition-colors hover:bg-app-danger/15"
                >
                  Clear amount
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Customer & Account Info */}
          <div className="flex min-h-0 flex-col gap-4">
            <div className="shrink-0 space-y-2">
              <label
                className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
              >
                Customer account
              </label>

              {!selectedCustomer ? (
                <div className="ui-panel ui-tint-warning p-4 space-y-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="h-5 w-5 text-app-warning shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-black uppercase tracking-wider text-app-text">Customer Required</p>
                      <p className="text-[10px] text-app-text-muted leading-relaxed mt-0.5">
                        Please search or select a customer profile to check their linked financing account.
                      </p>
                    </div>
                  </div>
                  <div className="pt-1.5 border-t border-app-border/40">
                    <CustomerSelector
                      variant="posStrip"
                      selectedCustomer={selectedCustomer}
                      onSelect={onSelectCustomer}
                      weddingMemberships={weddingMemberships}
                      onOpenWeddingParty={onOpenWeddingParty}
                      showWalkInOption={false}
                    />
                  </div>
                </div>
              ) : (
                /* Customer Selected Chip */
                <div className="rounded-2xl bg-blue-600/90 px-3 py-2.5 text-white shadow-md flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-black italic uppercase leading-none tracking-tight">
                      {selectedCustomer.first_name} {selectedCustomer.last_name}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-blue-100/90">
                      <span>{selectedCustomer.customer_code || "—"}</span>
                      {selectedCustomer.phone && <span>· {selectedCustomer.phone}</span>}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectCustomer(null);
                      clearSummary();
                    }}
                    className="shrink-0 rounded-full bg-app-surface/10 p-1.5 transition-colors hover:bg-app-surface/20"
                    aria-label="Remove customer"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* Account Details Panel */}
            <div className="ui-panel ui-tint-success flex min-h-[9rem] flex-1 flex-col p-3.5 sm:p-4">
              <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Financing Account Data
              </p>

              {!selectedCustomer ? (
                <p className="text-xs leading-relaxed text-app-text-muted">
                  Search and link a customer profile to pull active balances.
                </p>
              ) : lookupLoading ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-app-text-muted">
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden />
                  <span className="text-xs font-bold">Querying CoreCredit status…</span>
                </div>
              ) : lookupError ? (
                <div className="space-y-2">
                  <p className="text-sm font-bold text-app-danger">{lookupError}</p>
                  <button
                    type="button"
                    onClick={() => void resolveAccount()}
                    className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-blue-400 hover:text-blue-300"
                  >
                    <RefreshCw size={10} />
                    Retry Lookup
                  </button>
                </div>
              ) : blockingError ? (
                <p className="text-xs font-bold text-app-danger leading-relaxed">
                  {blockingError}
                </p>
              ) : choices.length === 0 ? (
                <p className="text-xs leading-relaxed text-app-warning font-bold">
                  No linked RMS Charge account found for this customer.
                </p>
              ) : account && summary ? (
                <dl className="space-y-2.5 text-sm">
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Financed Account
                    </dt>
                    <dd className="text-right font-mono font-bold text-app-text">
                      {summary.masked_account}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Status
                    </dt>
                    <dd className="text-right font-bold text-app-success capitalize">
                      {summary.account_status}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Available Credit
                    </dt>
                    <dd className="text-right font-bold tabular-nums text-app-text">
                      {summary.available_credit ? `$${summary.available_credit}` : "$0.00"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Outstanding Balance
                    </dt>
                    <dd className="text-right text-base font-black tabular-nums text-app-text">
                      {summary.current_balance ? `$${summary.current_balance}` : "$0.00"}
                    </dd>
                  </div>

                  {summary.current_balance && parseMoneyToCents(summary.current_balance) > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        const balCents = parseMoneyToCents(summary.current_balance);
                        setAmountBuffer(centsToFixed2(balCents));
                      }}
                      className="w-full py-1.5 text-center rounded-lg border border-violet-500/35 bg-violet-500/10 text-[9px] font-black uppercase tracking-widest text-violet-300 hover:bg-violet-600 hover:text-white transition-colors"
                    >
                      Autofill Outstanding Balance
                    </button>
                  )}
                </dl>
              ) : choices.length > 1 ? (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-app-text-muted">Multiple accounts found. Select one:</p>
                  <div className="space-y-1.5 max-h-[7rem] overflow-y-auto pr-1">
                    {choices.map((c) => (
                      <button
                        key={c.link_id}
                        type="button"
                        onClick={() => {
                          setAccount(c);
                          void loadSummary(c);
                        }}
                        className="w-full text-left p-2 rounded-lg border border-app-border bg-app-surface hover:bg-app-surface-2 transition-colors flex items-center justify-between text-xs"
                      >
                        <span className="font-mono font-bold text-app-text">{c.masked_account}</span>
                        <span className="text-[10px] font-bold capitalize text-app-success">{c.status}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-app-text-muted">
                  Initializing lookup details…
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={busy || !account || Boolean(blockingError)}
              onClick={() => void submit()}
              className="ui-touch-target flex h-14 w-full shrink-0 items-center justify-center rounded-2xl border-b-[6px] border-violet-900 bg-violet-600 text-sm font-black uppercase tracking-widest text-white shadow-xl shadow-violet-600/25 transition-all hover:bg-violet-500 active:translate-y-0.5 active:border-b-4 disabled:opacity-40"
            >
              {busy ? "Adding…" : "Add to cart"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    root
  );
}
