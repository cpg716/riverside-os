import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const source = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

test("wedding lifecycle is fulfillment-derived and pickup cannot be toggled", () => {
  const queries = source("../../server/src/logic/wedding_queries.rs");
  const health = source("../../server/src/logic/wedding_health.rs");
  const desktop = source(
    "../src/components/wedding-manager/components/MemberListDesktop.jsx",
  );
  const mobile = source(
    "../src/components/wedding-manager/components/MemberListMobile.jsx",
  );

  expect(queries).toContain("LEFT JOIN LATERAL");
  expect(queries).toContain("tl.order_lifecycle_status = 'picked_up'");
  expect(health).toContain("m.open_count == 0 && m.picked_up_count > 0");
  expect(health).not.toContain('m.pickup_status == "complete" ||');
  expect(desktop).not.toContain("toggleStatus(partyId, member.id, 'pickup')");
  expect(mobile).not.toContain("toggleStatus(partyId, member.id, 'pickup')");
  expect(desktop).toContain("Complete pickup through Orders/Register");
});

test("wedding appointment integration preserves schedule and audit contracts", () => {
  const modal = source(
    "../src/components/scheduler/AppointmentModal.tsx",
  );
  const scheduler = source(
    "../src/components/scheduler/SchedulerWorkspace.tsx",
  );
  const api = source("../src/components/wedding-manager/lib/api.js");
  const server = source("../../server/src/api/weddings.rs");
  const bridge = source("../src/lib/weddingPosBridge.ts");
  const memberDetail = source(
    "../src/components/wedding-manager/components/MemberDetailModal.jsx",
  );

  expect(api).toContain("salesperson_staff_id");
  expect(api).toContain("schedule_override_reason");
  expect(api).toContain("conflict_override_reason");
  expect(api).toContain("expected_revision");
  expect(modal).toContain("Manager Access overlap override");
  expect(modal).toContain("completeMemberMilestone: syncMember");
  expect(modal).toContain("Complete the pickup through Orders/Register");
  expect(modal).toContain('document.getElementById("drawer-root")');
  expect(modal).toContain("ui-overlay-backdrop");
  expect(scheduler).toContain('activeSection === "conflicts"');
  expect(scheduler).toContain("getAppointmentConflicts");
  expect(server).toContain('"APPOINTMENT_ATTENDED"');
  expect(server).toContain("body.complete_member_milestone");
  expect(server).toContain('merged_status.eq_ignore_ascii_case("Attended")');
  expect(server).toContain('"actor_staff_id": actor.id');
  expect(bridge).toContain("ROS_OPEN_TRANSACTION_FROM_WM");
  expect(memberDetail).toContain("dispatchOpenWeddingTransaction(ln.transaction_id)");
});
