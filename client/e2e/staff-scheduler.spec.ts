import { expect, test } from "@playwright/test";
import { signInToBackOffice, openBackofficeSidebarTab } from "./helpers/backofficeSignIn";

const ELIGIBLE_STAFF = [
    { id: "staff-1", full_name: "Alice Admin", role: "admin" },
    { id: "staff-2", full_name: "Bob Sales", role: "salesperson" },
];

const WEEK_START = "2026-04-26";
const WEEK_END = "2026-05-02";

test.describe("Staff Scheduler E2E", () => {
    test.beforeEach(async ({ page }) => {
        // Mock eligible staff
        await page.route("**/api/staff/schedule/eligible", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(ELIGIBLE_STAFF),
            });
        });

        // Mock weekly view (Public Roster)
        await page.route("**/api/staff/schedule/weekly-view?*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    from: WEEK_START,
                    to: WEEK_END,
                    rows: ELIGIBLE_STAFF.map(s => ({
                        staff_id: s.id,
                        full_name: s.full_name,
                        role: s.role,
                        days: [
                            { date: "2026-04-26", working: true, shift_label: "9-5" },
                            { date: "2026-04-27", working: true, shift_label: "9-5" },
                            { date: "2026-04-28", working: true, shift_label: "9-5" },
                            { date: "2026-04-29", working: true, shift_label: "9-5" },
                            { date: "2026-04-30", working: true, shift_label: "9-5" },
                            { date: "2026-05-01", working: true, shift_label: "9-5" },
                            { date: "2026-05-02", working: true, shift_label: "9-5" },
                        ]
                    })),
                }),
            });
        });

        // Mock specific week data for Scheduler (Draft/Published)
        await page.route(`**/api/staff/schedule/weeks/${WEEK_START}*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(ELIGIBLE_STAFF.map(s => ({
                    staff_id: s.id,
                    full_name: s.full_name,
                    role: s.role,
                    status: "Published",
                    weekdays: Array.from({ length: 7 }, (_, i) => ({
                        weekday: i,
                        works: true,
                        shift_label: "9-5",
                        is_highlighted: false
                    }))
                }))),
            });
        });

        // Mock individual staff patterns/exceptions
        await page.route(`**/api/staff/schedule/weekly/staff-1`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(Array.from({ length: 7 }, (_, i) => ({
                    weekday: i,
                    works: true,
                    shift_label: "Pattern 9-5"
                }))),
            });
        });

        await page.route(`**/api/staff/schedule/effective?staff_id=staff-1*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ days: [] }),
            });
        });

        await page.route(`**/api/staff/schedule/exceptions?staff_id=staff-1*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        });

        await signInToBackOffice(page);
    });

    test("can view public weekly roster", async ({ page }) => {
        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        
        await expect(page.getByRole("heading", { name: "Weekly schedule" })).toBeVisible();
        await expect(page.getByText("Alice Admin").first()).toBeVisible();
        await expect(page.getByText("Bob Sales")).toBeVisible();
        
        // Verify shifts are visible in the table
        const firstRow = page.getByRole("row").filter({ hasText: "Alice Admin" });
        await expect(firstRow.getByText("9-5").first()).toBeVisible();
    });

    test("can manage individual staff availability", async ({ page }) => {
        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        
        // Switch to "Staff" sub-view
        await page
            .getByTestId("app-shell-state")
            .getByRole("button", { name: "Staff", exact: true })
            .click();
        await expect(page.getByText(/Time & Attendance|Team Attendance/)).toBeVisible();

        // Select Alice
        await page.locator("select").first().selectOption({ label: "Alice Admin" });
        await expect(page.getByText("Managing Schedule")).toBeVisible();
        await expect(page.getByRole("heading", { name: "Alice Admin" })).toBeVisible();

        // Verify pattern is loaded
        await expect(page.getByPlaceholder("Shift").first()).toHaveValue("Pattern 9-5");
    });

    test("can access master scheduler and see published status", async ({ page }) => {
        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        
        // Switch to "Scheduler" sub-view
        await page.getByRole("button", { name: "Scheduler", exact: true }).click();
        await expect(page.getByText("Plan specific weeks")).toBeVisible();

        // Verify status badge
        await expect(page.getByText("Published week")).toBeVisible();

        // Verify Excel Import button existence
        await expect(page.getByText("Upload Excel")).toBeVisible();
    });

    test("can manage store events (meetings/holidays)", async ({ page }) => {
        // Mock events fetch
        await page.route("**/api/staff/schedule/events*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { 
                        id: "evt-1", 
                        event_date: "2026-04-27", 
                        label: "Memorial Day", 
                        kind: "holiday", 
                        is_all_staff: true, 
                        attendees: [] 
                    }
                ]),
            });
        });

        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        await page.getByRole("button", { name: "Scheduler", exact: true }).click();

        // Verify holiday star and red color in grid (top row)
        const holidayCell = page.getByText("★ Memorial Day");
        await expect(holidayCell).toBeVisible();
        
        // Verify staff shift badge (red 'H' for holiday)
        const shiftBadge = page.getByText("H", { exact: true }).first();
        await expect(shiftBadge).toBeVisible();
        await expect(shiftBadge).toContainText("H");
    });

    test("can switch to master template mode", async ({ page }) => {
        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        await page.getByRole("button", { name: "Scheduler", exact: true }).click();

        // Mock template endpoint
        await page.route("**/api/staff/schedule/weekly/template", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        });

        // Click "Template" mode
        await page.getByRole("button", { name: /Master Template/i }).click();
        await expect(page.getByText("Store-wide Template")).toBeVisible();
    });
});
