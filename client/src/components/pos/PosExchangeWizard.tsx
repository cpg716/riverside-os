import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, X, Loader2, Package } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { centsToFixed2, parseMoney, parseMoneyToCents, formatMoney } from "../../lib/money";
import { calculateNysErieTaxForUnit, type TaxCategory } from "../../lib/tax";
import type { Customer } from "../pos/CustomerSelector";
import TransactionSearchInput from "../ui/TransactionSearchInput";

type FulfillmentKind = "takeaway" | "special_order" | "wedding_order";

interface TransactionItemRow {
  transaction_line_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  unit_price: string;
  unit_cost: string;
  state_tax: string;
  local_tax: string;
  tax_category?: string | null;
  fulfillment: FulfillmentKind;
  is_fulfilled?: boolean;
  fulfilled_at?: string | null;
  picked_up_at?: string | null;
}

interface TransactionDetailLite {
  transaction_id: string;
  transaction_display_id?: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  is_counterpoint_import?: boolean;
  is_tax_exempt?: boolean;
  payment_methods_summary?: string;
  customer: {
    id: string;
    first_name: string;
    last_name: string;
    customer_code?: string | null;
    company_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  items: TransactionItemRow[];
}

interface CustomerTransactionRow {
  transaction_id: string;
  display_id?: string | null;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  item_count: number;
  order_items_summary?: string | null;
}

interface CustomerTransactionResponse {
  items?: CustomerTransactionRow[];
}

type Step = "load" | "return" | "done";

type WorkflowStep = {
  id: Step;
  label: string;
  hint: string;
};

type ReturnedLineSummary = {
  transaction_line_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label?: string | null;
  quantity: number;
  unit_price_cents: number;
  unit_cost: string | number;
  state_tax_cents: number;
  local_tax_cents: number;
  tax_cents: number;
  reason?: "refund" | "exchange";
  restock?: boolean | null;
};

type ReturnTaxCents = {
  stateTaxCents: number;
  localTaxCents: number;
  taxCents: number;
};

const TAX_CATEGORIES: TaxCategory[] = ["clothing", "footwear", "accessory", "service", "other"];
const CLOTHING_FOOTWEAR_STATE_EXEMPTION_CENTS = 11000;

function normalizeTaxCategory(raw: string | null | undefined): TaxCategory {
  const normalized = (raw ?? "").trim().toLowerCase();
  return TAX_CATEGORIES.includes(normalized as TaxCategory) ? (normalized as TaxCategory) : "other";
}

function shouldForceCurrentClothingReturnTax(item: TransactionItemRow): boolean {
  const category = normalizeTaxCategory(item.tax_category);
  return (
    (category === "clothing" || category === "footwear") &&
    parseMoneyToCents(item.unit_price) < CLOTHING_FOOTWEAR_STATE_EXEMPTION_CENTS
  );
}

function returnTaxCentsForItem(detail: TransactionDetailLite, item: TransactionItemRow): ReturnTaxCents {
  const storedStateTaxCents = parseMoneyToCents(item.state_tax);
  const storedLocalTaxCents = parseMoneyToCents(item.local_tax);

  if (shouldForceCurrentClothingReturnTax(item)) {
    const { stateTaxCents, localTaxCents } = calculateNysErieTaxForUnit(
      normalizeTaxCategory(item.tax_category),
      parseMoneyToCents(item.unit_price),
    );
    return {
      stateTaxCents,
      localTaxCents,
      taxCents: stateTaxCents + localTaxCents,
    };
  }

  if (
    storedStateTaxCents !== 0 ||
    storedLocalTaxCents !== 0 ||
    !detail.is_counterpoint_import ||
    detail.is_tax_exempt
  ) {
    return {
      stateTaxCents: storedStateTaxCents,
      localTaxCents: storedLocalTaxCents,
      taxCents: storedStateTaxCents + storedLocalTaxCents,
    };
  }

  const { stateTaxCents, localTaxCents } = calculateNysErieTaxForUnit(
    normalizeTaxCategory(item.tax_category),
    parseMoneyToCents(item.unit_price),
  );

  return {
    stateTaxCents,
    localTaxCents,
    taxCents: stateTaxCents + localTaxCents,
  };
}

const EXCHANGE_WORKFLOW_STEPS: WorkflowStep[] = [
  {
    id: "load",
    label: "Find original sale",
    hint: "Load the transaction you are exchanging on this register session.",
  },
  {
    id: "return",
    label: "Record return items",
    hint: "Enter only the quantities coming back from the original sale.",
  },
  {
    id: "done",
    label: "Refund or replace",
    hint: "Refund the customer now, or continue into a replacement sale if this is an exchange.",
  },
];

function refundableCreditCents(detail: TransactionDetailLite): number {
  const paidCents = parseMoneyToCents(detail.amount_paid);
  const creditCents = Math.max(0, -parseMoneyToCents(detail.balance_due));
  return Math.min(paidCents, creditCents);
}

function paidReturnCreditCents(detail: TransactionDetailLite, selectedReturnCents: number): number {
  const paidCents = parseMoneyToCents(detail.amount_paid);
  return Math.min(selectedReturnCents, Math.max(0, paidCents));
}

function returnedLineSummaries(detail: TransactionDetailLite): ReturnedLineSummary[] {
  return detail.items
    .filter((item) => (item.quantity_returned ?? 0) > 0)
    .map((item) => {
      const tax = returnTaxCentsForItem(detail, item);
      return {
        transaction_line_id: item.transaction_line_id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        sku: item.sku,
        product_name: item.product_name,
        variation_label: item.variation_label,
        quantity: item.quantity_returned,
        unit_price_cents: parseMoneyToCents(item.unit_price),
        unit_cost: item.unit_cost,
        state_tax_cents: tax.stateTaxCents,
        local_tax_cents: tax.localTaxCents,
        tax_cents: tax.taxCents,
      };
    });
}

export default function PosExchangeWizard({
  open,
  initialTransactionId,
  initialReturnLineId,
  customer,
  onClose,
  sessionId,
  baseUrl,
  apiAuth,
  onContinueToReplacement,
}: {
  open: boolean;
  initialTransactionId?: string | null;
  initialReturnLineId?: string | null;
  customer?: Customer | null;
  onClose: () => void;
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onContinueToReplacement: (args: {
    originalTransactionId: string;
    customer: Customer | null;
    receiptLabel?: string;
    returnedLines?: ReturnedLineSummary[];
    refundAmountCents?: number;
    action?: "refund" | "exchange";
  }) => void;
}) {
  const { toast } = useToast();
  useShellBackdropLayer(open);

  const [step, setStep] = useState<Step>("load");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<TransactionDetailLite | null>(null);
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [returnedLines, setReturnedLines] = useState<ReturnedLineSummary[]>([]);
  const [refundAmount, setRefundAmount] = useState("");
  const [customerTransactions, setCustomerTransactions] = useState<CustomerTransactionRow[]>([]);
  const [customerTransactionsLoading, setCustomerTransactionsLoading] = useState(false);
  const [customerTransactionsError, setCustomerTransactionsError] = useState<string | null>(null);
  const workflowIndex = EXCHANGE_WORKFLOW_STEPS.findIndex((item) => item.id === step);
  const receiptLabel =
    detail?.transaction_display_id ?? detail?.transaction_id.slice(0, 8).toUpperCase() ?? "";
 
   const sessionQs = `register_session_id=${encodeURIComponent(sessionId)}`;

  const reset = useCallback(() => {
    setStep("load");
    setDetail(null);
    setReturnQtyDraft({});
    setReturnedLines([]);
    setRefundAmount("");
    setCustomerTransactions([]);
    setCustomerTransactionsError(null);
  }, []);

  const prefillReturnLine = useCallback((d: TransactionDetailLite) => {
    if (!initialReturnLineId) return;
    const line = d.items.find((item) => item.transaction_line_id === initialReturnLineId);
    if (!line) return;
    const max = line.quantity - (line.quantity_returned ?? 0);
    if (max > 0) {
      setReturnQtyDraft({ [initialReturnLineId]: "1" });
    }
  }, [initialReturnLineId]);

  const applyLoadedTransaction = useCallback((d: TransactionDetailLite) => {
    setDetail(d);
    prefillReturnLine(d);
    setStep("return");
  }, [prefillReturnLine]);

  const loadTransaction = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${encodeURIComponent(id)}?${sessionQs}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          b.error ??
            "Could not load this transaction. It may be outside this register session — use Back Office instead.",
          "error",
        );
        return;
      }
      const d = (await res.json()) as TransactionDetailLite;
      if ((d.status || "").toLowerCase() === "cancelled") {
        toast("Cancelled transactions cannot be exchanged here", "error");
        return;
      }
      
      const hasReturnableLines = d.items.some((item) => item.quantity - (item.quantity_returned ?? 0) > 0);
      const existingRefundableCents = refundableCreditCents(d);
      if (!hasReturnableLines && existingRefundableCents > 0) {
        setDetail(d);
        setReturnedLines(returnedLineSummaries(d));
        setRefundAmount(centsToFixed2(existingRefundableCents));
        setStep("done");
        toast("Return is already recorded. Finish the remaining refund credit.", "info");
        return;
      }

      applyLoadedTransaction(d);
    } catch {
      toast("Network error loading transaction", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, sessionQs, apiAuth, toast, applyLoadedTransaction]);

  useEffect(() => {
    if (!open || !customer?.id || step !== "load" || initialTransactionId) return;
    let cancelled = false;
    setCustomerTransactionsLoading(true);
    setCustomerTransactionsError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({
          customer_id: customer.id,
          register_session_id: sessionId,
          show_closed: "true",
          limit: "25",
        });
        const res = await fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
          headers: apiAuth(),
        });
        if (!res.ok) {
          throw new Error("transaction list unavailable");
        }
        const data = (await res.json()) as CustomerTransactionResponse;
        if (!cancelled) setCustomerTransactions(Array.isArray(data.items) ? data.items : []);
      } catch {
        if (!cancelled) {
          setCustomerTransactions([]);
          setCustomerTransactionsError("Could not load this customer's transactions.");
        }
      } finally {
        if (!cancelled) setCustomerTransactionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiAuth, baseUrl, customer?.id, initialTransactionId, open, sessionId, step]);

  useEffect(() => {
    if (open && initialTransactionId) {
      void loadTransaction(initialTransactionId);
    } else if (!open) {
      reset();
    }
  }, [open, initialTransactionId, reset, loadTransaction]);

  const selectedReturnLines = useCallback(() => {
    if (!detail) return;
    const lines: { transaction_line_id: string; quantity: number; item: TransactionItemRow }[] = [];
    for (const it of detail.items) {
      const raw = (returnQtyDraft[it.transaction_line_id] ?? "").trim();
      if (!raw) continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q <= 0) continue;
      const max = it.quantity - (it.quantity_returned ?? 0);
      if (q > max) {
        return null;
      }
      lines.push({
        transaction_line_id: it.transaction_line_id,
        quantity: q,
        item: it,
      });
    }
    return lines;
  }, [detail, returnQtyDraft]);

  const selectedRefundCents = (selectedReturnLines() ?? []).reduce((sum, line) => {
    const unitCents = parseMoneyToCents(line.item.unit_price);
    const taxCents = detail ? returnTaxCentsForItem(detail, line.item).taxCents : 0;
    return sum + (unitCents + taxCents) * line.quantity;
  }, 0);
  const selectedReturnCount = (selectedReturnLines() ?? []).reduce((sum, line) => sum + line.quantity, 0);

  const submitReturns = async (nextAction: "refund" | "exchange") => {
    if (!detail) return;
    const lines = selectedReturnLines();
    if (!lines) {
      toast("Fix return quantities before continuing.", "error");
      return;
    }
    if (lines.length === 0) {
      toast("Enter return quantities for at least one line", "info");
      return;
    }
    setSubmitting(true);
    try {
      const refundLines = lines.map(({ item, quantity }) => {
        const tax = returnTaxCentsForItem(detail, item);
        return {
          transaction_line_id: item.transaction_line_id,
          product_id: item.product_id,
          variant_id: item.variant_id,
          sku: item.sku,
          product_name: item.product_name,
          variation_label: item.variation_label,
          quantity,
          unit_price_cents: parseMoneyToCents(item.unit_price),
          unit_cost: item.unit_cost,
          state_tax_cents: tax.stateTaxCents,
          local_tax_cents: tax.localTaxCents,
          tax_cents: tax.taxCents,
          reason: nextAction,
          restock: true,
        };
      });
      setReturnedLines(refundLines);
      const returnedValueCents = refundLines.reduce(
        (sum, line) => sum + (line.unit_price_cents + line.tax_cents) * line.quantity,
        0,
      );
      const refundCents = paidReturnCreditCents(detail, returnedValueCents);
      setRefundAmount(centsToFixed2(refundCents));
      if (refundCents > 0) {
        onContinueToReplacement({
          originalTransactionId: detail.transaction_id,
          customer: applyCustomer(),
          receiptLabel,
          returnedLines: refundLines,
          refundAmountCents: refundCents,
          action: nextAction,
        });
        onClose();
        return;
      }
      toast(
        nextAction === "refund"
          ? "Return staged. No paid credit is available to refund yet."
          : "Return staged. Continue with replacement items, then refund any remaining credit if needed.",
        "success",
      );
      setStep("done");
    } catch {
      toast("Return could not be staged", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const applyCustomer = (): Customer | null => {
    if (!detail?.customer) return null;
    const c = detail.customer;
    return {
      id: c.id,
      customer_code: "",
      first_name: c.first_name,
      last_name: c.last_name,
      company_name: c.company_name ?? null,
      email: c.email ?? null,
      phone: c.phone ?? null,
    };
  };

  const handleContinue = () => {
    if (!detail) return;
    onContinueToReplacement({
      originalTransactionId: detail.transaction_id,
      customer: applyCustomer(),
      receiptLabel,
      returnedLines,
      refundAmountCents: parseMoneyToCents(refundAmount),
      action: "exchange",
    });
    onClose();
  };

  if (!open) return null;

  return createPortal(
    <div
      className="ui-overlay-backdrop !z-[200]"
      role="dialog"
      aria-modal="true"
      aria-label="Exchange/Return wizard"
      data-testid="pos-exchange-wizard-dialog"
    >
      <div 
        className="ui-card flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border border-app-border bg-app-surface/80 backdrop-blur-xl shadow-2xl sm:max-h-[min(720px,90vh)] sm:max-w-3xl sm:rounded-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-app-border/50 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent shadow-inner">
              <ArrowLeftRight className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-app-text">
                Exchange / Return Wizard
              </h2>
              <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                Register returns desk
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="border-b border-app-border/50 bg-app-surface-2/70 px-6 py-3">
          <div className="flex flex-wrap items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <span className="rounded-lg border border-app-border bg-app-surface px-2.5 py-1 text-app-text">
              {customer ? `${customer.first_name} ${customer.last_name}` : "Customer not selected"}
            </span>
            {detail ? (
              <span className="rounded-lg border border-app-accent/25 bg-app-accent/10 px-2.5 py-1 text-app-accent">
                Receipt {receiptLabel}
              </span>
            ) : null}
            <span className="rounded-lg bg-app-surface px-2.5 py-1">
              {step === "load"
                ? "Find original sale"
                : step === "return"
                  ? "Return in progress"
                  : "Return saved"}
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          <div className="mb-8 grid gap-4 lg:grid-cols-[1fr,240px]">
            <div className="grid gap-2 grid-cols-3">
              {EXCHANGE_WORKFLOW_STEPS.map((item, index) => {
                const isCurrent = item.id === step;
                const isComplete = index < workflowIndex;
                return (
                  <div
                    key={item.id}
                    className={`relative overflow-hidden rounded-2xl border px-4 py-4 transition-all duration-300 ${
                      isCurrent
                        ? "border-app-accent bg-app-accent/10 text-app-text shadow-glow-accent-xs ring-1 ring-app-accent/20"
                        : isComplete
                          ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600"
                          : "border-app-border bg-app-surface-2/50 text-app-text-muted"
                    }`}
                  >
                    {isCurrent && (
                      <div className="absolute -right-2 -top-2 h-8 w-8 rounded-full bg-app-accent/20 blur-xl" />
                    )}
                    <p className="text-[10px] font-black uppercase tracking-[0.15em] opacity-60">
                      Phase 0{index + 1}
                    </p>
                    <p className="mt-1 text-[11px] font-black uppercase tracking-wide text-current">
                      {item.label}
                    </p>
                    {isComplete && (
                      <div className="absolute right-2 top-2">
                        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-[10px] text-white">
                          ✓
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-col justify-center rounded-2xl border border-app-accent/20 bg-app-accent/5 px-4 py-4 shadow-inner">
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-app-accent shadow-glow-accent-xs" />
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                  Active Instruction
                </p>
              </div>
              <p className="mt-2 text-xs font-bold leading-relaxed text-app-text">
                {EXCHANGE_WORKFLOW_STEPS[workflowIndex]?.hint}
              </p>
            </div>
          </div>

          {step === "load" && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-app-border bg-app-surface-2/30 p-6 text-center">
                <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-app-surface shadow-inner">
                   <ArrowLeftRight className="h-8 w-8 text-app-accent opacity-40" />
                </div>
                <h3 className="text-sm font-black text-app-text">Locate Original Transaction</h3>
                <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
                  Select one of this customer's transactions, or scan a receipt barcode to pull up eligible return items.
                </p>
              </div>

              {customer ? (
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Original Transactions
                    </p>
                    {customerTransactionsLoading ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Loading
                      </span>
                    ) : null}
                  </div>
                  {customerTransactionsError ? (
                    <p className="rounded-xl border border-app-danger/20 bg-app-danger/5 px-3 py-2 text-xs font-bold text-app-danger">
                      {customerTransactionsError}
                    </p>
                  ) : customerTransactions.length === 0 && !customerTransactionsLoading ? (
                    <p className="rounded-xl border border-app-border bg-app-surface px-3 py-3 text-xs font-semibold text-app-text-muted">
                      No transactions were found for this customer. Scan a receipt or search by transaction number below.
                    </p>
                  ) : (
                    <div className="grid gap-2">
                      {customerTransactions.map((row) => (
                        <button
                          key={row.transaction_id}
                          type="button"
                          onClick={() => void loadTransaction(row.transaction_id)}
                          disabled={loading}
                          className="flex items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface px-3 py-3 text-left transition-colors hover:border-app-accent/40 hover:bg-app-accent/5 disabled:opacity-60"
                        >
                          <div className="min-w-0">
                            <p className="font-mono text-xs font-black text-app-accent">
                              {row.display_id ?? row.transaction_id.slice(0, 8).toUpperCase()}
                            </p>
                            <p className="mt-1 truncate text-[11px] font-semibold text-app-text-muted">
                              {new Date(row.booked_at).toLocaleDateString()} · {row.item_count} item{row.item_count === 1 ? "" : "s"}
                              {row.order_items_summary ? ` · ${row.order_items_summary}` : ""}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="font-mono text-sm font-black text-app-text">
                              ${formatMoney(parseMoney(row.total_price))}
                            </p>
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              {row.status}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                 <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                   Receipt / Transaction Lookup
                 </p>
                 <TransactionSearchInput 
                    autoFocus={!customer}
                    initialQuery=""
                    onSelect={(o) => void loadTransaction(o.transaction_id)} 
                    disabled={loading}
                 />
              </div>
              <p className="text-[10px] text-app-text-muted leading-relaxed opacity-60">
                For older returns and uneven wedding group payments, confirm the transaction, member record, and return
                quantities before refunding.
              </p>
            </div>
          )}

          {step === "return" && detail && (
            <div className="space-y-6">
              <div className="flex flex-col gap-4 rounded-2xl border border-app-border bg-app-surface-2/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    Transaction Source
                  </p>
                  <p className="mt-1 text-sm font-black text-app-text">
                    Receipt: <span className="font-mono text-app-accent">{receiptLabel}</span>
                  </p>
                </div>
                <div className="flex gap-4 border-l border-app-border/50 pl-4">
                  <div className="text-right">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Status</p>
                    <p className="mt-0.5 text-xs font-bold text-emerald-500 uppercase italic tracking-tighter">
                      {detail.status}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Booked</p>
                    <p className="mt-0.5 text-xs font-bold text-app-text">
                      {new Date(detail.booked_at).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Original total</p>
                  <p className="mt-1 font-mono text-lg font-black text-app-text">
                    ${formatMoney(parseMoney(detail.total_price))}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Paid on sale</p>
                  <p className="mt-1 font-mono text-lg font-black text-emerald-500">
                    ${formatMoney(parseMoney(detail.amount_paid))}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Balance still due</p>
                  <p className="mt-1 font-mono text-lg font-black text-app-warning">
                    ${formatMoney(parseMoney(detail.balance_due))}
                  </p>
                </div>
              </div>

              {detail.payment_methods_summary && (
                <div className="rounded-xl border border-dashed border-app-border bg-app-surface-2/20 px-4 py-2">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Payment Summary: <span className="font-mono text-app-text">{detail.payment_methods_summary}</span>
                  </p>
                </div>
              )}

              <div className="space-y-3">
                <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Eligible Return Items
                </h3>
                <div className="grid gap-4">
                {detail.items.map((it: TransactionItemRow) => {
                  const max = it.quantity - (it.quantity_returned ?? 0);
                  if (max <= 0) return null;
                  return (
                    <div
                      key={it.transaction_line_id}
                      className="group flex flex-col gap-4 rounded-2xl border border-app-border bg-app-surface-2/50 p-4 transition-all hover:bg-app-surface-2 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-app-surface shadow-inner group-hover:bg-app-accent/5 transition-colors">
                          <Package className="h-6 w-6 text-app-text-muted group-hover:text-app-accent transition-colors" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-app-text">
                            {it.product_name}
                          </p>
                          <div className="mt-0.5 flex items-center gap-2">
                            <span className="rounded bg-app-surface px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-app-text-muted shadow-sm">
                              {it.sku}
                            </span>
                            <span className="text-[10px] font-bold text-app-text-muted opacity-60 italic">
                              Max return: {max}
                            </span>
                            <span className="text-[10px] font-black text-app-danger">
                              -${centsToFixed2(parseMoneyToCents(it.unit_price))}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right sm:block hidden">
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Return Qty</p>
                        </div>
                        <input
                          className="ui-input w-28 text-center font-mono text-base font-black ring-2 ring-transparent focus:ring-app-accent/20"
                          inputMode="numeric"
                          placeholder="0"
                          value={returnQtyDraft[it.transaction_line_id] ?? ""}
                          onChange={(e) =>
                            setReturnQtyDraft((d: Record<string, string>) => ({
                              ...d,
                              [it.transaction_line_id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
              {selectedRefundCents > 0 ? (
                <div className="rounded-2xl border border-app-danger/20 bg-app-danger/5 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-danger">
                      Return staged
                    </p>
                    <span className="rounded-full bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-danger">
                      {selectedReturnCount} item{selectedReturnCount === 1 ? "" : "s"} · -${centsToFixed2(selectedRefundCents)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-black text-app-text">
                    Not recorded yet. Choose “Refund customer” or “Continue exchange” to finish the return path.
                  </p>
                  <p className="mt-2 text-xs font-semibold text-app-text-muted">
                    Refund customer records the return and refund together. Continue exchange carries these staged return lines into the replacement checkout.
                  </p>
                  <p className="mt-2 text-xs font-semibold text-app-text-muted">
                    If interrupted or closed, the original Transaction Record is unchanged until the final refund or exchange settlement succeeds.
                  </p>
                  <p className="mt-2 text-xs font-bold text-app-danger">
                    Pilot watch: if this flow is reopened later, confirm the saved return lines and refund tender before register close.
                  </p>
                </div>
              ) : null}
              <div className="sticky bottom-0 -mx-6 grid gap-3 border-t border-app-border bg-app-surface/95 px-6 py-4 backdrop-blur sm:grid-cols-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitReturns("refund")}
                  className="ui-btn-secondary flex w-full items-center justify-center gap-2 py-4 font-black uppercase tracking-[0.16em]"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Refund customer
                </button>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitReturns("exchange")}
                  className="ui-btn-primary flex w-full items-center justify-center gap-2 py-4 font-black uppercase tracking-[0.16em] shadow-glow-accent-xs"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Continue exchange
                </button>
              </div>
            </div>
          )}

          {step === "done" && detail && (
            <div className="space-y-4 text-center">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-900">
                <Package className="mx-auto h-12 w-12 text-emerald-600" />
                <p className="mt-2 text-[10px] font-black uppercase tracking-[0.2em]">Return saved</p>
                <p className="mt-1 text-sm font-bold">
                  Return lines are recorded on receipt {receiptLabel}. No refund is complete until tender is selected.
                </p>
              </div>
              <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                  Negative return lines
                </p>
                <div className="mt-3 space-y-2">
                  {returnedLines.map((line) => (
                    <div key={line.transaction_line_id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-bold text-app-text">{line.quantity}x {line.product_name}</span>
                      <span className="font-mono font-black text-app-danger">
                        -${centsToFixed2((line.unit_price_cents + line.tax_cents) * line.quantity)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <p className="text-xs text-app-text-muted">
                Return lines are saved. Next step: refund this credit now, or continue to a replacement sale and refund any remaining credit afterward.
              </p>
              <div className="grid gap-3 text-left sm:grid-cols-2">
                <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Refund now
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    Use when the customer is not buying replacement items. Select the refund tender and finish before closing the drawer.
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Replacement sale
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    Use when the customer is exchanging. Add replacement items next, then settle any remaining balance or credit.
                  </p>
                </div>
              </div>
              <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left text-xs font-bold text-amber-900">
                Pilot watch: saved return lines are audit-sensitive until the refund or replacement sale is finished.
              </p>
              <div className="sticky bottom-0 -mx-6 grid gap-3 border-t border-app-border bg-app-surface/95 px-6 py-4 backdrop-blur sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!detail) return;
                    const amountCents = parseMoneyToCents(refundAmount);
                    if (amountCents <= 0) {
                      toast("No paid credit is available to refund.", "error");
                      return;
                    }
                    onContinueToReplacement({
                      originalTransactionId: detail.transaction_id,
                      customer: applyCustomer(),
                      receiptLabel,
                      returnedLines,
                      refundAmountCents: amountCents,
                      action: "refund",
                    });
                    onClose();
                  }}
                  className="ui-btn-secondary w-full py-3 font-black uppercase tracking-widest"
                >
                  Refund customer now
                </button>
                <button
                  type="button"
                  onClick={handleContinue}
                  className="ui-btn-primary w-full py-3 font-black uppercase tracking-widest"
                >
                  Continue replacement sale
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.getElementById("drawer-root")!
  );
}
