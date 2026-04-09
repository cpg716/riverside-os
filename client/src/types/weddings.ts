export interface WeddingMember {
  id: string;
  wedding_party_id: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  measured: boolean;
  suit_ordered: boolean;
  suit?: string;
  waist?: string;
  vest?: string;
  shirt?: string;
  shoe?: string;
  balance_due?: string | number;
}

export interface WeddingPartyRow {
  id: string;
  party_name: string | null;
  groom_name: string;
  bride_name: string | null;
  event_date: string;
  venue: string | null;
}

export interface WeddingPartyDetail extends WeddingPartyRow {
  members: WeddingMember[];
  /** Server-computed `NameNoSpaces-MMDDYY`; optional for older responses. */
  party_tracking_label?: string;
}

export interface WeddingLedgerSummary {
  wedding_party_id: string;
  total_order_value: string;
  total_paid: string;
  balance_due: string;
}

export interface WeddingLedgerLine {
  order_id: string | null;
  customer_name: string;
  wedding_member_id: string;
  kind: string;
  amount: string;
  created_at: string;
}

export interface WeddingLedgerResponse {
  summary: WeddingLedgerSummary;
  lines: WeddingLedgerLine[];
}

export interface AppointmentRow {
  id: string;
  wedding_member_id: string;
  appointment_type: string;
  starts_at: string;
  status: string;
}
