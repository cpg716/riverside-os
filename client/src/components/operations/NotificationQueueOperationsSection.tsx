import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BellRing,
  CheckCircle2,
  Clock,
  Inbox,
  Mail,
  RefreshCw,
  RotateCcw,
  Search,
  UserRound,
  XCircle,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import type { Customer } from "../pos/CustomerSelector";

type QueueStatus = "pending" | "scheduled" | "sent" | "skipped" | "failed";

interface NotificationQueueRow {
  id: string;
  entity_type: string;
  entity_id: string;
  customer_id: string;
  kind: string;
  status: string;
  effective_status: string;
  scheduled_for: string | null;
  sent_at: string | null;
  send_immediately: boolean;
  override_reason: string | null;
  delivery_method: string | null;
  delivery_status: string | null;
  delivery_error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by_staff_id: string | null;
  review_note: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
}

const baseUrl = getBaseUrl();

function formatDate(value?: string | null) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function metadataLabel(row: NotificationQueueRow) {
  const customerName = row.customer_name ?? row.metadata.customer_name;
  const orderRef = row.metadata.order_ref ?? row.metadata.transaction_display_id;
  const alterationRef = row.metadata.alteration_ref ?? row.metadata.ticket_number;
  const appointment = row.metadata.appointment_type;
  return [customerName, row.customer_phone, row.customer_email, orderRef, alterationRef, appointment]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" · ");
}

function deliveryErrorDetails(error?: string | null) {
  if (!error) return null;
  if (error.includes("P0005")) {
    return {
      message:
        "Podium accepted this SMS, but carrier delivery failed. Podium did not provide the specific carrier reason. Verify the customer's mobile number and contact them another way.",
      providerCode: "P0005",
    };
  }
  return { message: error, providerCode: null };
}

interface NotificationQueueOperationsSectionProps {
  surface?: "backoffice" | "pos";
  embedded?: boolean;
  initialFocusId?: string | null;
  onOpenCustomerHub?: (customer: Customer) => void;
}

