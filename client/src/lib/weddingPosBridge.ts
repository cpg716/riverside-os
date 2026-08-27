/** Dispatched from Wedding Manager to open POS with a linked wedding member (wedding_order semantics). */
export const ROS_OPEN_REGISTER_FROM_WM = "ros-open-register-from-wm";
export const ROS_OPEN_TRANSACTION_FROM_WM = "ros-open-transaction-from-wm";

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

type WeddingManagerMemberLike = {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  role?: string | null;
  status?: string | null;
  measured?: boolean | null;
  ordered?: boolean | null;
  suit_ordered?: boolean | null;
  customerId?: string | null;
  customer_id?: string | null;
  customerEmail?: string | null;
  customer_email?: string | null;
  phone?: string | null;
  customer_phone?: string | null;
  suitVariantId?: string | null;
  suit_variant_id?: string | null;
  isFreeSuitPromo?: boolean | null;
  is_free_suit_promo?: boolean | null;
};

export function dispatchOpenRegisterFromWeddingManager(detail: RosOpenRegisterFromWmDetail): void {
  window.dispatchEvent(new CustomEvent(ROS_OPEN_REGISTER_FROM_WM, { detail }));
}

export function openWeddingMemberInRegister(
  partyName: string,
  member: WeddingManagerMemberLike,
): boolean {
  const customerId = member.customerId ?? member.customer_id ?? "";
  if (!customerId) return false;

  dispatchOpenRegisterFromWeddingManager({
    partyName,
    member: {
      id: member.id,
      first_name: member.firstName ?? member.first_name ?? "",
      last_name: member.lastName ?? member.last_name ?? "",
      role: member.role ?? "Member",
      status: member.status ?? "prospect",
      measured: Boolean(member.measured),
      suit_ordered: Boolean(member.ordered ?? member.suit_ordered),
      customer_id: customerId,
      customer_email: member.customerEmail ?? member.customer_email ?? null,
      customer_phone: member.phone ?? member.customer_phone ?? null,
      suit_variant_id: member.suitVariantId ?? member.suit_variant_id ?? null,
      is_free_suit_promo: Boolean(
        member.isFreeSuitPromo ?? member.is_free_suit_promo,
      ),
    },
  });
  return true;
}

export function dispatchOpenWeddingTransaction(transactionId: string): void {
  window.dispatchEvent(
    new CustomEvent(ROS_OPEN_TRANSACTION_FROM_WM, { detail: { transactionId } }),
  );
}
