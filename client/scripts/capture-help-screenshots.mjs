#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request as playwrightRequest } from "playwright";
import { HELP_SCREENSHOT_SPECS } from "./help-screenshot-specs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(CLIENT_ROOT, "..");
const SESSION_KEY = "ros.backoffice.session.v1";

function usage() {
  console.log(`Usage: node scripts/capture-help-screenshots.mjs [options]

Options:
  --base-url <url>      Browser base URL (default: E2E_BASE_URL or http://localhost:43173)
  --api-base <url>      API base URL (default: E2E_API_BASE or http://127.0.0.1:43300)
  --target <id>         Capture only one target (repeatable)
  --list                List available targets and exit
  --headed              Run Chromium headed
  --staff-code <code>   Admin staff code (default: E2E_BO_STAFF_CODE or 1234)
  --staff-pin <pin>     Admin staff pin (default: E2E_BO_STAFF_PIN or 1234)
`);
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: process.env.E2E_BASE_URL?.trim() || "http://localhost:43173",
    apiBase: process.env.E2E_API_BASE?.trim() || "http://127.0.0.1:43300",
    headed: false,
    list: false,
    targets: [],
    staffCode: process.env.E2E_BO_STAFF_CODE?.trim() || "1234",
    staffPin: process.env.E2E_BO_STAFF_PIN?.trim() || "1234",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--headed") {
      parsed.headed = true;
      continue;
    }
    if (arg === "--base-url" && argv[i + 1]) {
      parsed.baseUrl = argv[++i];
      continue;
    }
    if (arg === "--api-base" && argv[i + 1]) {
      parsed.apiBase = argv[++i];
      continue;
    }
    if (arg === "--target" && argv[i + 1]) {
      parsed.targets.push(argv[++i]);
      continue;
    }
    if (arg === "--staff-code" && argv[i + 1]) {
      parsed.staffCode = argv[++i];
      continue;
    }
    if (arg === "--staff-pin" && argv[i + 1]) {
      parsed.staffPin = argv[++i];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function absOutput(relPath) {
  return path.join(REPO_ROOT, relPath);
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function normalizeUrl(url) {
  return url.replace(/\/$/, "");
}

async function waitForApp(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const signInHeading = page.getByRole("heading", { name: /^sign in$/i });
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });
  for (let i = 0; i < 40; i += 1) {
    if (await signInHeading.isVisible().catch(() => false)) return;
    if (await mainNav.isVisible().catch(() => false)) return;
    if (await posNav.isVisible().catch(() => false)) return;
    await page.waitForTimeout(500);
  }
}

async function waitForBackofficeShellReady(page, message) {
  const mainNav = page.getByRole("navigation", { name: "Main Navigation" });
  for (let i = 0; i < 60; i += 1) {
    if (
      (await page.getByRole("heading", { name: /operations overview/i }).isVisible().catch(() => false)) ||
      (await page.getByRole("navigation", { name: "POS Navigation" }).isVisible().catch(() => false)) ||
      (await mainNav.isVisible().catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(message);
}

async function selectBackofficeStaffMember(page) {
  const preferredName = process.env.E2E_BO_STAFF_NAME?.trim() || "Chris G";
  const selectorButton = page.getByTestId("staff-selector-button");
  await selectorButton.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if (!(await selectorButton.isVisible().catch(() => false))) {
    return;
  }
  if ((await selectorButton.textContent().catch(() => "")).match(new RegExp(preferredName, "i"))) {
    return;
  }
  await selectorButton.click();
  const preferredOption = page.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });
  await preferredOption.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
    return;
  }
  const dropdown = page.getByTestId("staff-selector-dropdown");
  const firstIdentity = dropdown.getByTestId("staff-identity-selector-1");
  await firstIdentity.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  if (await firstIdentity.isVisible().catch(() => false)) {
    await firstIdentity.click();
  }
}

