import { useState, useCallback } from "react";
import {
  type CartLineItem,
  type Customer,
  type WeddingMember,
  type AppliedPaymentLine,
  type CheckoutOperatorContext,
  type CheckoutPayload,
  type CheckoutPaymentSplitPayload,
  type CartTotals,
  type PosShippingSelection,
  type PosOrderOptions,
  type PendingAlterationIntake,
  type OrderPaymentCartLine
} from "../components/pos/types";
import { parseMoneyToCents, centsToFixed2 } from "../lib/money";
import { isNonTaxableServiceLine } from "../lib/cartTax";
import { newCheckoutClientId, normalizeGiftCardSubType } from "../lib/posUtils";
import {
  clearBlockedCheckoutRecovery,
  enqueueBlockedCheckoutRecovery,
  enqueueCheckout,
} from "../lib/offlineQueue";
import { playPosScanError } from "../lib/posAudio";
import { isRegisterReconciliationLocked } from "../lib/serverRecovery";

interface UseCartCheckoutProps {
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  lines: CartLineItem[];
  selectedCustomer: Customer | null;
  activeWeddingMember: WeddingMember | null;
  cashierName?: string | null;
  primarySalespersonId: string;
  disbursementMembers: WeddingMember[];
  posShipping: PosShippingSelection | null;
  pendingAlterationIntakes: PendingAlterationIntake[];
  orderPaymentLines: OrderPaymentCartLine[];
  pickupAlterationIds?: string[];
  pickupConfirmed: boolean;
  pickupTransactionId: string | null;
  pickupTransactions?: PickupTransactionSelection[];
  belowCostApproval: {
    approvedByStaffId: string;
    reason?: string;
    lineSignature?: string;
  } | null;
  saleDateTimeLocal?: string | null;
  backdateApproval: {
    approvedByStaffId: string;
    reason: string;
  } | null;
  totals: CartTotals;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  clearCart: () => void;
  onSaleCompleted?: () => void;
  ensurePosTokenForSession: () => Promise<string | null>;
  requestPickupPaymentOverride?: (message: string) => Promise<NonNullable<PosOrderOptions["pickupPaymentOverride"]> | null>;
}

export interface PickupTransactionSelection {
  transactionId: string;
  lineIds: string[];
}

interface CheckoutExecutionOverrides {
  linesOverride?: CartLineItem[];
  totalsOverride?: CartTotals;
  clearAfterCheckout?: boolean;
  emitSaleCompleted?: boolean;
  showSuccessToast?: boolean;
  exchangeSettlement?: CheckoutPayload["exchange_settlement"];
}

export function buildCheckoutPaymentSplits(
  applied: AppliedPaymentLine[],
  depositCents: number,
): { paymentSplits: CheckoutPaymentSplitPayload[]; unallocatedDepositCents: number } {
  let remainingDepositAllocationCents = Math.max(0, depositCents);
  const paymentSplits: CheckoutPaymentSplitPayload[] = applied.map((p) => {
    const split: CheckoutPaymentSplitPayload = {
      payment_method: p.method,
      amount: centsToFixed2(p.amountCents),
    };
    if (remainingDepositAllocationCents > 0) {
      const depositForSplitCents = Math.min(remainingDepositAllocationCents, p.amountCents);
      if (depositForSplitCents > 0) {
        split.applied_deposit_amount = centsToFixed2(depositForSplitCents);
        remainingDepositAllocationCents -= depositForSplitCents;
      }
    }
    const subtype = normalizeGiftCardSubType(p.sub_type);
    if (subtype) split.sub_type = subtype;
    if (p.method === "gift_card" && p.gift_card_code) {
      split.gift_card_code = p.gift_card_code;
    }
    if (p.method === "check" && p.metadata?.check_number) {
      split.check_number = p.metadata.check_number;
    }
    if (p.metadata) {
      split.metadata = p.metadata;
    }
    return split;
  });

  return {
    paymentSplits,
    unallocatedDepositCents: remainingDepositAllocationCents,
  };
}

function cashChangeDueCents(applied: AppliedPaymentLine[]): number {
  return applied.reduce((max, payment) => {
    if (payment.method !== "cash") return max;
    const raw = payment.metadata?.change_due_cents;
    return typeof raw === "number" && Number.isFinite(raw) ? Math.max(max, raw) : max;
  }, 0);
}

function hasProviderBackedPayment(applied: AppliedPaymentLine[]): boolean {
  return applied.some((payment) => {
    const provider = payment.metadata?.payment_provider;
    return typeof provider === "string" && provider.trim().length > 0;
  });
}

function isTransientSessionProbeStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function checkoutResponseError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  }
  const text = await response.text().catch(() => "");
  return text.trim() || `Checkout failed (${response.status})`;
}

async function recordBlockedCheckoutRecovery(
  payload: CheckoutPayload,
  status: number,
  message: string,
  options: Parameters<typeof enqueueBlockedCheckoutRecovery>[3],
): Promise<void> {
  try {
    await enqueueBlockedCheckoutRecovery(payload, status, message, options);
  } catch (err) {
    console.error("Checkout recovery record could not be saved", err);
  }
}

export function maxCollectableTenderCents(
  collectTotalCents: number,
  depositCents: number,
  roundingAdjustmentCents = 0,
): number {
  return Math.max(collectTotalCents, Math.max(0, depositCents)) + roundingAdjustmentCents;
}

export function optionalCentsField(cents: number | undefined): string | undefined {
  return cents != null ? centsToFixed2(cents) : undefined;
}

export function checkoutTaxCategoryOverride(
  category?: CartLineItem["tax_category"],
): "clothing" | "footwear" | "service" | "other" | undefined {
  return category === "clothing" || category === "footwear" || category === "service" || category === "other"
    ? category
    : undefined;
}

function weddingDisbursementAmountCents(member: WeddingMember): number {
  return parseMoneyToCents(member.split_deposit_amount ?? member.balance_due ?? "0");
}

