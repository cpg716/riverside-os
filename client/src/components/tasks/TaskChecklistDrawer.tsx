import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import DetailDrawer from "../layout/DetailDrawer";
import { useToast } from "../ui/ToastProviderLogic";
import { CheckSquare, Printer, Square } from "lucide-react";
import { openPrintableHtml } from "../../lib/browserPrint";

const baseUrl = getBaseUrl();

export interface TaskInstanceDetailJson {
  id: string;
  title_snapshot: string;
  due_date: string | null;
  status: string;
  customer_id: string | null;
  period_key: string;
  assigned_by_staff_id?: string | null;
  assigned_by_name?: string | null;
  overdue_days?: number | null;
  items: {
    id: string;
    sort_order: number;
    label: string;
    required: boolean;
    done_at: string | null;
  }[];
}

interface TaskChecklistDrawerProps {
  open: boolean;
  instanceId: string | null;
  authHeaders: () => HeadersInit;
  onClose: () => void;
  onUpdated?: () => void;
}

export default function TaskChecklistDrawer({
  open,
  instanceId,
  authHeaders,
  onClose,
  onUpdated,
}: TaskChecklistDrawerProps) {
  const { toast } = useToast();
  const [detail, setDetail] = useState<TaskInstanceDetailJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [completeBusy, setCompleteBusy] = useState(false);

  const load = useCallback(async () => {
    if (!instanceId) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/tasks/instances/${encodeURIComponent(instanceId)}`, {
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Failed to load task");
      const row = (await res.json()) as TaskInstanceDetailJson & { items?: TaskInstanceDetailJson["items"] };
      setDetail({
        ...row,
        items: Array.isArray(row.items) ? row.items : [],
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load task", "error");
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [instanceId, authHeaders, toast]);

  useEffect(() => {
    if (!open || !instanceId) {
      setDetail(null);
      return;
    }
    void load();
  }, [open, instanceId, load]);

  const toggleItem = async (itemId: string, done: boolean) => {
    if (!instanceId) return;
    setBusyId(itemId);
    try {
      const res = await fetch(
        `${baseUrl}/api/tasks/instances/${encodeURIComponent(instanceId)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ done }),
        },
      );
      if (!res.ok) throw new Error("Update failed");
      await load();
      onUpdated?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
    } finally {
      setBusyId(null);
    }
  };

  const requiredRemaining = useMemo(() => {
    if (!detail) return 0;
    return detail.items.filter((item) => item.required && !item.done_at).length;
  }, [detail]);

  const doneCount = useMemo(
    () => detail?.items.filter((item) => item.done_at).length ?? 0,
    [detail],
  );

  const completeChecklist = async () => {
    if (!instanceId) return;
    setCompleteBusy(true);
    try {
      const completeRes = await fetch(
        `${baseUrl}/api/tasks/instances/${encodeURIComponent(instanceId)}/complete`,
        {
          method: "POST",
          headers: authHeaders(),
        },
      );
      if (!completeRes.ok) throw new Error("Could not complete checklist");
      const j = (await completeRes.json()) as { completed?: boolean };
      if (!j.completed) {
        toast("Complete all required items first.", "error");
        await load();
        return;
      }
      toast("Checklist completed.", "success");
      onUpdated?.();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not complete checklist", "error");
    } finally {
      setCompleteBusy(false);
    }
  };

  const printTask = () => {
    if (!detail) return;
    const esc = (value: string | null | undefined) =>
      String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const due = detail.due_date ?? "No due date";
    const overdue =
      detail.overdue_days && detail.overdue_days > 0
        ? `<span class="badge danger">${detail.overdue_days} day${detail.overdue_days === 1 ? "" : "s"} overdue</span>`
        : "";
    const items = detail.items
      .map(
        (item) => `
          <li>
            <span class="box">${item.done_at ? "✓" : ""}</span>
            <span>${esc(item.label)}</span>
            ${item.required ? '<span class="badge">Required</span>' : '<span class="badge muted">Optional</span>'}
          </li>
        `,
      )
      .join("");
    void openPrintableHtml(`<!doctype html>
      <html>
        <head>
          <title>${esc(detail.title_snapshot)}</title>
          <style>
            body { font-family: Inter, system-ui, sans-serif; color: #111827; padding: 32px; }
            h1 { font-size: 24px; margin: 0 0 8px; }
            .meta { color: #4b5563; font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
            .badge { display: inline-block; margin-left: 8px; border: 1px solid #d1d5db; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
            .badge.muted { color: #6b7280; }
            .badge.danger { color: #991b1b; border-color: #fecaca; background: #fef2f2; }
            ul { list-style: none; padding: 0; margin: 0; }
            li { display: flex; align-items: flex-start; gap: 10px; border-bottom: 1px solid #e5e7eb; padding: 10px 0; }
            .box { width: 18px; height: 18px; border: 2px solid #111827; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 900; }
            .footer { margin-top: 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; font-size: 12px; color: #4b5563; }
            .line { border-bottom: 1px solid #111827; height: 28px; margin-top: 6px; }
            @media print { body { padding: 18px; } }
          </style>
        </head>
        <body>
          <h1>${esc(detail.title_snapshot)}</h1>
          <div class="meta">
            Status: ${esc(detail.status)} ${overdue}<br />
            Due: ${esc(due)} · Period: ${esc(detail.period_key)}<br />
            Assigned by: ${esc(detail.assigned_by_name ?? "Not recorded")}<br />
            Progress: ${doneCount}/${detail.items.length} checked
          </div>
          <ul>${items}</ul>
          <div class="footer">
            <div>Completed by<div class="line"></div></div>
            <div>Completed at<div class="line"></div></div>
          </div>
        </body>
      </html>`, detail.title_snapshot, {
      filename: `riverside-task-${detail.id}.html`,
      width: 850,
      height: 950,
    }).catch((error) => {
      toast(error instanceof Error ? error.message : "Could not open task print preview.", "error");
    });
  };

  const title = detail?.title_snapshot ?? "Task";

  return (
    <DetailDrawer
      isOpen={open && !!instanceId}
      onClose={onClose}
      title={title}
      subtitle={
        detail?.due_date
          ? `Due ${detail.due_date}${detail.period_key ? ` · ${detail.period_key}` : ""}`
          : detail?.period_key ?? undefined
      }
    >
      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : !detail ? (
        <p className="text-sm text-app-text-muted">No task loaded.</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-black text-app-text">
                {doneCount}/{detail.items.length} items checked
              </p>
              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {requiredRemaining === 0 ? "Ready to complete" : `${requiredRemaining} required left`}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold text-app-text-muted">
              {detail.assigned_by_name ? (
                <span>Assigned by {detail.assigned_by_name}</span>
              ) : null}
              {detail.overdue_days && detail.overdue_days > 0 ? (
                <span className="rounded-full border border-app-danger/25 bg-app-danger/10 px-2 py-0.5 font-black uppercase tracking-widest text-app-danger">
                  {detail.overdue_days} day{detail.overdue_days === 1 ? "" : "s"} overdue
                </span>
              ) : null}
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-app-surface">
              <div
                className="h-full rounded-full bg-app-accent transition-all"
                style={{
                  width:
                    detail.items.length === 0
                      ? "0%"
                      : `${Math.round((doneCount / detail.items.length) * 100)}%`,
                }}
              />
            </div>
          </div>

          <ul className="space-y-2">
            {detail.items.map((it) => {
              const done = !!it.done_at;
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    disabled={busyId === it.id || detail.status !== "open"}
                    onClick={() => void toggleItem(it.id, !done)}
                    className="flex w-full items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2.5 text-left transition-colors hover:bg-app-surface disabled:opacity-50"
                  >
                    <span className="mt-0.5 shrink-0 text-app-accent">
                      {done ? <CheckSquare size={20} /> : <Square size={20} />}
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold text-app-text">
                      {it.label}
                      {it.required ? (
                        <span className="ml-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                          Required
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {detail.status === "open" ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={printTask}
                className="ui-btn-secondary inline-flex items-center justify-center gap-2 sm:w-auto"
              >
                <Printer size={16} aria-hidden />
                Print
              </button>
              <button
                type="button"
                disabled={requiredRemaining > 0 || completeBusy}
                onClick={() => void completeChecklist()}
                className="ui-btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {completeBusy ? "Completing..." : "Complete checklist"}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <button
                type="button"
                onClick={printTask}
                className="ui-btn-secondary inline-flex items-center justify-center gap-2"
              >
                <Printer size={16} aria-hidden />
                Print
              </button>
              <p className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm font-semibold text-app-text-muted">
                This checklist is already closed.
              </p>
            </div>
          )}
        </div>
      )}
    </DetailDrawer>
  );
}
