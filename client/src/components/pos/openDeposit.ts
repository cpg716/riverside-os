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
  takeawayCents: number;
  hasExternalAllocations: boolean;
}

export function openDepositApplicationCents({
  heldBalanceCents,
  alreadyAppliedCents,
  remainingCheckoutCents,
  currentSaleCents,
  takeawayCents,
  hasExternalAllocations,
}: OpenDepositApplicationArgs): number {
  if (hasExternalAllocations) return 0;

  const heldRemaining = Math.max(0, heldBalanceCents - alreadyAppliedCents);
  const deferredSaleCapacity = Math.max(
    0,
    Math.round(currentSaleCents) - Math.max(0, Math.round(takeawayCents)) - alreadyAppliedCents,
  );

  return Math.min(
    heldRemaining,
    Math.max(0, Math.round(remainingCheckoutCents)),
    deferredSaleCapacity,
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
