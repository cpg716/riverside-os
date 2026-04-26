import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight, X, Loader2, Package } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { parseMoney, formatMoney } from "../../lib/money";
import type { Customer } from "../pos/CustomerSelector";
import TransactionSearchInput from "../ui/TransactionSearchInput";
import ManagerApprovalModal from "./ManagerApprovalModal";

type FulfillmentKind = "takeaway" | "special_order" | "wedding_order";

interface TransactionItemRow {
  transaction_line_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  fulfillment: FulfillmentKind;
}

interface TransactionDetailLite {
  transaction_id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  payment_methods_summary?: string;
  customer: { id: string; first_name: string; last_name: string } | null;
  items: TransactionItemRow[];
}

function jsonHeaders(base: Record<string, string>): HeadersInit {
  const h = new Headers(base);
  h.set("Content-Type", "application/json");
  return h;
}

type Step = "load" | "return" | "done";

type WorkflowStep = {
  id: Step;
  label: string;
  hint: string;
};

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
    label: "Sell replacements",
    hint: "Move the customer into a replacement sale and finish checkout there.",
  },
];

export default function PosExchangeWizard({
  open,
  initialTransactionId,
  customer,
  onClose,
  sessionId,
  baseUrl,
  apiAuth,
  onContinueToReplacement,
}: {
  open: boolean;
  initialTransactionId?: string | null;
  customer?: Customer | null;
  onClose: () => void;
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onContinueToReplacement: (args: {
    originalTransactionId: string;
    customer: Customer | null;
  }) => void;
}) {
  const { toast } = useToast();
  useShellBackdropLayer(open);

  const [step, setStep] = useState<Step>("load");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<TransactionDetailLite | null>(null);
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [pendingManagerApproval, setPendingManagerApproval] = useState<TransactionDetailLite | null>(null);
  const workflowIndex = EXCHANGE_WORKFLOW_STEPS.findIndex((item) => item.id === step);
 
   const sessionQs = `register_session_id=${encodeURIComponent(sessionId)}`;

  const reset = useCallback(() => {
    setStep("load");
    setDetail(null);
    setReturnQtyDraft({});
    setPendingManagerApproval(null);
  }, []);

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
      
      const daysOld = (Date.now() - new Date(d.booked_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysOld > 60) {
        setPendingManagerApproval(d);
      } else {
        setDetail(d);
        setStep("return");
      }
    } catch {
      toast("Network error loading transaction", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, sessionQs, apiAuth, toast]);

  useEffect(() => {
    if (open && initialTransactionId) {
      void loadTransaction(initialTransactionId);
    } else if (!open) {
      reset();
    }
  }, [open, initialTransactionId, reset, loadTransaction]);

  const submitReturns = async () => {
    if (!detail) return;
    const lines: { transaction_line_id: string; quantity: number; reason?: string }[] = [];
    for (const it of detail.items) {
      const raw = (returnQtyDraft[it.transaction_line_id] ?? "").trim();
      if (!raw) continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q <= 0) continue;
      const max = it.quantity - (it.quantity_returned ?? 0);
      if (q > max) {
        toast(`Return qty too high for ${it.sku} (max ${max})`, "error");
        return;
      }
      lines.push({
        transaction_line_id: it.transaction_line_id,
        quantity: q,
        reason: "exchange",
      });
    }
    if (lines.length === 0) {
      toast("Enter return quantities for at least one line", "info");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/transactions/${encodeURIComponent(detail.transaction_id)}/returns?${sessionQs}`,
        {
          method: "POST",
          headers: jsonHeaders(apiAuth()),
          body: JSON.stringify({ lines }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Return failed", "error");
        return;
      }
      toast("Return recorded. Process any refund due from the Transactions workspace if needed.", "success");
      setStep("done");
    } catch {
      toast("Return failed", "error");
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
      company_name: null,
      email: null,
      phone: null,
    };
  };

  const handleContinue = () => {
    if (!detail) return;
    onContinueToReplacement({
      originalTransactionId: detail.transaction_id,
      customer: applyCustomer(),
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
                Register Workflow · Riverside OS
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
                  Search by customer name, phone, or Short ID to pull up the eligible items for return.
                </p>
              </div>

              <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                 <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                   Transaction Search
                 </p>
                 <TransactionSearchInput 
                    autoFocus 
                    initialQuery={customer ? `${customer.first_name} ${customer.last_name}`.trim() : ""}
                    onSelect={(o) => void loadTransaction(o.transaction_id)} 
                    disabled={loading}
                 />
              </div>
              <p className="text-[10px] text-app-text-muted leading-relaxed opacity-60">
                The transaction must have a payment on this open register session,
                or use Back Office instead. For uneven wedding group payments, confirm return
                quantities against the correct member record in Back Office.
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
                    ID: <span className="font-mono text-app-accent">{detail.transaction_id.slice(0, 8).toUpperCase()}</span>
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
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Total</p>
                  <p className="mt-1 font-mono text-lg font-black text-app-text">
                    ${formatMoney(parseMoney(detail.total_price))}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Paid</p>
                  <p className="mt-1 font-mono text-lg font-black text-emerald-500">
                    ${formatMoney(parseMoney(detail.amount_paid))}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Balance</p>
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
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitReturns()}
                className="ui-btn-primary flex w-full items-center justify-center gap-2 py-4 font-black uppercase tracking-[0.2em] shadow-glow-accent-xs"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Record returns & Proceed
              </button>
            </div>
          )}

          {step === "done" && detail && (
            <div className="space-y-4 text-center">
              <Package className="mx-auto h-12 w-12 text-emerald-600" />
              <p className="text-sm font-bold text-app-text">
                Returns are saved. Add replacement items to the cart, then complete checkout.
              </p>
              <p className="text-xs text-app-text-muted">
                After checkout, transactions link automatically for exchange reporting when both sales are
                part of the same register session.
              </p>
              <button
                type="button"
                onClick={handleContinue}
                className="ui-btn-primary w-full py-3 font-black uppercase tracking-widest"
              >
                Continue to replacement sale
              </button>
            </div>
          )}
        </div>
      </div>

      {pendingManagerApproval ? (
        <ManagerApprovalModal
          isOpen={true}
          title="Return Deadline Exceeded"
          message="This original sale is older than 60 days. A Manager PIN is required to process an exchange/return."
          onClose={() => {
            setPendingManagerApproval(null);
            setLoading(false);
          }}
          onApprove={async (pin, managerId) => {
             const res = await fetch(`${baseUrl}/api/staff/verify-pin`, {
               method: "POST",
               headers: { ...jsonHeaders(apiAuth()) },
               body: JSON.stringify({ staff_id: managerId, pin_hash: pin })
             });
             if (!res.ok) {
               throw new Error("Invalid Manager PIN.");
             }
             setDetail(pendingManagerApproval);
             setStep("return");
             setPendingManagerApproval(null);
          }}
        />
      ) : null}
    </div>,
    document.getElementById("drawer-root")!
  );
}
