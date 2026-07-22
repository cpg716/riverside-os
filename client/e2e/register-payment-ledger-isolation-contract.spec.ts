import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("approved provider tender stays with its current customer", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");

  expect(cart).toContain("currentCustomerId !== nextCustomerId");
  expect(cart).toContain("approvedProviderPaymentInCheckout");
  expect(cart).toContain("providerCheckoutIdentityHeld");
  expect(cart).toContain("latestProviderSaleLockRef.current");
  expect(cart).toContain("latestSaleCustomerIdRef.current");
  expect(cart).toContain("A card workflow is active for this checkout");
  expect(cart).toContain("onSelect={selectCustomerForSale}");
  expect(cart).toContain("use Clear Sale and Payments Health before choosing another customer");
  expect(cart).toContain(
    "It does not delete, move, retry, or refund the approved provider payment",
  );
  expect(cart).toContain(
    "The approved provider payment remains in Payments Health",
  );
  expect(cart).toContain("checkoutAppliedPayments.length === 0");
  expect(cart).toContain("!providerCheckoutIdentityHeld");
});

test("parked-sale recall cannot inherit tender from the active checkout", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const parkedSales = repoFile("client/src/hooks/useParkedSales.ts");

  expect(cart).toContain("latestParkedRecallStateRef.current");
  expect(cart).toContain("appliedPaymentCount: checkoutAppliedPayments.length");
  expect(cart).toContain("providerCheckoutIdentityHeld");
  expect(cart).toContain(
    "canReplaceCurrentSale: canReplaceCurrentSaleWithParked",
  );
  expect(cart).toContain(
    "Riverside will not carry tender or card activity into the recalled sale",
  );

  const guard = "if (!canReplaceCurrentSale()) return;";
  expect(parkedSales.split(guard)).toHaveLength(3);
  expect(parkedSales.lastIndexOf(guard)).toBeLessThan(
    parkedSales.indexOf("await recallParkedSaleOnServer"),
  );
});

test("only exact audited recovery evidence clears the active Register sale", () => {
  const cart = repoFile("client/src/components/pos/Cart.tsx");
  const offlineQueue = repoFile("client/src/lib/offlineQueue.ts");

  expect(offlineQueue).toContain("CHECKOUT_RECOVERY_RESOLVED_EVENT");
  expect(offlineQueue).toContain("serverCheckoutClientId === checkoutClientId");
  expect(offlineQueue).toContain("job.client_job_key === recoveryKey");
  expect(offlineQueue).toContain("transactionId &&");
  expect(cart).toContain("detail.checkoutClientId !== checkoutClientId");
  expect(cart).toContain("!detail.recoveryKey?.startsWith(\"checkout:\")");
  expect(cart).toContain("clearCartAndAlterations();");
  expect(cart).toContain("setCheckoutClientId(newCheckoutClientId());");
  expect(cart).toContain("const clearSaleForNextCheckout = useCallback");
  expect(cart).toContain("clearSaleForNextCheckout();");
  expect(cart).toContain('key={`${checkoutClientId}:${selectedCustomer?.id ?? "no-customer"}`}');
});
