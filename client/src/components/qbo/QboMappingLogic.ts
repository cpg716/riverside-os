export interface AccountMapping {
  ros_id: string;
  qbo_account_id: string;
  qbo_account_name: string;
}

export interface QboMatrixAccount {
  id: string;
  name: string;
}

export const QBO_MATRIX_TENDERS = [
  { id: "card_terminal", label: "Card terminal" },
  { id: "cash", label: "Cash" },
  { id: "check", label: "Check" },
  { id: "on_account", label: "On account (AR)" },
  { id: "gift_card", label: "Gift card (redemption)" },
] as const;

export const QBO_MATRIX_CUSTOM_TYPES = [
  { id: "hsm_suit", label: "HSM Suit" },
  { id: "hsm_sport_coat", label: "HSM Sport Coat" },
  { id: "hsm_slacks", label: "HSM Slacks" },
  { id: "individualized_shirt", label: "Individualized Shirt" },
] as const;

/** Matrix UI key → `qbo_mappings` row (server). */
export function matrixKeyToGranular(
  key: string,
): { source_type: string; source_id: string } | null {
  if (key === "gc_liability") {
    return { source_type: "liability_gift_card", source_id: "default" };
  }
  if (key === "gc_marketing") {
    return { source_type: "expense_loyalty", source_id: "default" };
  }
  if (key === "invoice_holding") {
    return { source_type: "clearing_invoice_holding", source_id: "default" };
  }
  if (key === "deposit_holding") {
    return { source_type: "liability_deposit", source_id: "default" };
  }
  if (key === "stripe_fee") {
    return { source_type: "expense_merchant_fee", source_id: "default" };
  }
  if (key === "tax_sales") {
    return { source_type: "tax", source_id: "SALES_TAX" };
  }
  let m = /^rev_(.+)$/.exec(key);
  if (m) return { source_type: "category_revenue", source_id: m[1] };
  m = /^inv_(.+)$/.exec(key);
  if (m) return { source_type: "category_inventory", source_id: m[1] };
  m = /^cogs_(.+)$/.exec(key);
  if (m) return { source_type: "category_cogs", source_id: m[1] };
  m = /^custom_rev_(.+)$/.exec(key);
  if (m) return { source_type: "custom_revenue", source_id: m[1] };
  m = /^custom_inv_(.+)$/.exec(key);
  if (m) return { source_type: "custom_inventory", source_id: m[1] };
  m = /^custom_cogs_(.+)$/.exec(key);
  if (m) return { source_type: "custom_cogs", source_id: m[1] };
  m = /^tender_(.+)$/.exec(key);
  if (m) return { source_type: "tender", source_id: m[1] };
  return null;
}

export function granularToMatrixKey(
  source_type: string,
  source_id: string,
): string | null {
  switch (source_type) {
    case "category_revenue":
      return `rev_${source_id}`;
    case "category_inventory":
      return `inv_${source_id}`;
    case "category_cogs":
      return `cogs_${source_id}`;
    case "custom_revenue":
      return `custom_rev_${source_id}`;
    case "custom_inventory":
      return `custom_inv_${source_id}`;
    case "custom_cogs":
      return `custom_cogs_${source_id}`;
    case "tender":
      return `tender_${source_id}`;
    case "liability_gift_card":
      return source_id === "default" ? "gc_liability" : null;
    case "expense_loyalty":
      return source_id === "default" ? "gc_marketing" : null;
    case "clearing_invoice_holding":
      return source_id === "default" ? "invoice_holding" : null;
    case "liability_deposit":
      return source_id === "default" ? "deposit_holding" : null;
    case "expense_merchant_fee":
      return source_id === "default" ? "stripe_fee" : null;
    case "tax":
      return source_id === "SALES_TAX" ? "tax_sales" : null;
    default:
      return null;
  }
}

export function buildMatrixInitialFromGranular(
  granular: {
    source_type: string;
    source_id: string;
    qbo_account_id: string;
    qbo_account_name: string;
  }[],
): Record<string, AccountMapping> {
  const out: Record<string, AccountMapping> = {};
  for (const g of granular) {
    const key = granularToMatrixKey(g.source_type, g.source_id);
    if (!key) continue;
    out[key] = {
      ros_id: key,
      qbo_account_id: g.qbo_account_id,
      qbo_account_name: g.qbo_account_name,
    };
  }
  return out;
}
