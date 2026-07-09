/** Professional letter-style Z / X reconciliation report for audit and accounting. */

import { dispatchAppToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { printReportDocument } from "../../lib/reportPrint";
import type { ReportPrintAction } from "../../lib/reportPrint";
import { describePrinterTarget, resolvePrinterTarget } from "../../lib/printerBridge";

export interface ZReportTenderRow {
  payment_method: string;
  total_amount: string;
  tx_count: number;
}

export interface ZReportOverrideRow {
  reason: string;
  line_count: number;
  total_delta: string;
}

export interface ZReportManualDrawerOpenRow {
  staff_name: string;
  reason: string;
  created_at: string;
}

export interface ZReportQboJournalLine {
  qbo_account_id: string;
  qbo_account_name: string;
  debit: string;
  credit: string;
  memo: string;
}

export interface ZReportQboJournal {
  activity_date: string;
  business_timezone: string;
  generated_at: string;
  lines: ZReportQboJournalLine[];
  warnings: string[];
  totals: {
    debits: string;
    credits: string;
    balanced: boolean;
  };
}

export interface ZReportInventoryActivityRow {
  created_at: string;
  tx_type: string;
  sku: string;
  product_name: string;
  category_name?: string | null;
  quantity_delta: number;
  unit_cost?: string | null;
  value_delta: string;
  reference_table?: string | null;
  reference_id?: string | null;
  notes?: string | null;
  staff_name?: string | null;
}

type ZReportAuditItem = {
  name: string;
  sku: string;
  quantity: number;
  unit_price: string;
  original_unit_price?: string | null;
  overridden_unit_price?: string | null;
  fulfillment: string;
  is_internal: boolean;
  line_kind?: string | null;
};

function escapeReportHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatReportMoney(value: string | number): string {
  const cents = typeof value === "number" ? value : parseMoneyToCents(String(value));
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${centsToFixed2(Math.abs(cents))}`;
}

function isCreditCardTender(method: string): boolean {
  const tender = method.toLowerCase();
  return (
    tender.includes("card") ||
    tender.includes("cc") ||
    tender.includes("helcim") ||
    tender.includes("credit") ||
    tender.includes("debit") ||
    tender.includes("visa") ||
    tender.includes("master") ||
    tender.includes("discover") ||
    tender.includes("amex")
  );
}

const Z_REPORT_TENDER_KEYS = [
  "cash",
  "card_reader",
  "card_manual",
  "card_not_present",
  "check",
  "gift_card",
  "store_credit",
  "rms_charge",
  "rms_payment",
  "staff_account",
  "donation",
] as const;

type ZReportTenderKey = typeof Z_REPORT_TENDER_KEYS[number];

function normalizedTenderKey(method: string): ZReportTenderKey | "other" {
  const tender = method.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (tender === "cash") return "cash";
  if (tender.includes("manualcard") || tender.includes("cardmanual")) return "card_manual";
  if (tender.includes("cardnotpresent") || tender === "cnp") return "card_not_present";
  if (tender === "check" || tender === "cheque") return "check";
  if (tender.includes("gift")) return "gift_card";
  if (tender.includes("storecredit") || tender === "sc") return "store_credit";
  if (tender.includes("rmspayment")) return "rms_payment";
  if (tender.includes("rms")) return "rms_charge";
  if (tender.includes("staffaccount")) return "staff_account";
  if (tender.includes("donation")) return "donation";
  if (isCreditCardTender(method)) return "card_reader";
  return "other";
}

function tenderKeyLabel(key: ZReportTenderKey | "other"): string {
  switch (key) {
    case "cash":
      return "Cash";
    case "card_reader":
      return "CC";
    case "card_manual":
      return "Card Manual";
    case "card_not_present":
      return "Card Not Present";
    case "check":
      return "Check";
    case "gift_card":
      return "Gift Card";
    case "store_credit":
      return "Store Credit";
    case "rms_charge":
      return "RMS Charge";
    case "rms_payment":
      return "RMS Payment";
    case "staff_account":
      return "Staff Account";
    case "donation":
      return "Donation";
    default:
      return "Other";
  }
}

function tenderRowsWithZeros(tenders: ZReportTenderRow[], extras?: Partial<Record<ZReportTenderKey, { amountCents: number; txCount: number }>>) {
  const buckets = new Map<ZReportTenderKey | "other", { amountCents: number; txCount: number }>();
  for (const key of Z_REPORT_TENDER_KEYS) {
    buckets.set(key, { amountCents: extras?.[key]?.amountCents ?? 0, txCount: extras?.[key]?.txCount ?? 0 });
  }
  for (const tender of tenders) {
    const key = normalizedTenderKey(tender.payment_method);
    const bucket = buckets.get(key) ?? { amountCents: 0, txCount: 0 };
    bucket.amountCents += parseMoneyToCents(tender.total_amount);
    bucket.txCount += tender.tx_count;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.entries()).map(([key, value]) => ({
    key,
    label: tenderKeyLabel(key),
    amountCents: value.amountCents,
    txCount: value.txCount,
  }));
}

function creditCardTenderTotalCents(tenders: ZReportTenderRow[]): number {
  return tenders.reduce((sum, tender) => {
    return isCreditCardTender(tender.payment_method) ? sum + parseMoneyToCents(tender.total_amount) : sum;
  }, 0);
}

function creditCardTenderCount(tenders: ZReportTenderRow[]): number {
  return tenders.reduce((sum, tender) => {
    return isCreditCardTender(tender.payment_method) ? sum + tender.tx_count : sum;
  }, 0);
}

function moneyWithCount(cents: number, count: number): string {
  return `${formatReportMoney(cents)} (${count})`;
}

function isRmsChargeTender(method: string): boolean {
  const tender = method.toLowerCase().replace(/[\s_-]/g, "");
  return tender === "rms" || tender === "rmscharge" || tender === "rms90" || tender.includes("rmscharge");
}

function textValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function isVisibleAuditItem(item: ZReportAuditItem): boolean {
  return !item.is_internal || item.line_kind === "rms_charge_payment";
}

function auditItemsSubtotalBeforeTaxCents(items: ZReportAuditItem[] | null | undefined): number {
  return (items ?? [])
    .filter((item) => !item.is_internal)
    .reduce((lineTotal, item) => lineTotal + parseMoneyToCents(item.unit_price) * item.quantity, 0);
}

function auditSubtotalBeforeTaxCents(transactions: { items?: ZReportAuditItem[] | null }[] | undefined): number {
  return (transactions ?? []).reduce((total, transaction) => {
    return total + auditItemsSubtotalBeforeTaxCents(transaction.items);
  }, 0);
}

function auditItemKindLabel(item: ZReportAuditItem): string | null {
  if (item.line_kind === "rms_charge_payment") return "RMS Payment";
  if (item.line_kind === "alteration_service") return "Alteration";
  if (item.line_kind === "pos_gift_card_load") return "Gift Card";
  return null;
}

function notifyPrintDialogFailure(error: unknown): void {
  console.error("Print failed:", error);
  dispatchAppToast("Report could not be printed. Please check the Reports printer setup.", "error");
}

function createPrintDocument(title: string) {
  return {
    doc: document.implementation.createHTMLDocument(title),
  };
}

async function finishPrintDocument(
  target: { doc: Document },
  filename: string,
  directReportText?: string,
  opts?: { action?: ReportPrintAction },
): Promise<boolean> {
  target.doc.close();
  if (!directReportText?.trim()) {
    notifyPrintDialogFailure(new Error("Report content is empty."));
    return false;
  }
  try {
    await printReportDocument({
      title: target.doc.title || filename,
      filename,
      html: `<!doctype html>${target.doc.documentElement.outerHTML}`,
      text: directReportText,
      width: 950,
      height: 950,
      preferFormattedPreview: opts?.action === "preview",
      action: opts?.action ?? "print",
    });
    return true;
  } catch (error) {
    notifyPrintDialogFailure(error);
    return false;
  }
}

function reportPrinterName(): string {
  return describePrinterTarget(resolvePrinterTarget("report"));
}

function reportLabel(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
  const tenderKey = normalized.replace(/[^a-z0-9]/g, "");
  switch (tenderKey) {
    case "card":
    case "cardterminal":
    case "cardreader":
    case "credit":
    case "creditcard":
    case "creditcards":
    case "debit":
    case "helcim":
    case "visa":
    case "mastercard":
    case "mc":
    case "amex":
    case "americanexpress":
    case "discover":
      return "CC";
    case "cardmanual":
    case "manualcard":
      return "Card Manual";
    case "cardnotpresent":
    case "cnp":
      return "Card Not Present";
    case "cash":
      return "Cash";
    case "rms90":
    case "rms90day":
    case "rms90days":
      return "RMS90";
    case "rms":
    case "rmscharge":
      return "RMS Charge";
    case "rmspayment":
      return "RMS Payment";
    case "check":
    case "cheque":
      return "Check";
    case "sc":
    case "storecredit":
      return "SC";
  }
  switch (normalized) {
    case "pos_gift_card_load":
      return "Gift card issued";
    case "alteration_service":
      return "Alteration service charge";
    case "pos_manual_price":
    case "manual override":
      return "Manual price change";
    case "custom_order_booking":
      return "Custom order booking";
    case "rms_charge_payment":
      return "Counterpoint payment";
    case "customer_profile_discount":
      return "Customer profile discount";
    case "":
    case "(unset)":
      return "Unspecified price change";
    default:
      return value!.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

function discountPercentLabel(regularCents: number, saleCents: number): string {
  const regularAbs = Math.abs(regularCents);
  const saleAbs = Math.abs(saleCents);
  if (regularAbs <= 0 || saleAbs >= regularAbs) return "0%";
  const percent = ((regularAbs - saleAbs) / regularAbs) * 100;
  const rounded = Math.round(percent * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function linePriceBreakdown(
  salePrice: string | number,
  regularPrice?: string | number | null,
): { saleCents: number; regularCents: number; discountPercent: string } {
  const saleCents = typeof salePrice === "number" ? salePrice : parseMoneyToCents(String(salePrice));
  const regularCents =
    regularPrice === null || regularPrice === undefined || String(regularPrice).trim() === ""
      ? saleCents
      : typeof regularPrice === "number"
        ? regularPrice
        : parseMoneyToCents(String(regularPrice));
  return {
    saleCents,
    regularCents,
    discountPercent: discountPercentLabel(regularCents, saleCents),
  };
}

function linePriceBreakdownHtml(salePrice: string | number, regularPrice?: string | number | null): string {
  const price = linePriceBreakdown(salePrice, regularPrice);
  return `
    <span class="line-price-block">
      <span class="line-sale-price">${formatReportMoney(price.saleCents)}</span>
      <span class="line-discount-meta">Reg ${formatReportMoney(price.regularCents)} · Discount ${price.discountPercent}</span>
    </span>
  `;
}

function linePriceBreakdownText(salePrice: string | number, regularPrice?: string | number | null): string {
  const price = linePriceBreakdown(salePrice, regularPrice);
  return `Reg ${formatReportMoney(price.regularCents)} | Discount ${price.discountPercent} | Paid ${formatReportMoney(price.saleCents)}`;
}

function fulfillmentLabel(value: string | null | undefined): string {
  switch ((value ?? "").trim()) {
    case "takeaway":
      return "Takeaway";
    case "special_order":
      return "Special order";
    case "wedding_order":
      return "Wedding order";
    case "custom":
      return "Custom order";
    case "layaway":
      return "Layaway";
    default:
      return reportLabel(value);
  }
}

type ZReportPrintTransaction = {
  created_at: string;
  payment_method: string;
  amount: string;
  payments?: {
    payment_method: string;
    amount: string;
    check_number?: string | null;
  }[] | null;
  customer_name: string;
  transaction_display_id?: string | null;
  transaction_status?: string | null;
  transaction_total?: string | null;
  transaction_paid?: string | null;
  transaction_balance_due?: string | null;
  shipping_amount?: string | null;
  items?: ZReportAuditItem[];
  register_lane: number;
};

function zReportTransactionKey(transaction: ZReportPrintTransaction): string {
  const displayId = transaction.transaction_display_id?.trim();
  if (displayId) return `display:${displayId}`;
  return [
    transaction.created_at,
    transaction.customer_name,
    transaction.transaction_total ?? "",
    transaction.register_lane,
  ].join("|");
}

function tenderLinesForTransaction(transaction: ZReportPrintTransaction) {
  if (transaction.payments?.length) return transaction.payments;
  return [{
    payment_method: transaction.payment_method,
    amount: transaction.amount,
    check_number: null,
  }];
}

function normalizeZReportTransactions(transactions: ZReportPrintTransaction[]): ZReportPrintTransaction[] {
  const grouped = new Map<string, ZReportPrintTransaction>();
  for (const transaction of transactions) {
    const key = zReportTransactionKey(transaction);
    const existing = grouped.get(key);
    const tenderLines = tenderLinesForTransaction(transaction);
    if (!existing) {
      grouped.set(key, {
        ...transaction,
        payments: tenderLines,
        payment_method: tenderLines.length > 1 ? "split" : transaction.payment_method,
      });
      continue;
    }

    const mergedPayments = [...tenderLinesForTransaction(existing), ...tenderLines];
    const paymentTotals = new Map<string, { payment_method: string; amountCents: number; check_number?: string | null }>();
    for (const payment of mergedPayments) {
      const method = payment.payment_method || "unknown";
      const checkNumber = payment.check_number?.trim() || null;
      const mapKey = `${method}|${checkNumber ?? ""}`;
      const current = paymentTotals.get(mapKey) ?? {
        payment_method: method,
        amountCents: 0,
        check_number: checkNumber,
      };
      current.amountCents += parseMoneyToCents(payment.amount);
      paymentTotals.set(mapKey, current);
    }
    const payments = Array.from(paymentTotals.values()).map((payment) => ({
      payment_method: payment.payment_method,
      amount: centsToFixed2(payment.amountCents),
      check_number: payment.check_number,
    }));
    const amountCents = payments.reduce((sum, payment) => sum + parseMoneyToCents(payment.amount), 0);
    grouped.set(key, {
      ...existing,
      amount: centsToFixed2(amountCents),
      payment_method: payments.length > 1 ? "split" : payments[0]?.payment_method ?? existing.payment_method,
      payments,
      items: existing.items?.length ? existing.items : transaction.items,
      transaction_total: existing.transaction_total ?? transaction.transaction_total,
      transaction_paid: existing.transaction_paid ?? transaction.transaction_paid,
      transaction_balance_due: existing.transaction_balance_due ?? transaction.transaction_balance_due,
    });
  }
  return Array.from(grouped.values());
}

function zReportPaymentTextRows(transaction: ZReportPrintTransaction): string[] {
  return tenderLinesForTransaction(transaction).map((payment) => {
    const check = payment.check_number?.trim() ? ` #${payment.check_number.trim()}` : "";
    return `Payment: ${reportLabel(payment.payment_method)}${check} ${formatReportMoney(payment.amount)}`;
  });
}

