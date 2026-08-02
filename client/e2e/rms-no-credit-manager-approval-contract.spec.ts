import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const drawer = readFileSync(
  new URL("../src/components/pos/NexoCheckoutDrawer.tsx", import.meta.url),
  "utf8",
);
const checkout = readFileSync(
  new URL("../../server/src/logic/transaction_checkout.rs", import.meta.url),
  "utf8",
);

test("no-credit RMS charges require an audited manager approval", () => {
  expect(drawer).toContain('authorize_action: "rms_charge_no_open_to_buy"');
  expect(drawer).toContain("rmsNoCreditTenderNeedsApproval");
  expect(drawer).toContain("No available credit");
  expect(drawer).toContain("Manager Access is required before Ready to Save becomes available.");
  expect(checkout).toContain("rms_account_has_no_open_to_buy");
  expect(checkout).toContain("rms_no_open_to_buy_approval_was_logged");
  expect(checkout).toContain(
    "This RMS account has no available credit. Manager Access approval is required before recording the sale.",
  );
});

test("RMS plan choices remain touch sized and use plain labels", () => {
  expect(drawer).toMatch(
    /program\.program_code === "rms90"\s+\? "90 Day"\s+: "Standard"/,
  );
  expect(drawer).toContain("min-h-14");
  expect(drawer).toContain("RMS approval #");
  expect(drawer).toContain("Account {rmsSelectedAccount.masked_account}");
});