async function signInToBackOffice(page, { staffCode }) {
  const signInHeading = page.getByRole("heading", { name: /^sign in$/i });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/loading riverside/i).waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});

  if (!(await signInHeading.isVisible().catch(() => false))) {
    await waitForBackofficeShellReady(page, "Back Office shell never stabilized after session reset");
    return;
  }
  await selectBackofficeStaffMember(page);

  for (const digit of staffCode) {
    await page.getByTestId(`pin-key-${digit}`).click();
  }
  await signInHeading.waitFor({ state: "hidden", timeout: 20000 });
  await waitForBackofficeShellReady(page, "Back Office shell never finished bootstrap after sign-in");
}

async function ensureMainNavigationVisible(page) {
  const nav = page.getByRole("navigation", { name: "Main Navigation" });
  if (await nav.isVisible().catch(() => false)) {
    return nav;
  }
  await page.waitForTimeout(1000);
  if (await nav.isVisible().catch(() => false)) {
    return nav;
  }
  const toggle = page.getByRole("button", { name: /toggle menu/i });
  if (await toggle.isVisible().catch(() => false)) {
    await toggle.click();
  }
  await nav.waitFor({ state: "visible", timeout: 30000 });
  return nav;
}

async function openBackofficeSidebarTab(page, tabPattern) {
  await page.keyboard.press("Escape").catch(() => {});
  await waitForOverlayBackdropsHidden(page).catch(() => {});
  const nav = await ensureMainNavigationVisible(page);
  const exactId = tabPattern.source.match(/^\^([a-z-]+)\$$/i)?.[1];
  if (exactId) {
    const testId = exactId === "pos" ? "register" : exactId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const testIdButton = page.getByTestId(`sidebar-nav-${testId}`);
      await testIdButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      if (await testIdButton.isVisible().catch(() => false)) {
        await testIdButton.scrollIntoViewIfNeeded().catch(() => {});
        try {
          await testIdButton.click({ timeout: 10000 });
          return testIdButton;
        } catch (error) {
          if (attempt === 2) throw error;
          await page.waitForTimeout(500);
        }
      }
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentNav = page.getByRole("navigation", { name: "Main Navigation" });
    const button = currentNav.getByRole("button", { name: tabPattern });
    await button.waitFor({ state: "visible", timeout: 15000 });
    await button.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await button.click({ timeout: 10000 });
      return button;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(500);
    }
  }
}

async function openSettingsSection(page, sectionPattern) {
  await openBackofficeSidebarTab(page, /^settings(?:\s+bo)?$/i);
  const nav = await ensureMainNavigationVisible(page);
  const button = nav.getByRole("button", { name: sectionPattern });
  await button.waitFor({ state: "visible", timeout: 20000 });
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click();
}

async function enterPosShell(page) {
  const existingPosNav = page.getByRole("navigation", { name: "POS Navigation" });
  if (await existingPosNav.isVisible().catch(() => false)) {
    return;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const posNav = page.getByRole("navigation", { name: "POS Navigation" });
    if (await posNav.isVisible().catch(() => false)) {
      return;
    }
    const registerNavButton = page.getByTestId("sidebar-nav-register");
    await registerNavButton.waitFor({ state: "visible", timeout: 30000 });
    await registerNavButton.click({ timeout: 10000 });
    const enterButton = page.getByRole("button", { name: /^(enter|return) to pos$/i });
    const posDashboardPlaceholder = page.getByText(/pos-dashboard module coming soon\./i);
    const operationsOverview = page.getByRole("heading", {
      name: /operations overview/i,
    });

    const readLandingState = async () => {
      if (await posNav.isVisible().catch(() => false)) return "nav";
      if (await enterButton.isVisible().catch(() => false)) return "launch";
      if (await posDashboardPlaceholder.isVisible().catch(() => false)) return "placeholder";
      if (await operationsOverview.isVisible().catch(() => false)) return "backoffice";
      return "pending";
    };

    for (let i = 0; i < 20; i += 1) {
      if ((await readLandingState()) !== "pending") {
        break;
      }
      await page.waitForTimeout(500);
    }

    if (await enterButton.isVisible().catch(() => false)) {
      await enterButton.click();
      await posNav.waitFor({ state: "visible", timeout: 20000 });
      return;
    }
    const settledState = await readLandingState();
    if (settledState === "nav") {
      return;
    }
    if (settledState === "backoffice" || settledState === "placeholder") {
      continue;
    }
    await page.waitForTimeout(1000);
  }

  await page.getByRole("navigation", { name: "POS Navigation" }).waitFor({
    timeout: 20000,
  });
}

