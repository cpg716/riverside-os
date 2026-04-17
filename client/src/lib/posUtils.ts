import { type GiftCardType, type ResolvedSkuItem } from "../components/pos/types";

export function newCartRowId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}

export function newCheckoutClientId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure contexts or older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function normalizeGiftCardSubType(
  t: string | undefined | null,
): GiftCardType | undefined {
  if (!t) return undefined;
  const s = String(t).toLowerCase();
  if (s.includes("paid")) return "paid_liability";
  if (s.includes("loyalty")) return "loyalty_giveaway";
  if (s.includes("donated")) return "donated_giveaway";
  return undefined;
}

export function scanPayloadToResolvedItem(r: Record<string, unknown>): ResolvedSkuItem {
  return {
    product_id: String(r.product_id),
    variant_id: String(r.variant_id),
    sku: String(r.sku),
    name: String(r.name),
    variation_label: (r.variation_label as string | null | undefined) ?? undefined,
    standard_retail_price: (r.standard_retail_price as string | number) ?? 0,
    employee_price: r.employee_price as string | number | undefined,
    unit_cost: (r.unit_cost as string | number) ?? 0,
    spiff_amount: r.spiff_amount as string | number | undefined,
    stock_on_hand: typeof r.stock_on_hand === "number" ? r.stock_on_hand : undefined,
    state_tax: (r.state_tax as string | number) ?? 0,
    local_tax: (r.local_tax as string | number) ?? 0,
    tax_category: (r.tax_category as "clothing" | "footwear" | "other") ?? undefined,
  };
}
