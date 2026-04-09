import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  ListChecks,
  Users,
  History,
  Plus,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import { useToast } from "../ui/ToastProviderLogic";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type MeJson = {
  open: {
    id: string;
    title_snapshot: string;
    due_date: string | null;
    status: string;
    period_key: string;
  }[];
  completed_recent: { id: string; title_snapshot: string; due_date: string | null }[];
};

type TemplateRow = { id: string; title: string; description: string | null };
type AssignmentRow = {
  id: string;
  template_id: string;
  template_title: string;
  recurrence: string;
  assignee_kind: string;
  assignee_staff_id: string | null;
  assignee_role: string | null;
  active: boolean;
};
type TeamRow = {
  instance_id: string;
  title_snapshot: string;
  due_date: string | null;
  assignee_staff_id: string;
  assignee_name: string;
  assignee_avatar_key: string;
};
type HistRow = {
  instance_id: string;
  title_snapshot: string;
  period_key: string;
  status: string;
  completed_at: string | null;
  assignee_name: string;
  assignee_avatar_key: string;
};
type HubRow = {
  id: string;
  full_name: string;
  cashier_code: string;
  role: string;
  avatar_key: string;
};

type SubTab = "mine" | "team" | "admin";

export default function StaffTasksPanel({
  focusInstanceId,
  onFocusConsumed,
}: {
  focusInstanceId?: string | null;
  onFocusConsumed?: () => void;
} = {}) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const auth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const canManage = hasPermission("tasks.manage");
  const canTeam = hasPermission("tasks.view_team");

  const [sub, setSub] = useState<SubTab>("mine");
  useEffect(() => {
    if (sub === "team" && !canTeam) setSub("mine");
    if (sub === "admin" && !canManage) setSub("mine");
  }, [sub, canTeam, canManage]);

  const [me, setMe] = useState<MeJson | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [assignments, setAssignments] = useState<AssignmentRow[]>([]);
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [history, setHistory] = useState<HistRow[]>([]);
  const [roster, setRoster] = useState<HubRow[]>([]);
  const [drawerId, setDrawerId] = useState<string | null>(null);

  useEffect(() => {
    const id = focusInstanceId?.trim();
    if (!id) return;
    setSub("mine");
    setDrawerId(id);
    onFocusConsumed?.();
  }, [focusInstanceId, onFocusConsumed]);

  const [tplTitle, setTplTitle] = useState("");
  const [tplDesc, setTplDesc] = useState("");
  const [tplItems, setTplItems] = useState("Count cash drawer\nVerify float");

  const [asgTemplate, setAsgTemplate] = useState("");
  const [asgRecurrence, setAsgRecurrence] = useState("daily");
  const [asgKind, setAsgKind] = useState<"staff" | "role">("role");
  const [asgStaff, setAsgStaff] = useState("");
  const [asgRole, setAsgRole] = useState("salesperson");
  const [asgCustomerId, setAsgCustomerId] = useState("");

  const refreshMe = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: auth() });
      if (res.ok) setMe((await res.json()) as MeJson);
    } catch {
      /* ignore */
    }
  }, [auth]);

  const refreshAdmin = useCallback(async () => {
    if (!canManage) return;
    try {
      const [tRes, aRes, hRes, rRes] = await Promise.all([
        fetch(`${baseUrl}/api/tasks/admin/templates`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/tasks/admin/assignments`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/tasks/admin/history?limit=40`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/staff/admin/roster`, { headers: backofficeHeaders() }),
      ]);
      if (tRes.ok) setTemplates((await tRes.json()) as TemplateRow[]);
      if (aRes.ok) setAssignments((await aRes.json()) as AssignmentRow[]);
      if (hRes.ok) setHistory((await hRes.json()) as HistRow[]);
      if (rRes.ok) setRoster((await rRes.json()) as HubRow[]);
    } catch {
      /* ignore */
    }
  }, [canManage, backofficeHeaders]);

  const refreshTeam = useCallback(async () => {
    if (!canTeam) return;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/admin/team-open`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) setTeam((await res.json()) as TeamRow[]);
    } catch {
      /* ignore */
    }
  }, [canTeam, backofficeHeaders]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    if (sub === "admin") void refreshAdmin();
  }, [sub, refreshAdmin]);

  useEffect(() => {
    if (sub === "team") void refreshTeam();
  }, [sub, refreshTeam]);

  const createTemplate = async () => {
    const title = tplTitle.trim();
    if (!title) {
      toast("Template title is required.", "error");
      return;
    }
    const items = tplItems
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((label) => ({ label, required: true }));
    try {
      const res = await fetch(`${baseUrl}/api/tasks/admin/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...backofficeHeaders() },
        body: JSON.stringify({
          title,
          description: tplDesc.trim() || null,
          items,
        }),
      });
      if (!res.ok) throw new Error("Create failed");
      toast("Template saved.", "success");
      setTplTitle("");
      setTplDesc("");
      void refreshAdmin();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    }
  };

  const createAssignment = async () => {
    if (!asgTemplate) {
      toast("Pick a template.", "error");
      return;
    }
    const body: Record<string, unknown> = {
      template_id: asgTemplate,
      recurrence: asgRecurrence,
      recurrence_config: {},
      assignee_kind: asgKind,
      active: true,
    };
    if (asgKind === "staff") {
      if (!asgStaff) {
        toast("Pick a staff member.", "error");
        return;
      }
      body.assignee_staff_id = asgStaff;
    } else {
      body.assignee_role = asgRole;
    }
    const cust = asgCustomerId.trim();
    if (cust.length > 0) body.customer_id = cust;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/admin/assignments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...backofficeHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Create failed");
      toast("Assignment created.", "success");
      void refreshAdmin();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    }
  };

  const toggleAssignment = async (id: string, active: boolean) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/tasks/admin/assignments/${encodeURIComponent(id)}/active`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify({ active }),
        },
      );
      if (!res.ok) throw new Error("Update failed");
      void refreshAdmin();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed", "error");
    }
  };

  const subTabs = useMemo(() => {
    const out: { id: SubTab; label: string; icon: typeof ListChecks }[] = [
      { id: "mine", label: "My tasks", icon: ListChecks },
    ];
    if (canTeam) out.push({ id: "team", label: "Team", icon: Users });
    if (canManage) out.push({ id: "admin", label: "Admin", icon: ClipboardCheck });
    return out;
  }, [canTeam, canManage]);

  return (
    <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden p-4">
      <div className="mb-4 flex flex-wrap gap-2 border-b border-app-border pb-3">
        {subTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSub(t.id)}
            className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
              sub === t.id
                ? "border-app-accent bg-app-accent/10 text-app-accent"
                : "border-app-border bg-app-surface-2 text-app-text-muted"
            }`}
          >
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sub === "mine" ? (
          <div className="space-y-4">
            <section>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Open
              </h3>
              {!me?.open?.length ? (
                <p className="text-sm text-app-text-muted">No open tasks.</p>
              ) : (
                <ul className="space-y-2">
                  {me.open.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setDrawerId(t.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2.5 text-left"
                      >
                        <span className="font-semibold text-app-text">{t.title_snapshot}</span>
                        <span className="text-[10px] text-app-text-muted">
                          {t.due_date ?? t.period_key}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Recently completed
              </h3>
              {!me?.completed_recent?.length ? (
                <p className="text-sm text-app-text-muted">None yet.</p>
              ) : (
                <ul className="space-y-1 text-sm text-app-text-muted">
                  {me.completed_recent.map((t) => (
                    <li key={t.id}>{t.title_snapshot}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}

        {sub === "team" ? (
          <ul className="space-y-2">
            {team.length === 0 ? (
              <p className="text-sm text-app-text-muted">No open team tasks.</p>
            ) : (
              team.map((r) => (
                <li key={r.instance_id}>
                  <button
                    type="button"
                    onClick={() => setDrawerId(r.instance_id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-left"
                  >
                    <img
                      src={staffAvatarUrl(r.assignee_avatar_key)}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full border border-app-border"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-app-text">{r.title_snapshot}</p>
                      <p className="text-xs text-app-text-muted">{r.assignee_name}</p>
                    </div>
                    <span className="text-[10px] text-app-text-muted">
                      {r.due_date ?? "—"}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}

        {sub === "admin" ? (
          <div className="space-y-8 pb-8">
            <section className="rounded-xl border border-app-border bg-app-surface-2 p-4">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-app-text">
                <Plus size={16} />
                New checklist template
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Title
                  <input
                    className="ui-input mt-1 w-full"
                    value={tplTitle}
                    onChange={(e) => setTplTitle(e.target.value)}
                  />
                </label>
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Description
                  <input
                    className="ui-input mt-1 w-full"
                    value={tplDesc}
                    onChange={(e) => setTplDesc(e.target.value)}
                  />
                </label>
              </div>
              <label className="mt-3 block text-[10px] font-black uppercase text-app-text-muted">
                Items (one per line)
                <textarea
                  className="ui-input mt-1 min-h-[100px] w-full font-mono text-sm"
                  value={tplItems}
                  onChange={(e) => setTplItems(e.target.value)}
                />
              </label>
              <button type="button" onClick={() => void createTemplate()} className="ui-btn-primary mt-3">
                Save template
              </button>
            </section>

            <section className="rounded-xl border border-app-border bg-app-surface-2 p-4">
              <h3 className="mb-3 text-sm font-black text-app-text">New assignment</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Template
                  <select
                    className="ui-input mt-1 w-full"
                    value={asgTemplate}
                    onChange={(e) => setAsgTemplate(e.target.value)}
                  >
                    <option value="">Select…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Recurrence
                  <select
                    className="ui-input mt-1 w-full"
                    value={asgRecurrence}
                    onChange={(e) => setAsgRecurrence(e.target.value)}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={asgKind === "role"}
                    onChange={() => setAsgKind("role")}
                  />
                  By role
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={asgKind === "staff"}
                    onChange={() => setAsgKind("staff")}
                  />
                  Individual
                </label>
              </div>
              {asgKind === "role" ? (
                <select
                  className="ui-input mt-2 w-full max-w-xs"
                  value={asgRole}
                  onChange={(e) => setAsgRole(e.target.value)}
                >
                  <option value="salesperson">Salesperson</option>
                  <option value="sales_support">Sales Support</option>
                  <option value="admin">Admin</option>
                </select>
              ) : (
                <select
                  className="ui-input mt-2 w-full max-w-xs"
                  value={asgStaff}
                  onChange={(e) => setAsgStaff(e.target.value)}
                >
                  <option value="">Select staff…</option>
                  {roster.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.full_name} ({r.cashier_code})
                    </option>
                  ))}
                </select>
              )}
              <label className="mt-3 block text-[10px] font-black uppercase text-app-text-muted">
                Customer ID (optional)
                <input
                  className="ui-input mt-1 w-full max-w-md font-mono text-xs"
                  placeholder="UUID from CRM"
                  value={asgCustomerId}
                  onChange={(e) => setAsgCustomerId(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => void createAssignment()}
                className="ui-btn-primary mt-3"
              >
                Create assignment
              </button>
            </section>

            <section>
              <h3 className="mb-2 text-sm font-black text-app-text">Assignments</h3>
              <ul className="space-y-2">
                {assignments.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app-border px-3 py-2 text-sm"
                  >
                    <div>
                      <span className="font-semibold text-app-text">{a.template_title}</span>
                      <span className="ml-2 text-app-text-muted">
                        {a.recurrence} ·{" "}
                        {a.assignee_kind === "staff"
                          ? "individual"
                          : a.assignee_role ?? "role"}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggleAssignment(a.id, !a.active)}
                      className="ui-btn-secondary text-xs"
                    >
                      {a.active ? "Deactivate" : "Activate"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-app-text">
                <History size={16} />
                History
              </h3>
              <ul className="space-y-2">
                {history.map((h) => (
                  <li
                    key={h.instance_id}
                    className="flex items-center gap-3 rounded-lg border border-app-border px-3 py-2 text-sm"
                  >
                    <img
                      src={staffAvatarUrl(h.assignee_avatar_key)}
                      alt=""
                      className="h-8 w-8 rounded-full border border-app-border"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-app-text">{h.title_snapshot}</p>
                      <p className="text-xs text-app-text-muted">
                        {h.assignee_name} · {h.period_key}{" "}
                        {h.completed_at
                          ? `· done ${new Date(h.completed_at).toLocaleString()}`
                          : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : null}
      </div>

      <TaskChecklistDrawer
        open={drawerId !== null}
        instanceId={drawerId}
        authHeaders={auth}
        onClose={() => setDrawerId(null)}
        onUpdated={() => {
          void refreshMe();
          void refreshTeam();
        }}
      />
    </div>
  );
}
