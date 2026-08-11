import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const mailboxWorkspace = repoFile(
  "client/src/components/operations/MailboxOperationsSection.tsx",
);
const mailboxApi = repoFile("server/src/api/mailbox.rs");
const mailboxLogic = repoFile("server/src/logic/email.rs");
const notificationsApi = repoFile("server/src/api/notifications.rs");
const notificationsLogic = repoFile("server/src/logic/notifications.rs");
const podiumLogic = repoFile("server/src/logic/podium_messaging.rs");
const posShell = repoFile("client/src/components/layout/PosShell.tsx");
const posSidebar = repoFile("client/src/components/pos/PosSidebar.tsx");
const mailboxStateMigration = repoFile(
  "migrations/191_mailbox_read_and_trash.sql",
);

test("Mailbox exposes familiar conversation and bulk triage actions", () => {
  expect(mailboxWorkspace).toContain('label: "Inbox"');
  expect(mailboxWorkspace).toContain('label: "Trash"');
  expect(mailboxWorkspace).toContain(
    'Mark {selectedThreadHasUnread ? "read" : "unread"}',
  );
  expect(mailboxWorkspace).toContain("Selected conversations archived.");
  expect(mailboxWorkspace).toContain('title="Move email to Trash?"');
  expect(mailboxWorkspace).toContain('confirmLabel="Move to Trash"');
  expect(mailboxWorkspace).toContain("Conversation restored to Inbox.");
  expect(mailboxWorkspace).toContain("New email");
  expect(mailboxWorkspace).toContain("Reply");
  expect(mailboxWorkspace).toContain("Forward");
});

test("Opening mail persists read state and bulk state is permission guarded", () => {
  expect(mailboxWorkspace).toContain('`${baseUrl}/api/mailbox/bulk-state`');
  expect(mailboxWorkspace).toContain("row.direction === \"inbound\" && !row.is_read");
  expect(mailboxWorkspace).toContain("{ is_read: true }");
  expect(mailboxApi).toContain('.route("/bulk-state", post(patch_message_states))');
  expect(mailboxApi).toContain("require_perm(&state, &headers, CUSTOMERS_HUB_EDIT)");
  expect(mailboxApi).toContain("ids.len() > 200");
  expect(mailboxLogic).toContain("update_mailbox_message_states");
  expect(mailboxLogic).toContain('"ARCHIVED" | "TRASH"');
  expect(mailboxStateMigration).toContain("ADD COLUMN is_read BOOLEAN NOT NULL DEFAULT false");
  expect(mailboxStateMigration).toContain("SET is_read = true");
});

test("Mailbox is available in POS and its badge uses authoritative unread mail", () => {
  expect(posSidebar).toContain('{ id: "mailbox", label: "Mailbox"');
  expect(posShell).toContain('activePosTab === "mailbox"');
  expect(posShell).toContain("<MailboxOperationsSection");
  expect(mailboxLogic).toContain("pub async fn unread_mailbox_count");
  expect(notificationsApi).toContain('"mailbox_unread": mailbox');
  expect(mailboxWorkspace).toContain("await refreshNavigationCounts?.()");
});

test("New inbound bundle items reopen reviewed staff notifications", () => {
  expect(notificationsLogic).toContain("A new item makes the shared bundle actionable again");
  expect(notificationsLogic).toContain("SET read_at = NULL");
  expect(notificationsLogic).toContain("archived_at = NULL");
});

test("Podium unread state counts inbound customer messages, not staff replies", () => {
  expect(podiumLogic).toContain("pub async fn unread_messaging_inbox_count");
  expect(podiumLogic).toContain("unread_message.direction = 'inbound'");
  expect(podiumLogic).toContain("unread_message.created_at > COALESCE(pc.last_viewed_at");
});

test("Formatted email uses a scriptless contained viewer", () => {
  expect(mailboxWorkspace).toContain(
    'sandbox="allow-popups allow-popups-to-escape-sandbox"',
  );
  expect(mailboxWorkspace).toContain("srcDoc={safeEmailDocument(");
  expect(mailboxWorkspace).toContain("script,iframe,object,embed,form,input,button");
  expect(mailboxWorkspace).toContain("form-action 'none'");
  expect(mailboxWorkspace).toContain('referrerPolicy="no-referrer"');
  expect(mailboxWorkspace).toContain('target", "_blank"');
  expect(mailboxWorkspace).not.toContain("dangerouslySetInnerHTML");
  expect(mailboxWorkspace).not.toContain('sandbox="allow-scripts');
});
