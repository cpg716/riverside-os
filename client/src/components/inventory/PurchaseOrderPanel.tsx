import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import ReceivingBay from "./ReceivingBay";
import ReceivingReport from "./ReceivingReport";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";
import { AlertTriangle, Clock, FileText, Truck, Plus, Printer, Mail } from "lucide-react";

interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  status: string;
  vendor_name: string;
  po_kind?: string;
  expected_at?: string | null;
}

interface WeddingNonInventoryItem {
  id: string;
  wedding_party_id: string;
  wedding_member_id?: string;
  description: string;
  quantity: number;
  status: string;
  notes?: string;
  created_at: string;
}

interface Vendor {
  id: string;
  name: string;
  email?: string | null;
}

interface NtboLifecycleItem {
  transaction_line_id: string;
  transaction_display_id: string;
  customer_name: string;
  product_name: string;
  sku: string;
  variation_label?: string | null;
  quantity: number;
  is_rush: boolean;
  need_by_date?: string | null;
  risk_level: string;
}

interface PurchaseOrderLineDetail {
  line_id: string;
  sku: string;
  product_name: string;
  variation_label?: string | null;
  qty_ordered: number;
  qty_previously_received: number;
  unit_cost: string;
}

interface PurchaseOrderDetail {
  id: string;
  po_number: string;
  status: string;
  vendor_id: string;
  vendor_name: string;
  po_kind: string;
  lines: PurchaseOrderLineDetail[];
}

type PurchaseOrderPanelMode = "order" | "receive";

const baseUrl = getBaseUrl();
let cachedPurchaseOrders: PurchaseOrder[] = [];
let cachedPurchaseOrdersLoaded = false;

function dateDisplay(value?: string | null): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function purchaseOrderTypeLabel(kind?: string): string {
  return kind === "direct_invoice" ? "Direct invoice" : "Purchase order";
}

function purchaseOrderStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "submitted":
      return "Sent to vendor";
    case "partially_received":
      return "Partially received";
    case "closed":
      return "Closed";
    case "cancelled":
      return "Cancelled";
    default:
      return status.replace(/_/g, " ");
  }
}

function poEmailText(detail: PurchaseOrderDetail): string {
  const lines = detail.lines.map((line) => (
    `${line.qty_ordered} x ${line.product_name}${line.variation_label ? ` - ${line.variation_label}` : ""} (${line.sku}) @ $${line.unit_cost}`
  ));
  return [
    `Purchase Order: ${detail.po_number}`,
    `Vendor: ${detail.vendor_name}`,
    `Status: ${purchaseOrderStatusLabel(detail.status)}`,
    "",
    ...lines,
  ].join("\n");
}

