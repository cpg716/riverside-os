/** Touch-friendly 0–9 entry for a single 4-digit staff credential (same value used everywhere). */

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"] as const;

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
    <div
      className={`flex justify-center gap-3 ${className}`}
      aria-hidden
    >
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
  maxDigits = 4,
  disabled = false,
  className = "",
  compact = false,
}: {
  value: string;
  onChange: (next: string) => void;
  maxDigits?: number;
  disabled?: boolean;
  className?: string;
  /** Denser keys for POS payment drawer (1080p zero-scroll). */
  compact?: boolean;
}) {
  const press = (k: string) => {
    if (disabled) return;
    if (k === "del") {
      onChange(value.slice(0, -1));
      return;
    }
    if (!k || !/^\d$/.test(k)) return;
    if (value.length >= maxDigits) return;
    onChange(value + k);
  };

  const gap = compact ? "gap-1" : "gap-2 sm:gap-3";
  const cell = compact
    ? "min-h-11 rounded-lg text-lg"
    : "min-h-[52px] rounded-2xl text-xl";

  return (
    <div className={className}>
      <div className={`grid grid-cols-3 ${gap}`}>
        {KEYS.map((k) =>
          k === "" ? (
            <div key="spacer" className={compact ? "min-h-11" : "min-h-[52px]"} />
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
