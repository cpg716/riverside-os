import { expect, test } from "@playwright/test";

function apiBase(): string {
  return (
    process.env.E2E_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    "http://127.0.0.1:43300"
  ).replace(/\/$/, "");
}

function staffHeaders(): Record<string, string> {
  const code = process.env.E2E_BO_STAFF_CODE?.trim() || "1234";
  return {
    "x-riverside-staff-code": code,
    "x-riverside-staff-pin": code,
  };
}

let serverReachable = false;

test.beforeAll(async ({ request }) => {
  try {
    const response = await request.get(`${apiBase()}/api/staff/list-for-pos`, {
      timeout: 8_000,
      failOnStatusCode: false,
    });
    serverReachable = response.status() > 0;
  } catch {
    serverReachable = false;
  }
});

test.beforeEach(() => {
  test.skip(!serverReachable, `API not reachable at ${apiBase()}`);
});

test("universal endpoint executes the authenticated handler within its no-match budget", async ({
  request,
}) => {
  const query = `zz-literal-%_-${Date.now()}`;
  const started = Date.now();
  const response = await request.get(
    `${apiBase()}/api/search/universal?q=${encodeURIComponent(query)}&limit=8`,
    {
      headers: staffHeaders(),
      timeout: 5_000,
      failOnStatusCode: false,
    },
  );
  const elapsedMs = Date.now() - started;
  const body = (await response.json()) as {
    query?: string;
    sources_failed?: string[];
    customers?: unknown[];
    orders?: unknown[];
    weddings?: unknown[];
  };

  expect(response.status(), JSON.stringify(body.sources_failed ?? [])).toBe(200);
  expect(body.query).toBe(query);
  expect(body.customers).toEqual([]);
  expect(body.orders).toEqual([]);
  expect(body.weddings).toEqual([]);
  expect(elapsedMs).toBeLessThan(1_500);
});

test("universal endpoint rejects punctuation-only queries", async ({ request }) => {
  const response = await request.get(
    `${apiBase()}/api/search/universal?q=${encodeURIComponent("%_")}&limit=8`,
    {
      headers: staffHeaders(),
      timeout: 5_000,
      failOnStatusCode: false,
    },
  );
  const body = (await response.json()) as { error?: string };

  expect(response.status()).toBe(400);
  expect(body.error).toBe("query must include at least one letter or number");
});
