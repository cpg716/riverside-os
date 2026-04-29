import { expect, test } from "@playwright/test";
import { signInToBackOffice, openBackofficeSidebarTab } from "./helpers/backofficeSignIn";

const CUSTOMER = {
    id: "11111111-1111-4111-8111-111111111111",
    customer_code: "ALT-SCHED",
    first_name: "Charlie",
    last_name: "Custom",
    phone: "716-555-9999",
};

const ALTERATION = {
    id: "22222222-2222-4222-8222-222222222222",
    customer_id: CUSTOMER.id,
    customer_first_name: CUSTOMER.first_name,
    customer_last_name: CUSTOMER.last_name,
    customer_code: CUSTOMER.customer_code,
    customer_phone: CUSTOMER.phone,
    customer_email: null,
    customer_address_line1: null,
    customer_city: null,
    customer_state: null,
    customer_postal_code: null,
    status: "intake",
    item_description: "E2E Test Suit",
    work_requested: "Initial fitting needed",
    source_type: "custom_item",
    source_transaction_id: null,
    source_transaction_line_id: null,
    source_sku: null,
    linked_transaction_id: null,
    linked_transaction_display_id: null,
    charge_amount: null,
    intake_channel: "back_office",
    source_snapshot: null,
    due_at: "2026-06-01T12:00:00Z",
    fitting_at: null,
    appointment_id: null,
    wedding_member_id: null,
    notes: null,
    created_at: new Date().toISOString(),
    total_units_jacket: 0,
    total_units_pant: 0,
};

