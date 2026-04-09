import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Loader2, Save, Trash2 } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { useToast } from "../ui/ToastProvider";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type EligibleRow = { id: string; full_name: string; role: string };
type WeeklyRow = { weekday: number; works: boolean };
type ExceptionRow = {
  id: string;
  staff_id: string;
  exception_date: string;
  kind: string;
  notes: string | null;
};
type EffectiveDay = { date: string; working: boolean };

function toYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}-${String(mo).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthBounds(cursor: Date): { from: string; to: string } {
  const from = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  return { from: toYmdLocal(from), to: toYmdLocal(to) };
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EXCEPTION_KINDS = [
  { value: "sick", label: "Sick" },
  { value: "pto", label: "PTO" },
  { value: "missed_shift", label: "Missed shift" },
  { value: "extra_shift", label: "Extra shift (working)" },
] as const;

function kindLabel(k: string): string {
  return EXCEPTION_KINDS.find((x) => x.value === k)?.label ?? k;
}

export default function StaffSchedulePanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canEdit = hasPermission("tasks.manage") || hasPermission("staff.manage_access");

  const [eligible, setEligible] = useState<EligibleRow[]>([]);
  const [staffId, setStaffId] = useState("");
  const [weeklyWorks, setWeeklyWorks] = useState<boolean[]>(() => Array(7).fill(true));
  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [effective, setEffective] = useState<EffectiveDay[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingWeekly, setSavingWeekly] = useState(false);

  const [excDate, setExcDate] = useState(() => toYmdLocal(new Date()));
  const [excKind, setExcKind] = useState<string>("sick");
  const [excNotes, setExcNotes] = useState("");

  const [absDate, setAbsDate] = useState(() => toYmdLocal(new Date()));
  const [absKind, setAbsKind] = useState<string>("sick");
  const [absNotes, setAbsNotes] = useState("");
  const [absAction, setAbsAction] = useState<"none" | "unassign" | "reassign">("unassign");
  const [absReassignTo, setAbsReassignTo] = useState("");
  const [absBusy, setAbsBusy] = useState(false);

  const headers = useMemo(() => {
    const h = new Headers(backofficeHeaders());
    return h;
  }, [backofficeHeaders]);

  const loadEligible = useCallback(async () => {
    const res = await fetch(`${baseUrl}/api/staff/schedule/eligible`, { headers });
    if (!res.ok) {
      toast("Could not load schedule-eligible staff.", "error");
      return;
    }
    const rows = (await res.json()) as EligibleRow[];
    setEligible(rows);
    setStaffId((prev) => prev || (rows[0]?.id ?? ""));
  }, [headers, toast]);

  const loadStaffData = useCallback(async () => {
    if (!staffId) {
      setEffective([]);
      setExceptions([]);
      return;
    }
    const { from, to } = monthBounds(monthCursor);
    setLoading(true);
    try {
      const [wRes, eRes, xRes] = await Promise.all([
        fetch(`${baseUrl}/api/staff/schedule/weekly/${staffId}`, { headers }),
        fetch(
          `${baseUrl}/api/staff/schedule/effective?staff_id=${encodeURIComponent(staffId)}&from=${from}&to=${to}`,
          { headers },
        ),
        fetch(
          `${baseUrl}/api/staff/schedule/exceptions?staff_id=${encodeURIComponent(staffId)}&from=${from}&to=${to}`,
          { headers },
        ),
      ]);
      if (wRes.ok) {
        const wrows = (await wRes.json()) as WeeklyRow[];
        const next = Array(7).fill(true) as boolean[];
        for (const r of wrows) {
          if (r.weekday >= 0 && r.weekday <= 6) next[r.weekday] = r.works;
        }
        setWeeklyWorks(next);
      }
      if (eRes.ok) {
        const body = (await eRes.json()) as { days: EffectiveDay[] };
        setEffective(body.days ?? []);
      } else {
        setEffective([]);
      }
      if (xRes.ok) {
        setExceptions(await xRes.json());
      } else {
        setExceptions([]);
      }
    } finally {
      setLoading(false);
    }
  }, [staffId, monthCursor, headers]);

  useEffect(() => {
    void loadEligible();
  }, [loadEligible]);

  useEffect(() => {
    void loadStaffData();
  }, [loadStaffData]);

  const saveWeekly = async () => {
    if (!canEdit || !staffId) return;
    setSavingWeekly(true);
    try {
      const weekdays = weeklyWorks.map((works, weekday) => ({ weekday, works }));
      const res = await fetch(`${baseUrl}/api/staff/schedule/weekly`, {
        method: "PUT",
        headers: { ...Object.fromEntries(headers.entries()), "Content-Type": "application/json" },
        body: JSON.stringify({ staff_id: staffId, weekdays }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Could not save weekly pattern.", "error");
        return;
      }
      toast("Weekly schedule saved.", "success");
      await loadStaffData();
    } finally {
      setSavingWeekly(false);
    }
  };

  const addException = async () => {
    if (!canEdit || !staffId) return;
    const res = await fetch(`${baseUrl}/api/staff/schedule/exceptions`, {
      method: "POST",
      headers: { ...Object.fromEntries(headers.entries()), "Content-Type": "application/json" },
      body: JSON.stringify({
        staff_id: staffId,
        exception_date: excDate,
        kind: excKind,
        notes: excNotes.trim() || null,
      }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Could not save exception.", "error");
      return;
    }
    toast("Day exception saved.", "success");
    setExcNotes("");
    await loadStaffData();
  };

  const removeException = async (exceptionDate: string) => {
    if (!canEdit || !staffId) return;
    const q = new URLSearchParams({
      staff_id: staffId,
      exception_date: exceptionDate,
    });
    const res = await fetch(`${baseUrl}/api/staff/schedule/exceptions?${q}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Could not remove exception.", "error");
      return;
    }
    toast("Exception removed.", "success");
    await loadStaffData();
  };

  const submitMarkAbsence = async () => {
    if (!canEdit || !staffId) return;
    if (absAction === "reassign" && !absReassignTo) {
      toast("Choose a teammate to reassign appointments to.", "error");
      return;
    }
    setAbsBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/schedule/mark-absence`, {
        method: "POST",
        headers: { ...Object.fromEntries(headers.entries()), "Content-Type": "application/json" },
        body: JSON.stringify({
          staff_id: staffId,
          absence_date: absDate,
          kind: absKind,
          notes: absNotes.trim() || null,
          unassign_appointments: absAction === "unassign",
          reassign_to_staff_id:
            absAction === "reassign" && absReassignTo ? absReassignTo : null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        appointments_updated?: number;
        tasks_cancelled?: number;
        appointment_ids?: string[];
      };
      if (!res.ok) {
        toast(body.error ?? "Could not record absence.", "error");
        return;
      }
      const au = body.appointments_updated ?? 0;
      const tc = body.tasks_cancelled ?? 0;
      toast(
        `Absence recorded. ${au} appointment(s) updated, ${tc} daily task instance(s) cancelled.`,
        "success",
      );
      setAbsNotes("");
      await loadStaffData();
    } finally {
      setAbsBusy(false);
    }
  };

  const calendarCells = useMemo(() => {
    const { from, to } = monthBounds(monthCursor);
    const start = new Date(from + "T12:00:00");
    const end = new Date(to + "T12:00:00");
    const map = new Map(effective.map((d) => [d.date, d.working]));
    const excMap = new Map(exceptions.map((e) => [e.exception_date, e]));
    const cells: {
      date: string;
      dayNum: number;
      working: boolean;
      exception?: ExceptionRow;
    }[] = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const ymd = toYmdLocal(d);
      cells.push({
        date: ymd,
        dayNum: d.getDate(),
        working: map.get(ymd) ?? true,
        exception: excMap.get(ymd),
      });
    }
    return cells;
  }, [monthCursor, effective, exceptions]);

  const monthLabel = monthCursor.toLocaleString(undefined, { month: "long", year: "numeric" });

  return (
    <section className="ui-card flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2))] text-[var(--app-accent)]">
            <CalendarDays className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Floor staff
            </p>
            <h3 className="text-lg font-black text-app-text">Work schedule</h3>
            <p className="text-xs text-app-text-muted">
              Salesperson and sales support weekly hours, sick days, and PTO. Appointments and daily
              tasks follow this calendar.
            </p>
          </div>
        </div>
        <label className="min-w-[12rem] text-[10px] font-black uppercase text-app-text-muted">
          Team member
          <select
            className="ui-input mt-1 w-full text-sm font-bold"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">Select…</option>
            {eligible.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!staffId ? (
        <p className="text-sm text-app-text-muted">No schedule-eligible staff found.</p>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="ui-card space-y-4 p-4">
              <h4 className="text-sm font-black text-app-text">Weekly pattern</h4>
              <p className="text-xs text-app-text-muted">
                0 = Sunday through 6 = Saturday. Uncheck days they are normally off.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {WEEKDAY_LABELS.map((label, wd) => (
                  <label
                    key={label}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-app-border"
                      checked={weeklyWorks[wd]}
                      disabled={!canEdit}
                      onChange={(e) => {
                        const next = [...weeklyWorks];
                        next[wd] = e.target.checked;
                        setWeeklyWorks(next);
                      }}
                    />
                    <span className="font-bold">{label}</span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={!canEdit || savingWeekly}
                onClick={() => void saveWeekly()}
                className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
              >
                {savingWeekly ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save weekly pattern
              </button>
              {!canEdit ? (
                <p className="text-xs text-app-text-muted">
                  You need tasks.manage or staff.manage_access to edit schedules.
                </p>
              ) : null}
            </div>

            <div className="ui-card space-y-4 p-4">
              <h4 className="text-sm font-black text-app-text">Single-day exception</h4>
              <p className="text-xs text-app-text-muted">
                Use <strong className="text-app-text">Extra shift</strong> when someone works on a day
                that is normally off (no appointment blocking).
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-[10px] font-black uppercase text-app-text-muted">
                  Date
                  <input
                    type="date"
                    className="ui-input mt-1 w-full text-sm font-bold"
                    value={excDate}
                    disabled={!canEdit}
                    onChange={(e) => setExcDate(e.target.value)}
                  />
                </label>
                <label className="text-[10px] font-black uppercase text-app-text-muted">
                  Type
                  <select
                    className="ui-input mt-1 w-full text-sm font-bold"
                    value={excKind}
                    disabled={!canEdit}
                    onChange={(e) => setExcKind(e.target.value)}
                  >
                    {EXCEPTION_KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Notes (optional)
                <input
                  type="text"
                  className="ui-input mt-1 w-full text-sm"
                  value={excNotes}
                  disabled={!canEdit}
                  onChange={(e) => setExcNotes(e.target.value)}
                  placeholder="e.g. Doctor note on file"
                />
              </label>
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => void addException()}
                className="ui-btn-secondary px-4 py-2 text-sm disabled:opacity-50"
              >
                Save exception
              </button>
            </div>
          </div>

          <div className="ui-card space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-black text-app-text">Month view</h4>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-1 text-xs"
                  onClick={() =>
                    setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))
                  }
                >
                  Prev
                </button>
                <span className="text-sm font-bold text-app-text">{monthLabel}</span>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-1 text-xs"
                  onClick={() =>
                    setMonthCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))
                  }
                >
                  Next
                </button>
              </div>
            </div>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-app-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : (
              <>
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-black uppercase text-app-text-muted">
                  {WEEKDAY_LABELS.map((d) => (
                    <div key={d}>{d}</div>
                  ))}
                </div>
                <MonthGrid
                  cells={calendarCells}
                  monthCursor={monthCursor}
                  onRemoveException={canEdit ? removeException : undefined}
                />
              </>
            )}
          </div>

          <div className="ui-card space-y-4 border-amber-200/40 bg-amber-50/30 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
            <h4 className="text-sm font-black text-app-text">Mark sick / absence</h4>
            <p className="text-xs text-app-text-muted">
              Records sick, PTO, or missed shift, cancels open <strong className="text-app-text">daily</strong>{" "}
              checklist instances for that date, and optionally clears or reassigns same-day
              appointments that match this person&apos;s name.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Date
                <input
                  type="date"
                  className="ui-input mt-1 w-full text-sm font-bold"
                  value={absDate}
                  disabled={!canEdit}
                  onChange={(e) => setAbsDate(e.target.value)}
                />
              </label>
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Type
                <select
                  className="ui-input mt-1 w-full text-sm font-bold"
                  value={absKind}
                  disabled={!canEdit}
                  onChange={(e) => setAbsKind(e.target.value)}
                >
                  <option value="sick">Sick</option>
                  <option value="pto">PTO</option>
                  <option value="missed_shift">Missed shift</option>
                </select>
              </label>
            </div>
            <label className="block text-[10px] font-black uppercase text-app-text-muted">
              Notes (optional)
              <input
                type="text"
                className="ui-input mt-1 w-full text-sm"
                value={absNotes}
                disabled={!canEdit}
                onChange={(e) => setAbsNotes(e.target.value)}
              />
            </label>
            <fieldset disabled={!canEdit} className="space-y-2 text-sm">
              <legend className="text-[10px] font-black uppercase text-app-text-muted">
                Appointments that day
              </legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="absAppt"
                  checked={absAction === "none"}
                  onChange={() => setAbsAction("none")}
                />
                Leave as-is (rebook manually)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="absAppt"
                  checked={absAction === "unassign"}
                  onChange={() => setAbsAction("unassign")}
                />
                Unassign salesperson (needs reassignment in scheduler)
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="absAppt"
                  checked={absAction === "reassign"}
                  onChange={() => setAbsAction("reassign")}
                />
                Reassign to teammate (must be working that day)
              </label>
            </fieldset>
            {absAction === "reassign" ? (
              <label className="text-[10px] font-black uppercase text-app-text-muted">
                Reassign to
                <select
                  className="ui-input mt-1 w-full text-sm font-bold"
                  value={absReassignTo}
                  onChange={(e) => setAbsReassignTo(e.target.value)}
                >
                  <option value="">Select…</option>
                  {eligible
                    .filter((e) => e.id !== staffId)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.full_name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            <button
              type="button"
              disabled={!canEdit || absBusy}
              onClick={() => void submitMarkAbsence()}
              className="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
            >
              {absBusy ? "Saving…" : "Record absence"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function MonthGrid({
  cells,
  monthCursor,
  onRemoveException,
}: {
  cells: { date: string; dayNum: number; working: boolean; exception?: ExceptionRow }[];
  monthCursor: Date;
  onRemoveException?: (d: string) => void;
}) {
  if (cells.length === 0) return null;
  const first = new Date(cells[0].date + "T12:00:00");
  if (
    first.getMonth() !== monthCursor.getMonth() ||
    first.getFullYear() !== monthCursor.getFullYear()
  ) {
    return null;
  }
  const lead = first.getDay();
  const blanks = Array.from({ length: lead }, (_, i) => (
    <div key={`b-${i}`} className="min-h-[3.25rem]" />
  ));
  return (
    <div className="grid grid-cols-7 gap-1">
      {blanks}
      {cells.map((c) => (
        <div
          key={c.date}
          className={`flex min-h-[3.25rem] flex-col rounded-lg border p-1 text-left text-xs ${
            c.working
              ? "border-app-border bg-app-surface-2/40"
              : "border-app-border bg-app-surface-2/80 opacity-90"
          } ${c.exception ? "ring-1 ring-amber-400/60" : ""}`}
        >
          <span className="font-black text-app-text">{c.dayNum}</span>
          <span
            className={`text-[9px] font-bold uppercase text-app-text-muted ${
              c.working ? "" : "line-through"
            }`}
          >
            {c.working ? "Work" : "Off"}
          </span>
          {c.exception ? (
            <span className="mt-0.5 line-clamp-2 text-[9px] font-semibold text-amber-800 dark:text-amber-200">
              {kindLabel(c.exception.kind)}
            </span>
          ) : null}
          {c.exception && onRemoveException ? (
            <button
              type="button"
              title="Remove exception"
              className="mt-auto self-end rounded p-0.5 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
              onClick={() => onRemoveException(c.exception!.exception_date)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
