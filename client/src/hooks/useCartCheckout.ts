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
import { newCheckoutClientId, normalizeGiftCardSubType } from "../lib/posUtils";
import { enqueueCheckout } from "../lib/offlineQueue";
import { playPosScanError } from "../lib/posAudio";

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
  pickupConfirmed: boolean;
  totals: CartTotals; 
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  clearCart: () => void;
  onSaleCompleted?: () => void;
  ensurePosTokenForSession: () => Promise<string | null>;
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
  pickupConfirmed,
  totals,
  toast,
  clearCart,
  onSaleCompleted,
  ensurePosTokenForSession,
}: UseCartCheckoutProps) {
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [lastTransactionId, setLastTransactionId] = useState<string | null>(null);

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
    options?: PosOrderOptions
  ) => {
    if (!op?.staffId?.trim()) {
      toast("Sign in as cashier on the register sign-in screen before completing payment.", "error");
      return;
    }
    if (lines.length === 0 && disbursementMembers.length === 0 && orderPaymentLines.length === 0) {
      toast("Add at least one item or order payment before checking out.", "error");
      return;
    }
    if (!navigator.onLine && posShipping) {
      toast("Shipping requires an online connection. Clear shipping or try again when online.", "error");
      return;
    }
    if (!navigator.onLine && orderPaymentLines.length > 0) {
      toast("Order payments require an online connection. Remove the order payment or try again when online.", "error");
      return;
    }

    const gotToken = await ensurePosTokenForSession();
    if (!gotToken) {
      toast("This device is missing the till session token. From POS, open or join the till.", "error");
      return;
    }

    setCheckoutBusy(true);

    try {
      const { paymentSplits: payment_splits, unallocatedDepositCents } =
        buildCheckoutPaymentSplits(applied, ledgerSignals.appliedDepositAmountCents);

      const tenderPaidCents = applied.reduce((s, p) => s + p.amountCents, 0);
      const ledgerCents = Math.max(0, ledgerSignals.appliedDepositAmountCents);

      // Deposit is a protocol on collected tender, not extra money on top of it.
      if (tenderPaidCents > totals.collectTotalCents) {
        toast(
          `Tender total $${centsToFixed2(tenderPaidCents)} is more than the amount due $${centsToFixed2(totals.collectTotalCents)}.`,
          "error",
        );
        setCheckoutBusy(false);
        return;
      }
      if (ledgerCents > 0 && unallocatedDepositCents > 0) {
        toast(
          "Deposit amount cannot exceed the tender collected today. Reduce the deposit or add matching payment.",
          "error",
        );
        setCheckoutBusy(false);
        return;
      }

      const checkoutClientId = newCheckoutClientId();
      const primaryTrim = primarySalespersonId.trim();
      if (orderPaymentLines.length > 0) {
        if (!selectedCustomer?.id) {
          toast("Select a customer before checking out with an order payment.", "error");
          setCheckoutBusy(false);
          return;
        }
        const targetIds = new Set<string>();
        const clientLineIds = new Set<string>();
        for (const line of orderPaymentLines) {
          const amountCents = parseMoneyToCents(line.amount);
          const balanceCents = parseMoneyToCents(line.balance_before);
          if (amountCents <= 0 || amountCents > balanceCents) {
            toast("Review the order payment amount before checkout.", "error");
            setCheckoutBusy(false);
            return;
          }
          if (line.customer_id !== selectedCustomer.id) {
            toast("Order payments must belong to the selected customer.", "error");
            setCheckoutBusy(false);
            return;
          }
          if (targetIds.has(line.target_transaction_id) || clientLineIds.has(line.cart_row_id)) {
            toast("Only one payment line per existing order is allowed.", "error");
            setCheckoutBusy(false);
            return;
          }
          targetIds.add(line.target_transaction_id);
          clientLineIds.add(line.cart_row_id);
        }
      }
      const alterationLines = lines.filter((line) => line.line_type === "alteration_service");
      if (pendingAlterationIntakes.length > 0 || alterationLines.length > 0) {
        if (!selectedCustomer?.id) {
          toast("Select a customer before checking out with alteration intake.", "error");
          setCheckoutBusy(false);
          return;
        }
        const activeLineIds = new Set(lines.map((line) => line.cart_row_id));
        const alterationLinesByIntake = new Map(
          alterationLines
            .filter((line) => line.alteration_intake_id)
            .map((line) => [line.alteration_intake_id!, line]),
        );
        if (alterationLinesByIntake.size !== alterationLines.length) {
          toast("Every alteration cart line must be linked to an alteration intake.", "error");
          setCheckoutBusy(false);
          return;
        }
        for (const intake of pendingAlterationIntakes) {
          const alterationLine = alterationLinesByIntake.get(intake.id);
          if (!alterationLine || alterationLine.cart_row_id !== intake.alteration_cart_row_id) {
            toast("Every alteration intake must have a matching alteration cart line.", "error");
            setCheckoutBusy(false);
            return;
          }
          if (
            intake.source_type === "current_cart_item" &&
            (!intake.cart_row_id || !activeLineIds.has(intake.cart_row_id))
          ) {
            toast("An alteration intake references an item that is no longer in the cart.", "error");
            setCheckoutBusy(false);
            return;
          }
          const chargeCents =
            intake.charge_amount && intake.charge_amount.trim()
              ? parseMoneyToCents(intake.charge_amount)
              : 0;
          const lineCents = parseMoneyToCents(alterationLine.standard_retail_price);
          if (lineCents !== chargeCents) {
            toast("Alteration cart line amount must match the intake charge.", "error");
            setCheckoutBusy(false);
            return;
          }
        }
        const intakeIds = new Set(pendingAlterationIntakes.map((intake) => intake.id));
        for (const line of alterationLines) {
          if (!line.alteration_intake_id || !intakeIds.has(line.alteration_intake_id)) {
            toast("Remove or edit the orphan alteration line before checkout.", "error");
            setCheckoutBusy(false);
            return;
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
        total_price: centsToFixed2(ledgerSignals.isTaxExempt ? totals.orderTotalCents - (totals.stateTaxCents + totals.localTaxCents) : totals.orderTotalCents),
        amount_paid: centsToFixed2(tenderPaidCents),
        checkout_client_id: checkoutClientId,
        is_rush: options?.is_rush ?? lines.some((l) => l.is_rush),
        need_by_date:
          options?.need_by_date ??
          (lines.find((l) => l.need_by_date)?.need_by_date || null),
        fulfillment_mode:
          options?.fulfillment_mode ?? (posShipping ? "ship" : "pickup"),
        ship_to: options?.ship_to ?? (posShipping?.to_address || null),
        stripe_payment_method_id: options?.stripe_payment_method_id ?? null,
        actor_name: op.fullName.trim() || cashierName?.trim() || null,
        payment_splits,
        is_tax_exempt: ledgerSignals.isTaxExempt,
        tax_exempt_reason: ledgerSignals.isTaxExempt ? (ledgerSignals.taxExemptReason ?? "Other") : undefined,
        rounding_adjustment: ledgerSignals.roundingAdjustmentCents ? centsToFixed2(ledgerSignals.roundingAdjustmentCents) : undefined,
        final_cash_due: ledgerSignals.finalCashDueCents ? centsToFixed2(ledgerSignals.finalCashDueCents) : undefined,
        items: lines.map((l) => {
          const unitCents = parseMoneyToCents(l.standard_retail_price);
          const origCents = l.original_unit_price != null ? parseMoneyToCents(l.original_unit_price) : unitCents;
          return {
            client_line_id: l.cart_row_id,
            line_type: l.line_type ?? "merchandise",
            alteration_intake_id: l.alteration_intake_id ?? null,
            product_id: l.product_id, 
            variant_id: l.variant_id, 
            fulfillment: pickupConfirmed ? "takeaway" : (l.fulfillment ?? "takeaway"),
            quantity: l.quantity,
            unit_price: centsToFixed2(unitCents),
            original_unit_price: origCents !== unitCents ? centsToFixed2(origCents) : undefined,
            price_override_reason: l.price_override_reason,
            unit_cost: centsToFixed2(parseMoneyToCents(l.unit_cost)),
            state_tax: centsToFixed2(ledgerSignals.isTaxExempt ? 0 : parseMoneyToCents(l.state_tax)), 
            local_tax: centsToFixed2(ledgerSignals.isTaxExempt ? 0 : parseMoneyToCents(l.local_tax)),
            salesperson_id: l.salesperson_id?.trim() || null,
            custom_item_type: l.custom_item_type,
            custom_order_details: l.custom_order_details ?? undefined,
            is_rush: l.is_rush,
            need_by_date: l.need_by_date,
            needs_gift_wrap: l.needs_gift_wrap,
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
          source_product_id: intake.source_product_id ?? null,
          source_variant_id: intake.source_variant_id ?? null,
          source_sku: intake.source_sku ?? null,
          source_transaction_id: intake.source_transaction_id ?? null,
          source_transaction_line_id: intake.source_transaction_line_id ?? null,
          charge_amount: intake.charge_amount ?? null,
          due_at: intake.due_at ?? null,
          notes: intake.notes ?? null,
        })),
        order_payments: orderPaymentLines.length > 0 ? orderPaymentLines.map((line) => ({
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
          amount: centsToFixed2(parseMoneyToCents(m.balance_due || "0")),
        })) : undefined,
        ...(posShipping ? { shipping_rate_quote_id: posShipping.rate_quote_id } : {}),
      };

      if (!navigator.onLine) {
        await enqueueCheckout(payload, apiAuth());
        toast("Sale queued offline.", "info");
        clearCart();
        onSaleCompleted?.();
        return;
      }

      const res = await fetch(`${baseUrl}/api/transactions/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `Checkout failed (${res.status})`);
      }

      const data = await res.json() as { transaction_id: string };
      setLastTransactionId(data.transaction_id);
      toast("Checkout complete", "success");
      clearCart();
      onSaleCompleted?.();
    } catch (e) {
      playPosScanError();
      toast(e instanceof Error ? e.message : "Checkout failed", "error");
    } finally {
      setCheckoutBusy(false);
    }
  }, [
    sessionId, baseUrl, apiAuth, lines, selectedCustomer, activeWeddingMember, 
    cashierName, primarySalespersonId, disbursementMembers, posShipping, pendingAlterationIntakes, orderPaymentLines,
    pickupConfirmed, totals, toast, clearCart, onSaleCompleted, ensurePosTokenForSession
  ]);

  return {
    executeCheckout,
    checkoutBusy,
    lastTransactionId,
    setLastTransactionId
  };
}
