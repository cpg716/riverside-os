import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, CalendarRange, LayoutGrid, Loader2, Save, Trash2, User } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import StaffWeeklyGridView from "./StaffWeeklyGridView";

const baseUrl = getBaseUrl();

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
type WeeklyViewDay = { date: string; working: boolean; shift_label: string | null };
type WeeklyViewStaff = {
  staff_id: string;
  full_name: string;
  role: string;
  days: WeeklyViewDay[];
};
type WeeklyViewResponse = {
  from: string;
  to: string;
  rows: WeeklyViewStaff[];
};

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

function sundayStart(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date: Date, count: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function formatWeekLabel(from: Date, to: Date): string {
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = from.getMonth() === to.getMonth();
  if (sameYear && sameMonth) {
    return `${from.toLocaleString(undefined, { month: "short", day: "numeric" })} – ${to.getDate()}, ${from.getFullYear()}`;
  }
  if (sameYear) {
    return `${from.toLocaleString(undefined, { month: "short", day: "numeric" })} – ${to.toLocaleString(
      undefined,
      { month: "short", day: "numeric" },
    )}, ${from.getFullYear()}`;
  }
  return `${from.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${to.toLocaleString(
    undefined,
    { month: "short", day: "numeric", year: "numeric" },
  )}`;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const EXCEPTION_KINDS = [
  { value: "pto", label: "PTO" },
  { value: "vacation", label: "Vacation" },
  { value: "doctors_appt", label: "Doctors Appt" },
  { value: "other", label: "Other" },
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
  const [weeklyShiftLabels, setWeeklyShiftLabels] = useState<string[]>(() => Array(7).fill(""));

  const [monthCursor, setMonthCursor] = useState(() => new Date());
  const [effective, setEffective] = useState<EffectiveDay[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingWeekly, setSavingWeekly] = useState(false);

  const [excDate, setExcDate] = useState(() => toYmdLocal(new Date()));
  const [excKind, setExcKind] = useState<string>("sick");
  const [excShiftLabel, setExcShiftLabel] = useState("");
  const [excNotes, setExcNotes] = useState("");

  const [absDate, setAbsDate] = useState(() => toYmdLocal(new Date()));
	const [absKind, setAbsKind] = useState<string>("sick");
	const [absShiftLabel, setAbsShiftLabel] = useState("");
	const [absNotes, setAbsNotes] = useState("");
	const [absAction, setAbsAction] = useState<"none" | "unassign" | "reassign">("unassign");
	const [absReassignTo, setAbsReassignTo] = useState("");
	const [absBusy, setAbsBusy] = useState(false);

	const [viewMode, setViewMode] = useState<"weekly" | "staff" | "scheduler">("weekly");
	const [weekCursor, setWeekCursor] = useState(() => new Date());
	const [weeklyViewRows, setWeeklyViewRows] = useState<WeeklyViewStaff[]>([]);
	const [loadingWeeklyView, setLoadingWeeklyView] = useState(false);

	const headers = useMemo(() => {
	  const h = new Headers(backofficeHeaders());
	  return h;
	}, [backofficeHeaders]);

	const weekBounds = useMemo(() => {
	  const start = sundayStart(weekCursor);
	  const end = addDays(start, 6);
	  return { start, end, from: toYmdLocal(start), to: toYmdLocal(end) };
	}, [weekCursor]);

	const weekHeaders = useMemo(() => {
	  const start = sundayStart(weekCursor);
	  return Array.from({ length: 7 }, (_, offset) => {
	    const date = addDays(start, offset);
	    return {
	      date: toYmdLocal(date),
	      dayNum: date.getDate(),
	      label: WEEKDAY_LABELS[offset],
	    };
	  });
	}, [weekCursor]);

  const activeStaff = useMemo(
    () => eligible.find((e) => e.id === staffId),
    [eligible, staffId]
  );

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
        const wrows = (await wRes.json()) as (WeeklyRow & { shift_label: string | null })[];
        const nextWorks = Array(7).fill(true) as boolean[];
        const nextLabels = Array(7).fill("") as string[];
        for (const r of wrows) {
          if (r.weekday >= 0 && r.weekday <= 6) {
            nextWorks[r.weekday] = r.works;
            nextLabels[r.weekday] = r.shift_label || "";
          }
        }
        setWeeklyWorks(nextWorks);
        setWeeklyShiftLabels(nextLabels);
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

	const loadWeeklyView = useCallback(async () => {
	  setLoadingWeeklyView(true);
	  try {
	    const res = await fetch(
	      `${baseUrl}/api/staff/schedule/weekly-view?from=${encodeURIComponent(
	        weekBounds.from,
	      )}&to=${encodeURIComponent(weekBounds.to)}`,
	      {
	        headers,
	      },
	    );
	    if (!res.ok) {
	      const b = (await res.json().catch(() => ({}))) as { error?: string };
	      toast(b.error ?? "Could not load weekly schedule view.", "error");
	      setWeeklyViewRows([]);
	      return;
	    }
	    const body = (await res.json()) as WeeklyViewResponse;
	    setWeeklyViewRows(body.rows ?? []);
	  } finally {
	    setLoadingWeeklyView(false);
	  }
	}, [headers, weekBounds, toast]);

  useEffect(() => {
    void loadEligible();
  }, [loadEligible]);

	useEffect(() => {
	  void loadStaffData();
	}, [loadStaffData]);

	useEffect(() => {
	  if (viewMode === "weekly") {
	    void loadWeeklyView();
	  }
	}, [loadWeeklyView, viewMode]);

  const saveWeekly = async () => {
    if (!canEdit || !staffId) return;
    setSavingWeekly(true);
    try {
      const weekdays = weeklyWorks.map((works, weekday) => ({ 
        weekday, 
        works, 
        shift_label: weeklyShiftLabels[weekday].trim() || null 
      }));
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
        shift_label: excShiftLabel.trim() || null,
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
          shift_label: absShiftLabel.trim() || null,
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
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border pb-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Staff schedules</p>
          <h1 className="text-xl font-black text-app-text">Schedule workspace</h1>
          <p className="text-xs text-app-text-muted">
            WEEKLY is for viewing published schedules; STAFF is for personnel profiles; SCHEDULER is
            for making and editing schedules.
          </p>
        </div>
        <div className="flex gap-2 p-1 rounded-2xl bg-app-surface-2 border border-app-border">
          <button
            type="button"
            onClick={() => setViewMode("weekly")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
              viewMode === "weekly"
                ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            <CalendarRange size={14} />
            Weekly
          </button>
          <button
            type="button"
            onClick={() => setViewMode("staff")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
              viewMode === "staff"
                ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            <User size={14} />
            Staff
          </button>
          <button
            type="button"
            onClick={() => setViewMode("scheduler")}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
              viewMode === "scheduler"
                ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            <LayoutGrid size={14} />
            Scheduler
          </button>
        </div>
      </div>

      {viewMode === "weekly" ? (
        <>
          <div className="ui-card space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2))] text-[var(--app-accent)]">
                  <CalendarDays className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">All staff</p>
                  <h3 className="text-lg font-black text-app-text">Weekly schedule</h3>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-1 text-xs"
                  onClick={() =>
                    setWeekCursor((current) => {
                      const next = new Date(current);
                      next.setDate(next.getDate() - 7);
                      return next;
                    })
                  }
                >
                  Prev week
                </button>
                <span className="text-sm font-bold text-app-text">{formatWeekLabel(weekBounds.start, weekBounds.end)}</span>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-1 text-xs"
                  onClick={() =>
                    setWeekCursor((current) => {
                      const next = new Date(current);
                      next.setDate(next.getDate() + 7);
                      return next;
                    })
                  }
                >
                  Next week
                </button>
              </div>
            </div>
            {loadingWeeklyView ? (
              <div className="flex items-center gap-2 text-sm text-app-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading weekly schedule…
              </div>
            ) : weeklyViewRows.length === 0 ? (
              <p className="text-sm text-app-text-muted">No active floor staff found for weekly schedule.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left text-sm">
                  <thead>
                    <tr className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      <th className="w-48 px-3 py-2">Staff Member</th>
                      {weekHeaders.map((day) => (
                        <th key={day.date} className="px-3 py-2 text-center">
                          <div>{day.label}</div>
                          <div>{day.dayNum}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {weeklyViewRows.map((staff) => {
                      const dayByDate = new Map(staff.days.map((d) => [d.date, d]));
                      return (
                        <tr key={staff.staff_id} className="hover:bg-app-surface-2/40">
                          <td className="px-3 py-2 align-middle font-black text-app-text">
                            <p className="truncate" title={staff.full_name}>
                              {staff.full_name}
                            </p>
                            <p className="text-[10px] uppercase text-app-text-muted">{staff.role}</p>
                          </td>
                          {weekHeaders.map((day) => {
                            const dayEntry = dayByDate.get(day.date);
                            const shift = dayEntry?.shift_label ?? null;
                            const isWorking = dayEntry?.working ?? true;
                            return (
                              <td key={day.date} className="px-2 py-2 align-middle text-center text-xs">
                                <div
                                  className={`rounded-lg border px-2 py-2 text-xs font-black ${
                                    isWorking
                                      ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200"
                                      : "border-app-border bg-app-surface-2 text-app-text-muted"
                                  }`}
                                >
                                  {isWorking ? shift ?? "Work" : "OFF"}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}

      {viewMode === "staff" ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-6 border-b border-app-border pb-6">
            <div className="flex items-center gap-5">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20 shadow-lg shadow-app-accent/5">
                {activeStaff ? (
                  <span className="text-xl font-black uppercase tracking-tighter">
                    {activeStaff.full_name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                  </span>
                ) : (
                  <CalendarDays className="h-8 w-8 opacity-80" aria-hidden />
                )}
              </div>
              <div className="space-y-1">
                {activeStaff ? (
                  <>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                      Managing Schedule
                    </p>
                    <h3 className="text-2xl font-black text-app-text tracking-tight">
                      {activeStaff.full_name}
                    </h3>
                    <p className="text-sm font-medium text-app-text-muted">
                      {activeStaff.role}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                      Individual
                    </p>
                    <h3 className="text-2xl font-black text-app-text tracking-tight">
                      Team Attendance
                    </h3>
                    <p className="text-sm font-medium text-app-text-muted">
                      Select a staff member to view and edit their availability.
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-1.5 min-w-[200px]">
              <label className="text-[10px] font-black uppercase tracking-wider text-app-text-muted px-1">
                Select Team Member
              </label>
              <select
                className="ui-input w-full text-base font-black bg-app-surface-2/50 border-app-accent/20 focus:border-app-accent focus:ring-4 focus:ring-app-accent/10 transition-all cursor-pointer"
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
            </div>
          </div>

          {!staffId ? (
            <p className="text-sm text-app-text-muted">No schedule-eligible staff found.</p>
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <div className="ui-card space-y-4 p-4">
                <h4 className="text-sm font-black text-app-text">Weekly Availability</h4>
                <p className="text-xs text-app-text-muted">
                  Set the recurring work pattern for this staff member.
                </p>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {WEEKDAY_LABELS.map((label, wd) => (
                      <div key={label} className="flex flex-col gap-1">
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-sm bg-app-surface-2/30">
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
                        <input
                          type="text"
                          placeholder="Shift"
                          className="ui-input h-8 px-2 text-[10px] font-bold"
                          value={weeklyShiftLabels[wd]}
                          disabled={!canEdit || !weeklyWorks[wd]}
                          onChange={(e) => {
                            const next = [...weeklyShiftLabels];
                            next[wd] = e.target.value;
                            setWeeklyShiftLabels(next);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!canEdit || savingWeekly}
                  onClick={() => void saveWeekly()}
                  className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
                >
                  {savingWeekly ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save availability
                </button>
              </div>

              <div className="ui-card space-y-4 p-4">
                <h4 className="text-sm font-black text-app-text">Time off requests</h4>
                <p className="text-xs text-app-text-muted">
                  Record planned time away. These will be highlighted in the <strong>Scheduler</strong> to prevent double-booking.
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-[10px] font-black uppercase text-app-text-muted">
                    Shift Label (optional)
                    <input
                      type="text"
                      className="ui-input mt-1 w-full text-sm font-bold"
                      value={excShiftLabel}
                      disabled={!canEdit}
                      onChange={(e) => setExcShiftLabel(e.target.value)}
                      placeholder="e.g. 9:30-6"
                    />
                  </label>
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
                </div>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => void addException()}
                  className="ui-btn-primary px-4 py-2 text-sm disabled:opacity-50"
                >
                  Save request
                </button>
              </div>

              <div className="ui-card space-y-4 p-4">
                <h4 className="text-sm font-black text-app-text">Time & Attendance</h4>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-app-text-muted">History of requests and absences.</p>
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-[10px] font-black uppercase text-app-text-muted">
                    Shift Label (optional)
                    <input
                      type="text"
                      className="ui-input mt-1 w-full text-sm font-bold"
                      value={absShiftLabel}
                      disabled={!canEdit}
                      onChange={(e) => setAbsShiftLabel(e.target.value)}
                    />
                  </label>
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
                </div>
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
            </div>
          )}
        </>
      ) : null}

      {viewMode === "scheduler" ? <StaffWeeklyGridView /> : null}
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
