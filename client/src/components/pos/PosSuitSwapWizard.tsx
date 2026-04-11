import { useCallback, useEffect, useState } from "react";
import { Shirt, X, Loader2 } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import OrderSearchInput from "../ui/OrderSearchInput";

type FulfillmentKind = "takeaway" | "special_order" | "wedding_order";

interface OrderItemRow {
  order_item_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  quantity_returned: number;
  fulfillment: FulfillmentKind;
  is_fulfilled?: boolean;
}

interface OrderDetailLite {
  order_id: string;
  status: string;
  items: OrderItemRow[];
}

function jsonHeaders(base: Record<string, string>): HeadersInit {
  const h = new Headers(base);
  h.set("Content-Type", "application/json");
  return h;
}

export default function PosSuitSwapWizard({
  open,
  onClose,
  sessionId,
  baseUrl,
  apiAuth,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  baseUrl: string;
  apiAuth: () => Record<string, string>;
}) {
  const { toast } = useToast();
  useShellBackdropLayer(open);

  const [step, setStep] = useState<"load" | "swap" | "done">("load");
  const [_loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<OrderDetailLite | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [replacementSku, setReplacementSku] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const sessionQs = `register_session_id=${encodeURIComponent(sessionId)}`;

  const reset = useCallback(() => {
    setStep("load");
    setDetail(null);
    setSelectedLineId(null);
    setReplacementSku("");
    setNote("");
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const loadOrder = async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(id)}?${sessionQs}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          b.error ??
            "Could not load order. It must have a payment on this register session.",
          "error",
        );
        return;
      }
      const d = (await res.json()) as OrderDetailLite;
      if (d.status === "cancelled") {
        toast("Cancelled orders cannot be edited here.", "error");
        return;
      }
      setDetail(d);
      setStep("swap");
    } catch {
      toast("Network error loading order", "error");
    } finally {
      setLoading(false);
    }
  };

  const submitSwap = async () => {
    if (!detail || !selectedLineId || !replacementSku.trim()) {
      toast("Select a line and enter replacement SKU.", "info");
      return;
    }
    const sellable =
      (detail.items.find((i) => i.order_item_id === selectedLineId)?.quantity ?? 0) -
      (detail.items.find((i) => i.order_item_id === selectedLineId)?.quantity_returned ?? 0);
    if (sellable <= 0) {
      toast("That line has no remaining quantity.", "error");
      return;
    }
    setSubmitting(true);
    try {
      const scanRes = await fetch(
        `${baseUrl}/api/inventory/scan/${encodeURIComponent(replacementSku.trim())}`,
        { headers: apiAuth() },
      );
      if (!scanRes.ok) {
        toast("Could not resolve replacement SKU.", "error");
        return;
      }
      const scanned = (await scanRes.json()) as { variant_id: string };
      const res = await fetch(
        `${baseUrl}/api/orders/${detail.order_id}/items/${selectedLineId}/suit-swap`,
        {
          method: "POST",
          headers: jsonHeaders(apiAuth()),
          body: JSON.stringify({
            in_variant_id: scanned.variant_id,
            register_session_id: sessionId,
            note: note.trim() || null,
          }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Swap failed", "error");
        return;
      }
      const out = (await res.json()) as { old_sku: string; new_sku: string; inventory_adjusted: boolean };
      toast(
        `Swapped ${out.old_sku} → ${out.new_sku}${out.inventory_adjusted ? " (stock updated)" : ""}.`,
        "success",
      );
      setStep("done");
    } catch {
      toast("Swap failed", "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Suit swap wizard"
    >
      <div className="ui-card flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col overflow-hidden border border-app-border bg-app-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Shirt className="h-5 w-5 text-emerald-600" />
            <h2 className="text-sm font-black uppercase tracking-widest text-app-text">
              Suit / component swap
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step === "load" && (
            <div className="space-y-4">
              <p className="text-xs text-app-text-muted">
                Search for an order that already has a payment on this open register session.
              </p>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                 <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                   Select Order
                 </p>
                 <OrderSearchInput 
                    autoFocus 
                    onSelect={(o) => void loadOrder(o.order_id)} 
                    disabled={_loading}
                 />
              </div>
              <p className="text-[10px] text-app-text-muted leading-relaxed opacity-60">
                Inventory moves apply for fulfilled takeaway and fulfilled special/wedding lines per server rules.
              </p>
            </div>
          )}

          {step === "swap" && detail && (
            <div className="space-y-4">
              <p className="text-xs font-mono text-app-text-muted">{detail.order_id}</p>
              <div className="space-y-2">
                <p className="text-[10px] font-black uppercase text-app-text-muted">Line</p>
                <ul className="max-h-48 space-y-2 overflow-y-auto">
                  {detail.items.map((it) => {
                    const max = it.quantity - (it.quantity_returned ?? 0);
                    if (max <= 0) return null;
                    return (
                      <li key={it.order_item_id}>
                        <button
                          type="button"
                          onClick={() => setSelectedLineId(it.order_item_id)}
                          className={`w-full rounded-xl border p-3 text-left text-xs transition-colors ${
                            selectedLineId === it.order_item_id
                              ? "border-emerald-600 bg-emerald-900/20"
                              : "border-app-border bg-app-surface-2"
                          }`}
                        >
                          <span className="font-bold text-app-text">{it.product_name}</span>
                          <span className="mt-1 block font-mono text-app-text-muted">
                            {it.sku} · {it.fulfillment}
                            {it.is_fulfilled ? " · fulfilled" : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Replacement SKU
                <input
                  className="ui-input mt-1 w-full font-mono text-sm"
                  value={replacementSku}
                  onChange={(e) => setReplacementSku(e.target.value)}
                  placeholder="Scan or type SKU"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Note (optional)
                <input
                  className="ui-input mt-1 w-full text-sm"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={submitting || !selectedLineId}
                onClick={() => void submitSwap()}
                className="ui-btn-primary flex w-full items-center justify-center gap-2 py-3"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Confirm swap
              </button>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-4 text-center">
              <p className="text-sm font-bold text-app-text">Swap recorded.</p>
              <p className="text-xs text-app-text-muted">
                QBO daily journal includes suit-swap value deltas when mappings exist. Use Back Office Orders
                for voids, returns, or exchange links.
              </p>
              <button
                type="button"
                onClick={() => {
                  reset();
                  onClose();
                }}
                className="ui-btn-secondary w-full py-2 text-xs"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
