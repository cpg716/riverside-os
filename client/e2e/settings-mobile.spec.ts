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

const SETTINGS_GROUPS = [
  {
    label: "Store & Staff",
    sections: [
      "Profile",
      "Staff Access Defaults",
      "Online Store",
      "Customer Reviews",
    ],
  },
  {
    label: "Register & Printing",
    sections: [
      "Printers & Scanners",
      "Receipt Settings",
      "Tag Designer",
      "Terminal Overrides",
      "Station & Network",
    ],
  },
  {
    label: "Data & Maintenance",
    sections: ["Data & Backups", "Daily Financial Report"],
  },
  {
    label: "Connected Services",
    sections: [
      "Podium",
      "Email",
      "Shippo",
      "Helcim",
      "Fal.ai",
      "QuickBooks",
      "Constant Contact",
      "Counterpoint",
      "NuORDER",
      "Geoapify",
      "Weather",
      "Insights",
      "Meilisearch",
    ],
  },
  {
    label: "Help & System",
    sections: [
      "Remote Access",
      "Help Center",
      "ROSIE",
      "ROS Operations & Support Center",
      "ROS Dev Center",
    ],
  },
];

const SETTINGS_ORDER = [
  "Settings Hub",
  ...SETTINGS_GROUPS.flatMap((group) => [group.label, ...group.sections]),
];

const SETTINGS_DEEP_LINKS: SettingsDeepLinkCase[] = [
  {
    section: "register",
    title: "Open Terminal Overrides",
    expected: /Register Settings/i,
  },
  {
    section: "tag-designer",
    title: "Open Tag Designer",
    expected: /Price tag builder/i,
  },
  {
    section: "shippo",
    title: "Open Shippo",
    expected: /Shipping Configuration/i,
  },
  {
    section: "ros-dev-center",
    title: "Open Dev Center",
    expected: /Dev Center/i,
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

test("Settings sidebar groups stay compact, complete, and ordered", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mainNav = await openSettings(page);

  await expect(
    mainNav.getByRole("button", { name: "Settings Hub", exact: true }),
  ).toBeVisible();
  const settingsNav = mainNav.getByTestId("sidebar-nav-group-settings");

  for (const group of SETTINGS_GROUPS) {
    const groupButton = settingsNav.getByRole("button", {
      name: new RegExp(`^${group.label}`),
    });
    await expect(groupButton).toBeVisible();
    await expect(groupButton).toHaveAttribute("aria-expanded", "false");
    await groupButton.click();
    await expect(groupButton).toHaveAttribute("aria-expanded", "true");

    for (const section of group.sections) {
      await expect(
        settingsNav.getByRole("button", { name: section, exact: true }),
      ).toBeVisible();
    }
  }

  const navText = `Settings Hub ${(await settingsNav.textContent()) ?? ""}`;
  expectTextOrder(navText.replace(/\s+/g, " "), SETTINGS_ORDER);
});

test("Settings Hub category flow and search open the matching setting", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSettings(page);

  const settingsHub = page.getByTestId("settings-workspace-content");
  const categoryNav = settingsHub.getByRole("navigation", {
    name: "Settings categories",
  });
  await expect(
    categoryNav.getByRole("button", { name: /^Store & Staff/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    settingsHub.getByRole("button", { name: /^Online Store/ }),
  ).toBeVisible();
  await expect(
    settingsHub.getByRole("button", { name: /^Podium/ }),
  ).toHaveCount(0);

  await categoryNav
    .getByRole("button", { name: /^Connected Services/ })
    .click();
  await expect(
    settingsHub.getByRole("button", { name: /^Podium/ }),
  ).toBeVisible();
  await expect(
    settingsHub.getByRole("button", { name: /^Online Store/ }),
  ).toHaveCount(0);

  await settingsHub
    .getByRole("searchbox", { name: "Search settings" })
    .fill("receipt");
  await expect(
    settingsHub.getByRole("button", { name: /Receipt Settings/ }),
  ).toBeVisible();
  await expect(
    settingsHub.getByRole("button", { name: /^Profile/ }),
  ).toHaveCount(0);

  await settingsHub.getByRole("button", { name: /Receipt Settings/ }).click();
  await expect(
    page.getByRole("heading", { name: "Receipt Settings" }),
  ).toBeVisible({ timeout: 20_000 });
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
