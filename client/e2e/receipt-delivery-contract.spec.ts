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
const receiptDeliverySettings = repoFile(
  "client/src/components/settings/ReceiptDeliverySettingsCard.tsx",
);
const saleComplete = repoFile(
  "client/src/components/pos/ReceiptSummaryModal.tsx",
);
const transactionsApi = repoFile("server/src/api/transactions.rs");
const settingsApi = repoFile("server/src/api/settings.rs");
const storeEmail = repoFile("server/src/logic/email.rs");

test("Receipt Builder can send the current preview to typed email and phone destinations", () => {
  expect(receiptBuilder).toContain('aria-label="Test receipt email address"');
  expect(receiptBuilder).toContain('aria-label="Test receipt phone number"');
  expect(receiptBuilder).toContain("Send Test Email");
  expect(receiptBuilder).toContain("Send Test Text");
  expect(receiptBuilder).toContain(
    "`${baseUrl}/api/settings/receipt/test-${channel}`",
  );
  expect(receiptBuilder).toContain("receiptHtmlToPngBase64");
  expect(receiptBuilder).toContain("png_base64: pngBase64");
  expect(receiptBuilder).toContain("receipt_sms_enabled");
  expect(receiptBuilder).not.toContain("receiptEmailHtml");
  expect(settingsApi).toContain('"/receipt/test-email"');
  expect(settingsApi).toContain('"/receipt/test-sms"');
  expect(settingsApi).toContain("email::send_email_with_attachments(");
  expect(settingsApi).toContain("RECEIPT_TEST_EMAIL_CONTENT_ID");
  expect(settingsApi).toContain('"mode": "inline_png"');
  expect(storeEmail).toContain("Attachment::new_inline_with_name");
  expect(settingsApi).toContain(
    "send_podium_phone_message_with_png_attachment",
  );
  expect(settingsApi).toContain("podium_cfg.sms_features.receipts");
  expect(settingsApi).toContain(
    "podium_cfg.receipt_templates.merged_defaults().sms_caption",
  );
});

test("Digital Receipt Delivery shows current Store Email and Podium readiness", () => {
  expect(receiptDeliverySettings).toContain("Store Email");
  expect(receiptDeliverySettings).toContain("Podium");
  expect(receiptDeliverySettings).toContain("ui-pill");
  expect(receiptDeliverySettings).toContain("/api/settings/email");
  expect(receiptDeliverySettings).toContain("/api/settings/podium/readiness");
  expect(receiptDeliverySettings).toContain("/api/mailbox/health");
  expect(receiptDeliverySettings).toContain("/api/settings/podium/health");
  expect(receiptDeliverySettings).toContain("credentials_configured");
  expect(receiptDeliverySettings).toContain("location_uid_configured");
  expect(receiptDeliverySettings).toContain("receipt_sms_enabled");
  expect(receiptDeliverySettings).toContain("smtp_reachable");
  expect(receiptDeliverySettings).toContain("podiumHealth?.reachable");
  expect(receiptDeliverySettings).toContain("Save pending");
});

test("Sale Complete sends email through Store Email and text through Podium", () => {
  expect(saleComplete).toContain("Email receipt");
  expect(saleComplete).toContain("Text receipt");
  expect(saleComplete).toContain("/receipt/send-email");
  expect(saleComplete).toContain("/receipt/send-sms");
  expect(saleComplete).toContain("receiptHtmlToPngBase64");
  expect(saleComplete).toContain("payload.png_base64 = pngBase64");
  expect(transactionsApi).toContain("store_email::send_email(");
  expect(transactionsApi).toContain("podium::apply_template_placeholders(");
  expect(transactionsApi).toContain("&message_templates.email_subject");
  expect(transactionsApi).toContain("&message_templates.gift_email_subject");
  expect(transactionsApi).toContain('"Gift receipt"');
  expect(transactionsApi).toContain(
    "wrap_receipt_fragment_for_podium_email_inline",
  );
  expect(transactionsApi).toContain(
    "send_podium_phone_message_with_png_attachment",
  );
  expect(transactionsApi).toContain("send_podium_sms_message_tracked(");
  expect(transactionsApi).toContain(
    'json!({ "status": "sent", "mode": "mms_attachment" })',
  );
  expect(transactionsApi).toContain(
    'json!({ "status": "sent", "mode": "sms_text" })',
  );
});
