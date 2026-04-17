import { useState, useCallback, useMemo } from "react";
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
  type PosOrderOptions
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
  pickupConfirmed: boolean;
  totals: CartTotals; 
  toast: (msg: string, type?: "success" | "error" | "info") => void;
  clearCart: () => void;
  onSaleCompleted?: () => void;
  ensurePosTokenForSession: () => Promise<string | null>;
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
    if (lines.length === 0 && disbursementMembers.length === 0) {
      toast("Cart is empty", "error");
      return;
    }
    if (!navigator.onLine && posShipping) {
      toast("Shipping requires an online connection. Clear shipping or try again when online.", "error");
      return;
    }

    const gotToken = await ensurePosTokenForSession();
    if (!gotToken) {
      toast("This device is missing the till session token. From POS, open or join the till.", "error");
      return;
    }

    if (posShipping && lines.some(l => l.fulfillment === "takeaway")) {
      toast("Items marked as 'Takeaway' cannot be shipped. Switch fulfillment to Special Order.", "error");
      return;
    }

    setCheckoutBusy(true);

    try {
      const payment_splits: CheckoutPaymentSplitPayload[] = applied.map((p) => {
        const split: CheckoutPaymentSplitPayload = {
          payment_method: p.method,
          amount: centsToFixed2(p.amountCents),
        };
        const subtype = normalizeGiftCardSubType(p.sub_type);
        if (subtype) split.sub_type = subtype;
        if (p.method === "gift_card" && p.gift_card_code)
          split.gift_card_code = p.gift_card_code;
        if (p.method === "check" && p.metadata?.check_number)
          split.check_number = p.metadata.check_number;
        
        // Pass other metadata (Stripe, etc.) if present
        if (p.metadata) {
          split.metadata = p.metadata;
        }

        return split;
      });

      const tenderPaidCents = applied.reduce((s, p) => s + p.amountCents, 0);
      const ledgerCents = Math.max(0, ledgerSignals.appliedDepositAmountCents);
      const totalAccountedCents = tenderPaidCents + ledgerCents;

      // Validate totals
      if (totalAccountedCents > totals.collectTotalCents) {
         toast(`Accounted total $${centsToFixed2(totalAccountedCents)} is more than the amount due $${centsToFixed2(totals.collectTotalCents)}.`, "error");
         setCheckoutBusy(false);
         return;
      }

      const checkoutClientId = newCheckoutClientId();
      const primaryTrim = primarySalespersonId.trim();

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
        applied_deposit_amount: ledgerCents > 0 ? centsToFixed2(ledgerCents) : undefined,
        is_tax_exempt: ledgerSignals.isTaxExempt,
        tax_exempt_reason: ledgerSignals.isTaxExempt ? (ledgerSignals.taxExemptReason ?? "Other") : undefined,
        rounding_adjustment: ledgerSignals.roundingAdjustmentCents ? centsToFixed2(ledgerSignals.roundingAdjustmentCents) : undefined,
        final_cash_due: ledgerSignals.finalCashDueCents ? centsToFixed2(ledgerSignals.finalCashDueCents) : undefined,
        items: lines.map((l) => {
          const unitCents = parseMoneyToCents(l.standard_retail_price);
          const origCents = l.original_unit_price != null ? parseMoneyToCents(l.original_unit_price) : unitCents;
          return {
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
            is_rush: l.is_rush,
            need_by_date: l.need_by_date,
            needs_gift_wrap: l.needs_gift_wrap,
            ...(l.discount_event_id ? { discount_event_id: l.discount_event_id } : {}),
            ...(l.gift_card_load_code?.trim() ? { gift_card_load_code: l.gift_card_load_code.trim().toUpperCase() } : {}),
          };
        }),
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
    cashierName, primarySalespersonId, disbursementMembers, posShipping, 
    pickupConfirmed, totals, toast, clearCart, onSaleCompleted, ensurePosTokenForSession
  ]);

  return useMemo(() => ({
    executeCheckout,
    checkoutBusy,
    lastTransactionId,
    setLastTransactionId
  }), [
    executeCheckout,
    checkoutBusy,
    lastTransactionId
  ]);
}