export default function PurchaseOrderPanel({
  initialPoId,
  onInitialPoConsumed,
  mode = "order",
  onOpenOrderStock,
  onOpenReceiving,
}: {
  initialPoId?: string | null;
  onInitialPoConsumed?: () => void;
  mode?: PurchaseOrderPanelMode;
  onOpenOrderStock?: () => void;
  onOpenReceiving?: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const consumedInitialPo = useRef(false);
  const ordersLoadedOnce = useRef(false);
  const lastLoadedOrders = useRef<PurchaseOrder[]>([]);
  const canManageLifecycle = hasPermission("orders.lifecycle_manage");

  useEffect(() => {
    consumedInitialPo.current = false;
  }, [initialPoId]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [selectedPo, setSelectedPo] = useState<string>("");
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
  const [ordersShowingStale, setOrdersShowingStale] = useState(false);
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitCost, setUnitCost] = useState("0.00");
  const [receivingPoId, setReceivingPoId] = useState<string | null>(null);
  const [nonInventoryNeeds, setNonInventoryNeeds] = useState<WeddingNonInventoryItem[]>([]);
  const [ntboItems, setNtboItems] = useState<NtboLifecycleItem[]>([]);
  const [, setNtboLoading] = useState(false);
  const [ntboError, setNtboError] = useState<string | null>(null);
  const [selectedNtboIds, setSelectedNtboIds] = useState<Set<string>>(() => new Set());
  const [ntboVendorId, setNtboVendorId] = useState("");
  const [ntboPoBusy, setNtboPoBusy] = useState(false);
  const [viewingReceivingEventId, setViewingReceivingEventId] = useState<string | null>(null);

  interface ReceivingHistoryRow {
    id: string;
    po_number: string;
    vendor_name: string;
    invoice_number?: string | null;
    freight_total: number;
    received_at?: string | null;
    received_by_name?: string | null;
    total_units_received: number;
    total_line_cost: number;
  }
  const [receivingHistory, setReceivingHistory] = useState<ReceivingHistoryRow[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  const loadReceivingHistory = useCallback(
    async (poId: string) => {
      try {
        const res = await fetch(
          `${baseUrl}/api/purchase-orders/${poId}/receiving-history`,
          { headers: backofficeHeaders() as Record<string, string> },
        );
        if (!res.ok) return;
        const data = (await res.json()) as ReceivingHistoryRow[];
        setReceivingHistory(data);
        setShowHistory(true);
      } catch {
        toast("Could not load receiving history.", "error");
      }
    },
    [backofficeHeaders, toast],
  );

  const refresh = useCallback(async () => {
    setOrdersLoading(true);
    setOrdersLoadError(null);
    setOrdersShowingStale(false);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/purchase-orders"), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        throw new Error("purchase_orders_load_failed");
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : [];
      ordersLoadedOnce.current = true;
      lastLoadedOrders.current = list;
      cachedPurchaseOrders = list;
      cachedPurchaseOrdersLoaded = true;
      setOrders(list);
      if (!selectedPo && list.length > 0) setSelectedPo(list[0].id);
    } catch {
      const hasStaleRows =
        (ordersLoadedOnce.current && lastLoadedOrders.current.length > 0) ||
        (cachedPurchaseOrdersLoaded && cachedPurchaseOrders.length > 0);
      if (hasStaleRows) {
        const staleRows =
          lastLoadedOrders.current.length > 0
            ? lastLoadedOrders.current
            : cachedPurchaseOrders;
        lastLoadedOrders.current = staleRows;
        ordersLoadedOnce.current = true;
        setOrders(staleRows);
        if (!selectedPo && staleRows.length > 0) setSelectedPo(staleRows[0].id);
      }
      setOrdersShowingStale(hasStaleRows);
      setOrdersLoadError(
        hasStaleRows
          ? "Could not refresh the latest paperwork. Showing the last successfully loaded results."
          : "Vendor paperwork could not load right now. Try again in a moment.",
      );
    } finally {
      setOrdersLoading(false);
    }
  }, [backofficeHeaders, selectedPo]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadNtboItems = useCallback(async () => {
    setNtboLoading(true);
    setNtboError(null);
    try {
      const res = await fetch(`${baseUrl}/api/order-lifecycle/items?status=ntbo&unlinked_only=true`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("ntbo_load_failed");
      const rows = (await res.json()) as NtboLifecycleItem[];
      const nextItems = Array.isArray(rows) ? rows : [];
      setNtboItems(nextItems);
      setSelectedNtboIds((prev) => {
        const visible = new Set(nextItems.map((item) => item.transaction_line_id));
        return new Set([...prev].filter((id) => visible.has(id)));
      });
    } catch {
      setNtboError("NTBO queue could not refresh. Vendor paperwork is still available below.");
    } finally {
      setNtboLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    if (mode !== "order") return;
    void loadNtboItems();
  }, [loadNtboItems, mode]);

  useEffect(() => {
    const id = initialPoId?.trim();
    if (id && orders.some((o) => o.id === id) && !consumedInitialPo.current) {
      setSelectedPo(id);
      consumedInitialPo.current = true;
      onInitialPoConsumed?.();
    }
  }, [initialPoId, orders, onInitialPoConsumed]);

  useEffect(() => {
    fetch(apiUrl(baseUrl, "/api/vendors"), {
      headers: backofficeHeaders() as Record<string, string>,
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setVendors(list);
        if (list.length > 0) setVendorId(list[0].id);
      })
      .catch(() => setVendors([]));

    // Fetch Non-Inventory Needs
    fetch(apiUrl(baseUrl, "/api/weddings/non-inventory"), {
      headers: backofficeHeaders() as Record<string, string>,
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setNonInventoryNeeds(list.filter(item => item.status === 'needed'));
      })
      .catch(() => setNonInventoryNeeds([]));
  }, [refresh, backofficeHeaders]);

  const createDraft = async () => {
    if (!vendorId) return;
    const res = await fetch(apiUrl(baseUrl, "/api/purchase-orders"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({ vendor_id: vendorId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Failed to create PO draft", "error");
      return;
    }
    const created = (await res.json().catch(() => ({}))) as { id?: string };
    if (typeof created.id === "string" && created.id.trim().length > 0) {
      setSelectedPo(created.id);
    }
    void refresh();
  };

  const createDirectInvoice = async () => {
    if (!vendorId) return;
    const res = await fetch(`${baseUrl}/api/purchase-orders/direct-invoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({ vendor_id: vendorId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Failed to create direct invoice draft", "error");
      return;
    }
    const created = (await res.json().catch(() => ({}))) as { id?: string };
    if (typeof created.id === "string" && created.id.trim().length > 0) {
      setSelectedPo(created.id);
    }
    void refresh();
  };

  const addLine = async () => {
    if (!selectedPo || !variantId.trim()) return;
    if (qty <= 0) {
      toast("Quantity must be greater than zero", "error");
      return;
    }
    if (parseMoneyToCents(unitCost) < 0) {
      toast("Unit cost must be non-negative", "error");
      return;
    }
    const res = await fetch(`${baseUrl}/api/purchase-orders/${selectedPo}/lines`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({
        variant_id: variantId.trim(),
        quantity_ordered: qty,
        unit_cost: centsToFixed2(parseMoneyToCents(unitCost)),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Failed to add PO line", "error");
      return;
    }
    toast("PO line added", "success");
    void refresh();
  };

  const submitPo = async () => {
    if (!selectedPo) return;
    const res = await fetch(`${baseUrl}/api/purchase-orders/${selectedPo}/submit`, {
      method: "POST",
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Could not mark purchase order sent.", "error");
      return;
    }
    toast("Purchase order marked sent. Linked NTBO items are now ordered.", "success");
    void refresh();
  };

  const selected = orders.find((o) => o.id === selectedPo);
  const isReceiveMode = mode === "receive";
  useEffect(() => {
    if (isReceiveMode) return;
    if (selected?.status === "draft" && selected.po_kind !== "direct_invoice") {
      setNtboVendorId(selected.vendor_id);
    }
  }, [isReceiveMode, selected?.id, selected?.po_kind, selected?.status, selected?.vendor_id]);

  const selectedDraftForNtbo =
    selected &&
    selected.status === "draft" &&
    selected.po_kind !== "direct_invoice" &&
    selected.vendor_id === ntboVendorId
      ? selected
      : null;

  const createPoFromNtbo = useCallback(async () => {
    if (!ntboVendorId || selectedNtboIds.size === 0) return;
    setNtboPoBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/order-lifecycle/ntbo/create-po`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          purchase_order_id: selectedDraftForNtbo?.id,
          vendor_id: ntboVendorId,
          transaction_line_ids: [...selectedNtboIds],
          notes: selectedDraftForNtbo
            ? "Added from Inventory Order Stock NTBO queue"
            : "Created from Inventory Order Stock NTBO queue",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Could not create purchase order from NTBO items.", "error");
        return;
      }
      const body = (await res.json()) as { purchase_order_id?: string; po_number?: string; linked_line_count?: number };
      toast(
        `${body.po_number ?? "Purchase order"} ${selectedDraftForNtbo ? "updated" : "started"} with ${body.linked_line_count ?? selectedNtboIds.size} NTBO item(s). Mark Sent when it has been sent to the vendor.`,
        "success",
      );
      setSelectedNtboIds(new Set());
      await loadNtboItems();
      await refresh();
      if (body.purchase_order_id) setSelectedPo(body.purchase_order_id);
    } finally {
      setNtboPoBusy(false);
    }
  }, [backofficeHeaders, loadNtboItems, ntboVendorId, refresh, selectedDraftForNtbo, selectedNtboIds, toast]);

  const canSubmitSelected =
    !!selected &&
    selected.status === "draft" &&
    selected.po_kind !== "direct_invoice";
  const canOpenReceiving =
    !!selected &&
    selected.status !== "cancelled" &&
    selected.status !== "closed" &&
    (selected.po_kind === "direct_invoice"
      ? true
      : selected.status !== "draft");
  const canReceiveOrder = (order: PurchaseOrder) =>
    order.status !== "cancelled" &&
    order.status !== "closed" &&
    (order.po_kind === "direct_invoice" ? true : order.status !== "draft");
  const selectedVendor = selected ? vendors.find((vendor) => vendor.id === selected.vendor_id) : null;

  const loadPurchaseOrderDetail = useCallback(async (poId: string): Promise<PurchaseOrderDetail | null> => {
    const res = await fetch(`${baseUrl}/api/purchase-orders/${poId}`, {
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (!res.ok) {
      toast("Could not load purchase order details.", "error");
      return null;
    }
    return (await res.json()) as PurchaseOrderDetail;
  }, [backofficeHeaders, toast]);

  const printSelectedPo = useCallback(async () => {
    if (!selectedPo) return;
    const detail = await loadPurchaseOrderDetail(selectedPo);
    if (!detail) return;
    const printWindow = window.open("", "_blank", "width=900,height=700");
    if (!printWindow) {
      toast("Could not open print window.", "error");
      return;
    }
    const rows = detail.lines.map((line) => `
      <tr>
        <td>${line.qty_ordered}</td>
        <td>${escapeHtml(line.sku)}</td>
        <td>${escapeHtml(`${line.product_name}${line.variation_label ? ` - ${line.variation_label}` : ""}`)}</td>
        <td>$${line.unit_cost}</td>
      </tr>
    `).join("");
    printWindow.document.write(`
      <html>
        <head>
          <title>${detail.po_number}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #111827; }
            h1 { margin: 0 0 4px; font-size: 24px; }
            p { margin: 0 0 18px; color: #4b5563; }
            table { width: 100%; border-collapse: collapse; margin-top: 24px; }
            th, td { border-bottom: 1px solid #e5e7eb; padding: 10px; text-align: left; font-size: 13px; }
            th { text-transform: uppercase; letter-spacing: .12em; font-size: 10px; color: #6b7280; }
          </style>
        </head>
        <body>
          <h1>${escapeHtml(detail.po_number)}</h1>
          <p>${escapeHtml(detail.vendor_name)} - ${escapeHtml(purchaseOrderStatusLabel(detail.status))}</p>
          <table>
            <thead><tr><th>Qty</th><th>SKU</th><th>Item</th><th>Unit Cost</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </body>
      </html>
    `);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }, [loadPurchaseOrderDetail, selectedPo, toast]);

  const emailSelectedPo = useCallback(async () => {
    if (!selectedPo) return;
    if (!selectedVendor?.email) {
      toast("Add an email to this vendor before emailing a purchase order.", "error");
      return;
    }
    const detail = await loadPurchaseOrderDetail(selectedPo);
    if (!detail) return;
    const subject = encodeURIComponent(`Purchase Order ${detail.po_number}`);
    const body = encodeURIComponent(poEmailText(detail));
    window.location.href = `mailto:${selectedVendor.email}?subject=${subject}&body=${body}`;
  }, [loadPurchaseOrderDetail, selectedPo, selectedVendor, toast]);

  /* ── Helpers for the NTBO collapsible ── */
  const [ntboExpanded, setNtboExpanded] = useState(true);

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {receivingPoId && (
        <ReceivingBay
          poId={receivingPoId}
          onClose={() => setReceivingPoId(null)}
          onComplete={() => {
            setReceivingPoId(null);
            void refresh();
          }}
        />
      )}

      {/* ── Vendor Selector Bar ── */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
        <div className="flex items-center gap-2 mr-auto">
          <Truck size={18} className="text-app-accent shrink-0" />
          <div>
            <p className="text-sm font-bold text-app-text">
              {isReceiveMode ? "Receive Stock" : "Order Stock"}
            </p>
            <p className="text-[10px] text-app-text-muted">
              {isReceiveMode ? "Post arrived vendor shipments into inventory." : "Build purchase orders and send to vendors."}
            </p>
          </div>
        </div>
        <select
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className="h-10 min-w-[200px] rounded-xl bg-app-surface-2 border border-app-border px-4 text-xs font-bold focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>{v.name}</option>
          ))}
        </select>
        {isReceiveMode ? (
          <>
            <button
              type="button"
              disabled={!vendorId}
              onClick={() => void createDirectInvoice()}
              className="flex h-10 items-center gap-2 rounded-xl bg-app-accent px-5 text-xs font-bold text-white shadow-md shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-30"
            >
              <FileText size={14} /> Direct Invoice
            </button>
            {onOpenOrderStock && (
              <button
                type="button"
                onClick={onOpenOrderStock}
                className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-5 text-xs font-bold text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
              >
                <Plus size={14} /> Build Standard PO
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={!vendorId}
              onClick={createDraft}
              className="flex h-10 items-center gap-2 rounded-xl bg-app-accent px-5 text-xs font-bold text-white shadow-md shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-30"
            >
              <Plus size={14} /> New PO
            </button>
            {onOpenReceiving && (
              <button
                type="button"
                onClick={onOpenReceiving}
                className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-5 text-xs font-bold text-app-text transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
              >
                <Truck size={14} /> Receive Stock
              </button>
            )}
          </>
        )}
      </div>

      {isReceiveMode && (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
              1 · Pick document
            </p>
            <p className="mt-2 text-sm font-bold text-app-text">
              Use a submitted PO, partially received PO, or direct invoice.
            </p>
            <p className="mt-1 text-[11px] font-semibold leading-relaxed text-app-text-muted">
              Draft standard POs must be sent from Order Stock before receiving.
            </p>
          </div>
          <div className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
              2 · Stage counts
            </p>
            <p className="mt-2 text-sm font-bold text-app-text">
              Scan or enter quantities, invoice number, and freight.
            </p>
            <p className="mt-1 text-[11px] font-semibold leading-relaxed text-app-text-muted">
              Staging does not change live stock until Post Receipt.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-300/50 bg-amber-50 p-4 shadow-sm">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-700">
              AI import prep
            </p>
            <p className="mt-2 text-sm font-bold text-amber-950">
              Vendor-paperwork AI will create reviewed drafts only.
            </p>
            <p className="mt-1 text-[11px] font-semibold leading-relaxed text-amber-800">
              Today, use Direct Invoice for received paperwork without a PO.
            </p>
          </div>
        </div>
      )}

      {/* ── NTBO Queue (order mode only, collapsible) ── */}
      {!isReceiveMode && ntboItems.length > 0 && (
        <div className="rounded-2xl border ui-tint-warning shadow-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setNtboExpanded(!ntboExpanded)}
            className="flex w-full items-center justify-between px-5 py-3 hover:bg-app-surface-2/40 transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-2 w-2 animate-pulse rounded-full bg-app-warning" />
              <span className="text-sm font-bold text-app-text">
                {ntboItems.length} customer order item{ntboItems.length === 1 ? "" : "s"} need vendor ordering
              </span>
            </div>
            <span className="text-xs font-bold text-app-text-muted">{ntboExpanded ? "Collapse" : "Expand"}</span>
          </button>

          {ntboExpanded && (
            <div className="border-t border-app-border/40 px-5 py-4 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={ntboVendorId}
                  onChange={(e) => setNtboVendorId(e.target.value)}
                  className="ui-input h-10 min-w-[200px] text-xs font-bold"
                  disabled={!canManageLifecycle || ntboPoBusy}
                >
                  <option value="">Select vendor for PO...</option>
                  {vendors.map((v) => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void createPoFromNtbo()}
                  disabled={!canManageLifecycle || !ntboVendorId || selectedNtboIds.size === 0 || ntboPoBusy}
                  className="h-10 rounded-xl bg-app-accent px-4 text-xs font-bold text-white disabled:opacity-40 transition-all active:scale-95 shadow-md shadow-app-accent/20"
                >
                  {ntboPoBusy ? "Working..." : `${selectedDraftForNtbo ? "Add to " + selectedDraftForNtbo.po_number : "Start PO"} (${selectedNtboIds.size})`}
                </button>
                {selectedDraftForNtbo && (
                  <span className="text-[10px] font-bold text-app-accent">→ Adding to {selectedDraftForNtbo.po_number}</span>
                )}
                {ntboError && <span className="text-xs font-bold text-app-danger">{ntboError}</span>}
              </div>

              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {ntboItems.map((item) => {
                  const isChecked = selectedNtboIds.has(item.transaction_line_id);
                  return (
                    <label
                      key={item.transaction_line_id}
                      className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                        isChecked
                          ? "border-app-warning bg-app-warning/10 shadow-sm"
                          : "border-app-border bg-app-surface hover:border-app-warning/60"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canManageLifecycle}
                        onChange={(e) => {
                          setSelectedNtboIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(item.transaction_line_id);
                            else next.delete(item.transaction_line_id);
                            return next;
                          });
                        }}
                        className="mt-0.5 h-4 w-4 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent"
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-bold text-app-text truncate">{item.quantity}× {item.product_name}</p>
                        <p className="text-[10px] text-app-text-muted truncate">{item.customer_name} · {item.sku}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {item.is_rush && (
                            <span className="rounded-full bg-app-danger/10 border border-app-danger/20 px-2 py-px text-[8px] font-bold uppercase text-app-danger">Rush</span>
                          )}
                          {item.need_by_date && (
                            <span className="rounded-full bg-app-warning/10 border border-app-warning/20 px-2 py-px text-[8px] font-bold text-app-warning">Need {dateDisplay(item.need_by_date)}</span>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Purchase Order List ── */}
      <div className="rounded-2xl border border-app-border bg-app-surface shadow-sm overflow-hidden">
        {ordersLoadError && (
          <div className="flex flex-col gap-1 border-b border-amber-400/20 bg-amber-50 px-5 py-3">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-600 shrink-0" />
              <p className="text-xs font-bold text-amber-850">
                {ordersShowingStale ? "Vendor paperwork may not be current" : "Vendor paperwork unavailable"}
              </p>
            </div>
            <p className="text-xs text-amber-800 pl-6">{ordersLoadError}</p>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-app-surface-2/60 border-b border-app-border">
              <tr>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">{isReceiveMode ? "Document" : "PO #"}</th>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Vendor</th>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Type</th>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Status</th>
                <th className="px-5 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/30">
              {ordersLoading && orders.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center">
                    <Clock size={24} className="mx-auto mb-2 text-app-text-muted/40" />
                    <p className="text-xs font-bold text-app-text-muted">Loading vendor paperwork...</p>
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center">
                    <p className="text-xs font-bold text-app-text-muted">
                      {isReceiveMode ? "No documents ready to receive." : "No purchase orders yet."} Select a vendor above to create one.
                    </p>
                  </td>
                </tr>
              ) : orders.map((o) => (
                <tr
                  key={o.id}
                  className={`group cursor-pointer transition-colors ${
                    selectedPo === o.id ? "bg-app-accent/8" : "hover:bg-app-surface-2/40"
                  }`}
                  onClick={() => setSelectedPo(o.id)}
                >
                  <td className="px-5 py-3 font-mono font-bold text-app-accent">{o.po_number}</td>
                  <td className="px-5 py-3 font-bold text-app-text">{o.vendor_name}</td>
                  <td className="px-5 py-3">
                    <span className="text-[10px] font-bold text-app-text-muted">{purchaseOrderTypeLabel(o.po_kind)}</span>
                  </td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[9px] font-bold uppercase ${
                      o.status === "draft" ? "bg-app-surface-2 text-app-text-muted border border-app-border" :
                      o.status === "submitted" ? "bg-app-accent/10 text-app-accent border border-app-accent/20" :
                      o.status === "partially_received" ? "bg-amber-100 text-amber-700 border border-amber-200" :
                      o.status === "closed" ? "bg-emerald-100 text-emerald-700 border border-emerald-200" :
                      "bg-red-100 text-red-600 border border-red-200"
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        o.status === "draft" ? "bg-app-text-muted" :
                        o.status === "submitted" ? "bg-app-accent" :
                        o.status === "partially_received" ? "bg-amber-500" :
                        o.status === "closed" ? "bg-emerald-500" :
                        "bg-red-500"
                      }`} />
                      {purchaseOrderStatusLabel(o.status)}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      {o.status === "draft" && o.po_kind !== "direct_invoice" && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedPo(o.id); void submitPo(); }}
                          className="h-7 rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-bold text-app-text hover:border-app-accent hover:text-app-accent transition-all"
                        >
                          Mark Sent
                        </button>
                      )}
                      {canReceiveOrder(o) && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedPo(o.id); setReceivingPoId(o.id); }}
                          className="h-7 rounded-lg bg-emerald-600 px-3 text-[9px] font-bold text-white shadow-sm hover:brightness-110 transition-all"
                        >
                          Receive
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add Lines to Selected PO ── */}
      {selected && (
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-app-text">
                {selected.po_number} <span className="text-app-text-muted">· {selected.vendor_name}</span>
              </p>
              <p className="text-[10px] text-app-text-muted mt-0.5">
                {purchaseOrderTypeLabel(selected.po_kind)} · {purchaseOrderStatusLabel(selected.status)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!selectedPo}
                onClick={() => void printSelectedPo()}
                className="h-9 rounded-lg border border-app-border bg-app-surface-2 px-3 text-[10px] font-bold text-app-text-muted hover:text-app-text transition-all"
              >
                <Printer size={13} className="inline mr-1" /> Print
              </button>
              <button
                type="button"
                disabled={!selectedPo || !selectedVendor?.email}
                onClick={() => void emailSelectedPo()}
                className="h-9 rounded-lg border border-app-border bg-app-surface-2 px-3 text-[10px] font-bold text-app-text-muted hover:text-app-text transition-all"
                title={selectedVendor?.email ? "Email PO to vendor" : "Add vendor email first"}
              >
                <Mail size={13} className="inline mr-1" /> Email
              </button>
              {selected && ["partially_received", "closed"].includes(selected.status) && (
                <button
                  type="button"
                  onClick={() => void loadReceivingHistory(selected.id)}
                  className="h-9 rounded-lg border border-app-border bg-app-surface-2 px-3 text-[10px] font-bold text-app-text-muted hover:text-app-text transition-all"
                >
                  <FileText size={13} className="inline mr-1" /> History
                </button>
              )}
              {canSubmitSelected && (
                <button
                  type="button"
                  onClick={() => void submitPo()}
                  className="h-9 rounded-lg border border-app-accent/30 bg-app-accent/10 px-4 text-[10px] font-bold text-app-accent hover:bg-app-accent/20 transition-all"
                >
                  Mark Sent
                </button>
              )}
              {canOpenReceiving && (
                <button
                  type="button"
                  aria-label={`Receive stock for ${selected.po_number}`}
                  onClick={() => setReceivingPoId(selectedPo)}
                  className="h-9 rounded-lg bg-emerald-600 px-4 text-[10px] font-bold text-white shadow-sm hover:brightness-110 transition-all"
                >
                  Receive Stock
                </button>
              )}
            </div>
          </div>

          {/* Add line form */}
          <div className="flex flex-wrap items-end gap-3 rounded-xl border border-app-border/40 bg-app-surface-2 p-4">
            <div className="min-w-[260px] flex-1 space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Search Item</label>
              <VariantSearchInput
                onSelect={(v: VariantSearchResult) => {
                  setVariantId(v.variant_id);
                  if (v.cost_price) setUnitCost(String(typeof v.cost_price === "number" ? (v.cost_price / 100).toFixed(2) : v.cost_price));
                }}
                placeholder="SKU or product name..."
              />
            </div>
            <div className="w-[140px] space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Unit Cost</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/40">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                  className="w-full h-11 bg-app-surface border border-app-border rounded-xl pl-7 pr-3 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
                />
              </div>
            </div>
            <div className="w-[80px] space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Qty</label>
              <input
                type="number"
                min="1"
                value={qty}
                onChange={(e) => setQty(Number.parseInt(e.target.value || "1", 10))}
                className="w-full h-11 bg-app-surface border border-app-border rounded-xl px-3 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
              />
            </div>
            <button
              type="button"
              disabled={!selectedPo || !variantId}
              onClick={addLine}
              className="h-11 rounded-xl bg-app-accent px-6 text-xs font-bold text-white shadow-md shadow-app-accent/20 hover:brightness-110 disabled:opacity-20 active:scale-95 transition-all"
            >
              Add Line
            </button>
          </div>
        </div>
      )}

      {/* ── Non-Inventory Wedding Items ── */}
      {nonInventoryNeeds.length > 0 && (
        <div className="rounded-2xl border border-amber-300/40 bg-amber-50/60 p-4 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <span className="flex h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            <h3 className="text-xs font-bold text-amber-900">
              Non-Inventory Items Needed ({nonInventoryNeeds.length})
            </h3>
          </div>
          <div className="rounded-xl border border-amber-200 bg-app-surface overflow-hidden">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-amber-50 border-b border-amber-200">
                <tr>
                  <th className="px-3 py-2 font-bold text-amber-900">Description</th>
                  <th className="px-3 py-2 font-bold text-amber-900 text-center">Qty</th>
                  <th className="px-3 py-2 font-bold text-amber-900">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {nonInventoryNeeds.map((item) => (
                  <tr key={item.id} className="hover:bg-amber-50/30 transition-colors">
                    <td className="px-3 py-2 font-bold text-app-text">{item.description}</td>
                    <td className="px-3 py-2 text-center font-mono text-emerald-700">{item.quantity}</td>
                    <td className="px-3 py-2 text-app-text-muted">{item.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Receiving History ── */}
      {showHistory && receivingHistory.length > 0 && (
        <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-app-text flex items-center gap-2">
              <FileText size={14} className="text-app-text-muted" />
              Receiving History ({receivingHistory.length})
            </h3>
            <button
              type="button"
              onClick={() => { setShowHistory(false); setReceivingHistory([]); }}
              className="text-[9px] font-bold text-app-text-muted hover:text-app-text transition-colors"
            >
              Close
            </button>
          </div>
          <div className="rounded-xl border border-app-border overflow-hidden">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-app-surface-2/60 border-b border-app-border">
                <tr>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">Date</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">Invoice #</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-center">Units</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-right">Merchandise</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted text-right">Freight</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted">Received By</th>
                  <th className="px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted" />
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/40">
                {receivingHistory.map((ev) => (
                  <tr key={ev.id} className="hover:bg-app-surface-2/30 transition-colors">
                    <td className="px-3 py-2 text-app-text font-bold">
                      {ev.received_at
                        ? new Date(ev.received_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
                        : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-app-text">
                      {ev.invoice_number || "—"}
                    </td>
                    <td className="px-3 py-2 text-center font-mono font-bold text-app-text">
                      {ev.total_units_received}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-app-text">
                      ${Number(ev.total_line_cost).toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700">
                      {Number(ev.freight_total) > 0 ? `$${Number(ev.freight_total).toFixed(2)}` : "—"}
                    </td>
                    <td className="px-3 py-2 text-app-text-muted">
                      {ev.received_by_name || "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setViewingReceivingEventId(ev.id)}
                        className="h-7 rounded-lg border border-app-border bg-app-surface px-3 text-[9px] font-bold text-app-text-muted hover:text-app-text hover:border-app-accent transition-all"
                      >
                        View Report
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {viewingReceivingEventId && (
        <ReceivingReport
          receivingEventId={viewingReceivingEventId}
          onClose={() => setViewingReceivingEventId(null)}
        />
      )}
    </div>
  );
}
