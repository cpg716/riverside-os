import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useRegisterGate } from "../../context/RegisterGateContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import RegisterRequiredModal from "../layout/RegisterRequiredModal";
import PosRefundModal from "../pos/PosRefundModal";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import {
  centsToFixed2,
  formatUsdFromCents,
  parseMoneyToCents,
} from "../../lib/money";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Search,
  RotateCcw,
  Wallet,
  Printer,
  Truck,
} from "lucide-react";
import AttachOrderToWeddingModal from "./AttachOrderToWeddingModal";
import TransactionDetailDrawer, {
  type TransactionDrawerAudit,
  type TransactionDrawerDetail,
} from "./TransactionDetailDrawer";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { getAppIcon } from "../../lib/icons";

const WEDDINGS_ICON = getAppIcon("weddings");
const ORDERS_ICON = getAppIcon("orders");

function cn(...inputs: (string | undefined | null | boolean)[]) {
  return twMerge(clsx(inputs));
}

interface TransactionRow {
  transaction_id: string;
  display_id: string;
  booked_at: string;
  status: string;
  total_price: string;
  amount_paid: string;
  balance_due: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_code?: string | null;
  customer_phone?: string | null;
  customer_email?: string | null;
  wedding_member_id: string | null;
  wedding_party_id: string | null;
  party_name: string | null;
  wedding_event_date?: string | null;
  operator_name?: string | null;
  primary_salesperson_name?: string | null;
  item_count: number;
  order_items_summary?: string | null;
  order_print_items?: unknown;
  is_rush?: boolean;
  need_by_date?: string | null;
  order_kind: string;
  counterpoint_customer_code?: string | null;
}

interface OrderItem {
  order_item_id: string;
  transaction_line_id?: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  unit_price: string;
  unit_cost?: string;
  state_tax: string;
  local_tax: string;
  fulfillment: FulfillmentKind;
  /** Takeaway lines can be fulfilled at checkout; orders at pickup. */
  is_fulfilled: boolean;
}

type WorkspaceOrderDetail = Omit<TransactionDrawerDetail, "items"> & {
  items: OrderItem[];
};

interface TransactionPipelineStats {
  needs_action: number;
  ready_for_pickup: number;
  overdue: number;
  wedding_orders: number;
}

interface OrderIntegritySummary {
  visibleOrders: number;
  waitingOnDetails: number;
  balanceStillDue: number;
}

interface OrderLineSummary {
  count: number;
  items: string[];
  error?: string;
}

interface OrderPrintItem {
  name: string;
  sku: string | null;
  quantity: number;
  status: string;
}

interface LifecycleItem {
  transaction_line_id: string;
  transaction_display_id: string;
  customer_name: string;
  product_name: string;
  sku: string;
  variation_label?: string | null;
  quantity: number;
  vendor_id?: string | null;
  vendor_name?: string | null;
  salesperson_name?: string | null;
  is_rush: boolean;
  need_by_date?: string | null;
  wedding_date?: string | null;
  days_outstanding: number;
  risk_level: string;
  safe_next_action: string;
}

interface VendorOption {
  id: string;
  name: string;
}




interface ScanItem {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  standard_retail_price: string | number;
  unit_cost: string | number;
  state_tax: string | number;
  local_tax: string | number;
}

function money(v: string | number) {
  return formatUsdFromCents(parseMoneyToCents(v));
}

function summarizeOrderItemsFromDetail(items: TransactionDrawerDetail["items"]): OrderLineSummary {
  const orderItems = items.filter(
    (item) => item.fulfillment !== "takeaway" && !item.is_internal,
  );
  return {
    count: orderItems.length,
    items: orderItems.map((item) => {
      const name = item.product_name?.trim() || item.sku?.trim() || "Order item";
      const sku = item.sku?.trim();
      return `${item.quantity}x ${name}${sku ? ` (${sku})` : ""}`;
    }),
  };
}

function orderItemLines(
  row: Pick<TransactionRow, "transaction_id" | "item_count" | "order_items_summary">,
  hydratedSummaries: Record<string, OrderLineSummary>,
) {
  const hydrated = hydratedSummaries[row.transaction_id];
  if (hydrated?.items.length) return hydrated.items;
  if (hydrated?.error) return ["Could not load order items"];
  const summary = row.order_items_summary?.trim();
  if (summary) return summary.split(/\n|,\s+(?=\d+(?:\.\d+)?x\s)/i).map((line) => line.trim()).filter(Boolean);
  return row.item_count > 0 ? ["Loading order items..."] : ["No order items on this transaction"];
}

function formatLifecycleStatusLabel(status: string | null | undefined) {
  const raw = status?.trim();
  if (!raw) return "Lifecycle not loaded";
  const normalized = raw.toLowerCase().replace(/_/g, " ");
  switch (normalized) {
    case "ntbo":
      return "NTBO";
    case "ordered":
      return "Ordered";
    case "received":
      return "Received";
    case "ready for pickup":
      return "Ready for Pickup";
    case "picked up":
      return "Picked Up";
    default:
      return raw.replace(/_/g, " ");
  }
}

function stripLeadingQuantity(name: string) {
  return name.replace(/^\s*\d+(?:\.\d+)?\s*x\s+/i, "").trim() || name;
}

function parseFallbackOrderLine(line: string) {
  const match = line.match(/^\s*(\d+(?:\.\d+)?)\s*x\s+(.+)$/i);
  if (!match) return { quantity: 1, name: line };
  return {
    quantity: Number.parseFloat(match[1]) || 1,
    name: match[2].trim(),
  };
}

function displayOrderItemName(item: Pick<OrderPrintItem, "name">) {
  return stripLeadingQuantity(item.name.trim() || "Order item");
}

function orderItemsCount(row: TransactionRow, hydratedSummaries: Record<string, OrderLineSummary>) {
  return hydratedSummaries[row.transaction_id]?.count ?? row.item_count;
}

function orderPriorityLabels(row: Pick<TransactionRow, "is_rush" | "need_by_date">) {
  const labels: string[] = [];
  if (row.is_rush) labels.push("Rush");
  if (row.need_by_date) labels.push(`Due ${new Date(`${row.need_by_date}T00:00:00`).toLocaleDateString()}`);
  return labels;
}

function customerContactLines(row: Pick<TransactionRow, "customer_code" | "counterpoint_customer_code" | "customer_phone" | "customer_email">) {
  return [
    row.customer_code || row.counterpoint_customer_code ? `#${row.customer_code ?? row.counterpoint_customer_code}` : null,
    row.customer_phone ?? null,
    row.customer_email ?? null,
  ].filter((value): value is string => Boolean(value));
}

