import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { Building2, Clock3, Package, Plus, Search, Trash2, Wallet, ShieldCheck, Merge, TrendingUp } from "lucide-react";
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

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingBrandId, setDeletingBrandId] = useState<string | null>(null);
  
  const [showMergeModal, setShowMergeModal] = useState(false);
  const [sourceVendorId, setSourceVendorId] = useState("");
  const [merging, setMerging] = useState(false);

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

      {hub && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
             <DashboardStatsCard
               title="Active Pipeline"
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
        title="Brand Portfolio"
        subtitle={`${brands.length} active links`}
        icon={TrendingUp}
      >
        <div className="flex flex-wrap gap-3 mb-6">
          <input
            value={brandInput}
            onChange={(e) => setBrandInput(e.target.value)}
            placeholder="Link a brand name..."
            className="flex-1 h-12 bg-app-surface shadow-inner border border-app-border rounded-2xl px-6 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 focus:border-app-accent transition-all"
          />
          <button
            type="button"
            onClick={() => void addBrand()}
            className="flex items-center gap-2 rounded-2xl bg-app-accent px-8 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 transition-all active:scale-95"
          >
            <Plus size={14} /> Link Brand
          </button>
        </div>
        <div className="rounded-[28px] border border-app-border/40 bg-app-bg/10 overflow-hidden backdrop-blur-md">
          <ul className="divide-y divide-app-border/40">
            {brands.length === 0 ? (
              <li className="px-6 py-8 text-xs font-bold text-app-text-muted opacity-40 text-center uppercase tracking-widest">
                No linked brands yet.
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
        message="Are you sure you want to remove this brand from the vendor portfolio? This action cannot be undone."
        confirmLabel="Remove Link"
        variant="danger"
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => {
          setShowDeleteConfirm(false);
          setDeletingBrandId(null);
        }}
      />

      {showMergeModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-xl">
          <div className="w-full max-w-md overflow-hidden rounded-[40px] border border-app-border bg-app-surface shadow-2xl ring-1 ring-black/10 transition-all animate-in zoom-in-95 duration-300">
            <div className="relative h-32 bg-emerald-600 p-8 flex items-center justify-between">
               <div className="relative z-10 text-white">
                 <h3 className="text-2xl font-black uppercase tracking-tight">Consolidate</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Vendor Master Merge</p>
               </div>
               <div className="relative z-10 h-16 w-16 rounded-[24px] bg-white/20 backdrop-blur-md border border-white/30 flex items-center justify-center text-white">
                 <Merge size={32} />
               </div>
               {/* Decorative background circle */}
               <div className="absolute -top-12 -right-12 h-48 w-48 rounded-full bg-emerald-500/40 blur-3xl" />
            </div>

            <div className="p-8">
              <p className="mb-8 text-xs font-bold text-app-text-muted leading-relaxed">
                This action will move <span className="text-emerald-600 font-black">ALL</span> products, historical POs, brands, and promotions from the selected source into the active master record.
              </p>

              <div className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Master Record (Keeping)</label>
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-50/50 px-4 py-4 text-sm font-black text-emerald-700 ring-1 ring-emerald-500/10">
                    <Building2 size={16} className="inline mr-2 opacity-50 align-text-bottom" />
                    {vendors.find(v => v.id === vendorId)?.name || 'Unknown'}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-1">Source Record (Removing)</label>
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
                   {merging ? 'Merging...' : 'Execute Merge'}
                 </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
