/** 80mm-style Z / X report for physical deposit envelope (browser print). */

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

export function openThermalZReportPrint(opts: {
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
  const w = window.open("", "_blank", "width=420,height=900");
  if (!w) return;
  const ord =
    opts.registerOrdinal != null ? ` #${opts.registerOrdinal}` : "";
  const rows = opts.tenders
    .map(
      (t) =>
        `<tr><td style="text-transform:capitalize;padding:3px 0">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:center">${t.tx_count}</td><td style="text-align:right;font-family:ui-monospace,monospace">$${centsToFixed2(parseMoneyToCents(String(t.total_amount)))}</td></tr>`,
    )
    .join("");
  const ov = opts.overrideSummary
    .map(
      (o) =>
        `<tr><td style="padding:2px 0">${o.reason}</td><td style="text-align:center">${o.line_count}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(o.total_delta)))}</td></tr>`,
    )
    .join("");
  const byLane =
    opts.tendersByLane && opts.tendersByLane.length > 0
      ? opts.tendersByLane
          .map((lane) => {
            const sub = lane.tenders
              .map(
                (t) =>
                  `<tr><td style="text-transform:capitalize;padding:2px 0">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:center">${t.tx_count}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(t.total_amount)))}</td></tr>`,
              )
              .join("");
            return `<p class="muted" style="margin-top:8px">REGISTER #${lane.register_lane}</p><table>${sub || "<tr><td colspan='3' class='muted'>No payments</td></tr>"}</table>`;
          })
          .join("")
      : "";
  const txRows =
    opts.transactions && opts.transactions.length > 0
      ? opts.transactions
          .map((t) => {
            const tm = new Date(t.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            });
            const safeCust = (t.customer_name || "—").replace(/[<>&]/g, "");
            return `<tr><td style="padding:2px 0;font-size:9px">${tm}</td><td style="text-align:center">#${t.register_lane}</td><td style="text-transform:capitalize">${t.payment_method.replace(/_/g, " ")}</td><td style="text-align:right;font-family:monospace">$${centsToFixed2(parseMoneyToCents(String(t.amount)))}</td><td style="font-size:9px;max-width:80px;overflow:hidden">${safeCust}</td></tr>`;
          })
          .join("")
      : "";
  const dc = opts.discrepancyCents;
  const shortOver =
    dc === 0
      ? "Balanced"
      : dc < 0
        ? `SHORT $${centsToFixed2(Math.abs(dc))}`
        : `OVER $${centsToFixed2(dc)}`;

  w.document.write(`<!DOCTYPE html><html><head><title>${opts.title} — ${opts.sessionId}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; padding: 14px; color: #0f172a; }
    h1 { font-size: 12px; margin: 0 0 6px; letter-spacing: 0.12em; }
    .muted { color: #64748b; font-size: 9px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; }
    th.right, td:last-child.amount { text-align: right; }
    .rule { border-top: 1px dashed #94a3b8; margin: 10px 0; }
  </style></head><body>
  <h1>RIVERSIDE OS</h1>
  <p class="muted">Thermal ${opts.title}${ord}</p>
  <p><strong>Session</strong> ${opts.sessionId.slice(0, 8)}…</p>
  ${opts.cashierLabel ? `<p>Cashier: ${opts.cashierLabel}</p>` : ""}
  ${opts.openedAt ? `<p class="muted">${new Date(opts.openedAt).toLocaleString()}</p>` : `<p class="muted">${new Date().toLocaleString()}</p>`}
  <div class="rule"></div>
  <p><strong>Opening float</strong> $${centsToFixed2(opts.openingCents)}</p>
  <p><strong>Cash sales</strong> +$${centsToFixed2(opts.cashSalesCents)}</p>
  <p><strong>Net drawer adjustments</strong> ${opts.netAdjustmentsCents >= 0 ? "+" : ""}$${centsToFixed2(opts.netAdjustmentsCents)}</p>
  <p><strong>Expected cash</strong> $${centsToFixed2(opts.expectedCents)}</p>
  <p><strong>Actual counted</strong> $${centsToFixed2(opts.actualCents)}</p>
  <p><strong>${shortOver}</strong></p>
  <div class="rule"></div>
  <p class="muted">ONE DRAWER — cash above includes linked registers when applicable.</p>
  <div class="rule"></div>
  <p class="muted">TENDERS (COMBINED)</p>
  <table>${rows || "<tr><td colspan='3' class='muted'>No payments</td></tr>"}</table>
  ${byLane ? `<div class="rule"></div><p class="muted">TENDERS BY REGISTER</p>${byLane}` : ""}
  <div class="rule"></div>
  <p class="muted">OVERRIDE SUMMARY (Δ retail)</p>
  <table>${ov || "<tr><td colspan='3' class='muted'>None</td></tr>"}</table>
  ${
    txRows
      ? `<div class="rule"></div><p class="muted">PAYMENTS</p><table><thead><tr><th>Time</th><th>Reg</th><th>Method</th><th class="right">Amt</th><th>Customer</th></tr></thead><tbody>${txRows}</tbody></table>`
      : ""
  }
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
  w.close();
}
