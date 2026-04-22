import { expect, test } from "@playwright/test";
import {
  checkoutFinancedSale,
  getTransactionArtifacts,
  openCustomersRmsWorkspace,
  prepareRmsRecord,
  resetFakeCoreCardHost,
  seedRmsFixture,
  staffHeaders,
  verifyStaffId,
} from "./helpers/rmsCharge";
import { signInToBackOffice } from "./helpers/backofficeSignIn";

test.describe("Back Office RMS Charge workspace", () => {
  test.beforeEach(async ({ request }) => {
    await resetFakeCoreCardHost(request);
  });

test("exception ownership and retry flow stay support-safe", async ({ request, page }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Exception");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    expect(checkout.response.status(), "Financed RMS checkout failed during spec setup.").toBe(200);
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const prepared = (await prepareRmsRecord(request, "failed_exception", artifacts.rms_records[0]!.id)) as {
      exception_id: string;
    };
    const currentStaffId = await verifyStaffId(request);

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page.getByTestId("rms-workspace-tab-exceptions").click();
    await expect(page.getByText(/failed purchase post/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`rms-exception-assignee-${prepared.exception_id}`)).toContainText(/unassigned/i);

    await page.getByTestId(`rms-exception-assign-self-${prepared.exception_id}`).click();
    await expect(page.getByTestId(`rms-exception-assignee-${prepared.exception_id}`)).toContainText(/assigned to you/i);

    const assignedRes = await request.get(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/customers/rms-charge/exceptions?limit=50`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(assignedRes.status()).toBe(200);
    const assignedRows = (await assignedRes.json()) as Array<{
      id: string;
      assigned_to_staff_id?: string | null;
      notes?: string | null;
    }>;
    const assigned = assignedRows.find((row) => row.id === prepared.exception_id);
    expect(assigned?.assigned_to_staff_id).toBe(currentStaffId);
    expect(assigned?.notes).toMatch(/claimed by/i);

    await page.getByTestId(`rms-exception-retry-${prepared.exception_id}`).click();
    await expect
      .poll(
        async () => {
          const refreshed = await getTransactionArtifacts(request, checkout.body!.transaction_id);
          return refreshed.rms_records[0]?.posting_status;
        },
        { timeout: 15_000, message: "Seeded RMS exception never transitioned back to posted." },
      )
      .toBe("posted");
  });

  test("resolution notes are required and stored for RMS exception follow-up", async ({ request, page }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Resolution");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    expect(checkout.response.status(), "Financed RMS checkout failed during resolution-note setup.").toBe(200);
    const artifacts = await getTransactionArtifacts(request, checkout.body!.transaction_id);
    const prepared = (await prepareRmsRecord(request, "failed_exception", artifacts.rms_records[0]!.id)) as {
      exception_id: string;
    };

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page.getByTestId("rms-workspace-tab-exceptions").click();
    await expect(page.getByText(/failed purchase post/i).first()).toBeVisible({ timeout: 15_000 });

    await page.getByTestId(`rms-exception-resolve-${prepared.exception_id}`).click();
    const resolutionDialog = page.getByRole("dialog", { name: /resolve rms issue/i });
    await expect(resolutionDialog).toBeVisible();
    await resolutionDialog.getByRole("button", { name: /save resolution/i }).click();
    await expect(resolutionDialog).toBeVisible();

    await resolutionDialog.getByPlaceholder(/corecard confirmed/i).fill(
      "CoreCard confirmed the original post and support closed the duplicate failure.",
    );
    await resolutionDialog.getByRole("button", { name: /save resolution/i }).click();
    await expect(resolutionDialog).toBeHidden({ timeout: 15_000 });

    const resolvedRes = await request.get(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/customers/rms-charge/exceptions?limit=50`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(resolvedRes.status()).toBe(200);
    const resolvedRows = (await resolvedRes.json()) as Array<{
      id: string;
      status?: string | null;
      resolution_notes?: string | null;
    }>;
    const resolved = resolvedRows.find((row) => row.id === prepared.exception_id);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolution_notes).toContain("CoreCard confirmed the original post");
  });

  test("reconciliation can fail while overview and exceptions remain usable", async ({ request, page }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Partial Load");
    const checkout = await checkoutFinancedSale(request, {
      fixture,
      programCode: "standard",
    });
    expect(checkout.response.status(), "Financed RMS checkout failed during partial-load setup.").toBe(200);

    await page.route("**/api/customers/rms-charge/reconciliation?limit=10", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Reconciliation service unavailable" }),
      });
    });

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await expect(page.getByRole("heading", { name: /operational overview/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/charges/i).first()).toBeVisible();

    await page.getByTestId("rms-workspace-tab-reconciliation").click();
    await expect(page.getByTestId("rms-reconciliation-load-warning")).toContainText(
      /overview and exceptions are still available/i,
    );

    await page.getByTestId("rms-workspace-tab-exceptions").click();
    await expect(page.getByRole("heading", { name: /manual review queue/i })).toBeVisible();
    await expect(page.getByText(/No active RMS Charge exceptions|failed purchase post/i).first()).toBeVisible();
  });

  test("account link correction uses confirmation before unlink and supports relink", async ({ page, request }) => {
    const fixture = await seedRmsFixture(request, "single_valid", "Linking");
    const linked = fixture.linked_accounts[0]!;
    const releaseSeedLink = await request.post(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/customers/rms-charge/unlink-account`,
      {
        data: {
          customer_id: fixture.customer.id,
          link_id: linked.id,
        },
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(releaseSeedLink.status()).toBe(200);

    await signInToBackOffice(page);
    await openCustomersRmsWorkspace(page);
    await page.getByPlaceholder(/search customer for rms charge/i).fill("E2E");
    await page.locator("ul button").first().click();
    await page.getByTestId("rms-workspace-tab-accounts").click();

    const selectedCustomerId = (await page.getByTestId("rms-selected-customer-id").textContent())?.trim();
    expect(selectedCustomerId).toBeTruthy();

    const initialLink = await request.post(
      `${process.env.E2E_API_BASE || "http://127.0.0.1:43300"}/api/customers/rms-charge/link-account`,
      {
        data: {
          customer_id: selectedCustomerId,
          corecredit_customer_id: linked.corecredit_customer_id,
          corecredit_account_id: linked.corecredit_account_id,
          program_group: linked.program_group ?? undefined,
          status: linked.status,
          notes: "Linked for support correction flow.",
          is_primary: linked.is_primary,
        },
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    expect(initialLink.status()).toBe(200);

    await page.getByTestId("rms-linked-accounts-refresh").click();

    const linkedAccountCard = page
      .locator("div.rounded-xl.border.p-4", {
        has: page.getByText(linked.masked_account),
      })
      .first();
    await expect(linkedAccountCard).toBeVisible({ timeout: 15_000 });

    await linkedAccountCard.getByRole("button", { name: /remove link/i }).click();
    const confirmDialog = page.getByRole("dialog", { name: /remove rms account link/i });
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog).toContainText(/does not change the corecard account itself/i);
    await expect(confirmDialog).toContainText(/recorded in the audit trail/i);
    await confirmDialog.getByRole("button", { name: /keep link/i }).click();
    await expect(confirmDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(linked.masked_account)).toBeVisible();

    await linkedAccountCard.getByRole("button", { name: /remove link/i }).click();
    await confirmDialog.getByRole("button", { name: /remove link/i }).click();
    await expect(confirmDialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/no linked corecredit\/corecard accounts for this customer yet/i)).toBeVisible();

    await page.getByTestId("rms-link-corecredit-customer-id").fill(linked.corecredit_customer_id);
    await page.getByTestId("rms-link-corecredit-account-id").fill(linked.corecredit_account_id);
    if (linked.program_group) {
      await page.getByTestId("rms-link-program-group").fill(linked.program_group);
    }
    await page.getByTestId("rms-link-notes").fill("Re-linked after support correction.");
    if (linked.is_primary) {
      await page.getByTestId("rms-link-primary").check();
    }
    await page.getByTestId("rms-link-submit").click();
    await expect(page.getByText(linked.masked_account)).toBeVisible({ timeout: 15_000 });
  });
});
