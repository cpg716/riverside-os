import { expect, test } from "@playwright/test";
import { apiBase, staffHeaders } from "./helpers/rmsCharge";

test("manager tracker archive preserves linked source work and can be reopened", async ({
  request,
}) => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const headers = { ...staffHeaders(), "Content-Type": "application/json" };
  const eventDate = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);

  const partyRes = await request.post(`${apiBase()}/api/weddings/parties`, {
    headers,
    data: {
      party_name: `Closeout Certification ${suffix}`,
      groom_name: `Closeout Groom ${suffix}`,
      event_date: eventDate,
      party_type: "Wedding",
      start_empty: true,
    },
  });
  expect(partyRes.status(), await partyRes.text()).toBe(200);
  const partyBody = await partyRes.json();
  const partyId = partyBody.id as string;

  const memberRes = await request.post(
    `${apiBase()}/api/weddings/parties/${partyId}/members`,
    {
      headers,
      data: {
        first_name: "Closeout",
        last_name: `Member ${suffix}`,
        role: "Groomsman",
      },
    },
  );
  expect(memberRes.status(), await memberRes.text()).toBe(200);
  const member = await memberRes.json();

  const appointmentRes = await request.post(`${apiBase()}/api/weddings/appointments`, {
    headers,
    data: {
      wedding_member_id: member.id,
      appointment_type: "Fitting",
      starts_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      status: "Scheduled",
    },
  });
  expect(appointmentRes.status(), await appointmentRes.text()).toBe(200);

  const summaryRes = await request.get(
    `${apiBase()}/api/weddings/parties/${partyId}/closeout`,
    { headers: staffHeaders() },
  );
  expect(summaryRes.status(), await summaryRes.text()).toBe(200);
  const summary = await summaryRes.json();
  expect(summary.scheduled_appointment_count).toBe(1);

  const blockedRes = await request.post(
    `${apiBase()}/api/weddings/parties/${partyId}/closeout`,
    {
      headers,
      data: {
        outcome: "legacy_record",
        reason: "Historical wedding predates complete ROS tracking",
        acknowledge_open_work: false,
      },
      failOnStatusCode: false,
    },
  );
  expect(blockedRes.status()).toBe(400);
  expect(await blockedRes.text()).toContain("explicitly acknowledge");

  const closeRes = await request.post(
    `${apiBase()}/api/weddings/parties/${partyId}/closeout`,
    {
      headers,
      data: {
        outcome: "legacy_record",
        reason: "Historical wedding predates complete ROS tracking",
        notes: "Certification verifies records remain untouched.",
        acknowledge_open_work: true,
      },
    },
  );
  expect(closeRes.status(), await closeRes.text()).toBe(200);
  const closed = await closeRes.json();
  expect(closed.closed).toBe(true);
  expect(closed.linked_source_snapshot.scheduled_appointment_count).toBe(1);

  const archivedRes = await request.get(`${apiBase()}/api/weddings/parties`, {
    headers: staffHeaders(),
    params: { show_deleted: "true", search: `Closeout Certification ${suffix}` },
  });
  expect(archivedRes.status(), await archivedRes.text()).toBe(200);
  const archived = await archivedRes.json();
  expect(archived.data).toHaveLength(1);
  expect(archived.data[0].closeout_outcome).toBe("legacy_record");
  expect(archived.data[0].closeout_reason).toContain("predates complete ROS");
  expect(archived.data[0].closed_at).toBeTruthy();

  const restoreRes = await request.post(
    `${apiBase()}/api/weddings/parties/${partyId}/restore`,
    { headers },
  );
  expect(restoreRes.status(), await restoreRes.text()).toBe(200);
  const restored = await restoreRes.json();
  expect(restored.is_deleted).toBe(false);
  expect(restored.closed_at).toBeNull();
  expect(restored.closeout_outcome).toBeNull();
});
