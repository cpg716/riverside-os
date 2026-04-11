import { useCallback, useEffect, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";
import { 
  Ticket, 
  Clock3, 
  BarChart3, 
  Plus, 
  Zap, 
  Calendar, 
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Settings2
} from "lucide-react";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface EventRow {
  id: string;
  name: string;
  receipt_label: string;
  starts_at: string;
  ends_at: string;
  percent_off: string;
  is_active: boolean;
  scope_type: string;
  scope_category_id: string | null;
  scope_vendor_id: string | null;
}

interface VarRow {
  variant_id: string;
  sku: string;
  product_name: string;
}

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

function ymdLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function DiscountEventsPanel() {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canView = hasPermission("catalog.view");
  const canEdit = hasPermission("catalog.edit");

  const [rows, setRows] = useState<EventRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [vars, setVars] = useState<VarRow[]>([]);
  
  // Create / Edit Fields
  const [name, setName] = useState("");
  const [receiptLabel, setReceiptLabel] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [pct, setPct] = useState("25");
  const [scopeType, setScopeType] = useState<"variants" | "category" | "vendor">("variants");
  const [scopeCategoryId] = useState("");
  const [scopeVendorId] = useState("");
  
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [promoVendors, setPromoVendors] = useState<{ id: string; name: string }[]>([]);
  
  const [editScopeType, setEditScopeType] = useState<"variants" | "category" | "vendor">("variants");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editVendorId, setEditVendorId] = useState("");
  
  const [usageFrom, setUsageFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return ymdLocal(d);
  });
  const [usageTo, setUsageTo] = useState(() => ymdLocal(new Date()));
  const [usageRows, setUsageRows] = useState<
    {
      event_id: string;
      event_name: string;
      line_count: number;
      units_sold: number;
      subtotal_sum: string;
    }[]
  >([]);

  const load = useCallback(async () => {
    if (!canView) return;
    const res = await fetch(`${baseUrl}/api/discount-events`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      setRows([]);
      return;
    }
    setRows((await res.json()) as EventRow[]);
  }, [backofficeHeaders, canView]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      const [cRes, vRes] = await Promise.all([
        fetch(`${baseUrl}/api/categories`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/vendors`, { headers: backofficeHeaders() }),
      ]);
      if (cRes.ok) {
        const j = (await cRes.json()) as { id: string; name: string }[];
        setCategories(Array.isArray(j) ? j : []);
      }
      if (vRes.ok) {
        const j = (await vRes.json()) as { id: string; name: string }[];
        setPromoVendors(Array.isArray(j) ? j : []);
      }
    })();
  }, [canView, backofficeHeaders]);

  useEffect(() => {
    const r = rows.find((x) => x.id === sel);
    if (!r) return;
    const st = (r.scope_type ?? "variants") as "variants" | "category" | "vendor";
    setEditScopeType(st);
    setEditCategoryId(r.scope_category_id ?? "");
    setEditVendorId(r.scope_vendor_id ?? "");
  }, [sel, rows]);

  const loadUsageReport = useCallback(async () => {
    if (!canView) return;
    const p = new URLSearchParams();
    if (usageFrom.trim()) p.set("from", usageFrom.trim());
    if (usageTo.trim()) p.set("to", usageTo.trim());
    const res = await fetch(
      `${baseUrl}/api/discount-events/usage-report?${p.toString()}`,
      { headers: backofficeHeaders() },
    );
    if (!res.ok) {
      setUsageRows([]);
      toast("Analytical capture failed", "error");
      return;
    }
    setUsageRows((await res.json()) as {
      event_id: string;
      event_name: string;
      line_count: number;
      units_sold: number;
      subtotal_sum: string;
    }[]);
  }, [backofficeHeaders, canView, usageFrom, usageTo, toast]);

  useEffect(() => {
     void loadUsageReport();
  }, [loadUsageReport]);

  const loadVars = useCallback(
    async (id: string) => {
      const res = await fetch(`${baseUrl}/api/discount-events/${id}/variants`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        setVars([]);
        return;
      }
      setVars((await res.json()) as VarRow[]);
    },
    [backofficeHeaders],
  );

  useEffect(() => {
    if (!sel) {
      setVars([]);
      return;
    }
    void loadVars(sel);
  }, [sel, loadVars]);

  const createEvent = async () => {
    if (!canEdit) return;
    if (!name.trim() || !receiptLabel.trim() || !starts || !ends) {
      toast("Essential parameters missing for event creation", "info");
      return;
    }
    const p = Number.parseFloat(pct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      toast("Invalid percentage value", "error");
      return;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      receipt_label: receiptLabel.trim(),
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      percent_off: p.toFixed(2),
      scope_type: scopeType,
    };
    if (scopeType === "category") body.scope_category_id = scopeCategoryId;
    if (scopeType === "vendor") body.scope_vendor_id = scopeVendorId;

    const res = await fetch(`${baseUrl}/api/discount-events`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Registry rejected promotion", "error");
      return;
    }
    toast("Promotion localized and activated", "success");
    setName("");
    setReceiptLabel("");
    void load();
  };

  const patchSelectedScope = async () => {
    if (!canEdit || !sel) return;
    const body: Record<string, unknown> = { scope_type: editScopeType };
    if (editScopeType === "category") body.scope_category_id = editCategoryId;
    if (editScopeType === "vendor") body.scope_vendor_id = editVendorId;

    const res = await fetch(`${baseUrl}/api/discount-events/${sel}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
        toast("Scope mutation failed", "error");
        return;
    }
    toast("Event scope re-localized", "success");
    void load();
    void loadVars(sel);
  };

  const addVariant = async (v: VariantSearchResult) => {
    if (!canEdit || !sel) return;
    const res = await fetch(`${baseUrl}/api/discount-events/${sel}/variants`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ variant_id: v.variant_id }),
    });
    if (!res.ok) {
      toast("SKU binding failed", "error");
      return;
    }
    void loadVars(sel);
  };

  if (!canView) return <p className="p-8 text-app-text-muted">Security clearance insufficient.</p>;

  return (
    <div className="flex h-full flex-col gap-8 bg-app-surface p-6 overflow-hidden">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter text-app-text uppercase flex items-center gap-3">
             <Ticket size={32} className="text-app-accent" />
             Strategic Promotions
          </h2>
          <p className="text-xs font-bold text-app-text-muted mt-1 uppercase tracking-widest">
             Dynamic markdown engine and performance auditing
          </p>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 gap-8 lg:grid-cols-[1fr_400px]">
        <div className="flex flex-col gap-8 overflow-y-auto no-scrollbar pb-20">
          
          {/* ANALYTICS SNAPSHOT */}
          <section className="rounded-[2.5rem] border border-app-border bg-app-surface-2 p-8 shadow-inner">
             <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3 text-app-text-muted">
                    <BarChart3 size={18} />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">Promotion Performance</h4>
                </div>
                <div className="flex items-center gap-3">
                    <input 
                        type="date"
                        value={usageFrom}
                        onChange={(e) => setUsageFrom(e.target.value)}
                        className="ui-input h-10 w-36 text-[10px] font-black uppercase"
                    />
                    <ArrowRight size={14} className="text-app-text-muted" />
                    <input 
                        type="date"
                        value={usageTo}
                        onChange={(e) => setUsageTo(e.target.value)}
                        className="ui-input h-10 w-36 text-[10px] font-black uppercase"
                    />
                </div>
             </div>

             <div className="rounded-3xl border border-app-border bg-app-surface overflow-hidden shadow-sm">
                <table className="w-full text-left text-xs">
                    <thead className="bg-app-surface-2 border-b border-app-border">
                        <tr>
                            <th className="px-6 py-4 font-black uppercase tracking-widest text-app-text-muted">Event Label</th>
                            <th className="px-6 py-4 text-right font-black uppercase tracking-widest text-app-text-muted">Volume</th>
                            <th className="px-6 py-4 text-right font-black uppercase tracking-widest text-app-text-muted">Units</th>
                            <th className="px-6 py-4 text-right font-black uppercase tracking-widest text-app-text-muted">Capture</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border/40">
                        {usageRows.map((u) => (
                            <tr key={u.event_id} className="hover:bg-app-surface-2/50 transition-colors">
                                <td className="px-6 py-4 font-black uppercase italic text-app-text">{u.event_name}</td>
                                <td className="px-6 py-4 text-right font-mono font-bold text-app-text-muted">{u.line_count} lines</td>
                                <td className="px-6 py-4 text-right font-mono font-bold text-app-text-muted">{u.units_sold}</td>
                                <td className="px-6 py-4 text-right font-mono font-black text-emerald-600">${u.subtotal_sum}</td>
                            </tr>
                        ))}
                        {usageRows.length === 0 && (
                            <tr>
                                <td colSpan={4} className="px-6 py-12 text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40">No historical data in window</td>
                            </tr>
                        )}
                    </tbody>
                </table>
             </div>
          </section>

          {/* ACTIVE PROMOTIONS LIST */}
          <section className="space-y-4">
             <div className="flex items-center justify-between ml-2">
                <div className="flex items-center gap-3 text-app-text-muted">
                    <Clock3 size={18} />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">Promotion Registry</h4>
                </div>
                <span className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">{rows.length} Events Logged</span>
             </div>

             <div className="grid gap-4 md:grid-cols-2">
                {rows.map((r) => (
                    <button
                        key={r.id}
                        onClick={() => setSel(r.id)}
                        className={`group relative flex flex-col p-6 rounded-[2rem] border transition-all text-left ${
                            sel === r.id 
                            ? "border-app-accent bg-app-accent/5 ring-4 ring-app-accent/10 shadow-xl" 
                            : "border-app-border bg-app-surface hover:border-app-accent/40"
                        }`}
                    >
                        <div className="flex items-center justify-between mb-4">
                            <div className={`h-10 w-10 flex items-center justify-center rounded-2xl ${r.is_active ? 'bg-emerald-500 text-white' : 'bg-app-surface-2 text-app-text-muted'}`}>
                                <Zap size={20} className={r.is_active ? 'animate-pulse' : ''} />
                            </div>
                            <span className="font-mono text-2xl font-black italic tracking-tighter text-app-text">
                                -{Number(r.percent_off)}%
                            </span>
                        </div>
                        <h5 className="text-sm font-black uppercase tracking-tight text-app-text italic">{r.name}</h5>
                        <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest mt-1 opacity-60">{r.receipt_label}</p>
                        
                        <div className="mt-6 flex items-center gap-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
                            <div className="flex items-center gap-1">
                                <Calendar size={12} />
                                {new Date(r.starts_at).toLocaleDateString()} — {new Date(r.ends_at).toLocaleDateString()}
                            </div>
                            <div className="flex items-center gap-1 border-l border-app-border pl-4 uppercase italic">
                                {r.scope_type} Scope
                            </div>
                        </div>
                    </button>
                ))}
             </div>
          </section>
        </div>

        {/* SIDEBAR: CREATION & SCOPE */}
        <aside className="no-scrollbar overflow-y-auto pb-20 space-y-8">
           
           {/* NEW PROMOTION FORM */}
           <section className="rounded-[2.5rem] border border-app-border bg-app-surface p-8 shadow-sm">
                <div className="flex items-center gap-3 text-app-accent mb-6">
                    <Plus size={20} />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">Deploy Promotion</h4>
                </div>

                <div className="space-y-4">
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Internal Name</label>
                        <input className="ui-input h-12 text-xs font-bold" value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Receipt Descriptor</label>
                        <input className="ui-input h-12 text-xs font-bold" value={receiptLabel} onChange={(e) => setReceiptLabel(e.target.value)} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Activation</label>
                            <input className="ui-input h-10 text-[10px] font-black uppercase" type="datetime-local" value={starts} onChange={(e) => setStarts(e.target.value)} />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Expiration</label>
                            <input className="ui-input h-10 text-[10px] font-black uppercase" type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} />
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Markdown Percentage</label>
                        <div className="relative">
                            <input className="ui-input h-14 pl-10 text-xl font-black tabular-nums tracking-tighter" value={pct} onChange={(e) => setPct(e.target.value)} />
                            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted"><Zap size={18} /></div>
                        </div>
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Targeting Logic</label>
                        <select className="ui-input h-12 text-xs font-bold" value={scopeType} onChange={(e) => setScopeType(e.target.value as any)}>
                            <option value="variants">Selected SKUs</option>
                            <option value="category">Whole Category</option>
                            <option value="vendor">Primary Vendor</option>
                        </select>
                    </div>

                    <button 
                        onClick={createEvent}
                        className="w-full h-14 rounded-2xl bg-app-accent text-white text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-app-accent/20 hover:brightness-110 active:scale-95 transition-all mt-4"
                    >
                        Initialize Strategic Event
                    </button>
                </div>
           </section>

           {/* EDIT SCOPE (Only if selected) */}
           {sel && (
               <section className="rounded-[2.5rem] border border-app-border bg-violet-600 p-8 shadow-xl shadow-violet-600/20 text-white animate-in slide-in-from-right-4 duration-300">
                   <div className="flex items-center justify-between mb-6">
                        <div className="flex items-center gap-3 opacity-90">
                            <Settings2 size={20} />
                            <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">Resource Targeting</h4>
                        </div>
                        <button onClick={() => setSel(null)}><CheckCircle2 size={18} className="opacity-60 hover:opacity-100" /></button>
                   </div>
                   
                   <div className="space-y-4">
                        <select 
                            className="w-full h-12 bg-white/10 border border-white/20 rounded-xl px-4 text-xs font-bold text-white outline-none"
                            value={editScopeType} 
                            onChange={(e) => setEditScopeType(e.target.value as any)}
                        >
                            <option className="text-app-text" value="variants">Discrete Variant List</option>
                            <option className="text-app-text" value="category">Global Category Binding</option>
                            <option className="text-app-text" value="vendor">Vendor Asset Direct</option>
                        </select>

                        {editScopeType === "category" && (
                            <select 
                                className="w-full h-12 bg-white/10 border border-white/20 rounded-xl px-4 text-xs font-bold text-white outline-none"
                                value={editCategoryId} 
                                onChange={(e) => setEditCategoryId(e.target.value)}
                            >
                                <option className="text-app-text" value="">Select Classification...</option>
                                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                        )}

                        {editScopeType === "vendor" && (
                            <select 
                                className="w-full h-12 bg-white/10 border border-white/20 rounded-xl px-4 text-xs font-bold text-white outline-none"
                                value={editVendorId} 
                                onChange={(e) => setEditVendorId(e.target.value)}
                            >
                                <option className="text-app-text" value="">Select Vendor Entity...</option>
                                {promoVendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                            </select>
                        )}

                        {editScopeType === "variants" && (
                            <div className="space-y-4">
                                <VariantSearchInput 
                                    onSelect={addVariant} 
                                    className="ui-input-dark h-12 w-full" 
                                    placeholder="Add SKU to markdown list..." 
                                />
                                <div className="max-h-48 overflow-y-auto no-scrollbar space-y-2">
                                    {vars.map(v => (
                                        <div key={v.variant_id} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/10 group">
                                           <div className="flex flex-col">
                                              <span className="text-[10px] font-black uppercase tracking-tight">{v.product_name}</span>
                                              <span className="text-[8px] font-bold opacity-60 font-mono">{v.sku}</span>
                                           </div>
                                           <button 
                                                onClick={async () => {
                                                    await fetch(`${baseUrl}/api/discount-events/${sel}/variants/${v.variant_id}`, { method: "DELETE", headers: backofficeHeaders() });
                                                    void loadVars(sel!);
                                                }}
                                                className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500 rounded-lg transition-all"
                                           >
                                                <AlertCircle size={14} />
                                           </button>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <button 
                            onClick={patchSelectedScope}
                            className="w-full h-14 bg-white text-violet-600 rounded-2xl text-[10px] font-black uppercase tracking-widest shadow-xl hover:brightness-110 active:scale-95 transition-all"
                        >
                            Sync Targeting Logic
                        </button>
                   </div>
               </section>
           )}

           <section className="rounded-[2rem] border border-app-border bg-app-surface p-8 shadow-sm">
              <div className="flex items-center gap-3 text-app-text-muted mb-4">
                 <ShieldCheck size={18} />
                 <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">Governance</h4>
              </div>
              <p className="text-[10px] font-bold text-app-text-muted leading-relaxed">
                 Promotion events are automatically applied at POS based on the checkout timestamp. 
                 Global Category & Vendor bindings are computationally efficient but check your overlapping 
                 prompts in the Checkout Configuration.
              </p>
           </section>
        </aside>
      </main>
    </div>
  );
}
