export function parseMoney(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Integer cents — avoids float drift when summing many POS lines. */
export function parseMoneyToCents(v: string | number | undefined | null): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") {
    return Math.round(v * 100);
  }
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function centsToFixed2(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(v: number): string {
  return v.toFixed(2);
}

/** Locale USD string from integer cents (display only). */
export function formatUsdFromCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

/** Sum money-like fields in integer cents (no float accumulation). */
export function sumMoneyToCents(
  values: ReadonlyArray<string | number | null | undefined>,
): number {
  let t = 0;
  for (const v of values) t += parseMoneyToCents(v);
  return t;
}

/** 
 * Swedish (Swedish) Rounding logic ($0.05 step).
 * Formula: Math.round(cent_val / 5) * 5
 */
export function calculateSwedishRounding(cents: number): number {
  if (cents === 0) return 0;
  return Math.round(cents / 5) * 5;
}