export default function NotificationQueueOperationsSection({
  surface = "backoffice",
  embedded = false,
  initialFocusId,
  onOpenCustomerHub,
}: NotificationQueueOperationsSectionProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<QueueStatus | "all">("all");
  const [entityType, setEntityType] = useState("all");
  const [includeReviewed, setIncludeReviewed] = useState(Boolean(initialFocusId));
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<NotificationQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const focusedRowRef = useRef<HTMLTableRowElement | null>(null);
  const canReview = surface === "pos" || hasPermission("orders.lifecycle_manage");

  const retryPermission = (row: NotificationQueueRow) => {
    if (row.kind === "review_invite") return hasPermission("reviews.view");
    if (row.kind === "receipt") return hasPermission("orders.view");
    if (row.kind === "ready_for_pickup" || row.kind === "alteration_ready") {
      return hasPermission("orders.lifecycle_manage");
    }
    return false;
  };

  const retrySupported = (row: NotificationQueueRow) =>
    row.kind === "review_invite" ||
    row.kind === "receipt" ||
    row.kind === "ready_for_pickup" ||
    row.kind === "alteration_ready";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: "all",
        include_reviewed: String(includeReviewed),
      });
      if (entityType !== "all") params.set("entity_type", entityType);
      const res = await fetch(`${baseUrl}/api/notifications/queue?${params.toString()}`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load notification queue.");
      }
      setRows((await res.json()) as NotificationQueueRow[]);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load notification queue.", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, entityType, includeReviewed, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const markReviewed = async (row: NotificationQueueRow) => {
    if (!canReview) {
      toast("Customer notification review access is required.", "error");
      return;
    }
    setBusyId(row.id);
    try {
      const res = await fetch(`${baseUrl}/api/notifications/queue/${row.id}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ note: "Reviewed from Customer Interactions." }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not mark notification reviewed.");
      }
      toast("Notification reviewed.", "success");
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not mark notification reviewed.", "error");
    } finally {
      setBusyId(null);
    }
  };

  const openCustomer = (row: NotificationQueueRow) => {
    if (!onOpenCustomerHub) return;
    const [firstName = "Customer", ...lastNameParts] = (row.customer_name ?? "Customer")
      .trim()
      .split(/\s+/);
    onOpenCustomerHub({
      id: row.customer_id,
      customer_code: "",
      first_name: firstName,
      last_name: lastNameParts.join(" "),
      company_name: null,
      email: row.customer_email,
      phone: row.customer_phone,
    });
  };

  const retryDelivery = async (row: NotificationQueueRow) => {
    if (!retryPermission(row)) {
      toast("Your staff access does not allow this delivery retry.", "error");
      return;
    }
    setBusyId(row.id);
    try {
      let endpoint = `${baseUrl}/api/notifications/queue/${row.id}/send-now`;
      let body: Record<string, unknown> = {
        reason: "Customer contact details reviewed; retry requested from Customer Interactions.",
      };
      if (row.kind === "review_invite") {
        endpoint = `${baseUrl}/api/reviews/invite-rows/${row.entity_id}/retry`;
        body = {};
      } else if (row.kind === "receipt") {
        const emailDelivery = row.delivery_method === "email";
        endpoint = `${baseUrl}/api/transactions/${row.entity_id}/receipt/${
          emailDelivery ? "send-email" : "send-sms"
        }`;
        body = emailDelivery
          ? {
              to_email: row.customer_email,
              gift: row.metadata.gift === true,
            }
          : {
              to_phone: row.customer_phone,
              gift: row.metadata.gift === true,
            };
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };
      if (!response.ok || payload.success === false) {
        throw new Error(
          payload.error ??
            "Delivery still failed. Confirm the updated contact detail and try the alternate channel.",
        );
      }
      toast(
        row.kind === "review_invite"
          ? "Review request scheduled for retry."
          : "Customer message retry completed.",
        "success",
      );
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not retry customer delivery.", "error");
    } finally {
      setBusyId(null);
    }
  };

  const stats = useMemo(() => {
    const sent = rows.filter((row) => row.effective_status === "sent").length;
    const failed = rows.filter((row) => row.effective_status === "failed").length;
    const needsReview = rows.filter((row) => !row.reviewed_at).length;
    const reviewed = rows.filter((row) => row.reviewed_at).length;
    return { total: rows.length, sent, failed, needsReview, reviewed };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const statusRows =
      status === "all" ? rows : rows.filter((row) => row.effective_status === status);
    const q = search.trim().toLowerCase();
    if (!q) return statusRows;
    return statusRows.filter((row) => {
      const haystack = [
        metadataLabel(row),
        row.kind,
        row.entity_type,
        row.status,
        row.delivery_method,
        row.delivery_status,
        row.delivery_error,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, search, status]);

  useEffect(() => {
    if (!initialFocusId || !focusedRowRef.current) return;
    focusedRowRef.current.scrollIntoView({ block: "center" });
    focusedRowRef.current.focus({ preventScroll: true });
  }, [filteredRows, initialFocusId]);

  const statCards = [
    { label: "Messages", value: stats.total, icon: Inbox, tint: "ui-tint-default", border: "border-app-border", bg: "bg-app-surface-2", color: "text-app-text-muted" },
    { label: "Sent", value: stats.sent, icon: CheckCircle2, tint: "ui-tint-success", border: "border-app-success/20", bg: "bg-app-success/10", color: "text-app-success" },
    { label: "Failures", value: stats.failed, icon: XCircle, tint: "ui-tint-danger", border: "border-app-danger/20", bg: "bg-app-danger/10", color: "text-app-danger" },
    { label: "Needs Review", value: stats.needsReview, icon: Clock, tint: "ui-tint-default", border: "border-app-border", bg: "bg-app-surface-2", color: "text-app-text-muted" },
  ];

  const filterTabs: { id: QueueStatus | "all"; label: string }[] = [
    { id: "all", label: "All" },
    { id: "sent", label: "Sent" },
    { id: "failed", label: "Failed" },
    { id: "skipped", label: "Skipped" },
    { id: "pending", label: "Pending" },
  ];

  return (
    <section className="ui-page flex flex-1 flex-col bg-transparent p-0">
      {!embedded ? (
      <div className="border-b border-app-border bg-app-surface/80 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
              <BellRing size={20} aria-hidden />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Operations
              </p>
              <h2 className="text-xl font-black tracking-tight text-app-text">
                Customer Interactions
              </h2>
              <p className="mt-1 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
                Review current automated SMS/email delivery and continue manual follow-up in Podium Inbox or Mailbox.
              </p>
              {surface === "pos" ? (
                <p className="mt-1 text-xs font-black uppercase tracking-widest text-app-accent">
                  POS staff access · no manager permission required to review
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ui-btn-secondary min-h-11 gap-2 px-4 disabled:opacity-50"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} aria-hidden />
            Refresh
          </button>
        </div>
      </div>
      ) : null}

      <div className="grid shrink-0 grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-6 sm:pb-2 xl:grid-cols-4">
        {statCards.map((stat) => (
          <div key={stat.label} className={`ui-card flex min-w-0 items-center gap-4 p-4 ${stat.tint}`}>
            <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${stat.border} ${stat.bg} shadow-sm`}>
              <stat.icon size={24} className={stat.color} />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                {stat.label}
              </p>
              <p className="text-2xl font-black tabular-nums text-app-text">{stat.value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-1 flex-col p-3 sm:p-6 animate-workspace-snap">
        <div className="ui-card flex flex-col overflow-hidden">
          <div className="flex shrink-0 flex-col gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:px-5">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
              <div className="relative group min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search customer, type, status, or error…"
                  className="ui-input w-full pl-10 text-sm font-bold shadow-sm focus:border-app-accent"
                />
              </div>
              <span className="rounded-full border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {filteredRows.length} {filteredRows.length === 1 ? "record" : "records"}
              </span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <select
                value={entityType}
                onChange={(event) => setEntityType(event.target.value)}
                className="ui-input h-10 min-w-[11rem] text-sm font-bold"
              >
                <option value="all">All types</option>
                <option value="order">Orders</option>
                <option value="alteration">Alterations</option>
                <option value="appointment">Appointments</option>
              </select>
              <div className="flex flex-wrap items-center gap-2">
                {filterTabs.map((tab) => {
                  const active = status === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStatus(tab.id)}
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
                <label className="inline-flex items-center gap-2 rounded-full border border-app-border bg-app-surface-3 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <input
                    type="checkbox"
                    checked={includeReviewed}
                    onChange={(event) => setIncludeReviewed(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border-app-border"
                  />
                  Reviewed archive
                </label>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="flex flex-1 flex-col items-center justify-center p-12">
              <Clock size={48} className="mx-auto mb-3 opacity-40" />
              <p className="text-sm font-black uppercase tracking-widest italic text-app-text-muted">
                  Loading automated delivery activity…
              </p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center p-12">
              <Mail size={48} className="mx-auto mb-3 opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest italic text-app-text-muted">
                No automated delivery activity.
              </p>
              <p className="mt-2 max-w-md text-center text-xs font-semibold text-app-text-muted opacity-70">
                Try another filter or refresh.
              </p>
            </div>
          ) : (
            <div className="overflow-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-app-surface-3 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  <tr>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Automation</th>
                    <th className="px-4 py-3">Delivery</th>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3 text-right">Resolution</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border bg-app-surface">
                  {filteredRows.map((row) => {
                    const isFailure = row.effective_status === "failed";
                    const deliveryError = deliveryErrorDetails(row.delivery_error);
                    return (
                      <tr
                        key={row.id}
                        ref={row.id === initialFocusId ? focusedRowRef : undefined}
                        tabIndex={row.id === initialFocusId ? -1 : undefined}
                        className={`transition-colors hover:bg-app-surface-2/50 ${
                          row.id === initialFocusId
                            ? "bg-app-accent/10 outline outline-2 outline-app-accent/30"
                            : ""
                        }`}
                      >
                        <td className="px-4 py-3">
                          <p className="font-black text-app-text">
                            {row.customer_name ?? row.customer_phone ?? row.customer_email ?? "Customer"}
                          </p>
                          <p className="mt-0.5 text-xs font-semibold text-app-text-muted">
                            {[row.customer_phone, row.customer_email].filter(Boolean).join(" · ") || "No contact detail captured"}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-app-accent/20 bg-app-accent/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-accent">
                              {row.kind.replace(/_/g, " ")}
                            </span>
                            <span className="rounded-full border border-app-border bg-app-surface-2 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                              {row.entity_type}
                            </span>
                          </div>
                          <p className="mt-2 text-xs font-semibold text-app-text-muted">
                            {metadataLabel(row) || "Automated customer message"}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${
                            isFailure
                              ? "border-app-danger/20 bg-app-danger/10 text-app-danger"
                              : row.effective_status === "sent"
                                ? "border-app-success/20 bg-app-success/10 text-app-success"
                                : "border-app-border bg-app-surface-2 text-app-text-muted"
                          }`}>
                            {isFailure ? (
                              <XCircle size={12} />
                            ) : row.effective_status === "sent" ? (
                              <CheckCircle2 size={12} />
                            ) : (
                              <Clock size={12} />
                            )}
                            {row.delivery_status ?? row.status}
                          </span>
                          <p className="mt-1 text-xs font-semibold text-app-text-muted">
                            {row.delivery_method ?? "method pending"}
                          </p>
                          {deliveryError ? (
                            <p className="mt-2 rounded-xl border border-app-danger/25 bg-app-danger/10 px-3 py-2 text-xs font-bold text-app-danger">
                              {deliveryError.message}
                              {deliveryError.providerCode ? (
                                <span className="mt-1 block text-[10px] font-black uppercase tracking-wider opacity-80">
                                  Provider code: {deliveryError.providerCode}
                                </span>
                              ) : null}
                            </p>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-xs font-semibold text-app-text-muted">
                          <p>Sent: {formatDate(row.sent_at)}</p>
                          <p className="mt-1">Created: {formatDate(row.created_at)}</p>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isFailure ? (
                            <div className="flex flex-col items-end gap-2">
                              {onOpenCustomerHub ? (
                                <button
                                  type="button"
                                  disabled={busyId === row.id}
                                  onClick={() => openCustomer(row)}
                                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                                >
                                  <UserRound size={12} aria-hidden />
                                  Update customer
                                </button>
                              ) : null}
                              {retrySupported(row) ? (
                                <button
                                  type="button"
                                  disabled={!retryPermission(row) || busyId === row.id}
                                  onClick={() => void retryDelivery(row)}
                                  title={
                                    retryPermission(row)
                                      ? "Retry using the customer's current saved contact details."
                                      : "Required source access is needed to retry this delivery."
                                  }
                                  className="ui-btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                                >
                                  <RotateCcw size={12} aria-hidden />
                                  Retry delivery
                                </button>
                              ) : (
                                <span className="max-w-52 text-right text-[10px] font-bold leading-relaxed text-app-text-muted">
                                  Update the contact detail. Appointment messages retry automatically;
                                  other messages continue in their source workspace.
                                </span>
                              )}
                              {!row.reviewed_at ? (
                                <button
                                  type="button"
                                  disabled={!canReview || busyId === row.id}
                                  onClick={() => void markReviewed(row)}
                                  className="px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted underline decoration-app-border underline-offset-4 disabled:opacity-50"
                                >
                                  Mark reviewed without retry
                                </button>
                              ) : null}
                            </div>
                          ) : row.reviewed_at ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-app-success/20 bg-app-success/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-app-success">
                              <CheckCircle2 size={12} />
                              Reviewed
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={!canReview || busyId === row.id}
                              onClick={() => void markReviewed(row)}
                              className="ui-btn-secondary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                            >
                              Mark Reviewed
                            </button>
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
      </div>
    </section>
  );
}
