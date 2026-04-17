import { useCallback, useEffect, useState } from "react";
import {
  Receipt,
  Printer,
  Clock,
  User,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

function fmtMoney(v: string | number): string {
  const cents = parseMoneyToCents(v);
  return formatUsdFromCents(cents);
}
import ReceiptSummaryModal from "../pos/ReceiptSummaryModal";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface TransactionDetailDrawerProps {
  orderId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenCustomerHub?: (customerId: string) => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}

interface OrderItem {
  order_item_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  unit_price: string;
  line_total: string;
}

interface OrderDetail {
  order_id: string;
  booked_at: string;
  status: string;
  sale_channel: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_code: string | null;
  items: OrderItem[];
}

interface OrderAudit {
  id: string;
  event_kind: string;
  summary: string;
  created_at: string;
}

export default function TransactionDetailDrawer({
  orderId,
  isOpen,
  onClose,
  onOpenCustomerHub,
  onOpenTransactionInBackoffice,
}: TransactionDetailDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const auth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [audit, setAudit] = useState<OrderAudit[]>([]);
  const [loading, setLoading] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    try {
      const [dRes, aRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions/${orderId}`, { headers: auth() }),
        fetch(`${baseUrl}/api/transactions/${orderId}/audit`, { headers: auth() }),
      ]);
      if (dRes.ok) setDetail((await dRes.json()) as OrderDetail);
      if (aRes.ok) setAudit((await aRes.json()) as OrderAudit[]);
    } catch (e) {
      console.error("Order load failed", e);
    } finally {
      setLoading(false);
    }
  }, [orderId, auth]);

  useEffect(() => {
    if (isOpen && orderId) {
      void load();
    } else {
      setDetail(null);
      setAudit([]);
    }
  }, [isOpen, orderId, load]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[150] flex justify-end bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="h-full w-full max-w-xl animate-in slide-in-from-right bg-app-surface shadow-2xl duration-300 sm:rounded-l-[2rem] lg:max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full flex-col overflow-hidden">
          {/* Header */}
          <div className="flex shrink-0 items-center justify-between border-b border-app-border bg-app-surface-2/40 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                <Receipt size={20} />
              </div>
              <div>
                <h2 className="text-lg font-black uppercase italic tracking-tighter text-app-text">
                  Transaction Record
                </h2>
                <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                  Order ID: {orderId?.slice(0, 8)}…
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-full border border-app-border p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
            >
              <ChevronRight size={20} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {loading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-app-accent border-t-transparent" />
              </div>
            ) : detail ? (
              <>
                {/* Status & Summary */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Status
                    </p>
                    <p className="mt-1 text-sm font-black uppercase tracking-tight text-app-text">
                      {detail.status}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Booked Date
                    </p>
                    <p className="mt-1 text-sm font-medium text-app-text">
                      {new Date(detail.booked_at).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Customer Section */}
                {detail.customer_name && (
                  <div className="rounded-2xl border border-app-border bg-app-surface-2/60 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <User size={16} className="text-app-text-muted" />
                        <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text">
                          Customer Profile
                        </h3>
                      </div>
                      {onOpenCustomerHub && detail.customer_id && (
                        <button
                          onClick={() => detail.customer_id && onOpenCustomerHub(detail.customer_id)}
                          className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                        >
                          View Hub <ExternalLink size={12} />
                        </button>
                      )}
                    </div>
                    <div className="mt-3">
                      <p className="text-sm font-black text-app-text">{detail.customer_name}</p>
                      {detail.customer_code && (
                        <p className="mt-0.5 text-[10px] font-bold text-app-text-muted opacity-80">
                          Account: {detail.customer_code}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* Line Items */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                      Items ({detail.items.length})
                    </h3>
                    <div className="h-[1px] flex-1 bg-app-border/40" />
                  </div>
                  <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        <tr>
                          <th className="px-4 py-2">Product</th>
                          <th className="px-4 py-2 text-right">Qty</th>
                          <th className="px-4 py-2 text-right">Price</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-app-border/40">
                        {detail.items.map((it) => (
                          <tr key={it.order_item_id} className="group hover:bg-app-surface-2/30">
                            <td className="px-4 py-3">
                              <p className="font-bold text-app-text">{it.product_name}</p>
                              <p className="text-[10px] font-mono text-app-text-muted">{it.sku}</p>
                              {it.variation_label && (
                                <p className="mt-0.5 text-[10px] text-app-text-muted opacity-70">
                                  {it.variation_label}
                                </p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right font-bold tabular-nums">
                              {it.quantity}
                            </td>
                            <td className="px-4 py-3 text-right font-bold tabular-nums">
                              {fmtMoney(it.line_total)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Financial Summary */}
                <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-5 shadow-inner">
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs font-bold text-app-text-muted">
                      <span>Subtotal</span>
                      <span className="tabular-nums font-mono">{fmtMoney(detail.total_price)}</span>
                    </div>
                    <div className="flex justify-between border-t border-app-border/40 pt-2 text-sm font-black text-app-text">
                      <span>Total Price</span>
                      <span className="tabular-nums font-mono">{fmtMoney(detail.total_price)}</span>
                    </div>
                    <div className="flex justify-between text-xs font-bold text-emerald-600 dark:text-emerald-400">
                      <span>Amount Paid</span>
                      <span className="tabular-nums font-mono">{fmtMoney(detail.amount_paid)}</span>
                    </div>
                    {parseFloat(detail.balance_due) > 0 && (
                      <div className="flex justify-between text-xs font-black text-app-accent">
                        <span>Balance Due</span>
                        <span className="tabular-nums font-mono">{fmtMoney(detail.balance_due)}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Audit Trail */}
                <div className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Clock size={16} className="text-app-text-muted" />
                    <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                      Audit Trail
                    </h3>
                  </div>
                  <div className="relative space-y-4 border-l-2 border-app-border/60 pl-4 py-1">
                    {audit.map((evt) => (
                      <div key={evt.id} className="relative">
                        <div className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-app-surface bg-app-border" />
                        <p className="text-xs font-black text-app-text leading-tight">{evt.summary}</p>
                        <p className="mt-0.5 text-[10px] font-bold text-app-text-muted opacity-60">
                          {new Date(evt.created_at).toLocaleString()}
                        </p>
                      </div>
                    ))}
                    {audit.length === 0 && (
                      <p className="text-xs text-app-text-muted italic">No history available.</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-center text-sm text-app-text-muted">Transaction not found.</p>
            )}
          </div>

          {/* Footer Actions */}
          <div className="shrink-0 border-t border-app-border bg-app-surface-2 p-6">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setShowReceiptModal(true)}
                disabled={!detail}
                className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg hover:bg-emerald-500 active:translate-y-0.5 disabled:opacity-50"
              >
                <Printer size={16} />
                Reprint Receipt
              </button>
              {onOpenTransactionInBackoffice && (
                <button
                  type="button"
                  onClick={() => detail && onOpenTransactionInBackoffice(detail.order_id)}
                  className="flex items-center justify-center gap-2 rounded-xl border-b-4 border-app-accent/80 bg-app-accent py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg hover:opacity-90 active:translate-y-0.5"
                >
                  <ExternalLink size={16} />
                  Full Operations
                </button>
              )}
            </div>
            <p className="mt-4 text-center text-[9px] font-bold uppercase tracking-wider text-app-text-muted opacity-60">
              Transaction Record · Riverside OS Core
            </p>
          </div>
        </div>
      </div>

      {showReceiptModal && orderId && (
        <ReceiptSummaryModal
          transactionId={orderId}
          onClose={() => setShowReceiptModal(false)}
          baseUrl={baseUrl}
          getAuthHeaders={auth}
        />
      )}
    </div>
  );
}
