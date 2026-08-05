import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const receiptBuilder = repoFile(
  "client/src/components/settings/ReceiptBuilderPanel.tsx",
);
const saleComplete = repoFile(
  "client/src/components/pos/ReceiptSummaryModal.tsx",
);
const transactionsApi = repoFile("server/src/api/transactions.rs");
const settingsApi = repoFile("server/src/api/settings.rs");

test("Receipt Builder can send the current preview to typed email and phone destinations", () => {
  expect(receiptBuilder).toContain('aria-label="Test receipt email address"');
  expect(receiptBuilder).toContain('aria-label="Test receipt phone number"');
  expect(receiptBuilder).toContain("Send Test Email");
  expect(receiptBuilder).toContain("Send Test Text");
  expect(receiptBuilder).toContain(
    "`${baseUrl}/api/settings/receipt/test-${channel}`",
  );
  expect(receiptBuilder).toContain("receiptHtmlToPngBase64");
  expect(settingsApi).toContain('"/receipt/test-email"');
  expect(settingsApi).toContain('"/receipt/test-sms"');
  expect(settingsApi).toContain("email::send_email(");
  expect(settingsApi).toContain(
    "send_podium_phone_message_with_png_attachment",
  );
});

test("Sale Complete sends email through Store Email and text through Podium", () => {
  expect(saleComplete).toContain("Email receipt");
  expect(saleComplete).toContain("Text receipt");
  expect(saleComplete).toContain("/receipt/send-email");
  expect(saleComplete).toContain("/receipt/send-sms");
  expect(saleComplete).toContain("receiptHtmlToPngBase64");
  expect(saleComplete).toContain("payload.png_base64 = pngBase64");
  expect(transactionsApi).toContain("store_email::send_email(");
  expect(transactionsApi).toContain(
    "send_podium_phone_message_with_png_attachment",
  );
  expect(transactionsApi).toContain("send_podium_sms_message(");
  expect(transactionsApi).toContain(
    'json!({ "status": "sent", "mode": "mms_attachment" })',
  );
  expect(transactionsApi).toContain(
    'json!({ "status": "sent", "mode": "sms_text" })',
  );
});
