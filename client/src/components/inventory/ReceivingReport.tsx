import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle,
  Clock,
  FileText,
  Printer,
  Tag,
  X,
} from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { openPrintableHtml } from "../../lib/browserPrint";

const BASE_URL = getBaseUrl();

interface ReceivingEventLine {
  sku: string;
  product_name: string;
  variation_label?: string | null;
  quantity_received: number;
  unit_cost: number;
  landed_cost_component: number;
  line_total: number;
}

interface ReceivingEventDetail {
  id: string;
  purchase_order_id: string;
  po_number: string;
  vendor_name: string;
  invoice_number?: string | null;
  freight_total: number;
  received_at?: string | null;
  received_by_name?: string | null;
  lines: ReceivingEventLine[];
  total_units: number;
  total_merchandise_cost: number;
  grand_total: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function dollars(v: number): string {
  return `$${Number(v).toFixed(2)}`;
}

interface Props {
  receivingEventId: string;
  onClose: () => void;
  onPrintTags?: (receivingEventId: string) => void;
  showTagPrompt?: boolean;
}

export default function ReceivingReport({
  receivingEventId,
  onClose,
  onPrintTags,
  showTagPrompt = false,
}: Props) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [detail, setDetail] = useState<ReceivingEventDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `${BASE_URL}/api/purchase-orders/receiving-events/${receivingEventId}`,
          { headers: apiAuth() },
        );
        if (!res.ok) throw new Error("load_failed");
        const data = (await res.json()) as ReceivingEventDetail;
        if (!cancelled) setDetail(data);
      } catch {
        if (!cancelled) setLoadError("Could not load the receiving report.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [receivingEventId, apiAuth]);

  const printReport = useCallback(() => {
    if (!detail) return;
    const rows = detail.lines
      .map(
        (l) => `
      <tr>
        <td>${l.quantity_received}</td>
        <td>${escapeHtml(l.sku)}</td>
        <td>${escapeHtml(l.product_name)}${l.variation_label ? ` — ${escapeHtml(l.variation_label)}` : ""}</td>
        <td class="r">${dollars(l.unit_cost)}</td>
        <td class="r">${dollars(l.line_total)}</td>
      </tr>`,
      )
      .join("");

    void openPrintableHtml(`
      <html>
        <head>
          <title>Receiving Report — ${escapeHtml(detail.po_number)}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #111827; }
            h1 { margin: 0 0 10px; font-size: 28px; }
            .meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 22px; }
            .meta-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px; }
            .meta-card b { display: block; color: #6b7280; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; margin-bottom: 4px; }
            .meta-card span { color: #111827; font-size: 16px; font-weight: 700; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            th, td { border-bottom: 1px solid #e5e7eb; padding: 8px 10px; text-align: left; font-size: 12px; }
            th { text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #6b7280; background: #f9fafb; }
            .r { text-align: right; }
            .totals { margin-top: 20px; text-align: right; font-size: 13px; }
            .totals div { margin-bottom: 4px; }
            .totals .grand { font-size: 16px; font-weight: bold; border-top: 2px solid #111827; padding-top: 8px; margin-top: 8px; }
            .footer { margin-top: 32px; font-size: 10px; color: #9ca3af; border-top: 1px solid #e5e7eb; padding-top: 12px; }
          </style>
        </head>
        <body>
          <h1>Receiving Report</h1>
          <div class="meta">
            <div class="meta-card"><b>Document</b><span>${escapeHtml(detail.po_number)}</span></div>
            <div class="meta-card"><b>Vendor</b><span>${escapeHtml(detail.vendor_name)}</span></div>
            <div class="meta-card"><b>Invoice #</b><span>${escapeHtml(detail.invoice_number || "—")}</span></div>
            <div class="meta-card"><b>Date Received</b><span>${escapeHtml(formatDate(detail.received_at))}</span></div>
            ${detail.received_by_name ? `<div class="meta-card"><b>Received By</b><span>${escapeHtml(detail.received_by_name)}</span></div>` : ""}
          </div>
          <table>
            <thead>
              <tr><th>Qty</th><th>SKU</th><th>Item</th><th class="r">Unit Cost</th><th class="r">Extended</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="totals">
            <div>${detail.total_units} unit${detail.total_units === 1 ? "" : "s"} received</div>
            <div>Merchandise: ${dollars(detail.total_merchandise_cost)}</div>
            ${Number(detail.freight_total) > 0 ? `<div>Freight / Shipping: ${dollars(detail.freight_total)}</div>` : ""}
            <div class="grand">Total: ${dollars(detail.grand_total)}</div>
          </div>
          <div class="footer">
            Riverside OS — Receiving Report · ${escapeHtml(detail.po_number)} · Event ${escapeHtml(detail.id)}
          </div>
        </body>
      </html>
    `, `Receiving Report ${detail.po_number}`, {
      filename: `riverside-receiving-${detail.po_number}.html`,
      width: 900,
      height: 700,
    });
  }, [detail]);

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 font-sans">
      <div className="relative w-full max-w-3xl max-h-[90vh] flex flex-col rounded-3xl border border-app-border bg-app-surface shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-300">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-app-border bg-emerald-50 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600">
              <CheckCircle size={22} />
            </div>
            <div>
              <h2 className="text-base font-black text-app-text">
                {showTagPrompt ? "Receipt Posted" : "Receiving Report"}
              </h2>
              <p className="text-[10px] text-app-text-muted">
                {detail
                  ? `${detail.po_number} · ${detail.vendor_name}`
                  : "Loading..."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loadError && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold text-amber-900">
              {loadError}
            </div>
          )}

          {!detail && !loadError && (
            <div className="flex items-center justify-center py-12 gap-2 text-xs font-bold text-app-text-muted">
              <Clock size={16} className="animate-spin" /> Loading report...
            </div>
          )}

          {detail && (
            <>
              {/* Meta row */}
              <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                  <span className="text-[9px] font-bold uppercase text-app-text-muted">
                    Document
                  </span>
                  <p className="mt-1 font-mono text-base font-black text-app-text">
                    {detail.po_number}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                  <span className="text-[9px] font-bold uppercase text-app-text-muted">
                    Vendor
                  </span>
                  <p className="mt-1 text-base font-black text-app-text">
                    {detail.vendor_name}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                  <span className="text-[9px] font-bold uppercase text-app-text-muted">
                    Invoice #
                  </span>
                  <p className="mt-1 text-base font-black text-app-text">
                    {detail.invoice_number || "—"}
                  </p>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                  <span className="text-[9px] font-bold uppercase text-app-text-muted">
                    Date Received
                  </span>
                  <p className="mt-1 text-base font-black text-app-text">
                    {formatDate(detail.received_at)}
                  </p>
                </div>
                {detail.received_by_name && (
                  <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
                    <span className="text-[9px] font-bold uppercase text-app-text-muted">
                      Received By
                    </span>
                    <p className="mt-1 text-base font-black text-app-text">
                      {detail.received_by_name}
                    </p>
                  </div>
                )}
              </div>

              {/* Line items */}
              <div className="rounded-xl border border-app-border overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-app-surface-2/60 border-b border-app-border">
                    <tr>
                      <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-center">
                        Qty
                      </th>
                      <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">
                        SKU
                      </th>
                      <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">
                        Item
                      </th>
                      <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-right">
                        Unit Cost
                      </th>
                      <th className="px-4 py-2.5 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-right">
                        Extended
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border/40">
                    {detail.lines.map((line, i) => (
                      <tr
                        key={`${line.sku}-${i}`}
                        className="hover:bg-app-surface-2/30 transition-colors"
                      >
                        <td className="px-4 py-2.5 text-center font-bold text-app-text">
                          {line.quantity_received}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-app-text-muted">
                          {line.sku}
                        </td>
                        <td className="px-4 py-2.5 font-bold text-app-text">
                          {line.product_name}
                          {line.variation_label && (
                            <span className="ml-1 text-app-text-muted font-normal">
                              — {line.variation_label}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-app-text">
                          {dollars(line.unit_cost)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold text-app-text">
                          {dollars(line.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-64 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-app-text-muted font-bold">
                      Units received
                    </span>
                    <span className="font-bold text-app-text">
                      {detail.total_units}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-app-text-muted font-bold">
                      Merchandise
                    </span>
                    <span className="font-mono tabular-nums font-bold text-app-text">
                      {dollars(detail.total_merchandise_cost)}
                    </span>
                  </div>
                  {Number(detail.freight_total) > 0 && (
                    <div className="flex justify-between">
                      <span className="text-app-text-muted font-bold">
                        Freight / Shipping
                      </span>
                      <span className="font-mono tabular-nums font-bold text-amber-700">
                        {dollars(detail.freight_total)}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between border-t-2 border-app-text pt-2 mt-2">
                    <span className="font-black text-app-text">Total</span>
                    <span className="font-mono tabular-nums font-black text-emerald-700 text-sm">
                      {dollars(detail.grand_total)}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer Actions */}
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-app-border bg-app-surface px-6 py-4">
          <p className="text-[9px] font-bold text-app-text-muted">
            <FileText size={10} className="inline mr-1" />
            This report is saved in receiving history and can be reprinted.
          </p>
          <div className="flex items-center gap-2">
            {showTagPrompt && onPrintTags && detail && (
              <button
                type="button"
                onClick={() => onPrintTags(receivingEventId)}
                className="flex items-center gap-2 h-9 rounded-xl border border-app-accent/30 bg-app-accent/10 px-4 text-[10px] font-bold text-app-accent hover:bg-app-accent/20 transition-all active:scale-95"
              >
                <Tag size={13} /> Print Tags
              </button>
            )}
            <button
              type="button"
              onClick={printReport}
              disabled={!detail}
              className="flex items-center gap-2 h-9 rounded-xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-bold text-app-text hover:border-app-accent hover:text-app-accent disabled:opacity-30 transition-all active:scale-95"
            >
              <Printer size={13} /> Print Report
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-xl bg-emerald-600 px-5 text-[10px] font-bold text-white shadow-sm hover:brightness-110 transition-all active:scale-95"
            >
              Done
            </button>
          </div>
        </footer>
      </div>
    </div>,
    root,
  );
}
