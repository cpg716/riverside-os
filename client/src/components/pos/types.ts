import type { CustomOrderDetails } from "../../lib/customOrders";

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
  tax_category?: "clothing" | "footwear" | "accessory" | "service" | "other";
  stock_on_hand?: number;
  total_variant_count?: number;
  vendor_sku?: string;
  /** Present when API includes it (promotions, prompts). */
  category_id?: string | null;
  primary_vendor_id?: string | null;
  primary_vendor_name?: string | null;
  /** Custom Work Order fields */
  custom_item_type?: string;
  custom_order_details?: CustomOrderDetails | null;
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

export type OrderLifecycleStatus =
  | "needs_measurements"
  | "ntbo"
  | "ordered"
  | "received"
  | "ready_for_pickup"
  | "picked_up";

export interface CartLineItem extends ResolvedSkuItem {
  line_type?: "merchandise" | "alteration_service";
  quantity: number;
  fulfillment: FulfillmentKind;
  /** Stable row identity (e.g. multiple POS gift card loads share the same internal SKU). */
  cart_row_id: string;
  alteration_intake_id?: string | null;
  alteration_source_cart_row_id?: string | null;
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
  order_lifecycle_status?: OrderLifecycleStatus;
  /** Display-only return credit handed off from the Exchange / Return wizard for tendering. */
  return_tender_original_transaction_id?: string | null;
  return_tender_receipt_label?: string | null;
  return_tender_refund_cents?: number | null;
  /** Database ID of the original transaction line for pickup tracking. */
  transaction_line_id?: string | null;
  catalog_standard_retail_price?: string | number;
  catalog_employee_price?: string | number;
}

export type AlterationSourceType =
  | "current_cart_item"
  | "past_transaction_line"
  | "catalog_item"
  | "custom_item";

export interface PendingAlterationIntake {
  id: string;
  customer_id: string;
  customer_name: string;
  source_type: AlterationSourceType;
  alteration_cart_row_id?: string | null;
  cart_row_id?: string | null;
  item_description: string;
  work_requested: string;
  capacity_bucket?: "jacket" | "pant" | "other" | null;
  capacity_units?: number | null;
  source_product_id?: string | null;
  source_variant_id?: string | null;
  source_sku?: string | null;
  source_transaction_id?: string | null;
  source_transaction_line_id?: string | null;
  charge_amount?: string | null;
  due_at?: string | null;
  notes?: string | null;
  ticket_number?: string | null;
  created_at: string;
}

export interface CheckoutAlterationIntakePayload {
  intake_id: string;
  alteration_line_client_id: string;
  source_client_line_id?: string | null;
  source_type: AlterationSourceType;
  item_description: string;
  work_requested: string;
  capacity_bucket?: "jacket" | "pant" | "other" | null;
  capacity_units?: number | null;
  source_product_id?: string | null;
  source_variant_id?: string | null;
  source_sku?: string | null;
  source_transaction_id?: string | null;
  source_transaction_line_id?: string | null;
  charge_amount?: string | null;
  due_at?: string | null;
  notes?: string | null;
  ticket_number?: string | null;
}

export interface OrderPaymentCartLine {
  line_type: "order_payment";
  cart_row_id: string;
  target_transaction_id: string;
  target_display_id: string;
  customer_id: string;
  customer_name: string;
  amount: string;
  balance_before: string;
  projected_balance_after: string;
}

export interface CheckoutOrderPaymentPayload {
  client_line_id: string;
  target_transaction_id: string;
  target_display_id: string;
  customer_id: string;
  amount: string;
  balance_before: string;
  projected_balance_after: string;
}

export type GiftCardType =
  | "paid_liability"
  | "loyalty_giveaway"
  | "donated_giveaway"
  | "promo_gift_card";

export interface AppliedPaymentLine {
  id: string;
  method: string;
  sub_type?: GiftCardType;
  gift_card_code?: string;
  /** Tender amount in integer cents (source of truth for checkout splits). */
  amountCents: number;
  label: string;
  metadata?: {
    card_brand?: string | null;
    card_last4?: string | null;
    check_number?: string | null;
    tender_family?: string;
    program_code?: string;
    program_label?: string;
    masked_account?: string;
    resolution_status?: string;
    rms_charge_collection?: boolean;
    staff_account_collection?: boolean;
    posting_status?: string;
    external_transaction_id?: string;
    external_auth_code?: string;
    external_transaction_type?: string;
    host_reference?: string;
    idempotency_key?: string;
    [key: string]: string | number | boolean | null | undefined;
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
  overrideReadiness?: boolean;
  overrideReason?: string;
  pickupPaymentOverride?: {
    managerStaffId: string;
    managerPin: string;
    reason: string;
  };
}

export type NexoTenderTab =
  | "card_terminal"
  | "card_manual"
  | "card_saved"
  | "card_credit"
  | "offline_cc"
  | "cash"
  | "check"
  | "gift_card"
  | "donation"
  | "rms_charge"
  | "staff_account"
  | "store_credit";

export interface CheckoutPaymentSplitPayload {
  payment_method: string;
  amount: string;
  sub_type?: "paid_liability" | "loyalty_giveaway" | "donated_giveaway" | "promo_gift_card";
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
  alteration_intakes?: CheckoutAlterationIntakePayload[];
  order_payments?: CheckoutOrderPaymentPayload[];
  below_cost_approval?: {
    approved_by_staff_id: string;
    reason?: string;
    line_signature?: string;
  };
  actor_name?: string | null;
  payment_splits?: CheckoutPaymentSplitPayload[] | null;
  applied_deposit_amount?: string;
  wedding_disbursements?: {
    wedding_member_id: string;
    amount: string;
  }[];
  checkout_client_id?: string;
  booked_at_local?: string;
  backdate_approval?: {
    approved_by_staff_id: string;
    reason: string;
  };
  /** Binds server `store_shipping_rate_quote` into checkout totals. */
  shipping_rate_quote_id?: string | null;
  /** Existing Transaction Records covered by this shipping charge. */
  shipping_links?: { target_transaction_id: string }[];
  /** Binds Order Urgency */
  is_rush?: boolean;
  need_by_date?: string | null;
  /** Order Review flow: pickup or ship */
  fulfillment_mode?: string | null;
  /** Order Review flow: ship-to address JSON */
  ship_to?: unknown | null;
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

export type StaffAccountPaymentLineMeta = RmsPaymentLineMeta;

export type GiftCardLoadLineMeta = {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
};

export interface PosShipToForm {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
  is_residential?: boolean;
}

export interface PosShippingSelection {
  rate_quote_id: string;
  amount_cents: number;
  /** e.g. "USPS — Priority Mail" */
  label: string;
  to_address: PosShipToForm | null;
  /** A non-taxable fee only; it does not create a shipment or require an address. */
  fee_only?: boolean;
  linked_order_ids?: string[];
}

export interface CartTotals {
  subtotalCents: number;
  stateTaxCents: number;
  localTaxCents: number;
  totalPieces: number;
  taxCents: number;
  orderTotalCents: number;
  orderPaymentCents: number;
  collectTotalCents: number;
  shippingCents: number;
  takeawayDueCents: number;
  totalCents: number;
}
