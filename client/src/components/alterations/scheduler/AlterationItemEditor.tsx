import { useState, useEffect } from "react";
import { Plus, Trash2, Check, Scissors, Ruler } from "lucide-react";
import { getBaseUrl } from "../../../lib/apiConfig";

const baseUrl = getBaseUrl();

type AlterationOrderItem = {
  id: string;
  alteration_order_id: string;
  label: string;
  capacity_bucket: "jacket" | "pant" | "other";
  units: number;
  completed_at: string | null;
  created_at: string;
};

type AlterationItemEditorProps = {
  alterationId: string;
  apiAuth: () => Record<string, string>;
  onItemsChanged?: () => void;
};

const COMMON_TASKS = [
  { label: "Waist in/out", bucket: "pant", units: 2 },
  { label: "Seat in/out", bucket: "pant", units: 2 },
  { label: "Hem (Plain)", bucket: "pant", units: 1 },
  { label: "Hem (Cuff)", bucket: "pant", units: 2 },
  { label: "Shorten Sleeves", bucket: "jacket", units: 4 },
  { label: "Sides in/out", bucket: "jacket", units: 4 },
  { label: "Taper Legs", bucket: "pant", units: 3 },
  { label: "Shorten Jacket", bucket: "jacket", units: 6 },
];

