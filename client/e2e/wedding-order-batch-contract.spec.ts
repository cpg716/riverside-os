import { expect, test } from "@playwright/test";

import type { CartLineItem, WeddingMember } from "../src/components/pos/types";
import type { WeddingCollectBuildDraft } from "../src/hooks/useParkedSales";
import {
  buildWeddingMemberCheckoutPayload,
  weddingOrderBatchAmounts,
} from "../src/lib/weddingOrderBatch";

const member: WeddingMember = {
  id: "member-1",
  customer_id: "customer-1",
  first_name: "Cory",
  last_name: "Knadle",
  role: "Groomsman",
  status: "active",
  measured: false,
  suit_ordered: false,
  is_free_suit_promo: false,
};

const line: CartLineItem = {
  product_id: "product-1",
  variant_id: "variant-1",
  sku: "15149-221-12-D",
  name: "Florsheim Postino CapToe Oxford",
  variation_label: "12 / D",
  standard_retail_price: "150.00",
  unit_cost: "60.00",
  state_tax: "6.00",
  local_tax: "7.13",
  tax_category: "footwear",
  quantity: 1,
  fulfillment: "wedding_order",
  cart_row_id: "line-1",
};

function draft(overrides: Partial<WeddingCollectBuildDraft> = {}): WeddingCollectBuildDraft {
  return {
    member,
    lines: [line],
    salespersonId: "staff-1",
    checkoutClientId: "checkout-member-1",
    isTaxExempt: false,
    taxExemptReason: null,
    alterationIntakes: [],
    ...overrides,
  };
}

test("member batch checkout uses one exact held source and keeps any balance due", () => {
  const reviewed = draft();
  expect(weddingOrderBatchAmounts(reviewed, 10000)).toEqual({
    totalCents: 16313,
    depositAppliedCents: 10000,
    balanceDueCents: 6313,
  });

  const { payload } = buildWeddingMemberCheckoutPayload({
    sessionId: "session-1",
    operator: { staffId: "operator-1", fullName: "Chris G" },
    member,
    draft: reviewed,
    source: {
      workflowId: "workflow-1",
      sourceCreditLedgerId: "ledger-1",
      remainingCents: 10000,
    },
  });

  expect(payload.customer_id).toBe(member.customer_id);
  expect(payload.wedding_member_id).toBe(member.id);
  expect(payload.checkout_client_id).toBe("checkout-member-1");
  expect(payload.total_price).toBe("163.13");
  expect(payload.amount_paid).toBe("100.00");
  expect(payload.payment_splits).toEqual([
    expect.objectContaining({
      payment_method: "open_deposit",
      amount: "100.00",
      metadata: expect.objectContaining({
        wedding_deposit_workflow_id: "workflow-1",
        wedding_deposit_source_credit_ledger_id: "ledger-1",
        held_for_customer_id: member.customer_id,
      }),
    }),
  ]);
});

test("No Tax is explicit per member and requires a reason", () => {
  expect(() =>
    buildWeddingMemberCheckoutPayload({
      sessionId: "session-1",
      operator: { staffId: "operator-1", fullName: "Chris G" },
      member,
      draft: draft({ isTaxExempt: true, taxExemptReason: "" }),
      source: {
        workflowId: "workflow-1",
        sourceCreditLedgerId: "ledger-1",
        remainingCents: 10000,
      },
    }),
  ).toThrow("Enter the No Tax reason");

  const { payload, amounts } = buildWeddingMemberCheckoutPayload({
    sessionId: "session-1",
    operator: { staffId: "operator-1", fullName: "Chris G" },
    member,
    draft: draft({ isTaxExempt: true, taxExemptReason: "Out of State" }),
    source: {
      workflowId: "workflow-1",
      sourceCreditLedgerId: "ledger-1",
      remainingCents: 10000,
    },
  });

  expect(amounts.totalCents).toBe(15000);
  expect(payload.is_tax_exempt).toBe(true);
  expect(payload.tax_exempt_reason).toBe("Out of State");
  expect(payload.items).toEqual([
    expect.objectContaining({ state_tax: "0.00", local_tax: "0.00" }),
  ]);
});

test("non-wedding merchandise cannot silently enter the batch", () => {
  expect(() =>
    buildWeddingMemberCheckoutPayload({
      sessionId: "session-1",
      operator: { staffId: "operator-1", fullName: "Chris G" },
      member,
      draft: draft({ lines: [{ ...line, fulfillment: "takeaway" }] }),
      source: {
        workflowId: "workflow-1",
        sourceCreditLedgerId: "ledger-1",
        remainingCents: 10000,
      },
    }),
  ).toThrow("not marked Order (Wedding)");
});

test("alteration intake stays attached to its exact member charge", () => {
  const alterationLine: CartLineItem = {
    product_id: "alteration-product",
    variant_id: "alteration-variant",
    sku: "ROS-ALTERATION-FEE",
    name: "Alteration Service",
    variation_label: "Hem",
    standard_retail_price: "25.00",
    unit_cost: "0.00",
    state_tax: "0.00",
    local_tax: "0.00",
    tax_category: "service",
    quantity: 1,
    fulfillment: "takeaway",
    line_type: "alteration_service",
    alteration_intake_id: "intake-1",
    cart_row_id: "alteration-line-1",
  };
  const reviewed = draft({
    lines: [line, alterationLine],
    alterationIntakes: [
      {
        id: "intake-1",
        customer_id: member.customer_id,
        customer_name: "Cory Knadle",
        source_type: "current_cart_item",
        alteration_cart_row_id: alterationLine.cart_row_id,
        cart_row_id: line.cart_row_id,
        item_description: line.name,
        work_requested: "Hem trousers",
        charge_amount: "25.00",
        created_at: "2026-08-02T12:00:00Z",
      },
    ],
  });

  const { payload } = buildWeddingMemberCheckoutPayload({
    sessionId: "session-1",
    operator: { staffId: "operator-1", fullName: "Chris G" },
    member,
    draft: reviewed,
    source: {
      workflowId: "workflow-1",
      sourceCreditLedgerId: "ledger-1",
      remainingCents: 20000,
    },
  });

  expect(payload.alteration_intakes).toEqual([
    expect.objectContaining({
      intake_id: "intake-1",
      alteration_line_client_id: "alteration-line-1",
      source_client_line_id: "line-1",
      charge_amount: "25.00",
    }),
  ]);
});