export function useCartCheckout({
  sessionId,
  baseUrl,
  apiAuth,
  lines,
  selectedCustomer,
  activeWeddingMember,
  cashierName,
  primarySalespersonId,
  disbursementMembers,
  posShipping,
  pendingAlterationIntakes,
  orderPaymentLines,
  pickupAlterationIds = [],
  pickupConfirmed,
  pickupTransactionId,
  pickupTransactions = [],
  belowCostApproval,
  saleDateTimeLocal,
  backdateApproval,
  totals,
  toast,
  clearCart,
  onSaleCompleted,
  ensurePosTokenForSession,
  requestPickupPaymentOverride,
}: UseCartCheckoutProps) {
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [lastTransactionId, setLastTransactionId] = useState<string | null>(null);
  const [lastCashChangeDueCents, setLastCashChangeDueCents] = useState(0);
  const [lastReceiptTransactionLineIds, setLastReceiptTransactionLineIds] = useState<string[]>([]);
  const [checkoutClientId, setCheckoutClientId] = useState<string>(() => newCheckoutClientId());

  const executeCheckout = useCallback(async (
    applied: AppliedPaymentLine[],
    op: CheckoutOperatorContext,
    ledgerSignals: {
      appliedDepositAmountCents: number;
      isTaxExempt: boolean;
      taxExemptReason?: string;
      roundingAdjustmentCents?: number;
      finalCashDueCents?: number;
    },
    options?: PosOrderOptions,
    execution?: CheckoutExecutionOverrides,
  ) => {
    if (isRegisterReconciliationLocked(sessionId)) {
      toast(
        "This workstation has acknowledged Z-close reconciliation. Finish or cancel Register #1 reconciliation before starting another sale.",
        "error",
      );
      return null;
    }
    const checkoutLines = execution?.linesOverride ?? lines;
    const checkoutTotals = execution?.totalsOverride ?? totals;
    if (!op?.staffId?.trim()) {
      toast("Sign in as cashier on the register sign-in screen before completing payment.", "error");
      return null;
    }
    if (checkoutLines.length === 0 && disbursementMembers.length === 0 && orderPaymentLines.length === 0 && !posShipping) {
      toast("Add at least one item, order payment, or shipping charge before checking out.", "error");
      return null;
    }
    if (!navigator.onLine && posShipping) {
      toast("Shipping requires an online connection. Clear shipping or try again when online.", "error");
      return null;
    }
    if (!navigator.onLine && orderPaymentLines.length > 0) {
      toast("Order payments require an online connection. Remove the order payment or try again when online.", "error");
      return null;
    }

    const gotToken = await ensurePosTokenForSession();
    if (!gotToken) {
      toast("This device is missing the till session token. From POS, open or join the till.", "error");
      return null;
    }

    if (navigator.onLine) {
      // Verify session is still open before tendering (gives early feedback if closed by another terminal)
      try {
        const sessionRes = await fetch(`${baseUrl}/api/sessions/current`, {
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          cache: "no-store",
        });
        if (!sessionRes.ok) {
          if (isTransientSessionProbeStatus(sessionRes.status)) {
            toast(
              "Main Hub is unavailable. Keep this checkout open and retry when the connection banner clears.",
              "error",
            );
          } else {
            toast("Your register session is no longer active. Re-open the till to continue.", "error");
          }
          return null;
        }
      } catch {
        toast(
          "Main Hub is unavailable. Keep this checkout open and retry when the connection banner clears.",
          "error",
        );
        return null;
      }
    }

    setCheckoutBusy(true);

    try {
      const { paymentSplits: payment_splits, unallocatedDepositCents } =
        buildCheckoutPaymentSplits(applied, ledgerSignals.appliedDepositAmountCents);

      const tenderPaidCents = applied.reduce((s, p) => s + p.amountCents, 0);
      const ledgerCents = Math.max(0, ledgerSignals.appliedDepositAmountCents);
      const maxPaidAgainstSaleCents = maxCollectableTenderCents(
        checkoutTotals.collectTotalCents,
        ledgerCents,
        ledgerSignals.roundingAdjustmentCents ?? 0,
      );
      const providerBackedPayment = hasProviderBackedPayment(applied);
      const pickupPaymentApprovalRequired = (message: string) =>
        message.includes("use Manager Access to approve a pickup payment override");

      const postPickup = async (
        transactionId: string,
        deliveredItemIds: string[],
        pickupOptions?: PosOrderOptions,
        checkoutTransactionId?: string,
      ): Promise<{ ok: true; warnings: string[] } | { ok: false; status: number; message: string }> => {
        const pickupRes = await fetch(`${baseUrl}/api/transactions/${transactionId}/pickup`, {
          method: "POST",
          headers: { ...apiAuth(), "Content-Type": "application/json" },
          body: JSON.stringify({
            delivered_item_ids: deliveredItemIds,
            actor: op.fullName.trim() || cashierName?.trim() || "Register Pickup Flow",
            override_readiness: pickupOptions?.overrideReadiness ?? false,
            override_reason: pickupOptions?.overrideReadiness
              ? (pickupOptions?.overrideReason ?? "Register pickup override: manager approved release for unready items.")
              : undefined,
            readiness_override_manager_staff_id:
              pickupOptions?.readinessOverrideManagerStaffId,
            readiness_override_manager_pin:
              pickupOptions?.readinessOverrideManagerPin,
            payment_override_manager_staff_id: pickupOptions?.pickupPaymentOverride?.managerStaffId,
            payment_override_manager_pin: pickupOptions?.pickupPaymentOverride?.managerPin,
            payment_override_reason: pickupOptions?.pickupPaymentOverride?.reason,
            register_session_id: sessionId,
            checkout_transaction_id: checkoutTransactionId,
          }),
        });

        if (pickupRes.ok) {
          const pickupBody = (await pickupRes.json().catch(() => ({}))) as { warnings?: string[] };
          return { ok: true, warnings: pickupBody.warnings ?? [] };
        }

        let b: { error?: string } = {};
        try {
          b = await pickupRes.json() as { error?: string };
        } catch {
          const text = await pickupRes.text().catch(() => "");
          b = { error: text || `Pickup failed (${pickupRes.status})` };
        }
        return {
          ok: false,
          status: pickupRes.status,
          message: b.error || `Pickup failed (${pickupRes.status})`,
        };
      };

      const completePickupWithOptionalPaymentOverride = async (
        transactionId: string,
        deliveredItemIds: string[],
        pickupOptions?: PosOrderOptions,
        checkoutTransactionId?: string,
      ): Promise<{ ok: true; warnings: string[] } | { ok: false; status: number; message: string }> => {
        const firstAttempt = await postPickup(transactionId, deliveredItemIds, pickupOptions, checkoutTransactionId);
        if (
          firstAttempt.ok ||
          pickupOptions?.pickupPaymentOverride ||
          !pickupPaymentApprovalRequired(firstAttempt.message) ||
          !requestPickupPaymentOverride
        ) {
          return firstAttempt;
        }

        const approval = await requestPickupPaymentOverride(firstAttempt.message);
        if (!approval) return firstAttempt;
        return postPickup(
          transactionId,
          deliveredItemIds,
          {
            ...pickupOptions,
            pickupPaymentOverride: approval,
          },
          checkoutTransactionId,
        );
      };

      const isZeroBalancePickup =
        !!pickupTransactionId &&
        checkoutLines.length > 0 &&
        checkoutLines.every((l) => l.transaction_line_id) &&
        tenderPaidCents === 0 &&
        orderPaymentLines.every((l) => parseMoneyToCents(l.amount) === 0);

      if (isZeroBalancePickup) {
        if (!navigator.onLine) {
          toast("Pickups require an online connection.", "error");
          setCheckoutBusy(false);
          return null;
        }

        const deliveredItemIds = checkoutLines.flatMap((line) =>
          line.transaction_line_id ? [line.transaction_line_id] : [],
        );

        for (const selection of pickupTransactions.length > 0
          ? pickupTransactions
          : [{ transactionId: pickupTransactionId, lineIds: deliveredItemIds }]) {
          const pickupResult = await completePickupWithOptionalPaymentOverride(selection.transactionId, selection.lineIds, options);
          if (!pickupResult.ok) throw new Error(pickupResult.message);
          for (const warning of pickupResult.warnings) {
            if (warning.trim()) toast(warning, "info");
          }
        }
        toast("Pickup completed successfully.", "success");
        setLastReceiptTransactionLineIds(deliveredItemIds);
        setLastTransactionId(pickupTransactionId);
        void clearBlockedCheckoutRecovery({ recoveryTransactionId: pickupTransactionId });

        if (execution?.clearAfterCheckout !== false) {
          clearCart();
          setCheckoutClientId(newCheckoutClientId());
        }
        if (execution?.emitSaleCompleted !== false) {
          onSaleCompleted?.();
        }
        return pickupTransactionId;
      }

      if (checkoutTotals.totalCents < 0 && orderPaymentLines.length > 0) {
        toast("Clear transaction payments before recording a refund or exchange credit.", "error");
        setCheckoutBusy(false);
        return null;
      }

      // Deposit is a protocol on collected tender, not extra money on top of it.
      if (tenderPaidCents > maxPaidAgainstSaleCents) {
        toast(
          `Tender total $${centsToFixed2(tenderPaidCents)} is more than the amount due $${centsToFixed2(maxPaidAgainstSaleCents)}.`,
          "error",
        );
        setCheckoutBusy(false);
        return null;
      }
      if (ledgerCents > 0 && unallocatedDepositCents > 0) {
        toast(
          "Deposit amount cannot exceed the tender collected today. Reduce the deposit or add matching payment.",
          "error",
        );
        setCheckoutBusy(false);
        return null;
      }

      const isEmployeeSale = selectedCustomer?.employee_discount_eligible === true;
      const primaryTrim = isEmployeeSale ? "" : primarySalespersonId.trim();
      const positiveOrderPaymentLines = orderPaymentLines.filter(
        (line) => parseMoneyToCents(line.amount) > 0,
      );
      if (positiveOrderPaymentLines.length > 0) {
        if (!selectedCustomer?.id) {
          toast("Select a customer before checking out with an order payment.", "error");
          setCheckoutBusy(false);
          return null;
        }
        const targetIds = new Set<string>();
        const clientLineIds = new Set<string>();
        for (const line of positiveOrderPaymentLines) {
          const amountCents = parseMoneyToCents(line.amount);
          const balanceCents = parseMoneyToCents(line.balance_before);
          if (balanceCents <= 0 || amountCents > balanceCents) {
            toast("Review the order payment amount before checkout.", "error");
            setCheckoutBusy(false);
            return null;
          }
          if (line.customer_id !== selectedCustomer.id) {
            toast("Order payments must belong to the selected customer.", "error");
            setCheckoutBusy(false);
            return null;
          }
          if (targetIds.has(line.target_transaction_id) || clientLineIds.has(line.cart_row_id)) {
            toast("Only one payment line per existing order is allowed.", "error");
            setCheckoutBusy(false);
            return null;
          }
          targetIds.add(line.target_transaction_id);
          clientLineIds.add(line.cart_row_id);
        }
      }
      const payloadSaleLines = checkoutLines.filter((line) => !line.transaction_line_id);
      const payloadLineTotalCents = payloadSaleLines.reduce((sum, line) => {
        const quantity = Math.max(0, line.quantity);
        const forceNonTaxable = ledgerSignals.isTaxExempt || isNonTaxableServiceLine(line);
        const stateTaxCents = forceNonTaxable ? 0 : parseMoneyToCents(line.state_tax);
        const localTaxCents = forceNonTaxable ? 0 : parseMoneyToCents(line.local_tax);
        return (
          sum +
          (parseMoneyToCents(line.standard_retail_price) + stateTaxCents + localTaxCents) * quantity
        );
      }, 0);
      // Use the same override totals that drive this checkout execution. This
      // matters for exchanges, where the cart also contains non-sale return
      // lines but the server receives only the replacement sale lines.
      const payloadTotalPriceCents = execution?.totalsOverride
        ? checkoutTotals.orderTotalCents
        : payloadLineTotalCents + (posShipping?.amount_cents ?? 0);
      const alterationLines = checkoutLines.filter((line) => line.line_type === "alteration_service");
      if (pendingAlterationIntakes.length > 0 || alterationLines.length > 0) {
        if (!selectedCustomer?.id) {
          toast("Select a customer before checking out with alteration intake.", "error");
          setCheckoutBusy(false);
          return null;
        }
        const activeLineIds = new Set(checkoutLines.map((line) => line.cart_row_id));
        const alterationLinesByIntake = new Map(
          alterationLines
            .filter((line) => line.alteration_intake_id)
            .map((line) => [line.alteration_intake_id!, line]),
        );
        if (alterationLinesByIntake.size !== alterationLines.length) {
            toast("Every alteration cart line must be linked to an alteration intake.", "error");
            setCheckoutBusy(false);
            return null;
          }
        for (const intake of pendingAlterationIntakes) {
          const alterationLine = alterationLinesByIntake.get(intake.id);
          if (!alterationLine || alterationLine.cart_row_id !== intake.alteration_cart_row_id) {
            toast("Every alteration intake must have a matching alteration cart line.", "error");
            setCheckoutBusy(false);
            return null;
          }
          if (
            intake.source_type === "current_cart_item" &&
            (!intake.cart_row_id || !activeLineIds.has(intake.cart_row_id))
          ) {
            toast("An alteration intake references an item that is no longer in the cart.", "error");
            setCheckoutBusy(false);
            return null;
          }
          const chargeCents =
            intake.charge_amount && intake.charge_amount.trim()
              ? parseMoneyToCents(intake.charge_amount)
              : 0;
          const lineCents = parseMoneyToCents(alterationLine.standard_retail_price);
          if (lineCents !== chargeCents) {
            toast("Alteration cart line amount must match the intake charge.", "error");
            setCheckoutBusy(false);
            return null;
          }
        }
        const intakeIds = new Set(pendingAlterationIntakes.map((intake) => intake.id));
        for (const line of alterationLines) {
          if (!line.alteration_intake_id || !intakeIds.has(line.alteration_intake_id)) {
            toast("Remove or edit the orphan alteration line before checkout.", "error");
            setCheckoutBusy(false);
            return null;
          }
        }
      }

      const payload: CheckoutPayload = {
        session_id: sessionId,
        operator_staff_id: op.staffId,
        primary_salesperson_id: primaryTrim ? primaryTrim : null,
        customer_id: selectedCustomer?.id ?? null,
        wedding_member_id: activeWeddingMember?.id ?? null,
        payment_method: payment_splits.length === 1 ? payment_splits[0]!.payment_method : "split",
        total_price: centsToFixed2(payloadTotalPriceCents),
        amount_paid: centsToFixed2(tenderPaidCents),
        checkout_client_id: checkoutClientId,
        booked_at_local: saleDateTimeLocal?.trim() || undefined,
        backdate_approval: backdateApproval
          ? {
              approved_by_staff_id: backdateApproval.approvedByStaffId,
              reason: backdateApproval.reason,
            }
          : undefined,
        is_rush: options?.is_rush ?? checkoutLines.some((l) => l.is_rush),
        need_by_date:
          options?.need_by_date ??
          (checkoutLines.find((l) => l.need_by_date)?.need_by_date || null),
        fulfillment_mode:
          posShipping
            ? (posShipping.fee_only ? "pickup" : "ship")
            : (options?.fulfillment_mode ?? "pickup"),
        ship_to: posShipping?.to_address ?? options?.ship_to ?? null,
        actor_name: op.fullName.trim() || cashierName?.trim() || null,
        payment_splits,
        ...(belowCostApproval
          ? {
              below_cost_approval: {
                approved_by_staff_id: belowCostApproval.approvedByStaffId,
                reason: belowCostApproval.reason,
                line_signature: belowCostApproval.lineSignature,
              },
            }
          : {}),
        is_tax_exempt: ledgerSignals.isTaxExempt,
        tax_exempt_reason: ledgerSignals.isTaxExempt ? (ledgerSignals.taxExemptReason ?? "Other") : undefined,
        rounding_adjustment: optionalCentsField(ledgerSignals.roundingAdjustmentCents),
        final_cash_due: optionalCentsField(ledgerSignals.finalCashDueCents),
        exchange_settlement: execution?.exchangeSettlement,
        items: payloadSaleLines
          .map((l) => {
            const unitCents = parseMoneyToCents(l.standard_retail_price);
            const origCents = l.original_unit_price != null ? parseMoneyToCents(l.original_unit_price) : unitCents;
            const fulfillment = pickupConfirmed ? "takeaway" : (l.fulfillment ?? "takeaway");
            const appliesOrderOptions = fulfillment !== "takeaway";
            const forceNonTaxable = ledgerSignals.isTaxExempt || isNonTaxableServiceLine(l);
            const taxCategoryOverride = checkoutTaxCategoryOverride(l.tax_category);
            return {
              client_line_id: l.cart_row_id,
              line_type: l.line_type ?? "merchandise",
              alteration_intake_id: l.alteration_intake_id ?? null,
              product_id: l.product_id,
              variant_id: l.variant_id,
              fulfillment,
              quantity: l.quantity,
              unit_price: centsToFixed2(unitCents),
              original_unit_price: origCents !== unitCents ? centsToFixed2(origCents) : undefined,
              price_override_reason: l.price_override_reason,
              unit_cost: centsToFixed2(parseMoneyToCents(l.unit_cost)),
              state_tax: centsToFixed2(forceNonTaxable ? 0 : parseMoneyToCents(l.state_tax)),
              local_tax: centsToFixed2(forceNonTaxable ? 0 : parseMoneyToCents(l.local_tax)),
              tax_category_override: taxCategoryOverride,
              salesperson_id: isEmployeeSale ? null : l.salesperson_id?.trim() || null,
              custom_item_type: l.custom_item_type,
              custom_order_details: l.custom_order_details ?? undefined,
              is_rush: l.is_rush || (appliesOrderOptions ? Boolean(options?.is_rush) : false),
              need_by_date: l.need_by_date ?? (appliesOrderOptions ? options?.need_by_date ?? null : null),
              needs_gift_wrap: l.needs_gift_wrap,
              order_lifecycle_status:
                appliesOrderOptions && l.order_lifecycle_status === "needs_measurements"
                  ? "needs_measurements"
                  : undefined,
              ...(l.discount_event_id ? { discount_event_id: l.discount_event_id } : {}),
              ...(l.gift_card_load_code?.trim() ? { gift_card_load_code: l.gift_card_load_code.trim().toUpperCase() } : {}),
            };
          }),
        alteration_intakes: pendingAlterationIntakes.map((intake) => ({
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
        })),
        order_payments: positiveOrderPaymentLines.length > 0 ? positiveOrderPaymentLines.map((line) => ({
          client_line_id: line.cart_row_id,
          target_transaction_id: line.target_transaction_id,
          target_display_id: line.target_display_id,
          customer_id: line.customer_id,
          amount: line.amount,
          balance_before: line.balance_before,
          projected_balance_after: line.projected_balance_after,
        })) : undefined,
        wedding_disbursements: disbursementMembers.length > 0 ? disbursementMembers.map(m => ({
          wedding_member_id: m.id,
          amount: centsToFixed2(weddingDisbursementAmountCents(m)),
        })) : undefined,
        ...(posShipping ? { shipping_rate_quote_id: posShipping.rate_quote_id } : {}),
        ...(posShipping?.linked_order_ids?.length
          ? {
              shipping_links: posShipping.linked_order_ids.map((target_transaction_id) => ({
                target_transaction_id,
              })),
            }
          : {}),
      };

      if (!navigator.onLine) {
        if (providerBackedPayment) {
          toast("Card provider payments cannot be queued offline. Keep the checkout open and reconnect before recording the sale.", "error");
          setCheckoutBusy(false);
          return null;
        }
        await enqueueCheckout(payload, apiAuth());
        toast("Sale queued offline.", "info");
        if (execution?.clearAfterCheckout !== false) {
          clearCart();
          setCheckoutClientId(newCheckoutClientId());
        }
        if (execution?.emitSaleCompleted !== false) {
          onSaleCompleted?.();
        }
        return null;
      }

      let res: Response | null = null;
      let checkoutNetworkError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          res = await fetch(`${baseUrl}/api/transactions/checkout`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...apiAuth() },
            body: JSON.stringify(payload),
          });
          if (res.ok || (res.status < 500 && res.status !== 408 && res.status !== 429)) {
            break;
          }
        } catch (error) {
          checkoutNetworkError = error;
          res = null;
        }
      }

      if (!res) {
        const detail =
          checkoutNetworkError instanceof Error
            ? checkoutNetworkError.message
            : "Network failure while recording checkout.";
        await recordBlockedCheckoutRecovery(payload, 0, detail, {
          recoveryKind: "online_unconfirmed",
          recoveryKey: checkoutClientId,
          authHeaders: apiAuth(),
        });
        const tenderText = providerBackedPayment
          ? "Do not run the card again."
          : "Do not re-enter or queue this sale blindly.";
        throw new Error(
          `Riverside OS could not confirm whether this checkout saved. ${tenderText} Keep the cart open and retry Record Sale after checking recovery.`,
        );
      }

      if (!res.ok) {
        const detail = await checkoutResponseError(res);
        if (providerBackedPayment && res.status < 500) {
          await recordBlockedCheckoutRecovery(payload, res.status, detail, {
            recoveryKind: "online_unconfirmed",
            recoveryKey: checkoutClientId,
            authHeaders: apiAuth(),
          });
        }
        if (res.status >= 500) {
          await recordBlockedCheckoutRecovery(payload, res.status, detail, {
            recoveryKind: "online_unconfirmed",
            recoveryKey: checkoutClientId,
            authHeaders: apiAuth(),
          });
          const tenderText = providerBackedPayment
            ? "Do not run the card again."
            : "Do not re-enter or queue this sale blindly.";
          throw new Error(
            `Riverside OS could not confirm whether this checkout saved. ${tenderText} Keep the cart open and retry Record Sale after checking recovery.`,
          );
        }
        throw new Error(detail);
      }

      const data = await res.json() as { transaction_id: string; warnings?: string[] };
      void clearBlockedCheckoutRecovery({ checkoutClientId });
      let receiptTransactionId = data.transaction_id;
      if (execution?.showSuccessToast !== false) {
        toast("Checkout complete", "success");
      }
      if (data.warnings && data.warnings.length > 0) {
        for (const w of data.warnings) {
          toast(w, "info");
        }
      }
      const shippingReleaseOrderIds = posShipping?.linked_order_ids ?? [];
      if (shippingReleaseOrderIds.length > 0) {
        const releaseFailures: Array<{ transactionId: string; message: string }> = [];
        for (const orderId of shippingReleaseOrderIds) {
          try {
            const shipRes = await fetch(`${baseUrl}/api/transactions/${orderId}/ship`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                shipped_item_ids: [],
                actor: "Register Shipping Charge",
                register_session_id: sessionId,
              }),
            });
            if (!shipRes.ok) {
              const body = await shipRes.json().catch(() => ({})) as { error?: string };
              releaseFailures.push({
                transactionId: orderId,
                message: body.error ?? `Transaction Record ${orderId} could not be marked shipped.`,
              });
            }
          } catch {
            releaseFailures.push({
              transactionId: orderId,
              message: `Transaction Record ${orderId} shipping release failed after payment.`,
            });
          }
        }
        if (releaseFailures.length > 0) {
          const message = releaseFailures.map((failure) => failure.message).join(" ");
          await recordBlockedCheckoutRecovery(payload, 0, message, {
            recoveryKind: "pickup_after_payment",
            recoveryKey: data.transaction_id,
            recoveryTransactionId: data.transaction_id,
            recoverySteps: releaseFailures.map((failure) => ({
              kind: "ship_transaction" as const,
              transaction_id: failure.transactionId,
              transaction_line_ids: [],
            })),
            authHeaders: apiAuth(),
          });
          toast("Shipping fee saved, but one or more linked orders were not marked shipped. Review checkout recovery before closing.", "error");
        } else {
          toast("Linked order shipping completed.", "success");
        }
      }
      // Call pickup API after successful checkout when in pickup mode
      let receiptTransactionLineIds: string[] = [];
      if (pickupTransactionId) {
        const deliveredItemIds = checkoutLines.flatMap((line) =>
          line.transaction_line_id ? [line.transaction_line_id] : [],
        );
        try {
          const pickupResults = [];
          const recoveryPickupSelections = pickupTransactions.length > 0
            ? pickupTransactions
            : [{ transactionId: pickupTransactionId, lineIds: deliveredItemIds }];
          for (const selection of recoveryPickupSelections) {
            pickupResults.push(
              await completePickupWithOptionalPaymentOverride(
                selection.transactionId,
                selection.lineIds,
                options,
                data.transaction_id,
              ),
            );
          }
          const pickupResult = pickupResults.find((result) => !result.ok) ?? {
            ok: true as const,
            warnings: pickupResults
              .filter((result): result is { ok: true; warnings: string[] } => result.ok)
              .flatMap((result) => result.warnings),
          };
          if (pickupResult.ok) {
            for (const warning of pickupResult.warnings) if (warning.trim()) toast(warning, "info");
            toast("Pickup completed successfully.", "success");
            const alterationPickupFailures: string[] = [];
            const alterationPickupFailureIds: string[] = [];
            for (const alterationId of pickupAlterationIds) {
              try {
                const alterationPickupRes = await fetch(`${baseUrl}/api/alterations/${alterationId}/pickup`, {
                  method: "POST",
                  headers: apiAuth(),
                });
                if (!alterationPickupRes.ok) {
                  const body = await alterationPickupRes.json().catch(() => ({})) as { error?: string };
                  alterationPickupFailureIds.push(alterationId);
                  alterationPickupFailures.push(
                    body.error ?? `Ready alteration ${alterationId} could not be marked picked up.`,
                  );
                }
              } catch {
                alterationPickupFailureIds.push(alterationId);
                alterationPickupFailures.push(
                  `Ready alteration ${alterationId} pickup update failed after order pickup.`,
                );
              }
            }
            if (alterationPickupFailures.length > 0) {
              const message = alterationPickupFailures.join(" ");
              await recordBlockedCheckoutRecovery(payload, 0, message, {
                recoveryKind: "pickup_after_payment",
                recoveryKey: `${pickupTransactionId}:alterations`,
                recoveryTransactionId: pickupTransactionId,
                recoverySteps: alterationPickupFailureIds.map((alterationId) => ({
                  kind: "alteration_pickup" as const,
                  alteration_id: alterationId,
                })),
                authHeaders: apiAuth(),
              });
              toast("Pickup saved, but alteration pickup recovery needs review before closing.", "error");
            }
            if (payloadSaleLines.length === 0) {
              receiptTransactionId = pickupTransactionId;
              receiptTransactionLineIds = deliveredItemIds;
            }
          } else {
            await recordBlockedCheckoutRecovery(payload, pickupResult.status, pickupResult.message, {
              recoveryKind: "pickup_after_payment",
              recoveryKey: pickupTransactionId,
              recoveryTransactionId: pickupTransactionId,
              recoverySteps: recoveryPickupSelections.map((selection) => ({
                kind: "pickup_transaction" as const,
                transaction_id: selection.transactionId,
                transaction_line_ids: selection.lineIds,
              })),
              authHeaders: apiAuth(),
            });
            toast(`Payment saved, but pickup is not complete. ${pickupResult.message}`, "error");
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Pickup API call failed after checkout.";
          await recordBlockedCheckoutRecovery(payload, 0, message, {
            recoveryKind: "pickup_after_payment",
            recoveryKey: pickupTransactionId,
            recoveryTransactionId: pickupTransactionId,
            recoverySteps: (pickupTransactions.length > 0
              ? pickupTransactions
              : [{ transactionId: pickupTransactionId, lineIds: deliveredItemIds }]
            ).map((selection) => ({
              kind: "pickup_transaction" as const,
              transaction_id: selection.transactionId,
              transaction_line_ids: selection.lineIds,
            })),
            authHeaders: apiAuth(),
          });
          toast("Payment saved, but pickup is not complete. Review checkout recovery before closing.", "error");
        }
      }

      setLastCashChangeDueCents(cashChangeDueCents(applied));
      if (execution?.emitSaleCompleted !== false) {
        setLastReceiptTransactionLineIds(receiptTransactionLineIds);
        setLastTransactionId(receiptTransactionId);
      }
      if (execution?.clearAfterCheckout !== false) {
        clearCart();
        setCheckoutClientId(newCheckoutClientId());
      }
      if (execution?.emitSaleCompleted !== false) {
        onSaleCompleted?.();
      }
      return data.transaction_id;
    } catch (e) {
      playPosScanError();
      toast(e instanceof Error ? e.message : "Checkout failed", "error");
      return null;
    } finally {
      setCheckoutBusy(false);
    }
  }, [
    sessionId, baseUrl, apiAuth, lines, selectedCustomer, activeWeddingMember,
    cashierName, primarySalespersonId, disbursementMembers, posShipping, pendingAlterationIntakes, orderPaymentLines,
    pickupAlterationIds, pickupConfirmed, pickupTransactionId, pickupTransactions, belowCostApproval, saleDateTimeLocal, backdateApproval, totals, toast, clearCart, onSaleCompleted, ensurePosTokenForSession, requestPickupPaymentOverride, checkoutClientId
  ]);

  return {
    executeCheckout,
    checkoutBusy,
    checkoutClientId,
    lastTransactionId,
    lastCashChangeDueCents,
    lastReceiptTransactionLineIds,
    setLastTransactionId,
    setLastReceiptTransactionLineIds,
    setCheckoutClientId,
  };
}
