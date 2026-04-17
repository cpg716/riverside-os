import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useToast } from "../ui/ToastProviderLogic";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { X as CloseIcon } from "lucide-react";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

function fmtMoney(s: string) {
  const t = String(s).trim();
  if (!t) return "—";
  const normalized = t.replace(/,/g, "");
  if (!Number.isFinite(Number.parseFloat(normalized))) return t;
  return formatUsdFromCents(parseMoneyToCents(normalized));
}

export interface RmsChargeAdminSectionProps {
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}

type RmsRecordRow = {
  id: string;
  record_kind: string;
  created_at: string;
  order_id: string;
  register_session_id: string;
  customer_id: string | null;
  payment_method: string;
  amount: string;
  operator_staff_id: string | null;
  payment_transaction_id: string | null;
  customer_display: string | null;
  order_short_ref: string | null;
  customer_name: string | null;
  customer_code: string | null;
  operator_name: string | null;
};

const PAGE = 100;

export default function RmsChargeAdminSection({
  onOpenTransactionInBackoffice,
}: RmsChargeAdminSectionProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<"" | "charge" | "payment">("");
  const [customerId, setCustomerId] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<RmsRecordRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const fetchPage = useCallback(
    async (nextOffset: number, append: boolean) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("from", from);
        params.set("to", to);
        if (kind) params.set("kind", kind);
        const cid = customerId.trim();
        if (cid) params.set("customer_id", cid);
        const sq = q.trim();
        if (sq) params.set("q", sq);
        params.set("limit", String(PAGE));
        params.set("offset", String(nextOffset));
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/records?${params.toString()}`,
          { headers: apiAuth() },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? "Could not load records");
        }
        const data = (await res.json()) as RmsRecordRow[];
        setHasMore(data.length >= PAGE);
        setOffset(nextOffset + data.length);
        setRows((prev) => (append ? [...prev, ...data] : data));
      } catch (e) {
        toast(e instanceof Error ? e.message : "Load failed", "error");
        if (!append) setRows([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [apiAuth, customerId, from, kind, q, to, toast],
  );

  useEffect(() => {
    setOffset(0);
    void fetchPage(0, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- filter-driven refresh only
  }, [from, to, kind, customerId, q]);

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 shrink-0">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          Customers
        </p>
        <h2 className="text-2xl font-black tracking-tight text-app-text">
          RMS charge (R2S)
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-app-text-muted">
          Store charges on RMS/RMS90 account tenders and cash or check collections
          posted against the RMS CHARGE PAYMENT line.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-app-surface-2 p-4">
        <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="ui-input py-2 text-xs font-semibold normal-case"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="ui-input py-2 text-xs font-semibold normal-case"
          />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Kind
          <select
            value={kind}
            onChange={(e) =>
              setKind(e.target.value as "" | "charge" | "payment")
            }
            className="ui-input py-2 text-xs font-semibold normal-case"
          >
            <option value="">All</option>
            <option value="charge">Charge (RMS tender)</option>
            <option value="payment">Payment (cash/check)</option>
          </select>
        </label>
        <div className="flex min-w-[240px] flex-1 flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Customer Filter
          {customerId ? (
            <div className="flex h-[38px] items-center justify-between rounded-xl border border-app-accent bg-app-accent/5 px-3">
              <span className="truncate text-[10px] font-black uppercase tracking-widest text-app-accent">
                ID: {customerId.slice(0, 8)}...
              </span>
              <button
                type="button"
                onClick={() => setCustomerId("")}
                className="ml-2 text-app-accent hover:text-black"
                aria-label="Clear customer filter"
              >
                <CloseIcon size={14} />
              </button>
            </div>
          ) : (
            <CustomerSearchInput
              onSelect={(c) => setCustomerId(c.id)}
              placeholder="Filter by name or code…"
              className="py-0.5"
            />
          )}
        </div>
        <label className="flex min-w-[200px] flex-[2] flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Search
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Code, name, order ref, tender…"
            className="ui-input py-2 text-xs font-semibold normal-case"
          />
        </label>
      </div>

      <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden p-0">
        <div className="no-scrollbar min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-[1] bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Tender</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Order</th>
                <th className="px-4 py-3">Operator</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm text-app-text-muted"
                  >
                    No records in this range.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-app-border transition-colors hover:bg-app-surface-2"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-app-text-muted">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                        r.record_kind === "payment"
                          ? "bg-emerald-500/15 text-emerald-800"
                          : "bg-amber-500/15 text-amber-900"
                      }`}
                    >
                      {r.record_kind}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                    {fmtMoney(r.amount)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs uppercase text-app-text">
                    {r.payment_method}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="font-semibold text-app-text">
                      {r.customer_name || r.customer_display || "—"}
                    </div>
                    {r.customer_code ? (
                      <div className="mt-0.5 font-mono text-[11px] text-app-text-muted">
                        {r.customer_code}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {onOpenTransactionInBackoffice ? (
                      <button
                        type="button"
                        onClick={() => onOpenTransactionInBackoffice(r.order_id)}
                        className="text-left font-mono text-xs text-[var(--app-accent)] underline-offset-2 hover:underline"
                      >
                        {r.order_short_ref || r.order_id.slice(0, 8)}
                      </button>
                    ) : (
                      <span className="font-mono text-xs text-app-text-muted">
                        {r.order_short_ref || r.order_id.slice(0, 8)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-app-text-muted">
                    {r.operator_name || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {hasMore ? (
          <div className="shrink-0 border-t border-app-border p-3">
            <button
              type="button"
              disabled={loading}
              onClick={() => void fetchPage(offset, true)}
              className="ui-btn-secondary w-full py-2 text-[10px] font-black uppercase tracking-widest"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
