import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Clock,
  Inbox,
  MessageSquareText,
  RefreshCw,
  Search,
  Star,
} from "lucide-react";
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

type StatusFilter = "all" | "sent" | "suppressed";

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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/reviews/invite-rows?limit=200`, {
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

  const stats = useMemo(() => {
    const total = rows.length;
    const sent = rows.filter((r) => r.review_invite_sent_at != null).length;
    const suppressed = rows.filter((r) => r.review_invite_suppressed_at != null).length;
    const pending = total - sent - suppressed;
    return { total, sent, suppressed, pending };
  }, [rows]);

  const filteredRows = useMemo(() => {
    let filtered = rows;
    if (statusFilter === "sent") {
      filtered = filtered.filter((r) => r.review_invite_sent_at != null);
    } else if (statusFilter === "suppressed") {
      filtered = filtered.filter((r) => r.review_invite_suppressed_at != null);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((r) => {
        const customer = [r.first_name, r.last_name, r.customer_code]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          r.display_id.toLowerCase().includes(q) ||
          customer.includes(q) ||
          (r.podium_review_invite_id?.toLowerCase().includes(q) ?? false)
        );
      });
    }
    return filtered;
  }, [rows, statusFilter, search]);

  const statCards = [
    {
      label: "Total Invites",
      value: stats.total,
      icon: Inbox,
      tint: "ui-tint-default",
      border: "border-app-border",
      bg: "bg-app-surface-2",
      color: "text-app-text-muted",
    },
    {
      label: "Sent",
      value: stats.sent,
      icon: CheckCircle2,
      tint: "ui-tint-success",
      border: "border-app-success/20",
      bg: "bg-app-success/10",
      color: "text-app-success",
    },
    {
      label: "Suppressed",
      value: stats.suppressed,
      icon: Ban,
      tint: "ui-tint-warning",
      border: "border-app-warning/20",
      bg: "bg-app-warning/10",
      color: "text-app-warning",
    },
    {
      label: "Pending",
      value: stats.pending,
      icon: Clock,
      tint: "ui-tint-default",
      border: "border-app-border",
      bg: "bg-app-surface-2",
      color: "text-app-text-muted",
    },
  ];

  const filterTabs: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "sent", label: "Sent" },
    { id: "suppressed", label: "Suppressed" },
  ];

  return (
    <div className="ui-page flex flex-1 flex-col bg-transparent p-0">
      <div className="flex flex-1 flex-col bg-transparent">
        {/* Stats cards */}
        <div className="grid shrink-0 grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-6 sm:pb-2 xl:grid-cols-4">
          {statCards.map((stat) => (
            <div
              key={stat.label}
              className={`ui-card flex min-w-0 items-center gap-4 p-4 ${stat.tint}`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${stat.border} ${stat.bg} shadow-sm`}
              >
                <stat.icon size={24} className={stat.color} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                  {stat.label}
                </p>
                <p className="text-2xl font-black tabular-nums text-app-text">
                  {stat.value}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Context card */}
        <div className="px-4 sm:px-6">
          <div className="ui-card ui-tint-default px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  Review Requests
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Riverside asks customers for feedback after completed or picked-up sales. Each customer is invited at most once every 180 days.
                </p>
              </div>
              <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {filteredRows.length} {filteredRows.length === 1 ? "record" : "records"}
              </span>
            </div>
          </div>
        </div>

        {/* Data table section */}
        <div className="flex flex-1 flex-col p-3 sm:p-6 lg:p-8 animate-workspace-snap">
          <div className="ui-card flex flex-col overflow-hidden">
            {/* Toolbar */}
            <div className="flex shrink-0 flex-col gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:flex-row lg:flex-wrap lg:items-center lg:gap-4 lg:px-5">
              <div className="relative group min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by customer, order number, or invite ID…"
                  className="ui-input w-full pl-10 text-sm font-bold shadow-sm focus:border-app-accent"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {filterTabs.map((tab) => {
                  const active = statusFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStatusFilter(tab.id)}
                      className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                        active
                          ? "border-app-accent/20 bg-app-accent/10 text-app-accent"
                          : "border-app-border bg-app-surface-3 text-app-text-muted hover:bg-app-surface hover:text-app-text"
                      }`}
                      aria-pressed={active}
                    >
                      {tab.label}
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => void syncProviderStatus()}
                  disabled={syncBusy}
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${syncBusy ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  Podium
                </button>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                    aria-hidden
                  />
                  Refresh
                </button>
              </div>
            </div>

            {/* Table */}
            {loading ? (
              <div className="flex flex-1 flex-col items-center justify-center p-12">
                <Clock size={48} className="mx-auto mb-3 opacity-40" />
                <p className="text-sm font-black uppercase tracking-widest italic text-app-text-muted">
                  Loading review invites…
                </p>
              </div>
            ) : filteredRows.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center p-12">
                <Star size={48} className="mx-auto mb-3 opacity-20" />
                <p className="text-sm font-black uppercase tracking-widest italic text-app-text-muted">
                  {search.trim() ? "No matches for your search." : "No review invite activity yet."}
                </p>
                <p className="mt-2 max-w-md text-center text-xs font-semibold text-app-text-muted opacity-70">
                  {search.trim()
                    ? "Try adjusting your filters or search terms."
                    : "After a sale is completed or picked up, Riverside will send a review request and it will appear here."}
                </p>
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-app-surface-3 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                    <tr>
                      <th className="px-4 py-3">Order</th>
                      <th className="px-4 py-3">Customer</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Provider</th>
                      <th className="px-4 py-3">When</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border bg-app-surface">
                    {filteredRows.map((r) => {
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
                        <tr
                          key={r.transaction_id}
                          className="transition-colors hover:bg-app-surface-2/50"
                        >
                          <td className="px-4 py-3">
                            <span className="font-bold text-app-text">{r.display_id}</span>
                          </td>
                          <td className="px-4 py-3 text-app-text">{customer}</td>
                          <td className="px-4 py-3">
                            {sent ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-app-success/20 bg-app-success/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-success">
                                <CheckCircle2 size={12} />
                                {reviewStatusLabel(r.podium_review_invite_status, sent, suppressed)}
                              </span>
                            ) : suppressed ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-app-warning/20 bg-app-warning/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-warning">
                                <Ban size={12} />
                                {reviewStatusLabel(r.podium_review_invite_status, sent, suppressed)}
                              </span>
                            ) : (
                              <span className="ui-pill bg-app-surface-2 text-app-text-muted">
                                <Clock size={12} className="inline mr-1" />
                                Pending
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {r.podium_review_url ? (
                              <a
                                href={r.podium_review_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-xs font-bold text-app-accent underline underline-offset-4"
                              >
                                <MessageSquareText size={14} />
                                Review link
                              </a>
                            ) : (
                              <span className="text-xs text-app-text-muted">
                                {r.podium_review_invite_id ?? "—"}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-app-text-muted">
                            {fmt(when)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => setTxDetailFullId(r.transaction_id)}
                                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold"
                              >
                                Record
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenTransactionInBackoffice(r.transaction_id)}
                                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold"
                              >
                                Open
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      <TransactionDetailDrawer
        orderId={txDetailFullId}
        isOpen={!!txDetailFullId}
        onClose={() => setTxDetailFullId(null)}
        onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
      />
    </div>
  );
}
