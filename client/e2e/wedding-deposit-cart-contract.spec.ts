import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const cartSource = readFileSync(
  new URL("../src/components/pos/Cart.tsx", import.meta.url),
  "utf8",
);
const weddingDrawerSource = readFileSync(
  new URL("../src/components/pos/WeddingLookupDrawer.tsx", import.meta.url),
  "utf8",
);
const checkoutSource = readFileSync(
  new URL("../src/hooks/useCartCheckout.ts", import.meta.url),
  "utf8",
);

test("wedding deposits are a removable deposit-only Cart workflow", () => {
  expect(cartSource).toContain('data-testid="pos-action-wedding-deposit"');
  expect(cartSource).toContain("openWeddingDepositTool");
  expect(cartSource).toContain(
    "memberships.find((candidate) => candidate.active) ?? memberships[0]",
  );
  expect(cartSource).toContain('data-testid="pos-wedding-deposit-line"');
  expect(cartSource).toContain('data-testid="pos-wedding-deposit-remove"');
  expect(cartSource).toContain("initialPartyId={weddingDrawerInitialPartyId}");
  expect(cartSource).toContain(
    "payerCustomerId={selectedCustomer?.id ?? null}",
  );

  expect(weddingDrawerSource).toContain(
    "/api/weddings/parties/${encodeURIComponent(partyId)}",
  );
  expect(weddingDrawerSource).toContain("setGroupPayMode(true)");
  expect(weddingDrawerSource).toContain(
    "member.customer_id === payerCustomerId",
  );
  expect(weddingDrawerSource).toContain('{isPayer ? " · Payer" : ""}');

  expect(checkoutSource).toContain(
    "checkoutLines.length === 0 && disbursementMembers.length === 0",
  );
});
