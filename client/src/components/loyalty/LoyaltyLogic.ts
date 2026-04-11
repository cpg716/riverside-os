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
