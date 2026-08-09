import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const serverMain = repoFile("server/src/main.rs");
const customersApi = repoFile("server/src/api/customers.rs");
const opsDevCenter = repoFile("server/src/logic/ops_dev_center.rs");
const settingsApi = repoFile("server/src/api/settings.rs");
const credentialsCard = repoFile(
  "client/src/components/settings/IntegrationCredentialsCard.tsx",
);
const meilisearchManual = repoFile(
  "client/src/assets/docs/settings-meilisearch-settings-panel-manual.md",
);

test("installed Main Hub environment overrides inherited task values", () => {
  expect(serverMain).toContain("load_runtime_environment_from");
  expect(serverMain).toContain("from_path_override(installed_env_path)");
  expect(serverMain).toContain("installed_env_overrides_inherited_process_values");
});

test("Geoapify failures are bounded and logged without provider error contents", () => {
  const lookupFailure = customersApi
    .split("let res = match res {")[1]
    ?.split("if !res.status().is_success()")?.[0];

  expect(customersApi).toContain("Duration::from_secs(10)");
  expect(customersApi).toContain(".timeout(ADDRESS_LOOKUP_REQUEST_TIMEOUT)");
  expect(lookupFailure).toContain("error_kind");
  expect(lookupFailure).not.toContain("error = %error");
});

test("audit probes do not classify alteration service pricing as discount evidence", () => {
  const discountProbe = opsDevCenter
    .split('"discount_missing_override_evidence"')[1]
    ?.split('"discount_usage_missing"')?.[0];

  expect(discountProbe).toContain("alteration_service");
});

test("Meilisearch credential changes truthfully require a Main Hub restart", () => {
  expect(settingsApi).toContain("integration_credentials_activation_message");
  expect(settingsApi).toContain("restart_required");
  expect(settingsApi).toContain("Restart Main Hub to activate");
  expect(credentialsCard).toContain("Main Hub restart required");
  expect(credentialsCard).toContain('nextStatus.restart_required ? "warning" : "success"');
  expect(meilisearchManual).toContain("do not treat a successful save or health check as full activation");
});
