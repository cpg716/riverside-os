import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

function reviewStatusLabel(status: string | null | undefined, sent: boolean, suppressed: boolean) {
  switch (status) {
    case "sent":
      return "Sent";
    case "suppressed":
      return "Skipped by staff";
    case "skipped_recent_180d":
      return "Skipped: asked recently";
    case "skipped_no_contact":
      return "Skipped: no contact";
    case "disabled":
      return "Reviews off";
    case "not_ready":
      return "Not completed";
    default:
      if (sent) return "Sent";
      if (suppressed) return "Skipped";
      return "Pending";
  }
}

export interface ReviewInviteRow {
  transaction_id: string;
  display_id: string;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  review_invite_sent_at: string | null;
  review_invite_suppressed_at: string | null;
  podium_review_invite_id: string | null;
  podium_review_url: string | null;
  podium_review_invite_status: string | null;
}

export interface ReviewsOperationsSectionProps {
  onOpenTransactionInBackoffice: (transactionId: string) => void;
  refreshSignal?: number;
  deepLinkTxnId?: string | null;
  onDeepLinkConsumed?: () => void;
}

export default function ReviewsOperationsSection({
  onOpenTransactionInBackoffice,
  refreshSignal = 0,
  deepLinkTxnId,
  onDeepLinkConsumed,
}: ReviewsOperationsSectionProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<ReviewInviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [txDetailFullId, setTxDetailFullId] = useState<string | null>(null);

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

  const syncProviderStatus = useCallback(async () => {
    setSyncBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/reviews/sync`, {
        method: "POST",
        headers: auth(),
      });
      if (!res.ok) {
        toast("Could not update Podium review status.", "error");
        return;
      }
      const result = (await res.json()) as {
        provider_rows_seen: number;
        rows_updated: number;
      };
      toast(
        `Podium reviews updated: ${result.rows_updated} rows refreshed from ${result.provider_rows_seen} Podium rows.`,
        "success",
      );
      await load();
    } finally {
      setSyncBusy(false);
    }
  }, [auth, load, toast]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const fmt = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(undefined, {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "—";

  useEffect(() => {
    if (deepLinkTxnId) {
      setTxDetailFullId(deepLinkTxnId);
      onDeepLinkConsumed?.();
    }
  }, [deepLinkTxnId, onDeepLinkConsumed]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium text-app-text-muted max-w-2xl leading-relaxed">
          Review requests sent from sale completion. Riverside asks after completed or picked-up sales and only once per customer every 180 days.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void syncProviderStatus()}
            disabled={syncBusy}
            className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${syncBusy ? "animate-spin" : ""}`}
              aria-hidden
            />
            Update from Podium
          </button>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-xs font-black uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw
              className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-app-text-muted">
          No review invite activity yet.
        </p>
      ) : (
        <>
          <div className="overflow-auto rounded-2xl border border-app-border">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-app-surface-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                <tr>
                  <th className="px-3 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Provider</th>
                  <th className="px-3 py-2.5">When</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border bg-app-surface">
                {rows.map((r) => {
                  const sent = r.review_invite_sent_at != null;
                  const suppressed = r.review_invite_suppressed_at != null;
                  const customer =
                    [r.first_name, r.last_name]
                      .filter(Boolean)
                      .join(" ")
                      .trim() ||
                    r.customer_code ||
                    "—";
                  const when = sent
                    ? r.review_invite_sent_at
                    : suppressed
                      ? r.review_invite_suppressed_at
                      : null;

                  return (
                    <tr key={r.transaction_id}>
                      <td className="px-3 py-2.5 font-bold">
                        {r.display_id}
                      </td>
                      <td className="px-3 py-2.5">{customer}</td>
                      <td className="px-3 py-2.5">
                        {sent ? (
                          <span className="ui-pill bg-app-success/10 text-app-success">
                            {reviewStatusLabel(r.podium_review_invite_status, sent, suppressed)}
                          </span>
                        ) : suppressed ? (
                          <span className="ui-pill bg-app-surface-2 text-app-text-muted">
                            {reviewStatusLabel(r.podium_review_invite_status, sent, suppressed)}
                          </span>
                        ) : (
                          <span className="ui-pill bg-app-surface-2 text-app-text-muted">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-app-text-muted">
                        {r.podium_review_url ? (
                          <a
                            href={r.podium_review_url}
                            target="_blank"
                            rel="noreferrer"
                            className="font-bold text-app-accent underline underline-offset-4"
                          >
                            Review link
                          </a>
                        ) : (
                          r.podium_review_invite_id ?? "—"
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-app-text-muted">
                        {fmt(when)}
                      </td>
                      <td className="px-3 py-2.5 text-right flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setTxDetailFullId(r.transaction_id)}
                          className="ui-btn-secondary px-3 py-1.5 text-xs font-bold"
                        >
                          Record
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenTransactionInBackoffice(r.transaction_id)}
                          className="ui-btn-secondary px-3 py-1.5 text-xs font-bold"
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <TransactionDetailDrawer
            orderId={txDetailFullId}
            isOpen={!!txDetailFullId}
            onClose={() => setTxDetailFullId(null)}
            onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
          />
        </>
      )}
    </div>
  );
}
