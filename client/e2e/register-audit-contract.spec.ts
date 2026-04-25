import { expect, test, type APIRequestContext } from "@playwright/test";
import { apiBase, staffCode, staffHeaders } from "./helpers/rmsCharge";

type OpenSessionResponse = {
  session_id: string;
  register_lane: number;
  till_close_group_id: string;
  opening_float: string;
  pos_api_token?: string | null;
};

type OpenSessionRow = {
  session_id: string;
  register_lane: number;
  till_close_group_id: string;
  lifecycle_status: string;
};

type ReconciliationResponse = {
  session_id: string;
  opening_float: string;
  expected_cash: string;
  tenders_by_lane: Array<{
    register_lane: number;
    tenders: Array<{ payment_method: string; total_amount: string; tx_count: number }>;
  }>;
};

type CloseSessionResponse = {
  status: string;
  discrepancy: string;
};

type VerifyCashierResponse = {
  staff_id: string;
};

type ParkedSaleResponse = {
  id: string;
  status: string;
};

type ParkedSaleStatusResponse = {
  id: string;
  register_session_id: string;
  status: string;
  audit_actions: string[];
};

function expectMoney(actual: string, expected: string) {
  expect(Number.parseFloat(actual)).toBeCloseTo(Number.parseFloat(expected), 2);
}

