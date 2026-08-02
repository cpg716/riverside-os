import type {
  CartLineItem,
  CheckoutOperatorContext,
  CheckoutPayload,
  WeddingMember,
} from "../components/pos/types";
import type { WeddingCollectBuildDraft } from "../hooks/useParkedSales";
import { isNonTaxableServiceLine } from "./cartTax";
import { centsToFixed2, parseMoneyToCents } from "./money";

export type FundedWeddingOrderSource = {
  workflowId: string;
  sourceCreditLedgerId: string;
  remainingCents: number;
};

export type WeddingOrderBatchAmounts = {
  totalCents: number;
  depositAppliedCents: number;
  balanceDueCents: number;
};

function taxCategoryOverride(
  category: CartLineItem["tax_category"],
): "clothing" | "footwear" | "service" | "other" | undefined {
  return category === "clothing" ||
    category === "footwear" ||
    category === "service" ||
    category === "other"
    ? category
    : undefined;
}

export function weddingOrderBatchAmounts(
  draft: WeddingCollectBuildDraft,
  sourceRemainingCents: number,
): WeddingOrderBatchAmounts {
  const totalCents = draft.lines.reduce((sum, line) => {
    const quantity = Math.max(0, line.quantity);
    const noTax = draft.isTaxExempt || isNonTaxableServiceLine(line);
    return (
      sum +
      (parseMoneyToCents(line.standard_retail_price) +
        (noTax ? 0 : parseMoneyToCents(line.state_tax)) +
        (noTax ? 0 : parseMoneyToCents(line.local_tax))) *
        quantity
    );
  }, 0);
  const depositAppliedCents = Math.min(
    Math.max(0, sourceRemainingCents),
    Math.max(0, totalCents),
  );
  return {
    totalCents,
    depositAppliedCents,
    balanceDueCents: Math.max(0, totalCents - depositAppliedCents),
  };
}

