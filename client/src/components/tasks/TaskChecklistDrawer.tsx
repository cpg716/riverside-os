import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import DetailDrawer from "../layout/DetailDrawer";
import { useToast } from "../ui/ToastProviderLogic";
import { CheckSquare, Square } from "lucide-react";

const baseUrl = getBaseUrl();

export interface TaskInstanceDetailJson {
  id: string;
  title_snapshot: string;
  due_date: string | null;
  status: string;
  customer_id: string | null;
  period_key: string;
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
            <button
              type="button"
              disabled={requiredRemaining > 0 || completeBusy}
              onClick={() => void completeChecklist()}
              className="ui-btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {completeBusy ? "Completing..." : "Complete checklist"}
            </button>
          ) : (
            <p className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm font-semibold text-app-text-muted">
              This checklist is already closed.
            </p>
          )}
        </div>
      )}
    </DetailDrawer>
  );
}
