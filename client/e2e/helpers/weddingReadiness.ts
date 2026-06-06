import { expect, type APIRequestContext } from "@playwright/test";
import {
  apiBase,
  ensureSessionAuth,
  staffCode,
  staffHeaders,
  verifyStaffId,
} from "./rmsCharge";
import type { CreatedProduct } from "./inventoryReceiving";

export type CheckoutResponse = { transaction_id: string };

export type AttachedWeddingMember = {
  id: string;
  wedding_party_id: string;
};

export type TransactionDetail = {
  items: Array<{
    transaction_line_id: string;
    sku: string;
    order_lifecycle_status: string;
  }>;
};

export type ReadinessStatus = "safe" | "watch" | "at_risk" | "critical" | "complete";

export type ReadinessDetail = {
  status: ReadinessStatus;
  lifecycle: {
    needs_measurements: number;
    ntbo: number;
    ordered: number;
    ready_for_pickup: number;
    picked_up: number;
    open: number;
  };
  pickup: {
    ready_members: number;
    blocked_members: number;
    partial_ready_members: number;
    balance_blocked_members: number;
  };
  vendor_risk: {
    delayed_vendor_count: number;
    missing_vendor_count: number;
  };
  blockers: Array<{ label: string; next_safe_action: string }>;
  members: Array<{ status: string; blockers: Array<{ label: string }> }>;
};

export const WEDDING_READINESS_UNIT_PRICE = "49.99";
export const WEDDING_READINESS_UNIT_COST = "20.00";

export function addDays(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split("T")[0]!;
}

function totalFor(products: CreatedProduct[]): string {
  return (products.length * Number.parseFloat(WEDDING_READINESS_UNIT_PRICE)).toFixed(2);
}

export async function checkoutWeddingOrderSeed(
  request: APIRequestContext,
  options: {
    customerId: string;
    products: CreatedProduct[];
    amountPaid?: string;
    orderLifecycleStatus?: "needs_measurements" | "ntbo";
  },
): Promise<CheckoutResponse> {
  const { sessionId, sessionToken } = await ensureSessionAuth(request);
  const operatorStaffId = await verifyStaffId(request);
  const total = totalFor(options.products);
  const amountPaid = options.amountPaid ?? total;
  const res = await request.post(`${apiBase()}/api/transactions/checkout`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
      "x-riverside-pos-session-id": sessionId,
      "x-riverside-pos-session-token": sessionToken,
    },
    data: {
      session_id: sessionId,
      operator_staff_id: operatorStaffId,
      primary_salesperson_id: operatorStaffId,
      customer_id: options.customerId,
      payment_method: "cash",
      total_price: total,
      amount_paid: amountPaid,
      payment_splits:
        Number.parseFloat(amountPaid) > 0
          ? [{ payment_method: "cash", amount: amountPaid }]
          : [],
      is_tax_exempt: true,
      tax_exempt_reason: "Phase 4 readiness certification",
      checkout_client_id: crypto.randomUUID(),
      items: options.products.map((product) => ({
        product_id: product.productId,
        variant_id: product.variantId,
        fulfillment: "special_order",
        quantity: 1,
        unit_price: WEDDING_READINESS_UNIT_PRICE,
        unit_cost: WEDDING_READINESS_UNIT_COST,
        state_tax: "0.00",
        local_tax: "0.00",
        salesperson_id: operatorStaffId,
        order_lifecycle_status: options.orderLifecycleStatus,
      })),
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as CheckoutResponse;
}

export async function attachToNewWedding(
  request: APIRequestContext,
  transactionId: string,
  suffix: string,
  daysUntilEvent: number,
  options?: {
    partyNamePrefix?: string;
    actorName?: string;
  },
): Promise<AttachedWeddingMember> {
  const partyNamePrefix = options?.partyNamePrefix ?? "Phase 4 Readiness";
  const actorName = options?.actorName ?? "Phase 4 Readiness Certification";
  const res = await request.post(`${apiBase()}/api/weddings/attach-order`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      transaction_id: transactionId,
      role: "Groomsman",
      new_party_info: {
        party_name: `${partyNamePrefix} ${suffix}`,
        groom_name: `Phase 4 Groom ${suffix}`,
        event_date: addDays(daysUntilEvent),
        party_type: "Wedding",
      },
      actor_name: actorName,
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as AttachedWeddingMember;
}

export async function fetchTransactionDetail(
  request: APIRequestContext,
  transactionId: string,
): Promise<TransactionDetail> {
  const res = await request.get(`${apiBase()}/api/transactions/${transactionId}`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as TransactionDetail;
}

export async function fetchReadiness(
  request: APIRequestContext,
  partyId: string,
): Promise<ReadinessDetail> {
  const res = await request.get(`${apiBase()}/api/weddings/parties/${partyId}/readiness`, {
    headers: staffHeaders(),
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
  return JSON.parse(bodyText) as ReadinessDetail;
}

export async function transitionLine(
  request: APIRequestContext,
  lineId: string,
  data: Record<string, unknown>,
) {
  const res = await request.post(`${apiBase()}/api/order-lifecycle/items/${lineId}/transition`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data,
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}

export async function markLineReceived(
  request: APIRequestContext,
  lineId: string,
  reason = "Phase 4 readiness item received before pickup prep",
) {
  await transitionLine(request, lineId, {
    next_status: "received",
    reason,
  });
}

export async function markLineReadyForPickup(
  request: APIRequestContext,
  lineId: string,
  reason = "Phase 4 readiness item ready after receipt",
) {
  await transitionLine(request, lineId, {
    next_status: "ready_for_pickup",
    override_checks: true,
    manager_staff_code: staffCode(),
    manager_pin: staffCode(),
    reason,
  });
}

export async function pickupLine(
  request: APIRequestContext,
  transactionId: string,
  lineId: string,
) {
  const res = await request.post(`${apiBase()}/api/transactions/${transactionId}/pickup`, {
    headers: {
      ...staffHeaders(),
      "Content-Type": "application/json",
    },
    data: {
      actor: "Phase 4 Readiness Certification",
      delivered_item_ids: [lineId],
    },
    failOnStatusCode: false,
  });
  const bodyText = await res.text();
  expect(res.status(), bodyText.slice(0, 1000)).toBe(200);
}
