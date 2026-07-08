import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Truck, X } from "lucide-react";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";
import type { Customer } from "./CustomerSelector";
import type { CustomerOrder } from "./OrderLoadModal";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";

export interface PosShippingSelection {
  rate_quote_id: string;
  amount_cents: number;
  /** e.g. "USPS — Priority Mail" */
  label: string;
  to_address: PosShipToForm;
  linked_order_ids?: string[];
}

export interface PosShipToForm {
  name: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
  email?: string;
  is_residential?: boolean;
}

function emptyForm(): PosShipToForm {
    return {
      name: "",
      company: "",
      street1: "",
      street2: "",
      city: "",
      state: "",
      zip: "",
      country: "US",
      phone: "",
      email: "",
      is_residential: false,
    };
}

function decimalToCents(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.round(v * 100);
  }
  const s = String(v ?? "").trim();
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

interface RateRow {
  rate_quote_id: string;
  amount_usd: unknown;
  carrier: string;
  service_name: string;
  estimated_days?: string | null;
}

interface PosShippingModalProps {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  getHeaders: () => Record<string, string>;
  registerSessionId?: string | null;
  selectedCustomer: Customer | null;
  current: PosShippingSelection | null;
  onApply: (next: PosShippingSelection | null) => void;
}

export default function PosShippingModal({
  open,
  onClose,
  baseUrl,
  getHeaders,
  registerSessionId,
  selectedCustomer,
  current,
  onApply,
}: PosShippingModalProps) {
  const { toast } = useToast();
  const { dialogRef, titleId } = useDialogAccessibility(open, { onEscape: onClose });
  const [form, setForm] = useState<PosShipToForm>(emptyForm());
  const [rates, setRates] = useState<RateRow[]>([]);
  const [stub, setStub] = useState(true);
  const [loading, setLoading] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [manualLabel, setManualLabel] = useState("Shipping");
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [linkableOrders, setLinkableOrders] = useState<CustomerOrder[]>([]);
  const [selectedLinkedOrderIds, setSelectedLinkedOrderIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    if (current?.to_address) {
      setForm({ ...current.to_address });
    } else {
      const nm = [selectedCustomer?.first_name, selectedCustomer?.last_name]
        .filter(Boolean)
        .join(" ")
        .trim();
      setForm({
        ...emptyForm(),
        name: nm,
      });
    }
    setRates([]);
    setSelectedQuoteId(current?.rate_quote_id ?? null);
    setStub(true);
    setManualAmount(current ? (current.amount_cents / 100).toFixed(2) : "");
    setManualLabel("Shipping");
    setSelectedLinkedOrderIds(current?.linked_order_ids ?? []);
  }, [open, current, selectedCustomer]);

  useEffect(() => {
    if (!open || !selectedCustomer?.id) {
      setLinkableOrders([]);
      return;
    }
    const params = new URLSearchParams({
      customer_id: selectedCustomer.id,
      limit: "25",
      record_scope: "orders",
      status_scope: "all",
    });
    if (registerSessionId) params.set("register_session_id", registerSessionId);
    let ignore = false;
    fetch(`${baseUrl}/api/transactions?${params.toString()}`, {
      headers: getHeaders(),
    })
      .then(async (res) => {
        if (!res.ok) return [];
        const data = await res.json();
        const rows = Array.isArray(data?.items) ? data.items : [];
        return rows
          .map((row: CustomerOrder) => ({ ...row, id: row.id ?? row.transaction_id }))
          .filter((row: CustomerOrder) => row.id && row.status !== "fulfilled" && row.status !== "cancelled");
      })
      .then((rows: CustomerOrder[]) => {
        if (!ignore) setLinkableOrders(rows);
      })
      .catch(() => {
        if (!ignore) setLinkableOrders([]);
      });
    return () => {
      ignore = true;
    };
  }, [baseUrl, getHeaders, open, registerSessionId, selectedCustomer?.id]);

  const toggleLinkedOrder = useCallback((orderId: string) => {
    setSelectedLinkedOrderIds((prev) =>
      prev.includes(orderId)
        ? prev.filter((id) => id !== orderId)
        : [...prev, orderId],
    );
  }, []);

  const fillFromCustomer = useCallback(async () => {
    if (!selectedCustomer?.id) {
      toast("Link a customer first", "error");
      return;
    }
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/${encodeURIComponent(selectedCustomer.id)}`,
        { headers: getHeaders() },
      );
      if (!res.ok) {
        toast("Could not load customer address (check CRM permissions)", "error");
        return;
      }
      const d = (await res.json()) as {
        first_name?: string | null;
        last_name?: string | null;
        address_line1?: string | null;
        address_line2?: string | null;
        city?: string | null;
        state?: string | null;
        postal_code?: string | null;
        phone_primary?: string | null;
        phone?: string | null;
        email?: string | null;
      };
      const nm = [d.first_name, d.last_name].filter(Boolean).join(" ").trim();
      setForm((f) => ({
        ...f,
        name: nm || f.name,
        street1: (d.address_line1 ?? "").trim() || f.street1,
        street2: (d.address_line2 ?? "").trim() || f.street2,
        city: (d.city ?? "").trim() || f.city,
        state: (d.state ?? "").trim() || f.state,
        zip: (d.postal_code ?? "").trim() || f.zip,
        phone: (d.phone_primary ?? d.phone ?? "").trim() || f.phone,
        email: (d.email ?? "").trim() || f.email,
      }));
      toast("Address filled from customer profile", "info");
    } catch {
      toast("Could not load customer", "error");
    }
  }, [baseUrl, getHeaders, selectedCustomer, toast]);

  const fetchRates = useCallback(async () => {
    if (!form.street1.trim() || !form.city.trim() || !form.state.trim() || !form.zip.trim()) {
      toast("Enter street, city, state, and ZIP", "error");
      return;
    }
    setLoading(true);
    setRates([]);
    setSelectedQuoteId(null);
    try {
      const res = await fetch(`${baseUrl}/api/pos/shipping/rates`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({
          to_address: {
            name: form.name.trim(),
            company: form.company?.trim() || undefined,
            street1: form.street1.trim(),
            street2: form.street2?.trim() || undefined,
            city: form.city.trim(),
            state: form.state.trim(),
            zip: form.zip.trim(),
            country: form.country.trim() || "US",
            phone: form.phone?.trim() || undefined,
            email: form.email?.trim() || undefined,
            is_residential: !!form.is_residential,
          },
          force_stub: false,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        rates?: RateRow[];
        stub?: boolean;
      };
      if (!res.ok) {
        toast(j.error ?? "Could not get shipping rates", "error");
        return;
      }
      const list = j.rates ?? [];
      setRates(list);
      setStub(!!j.stub);
      if (list.length === 0) toast("No rates returned", "error");
    } catch {
      toast("Network error loading rates", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, form, getHeaders, toast]);

  const applySelection = useCallback(() => {
    if (!selectedQuoteId) {
      toast("Select a shipping option", "error");
      return;
    }
    const row = rates.find((r) => r.rate_quote_id === selectedQuoteId);
    if (!row) {
      toast("Selected rate expired — get rates again", "error");
      return;
    }
    const amount_cents = decimalToCents(row.amount_usd);
    if (amount_cents <= 0) {
      toast("Invalid shipping amount", "error");
      return;
    }
    onApply({
      rate_quote_id: row.rate_quote_id,
      amount_cents,
      label: `${row.carrier} — ${row.service_name}`,
      to_address: { ...form },
      linked_order_ids: selectedLinkedOrderIds,
    });
    onClose();
    toast("Shipping added to sale", "success");
  }, [form, onApply, onClose, rates, selectedLinkedOrderIds, selectedQuoteId, toast]);

  const applyManualShipping = useCallback(async () => {
    if (!form.street1.trim() || !form.city.trim() || !form.state.trim() || !form.zip.trim()) {
      toast("Enter street, city, state, and ZIP", "error");
      return;
    }
    const amount = Number.parseFloat(manualAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast("Enter a shipping amount", "error");
      return;
    }
    setManualLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/pos/shipping/manual-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getHeaders() },
        body: JSON.stringify({
          to_address: {
            name: form.name.trim(),
            company: form.company?.trim() || undefined,
            street1: form.street1.trim(),
            street2: form.street2?.trim() || undefined,
            city: form.city.trim(),
            state: form.state.trim(),
            zip: form.zip.trim(),
            country: form.country.trim() || "US",
            phone: form.phone?.trim() || undefined,
            email: form.email?.trim() || undefined,
            is_residential: !!form.is_residential,
          },
          amount_usd: amount.toFixed(2),
          label: manualLabel.trim() || "Shipping",
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        rate_quote_id?: string;
        amount_usd?: unknown;
        carrier?: string;
        service_name?: string;
      };
      if (!res.ok || !j.rate_quote_id) {
        toast(j.error ?? "Could not add shipping charge", "error");
        return;
      }
      const amount_cents = decimalToCents(j.amount_usd ?? amount);
      if (amount_cents <= 0) {
        toast("Invalid shipping amount", "error");
        return;
      }
      const carrier = j.carrier || "Riverside";
      const service = j.service_name || manualLabel.trim() || "Shipping";
      onApply({
        rate_quote_id: j.rate_quote_id,
        amount_cents,
        label: `${carrier} — ${service}`,
        to_address: { ...form },
        linked_order_ids: selectedLinkedOrderIds,
      });
      onClose();
      toast("Shipping charge added to sale", "success");
    } catch {
      toast("Network error adding shipping charge", "error");
    } finally {
      setManualLoading(false);
    }
  }, [
    baseUrl,
    form,
    getHeaders,
    manualAmount,
    manualLabel,
    onApply,
    onClose,
    selectedLinkedOrderIds,
    toast,
  ]);

  const clearShipping = useCallback(() => {
    onApply(null);
    onClose();
    toast("Shipping removed", "info");
  }, [onApply, onClose, toast]);

  if (!open) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        className="absolute inset-0 bg-black/50"
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border border-app-border bg-app-surface shadow-2xl sm:max-h-[min(640px,90vh)] sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/15 text-sky-600">
              <Truck size={18} />
            </div>
            <div>
              <h2 id={titleId} className="text-sm font-black uppercase tracking-widest text-app-text">
                Ship this sale
              </h2>
              <p className="text-[10px] font-semibold text-app-text-muted">
                Quotes expire in about 15 minutes. Re-fetch if checkout waits.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="no-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void fillFromCustomer()}
              disabled={!selectedCustomer}
              className="ui-btn-secondary rounded-xl px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
            >
              Use customer address
            </button>
            {current ? (
              <button
                type="button"
                onClick={clearShipping}
                className="rounded-xl border border-red-500/40 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-red-600 hover:bg-red-500/10"
              >
                Remove shipping
              </button>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Name
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Country
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.country}
                onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))}
              />
            </label>
            <label className="col-span-full block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Company
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.company ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
              />
            </label>
            <AddressAutocompleteInput
              className="col-span-full"
              label="Street 1"
              value={form.street1}
              inputClassName="ui-input w-full text-sm"
              validationContext={{
                name: form.name,
                company: form.company,
                address_line2: form.street2,
                country: form.country,
                phone: form.phone,
                email: form.email,
                is_residential: form.is_residential,
              }}
              onChange={(value) => setForm((f) => ({ ...f, street1: value }))}
              onSelectAddress={(suggestion) =>
                setForm((f) => ({
                  ...f,
                  street1: suggestion.address_line1,
                  city: suggestion.city,
                  state: suggestion.state,
                  zip: suggestion.postal_code,
                  country: suggestion.country || f.country || "US",
                }))
              }
            />
            <label className="col-span-full block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Street 2
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.street2 ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, street2: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                City
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                State
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                ZIP
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.zip}
                onChange={(e) => setForm((f) => ({ ...f, zip: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Phone
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.phone ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                Email
              </span>
              <input
                type="email"
                className="ui-input w-full text-sm"
                value={form.email ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </label>
            <label className="col-span-full flex items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <input
                type="checkbox"
                className="rounded border-app-border"
                checked={!!form.is_residential}
                onChange={(e) =>
                  setForm((f) => ({ ...f, is_residential: e.target.checked }))
                }
              />
              Residential destination
            </label>
          </div>

          {linkableOrders.length > 0 ? (
            <div className="space-y-2 rounded-2xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Link existing orders
              </p>
              <div className="space-y-1.5">
                {linkableOrders.map((order) => {
                  const checked = selectedLinkedOrderIds.includes(order.id);
                  return (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => toggleLinkedOrder(order.id)}
                      className={`flex w-full items-center justify-between rounded-xl border px-3 py-2 text-left transition-colors ${
                        checked
                          ? "border-app-accent bg-app-accent/10"
                          : "border-app-border bg-app-surface hover:border-app-border"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-black text-app-text">
                          {order.display_id}
                        </span>
                        <span className="block text-[10px] font-semibold text-app-text-muted">
                          Balance ${Number.parseFloat(order.balance_due ?? "0").toFixed(2)}
                        </span>
                      </span>
                      <span
                        className={`h-5 w-5 rounded border ${
                          checked
                            ? "border-app-accent bg-app-accent"
                            : "border-app-border bg-app-surface-2"
                        }`}
                        aria-hidden="true"
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            disabled={loading}
            onClick={() => void fetchRates()}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-app-border bg-app-surface-2 py-2.5 text-[11px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface disabled:opacity-50"
          >
            <IntegrationBrandLogo
              brand="shippo"
              kind="icon"
              className="inline-flex"
              imageClassName="h-4 w-4 object-contain"
            />
            {loading ? "Loading rates…" : "Get shipping rates"}
          </button>

          <div className="space-y-2 rounded-2xl border border-app-border bg-app-surface-2 p-3">
            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Manual shipping charge
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_140px]">
              <label className="block space-y-1">
                <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                  Label
                </span>
                <input
                  className="ui-input w-full text-sm"
                  value={manualLabel}
                  onChange={(e) => setManualLabel(e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                  Amount
                </span>
                <input
                  className="ui-input w-full text-sm"
                  inputMode="decimal"
                  value={manualAmount}
                  onChange={(e) => setManualAmount(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            </div>
            <button
              type="button"
              disabled={manualLoading}
              onClick={() => void applyManualShipping()}
              className="flex w-full items-center justify-center rounded-xl bg-app-accent px-3 py-2 text-[11px] font-black uppercase tracking-widest text-white shadow-sm disabled:opacity-50"
            >
              {manualLoading ? "Adding..." : "Add shipping charge"}
            </button>
          </div>

          {stub && rates.length > 0 ? (
            <div className="flex items-center gap-2 text-[10px] font-semibold text-amber-700">
              <IntegrationBrandLogo
                brand="shippo"
                kind="icon"
                className="inline-flex"
                imageClassName="h-4 w-4 object-contain"
              />
              <p>
                Demo rates (stub). Configure Shippo in Settings for live carrier pricing.
              </p>
            </div>
          ) : null}

          {rates.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Select rate
              </p>
              <ul className="space-y-1.5">
                {rates.map((r) => {
                  const id = r.rate_quote_id;
                  const cents = decimalToCents(r.amount_usd);
                  const sel = selectedQuoteId === id;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => setSelectedQuoteId(id)}
                        className={`flex w-full items-center justify-between rounded-xl border-2 px-3 py-2 text-left transition-colors ${
                          sel
                            ? "border-app-accent bg-app-accent/10"
                            : "border-app-border bg-app-surface-2 hover:border-app-border"
                        }`}
                      >
                        <div>
                          <p className="text-xs font-black text-app-text">
                            {r.carrier} — {r.service_name}
                          </p>
                          {r.estimated_days ? (
                            <p className="text-[10px] font-semibold text-app-text-muted">
                              Est. {r.estimated_days} days
                            </p>
                          ) : null}
                        </div>
                        <span className="text-sm font-black tabular-nums text-app-text">
                          ${(cents / 100).toFixed(2)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="border-t border-app-border bg-app-surface p-4">
          <button
            type="button"
            onClick={applySelection}
            disabled={!selectedQuoteId || rates.length === 0}
            className="flex h-14 w-full items-center justify-center rounded-2xl border-b-8 border-emerald-800 bg-emerald-600 text-sm font-black uppercase tracking-widest text-white shadow-lg disabled:cursor-not-allowed disabled:border-app-border disabled:bg-app-surface-2 disabled:text-app-text-muted"
          >
            Apply shipping to sale
          </button>
        </div>
      </div>
    </div>,
    root
  );
}
