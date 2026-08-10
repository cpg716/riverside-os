import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(
  new URL("../src/components/gift-cards/GiftCardsWorkspace.tsx", import.meta.url),
  "utf8",
);
const apiSource = readFileSync(
  new URL("../../server/src/api/gift_cards.rs", import.meta.url),
  "utf8",
);

test.describe("Gift Card Back Office lookup contract", () => {
  test("can open retained history for closed cards without weakening POS lookup", () => {
    expect(workspaceSource).toContain("?include_closed=true");
    expect(apiSource).toContain("if query.include_closed");
    expect(apiSource).toContain("require_gift_cards_manage(&state, &headers).await?");
    expect(apiSource).toContain("require_gift_card_lookup(&state, &headers).await?");
  });
});