async function listOpenSessions(request: APIRequestContext): Promise<OpenSessionRow[]> {
  const res = await request.get(`${apiBase()}/api/sessions/list-open`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as OpenSessionRow[];
}

async function issuePosToken(request: APIRequestContext, sessionId: string): Promise<string> {
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/pos-api-token`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as { pos_api_token?: string };
  expect(body.pos_api_token).toBeTruthy();
  return body.pos_api_token ?? "";
}

async function verifyStaffId(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${apiBase()}/api/staff/verify-cashier-code`, {
    headers: { "Content-Type": "application/json" },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as VerifyCashierResponse;
  expect(body.staff_id).toBeTruthy();
  return body.staff_id;
}

async function fetchReconciliation(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<ReconciliationResponse> {
  const res = await request.get(`${apiBase()}/api/sessions/${sessionId}/reconciliation`, {
    headers: {
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as ReconciliationResponse;
}

async function createParkedSale(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
  staffId: string,
): Promise<ParkedSaleResponse> {
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/parked-sales`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      parked_by_staff_id: staffId,
      label: "E2E parked sale close purge",
      payload_json: {
        cart: [{ sku: "E2E-PARKED", quantity: 1 }],
        source: "register-audit-contract",
      },
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as ParkedSaleResponse;
}

async function fetchParkedSaleStatus(
  request: APIRequestContext,
  parkedSaleId: string,
): Promise<ParkedSaleStatusResponse> {
  const res = await request.get(`${apiBase()}/api/test-support/parked-sales/${parkedSaleId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as ParkedSaleStatusResponse;
}

async function closeGroupExactly(
  request: APIRequestContext,
  sessionId: string,
  sessionToken: string,
): Promise<CloseSessionResponse> {
  const recon = await fetchReconciliation(request, sessionId, sessionToken);
  const res = await request.post(`${apiBase()}/api/sessions/${sessionId}/close`, {
    headers: {
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      actual_cash: recon.expected_cash,
      closing_notes: null,
      closing_comments: null,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CloseSessionResponse;
}

async function closeExistingPrimaryGroup(request: APIRequestContext): Promise<void> {
  const rows = await listOpenSessions(request);
  const primary = rows.find((row) => row.register_lane === 1);
  if (!primary) return;
  const token = await issuePosToken(request, primary.session_id);
  await closeGroupExactly(request, primary.session_id, token);
}

async function openPrimaryRegister(request: APIRequestContext): Promise<OpenSessionResponse> {
  const res = await request.post(`${apiBase()}/api/sessions/open`, {
    headers: {
      "Content-Type": "application/json",
    },
    data: {
      cashier_code: staffCode(),
      pin: staffCode(),
      opening_float: "200.00",
      register_lane: 1,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  const body = JSON.parse(bodyText) as OpenSessionResponse;
  expect(body.session_id).toBeTruthy();
  expect(body.pos_api_token).toBeTruthy();
  expect(body.register_lane).toBe(1);
  return body;
}

test.describe("register audit contract", () => {
  test("primary register owns till close, linked lanes attach, and closed tokens stop working", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    await closeExistingPrimaryGroup(request);

    const opened = await openPrimaryRegister(request);
    const rows = await listOpenSessions(request);
    const groupRows = rows
      .filter((row) => row.till_close_group_id === opened.till_close_group_id)
      .sort((a, b) => a.register_lane - b.register_lane);
    expect(groupRows.map((row) => row.register_lane)).toEqual([1, 2, 3]);
    expect(groupRows.every((row) => row.lifecycle_status === "open")).toBe(true);

    const duplicatePrimary = await request.post(`${apiBase()}/api/sessions/open`, {
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        cashier_code: staffCode(),
        pin: staffCode(),
        opening_float: "200.00",
        register_lane: 1,
      },
      failOnStatusCode: false,
    });
    expect(duplicatePrimary.status()).toBe(409);
    await expect(duplicatePrimary.text()).resolves.toMatch(/register_lane_in_use/i);

    const satellite = groupRows.find((row) => row.register_lane === 2);
    expect(satellite).toBeTruthy();
    const satelliteAttach = await request.post(
      `${apiBase()}/api/sessions/${satellite?.session_id}/attach`,
      {
        headers: staffHeaders(),
        failOnStatusCode: false,
      },
    );
    const satelliteAttachText = await satelliteAttach.text();
    expect(satelliteAttach.status(), satelliteAttachText.slice(0, 1000)).toBe(200);
    const satelliteToken = (JSON.parse(satelliteAttachText) as { pos_api_token?: string })
      .pos_api_token;
    expect(satelliteToken).toBeTruthy();

    const satelliteClose = await request.post(
      `${apiBase()}/api/sessions/${satellite?.session_id}/close`,
      {
        headers: {
          "Content-Type": "application/json",
          "x-riverside-pos-session-id": satellite?.session_id ?? "",
          "x-riverside-pos-session-token": satelliteToken ?? "",
        },
        data: {
          actual_cash: "0.00",
          closing_notes: null,
          closing_comments: null,
        },
        failOnStatusCode: false,
      },
    );
    expect(satelliteClose.status()).toBe(400);
    await expect(satelliteClose.text()).resolves.toMatch(/Register #1 only/i);

    const recon = await fetchReconciliation(request, opened.session_id, opened.pos_api_token ?? "");
    expect(recon.session_id).toBe(opened.session_id);
    expect(recon.opening_float).toBe("200.00");
    expect(recon.expected_cash).toBe("200.00");
    expect(recon.tenders_by_lane).toEqual([]);

    const close = await closeGroupExactly(request, opened.session_id, opened.pos_api_token ?? "");
    expect(close.status).toBe("closed");
    expectMoney(close.discrepancy, "0.00");

    const afterCloseRows = await listOpenSessions(request);
    expect(
      afterCloseRows.some((row) => row.till_close_group_id === opened.till_close_group_id),
    ).toBe(false);

    const currentWithClosedToken = await request.get(`${apiBase()}/api/sessions/current`, {
      headers: {
        "x-riverside-pos-session-id": opened.session_id,
        "x-riverside-pos-session-token": opened.pos_api_token ?? "",
      },
      failOnStatusCode: false,
    });
    expect([401, 404]).toContain(currentWithClosedToken.status());

    const tokenAfterClose = await request.post(
      `${apiBase()}/api/sessions/${opened.session_id}/pos-api-token`,
      {
        headers: {
          "Content-Type": "application/json",
        },
        data: {
          cashier_code: staffCode(),
          pin: staffCode(),
        },
        failOnStatusCode: false,
      },
    );
    expect(tokenAfterClose.status()).toBe(404);
  });

  test("Z-close atomically purges server-backed parked sales and writes audit rows", async ({
    request,
  }) => {
    test.setTimeout(90_000);
    await closeExistingPrimaryGroup(request);

    const opened = await openPrimaryRegister(request);
    const staffId = await verifyStaffId(request);
    const parked = await createParkedSale(
      request,
      opened.session_id,
      opened.pos_api_token ?? "",
      staffId,
    );
    expect(parked.status).toBe("parked");

    const close = await closeGroupExactly(request, opened.session_id, opened.pos_api_token ?? "");
    expect(close.status).toBe("closed");

    const status = await fetchParkedSaleStatus(request, parked.id);
    expect(status.register_session_id).toBe(opened.session_id);
    expect(status.status).toBe("deleted");
    expect(status.audit_actions).toEqual(expect.arrayContaining(["park", "purge_on_close"]));
  });
});
