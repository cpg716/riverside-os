import { useEffect, useCallback } from "react";

/** Touch-friendly 0–9 entry for a single 4-digit staff credential (same value used everywhere). */

const KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  ".",
  "0",
  "del",
] as const;

export function PinDots({
  length,
  maxDigits = 4,
  className = "",
}: {
  length: number;
  maxDigits?: number;
  className?: string;
}) {
  return (
    <div className={`flex justify-center gap-3 ${className}`} aria-hidden>
      {Array.from({ length: maxDigits }, (_, i) => (
        <div
          key={i}
          className={`h-3 w-3 rounded-full border-2 border-app-border ${
            i < length ? "bg-app-accent border-app-accent" : "bg-transparent"
          }`}
        />
      ))}
    </div>
  );
}

export default function NumericPinKeypad({
  value,
  onChange,
  onEnter,
  maxDigits = 4,
  disabled = false,
  className = "",
  compact = false,
  showDecimal = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  maxDigits?: number;
  disabled?: boolean;
  className?: string;
  /** Denser keys for POS payment drawer (1080p zero-scroll). */
  compact?: boolean;
  showDecimal?: boolean;
}) {
  const press = useCallback(
    (k: string) => {
      if (disabled) return;
      if (k === "del" || k === "Backspace") {
        onChange(value.slice(0, -1));
        return;
      }
      if (k === ".") {
        if (!showDecimal) return;
        if (value.includes(".")) return;
        onChange(value + k);
        return;
      }
      if (!k || !/^\d$/.test(k)) return;
      if (value.length >= maxDigits) return;
      onChange(value + k);
    },
    [disabled, value, maxDigits, onChange, showDecimal],
  );

  useEffect(() => {
    if (disabled) return;
    const handleDown = (e: KeyboardEvent) => {
      if ((e.key >= "0" && e.key <= "9") || (e.key === "." && showDecimal)) {
        press(e.key);
      } else if (e.key === "Backspace") {
        press("del");
      } else if (e.key === "Enter" && value.length === maxDigits && onEnter) {
        onEnter();
      }
    };
    window.addEventListener("keydown", handleDown);
    return () => window.removeEventListener("keydown", handleDown);
  }, [disabled, value, maxDigits, onEnter, press, showDecimal]);

  const gap = compact ? "gap-1" : "gap-2 sm:gap-3";
  const cell = compact
    ? "min-h-11 rounded-lg text-lg"
    : "min-h-16 rounded-2xl text-2xl";

  return (
    <div className={className} data-pin-entry="true">
      <div className={`grid grid-cols-3 ${gap}`}>
        {KEYS.map((k) =>
          k === "." && !showDecimal ? (
            <div
              key="spacer"
              className={compact ? "min-h-11" : "min-h-[52px]"}
            />
          ) : (
            <button
              key={k}
              type="button"
              data-testid={k === "del" ? "pin-key-del" : `pin-key-${k}`}
              disabled={disabled}
              onClick={() => press(k)}
              className={`ui-touch-target flex ${cell} items-center justify-center font-black tabular-nums shadow-sm ring-1 ring-app-border transition-all active:scale-95 disabled:opacity-40 ${
                k === "del"
                  ? "bg-app-surface-2 text-[10px] uppercase tracking-widest text-red-500"
                  : "bg-app-surface text-app-text hover:ring-app-input-border"
              }`}
            >
              {k === "del" ? "Del" : k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
