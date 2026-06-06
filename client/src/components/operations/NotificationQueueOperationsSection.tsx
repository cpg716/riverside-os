import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, CheckCircle2, RefreshCw, Send, SkipForward } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

type QueueStatus = "pending" | "scheduled" | "sent" | "skipped" | "failed";

interface NotificationQueueRow {
  id: string;
  entity_type: string;
  entity_id: string;
  customer_id: string;
  kind: string;
  status: string;
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

interface NotificationQueueOperationsSectionProps {
  surface?: "backoffice" | "pos";
}

export default function NotificationQueueOperationsSection({
  surface = "backoffice",
}: NotificationQueueOperationsSectionProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<QueueStatus | "all">("all");
  const [entityType, setEntityType] = useState("all");
  const [includeReviewed, setIncludeReviewed] = useState(false);
  const [rows, setRows] = useState<NotificationQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchTime, setBatchTime] = useState(() => {
    const next = new Date();
    next.setHours(next.getHours() + 1, 0, 0, 0);
    return next.toISOString().slice(0, 16);
  });

  const canManage = hasPermission("orders.lifecycle_manage");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status, include_reviewed: String(includeReviewed) });
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
  }, [backofficeHeaders, entityType, includeReviewed, status, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        acc[row.entity_type] = (acc[row.entity_type] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [rows]);

  const sendNow = async (row: NotificationQueueRow) => {
    if (!canManage) {
      toast("Order lifecycle access is required to send queued notifications.", "error");
      return;
    }
    setBusyId(row.id);
    try {
      const res = await fetch(`${baseUrl}/api/notifications/queue/${row.id}/send-now`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
      body: JSON.stringify({ reason: "Staff sent from Operations Notification Queue." }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not send notification now.");
      }
      toast("Notification queued for immediate send.", "success");
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not send notification now.", "error");
    } finally {
      setBusyId(null);
    }
  };

  const skip = async (row: NotificationQueueRow) => {
    if (!canManage) {
      toast("Order lifecycle access is required to skip queued notifications.", "error");
      return;
    }
    setBusyId(row.id);
    try {
      const res = await fetch(`${baseUrl}/api/notifications/queue/${row.id}/skip`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not skip notification.");
      }
      toast("Notification skipped.", "success");
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not skip notification.", "error");
    } finally {
      setBusyId(null);
    }
  };

  const markReviewed = async (row: NotificationQueueRow) => {
    setBusyId(row.id);
    try {
      const res = await fetch(`${baseUrl}/api/notifications/queue/${row.id}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ note: "Reviewed from Customer Notifications." }),
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

  const scheduleBatch = async () => {
    if (!canManage) {
      toast("Order lifecycle access is required to schedule notifications.", "error");
      return;
    }
    setBusyId("batch");
    try {
      const target = new Date(batchTime);
      if (Number.isNaN(target.getTime())) {
        toast("Enter a valid batch time.", "error");
        return;
      }
      const res = await fetch(`${baseUrl}/api/notifications/queue/schedule-batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ target_time: target.toISOString() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not schedule notification batch.");
      }
      const body = (await res.json()) as { scheduled_count: number };
      toast(`${body.scheduled_count} notification${body.scheduled_count === 1 ? "" : "s"} scheduled.`, "success");
      void load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not schedule notification batch.", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-1 flex-col bg-app-surface">
      <div className="border-b border-app-border bg-app-surface px-4 py-4 sm:px-6">
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
                Customer Notifications
              </h2>
              <p className="mt-1 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
                Review customer SMS and email activity, queued sends, and failed delivery details. Mark rows reviewed after staff confirms the message status or fixes the customer contact record.
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

      <div className="space-y-4 p-4 sm:p-6">
        <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto]">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Status
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as QueueStatus | "all")}
                className="ui-input mt-1 h-11 w-full text-sm font-bold"
              >
                <option value="all">All active</option>
                <option value="pending">Pending</option>
                <option value="scheduled">Scheduled</option>
                <option value="sent">Sent</option>
                <option value="skipped">Skipped</option>
                <option value="failed">Failed</option>
              </select>
            </label>
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Type
              <select
                value={entityType}
                onChange={(event) => setEntityType(event.target.value)}
                className="ui-input mt-1 h-11 w-full text-sm font-bold"
              >
                <option value="all">All</option>
                <option value="order">Orders</option>
                <option value="alteration">Alterations</option>
                <option value="appointment">Appointments</option>
              </select>
            </label>
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Schedule pending batch
              <input
                type="datetime-local"
                value={batchTime}
                onChange={(event) => setBatchTime(event.target.value)}
                className="ui-input mt-1 h-11 w-full text-sm font-bold"
              />
            </label>
            <button
              type="button"
              onClick={() => void scheduleBatch()}
              disabled={!canManage || busyId === "batch"}
              className="ui-btn-primary mt-5 min-h-11 gap-2 px-4 disabled:opacity-50 md:mt-auto"
            >
              <Send size={15} aria-hidden />
              Schedule
            </button>
          </div>
          <p className="mt-3 text-[11px] font-semibold text-app-text-muted">
            Current list: {rows.length} row{rows.length === 1 ? "" : "s"}
            {Object.keys(counts).length > 0 ? ` · ${Object.entries(counts).map(([key, value]) => `${key}: ${value}`).join(" · ")}` : ""}
          </p>
          <label className="mt-3 flex items-center gap-2 text-[11px] font-black uppercase tracking-widest text-app-text-muted">
            <input
              type="checkbox"
              checked={includeReviewed}
              onChange={(event) => setIncludeReviewed(event.target.checked)}
              className="h-4 w-4 rounded border-app-border"
            />
            Include reviewed archive
          </label>
        </div>

        <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
          {loading ? (
            <div className="p-8 text-center text-xs font-black uppercase tracking-widest text-app-text-muted">
              Loading customer notifications...
            </div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-sm font-black text-app-text">No customer notifications match this filter.</p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Queued, sent, and failed customer SMS/email records appear here when generated.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-app-border">
              {rows.map((row) => (
                <article key={row.id} className="grid gap-4 p-4 lg:grid-cols-[1fr_auto]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {row.entity_type}
                      </span>
                      <span className="rounded-lg border border-app-accent/20 bg-app-accent/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-accent">
                        {row.kind.replace(/_/g, " ")}
                      </span>
                      <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {row.status}
                      </span>
                      {row.delivery_method ? (
                        <span className="rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          {row.delivery_method}
                        </span>
                      ) : null}
                      {row.send_immediately ? (
                        <span className="rounded-lg border border-app-success/25 bg-app-success/10 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-success">
                          Send now
                        </span>
                      ) : null}
                    </div>
                    <h3 className="mt-2 text-sm font-black text-app-text">
                      {metadataLabel(row) || `${row.entity_type} notification`}
                    </h3>
                    <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                      Sent: {formatDate(row.sent_at)} · Scheduled: {formatDate(row.scheduled_for)} · Created: {formatDate(row.created_at)}
                    </p>
                    {row.delivery_error ? (
                      <p className="mt-2 rounded-xl border border-app-danger/25 bg-app-danger/10 px-3 py-2 text-xs font-bold text-app-danger">
                        {row.delivery_error}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={!canManage || busyId === row.id || row.status === "sent"}
                      onClick={() => void sendNow(row)}
                      className="ui-btn-primary min-h-10 gap-2 px-3 text-[10px] disabled:opacity-50"
                    >
                      <Send size={14} aria-hidden />
                      Send Now
                    </button>
                    <button
                      type="button"
                      disabled={!canManage || busyId === row.id || row.status === "sent" || row.status === "skipped"}
                      onClick={() => void skip(row)}
                      className="ui-btn-secondary min-h-10 gap-2 px-3 text-[10px] disabled:opacity-50"
                    >
                      <SkipForward size={14} aria-hidden />
                      Skip
                    </button>
                    <button
                      type="button"
                      disabled={busyId === row.id || Boolean(row.reviewed_at)}
                      onClick={() => void markReviewed(row)}
                      className="ui-btn-secondary min-h-10 gap-2 px-3 text-[10px] disabled:opacity-50"
                    >
                      <CheckCircle2 size={14} aria-hidden />
                      Reviewed
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
