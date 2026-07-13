import type { AppliedPaymentLine } from "./types";

export function isApprovedProviderPayment(line: AppliedPaymentLine): boolean {
  const provider = line.metadata?.payment_provider;
  if (typeof provider !== "string" || provider.trim().length === 0) return false;

  const status = String(line.metadata?.provider_status ?? "").trim().toLowerCase();
  return (
    status === "approved" ||
    status === "captured" ||
    typeof line.metadata?.payment_provider_attempt_id === "string" ||
    typeof line.metadata?.provider_transaction_id === "string"
  );
}

export function hasApprovedProviderPayment(lines: AppliedPaymentLine[]): boolean {
  return lines.some(isApprovedProviderPayment);
}
