import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("Customer Hub nests quick-look cards below contact details", () => {
  const drawer = repoFile(
    "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
  );

  expect(drawer).toContain(
    'className="order-1 space-y-4" data-testid="customer-profile-details"',
  );
  expect(drawer).toContain('data-testid="customer-profile-quick-look"');
  expect(drawer).toContain(
    'className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"',
  );
  expect(
    drawer.indexOf('data-testid="customer-profile-quick-look"'),
  ).toBeGreaterThan(
    drawer.indexOf('className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3"'),
  );
  expect(
    drawer.indexOf('data-testid="customer-profile-quick-look"'),
  ).toBeLessThan(drawer.indexOf("Register defaults"));
});

test("Customer History groups activity that happened in the same second", () => {
  const drawer = repoFile(
    "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
  );

  expect(drawer).toContain("groupCustomerTimelineEvents(timeline)");
  expect(drawer).toContain('data-testid="customer-history-group"');
  expect(drawer).toContain(
    'group.events.length === 1 ? "activity" : "activities"',
  );
});

test("Customer Hub presents linked Podium calls with messages and in History", () => {
  const drawer = repoFile(
    "client/src/components/customers/CustomerRelationshipHubDrawer.tsx",
  );
  const customerApi = repoFile("server/src/api/customers.rs");
  const podiumCalls = repoFile("server/src/logic/podium_calls.rs");

  expect(drawer).toContain("Text & calls");
  expect(drawer).toContain("/podium/calls");
  expect(drawer).toContain('case "call":');
  expect(customerApi).toContain('"/{customer_id}/podium/calls"');
  expect(customerApi).toContain('kind: "call".to_string()');
  expect(customerApi).toContain('reference_type: Some("podium_call".to_string())');
  expect(podiumCalls).toContain("pub async fn list_call_events_for_customer");
});
