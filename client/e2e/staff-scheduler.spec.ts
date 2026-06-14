import { expect, test } from "@playwright/test";
import { signInToBackOffice, openBackofficeSidebarTab } from "./helpers/backofficeSignIn";

const ELIGIBLE_STAFF = [
    { id: "staff-1", full_name: "Alice Admin", role: "admin" },
    { id: "staff-2", full_name: "Bob Sales", role: "salesperson" },
];

const WEEK_START = "2026-04-26";
const WEEK_END = "2026-05-02";

function addDaysYmd(start: string, days: number) {
    const date = new Date(`${start}T00:00:00`);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
}

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
            const url = new URL(route.request().url());
            const from = url.searchParams.get("from") ?? WEEK_START;
            const to = url.searchParams.get("to") ?? addDaysYmd(from, 6);
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    from,
                    to,
                    rows: ELIGIBLE_STAFF.map(s => ({
                        staff_id: s.id,
                        full_name: s.full_name,
                        role: s.role,
                        days: Array.from({ length: 7 }, (_, i) => ({
                            date: addDaysYmd(from, i),
                            working: true,
                            shift_label: "9-5"
                        }))
                    })),
                }),
            });
        });

        // Mock specific week data for Scheduler (Draft/Published)
        await page.route("**/api/staff/schedule/weeks/*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(ELIGIBLE_STAFF.map(s => ({
                    staff_id: s.id,
                    full_name: s.full_name,
                    role: s.role,
                    status: "published",
                    weekdays: Array.from({ length: 7 }, (_, i) => ({
                        weekday: i,
                        works: true,
                        shift_label: "9-5",
                        is_highlighted: false
                    }))
                }))),
            });
        });

        await page.route("**/api/staff/schedule/events*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
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

        await page.route(`**/api/staff/schedule/requests?staff_id=staff-1*`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    {
                        id: "request-1",
                        staff_id: "staff-1",
                        full_name: "Alice Admin",
                        requested_by_staff_id: "staff-1",
                        requested_by_name: "Alice Admin",
                        kind: "pto",
                        start_date: "2026-04-28",
                        end_date: "2026-04-28",
                        partial_start_time: null,
                        partial_end_time: null,
                        staff_note: "Family appointment",
                        status: "pending",
                        reviewed_by_staff_id: null,
                        reviewed_by_name: null,
                        reviewed_at: null,
                        manager_note: null,
                        created_at: "2026-04-20T12:00:00Z",
                        updated_at: "2026-04-20T12:00:00Z",
                    },
                ]),
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
        await expect(page.getByText("Request history")).toBeVisible();
        await expect(page.getByText("Family appointment")).toBeVisible();
    });

    test("can access master scheduler and see published status", async ({ page }) => {
        await openBackofficeSidebarTab(page, "staff");
        await page.getByRole("button", { name: /^Schedule$/i }).click();
        
        // Switch to "Scheduler" sub-view
        await page.getByRole("button", { name: "Scheduler", exact: true }).click();
        await expect(page.getByText("Plan specific weeks")).toBeVisible();

        // Verify status badge
        await expect(page.getByText("Published week", { exact: true })).toBeVisible();

        // Verify Excel Import button existence
        await expect(page.getByText("Upload Excel")).toBeVisible();
    });

    test("can manage store events (meetings/holidays)", async ({ page }) => {
        // Mock events fetch
        await page.route("**/api/staff/schedule/events*", async (route) => {
            const url = new URL(route.request().url());
            const from = url.searchParams.get("from") ?? WEEK_START;
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { 
                        id: "evt-1", 
                        event_date: addDaysYmd(from, 1), 
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
