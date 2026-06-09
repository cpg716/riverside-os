/** Professional letter-style Z / X reconciliation report for audit and accounting (browser print). */

import { dispatchAppToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { openDesktopTextPreview } from "../../lib/desktopFileBridge";
import { isTauri } from "@tauri-apps/api/core";

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

function notifyPrintDialogFailure(error: unknown): void {
  console.error("Print failed:", error);
  dispatchAppToast("Print dialog could not be opened. Please check your browser settings.", "error");
}

function isTauriDesktop() {
  return isTauri();
}

function createPrintDocument(title: string, features: string) {
  if (isTauriDesktop()) {
    return {
      doc: document.implementation.createHTMLDocument(title),
      win: null as Window | null,
    };
  }
  const win = window.open("", "_blank", features);
  if (!win) return null;
  return { doc: win.document, win };
}

function finishPrintDocument(target: { doc: Document; win: Window | null }, filename: string) {
  target.doc.close();
  if (target.win) {
    target.win.focus();
    setTimeout(() => {
      try {
        target.win?.print();
      } catch (e) {
        notifyPrintDialogFailure(e);
      }
    }, 500);
    return;
  }
  void openDesktopTextPreview(filename, target.doc.documentElement.outerHTML).catch((error) => {
    notifyPrintDialogFailure(error);
  });
}

function reportLabel(value: string | null | undefined): string {
  const normalized = (value ?? "").trim().toLowerCase();
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

function inventoryTxLabel(value: string | null | undefined): string {
  switch ((value ?? "").trim()) {
    case "po_receipt":
      return "Receiving";
    case "return_to_vendor":
      return "Return to Vendor";
    case "damaged":
      return "Damaged";
    case "physical_inventory":
      return "Physical Count";
    case "adjustment":
      return "Adjustment";
    default:
      return reportLabel(value);
  }
}

export function openProfessionalZReportPrint(opts: {
  title: string;
  sessionId: string;
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
  transactions?: {
    created_at: string;
    payment_method: string;
    amount: string;
    customer_name: string;
    transaction_display_id?: string | null;
    transaction_status?: string | null;
    transaction_total?: string | null;
    transaction_paid?: string | null;
    transaction_balance_due?: string | null;
    items?: ZReportAuditItem[];
    register_lane: number;
  }[];
}): void {
  const target = createPrintDocument(`${opts.title} — ${opts.sessionId}`, "width=850,height=950");
  if (!target) return;

  const ord = opts.registerOrdinal != null ? ` #${opts.registerOrdinal}` : "";
  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";

  const tendersRows = opts.tenders
    .map(
      (t) =>
        `<tr><td>${escapeReportHtml(reportLabel(t.payment_method))}</td><td class="center">${t.tx_count}</td><td class="money">${formatReportMoney(t.total_amount)}</td></tr>`,
    )
    .join("");

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

  const byLaneSections =
    opts.tendersByLane && opts.tendersByLane.length > 0
      ? opts.tendersByLane
          .map((lane) => {
            const laneTendersItems = lane.tenders
              .map(
                (t) =>
                  `<tr><td>${escapeReportHtml(reportLabel(t.payment_method))}</td><td class="center">${t.tx_count}</td><td class="money">${formatReportMoney(t.total_amount)}</td></tr>`,
              )
              .join("");
            return `
              <div class="lane-block">
                <p class="subhead">Register #${lane.register_lane}</p>
                <table>${laneTendersItems || "<tr><td colspan='3' class='muted'>No payments</td></tr>"}</table>
              </div>
            `;
          })
          .join("")
      : "";

  const txAuditRows =
    opts.transactions && opts.transactions.length > 0
      ? opts.transactions
          .map((t) => {
            const tm = new Date(t.created_at).toLocaleString([], {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            });
            const visibleItems = (t.items ?? []).filter((item) => !item.is_internal).slice(0, 4);
            const internalItems = (t.items ?? []).filter((item) => item.is_internal);
            const giftCardIssued = internalItems.find((item) => item.line_kind === "pos_gift_card_load");

            const itemsHtml = visibleItems.map(item => `
              <div class="print-item-row">
                <span><strong>${item.quantity}× ${item.name}</strong><br><span class="muted mono">${item.sku}${item.fulfillment ? ` · ${fulfillmentLabel(item.fulfillment)}` : ""}</span></span>
                <span style="font-family: monospace;">
                  ${formatReportMoney(item.unit_price)}
                </span>
              </div>
            `).join("");

            const extraCount = Math.max(0, (t.items ?? []).filter((item) => !item.is_internal).length - visibleItems.length);
            const notes = [
              extraCount > 0 ? `+${extraCount} more line${extraCount === 1 ? "" : "s"}` : null,
              giftCardIssued ? "Gift card issued on this sale" : null,
            ].filter(Boolean).join(" · ");

            const chips = [
              t.transaction_status ? reportLabel(t.transaction_status) : null,
            ].filter(Boolean).map((chip) => `<span class="chip">${chip}</span>`).join("");

            return `
              <section class="activity-card">
                <div class="activity-left">
                  <div class="pill">${reportLabel(t.payment_method)}</div>
                  <div class="time">${tm}</div>
                  <div class="customer">${t.customer_name || "Walk-in Customer"}</div>
                  <div class="chips">${t.transaction_display_id ? `<span class="chip mono">#${t.transaction_display_id}</span>` : ""}<span class="chip mono">Lane #${t.register_lane}</span>${chips}</div>
                </div>
                <div class="activity-items">
                  <div class="section-label">Line Items</div>
                  ${itemsHtml || `<div class="muted" style="padding:18px 0;text-align:center;">No item details recorded for this transaction</div>`}
                  ${notes ? `<div class="muted" style="font-size:9px;margin-top:8px;">${notes}</div>` : ""}
                </div>
                <div class="activity-money">
                  <div class="money-label">Transaction Amount</div>
                  <div class="money-total">${formatReportMoney(t.amount)}</div>
                  ${t.transaction_total ? `<div class="money-sub">Sale Total: ${formatReportMoney(t.transaction_total)}</div>` : ""}
                  ${t.transaction_paid ? `<div class="money-sub">Paid: ${formatReportMoney(t.transaction_paid)}</div>` : ""}
                  ${t.transaction_balance_due && parseMoneyToCents(t.transaction_balance_due) > 0 ? `<div class="money-due">Balance: ${formatReportMoney(t.transaction_balance_due)}</div>` : ""}
                </div>
              </section>
            `;
          })
          .join("")
      : "";

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

  const inventoryActivityRows =
    opts.inventoryActivity && opts.inventoryActivity.length > 0
      ? opts.inventoryActivity
          .map((row) => {
            const tm = new Date(row.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const detail = [
              row.category_name,
              row.notes,
              row.reference_table ? `${row.reference_table}${row.reference_id ? ` ${row.reference_id.slice(0, 8)}` : ""}` : null,
            ].filter(Boolean).join(" · ");
            return `<tr>
              <td>${escapeReportHtml(tm)}</td>
              <td>${escapeReportHtml(inventoryTxLabel(row.tx_type))}</td>
              <td><strong>${escapeReportHtml(row.product_name)}</strong><br><span class="muted mono">${escapeReportHtml(row.sku)}</span></td>
              <td class="center mono">${row.quantity_delta > 0 ? "+" : ""}${row.quantity_delta}</td>
              <td class="money">${row.unit_cost ? formatReportMoney(row.unit_cost) : "—"}</td>
              <td class="money">${formatReportMoney(row.value_delta)}</td>
              <td>${escapeReportHtml(row.staff_name || "System")}<br><span class="muted">${escapeReportHtml(detail || "No detail")}</span></td>
            </tr>`;
          })
          .join("")
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

  target.doc.write(`<!DOCTYPE html><html><head><title>${opts.title} — ${opts.sessionId}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    @page { size: letter portrait; margin: 0.38in; }
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 9.5px; line-height: 1.32; color: #0f172a; padding: 0; }
    h1 { font-size: 19px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 10.5px; font-weight: 800; margin: 14px 0 5px; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
    .header-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 14px; }
    .stat-label { font-size: 7.5px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 2px; }
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
    .activity-money { text-align: right; }
    .money-label { color: #64748b; font-size: 10px; font-weight: 800; }
    .money-total { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 800; margin-top: 4px; }
    .money-sub, .money-good, .money-due { font-size: 10px; font-weight: 800; margin-top: 8px; }
    .money-sub { color: #64748b; }
    .money-good { color: #047857; }
    .money-due { color: #b45309; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE MEN'S SHOP</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Z-Report Reconciliation Audit</p>
      <p class="muted" style="font-size: 10px; margin-top: 2px;">Generated: ${new Date().toLocaleString()}</p>
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Report ID</p>
      <p class="mono" style="font-weight: 700;">${opts.sessionId}</p>
      <p class="muted" style="margin-top: 2px;">Printed from <span style="font-weight:800;color:#0f172a">${escapeReportHtml(reportPrinter)}</span></p>
    </div>
  </div>

  <div class="header-grid">
    <div>
      <p class="stat-label">Shift Primary Cashier</p>
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

  ${inventoryActivityRows ? `
    <div style="margin-top: 14px; break-inside: avoid;">
      <h2>Inventory Activity (Non-Sale)</h2>
      <table style="font-size: 8.2px;">
        <thead><tr><th>Time</th><th>Type</th><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Cost</th><th style="text-align:right">Value</th><th>Staff / Detail</th></tr></thead>
        <tbody>${inventoryActivityRows}</tbody>
      </table>
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

  ${txAuditRows ? `
    <div style="margin-top: 14px; page-break-before: auto;">
      <h2>Transaction List</h2>
      ${txAuditRows}
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
  finishPrintDocument(target, `z-report-${opts.sessionId.slice(0, 8)}.html`);
}

export function openProfessionalDailySalesPrint(opts: {
  title: string;
  rangeLabel: string;
  summary: {
    sales_count: number;
    sales_subtotal_no_tax: string;
    sales_tax_total: string;
    net_sales: string;
    appointment_count: number;
    online_order_count: number;
    new_wedding_parties_count: number;
    merchant_fees_total: string;
    cash_collected: string;
    deposits_collected: string;
  };
  activities: {
    occurred_at: string;
    title: string;
    amount_label?: string | null;
    kind: string;
    payment_summary?: string | null;
    customer_name?: string | null;
    customer_code?: string | null;
    wedding_party_name?: string | null;
    sales_total?: string | null;
    transaction_total?: string | null;
    deposits_paid?: string | null;
    balance_due?: string | null;
    short_id?: string | null;
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
    }[] | null;
  }[];
}): void {
  const target = createPrintDocument("Daily Sales Report", "width=850,height=950");
  if (!target) return;

  target.doc.title = "Daily Sales Report";

  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";
  const { summary, activities } = opts;

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
          <span style="font-family: monospace;">
            ${item.reg_price !== item.price ? `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 4px;">$${item.reg_price}</span>` : ""}
            $${item.price}
          </span>
        </div>
      `).join("");
      const chips = [
        row.fulfillment_label,
        row.channel === "web" ? "Online" : null,
      ].filter(Boolean).map((chip) => `<span class="chip">${chip}</span>`).join("");

      return `
        <section class="activity-card">
          <div class="activity-left">
            <div class="pill">${row.title}</div>
            <div class="time">${tm}</div>
            <div class="customer">${customerInfo || "Walk-in Customer"}</div>
            <div class="chips">${row.short_id ? `<span class="chip mono">#${row.short_id}</span>` : ""}${chips}</div>
          </div>
          <div class="activity-items">
            <div class="section-label">Line Items</div>
            ${itemsHtml || `<div class="muted" style="padding:18px 0;text-align:center;">No item details recorded for this transaction</div>`}
          </div>
          <div class="activity-money">
            <div class="money-label">Sales Total</div>
            <div class="money-total">${row.sales_total ? `$${row.sales_total}` : row.amount_label || "—"}</div>
            <div class="money-sub">Transaction Total: ${row.transaction_total ? `$${row.transaction_total}` : "—"}</div>
            ${row.payment_summary ? `<div class="money-sub">${row.payment_summary}</div>` : ""}
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

  // Calculate grand total across all groups
  const grandTotal = Object.values(groupedActivities)
    .flat()
    .reduce((sum, row) => sum + (Number.parseFloat(row.sales_total || "0") || 0), 0)
    .toFixed(2);

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
    .activity-money { text-align: right; }
    .money-label { color: #64748b; font-size: 10px; font-weight: 800; }
    .money-total { font-family: 'JetBrains Mono', monospace; font-size: 17px; font-weight: 800; margin-top: 4px; }
    .money-sub, .money-good, .money-due { font-size: 10px; font-weight: 800; margin-top: 8px; }
    .money-sub { color: #64748b; }
    .money-good { color: #047857; }
    .money-due { color: #b45309; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE MEN'S SHOP</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Daily Sales & Activity Report</p>
      <p class="muted" style="font-size: 10px; margin-top: 2px;">Generated: ${new Date().toLocaleString()}</p>
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
      <p class="stat-label">Sales (No Tax)</p>
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
    <div class="stat-card" style="border-color:#10b981; background: #f0fdf4;">
      <p class="stat-label" style="color:#047857">Deposits Taken</p>
      <p class="stat-value" style="color:#047857">$${summary.deposits_collected}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Total Appointments</p>
      <p class="stat-value">${summary.appointment_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Online Orders</p>
      <p class="stat-value">${summary.online_order_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">New Weddings</p>
      <p class="stat-value">${summary.new_wedding_parties_count}</p>
    </div>
    <div class="stat-card">
      <p class="stat-label">Merchant Fees</p>
      <p class="stat-value" style="color:#dc2626">-$${centsToFixed2(parseMoneyToCents(summary.merchant_fees_total))}</p>
    </div>
    <div class="stat-card" style="border-color:#0f172a; background: #f8fafc;">
      <p class="stat-label" style="color:#0f172a">Net Daily Shift</p>
      <p class="stat-value" style="color:#0f172a">$${centsToFixed2(parseMoneyToCents(summary.net_sales))}</p>
    </div>
  </div>

  <h2>Transaction List</h2>
  ${activityRows || "<div class='muted' style='padding:40px; text-align:center;'>No activity recorded for this period.</div>"}

  ${activityRows ? `
  <div style="margin-top: 30px; border-top: 2px solid #e2e8f0; padding-top: 20px; text-align: right;">
    <p style="font-size: 14px; font-weight: 800; color: #0f172a; margin: 0;">Grand Total: $${grandTotal}</p>
  </div>
  ` : ""}

  <div style="margin-top: 60px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
    <p class="muted" style="font-size: 10px;">End of Summary Audit · Riverside Men's Shop · Generated: ${new Date().toLocaleString()}</p>
  </div>
  </body></html>`);
  finishPrintDocument(target, "daily-sales-report.html");
}

export function openProfessionalTablePrint(opts: {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Record<string, unknown>[];
}): boolean {
  const target = createPrintDocument(opts.title, "width=950,height=950");
  if (!target) return false;

  target.doc.title = opts.title;

  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";
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
  finishPrintDocument(target, `${opts.title.replace(/[^a-z0-9]/gi, "_")}.html`);
  return true;
}
