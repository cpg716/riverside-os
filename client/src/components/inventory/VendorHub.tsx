import { useCallback, useEffect, useState } from "react";
import { Building2, Clock3, Package, Plus, Search, Trash2, Wallet, ShieldCheck } from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

interface Vendor {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  account_number?: string | null;
  payment_terms?: string | null;
  vendor_code?: string | null;
  nuorder_brand_id?: string | null;
  is_active?: boolean;
}

interface VendorHubDto {
  vendor_id: string;
  vendor_name: string;
  account_number: string | null;
  payment_terms: string | null;
  vendor_code: string | null;
  nuorder_brand_id: string | null;
  active_po_count: number;
  total_received_spend: string;
  open_credits_usd: string;
  avg_lead_time_days: number | null;
}

interface VendorBrandRow {
  id: string;
  brand: string;
  created_at: string;
}

function formatMoney(v: string): string {
  return formatUsdFromCents(parseMoneyToCents(v));
}

export default function VendorHub() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [hub, setHub] = useState<VendorHubDto | null>(null);
  const [brands, setBrands] = useState<VendorBrandRow[]>([]);
  const [brandInput, setBrandInput] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [vendorSearch, setVendorSearch] = useState("");

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingBrandId, setDeletingBrandId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(apiUrl(baseUrl, "/api/vendors"), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok || cancelled) {
        if (!cancelled) setVendors([]);
        return;
      }
      const data = (await res.json()) as Vendor[];
      const list = Array.isArray(data) ? data : [];
      if (cancelled) return;
      setVendors(list);
      setVendorId((cur) => cur || list[0]?.id || "");
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, backofficeHeaders]);

  const loadHub = useCallback(async () => {
    if (!vendorId) return;
    setLoadErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/vendors/${vendorId}/hub`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to load hub");
      }
      setHub((await res.json()) as VendorHubDto);
    } catch (e) {
      setHub(null);
      setLoadErr(e instanceof Error ? e.message : "Hub load failed");
    }
  }, [baseUrl, vendorId, backofficeHeaders]);

  const loadBrands = useCallback(async () => {
    if (!vendorId) return;
    const res = await fetch(`${baseUrl}/api/vendors/${vendorId}/brands`, {
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (!res.ok) {
      setBrands([]);
      return;
    }
    const data = (await res.json()) as VendorBrandRow[];
    setBrands(Array.isArray(data) ? data : []);
  }, [baseUrl, vendorId, backofficeHeaders]);

  useEffect(() => {
    void loadHub();
    void loadBrands();
  }, [loadHub, loadBrands]);

  const addBrand = async () => {
    const t = brandInput.trim();
    if (!t || !vendorId) return;
    const res = await fetch(`${baseUrl}/api/vendors/${vendorId}/brands`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      },
      body: JSON.stringify({ brand: t }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast(body.error ?? "Could not add brand", "error");
      return;
    }
    setBrandInput("");
    void loadBrands();
  };

  const handleConfirmDelete = async () => {
    if (!vendorId || !deletingBrandId) return;
    const res = await fetch(`${baseUrl}/api/vendors/${vendorId}/brands/${deletingBrandId}`, {
      method: "DELETE",
      headers: backofficeHeaders() as Record<string, string>,
    });
    if (!res.ok) {
      toast("Delete failed", "error");
    } else {
      void loadBrands();
    }
    setShowDeleteConfirm(false);
    setDeletingBrandId(null);
  };

  const leadLabel =
    hub?.avg_lead_time_days != null && Number.isFinite(hub.avg_lead_time_days)
      ? `${hub.avg_lead_time_days.toFixed(1)} days (submit → first receipt)`
      : "— (need submitted POs with receipts)";

  return (
    <div className="space-y-4 rounded-xl border border-app-border bg-app-surface p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Building2 className="text-app-accent-2" size={20} />
          <h3 className="text-sm font-black uppercase tracking-wider text-app-text">
            Vendor hub
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-app-text-muted" />
            <input
              type="text"
              placeholder="Filter vendors…"
              className="ui-input h-9 w-40 pl-8 text-xs font-bold"
              value={vendorSearch}
              onChange={(e) => setVendorSearch(e.target.value)}
            />
          </div>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="ui-input h-9 text-sm font-bold"
          >
            {vendors.length === 0 ? (
              <option value="">No vendors</option>
            ) : (
              vendors
                .filter((v) => {
                  if (!vendorSearch.trim()) return true;
                  const q = vendorSearch.toLowerCase();
                  return (
                    v.name.toLowerCase().includes(q) ||
                    v.vendor_code?.toLowerCase().includes(q)
                  );
                })
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))
            )}
          </select>
        </div>
      </header>

      {loadErr && (
        <p className="text-xs font-bold text-red-600">{loadErr}</p>
      )}

      {hub && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Package size={12} className="text-app-accent-2" />
                Active POs
              </div>
              <p className="font-mono text-3xl font-black text-app-text">
                {hub.active_po_count}
              </p>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Wallet size={12} className="text-app-success" />
                Total received spend
              </div>
              <p className="font-mono text-2xl font-black text-app-success">
                {formatMoney(hub.total_received_spend)}
              </p>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 shadow-sm">
              <div className="mb-1 flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Clock3 size={12} className="text-app-accent" />
                Avg lead time
              </div>
              <p className="text-sm font-black text-app-text">{leadLabel}</p>
              <p className="mt-2 text-[10px] font-bold uppercase tracking-tight text-app-text-muted">
                Open credits: {formatMoney(hub.open_credits_usd)} (AP module)
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-app-text-muted">
            {hub.vendor_code ? (
              <p>
                Vendor code:{" "}
                <span className="font-mono font-bold">{hub.vendor_code}</span>
              </p>
            ) : null}
            {hub.account_number ? (
              <p>
                Account #:{" "}
                <span className="font-mono font-bold">{hub.account_number}</span>
              </p>
            ) : null}
            {hub.payment_terms ? (
              <p>
                Payment terms:{" "}
                <span className="font-mono font-bold">{hub.payment_terms}</span>
              </p>
            ) : null}
            {hub.nuorder_brand_id ? (
              <p>
                NuORDER Brand:{" "}
                <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">{hub.nuorder_brand_id}</span>
              </p>
            ) : (
              <p className="text-amber-600/60 dark:text-amber-400/60 flex items-center gap-1">
                <ShieldCheck size={12} /> Unlinked to NuORDER
              </p>
            )}
          </div>
        </>
      )}

      <div className="rounded-xl border border-app-border bg-app-surface-2/80 p-4">
        <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Brand portfolio
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          <input
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="Link a brand name…"
            className="ui-input min-w-[200px] flex-1 text-sm"
          />
          <button
            type="button"
            onClick={() => void addBrand()}
            className="flex items-center gap-1 rounded-lg bg-app-accent px-4 py-2 text-xs font-black uppercase tracking-widest text-white"
          >
            <Plus size={14} /> Add
          </button>
        </div>
        <ul className="divide-y divide-app-border rounded-lg border border-app-border bg-app-surface">
          {brands.length === 0 ? (
            <li className="px-3 py-4 text-xs text-app-text-muted">
              No linked brands yet.
            </li>
          ) : (
            brands.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <span className="text-sm font-bold text-app-text">{b.brand}</span>
                <button
                  type="button"
                  onClick={() => {
                    setDeletingBrandId(b.id);
                    setShowDeleteConfirm(true);
                  }}
                  className="rounded p-1 text-app-text-muted hover:bg-red-50 hover:text-red-600"
                  aria-label={`Remove ${b.brand}`}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            ))
          )}
        </ul>
      </div>

      <ConfirmationModal
        isOpen={showDeleteConfirm}
        title="Remove Brand Link?"
        message="Are you sure you want to remove this brand from the vendor portfolio? This action cannot be undone."
        confirmLabel="Remove Link"
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          setShowDeleteConfirm(false);
          setDeletingBrandId(null);
        }}
      />
    </div>
  );
}
