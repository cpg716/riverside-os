import { useState, useEffect, useCallback, useMemo } from "react";
import { Calendar, Clock, CheckCircle2, AlertTriangle, ChevronRight, Info } from "lucide-react";
import { getBaseUrl } from "../../../lib/apiConfig";

const baseUrl = getBaseUrl();
const MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short" });
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-US", { weekday: "long" });

function toDateKey(value: string): string {
  return value.split("T")[0] ?? value;
}

function slotDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateKey(): string {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return formatDateKey(today);
}

function latestFinishDateKey(dueDate: string): string {
  const finish = slotDate(toDateKey(dueDate));
  finish.setDate(finish.getDate() - 1);
  return formatDateKey(finish);
}

function formatCapacityDate(value: string): string {
  const date = slotDate(value);
  const weekday = WEEKDAY_FORMATTER.format(date);
  const month = MONTH_FORMATTER.format(date);
  return `${weekday}, ${month} ${date.getDate()}`;
}

function unitLabel(count: number, noun: "jacket" | "pant"): string {
  return `${count} ${noun} unit${count === 1 ? "" : "s"}`;
}

type SuggestedSlot = {
  date: string;
  score: number;
};

type CapacityDay = {
  date: string;
  jacket_units_used: number;
  pant_units_used: number;
  jacket_units_available: number;
  pant_units_available: number;
  is_manual_only: boolean;
  is_closed: boolean;
  closed_label: string | null;
  has_staff: boolean;
};

type CapacityOutlook = {
  requested: string;
  nextSafeDay: string | null;
  overloadedDays: number;
  closedDays: number;
  noStaffDays: number;
  hasManualOnlyDay: boolean;
  selectedUtilization: string | null;
};

type AlterationSmartSchedulerProps = {
  alterationId: string;
  jacketUnits: number;
  pantUnits: number;
  dueDate: string | null;
  currentFittingAt: string | null;
  apiAuth: () => Record<string, string>;
  onSlotSelected: (date: string) => void;
};

