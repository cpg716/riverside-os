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

interface PosRegisterLiveClockProps {
  timeZone: string;
}

export function PosRegisterLiveClock({ timeZone }: PosRegisterLiveClockProps) {
  const [now, setNow] = useState(() => new Date());
  
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div
      className="ml-auto min-w-0 max-w-[55%] shrink text-right sm:max-w-none"
      title="Store time zone matches receipt settings. The printed receipt uses the server time when you complete the sale."
    >
      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
        Store date and time
      </p>
      <p className="truncate font-mono text-xs font-black tabular-nums text-app-text">
        {formatStoreClockLine(now, timeZone)}
      </p>
    </div>
  );
}