function customerNameLastFirst(row: Pick<TransactionRow, "customer_name" | "counterpoint_customer_code">) {
  const name = row.customer_name?.trim();
  if (!name) return `CP: ${row.counterpoint_customer_code ?? "Unknown"}`;
  if (name.includes(",")) return name;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`;
}

function dateDisplay(value: string | null | undefined) {
  return value ? new Date(`${value}T00:00:00`).toLocaleDateString() : "";
}

function escapePrintHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function asPrintItems(
  row: Pick<TransactionRow, "order_print_items" | "transaction_id" | "item_count" | "order_items_summary">,
  hydratedSummaries: Record<string, OrderLineSummary>,
): OrderPrintItem[] {
  if (Array.isArray(row.order_print_items)) {
    const items = row.order_print_items
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Order item";
        const sku = typeof record.sku === "string" && record.sku.trim() ? record.sku.trim() : null;
        const quantity =
          typeof record.quantity === "number"
            ? record.quantity
            : Number.parseInt(String(record.quantity ?? "1"), 10) || 1;
        const status = typeof record.status === "string" && record.status.trim() ? record.status.trim() : "NTBO";
        return { name, sku, quantity, status };
      })
      .filter((item): item is OrderPrintItem => Boolean(item));
    if (items.length > 0) return items;
  }

  return orderItemLines(row, hydratedSummaries).map((line) => {
    const parsed = parseFallbackOrderLine(line);
    return {
      name: parsed.name,
      sku: null,
      quantity: parsed.quantity,
      status: "Lifecycle not loaded",
    };
  });
}

function dateFilterLabel(datePreset: string, dateFrom: string, dateTo: string) {
  if (datePreset === "today") return "Today";
  if (datePreset === "30d") return "Last 30 days";
  if (datePreset === "custom") {
    if (dateFrom && dateTo) return `${dateFrom} to ${dateTo}`;
    if (dateFrom) return `From ${dateFrom}`;
    if (dateTo) return `Through ${dateTo}`;
    return "Custom date range";
  }
  return "All dates";
}

function openBespokeOrdersPrint(opts: {
  title: string;
  subtitle: string;
  rows: TransactionRow[];
  hydratedOrderLines: Record<string, OrderLineSummary>;
}) {
  const w = window.open("", "_blank", "width=1100,height=950");
  if (!w) return;

  const reportPrinter = localStorage.getItem("ros.pos.reportPrinterName") || "System Default";
  const orderCards = opts.rows
    .map((row) => {
      const items = asPrintItems(row, opts.hydratedOrderLines);
      const customerNumber = row.customer_code ?? row.counterpoint_customer_code ?? "";
      const itemRows = items
        .map((item) => {
          const skuText = item.sku ? `<span class="item-sku">${escapePrintHtml(item.sku)}</span>` : "";
          const status = `<span class="item-status">${escapePrintHtml(formatLifecycleStatusLabel(item.status))}</span>`;
          return `
            <div class="item-row">
              <div class="item-main">
                <span class="item-qty">${escapePrintHtml(`${item.quantity}x`)}</span>
                <div class="item-copy">
                  <div class="item-name">${escapePrintHtml(displayOrderItemName(item))}</div>
                  ${skuText}
                </div>
              </div>
              <div class="item-state">
                ${status}
              </div>
            </div>
          `;
        })
        .join("");
      const priority = [row.is_rush ? "Rush" : null, row.need_by_date ? `Due ${dateDisplay(row.need_by_date)}` : null]
        .filter(Boolean)
        .join(" · ");
      const weddingDate = row.wedding_event_date ? `Wedding ${dateDisplay(row.wedding_event_date)}` : "";
      return `
        <section class="order-card">
          <div class="order-top">
            <div class="customer-head">
              <div class="customer-name">${escapePrintHtml(customerNameLastFirst(row))}</div>
              <div class="customer-meta">
                <span>Customer # ${escapePrintHtml(customerNumber || "—")}</span>
                <span>Phone ${escapePrintHtml(row.customer_phone ?? "—")}</span>
                <span>Email ${escapePrintHtml(row.customer_email ?? "—")}</span>
              </div>
              <div class="transaction-meta">
                <span>${escapePrintHtml(row.display_id)}</span>
                <span>${escapePrintHtml(new Date(row.booked_at).toLocaleDateString())}</span>
                <span>${escapePrintHtml(formatOrderStatusLabel(row.status))}</span>
              </div>
            </div>
            <div class="order-flags">
              ${priority ? `<span>${escapePrintHtml(priority)}</span>` : ""}
              ${weddingDate ? `<span>${escapePrintHtml(weddingDate)}</span>` : ""}
            </div>
          </div>

          <div class="items-title">Items Ordered</div>
          <div class="items-list">${itemRows || `<div class="item-row muted">No order items on this transaction</div>`}</div>

          <div class="order-footer">
            <div class="staff-line">
              <span>${escapePrintHtml(row.primary_salesperson_name ? `Salesperson: ${row.primary_salesperson_name}` : "Salesperson: —")}</span>
              <span>${escapePrintHtml(row.operator_name ? `Cashier: ${row.operator_name}` : "Cashier: —")}</span>
            </div>
            <div class="money-grid">
              <div><span>Total</span><strong>${escapePrintHtml(money(row.total_price))}</strong></div>
              <div><span>Deposits</span><strong>${escapePrintHtml(money(row.amount_paid))}</strong></div>
              <div><span>Balance</span><strong>${escapePrintHtml(money(row.balance_due))}</strong></div>
            </div>
          </div>
        </section>
      `;
    })
    .join("");

  w.document.write(`<!DOCTYPE html><html><head><title>${escapePrintHtml(opts.title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800;900&display=swap');
    body { font-family: Inter, system-ui, sans-serif; color: #0f172a; padding: 32px; font-size: 13px; line-height: 1.35; }
    h1 { font-size: 28px; font-weight: 900; margin: 0; letter-spacing: 0; }
    .muted { color: #64748b; }
    .report-head { display:flex; justify-content:space-between; gap:24px; border-bottom:4px solid #0f172a; padding-bottom:18px; margin-bottom:22px; }
    .report-meta { text-align:right; font-weight:800; color:#475569; }
    .subtitle { font-size: 14px; font-weight: 800; margin: 0 0 20px; }
    .order-card { break-inside: avoid; border: 2px solid #cbd5e1; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .order-top { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; border-bottom:1px solid #e2e8f0; padding-bottom:12px; }
    .customer-head { min-width:0; flex:1; }
    .customer-name { font-size: 24px; font-weight: 900; letter-spacing:0; }
    .customer-meta, .transaction-meta { display:flex; flex-wrap:wrap; gap:10px 16px; margin-top:5px; color:#475569; font-size:12px; font-weight:800; }
    .transaction-meta { color:#0f172a; font-size:13px; }
    .order-flags { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
    .order-flags span, .item-status { border:1px solid #cbd5e1; border-radius:999px; padding:5px 9px; font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:.08em; white-space:nowrap; }
    .items-title { font-size:12px; font-weight:900; text-transform:uppercase; letter-spacing:.14em; color:#475569; margin:14px 0 8px; }
    .items-list { border:1px solid #e2e8f0; border-radius:10px; overflow:hidden; }
    .item-row { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:10px 12px; border-bottom:1px solid #e2e8f0; }
    .item-row:last-child { border-bottom:0; }
    .item-main { min-width:0; flex:1; display:flex; align-items:flex-start; gap:10px; }
    .item-qty { flex:0 0 auto; min-width:32px; font-size:15px; font-weight:900; color:#0f172a; }
    .item-copy { min-width:0; flex:1; }
    .item-name { font-size:15px; font-weight:900; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .item-sku { display:block; margin-top:2px; font-size:12px; font-weight:800; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .item-state { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; gap:4px; max-width:190px; }
    .order-footer { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-top:14px; }
    .staff-line { display:flex; flex-direction:column; gap:3px; font-size:12px; font-weight:800; color:#334155; }
    .money-grid { display:grid; grid-template-columns: repeat(3, auto); gap:14px; text-align:right; }
    .money-grid span { display:block; font-size:10px; font-weight:900; color:#64748b; text-transform:uppercase; letter-spacing:.12em; }
    .money-grid strong { display:block; font-size:17px; font-weight:900; margin-top:2px; }
    @media print {
      body { padding: 0; }
      .order-card { page-break-inside: avoid; }
    }
  </style></head><body>
    <header class="report-head">
      <div>
        <h1>RIVERSIDE OS</h1>
        <div class="muted" style="font-weight:800;margin-top:4px;">${escapePrintHtml(opts.title)} · Bespoke Order List</div>
      </div>
      <div class="report-meta">
        <div>REPORTING STATION</div>
        <div style="font-size:15px;color:#0f172a;margin-top:4px;">${escapePrintHtml(reportPrinter)}</div>
        <div style="margin-top:8px;">Generated: ${escapePrintHtml(new Date().toLocaleString())}</div>
      </div>
    </header>
    <p class="subtitle">${escapePrintHtml(opts.subtitle)}</p>
    ${orderCards || `<section class="order-card muted">No records found</section>`}
  </body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 500);
}

type Section = "open" | "all";
type OrderViewPreset = "open" | "all";
type FulfillmentKind =
  | "takeaway"
  | "shipment"
  | "wedding_order"
  | "special_order"
  | "custom"
  | "regular_order"
  | "layaway";

interface OrderRowActions {
  onOpenInRegister?: (orderId: string) => void;
  onAttachToWedding: () => void;
  onCancel: () => void;
  onReturnAll: () => void;
  deleteLine: (it: OrderItem) => void;
  addBySku: (skuOverride?: string) => Promise<boolean>;
  updateLine: (
    item: Pick<
      OrderItem,
      "transaction_line_id" | "sku" | "product_name" | "quantity" | "unit_price" | "fulfillment"
    >,
    patch: {
      quantity?: number;
      unit_price?: string;
      fulfillment?: FulfillmentKind;
    },
  ) => Promise<void>;
  setSku: (s: string) => void;
  sku: string;
  canModify: boolean;
  canAttemptCancel: boolean;
}



function orderKindLabel(kind: string) {
  switch (kind) {
    case "wedding_order":
      return "Wedding";
    case "special_order":
      return "Special";
    case "custom":
      return "Custom";
    case "layaway":
      return "Layaway";
    default:
      return "Transaction";
  }
}

function formatOrderStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function OrderTableRow({ row, isSelected, onClick, actions, hydratedSummaries }: {
  row: TransactionRow;
  isSelected: boolean; 
  onClick: () => void;
  actions: OrderRowActions;
  hydratedSummaries: Record<string, OrderLineSummary>;
}) {
  const lifecycleItems = asPrintItems(row, hydratedSummaries);
  const visibleItemCount = lifecycleItems.length || orderItemsCount(row, hydratedSummaries);
  const contactLines = customerContactLines(row);
  const priorityLabels = orderPriorityLabels(row);
  return (
    <tr 
      onClick={onClick}
      onDoubleClick={() => actions.onOpenInRegister?.(row.transaction_id)}
      className={cn(
        "group cursor-pointer transition-all duration-150 hover:bg-app-surface-2 focus-within:bg-app-surface-2",
        isSelected ? "border-l-4 border-app-success bg-app-success/8" : "border-l-4 border-transparent"
      )}
    >
        <td className="px-6 py-4">
           <p className="text-[11px] font-black tracking-tight text-app-text mb-1">{row.display_id}</p>
           <p className="text-[9px] font-bold uppercase tracking-widest italic text-app-text-muted">
             {new Date(row.booked_at).toLocaleDateString()}
           </p>
        </td>
        <td className="px-6 py-4">
           <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-success/10 text-[10px] font-black text-app-success">
                {row.customer_name?.[0] ?? row.counterpoint_customer_code?.[0] ?? "W"}
              </div>
              <div>
                <p className="text-[11px] font-bold text-app-text flex items-center gap-1.5">
                  {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
                  {row.party_name && <WEDDINGS_ICON size={10} className="text-app-danger" />}
                </p>
                {contactLines.length > 0 ? (
                  <div className="mt-1 space-y-0.5 text-[9px] font-bold text-app-text-muted">
                    {contactLines.map((line) => (
                      <p key={line} className="truncate">{line}</p>
                    ))}
                  </div>
                ) : null}
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest italic text-app-text-muted">
                    {orderKindLabel(row.order_kind)}
                  </p>
                  {row.counterpoint_customer_code && (
                    <span className="rounded-md border border-app-success/20 bg-app-success/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-success">
                      CP Open Doc
                    </span>
                  )}
                  {row.party_name && <p className="text-[9px] font-bold uppercase tracking-tighter italic text-app-danger">{row.party_name}</p>}
                </div>
              </div>
           </div>
        </td>
        <td className="px-6 py-4 max-w-[300px]">
           <p className="text-[10px] font-black text-app-text">
             {visibleItemCount} item{visibleItemCount === 1 ? "" : "s"}
           </p>
           <div className="mt-1 space-y-1 text-[10px] font-bold text-app-text-muted">
             {lifecycleItems.map((item, index) => (
               <div
                 key={`${item.name}-${item.sku ?? "no-sku"}-${index}`}
                 className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-app-border/50 bg-app-surface-2/60 px-2 py-1"
                 data-testid="open-order-lifecycle-item"
               >
                 <span className="min-w-0 flex-1 truncate">
                   <span className="font-black text-app-text">{item.quantity}x</span>{" "}
                   {displayOrderItemName(item)}
                   {item.sku ? <span className="text-app-text-disabled"> · {item.sku}</span> : null}
                 </span>
                 <span className="shrink-0 rounded-md border border-app-border bg-app-surface px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text">
                   {formatLifecycleStatusLabel(item.status)}
                 </span>
               </div>
             ))}
           </div>
           {priorityLabels.length > 0 ? (
             <div className="mt-2 flex flex-wrap gap-1">
               {priorityLabels.map((label) => (
                 <span
                   key={label}
                   className="rounded-md border border-app-warning/30 bg-app-warning/10 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-warning"
                 >
                   {label}
                 </span>
               ))}
             </div>
           ) : null}
        </td>
        <td className="px-6 py-4">
          <p className="max-w-[180px] truncate text-[10px] font-black text-app-text">
            {row.primary_salesperson_name ?? "—"}
          </p>
          <p className="mt-1 max-w-[180px] truncate text-[9px] font-bold text-app-text-muted">
            Cashier: {row.operator_name ?? "—"}
          </p>
        </td>
        <td className="px-6 py-4">
           <span className={cn(
             "px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest border",
             row.counterpoint_customer_code
               ? "border-app-info/20 bg-app-info/10 text-app-info"
               : "border-app-success/20 bg-app-success/10 text-app-success"
           )}>
             {formatOrderStatusLabel(row.status)}
           </span>
        </td>
        <td className="px-6 py-4">
          <p className="text-[11px] font-black text-app-text">{money(row.total_price)}</p>
          <p className="mt-1 text-[9px] font-bold text-app-text-muted">
            Deposits {money(row.amount_paid)}
          </p>
        </td>
        <td className="px-6 py-4 text-right flex items-center justify-end gap-3">
          <p className={cn("text-[11px] font-black", parseMoneyToCents(row.balance_due) > 0 ? "text-app-warning" : "text-app-text-disabled")}>
            {money(row.balance_due)}
          </p>
           <button 
             onClick={(e) => { e.stopPropagation(); actions.onOpenInRegister?.(row.transaction_id); }}
             className="rounded-lg bg-app-success px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-white opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:brightness-110 active:scale-95 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-success/30"
           >
             Register
           </button>
        </td>
      </tr>
  );
}

function OrderMobileCard({
  row,
  isSelected,
  onClick,
  actions,
  hydratedSummaries,
}: {
  row: TransactionRow;
  isSelected: boolean;
  onClick: () => void;
  actions: OrderRowActions;
  hydratedSummaries: Record<string, OrderLineSummary>;
}) {
  const balanceDue = parseMoneyToCents(row.balance_due);
  const lifecycleItems = asPrintItems(row, hydratedSummaries);
  const visibleItemCount = lifecycleItems.length || orderItemsCount(row, hydratedSummaries);
  const contactLines = customerContactLines(row);
  const priorityLabels = orderPriorityLabels(row);
  return (
    <article
      className={cn(
        "rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm",
        isSelected && "ring-2 ring-app-success",
      )}
    >
      <button type="button" onClick={onClick} className="w-full text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-black text-app-text">{row.display_id}</p>
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {new Date(row.booked_at).toLocaleDateString()} · {orderKindLabel(row.order_kind)}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-lg border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest",
              row.counterpoint_customer_code
                ? "border-app-info/20 bg-app-info/10 text-app-info"
                : "border-app-success/20 bg-app-success/10 text-app-success",
            )}
          >
            {formatOrderStatusLabel(row.status)}
          </span>
        </div>

        <div className="mt-4 min-w-0">
          <p className="truncate text-base font-black text-app-text">
            {row.customer_name ?? `CP: ${row.counterpoint_customer_code ?? "Unknown"}`}
          </p>
          {contactLines.length > 0 ? (
            <div className="mt-1 space-y-0.5 text-[10px] font-bold text-app-text-muted">
              {contactLines.map((line) => (
                <p key={line} className="truncate">{line}</p>
              ))}
            </div>
          ) : null}
          <p className="mt-1 truncate text-xs font-semibold text-app-text-muted">
            {visibleItemCount} item{visibleItemCount === 1 ? "" : "s"}
            {row.primary_salesperson_name ? ` · ${row.primary_salesperson_name}` : ""}
            {row.operator_name ? ` · Cashier ${row.operator_name}` : ""}
          </p>
          <div className="mt-2 space-y-1 rounded-xl border border-app-border/50 bg-app-surface-2/70 px-3 py-2 text-xs font-semibold text-app-text-muted">
            {lifecycleItems.map((item, index) => (
              <div
                key={`${item.name}-${item.sku ?? "no-sku"}-${index}`}
                className="flex min-w-0 items-center justify-between gap-2"
                data-testid="open-order-lifecycle-item"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-black text-app-text">{item.quantity}x</span>{" "}
                  {displayOrderItemName(item)}
                  {item.sku ? <span className="text-app-text-disabled"> · {item.sku}</span> : null}
                </span>
                <span className="shrink-0 rounded-md border border-app-border bg-app-surface px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text">
                  {formatLifecycleStatusLabel(item.status)}
                </span>
              </div>
            ))}
          </div>
          {priorityLabels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {priorityLabels.map((label) => (
                <span
                  key={label}
                  className="rounded-md border border-app-warning/30 bg-app-warning/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-warning"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}
          {row.party_name ? (
            <p className="mt-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-app-danger">
              <WEDDINGS_ICON size={12} />
              {row.party_name}
            </p>
          ) : null}
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Total
            </dt>
            <dd className="mt-1 font-mono font-black text-app-text">
              {money(row.total_price)}
            </dd>
          </div>
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Deposits
            </dt>
            <dd className="mt-1 font-mono font-black text-app-text">
              {money(row.amount_paid)}
            </dd>
          </div>
          <div className="rounded-xl border border-app-border/50 bg-app-surface-2/70 p-3">
            <dt className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Due
            </dt>
            <dd className={cn("mt-1 font-mono font-black", balanceDue > 0 ? "text-app-warning" : "text-app-text-muted")}>
              {money(row.balance_due)}
            </dd>
          </div>
        </dl>
      </button>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => actions.onOpenInRegister?.(row.transaction_id)}
          className="min-h-11 rounded-xl bg-app-success px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white"
        >
          Register
        </button>
        <button
          type="button"
          onClick={onClick}
          className="min-h-11 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
        >
          {isSelected ? "Hide Detail" : "View Detail"}
        </button>
      </div>
    </article>
  );
}

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

export default function OrdersWorkspace({
  activeSection = "open",
  onOpenInRegister,
  deepLinkTxnId = null,
  onDeepLinkTxnConsumed,
  refreshSignal = 0,
}: {
  activeSection?: string;
  onOpenInRegister?: (orderId: string) => void;
  /** When set, selects this order in the list and opens detail (e.g. from CRM hub). */
  deepLinkTxnId?: string | null;
  onDeepLinkTxnConsumed?: () => void;
  refreshSignal?: number;
}) {
  const defaultViewPreset: OrderViewPreset =
    activeSection === "all" ? "all" : "open";
  const baseUrl = getBaseUrl();
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { goToOpenRegister } = useRegisterGate();

  const canModify = hasPermission("orders.modify");
  const canCancel = hasPermission("orders.cancel");
  const canVoidUnpaid = hasPermission("orders.void_sale");
  const canRefund = hasPermission("orders.refund_process");
  const canManageLifecycle = hasPermission("orders.lifecycle_manage");

  const [transactionRows, setTransactionRows] = useState<TransactionRow[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsLoadError, setTransactionsLoadError] = useState<string | null>(null);
  const [pipelineStats, setPipelineStats] =
    useState<TransactionPipelineStats | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [sku, setSku] = useState("");
  const [audit, setAudit] = useState<TransactionDrawerAudit[]>([]);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const limit = 5000; // High-volume non-paginated limit for operational focus

  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [returnConfirmOpen, setReturnConfirmOpen] = useState(false);
  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundTargetOrderId, setRefundTargetOrderId] = useState<string | null>(null);
  const [refundAmountStr, setRefundAmountStr] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [refundGiftCode, setRefundGiftCode] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [registerRequiredOpen, setRegisterRequiredOpen] = useState(false);
  useShellBackdropLayer(refundModalOpen || registerRequiredOpen);
  // exchangeOtherId removed
  const [returnQtyDraft, setReturnQtyDraft] = useState<Record<string, string>>({});
  const [attachWeddingModalOpen, setAttachWeddingModalOpen] = useState(false);
  const detailRequestSeqRef = useRef(0);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [paymentFilter, setPaymentFilter] = useState("all");
  const [salespersonFilter, setSalespersonFilter] = useState("all");
  const [datePreset, setDatePreset] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [viewPreset, setViewPreset] = useState<OrderViewPreset>(
    defaultViewPreset,
  );
  const [hydratedOrderLines, setHydratedOrderLines] = useState<Record<string, OrderLineSummary>>({});
  const [ntboItems, setNtboItems] = useState<LifecycleItem[]>([]);
  const [ntboLoading, setNtboLoading] = useState(false);
  const [ntboError, setNtboError] = useState<string | null>(null);
  const [selectedNtboIds, setSelectedNtboIds] = useState<Set<string>>(() => new Set());
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [ntboVendorId, setNtboVendorId] = useState("");
  const [ntboPoBusy, setNtboPoBusy] = useState(false);

  const section: Section = viewPreset === "all" ? "all" : "open";

  const loadNtboItems = useCallback(async () => {
    setNtboLoading(true);
    setNtboError(null);
    try {
      const [itemsRes, vendorsRes] = await Promise.all([
        fetch(`${baseUrl}/api/order-lifecycle/items?status=ntbo`, {
          headers: backofficeHeaders(),
        }),
        fetch(`${baseUrl}/api/vendors`, {
          headers: backofficeHeaders(),
        }),
      ]);
      if (!itemsRes.ok) throw new Error("ntbo_load_failed");
      const items = (await itemsRes.json()) as LifecycleItem[];
      const nextItems = Array.isArray(items) ? items : [];
      setNtboItems(nextItems);
      setSelectedNtboIds((prev) => {
        const visible = new Set(nextItems.map((item) => item.transaction_line_id));
        return new Set([...prev].filter((id) => visible.has(id)));
      });
      if (vendorsRes.ok) {
        const rows = (await vendorsRes.json()) as VendorOption[];
        setVendors(Array.isArray(rows) ? rows : []);
      }
    } catch {
      setNtboError("NTBO queue could not refresh. Existing orders are still shown below.");
    } finally {
      setNtboLoading(false);
    }
  }, [backofficeHeaders, baseUrl]);

  useEffect(() => {
    setViewPreset(defaultViewPreset);
  }, [defaultViewPreset]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, kindFilter, paymentFilter, salespersonFilter, datePreset, dateFrom, dateTo, section]);

  const loadPipelineStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/transactions/pipeline-stats`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as TransactionPipelineStats;
      setPipelineStats(data);
    } catch {
      // ignore
    }
  }, [baseUrl, backofficeHeaders]);

  const loadTransactions = useCallback(async () => {
    setTransactionsLoading(true);
    setTransactionsLoadError(null);
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(page * limit));
    params.set("status_scope", section === "open" ? "open" : "closed");
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (kindFilter !== "all") params.set("kind_filter", kindFilter);
    if (paymentFilter !== "all") params.set("payment_filter", paymentFilter);
    if (salespersonFilter !== "all") params.set("salesperson_filter", salespersonFilter);
    if (dateFrom) params.set("date_from", new Date(dateFrom).toISOString());
    if (dateTo) {
      const inclusiveDateTo = new Date(dateTo);
      inclusiveDateTo.setHours(23, 59, 59, 999);
      params.set("date_to", inclusiveDateTo.toISOString());
    }

    try {
      const res = await fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        throw new Error("transactions_load_failed");
      }
      const data = await res.json();
      setTransactionRows(Array.isArray(data.items) ? data.items : []);
      setTotalCount(typeof data.total_count === "number" ? data.total_count : 0);
    } catch {
      setTransactionsLoadError("Transaction records could not load right now. Try again in a moment.");
    } finally {
      setTransactionsLoading(false);
    }
  }, [baseUrl, backofficeHeaders, page, debouncedSearch, kindFilter, paymentFilter, salespersonFilter, dateFrom, dateTo, section]);

  const loadDetail = useCallback(async (id: string) => {
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [detailRes, auditRes] = await Promise.all([
        fetch(`${baseUrl}/api/transactions/${id}`, {
          headers: backofficeHeaders(),
        }),
        fetch(`${baseUrl}/api/transactions/${id}/audit`, {
          headers: backofficeHeaders(),
        }),
      ]);

      if (!detailRes.ok) {
        if (detailRequestSeqRef.current !== requestSeq) return;
        setDetail(null);
        setAudit([]);
        setDetailError("We couldn't load this transaction record right now.");
        return;
      }

      const rawDetail = (await detailRes.json()) as TransactionDrawerDetail;
      if (detailRequestSeqRef.current !== requestSeq) return;
      setDetail({
        ...rawDetail,
        items: (rawDetail.items ?? []).map((item) => ({
          order_item_id:
            (item as { order_item_id?: string; transaction_line_id?: string }).order_item_id ??
            item.transaction_line_id ??
            `${item.sku}-${item.product_name}`,
          transaction_line_id: item.transaction_line_id,
          product_id: (item as { product_id?: string }).product_id ?? "",
          variant_id: (item as { variant_id?: string }).variant_id ?? "",
          sku: item.sku,
          product_name: item.product_name,
          variation_label: item.variation_label,
          quantity: item.quantity,
          quantity_returned: item.quantity_returned ?? 0,
          unit_price: item.unit_price,
          unit_cost: item.unit_cost,
          state_tax: String(item.state_tax ?? "0"),
          local_tax: String(item.local_tax ?? "0"),
          fulfillment: item.fulfillment as FulfillmentKind,
          is_fulfilled: Boolean(item.is_fulfilled),
        })),
      });
      if (auditRes.ok) {
        const nextAudit = (await auditRes.json()) as TransactionDrawerAudit[];
        if (detailRequestSeqRef.current !== requestSeq) return;
        setAudit(nextAudit);
      } else {
        if (detailRequestSeqRef.current !== requestSeq) return;
        setAudit([]);
      }
    } catch {
      if (detailRequestSeqRef.current !== requestSeq) return;
      setDetail(null);
      setAudit([]);
      setDetailError("We couldn't load this transaction record right now.");
    } finally {
      if (detailRequestSeqRef.current === requestSeq) {
        setDetailLoading(false);
      }
    }
    setReturnQtyDraft({});
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void loadPipelineStats();
  }, [loadPipelineStats]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    void loadNtboItems();
  }, [loadNtboItems]);

  useEffect(() => {
    const rowsNeedingNames = transactionRows.filter(
      (row) => row.item_count > 0 && !row.order_items_summary?.trim() && !hydratedOrderLines[row.transaction_id],
    );
    if (rowsNeedingNames.length === 0) return;

    let cancelled = false;
    void Promise.all(
      rowsNeedingNames.map(async (row) => {
        try {
          const res = await fetch(`${baseUrl}/api/transactions/${row.transaction_id}`, {
            headers: backofficeHeaders(),
          });
          if (!res.ok) throw new Error("detail_load_failed");
          const detailForSummary = (await res.json()) as TransactionDrawerDetail;
          return [row.transaction_id, summarizeOrderItemsFromDetail(detailForSummary.items)] as const;
        } catch {
          return [
            row.transaction_id,
            {
              count: row.item_count,
              items: [],
              error: "Could not load order items",
            } satisfies OrderLineSummary,
          ] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setHydratedOrderLines((current) => {
        const next = { ...current };
        for (const [transactionId, summary] of entries) {
          next[transactionId] = summary;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [backofficeHeaders, baseUrl, hydratedOrderLines, transactionRows]);

  useEffect(() => {
    if (!deepLinkTxnId) return;
    setSelectedId(deepLinkTxnId);
    onDeepLinkTxnConsumed?.();
  }, [deepLinkTxnId, onDeepLinkTxnConsumed]);

  useEffect(() => {
    if (!selectedId) {
      detailRequestSeqRef.current += 1;
      setDetail(null);
      setAudit([]);
      setDetailError(null);
      setRefundTargetOrderId(null);
      return;
    }
    void loadDetail(selectedId);
    setRefundTargetOrderId(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (refreshSignal === 0) return;
    void loadPipelineStats();
    void loadTransactions();
    void loadNtboItems();
    if (selectedId) {
      void loadDetail(selectedId);
    }
  }, [loadDetail, loadNtboItems, loadPipelineStats, loadTransactions, refreshSignal, selectedId]);

  const addBySku = async (skuOverride?: string): Promise<boolean> => {
    const enteredSku = (skuOverride ?? sku).trim();
    if (!detail || !enteredSku || !canModify) return false;
    let item: ScanItem;
    try {
      const scanRes = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(enteredSku)}`,
        {
          headers: backofficeHeaders(),
        },
      );
      if (!scanRes.ok) {
        await scanRes.json().catch(() => ({}));
        if (scanRes.status === 404) {
          toast(`SKU "${enteredSku}" was not found. Check it and try again.`, "error");
          return false;
        }
        if (scanRes.status === 401 || scanRes.status === 403) {
          toast("Your session or access has expired. Sign in again and retry.", "error");
          return false;
        }
        if (scanRes.status >= 500) {
          toast("SKU lookup is temporarily unavailable. Please try again.", "error");
          return false;
        }
        toast("SKU lookup failed. Please try again.", "error");
        return false;
      }
      item = (await scanRes.json()) as ScanItem;
    } catch {
      toast("SKU lookup failed. Please try again.", "error");
      return false;
    }
    if (!item.product_id || !item.variant_id) {
      toast(`SKU "${enteredSku}" was not found. Check it and try again.`, "error");
      return false;
    }
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/items`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({
        product_id: item.product_id,
        variant_id: item.variant_id,
        fulfillment: detail.wedding_member_id ? "wedding_order" : "special_order",
        quantity: 1,
        unit_price: centsToFixed2(parseMoneyToCents(item.standard_retail_price)),
        unit_cost: centsToFixed2(parseMoneyToCents(item.unit_cost)),
        state_tax: centsToFixed2(parseMoneyToCents(item.state_tax)),
        local_tax: centsToFixed2(parseMoneyToCents(item.local_tax)),
      }),
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      toast("We couldn't add this item. Please try again.", "error");
      return false;
    }
    setSku("");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    setHydratedOrderLines((current) => {
      const next = { ...current };
      delete next[detail.transaction_id];
      return next;
    });
    return true;
  };

  const orderUnpaid = detail
    ? parseMoneyToCents(detail.amount_paid) === 0
    : false;
  const canAttemptCancel =
    !!detail &&
    (canCancel || (canVoidUnpaid && orderUnpaid));

  const runCancelOrder = async () => {
    if (!detail || !canAttemptCancel) return;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ status: "cancelled" }),
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      toast("We couldn't cancel this transaction. Please try again.", "error");
      return;
    }
    setCancelConfirmOpen(false);
      toast("Transaction cancelled", "info");
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    setHydratedOrderLines((current) => {
      const next = { ...current };
      delete next[detail.transaction_id];
      return next;
    });
  };

  const deleteLine = async (item: Pick<OrderItem, "order_item_id">) => {
    if (!detail || !canModify) return;
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/items/${item.order_item_id}`, {
      method: "DELETE",
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      toast("We couldn't remove this item. Please try again.", "error");
      return;
    }
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    setHydratedOrderLines((current) => {
      const next = { ...current };
      delete next[detail.transaction_id];
      return next;
    });
  };

  const updateLine = useCallback(
    async (
      item: Pick<
        OrderItem,
        "transaction_line_id" | "sku" | "product_name" | "quantity" | "unit_price" | "fulfillment"
      >,
      patch: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
      },
    ) => {
      if (!detail || !canModify || !item.transaction_line_id) return;
      const body: {
        quantity?: number;
        unit_price?: string;
        fulfillment?: FulfillmentKind;
      } = {};
      if (patch.quantity !== undefined) {
        body.quantity = patch.quantity;
      }
      if (patch.unit_price !== undefined) {
        body.unit_price = centsToFixed2(parseMoneyToCents(patch.unit_price));
      }
      if (patch.fulfillment !== undefined) {
        body.fulfillment = patch.fulfillment;
      }
      if (
        body.quantity === undefined &&
        body.unit_price === undefined &&
        body.fulfillment === undefined
      ) {
        return;
      }
      const res = await fetch(
        `${baseUrl}/api/transactions/${detail.transaction_id}/items/${item.transaction_line_id}`,
        {
          method: "PATCH",
          headers: jsonHeaders(backofficeHeaders),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        await res.json().catch(() => ({}));
        throw new Error("We couldn't save that line. Please try again.");
      }
      toast(`${item.product_name} updated.`, "success");
      await loadDetail(detail.transaction_id);
      await loadTransactions();
      setHydratedOrderLines((current) => {
        const next = { ...current };
        delete next[detail.transaction_id];
        return next;
      });
    },
    [backofficeHeaders, baseUrl, canModify, detail, loadDetail, loadTransactions, toast],
  );

  /** applyReturns is used in ConfirmationModal or similar, if unused prefix with _ */
  const _applyReturns = async () => {
    if (!detail || !canModify || detail.status === "cancelled") return;
    const lines: { order_item_id: string; quantity: number; reason?: string }[] = [];
    for (const it of detail.items) {
      const raw = (returnQtyDraft[it.order_item_id] ?? "").trim();
      if (!raw) continue;
      const q = Number(raw);
      if (!Number.isFinite(q) || q <= 0) continue;
      const max = it.quantity - (it.quantity_returned ?? 0);
      if (q > max) {
        toast(`Return qty too high for line ${it.sku} (max ${max})`, "error");
        return;
      }
      lines.push({ order_item_id: it.order_item_id, quantity: q, reason: "return" });
    }
    if (lines.length === 0) {
      toast("Enter return quantities first", "info");
      return;
    }
    const res = await fetch(`${baseUrl}/api/transactions/${detail.transaction_id}/returns`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ lines }),
    });
    if (!res.ok) {
      await res.json().catch(() => ({}));
      toast("Return failed. Check the quantities and try again.", "error");
      return;
    }
    toast("Return saved.", "success");
    setReturnQtyDraft({});
    await loadDetail(detail.transaction_id);
    await loadTransactions();
    setHydratedOrderLines((current) => {
      const next = { ...current };
      delete next[detail.transaction_id];
      return next;
    });
  };

// linkExchange logic removed for build stabilization

  const submitProcessRefund = async () => {
    if (!refundTargetOrderId || !canRefund) return;
    setRefundBusy(true);
    try {
      const cur = await fetch(`${baseUrl}/api/sessions/current`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (cur.status === 409) {
        toast(
          "More than one register is open. Choose which register to use when prompted, then try again.",
          "error",
        );
        return;
      }
      if (!cur.ok) {
        setRegisterRequiredOpen(true);
        return;
      }
      const sess = (await cur.json()) as { session_id: string };
      const amtCents = parseMoneyToCents(refundAmountStr.trim());
      if (amtCents <= 0) {
        toast("Enter a valid refund amount", "error");
        return;
      }
      const body: Record<string, unknown> = {
        session_id: sess.session_id,
        payment_method: refundMethod.trim(),
        amount: centsToFixed2(amtCents),
      };
      if (refundMethod.toLowerCase().includes("gift")) {
        body.gift_card_code = refundGiftCode.trim();
      }
      const res = await fetch(`${baseUrl}/api/transactions/${refundTargetOrderId}/refunds/process`, {
        method: "POST",
        headers: jsonHeaders(backofficeHeaders),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Refund failed. Check the amount and try again.", "error");
        return;
      }
      toast("Refund completed.", "success");
      setRefundModalOpen(false);
      if (detail?.transaction_id === refundTargetOrderId) await loadDetail(refundTargetOrderId);
      await loadTransactions();
    } finally {
      setRefundBusy(false);
    }
  };

  const salespersonOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of transactionRows) {
      const n = (r.primary_salesperson_name ?? "").trim();
      if (n) set.add(n);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [transactionRows]);

  const createPoFromNtbo = useCallback(async () => {
    if (!ntboVendorId || selectedNtboIds.size === 0) return;
    setNtboPoBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/order-lifecycle/ntbo/create-po`, {
        method: "POST",
        headers: jsonHeaders(backofficeHeaders),
        body: JSON.stringify({
          vendor_id: ntboVendorId,
          transaction_line_ids: [...selectedNtboIds],
          notes: "Created from ROS NTBO queue",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Could not create purchase order from NTBO items.", "error");
        return;
      }
      const body = (await res.json()) as { po_number?: string; linked_line_count?: number };
      toast(
        `${body.po_number ?? "Purchase order"} created for ${body.linked_line_count ?? selectedNtboIds.size} item(s).`,
        "success",
      );
      setSelectedNtboIds(new Set());
      await loadNtboItems();
      await loadTransactions();
    } finally {
      setNtboPoBusy(false);
    }
  }, [backofficeHeaders, baseUrl, loadNtboItems, loadTransactions, ntboVendorId, selectedNtboIds, toast]);

  const orderIntegritySummary = useMemo<OrderIntegritySummary>(() => {
    return transactionRows.reduce(
      (summary, row) => ({
        visibleOrders: summary.visibleOrders + 1,
        waitingOnDetails:
          summary.waitingOnDetails + (row.status === "pending_measurement" ? 1 : 0),
        balanceStillDue:
          summary.balanceStillDue +
          (parseMoneyToCents(row.balance_due) > 0 ? 1 : 0),
      }),
      {
        visibleOrders: 0,
        waitingOnDetails: 0,
        balanceStillDue: 0,
      },
    );
  }, [transactionRows]);

  const orderStatCards = [
    {
      label: "Visible Records",
      value: orderIntegritySummary.visibleOrders,
      icon: ORDERS_ICON,
      tint: "ui-tint-info",
      color: "text-app-info",
      bg: "bg-app-info/8",
      border: "border-app-info/16",
    },
    {
      label: "Waiting Details",
      value: orderIntegritySummary.waitingOnDetails,
      icon: Clock,
      tint: "ui-tint-warning",
      color: "text-app-warning",
      bg: "bg-app-warning/8",
      border: "border-app-warning/16",
    },
    {
      label: "Balance Due",
      value: orderIntegritySummary.balanceStillDue,
      icon: Wallet,
      tint: "ui-tint-danger",
      color: "text-app-danger",
      bg: "bg-app-danger/8",
      border: "border-app-danger/16",
    },
    {
      label: "Wedding Orders",
      value: pipelineStats?.wedding_orders ?? 0,
      icon: WEDDINGS_ICON,
      tint: "ui-tint-accent",
      color: "text-app-accent",
      bg: "bg-app-accent/8",
      border: "border-app-accent/16",
    },
  ];

  const orderFollowUpMetrics = [
    { label: "Needs action", value: pipelineStats?.needs_action ?? 0, icon: Activity },
    { label: "Ready pickup", value: pipelineStats?.ready_for_pickup ?? 0, icon: CheckCircle2 },
    { label: "Overdue follow-up", value: pipelineStats?.overdue ?? 0, icon: AlertTriangle },
  ];

  const hasUnresolvedOrderItems = transactionRows.some((row) => {
    if (row.item_count <= 0 || row.order_items_summary?.trim()) return false;
    const hydrated = hydratedOrderLines[row.transaction_id];
    return !hydrated?.items.length && !hydrated?.error;
  });

  const printOrdersList = useCallback(() => {
    if (hasUnresolvedOrderItems) {
      toast("Order item names are still loading. Try Print again once the list finishes.", "info");
      return;
    }
    const title = viewPreset === "open" ? "Open Orders List" : "Transaction History List";
    const filters = [
      `View: ${viewPreset === "open" ? "Open orders" : "Transaction history"}`,
      `Date: ${dateFilterLabel(datePreset, dateFrom, dateTo)}`,
      `Type: ${kindFilter === "all" ? "All" : orderKindLabel(kindFilter)}`,
      `Payment: ${paymentFilter === "all" ? "All" : paymentFilter}`,
      `Staff: ${salespersonFilter === "all" ? "All" : salespersonFilter}`,
      search.trim() ? `Search: ${search.trim()}` : null,
    ].filter(Boolean);

    openBespokeOrdersPrint({
      title,
      subtitle: `${filters.join(" · ")} · ${transactionRows.length} visible record${transactionRows.length === 1 ? "" : "s"}`,
      rows: transactionRows,
      hydratedOrderLines,
    });
  }, [
    dateFrom,
    datePreset,
    dateTo,
    hasUnresolvedOrderItems,
    hydratedOrderLines,
    kindFilter,
    paymentFilter,
    salespersonFilter,
    search,
    toast,
    transactionRows,
    viewPreset,
  ]);

  const renderTransactionListState = (layout: "mobile" | "desktop") => {
    if (transactionRows.length > 0) return null;

    const isMobile = layout === "mobile";
    const wrapperClass = isMobile
      ? "rounded-2xl border border-dashed border-app-border bg-app-surface-2 p-8 text-center text-app-text-muted"
      : "flex flex-col items-center justify-center p-16 text-center text-app-text-muted";
    const iconSize = isMobile ? 40 : 48;

    if (transactionsLoading) {
      return (
        <div className={wrapperClass}>
          <Clock size={iconSize} className="mx-auto mb-3 opacity-50" />
          <p className="text-sm font-black uppercase tracking-widest italic">
            Loading transaction records
          </p>
        </div>
      );
    }

    if (transactionsLoadError) {
      return (
        <div className={wrapperClass}>
          <AlertTriangle
            size={iconSize}
            className="mx-auto mb-3 text-amber-600 opacity-80"
          />
          <p className="text-sm font-black uppercase tracking-widest italic text-app-text">
            Transactions unavailable
          </p>
          <p
            className={cn(
              "mt-2 text-sm font-medium normal-case tracking-normal text-app-text-muted",
              !isMobile && "max-w-sm",
            )}
          >
            {transactionsLoadError}
          </p>
        </div>
      );
    }

    return (
      <div className={wrapperClass}>
        <Search size={iconSize} className="mx-auto mb-3 opacity-50" />
        <p className="text-sm font-black uppercase tracking-widest italic">
          No matching records found
        </p>
        <p
          className={cn(
            "mt-2 text-sm font-medium normal-case tracking-normal",
            !isMobile && "max-w-sm text-app-text-muted",
          )}
        >
          {isMobile
            ? "Try a broader search or clear one of the active filters."
            : "Try a broader search or clear one of the active filters to bring records back into view."}
        </p>
      </div>
    );
  };

  return (
    <div className="ui-page flex flex-1 flex-col bg-transparent p-0">
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="grid shrink-0 grid-cols-1 gap-4 p-4 sm:grid-cols-2 sm:p-6 sm:pb-2 xl:grid-cols-4">
          {orderStatCards.map((stat) => (
            <div
              key={stat.label}
              className={`ui-card flex min-w-0 items-center gap-4 p-4 ${stat.tint}`}
            >
              <div
                className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border ${stat.border} ${stat.bg} shadow-sm`}
              >
                <stat.icon size={24} className={stat.color} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
                  {stat.label}
                </p>
                <p className="text-2xl font-black tabular-nums text-app-text">
                  {stat.value}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 sm:px-6">
          <div className="ui-card ui-tint-warning px-4 py-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                  Fulfillment Follow-Up
                </p>
                <p className="mt-1 text-sm font-semibold text-app-text">
                  Special, Custom, and Wedding order work with transaction payment context. Layaways stay separate.
                </p>
              </div>
              <span className="rounded-full border border-app-border bg-app-surface-3 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {totalCount} records found
              </span>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              {orderFollowUpMetrics.map((metric) => {
                const Icon = metric.icon;
                return (
                <div key={metric.label} className="ui-metric-cell px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {metric.label}
                      </p>
                      <p className="mt-1 text-lg font-black tabular-nums text-app-text">
                        {metric.value}
                      </p>
                    </div>
                    <Icon size={18} className="text-app-text-muted opacity-50" />
                  </div>
                </div>
              );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col p-3 sm:p-6 lg:p-8 animate-workspace-snap">
          <div className="ui-card flex flex-col overflow-hidden">
            <div className="flex shrink-0 flex-col gap-3 border-b border-app-border bg-app-surface-2 px-4 py-4 lg:flex-row lg:flex-wrap lg:items-center lg:gap-4 lg:px-5">
              <div className="relative group min-w-0 flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by customer, phone, transaction number, or order number..."
                  className="ui-input w-full pl-10 text-sm font-bold shadow-sm focus:border-app-accent"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    { id: "open", label: "Open Orders" },
                    { id: "all", label: "Transaction History" },
                  ] satisfies Array<{ id: OrderViewPreset; label: string }>
                ).map((preset) => {
                  const active = viewPreset === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setViewPreset(preset.id)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all",
                        active
                          ? "border-app-accent/20 bg-app-accent/10 text-app-accent"
                          : "border-app-border bg-app-surface-3 text-app-text-muted hover:bg-app-surface hover:text-app-text",
                      )}
                      aria-pressed={active}
                    >
                      {preset.label}
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={printOrdersList}
                  disabled={transactionRows.length === 0 || transactionsLoading || hasUnresolvedOrderItems}
                  className="flex items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:bg-app-surface hover:text-app-text disabled:cursor-not-allowed disabled:opacity-50"
                  title={hasUnresolvedOrderItems ? "Order item names are still loading" : "Print current orders list"}
                >
                  <Printer size={16} />
                  {hasUnresolvedOrderItems ? "Loading Items" : "Print"}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setSearch("");
                    setViewPreset(defaultViewPreset);
                    setKindFilter("all");
                    setPaymentFilter("all");
                    setSalespersonFilter("all");
                    setDatePreset("all");
                    setDateFrom("");
                    setDateTo("");
                  }}
                  className="flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors"
                  title="Reset filters"
                >
                  <RotateCcw size={18} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-app-border bg-app-surface-3 px-4 py-4 lg:px-5">
                <select
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Type: All</option>
                  <option value="special_order">Special</option>
                  <option value="wedding_order">Wedding</option>
                  <option value="custom">Custom</option>
                </select>
                <select
                  value={paymentFilter}
                  onChange={(e) => setPaymentFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Payment: All</option>
                  <option value="paid">Paid</option>
                  <option value="partial">Partial</option>
                  <option value="unpaid">Unpaid</option>
                </select>
                <select
                  value={salespersonFilter}
                  onChange={(e) => setSalespersonFilter(e.target.value)}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Staff: All</option>
                  {salespersonOptions.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
                <select
                  value={datePreset}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDatePreset(val);
                    if (val === "today") {
                      const d = new Date().toISOString().split("T")[0];
                      setDateFrom(d);
                      setDateTo(d);
                    } else if (val === "30d") {
                      const d = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
                      setDateFrom(d);
                      setDateTo(new Date().toISOString().split("T")[0]);
                    } else if (val === "all") {
                      setDateFrom("");
                      setDateTo("");
                    }
                  }}
                  className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                >
                  <option value="all">Date: Always</option>
                  <option value="today">Today</option>
                  <option value="30d">30 Days</option>
                  <option value="custom">Custom</option>
                </select>
                {datePreset === "custom" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="date"
                      value={dateFrom}
                      onChange={(event) => setDateFrom(event.target.value)}
                      className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                      aria-label="Orders date from"
                    />
                    <input
                      type="date"
                      value={dateTo}
                      onChange={(event) => setDateTo(event.target.value)}
                      className="ui-input h-10 px-3 text-[10px] font-black uppercase tracking-widest"
                      aria-label="Orders date to"
                    />
                  </div>
                ) : null}
            </div>

            <div className="border-b border-app-border bg-app-surface px-4 py-4 lg:px-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 rounded-xl border border-app-warning/25 bg-app-warning/10 p-2 text-app-warning">
                    <Truck size={18} />
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      NTBO Vendor Queue
                    </p>
                    <p className="mt-1 text-sm font-semibold text-app-text">
                      {ntboLoading
                        ? "Refreshing items that still need vendor ordering..."
                        : `${ntboItems.length} item${ntboItems.length === 1 ? "" : "s"} still need vendor ordering.`}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      Creates exact PO-line links and moves selected items from NTBO to Ordered.
                    </p>
                    {ntboError ? (
                      <p className="mt-2 text-xs font-bold text-app-warning">{ntboError}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={ntboVendorId}
                    onChange={(event) => setNtboVendorId(event.target.value)}
                    className="ui-input h-10 min-w-[220px] px-3 text-[10px] font-black uppercase tracking-widest"
                    disabled={!canManageLifecycle || ntboPoBusy}
                  >
                    <option value="">Vendor: Select</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void createPoFromNtbo()}
                    disabled={!canManageLifecycle || !ntboVendorId || selectedNtboIds.size === 0 || ntboPoBusy}
                    className="rounded-xl border border-app-accent/30 bg-app-accent px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ntboPoBusy ? "Creating..." : `Create PO (${selectedNtboIds.size})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadNtboItems()}
                    disabled={ntboLoading}
                    className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>
              </div>
              {ntboItems.length > 0 ? (
                <div className="mt-3 grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
                  {ntboItems.slice(0, 6).map((item) => {
                    const selected = selectedNtboIds.has(item.transaction_line_id);
                    return (
                      <label
                        key={item.transaction_line_id}
                        className={cn(
                          "flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors",
                          selected
                            ? "border-app-accent/40 bg-app-accent/10"
                            : "border-app-border bg-app-surface-2 hover:border-app-border-hover",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={!canManageLifecycle}
                          onChange={(event) => {
                            setSelectedNtboIds((prev) => {
                              const next = new Set(prev);
                              if (event.target.checked) next.add(item.transaction_line_id);
                              else next.delete(item.transaction_line_id);
                              return next;
                            });
                          }}
                          className="mt-1 h-4 w-4"
                        />
                        <span className="min-w-0">
                          <span className="block text-xs font-black text-app-text">
                            {item.quantity}x {item.product_name}
                          </span>
                          <span className="mt-1 block truncate text-[11px] font-semibold text-app-text-muted">
                            {item.transaction_display_id} · {item.customer_name} · {item.sku}
                          </span>
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {item.is_rush ? (
                              <span className="rounded-full border border-app-danger/20 bg-app-danger/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-danger">
                                Rush
                              </span>
                            ) : null}
                            <span className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text-muted">
                              {item.risk_level.replace(/_/g, " ")}
                            </span>
                            {item.need_by_date ? (
                              <span className="rounded-full border border-app-border bg-app-surface px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text-muted">
                                Need {dateDisplay(item.need_by_date)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 p-3 xl:hidden">
              {transactionRows.map((r) => (
                <OrderMobileCard
                  key={r.transaction_id}
                  row={r}
                  isSelected={selectedId === r.transaction_id}
                  onClick={() => setSelectedId(selectedId === r.transaction_id ? null : r.transaction_id)}
                  actions={{
                    onOpenInRegister,
                    onAttachToWedding: () => setAttachWeddingModalOpen(true),
                    onCancel: () => setCancelConfirmOpen(true),
                    onReturnAll: () => setReturnConfirmOpen(true),
                    deleteLine: (it: OrderItem) => void deleteLine(it),
                    addBySku,
                    updateLine,
                    setSku,
                    sku,
                    canModify,
                    canAttemptCancel,
                  }}
                  hydratedSummaries={hydratedOrderLines}
                />
              ))}
              {renderTransactionListState("mobile")}
            </div>

            <div className="hidden flex-1 custom-scrollbar overflow-x-auto xl:block">
              <table className="w-full min-w-[960px] border-collapse text-left">
              <thead className="sticky top-0 z-20 border-b border-app-border bg-app-surface-3">
                <tr>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">ID / Date</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Customer</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Order Items / Lifecycle</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Salesperson / Cashier</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Status</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Transaction Amounts</th>
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/40">
                {transactionRows.map((r) => (
                  <OrderTableRow 
                    key={r.transaction_id} 
                    row={r} 
                    isSelected={selectedId === r.transaction_id}
                    onClick={() => setSelectedId(selectedId === r.transaction_id ? null : r.transaction_id)}
                    actions={{
                      onOpenInRegister,
                      onAttachToWedding: () => setAttachWeddingModalOpen(true),
                      onCancel: () => setCancelConfirmOpen(true),
                      onReturnAll: () => setReturnConfirmOpen(true),
                      deleteLine: (it: OrderItem) => void deleteLine(it),
                      addBySku,
                      updateLine,
                      setSku,
                      sku,
                      canModify,
                      canAttemptCancel,
                    }}
                    hydratedSummaries={hydratedOrderLines}
                  />
                ))}
              </tbody>
            </table>

              {renderTransactionListState("desktop")}
            </div>
          </div>
        </div>
      </div>

      <ConfirmationModal
        isOpen={cancelConfirmOpen}
        onClose={() => setCancelConfirmOpen(false)}
        onConfirm={() => void runCancelOrder()}
        title={orderUnpaid && !canCancel ? "Void this transaction?" : "Cancel this transaction?"}
        message={
          orderUnpaid
            ? "No payments are allocated to this transaction. Loyalty accrual will be reversed when applicable."
            : "This will prepare any refundable payments for review. Loyalty accrual will be reversed when applicable."
        }
        confirmLabel={orderUnpaid && !canCancel ? "Void transaction" : "Cancel transaction"}
        variant="danger"
      />

      <ConfirmationModal
        isOpen={returnConfirmOpen}
        onClose={() => setReturnConfirmOpen(false)}
        onConfirm={() => void _applyReturns()}
        title="Return all items?"
        message="This will mark all eligible items as returned and calculate the refund due. This action cannot be undone."
        confirmLabel="Process returns"
        variant="danger"
      />

      {detail && (
        <AttachOrderToWeddingModal
          isOpen={attachWeddingModalOpen}
          onClose={() => setAttachWeddingModalOpen(false)}
          onSuccess={async () => {
            if (selectedId) await loadDetail(selectedId);
            await loadTransactions();
            await loadPipelineStats();
          }}
          orderId={detail.transaction_id}
          customerName={transactionRows.find(r => r.transaction_id === selectedId)?.customer_name ?? "Customer"}
        />
      )}

      <PosRefundModal
        isOpen={refundModalOpen}
        onClose={() => setRefundModalOpen(false)}
        onSubmit={() => void submitProcessRefund()}
        busy={refundBusy}
        amount={refundAmountStr}
        setAmount={setRefundAmountStr}
        method={refundMethod}
        setMethod={setRefundMethod}
        giftCode={refundGiftCode}
        setGiftCode={setRefundGiftCode}
      />

      <TransactionDetailDrawer
        orderId={selectedId}
        isOpen={selectedId !== null}
        onClose={() => setSelectedId(null)}
        detail={detail}
        audit={audit}
        loading={detailLoading}
        errorMessage={detailError}
        onLifecycleChanged={async () => {
          if (selectedId) await loadDetail(selectedId);
          await loadTransactions();
          await loadNtboItems();
        }}
        orderActions={{
          onOpenInRegister,
          onAttachToWedding: () => setAttachWeddingModalOpen(true),
          onCancel: () => setCancelConfirmOpen(true),
          onReturnAll: () => setReturnConfirmOpen(true),
          onProcessRefund: () => setRefundModalOpen(true),
          deleteLine: (it) => void deleteLine(it),
          addBySku,
          updateLine,
          setSku,
          sku,
          canModify,
          canAttemptCancel,
          canRefund,
        }}
      />

      <RegisterRequiredModal
        open={registerRequiredOpen}
        onClose={() => setRegisterRequiredOpen(false)}
        onGoToRegister={goToOpenRegister}
      />
    </div>
  );
}
