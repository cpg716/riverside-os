import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Package,
  Search,
  Scissors,
  X,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import type {
  AlterationSourceType,
  CartLineItem,
  PendingAlterationIntake,
  SearchResult,
} from "./types";
import type { Customer } from "./CustomerSelector";

type SourceMode = AlterationSourceType;

type CustomerOrder = {
  id?: string;
  transaction_id?: string;
  display_id?: string;
  booked_at?: string;
  status?: string;
};

type PastPurchaseItem = {
  transaction_line_id: string;
  product_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  quantity: number;
  unit_price: string;
  fulfillment: string;
};

type SelectedSource = {
  source_type: SourceMode;
  cart_row_id?: string | null;
  item_description: string;
  source_product_id?: string | null;
  source_variant_id?: string | null;
  source_sku?: string | null;
  source_transaction_id?: string | null;
  source_transaction_line_id?: string | null;
  source_snapshot?: Record<string, unknown> | null;
};

interface PosAlterationIntakeModalProps {
  open: boolean;
  customer: Customer | null;
  cartLines: CartLineItem[];
  baseUrl: string;
  apiAuth: () => Record<string, string>;
  editingIntake?: PendingAlterationIntake | null;
  onClose: () => void;
  onSavedStandalone: () => void;
  onSavePending: (intake: PendingAlterationIntake) => void;
}

const SOURCE_OPTIONS: Array<{ id: SourceMode; label: string }> = [
  { id: "current_cart_item", label: "Cart item" },
  { id: "past_transaction_line", label: "Past purchase" },
  { id: "catalog_item", label: "SKU / item" },
  { id: "custom_item", label: "Custom item" },
];

function newPendingAlterationId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function customerName(customer: Customer): string {
  return `${customer.first_name} ${customer.last_name}`.trim() || "Customer";
}

function cartLineDescription(line: CartLineItem): string {
  return [line.name, line.variation_label].filter(Boolean).join(" - ");
}

function pastItemDescription(item: PastPurchaseItem): string {
  return [item.product_name, item.variation_label].filter(Boolean).join(" - ");
}

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString();
}

function mapControlBoardRow(row: Record<string, unknown>): SearchResult {
  return {
    product_id: String(row.product_id ?? ""),
    variant_id: String(row.variant_id ?? ""),
    sku: String(row.sku ?? ""),
    name: String(row.product_name ?? ""),
    variation_label: row.variation_label == null ? null : String(row.variation_label),
    standard_retail_price: (row.retail_price as string | number | undefined) ?? 0,
    unit_cost: (row.cost_price as string | number | undefined) ?? 0,
    stock_on_hand: Number(row.stock_on_hand ?? 0),
    state_tax: (row.state_tax as string | number | undefined) ?? 0,
    local_tax: (row.local_tax as string | number | undefined) ?? 0,
    tax_category: row.tax_category as "clothing" | "footwear" | "other" | undefined,
  };
}