export default function AlterationSmartScheduler({
  jacketUnits,
  pantUnits,
  dueDate,
  currentFittingAt,
  apiAuth,
  onSlotSelected,
}: AlterationSmartSchedulerProps) {
  const [slots, setSlots] = useState<SuggestedSlot[]>([]);
  const [capacity, setCapacity] = useState<CapacityDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [capacityLoading, setCapacityLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        jacket_units: jacketUnits.toString(),
        pant_units: pantUnits.toString(),
        due_date: dueDate!.split('T')[0],
      });

      const res = await fetch(`${baseUrl}/api/alterations/suggest-slots?${q}`, {
        headers: apiAuth(),
      });

      if (res.ok) {
        const data = await res.json();
        setSlots(data);
      } else {
        setError("No valid work days found for this capacity and due date.");
      }
    } catch {
      setError("Failed to calculate capacity days.");
    } finally {
      setLoading(false);
    }
  }, [dueDate, jacketUnits, pantUnits, apiAuth]);

  const fetchCapacity = useCallback(async () => {
    if (!dueDate) return;
    const start = todayDateKey();
    const end = latestFinishDateKey(dueDate);
    if (end < start) {
      setCapacity([]);
      return;
    }

    setCapacityLoading(true);
    setCapacityError(null);
    try {
      const q = new URLSearchParams({ start, end });
      const res = await fetch(`${baseUrl}/api/alterations/capacity?${q}`, {
        headers: apiAuth(),
      });

      if (res.ok) {
        const data = (await res.json()) as CapacityDay[];
        setCapacity([...data].sort((a, b) => a.date.localeCompare(b.date)));
      } else {
        setCapacity([]);
        setCapacityError("Capacity outlook is unavailable right now.");
      }
    } catch {
      setCapacity([]);
      setCapacityError("Capacity outlook is unavailable right now.");
    } finally {
      setCapacityLoading(false);
    }
  }, [apiAuth, dueDate]);

  useEffect(() => {
    if (dueDate && (jacketUnits > 0 || pantUnits > 0)) {
      fetchSlots();
    }
  }, [fetchSlots, dueDate, jacketUnits, pantUnits]);

  useEffect(() => {
    if (dueDate) {
      fetchCapacity();
    }
  }, [dueDate, fetchCapacity]);

  const capacityOutlook = useMemo<CapacityOutlook | null>(() => {
    if (!dueDate || capacity.length === 0) return null;
    const nextSafe = capacity.find(
      (day) =>
        day.has_staff &&
        !day.is_closed &&
        !day.is_manual_only &&
        day.jacket_units_available >= jacketUnits &&
        day.pant_units_available >= pantUnits,
    );
    const overloadedDays = capacity.filter(
      (day) =>
        day.has_staff &&
        !day.is_closed &&
        !day.is_manual_only &&
        (day.jacket_units_available < jacketUnits ||
          day.pant_units_available < pantUnits),
    ).length;
    const closedDays = capacity.filter((day) => day.is_closed).length;
    const noStaffDays = capacity.filter((day) => !day.has_staff).length;
    const selectedDay = currentFittingAt
      ? capacity.find((day) => day.date === toDateKey(currentFittingAt))
      : null;
    const selectedUtilization = selectedDay
      ? `Selected day: ${selectedDay.jacket_units_used}/${
          selectedDay.jacket_units_used + selectedDay.jacket_units_available
        } jacket units, ${selectedDay.pant_units_used}/${
          selectedDay.pant_units_used + selectedDay.pant_units_available
        } pant units booked.`
      : null;

    return {
      requested: `Requested work: ${unitLabel(jacketUnits, "jacket")}, ${unitLabel(
        pantUnits,
        "pant",
      )}.`,
      nextSafeDay: nextSafe ? `Next safe day: ${formatCapacityDate(nextSafe.date)}.` : null,
      overloadedDays,
      closedDays,
      noStaffDays,
      hasManualOnlyDay: capacity.some((day) => day.is_manual_only),
      selectedUtilization,
    };
  }, [capacity, currentFittingAt, dueDate, jacketUnits, pantUnits]);

  const selectSlot = (date: string) => {
    onSlotSelected(date);
  };

  if (!dueDate) {
    return (
      <div className="p-6 text-center border border-dashed border-white/10 rounded-xl bg-app-surface/5">
        <Calendar className="w-8 h-8 text-white/20 mx-auto mb-2" />
        <p className="text-sm text-white/40">Set a Due Date first to find work days</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-14 bg-app-surface/5 rounded-xl border border-white/10" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-500/10 bg-blue-500/5 p-4">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-400" />
          <h3 className="text-sm font-semibold text-white/90">Capacity Outlook</h3>
        </div>
        {capacityLoading ? (
          <p className="mt-3 text-[11px] font-medium text-white/40">
            Loading capacity outlook…
          </p>
        ) : capacityError ? (
          <p className="mt-3 text-[11px] font-medium text-yellow-100/70">
            {capacityError}
          </p>
        ) : capacityOutlook ? (
          <>
            <ul className="mt-3 space-y-2 text-[11px] font-medium text-blue-100/70">
              <li>{capacityOutlook.requested}</li>
              {capacityOutlook.nextSafeDay ? <li>{capacityOutlook.nextSafeDay}</li> : null}
              {capacityOutlook.overloadedDays > 0 ? (
                <li>
                  {capacityOutlook.overloadedDays} day
                  {capacityOutlook.overloadedDays === 1 ? " is" : "s are"} over capacity in this
                  window.
                </li>
              ) : null}
              {capacityOutlook.closedDays > 0 ? (
                <li>
                  {capacityOutlook.closedDays} day
                  {capacityOutlook.closedDays === 1 ? " is" : "s are"} marked closed.
                </li>
              ) : null}
              {capacityOutlook.noStaffDays > 0 ? (
                <li>
                  {capacityOutlook.noStaffDays} day
                  {capacityOutlook.noStaffDays === 1 ? " has" : "s have"} no alterations staff
                  scheduled.
                </li>
              ) : null}
              {capacityOutlook.hasManualOnlyDay ? <li>Thursdays require manual review.</li> : null}
              {capacityOutlook.selectedUtilization ? (
                <li>{capacityOutlook.selectedUtilization}</li>
              ) : null}
            </ul>
          </>
        ) : (
          <p className="mt-3 text-[11px] font-medium text-white/40">
            No capacity days are available before the due date.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/90 flex items-center gap-2">
          <Clock className="w-4 h-4 text-purple-400" />
          Smart Work Day Suggestions
        </h3>
        {slots.length > 0 && (
          <span className="text-[10px] text-white/40 uppercase font-bold">
            Based on {jacketUnits + pantUnits} units
          </span>
        )}
      </div>

      {error ? (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5" />
          <p className="text-xs text-red-200/70">{error}</p>
        </div>
      ) : slots.length === 0 ? (
        <div className="p-6 text-center border border-dashed border-white/10 rounded-xl bg-app-surface/5">
          <AlertTriangle className="w-6 h-6 text-yellow-500/50 mx-auto mb-2" />
          <p className="text-sm text-white/40 font-medium">Over Capacity</p>
          <p className="text-[11px] text-white/30 max-w-[200px] mx-auto mt-1">
            No days have enough open units before the due date. Manual review required.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {slots.map((slot, idx) => {
            const isSelected = currentFittingAt && toDateKey(currentFittingAt) === slot.date;
            const dateObj = slotDate(slot.date); // Midday to avoid TZ shifts

            return (
              <button
                key={slot.date}
                onClick={() => selectSlot(slot.date)}
                className={`w-full group flex items-center justify-between p-3 rounded-xl border transition-all ${
                  isSelected
                    ? "bg-purple-600/20 border-purple-500 shadow-lg shadow-purple-500/10"
                    : "bg-app-surface/5 border-white/10 hover:border-white/30 hover:bg-app-surface/10"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center ${
                    isSelected ? "bg-purple-500 text-white" : "bg-app-surface/5 text-white/60 group-hover:text-white"
                  }`}>
                    <span className="text-[10px] uppercase font-bold leading-none">{MONTH_FORMATTER.format(dateObj)}</span>
                    <span className="text-lg font-bold leading-none mt-0.5">{dateObj.getDate()}</span>
                  </div>
                  <div className="text-left">
                    <p className={`text-sm font-semibold ${isSelected ? "text-white" : "text-white/80"}`}>
                      {WEEKDAY_FORMATTER.format(dateObj)}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {idx === 0 && !isSelected && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[9px] uppercase font-black">
                          Best Fit
                        </span>
                      )}
                      <span className="text-[10px] text-white/40 font-medium">
                        Suggested Work Day
                      </span>
                    </div>
                  </div>
                </div>

                {isSelected ? (
                  <CheckCircle2 className="w-5 h-5 text-purple-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
        <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
        <p className="text-[10px] text-blue-200/50 leading-relaxed">
          The Smart Scheduler skips closed days and Thursdays to preserve capacity for last-minute repairs and keeps planned work at least 1 day before the due date.
        </p>
      </div>
    </div>
  );
}
