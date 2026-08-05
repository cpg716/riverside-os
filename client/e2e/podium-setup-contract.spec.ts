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
const settingsApi = repoFile("server/src/api/settings.rs");

test("Podium setup is guided and authorization is prerequisite-gated", () => {
  expect(panel).toContain("Connect Podium in 3 steps");
  expect(panel).toContain("Open Podium Developer Portal");
  expect(panel).toContain("Copy callback");
  expect(panel).toContain("!appCredentialsReady || !callbackReady");
  expect(panel).toContain("Advanced and incoming-message setup");
  expect(settingsApi).toContain("client_id_configured");
  expect(settingsApi).toContain("client_secret_configured");
});

test("Podium callback shows the provider exchange error", () => {
  expect(callback).toContain("`Podium connection failed: ${j.error}`");
});
