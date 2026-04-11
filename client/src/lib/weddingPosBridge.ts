/** Dispatched from Wedding Manager to open POS with a linked wedding member (wedding_order semantics). */
export const ROS_OPEN_REGISTER_FROM_WM = "ros-open-register-from-wm";

export type RosOpenRegisterFromWmMember = {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  measured: boolean;
  suit_ordered: boolean;
  customer_id: string;
  customer_email?: string | null;
  customer_phone?: string | null;
  suit_variant_id?: string | null;
  /** Added for "Buy 5, Get 1" promotion tracking. */
  is_free_suit_promo?: boolean | null;
};

export type RosOpenRegisterFromWmDetail = {
  partyName: string;
  member: RosOpenRegisterFromWmMember;
};

export function dispatchOpenRegisterFromWeddingManager(detail: RosOpenRegisterFromWmDetail): void {
  window.dispatchEvent(new CustomEvent(ROS_OPEN_REGISTER_FROM_WM, { detail }));
}
