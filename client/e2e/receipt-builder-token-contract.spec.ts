import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

test("receipt builder exposes every production ReceiptLine token", () => {
  const builder = readSource("src/components/settings/ReceiptBuilderPanel.tsx");
  const renderer = readSource("../server/src/logic/receipt_escpos.rs");
  const tokenPattern = /\{\{[A-Z_]+\}\}/g;
  const productionTokens = new Set(renderer.match(tokenPattern) ?? []);

  for (const token of productionTokens) {
    expect(builder, `builder is missing ${token}`).toContain(token);
  }

  expect(builder).toContain(
    '["Wedding Deposits", "{{WEDDING_DEPOSIT_LINES}}"]',
  );
  expect(builder).toContain('["Payment History", "{{PAYMENT_HISTORY_BLOCK}}"]');
  expect(builder).toContain('["Register", "{{REGISTER_LINE}}"]');
  expect(builder).toContain("duplicateReceiptTokens");
  expect(builder).toContain("disabled={busy || hasInvalidSavedTemplate}");
  expect(builder).toContain("disabled={testPrinting || activeTemplateInvalid}");
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
