import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import ReceivingBay from "./ReceivingBay";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";
import { AlertTriangle, Clock, Truck, ListFilter, Sparkles, Plus, Printer, Mail } from "lucide-react";
import DashboardGridCard from "../ui/DashboardGridCard";

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
}: {
  initialPoId?: string | null;
  onInitialPoConsumed?: () => void;
  mode?: PurchaseOrderPanelMode;
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
  const [ntboLoading, setNtboLoading] = useState(false);
  const [ntboError, setNtboError] = useState<string | null>(null);
  const [selectedNtboIds, setSelectedNtboIds] = useState<Set<string>>(() => new Set());
  const [ntboVendorId, setNtboVendorId] = useState("");
  const [ntboPoBusy, setNtboPoBusy] = useState(false);

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
      setOrders(list);
      if (!selectedPo && list.length > 0) setSelectedPo(list[0].id);
    } catch {
      const hasStaleRows =
        ordersLoadedOnce.current && lastLoadedOrders.current.length > 0;
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

  return (
    <div className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
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
      <div className="px-2">
        <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">
          {isReceiveMode ? "Vendor Paperwork" : "Vendor Orders"}
        </h3>
        <h2 className="text-2xl font-black tracking-tight text-app-text">
          {isReceiveMode ? "Vendor Paperwork to Receive" : "Purchase Orders & Receiving"}
        </h2>
      </div>

      {!isReceiveMode && (
        <DashboardGridCard
          title="NTBO Vendor Queue"
          subtitle={`${ntboItems.length} item${ntboItems.length === 1 ? "" : "s"} still need vendor ordering`}
          icon={Truck}
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="max-w-3xl">
                <p className="text-sm font-black text-app-text">
                  Create vendor paperwork from customer order items that are not yet ordered.
                </p>
                <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
                  Selected lines are staged on draft vendor paperwork. They move from NTBO to Ordered only when the PO is marked sent.
                </p>
                {selectedDraftForNtbo ? (
                  <p className="mt-2 text-xs font-black text-app-accent">
                    Selected draft: {selectedDraftForNtbo.po_number}. NTBO items will be added to this PO.
                  </p>
                ) : null}
                {ntboError ? (
                  <p className="mt-2 text-xs font-bold text-app-warning">{ntboError}</p>
                ) : null}
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
                  className="h-10 rounded-xl border border-app-accent/30 bg-app-accent px-4 text-[10px] font-black uppercase tracking-widest text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ntboPoBusy
                    ? "Working..."
                    : `${selectedDraftForNtbo ? "Add to PO" : "Start PO"} (${selectedNtboIds.size})`}
                </button>
                <button
                  type="button"
                  onClick={() => void loadNtboItems()}
                  disabled={ntboLoading}
                  className="h-10 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text disabled:opacity-50"
                >
                  {ntboLoading ? "Refreshing" : "Refresh"}
                </button>
              </div>
            </div>

            {ntboItems.length > 0 ? (
              <div className="grid gap-2 lg:grid-cols-2 xl:grid-cols-3">
                {ntboItems.map((item) => {
                  const selectedItem = selectedNtboIds.has(item.transaction_line_id);
                  return (
                    <label
                      key={item.transaction_line_id}
                      className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                        selectedItem
                          ? "border-app-accent/40 bg-app-accent/10"
                          : "border-app-border bg-app-surface-2 hover:border-app-border-hover"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedItem}
                        disabled={!canManageLifecycle}
                        onChange={(event) => {
                          setSelectedNtboIds((prev) => {
                            const next = new Set(prev);
                            if (event.target.checked) next.add(item.transaction_line_id);
                            else next.delete(item.transaction_line_id);
                            return next;
                          });
                        }}
                        className="mt-1 h-4 w-4 accent-app-accent"
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
            ) : (
              <div className="rounded-2xl border border-dashed border-app-border bg-app-surface-2 p-6 text-center">
                <p className="text-sm font-black text-app-text">
                  {ntboLoading ? "Refreshing NTBO items..." : "No NTBO items need vendor ordering."}
                </p>
              </div>
            )}
          </div>
        </DashboardGridCard>
      )}

      <DashboardGridCard 
        title={isReceiveMode ? "Ready-to-Receive Documents" : "Active Purchase Orders"}
        subtitle={`${orders.length} vendor document${orders.length === 1 ? "" : "s"} listed`}
        icon={ListFilter}
      >
        <div className="flex items-center gap-3 mb-6">
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="h-10 min-w-[180px] rounded-xl bg-app-surface/40 border border-app-border px-4 text-xs font-bold focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
          >
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!vendorId}
            onClick={createDraft}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-app-accent text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 hover:brightness-110 active:scale-95 disabled:opacity-40 transition-all"
          >
            <Plus size={14} /> {isReceiveMode ? "New PO Setup" : "New PO"}
          </button>
          <button
            type="button"
            disabled={!vendorId}
            onClick={() => void createDirectInvoice()}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-app-accent-2/10 border border-app-accent-2/20 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-accent-2/20 disabled:opacity-40 transition-all active:scale-95"
          >
            <Sparkles size={14} /> {isReceiveMode ? "Direct Invoice - Arrived Stock" : "Direct Invoice"}
          </button>
          <button
            type="button"
            disabled={!selectedPo}
            onClick={() => void printSelectedPo()}
            className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-all hover:text-app-text disabled:opacity-40"
          >
            <Printer size={14} /> Print PO
          </button>
          <button
            type="button"
            disabled={!selectedPo || !selectedVendor?.email}
            onClick={() => void emailSelectedPo()}
            className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-all hover:text-app-text disabled:opacity-40"
            title={selectedVendor?.email ? "Email selected PO" : "Vendor email required"}
          >
            <Mail size={14} /> Email PO
          </button>
        </div>
        <div className="mb-6 rounded-2xl border border-app-border bg-app-surface/30 px-5 py-4">
          <p className="text-sm font-black text-app-text">
            {isReceiveMode
              ? "Receive from a sent PO below, or create a Direct Invoice when merchandise is already here without a pre-built order."
              : "Build draft POs here, print or email them, then mark sent before receiving."}
          </p>
          <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
            {isReceiveMode
              ? "Sent PO = ready to receive. Direct invoice = arrived without a pre-built PO. Draft PO = order setup; mark sent before receiving."
              : "NTBO lines stay NTBO while a PO is in draft. Mark Sent moves linked order items to Ordered."}
          </p>
        </div>
        {ordersLoadError && (
          <div className="mb-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm font-semibold text-amber-700 dark:text-amber-200">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-black uppercase tracking-widest text-[10px]">
                  {ordersShowingStale
                    ? "Vendor paperwork may not be current"
                    : "Vendor paperwork unavailable"}
                </p>
                <p className="mt-1 normal-case tracking-normal">{ordersLoadError}</p>
              </div>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-[2.5rem] border border-app-border/40 bg-app-bg/10 backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-app-surface/40 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                <tr>
                  <th className="px-6 py-4">{isReceiveMode ? "Document #" : "PO #"}</th>
                  <th className="px-6 py-4">Vendor</th>
                  <th className="px-6 py-4">Type</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/40">
                {ordersLoading && orders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <Clock size={32} className="mx-auto mb-3 text-app-text-muted opacity-60" />
                      <p className="text-sm font-black text-app-text">Loading vendor paperwork</p>
                    </td>
                  </tr>
                ) : ordersLoadError && orders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <AlertTriangle size={32} className="mx-auto mb-3 text-amber-600 opacity-80" />
                      <p className="text-sm font-black text-app-text">Vendor paperwork could not load.</p>
                      <p className="mt-2 text-xs font-semibold text-app-text-muted">
                        Try again in a moment before starting a new receiving document.
                      </p>
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <p className="text-sm font-black text-app-text">
                        {isReceiveMode
                          ? "No vendor paperwork is ready to receive yet."
                          : "No purchase orders or direct invoices yet."}
                      </p>
                      <p className="mt-2 text-xs font-semibold text-app-text-muted">
                        {isReceiveMode
                          ? "Select a vendor, then create a Direct Invoice for arrived merchandise or use New PO Setup if this is still an order."
                          : "Select a vendor above, then create a New PO or Direct Invoice to begin receiving."}
                      </p>
                    </td>
                  </tr>
                ) : orders.map((o) => (
                  <tr
                    key={o.id}
                    className={`group cursor-pointer transition-all ${
                      selectedPo === o.id ? "bg-app-accent/10" : "hover:bg-app-surface/20"
                    }`}
                    onClick={() => setSelectedPo(o.id)}
                  >
                    <td className="px-6 py-4 font-mono font-black text-app-accent">{o.po_number}</td>
                    <td className="px-6 py-4 font-bold text-app-text">{o.vendor_name}</td>
                    <td className="px-6 py-4">
                      <span className="rounded-lg bg-app-surface-2 px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                        {purchaseOrderTypeLabel(o.po_kind)}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                       <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[9px] font-black uppercase tracking-widest shadow-sm ${
                         o.status === 'draft' ? 'bg-app-surface-2 text-app-text-muted border border-app-border' :
                         o.status === 'submitted' ? 'bg-app-accent/10 text-app-accent border border-app-accent/20' :
                         o.status === 'partially_received' ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20' :
                         o.status === 'closed' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20' :
                         'bg-red-500/10 text-red-500 border border-red-500/20'
                       }`}>
                         <div className={`h-1.5 w-1.5 rounded-full ${
                           o.status === 'draft' ? 'bg-app-text-muted' :
                           o.status === 'submitted' ? 'bg-app-accent' :
                           o.status === 'partially_received' ? 'bg-amber-500' :
                           o.status === 'closed' ? 'bg-emerald-500' :
                           'bg-red-500'
                         }`} />
                         {purchaseOrderStatusLabel(o.status)}
                       </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        {selectedPo === o.id &&
                        o.status === "draft" &&
                        o.po_kind !== "direct_invoice" ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void submitPo();
                            }}
                            className="inline-flex h-8 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 text-[9px] font-black uppercase tracking-widest text-app-text shadow-sm hover:border-app-accent hover:text-app-accent transition-all active:scale-95"
                          >
                            Mark Sent
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={!canReceiveOrder(o)}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedPo(o.id);
                            setReceivingPoId(o.id);
                          }}
                          className="inline-flex h-8 items-center gap-2 rounded-xl bg-emerald-600 px-4 text-[9px] font-black uppercase tracking-widest text-white shadow-lg shadow-emerald-600/20 hover:brightness-110 disabled:opacity-0 transition-all active:scale-95"
                        >
                          <Truck size={12} /> Receive
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </DashboardGridCard>

      <DashboardGridCard 
        title={isReceiveMode ? "Document Lines" : "PO Lines"}
        subtitle={
          selected
            ? isReceiveMode
              ? `Match arrived items to ${selected.po_number}`
              : `Adding items to ${selected.po_number}`
            : isReceiveMode
              ? "Select vendor paperwork before reviewing received items"
              : "Select a purchase order before adding items"
        }
        icon={Sparkles}
      >
        <div className="grid gap-6 md:grid-cols-[1fr_1fr_120px_160px]">
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">Item Search</label>
            <VariantSearchInput
              onSelect={(v: VariantSearchResult) => setVariantId(v.variant_id)}
              placeholder="Filter by SKU or Product name..."
            />
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">Unit Cost (USD)</label>
            <div className="relative">
              <input
                type="number"
                step="0.01"
                min="0"
                value={unitCost}
                onChange={(e) => setUnitCost(e.target.value)}
                className="w-full h-12 bg-app-surface shadow-inner border border-app-border rounded-2xl px-10 text-sm font-black focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
              />
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted opacity-40 font-black">$</span>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">Quantity</label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(Number.parseInt(e.target.value || "1", 10))}
              className="w-full h-12 bg-app-surface shadow-inner border border-app-border rounded-2xl px-5 text-sm font-black focus:ring-2 focus:ring-app-accent/20 transition-all outline-none"
            />
          </div>
          <div className="flex flex-col justify-end">
            <button
              type="button"
              disabled={!selectedPo || !variantId}
              onClick={addLine}
              className="h-12 rounded-2xl bg-app-accent text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 hover:brightness-110 disabled:opacity-20 active:scale-95 transition-all"
            >
              {isReceiveMode ? "Add Line to Paperwork" : "Add Line"}
            </button>
          </div>
        </div>

        <div className="mt-10 rounded-[2rem] border border-app-border/40 bg-app-surface/20 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Receipt Posting
              </p>
              <p className="text-sm font-bold text-app-text">
                Final stock posts only from Receive Stock.
              </p>
              <p className="text-xs text-app-text-muted">
                {isReceiveMode
                  ? "Open Receive Stock when the sent PO or direct invoice matches the paperwork in hand."
                  : "Standard purchase orders must be marked sent before receiving. Direct invoices can open receiving immediately."}
              </p>
            </div>
            <div className="flex gap-3">
              {canSubmitSelected ? (
                <button
                  type="button"
                  onClick={() => void submitPo()}
                  className="h-12 rounded-2xl border border-app-border bg-app-surface px-5 text-[10px] font-black uppercase tracking-widest text-app-text shadow-sm hover:border-app-accent hover:text-app-accent transition-all active:scale-95"
                >
                  Mark Sent
                </button>
              ) : null}
              <button
                type="button"
                disabled={!canOpenReceiving}
                onClick={() => setReceivingPoId(selectedPo)}
                className="h-12 rounded-2xl bg-emerald-600 px-5 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/20 hover:brightness-110 disabled:opacity-20 active:scale-95 transition-all"
              >
                Open Receive Stock
              </button>
            </div>
          </div>
        </div>
      </DashboardGridCard>


      {nonInventoryNeeds.length > 0 && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm animate-in fade-in slide-in-from-top-2 duration-300">
          <h3 className="mb-3 text-sm font-black uppercase tracking-wider text-amber-900 flex items-center gap-2">
            <span className="flex h-2 w-2 animate-pulse rounded-full bg-amber-600"></span>
            Non-Inventory Items Needed (Weddings)
          </h3>
          <div className="rounded border border-amber-200 bg-white overflow-hidden">
            <table className="w-full text-left text-[11px]">
              <thead className="bg-amber-100/50">
                <tr>
                  <th className="px-3 py-2 text-amber-900">Description</th>
                  <th className="px-3 py-2 text-amber-900 text-center">Qty</th>
                  <th className="px-3 py-2 text-amber-900">Notes</th>
                  <th className="px-3 py-2 text-amber-900">Added</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-amber-100">
                {nonInventoryNeeds.map((item) => (
                  <tr key={item.id} className="hover:bg-amber-50/50 transition-colors">
                    <td className="px-3 py-2 font-bold text-app-text">{item.description}</td>
                    <td className="px-3 py-2 text-center font-mono text-emerald-700">{item.quantity}</td>
                    <td className="px-3 py-2 text-app-text-muted italic">{item.notes || "-"}</td>
                    <td className="px-3 py-2 text-[10px] text-app-text-muted">
                        {new Date(item.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-amber-700 italic">
            Note: These items are not in the item list and must be sourced manually for specific wedding orders.
          </p>
        </section>
      )}
    </div>
  );
}
