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
