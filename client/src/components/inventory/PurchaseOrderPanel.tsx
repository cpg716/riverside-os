import { useCallback, useEffect, useRef, useState } from "react";
import ReceivingBay from "./ReceivingBay";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";

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

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
  const [receiveLineId, setReceiveLineId] = useState("");
  const [receiveQty, setReceiveQty] = useState(1);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [freightTotal, setFreightTotal] = useState("0.00");
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
      toast("Failed to create PO draft", "error");
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
      toast("Failed to create direct invoice draft", "error");
      return;
    }
    refresh();
  };

  const addLine = async () => {
    if (!selectedPo || !variantId.trim()) return;
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
      toast("Failed to add PO line", "error");
      return;
    }
    toast("PO line added", "success");
  };

  const receive = async () => {
    if (!selectedPo) return;
    const res = await fetch(`${baseUrl}/api/purchase-orders/${selectedPo}/receive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({
        invoice_number: invoiceNo || null,
        freight_total: centsToFixed2(parseMoneyToCents(freightTotal)),
        lines: [
          {
            po_line_id: receiveLineId.trim(),
            quantity_received_now: receiveQty,
          },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Receiving requires line items", "error");
      return;
    }
    toast("Receiving posted", "success");
    refresh();
  };

  const selected = orders.find((o) => o.id === selectedPo);
  const canOpenReceiving =
    !!selected &&
    selected.status !== "cancelled" &&
    selected.status !== "closed" &&
    (selected.po_kind === "direct_invoice"
      ? true
      : selected.status !== "draft");

  return (
    <div className="relative space-y-4">
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
      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <h3 className="mb-3 text-sm font-black uppercase tracking-wider text-app-text">
          Purchase Orders
        </h3>
        <div className="flex flex-wrap gap-2">
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="ui-input"
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
            className="ui-btn-primary text-sm normal-case tracking-normal font-bold"
          >
            Create Draft PO
          </button>
          <button
            type="button"
            onClick={() => void createDirectInvoice()}
            className="rounded border border-app-accent-2/40 bg-app-accent-2/10 px-3 py-2 text-sm font-bold text-app-text"
          >
            Direct invoice
          </button>
          <button
            type="button"
            disabled={!selectedPo || !canOpenReceiving}
            onClick={() => selectedPo && setReceivingPoId(selectedPo)}
            className="rounded border border-app-accent-2/35 bg-app-accent-2/10 px-3 py-2 text-sm font-bold text-app-accent-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Receiving bay
          </button>
        </div>
        <div className="mt-3 rounded border border-app-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-app-surface-2">
              <tr>
                <th className="px-2 py-2">PO #</th>
                <th className="px-2 py-2">Vendor</th>
                <th className="px-2 py-2">Kind</th>
                <th className="px-2 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className={`cursor-pointer border-t border-app-border ${
                    selectedPo === o.id ? "bg-app-accent-2/10" : ""
                  }`}
                  onClick={() => setSelectedPo(o.id)}
                >
                  <td className="px-2 py-2 font-mono">{o.po_number}</td>
                  <td className="px-2 py-2">{o.vendor_name}</td>
                  <td className="px-2 py-2 font-mono text-[10px] uppercase text-app-text-muted">
                    {o.po_kind ?? "standard"}
                  </td>
                  <td className="px-2 py-2 uppercase">{o.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <h3 className="mb-3 text-sm font-black uppercase tracking-wider text-app-text">
          Add PO line / Quick receive
        </h3>
        <div className="grid gap-2 md:grid-cols-4">
          <VariantSearchInput
            onSelect={(v: VariantSearchResult) => setVariantId(v.variant_id)}
            placeholder="Search products by name or SKU…"
            className="md:col-span-2"
          />
          <input
            type="number"
            value={qty}
            onChange={(e) => setQty(Number.parseInt(e.target.value || "1", 10))}
            className="ui-input py-2 text-xs"
          />
          <input
            type="number"
            step="0.01"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            className="ui-input py-2 text-xs"
            placeholder="Unit cost"
          />
        </div>
        <button
          type="button"
          onClick={addLine}
          className="ui-btn-primary mt-2 text-xs normal-case tracking-normal font-bold"
        >
          Add line
        </button>

        <div className="mt-4 grid gap-2 md:grid-cols-4 border-t border-app-border pt-4">
          <input
            value={invoiceNo}
            onChange={(e) => setInvoiceNo(e.target.value)}
            placeholder="Invoice #"
            className="ui-input py-2 text-xs"
          />
          <input
            value={receiveLineId}
            onChange={(e) => setReceiveLineId(e.target.value)}
            placeholder="PO Line ID"
            className="ui-input py-2 text-xs font-mono"
          />
          <input
            value={receiveQty}
            onChange={(e) => setReceiveQty(Number.parseInt(e.target.value || "1", 10))}
            type="number"
            placeholder="Qty received now"
            className="ui-input py-2 text-xs"
          />
          <input
            value={freightTotal}
            onChange={(e) => setFreightTotal(e.target.value)}
            step="0.01"
            type="number"
            placeholder="Freight total"
            className="ui-input py-2 text-xs"
          />
          <button
            type="button"
            onClick={receive}
            className="rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white shadow-sm hover:brightness-110 transition-all"
          >
            Quick Receive
          </button>
        </div>
      </section>

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
