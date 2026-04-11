import { useState, useCallback, useEffect } from "react";
import { 
  Percent, 
  Receipt, 
  Zap, 
  Settings, 
  Plus,
  Trash2,
  TrendingUp,
  Layers,
  X
} from "lucide-react";
import CommissionPayoutsPanel from "./CommissionPayoutsPanel"; 
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ComboEditorModal from "./ComboEditorModal";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

const DNA = {
  bg: "bg-slate-950",
  surface: "bg-slate-900 border-slate-800",
  accent: "text-emerald-500",
  accentBg: "bg-emerald-500",
  muted: "text-slate-400",
  heading: "text-[10px] font-black uppercase tracking-widest text-slate-500"
};

type TabId = "payouts" | "promos" | "products";

export default function CommissionManagerWorkspace() {
  const [activeTab, setActiveTab] = useState<TabId>("payouts");

  return (
    <div className={`flex flex-1 flex-col overflow-hidden ${DNA.bg} text-slate-200`}>
      <header className="flex items-center justify-between border-b border-white/5 bg-slate-900/50 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 shadow-inner">
            <Percent size={20} className="drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-white line-height-tight">Commission Manager</h1>
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/60">
              Staff Incentives & SPIFF Hub
            </p>
          </div>
        </div>

        <nav className="flex items-center gap-1 rounded-full bg-slate-950/50 p-1 border border-white/5">
          <TabButton 
            active={activeTab === "payouts"} 
            onClick={() => setActiveTab("payouts")}
            icon={<Receipt size={14} />}
            label="Payout Ledger"
          />
          <TabButton 
            active={activeTab === "promos"} 
            onClick={() => setActiveTab("promos")}
            icon={<Zap size={14} />}
            label="Promo Manager"
          />
          <TabButton 
            active={activeTab === "products"} 
            onClick={() => setActiveTab("products")}
            icon={<Settings size={14} />}
            label="Product Settings"
          />
        </nav>
      </header>

      <main className="flex-1 overflow-hidden p-6">
        {activeTab === "payouts" && (
          <div className="h-full flex flex-col gap-6">
             <div className="flex-1 overflow-auto rounded-2xl border border-white/5 bg-slate-900/40 p-1">
                <CommissionPayoutsPanel />
             </div>
          </div>
        )}

        {activeTab === "promos" && (
          <PromoManagerSection />
        )}

        {activeTab === "products" && (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 opacity-30">
             <TrendingUp size={48} className="mb-4" />
             <p className="text-[10px] font-black uppercase tracking-widest text-center">Specificity Overrides View Coming Soon<br/>(Matrix of base Category/Product rates)</p>
          </div>
        )}
      </main>
    </div>
  );
}

