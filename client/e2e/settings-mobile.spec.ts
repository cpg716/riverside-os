import { expect, test, type Page } from "@playwright/test";
import {
  ensureMainNavigationVisible,
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

type SettingsDeepLinkCase = {
  section: string;
  title: string;
  expected: RegExp;
};

const SETTINGS_ORDER = [
  "Store Setup",
  "Settings Hub",
  "Profile",
  "General",
  "Staff Access Defaults",
  "Online Store",
  "Register Setup",
  "Printers & Scanners",
  "Receipt Settings",
  "Tag Designer",
  "Terminal Overrides",
  "Maintenance",
  "Data & Backups",
  "Remote Access",
  "Integrations",
  "Integrations Overview",
  "Podium",
  "Shippo",
  "System & Support",
  "Help Center",
  "ROS Dev Center",
];

const SETTINGS_DEEP_LINKS: SettingsDeepLinkCase[] = [
  {
    section: "register",
    title: "Open Terminal Overrides",
    expected: /Terminal Overrides/i,
  },
  {
    section: "tag-designer",
    title: "Open Tag Designer",
    expected: /Inventory tag layouts/i,
  },
  {
    section: "shippo",
    title: "Open Shippo",
    expected: /Shipping Configuration/i,
  },
  {
    section: "ros-dev-center",
    title: "Open Support Center",
    expected: /Support Center/i,
  },
];

async function openSettings(page: Page) {
  await signInToBackOffice(page);
  await openBackofficeSidebarTab(page, "settings");
  await expect(page.getByTestId("settings-workspace-content")).toBeVisible({
    timeout: 20_000,
  });
  return ensureMainNavigationVisible(page);
}

async function mockSettingsNotification(page: Page, linkCase: SettingsDeepLinkCase) {
  await page.route("**/api/notifications/unread-count", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ unread: 1, podium_inbox_unread: 0 }),
    });
  });
  await page.route("**/api/notifications?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          staff_notification_id: `settings-${linkCase.section}`,
          notification_id: `settings-notification-${linkCase.section}`,
          created_at: new Date().toISOString(),
          kind: "settings_deep_link",
          title: linkCase.title,
          body: `Open Settings ${linkCase.section}`,
          deep_link: { type: "settings", section: linkCase.section },
          source: "e2e",
          read_at: null,
          completed_at: null,
          archived_at: null,
        },
      ]),
    });
  });
  await page.route("**/api/notifications/*/read", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

function expectTextOrder(text: string, labels: string[]) {
  let cursor = -1;
  for (const label of labels) {
    const index = text.indexOf(label, cursor + 1);
    expect(index, `${label} should appear after ${labels[Math.max(0, labels.indexOf(label) - 1)]}`).toBeGreaterThan(cursor);
    cursor = index;
  }
}

test("Settings sidebar groups stay visible and ordered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mainNav = await openSettings(page);

  for (const group of [
    "Store Setup",
    "Register Setup",
    "Maintenance",
    "Integrations",
    "System & Support",
  ]) {
    await expect(mainNav.getByText(group, { exact: true })).toBeVisible();
  }

  for (const section of [
    "Settings Hub",
    "Profile",
    "Online Store",
    "Printers & Scanners",
    "Tag Designer",
    "Terminal Overrides",
    "Data & Backups",
    "Integrations Overview",
    "Shippo",
    "ROS Dev Center",
  ]) {
    await expect(mainNav.getByRole("button", { name: section, exact: true })).toBeVisible();
  }

  const navText = (await mainNav.textContent()) ?? "";
  expectTextOrder(navText.replace(/\s+/g, " "), SETTINGS_ORDER);
});

for (const linkCase of SETTINGS_DEEP_LINKS) {
  test(`Settings deep link opens ${linkCase.section}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockSettingsNotification(page, linkCase);
    await openSettings(page);

    await page.getByRole("button", { name: /Notifications/i }).click();
    await page
      .getByRole("button", { name: new RegExp(`${linkCase.title}.*Open Settings`, "i") })
      .click();

    const workspace = page.getByTestId("settings-workspace-content");
    await expect(workspace.getByText(linkCase.expected).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(workspace.getByRole("heading", { name: /System Settings/i })).toHaveCount(0);
  });
}
