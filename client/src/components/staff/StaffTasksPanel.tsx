import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCheck,
  ListChecks,
  Users,
  History,
  Plus,
  Printer,
  Search,
  Trash2,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  hasStaffOrPosAuthHeaders,
  mergedPosStaffHeaders,
} from "../../lib/posRegisterAuth";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import { useToast } from "../ui/ToastProviderLogic";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { openPrintableHtml } from "../../lib/browserPrint";

const baseUrl = getBaseUrl();

type MeJson = {
  open: {
    id: string;
    title_snapshot: string;
    due_date: string | null;
    status: string;
    period_key: string;
    assigned_by_name?: string | null;
    overdue_days?: number | null;
  }[];
  completed_recent: {
    id: string;
    title_snapshot: string;
    due_date: string | null;
    assigned_by_name?: string | null;
  }[];
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
  customer_id: string | null;
  customer_display_name: string | null;
  customer_code: string | null;
  customer_phone: string | null;
  active: boolean;
  starts_on: string | null;
  ends_on: string | null;
  assigned_by_staff_id: string | null;
  assigned_by_name: string | null;
};
type TeamRow = {
  instance_id: string;
  title_snapshot: string;
  due_date: string | null;
  assignee_staff_id: string;
  assignee_name: string;
  assignee_avatar_key: string;
  assignee_avatar_photo_url?: string | null;
  assigned_by_name?: string | null;
  overdue_days?: number | null;
};
type HistRow = {
  instance_id: string;
  title_snapshot: string;
  period_key: string;
  status: string;
  completed_at: string | null;
  assignee_name: string;
  assignee_avatar_key: string;
  assignee_avatar_photo_url?: string | null;
  assigned_by_name?: string | null;
  overdue_days?: number | null;
};
type HubRow = {
  id: string;
  full_name: string;
  cashier_code: string;
  role: string;
  avatar_key: string;
  avatar_photo_url?: string | null;
};

