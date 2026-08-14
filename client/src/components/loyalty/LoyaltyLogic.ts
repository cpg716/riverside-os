export interface LoyaltyEligibleCustomer {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  loyalty_points: number;
  customer_code?: string;
  card_code?: string;
}

export function loyaltyEligibleDisplayName(c: LoyaltyEligibleCustomer): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export const LOYALTY_GIFT_CARD_CODE_ERROR =
  "Scan or enter the complete 8-digit loyalty gift card code.";

export function normalizeLoyaltyGiftCardCode(code: string): string {
  return code.trim();
}

export function isValidLoyaltyGiftCardCode(code: string): boolean {
  return /^\d{8}$/.test(normalizeLoyaltyGiftCardCode(code));
}

export interface LoyaltySettings {
  id?: string;
  enabled?: boolean;
  points_per_dollar: number;
  loyalty_point_threshold: number;
  loyalty_reward_amount: string | number;
  reward_threshold_points?: number;
  reward_dollar_value?: string;
  loyalty_letter_template?: string;
}