export default function PosAlterationIntakeModal({
  open,
  customer,
  cartLines,
  baseUrl,
  apiAuth,
  editingIntake = null,
  onClose,
  onSavedStandalone,
  onSavePending,
}: PosAlterationIntakeModalProps) {
  const { toast } = useToast();
  const [sourceMode, setSourceMode] = useState<SourceMode>("current_cart_item");
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const [workRequested, setWorkRequested] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [chargeEnabled, setChargeEnabled] = useState(false);
  const [chargeAmount, setChargeAmount] = useState("");
  const [customItemDescription, setCustomItemDescription] = useState("");

  const [catalogSearch, setCatalogSearch] = useState("");
  const [catalogResults, setCatalogResults] = useState<SearchResult[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [viewingOrderId, setViewingOrderId] = useState<string | null>(null);
  const [pastItems, setPastItems] = useState<PastPurchaseItem[]>([]);

  const selectedCartLine = useMemo(
    () => cartLines.find((line) => line.cart_row_id === selectedSource?.cart_row_id) ?? null,
    [cartLines, selectedSource],
  );

  const warning = useMemo(() => {
    switch (sourceMode) {
      case "past_transaction_line":
        return "This item is from a previous purchase and will not be sold again.";
      case "catalog_item":
        return "This item is being attached for alterations only and will not be added to the sale.";
      case "custom_item":
        return "Use this when the item is not in the system.";
      default:
        return null;
    }
  }, [sourceMode]);

  const reset = useCallback(() => {
    setSourceMode("current_cart_item");
    setSelectedSource(null);
    setWorkRequested("");
    setDueAt("");
    setNotes("");
    setChargeEnabled(false);
    setChargeAmount("");
    setCustomItemDescription("");
    setCatalogSearch("");
    setCatalogResults([]);
    setCatalogLoading(false);
    setOrders([]);
    setOrdersLoading(false);
    setViewingOrderId(null);
    setPastItems([]);
  }, []);

  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    if (!editingIntake) return;
    setSourceMode(editingIntake.source_type);
    setSelectedSource({
      source_type: editingIntake.source_type,
      cart_row_id: editingIntake.cart_row_id ?? null,
      item_description: editingIntake.item_description,
      source_product_id: editingIntake.source_product_id ?? null,
      source_variant_id: editingIntake.source_variant_id ?? null,
      source_sku: editingIntake.source_sku ?? null,
      source_transaction_id: editingIntake.source_transaction_id ?? null,
      source_transaction_line_id: editingIntake.source_transaction_line_id ?? null,
    });
    setWorkRequested(editingIntake.work_requested);
    setDueAt(editingIntake.due_at ? editingIntake.due_at.slice(0, 10) : "");
    setNotes(editingIntake.notes ?? "");
    setChargeEnabled(Boolean(editingIntake.charge_amount && editingIntake.charge_amount !== "0.00"));
    setChargeAmount(editingIntake.charge_amount ?? "");
    setCustomItemDescription(
      editingIntake.source_type === "custom_item" ? editingIntake.item_description : "",
    );
  }, [editingIntake, open, reset]);

  useEffect(() => {
    if (!open || sourceMode !== "past_transaction_line" || !customer) return;
    setOrdersLoading(true);
    fetch(`${baseUrl}/api/transactions?customer_id=${encodeURIComponent(customer.id)}&limit=25`, {
      headers: apiAuth(),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("load orders");
        return res.json();
      })
      .then((data) => setOrders(Array.isArray(data?.items) ? data.items : []))
      .catch(() => {
        setOrders([]);
        toast("Could not load this customer's past purchases.", "error");
      })
      .finally(() => setOrdersLoading(false));
  }, [apiAuth, baseUrl, customer, open, sourceMode, toast]);

  const selectSourceMode = (next: SourceMode) => {
    setSourceMode(next);
    setSelectedSource(null);
    setViewingOrderId(null);
    setPastItems([]);
    setCatalogResults([]);
    setCatalogSearch("");
  };

  const loadPastItems = async (order: CustomerOrder) => {
    const orderId = order.id ?? order.transaction_id;
    if (!orderId) return;
    setViewingOrderId(orderId);
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${encodeURIComponent(orderId)}/items`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("load items");
      const items = (await res.json()) as PastPurchaseItem[];
      setPastItems(Array.isArray(items) ? items : []);
    } catch {
      setPastItems([]);
      toast("Could not load items for that purchase.", "error");
    }
  };

  const runCatalogLookup = async () => {
    const q = catalogSearch.trim();
    if (q.length < 2) {
      setCatalogResults([]);
      return;
    }
    setCatalogLoading(true);
    const collected: SearchResult[] = [];
    try {
      const [scanRes, boardRes] = await Promise.all([
        fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
          headers: apiAuth(),
        }),
        fetch(`${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=50`, {
          headers: apiAuth(),
        }),
      ]);

      if (scanRes.ok) {
        collected.push((await scanRes.json()) as SearchResult);
      }
      if (boardRes.ok) {
        const data = (await boardRes.json()) as { rows?: Array<Record<string, unknown>> };
        collected.push(...(data.rows ?? []).map(mapControlBoardRow));
      }

      const seen = new Set<string>();
      setCatalogResults(
        collected.filter((item) => {
          if (!item.variant_id || seen.has(item.variant_id)) return false;
          seen.add(item.variant_id);
          return true;
        }),
      );
    } catch {
      setCatalogResults([]);
      toast("Lookup failed. Try the SKU or item name again.", "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const sourceForSubmit = (): SelectedSource | null => {
    if (sourceMode === "custom_item") {
      const description = customItemDescription.trim();
      if (!description) return null;
      return {
        source_type: "custom_item",
        item_description: description,
      };
    }
    return selectedSource;
  };

  const save = async () => {
    if (!customer) {
      toast("Select a customer before starting an alteration.", "error");
      return;
    }

    const source = sourceForSubmit();
    if (!source) {
      toast("Select or describe the item being altered.", "error");
      return;
    }

    const work = workRequested.trim();
    if (!work) {
      toast("Enter the work requested before saving.", "error");
      return;
    }

    const charge = chargeEnabled ? chargeAmount.trim() : "";
    if (chargeEnabled && (!charge || Number(charge) < 0 || Number.isNaN(Number(charge)))) {
      toast("Enter a valid charge amount or turn off the charge option.", "error");
      return;
    }

    const dueIso = dueAt ? new Date(`${dueAt}T12:00:00`).toISOString() : null;
    const chargeValue = chargeEnabled ? charge : null;
    const noteValue = notes.trim() || null;

    const intakeId = editingIntake?.id ?? newPendingAlterationId();
    onSavePending({
        id: intakeId,
        customer_id: customer.id,
        customer_name: customerName(customer),
        source_type: source.source_type,
        alteration_cart_row_id: editingIntake?.alteration_cart_row_id ?? null,
        cart_row_id: source.cart_row_id ?? null,
        item_description: source.item_description,
        work_requested: work,
        source_product_id: source.source_product_id ?? null,
        source_variant_id: source.source_variant_id ?? null,
        source_sku: source.source_sku ?? null,
        charge_amount: chargeValue,
        due_at: dueIso,
        notes: noteValue,
        created_at: editingIntake?.created_at ?? new Date().toISOString(),
      });
    toast(editingIntake ? "Alteration line updated." : "Alteration line added to the cart.", "success");
    onSavedStandalone();
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Alteration intake"
      data-testid="pos-alteration-intake-dialog"
    >
      <div className="ui-card flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden border border-app-border bg-app-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Scissors className="h-5 w-5 text-app-accent" />
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-app-text">
                Alteration intake
              </h2>
              <p className="text-xs font-semibold text-app-text-muted">
                {customer ? customerName(customer) : "Select a customer before saving"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
            aria-label="Close alteration intake"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!customer ? (
          <div className="m-5 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm font-bold text-amber-800">
            Select or create a customer on the Register before starting alteration intake.
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-[1.15fr_0.85fr]">
          <div className="min-h-0 overflow-y-auto p-5">
            <div className="mb-4 flex flex-wrap gap-2">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-testid={`pos-alteration-source-${option.id}`}
                  onClick={() => selectSourceMode(option.id)}
                  className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition-all ${
                    sourceMode === option.id
                      ? "border-app-accent bg-app-accent text-white"
                      : "border-app-border bg-app-surface-2 text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {warning ? (
              <div className="mb-4 flex gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs font-bold text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{warning}</span>
              </div>
            ) : null}

            {sourceMode === "current_cart_item" ? (
              <div className="space-y-2">
                {cartLines.length === 0 ? (
                  <div className="rounded-xl border border-app-border bg-app-surface-2 p-4 text-sm font-semibold text-app-text-muted">
                    Add clothing to the cart before attaching an alteration to a current sale item.
                  </div>
                ) : (
                  cartLines.map((line) => (
                    <button
                      key={line.cart_row_id}
                      type="button"
                      data-testid="pos-alteration-cart-source-option"
                      onClick={() =>
                        setSelectedSource({
                          source_type: "current_cart_item",
                          cart_row_id: line.cart_row_id,
                          item_description: cartLineDescription(line),
                          source_product_id: line.product_id,
                          source_variant_id: line.variant_id,
                          source_sku: line.sku,
                          source_snapshot: {
                            sku: line.sku,
                            name: line.name,
                            variation_label: line.variation_label ?? null,
                          },
                        })
                      }
                      className={`flex w-full items-center justify-between rounded-xl border p-3 text-left transition-all ${
                        selectedCartLine?.cart_row_id === line.cart_row_id
                          ? "border-app-accent bg-app-accent/10"
                          : "border-app-border bg-app-surface-2 hover:border-app-accent/50"
                      }`}
                    >
                      <div>
                        <p className="text-sm font-black text-app-text">{cartLineDescription(line)}</p>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                          {line.sku} - Qty {line.quantity}
                        </p>
                      </div>
                      {selectedCartLine?.cart_row_id === line.cart_row_id ? (
                        <CheckCircle2 className="h-5 w-5 text-app-accent" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}

            {sourceMode === "past_transaction_line" ? (
              <div className="space-y-3">
                {ordersLoading ? (
                  <Loader2 className="h-5 w-5 animate-spin text-app-accent" />
                ) : orders.length === 0 ? (
                  <div className="rounded-xl border border-app-border bg-app-surface-2 p-4 text-sm font-semibold text-app-text-muted">
                    No recent purchases found for this customer.
                  </div>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {orders.map((order) => {
                      const orderId = order.id ?? order.transaction_id ?? "";
                      return (
                        <button
                          key={orderId}
                          type="button"
                          onClick={() => void loadPastItems(order)}
                          className={`rounded-xl border p-3 text-left ${
                            viewingOrderId === orderId
                              ? "border-app-accent bg-app-accent/10"
                              : "border-app-border bg-app-surface-2 hover:border-app-accent/50"
                          }`}
                        >
                          <p className="text-sm font-black text-app-text">
                            {order.display_id ?? orderId.slice(0, 8).toUpperCase()}
                          </p>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                            {formatDate(order.booked_at)}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                )}

                {pastItems.length > 0 ? (
                  <div className="space-y-2 border-t border-app-border pt-3">
                    {pastItems.map((item) => (
                      <button
                      key={item.transaction_line_id}
                      type="button"
                      data-testid="pos-alteration-past-source-option"
                      onClick={() =>
                          setSelectedSource({
                            source_type: "past_transaction_line",
                            item_description: pastItemDescription(item),
                            source_product_id: item.product_id,
                            source_variant_id: item.variant_id,
                            source_sku: item.sku,
                            source_transaction_id: viewingOrderId,
                            source_transaction_line_id: item.transaction_line_id,
                            source_snapshot: {
                              sku: item.sku,
                              product_name: item.product_name,
                              variation_label: item.variation_label,
                              fulfillment: item.fulfillment,
                            },
                          })
                        }
                        className={`flex w-full items-center justify-between rounded-xl border p-3 text-left ${
                          selectedSource?.source_transaction_line_id === item.transaction_line_id
                            ? "border-app-accent bg-app-accent/10"
                            : "border-app-border bg-app-surface-2 hover:border-app-accent/50"
                        }`}
                      >
                        <div>
                          <p className="text-sm font-black text-app-text">{pastItemDescription(item)}</p>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                            {item.sku} - Qty {item.quantity}
                          </p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {sourceMode === "catalog_item" ? (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted" />
                    <input
                      value={catalogSearch}
                      onChange={(event) => setCatalogSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void runCatalogLookup();
                        }
                      }}
                      placeholder="Scan or enter SKU / item name"
                      data-testid="pos-alteration-lookup-input"
                      className="ui-input h-11 w-full pl-9 text-sm font-bold"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => void runCatalogLookup()}
                    data-testid="pos-alteration-lookup-button"
                    className="ui-btn-secondary px-4 text-[10px] font-black uppercase tracking-widest"
                  >
                    {catalogLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Lookup"}
                  </button>
                </div>

                <div className="space-y-2">
                  {catalogResults.map((item) => (
                    <button
                      key={item.variant_id}
                      type="button"
                      data-testid="pos-alteration-catalog-source-option"
                      onClick={() =>
                        setSelectedSource({
                          source_type: "catalog_item",
                          item_description: [item.name, item.variation_label].filter(Boolean).join(" - "),
                          source_product_id: item.product_id,
                          source_variant_id: item.variant_id,
                          source_sku: item.sku,
                          source_snapshot: {
                            sku: item.sku,
                            name: item.name,
                            variation_label: item.variation_label ?? null,
                          },
                        })
                      }
                      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${
                        selectedSource?.source_variant_id === item.variant_id
                          ? "border-app-accent bg-app-accent/10"
                          : "border-app-border bg-app-surface-2 hover:border-app-accent/50"
                      }`}
                    >
                      <Package className="h-5 w-5 text-app-text-muted" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-app-text">
                          {[item.name, item.variation_label].filter(Boolean).join(" - ")}
                        </p>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                          {item.sku}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {sourceMode === "custom_item" ? (
              <label className="block space-y-2">
                <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Custom item description
                </span>
                <input
                  value={customItemDescription}
                  onChange={(event) => setCustomItemDescription(event.target.value)}
                  placeholder="Customer-owned gown, outside jacket, vintage suit..."
                  data-testid="pos-alteration-custom-description"
                  className="ui-input h-11 w-full text-sm font-bold"
                />
              </label>
            ) : null}
          </div>

          <div className="min-h-0 overflow-y-auto border-t border-app-border bg-app-surface-2/50 p-5 lg:border-l lg:border-t-0">
            <div className="space-y-4">
              <div className="rounded-xl border border-app-border bg-app-surface p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Selected item
                </p>
                <p className="mt-1 text-sm font-black text-app-text">
                  {sourceForSubmit()?.item_description ?? "No item selected"}
                </p>
                {sourceForSubmit()?.source_sku ? (
                  <p className="font-mono text-[10px] text-app-text-muted">
                    {sourceForSubmit()?.source_sku}
                  </p>
                ) : null}
              </div>

              <label className="block space-y-2">
                <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Work requested
                </span>
                <input
                  value={workRequested}
                  onChange={(event) => setWorkRequested(event.target.value)}
                  placeholder="Hem pants, take in waist, shorten sleeves..."
                  data-testid="pos-alteration-work-requested"
                  className="ui-input h-11 w-full text-sm font-bold"
                />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface p-3">
                <span className="text-xs font-black uppercase tracking-widest text-app-text">
                  Optional charge
                </span>
                <input
                  type="checkbox"
                  checked={chargeEnabled}
                  onChange={(event) => setChargeEnabled(event.target.checked)}
                  data-testid="pos-alteration-charge-toggle"
                  className="h-5 w-5 accent-[var(--app-accent)]"
                />
              </label>

              {chargeEnabled ? (
                <label className="block space-y-2">
                  <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Charge amount
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={chargeAmount}
                    onChange={(event) => setChargeAmount(event.target.value)}
                    placeholder="0.00"
                    data-testid="pos-alteration-charge-amount"
                    className="ui-input h-11 w-full text-sm font-bold"
                  />
                  <p className="text-[10px] font-semibold text-app-text-muted">
                    This updates the alteration cart line amount. The garment lookup is not sold again.
                  </p>
                </label>
              ) : null}

              <label className="block space-y-2">
                <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Due date
                </span>
                <input
                  type="date"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                  className="ui-input h-11 w-full text-sm font-bold"
                />
              </label>

              <label className="block space-y-2">
                <span className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Notes
                </span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Staff notes for the tailor..."
                  className="ui-input min-h-[96px] w-full p-3 text-sm"
                />
              </label>

              <button
                type="button"
                disabled={!customer}
                  onClick={() => void save()}
                data-testid="pos-alteration-save"
                className="ui-btn-primary flex h-12 w-full items-center justify-center gap-2 text-[11px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                <Scissors className="h-4 w-4" />
                Save alteration intake
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
