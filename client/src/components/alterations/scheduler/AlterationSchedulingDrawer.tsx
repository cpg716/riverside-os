import { useState, useEffect } from "react";
import { X, Calendar, Clock, Scissors, Check, AlertTriangle, User, UserCheck } from "lucide-react";
import AlterationItemEditor from "./AlterationItemEditor";
import AlterationSmartScheduler from "./AlterationSmartScheduler";
import { getBaseUrl } from "../../../lib/apiConfig";

const baseUrl = getBaseUrl();

type AlterationRow = {
  id: string;
  customer_id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  wedding_member_id: string | null;
  status: string;
  due_at: string | null;
  fitting_at: string | null;
  appointment_id: string | null;
  total_units_jacket: number;
  total_units_pant: number;
  notes: string | null;
  item_description: string | null;
  work_requested: string | null;
};

type AlterationSchedulingDrawerProps = {
  alteration: AlterationRow;
  apiAuth: () => Record<string, string>;
  onClose: () => void;
  onUpdated: () => void;
};

export default function AlterationSchedulingDrawer({
  alteration,
  apiAuth,
  onClose,
  onUpdated,
}: AlterationSchedulingDrawerProps) {
  const [activeTab, setActiveTab] = useState<"items" | "schedule">("items");
  const [localAlt, setLocalAlt] = useState(alteration);
  const [saving, setSaving] = useState(false);

  const customerName = `${localAlt.customer_first_name ?? ""} ${localAlt.customer_last_name ?? ""}`.trim() || "Unassigned Customer";

  const updateAlteration = async (patch: Partial<AlterationRow>) => {
    setSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${localAlt.id}`, {
        method: "PATCH",
        headers: { ...apiAuth(), "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json();
        setLocalAlt(updated);
        onUpdated();
      }
    } catch (e) {
      console.error("Failed to update alteration", e);
    } finally {
      setSaving(false);
    }
  };

  const handleSlotSelected = async (date: string) => {
    // 1. Update fitting_at
    // 2. Create appointment (implicitly via backend or explicitly here)
    // For now, let's just update fitting_at.
    await updateAlteration({ fitting_at: `${date}T10:00:00Z` });
    setActiveTab("schedule");
  };

  useEffect(() => {
    // Scroll to top when drawer opens or alteration changes
    const scrollContainer = document.querySelector(".drawer-content-area");
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
  }, [alteration.id, activeTab]);

  return (
    <div className="fixed inset-0 z-[100] flex justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
      <div 
        className="w-full max-w-lg bg-app-surface border-l border-app-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-500 ease-out h-full top-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-white/10 bg-white/5">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-app-accent/10 border border-app-accent/20 flex items-center justify-center text-app-accent">
              <Scissors className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-black text-app-text tracking-tight">Plan & Schedule</h2>
              <p className="text-xs text-app-text-muted font-bold uppercase tracking-widest mt-0.5 flex items-center gap-1.5">
                <User className="w-3 h-3" />
                {customerName}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 rounded-full hover:bg-app-surface-2 text-app-text-muted hover:text-app-text transition-all"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Garment Info Sticky */}
        <div className="px-6 py-4 bg-app-surface-2 border-b border-app-border grid grid-cols-2 gap-6">
          <div>
            <p className="text-[10px] text-app-text-muted uppercase font-black tracking-widest">Garment</p>
            <p className="text-sm font-bold text-app-text mt-1 truncate">{localAlt.item_description || "Not specified"}</p>
          </div>
          <div>
            <p className="text-[10px] text-app-text-muted uppercase font-black tracking-widest">Initial Request</p>
            <p className="text-sm font-bold text-app-text mt-1 truncate">{localAlt.work_requested || "Not specified"}</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex p-1 gap-1 bg-app-surface-2 border-b border-app-border">
          <button
            onClick={() => setActiveTab("items")}
            className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === "items" ? "bg-app-surface text-app-text shadow-sm border border-app-border" : "text-app-text-muted hover:text-app-text hover:bg-app-surface"
            }`}
          >
            1. Define Work Items
          </button>
          <button
            onClick={() => setActiveTab("schedule")}
            className={`flex-1 py-3 rounded-lg text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === "schedule" ? "bg-app-surface text-app-text shadow-sm border border-app-border" : "text-app-text-muted hover:text-app-text hover:bg-app-surface"
            }`}
          >
            2. Schedule Slot
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar drawer-content-area">
          {activeTab === "items" ? (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <AlterationItemEditor 
                alterationId={localAlt.id} 
                apiAuth={apiAuth}
                onItemsChanged={() => {
                  // Reload alt to get new totals
                  void updateAlteration({});
                }}
              />
              
              <div className="pt-6 border-t border-white/5">
                <button 
                  onClick={() => setActiveTab("schedule")}
                  className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-black uppercase tracking-widest rounded-xl shadow-lg shadow-blue-500/20 transition-all flex items-center justify-center gap-2 group"
                >
                  Proceed to Scheduling
                  <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
              <div className="space-y-1">
                <label className="text-[10px] text-app-text-muted uppercase font-black tracking-widest">Promised Due Date</label>
                <input 
                  type="date"
                  className="w-full bg-app-surface border border-app-border rounded-xl px-4 py-3 text-app-text focus:outline-none focus:border-app-accent/50"
                  value={localAlt.due_at ? localAlt.due_at.split('T')[0] : ""}
                  onChange={e => updateAlteration({ due_at: e.target.value ? `${e.target.value}T17:00:00Z` : null })}
                />
              </div>

              <AlterationSmartScheduler 
                alterationId={localAlt.id}
                jacketUnits={localAlt.total_units_jacket}
                pantUnits={localAlt.total_units_pant}
                dueDate={localAlt.due_at}
                currentFittingAt={localAlt.fitting_at}
                apiAuth={apiAuth}
                onSlotSelected={handleSlotSelected}
              />
            </div>
          )}
        </div>

        {/* Footer Info */}
        <div className="p-6 border-t border-app-border bg-app-surface-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-2 h-2 rounded-full ${localAlt.fitting_at ? "bg-emerald-500 animate-pulse" : "bg-app-text-muted/20"}`} />
              <p className="text-[10px] text-app-text-muted uppercase font-bold tracking-widest">
                {localAlt.fitting_at ? "Fitting Scheduled" : "Waiting for Slot"}
              </p>
            </div>
            {localAlt.fitting_at && (
              <p className="text-xs font-black text-emerald-500">
                {new Date(localAlt.fitting_at).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChevronRight(props: any) {
  return (
    <svg 
      {...props} 
      xmlns="http://www.w3.org/2000/svg" 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6"/>
    </svg>
  );
}
