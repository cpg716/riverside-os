import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TaskChecklistDrawer from "./TaskChecklistDrawer";

const baseUrl = getBaseUrl();

type MeJson = {
  open: {
    id: string;
    title_snapshot: string;
    due_date: string | null;
    period_key: string;
  }[];
};

export default function RegisterTasksPanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [me, setMe] = useState<MeJson | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: auth() });
      if (res.ok) setMe((await res.json()) as MeJson);
    } catch {
      /* ignore */
    }
  }, [auth]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-app-bg">
      <header className="shrink-0 border-b border-app-border bg-app-surface px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="text-app-accent" size={18} />
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Register
            </p>
            <h2 className="text-lg font-black tracking-tight text-app-text">Shift tasks</h2>
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!me?.open?.length ? (
          <p className="text-sm text-app-text-muted">No open tasks for this shift primary.</p>
        ) : (
          <ul className="space-y-2">
            {me.open.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setDrawerId(t.id)}
                  className="flex w-full items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-3 text-left shadow-sm"
                >
                  <span className="text-sm font-bold text-app-text">{t.title_snapshot}</span>
                  <span className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                    {t.due_date ?? t.period_key}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <TaskChecklistDrawer
        open={drawerId !== null}
        instanceId={drawerId}
        authHeaders={auth}
        onClose={() => setDrawerId(null)}
        onUpdated={refresh}
      />
    </div>
  );
}
