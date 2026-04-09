import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

export interface ReviewInviteRow {
  order_id: string;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  review_invite_sent_at: string | null;
  review_invite_suppressed_at: string | null;
  podium_review_invite_id: string | null;
}

interface ReviewsOperationsSectionProps {
  onOpenOrderInBackoffice: (orderId: string) => void;
  refreshSignal?: number;
}

export default function ReviewsOperationsSection({
  onOpenOrderInBackoffice,
  refreshSignal = 0,
}: ReviewsOperationsSectionProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<ReviewInviteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/reviews/invite-rows?limit=120`, {
        headers: auth(),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as ReviewInviteRow[];
        setRows(Array.isArray(data) ? data : []);
      } else {
        setRows([]);
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }) : "—";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium text-app-text-muted max-w-2xl leading-relaxed">
          Post-sale review invite decisions from the receipt summary (POS). Podium review delivery is stubbed
          until the review API is configured; this list still shows suppressed vs recorded invites.
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-widest disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-app-text-muted">No review invite activity yet.</p>
      ) : (
        <div className="overflow-auto rounded-2xl border border-app-border">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-app-surface-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              <tr>
                <th className="px-3 py-2.5">Order</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">When</th>
                <th className="px-3 py-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border bg-app-surface">
              {rows.map((r) => {
                const sent = r.review_invite_sent_at != null;
                const suppressed = r.review_invite_suppressed_at != null;
                const customer =
                  [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
                  r.customer_code ||
                  "—";
                const when = sent
                  ? r.review_invite_sent_at
                  : suppressed
                    ? r.review_invite_suppressed_at
                    : null;
                return (
                  <tr key={r.order_id}>
                    <td className="px-3 py-2.5 font-mono text-xs text-app-text">
                      {r.order_id.slice(0, 8)}…
                    </td>
                    <td className="px-3 py-2.5 text-app-text">{customer}</td>
                    <td className="px-3 py-2.5">
                      {sent ? (
                        <span className="ui-pill bg-emerald-500/15 text-emerald-800 dark:text-emerald-200">
                          Invite recorded
                        </span>
                      ) : suppressed ? (
                        <span className="ui-pill bg-app-surface-2 text-app-text-muted">Suppressed</span>
                      ) : (
                        <span className="ui-pill bg-app-surface-2 text-app-text-muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-app-text-muted">{fmt(when)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => onOpenOrderInBackoffice(r.order_id)}
                        className="ui-btn-secondary px-3 py-1.5 text-xs font-bold"
                      >
                        Open order
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
