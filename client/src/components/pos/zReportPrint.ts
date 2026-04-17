/** Professional letter-style Z / X reconciliation report for audit and accounting (browser print). */

import { centsToFixed2, parseMoneyToCents } from "../../lib/money";

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

export function openProfessionalZReportPrint(opts: {
  title: string;
  sessionId: string;
  registerOrdinal?: number | null;
  cashierLabel?: string | null;
  openedAt?: string | null;
  openingCents: number;
  cashSalesCents: number;
  netAdjustmentsCents: number;
  expectedCents: number;
  actualCents: number;
  discrepancyCents: number;
  tenders: ZReportTenderRow[];
  overrideSummary: ZReportOverrideRow[];
  /** Per-lane tender breakdown when multiple registers share one till shift. */
  tendersByLane?: { register_lane: number; tenders: ZReportTenderRow[] }[];
  /** Optional payment lines for audit trail. */
  transactions?: {
    created_at: string;
    payment_method: string;
    amount: string;
    customer_name: string;
    register_lane: number;
  }[];
}): void {
  // Use a wider window for a more professional full-page landscape/portrait view
  const w = window.open("", "_blank", "width=850,height=950");
  if (!w) return;

  const ord = opts.registerOrdinal != null ? ` #${opts.registerOrdinal}` : "";
  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";

  const tendersRows = opts.tenders
    .map(
      (t) =>
        `<tr style="border-bottom: 1px solid #f1f5f9"><td style="text-transform:capitalize;padding:10px 0">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:center">${t.tx_count}</td><td style="text-align:right;font-family:ui-monospace,monospace;font-weight:700">$${centsToFixed2(parseMoneyToCents(String(t.total_amount)))}</td></tr>`,
    )
    .join("");

  const overrideRows = opts.overrideSummary
    .map(
      (o) =>
        `<tr style="border-bottom: 1px solid #f1f5f9"><td style="padding:8px 0">${o.reason}</td><td style="text-align:center">${o.line_count}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(o.total_delta)))}</td></tr>`,
    )
    .join("");

  const byLaneSections =
    opts.tendersByLane && opts.tendersByLane.length > 0
      ? opts.tendersByLane
          .map((lane) => {
            const laneTendersItems = lane.tenders
              .map(
                (t) =>
                  `<tr><td style="text-transform:capitalize;padding:6px 0">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:center">${t.tx_count}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(t.total_amount)))}</td></tr>`,
              )
              .join("");
            return `
              <div style="margin-top: 20px; break-inside: avoid;">
                <p style="font-weight: 800; font-size: 10px; color: #64748b; letter-spacing: 0.1em; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 8px;">REGISTER #${lane.register_lane}</p>
                <table style="width:100%;font-size: 11px;border-collapse:collapse;">${laneTendersItems || "<tr><td colspan='3' class='muted'>No payments</td></tr>"}</table>
              </div>
            `;
          })
          .join("")
      : "";

  const txAuditRows =
    opts.transactions && opts.transactions.length > 0
      ? opts.transactions
          .map((t) => {
            const tm = new Date(t.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const safeCust = (t.customer_name || "—").replace(/[<>&]/g, "");
            return `<tr style="border-bottom: 1px solid #f8fafc"><td style="padding:6px 0">${tm}</td><td style="text-align:center;font-weight:800">#${t.register_lane}</td><td style="text-transform:capitalize">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(t.amount)))}</td><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#64748b;padding-left:10px">${safeCust}</td></tr>`;
          })
          .join("")
      : "";

  const dc = opts.discrepancyCents;
  const statusLabel = dc === 0 ? "BALANCED" : dc < 0 ? "SHORTFALL" : "OVERAGE";
  const statusColor = dc === 0 ? "#059669" : "#dc2626";

  w.document.write(`<!DOCTYPE html><html><head><title>${opts.title} — ${opts.sessionId}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 12px; line-height: 1.5; color: #0f172a; padding: 40px; }
    h1 { font-size: 24px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 14px; font-weight: 800; margin: 30px 0 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    .header-grid { display: grid; grid-template-cols: 1fr 1fr; gap: 40px; margin-top: 30px; }
    .stat-card { border: 1px solid #e2e8f0; padding: 16px; rounded: 12px; border-radius: 12px; }
    .stat-label { font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .stat-value { font-size: 18px; font-weight: 800; }
    .discrepancy-box { margin-top: 30px; border: 2px solid ${statusColor}; background: ${dc === 0 ? "#ecfdf5" : "#fef2f2"}; padding: 20px; border-radius: 12px; display: flex; justify-content: space-between; align-items: center; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .muted { color: #64748b; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .reconciliation-grid { display: grid; grid-template-cols: 2fr 1fr; gap: 40px; margin-top: 40px; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE OS</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Z-Report Reconciliation Audit</p>
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Report ID</p>
      <p class="mono" style="font-weight: 700;">${opts.sessionId}</p>
      <p class="muted" style="margin-top: 4px;">Assigned Printer: <span style="font-weight:800;color:#0f172a">${reportPrinter}</span></p>
    </div>
  </div>

  <div class="header-grid">
    <div>
      <p class="stat-label">Shift Primary Cashier</p>
      <p style="font-size: 16px; font-weight: 700;">${opts.cashierLabel || "System Admin"}</p>
      ${opts.openedAt ? `<p class="muted">Shift Start: ${new Date(opts.openedAt).toLocaleString()}</p>` : ""}
    </div>
    <div style="text-align: right;">
      <p class="stat-label">Terminal Node</p>
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
      <div style="space-y: 12px;">
        <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
          <span class="muted">Opening Float</span>
          <span class="mono" style="font-weight: 700;">$${centsToFixed2(opts.openingCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
          <span class="muted">Cash Sales</span>
          <span class="mono" style="font-weight: 700;">+$${centsToFixed2(opts.cashSalesCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
          <span class="muted">Drawer Adjustments</span>
          <span class="mono" style="font-weight: 700;">${opts.netAdjustmentsCents >= 0 ? "+" : ""}$${centsToFixed2(opts.netAdjustmentsCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 12px 0; margin-top: 8px; border-top: 2px solid #e2e8f0;">
          <span style="font-weight: 800; text-transform: uppercase;">Expected Cash</span>
          <span class="mono" style="font-weight: 800; font-size: 16px;">$${centsToFixed2(opts.expectedCents)}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 12px 0; background: #f8fafc; border-radius: 8px; margin-top: 4px; padding: 12px;">
          <span style="font-weight: 800; text-transform: uppercase;">Actual Counted</span>
          <span class="mono" style="font-weight: 800; font-size: 18px; color: #0f172a;">$${centsToFixed2(opts.actualCents)}</span>
        </div>
      </div>

      <div class="discrepancy-box">
        <div>
          <p style="font-size: 10px; font-weight: 800; color: ${statusColor}; letter-spacing: 0.1em; margin-bottom: 2px;">STATUS: ${statusLabel}</p>
          <p style="font-size: 20px; font-weight: 800; color: ${statusColor}; margin: 0;">$${centsToFixed2(Math.abs(dc))}</p>
        </div>
        <div style="text-align: right;">
           ${dc === 0 ? '✓' : '⚠'}
        </div>
      </div>
    </div>
  </div>

  ${overrideRows ? `
    <div style="margin-top: 40px; break-inside: avoid;">
      <h2>Price Override Audit</h2>
      <table>
        <thead><tr><th>Reason for Override</th><th style="text-align:center">Occurrences</th><th style="text-align:right">Total Δ Retail</th></tr></thead>
        <tbody>${overrideRows}</tbody>
      </table>
    </div>
  ` : ""}

  ${txAuditRows ? `
    <div style="margin-top: 40px; page-break-before: auto;">
      <h2>Transaction Audit Trail</h2>
      <table style="font-size: 10px;">
        <thead><tr><th>Time</th><th style="text-align:center">Reg</th><th>Method</th><th style="text-align:right">Amount</th><th>Customer Context</th></tr></thead>
        <tbody>${txAuditRows}</tbody>
      </table>
    </div>
  ` : ""}

  <div style="margin-top: 80px; border-top: 1px solid #e2e8f0; pt: 20px; display: grid; grid-template-cols: 1fr 1fr; gap: 40px;">
    <div>
      <p class="stat-label">Manager Signature</p>
      <div style="border-bottom: 1px solid #0f172a; height: 40px; margin-top: 10px;"></div>
    </div>
    <div>
      <p class="stat-label">Date of Verification</p>
      <div style="border-bottom: 1px solid #0f172a; height: 40px; margin-top: 10px;"></div>
    </div>
  </div>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => {
    w.print();
  }, 500);
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
    stripe_fees_total: string;
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
    items?: {
      name: string;
      sku: string;
      quantity: number;
      reg_price: string;
      price: string;
    }[] | null;
  }[];
}): void {
  const w = window.open("", "_blank", "width=850,height=950");
  if (!w) return;

  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";
  const { summary, activities } = opts;

  const activityRows = activities
    .map((row) => {
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
        <div style="font-size: 10px; color: #475569; margin-top: 4px; display: flex; justify-content: space-between; border-top: 1px dashed #e2e8f0; padding-top: 4px;">
          <span>${item.quantity}× ${item.name} (${item.sku})</span>
          <span style="font-family: monospace;">
            ${item.reg_price !== item.price ? `<span style="text-decoration: line-through; opacity: 0.6; margin-right: 4px;">$${item.reg_price}</span>` : ""}
            $${item.price}
          </span>
        </div>
      `).join("");

      return `
        <tr style="border-top: 1px solid #e2e8f0;">
          <td style="padding:12px 0; vertical-align: top;">${tm}</td>
          <td style="padding:12px 0; vertical-align: top;">
            <div style="text-transform:capitalize;font-weight:700">${row.kind.replace(/_/g, " ")}</div>
            <div style="font-size: 10px; color: #64748b;">${row.payment_summary || "No payment context"}</div>
          </td>
          <td style="padding:12px 0; vertical-align: top;">
            <div style="font-weight: 800; color: #0f172a;">${row.title} ${row.short_id ? `<span style="background:#f1f5f9; padding:1px 4px; border-radius:4px; font-family:monospace; font-size:10px; margin-left:4px;">#${row.short_id}</span>` : ""}</div>
            <div style="font-size: 11px; color: #0f172a; font-weight: 700; background: #f8fafc; padding: 4px 8px; border-radius: 6px; margin: 4px 0;">${customerInfo || "Walk-in Customer"}</div>
            <div style="margin-top: 8px;">${itemsHtml}</div>
          </td>
          <td style="padding:12px 0; text-align:right; vertical-align: top;">
            <div style="font-family: monospace; font-weight: 800; font-size: 14px;">${row.transaction_total || row.amount_label || "—"}</div>
            <div style="font-size: 9px; color: #64748b; font-weight: 700;">Sales Total: ${row.sales_total || "—"}</div>
            ${row.deposits_paid ? `<div style="font-size: 9px; color: #059669; font-weight: 700;">Paid: $${row.deposits_paid}</div>` : ""}
            ${row.balance_due && parseFloat(row.balance_due) > 0 ? `<div style="font-size: 9px; color: #b45309; font-weight: 700;">Balance: $${row.balance_due}</div>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");

  w.document.write(`<!DOCTYPE html><html><head><title>${opts.title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=JetBrains+Mono:wght@400;700&display=swap');
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 12px; line-height: 1.5; color: #0f172a; padding: 40px; }
    h1 { font-size: 24px; font-weight: 800; margin: 0; letter-spacing: -0.02em; }
    h2 { font-size: 14px; font-weight: 800; margin: 30px 0 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #475569; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; }
    .stat-grid { display: grid; grid-template-cols: repeat(5, 1fr); gap: 15px; margin-top: 30px; }
    .stat-card { border: 1px solid #e2e8f0; padding: 12px; border-radius: 12px; }
    .stat-label { font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
    .stat-value { font-size: 16px; font-weight: 800; tabular-nums: true; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th { text-align: left; font-size: 10px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
    .muted { color: #64748b; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    @media print { body { padding: 0; } }
  </style></head><body>
  <div style="display: flex; justify-content: space-between; align-items: flex-start;">
    <div>
      <h1>RIVERSIDE OS</h1>
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Daily Sales & Activity Report</p>
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
      <p class="stat-label">Stripe Fees</p>
      <p class="stat-value" style="color:#dc2626">-$${centsToFixed2(parseMoneyToCents(summary.stripe_fees_total))}</p>
    </div>
    <div class="stat-card" style="border-color:#0f172a; background: #f8fafc;">
      <p class="stat-label" style="color:#0f172a">Net Daily Shift</p>
      <p class="stat-value" style="color:#0f172a">$${centsToFixed2(parseMoneyToCents(summary.net_sales))}</p>
    </div>
  </div>

  <h2>Activity Detail</h2>
  <table style="table-layout: fixed;">
    <thead>
      <tr>
        <th style="width: 15%;">Time</th>
        <th style="width: 20%;">Type</th>
        <th style="width: 45%;">Reference / Customer</th>
        <th style="width: 20%; text-align: right;">Amount Details</th>
      </tr>
    </thead>
    <tbody>${activityRows || "<tr><td colspan='4' class='muted' style='padding:40px; text-align:center;'>No activity recorded for this period.</td></tr>"}</tbody>
  </table>

  <div style="margin-top: 60px; border-top: 1px solid #e2e8f0; padding-top: 20px; text-align: center;">
    <p class="muted" style="font-size: 10px;">End of Summary Audit · Riverside OS v0.2.0 · Generated: ${new Date().toLocaleString()}</p>
  </div>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

export function openProfessionalTablePrint(opts: {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: Record<string, unknown>[];
}): void {
  const w = window.open("", "_blank", "width=950,height=950");
  if (!w) return;

  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";

  const headerCells = opts.columns
    .map((c) => `<th style="text-align:left;padding:12px 8px;border-bottom:2px solid #e2e8f0;white-space:nowrap">${c.replace(/_/g, " ").toUpperCase()}</th>`)
    .join("");

  const bodyRows = opts.rows
    .map((r) => {
      const cells = opts.columns
        .map((c) => {
          const val = r[c];
          const display = val === null || val === undefined ? "—" : String(val);
          return `<td style="padding:10px 8px;border-bottom:1px solid #f1f5f9;font-weight:500">${display}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  w.document.write(`<!DOCTYPE html><html><head><title>${opts.title}</title>
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
      <p style="font-weight: 700; color: #64748b; margin-top: 4px;">Internal Audit · ${opts.title}</p>
    </div>
    <div style="text-align: right;">
      <p style="font-size: 9px; font-weight: 800; color: #64748b; text-transform: uppercase;">Reporting Station</p>
      <p style="font-weight: 800; font-size: 13px;">${reportPrinter}</p>
      <p class="muted" style="margin-top: 4px;">Generated: ${new Date().toLocaleString()}</p>
    </div>
  </div>

  ${opts.subtitle ? `<p style="margin-top:20px;font-weight:700;font-size:12px">${opts.subtitle}</p>` : ""}

  <table>
    <thead><tr>${headerCells}</tr></thead>
    <tbody>${bodyRows || "<tr><td colspan='100%' style='padding:40px;text-align:center' class='muted'>No records found</td></tr>"}</tbody>
  </table>

  <div style="margin-top: 40px; text-align: right;">
    <p class="muted" style="font-size: 9px;">End of Report · Riverside OS Proprietary Document</p>
  </div>
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}
