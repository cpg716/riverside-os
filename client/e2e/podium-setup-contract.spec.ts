import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const panel = repoFile(
  "client/src/components/settings/PodiumSettingsPanel.tsx",
);
const callback = repoFile(
  "client/src/components/settings/PodiumOAuthCallback.tsx",
);
const oauthHelpers = repoFile("client/src/lib/podiumOAuth.ts");
const settingsApi = repoFile("server/src/api/settings.rs");
const customersApi = repoFile("server/src/api/customers.rs");
const podiumLogic = repoFile("server/src/logic/podium.rs");
const podiumReviews = repoFile("server/src/logic/podium_reviews.rs");
const podiumWebhook = repoFile("server/src/logic/podium_webhook.rs");
const podiumWebhookMigration = repoFile(
  "migrations/183_podium_webhook_processing_queue.sql",
);
const podiumReviewMigration = repoFile(
  "migrations/184_schedule_podium_review_invites.sql",
);
const receiptSummary = repoFile(
  "client/src/components/pos/ReceiptSummaryModal.tsx",
);
const reviewsOperations = repoFile(
  "client/src/components/operations/ReviewsOperationsSection.tsx",
);

test("Podium setup is guided and authorization is prerequisite-gated", () => {
  expect(panel).toContain("Connect Podium in 3 steps");
  expect(panel).toContain("Open Podium Developer Portal");
  expect(panel).toContain("Copy callback");
  expect(panel).toContain("Open Secure Riverside");
  expect(panel).toContain("!appCredentialsReady || !callbackReady");
  expect(panel).toContain("isPodiumOAuthBrowserOriginReady");
  expect(panel).toContain("Advanced and incoming-message setup");
  expect(oauthHelpers).toContain(
    'PODIUM_PUBLIC_APP_ORIGIN = "https://ros.riversidemens.com"',
  );
  expect(oauthHelpers).toContain("return PODIUM_PRODUCTION_OAUTH_REDIRECT_URI");
  expect(oauthHelpers).toContain("callback.origin === current.origin");
  expect(settingsApi).toContain("client_id_configured");
  expect(settingsApi).toContain("client_secret_configured");
});

test("Podium callback shows the provider exchange error", () => {
  expect(callback).toContain("`Podium connection failed: ${j.error}`");
});

test("Podium provider contracts and webhook processing stay hardened", () => {
  expect(podiumLogic).toContain('"phoneNumber"');
  expect(podiumLogic).toContain('"locations"');
  expect(podiumLogic).toContain('json!({ "assigneeUids": assignee_uids })');
  expect(podiumLogic).toContain("http.put(&url)");
  expect(podiumLogic).toContain("StatusCode::TOO_MANY_REQUESTS");
  expect(podiumLogic).toContain("invalidate_podium_access_token");
  expect(podiumReviews).toContain("deliver_review_invite_link");
  expect(podiumReviews).toContain("process_due_review_invites");
  expect(podiumReviews).toContain("send_podium_sms_message_tracked");
  expect(podiumReviews).toContain("send_podium_email_message_tracked");
  expect(podiumLogic).toContain('"email"');
  expect(podiumReviews).toContain('"/deliveryStatus"');
  expect(podiumWebhook).toContain("process_pending_podium_webhooks");
  expect(podiumWebhookMigration).toContain("raw_payload JSONB");
  expect(podiumWebhookMigration).toContain("processing_status SET DEFAULT 'pending'");
  expect(podiumReviewMigration).toContain("review_invite_delivery_time");
  expect(podiumReviewMigration).toContain("TIME '10:00'");
  expect(podiumReviewMigration).toContain("v_target_date := v_target_date + 1");
  expect(receiptSummary).toContain("Scheduled automatically");
  expect(receiptSummary).not.toContain("setSkipReviewInvite");
  expect(reviewsOperations).toContain('label: "Failed"');
  expect(reviewsOperations).toContain('id: "scheduled"');
  expect(customersApi).toContain('sep.push("review_requests_opt_out = ")');
  expect(customersApi).not.toContain("opt_out_podium_contact");
  expect(podiumLogic).not.toContain("campaigns/opt_out");
});
