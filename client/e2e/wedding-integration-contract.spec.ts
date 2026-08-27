import { readFileSync } from "node:fs";
import { expect, test, type APIResponse } from "@playwright/test";
import { apiBase, staffHeaders } from "./helpers/rmsCharge";

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

test("new and managed wedding members use ROS Customers and can start Register immediately", () => {
  const addParty = source(
    "../src/components/wedding-manager/components/AddPartyModal.jsx",
  );
  const memberDetail = source(
    "../src/components/wedding-manager/components/MemberDetailModal.jsx",
  );
  const dashboard = source(
    "../src/components/wedding-manager/pages/Dashboard.jsx",
  );
  const weddingClient = source(
    "../src/components/wedding-manager/lib/api.js",
  );
  const depositWorkspace = source(
    "../src/components/pos/WeddingDepositWorkspace.tsx",
  );
  const roles = source("../src/lib/weddingMemberRoles.ts");
  const bridge = source("../src/lib/weddingPosBridge.ts");
  const server = source("../../server/src/api/weddings.rs");

  expect(addParty).toContain("Find Groom in ROS Customers");
  expect(addParty).toContain("groomLastName");
  expect(addParty).toContain("First Name");
  expect(addParty).toContain("Last Name");
  expect(addParty).toContain("Save & Start Groom Wedding Order");
  expect(addParty).toContain("openWeddingMemberInRegister");
  expect(memberDetail).toContain("Find Existing ROS Customer");
  expect(memberDetail).toContain("Add & Start Wedding Order");
  expect(memberDetail).toContain("Party Member Type");
  expect(dashboard).toContain("api.createParty(newParty)");
  expect(weddingClient).toContain("customer_id: memberData.customerId");
  expect(weddingClient).toContain("quick_create_customer: true");
  expect(depositWorkspace).toContain("quick_create_customer: true");
  expect(roles).toContain('"Groom"');
  expect(roles).toContain('"Groomsman"');
  expect(roles).toContain('"Father"');
  expect(roles).toContain('"Child"');
  expect(roles).toContain('"Other"');
  expect(bridge).toContain("openWeddingMemberInRegister");
  expect(server).toContain("quick_create_customer must be true");
});

test("new and existing Customers become immediately visible to Register wedding context", async ({
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phoneSuffix = String(Date.now()).slice(-4);
  const headers = { ...staffHeaders(), "Content-Type": "application/json" };
  const eventDate = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
  const json = async <T>(response: APIResponse): Promise<T> => {
    const text = await response.text();
    expect(response.status(), text).toBe(200);
    return JSON.parse(text) as T;
  };

  const party = await json<{ id: string }>(await request.post(`${apiBase()}/api/weddings/parties`, {
    headers,
    data: {
      party_name: `Customer Link ${suffix}`,
      groom_name: `Wedding Groom ${suffix}`,
      event_date: eventDate,
      party_type: "Wedding",
      start_empty: true,
    },
  }));

  const quickMember = await json<{ id: string; customer_id: string; role: string }>(await request.post(
    `${apiBase()}/api/weddings/parties/${party.id}/members`,
    {
      headers,
      data: {
        quick_create_customer: true,
        first_name: "Quick",
        last_name: `Member ${suffix}`,
        email: `quick-${suffix}@example.com`,
        phone: `716555${phoneSuffix}`,
        role: "Child",
        marketing_email_opt_in: false,
        marketing_sms_opt_in: false,
      },
    },
  ));
  expect(quickMember.customer_id).toBeTruthy();
  expect(quickMember.role).toBe("Child");

  const quickCustomer = await json<{ first_name: string; last_name: string; email: string }>(await request.get(
    `${apiBase()}/api/customers/${quickMember.customer_id}`,
    { headers: staffHeaders() },
  ));
  expect(quickCustomer.first_name).toBe("Quick");
  expect(quickCustomer.last_name).toBe(`Member ${suffix}`);
  expect(quickCustomer.email).toBe(`quick-${suffix}@example.com`);

  const quickContext = await json<{ memberships: Array<Record<string, unknown>> }>(await request.get(
    `${apiBase()}/api/weddings/customers/${quickMember.customer_id}/purchase-context`,
    { headers: staffHeaders() },
  ));
  expect(quickContext.memberships).toEqual(expect.arrayContaining([
    expect.objectContaining({
      wedding_member_id: quickMember.id,
      wedding_party_id: party.id,
      customer_id: quickMember.customer_id,
      role: "Child",
    }),
  ]));

  const existingCustomer = await json<{ id: string }>(await request.post(`${apiBase()}/api/customers`, {
    headers,
    data: {
      first_name: "Existing",
      last_name: `Customer ${suffix}`,
      email: `existing-${suffix}@example.com`,
      phone: `716556${phoneSuffix}`,
      marketing_email_opt_in: false,
      marketing_sms_opt_in: false,
      transactional_sms_opt_in: false,
      transactional_email_opt_in: false,
    },
  }));
  const linkedMember = await json<{ id: string; customer_id: string }>(await request.post(
    `${apiBase()}/api/weddings/parties/${party.id}/members`,
    {
      headers,
      data: { customer_id: existingCustomer.id, role: "Father" },
    },
  ));
  expect(linkedMember.customer_id).toBe(existingCustomer.id);

  const linkedContext = await json<{ memberships: Array<Record<string, unknown>> }>(await request.get(
    `${apiBase()}/api/weddings/customers/${existingCustomer.id}/purchase-context`,
    { headers: staffHeaders() },
  ));
  expect(linkedContext.memberships).toEqual(expect.arrayContaining([
    expect.objectContaining({
      wedding_member_id: linkedMember.id,
      wedding_party_id: party.id,
      customer_id: existingCustomer.id,
      role: "Father",
    }),
  ]));
});