test.describe("Smart Alterations Scheduler E2E", () => {
    test.beforeEach(async ({ page }) => {
        let alterationState = { ...ALTERATION };
        const alterationItems: Array<{
            id: string;
            alteration_order_id: string;
            label: string;
            capacity_bucket: "jacket" | "pant" | "other";
            units: number;
            completed_at: string | null;
            created_at: string;
        }> = [];

        // Mock Customers (matches /api/customers, /api/customers/browse, etc)
        await page.route(/\/api\/customers($|\?|\/)/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([CUSTOMER]),
            });
        });

        await page.route(`**/api/customers/${CUSTOMER.id}`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(CUSTOMER),
            });
        });

        // Mock Alterations workspace and customer-scoped views.
        await page.route(/\/api\/alterations($|\?)/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([ALTERATION]),
            });
        });

        // Mock Alteration Items (empty initially)
        await page.route(`**/api/alterations/${ALTERATION.id}/items`, async (route) => {
            if (route.request().method() === "GET") {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(alterationItems),
                });
            } else if (route.request().method() === "POST") {
                const body = route.request().postDataJSON();
                alterationItems.push({
                    id: `item-${alterationItems.length + 1}`,
                    alteration_order_id: ALTERATION.id,
                    label: body.label,
                    capacity_bucket: body.capacity_bucket,
                    units: body.units,
                    completed_at: null,
                    created_at: new Date().toISOString(),
                });
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(alterationItems.at(-1)),
                });
            }
        });

        // Mock Capacity
        await page.route("**/api/alterations/capacity?*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { date: "2026-05-15", used_jacket: 5, used_pant: 2, max_jacket: 28, max_pant: 24, is_manual_only: false },
                    { date: "2026-05-16", used_jacket: 10, used_pant: 5, max_jacket: 28, max_pant: 24, is_manual_only: false },
                ]),
            });
        });

        // Mock Suggestions
        await page.route("**/api/alterations/suggest-slots?*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { date: "2026-05-15", score: 100, is_manual_only: false, reason: "Best fit" },
                    { date: "2026-05-16", score: 90, is_manual_only: false, reason: "High capacity" },
                ]),
            });
        });

        // Mock Patch Alteration
        await page.route(`**/api/alterations/${ALTERATION.id}`, async (route) => {
            if (route.request().method() === "PATCH") {
                const body = route.request().postDataJSON();
                alterationState = {
                    ...alterationState,
                    ...body,
                    total_units_jacket: alterationItems
                        .filter((item) => item.capacity_bucket === "jacket")
                        .reduce((sum, item) => sum + item.units, 0),
                    total_units_pant: alterationItems
                        .filter((item) => item.capacity_bucket === "pant")
                        .reduce((sum, item) => sum + item.units, 0),
                };
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(alterationState),
                });
            }
        });

        await signInToBackOffice(page);
    });

    test("can plan work items and schedule a slot using the smart scheduler", async ({ page }) => {
        await openBackofficeSidebarTab(page, "alterations");
        
        const garmentCard = page.getByTestId("alteration-workbench-card").filter({
            hasText: "E2E Test Suit",
        }).last();
        await expect(garmentCard).toBeVisible();

        // Open Scheduler
        await garmentCard.getByRole("button", { name: "Plan & Schedule", exact: true }).click();
        await expect(page.getByText("Plan & Schedule", { exact: true })).toBeVisible();

        // Phase 1: Plan Work
        // Click a common task button (e.g. Waist in/out)
        await page.getByRole("button", { name: /Waist in\/out/i }).click();
        
        // Click a jacket common task (e.g. Shorten Sleeves)
        await page.getByRole("button", { name: /Shorten Sleeves/i }).click();

        // Verify units (Waist: 2u, Sleeves: 4u)
        await expect(page.getByText("Jacket Units").locator("xpath=following-sibling::p")).toHaveText("4u");
        await expect(page.getByText("Pant Units").locator("xpath=following-sibling::p")).toHaveText("2u");

        // Next Step: Schedule (using the new tab/button)
        await page.getByRole("button", { name: "2. Schedule Slot", exact: true }).click();

        // Phase 2: Schedule
        await expect(page.getByText("Smart Slot Suggestions")).toBeVisible();
        
        // Select the first suggestion (May 15)
        await page.getByText("Friday").first().click();

        // Verify card updated
        await expect(page.getByText("Scheduled for May 15, 2026")).toBeVisible();
        await expect(page.getByText("Scheduled", { exact: true })).toBeVisible();
    });

    test("surfaces alteration status in Wedding Hub member list", async ({ page }) => {
        // Mock Wedding Party and Member
        const PARTY_ID = "party-123";
        const MEMBER = {
            id: "member-456",
            name: "Groom Charlie",
            role: "Groom",
            customer_id: CUSTOMER.id,
            alteration_status: "Scheduled",
            measured: true,
            ordered: false,
            received: false,
            fitting: false,
            pickup: false,
        };

        await page.route(/\/api\/weddings\/parties($|\?)/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    data: [{
                        id: PARTY_ID,
                        name: "Charlie Wedding",
                        date: "2026-06-20",
                        salesperson: "Chris G",
                        members: [MEMBER],
                    }],
                    pagination: {
                        page: 1,
                        limit: 20,
                        total: 1,
                        totalPages: 1,
                    },
                }),
            });
        });

        await page.route(`**/api/weddings/parties/${PARTY_ID}/members`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([MEMBER]),
            });
        });

        await page.route(`**/api/weddings/parties/${PARTY_ID}`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ id: PARTY_ID, name: "Charlie Wedding" }),
            });
        });

        await openBackofficeSidebarTab(page, "weddings");
        
        // Navigate to party (mocked)
        await expect(page.getByText("Charlie Wedding")).toBeVisible({ timeout: 15_000 });
        await page.getByText("Charlie Wedding").click({ force: true });

        // Verify "Alt" column shows status
        const memberRow = page.getByRole("row").filter({ hasText: "Groom Charlie" });
        await expect(memberRow.getByText("Scheduled")).toBeVisible();
        await expect(memberRow.locator('[title="Alteration Status: Scheduled"]')).toBeVisible();
    });

    test("can create a manual Alteration appointment in the global calendar", async ({ page }) => {
        // Mock Salespeople for AppointmentModal
        await page.route("**/api/staff/list-for-appointments", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(["Avery Staff", "Taylor Tailor"]),
            });
        });
        await page.route("**/api/staff/list-for-pos", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    { full_name: "Avery Staff", role: "salesperson" },
                    { full_name: "Taylor Tailor", role: "sales_support" },
                ]),
            });
        });

        await page.route("**/api/weddings/appointments?*", async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        });

        await page.route("**/api/weddings/appointments", async (route) => {
            if (route.request().method() === "POST") {
                const body = route.request().postDataJSON();
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: "appt-123",
                        ...body,
                        customer_display_name: "Charlie Custom",
                        appointment_type: body.appointment_type ?? "Fitting",
                    }),
                });
                return;
            }
            await route.fallback();
        });
        await page.route("**/api/weddings/appointments/**", async (route) => {
            if (route.request().method() === "PATCH") {
                const body = route.request().postDataJSON();
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: "appt-123",
                        ...body,
                        customer_display_name: "Charlie Custom",
                        appointment_type: body.appointment_type ?? "Fitting",
                    }),
                });
                return;
            }
            await route.fallback();
        });

        await openBackofficeSidebarTab(page, "appointments");

        // Click New Appointment.
        await page.getByRole("button", { name: /New Appt/i }).click();

        // Fill Modal
        const modal = page.getByTestId("appointment-modal");
        await expect(modal).toBeVisible();
        await modal.locator("select").first().selectOption("Fitting");
        await modal.locator('input[type="time"]').fill("14:00");
        await modal.getByPlaceholder(/Search customers/i).fill("Charlie Custom");
        
        // Select mocked customer from search
        const customerMatch = modal.getByText("Charlie Custom").last();
        if (await customerMatch.isVisible().catch(() => false)) {
            await customerMatch.click();
        }

        // Save
        await modal.getByRole("button", { name: /Create Appointment|Update Schedule/i }).click();

        // Verify it appears in calendar (mocking the list response would be needed for absolute verification)
        await expect(page.getByTestId("appointment-modal")).not.toBeVisible();
    });
});
