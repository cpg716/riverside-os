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
const smsSettings = repoFile(
  "client/src/components/settings/PodiumSmsSettingsCard.tsx",
);
const emailTemplates = repoFile(
  "client/src/components/settings/OperationalEmailTemplatesCard.tsx",
);
const reviewSettings = repoFile(
  "client/src/components/settings/ReviewInvitesSettingsCard.tsx",
);
const receiptDelivery = repoFile(
  "client/src/components/settings/ReceiptDeliverySettingsCard.tsx",
);
const webChatSettings = repoFile(
  "client/src/components/settings/PodiumWebChatSettingsCard.tsx",
);
const callback = repoFile(
  "client/src/components/settings/PodiumOAuthCallback.tsx",
);
const oauthHelpers = repoFile("client/src/lib/podiumOAuth.ts");
const settingsApi = repoFile("server/src/api/settings.rs");
const customersApi = repoFile("server/src/api/customers.rs");
const podiumLogic = repoFile("server/src/logic/podium.rs");
const podiumContacts = repoFile("server/src/logic/podium_contacts.rs");
const podiumReviews = repoFile("server/src/logic/podium_reviews.rs");
const reviewsApi = repoFile("server/src/api/reviews.rs");
const podiumWebhook = repoFile("server/src/logic/podium_webhook.rs");
const podiumWebhookApi = repoFile("server/src/api/webhooks.rs");
const podiumInbound = repoFile("server/src/logic/podium_inbound.rs");
const podiumMessaging = repoFile("server/src/logic/podium_messaging.rs");
const podiumCalls = repoFile("server/src/logic/podium_calls.rs");
const podiumReviewActivity = repoFile(
  "server/src/logic/podium_review_activity.rs",
);
const podiumInbox = repoFile(
  "client/src/components/customers/PodiumMessagingInboxSection.tsx",
);
const customerRelationshipHub = repoFile(
  "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
);
const podiumResponderModal = repoFile(
  "client/src/components/customers/PodiumResponderPinModal.tsx",
);
const staffEditDrawer = repoFile(
  "client/src/components/staff/StaffEditDrawer.tsx",
);
const staffProfile = repoFile(
  "client/src/components/settings/StaffProfilePanel.tsx",
);
const podiumWebhookMigration = repoFile(
  "migrations/183_podium_webhook_processing_queue.sql",
);
const podiumReviewMigration = repoFile(
  "migrations/184_schedule_podium_review_invites.sql",
);
const podiumResponderMigration = repoFile(
  "migrations/194_podium_conversation_responder.sql",
);
const podiumCallMigration = repoFile(
  "migrations/196_podium_call_events.sql",
);
const podiumReviewActivityMigration = repoFile(
  "migrations/197_podium_review_activity.sql",
);
const podiumRecoveryMigration = repoFile(
  "migrations/198_recover_podium_delivery_backpressure.sql",
);
const podiumCustomerNameRepairMigration = repoFile(
  "migrations/205_preserve_customer_names_from_podium_display.sql",
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

test("Podium SMS workflows have independent enablement controls", () => {
  for (const feature of [
    "staff_messages",
    "ready_for_pickup",
    "alteration_ready",
    "appointment_confirmation",
    "appointment_reminder",
    "unknown_sender_welcome",
  ]) {
    expect(smsSettings).toContain(feature);
    expect(podiumLogic).toContain(feature);
  }
  expect(receiptDelivery).toContain("receipts");
  expect(receiptDelivery).toContain("Text receipts enabled");
  expect(panel).not.toContain('label: "SMS Active"');
});

test("communication settings are owned by their feature pages", () => {
  expect(panel).not.toContain("Operational Email Templates");
  expect(panel).not.toContain("Review Request Messages");
  expect(panel).not.toContain("Receipt Delivery Messages");
  expect(panel).not.toContain("Web Chat Storefront Widget");
  expect(emailTemplates).toContain("Automated email wording");
  expect(reviewSettings).toContain("Review request wording");
  expect(receiptDelivery).toContain("Digital receipt delivery");
  expect(webChatSettings).toContain("Podium web chat");
  expect(settingsApi).toContain('"/customer-communications"');
});

test("Podium provider contracts and webhook processing stay hardened", () => {
  expect(podiumLogic).toContain('"phoneNumber"');
  expect(podiumLogic).toContain('"locations"');
  expect(podiumLogic).toContain('json!({ "assigneeUids": assignee_uids })');
  expect(podiumLogic).toContain("http.put(&url)");
  expect(podiumLogic).toContain("/v4/webhooks");
  expect(podiumLogic).toContain("PODIUM_REQUIRED_WEBHOOK_EVENT_TYPES");
  expect(settingsApi).toContain('"/podium/provider-setup"');
  expect(settingsApi).toContain('"/podium/webhook"');
  expect(settingsApi).toContain(
    "Call webhooks require the read_phones OAuth scope",
  );
  expect(panel).toContain("Register Podium webhook?");
  expect(panel).toContain('"read_phones"');
  expect(podiumLogic).toContain("StatusCode::TOO_MANY_REQUESTS");
  expect(podiumLogic).toContain("PodiumError::RateLimited");
  expect(podiumLogic).toContain("invalidate_podium_access_token");
  expect(settingsApi).toContain(
    "invalidate_podium_access_token(&state.podium_token_cache).await",
  );
  expect(podiumLogic).toContain("PODIUM_MAX_ATTACHMENT_BYTES");
  expect(podiumLogic).not.toContain("#![allow(clippy::all)]");
  expect(podiumReviews).toContain("deliver_review_invite_link");
  expect(podiumReviews).toContain("process_due_review_invites");
  expect(podiumReviews).toContain("defer_rate_limited_review_invite");
  expect(podiumReviews).toContain("batch paused at provider rate limit");
  expect(podiumRecoveryMigration).toContain("processing_status = 'pending'");
  expect(podiumRecoveryMigration).toContain("review_invite_last_error ILIKE '%HTTP 429%'");
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
  expect(reviewsOperations).toContain('{ id: "scheduled", label: "Outbox" }');
  expect(reviewsOperations).toContain("<PromptModal");
  expect(reviewsOperations).toContain("/cancel`");
  expect(reviewsOperations).toContain("Send Test");
  expect(reviewsOperations).toContain("/api/reviews/test-invite");
  expect(reviewsApi).toContain("REVIEWS_MANAGE");
  expect(reviewsApi).toContain('"/test-invite"');
  expect(reviewsApi).toContain("post_test_review_invite");
  expect(reviewsApi).toContain("post_cancel_review_invite");
  expect(podiumReviews).toContain("send_test_review_invite");
  expect(podiumReviews).toContain('"review_test_invite_send"');
  expect(podiumReviews).toContain("ops_dev_center::write_action_audit");
  expect(podiumReviews).toContain("cancel_scheduled_review_invite");
  expect(podiumReviews).toContain("review_invite_cancelled");
  expect(podiumReviews).toContain("podium_review_url = NULL");
  expect(podiumReviews).toContain('"cancelled_by_staff_id": actor_staff_id');
  expect(customersApi).toContain('sep.push("review_requests_opt_out = ")');
  expect(customersApi).not.toContain("opt_out_podium_contact");
  expect(podiumLogic).not.toContain("campaigns/opt_out");
});

test("Podium inbox keeps webhook and history status truthful", () => {
  const historyFetcher = podiumLogic.slice(
    podiumLogic.indexOf("pub async fn fetch_podium_conversation_messages"),
    podiumLogic.indexOf("pub async fn fetch_podium_review_invites"),
  );

  expect(podiumWebhookApi).toContain('"/metadata/event_type"');
  expect(podiumWebhook).toContain('"/metadata/event_uid"');
  expect(historyFetcher).toContain('request.query(&[("cursor", cursor)])');
  expect(historyFetcher).not.toContain('request.query(&[("limit"');
  expect(podiumMessaging).toContain("last_synced_at = CASE");
  expect(podiumMessaging).toContain(
    "EXCLUDED.last_message_at > podium_conversation.last_message_at",
  );
  expect(podiumMessaging).toContain("THEN NULL");
  expect(podiumMessaging).toContain("mark_conversation_synced");
  expect(podiumInbox).toContain("incomplete_history_count");
  expect(podiumInbox).toContain("PROVIDER_PULL_STALE_MS = 30 * 60 * 1000");
  expect(podiumInbox).toContain("Riverside did not mark the pull complete");
  expect(podiumInbox).toContain("ROS webhook receiving");
  expect(podiumInbox).toContain("failed_webhook_delivery_count");
  expect(podiumInbox).toContain("Processing current");
  expect(podiumInbox).toContain("Last complete history pull");
  expect(podiumInbox).toContain("historyIncomplete || providerPullStale");
  expect(podiumInbox).not.toContain(
    "health.incomplete_history_count > 0 ||\n        isOlderThan",
  );
});

test("Podium inbox treats an active history pull as progress, not an alert", () => {
  expect(podiumInbox).toContain("const historyNeedsAttention =");
  expect(podiumInbox).toContain(
    "!syncBusy && Boolean(syncIssue || historyIncomplete)",
  );
  expect(podiumInbox).toContain(
    "activeWebhookFailure || historyNeedsAttention || callEventsMissing",
  );
  expect(podiumInbox).toContain(
    'syncBusy\n                    ? "bg-app-info/10 text-app-info"',
  );
  expect(podiumInbox).toContain('? "Pulling history"');
});

test("Podium inbox keeps unknown senders in the regular conversation flow", () => {
  expect(podiumMessaging).toContain("pub customer_id: Option<Uuid>");
  expect(podiumMessaging).toContain("LEFT JOIN customers c ON c.id = pc.customer_id");
  expect(podiumMessaging).toContain("list_messages_for_conversation");
  expect(podiumMessaging).toContain(
    "customer_id = COALESCE(podium_conversation.customer_id, EXCLUDED.customer_id)",
  );
  expect(customersApi).toContain(
    '"/podium/conversations/{conversation_id}/messages"',
  );
  expect(customersApi).toContain("post_podium_conversation_reply");
  expect(podiumMessaging).toContain("podium_conversation_reply_target");
  expect(podiumInbound).toContain(
    "Storing Podium message without adding or choosing a Riverside customer",
  );
  expect(podiumInbound).not.toContain('first_name: "New".into()');
  expect(podiumInbox).toContain(
    'return row.contact_identifier?.trim() || "Unknown sender"',
  );
  expect(podiumInbox).toContain("Match Customer");
  expect(podiumInbox).toContain("Add Customer");
  expect(podiumInbox).toContain("<AddCustomerDrawer");
  expect(podiumInbox).toContain("Reply here now, or match/add the customer");
  expect(podiumInbox).toContain("attachment_png_base64");
  expect(podiumInbox).toContain("MESSAGE_EMOJI_CHOICES");
  expect(podiumInbox).not.toContain("Unknown Podium senders");
  expect(podiumInbox).not.toContain("if (!selectedRow?.customer_id) return");
});

test("Podium reply surfaces stay rich without duplicating message history", () => {
  expect(podiumInbox).toContain("Pickup update");
  expect(podiumInbox).toContain("Image");
  expect(podiumInbox).toContain("Emoji");
  expect(podiumInbox).not.toContain(
    "Podium Inbox · Messages, calls, and linked reviews",
  );
  expect(customerRelationshipHub).toContain(
    "Text, call, and email history for",
  );
  expect(customerRelationshipHub).not.toContain("Communication timeline");
});

test("Podium inbox maps staff identity and supports shared conversation triage", () => {
  expect(customersApi).toContain('"/podium/conversations/read-state"');
  expect(customersApi).toContain('"/podium/conversations/closed-state"');
  expect(podiumMessaging).toContain("provider_uid_for_conversation");
  expect(podiumMessaging).toContain("podium_user_uid = ANY($1)");
  expect(podiumMessaging).toContain("set_conversations_read_state");
  expect(podiumLogic).toContain("podium_conversation_closed_payload");
  expect(podiumInbox).toContain("Mark unread");
  expect(podiumInbox).toContain("Select visible");
  expect(podiumInbox).toContain('<option value="closed">Closed</option>');
  expect(podiumInbox).toContain("Linked Podium Staff Member");
  expect(staffEditDrawer).toContain("Linked Podium Staff Member");
  expect(staffEditDrawer).not.toContain("{name} ({u.uid})");
  expect(staffProfile).toContain("A manager connects Podium identities");
  expect(staffProfile).not.toContain('placeholder="senderUid from Podium"');
});

test("Podium background refresh does not reload the open message thread", () => {
  expect(podiumInbox).toContain("if (!selectedConversationId)");
  expect(podiumInbox).toContain(
    "encodeURIComponent(selectedConversationId)",
  );
  expect(podiumInbox).toContain("}, [apiAuth, selectedConversationId]);");
  expect(podiumInbox).not.toContain("}, [apiAuth, selectedRow]);");
});

test("Podium inbox assigns conversations only to linked staff without sending a reply", () => {
  expect(customersApi).toContain('"/podium/assignment-staff"');
  expect(customersApi).toContain("assignment_staff_by_id");
  expect(podiumMessaging).toContain("pub async fn list_assignment_staff");
  expect(podiumMessaging).toContain("NULLIF(TRIM(podium_user_uid), '') IS NOT NULL");
  expect(podiumInbox).toContain("Assigned to");
  expect(podiumInbox).toContain('method: "PATCH"');
  expect(podiumInbox).toContain("body: JSON.stringify({ staff_id:");
  expect(podiumInbox).toContain("Saving assignment...");
  expect(podiumInbox).toContain(
    "}, [apiAuth, lastLoadedAt, selectedConversationId]);",
  );
  expect(podiumInbox).not.toContain("Saves immediately without sending a reply");
});

test("Podium inbox remembers a PIN-verified responder per conversation", () => {
  expect(customersApi).toContain(
    '"/podium/conversations/{conversation_id}/responder"',
  );
  expect(customersApi).toContain("authenticate_staff_by_id");
  expect(customersApi).toContain("body.conversation_id");
  expect(customersApi).toContain("resolve_podium_reply_actor");
  expect(podiumMessaging).toContain("remember_conversation_responder");
  expect(podiumMessaging).toContain(
    "NULLIF(TRIM(responder.podium_user_uid), '') IS NOT NULL",
  );
  expect(podiumLogic).toContain('data["senderName"] = json!(sender_name)');
  expect(podiumInbox).toContain("Replying as");
  expect(podiumInbox).toContain(
    "const responderOptions = assignmentRoster.map",
  );
  expect(podiumInbox).not.toContain("/api/staff/list-for-pos");
  expect(podiumInbox).toContain("Access PIN only when changing");
  expect(podiumResponderModal).toContain("Future replies in this conversation");
  expect(podiumResponderModal).toContain("<NumericPinKeypad");
  expect(podiumResponderMigration).toContain("responder_staff_id");
  expect(podiumResponderMigration).toContain("responder_verified_at");
});

test("Podium call webhooks appear as durable conversation activity", () => {
  for (const eventType of [
    "call.received",
    "call.completed",
    "call.missed",
    "call.voicemail_left",
  ]) {
    expect(podiumLogic).toContain(`"${eventType}"`);
    expect(podiumCallMigration).toContain(`'${eventType}'`);
  }
  expect(podiumWebhook).toContain("podium_calls::apply_call_webhook");
  expect(podiumCalls).toContain("raw_payload");
  expect(podiumCalls).toContain("list_call_events_for_conversation");
  expect(customersApi).toContain(
    '"/podium/conversations/{conversation_id}/calls"',
  );
  expect(podiumMessaging).toContain("podium_call_event unread_call");
  expect(podiumMessaging).toContain("latest_activity.kind AS latest_activity_kind");
  expect(podiumInbox).toContain('return "Call"');
  expect(podiumInbox).toContain("local_call_event_count");
  expect(podiumInbox).toContain('"--app-accent": "var(--app-info)"');
  expect(podiumInbox).toContain("Voicemail received");
  expect(podiumInbox).toContain('kind: "call"');
});

test("Podium review lifecycle appears in Operations and linked Inbox conversations", () => {
  for (const eventType of [
    "review.created",
    "review.updated",
    "review.response_created",
    "review.response_updated",
  ]) {
    expect(podiumLogic).toContain(`"${eventType}"`);
    expect(podiumReviewActivityMigration).toContain(`'${eventType}'`);
  }
  expect(podiumWebhook).toContain(
    "podium_review_activity::apply_review_webhook",
  );
  expect(podiumReviewActivity).toContain("reviewInvitationUid");
  expect(podiumReviewActivity).toContain("needs_response");
  expect(reviewsApi).toContain('"/provider-reviews"');
  expect(customersApi).toContain(
    '"/podium/conversations/{conversation_id}/reviews"',
  );
  expect(podiumMessaging).toContain("podium_review unread_review");
  expect(reviewsOperations).toContain("Published Reviews");
  expect(reviewsOperations).toContain("Needs response");
  expect(podiumInbox).toContain("Riverside response:");
  expect(podiumInbox).toContain("No messages, calls, or reviews loaded");
});

test("Podium contact reconciliation is backgrounded, observable, and avoids redundant work", () => {
  const contactFetcher = podiumLogic.slice(
    podiumLogic.indexOf("pub async fn fetch_all_podium_contacts"),
    podiumLogic.indexOf("pub async fn send_podium_phone_message"),
  );

  expect(contactFetcher).toContain('query(&[("limit", 100_u8)])');
  expect(contactFetcher).toContain('request.query(&[("cursor", cursor)])');
  expect(customersApi).toContain('"/podium/contact-sync-overview"');
  expect(customersApi).toContain("begin_contact_reconciliation");
  expect(customersApi).toContain("StatusCode::ACCEPTED");
  expect(podiumContacts).toContain("pub async fn contact_sync_overview");
  expect(podiumContacts).toContain("ProviderNameSource::DisplayName");
  expect(podiumContacts).toContain("Established Riverside name preserved");
  expect(podiumCustomerNameRepairMigration).toContain(
    "repair_truncated_rms_customer_name",
  );
  expect(podiumCustomerNameRepairMigration).toContain(
    "COUNT(DISTINCT UPPER(rms_last_name)) = 1",
  );
  expect(podiumContacts).toContain(
    "state.customer_id IS NULL OR state.status = 'failed'",
  );
  expect(podiumContacts).toContain("if created || updated");
  expect(podiumContacts).not.toContain(
    "transactional_sms_opt_in = FALSE,\n            updated_at = NOW()",
  );
  expect(panel).toContain("Reconciliation Running");
  expect(panel).toContain("Needs first sync");
  expect(panel).toContain("You can leave this page while it runs");
});
