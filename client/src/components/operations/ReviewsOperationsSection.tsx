import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Clock,
  ExternalLink,
  Inbox,
  MessageSquareText,
  RefreshCw,
  Search,
  Send,
  Star,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TransactionDetailDrawer from "../orders/TransactionDetailDrawer";
import PromptModal from "../ui/PromptModal";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

function reviewStatusLabel(status: string | null | undefined, sent: boolean, suppressed: boolean) {
  switch (status) {
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "scheduled":
      return "Waiting to send";
    case "sending":
      return "Sending";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
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

function reviewProviderFailureLabel(error: string | null | undefined) {
  const normalized = error?.toLowerCase() ?? "";
  if (/429|rate.?limit|too many requests/.test(normalized)) {
    return "Provider rate limit";
  }
  if (/timeout|timed out/.test(normalized)) {
    return "Provider timeout";
  }
  if (/reqwest|connect|connection|dns|http|https|url/.test(normalized)) {
    return "Provider connection problem";
  }
  return "Delivery failed";
}

export interface ReviewInviteRow {
  transaction_id: string;
  display_id: string;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  review_invite_sent_at: string | null;
  review_invite_suppressed_at: string | null;
  review_invite_scheduled_for: string | null;
  review_invite_last_attempt_at: string | null;
  review_invite_last_error: string | null;
  review_invite_delivery_channel: string | null;
  podium_review_invite_id: string | null;
  podium_review_message_id: string | null;
  podium_review_url: string | null;
  podium_review_invite_status: string | null;
}

type PodiumReviewActivityRow = {
  id: string;
  provider_review_uid: string;
  last_event_type: string;
  transaction_id: string | null;
  display_id: string | null;
  customer_id: string | null;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  conversation_id: string | null;
  author_name: string | null;
  rating: number | null;
  review_body: string | null;
  review_url: string | null;
  site_name: string | null;
  is_recommendation: boolean;
  needs_response: boolean;
  published_at: string;
  last_activity_at: string;
  response_count: number;
  latest_response_body: string | null;
  latest_response_author_name: string | null;
  latest_response_at: string | null;
};

type StatusFilter = "all" | "sent" | "scheduled" | "failed" | "suppressed";

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
  const {
    backofficeHeaders,
    hasPermission,
    permissionsLoaded,
    staffDisplayName,
  } = useBackofficeAuth();
  const { toast } = useToast();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<ReviewInviteRow[]>([]);
  const [providerReviews, setProviderReviews] = useState<PodiumReviewActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReviewInviteRow | null>(null);
  const [testSendOpen, setTestSendOpen] = useState(false);
  const [txDetailFullId, setTxDetailFullId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [reviewNeedsResponseOnly, setReviewNeedsResponseOnly] = useState(false);
  const canCancelScheduled =
    permissionsLoaded && hasPermission("reviews.manage");
  const canSendTest = permissionsLoaded && hasPermission("reviews.manage");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [invitesResponse, reviewsResponse] = await Promise.all([
        fetch(`${baseUrl}/api/reviews/invite-rows?limit=200`, {
          headers: auth(),
          cache: "no-store",
        }),
        fetch(`${baseUrl}/api/reviews/provider-reviews?limit=200`, {
          headers: auth(),
          cache: "no-store",
        }),
      ]);
      const invites = invitesResponse.ok
        ? ((await invitesResponse.json()) as ReviewInviteRow[])
        : [];
      const reviews = reviewsResponse.ok
        ? ((await reviewsResponse.json()) as PodiumReviewActivityRow[])
        : [];
      setRows(Array.isArray(invites) ? invites : []);
      setProviderReviews(Array.isArray(reviews) ? reviews : []);
      if (!invitesResponse.ok || !reviewsResponse.ok) {
        setLoadError("Some review activity could not be loaded. Refresh to try again.");
      }
    } catch {
      setRows([]);
      setProviderReviews([]);
      setLoadError("Review activity could not be loaded. Check the connection and try again.");
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
        toast("Could not update Podium review-invite status.", "error");
        return;
      }
      const result = (await res.json()) as {
        provider_rows_seen: number;
        rows_updated: number;
      };
      toast(
        `Podium review invites updated: ${result.rows_updated} rows refreshed from ${result.provider_rows_seen} provider rows.`,
        "success",
      );
      await load();
    } finally {
      setSyncBusy(false);
    }
  }, [auth, load, toast]);

  const retryFailedInvite = useCallback(
    async (transactionId: string) => {
      setRetryingId(transactionId);
      try {
        const res = await fetch(
          `${baseUrl}/api/reviews/invite-rows/${transactionId}/retry`,
          { method: "POST", headers: auth() },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast(body.error ?? "Could not reschedule review request.", "error");
          return;
        }
        toast("Review request rescheduled for the five-day delivery window.", "success");
        await load();
      } finally {
        setRetryingId(null);
      }
    },
    [auth, load, toast],
  );

  const cancelScheduledInvite = useCallback(
    async (reasonInput: string) => {
      if (!cancelTarget) return false;
      const reason = reasonInput.trim();
      const reasonLength = Array.from(reason).length;
      if (reasonLength < 12 || reasonLength > 500) {
        toast("Enter a cancellation reason between 12 and 500 characters.", "error");
        return false;
      }
      try {
        const res = await fetch(
          `${baseUrl}/api/reviews/invite-rows/${cancelTarget.transaction_id}/cancel`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...auth(),
            },
            body: JSON.stringify({ reason }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast(body.error ?? "Could not cancel the review request.", "error");
          if (res.status === 409) {
            await load();
            return true;
          }
          return false;
        }
        toast("Scheduled review request cancelled.", "success");
        await load();
        return true;
      } catch {
        toast("Could not cancel the review request.", "error");
        return false;
      }
    },
    [auth, cancelTarget, load, toast],
  );

  const sendTestReviewInvite = useCallback(
    async (phoneInput: string) => {
      const phone = phoneInput.trim();
      const digits = phone.replace(/\D/g, "");
      if (![10, 11].includes(digits.length)) {
        toast("Enter a valid US or Canadian mobile number.", "error");
        return false;
      }
      try {
        const res = await fetch(`${baseUrl}/api/reviews/test-invite`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...auth(),
          },
          body: JSON.stringify({
            phone,
            first_name: staffDisplayName.trim().split(/\s+/)[0] || null,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          toast(body.error ?? "Could not send the test review request.", "error");
          return false;
        }
        toast("Test review request accepted for SMS delivery.", "success");
        return true;
      } catch {
        toast("Could not send the test review request.", "error");
        return false;
      }
    },
    [auth, staffDisplayName, toast],
  );

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
    const sent = rows.filter((r) =>
      ["sent", "delivered"].includes(r.podium_review_invite_status ?? ""),
    ).length;
    const suppressed = rows.filter((r) => r.review_invite_suppressed_at != null).length;
    const failed = rows.filter((r) => r.podium_review_invite_status === "failed").length;
    const scheduled = rows.filter((r) =>
      ["scheduled", "sending"].includes(r.podium_review_invite_status ?? ""),
    ).length;
    return { total, sent, suppressed, failed, scheduled };
  }, [rows]);

  const providerFailureGroups = useMemo(() => {
    const counts = new Map<string, number>();
    rows
      .filter((row) => row.podium_review_invite_status === "failed")
      .forEach((row) => {
        const label = reviewProviderFailureLabel(row.review_invite_last_error);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      });
    return Array.from(counts, ([label, count]) => ({ label, count })).sort(
      (a, b) => b.count - a.count,
    );
  }, [rows]);

  const filteredRows = useMemo(() => {
    let filtered = rows;
    if (statusFilter === "sent") {
      filtered = filtered.filter((r) =>
        ["sent", "delivered"].includes(r.podium_review_invite_status ?? ""),
      );
    } else if (statusFilter === "scheduled") {
      filtered = filtered.filter((r) =>
        ["scheduled", "sending"].includes(r.podium_review_invite_status ?? ""),
      );
    } else if (statusFilter === "failed") {
      filtered = filtered.filter((r) => r.podium_review_invite_status === "failed");
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

  const filteredProviderReviews = useMemo(() => {
    const statusFiltered = reviewNeedsResponseOnly
      ? providerReviews.filter((review) => review.needs_response)
      : providerReviews;
    const q = reviewSearch.trim().toLowerCase();
    if (!q) return statusFiltered;
    return statusFiltered.filter((review) =>
      [
        review.author_name,
        review.review_body,
        review.site_name,
        review.display_id,
        review.customer_code,
        review.first_name,
        review.last_name,
        review.provider_review_uid,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [providerReviews, reviewNeedsResponseOnly, reviewSearch]);

  const reviewsNeedingResponse = providerReviews.filter(
    (review) => review.needs_response,
  ).length;

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
      label: "Cancelled / Suppressed",
      value: stats.suppressed,
      icon: Ban,
      tint: "ui-tint-warning",
      border: "border-app-warning/20",
      bg: "bg-app-warning/10",
      color: "text-app-warning",
    },
    {
      label: "Outbox",
      value: stats.scheduled,
      icon: Clock,
      tint: "ui-tint-default",
      border: "border-app-border",
      bg: "bg-app-surface-2",
      color: "text-app-text-muted",
    },
    {
      label: "Failed",
      value: stats.failed,
      icon: AlertCircle,
      tint: "ui-tint-danger",
      border: "border-app-danger/20",
      bg: "bg-app-danger/10",
      color: "text-app-danger",
    },
  ];

  const filterTabs: { id: StatusFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "sent", label: "Sent" },
    { id: "scheduled", label: "Outbox" },
    { id: "failed", label: "Failed" },
    { id: "suppressed", label: "Cancelled / Suppressed" },
  ];

  return (
    <div className="ui-page flex flex-1 flex-col bg-transparent p-0">
      <div className="flex flex-1 flex-col bg-transparent">
        {/* Stats cards */}
        <div className="grid shrink-0 grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-6 sm:pb-2 xl:grid-cols-5">
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
                  Customer Reviews & Requests
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Published Podium reviews appear here when the signed webhook arrives. Riverside separately asks customers for feedback after completed or picked-up sales.
                </p>
                <p className="mt-1 text-xs font-semibold text-app-text-muted">
                  Reviews marked Needs response stay visible for follow-up. Outbox shows requests waiting to send; authorized staff can cancel one before delivery with a recorded reason.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {providerReviews.length} posted
                </span>
                <span className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                  reviewsNeedingResponse > 0
                    ? "border-app-warning/30 bg-app-warning/10 text-app-warning"
                    : "border-app-border bg-app-surface-3 text-app-text-muted"
                }`}>
                  {reviewsNeedingResponse} need response
                </span>
              </div>
            </div>
          </div>
        </div>

        {loadError ? (
          <div className="px-4 pt-4 sm:px-6">
            <div className="ui-card ui-tint-warning flex flex-wrap items-center justify-between gap-3 px-4 py-3" role="alert">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-app-warning" aria-hidden />
                <div>
                  <p className="text-sm font-black text-app-text">Review data is incomplete</p>
                  <p className="text-xs font-semibold text-app-text-muted">{loadError}</p>
                </div>
              </div>
              <button type="button" onClick={() => void load()} className="ui-btn-secondary px-3 py-1.5 text-xs font-black">
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {providerFailureGroups.length > 0 ? (
          <div className="px-4 pt-4 sm:px-6">
            <div className="ui-card ui-tint-danger flex flex-wrap items-start justify-between gap-4 px-4 py-4" role="status">
              <div className="flex min-w-0 items-start gap-3">
                <AlertCircle className="mt-0.5 h-6 w-6 shrink-0 text-app-danger" aria-hidden />
                <div>
                  <p className="text-sm font-black text-app-text">
                    Review delivery incident · {stats.failed} affected
                  </p>
                  <p className="mt-1 text-xs font-semibold text-app-text-muted">
                    Wait for provider recovery before retrying. Retry each failed request only once; Riverside keeps the record-level evidence below.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {providerFailureGroups.map((group) => (
                      <span key={group.label} className="rounded-full border border-app-danger/25 bg-app-danger/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-danger">
                        {group.count} {group.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <button type="button" onClick={() => void syncProviderStatus()} disabled={syncBusy} className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-xs font-black disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
                Check provider status
              </button>
            </div>
          </div>
        ) : null}

        {/* Data table section */}
        <div className="flex flex-1 flex-col gap-4 p-3 sm:p-6 lg:p-8 animate-workspace-snap">
          <div className="ui-card flex flex-col overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:px-5">
              <div>
                <p className="text-sm font-black text-app-text">Published Reviews</p>
                <p className="mt-0.5 text-xs font-semibold text-app-text-muted">
                  Reviews and Riverside responses received through the signed Podium webhook.
                </p>
              </div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
                <div className="relative min-w-52 flex-1 sm:max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted" size={14} />
                  <input
                    value={reviewSearch}
                    onChange={(event) => setReviewSearch(event.target.value)}
                    placeholder="Search published reviews…"
                    aria-label="Search published reviews"
                    className="ui-input h-9 w-full pl-9 text-xs font-bold"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setReviewNeedsResponseOnly((current) => !current)}
                  aria-pressed={reviewNeedsResponseOnly}
                  className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                    reviewNeedsResponseOnly
                      ? "border-app-warning/30 bg-app-warning/10 text-app-warning"
                      : "border-app-border bg-app-surface-3 text-app-text-muted"
                  }`}
                >
                  Needs response
                </button>
                <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {filteredProviderReviews.length} shown
                </span>
              </div>
            </div>
            {loading ? (
              <div className="p-8 text-center text-sm font-semibold text-app-text-muted">
                Loading published reviews…
              </div>
            ) : filteredProviderReviews.length === 0 ? (
              <div className="p-8 text-center">
                <Star size={36} className="mx-auto mb-2 opacity-20" />
                <p className="text-sm font-black text-app-text">
                  {reviewSearch.trim() ? "No published reviews match this search." : "No published Podium reviews received yet."}
                </p>
                <p className="mt-1 text-xs font-semibold text-app-text-muted">
                  New reviews appear after Podium delivers the signed review webhook.
                </p>
              </div>
            ) : (
              <div className="overflow-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-app-surface-3 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                    <tr>
                      <th className="px-4 py-3">Review</th>
                      <th className="px-4 py-3">Customer / Record</th>
                      <th className="px-4 py-3">Follow-up</th>
                      <th className="px-4 py-3">Latest activity</th>
                      <th className="px-4 py-3 text-right">Provider</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border bg-app-surface">
                    {filteredProviderReviews.map((review) => {
                      const customer =
                        [review.first_name, review.last_name].filter(Boolean).join(" ").trim() ||
                        review.author_name ||
                        review.customer_code ||
                        "Not linked";
                      return (
                        <tr key={review.id} className="align-top hover:bg-app-surface-2/50">
                          <td className="max-w-xl px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="inline-flex items-center gap-1 font-black text-app-text">
                                <Star size={14} fill="currentColor" className="text-amber-500" />
                                {review.rating ?? "—"}/5
                              </span>
                              <span className="text-xs font-bold text-app-text-muted">
                                {review.site_name ?? "Podium"}
                              </span>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-app-text">
                              {review.review_body ?? "No written comment"}
                            </p>
                            <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                              {review.author_name ?? "Reviewer"} · {fmt(review.published_at)}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <p className="font-bold text-app-text">{customer}</p>
                            <p className="mt-1 text-xs text-app-text-muted">
                              {review.display_id ?? review.customer_code ?? "No Riverside match"}
                            </p>
                            {review.transaction_id ? (
                              <button
                                type="button"
                                onClick={() => setTxDetailFullId(review.transaction_id)}
                                aria-label={`Open Transaction Record ${review.display_id ?? review.transaction_id}`}
                                className="mt-2 text-[10px] font-black uppercase tracking-wider text-app-accent underline underline-offset-4"
                              >
                                Open Transaction Record
                              </button>
                            ) : null}
                          </td>
                          <td className="px-4 py-3">
                            {review.needs_response ? (
                              <span className="inline-flex rounded-full border border-app-warning/30 bg-app-warning/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-warning">
                                Needs response
                              </span>
                            ) : (
                              <span className="inline-flex rounded-full border border-app-success/20 bg-app-success/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-success">
                                Responded / no action
                              </span>
                            )}
                            {review.latest_response_body ? (
                              <p className="mt-2 max-w-sm text-xs text-app-text-muted">
                                <span className="font-black text-app-text">Latest response:</span>{" "}
                                {review.latest_response_body}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-4 py-3 text-xs text-app-text-muted">
                            {fmt(review.last_activity_at)}
                            <p className="mt-1">{review.response_count} {review.response_count === 1 ? "response" : "responses"}</p>
                          </td>
                          <td className="px-4 py-3 text-right">
                            {review.review_url ? (
                              <a
                                href={review.review_url}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-bold text-app-accent underline underline-offset-4"
                              >
                                Open review
                                <ExternalLink size={12} aria-hidden />
                              </a>
                            ) : (
                              <span className="text-xs text-app-text-muted">No link</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="ui-card flex flex-col overflow-hidden">
            <div className="border-b border-app-border bg-app-surface px-4 py-4 lg:px-5">
              <p className="text-sm font-black text-app-text">Review Request Activity</p>
              <p className="mt-0.5 text-xs font-semibold text-app-text-muted">
                Scheduled, delivered, cancelled, and failed review invitations.
              </p>
            </div>
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

                {canSendTest ? (
                  <button
                    type="button"
                    onClick={() => setTestSendOpen(true)}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden />
                    Send Test
                  </button>
                ) : null}

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
                  Sync Invites
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
                      const sent = ["sent", "delivered"].includes(
                        r.podium_review_invite_status ?? "",
                      );
                      const suppressed = r.review_invite_suppressed_at != null;
                      const failed = r.podium_review_invite_status === "failed";
                      const waitingToSend =
                        r.podium_review_invite_status === "scheduled";
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
                          : r.review_invite_scheduled_for ??
                            r.review_invite_last_attempt_at;

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
                            {failed ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full border border-app-danger/20 bg-app-danger/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-danger">
                                <AlertCircle size={12} />
                                {reviewProviderFailureLabel(r.review_invite_last_error)}
                              </span>
                            ) : sent ? (
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
                                {reviewStatusLabel(
                                  r.podium_review_invite_status,
                                  sent,
                                  suppressed,
                                )}
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
                              <div className="max-w-xs text-xs text-app-text-muted">
                                <span>{r.podium_review_invite_id ?? "—"}</span>
                                {r.review_invite_last_error ? (
                                  <details className="mt-1 text-app-text-muted">
                                    <summary className="cursor-pointer font-bold text-app-danger">Technical details</summary>
                                    <code className="mt-1 block max-w-xs whitespace-pre-wrap break-words text-[10px]">
                                      {r.review_invite_last_error}
                                    </code>
                                  </details>
                                ) : null}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-app-text-muted">
                            {fmt(when)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              {waitingToSend && canCancelScheduled ? (
                                <button
                                  type="button"
                                  onClick={() => setCancelTarget(r)}
                                  aria-label={`Cancel review invite for ${r.display_id}`}
                                  className="rounded-lg border border-app-danger/25 bg-app-danger/10 px-3 py-1.5 text-[10px] font-bold text-app-danger transition-colors hover:bg-app-danger/15"
                                >
                                  Cancel Invite
                                </button>
                              ) : null}
                              {failed ? (
                                <button
                                  type="button"
                                  onClick={() => void retryFailedInvite(r.transaction_id)}
                                  disabled={retryingId === r.transaction_id}
                                  aria-label={`Retry review request for ${r.display_id}`}
                                  className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold disabled:opacity-50"
                                >
                                  {retryingId === r.transaction_id
                                    ? "Scheduling…"
                                    : "Retry"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => setTxDetailFullId(r.transaction_id)}
                                aria-label={`View review request record ${r.display_id}`}
                                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-bold"
                              >
                                Record
                              </button>
                              <button
                                type="button"
                                onClick={() => onOpenTransactionInBackoffice(r.transaction_id)}
                                aria-label={`Open Transaction ${r.display_id} in Orders`}
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
      <PromptModal
        isOpen={testSendOpen}
        onClose={() => setTestSendOpen(false)}
        onSubmit={sendTestReviewInvite}
        title="Send test review request?"
        message={`This immediately sends one real SMS through Riverside's configured Podium review-request path. It uses the saved review template and your signed-in first name (${staffDisplayName.trim().split(/\s+/)[0] || "there"}) for the greeting. The send is recorded with your staff identity.`}
        placeholder="Mobile number, for example 716-555-1234"
        confirmLabel="Send Test"
      />
      <PromptModal
        isOpen={cancelTarget != null}
        onClose={() => setCancelTarget(null)}
        onSubmit={cancelScheduledInvite}
        title="Cancel scheduled review request?"
        message={
          cancelTarget
            ? `The review request for ${[cancelTarget.first_name, cancelTarget.last_name].filter(Boolean).join(" ") || cancelTarget.customer_code || "this customer"} (${cancelTarget.display_id}) is waiting to send at ${fmt(cancelTarget.review_invite_scheduled_for)}. Enter why it should not be sent. Riverside records your identity and reason. A request already being delivered cannot be cancelled.`
            : "Enter why this scheduled review request should not be sent."
        }
        placeholder="Reason (at least 12 characters)"
        confirmLabel="Cancel Invite"
      />
    </div>
  );
}