async function waitForOverlayBackdropsHidden(page, timeout = 15000) {
  const overlays = page.locator(".ui-overlay-backdrop");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const visibleCount = await overlays
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) => {
            const style = window.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return (
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              rect.width > 0 &&
              rect.height > 0
            );
          }).length,
      )
      .catch(() => 0);
    if (visibleCount === 0) {
      return;
    }
    await page.waitForTimeout(250);
  }
}

async function openPosRegisterTabIfNeeded(page) {
  const productSearch = page.getByTestId("pos-product-search");
  const cashierDialog = page.getByTestId("pos-sale-cashier-overlay");
  if (
    (await productSearch.isVisible().catch(() => false)) ||
    (await cashierDialog.isVisible().catch(() => false))
  ) {
    return;
  }

  await waitForOverlayBackdropsHidden(page);
  const registerButton = page.getByTestId("pos-sidebar-tab-register");
  await registerButton.waitFor({ state: "visible", timeout: 15000 });
  const isCurrent = (await registerButton.getAttribute("aria-current").catch(() => null)) === "page";
  if (!isCurrent) {
    await registerButton.click();
  }
}

async function ensurePosRegisterSessionOpen(page, { staffCode }) {
  const registerDialog = page.getByRole("dialog", { name: /open register|riverside register/i });
  const cashDrawerClosedDialog = page.getByRole("dialog", { name: /cash drawer not open yet/i });
  const posNav = page.getByRole("navigation", { name: "POS Navigation" });

  if (!(await posNav.isVisible().catch(() => false))) {
    await enterPosShell(page);
  }

  if (await cashDrawerClosedDialog.isVisible().catch(() => false)) {
    const openMainRegister = cashDrawerClosedDialog.getByRole("button", {
      name: "Open Register #1 (I am at the main terminal)",
    });
    await openMainRegister.waitFor({ state: "visible", timeout: 15000 });
    await openMainRegister.click();
    await registerDialog.waitFor({ state: "visible", timeout: 20000 });
  }

  const dialogVisible = await registerDialog.isVisible().catch(() => false);
  if (!dialogVisible) {
    return;
  }

  const lane = registerDialog.locator("select");
  if ((await lane.count()) === 1) {
    await lane.selectOption("1");
  }
  const floatInput = registerDialog.locator("input[type='number']").first();
  if (await floatInput.isVisible().catch(() => false)) {
    await floatInput.fill("200");
  }
  const pinKey = registerDialog.getByTestId(`pin-key-${staffCode[0]}`);
  if (await pinKey.isVisible().catch(() => false)) {
    for (const digit of staffCode) {
      await registerDialog.getByTestId(`pin-key-${digit}`).click();
    }
  }
  const openRegisterButton = registerDialog.getByRole("button", { name: /^open register$/i });
  if (await openRegisterButton.isVisible().catch(() => false)) {
    await openRegisterButton.click();
  }
  await registerDialog.waitFor({ state: "hidden", timeout: 30000 });
  await waitForOverlayBackdropsHidden(page);
}

