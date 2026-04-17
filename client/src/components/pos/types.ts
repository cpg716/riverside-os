export type { Customer } from "./CustomerSelector";
export type { WeddingMember } from "./WeddingLookupDrawer";

export interface ResolvedSkuItem {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  variation_label?: string | null;
  standard_retail_price: string | number;
  employee_price?: string | number;
  unit_cost: string | number;
  spiff_amount?: string | number;
  state_tax: string | number;
  local_tax: string | number;
  tax_category?: "clothing" | "footwear" | "other";
  stock_on_hand?: number;
  vendor_sku?: string;
  /** Present when API includes it (promotions, prompts). */
  category_id?: string | null;
  primary_vendor_id?: string | null;
  /** Custom Work Order fields */
  custom_item_type?: string;
  is_rush?: boolean;
  need_by_date?: string | null;
  needs_gift_wrap?: boolean;
  image_url?: string;
}

export interface SearchResult extends ResolvedSkuItem {
  image_url?: string;
}

export type FulfillmentKind =
  | "takeaway"
  | "special_order"
  | "wedding_order"
  | "custom"
  | "layaway";

export interface CartLineItem extends ResolvedSkuItem {
  quantity: number;
  fulfillment: FulfillmentKind;
  /** Stable row identity (e.g. multiple POS gift card loads share the same internal SKU). */
  cart_row_id: string;
  /** Set on internal `pos_gift_card_load` lines; sent as `gift_card_load_code` at checkout. */
  gift_card_load_code?: string | null;
  price_override_reason?: string;
  original_unit_price?: string;
  salesperson_id?: string | null;
  /** When set, checkout sends `discount_event_id` and price must match event % off retail. */
  discount_event_id?: string | null;
  /** Preserved tax rates from catalog to prevent compounding rounding errors during recalculation. */
  nominal_state_tax_rate?: number;
  nominal_local_tax_rate?: number;
}

export type GiftCardType =
  | "paid_liability"
  | "loyalty_giveaway"
  | "donated_giveaway";

export interface AppliedPaymentLine {
  id: string;
  method: string;
  sub_type?: GiftCardType;
  gift_card_code?: string;
  /** Tender amount in integer cents (source of truth for checkout splits). */
  amountCents: number;
  label: string;
  metadata?: {
    stripe_intent_id?: string;
    card_brand?: string | null;
    card_last4?: string | null;
    check_number?: string | null;
  };
}

export type AppliedPayment = AppliedPaymentLine;

export interface CheckoutOperatorContext {
  staffId: string;
  fullName: string;
}

export interface PosOrderOptions {
  is_rush?: boolean;
  need_by_date?: string | null;
  fulfillment_mode?: string | null;
  ship_to?: PosShipToForm | null;
  stripe_payment_method_id?: string | null;
}

export type NexoTenderTab =
  | "card_terminal"
  | "card_manual"
  | "card_saved"
  | "card_credit"
  | "cash"
  | "check"
  | "gift_card"
  | "on_account_rms"
  | "on_account_rms90"
  | "store_credit";

export interface CheckoutPaymentSplitPayload {
  payment_method: string;
  amount: string;
  sub_type?: "paid_liability" | "loyalty_giveaway" | "donated_giveaway";
  applied_deposit_amount?: string;
  gift_card_code?: string;
  check_number?: string;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

/** Active staff for POS salesperson pickers (commissions / attribution). */
export type PosStaffRow = {
  id: string;
  full_name: string;
  role?: string;
};

export interface CheckoutPayload {
  session_id: string;
  operator_staff_id: string;
  primary_salesperson_id: string | null;
  customer_id: string | null;
  wedding_member_id: string | null;
  payment_method: string;
  total_price: string;
  amount_paid: string;
  items: unknown[];
  actor_name?: string | null;
  payment_splits?: CheckoutPaymentSplitPayload[] | null;
  applied_deposit_amount?: string;
  wedding_disbursements?: {
    wedding_member_id: string;
    amount: string;
  }[];
  checkout_client_id?: string;
  /** Binds server `store_shipping_rate_quote` into checkout totals. */
  shipping_rate_quote_id?: string | null;
  /** Binds Order Urgency */
  is_rush?: boolean;
  need_by_date?: string | null;
  /** Order Review flow: pickup or ship */
  fulfillment_mode?: string | null;
  /** Order Review flow: ship-to address JSON */
  ship_to?: unknown | null;
  /** Order Review flow: saved card for balance at pickup */
  stripe_payment_method_id?: string | null;
  /** Tax Exemption */
  is_tax_exempt?: boolean;
  tax_exempt_reason?: string;
  rounding_adjustment?: string;
  final_cash_due?: string;
}

export type ActiveDiscountEvent = {
  id: string;
  receipt_label: string;
  percent_off: string;
  scope_type: string;
  scope_category_id: string | null;
  scope_vendor_id: string | null;
};

export type RmsPaymentLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
};

export type GiftCardLoadLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
};

export interface PosShipToForm {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface PosShippingSelection {
  rate_quote_id: string;
  amount_cents: number;
  /** e.g. "USPS — Priority Mail" */
  label: string;
  to_address: PosShipToForm;
}

export interface CartTotals {
  subtotalCents: number;
  stateTaxCents: number;
  localTaxCents: number;
  totalPieces: number;
  taxCents: number;
  orderTotalCents: number;
  collectTotalCents: number;
  shippingCents: number;
  takeawayDueCents: number;
  totalCents: number;
}
