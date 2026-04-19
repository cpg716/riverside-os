import { defineConfig, devices } from "@playwright/test";

// Env: E2E_BASE_URL, E2E_API_BASE, E2E_STAFF_CODE + E2E_STAFF_PIN (optional HTTP headers),
// E2E_BO_STAFF_CODE (optional; default 1234 for UI keypad sign-in — see e2e/helpers/backofficeSignIn.ts).

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:43173";
const apiBase = process.env.E2E_API_BASE ?? "http://127.0.0.1:43300";
const visualMode = process.env.E2E_RUN_VISUAL === "1";
const isCi = process.env.CI === "true" || process.env.CI === "1";
const autoBootLocalStack = (process.env.E2E_AUTO_BOOT ?? "1") !== "0";
const usingLocalViteBase = /^https?:\/\/localhost:43173\/?$/.test(baseURL);

/** Optional: inject staff headers on every browser request (use the same 4-digit value for code + pin when `pin_hash` is set). */
const e2eStaffCode = process.env.E2E_STAFF_CODE?.trim();
const e2eStaffPin = process.env.E2E_STAFF_PIN?.trim();
const e2eExtraHeaders: Record<string, string> = {};
if (e2eStaffCode) e2eExtraHeaders["x-riverside-staff-code"] = e2eStaffCode;
if (e2eStaffPin) e2eExtraHeaders["x-riverside-staff-pin"] = e2eStaffPin;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: isCi ? 1 : 0,
  reporter: [["list"]],
  webServer:
    !isCi && autoBootLocalStack && usingLocalViteBase
      ? {
          command: `E2E_BASE_URL="${baseURL}" E2E_API_BASE="${apiBase}" bash ../scripts/e2e-local-stack.sh`,
          url: baseURL,
          timeout: 600_000,
          reuseExistingServer: false,
        }
      : undefined,
  use: {
    baseURL,
    trace: visualMode || isCi ? "retain-on-failure" : "on-first-retry",
    screenshot: visualMode ? "on" : "only-on-failure",
    animation: "disabled",
    timezoneId: "UTC",
    locale: "en-US",
    ...(Object.keys(e2eExtraHeaders).length > 0
      ? { extraHTTPHeaders: e2eExtraHeaders }
      : {}),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