type SubTab = "mine" | "team" | "admin";
type TemplateDraftItem = { id: string; label: string; required: boolean };

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
  const hasTaskAuth = useCallback(
    () => hasStaffOrPosAuthHeaders(auth()),
    [auth],
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
  const [tplItems, setTplItems] = useState<TemplateDraftItem[]>([
    { id: "item-1", label: "Count cash drawer", required: true },
    { id: "item-2", label: "Verify float", required: true },
  ]);

  const [asgTemplate, setAsgTemplate] = useState("");
  const [asgRecurrence, setAsgRecurrence] = useState("daily");
  const [asgKind, setAsgKind] = useState<"staff" | "role">("role");
  const [asgStaff, setAsgStaff] = useState("");
  const [asgRole, setAsgRole] = useState("salesperson");
  const [asgCustomerId, setAsgCustomerId] = useState("");
  const [asgCustomerLabel, setAsgCustomerLabel] = useState("");
  const [asgStartsOn, setAsgStartsOn] = useState("");
  const [asgEndsOn, setAsgEndsOn] = useState("");
  const [asgActive, setAsgActive] = useState(true);
  const [editingAssignmentId, setEditingAssignmentId] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState("");
  const [teamSearch, setTeamSearch] = useState("");

  const refreshMe = useCallback(async () => {
    if (!hasTaskAuth()) {
      setMe(null);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: auth() });
      if (res.ok) setMe((await res.json()) as MeJson);
    } catch {
      /* ignore */
    }
  }, [auth, hasTaskAuth]);

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

  const refreshHistoryOnly = useCallback(async () => {
    if (!canManage) return;
    try {
      let url = `${baseUrl}/api/tasks/admin/history?limit=40`;
      if (historySearch.trim()) url += `&q=${encodeURIComponent(historySearch.trim())}`;
      const res = await fetch(url, { headers: backofficeHeaders() });
      if (res.ok) setHistory((await res.json()) as HistRow[]);
    } catch { /* ignore */ }
  }, [canManage, backofficeHeaders, historySearch]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (sub === "admin") void refreshHistoryOnly();
    }, 300);
    return () => clearTimeout(t);
  }, [historySearch, sub, refreshHistoryOnly]);

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

  const filteredTeam = useMemo(() => {
    if (!teamSearch.trim()) return team;
    const q = teamSearch.toLowerCase();
    return team.filter(
      (r) =>
        r.title_snapshot.toLowerCase().includes(q) ||
        r.assignee_name.toLowerCase().includes(q),
    );
  }, [team, teamSearch]);

  const assignmentCustomerLabel = (assignment: AssignmentRow) => {
    const name = assignment.customer_display_name?.trim();
    const pieces = [
      name && name.length > 0 ? name : null,
      assignment.customer_code,
      assignment.customer_phone,
    ].filter(Boolean);
    return pieces.length > 0 ? pieces.join(" · ") : null;
  };

  const addTemplateItem = () => {
    setTplItems((items) => [
      ...items,
      { id: `item-${Date.now()}-${items.length}`, label: "", required: true },
    ]);
  };

  const updateTemplateItem = (id: string, patch: Partial<TemplateDraftItem>) => {
    setTplItems((items) =>
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const removeTemplateItem = (id: string) => {
    setTplItems((items) =>
      items.length > 1 ? items.filter((item) => item.id !== id) : items,
    );
  };

  const printRows = (
    title: string,
    rows: {
      title: string;
      assignee?: string | null;
      due?: string | null;
      status?: string | null;
      assignedBy?: string | null;
      overdueDays?: number | null;
    }[],
  ) => {
    if (rows.length === 0) {
      toast("Nothing to print.", "error");
      return;
    }
    const esc = (value: string | null | undefined) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
    const bodyRows = rows
      .map(
        (row) => `
          <tr>
            <td>${esc(row.title)}</td>
            <td>${esc(row.assignee ?? "")}</td>
            <td>${esc(row.due ?? "")}</td>
            <td>${esc(row.status ?? "")}</td>
            <td>${esc(row.assignedBy ?? "")}</td>
            <td>${row.overdueDays && row.overdueDays > 0 ? `${row.overdueDays} day${row.overdueDays === 1 ? "" : "s"}` : ""}</td>
          </tr>
        `,
      )
      .join("");
    void openPrintableHtml(`<!doctype html>
      <html>
        <head>
          <title>${esc(title)}</title>
          <style>
            body { font-family: Inter, Arial, sans-serif; padding: 24px; color: #111827; }
            h1 { font-size: 22px; margin: 0 0 6px; }
            .meta { color: #6b7280; margin-bottom: 18px; }
            table { width: 100%; border-collapse: collapse; font-size: 12px; }
            th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
            th { background: #f3f4f6; text-transform: uppercase; letter-spacing: .06em; font-size: 10px; }
          </style>
        </head>
        <body>
          <h1>${esc(title)}</h1>
          <div class="meta">Printed ${new Date().toLocaleString()}</div>
          <table>
            <thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th><th>Assigned by</th><th>Overdue</th></tr></thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </body>
      </html>`, title, {
      filename: "riverside-staff-tasks.html",
      width: 900,
      height: 700,
    }).catch((error) => {
      toast(error instanceof Error ? error.message : "Could not open task report.", "error");
    });
  };

  const createTemplate = async () => {
    const title = tplTitle.trim();
    if (!title) {
      toast("Template title is required.", "error");
      return;
    }
    const items = tplItems
      .map((item) => ({ label: item.label.trim(), required: item.required }))
      .filter((item) => item.label.length > 0);
    if (items.length === 0) {
      toast("Add at least one checklist step.", "error");
      return;
    }
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
      setTplItems([{ id: `item-${Date.now()}`, label: "", required: true }]);
      void refreshAdmin();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    }
  };

  const resetAssignmentForm = () => {
    setEditingAssignmentId(null);
    setAsgTemplate("");
    setAsgRecurrence("daily");
    setAsgKind("role");
    setAsgStaff("");
    setAsgRole("salesperson");
    setAsgCustomerId("");
    setAsgCustomerLabel("");
    setAsgStartsOn("");
    setAsgEndsOn("");
    setAsgActive(true);
  };

  const editAssignment = (assignment: AssignmentRow) => {
    setEditingAssignmentId(assignment.id);
    setAsgTemplate(assignment.template_id);
    setAsgRecurrence(assignment.recurrence);
    setAsgKind(assignment.assignee_kind === "staff" ? "staff" : "role");
    setAsgStaff(assignment.assignee_staff_id ?? "");
    setAsgRole(assignment.assignee_role ?? "salesperson");
    setAsgCustomerId(assignment.customer_id ?? "");
    setAsgCustomerLabel(assignmentCustomerLabel(assignment) ?? "");
    setAsgStartsOn(assignment.starts_on ?? "");
    setAsgEndsOn(assignment.ends_on ?? "");
    setAsgActive(assignment.active);
  };

  const saveAssignment = async () => {
    if (!asgTemplate) {
      toast("Pick a template.", "error");
      return;
    }
    const body: Record<string, unknown> = {
      template_id: asgTemplate,
      recurrence: asgRecurrence,
      recurrence_config: {},
      assignee_kind: asgKind,
      active: asgActive,
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
    if (asgStartsOn) body.starts_on = asgStartsOn;
    if (asgEndsOn) body.ends_on = asgEndsOn;
    try {
      const url = editingAssignmentId
        ? `${baseUrl}/api/tasks/admin/assignments/${encodeURIComponent(editingAssignmentId)}`
        : `${baseUrl}/api/tasks/admin/assignments`;
      const res = await fetch(url, {
        method: editingAssignmentId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", ...backofficeHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(editingAssignmentId ? "Update failed" : "Create failed");
      toast(editingAssignmentId ? "Assignment updated." : "Assignment created.", "success");
      resetAssignmentForm();
      void refreshAdmin();
    } catch (e) {
      toast(
        e instanceof Error
          ? e.message
          : editingAssignmentId
            ? "Update failed"
            : "Create failed",
        "error",
      );
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
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Open
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    printRows(
                      "My open tasks",
                      (me?.open ?? []).map((t) => ({
                        title: t.title_snapshot,
                        due: t.due_date ?? t.period_key,
                        status: t.status,
                        assignedBy: t.assigned_by_name,
                        overdueDays: t.overdue_days,
                      })),
                    )
                  }
                  className="ui-btn-secondary inline-flex items-center gap-2 text-xs"
                >
                  <Printer size={14} />
                  Print
                </button>
              </div>
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
                        <span className="min-w-0">
                          <span className="block font-semibold text-app-text">
                            {t.title_snapshot}
                          </span>
                          {t.assigned_by_name ? (
                            <span className="block text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                              Assigned by {t.assigned_by_name}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-[10px] text-app-text-muted">
                          {t.overdue_days && t.overdue_days > 0 ? (
                            <span className="rounded-full bg-red-500/10 px-2 py-1 font-black text-red-600">
                              {t.overdue_days}d overdue
                            </span>
                          ) : null}
                          <span>{t.due_date ?? t.period_key}</span>
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
          <div className="flex flex-col gap-3 min-h-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-app-text-muted" />
                <input
                  type="text"
                  placeholder="Search team tasks…"
                  className="ui-input h-9 w-full pl-8 text-xs font-bold"
                  value={teamSearch}
                  onChange={(e) => setTeamSearch(e.target.value)}
                />
              </div>
              <button
                type="button"
                onClick={() =>
                  printRows(
                    "Open team tasks",
                    filteredTeam.map((r) => ({
                      title: r.title_snapshot,
                      assignee: r.assignee_name,
                      due: r.due_date,
                      status: "open",
                      assignedBy: r.assigned_by_name,
                      overdueDays: r.overdue_days,
                    })),
                  )
                }
                className="ui-btn-secondary inline-flex items-center gap-2 text-xs"
              >
                <Printer size={14} />
                Print
              </button>
            </div>
            <ul className="space-y-2 overflow-y-auto">
            {team.length === 0 ? (
              <p className="text-sm text-app-text-muted">No open team tasks.</p>
            ) : (
              filteredTeam.map((r) => (
                <li key={r.instance_id}>
                  <button
                    type="button"
                    onClick={() => setDrawerId(r.instance_id)}
                    className="flex w-full items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-left"
                  >
                    <img
                      src={staffAvatarUrl(r.assignee_avatar_key, r.assignee_avatar_photo_url)}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full border border-app-border"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-app-text">{r.title_snapshot}</p>
                      <p className="text-xs text-app-text-muted">
                        {r.assignee_name}
                        {r.assigned_by_name ? ` · assigned by ${r.assigned_by_name}` : ""}
                      </p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2 text-[10px] text-app-text-muted">
                      {r.overdue_days && r.overdue_days > 0 ? (
                        <span className="rounded-full bg-red-500/10 px-2 py-1 font-black text-red-600">
                          {r.overdue_days}d overdue
                        </span>
                      ) : null}
                      <span>{r.due_date ?? "—"}</span>
                    </span>
                  </button>
                </li>
              ))
            )}
            </ul>
          </div>
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
              <div className="mt-4 rounded-lg border border-app-border bg-app-bg/40 p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Checklist steps
                    </p>
                    <p className="text-xs text-app-text-muted">
                      {tplItems.filter((item) => item.required).length} required ·{" "}
                      {tplItems.filter((item) => !item.required).length} optional
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addTemplateItem}
                    className="ui-btn-secondary inline-flex items-center gap-2 text-xs"
                  >
                    <Plus size={14} />
                    Add step
                  </button>
                </div>
                <div className="space-y-2">
                  {tplItems.map((item, idx) => (
                    <div
                      key={item.id}
                      className="grid gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 sm:grid-cols-[auto_1fr_auto_auto]"
                    >
                      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-app-surface-2 text-xs font-black text-app-text-muted">
                        {idx + 1}
                      </span>
                      <input
                        className="ui-input h-9 w-full text-sm"
                        value={item.label}
                        onChange={(e) =>
                          updateTemplateItem(item.id, { label: e.target.value })
                        }
                        placeholder="Checklist step"
                      />
                      <label className="flex h-9 items-center gap-2 rounded-lg border border-app-border px-3 text-xs font-black uppercase tracking-widest text-app-text-muted">
                        <input
                          type="checkbox"
                          checked={item.required}
                          onChange={(e) =>
                            updateTemplateItem(item.id, { required: e.target.checked })
                          }
                        />
                        Required
                      </label>
                      <button
                        type="button"
                        onClick={() => removeTemplateItem(item.id)}
                        disabled={tplItems.length === 1}
                        className="ui-btn-secondary inline-flex h-9 items-center gap-2 text-xs disabled:opacity-40"
                        title="Remove step"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                {[
                  ["Daily", "Opening, closing, and register routines."],
                  ["Weekly", "Recurring floor, stock, or admin reviews."],
                  ["Monthly", "Compliance checks and recurring audits."],
                  ["Yearly", "Annual renewals and long-cycle work."],
                ].map(([label, copy]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-app-border bg-app-bg/30 p-3"
                  >
                    <p className="text-xs font-black uppercase tracking-widest text-app-text">
                      {label}
                    </p>
                    <p className="mt-1 text-xs text-app-text-muted">{copy}</p>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void createTemplate()}
                className="ui-btn-primary mt-3"
              >
                Save template
              </button>
            </section>

            <section className="rounded-xl border border-app-border bg-app-surface-2 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-black text-app-text">
                  {editingAssignmentId ? "Edit assignment" : "New assignment"}
                </h3>
                {editingAssignmentId ? (
                  <button
                    type="button"
                    onClick={resetAssignmentForm}
                    className="ui-btn-secondary text-xs"
                  >
                    Cancel edit
                  </button>
                ) : null}
              </div>
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
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Starts on
                  <input
                    type="date"
                    className="ui-input mt-1 w-full"
                    value={asgStartsOn}
                    onChange={(e) => setAsgStartsOn(e.target.value)}
                  />
                </label>
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Ends on
                  <input
                    type="date"
                    className="ui-input mt-1 w-full"
                    value={asgEndsOn}
                    onChange={(e) => setAsgEndsOn(e.target.value)}
                  />
                </label>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-app-text">
                <input
                  type="checkbox"
                  checked={asgActive}
                  onChange={(e) => setAsgActive(e.target.checked)}
                />
                Assignment active
              </label>
              <div className="mt-3">
                <label className="block text-[10px] font-black uppercase text-app-text-muted mb-1">
                  Link Customer (optional)
                </label>
                <CustomerSearchInput
                  onSelect={(c) => {
                    setAsgCustomerId(c.id);
                    setAsgCustomerLabel(
                      `${c.first_name} ${c.last_name}${c.customer_code ? ` · ${c.customer_code}` : ""}`,
                    );
                  }}
                  placeholder={asgCustomerId ? "Search to replace linked customer…" : "Search customer to link…"}
                  className="w-full"
                />
                {asgCustomerId && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <p className="text-[10px] font-bold text-emerald-600">
                      Linked: {asgCustomerLabel || "Selected customer"}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setAsgCustomerId("");
                        setAsgCustomerLabel("");
                      }}
                      className="text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void saveAssignment()}
                className="ui-btn-primary mt-3"
              >
                {editingAssignmentId ? "Save assignment" : "Create assignment"}
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
                    <div className="min-w-0">
                      <p className="font-semibold text-app-text">{a.template_title}</p>
                      <p className="text-xs text-app-text-muted">
                        {a.recurrence} ·{" "}
                        {a.assignee_kind === "staff"
                          ? roster.find((staff) => staff.id === a.assignee_staff_id)?.full_name ?? "individual"
                          : a.assignee_role ?? "role"}
                        {a.starts_on ? ` · starts ${a.starts_on}` : ""}
                        {a.ends_on ? ` · ends ${a.ends_on}` : ""}
                        {a.customer_id
                          ? ` · ${assignmentCustomerLabel(a) ?? "linked customer"}`
                          : ""}
                      </p>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        Assigned by {a.assigned_by_name ?? "Unknown"}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => editAssignment(a)}
                        className="ui-btn-secondary text-xs"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleAssignment(a.id, !a.active)}
                        className="ui-btn-secondary text-xs"
                      >
                        {a.active ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-black text-app-text">
                  <History size={16} />
                  History
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    printRows(
                      "Task history",
                      history.map((h) => ({
                        title: h.title_snapshot,
                        assignee: h.assignee_name,
                        due: h.period_key,
                        status: h.completed_at
                          ? `done ${new Date(h.completed_at).toLocaleString()}`
                          : h.status,
                        assignedBy: h.assigned_by_name,
                        overdueDays: h.overdue_days,
                      })),
                    )
                  }
                  className="ui-btn-secondary inline-flex items-center gap-2 text-xs"
                >
                  <Printer size={14} />
                  Print
                </button>
              </div>
              <div className="relative mb-3">
                <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-app-text-muted" />
                <input
                  type="text"
                  placeholder="Search history…"
                  className="ui-input h-9 w-full pl-8 text-xs font-bold"
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                />
              </div>
              <ul className="space-y-2">
                {history.map((h) => (
                  <li
                    key={h.instance_id}
                    className="flex items-center gap-3 rounded-lg border border-app-border px-3 py-2 text-sm"
                  >
                    <img
                      src={staffAvatarUrl(h.assignee_avatar_key, h.assignee_avatar_photo_url)}
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
                        {h.assigned_by_name ? ` · assigned by ${h.assigned_by_name}` : ""}
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
