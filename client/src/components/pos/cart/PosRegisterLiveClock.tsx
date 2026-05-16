import { useEffect, useState } from "react";

/** live register clock — same TZ as Settings receipt config (thermal line uses server time when the sale completes). */
function formatStoreClockLine(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .format(d)
      .replace(",", " ·");
  } catch {
    return d.toLocaleString("en-US");
  }
}

function storeDateTimeInputValue(d: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, part) => {
        if (part.type !== "literal") acc[part.type] = part.value;
        return acc;
      }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
  }
}

function formatLocalDateTimeLine(value: string): string {
  const [date, time] = value.split("T");
  if (!date || !time) return value;
  const [year, month, day] = date.split("-");
  const [hourRaw, minute = "00"] = time.split(":");
  const hour24 = Number.parseInt(hourRaw ?? "", 10);
  if (!year || !month || !day || !Number.isFinite(hour24)) return value;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${month}/${day}/${year} · ${hour12}:${minute.padStart(2, "0")} ${suffix}`;
}

interface PosRegisterLiveClockProps {
  timeZone: string;
  overrideLocalDateTime?: string | null;
  onOverrideChange?: (value: string | null) => void;
}

export function PosRegisterLiveClock({
  timeZone,
  overrideLocalDateTime = null,
  onOverrideChange,
}: PosRegisterLiveClockProps) {
  const [now, setNow] = useState(() => new Date());
  
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const inputValue = overrideLocalDateTime ?? storeDateTimeInputValue(now, timeZone);

  return (
    <div className="ml-auto flex min-w-0 max-w-[55%] shrink items-center justify-end gap-2 text-right sm:max-w-none">
      <label
        className="relative min-w-0 cursor-pointer rounded-xl px-2 py-1 transition-colors hover:bg-app-surface"
        title="Click to set the date and time for this transaction only."
      >
        <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
          {overrideLocalDateTime ? "Backdated sale" : "Store date and time"}
        </p>
        <p className="truncate font-mono text-xs font-black tabular-nums text-app-text">
          {overrideLocalDateTime
            ? formatLocalDateTimeLine(overrideLocalDateTime)
            : formatStoreClockLine(now, timeZone)}
        </p>
        <input
          aria-label="Set transaction date and time"
          type="datetime-local"
          value={inputValue}
          max={storeDateTimeInputValue(now, timeZone)}
          onChange={(event) => onOverrideChange?.(event.target.value || null)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      {overrideLocalDateTime ? (
        <button
          type="button"
          onClick={() => onOverrideChange?.(null)}
          className="rounded-lg border border-app-border px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
        >
          Now
        </button>
      ) : null}
    </div>
  );
}
