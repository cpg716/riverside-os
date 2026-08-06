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