function TabButton({ 
  active, 
  onClick, 
  icon, 
  label 
}: { 
  active: boolean; 
  onClick: () => void; 
  icon: React.ReactNode; 
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
        active 
          ? "bg-emerald-500 text-slate-950 shadow-lg shadow-emerald-500/20" 
          : "text-slate-400 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PromoManagerSection() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [rules, setRules] = useState<any[]>([]);
  const [combos, setCombos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<any>(null);

  const [showComboModal, setShowComboModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState<any>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`${baseUrl}/api/staff/commissions/rules`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/staff/commissions/combos`, { headers: backofficeHeaders() })
      ]);
      if (rRes.ok) setRules(await rRes.json());
      if (cRes.ok) setCombos(await cRes.json());
    } catch (e) {
      toast("Failed to load promo rules", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const deleteRule = async (id: string, isCombo: boolean) => {
    if (!confirm("Are you sure you want to delete this rule?")) return;
    try {
      const endpoint = isCombo ? `combos/${id}` : `rules/${id}`;
      const res = await fetch(`${baseUrl}/api/staff/commissions/${endpoint}`, {
        method: "DELETE",
        headers: backofficeHeaders()
      });
      if (!res.ok) throw new Error("Delete failed");
      toast("Rule deleted", "success");
      await loadAll();
    } catch (e) {
      toast("Failed to delete rule", "error");
    }
  };

  return (
    <div className="grid h-full grid-cols-12 gap-6 overflow-hidden">
      <div className="col-span-8 flex flex-col gap-4 overflow-hidden">
        <div className="flex items-center justify-between">
          <h2 className={DNA.heading}>Active SPIFF Rules</h2>
          <button 
            type="button"
            onClick={() => { setEditingRule(null); setShowRuleModal(true); }}
            className="flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500/20 shadow-lg shadow-emerald-500/5 transition-all active:scale-95"
          >
            <Plus size={14} />
            Create Rule
          </button>
        </div>

        <div className="flex-1 overflow-auto rounded-2xl border border-white/5 bg-slate-900/40">
          <table className="w-full text-left text-[11px]">
            <thead className={`sticky top-0 ${DNA.bg} ${DNA.heading}`}>
              <tr>
                <th className="px-6 py-4">Description</th>
                <th className="px-4 py-4 text-center">Specificity</th>
                <th className="px-4 py-4 text-emerald-500 text-right">Incentive</th>
                <th className="px-4 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 text-slate-300">
              {loading ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-500 font-bold uppercase tracking-widest text-[9px]">Analyzing promo matrix...</td></tr>
              ) : rules.length === 0 ? (
                <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-500 uppercase font-black tracking-widest opacity-20 text-[10px]">No active SPIFF rules</td></tr>
              ) : rules.map(rule => (
                <tr key={rule.id} className="group hover:bg-emerald-500/5 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-bold text-white uppercase tracking-tight">{rule.label || "Unnamed Rule"}</div>
                    <div className="text-[9px] text-slate-500 font-mono tracking-tighter">{rule.id.slice(0,8)}</div>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <span className="rounded bg-slate-800 px-2 py-0.5 font-bold uppercase tracking-tighter text-slate-400 border border-white/5 text-[9px]">
                      {rule.match_type}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    {rule.override_rate && (
                      <div className="text-emerald-400/30 line-through text-[9px] font-bold">Standard %</div>
                    )}
                    <div className="font-mono font-black text-emerald-400 text-md whitespace-nowrap">
                      {rule.override_rate ? `${(parseFloat(rule.override_rate) * 100).toFixed(0)}%` : ""}
                      {rule.override_rate && parseFloat(rule.fixed_spiff_amount) > 0 ? " + " : ""}
                      {parseFloat(rule.fixed_spiff_amount) > 0 ? `$${parseFloat(rule.fixed_spiff_amount).toFixed(2)}` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex items-center justify-center">
                      <div className={`h-1.5 w-1.5 rounded-full ${rule.is_active ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]" : "bg-slate-700"}`} />
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right whitespace-nowrap">
                    <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        type="button"
                        onClick={() => { setEditingRule(rule); setShowRuleModal(true); }}
                        className="rounded p-1.5 text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-400 transition-colors"
                      >
                        <Settings size={14} />
                      </button>
                      <button 
                        type="button"
                        onClick={() => deleteRule(rule.id, false)}
                        className="rounded p-1.5 text-slate-500 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="col-span-4 flex flex-col gap-4 overflow-hidden">
        <h2 className={DNA.heading}>Combo Rewards</h2>
        <div className="flex-1 overflow-auto rounded-2xl border border-white/5 bg-slate-900/60 p-4 space-y-4">
           {combos.length === 0 && !loading && (
             <div className="rounded-xl border border-dashed border-white/10 p-6 text-center">
                <Layers className="mx-auto mb-3 text-slate-600 shadow-sm" size={24} />
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">No active bundles</p>
             </div>
           )}

           {combos.map(combo => (
             <div key={combo.id} className="rounded-xl border border-white/10 bg-slate-950/40 p-4 hover:border-emerald-500/20 transition-all group shadow-sm">
                <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
                  <span className="font-bold text-emerald-400 uppercase tracking-tighter text-[11px]">{combo.label}</span>
                  <span className="text-[12px] font-mono font-black text-emerald-500">${parseFloat(combo.reward_amount).toFixed(2)}</span>
                </div>
                <div className="space-y-2">
                  {combo.items?.map((it: any, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-[10px] text-slate-400">
                      <div className="flex items-center gap-2">
                         <div className="h-1 w-1 rounded-full bg-slate-700" />
                         <span className="capitalize text-slate-500 font-bold">{it.match_type}:</span>
                      </div>
                      <span className="font-mono text-slate-300 font-black">x{it.qty_required}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                   <button 
                     type="button"
                     onClick={() => deleteRule(combo.id, true)}
                     className="text-[9px] font-black uppercase tracking-widest text-red-500/60 hover:text-red-500 transition-colors"
                   >
                     Delete Bundle
                   </button>
                </div>
             </div>
           ))}

           <button 
             type="button"
             onClick={() => { setEditingCombo(null); setShowComboModal(true); }}
             className="w-full rounded-lg bg-emerald-500 py-3 text-[10px] font-black uppercase tracking-widest text-slate-950 shadow-lg shadow-emerald-500/20 hover:bg-emerald-400 transition-all active:scale-95"
           >
             Configure Combo
           </button>
        </div>
      </div>

      {showRuleModal && (
        <RuleEditorModal 
          rule={editingRule} 
          onClose={() => setShowRuleModal(false)} 
          onSaved={() => { setShowRuleModal(false); void loadAll(); }}
        />
      )}

      {showComboModal && (
        <ComboEditorModal 
          combo={editingCombo}
          onClose={() => setShowComboModal(false)}
          onSaved={() => { setShowComboModal(false); void loadAll(); }}
        />
      )}
    </div>
  );
}

function RuleEditorModal({ rule, onClose, onSaved }: { rule: any; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);
  
  const [formData, setFormData] = useState({
    id: rule?.id || null,
    label: rule?.label || "",
    match_type: rule?.match_type || "category",
    match_id: rule?.match_id || "",
    override_rate: rule?.override_rate ? (parseFloat(rule.override_rate) * 100).toFixed(0).toString() : "",
    fixed_spiff_amount: rule?.fixed_spiff_amount ? parseFloat(rule.fixed_spiff_amount).toString() : "0",
    is_active: rule ? rule.is_active : true
  });

  useEffect(() => {
    const loadCats = async () => {
      const res = await fetch(`${baseUrl}/api/staff/admin/category-commissions`, { headers: backofficeHeaders() });
      if (res.ok) setCategories(await res.json());
    };
    void loadCats();
  }, [backofficeHeaders]);

  const save = async () => {
    if (!formData.match_id) return toast("Select a target category/product", "error");
    if (!formData.label) return toast("Label required", "error");
    
    setLoading(true);
    try {
      const body = {
        ...formData,
        override_rate: formData.override_rate ? (parseFloat(formData.override_rate) / 100).toString() : null,
        fixed_spiff_amount: parseFloat(formData.fixed_spiff_amount) || 0
      };
      
      const res = await fetch(`${baseUrl}/api/staff/commissions/rules`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders()
        },
        body: JSON.stringify(body)
      });
      
      if (!res.ok) throw new Error("Save failed");
      toast("Rule saved", "success");
      onSaved();
    } catch (e) {
      toast("Failed to save rule", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-900 shadow-2xl p-8 animate-in fade-in zoom-in duration-200">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-lg font-black tracking-tight text-white uppercase line-height-tight">
              {rule ? "Edit Rule" : "Create SPIFF Rule"}
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/60 mt-1 font-mono">SPECIFICITY OVERRIDE ENGINE</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-white/5 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          <div className="space-y-1.5">
            <label className={DNA.heading}>Description / Label</label>
            <input 
              className="w-full ui-input bg-slate-950/50 border-white/5 focus:border-emerald-500/40 text-sm py-3 px-4 rounded-xl text-white font-bold"
              placeholder="e.g. Seasonal Silk Tie Bonus"
              value={formData.label}
              onChange={e => setFormData({...formData, label: e.target.value})}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div className="space-y-1.5">
                <label className={DNA.heading}>Specificity</label>
                <select 
                  className="w-full ui-input bg-slate-950/50 border-white/5 text-sm py-3 px-4 rounded-xl text-white font-bold appearance-none"
                  value={formData.match_type}
                  onChange={e => setFormData({...formData, match_type: e.target.value as any, match_id: ""})}
                >
                  <option value="category">Category</option>
                  <option value="product" disabled>Product (Coming)</option>
                  <option value="variant" disabled>Variant (Coming)</option>
                </select>
             </div>
             <div className="space-y-1.5">
                <label className={DNA.heading}>Target {formData.match_type}</label>
                {formData.match_type === "category" ? (
                  <select 
                    className="w-full ui-input bg-slate-950/50 border-white/5 text-sm py-3 px-4 rounded-xl text-white font-bold appearance-none"
                    value={formData.match_id}
                    onChange={e => setFormData({...formData, match_id: e.target.value})}
                  >
                    <option value="">Select Category...</option>
                    {categories.map(c => (
                      <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                    ))}
                  </select>
                ) : (
                  <div className="ui-input bg-slate-950/50 border-white/5 text-slate-600 text-[10px] italic flex items-center px-4 rounded-xl py-3 h-[46px]">
                    Picker disabled
                  </div>
                )}
             </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div className="space-y-1.5">
                <label className={DNA.heading}>Commission Rate %</label>
                <div className="relative">
                   <input 
                    type="number"
                    className="w-full ui-input bg-slate-950/50 border-white/5 text-sm py-3 pl-4 pr-10 rounded-xl font-mono tabular-nums text-emerald-400 font-black"
                    placeholder="Override"
                    value={formData.override_rate}
                    onChange={e => setFormData({...formData, override_rate: e.target.value})}
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-600 font-bold">%</div>
                </div>
             </div>
             <div className="space-y-1.5">
                <label className={DNA.heading}>Flat SPIFF Bonus</label>
                <div className="relative">
                   <input 
                    type="number"
                    className="w-full ui-input bg-slate-950/50 border-white/5 text-sm py-3 pl-8 pr-4 rounded-xl font-mono tabular-nums text-emerald-400 font-black"
                    placeholder="0.00"
                    value={formData.fixed_spiff_amount}
                    onChange={e => setFormData({...formData, fixed_spiff_amount: e.target.value})}
                  />
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600 font-bold">$</div>
                </div>
             </div>
          </div>

          <div className="flex items-center gap-3 pt-6">
             <button 
               type="button"
               disabled={loading}
               onClick={save}
               className="flex-1 bg-emerald-500 text-slate-950 font-black uppercase tracking-widest text-[10px] py-4 rounded-2xl shadow-xl shadow-emerald-500/20 hover:bg-emerald-400 active:scale-95 transition-all disabled:opacity-50"
             >
               {loading ? "Transmitting..." : rule ? "Apply Changes" : "Commit SPIFF Rule"}
             </button>
             <button 
               type="button"
               onClick={onClose}
               className="px-6 bg-slate-800 text-slate-400 font-black uppercase tracking-widest text-[10px] py-4 rounded-2xl hover:text-white transition-colors"
             >
               Exit
             </button>
          </div>
        </div>
      </div>
    </div>
  );
}