export default function AlterationItemEditor({ 
  alterationId, 
  apiAuth, 
  onItemsChanged 
}: AlterationItemEditorProps) {
  const [items, setItems] = useState<AlterationOrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newItem, setNewItem] = useState({ label: "", bucket: "other" as const, units: 1 });

  useEffect(() => {
    fetchItems();
  }, [alterationId]);

  const fetchItems = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${alterationId}/items`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        const data = await res.json();
        setItems(data);
      }
    } catch (e) {
      console.error("Failed to fetch alteration items", e);
    } finally {
      setLoading(false);
    }
  };

  const addItem = async (itemData: { label: string; bucket: string; units: number }) => {
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${alterationId}/items`, {
        method: "POST",
        headers: { ...apiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: itemData.label,
          capacity_bucket: itemData.bucket,
          units: itemData.units,
        }),
      });
      if (res.ok) {
        fetchItems();
        onItemsChanged?.();
        setAdding(false);
        setNewItem({ label: "", bucket: "other", units: 1 });
      }
    } catch (e) {
      console.error("Failed to add item", e);
    }
  };

  const removeItem = async (itemId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${alterationId}/items/${itemId}`, {
        method: "DELETE",
        headers: apiAuth(),
      });
      if (res.ok) {
        fetchItems();
        onItemsChanged?.();
      }
    } catch (e) {
      console.error("Failed to remove item", e);
    }
  };

  const toggleComplete = async (item: AlterationOrderItem) => {
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${alterationId}/items/${item.id}`, {
        method: "PATCH",
        headers: { ...apiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify({ 
          completed_at: item.completed_at ? null : new Date().toISOString() 
        }),
      });
      if (res.ok) {
        fetchItems();
      }
    } catch (e) {
      console.error("Failed to toggle completion", e);
    }
  };

  if (loading) return <div className="p-4 text-center animate-pulse text-white/50">Loading tasks...</div>;

  const totalJacket = items.filter(i => i.capacity_bucket === "jacket").reduce((sum, i) => sum + i.units, 0);
  const totalPant = items.filter(i => i.capacity_bucket === "pant").reduce((sum, i) => sum + i.units, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-app-text flex items-center gap-2">
          <Scissors className="w-4 h-4 text-app-accent" />
          Work Items & Units
        </h3>
        <div className="flex gap-3 text-[10px] uppercase tracking-wider font-bold">
          <span className="text-blue-500">Jacket: {totalJacket}u</span>
          <span className="text-emerald-500">Pant: {totalPant}u</span>
        </div>
      </div>

      <div className="space-y-2">
        {items.map((item) => (
          <div 
            key={item.id} 
            className={`group flex items-center justify-between p-3 rounded-lg border transition-all ${
              item.completed_at 
                ? "bg-emerald-500/10 border-emerald-500/30 opacity-70" 
                : "bg-white/5 border-white/10 hover:border-white/20"
            }`}
          >
            <div className="flex items-center gap-3">
              <button 
                onClick={() => toggleComplete(item)}
                className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                  item.completed_at 
                    ? "bg-emerald-500 border-emerald-500 text-white" 
                    : "border-app-border hover:border-app-text"
                }`}
              >
                {item.completed_at && <Check className="w-3 h-3" />}
              </button>
              <div>
                <p className={`text-sm font-medium ${item.completed_at ? "line-through text-app-text-muted" : "text-app-text"}`}>
                  {item.label}
                </p>
                <p className="text-[10px] text-app-text-muted uppercase font-bold">
                  {item.capacity_bucket} • {item.units} unit{item.units !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            <button 
              onClick={() => removeItem(item.id)}
              className="p-1.5 opacity-0 group-hover:opacity-100 text-white/40 hover:text-red-400 transition-all"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}

        {items.length === 0 && !adding && (
          <div className="py-8 text-center border-2 border-dashed border-white/5 rounded-xl">
            <p className="text-sm text-white/30">No work items defined yet</p>
          </div>
        )}
      </div>

      {!adding ? (
        <div className="flex flex-wrap gap-2 pt-2">
          {COMMON_TASKS.map((task) => (
            <button
              key={task.label}
              onClick={() => addItem(task)}
              className="px-2.5 py-1.5 rounded-full bg-white/5 hover:bg-blue-500/20 border border-white/10 hover:border-blue-500/50 text-[11px] text-white/70 hover:text-white transition-all flex items-center gap-1.5"
            >
              <Plus className="w-3 h-3" />
              {task.label}
            </button>
          ))}
          <button
            onClick={() => setAdding(true)}
            className="px-2.5 py-1.5 rounded-full bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 text-[11px] text-blue-400 flex items-center gap-1.5"
          >
            <Plus className="w-3 h-3" />
            Custom Task
          </button>
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-app-surface-2 border border-app-border space-y-3 animate-in slide-in-from-top-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] text-app-text-muted uppercase font-bold">Label</label>
              <input 
                autoFocus
                className="w-full bg-app-surface border border-app-border rounded-lg px-3 py-2 text-sm text-app-text focus:outline-none focus:border-app-accent/50"
                value={newItem.label}
                onChange={e => setNewItem({...newItem, label: e.target.value})}
                placeholder="e.g. Hem Pants"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-white/40 uppercase font-bold">Bucket</label>
              <select 
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500/50"
                value={newItem.bucket}
                onChange={e => setNewItem({...newItem, bucket: e.target.value as any})}
              >
                <option value="jacket">Jacket (28u limit)</option>
                <option value="pant">Pant (24u limit)</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-3">
              <label className="text-[10px] text-white/40 uppercase font-bold">Units</label>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setNewItem({...newItem, units: Math.max(1, newItem.units - 1)})}
                  className="w-7 h-7 rounded bg-white/5 flex items-center justify-center hover:bg-white/10"
                >
                  -
                </button>
                <span className="w-8 text-center text-sm font-bold">{newItem.units}</span>
                <button 
                  onClick={() => setNewItem({...newItem, units: newItem.units + 1})}
                  className="w-7 h-7 rounded bg-white/5 flex items-center justify-center hover:bg-white/10"
                >
                  +
                </button>
              </div>
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => setAdding(false)}
                className="px-3 py-1.5 text-xs text-white/50 hover:text-white"
              >
                Cancel
              </button>
              <button 
                disabled={!newItem.label.trim()}
                onClick={() => addItem(newItem)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-xs font-bold text-white transition-all shadow-lg shadow-blue-500/20"
              >
                Add Item
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
