import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import ReceivingBay from "./ReceivingBay";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";
import { Truck, ListFilter, Sparkles, Plus } from "lucide-react";
import DashboardGridCard from "../ui/DashboardGridCard";

interface PurchaseOrder {
  id: string;
  po_number: string;
  status: string;
  vendor_name: string;
  po_kind?: string;
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
}

const baseUrl = getBaseUrl();

export default function PurchaseOrderPanel({
  initialPoId,
  onInitialPoConsumed,
}: {
  initialPoId?: string | null;
  onInitialPoConsumed?: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const consumedInitialPo = useRef(false);

  useEffect(() => {
    consumedInitialPo.current = false;
  }, [initialPoId]);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [selectedPo, setSelectedPo] = useState<string>("");
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState(1);
  const [unitCost, setUnitCost] = useState("0.00");
  const [receivingPoId, setReceivingPoId] = useState<string | null>(null);
  const [nonInventoryNeeds, setNonInventoryNeeds] = useState<WeddingNonInventoryItem[]>([]);

  const refresh = useCallback(() => {
    fetch(apiUrl(baseUrl, "/api/purchase-orders"), {
      headers: backofficeHeaders() as Record<string, string>,
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setOrders(list);
        if (!selectedPo && list.length > 0) setSelectedPo(list[0].id);
      })
      .catch(() => setOrders([]));
  }, [backofficeHeaders, selectedPo]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    refresh();
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
    refresh();
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
    refresh();
  };

  const submitPo = async () => {
    if (!selectedPo) return;
    const res = await fetch(`${baseUrl}/api/purchase-orders/${selectedPo}/submit`, {
      method: "POST",
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Could not submit purchase order", "error");
      return;
    }
    toast("Purchase order submitted", "success");
    refresh();
  };

  const selected = orders.find((o) => o.id === selectedPo);
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

  return (
    <div className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700">
      {receivingPoId && (
        <ReceivingBay
          poId={receivingPoId}
          onClose={() => setReceivingPoId(null)}
          onComplete={() => {
            setReceivingPoId(null);
            refresh();
          }}
        />
      )}
      <div className="px-2">
        <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Vendor Orders</h3>
        <h2 className="text-2xl font-black tracking-tight text-app-text">Purchase Orders & Receiving</h2>
      </div>

      <DashboardGridCard 
        title="Active Purchase Orders"
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
            onClick={createDraft}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-app-accent text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 hover:brightness-110 active:scale-95 transition-all"
          >
            <Plus size={14} /> New PO
          </button>
          <button
            type="button"
            onClick={() => void createDirectInvoice()}
            className="flex items-center gap-2 h-10 px-6 rounded-xl bg-app-accent-2/10 border border-app-accent-2/20 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-accent-2/20 transition-all active:scale-95"
          >
            <Sparkles size={14} /> Direct Invoice
          </button>
        </div>
        <div className="overflow-hidden rounded-[2.5rem] border border-app-border/40 bg-app-bg/10 backdrop-blur-md">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-app-surface/40 border-b border-app-border/40 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                <tr>
                  <th className="px-6 py-4">PO #</th>
                  <th className="px-6 py-4">Vendor</th>
                  <th className="px-6 py-4">Type</th>
                  <th className="px-6 py-4">Status</th>
                  <th className="px-6 py-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border/40">
                {orders.map((o) => (
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
                        {o.po_kind ?? "standard"}
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
                         {o.status}
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
                            Submit
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={selectedPo !== o.id || !canOpenReceiving}
                          onClick={(e) => {
                            e.stopPropagation();
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
        title="Line Builder"
        subtitle={selected ? `Active Context: ${selected.po_number}` : "Select a PO to add receipt lines"}
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
              Add Line
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
                Final stock posts only from the Receiving Bay overlay.
              </p>
              <p className="text-xs text-app-text-muted">
                Standard purchase orders must be submitted before receiving. Direct invoices can open receiving immediately.
              </p>
            </div>
            <div className="flex gap-3">
              {canSubmitSelected ? (
                <button
                  type="button"
                  onClick={() => void submitPo()}
                  className="h-12 rounded-2xl border border-app-border bg-app-surface px-5 text-[10px] font-black uppercase tracking-widest text-app-text shadow-sm hover:border-app-accent hover:text-app-accent transition-all active:scale-95"
                >
                  Submit PO
                </button>
              ) : null}
              <button
                type="button"
                disabled={!canOpenReceiving}
                onClick={() => setReceivingPoId(selectedPo)}
                className="h-12 rounded-2xl bg-emerald-600 px-5 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/20 hover:brightness-110 disabled:opacity-20 active:scale-95 transition-all"
              >
                Open Receiving Bay
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
            Note: These items are not in the master catalog and must be sourced manually for specific wedding orders.
          </p>
        </section>
      )}
    </div>
  );
}
