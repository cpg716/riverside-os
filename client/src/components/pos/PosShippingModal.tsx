import { useCallback, useEffect, useState } from "react";
import { Truck, X } from "lucide-react";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";
import type { Customer } from "./CustomerSelector";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

export interface PosShippingSelection {
  rate_quote_id: string;
  amount_cents: number;
  /** e.g. "USPS — Priority Mail" */
  label: string;
  to_address: PosShipToForm;
}

export interface PosShipToForm {
  name: string;
  street1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

function emptyForm(): PosShipToForm {
  return {
    name: "",
    street1: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
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
  selectedCustomer: Customer | null;
  current: PosShippingSelection | null;
  onApply: (next: PosShippingSelection | null) => void;
}

export default function PosShippingModal({
  open,
  onClose,
  baseUrl,
  getHeaders,
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
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);

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
  }, [open, current, selectedCustomer]);

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
        city?: string | null;
        state?: string | null;
        postal_code?: string | null;
      };
      const nm = [d.first_name, d.last_name].filter(Boolean).join(" ").trim();
      setForm((f) => ({
        ...f,
        name: nm || f.name,
        street1: (d.address_line1 ?? "").trim() || f.street1,
        city: (d.city ?? "").trim() || f.city,
        state: (d.state ?? "").trim() || f.state,
        zip: (d.postal_code ?? "").trim() || f.zip,
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
            street1: form.street1.trim(),
            city: form.city.trim(),
            state: form.state.trim(),
            zip: form.zip.trim(),
            country: form.country.trim() || "US",
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
    });
    onClose();
    toast("Shipping added to sale", "success");
  }, [form, onApply, onClose, rates, selectedQuoteId, toast]);

  const clearShipping = useCallback(() => {
    onApply(null);
    onClose();
    toast("Shipping removed", "info");
  }, [onApply, onClose, toast]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 font-sans">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[min(640px,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl"
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
                Street
              </span>
              <input
                className="ui-input w-full text-sm"
                value={form.street1}
                onChange={(e) => setForm((f) => ({ ...f, street1: e.target.value }))}
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
          </div>

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
    </div>
  );
}
