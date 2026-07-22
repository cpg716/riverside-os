import { expect, test } from "@playwright/test";
import { openBackofficeSidebarTab } from "./helpers/backofficeSignIn";

test.describe("production performance budgets", () => {
  test.skip(process.env.RUN_PRODUCTION_PERF !== "1", "Opt-in production-only read checks");

  test("core workspace load and scrolling stay within budget", async ({ page }) => {
    test.setTimeout(45_000);
    const started = Date.now();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("navigation", { name: /Main Navigation/i })).toBeVisible({
      timeout: 20_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    await openBackofficeSidebarTab(page, "reports");
    const workspace = page.locator('[data-testid="reports-workspace"]');
    await expect(workspace).toBeVisible({ timeout: 20_000 });

    const scrollState = await workspace.evaluate((element) => {
      const node = element as HTMLElement;
      const before = node.scrollTop;
      node.scrollTop = Math.min(240, Math.max(0, node.scrollHeight - node.clientHeight));
      return {
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        before,
      };
    });
    expect(scrollState.scrollHeight).toBeGreaterThanOrEqual(scrollState.clientHeight);
    if (scrollState.scrollHeight > scrollState.clientHeight) {
      expect(scrollState.scrollTop).toBeGreaterThan(0);
    }
  });

  test("core back-office workspaces expose a usable scroll contract", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("navigation", { name: /Main Navigation/i })).toBeVisible({
      timeout: 20_000,
    });

    for (const tab of ["customers", "orders", "inventory", "reports", "settings"] as const) {
      await openBackofficeSidebarTab(page, tab);
      const state = await page.getByTestId("backoffice-workspace-root").evaluate((root) => {
        const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
        const scrollable = elements.find((element) => {
          const style = getComputedStyle(element);
          return (
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            element.scrollHeight > element.clientHeight
          );
        });
        return {
          rootOverflowY: getComputedStyle(root).overflowY,
          hasScrollableDescendant: Boolean(scrollable),
        };
      });
      expect(state.rootOverflowY).not.toBe("hidden");
      expect(state.hasScrollableDescendant || tab === "settings").toBeTruthy();
    }
  });

  test("universal search responds within budget", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("navigation", { name: /Main Navigation/i })).toBeVisible({
      timeout: 20_000,
    });
    const searchButton = page.getByRole("button", { name: /open universal search/i });
    await searchButton.click();
    const search = page.getByRole("combobox", { name: /universal search/i });
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/search/universal?") && response.request().method() === "GET",
    );
    const started = Date.now();
    await search.fill(`zz-perf-no-match-${Date.now()}`);
    const response = await responsePromise;
    const body = (await response.json()) as { query?: string; sources_failed?: string[] };
    expect(response.status(), JSON.stringify(body.sources_failed ?? [])).toBe(200);
    expect(body.query).toContain("zz-perf-no-match-");
    expect(Date.now() - started).toBeLessThan(2_000); // includes the 220 ms input debounce
    await expect(page.getByText(/^Working…$/)).toBeHidden({ timeout: 2_000 });
    await expect(page.getByRole("listbox", { name: /search results/i })).toBeVisible();
  });
});
