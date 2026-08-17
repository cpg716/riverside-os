import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const repoFile = (path: string) =>
  readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("staff operations uses live proof and keeps raw diagnostics advanced", async () => {
  const [operationsCenter, bugManager] = await Promise.all([
    repoFile("client/src/components/operations/RosOperationsCenter.tsx"),
    repoFile("client/src/components/settings/BugReportsSettingsPanel.tsx"),
  ]);

  expect(operationsCenter).toContain('fetchReadiness(headers)');
  expect(operationsCenter).toContain('"/api/sessions/list-open"');
  expect(operationsCenter).toContain('data-testid="operations-today-action-summary"');
  expect(operationsCenter).toContain("Advanced Diagnostics");
  expect(operationsCenter).toContain("Routine staff corrections");
  expect(bugManager).toContain("Automated diagnostics");
  expect(bugManager).toContain("Similar events are grouped into one row");
  expect(bugManager).toContain(`"enter the customer's email address"`);
  expect(bugManager).toMatch(/eventTriageFilter[\s\S]*ErrorEventTriage[\s\S]*\("action"\)/);
});

test("desktop handoffs and workstation identity have safe fallbacks", async () => {
  const [quickBooks, desktopBridge, stationIdentity] = await Promise.all([
    repoFile("client/src/components/settings/QuickBooksSettingsPanel.tsx"),
    repoFile("client/src/lib/desktopFileBridge.ts"),
    repoFile("client/src/lib/stationIdentity.ts"),
  ]);

  expect(quickBooks).toContain("await openExternalUrl(body.authorize_url)");
  expect(quickBooks).not.toContain("window.open(body.authorize_url");
  expect(desktopBridge).toContain("if (!opened)");
  expect(desktopBridge).toContain("window.location.assign(url)");
  expect(stationIdentity).toContain("Riverside Workstation ${stationSuffix}");
  expect(stationIdentity).not.toContain('return hostname && hostname !== "tauri.localhost" ? hostname : "Riverside Station"');
});

test("staff bulk customer assignments use reviewed bounded server batches", async () => {
  const [customersWorkspace, customersApi, weddingsApi] = await Promise.all([
    repoFile("client/src/components/customers/CustomersWorkspace.tsx"),
    repoFile("server/src/api/customers.rs"),
    repoFile("server/src/api/weddings.rs"),
  ]);

  expect(customersWorkspace).toContain("Confirm wedding assignment");
  expect(customersWorkspace).toContain("Confirm group assignment");
  expect(customersWorkspace).toContain("/members/bulk-link");
  expect(customersWorkspace).toContain("/group-members/bulk");
  expect(customersApi).toContain('"/group-members/bulk"');
  expect(customersApi).toContain("select between 1 and 100 customers");
  expect(weddingsApi).toContain('"/parties/{party_id}/members/bulk-link"');
  expect(weddingsApi).toContain("reviewed customer batch");
});
