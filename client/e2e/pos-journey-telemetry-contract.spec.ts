import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { apiBase, ensureSessionAuth, staffHeaders } from "./helpers/rmsCharge";

const clientRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(clientRoot, "..");

async function clientSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(clientRoot, "src", relativePath), "utf8");
}

async function repoSource(relativePath: string): Promise<string> {
  return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

test("Register telemetry submits only allowlisted journey measurements", async () => {
  const telemetry = await clientSource("lib/posJourneyTelemetry.ts");

  for (const phase of [
    "search_to_result",
    "scan_to_line",
    "pay_open",
    "tender_confirmed",
    "receipt_ready",
    "close_complete",
  ]) {
    expect(telemetry).toContain(`"${phase}"`);
  }

  expect(telemetry).toContain("/api/pos/journey-metrics");
  expect(telemetry).toContain("getPosRegisterAuth()");
  expect(telemetry).toContain("posRegisterAuthHeaders()");
  expect(telemetry).toContain("keepalive: true");
  expect(telemetry).not.toMatch(/customer|search_text|receipt_content|card_number|pin:/i);
});

test("server ingestion requires the exact active Register session and rejects arbitrary fields", async () => {
  const api = await repoSource("server/src/api/pos.rs");
  const metrics = await repoSource("server/src/logic/operation_metrics.rs");

  expect(api).toContain("require_pos_register_session_for_checkout");
  expect(api).toContain("#[serde(deny_unknown_fields)]");
  expect(api).toContain("MAX_POS_JOURNEY_SAMPLES: usize = 20");
  expect(api).toContain("MAX_POS_JOURNEY_DURATION_MS: f64 = 600_000.0");
  expect(metrics).toContain("VALUES ('pos_journey'");
  expect(metrics).toContain("transaction_id,\n                register_session_id");
  expect(metrics).toContain("client_build_sha");
  expect(metrics).toContain("station_key");
});

test("all six workflow boundaries and the protected Ops summary are wired", async () => {
  const search = await clientSource("hooks/usePosSearch.ts");
  const cartActions = await clientSource("hooks/useCartActions.ts");
  const cart = await clientSource("components/pos/Cart.tsx");
  const payment = await clientSource("components/pos/NexoCheckoutDrawer.tsx");
  const checkout = await clientSource("hooks/useCartCheckout.ts");
  const receipt = await clientSource("components/pos/ReceiptSummaryModal.tsx");
  const close = await clientSource("components/pos/CloseRegisterModal.tsx");
  const ops = await clientSource("components/operations/PosJourneyMetricsPanel.tsx");

  expect(search).toContain('startPosJourneyTiming("search_to_result")');
  expect(cartActions).toContain('startPosJourneyTiming("scan_to_line")');
  expect(cart).toContain('startPosJourneyTiming("pay_open")');
  expect(payment).toContain('finishPosJourneyTimingAfterPaint("pay_open", true)');
  expect(payment).toContain('startPosJourneyTiming("tender_confirmed")');
  expect(checkout).toContain('startPosJourneyTiming("receipt_ready")');
  expect(receipt).toContain('finishPosJourneyTimingAfterPaint("receipt_ready", true)');
  expect(close).toContain('startPosJourneyTiming("close_complete")');
  expect(ops).toContain("/api/ops/metrics");
  expect(ops).toContain('row.operation === "pos_journey"');
  expect(ops).toContain("No customer, search,");
});

test("active Register session can record allowlisted samples for the Ops summary", async ({
  request,
}) => {
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const headers = {
    ...staffHeaders(),
    "Content-Type": "application/json",
    "x-riverside-pos-session-id": sessionId,
    "x-riverside-pos-session-token": sessionToken,
    "x-riverside-station-key": "station-e2e",
  };

  const accepted = await request.post(`${apiBase()}/api/pos/journey-metrics`, {
    headers,
    data: {
      register_session_id: sessionId,
      samples: [
        {
          phase: "search_to_result",
          duration_ms: 125.5,
          success: true,
          runtime_surface: "browser_tab",
          online: true,
        },
        {
          phase: "receipt_ready",
          duration_ms: 410,
          success: false,
          runtime_surface: "browser_tab",
          online: true,
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(accepted.status()).toBe(200);
  expect(await accepted.json()).toEqual({ recorded: 2 });

  const rejected = await request.post(`${apiBase()}/api/pos/journey-metrics`, {
    headers,
    data: {
      register_session_id: sessionId,
      samples: [
        {
          phase: "search_to_result",
          duration_ms: 10,
          success: true,
          runtime_surface: "browser_tab",
          online: true,
          customer_name: "must not be accepted",
        },
      ],
    },
    failOnStatusCode: false,
  });
  expect(rejected.status()).toBe(422);

  const summary = await request.get(`${apiBase()}/api/ops/metrics`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  expect(summary.status()).toBe(200);
  const body = (await summary.json()) as {
    phases?: Array<{ operation: string; phase: string; sample_count: number }>;
  };
  expect(body.phases).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "pos_journey",
        phase: "search_to_result",
        sample_count: expect.any(Number),
      }),
      expect.objectContaining({
        operation: "pos_journey",
        phase: "receipt_ready",
        sample_count: expect.any(Number),
      }),
    ]),
  );
});
