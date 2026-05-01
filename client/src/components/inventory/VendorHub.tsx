import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, Clock3, Edit3, Package, Plus, Search, Trash2, Wallet, ShieldCheck, Merge, TrendingUp } from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import DashboardStatsCard from "../ui/DashboardStatsCard";
import DashboardGridCard from "../ui/DashboardGridCard";



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

interface VendorFormState {
  name: string;
  email: string;
  phone: string;
  account_number: string;
  payment_terms: string;
  vendor_code: string;
}

const EMPTY_VENDOR_FORM: VendorFormState = {
  name: "",
  email: "",
  phone: "",
  account_number: "",
  payment_terms: "",
  vendor_code: "",
};

function formatMoney(v: string): string {
  return formatUsdFromCents(parseMoneyToCents(v));
}

export default function VendorHub() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [hub, setHub] = useState<VendorHubDto | null>(null);
  const [brands, setBrands] = useState<VendorBrandRow[]>([]);
  const [brandInput, setBrandInput] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [vendorSearch, setVendorSearch] = useState("");
  const [vendorForm, setVendorForm] = useState<VendorFormState>(EMPTY_VENDOR_FORM);
  const [editingVendorId, setEditingVendorId] = useState<string | null>(null);
  const [showVendorForm, setShowVendorForm] = useState(false);
  const [savingVendor, setSavingVendor] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingBrandId, setDeletingBrandId] = useState<string | null>(null);
  
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [sourceVendorId, setSourceVendorId] = useState("");
  const [merging, setMerging] = useState(false);

  const refreshVendors = useCallback(async (preferredVendorId?: string) => {
      const res = await fetch(apiUrl(baseUrl, "/api/vendors"), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        setVendors([]);
        return;
      }
      const data = (await res.json()) as Vendor[];
      const list = Array.isArray(data) ? data : [];
      setVendors(list);
      setVendorId((cur) => preferredVendorId || cur || list[0]?.id || "");
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await refreshVendors();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshVendors]);

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

  const handleMerge = async () => {
    if (!sourceVendorId || !vendorId || sourceVendorId === vendorId) {
      toast("Select a different source vendor", "error");
      return;
    }

    setMerging(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/vendors/merge"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          source_vendor_id: sourceVendorId,
          target_vendor_id: vendorId,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Merge failed");
      }

      toast("Vendors merged successfully", "success");
      setShowMergeModal(false);
      setSourceVendorId("");
      // Refresh vendor list
      const listRes = await fetch(apiUrl(baseUrl, "/api/vendors"), {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (listRes.ok) {
        setVendors((await listRes.json()) as Vendor[]);
      }
      void loadHub();
      void loadBrands();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Merge failed", "error");
    } finally {
      setMerging(false);
    }
  };

  const openCreateVendor = () => {
    setEditingVendorId(null);
    setVendorForm(EMPTY_VENDOR_FORM);
    setShowVendorForm(true);
  };

  const openEditVendor = () => {
    const vendor = vendors.find((v) => v.id === vendorId);
    if (!vendor) return;
    setEditingVendorId(vendor.id);
    setVendorForm({
      name: vendor.name ?? "",
      email: vendor.email ?? "",
      phone: vendor.phone ?? "",
      account_number: vendor.account_number ?? "",
      payment_terms: vendor.payment_terms ?? "",
      vendor_code: vendor.vendor_code ?? "",
    });
    setShowVendorForm(true);
  };

  const saveVendor = async () => {
    const name = vendorForm.name.trim();
    if (!name) {
      toast("Enter a vendor name first.", "info");
      return;
    }

    setSavingVendor(true);
    try {
      const payload = {
        name,
        email: vendorForm.email.trim() || null,
        phone: vendorForm.phone.trim() || null,
        account_number: vendorForm.account_number.trim() || null,
        payment_terms: vendorForm.payment_terms.trim() || null,
        vendor_code: vendorForm.vendor_code.trim() || null,
      };
      const res = await fetch(
        editingVendorId
          ? apiUrl(baseUrl, `/api/vendors/${editingVendorId}`)
          : apiUrl(baseUrl, "/api/vendors"),
        {
          method: editingVendorId ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save vendor");
      }
      const saved = (await res.json()) as Vendor;
      toast(editingVendorId ? "Vendor updated" : "Vendor created", "success");
      setShowVendorForm(false);
      setEditingVendorId(null);
      setVendorForm(EMPTY_VENDOR_FORM);
      await refreshVendors(saved.id);
      void loadHub();
      void loadBrands();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not save vendor", "error");
    } finally {
      setSavingVendor(false);
    }
  };

  const leadLabel =
    hub?.avg_lead_time_days != null && Number.isFinite(hub.avg_lead_time_days)
      ? `${hub.avg_lead_time_days.toFixed(1)} days (submit → first receipt)`
      : "— (need submitted POs with receipts)";

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-6 duration-700">
      <div className="flex flex-wrap items-center justify-between gap-4 px-1">
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-2xl bg-app-accent/10 border border-app-accent/20 flex items-center justify-center text-app-accent group-hover:scale-110 transition-all">
            <Building2 size={24} />
          </div>
          <div>
            <h2 className="text-2xl font-black tracking-tight text-app-text">
              {vendors.find(v => v.id === vendorId)?.name || 'Select Vendor'}
            </h2>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="group relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted transition-colors group-focus-within:text-app-accent" />
            <input
              type="text"
              placeholder="Find suppliers..."
              className="ui-input h-10 w-48 pl-10 text-xs font-bold"
              value={vendorSearch}
              onChange={(e) => setVendorSearch(e.target.value)}
            />
          </div>
          <select
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            className="ui-input h-10 min-w-[200px] text-sm font-black bg-app-surface/20 shadow-inner"
          >
            {vendors.length === 0 ? (
              <option value="">No vendors found</option>
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
                    {v.name} {v.vendor_code ? `(${v.vendor_code})` : ''}
                  </option>
                ))
            )}
          </select>
          <button
            onClick={openCreateVendor}
            className="flex h-10 items-center gap-2 rounded-xl bg-app-accent px-4 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition-all hover:brightness-110 active:scale-95"
          >
            <Plus size={14} /> New Vendor
          </button>
          <button
            onClick={openEditVendor}
            disabled={!vendorId}
            className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent hover:text-app-accent disabled:opacity-40 transition-all active:scale-95 shadow-sm"
          >
            <Edit3 size={14} /> Edit
          </button>
          <button
            onClick={() => setShowMergeModal(true)}
            className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent hover:text-app-accent transition-all active:scale-95 shadow-sm"
          >
            <Merge size={14} /> Merge
          </button>
        </div>
      </div>

	      {loadErr && (
	        <p className="text-xs font-bold text-red-600">{loadErr}</p>
	      )}

	      <section className="rounded-[28px] border border-app-border bg-app-surface p-4 shadow-sm">
	        <div className="mb-3 flex items-center justify-between gap-3">
	          <div>
	            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
	              Vendors
	            </h3>
	            <p className="text-xs font-bold text-app-text-muted">
	              Select a vendor to view, edit, merge, or manage brand links.
	            </p>
	          </div>
	          <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
	            {vendors.length} total
	          </span>
	        </div>
	        <div className="max-h-72 overflow-auto rounded-2xl border border-app-border">
	          <table className="w-full text-left text-xs">
	            <thead className="sticky top-0 bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
	              <tr>
	                <th className="px-4 py-3">Vendor</th>
	                <th className="px-4 py-3">Code</th>
	                <th className="px-4 py-3">Account</th>
	                <th className="px-4 py-3">Contact</th>
	                <th className="px-4 py-3">Status</th>
	              </tr>
	            </thead>
	            <tbody className="divide-y divide-app-border">
	              {vendors
	                .filter((v) => {
	                  if (!vendorSearch.trim()) return true;
	                  const q = vendorSearch.toLowerCase();
	                  return (
	                    v.name.toLowerCase().includes(q) ||
	                    v.vendor_code?.toLowerCase().includes(q) ||
	                    v.account_number?.toLowerCase().includes(q)
	                  );
	                })
	                .map((v) => (
	                  <tr
	                    key={v.id}
	                    onClick={() => setVendorId(v.id)}
	                    className={`cursor-pointer transition-colors hover:bg-app-accent/5 ${
	                      vendorId === v.id ? "bg-app-accent/10" : "bg-app-surface"
	                    }`}
	                  >
	                    <td className="px-4 py-3 font-black text-app-text">{v.name}</td>
	                    <td className="px-4 py-3 font-mono text-app-text-muted">{v.vendor_code || "—"}</td>
	                    <td className="px-4 py-3 text-app-text-muted">{v.account_number || "—"}</td>
	                    <td className="px-4 py-3 text-app-text-muted">{v.email || v.phone || "—"}</td>
	                    <td className="px-4 py-3">
	                      <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-widest ${v.is_active === false ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
	                        {v.is_active === false ? "Inactive" : "Active"}
	                      </span>
	                    </td>
	                  </tr>
	                ))}
	            </tbody>
	          </table>
	        </div>
	      </section>

	      {hub && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
             <DashboardStatsCard
               title="Open POs"
               value={hub.active_po_count.toString()}
               icon={Package}
             />
             <DashboardStatsCard
               title="Historical Spend"
               value={formatMoney(hub.total_received_spend)}
               icon={Wallet}
               trend={{ value: "+8.2%", isUp: true }}
               color="green"
             />
             <DashboardStatsCard
               title="Lead Performance"
               value={leadLabel.split("(")[0].trim()}
               icon={Clock3}
             />
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-[28px] border border-app-border bg-app-surface/20 p-5 text-[10px] font-black uppercase tracking-widest text-app-text-muted backdrop-blur-md shadow-inner">
            {hub.vendor_code && (
              <div className="flex items-center gap-2">
                <span className="opacity-40">Code:</span>
                <span className="font-mono font-bold text-app-text">{hub.vendor_code}</span>
              </div>
            )}
            {hub.account_number && (
              <div className="flex items-center gap-2">
                <span className="opacity-40">Account:</span>
                <span className="font-mono font-bold text-app-text">{hub.account_number}</span>
              </div>
            )}
            {hub.payment_terms && (
              <div className="flex items-center gap-2 border-l border-app-border pl-6">
                <span className="opacity-40">Terms:</span>
                <span className="font-mono font-bold text-app-text">{hub.payment_terms}</span>
              </div>
            )}
            <div className="flex-1" />
            {hub.nuorder_brand_id ? (
              <div className="flex items-center gap-2 rounded-lg bg-indigo-500/10 px-2 py-1 text-indigo-600 border border-indigo-500/20">
                <ShieldCheck size={12} /> NUORDER: {hub.nuorder_brand_id}
              </div>
            ) : (
              <div className="flex items-center gap-2 opacity-50">
                <ShieldCheck size={12} /> UNLINKED
              </div>
            )}
          </div>
        </>
      )}

      <DashboardGridCard 
        title="Optional Brand Links"
        subtitle={`${brands.length} brand link${brands.length === 1 ? "" : "s"}`}
        icon={TrendingUp}
      >
        <div className="flex flex-wrap gap-3 mb-6">
          <input
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="Optional brand name..."
            className="flex-1 h-12 bg-app-surface shadow-inner border border-app-border rounded-2xl px-6 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 focus:border-app-accent transition-all"
          />
          <button
            type="button"
            onClick={() => void addBrand()}
            className="flex items-center gap-2 rounded-2xl bg-app-accent px-8 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 transition-all active:scale-95"
          >
            <Plus size={14} /> Add Brand
          </button>
        </div>
        <div className="rounded-[28px] border border-app-border/40 bg-app-bg/10 overflow-hidden backdrop-blur-md">
          <ul className="divide-y divide-app-border/40">
            {brands.length === 0 ? (
              <li className="px-6 py-8 text-xs font-bold text-app-text-muted opacity-40 text-center uppercase tracking-widest">
                No optional brand links yet.
              </li>
            ) : (
              brands.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-2 px-6 py-4 hover:bg-app-surface/40 transition-colors"
                >
                  <span className="text-sm font-black uppercase italic tracking-tight text-app-text">{b.brand}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setDeletingBrandId(b.id);
                      setShowDeleteConfirm(true);
                    }}
                    className="rounded-xl p-2 text-app-text-muted hover:bg-red-500/10 hover:text-red-500 transition-all shadow-sm"
                    aria-label={`Remove ${b.brand}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      </DashboardGridCard>

      <ConfirmationModal
        isOpen={showDeleteConfirm}
        title="Remove Brand Link?"
        message="Remove this optional brand link from the vendor? This does not delete products or purchase orders."
        confirmLabel="Remove Link"
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          setShowDeleteConfirm(false);
          setDeletingBrandId(null);
        }}
      />

      {showMergeModal && createPortal(
        <div className="ui-overlay-backdrop animate-in fade-in duration-300">
          <div className="ui-modal w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="relative h-32 bg-emerald-600 p-8 flex items-center justify-between">
               <div className="relative z-10 text-white">
                 <h3 className="text-2xl font-black uppercase tracking-tight">Merge Vendors</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Clean up duplicate vendor records</p>
               </div>
               <div className="relative z-10 h-16 w-16 rounded-[24px] bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white">
                 <Merge size={32} />
               </div>
               {/* Decorative background circle */}
               <div className="absolute -top-12 -right-12 h-48 w-48 rounded-full bg-emerald-500/40 blur-3xl" />
            </div>

            <div className="p-8">
              <p className="mb-8 text-xs font-bold text-app-text-muted leading-relaxed">
                This action will move products, historical POs, optional brand links, and promotions from the selected duplicate into the vendor you are keeping.
              </p>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Vendor to Keep</label>
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-50/50 px-4 py-4 text-sm font-black text-emerald-700 ring-1 ring-emerald-500/10">
                    <Building2 size={16} className="inline mr-2 opacity-50 align-text-bottom" />
                    {vendors.find(v => v.id === vendorId)?.name || 'Unknown'}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Duplicate to Remove</label>
                  <div className="relative">
                    <select 
                      value={sourceVendorId}
                      onChange={(e) => setSourceVendorId(e.target.value)}
                      className="ui-input w-full h-14 text-sm font-black pl-5 appearance-none bg-app-surface-2 border-app-border"
                    >
                      <option value="">Select source vendor...</option>
                      {vendors.filter(v => v.id !== vendorId).map(v => (
                        <option key={v.id} value={v.id}>{v.name} {v.vendor_code ? `[${v.vendor_code}]` : ''}</option>
                      ))}
                    </select>
                    <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-app-text-muted">
                      <Trash2 size={18} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-12 flex gap-3">
                 <button 
                   onClick={() => setShowMergeModal(false)}
                   className="flex-1 py-4 bg-app-surface-2 rounded-2xl text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-border/40 transition-all active:scale-95"
                 >
                   Cancel
                 </button>
                 <button 
                   disabled={!sourceVendorId || merging}
                   onClick={() => void handleMerge()}
                   className="flex-1 py-4 bg-emerald-600 rounded-2xl text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/30 hover:brightness-110 disabled:opacity-50 transition-all active:scale-95 border-b-4 border-emerald-800"
                 >
                   {merging ? 'Merging...' : 'Merge Vendors'}
                 </button>
              </div>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}

      {showVendorForm && createPortal(
        <div className="ui-overlay-backdrop animate-in fade-in duration-300">
          <div className="ui-modal w-full max-w-2xl overflow-hidden animate-in zoom-in-95 duration-300">
            <div className="border-b border-app-border bg-app-surface-2 px-8 py-6">
              <h3 className="text-xl font-black tracking-tight text-app-text">
                {editingVendorId ? "Edit Vendor" : "New Vendor"}
              </h3>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Vendor name is required. Codes, account numbers, and terms are optional but help receiving and integrations stay clear.
              </p>
            </div>
            <div className="grid gap-4 p-8 sm:grid-cols-2">
              {[
                ["name", "Vendor Name", "e.g. Michael Kors"],
                ["vendor_code", "Vendor Code", "Optional Counterpoint code"],
                ["email", "Email", "orders@example.com"],
                ["phone", "Phone", "(555) 123-4567"],
                ["account_number", "Account Number", "Optional vendor account"],
                ["payment_terms", "Payment Terms", "Net 30"],
              ].map(([key, label, placeholder]) => (
                <label key={key} className="space-y-1.5">
                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {label}
                  </span>
                  <input
                    value={vendorForm[key as keyof VendorFormState]}
                    onChange={(e) =>
                      setVendorForm((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }))
                    }
                    placeholder={placeholder}
                    className="ui-input h-12 text-sm font-bold"
                  />
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-3 border-t border-app-border bg-app-surface-2 px-8 py-5">
              <button
                type="button"
                onClick={() => {
                  setShowVendorForm(false);
                  setEditingVendorId(null);
                }}
                className="h-11 rounded-2xl bg-app-surface px-5 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-all hover:text-app-text active:scale-95"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingVendor || !vendorForm.name.trim()}
                onClick={() => void saveVendor()}
                className="h-11 rounded-2xl bg-app-accent px-6 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 disabled:opacity-40 active:scale-95"
              >
                {savingVendor ? "Saving..." : "Save Vendor"}
              </button>
            </div>
          </div>
        </div>,
        document.getElementById("drawer-root") || document.body
      )}
    </div>
  );
}
