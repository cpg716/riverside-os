import { useState, useEffect } from "react";
import { X, Plus, Trash2 } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

const DNA = {
  heading: "text-[10px] font-black uppercase tracking-widest text-slate-500"
};

interface ComboItem {
  match_type: "category" | "product" | "variant";
  match_id: string;
  qty_required: number;
}

interface Combo {
  id?: string;
  label: string;
  reward_amount: string;
  is_active: boolean;
  items: ComboItem[];
}

export default function ComboEditorModal({ 
  combo, 
  onClose, 
  onSaved 
}: { 
  combo: any; 
  onClose: () => void; 
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<any[]>([]);

  const [formData, setFormData] = useState<Combo>({
    id: combo?.id || null,
    label: combo?.label || "",
    reward_amount: combo?.reward_amount || "0",
    is_active: combo ? combo.is_active : true,
    items: combo?.items || [{ match_type: "category", match_id: "", qty_required: 1 }]
  });

  useEffect(() => {
    const loadCats = async () => {
      const res = await fetch(`${baseUrl}/api/staff/admin/category-commissions`, { headers: backofficeHeaders() });
      if (res.ok) setCategories(await res.json());
    };
    void loadCats();
  }, [backofficeHeaders]);

  const save = async () => {
    if (!formData.label) return toast("Bundle label required", "error");
    if (formData.items.length === 0) return toast("At least one item required", "error");
    if (formData.items.some(it => !it.match_id)) return toast("All items must have a target", "error");

    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/commissions/combos`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders()
        },
        body: JSON.stringify(formData)
      });
      
      if (!res.ok) throw new Error("Save failed");
      toast("Bundle saved", "success");
      onSaved();
    } catch (e) {
      toast("Failed to save bundle", "error");
    } finally {
      setLoading(false);
    }
  };

  const addItem = () => {
    setFormData({
      ...formData,
      items: [...formData.items, { match_type: "category", match_id: "", qty_required: 1 }]
    });
  };

  const removeItem = (idx: number) => {
    setFormData({
      ...formData,
      items: formData.items.filter((_, i) => i !== idx)
    });
  };

  const updateItem = (idx: number, patch: Partial<ComboItem>) => {
    const next = [...formData.items];
    next[idx] = { ...next[idx], ...patch };
    setFormData({ ...formData, items: next });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-lg rounded-3xl border border-white/10 bg-slate-900 shadow-2xl p-8 animate-in fade-in zoom-in duration-200">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h3 className="text-lg font-black tracking-tight text-white uppercase line-height-tight">
              {combo ? "Edit Bundle" : "Configure Combo"}
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-500/60 mt-1 font-mono">MULTI-ITEM REWARD ENGINE</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-slate-500 hover:bg-white/5 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6 max-h-[60vh] overflow-auto pr-2">
          <div className="space-y-1.5">
            <label className={DNA.heading}>Bundle Name</label>
            <input 
              className="w-full ui-input bg-slate-950/50 border-white/5 focus:border-emerald-500/40 text-sm py-3 px-4 rounded-xl text-white font-bold"
              placeholder="e.g. Full Suit + Shirt Package"
              value={formData.label}
              onChange={e => setFormData({...formData, label: e.target.value})}
            />
          </div>

          <div className="space-y-1.5">
            <label className={DNA.heading}>Reward Amount ($)</label>
            <div className="relative">
               <input 
                type="number"
                className="w-full ui-input bg-slate-950/50 border-white/5 text-sm py-3 pl-8 pr-4 rounded-xl font-mono tabular-nums text-emerald-400 font-black"
                placeholder="0.00"
                value={formData.reward_amount}
                onChange={e => setFormData({...formData, reward_amount: e.target.value})}
              />
              <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-600 font-bold">$</div>
            </div>
          </div>

          <div className="space-y-4">
             <div className="flex items-center justify-between">
                <label className={DNA.heading}>Requirements</label>
                <button 
                  type="button"
                  onClick={addItem}
                  className="text-[9px] font-black uppercase tracking-widest text-emerald-500 hover:text-emerald-400"
                >
                  <Plus size={10} className="inline mr-1" /> Add Requirement
                </button>
             </div>
             
             {formData.items.map((item, idx) => (
                <div key={idx} className="flex gap-3 items-end p-3 rounded-xl bg-slate-950/30 border border-white/5">
                   <div className="flex-1 space-y-1.5">
                      <select 
                        className="w-full ui-input bg-slate-900 border-white/5 text-[10px] py-2 px-3 rounded-lg text-white font-bold appearance-none"
                        value={item.match_id}
                        onChange={e => updateItem(idx, { match_id: e.target.value })}
                      >
                        <option value="">Select Category...</option>
                        {categories.map(c => (
                          <option key={c.category_id} value={c.category_id}>{c.category_name}</option>
                        ))}
                      </select>
                   </div>
                   <div className="w-20 space-y-1.5">
                      <input 
                        type="number"
                        min="1"
                        className="w-full ui-input bg-app-bg/50 border-white/5 text-[10px] py-2 px-3 rounded-lg text-center font-mono text-white"
                        value={item.qty_required}
                        onChange={e => updateItem(idx, { qty_required: parseInt(e.target.value) || 1 })}
                      />
                   </div>
                   <button 
                    type="button"
                    onClick={() => removeItem(idx)}
                    disabled={formData.items.length === 1}
                    className="p-2 text-slate-600 hover:text-red-500 disabled:opacity-0"
                   >
                     <Trash2 size={14} />
                   </button>
                </div>
             ))}
          </div>
        </div>

        <div className="flex items-center gap-3 pt-8 border-t border-white/5 mt-8">
           <button 
             type="button"
             disabled={loading}
             onClick={save}
             className="flex-1 bg-emerald-500 text-slate-950 font-black uppercase tracking-widest text-[10px] py-4 rounded-2xl shadow-xl shadow-emerald-500/20 hover:bg-emerald-400 active:scale-95 transition-all disabled:opacity-50"
           >
             {loading ? "Syncing Bundle..." : combo ? "Update Bundle" : "Activate Bundle"}
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
  );
}
