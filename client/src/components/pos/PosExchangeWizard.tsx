import { useCallback, useEffect, useState } from "react";
import { ArrowLeftRight, Loader2, Package, X } from "lucide-react";
import type { Customer } from "./CustomerSelector";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { formatMoney, parseMoney } from "../../lib/money";

type FulfillmentKind = "takeaway" | "special_order" | "wedding_order";

interface OrderItemRow {
  order_item_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  fulfillment: FulfillmentKind;
}

interface OrderDetailLite {
  order_id: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  payment_methods_summary?: string;
  customer: { id: string; first_name: string; last_name: string } | null;
  items: OrderItemRow[];
}

function jsonHeaders(base: Record<string, string>): HeadersInit {
  const h = new Headers(base);
  h.set("Content-Type", "application/json");
  return h;
}

type Step = "load" | "return" | "done";

export default function PosExchangeWizard({
  open,
  onClose,
  sessionId,
  baseUrl,
  apiAuth,
  onContinueToReplacement,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  onContinueToReplacement: (args: {
    originalOrderId: string;
    customer: Customer | null;
  }) => void;
}) {
  const { toast } = useToast();
  useShellBackdropLayer(open);

  const [step, setStep] = useState<Step>("load");
  const [orderIdInput, setOrderIdInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<OrderDetailLite | null>(null);
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const sessionQs = `register_session_id=${encodeURIComponent(sessionId)}`;

  const reset = useCallback(() => {
    setStep("load");
    setOrderIdInput("");
    setDetail(null);
    setReturnQtyDraft({});
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const loadOrder = async () => {
    const id = orderIdInput.trim();
    if (!id) {
      toast("Paste or type the original order ID", "info");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(id)}?${sessionQs}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          b.error ??
            "Could not load this order. It may be outside this register session — use Back Office Orders.",
          "error",
        );
        return;
      }
      const d = (await res.json()) as OrderDetailLite;
      if (d.status === "cancelled") {
        toast("Cancelled orders cannot be exchanged here", "error");
        return;
      }
      setDetail(d);
      setStep("return");
    } catch {
      toast("Network error loading order", "error");
    } finally {
      setLoading(false);
    }
  };

  const submitReturns = async () => {
    if (!detail) return;
    const lines: { order_item_id: string; quantity: number; reason?: string }[] = [];
    for (const it of detail.items) {
      const raw = (returnQtyDraft[it.order_item_id] ?? "").trim();
      if (!raw) continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q <= 0) continue;
      const max = it.quantity - (it.quantity_returned ?? 0);
      if (q > max) {
        toast(`Return qty too high for ${it.sku} (max ${max})`, "error");
        return;
      }
      lines.push({
        order_item_id: it.order_item_id,
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
        `${baseUrl}/api/orders/${encodeURIComponent(detail.order_id)}/returns?${sessionQs}`,
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
      toast("Return recorded. Process any refund due from the Orders workspace if needed.", "success");
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
      originalOrderId: detail.order_id,
      customer: applyCustomer(),
    });
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Exchange wizard"
      data-testid="pos-exchange-wizard-dialog"
    >
      <div className="ui-card flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col overflow-hidden border border-app-border bg-app-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5 text-app-accent" />
            <h2 className="text-sm font-black uppercase tracking-widest text-app-text">
              Exchange wizard
            </h2>
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

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step === "load" && (
            <div className="space-y-4">
              <p className="text-xs text-app-text-muted">
                Load the original sale. The order must have a payment on this open register session,
                or use Back Office Orders instead.
              </p>
              <p className="text-xs text-app-text-muted">
                For uneven wedding group payments (one payer, multiple member orders), confirm return
                quantities against the correct member order in Back Office if balances look wrong.
                Component-only changes on an open line use Orders → Swap component (inventory-aware).
              </p>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Order ID
              </label>
              <input
                className="ui-input w-full font-mono text-sm"
                value={orderIdInput}
                onChange={(e) => setOrderIdInput(e.target.value)}
                placeholder="UUID from receipt or Orders"
                autoComplete="off"
              />
              <button
                type="button"
                disabled={loading}
                onClick={() => void loadOrder()}
                className="ui-btn-primary flex w-full items-center justify-center gap-2 py-3"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Load order
              </button>
            </div>
          )}

          {step === "return" && detail && (
            <div className="space-y-4">
              <p className="text-xs font-bold text-app-text">
                Order <span className="font-mono">{detail.order_id.slice(0, 8)}…</span>
              </p>
              <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] leading-relaxed text-app-text-muted">
                <p className="font-black uppercase tracking-widest text-app-text">Order totals</p>
                <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                  <span>
                    Total{" "}
                    <span className="font-mono font-bold text-app-text">
                      ${formatMoney(parseMoney(detail.total_price))}
                    </span>
                  </span>
                  <span>
                    Paid{" "}
                    <span className="font-mono font-bold text-app-text">
                      ${formatMoney(parseMoney(detail.amount_paid))}
                    </span>
                  </span>
                  <span>
                    Balance{" "}
                    <span className="font-mono font-bold text-app-text">
                      ${formatMoney(parseMoney(detail.balance_due))}
                    </span>
                  </span>
                </p>
                {detail.payment_methods_summary ? (
                  <p className="mt-1 text-[9px]">
                    Tenders: <span className="font-mono text-app-text">{detail.payment_methods_summary}</span>
                  </p>
                ) : null}
              </div>
              <ul className="space-y-2">
                {detail.items.map((it) => {
                  const max = it.quantity - (it.quantity_returned ?? 0);
                  if (max <= 0) return null;
                  return (
                    <li
                      key={it.order_item_id}
                      className="flex flex-col gap-1 rounded-xl border border-app-border bg-app-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-xs font-black text-app-text">{it.product_name}</p>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                          {it.sku} · max return {max}
                        </p>
                      </div>
                      <input
                        className="ui-input w-24 font-mono text-sm"
                        inputMode="numeric"
                        placeholder="Qty"
                        value={returnQtyDraft[it.order_item_id] ?? ""}
                        onChange={(e) =>
                          setReturnQtyDraft((d) => ({
                            ...d,
                            [it.order_item_id]: e.target.value,
                          }))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void submitReturns()}
                className="ui-btn-primary flex w-full items-center justify-center gap-2 py-3"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Record returns
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
                After checkout, orders link automatically for exchange reporting when both sales are
                on this register session.
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
    </div>
  );
}