async function waitForRegisterCartMounted(page) {
  const cartShell = page.getByTestId("pos-register-cart-shell");
  await cartShell.waitFor({ state: "visible", timeout: 25000 });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if ((await cartShell.getAttribute("data-sale-hydrated").catch(() => null)) === "true") {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("POS register cart did not finish hydrating");
}

async function waitForRegisterReady(page) {
  const cartShell = page.getByTestId("pos-register-cart-shell");
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (
      (await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true" &&
      (await page.getByTestId("pos-product-search").isVisible().catch(() => false)) &&
      (await page.getByTestId("pos-action-gift-card").isVisible().catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("POS register did not become ready after sale cashier sign-in");
}

async function waitForOverlayAttribute(page, locator, name, value, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await locator.getAttribute(name).catch(() => null)) === value) {
      return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(message);
}

async function selectFirstSaleStaffMember(cashierDialog) {
  const page = cashierDialog.page();
  const preferredName = process.env.E2E_BO_STAFF_NAME?.trim() || "Chris G";
  const selectorButton = cashierDialog.getByTestId("staff-selector-button");

  await selectorButton.waitFor({ state: "visible", timeout: 15000 });
  await selectorButton.scrollIntoViewIfNeeded().catch(() => {});

  const currentLabel = ((await selectorButton.textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (currentLabel.match(new RegExp(preferredName, "i"))) {
    return;
  }

  await selectorButton.click();
  const dropdown = page.getByTestId("staff-selector-dropdown");
  await dropdown.waitFor({ state: "visible", timeout: 10000 });

  const preferredOption = dropdown.getByRole("button", {
    name: new RegExp(preferredName, "i"),
  });
  if (await preferredOption.isVisible().catch(() => false)) {
    await preferredOption.click();
  } else {
    const firstIdentity = dropdown.getByTestId("staff-identity-selector-1");
    await firstIdentity.waitFor({ state: "visible", timeout: 5000 });
    await firstIdentity.click();
  }

  await dropdown.waitFor({ state: "hidden", timeout: 10000 });
}

async function ensurePosSaleCashierSignedIn(page, { staffCode }) {
  await waitForRegisterCartMounted(page);

  const cashierDialog = page.getByTestId("pos-sale-cashier-overlay");
  const cartShell = page.getByTestId("pos-register-cart-shell");
  const productSearch = page.getByTestId("pos-product-search");
  const continueButton = cashierDialog.getByTestId("pos-sale-cashier-continue");

  for (let i = 0; i < 40; i += 1) {
    const registerReady = (await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true";
    const cashierDialogVisible = await cashierDialog.isVisible().catch(() => false);
    if (registerReady || cashierDialogVisible) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if ((await cartShell.getAttribute("data-register-ready").catch(() => null)) === "true") {
    return;
  }

  if (
    (await productSearch.isVisible().catch(() => false)) &&
    !(await cashierDialog.isVisible().catch(() => false))
  ) {
    return;
  }

  await waitForOverlayAttribute(
    page,
    cashierDialog,
    "data-roster-ready",
    "true",
    15000,
    "Sale cashier staff roster did not load",
  );
  await selectFirstSaleStaffMember(cashierDialog);
  await waitForOverlayAttribute(
    page,
    cashierDialog,
    "data-pin-entry-ready",
    "true",
    10000,
    "Sale cashier PIN entry did not become ready",
  );

  const firstPinKey = cashierDialog.getByTestId(`pin-key-${staffCode[0]}`);
  await firstPinKey.waitFor({ state: "visible", timeout: 15000 });

  for (const digit of staffCode) {
    await cashierDialog.getByTestId(`pin-key-${digit}`).click();
    await page.waitForTimeout(150);
  }
  for (let i = 0; i < 60; i += 1) {
    if (!(await cashierDialog.isVisible().catch(() => false))) {
      await waitForRegisterReady(page);
      return;
    }
    if (await continueButton.isEnabled().catch(() => false)) {
      await continueButton.click();
      break;
    }
    await page.waitForTimeout(250);
  }
  await cashierDialog.waitFor({ state: "hidden", timeout: 20000 });
  await waitForRegisterReady(page);
}

async function preparePosRegister(page, opts) {
  await prepareBase(page, opts);
  await enterPosShell(page);
  await openPosRegisterTabIfNeeded(page);
  await ensurePosRegisterSessionOpen(page, opts);
  await openPosRegisterTabIfNeeded(page);
  await ensurePosSaleCashierSignedIn(page, opts);
  await page.getByTestId("pos-product-search").waitFor({
    state: "visible",
    timeout: 15000,
  });
}

async function addGiftCardLoadLine(page) {
  await page.getByTestId("pos-action-gift-card").click();
  const dialog = page.getByRole("dialog", { name: /gift card/i });
  await dialog.waitFor({ state: "visible", timeout: 15000 });
  await dialog.getByRole("button", { name: "5", exact: true }).click();
  await dialog.getByRole("button", { name: "0", exact: true }).click();
  await dialog.getByLabel(/card code/i).fill(`HELP-GC-${Date.now()}`);
  await dialog.getByRole("button", { name: /add to cart/i }).click();
  await dialog.waitFor({ state: "hidden", timeout: 15000 });
  await page.getByText(/gift card/i).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
}

async function preparePosRegisterWithPaymentLine(page, opts) {
  await preparePosRegister(page, opts);
  await addGiftCardLoadLine(page);
}

async function openCheckoutDrawer(page) {
  await page.getByTestId("pos-pay-button").click();
  const orderReviewContinue = page.getByRole("button", { name: /continue to payment/i });
  if (await orderReviewContinue.isVisible().catch(() => false)) {
    await orderReviewContinue.click();
  }
  const walkInDialog = page.getByRole("dialog", { name: /checkout as walk-in/i });
  if (await walkInDialog.isVisible().catch(() => false)) {
    await walkInDialog.getByRole("button", { name: /confirm walk-in/i }).click();
  }
  const drawer = page.getByRole("dialog", { name: /checkout/i });
  await drawer.waitFor({ state: "visible", timeout: 20000 });
}

async function addFullCashPayment(page) {
  const drawer = page.getByRole("dialog", { name: /checkout/i });
  await drawer.getByRole("button", { name: /^cash$/i }).click();
  await drawer.getByRole("button", { name: /full balance/i }).click();
  await drawer.getByRole("button", { name: /add payment/i }).click();
  await drawer.getByTestId("pos-finalize-checkout").waitFor({
    state: "visible",
    timeout: 15000,
  });
}

async function completePosSale(page) {
  const drawer = page.getByRole("dialog", { name: /checkout/i });
  await drawer.getByTestId("pos-finalize-checkout").click();
  await page.getByRole("heading", { name: /sale complete/i }).waitFor({
    state: "visible",
    timeout: 30000,
  });
}

async function seedRmsFixture(api, body) {
  const response = await api.post("/api/test-support/rms/seed-fixture", {
    data: body,
  });
  if (!response.ok()) {
    throw new Error(`Failed to seed RMS fixture: ${response.status()} ${await response.text()}`);
  }
  return response.json();
}

async function dismissNotifications(page) {
  const dismissButtons = page.getByRole("button", { name: /dismiss notification/i });
  for (let i = 0; i < 8; i += 1) {
    const count = await dismissButtons.count().catch(() => 0);
    if (count === 0) return;
    await dismissButtons.first().click().catch(() => {});
    await page.waitForTimeout(100);
  }
}

async function capture(page, spec) {
  const out = absOutput(spec.output);
  ensureParentDir(out);
  await dismissNotifications(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: out, fullPage: spec.fullPage === true });
  return out;
}

async function prepareBase(page, opts) {
  await waitForApp(page);
  await signInToBackOffice(page, opts);
}

async function runSpec(page, api, spec, opts) {
  switch (spec.kind) {
    case "help-drawer": {
      await prepareBase(page, opts);
      await page.getByTestId("help-center-trigger").click();
      await page.getByRole("dialog", { name: /help/i }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      const helpDialog = page.getByRole("dialog", { name: /help/i });
      await helpDialog.getByText(/loading manuals/i).waitFor({
        state: "hidden",
        timeout: 20000,
      }).catch(() => {});
      if (spec.modeButton) {
        await page.getByTestId(spec.modeButton).click();
        await page.waitForTimeout(500);
      }
      if (spec.searchQuery) {
        await page.getByTestId("help-center-search").fill(spec.searchQuery);
        await helpDialog.getByText("Results", { exact: true }).waitFor({
          state: "visible",
          timeout: 15000,
        });
        await helpDialog.getByText("Searching…", { exact: true }).waitFor({
          state: "hidden",
          timeout: 15000,
        }).catch(() => {});
      }
      return capture(page, spec);
    }
    case "bug-report-dialog": {
      await prepareBase(page, opts);
      await page.getByTestId("bug-report-trigger").click();
      await page.getByRole("dialog", { name: /report a bug/i }).waitFor({
        state: "visible",
        timeout: 20000,
      });
      await page.getByText(/attach screenshot/i).waitFor({
        state: "visible",
        timeout: 20000,
      });
      return capture(page, spec);
    }
    case "sign-in-gate": {
      await waitForApp(page);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.evaluate((key) => sessionStorage.removeItem(key), SESSION_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: /^sign in$/i }).waitFor({
        state: "visible",
        timeout: 30000,
      });
      return capture(page, spec);
    }
    case "notification-drawer": {
      await prepareBase(page, opts);
      await page.getByRole("button", { name: /^notifications(?:, \d+ unread)?$/i }).click();
      await page.getByText("Communications & Alerts").waitFor({
        state: "visible",
        timeout: 20000,
      });
      await page.getByText(/checking for alerts/i).waitFor({
        state: "hidden",
        timeout: 20000,
      }).catch(() => {});
      return capture(page, spec);
    }
    case "settings-panel": {
      await prepareBase(page, opts);
      await openSettingsSection(page, spec.sectionButton);
      if (spec.sectionButton.test("help center")) {
        await page.getByRole("heading", { name: /help center manager/i }).waitFor({
          state: "visible",
          timeout: 20000,
        });
      } else if (spec.sectionButton.test("rosie")) {
        await page.getByTestId("rosie-settings-panel").waitFor({
          state: "visible",
          timeout: 20000,
        });
      } else {
        await page.waitForTimeout(1200);
      }
      if (spec.tabButton) {
        await page.getByRole("button", { name: spec.tabButton }).first().click();
        await page.waitForTimeout(900);
      }
      return capture(page, spec);
    }
    case "wedding-workspace": {
      await prepareBase(page, opts);
      await openBackofficeSidebarTab(page, /^weddings$/i);
      const partiesTab = page.getByRole("button", { name: /^parties$/i }).first();
      await partiesTab.waitFor({ state: "visible", timeout: 20000 });
      const targetTab = page.getByRole("button", { name: spec.weddingTab }).first();
      await targetTab.click();
      await page.waitForTimeout(1200);
      return capture(page, spec);
    }
    case "pos-dashboard": {
      await prepareBase(page, opts);
      await enterPosShell(page);
      await ensurePosRegisterSessionOpen(page, opts);
      await page.getByRole("navigation", { name: "POS Navigation" }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      return capture(page, spec);
    }
    case "pos-cart-empty": {
      await preparePosRegister(page, opts);
      return capture(page, spec);
    }
    case "pos-cart-with-line": {
      await preparePosRegisterWithPaymentLine(page, opts);
      return capture(page, spec);
    }
    case "pos-checkout-drawer": {
      await preparePosRegisterWithPaymentLine(page, opts);
      await openCheckoutDrawer(page);
      return capture(page, spec);
    }
    case "pos-receipt-summary": {
      await preparePosRegisterWithPaymentLine(page, opts);
      await openCheckoutDrawer(page);
      await addFullCashPayment(page);
      await completePosSale(page);
      return capture(page, spec);
    }
    case "pos-receipt-preview": {
      await preparePosRegisterWithPaymentLine(page, opts);
      await openCheckoutDrawer(page);
      await addFullCashPayment(page);
      await completePosSale(page);
      await page.getByRole("button", { name: /view receipt/i }).click();
      await page.locator('[aria-labelledby="receipt-preview-dialog-title"]').waitFor({
        state: "visible",
        timeout: 20000,
      });
      return capture(page, spec);
    }
    case "pos-exchange-return-wizard": {
      await preparePosRegister(page, opts);
      await page.getByTestId("pos-exchange-wizard-trigger").click();
      await page.getByTestId("pos-exchange-wizard-dialog").waitFor({
        state: "visible",
        timeout: 15000,
      });
      return capture(page, spec);
    }
    case "pos-wedding-lookup": {
      await preparePosRegister(page, opts);
      await page.getByRole("button", { name: /^wedding$/i }).click();
      await page.getByRole("heading", { name: /wedding lookup/i }).waitFor({
        state: "visible",
        timeout: 15000,
      });
      return capture(page, spec);
    }
    case "workspace-tab": {
      await prepareBase(page, opts);
      await openBackofficeSidebarTab(page, new RegExp(`^${spec.tab}$`, "i"));
      if (spec.subSection) {
        const nav = await ensureMainNavigationVisible(page);
        const subSectionAliases = {
          list: "Find Item",
          receiving: "Receive Stock",
          purchase_orders: "Order Stock",
        };
        const subSectionLabel = subSectionAliases[spec.subSection] || spec.subSection;
        const subButton = nav.getByRole("button", { name: new RegExp(`^${subSectionLabel}$`, "i") });
        if (await subButton.isVisible().catch(() => false)) {
          await subButton.click();
        } else {
          // Try finding by the label if the ID/ID-part isn't matching
          const fallback = nav.locator("button").filter({ hasText: new RegExp(spec.subSection.replace(/_/g, " "), "i") });
          if (await fallback.isVisible().catch(() => false)) {
            await fallback.click();
          }
        }
      }
      if (spec.tab === "loyalty") {
        await page.getByText(/loading loyalty workspace/i).waitFor({
          state: "hidden",
          timeout: 25000,
        }).catch(() => {});
      }
      await page.waitForTimeout(1200);
      return capture(page, spec);
    }
    case "reports-loaded": {
      await prepareBase(page, opts);
      await openBackofficeSidebarTab(page, /^reports$/i);
      const card = page.getByTestId(`reports-catalog-card-${spec.reportId}`);
      await card.waitFor({ state: "visible", timeout: 20000 });
      await card.scrollIntoViewIfNeeded().catch(() => {});
      await card.click();
      await page.getByTestId("reports-detail-filters").waitFor({
        state: "visible",
        timeout: 20000,
      });
      await page.waitForTimeout(1200);
      return capture(page, spec);
    }
    default:
      throw new Error(`Unsupported screenshot kind: ${spec.kind}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const spec of HELP_SCREENSHOT_SPECS) {
      console.log(`${spec.id}\t${spec.output}`);
    }
    return;
  }

  const selected = args.targets.length
    ? HELP_SCREENSHOT_SPECS.filter((spec) => args.targets.includes(spec.id))
    : HELP_SCREENSHOT_SPECS;
  // Sign-in captures deliberately clear browser identity. Keep them last so a
  // full refresh cannot strand every later authenticated target at the gate.
  const wanted = [...selected].sort(
    (left, right) => Number(left.kind === "sign-in-gate") - Number(right.kind === "sign-in-gate"),
  );

  if (wanted.length === 0) {
    throw new Error("No matching screenshot targets were selected.");
  }

  const browser = await chromium.launch({
    headless: !args.headed,
  });
  const context = await browser.newContext({
    baseURL: normalizeUrl(args.baseUrl),
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const api = await playwrightRequest.newContext({
    baseURL: normalizeUrl(args.apiBase),
    extraHTTPHeaders: {
      "x-riverside-staff-code": args.staffCode,
      "x-riverside-staff-pin": args.staffPin,
      "Content-Type": "application/json",
    },
  });

  try {
    await seedRmsFixture(api, {
      fixture: "single_valid",
      customer_label: "help-docs",
    }).catch(() => null);

    for (const spec of wanted) {
      const out = await runSpec(page, api, spec, {
        staffCode: args.staffCode,
      });
      console.log(`captured ${spec.id} -> ${path.relative(REPO_ROOT, out)}`);
    }
  } finally {
    await api.dispose();
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
