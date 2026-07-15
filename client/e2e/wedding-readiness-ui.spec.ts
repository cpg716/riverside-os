import { expect, test } from "@playwright/test";
import {
  openBackofficeSidebarTab,
  signInToBackOffice,
} from "./helpers/backofficeSignIn";

test.describe("Phase 4 wedding readiness UI", () => {
  test("surfaces readiness search, priority counts, and next actions", async ({ page }) => {
    await page.route("**/api/weddings/readiness-dashboard?**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          critical_count: 1,
          at_risk_count: 1,
          watch_count: 1,
          safe_count: 1,
          complete_count: 1,
          parties: [
            readinessParty({
              id: "party-measurements",
              partyName: "Phase 4 Walkthrough Measurements",
              status: "critical",
              blockerLabel: "Needs measurements",
              blockerAction: "Measure members and update exact variations before creating vendor orders.",
              needsMeasurements: 1,
              blocked: 1,
              days: 12,
            }),
            readinessParty({
              id: "party-critical",
              partyName: "Phase 4 Walkthrough Critical NTBO",
              status: "critical",
              blockerLabel: "Needs vendor order",
              blockerAction: "Create or attach vendor purchase orders for NTBO items.",
              ntbo: 2,
              blocked: 1,
              days: 10,
            }),
            readinessParty({
              id: "party-vendor",
              partyName: "Phase 4 Walkthrough Vendor Delay",
              status: "critical",
              blockerLabel: "Vendor delay risk",
              blockerAction: "Call the vendor and update ETA before promising pickup.",
              ordered: 1,
              blocked: 1,
              days: 45,
            }),
            readinessParty({
              id: "party-partial",
              partyName: "Phase 4 Walkthrough Partial Ready",
              status: "at_risk",
              blockerLabel: "Partial party readiness",
              blockerAction: "Use partial pickup only for verified ready members.",
              ntbo: 1,
              ready: 1,
              blocked: 1,
              days: 60,
            }),
            readinessParty({
              id: "party-balance",
              partyName: "Phase 4 Walkthrough Balance Blocked",
              status: "at_risk",
              blockerLabel: "Pickup blocked until balance is cleared",
              blockerAction: "Collect payment before pickup release.",
              ready: 1,
              blocked: 1,
              days: 60,
            }),
            readinessParty({
              id: "party-safe",
              partyName: "Phase 4 Walkthrough Safe",
              status: "safe",
              nextAction: "Ready for guarded pickup release.",
              ready: 1,
              days: 45,
            }),
            readinessParty({
              id: "party-complete",
              partyName: "Phase 4 Walkthrough Complete",
              status: "complete",
              nextAction: "No action needed.",
              pickedUp: 1,
              days: 75,
            }),
          ],
        }),
      });
    });

    await signInToBackOffice(page);
    await openBackofficeSidebarTab(page, "weddings");
    await page.getByRole("button", { name: /^open readiness$/i }).click();

    const dashboard = page.getByTestId("wedding-readiness-dashboard");
    await expect(dashboard).toBeVisible({ timeout: 20_000 });
    await expect(dashboard.getByRole("heading", { name: /^readiness dashboard$/i })).toBeVisible();
    await expect(dashboard.getByText("Critical").first()).toBeVisible();
    await expect(dashboard.getByText("At risk").first()).toBeVisible();
    await expect(dashboard.getByText("Safe").first()).toBeVisible();

    await expect(dashboard.getByText("Phase 4 Walkthrough Critical NTBO")).toBeVisible();
    await expect(dashboard.getByText("Needs measurements")).toBeVisible();
    await expect(dashboard.getByText("Needs vendor order")).toBeVisible();
    await expect(dashboard.getByText("Vendor delay risk")).toBeVisible();
    await expect(dashboard.getByText("Pickup blocked until balance is cleared")).toBeVisible();

    await dashboard.getByLabel("Search wedding readiness").fill("balance");
    await expect(dashboard.getByText("Phase 4 Walkthrough Balance Blocked")).toBeVisible();
    await expect(dashboard.getByText("Phase 4 Walkthrough Critical NTBO")).toHaveCount(0);
    await expect(dashboard.getByText("Showing 1 of 7 party readiness record(s).")).toBeVisible();
  });
});

function readinessParty(options: {
  id: string;
  partyName: string;
  status: "safe" | "watch" | "at_risk" | "critical" | "complete";
  blockerLabel?: string;
  blockerAction?: string;
  nextAction?: string;
  ntbo?: number;
  needsMeasurements?: number;
  ordered?: number;
  ready?: number;
  pickedUp?: number;
  blocked?: number;
  days: number;
}) {
  const blocker = options.blockerLabel
    ? {
        severity: options.status === "critical" || options.status === "at_risk" ? "blocking" : "info",
        label: options.blockerLabel,
        explanation: options.blockerAction,
        next_safe_action: options.blockerAction,
      }
    : null;
  const ready = options.ready ?? 0;
  const pickedUp = options.pickedUp ?? 0;
  const ntbo = options.ntbo ?? 0;
  const needsMeasurements = options.needsMeasurements ?? 0;
  const ordered = options.ordered ?? 0;
  return {
    wedding_party_id: options.id,
    party_name: options.partyName,
    event_date: "2026-07-15",
    salesperson: "Chris G",
    days_until_event: options.days,
    readiness_score: options.status === "complete" ? 1 : options.status === "safe" ? 0.9 : 0.42,
    status: options.status,
    lifecycle: {
      needs_measurements: needsMeasurements,
      ntbo,
      ordered,
      received: 0,
      ready_for_pickup: ready,
      picked_up: pickedUp,
      open: needsMeasurements + ntbo + ordered + ready,
    },
    member_counts: {
      total: 1,
      measured: 1,
      ordered: ordered > 0 || ready > 0 || pickedUp > 0 ? 1 : 0,
      received: ready > 0 || pickedUp > 0 ? 1 : 0,
      fitting: ready > 0 || pickedUp > 0 ? 1 : 0,
      pickup_complete: pickedUp > 0 ? 1 : 0,
    },
    pickup: {
      ready_members: ready > 0 ? 1 : 0,
      blocked_members: options.blocked ?? 0,
      partial_ready_members: options.blockerLabel === "Partial party readiness" ? 1 : 0,
      balance_blocked_members: options.blockerLabel === "Pickup blocked until balance is cleared" ? 1 : 0,
    },
    vendor_risk: {
      ntbo_count: ntbo,
      stale_ordered_count: 0,
      missing_vendor_count: ntbo,
      delayed_vendor_count: options.blockerLabel === "Vendor delay risk" ? 1 : 0,
      next_eta: null,
    },
    blockers: blocker ? [blocker] : [],
    next_safe_action: options.nextAction ?? options.blockerAction ?? "Review readiness before pickup.",
  };
}
