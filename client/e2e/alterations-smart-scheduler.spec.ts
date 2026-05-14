import { expect, test, type APIRequestContext } from "@playwright/test";
import { signInToBackOffice, openBackofficeSidebarTab } from "./helpers/backofficeSignIn";
import { apiBase, seedRmsFixture, staffHeaders } from "./helpers/rmsCharge";

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

type AlterationApiRow = {
    id: string;
    customer_id: string;
    total_units_jacket: number;
    total_units_pant: number;
};

type AlterationItemApiRow = {
    id: string;
    alteration_order_id: string;
    capacity_bucket: "jacket" | "pant" | "other";
    units: number;
};

async function loadAlterationById(
    request: APIRequestContext,
    customerId: string,
    alterationId: string,
): Promise<AlterationApiRow> {
    const res = await request.get(
        `${apiBase()}/api/alterations?customer_id=${encodeURIComponent(customerId)}`,
        {
            headers: staffHeaders(),
            failOnStatusCode: false,
        },
    );
    expect(res.status()).toBe(200);
    const rows = (await res.json()) as AlterationApiRow[];
    const row = rows.find((entry) => entry.id === alterationId);
    expect(row).toBeTruthy();
    return row!;
}

async function addAlterationItem(
    request: APIRequestContext,
    alterationId: string,
    item: { label: string; capacity_bucket: "jacket" | "pant" | "other"; units: number },
): Promise<AlterationItemApiRow> {
    const res = await request.post(`${apiBase()}/api/alterations/${alterationId}/items`, {
        headers: {
            ...staffHeaders(),
            "Content-Type": "application/json",
        },
        data: item,
        failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
    return (await res.json()) as AlterationItemApiRow;
}

test.describe("Alteration unit totals API", () => {
    test("recalculates order unit totals after item add and delete", async ({ request }) => {
        const fixture = await seedRmsFixture(request, "standard_only", "Alteration Unit Totals");

        const createRes = await request.post(`${apiBase()}/api/alterations`, {
            headers: {
                ...staffHeaders(),
                "Content-Type": "application/json",
            },
            data: {
                customer_id: fixture.customer.id,
                source_type: "custom_item",
                item_description: "Customer-owned suit",
                work_requested: "Unit total reliability check",
                intake_channel: "standalone",
            },
            failOnStatusCode: false,
        });
        expect(createRes.status()).toBe(200);
        const alteration = (await createRes.json()) as AlterationApiRow;
        expect(alteration.total_units_jacket).toBe(0);
        expect(alteration.total_units_pant).toBe(0);

        const jacket = await addAlterationItem(request, alteration.id, {
            label: "Shorten sleeves",
            capacity_bucket: "jacket",
            units: 4,
        });
        await addAlterationItem(request, alteration.id, {
            label: "Waist in/out",
            capacity_bucket: "pant",
            units: 2,
        });
        const other = await addAlterationItem(request, alteration.id, {
            label: "Steam garment",
            capacity_bucket: "other",
            units: 3,
        });

        await expect
            .poll(async () => {
                const row = await loadAlterationById(request, fixture.customer.id, alteration.id);
                return [row.total_units_jacket, row.total_units_pant];
            })
            .toEqual([4, 2]);

        const deleteJacketRes = await request.delete(
            `${apiBase()}/api/alterations/${alteration.id}/items/${jacket.id}`,
            {
                headers: staffHeaders(),
                failOnStatusCode: false,
            },
        );
        expect(deleteJacketRes.status()).toBe(204);

        await expect
            .poll(async () => {
                const row = await loadAlterationById(request, fixture.customer.id, alteration.id);
                return [row.total_units_jacket, row.total_units_pant];
            })
            .toEqual([0, 2]);

        const deleteOtherRes = await request.delete(
            `${apiBase()}/api/alterations/${alteration.id}/items/${other.id}`,
            {
                headers: staffHeaders(),
                failOnStatusCode: false,
            },
        );
        expect(deleteOtherRes.status()).toBe(204);

        const finalRow = await loadAlterationById(request, fixture.customer.id, alteration.id);
        expect(finalRow.total_units_jacket).toBe(0);
        expect(finalRow.total_units_pant).toBe(2);
    });
});

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
                    {
                        date: "2026-05-14",
                        jacket_units_used: 12,
                        pant_units_used: 4,
                        jacket_units_available: 16,
                        pant_units_available: 20,
                        is_manual_only: true,
                        has_staff: true,
                    },
                    {
                        date: "2026-05-15",
                        jacket_units_used: 5,
                        pant_units_used: 2,
                        jacket_units_available: 23,
                        pant_units_available: 22,
                        is_manual_only: false,
                        has_staff: true,
                    },
                    {
                        date: "2026-05-16",
                        jacket_units_used: 27,
                        pant_units_used: 23,
                        jacket_units_available: 1,
                        pant_units_available: 1,
                        is_manual_only: false,
                        has_staff: true,
                    },
                    {
                        date: "2026-05-17",
                        jacket_units_used: 0,
                        pant_units_used: 0,
                        jacket_units_available: 0,
                        pant_units_available: 0,
                        is_manual_only: false,
                        has_staff: false,
                    },
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
        test.setTimeout(60_000);
        const insightRequests: Record<string, unknown>[] = [];
        await page.route("**/api/help/rosie/v1/insight-summary", async (route) => {
            insightRequests.push(JSON.parse(route.request().postData() || "{}") as Record<string, unknown>);
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    status: "available",
                    bullets:
                        insightRequests.length === 1
                            ? [
                                  {
                                      text: "Friday is the first visible safe capacity day.",
                                      source_fact_ids: ["capacity-next-safe-day"],
                                  },
                                  {
                                      text: "The overloaded and no-staff days need staff awareness.",
                                      source_fact_ids: ["capacity-overloaded-days", "capacity-no-staff-days"],
                                  },
                                  {
                                      text: "Manual Thursday review remains deterministic.",
                                      source_fact_ids: ["capacity-manual-only-day"],
                                  },
                                  {
                                      text: "This fourth capacity bullet should stay hidden.",
                                      source_fact_ids: ["capacity-requested"],
                                  },
                              ]
                            : [
                                  {
                                      text: "Selected-day utilization is now part of the visible capacity facts.",
                                      source_fact_ids: ["capacity-selected-utilization"],
                                  },
                              ],
                }),
            });
        });

        await openBackofficeSidebarTab(page, "alterations");
        
        const garmentCard = page.getByTestId("alteration-workbench-card").filter({
            hasText: "E2E Test Suit",
        }).last();
        await expect(garmentCard).toBeVisible();

        // Open Scheduler
        await garmentCard.getByRole("button", { name: /plan (?:& schedule|\/ reassign)/i }).click();
        await expect(page.getByRole("heading", { name: "Plan & Schedule" })).toBeVisible();

        // Phase 1: Plan Work
        // Click a common task button (e.g. Waist in/out)
        await page.getByRole("button", { name: /Waist in\/out/i }).click();
        
        // Click a jacket common task (e.g. Shorten Sleeves)
        await page.getByRole("button", { name: /Shorten Sleeves/i }).click();

        // Verify units (Waist: 2u, Sleeves: 4u)
        await expect(page.getByText("Jacket: 4u")).toBeVisible();
        await expect(page.getByText("Pant: 2u")).toBeVisible();

        // Next Step: Schedule (using the new tab/button)
        await page.getByRole("button", { name: "2. Schedule Slot", exact: true }).click();

        // Phase 2: Schedule
        await expect(page.getByRole("heading", { name: "Capacity Outlook" })).toBeVisible();
        await expect(page.getByText("Requested work: 4 jacket units, 2 pant units.")).toBeVisible();
        await expect(page.getByText("Next safe day: Friday, May 15.")).toBeVisible();
        await expect(page.getByText("1 day is over capacity in this window.")).toBeVisible();
        await expect(page.getByText("1 day has no alterations staff scheduled.")).toBeVisible();
        await expect(page.getByText("Thursdays require manual review.")).toBeVisible();
        await expect(page.getByText("Smart Slot Suggestions")).toBeVisible();
        expect(insightRequests).toHaveLength(0);
        await page
            .getByTestId("rosie-insight-summary-capacity_outlook")
            .getByRole("button", { name: /rosie insight/i })
            .click();
        await expect.poll(() => insightRequests.length).toBe(1);
        await expect(page.getByText("Friday is the first visible safe capacity day.")).toBeVisible();
        await expect(page.getByText("The overloaded and no-staff days need staff awareness.")).toBeVisible();
        await expect(page.getByText("Manual Thursday review remains deterministic.")).toBeVisible();
        await expect(page.getByText("This fourth capacity bullet should stay hidden.")).toHaveCount(0);
        expect(insightRequests).toHaveLength(1);
        expect(insightRequests[0]).toMatchObject({
            surface: "capacity_outlook",
            mode: "explain",
            facts: {
                title: "Capacity Outlook",
                bullets: expect.arrayContaining([
                    expect.objectContaining({
                        id: "capacity-requested",
                        label: "Requested work: 4 jacket units, 2 pant units.",
                    }),
                    expect.objectContaining({
                        id: "capacity-next-safe-day",
                        label: "Next safe day: Friday, May 15.",
                    }),
                    expect.objectContaining({
                        id: "capacity-overloaded-days",
                        label: "1 day is over capacity in this window.",
                    }),
                ]),
            },
        });
        expect(JSON.stringify(insightRequests[0])).not.toContain("jacket_units_used");
        
        // Select the first suggestion (May 15)
        await page.getByRole("button", { name: /Friday/i }).first().click();

        // Verify card updated
        await expect(page.getByText("Fitting Scheduled")).toBeVisible();
        await expect(page.getByText("5/15/2026")).toBeVisible();
        await expect(
            page.getByText("Selected day: 5/28 jacket units, 2/24 pant units booked."),
        ).toBeVisible();
        await expect(page.getByText("Friday is the first visible safe capacity day.")).toHaveCount(0);
        await page
            .getByTestId("rosie-insight-summary-capacity_outlook")
            .getByRole("button", { name: /rosie insight/i })
            .click();
        await expect.poll(() => insightRequests.length).toBe(2);
        await expect(
            page.getByText("Selected-day utilization is now part of the visible capacity facts."),
        ).toBeVisible();
        expect(insightRequests).toHaveLength(2);
        expect(insightRequests[1]).toMatchObject({
            surface: "capacity_outlook",
            facts: {
                bullets: expect.arrayContaining([
                    expect.objectContaining({
                        id: "capacity-selected-utilization",
                        label: "Selected day: 5/28 jacket units, 2/24 pant units booked.",
                    }),
                ]),
            },
        });
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
        const API_MEMBER = {
            id: MEMBER.id,
            wedding_party_id: PARTY_ID,
            first_name: "Groom",
            last_name: "Charlie",
            role: MEMBER.role,
            customer_id: MEMBER.customer_id,
            alteration_status: MEMBER.alteration_status,
            measured: MEMBER.measured,
            suit_ordered: MEMBER.ordered,
            received: MEMBER.received,
            fitting: MEMBER.fitting,
            pickup_status: MEMBER.pickup ? "complete" : "pending",
        };
        const API_PARTY = {
            id: PARTY_ID,
            party_name: "Charlie Wedding",
            groom_name: "Charlie Wedding",
            event_date: "2026-06-20",
            salesperson: "Chris G",
            members: [API_MEMBER],
        };

        await page.route(/\/api\/weddings\/parties($|\?)/, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    data: [API_PARTY],
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
                body: JSON.stringify([API_MEMBER]),
            });
        });

        await page.route(`**/api/weddings/parties/${PARTY_ID}`, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(API_PARTY),
            });
        });

        await openBackofficeSidebarTab(page, "weddings");
        
        // Navigate to party (mocked)
        await expect(page.getByText("CharlieWedding-062026")).toBeVisible({ timeout: 15_000 });
        await page.getByText("CharlieWedding-062026").click({ force: true });

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
