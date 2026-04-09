export interface WeddingMembership {
  wedding_member_id: string;
  wedding_party_id: string;
  order_id?: string | null;
  party_name: string;
  event_date: string;
  role: string;
  status: string;
  active?: boolean;
}

export interface CustomerProfile {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  date_of_birth: string | null;
  anniversary_date: string | null;
  custom_field_1: string | null;
  custom_field_2: string | null;
  custom_field_3: string | null;
  custom_field_4: string | null;
  marketing_email_opt_in: boolean;
  marketing_sms_opt_in: boolean;
  /** Operational SMS consent; omit on older API responses (treat as false). */
  transactional_sms_opt_in?: boolean;
  /** Operational email (Podium); migration 72+. */
  transactional_email_opt_in?: boolean;
  /** Staff-pasted Podium conversation URL; migration 72+. */
  podium_conversation_url?: string | null;
  /** Present on hub/profile payloads after migration 11. */
  is_vip?: boolean;
  /** `store` (POS/import) or `online_store` (first-party web signup); migration 77+. */
  customer_created_source?: string;
  profile_complete: boolean;
  weddings: WeddingMembership[];
  loyalty_points?: number;
}
