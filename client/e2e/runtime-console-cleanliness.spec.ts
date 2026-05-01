import { expect, test, type Page, type Response } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";
import {
  ensurePosRegisterSessionOpen,
  ensurePosSaleCashierSignedIn,
  enterPosShell,
} from "./helpers/openPosRegister";

type RuntimeIssue = {
  kind: "console" | "api";
  detail: string;
};

function installRuntimeIssueGuard(page: Page) {
  const issues: RuntimeIssue[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    if (
      /Encountered two children with the same key/i.test(text) ||
      /Each child in a list should have a unique/i.test(text) ||
      /Warning: Each child/i.test(text) ||
      /Uncaught|TypeError|ReferenceError|Cannot read properties/i.test(text)
    ) {
      issues.push({ kind: "console", detail: text });
    }
  });

  page.on("response", (response) => {
    if (!isUnexpectedApiFailure(response)) return;
    issues.push({
      kind: "api",
      detail: `${response.status()} ${response.request().method()} ${response.url()}`,
    });
  });

  return {
    issues,
    assertClean(context: string) {
      expect(issues, `${context}\n${issues.map((i) => `${i.kind}: ${i.detail}`).join("\n")}`).toEqual([]);
    },
  };
}

function isUnexpectedApiFailure(response: Response): boolean {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/")) return false;
  const status = response.status();
  if (status < 400) return false;

  if (url.pathname === "/api/sessions/current" && status === 404) {
    return false;
  }

  return true;
}

async function openPosRegisterReady(page: Page) {
  await signInToBackOffice(page);
  await enterPosShell(page);
  await ensurePosRegisterSessionOpen(page);
  await ensurePosSaleCashierSignedIn(page);
  await expect(page.getByTestId("pos-product-search")).toBeVisible({
    timeout: 20_000,
  });
}

async function setBrowserDate(page: Page, isoTimestamp: string) {
  await page.addInitScript((fixedNow) => {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(fixedNow);
        } else {
          super(...args);
        }
      }
      static now() {
        return new RealDate(fixedNow).getTime();
      }
      static parse(value: string) {
        return RealDate.parse(value);
      }
      static UTC(
        year: number,
        monthIndex: number,
        date?: number,
        hours?: number,
        minutes?: number,
        seconds?: number,
        ms?: number,
      ) {
        return RealDate.UTC(year, monthIndex, date ?? 1, hours ?? 0, minutes ?? 0, seconds ?? 0, ms ?? 0);
      }
    }
    window.Date = MockDate as DateConstructor;
  }, isoTimestamp);
}

test.describe("runtime console and API cleanliness", () => {
  test("POS customer-like product search does not fire exact inventory scan 404s", async ({
    page,
  }) => {
    const guard = installRuntimeIssueGuard(page);
    const scanUrls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/inventory/scan/Garcia")) {
        scanUrls.push(request.url());
      }
    });

    await openPosRegisterReady(page);

    await page.getByTestId("pos-product-search").fill("Garcia");
    await page.waitForResponse(
      (response) =>
        response.url().includes("/api/products/control-board") &&
        response.url().includes("search=Garcia"),
      { timeout: 10_000 },
    );

    expect(scanUrls, "Plain customer-name text should not hit exact SKU scan").toEqual([]);
    guard.assertClean("POS search emitted runtime console/API noise");
  });

  test("Customers workspace waits for auth before loading browse data", async ({ page }) => {
    const guard = installRuntimeIssueGuard(page);

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "customers");
    await page.waitForResponse(
      (response) =>
        response.url().includes("/api/customers/browse") &&
        response.request().method() === "GET",
      { timeout: 15_000 },
    );

    guard.assertClean("Customers workspace emitted runtime console/API noise");
  });

  test("Wedding dashboard month picker is stable on month-end dates", async ({ page }) => {
    await setBrowserDate(page, "2026-04-30T16:00:00.000Z");
    const guard = installRuntimeIssueGuard(page);

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "weddings");
    await expect(page.getByRole("button", { name: /next 90 days/i })).toBeVisible({
      timeout: 20_000,
    });

    guard.assertClean("Wedding dashboard emitted runtime console/API noise");
  });
});
