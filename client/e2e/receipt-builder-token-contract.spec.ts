import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { transform } from "receiptline";
import { duplicateReceiptTokens } from "../src/components/settings/receiptTemplateValidation";

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("receipt builder exposes every production ReceiptLine token", () => {
  const builder = readSource("src/components/settings/ReceiptBuilderPanel.tsx");
  const validation = readSource(
    "src/components/settings/receiptTemplateValidation.ts",
  );
  const renderer = readSource("../server/src/logic/receipt_escpos.rs");
  const tokenPattern = /\{\{[A-Z_]+\}\}/g;
  const productionTokens = new Set(renderer.match(tokenPattern) ?? []);

  for (const token of productionTokens) {
    expect(builder, `builder is missing ${token}`).toContain(token);
  }

  expect(builder).toContain(
    '["Wedding Deposits", "{{WEDDING_DEPOSIT_LINES}}"]',
  );
  expect(builder).not.toContain(
    '["Payment History", "{{PAYMENT_HISTORY_BLOCK}}"]',
  );
  expect(builder).toContain('"Order payment"');
  expect(builder).toContain('"Paid today - CC | $250.00"');
  expect(builder).toContain('"Status | Paid in full"');
  expect(builder).toContain('["Register", "{{REGISTER_LINE}}"]');
  expect(builder).toContain("duplicateReceiptTokens");
  expect(validation).toContain("INTENTIONAL_BARCODE_STUB_TOKENS");
  expect(validation).toContain('"{{CUSTOMER_LINE}}"');
  expect(validation).toContain('"{{RECEIPT_ID}}"');
  expect(validation).toContain('"{{RECEIPT_DATE}}"');
  expect(builder).toContain("disabled={busy || hasInvalidSavedTemplate}");
  expect(builder).toContain("disabled={testPrinting || activeTemplateInvalid}");
  expect(builder).toContain('previewTaxLines("$3.98", "$0.00", "$3.98")');
  expect(builder).toContain("`4.75%: ${localAmount} |`");
  expect(builder).toContain("`4.00%: ${stateAmount} |`");
  expect(builder).toContain("`Total Tax: ${totalAmount} |`");
});

test("receipt builder permits only the intentional barcode stub repeats", () => {
  const intentionalStub = [
    "{{RECEIPT_ID}}",
    "{{RECEIPT_DATE}}",
    "{{CUSTOMER_LINE}}",
    "{{TENDER_LINE}}",
    "{{BARCODE_IMAGE}}",
    "{{CUSTOMER_LINE}}",
    "{{RECEIPT_ID}}",
    "{{RECEIPT_DATE}}",
  ].join("\n");

  expect(duplicateReceiptTokens(intentionalStub)).toEqual([]);
  expect(duplicateReceiptTokens(`${intentionalStub}\n{{TENDER_LINE}}`)).toEqual(
    ["{{TENDER_LINE}}"],
  );
  expect(
    duplicateReceiptTokens(
      `{{CUSTOMER_LINE}}\n{{CUSTOMER_LINE}}\n{{BARCODE_IMAGE}}`,
    ),
  ).toEqual(["{{CUSTOMER_LINE}}"]);
});

test("printed tax rows use compact Epson Font B with contiguous labels", () => {
  const receiptSummary = readSource(
    "src/components/pos/ReceiptSummaryModal.tsx",
  );
  const command = String(
    transform(
      [
        "{command:\\x1b\\x4d\\x01}",
        "4.75%: $4.00 |",
        "4.00%: $0.00 |",
        "Total Tax: $4.00 |",
        "{command:\\x1b\\x4d\\x00}",
      ].join("\n"),
      {
        cpl: 48,
        encoding: "cp437",
        command: "escpos",
        cutting: false,
        spacing: false,
        margin: "full",
      },
    ),
  );
  const bytes = Buffer.from(command, "binary");

  expect(bytes.includes(Buffer.from([0x1b, 0x4d, 0x01]))).toBe(true);
  expect(bytes.includes(Buffer.from("4.75%: $4.00", "ascii"))).toBe(true);
  expect(bytes.includes(Buffer.from("4.00%: $0.00", "ascii"))).toBe(true);
  expect(bytes.includes(Buffer.from("Total Tax: $4.00", "ascii"))).toBe(true);
  expect(bytes.includes(Buffer.from([0x1b, 0x4d, 0x00]))).toBe(true);
  expect(receiptSummary).toContain(
    "/^(?:4\\.75%|4\\.00%|TotalTax):-?\\$\\d/",
  );
});

test("receipt builder offers the supported preview scenarios", () => {
  const builder = readSource("src/components/settings/ReceiptBuilderPanel.tsx");

  for (const scenario of [
    "sale",
    "mixed",
    "pickup",
    "return",
    "exchange",
    "gift",
  ]) {
    expect(builder, `builder is missing the ${scenario} preview`).toContain(
      `value: "${scenario}"`,
    );
  }

  expect(builder).toContain("Preview transaction");
  expect(builder).toContain("Mixed transaction");
});