export function buildWeddingMemberCheckoutPayload({
  sessionId,
  operator,
  member,
  draft,
  source,
}: {
  sessionId: string;
  operator: CheckoutOperatorContext;
  member: WeddingMember;
  draft: WeddingCollectBuildDraft;
  source: FundedWeddingOrderSource;
}): { payload: CheckoutPayload; amounts: WeddingOrderBatchAmounts } {
  if (draft.lines.length === 0) {
    throw new Error(`Add merchandise for ${member.first_name} ${member.last_name}.`);
  }
  if (!draft.salespersonId.trim()) {
    throw new Error(`Select a salesperson for ${member.first_name} ${member.last_name}.`);
  }
  if (draft.isTaxExempt && !draft.taxExemptReason?.trim()) {
    throw new Error(`Enter the No Tax reason for ${member.first_name} ${member.last_name}.`);
  }
  if (
    draft.lines.some(
      (line) =>
        line.line_type !== "alteration_service" &&
        line.fulfillment !== "wedding_order",
    )
  ) {
    throw new Error(
      `${member.first_name} ${member.last_name}'s Builder contains an item that is not marked Order (Wedding).`,
    );
  }

  const activeLineIds = new Set(draft.lines.map((line) => line.cart_row_id));
  const alterationLines = draft.lines.filter(
    (line) => line.line_type === "alteration_service",
  );
  const alterationLinesByIntake = new Map(
    alterationLines
      .filter((line) => line.alteration_intake_id)
      .map((line) => [line.alteration_intake_id!, line]),
  );
  if (alterationLinesByIntake.size !== alterationLines.length) {
    throw new Error(
      `${member.first_name} ${member.last_name} has an alteration charge without its intake record.`,
    );
  }
  for (const intake of draft.alterationIntakes) {
    const alterationLine = alterationLinesByIntake.get(intake.id);
    if (
      !alterationLine ||
      !intake.alteration_cart_row_id ||
      alterationLine.cart_row_id !== intake.alteration_cart_row_id
    ) {
      throw new Error(
        `${member.first_name} ${member.last_name} has an alteration intake without its matching charge.`,
      );
    }
    if (
      intake.source_type === "current_cart_item" &&
      (!intake.cart_row_id || !activeLineIds.has(intake.cart_row_id))
    ) {
      throw new Error(
        `${member.first_name} ${member.last_name} has an alteration tied to an item that is no longer in the draft.`,
      );
    }
    const intakeChargeCents = intake.charge_amount?.trim()
      ? parseMoneyToCents(intake.charge_amount)
      : 0;
    if (
      parseMoneyToCents(alterationLine.standard_retail_price) !==
      intakeChargeCents
    ) {
      throw new Error(
        `${member.first_name} ${member.last_name}'s alteration charge does not match its intake.`,
      );
    }
  }
  const intakeIds = new Set(draft.alterationIntakes.map((intake) => intake.id));
  if (
    alterationLines.some(
      (line) =>
        !line.alteration_intake_id ||
        !intakeIds.has(line.alteration_intake_id),
    )
  ) {
    throw new Error(
      `${member.first_name} ${member.last_name} has an orphan alteration charge.`,
    );
  }

  const amounts = weddingOrderBatchAmounts(draft, source.remainingCents);
  if (amounts.totalCents <= 0 || amounts.depositAppliedCents <= 0) {
    throw new Error(
      `${member.first_name} ${member.last_name} needs both merchandise and an available funded deposit before posting.`,
    );
  }

  const paymentSplits = [
    {
      payment_method: "open_deposit",
      amount: centsToFixed2(amounts.depositAppliedCents),
      metadata: {
        tender_family: "open_deposit",
        held_for_customer_id: member.customer_id,
        source: "wedding_party_split",
        wedding_deposit_workflow_id: source.workflowId,
        wedding_deposit_source_credit_ledger_id:
          source.sourceCreditLedgerId,
      },
    },
  ];

  return {
    amounts,
    payload: {
      session_id: sessionId,
      operator_staff_id: operator.staffId,
      primary_salesperson_id: draft.salespersonId.trim(),
      customer_id: member.customer_id,
      wedding_member_id: member.id,
      payment_method: "open_deposit",
      total_price: centsToFixed2(amounts.totalCents),
      amount_paid: centsToFixed2(amounts.depositAppliedCents),
      checkout_client_id: draft.checkoutClientId,
      fulfillment_mode: "pickup",
      actor_name: operator.fullName.trim() || null,
      payment_splits: paymentSplits,
      is_tax_exempt: draft.isTaxExempt,
      tax_exempt_reason: draft.isTaxExempt
        ? draft.taxExemptReason?.trim()
        : undefined,
      items: draft.lines.map((line) => {
        const noTax = draft.isTaxExempt || isNonTaxableServiceLine(line);
        const unitCents = parseMoneyToCents(line.standard_retail_price);
        const originalUnitCents =
          line.original_unit_price == null
            ? unitCents
            : parseMoneyToCents(line.original_unit_price);
        return {
          client_line_id: line.cart_row_id,
          line_type: line.line_type ?? "merchandise",
          product_id: line.product_id,
          variant_id: line.variant_id,
          fulfillment:
            line.line_type === "alteration_service"
              ? line.fulfillment
              : "wedding_order",
          quantity: line.quantity,
          unit_price: centsToFixed2(unitCents),
          original_unit_price:
            originalUnitCents !== unitCents
              ? centsToFixed2(originalUnitCents)
              : undefined,
          price_override_reason: line.price_override_reason,
          unit_cost: centsToFixed2(parseMoneyToCents(line.unit_cost)),
          state_tax: centsToFixed2(
            noTax ? 0 : parseMoneyToCents(line.state_tax),
          ),
          local_tax: centsToFixed2(
            noTax ? 0 : parseMoneyToCents(line.local_tax),
          ),
          tax_category_override: taxCategoryOverride(line.tax_category),
          salesperson_id: line.salesperson_id?.trim() || draft.salespersonId.trim(),
          custom_item_type: line.custom_item_type,
          custom_order_details: line.custom_order_details ?? undefined,
          is_rush: line.is_rush,
          need_by_date: line.need_by_date ?? null,
          needs_gift_wrap: line.needs_gift_wrap,
          order_lifecycle_status:
            line.order_lifecycle_status === "needs_measurements"
              ? "needs_measurements"
              : undefined,
          ...(line.discount_event_id
            ? { discount_event_id: line.discount_event_id }
            : {}),
        };
      }),
      alteration_intakes: draft.alterationIntakes.map((intake) => ({
        intake_id: intake.id,
        alteration_line_client_id: intake.alteration_cart_row_id!,
        source_client_line_id: intake.cart_row_id ?? null,
        source_type: intake.source_type,
        item_description: intake.item_description,
        work_requested: intake.work_requested,
        capacity_bucket: intake.capacity_bucket ?? null,
        capacity_units: intake.capacity_units ?? null,
        source_product_id: intake.source_product_id ?? null,
        source_variant_id: intake.source_variant_id ?? null,
        source_sku: intake.source_sku ?? null,
        source_transaction_id: intake.source_transaction_id ?? null,
        source_transaction_line_id: intake.source_transaction_line_id ?? null,
        charge_amount: intake.charge_amount ?? null,
        due_at: intake.due_at ?? null,
        notes: intake.notes ?? null,
        ticket_number: intake.ticket_number ?? null,
        intake_mode: intake.intake_mode ?? "full",
      })),
    },
  };
}
