import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  counterpointGiftCardReason,
  mapCounterpointGiftCardRow,
} from "./gift-card-mapping.mjs";

test("Counterpoint gift card programs map to explicit ROS reason codes", () => {
  assert.equal(counterpointGiftCardReason({ gfc_cod: "GC" }), "GC");
  assert.equal(
    counterpointGiftCardReason({ gfc_cod: "GC DONATE" }),
    "GC DONATE",
  );
  assert.equal(
    counterpointGiftCardReason({ gfc_cod: "PROMO GC", descr: "LOYALTY AWARD" }),
    "LOYALTY",
  );
  assert.equal(
    counterpointGiftCardReason({ gfc_cod: "PROMO GC", descr: "PROMOTIONAL" }),
    "PROMO GC",
  );
});

test("Counterpoint gift card mapping carries original amount and issue date", () => {
  const mapped = mapCounterpointGiftCardRow({
    gift_cert_no: " 12345 ",
    balance: "25.00",
    orig_amt: "50.00",
    gfc_cod: "GC DONATE",
    orig_dat: "2025-04-10T00:00:00",
  });

  assert.equal(mapped.cert_no, "12345");
  assert.equal(mapped.original_value, "50.00");
  assert.equal(mapped.reason_cod, "GC DONATE");
  assert.equal(mapped.issued_at, "2025-04-10T00:00:00.000Z");
});

test("Counterpoint gift card query carries classification and issue metadata", () => {
  const bridgeSource = readFileSync(
    new URL("./index.mjs", import.meta.url),
    "utf8",
  );

  for (const sourceColumn of [
    '["GFC_COD"]',
    '["DESCR"]',
    '["ORIG_AMT"]',
    '["ORIG_DAT", "ISSUE_DAT"]',
  ]) {
    assert.ok(bridgeSource.includes(sourceColumn), `missing ${sourceColumn}`);
  }
});
