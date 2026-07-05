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
  { id: "helcim_card", label: "Helcim card clearing" },
  { id: "credit_card", label: "Credit card clearing" },
  { id: "card_terminal", label: "Legacy card terminal" },
  { id: "card_manual", label: "Manual card clearing" },
  { id: "card_saved", label: "Saved card clearing" },
  { id: "card_credit", label: "Card refund clearing" },
  { id: "cash", label: "Cash" },
  { id: "check", label: "Check" },
  { id: "donation", label: "Donation clearing" },
  { id: "on_account", label: "On account (AR)" },
  { id: "gift_card", label: "Gift card (redemption)" },
  { id: "exchange_credit", label: "Exchange credit clearing" },
] as const;

export const QBO_MATRIX_CUSTOM_TYPES = [
  { id: "hsm_suit", label: "HSM Suit" },
  { id: "hsm_sport_coat", label: "HSM Sport Coat" },
  { id: "hsm_slacks", label: "HSM Slacks" },
  { id: "individualized_shirt", label: "Individualized Shirt" },
] as const;

export const QBO_MATRIX_FINANCIAL_ACCOUNTS = [
  {
    key: "shipping_income",
    label: "Shipping income",
    help: "Customer-charged shipping recognized with fulfilled/completed sales.",
    placeholder: "Shipping revenue income",
  },
  {
    key: "alterations_income",
    label: "Alterations income",
    help: "Charged alteration service lines.",
    placeholder: "Alterations/service income",
  },
  {
    key: "store_credit_liability",
    label: "Store credit liability",
    help: "Store credit redemptions release this liability instead of posting as tender revenue.",
    placeholder: "Store credit liability",
  },
  {
    key: "refund_queue_liability",
    label: "Refund queue clearing",
    help: "Balances return day and payout day when a refund is approved before cash leaves.",
    placeholder: "Refund liability clearing",
  },
  {
    key: "forfeited_deposit_income",
    label: "Forfeited deposit income",
    help: "Layaway or order deposits retained after approved forfeiture.",
    placeholder: "Forfeited deposit income",
  },
  {
    key: "gift_card_breakage_income",
    label: "Gift card breakage income",
    help: "Expired purchased gift card balances recognized as income after liability relief.",
    placeholder: "Gift card breakage income",
  },
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
  if (key === "deposit_holding") {
    return { source_type: "liability_deposit", source_id: "default" };
  }
  if (key === "merchant_fee") {
    return { source_type: "expense_merchant_fee", source_id: "default" };
  }
  if (key === "tax_sales") {
    return { source_type: "tax", source_id: "SALES_TAX" };
  }
  if (key === "shipping_income") {
    return { source_type: "income_shipping", source_id: "default" };
  }
  if (key === "alterations_income") {
    return { source_type: "income_alterations", source_id: "default" };
  }
  if (key === "store_credit_liability") {
    return { source_type: "liability_store_credit", source_id: "default" };
  }
  if (key === "refund_queue_liability") {
    return { source_type: "liability_refund_queue", source_id: "default" };
  }
  if (key === "forfeited_deposit_income") {
    return { source_type: "income_forfeited_deposit", source_id: "default" };
  }
  if (key === "gift_card_breakage_income") {
    return { source_type: "income_gift_card_breakage", source_id: "default" };
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
    case "liability_deposit":
      return source_id === "default" ? "deposit_holding" : null;
    case "expense_merchant_fee":
      return source_id === "default" ? "merchant_fee" : null;
    case "tax":
      return source_id === "SALES_TAX" ? "tax_sales" : null;
    case "income_shipping":
      return source_id === "default" ? "shipping_income" : null;
    case "income_alterations":
      return source_id === "default" ? "alterations_income" : null;
    case "liability_store_credit":
      return source_id === "default" ? "store_credit_liability" : null;
    case "liability_refund_queue":
      return source_id === "default" ? "refund_queue_liability" : null;
    case "income_forfeited_deposit":
      return source_id === "default" ? "forfeited_deposit_income" : null;
    case "income_gift_card_breakage":
      return source_id === "default" ? "gift_card_breakage_income" : null;
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