function zReportPaymentRows(transaction: ZReportPrintTransaction): string {
  return zReportPaymentTextRows(transaction)
    .map((payment) => escapeReportHtml(payment))
    .join("<br>");
}

export async function openProfessionalZReportPrint(opts: {
  title: string;
  sessionId: string;
  action?: ReportPrintAction;
  registerOrdinal?: number | null;
  cashierLabel?: string | null;
  openedAt?: string | null;
  openingCents: number;
  cashSalesCents: number;
  netAdjustmentsCents: number;
  roundingAdjustmentsCents?: number;
  expectedCents: number;
  actualCents: number;
  discrepancyCents: number;
  cashDepositDate?: string | null;
  cashDepositAmountCents?: number;
  closingNotes?: string | null;
  closingComments?: string | null;
  tenders: ZReportTenderRow[];
  overrideSummary: ZReportOverrideRow[];
  /** Per-lane tender breakdown when multiple registers share one till shift. */
  tendersByLane?: { register_lane: number; tenders: ZReportTenderRow[] }[];
  manualDrawerOpens?: ZReportManualDrawerOpenRow[];
  qboActivityDate?: string | null;
  qboJournal?: ZReportQboJournal | null;
  qboJournalError?: string | null;
  inventoryActivity?: ZReportInventoryActivityRow[];
  /** Optional payment lines for audit trail. */
  transactions?: ZReportPrintTransaction[];
	  pickupsToday?: {
	    occurred_at: string;
	    customer_name?: string | null;
	    customer_code?: string | null;
	    short_id?: string | null;
	    sales_total?: string | null;
	    transaction_total?: string | null;
	    items?: {
	      name: string;
	      sku: string;
	      quantity: number;
	    }[] | null;
  }[];
  newOrdersCount?: number;
  ordersPickedUpCount?: number;
  todayAppointmentsCount?: number;
	  newAppointmentsCount?: number;
	  newWeddingPartiesCount?: number;
	  newInvoicesCount?: number;
	  salesCount?: number;
	  salesTaxTotal?: string | null;
	  cashCollected?: string | null;
	  depositsCollected?: string | null;
	  netSales?: string | null;
	}): Promise<boolean> {
  const target = createPrintDocument(`${opts.title} — ${opts.sessionId}`);

  const ord = opts.registerOrdinal != null ? ` #${opts.registerOrdinal}` : "";
  const reportPrinter = reportPrinterName();

  const overrideRows = opts.overrideSummary
    .map(
      (o) =>
        `<tr><td>${escapeReportHtml(reportLabel(o.reason))}</td><td class="center">${o.line_count}</td><td class="money">${formatReportMoney(o.total_delta)}</td></tr>`,
    )
    .join("");

  const manualDrawerRows = (opts.manualDrawerOpens ?? [])
    .map((event) => {
      const tm = new Date(event.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      return `<tr><td>${escapeReportHtml(tm)}</td><td>${escapeReportHtml(event.staff_name)}</td><td>${escapeReportHtml(event.reason)}</td></tr>`;
    })
    .join("");

  const transactions = normalizeZReportTransactions(opts.transactions ?? []);
  const transactionHasFulfillment = (transaction: ZReportPrintTransaction, fulfillment: string): boolean =>
    (transaction.items ?? []).some((item) => item.fulfillment === fulfillment);
  const newOrderCount = transactions.filter((transaction) =>
    (transaction.items ?? []).some((item) => ["special_order", "custom", "wedding_order", "layaway"].includes(item.fulfillment)),
  ).length;
  const ordersPickedUpCount = transactions.filter((transaction) =>
    transaction.transaction_status === "fulfilled" || transactionHasFulfillment(transaction, "pickup"),
  ).length;
  const alterationCount = transactions.reduce((sum, transaction) => {
    return sum + (transaction.items ?? []).reduce((itemSum, item) => {
      return item.line_kind === "alteration_service" ? itemSum + Math.max(item.quantity, 0) : itemSum;
    }, 0);
  }, 0);
  const shippingTotalCents = transactions.reduce(
    (sum, transaction) => sum + parseMoneyToCents(transaction.shipping_amount ?? "0"),
    0,
  );
	  const discountTotalCents = transactions.reduce((sum, transaction) => {
	    return sum + (transaction.items ?? []).reduce((itemSum, item) => {
	      const regularCents = parseMoneyToCents(item.original_unit_price ?? item.unit_price);
	      const saleCents = parseMoneyToCents(item.overridden_unit_price ?? item.unit_price);
	      return itemSum + Math.max(regularCents - saleCents, 0) * Math.max(item.quantity, 0);
	    }, 0);
	  }, 0);
  const discountTransactionCount = transactions.filter((transaction) =>
    (transaction.items ?? []).some((item) => {
      const regularCents = parseMoneyToCents(item.original_unit_price ?? item.unit_price);
      const saleCents = parseMoneyToCents(item.overridden_unit_price ?? item.unit_price);
      return regularCents > saleCents;
    }),
  ).length;
  const transactionCreditCardTotalCents = transactions.reduce((sum, transaction) => {
    return sum + tenderLinesForTransaction(transaction).reduce((paymentSum, payment) => {
      return isCreditCardTender(payment.payment_method)
        ? paymentSum + parseMoneyToCents(payment.amount)
        : paymentSum;
    }, 0);
  }, 0);
  const rmsChargeTotalCents = transactions.reduce((sum, transaction) => {
    return sum + tenderLinesForTransaction(transaction).reduce((paymentSum, payment) => {
      return isRmsChargeTender(payment.payment_method)
        ? paymentSum + parseMoneyToCents(payment.amount)
        : paymentSum;
    }, 0);
  }, 0);
	  const rmsPaymentTotalCents = transactions.reduce((sum, transaction) => {
	    return sum + (transaction.items ?? []).reduce((itemSum, item) => {
	      return item.line_kind === "rms_charge_payment"
	        ? itemSum + parseMoneyToCents(item.unit_price) * Math.max(item.quantity, 0)
	        : itemSum;
	    }, 0);
	  }, 0);
	  const newLayawayCount = transactions.filter((transaction) =>
	    (transaction.items ?? []).some((item) => item.fulfillment === "layaway"),
	  ).length;
	  const pickupTotalCents = (opts.pickupsToday ?? []).reduce(
	    (sum, pickup) => sum + parseMoneyToCents(pickup.sales_total ?? pickup.transaction_total ?? "0"),
	    0,
	  );
	  const pickupTotalCount = opts.pickupsToday?.length ?? 0;
	  const newOrdersDisplayCount = opts.newOrdersCount ?? newOrderCount;
  const ordersPickedUpDisplayCount = opts.ordersPickedUpCount ?? ordersPickedUpCount;
  const creditCardTotalCents = creditCardTenderTotalCents(opts.tenders) || transactionCreditCardTotalCents;
  const creditCardTxCount = creditCardTenderCount(opts.tenders) || transactions.filter((transaction) =>
    tenderLinesForTransaction(transaction).some((payment) => isCreditCardTender(payment.payment_method)),
  ).length;
  const normalizedTenderRows = tenderRowsWithZeros(opts.tenders, {
    rms_payment: { amountCents: rmsPaymentTotalCents, txCount: rmsPaymentTotalCents === 0 ? 0 : 1 },
  });
  const tendersRows = normalizedTenderRows
    .map(
      (t) =>
        `<tr><td>${escapeReportHtml(t.label)}</td><td class="center">${t.txCount}</td><td class="money">${formatReportMoney(t.amountCents)}</td></tr>`,
    )
    .join("");
  const byLaneSections =
    opts.tendersByLane && opts.tendersByLane.length > 0
      ? opts.tendersByLane
          .map((lane) => {
            const cashTotal = lane.tenders
              .filter((tender) => normalizedTenderKey(tender.payment_method) === "cash")
              .reduce((sum, tender) => sum + parseMoneyToCents(tender.total_amount), 0);
            const cashCount = lane.tenders
              .filter((tender) => normalizedTenderKey(tender.payment_method) === "cash")
              .reduce((sum, tender) => sum + tender.tx_count, 0);
            const ccTotal = creditCardTenderTotalCents(lane.tenders);
            const ccCount = creditCardTenderCount(lane.tenders);
            return `
              <div class="lane-block">
                <p class="subhead">Register #${lane.register_lane}</p>
                <table>
                  <tbody>
                    <tr><td>Cash Total</td><td class="center">${cashCount}</td><td class="money">${formatReportMoney(cashTotal)}</td></tr>
                    <tr><td>CC Total</td><td class="center">${ccCount}</td><td class="money">${formatReportMoney(ccTotal)}</td></tr>
                  </tbody>
                </table>
              </div>
            `;
          })
          .join("")
      : "";

  const txAuditRows =
    transactions.length > 0
      ? transactions
          .map((t) => {
            const tm = new Date(t.created_at).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const transactionSubtotalBeforeTaxCents = auditItemsSubtotalBeforeTaxCents(t.items);
            const visibleItems = (t.items ?? []).filter(isVisibleAuditItem).slice(0, 4);
            const internalItems = (t.items ?? []).filter((item) => item.is_internal);
            const giftCardIssued = internalItems.find((item) => item.line_kind === "pos_gift_card_load");

            const itemsHtml = visibleItems.map(item => `
              <div class="print-item-row">
                <span><strong>${item.quantity}× ${item.name}</strong><br><span class="muted mono">${item.sku}${auditItemKindLabel(item) ? ` · ${auditItemKindLabel(item)}` : ""}${item.fulfillment ? ` · ${fulfillmentLabel(item.fulfillment)}` : ""}</span></span>
                ${linePriceBreakdownHtml(item.unit_price, item.original_unit_price ?? item.unit_price)}
              </div>
            `).join("");

            const extraCount = Math.max(0, (t.items ?? []).filter(isVisibleAuditItem).length - visibleItems.length);
            const notes = [
              extraCount > 0 ? `+${extraCount} more line${extraCount === 1 ? "" : "s"}` : null,
              giftCardIssued ? "Gift card issued on this sale" : null,
            ].filter(Boolean).join(" · ");

            const paymentRows = zReportPaymentRows(t);
            const chips = [
              t.transaction_status ? reportLabel(t.transaction_status) : null,
            ].filter(Boolean).map((chip) => `<span class="chip">${chip}</span>`).join("");

            return `
              <section class="activity-card">
                <div class="activity-left">
                  <div class="pill">${reportLabel(t.payment_method)}</div>
                  <div class="time">${tm}</div>
                  <div class="customer">${t.customer_name || "Walk-in Customer"}</div>
                  <div class="chips">${t.transaction_display_id ? `<span class="chip mono">Transaction ${t.transaction_display_id}</span>` : ""}<span class="chip mono">Lane #${t.register_lane}</span>${chips}</div>
                </div>
                <div class="activity-items">
                  <div class="section-label">Line Items</div>
                  ${itemsHtml || `<div class="muted" style="padding:18px 0;text-align:center;">No item details recorded for this transaction</div>`}
                  ${notes ? `<div class="muted" style="font-size:9px;margin-top:8px;">${notes}</div>` : ""}
                </div>
                <div class="activity-money">
                  <div class="money-label">Transaction Amount</div>
                  <div class="money-total">${formatReportMoney(t.amount)}</div>
                  ${paymentRows ? `<div class="money-sub">${paymentRows}</div>` : ""}
                  <div class="money-sub">Subtotal Before Tax: ${formatReportMoney(transactionSubtotalBeforeTaxCents)}</div>
                  ${t.transaction_total ? `<div class="money-sub">Sale Total: ${formatReportMoney(t.transaction_total)}</div>` : ""}
                  ${t.transaction_paid ? `<div class="money-sub">Paid: ${formatReportMoney(t.transaction_paid)}</div>` : ""}
                  ${t.transaction_balance_due && parseMoneyToCents(t.transaction_balance_due) > 0 ? `<div class="money-due">Balance: ${formatReportMoney(t.transaction_balance_due)}</div>` : ""}
                </div>
              </section>
            `;
          })
          .join("")
      : "";
  const pickupRows = (opts.pickupsToday ?? [])
    .map((pickup) => {
      const tm = new Date(pickup.occurred_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const customerInfo = [
        pickup.customer_name,
        pickup.customer_code ? `(#${pickup.customer_code})` : null,
      ].filter(Boolean).join(" ");
      const itemRows = (pickup.items ?? []).map((item) => `
        <div class="pickup-item">
          <span><strong>${escapeReportHtml(`${item.quantity}x ${item.name}`)}</strong></span>
          <span class="mono muted">${escapeReportHtml(item.sku)}</span>
        </div>
      `).join("");
      return `
        <section class="pickup-row">
          <div>
            <div class="time">${escapeReportHtml(tm)}</div>
            <div class="customer">${escapeReportHtml(customerInfo || "Walk-in Customer")}</div>
            ${pickup.short_id ? `<div class="chips"><span class="chip mono">Transaction ${escapeReportHtml(pickup.short_id)}</span></div>` : ""}
          </div>
          <div>${itemRows || `<div class="muted">No picked-up item details recorded.</div>`}</div>
        </section>
      `;
    })
    .join("");

  const qboJournalRows =
    opts.qboJournal && opts.qboJournal.lines.length > 0
      ? opts.qboJournal.lines
          .map((line) => `<tr>
            <td><strong>${escapeReportHtml(line.qbo_account_name)}</strong><br><span class="muted mono">${escapeReportHtml(line.qbo_account_id)}</span></td>
            <td>${escapeReportHtml(line.memo)}</td>
            <td class="money">${parseMoneyToCents(line.debit) !== 0 ? formatReportMoney(line.debit) : ""}</td>
            <td class="money">${parseMoneyToCents(line.credit) !== 0 ? formatReportMoney(line.credit) : ""}</td>
          </tr>`)
          .join("")
      : "";

  const qboWarnings = opts.qboJournal?.warnings?.length
    ? opts.qboJournal.warnings.map((warning) => `<li>${escapeReportHtml(warning)}</li>`).join("")
    : "";

  const dc = opts.discrepancyCents;
  const statusLabel = dc === 0 ? "BALANCED" : dc < 0 ? "SHORTFALL" : "OVERAGE";
  const statusColor = dc === 0 ? "#059669" : "#dc2626";
  const closingNotes = opts.closingNotes?.trim();
  const closingComments = opts.closingComments?.trim();
  const cashDepositDate = opts.cashDepositDate?.trim()
    ? new Date(`${opts.cashDepositDate}T00:00:00`).toLocaleDateString()
    : "Not recorded";
  const cashDepositAmountCents = opts.cashDepositAmountCents ?? Math.max(0, opts.actualCents - opts.openingCents);
  const generatedAt = new Date().toLocaleString();
  const subtotalBeforeTaxCents = auditSubtotalBeforeTaxCents(transactions);
  const zReportTextLines = [
    "RIVERSIDE MEN'S SHOP",
    "Z-Report Reconciliation Audit",
    `Generated: ${generatedAt}`,
    `Report ID: ${opts.sessionId}`,
    `Register Group: ${ord ? `Register Group${ord}` : "Register Group"}`,
    `Shift Staff Member: ${opts.cashierLabel || "System Admin"}`,
    opts.openedAt ? `Shift Start: ${new Date(opts.openedAt).toLocaleString()}` : "",
    `Assigned Reports Printer: ${reportPrinter}`,
    "",
    "SALES SUMMARY",
    `Transactions: ${opts.salesCount ?? transactions.length}`,
    `Tax Collected: ${formatReportMoney(opts.salesTaxTotal ?? "0")}`,
    `Cash Collected: ${formatReportMoney(opts.cashCollected ?? opts.cashSalesCents)}`,
    `Deposits Taken: ${formatReportMoney(opts.depositsCollected ?? "0")}`,
    `New Vendor Invoices: ${opts.newInvoicesCount ?? 0}`,
    `New Orders: ${newOrdersDisplayCount}`,
    `Orders Picked Up: ${ordersPickedUpDisplayCount}`,
    `Credit Card Total: ${moneyWithCount(creditCardTotalCents, creditCardTxCount)}`,
    `RMS Payments: ${formatReportMoney(rmsPaymentTotalCents)}`,
    `RMS Charge: ${formatReportMoney(rmsChargeTotalCents)}`,
    `Today's Appointments: ${opts.todayAppointmentsCount ?? 0}`,
    `New Appointments: ${opts.newAppointmentsCount ?? 0}`,
    `New Layaways: ${newLayawayCount}`,
    `Picked Up: ${moneyWithCount(pickupTotalCents, pickupTotalCount)}`,
    `Total Alterations: ${alterationCount}`,
    `New Wedding Parties: ${opts.newWeddingPartiesCount ?? 0}`,
    `Shipping Total: ${formatReportMoney(shippingTotalCents)}`,
    `Discounts Total: ${moneyWithCount(discountTotalCents, discountTransactionCount)}`,
    `Subtotal Before Tax: ${formatReportMoney(opts.netSales ?? subtotalBeforeTaxCents)}`,
    `Merchandise Subtotal: ${formatReportMoney(opts.netSales ?? subtotalBeforeTaxCents)}`,
    "",
    "COMBINED TENDERS",
    ...normalizedTenderRows.map(
      (t) => `${t.label} | Transactions: ${t.txCount} | Total: ${formatReportMoney(t.amountCents)}`,
    ),
    "",
    ...(opts.tendersByLane?.length
      ? [
          "BREAKDOWN BY REGISTER",
          ...opts.tendersByLane.flatMap((lane) => {
            const cashTotal = lane.tenders
              .filter((tender) => normalizedTenderKey(tender.payment_method) === "cash")
              .reduce((sum, tender) => sum + parseMoneyToCents(tender.total_amount), 0);
            const cashCount = lane.tenders
              .filter((tender) => normalizedTenderKey(tender.payment_method) === "cash")
              .reduce((sum, tender) => sum + tender.tx_count, 0);
            const ccTotal = creditCardTenderTotalCents(lane.tenders);
            const ccCount = creditCardTenderCount(lane.tenders);
            return [
              `Register #${lane.register_lane}`,
              `  Cash Total | Transactions: ${cashCount} | Total: ${formatReportMoney(cashTotal)}`,
              `  CC Total | Transactions: ${ccCount} | Total: ${formatReportMoney(ccTotal)}`,
            ];
          }),
          "",
        ]
      : []),
    "CASH RECONCILIATION",
    `Opening Float: ${formatReportMoney(opts.openingCents)}`,
    `Cash Sales (Gross): ${formatReportMoney(opts.cashSalesCents)}`,
    opts.roundingAdjustmentsCents !== undefined
      ? `Cash Rounding: ${formatReportMoney(opts.roundingAdjustmentsCents)}`
      : "",
    `Drawer Adjustments: ${formatReportMoney(opts.netAdjustmentsCents)}`,
    `Expected Cash: ${formatReportMoney(opts.expectedCents)}`,
    `Actual Counted: ${formatReportMoney(opts.actualCents)}`,
    `Daily Cash Deposit: ${formatReportMoney(cashDepositAmountCents)}`,
    `Deposit Date: ${cashDepositDate}`,
    `Status: ${statusLabel}`,
    `Over/Short: ${formatReportMoney(dc)}`,
    "",
    ...(opts.overrideSummary.length > 0
      ? [
          "PRICE OVERRIDE AUDIT",
          ...opts.overrideSummary.map(
            (row) =>
              `${reportLabel(row.reason)} | Occurrences: ${row.line_count} | Retail Delta: ${formatReportMoney(
                row.total_delta,
              )}`,
          ),
          "",
        ]
      : []),
    ...(opts.manualDrawerOpens?.length
      ? [
          "MANUAL DRAWER OPENS",
          ...opts.manualDrawerOpens.map(
            (event) =>
              `${new Date(event.created_at).toLocaleString()} | ${textValue(event.staff_name)} | ${textValue(
                event.reason,
              )}`,
          ),
          "",
        ]
      : []),
    ...(closingNotes || closingComments
      ? [
          "CLOSING NOTES",
          closingNotes ? `Internal Shift Notes: ${closingNotes}` : "",
          closingComments ? `Closing Comments: ${closingComments}` : "",
          "",
        ]
      : []),
    ...(transactions.length
      ? [
          "TRANSACTION LIST",
          ...transactions.flatMap((tx) => {
            const transactionSubtotalBeforeTaxCents = auditItemsSubtotalBeforeTaxCents(tx.items);
            const header = `${new Date(tx.created_at).toLocaleString()} | ${reportLabel(tx.payment_method)} | ${
              tx.customer_name || "Walk-in Customer"
            } | Lane #${tx.register_lane} | Amount: ${formatReportMoney(tx.amount)}${
              tx.transaction_display_id ? ` | Transaction: ${tx.transaction_display_id}` : ""
            }`;
            const items = (tx.items ?? [])
              .filter(isVisibleAuditItem)
              .map(
                (item) =>
                  `  ${item.quantity}x ${textValue(item.name)} | ${textValue(item.sku)}${auditItemKindLabel(item) ? ` | ${auditItemKindLabel(item)}` : ""} | ${fulfillmentLabel(
                    item.fulfillment,
                  )} | ${linePriceBreakdownText(item.unit_price, item.original_unit_price ?? item.unit_price)}`,
              );
            return [
              header,
              ...zReportPaymentTextRows(tx).map((payment) => `  ${payment}`),
              `  Subtotal Before Tax: ${formatReportMoney(transactionSubtotalBeforeTaxCents)}`,
              ...(items.length > 0 ? items : ["  No item details recorded"]),
            ];
          }),
          "",
        ]
      : []),
    ...(opts.pickupsToday?.length
      ? [
          "PICKUPS TODAY",
          ...opts.pickupsToday.flatMap((pickup) => {
            const customer = [
              pickup.customer_name,
              pickup.customer_code ? `(#${pickup.customer_code})` : null,
            ].filter(Boolean).join(" ") || "Walk-in Customer";
            const header = `${new Date(pickup.occurred_at).toLocaleString()} | ${customer}${
              pickup.short_id ? ` | Transaction: ${pickup.short_id}` : ""
            }`;
            const items = (pickup.items ?? []).map((item) => `  ${item.quantity}x ${textValue(item.name)} | ${textValue(item.sku)}`);
            return [header, ...(items.length > 0 ? items : ["  No picked-up item details recorded"])];
          }),
          "",
        ]
      : []),
    ...(opts.qboJournal?.lines?.length || opts.qboJournalError
      ? [
          "QBO JOURNAL ENTRY PREVIEW",
          opts.qboJournalError ? `Error: ${opts.qboJournalError}` : "",
          opts.qboJournal
            ? `Activity Date: ${opts.qboActivityDate ?? opts.qboJournal.activity_date} | Debits: ${formatReportMoney(
                opts.qboJournal.totals.debits,
              )} | Credits: ${formatReportMoney(opts.qboJournal.totals.credits)} | ${
                opts.qboJournal.totals.balanced ? "Balanced" : "Needs review"
              }`
            : "",
          ...(opts.qboJournal?.lines ?? []).map(
            (line) =>
              `${textValue(line.qbo_account_name)} (${textValue(line.qbo_account_id)}) | ${textValue(
                line.memo,
              )} | Debit: ${line.debit ? formatReportMoney(line.debit) : ""} | Credit: ${
                line.credit ? formatReportMoney(line.credit) : ""
              }`,
          ),
          ...(opts.qboJournal?.warnings ?? []).map((warning) => `Warning: ${warning}`),
          "",
        ]
      : []),
    "Manager Signature: ______________________________",
    "Date of Verification: ___________________________",
  ];

  target.doc.write(`<!DOCTYPE html><html><head><title>${opts.title} — ${opts.sessionId}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    @page { size: letter portrait; margin: 0.38in; }
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 9.5px; line-height: 1.32; color: #0f172a; padding: 0; }
    h1 { font-size: 19px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 10.5px; font-weight: 800; margin: 14px 0 5px; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 14px; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .summary-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; }
    .stat-label { font-size: 7.5px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 2px; }
    .stat-value { font-family: 'JetBrains Mono', monospace; font-size: 13px; font-weight: 800; margin: 0; }
    .discrepancy-box { margin-top: 8px; border: 1.5px solid ${statusColor}; background: ${dc === 0 ? "#ecfdf5" : "#fef2f2"}; padding: 9px 11px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 7.5px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; padding: 4px 0; border-bottom: 1px solid #e2e8f0; }
    td { border-bottom: 1px solid #f1f5f9; padding: 3.5px 0; vertical-align: top; }
    .muted { color: #64748b; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .money { font-family: 'JetBrains Mono', monospace; font-weight: 700; text-align: right; white-space: nowrap; }
    .center { text-align: center; }
    .subhead { border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 8px; font-weight: 800; letter-spacing: 0.1em; margin: 0 0 4px; padding-bottom: 3px; text-transform: uppercase; }
    .lane-block { break-inside: avoid; margin-top: 8px; }
    .reconciliation-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; margin-top: 16px; }
    .cash-line { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f1f5f9; }
    .signature-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
    .page-break { break-before: page; page-break-before: always; }
    .quick-look-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 14px; }
    .activity-card { display: grid; grid-template-columns: 1.05fr 1.6fr 1fr; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; margin-top: 14px; break-inside: avoid; }
    .activity-left, .activity-money { background: #f8fafc; padding: 18px; }
    .activity-items { padding: 18px; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
    .pill { display: inline-block; border: 1px solid #cbd5e1; border-radius: 999px; padding: 5px 10px; font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
    .time { margin-top: 8px; color: #64748b; font-size: 10px; font-weight: 700; }
    .customer { margin-top: 14px; font-size: 14px; font-weight: 800; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    .chip { background: #f1f5f9; border-radius: 999px; color: #475569; display: inline-block; font-size: 9px; font-weight: 800; padding: 4px 7px; text-transform: uppercase; }
    .section-label { color: #64748b; font-size: 10px; font-weight: 800; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.1em; }
    .print-item-row { align-items: flex-start; border-top: 1px solid #e2e8f0; color: #0f172a; display: flex; font-size: 10px; justify-content: space-between; gap: 12px; padding: 8px 0; }
    .line-price-block { align-items: flex-end; display: flex; flex-direction: column; font-family: 'JetBrains Mono', monospace; gap: 2px; min-width: 110px; text-align: right; }
    .line-sale-price { font-weight: 800; white-space: nowrap; }
    .line-discount-meta { color: #64748b; font-size: 8px; font-weight: 700; white-space: nowrap; }
    .activity-money { text-align: right; }
    .money-label { color: #64748b; font-size: 10px; font-weight: 800; }
    .money-total { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 800; margin-top: 4px; }
    .money-sub, .money-good, .money-due { font-size: 10px; font-weight: 800; margin-top: 8px; }
    .money-sub { color: #64748b; }
    .money-good { color: #047857; }
    .money-due { color: #b45309; }
    .pickup-row { border: 1px solid #e2e8f0; border-radius: 12px; display: grid; grid-template-columns: 1fr 2fr; gap: 14px; margin-top: 10px; padding: 12px; break-inside: avoid; }
    .pickup-item { align-items: baseline; border-top: 1px solid #f1f5f9; display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE MEN'S SHOP</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Z-Report Reconciliation Audit</p>
      <p class="muted" style="font-size: 10px; margin-top: 2px;">Generated: ${generatedAt}</p>
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Report ID</p>
      <p class="mono" style="font-weight: 700;">${opts.sessionId}</p>
      <p class="muted" style="margin-top: 2px;">Printed from <span style="font-weight:800;color:#0f172a">${escapeReportHtml(reportPrinter)}</span></p>
    </div>
  </div>

	  <div class="header-grid">
	    <div>
	      <p class="stat-label">Shift Staff Member</p>
      <p style="font-size: 16px; font-weight: 700;">${opts.cashierLabel || "System Admin"}</p>
      ${opts.openedAt ? `<p class="muted">Shift Start: ${new Date(opts.openedAt).toLocaleString()}</p>` : ""}
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Register Group</p>
      <p style="font-size: 16px; font-weight: 700;">Register Group ${ord}</p>
	    </div>
	  </div>

	  <div class="reconciliation-grid">
    <div>
      <h2>Combined Tenders (Register Group)</h2>
      <table>
        <thead><tr><th>Payment Method</th><th style="text-align:center">Transactions</th><th style="text-align:right">Total Amount</th></tr></thead>
        <tbody>${tendersRows || "<tr><td colspan='3' class='muted'>No payment activity recorded</td></tr>"}</tbody>
      </table>

      ${byLaneSections ? `<h2>Breakdown by Register</h2>${byLaneSections}` : ""}
    </div>

    <div>
      <h2>Cash Reconciliation</h2>
      <div>
        <div class="cash-line">
          <span class="muted">Opening Float</span>
          <span class="mono" style="font-weight: 700;">${formatReportMoney(opts.openingCents)}</span>
        </div>
        <div class="cash-line">
          <span class="muted">Cash Sales (Gross)</span>
          <span class="mono" style="font-weight: 700;">+${formatReportMoney(opts.cashSalesCents)}</span>
        </div>
        ${opts.roundingAdjustmentsCents !== undefined ? `
        <div class="cash-line">
          <span class="muted">Cash Rounding</span>
          <span class="mono" style="font-weight: 700;">${opts.roundingAdjustmentsCents >= 0 ? "+" : ""}${formatReportMoney(opts.roundingAdjustmentsCents)}</span>
        </div>` : ""}
        <div class="cash-line">
          <span class="muted">Drawer Adjustments</span>
          <span class="mono" style="font-weight: 700;">${opts.netAdjustmentsCents >= 0 ? "+" : ""}${formatReportMoney(opts.netAdjustmentsCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 7px 0; margin-top: 3px; border-top: 1.5px solid #e2e8f0;">
          <span style="font-weight: 800; text-transform: uppercase;">Expected Cash</span>
          <span class="mono" style="font-weight: 800; font-size: 12px;">${formatReportMoney(opts.expectedCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; background: #f8fafc; border-radius: 7px; margin-top: 3px; padding: 7px;">
          <span style="font-weight: 800; text-transform: uppercase;">Actual Counted</span>
          <span class="mono" style="font-weight: 800; font-size: 12px; color: #0f172a;">${formatReportMoney(opts.actualCents)}</span>
        </div>
        <div style="border: 1px solid #e2e8f0; border-radius: 7px; margin-top: 7px; padding: 7px;">
          <div style="display: flex; justify-content: space-between;">
            <span style="font-weight: 800; text-transform: uppercase;">Daily Cash Deposit</span>
            <span class="mono" style="font-weight: 800; font-size: 12px;">${formatReportMoney(cashDepositAmountCents)}</span>
          </div>
          <div style="display: flex; justify-content: space-between; margin-top: 3px;">
            <span class="muted">Deposit Date</span>
            <span class="mono" style="font-weight: 700;">${escapeReportHtml(cashDepositDate)}</span>
          </div>
        </div>
      </div>

      <div class="discrepancy-box">
        <div>
          <p style="font-size: 10px; font-weight: 800; color: ${statusColor}; letter-spacing: 0.1em; margin-bottom: 2px;">STATUS: ${statusLabel}</p>
          <p style="font-size: 14px; font-weight: 800; color: ${statusColor}; margin: 0;">${formatReportMoney(Math.abs(dc))}</p>
        </div>
      </div>
    </div>
  </div>

  ${overrideRows ? `
    <div style="margin-top: 14px; break-inside: avoid;">
      <h2>Price Override Audit</h2>
      <table>
        <thead><tr><th>Reason for Override</th><th style="text-align:center">Occurrences</th><th style="text-align:right">Total Δ Retail</th></tr></thead>
        <tbody>${overrideRows}</tbody>
      </table>
    </div>
  ` : ""}

  ${manualDrawerRows ? `
    <div style="margin-top: 14px; break-inside: avoid;">
      <h2>Manual Drawer Opens</h2>
      <table>
        <thead><tr><th>Time</th><th>Staff</th><th>Reason</th></tr></thead>
        <tbody>${manualDrawerRows}</tbody>
      </table>
    </div>
  ` : ""}

  ${closingNotes || closingComments ? `
    <div style="margin-top: 14px; break-inside: avoid;">
      <h2>Closing Notes</h2>
      ${closingNotes ? `<p class="stat-label">Internal Shift Notes</p><div style="border:1px solid #e2e8f0;border-radius:8px;padding:9px 10px;white-space:pre-wrap;">${escapeReportHtml(closingNotes)}</div>` : ""}
      ${closingComments ? `<p class="stat-label" style="margin-top:10px;">Closing Comments</p><div style="border:1px solid #e2e8f0;border-radius:8px;padding:9px 10px;white-space:pre-wrap;">${escapeReportHtml(closingComments)}</div>` : ""}
    </div>
  ` : ""}

  <div class="page-break">
	    <h2>Quick Look</h2>
	    <div class="quick-look-grid">
	      <div class="summary-card"><p class="stat-label">Transactions</p><p class="stat-value">${opts.salesCount ?? transactions.length}</p></div>
	      <div class="summary-card"><p class="stat-label">Subtotal Before Tax</p><p class="stat-value">${formatReportMoney(opts.netSales ?? subtotalBeforeTaxCents)}</p></div>
	      <div class="summary-card"><p class="stat-label">Tax Collected</p><p class="stat-value">${formatReportMoney(opts.salesTaxTotal ?? "0")}</p></div>
	      <div class="summary-card"><p class="stat-label">Cash Collected</p><p class="stat-value">${formatReportMoney(opts.cashCollected ?? opts.cashSalesCents)}</p></div>
	      <div class="summary-card"><p class="stat-label">Credit Card Total</p><p class="stat-value">${moneyWithCount(creditCardTotalCents, creditCardTxCount)}</p></div>
	      <div class="summary-card"><p class="stat-label">Deposits Taken</p><p class="stat-value">${formatReportMoney(opts.depositsCollected ?? "0")}</p></div>
	      <div class="summary-card"><p class="stat-label">New Orders</p><p class="stat-value">${newOrdersDisplayCount}</p></div>
	      <div class="summary-card"><p class="stat-label">Orders Picked Up</p><p class="stat-value">${ordersPickedUpDisplayCount}</p></div>
	      <div class="summary-card"><p class="stat-label">RMS Payments</p><p class="stat-value">${formatReportMoney(rmsPaymentTotalCents)}</p></div>
	      <div class="summary-card"><p class="stat-label">RMS Charge</p><p class="stat-value">${formatReportMoney(rmsChargeTotalCents)}</p></div>
	      <div class="summary-card"><p class="stat-label">Merchandise Subtotal</p><p class="stat-value">${formatReportMoney(opts.netSales ?? subtotalBeforeTaxCents)}</p></div>
	      <div class="summary-card"><p class="stat-label">New Appointments</p><p class="stat-value">${opts.newAppointmentsCount ?? 0}</p></div>
	      <div class="summary-card"><p class="stat-label">New Layaways</p><p class="stat-value">${newLayawayCount}</p></div>
	      <div class="summary-card"><p class="stat-label">Picked Up $</p><p class="stat-value">${moneyWithCount(pickupTotalCents, pickupTotalCount)}</p></div>
	      <div class="summary-card"><p class="stat-label">Discounts</p><p class="stat-value">${moneyWithCount(discountTotalCents, discountTransactionCount)}</p></div>
	      <div class="summary-card"><p class="stat-label">New Vendor Invoices</p><p class="stat-value">${opts.newInvoicesCount ?? 0}</p></div>
	      <div class="summary-card"><p class="stat-label">Today's Appts</p><p class="stat-value">${opts.todayAppointmentsCount ?? 0}</p></div>
	      <div class="summary-card"><p class="stat-label">Total Alterations</p><p class="stat-value">${alterationCount}</p></div>
	      <div class="summary-card"><p class="stat-label">New Wedding Parties</p><p class="stat-value">${opts.newWeddingPartiesCount ?? 0}</p></div>
	      <div class="summary-card"><p class="stat-label">Shipping Total</p><p class="stat-value">${formatReportMoney(shippingTotalCents)}</p></div>
	    </div>
	  </div>

  ${txAuditRows ? `
    <div style="margin-top: 14px; page-break-before: auto;">
      <h2>Transaction List</h2>
      ${txAuditRows}
    </div>
  ` : ""}

  ${pickupRows ? `
    <div style="margin-top: 14px;">
      <h2>Pickups Today</h2>
      ${pickupRows}
    </div>
  ` : ""}

  ${qboJournalRows || opts.qboJournalError ? `
    <div style="margin-top: 14px; break-inside: avoid;">
      <h2>QBO Journal Entry Preview</h2>
      ${opts.qboJournalError ? `<div style="border:1px solid #fecaca;background:#fef2f2;border-radius:8px;color:#991b1b;font-weight:700;padding:8px 10px;">${escapeReportHtml(opts.qboJournalError)}</div>` : ""}
      ${qboJournalRows ? `
        <p class="muted" style="margin:0 0 5px;">Activity Date: <strong>${escapeReportHtml(opts.qboActivityDate ?? opts.qboJournal?.activity_date ?? "—")}</strong> · Debits ${formatReportMoney(opts.qboJournal?.totals.debits ?? "0")} · Credits ${formatReportMoney(opts.qboJournal?.totals.credits ?? "0")} · ${opts.qboJournal?.totals.balanced ? "Balanced" : "Needs review"}</p>
        <table style="font-size: 8.2px;">
          <thead><tr><th>Account</th><th>Memo</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead>
          <tbody>${qboJournalRows}</tbody>
        </table>
      ` : ""}
      ${qboWarnings ? `<ul class="muted" style="margin:6px 0 0 14px;padding:0;">${qboWarnings}</ul>` : ""}
    </div>
  ` : ""}

  <div class="signature-grid">
    <div>
      <p class="stat-label">Manager Signature</p>
      <div style="border-bottom: 1px solid #0f172a; height: 26px; margin-top: 5px;"></div>
    </div>
    <div>
      <p class="stat-label">Date of Verification</p>
      <div style="border-bottom: 1px solid #0f172a; height: 26px; margin-top: 5px;"></div>
    </div>
  </div>
  </body></html>`);
  return finishPrintDocument(target, `z-report-${opts.sessionId.slice(0, 8)}.html`, zReportTextLines.join("\n"), {
    action: opts.action ?? "print",
  });
}

export async function openProfessionalDailySalesPrint(opts: {
  title: string;
  rangeLabel: string;
  action?: ReportPrintAction;
  summary: {
    sales_count: number;
    sales_subtotal_no_tax: string;
    sales_tax_total: string;
    net_sales: string;
    appointment_count: number;
    online_order_count: number;
    pickup_count: number;
    special_order_sale_count: number;
    new_wedding_parties_count: number;
    merchant_fees_total: string;
    cash_collected: string;
    deposits_collected: string;
    new_appointment_count?: number;
    new_layaway_count?: number;
    pickup_total?: string;
    pickup_total_count?: number;
    discount_total?: string;
    discount_count?: number;
  };
  activities: {
    occurred_at: string;
    title: string;
    amount_label?: string | null;
    subtotal_before_tax?: string | null;
    tax_total?: string | null;
    kind: string;
    payment_summary?: string | null;
    payments?: {
      method: string;
      amount_label: string;
    }[] | null;
    customer_name?: string | null;
    customer_code?: string | null;
    wedding_party_name?: string | null;
    sales_total?: string | null;
    transaction_total?: string | null;
    deposits_paid?: string | null;
    balance_due?: string | null;
    short_id?: string | null;
    imported_at?: string | null;
    fulfillment_label?: string | null;
    is_takeaway?: boolean | null;
    channel?: string | null;
    items?: {
      name: string;
      sku: string;
      quantity: number;
      reg_price: string;
      price: string;
      fulfillment?: string | null;
      line_kind?: string | null;
    }[] | null;
  }[];
  pickupsToday?: {
    occurred_at: string;
    customer_name?: string | null;
    customer_code?: string | null;
    short_id?: string | null;
    items?: {
      name: string;
      sku: string;
      quantity: number;
      fulfillment?: string | null;
    }[] | null;
    sales_total?: string | null;
    transaction_total?: string | null;
  }[];
}): Promise<boolean> {
  const target = createPrintDocument("Daily Sales Report");

  target.doc.title = "Daily Sales Report";

  const reportPrinter = reportPrinterName();
  const { summary, activities, pickupsToday = [] } = opts;

  const groupedActivities = activities.reduce<Record<string, typeof activities>>((groups, row) => {
    const date = new Date(row.occurred_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    groups[date] = [...(groups[date] ?? []), row];
    return groups;
  }, {});

  const activityRows = Object.entries(groupedActivities)
    .map(([date, rows]) => {
      const groupTotal = rows
        .reduce((sum, row) => sum + (Number.parseFloat(row.sales_total || "0") || 0), 0)
        .toFixed(2);
      const cards = rows.map((row) => {
      const tm = new Date(row.occurred_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const customerInfo = [
        row.customer_name,
        row.customer_code ? `(#${row.customer_code})` : null,
        row.wedding_party_name ? `• ${row.wedding_party_name}` : null
      ].filter(Boolean).join(" ");

      const itemsHtml = (row.items || []).map(item => `
        <div class="print-item-row">
          <span><strong>${item.quantity}× ${item.name}</strong><br><span class="muted mono">${item.sku}${item.fulfillment ? ` · ${item.fulfillment.replace(/_/g, " ")}` : ""}</span></span>
          ${linePriceBreakdownHtml(item.price, item.reg_price || item.price)}
        </div>
      `).join("");
      const chips = [
        row.fulfillment_label,
        row.imported_at
          ? `Imported at ${new Date(row.imported_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : null,
        row.channel === "web" ? "Online" : null,
      ].filter(Boolean).map((chip) => `<span class="chip">${chip}</span>`).join("");

      const paymentRows =
        row.payments && row.payments.length > 0
          ? row.payments
              .map(
                (payment) =>
                  `<div class="money-sub">${escapeReportHtml(payment.method)} ${formatReportMoney(payment.amount_label)}</div>`,
              )
              .join("")
          : row.payment_summary
            ? `<div class="money-sub">${escapeReportHtml(row.payment_summary)}</div>`
            : "";

      return `
        <section class="activity-card">
          <div class="activity-left">
            <div class="pill">${row.title}</div>
            <div class="time">${tm}</div>
            <div class="customer">${customerInfo || "Walk-in Customer"}</div>
            <div class="chips">${row.short_id ? `<span class="chip mono">Transaction ${row.short_id}</span>` : ""}${chips}</div>
          </div>
          <div class="activity-items">
            <div class="section-label">Line Items</div>
            ${itemsHtml || `<div class="muted" style="padding:18px 0;text-align:center;">No item details recorded for this transaction</div>`}
          </div>
          <div class="activity-money">
            <div class="money-label">Sales Total</div>
            <div class="money-total">${row.sales_total ? `$${row.sales_total}` : row.amount_label || "—"}</div>
            <div class="money-sub">Subtotal Before Tax: ${row.subtotal_before_tax ? `$${row.subtotal_before_tax}` : "—"}</div>
            ${row.tax_total ? `<div class="money-sub">Tax: ${formatReportMoney(row.tax_total)}</div>` : ""}
            <div class="money-sub">Transaction Total: ${row.transaction_total ? `$${row.transaction_total}` : "—"}</div>
            ${paymentRows}
            ${row.deposits_paid ? `<div class="money-good">Paid: $${row.deposits_paid}</div>` : ""}
            ${row.balance_due && parseFloat(row.balance_due) > 0 ? `<div class="money-due">Balance: $${row.balance_due}</div>` : ""}
          </div>
        </section>
      `;
      }).join("");
      return `
        <section class="activity-group">
          <div class="group-head">
            <div>
              <span class="group-date">${date}</span>
              <span class="group-count">(${rows.length} transaction${rows.length === 1 ? "" : "s"})</span>
            </div>
            <div class="group-total"><span>Total:</span> $${groupTotal}</div>
          </div>
          ${cards}
        </section>
      `;
    })
    .join("");

  const pickupRows = pickupsToday
    .map((pickup) => {
      const tm = new Date(pickup.occurred_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const customerInfo = [
        pickup.customer_name,
        pickup.customer_code ? `(#${pickup.customer_code})` : null,
      ].filter(Boolean).join(" ");
      const itemRows = (pickup.items ?? []).map((item) => `
        <div class="pickup-item">
          <span><strong>${escapeReportHtml(`${item.quantity}x ${item.name}`)}</strong></span>
          <span class="mono muted">${escapeReportHtml(item.sku)}</span>
        </div>
      `).join("");
      return `
        <section class="pickup-row">
          <div>
            <div class="time">${escapeReportHtml(tm)}</div>
            <div class="customer">${escapeReportHtml(customerInfo || "Walk-in Customer")}</div>
            ${pickup.short_id ? `<div class="chips"><span class="chip mono">Transaction ${escapeReportHtml(pickup.short_id)}</span></div>` : ""}
          </div>
          <div>${itemRows || `<div class="muted">No picked-up item details recorded.</div>`}</div>
        </section>
      `;
    })
    .join("");

  // Calculate grand total across all groups
  const grandTotal = Object.values(groupedActivities)
    .flat()
    .reduce((sum, row) => sum + (Number.parseFloat(row.sales_total || "0") || 0), 0)
    .toFixed(2);
  const creditCardTotalCents = activities.reduce((sum, row) => {
    return sum + (row.payments ?? []).reduce((paymentSum, payment) => {
      return isCreditCardTender(payment.method)
        ? paymentSum + parseMoneyToCents(payment.amount_label)
        : paymentSum;
    }, 0);
  }, 0);
  const rmsChargeTotalCents = activities.reduce((sum, row) => {
    return sum + (row.payments ?? []).reduce((paymentSum, payment) => {
      return isRmsChargeTender(payment.method)
        ? paymentSum + parseMoneyToCents(payment.amount_label)
        : paymentSum;
    }, 0);
  }, 0);
  const rmsPaymentTotalCents = activities.reduce((sum, row) => {
    return sum + (row.items ?? []).reduce((itemSum, item) => {
      return item.line_kind === "rms_charge_payment"
        ? itemSum + parseMoneyToCents(item.price) * item.quantity
        : itemSum;
    }, 0);
  }, 0);
  const creditCardPaymentCount = activities.filter((row) =>
    (row.payments ?? []).some((payment) => isCreditCardTender(payment.method)),
  ).length;
  const newLayawayCount = summary.new_layaway_count ?? activities.filter((row) =>
    (row.items ?? []).some((item) => item.fulfillment === "layaway"),
  ).length;
  const pickupTotalCents = summary.pickup_total
    ? parseMoneyToCents(summary.pickup_total)
    : pickupsToday.reduce((sum, pickup) => sum + parseMoneyToCents(pickup.sales_total ?? pickup.transaction_total ?? "0"), 0);
  const pickupTotalCount = summary.pickup_total_count ?? pickupsToday.length;
  const discountTotalCents = summary.discount_total
    ? parseMoneyToCents(summary.discount_total)
    : activities.reduce((sum, row) => {
        const rowDiscount = (row.items ?? []).reduce((itemSum, item) => {
          const regularCents = parseMoneyToCents(item.reg_price || item.price);
          const saleCents = parseMoneyToCents(item.price);
          return itemSum + Math.max(regularCents - saleCents, 0) * Math.max(item.quantity, 0);
        }, 0);
        return sum + rowDiscount;
      }, 0);
  const discountCount = summary.discount_count ?? activities.filter((row) =>
    (row.items ?? []).some((item) => parseMoneyToCents(item.reg_price || item.price) > parseMoneyToCents(item.price)),
  ).length;
  const generatedAt = new Date().toLocaleString();
  const dailyReportTextLines = [
    "RIVERSIDE MEN'S SHOP",
    "Daily Sales & Activity Report",
    `Generated: ${generatedAt}`,
    `Reporting Period: ${opts.rangeLabel}`,
    `Assigned Reports Printer: ${reportPrinter}`,
    "",
    "SUMMARY",
    `Transactions: ${summary.sales_count}`,
    `Subtotal Before Tax: ${formatReportMoney(summary.sales_subtotal_no_tax)}`,
    `Tax Collected: ${formatReportMoney(summary.sales_tax_total)}`,
    `Cash Collected: ${formatReportMoney(summary.cash_collected)}`,
    `Credit Card Total: ${moneyWithCount(creditCardTotalCents, creditCardPaymentCount)}`,
    `Deposits Taken: ${formatReportMoney(summary.deposits_collected)}`,
    `New Orders: ${summary.special_order_sale_count}`,
    `Orders Picked Up: ${summary.pickup_count}`,
    `RMS Payments: ${formatReportMoney(rmsPaymentTotalCents)}`,
    `RMS Charge: ${formatReportMoney(rmsChargeTotalCents)}`,
    `Merchandise Subtotal: ${formatReportMoney(summary.net_sales)}`,
    `New Appointments: ${summary.new_appointment_count ?? 0}`,
    `New Layaways: ${newLayawayCount}`,
    `Picked Up: ${moneyWithCount(pickupTotalCents, pickupTotalCount)}`,
    `Discounts: ${moneyWithCount(discountTotalCents, discountCount)}`,
    "",
    "TRANSACTION LIST",
    ...(activities.length > 0
      ? activities.flatMap((row) => {
          const customerInfo = [
            row.customer_name,
            row.customer_code ? `#${row.customer_code}` : null,
            row.wedding_party_name,
          ]
            .filter(Boolean)
            .join(" | ");
          const header = `${new Date(row.occurred_at).toLocaleString()} | ${textValue(row.title)}${
            row.short_id ? ` | Transaction: ${row.short_id}` : ""
          } | ${
            customerInfo || "Walk-in Customer"
          } | Sales: ${row.sales_total ? formatReportMoney(row.sales_total) : textValue(row.amount_label) || "-"}`;
          const paymentDetails =
            row.payments && row.payments.length > 0
              ? row.payments.map(
                  (payment) => `Payment: ${payment.method} ${formatReportMoney(payment.amount_label)}`,
                )
              : row.payment_summary
                ? [`Payment: ${row.payment_summary}`]
                : [];
          const details = [
            row.short_id ? `Transaction: ${row.short_id}` : "",
            row.imported_at ? `Imported at: ${new Date(row.imported_at).toLocaleString()}` : "",
            ...paymentDetails,
            row.subtotal_before_tax ? `Subtotal Before Tax: ${formatReportMoney(row.subtotal_before_tax)}` : "",
            row.tax_total ? `Tax: ${formatReportMoney(row.tax_total)}` : "",
            row.transaction_total ? `Transaction Total: ${formatReportMoney(row.transaction_total)}` : "",
            row.deposits_paid ? `Paid: ${formatReportMoney(row.deposits_paid)}` : "",
            row.balance_due && Number.parseFloat(row.balance_due) > 0
              ? `Balance: ${formatReportMoney(row.balance_due)}`
              : "",
            row.fulfillment_label ? `Fulfillment: ${row.fulfillment_label}` : "",
            row.channel ? `Channel: ${row.channel}` : "",
          ].filter(Boolean);
          const items = (row.items ?? []).map(
            (item) =>
              `  ${item.quantity}x ${textValue(item.name)} | ${textValue(item.sku)} | ${
                item.fulfillment ? fulfillmentLabel(item.fulfillment) : ""
              } | ${linePriceBreakdownText(item.price, item.reg_price || item.price)}`,
          );
          return [header, ...details.map((detail) => `  ${detail}`), ...(items.length > 0 ? items : [])];
        })
      : ["No activity recorded for this period."]),
    "",
    "PICKUPS TODAY",
    ...(pickupsToday.length > 0
      ? pickupsToday.flatMap((pickup) => {
          const customerInfo = [
            pickup.customer_name,
            pickup.customer_code ? `#${pickup.customer_code}` : null,
          ].filter(Boolean).join(" | ");
          const header = `${new Date(pickup.occurred_at).toLocaleString()}${
            pickup.short_id ? ` | Transaction: ${pickup.short_id}` : ""
          } | ${customerInfo || "Walk-in Customer"}`;
          const items = (pickup.items ?? []).map(
            (item) => `  ${item.quantity}x ${textValue(item.name)} | ${textValue(item.sku)}`,
          );
          return [header, ...(items.length > 0 ? items : ["  No picked-up item details recorded."])];
        })
      : ["No pickups recorded for this period."]),
    "",
    `Grand Total: ${formatReportMoney(grandTotal)}`,
    `End of Summary Audit - Riverside Men's Shop - Generated: ${generatedAt}`,
  ];

  target.doc.write(`<!DOCTYPE html><html><head><title>${opts.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 12px; line-height: 1.5; color: #0f172a; padding: 40px; }
    h1 { font-size: 24px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 14px; font-weight: 800; margin: 30px 0 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    .stat-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 15px; margin-top: 30px; }
    .stat-card { border: 1px solid #e2e8f0; padding: 12px; border-radius: 12px; }
    .stat-label { font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .stat-value { font-size: 16px; font-weight: 800; tabular-nums: true; }
    .muted { color: #64748b; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .activity-group { margin-top: 18px; }
    .group-head { align-items: center; border-bottom: 1px solid #cbd5e1; display: flex; justify-content: space-between; gap: 16px; margin-bottom: 12px; padding-bottom: 8px; }
    .group-date { color: #0f172a; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .group-count { color: #64748b; font-size: 11px; font-weight: 700; margin-left: 6px; }
    .group-total { color: #0f172a; font-size: 13px; font-weight: 800; }
    .group-total span { color: #64748b; }
    .activity-card { display: grid; grid-template-columns: 1.05fr 1.6fr 1fr; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; margin-top: 14px; break-inside: avoid; }
    .activity-left, .activity-money { background: #f8fafc; padding: 18px; }
    .activity-items { padding: 18px; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
    .pill { display: inline-block; border: 1px solid #cbd5e1; border-radius: 999px; padding: 5px 10px; font-size: 9px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; }
    .time { margin-top: 8px; color: #64748b; font-size: 10px; font-weight: 700; }
    .customer { margin-top: 14px; font-size: 14px; font-weight: 800; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    .chip { background: #f1f5f9; border-radius: 999px; color: #475569; display: inline-block; font-size: 9px; font-weight: 800; padding: 4px 7px; text-transform: uppercase; }
    .section-label { color: #64748b; font-size: 10px; font-weight: 800; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.1em; }
    .print-item-row { align-items: flex-start; border-top: 1px solid #e2e8f0; color: #0f172a; display: flex; font-size: 10px; justify-content: space-between; gap: 12px; padding: 8px 0; }
    .line-price-block { align-items: flex-end; display: flex; flex-direction: column; font-family: 'JetBrains Mono', monospace; gap: 2px; min-width: 110px; text-align: right; }
    .line-sale-price { font-weight: 800; white-space: nowrap; }
    .line-discount-meta { color: #64748b; font-size: 8px; font-weight: 700; white-space: nowrap; }
    .activity-money { text-align: right; }
    .money-label { color: #64748b; font-size: 10px; font-weight: 800; }
    .money-total { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 800; margin-top: 4px; }
    .money-sub, .money-good, .money-due { font-size: 10px; font-weight: 800; margin-top: 8px; }
    .money-sub { color: #64748b; }
    .money-good { color: #047857; }
    .money-due { color: #b45309; }
    .pickup-row { display: grid; grid-template-columns: 1fr 2fr; gap: 18px; border: 1px solid #d1fae5; background: #f0fdf4; border-radius: 14px; padding: 14px; margin-top: 10px; break-inside: avoid; }
    .pickup-item { display: flex; justify-content: space-between; gap: 16px; border-top: 1px solid #bbf7d0; padding: 7px 0; font-size: 10px; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE MEN'S SHOP</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Daily Sales & Activity Report</p>
      <p class="muted" style="font-size: 10px; margin-top: 2px;">Generated: ${generatedAt}</p>
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Reporting Period</p>
      <p style="font-weight: 800; font-size: 14px;">${opts.rangeLabel}</p>
      <p class="muted" style="margin-top: 4px;">Assigned Printer: <span style="font-weight:800;color:#0f172a">${reportPrinter}</span></p>
    </div>
  </div>

  <div class="stat-grid">
    <div class="stat-card">
      <p class="stat-label">Transactions</p>
      <p class="stat-value">${summary.sales_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Subtotal Before Tax</p>
      <p class="stat-value">$${centsToFixed2(parseMoneyToCents(summary.sales_subtotal_no_tax))}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Tax Collected</p>
      <p class="stat-value">$${centsToFixed2(parseMoneyToCents(summary.sales_tax_total))}</p>
    </div>
    <div class="stat-card" style="border-color:#10b981; background: #f0fdf4;">
      <p class="stat-label" style="color:#047857">Cash Collected</p>
      <p class="stat-value" style="color:#047857">$${summary.cash_collected}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Credit Card Total</p>
      <p class="stat-value">${moneyWithCount(creditCardTotalCents, creditCardPaymentCount)}</p>
    </div>
    <div class="stat-card" style="border-color:#10b981; background: #f0fdf4;">
      <p class="stat-label" style="color:#047857">Deposits Taken</p>
      <p class="stat-value" style="color:#047857">$${summary.deposits_collected}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">New Orders</p>
      <p class="stat-value">${summary.special_order_sale_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Orders Picked Up</p>
      <p class="stat-value">${summary.pickup_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">RMS Payments</p>
      <p class="stat-value">${formatReportMoney(rmsPaymentTotalCents)}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">RMS Charge</p>
      <p class="stat-value">${formatReportMoney(rmsChargeTotalCents)}</p>
    </div>
    <div class="stat-card" style="border-color:#0f172a; background: #f8fafc;">
      <p class="stat-label" style="color:#0f172a">Merchandise Subtotal</p>
      <p class="stat-value" style="color:#0f172a">$${centsToFixed2(parseMoneyToCents(summary.net_sales))}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">New Appts</p>
      <p class="stat-value">${summary.new_appointment_count ?? 0}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">New Layaways</p>
      <p class="stat-value">${newLayawayCount}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Picked Up $</p>
      <p class="stat-value">${moneyWithCount(pickupTotalCents, pickupTotalCount)}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Discounts</p>
      <p class="stat-value">${moneyWithCount(discountTotalCents, discountCount)}</p>
    </div>
  </div>

  <h2>Transaction List</h2>
  ${activityRows || "<div class='muted' style='padding:40px; text-align:center;'>No activity recorded for this period.</div>"}

  <h2>Pickups Today</h2>
  ${pickupRows || "<div class='muted' style='padding:20px 0;'>No pickups recorded for this period.</div>"}

  ${activityRows ? `
  <div style="margin-top: 30px; border-top: 2px solid #e2e8f0; padding-top: 20px; text-align: right;">
    <p style="font-size: 14px; font-weight: 800; color: #0f172a; margin: 0;">Grand Total: $${grandTotal}</p>
  </div>
  ` : ""}

  <div style="margin-top: 60px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
    <p class="muted" style="font-size: 10px;">End of Summary Audit · Riverside Men's Shop · Generated: ${generatedAt}</p>
  </div>
  </body></html>`);
  return finishPrintDocument(target, "daily-sales-report.html", dailyReportTextLines.join("\n"), {
    action: opts.action ?? "print",
  });
}

export async function openProfessionalTablePrint(opts: {
  title: string;
  action?: ReportPrintAction;
  subtitle?: string;
  columns: string[];
  rows: Record<string, unknown>[];
}): Promise<boolean> {
  const target = createPrintDocument(opts.title);

  target.doc.title = opts.title;

  const reportPrinter = reportPrinterName();
  const escapeHtml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const headerCells = opts.columns
    .map((c) => `<th style="text-align:left;padding:12px 8px;border-bottom:2px solid #e2e8f0;white-space:nowrap">${escapeHtml(c.replace(/_/g, " ").toUpperCase())}</th>`)
    .join("");

  const bodyRows = opts.rows
    .map((r) => {
      const cells = opts.columns
        .map((c) => {
          const val = r[c];
          const display = val === null || val === undefined ? "—" : String(val);
          return `<td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;font-weight:500;vertical-align:top;white-space:normal">${escapeHtml(display).replace(/\n/g, "<br>")}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  const tableReportText = [
    "RIVERSIDE OS",
    opts.title,
    opts.subtitle ?? "",
    `Reporting Station: ${reportPrinter}`,
    `Generated: ${new Date().toLocaleString()}`,
    "",
    opts.columns.map((column) => column.replace(/_/g, " ").toUpperCase()).join("\t"),
    ...(opts.rows.length > 0
      ? opts.rows.map((row) =>
          opts.columns
            .map((column) => {
              const value = row[column];
              return value === null || value === undefined ? "" : String(value).replace(/\s+/g, " ").trim();
            })
            .join("\t"),
        )
      : ["No records found"]),
    "",
    "End of Report - Riverside Men's Shop Proprietary Document",
  ]
    .join("\n");

  target.doc.write(`<!DOCTYPE html><html><head><title>${escapeHtml(opts.title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 11px; line-height: 1.4; color: #0f172a; padding: 40px; }
    h1 { font-size: 22px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: auto; }
    th { font-size: 9px; font-weight: 800; color: #64748b; letter-spacing: 0.1em; }
    .muted { color: #64748b; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 4px solid #0f172a; padding-bottom: 20px;">
    <div>
      <h1>RIVERSIDE OS</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Internal Audit · ${escapeHtml(opts.title)}</p>
    </div>
    <div style="text-align: right;">
      <p style="font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase;">Reporting Station</p>
      <p style="font-weight: 800; font-size: 13px;">${escapeHtml(reportPrinter)}</p>
      <p class="muted" style="margin-top: 4px;">Generated: ${new Date().toLocaleString()}</p>
    </div>
  </div>

  ${opts.subtitle ? `<p style="margin-top:20px;font-weight:700;font-size:12px">${escapeHtml(opts.subtitle)}</p>` : ""}

  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows || "<tr><td colspan='100%' style='padding:40px;text-align:center' class='muted'>No records found</td></tr>"}</tbody>
  </table>

  <div style="margin-top: 40px; text-align: right;">
    <p class="muted" style="font-size: 9px;">End of Report · Riverside Men's Shop Proprietary Document</p>
  </div>
  </body></html>`);
  return finishPrintDocument(target, `${opts.title.replace(/[^a-z0-9]/gi, "_")}.html`, tableReportText, {
    action: opts.action ?? "print",
  });
}
