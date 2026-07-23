export interface HeldOpenDeposit {
  customerId: string;
  balanceCents: number;
  lastPayerName: string | null;
  lastCreditCents: number | null;
}

interface OpenDepositApplicationArgs {
  heldBalanceCents: number;
  alreadyAppliedCents: number;
  remainingCheckoutCents: number;
  currentSaleCents: number;
  hasExternalAllocations: boolean;
}

export function openDepositApplicationCents({
  heldBalanceCents,
  alreadyAppliedCents,
  remainingCheckoutCents,
  currentSaleCents,
  hasExternalAllocations,
}: OpenDepositApplicationArgs): number {
  if (hasExternalAllocations) return 0;

  const heldRemaining = Math.max(0, heldBalanceCents - alreadyAppliedCents);
  const currentSaleCapacity = Math.max(0, Math.round(currentSaleCents) - alreadyAppliedCents);

  return Math.min(
    heldRemaining,
    Math.max(0, Math.round(remainingCheckoutCents)),
    currentSaleCapacity,
  );
}

export function heldOpenDepositNoticeMessage(deposit: HeldOpenDeposit): string {
  const amount = (deposit.balanceCents / 100).toFixed(2);
  const payer = deposit.lastPayerName?.trim();
  const payerDetail = payer
    ? ` The most recent contribution was placed by ${payer}.`
    : " Another wedding party member placed this deposit.";

  return `This customer has $${amount} in wedding deposit funds held on their account.${payerDetail} Staff can apply the available amount from the Pay screen when completing this member's eligible sale.`;
}
