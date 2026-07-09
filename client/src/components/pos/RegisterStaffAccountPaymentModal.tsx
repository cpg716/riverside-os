import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CreditCard, Loader2, RefreshCw, X } from "lucide-react";
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

interface StaffAccountSummary {
  account_id: string;
  staff_id: string;
  staff_name: string;
  customer_id: string;
  customer_code?: string | null;
  customer_name: string;
  status: string;
  current_balance: string | number;
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

export default function RegisterStaffAccountPaymentModal({
  open,
  onClose,
  selectedCustomer,
  onSelectCustomer,
  onAddToCart,
  weddingMemberships,
  onOpenWeddingParty,
}: Props) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  useShellBackdropLayer(open);
  const [amountBuffer, setAmountBuffer] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [account, setAccount] = useState<StaffAccountSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  const loadAccount = useCallback(async () => {
    if (!selectedCustomer) {
      setAccount(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ customer_id: selectedCustomer.id });
      const res = await fetch(`${baseUrl}/api/pos/staff-account/by-customer?${params.toString()}`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (!res.ok) throw new Error("Could not check Staff Account.");
      const data = (await res.json()) as StaffAccountSummary | null;
      setAccount(data);
      if (!data) setError("This customer is not linked to a Staff Account.");
    } catch (err) {
      setAccount(null);
      setError(err instanceof Error ? err.message : "Could not check Staff Account.");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, baseUrl, selectedCustomer]);

  useEffect(() => {
    if (!open) return;
    setAmountBuffer("");
    setBusy(false);
    void loadAccount();
  }, [open, loadAccount]);

  const appendAmountKey = useCallback((key: string) => {
    setAmountBuffer((prev) => {
      if (key === "del") return prev.slice(0, -1);
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

  const submit = useCallback(async () => {
    const cents = parseMoneyToCents(amountBuffer.trim() || "0");
    if (cents <= 0) {
      toast("Enter a payment amount greater than zero.", "error");
      return;
    }
    if (!selectedCustomer || !account || account.status !== "active") {
      toast("Select a customer with an active Staff Account.", "error");
      return;
    }
    const balanceCents = parseMoneyToCents(account.current_balance);
    if (cents > balanceCents) {
      toast("Staff Account payment cannot exceed the current balance.", "error");
      return;
    }
    setBusy(true);
    try {
      await onAddToCart(cents);
      toast("Staff Account payment line added to cart.", "success");
      onClose();
    } finally {
      setBusy(false);
    }
  }, [account, amountBuffer, onAddToCart, onClose, selectedCustomer, toast]);

  if (!open) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const displayAmount = `$${centsToFixed2(parseMoneyToCents(amountBuffer || "0"))}`;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal relative flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl outline-none sm:max-h-[90vh] sm:w-[min(42rem,calc(100vw-1.25rem))] sm:rounded-3xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-app-border/70 bg-app-surface-2 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-700 text-white shadow-lg shadow-cyan-700/20">
              <CreditCard className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h2 id={titleId} className="text-lg font-black uppercase tracking-tight text-app-text">
                Staff Account Payment
              </h2>
              <p className="text-[10px] font-bold uppercase tracking-wide text-app-text-muted">
                Pay down employee receivable balance
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2" aria-label="Close">
            <X size={22} aria-hidden />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-4 sm:grid-cols-2 sm:gap-6 sm:p-6">
          <div className="flex min-h-0 flex-col gap-3">
            <p className="text-xs leading-snug text-app-text-muted">
              This is a balance payment only. It does not create merchandise revenue or new tax.
            </p>
            <div className="mb-3 flex h-16 items-center justify-between rounded-2xl border-2 border-app-border/80 bg-app-surface-2/80 px-4 shadow-inner">
              <span className="text-[10px] font-black uppercase text-app-text-muted">Amount</span>
              <span className="text-3xl font-black tabular-nums text-app-text">{displayAmount}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {NUM_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={busy}
                  onClick={() => appendAmountKey(key)}
                  className="flex h-12 items-center justify-center rounded-xl border border-app-border/60 bg-app-surface-2 text-lg font-black text-app-text transition-colors hover:bg-app-surface"
                >
                  {key === "del" ? "DEL" : key}
                </button>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => setAmountBuffer("")}
                className="col-span-3 flex h-11 items-center justify-center rounded-xl bg-app-danger/10 text-xs font-black uppercase tracking-widest text-app-danger transition-colors hover:bg-app-danger/15"
              >
                Clear amount
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-4">
            {!selectedCustomer ? (
              <div className="ui-panel ui-tint-warning p-4">
                <CustomerSelector
                  variant="posStrip"
                  selectedCustomer={selectedCustomer}
                  onSelect={onSelectCustomer}
                  weddingMemberships={weddingMemberships}
                  onOpenWeddingParty={onOpenWeddingParty}
                  showWalkInOption={false}
                />
              </div>
            ) : (
              <div className="rounded-2xl bg-cyan-700 px-3 py-2.5 text-white shadow-md">
                <div className="truncate text-sm font-black italic uppercase leading-none tracking-tight">
                  {selectedCustomer.first_name} {selectedCustomer.last_name}
                </div>
                <div className="mt-1 text-[9px] font-bold uppercase tracking-widest text-cyan-100">
                  {selectedCustomer.customer_code || "Staff customer"}
                </div>
              </div>
            )}

            <div className="ui-panel flex min-h-[10rem] flex-1 flex-col p-4">
              <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Staff Account
              </p>
              {!selectedCustomer ? (
                <p className="text-xs text-app-text-muted">Select the staff member's linked customer profile.</p>
              ) : loading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-app-text-muted">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-xs font-bold">Checking account…</span>
                </div>
              ) : account ? (
                <dl className="space-y-3 text-sm">
                  <div className="flex justify-between gap-3 border-b border-app-border pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">Staff</dt>
                    <dd className="text-right font-bold text-app-text">{account.staff_name}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">Balance</dt>
                    <dd className="text-right font-black text-app-text">${centsToFixed2(parseMoneyToCents(account.current_balance))}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">Status</dt>
                    <dd className="text-right font-bold capitalize text-app-success">{account.status}</dd>
                  </div>
                </dl>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs font-bold text-app-danger">{error ?? "No Staff Account is linked."}</p>
                  <button
                    type="button"
                    onClick={() => void loadAccount()}
                    className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-cyan-700"
                  >
                    <RefreshCw size={10} />
                    Retry
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 justify-end border-t border-app-border bg-app-surface-2 px-5 py-4">
          <button
            type="button"
            disabled={busy || loading || !account || account.status !== "active" || parseMoneyToCents(amountBuffer || "0") <= 0}
            onClick={() => void submit()}
            className="ui-btn-primary min-h-12 px-5 disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add Payment Line"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
