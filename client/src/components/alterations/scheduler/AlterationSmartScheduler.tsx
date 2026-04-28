import { useState, useEffect, useCallback } from "react";
import { Calendar, Clock, CheckCircle2, AlertTriangle, ChevronRight, Info } from "lucide-react";
import { getBaseUrl } from "../../../lib/apiConfig";
import { format } from "date-fns";

const baseUrl = getBaseUrl();

type SuggestedSlot = {
  date: string;
  score: number;
};


type AlterationSmartSchedulerProps = {
  alterationId: string;
  jacketUnits: number;
  pantUnits: number;
  dueDate: string | null;
  currentFittingAt: string | null;
  apiAuth: () => Record<string, string>;
  onSlotSelected: (date: string) => void;
};

export default function AlterationSmartScheduler({
  jacketUnits,
  pantUnits,
  dueDate,
  currentFittingAt,
  apiAuth,
  onSlotSelected,
}: AlterationSmartSchedulerProps) {
  const [slots, setSlots] = useState<SuggestedSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({
        jacket_units: jacketUnits.toString(),
        pant_units: pantUnits.toString(),
        due_date: dueDate!.split('T')[0],
      });
      
      const res = await fetch(`${baseUrl}/api/alterations/suggest-slots?${q}`, {
        headers: apiAuth(),
      });
      
      if (res.ok) {
        const data = await res.json();
        setSlots(data);
      } else {
        setError("No valid slots found for this capacity and due date.");
      }
    } catch {
      setError("Failed to calculate capacity slots.");
    } finally {
      setLoading(false);
    }
  }, [dueDate, jacketUnits, pantUnits, apiAuth]);

  useEffect(() => {
    if (dueDate && (jacketUnits > 0 || pantUnits > 0)) {
      fetchSlots();
    }
  }, [fetchSlots, dueDate, jacketUnits, pantUnits]);

  const selectSlot = (date: string) => {
    onSlotSelected(date);
  };

  if (!dueDate) {
    return (
      <div className="p-6 text-center border border-dashed border-white/10 rounded-xl bg-white/5">
        <Calendar className="w-8 h-8 text-white/20 mx-auto mb-2" />
        <p className="text-sm text-white/40">Set a Due Date first to find scheduling slots</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-14 bg-white/5 rounded-xl border border-white/10" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/90 flex items-center gap-2">
          <Clock className="w-4 h-4 text-purple-400" />
          Smart Slot Suggestions
        </h3>
        {slots.length > 0 && (
          <span className="text-[10px] text-white/40 uppercase font-bold">
            Based on {jacketUnits + pantUnits} units
          </span>
        )}
      </div>

      {error ? (
        <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5" />
          <p className="text-xs text-red-200/70">{error}</p>
        </div>
      ) : slots.length === 0 ? (
        <div className="p-6 text-center border border-dashed border-white/10 rounded-xl bg-white/5">
          <AlertTriangle className="w-6 h-6 text-yellow-500/50 mx-auto mb-2" />
          <p className="text-sm text-white/40 font-medium">Over Capacity</p>
          <p className="text-[11px] text-white/30 max-w-[200px] mx-auto mt-1">
            No days have enough open units before the due date. Manual override required.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {slots.map((slot, idx) => {
            const isSelected = currentFittingAt && format(new Date(currentFittingAt), 'yyyy-MM-dd') === slot.date;
            const dateObj = new Date(slot.date + 'T12:00:00'); // Midday to avoid TZ shifts
            
            return (
              <button
                key={slot.date}
                onClick={() => selectSlot(slot.date)}
                className={`w-full group flex items-center justify-between p-3 rounded-xl border transition-all ${
                  isSelected 
                    ? "bg-purple-600/20 border-purple-500 shadow-lg shadow-purple-500/10" 
                    : "bg-white/5 border-white/10 hover:border-white/30 hover:bg-white/10"
                }`}
              >
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-lg flex flex-col items-center justify-center ${
                    isSelected ? "bg-purple-500 text-white" : "bg-white/5 text-white/60 group-hover:text-white"
                  }`}>
                    <span className="text-[10px] uppercase font-bold leading-none">{format(dateObj, 'MMM')}</span>
                    <span className="text-lg font-bold leading-none mt-0.5">{format(dateObj, 'd')}</span>
                  </div>
                  <div className="text-left">
                    <p className={`text-sm font-semibold ${isSelected ? "text-white" : "text-white/80"}`}>
                      {format(dateObj, 'EEEE')}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {idx === 0 && !isSelected && (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 text-[9px] uppercase font-black">
                          Best Fit
                        </span>
                      )}
                      <span className="text-[10px] text-white/40 font-medium">
                        Suggested Finish Slot
                      </span>
                    </div>
                  </div>
                </div>
                
                {isSelected ? (
                  <CheckCircle2 className="w-5 h-5 text-purple-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/50 transition-colors" />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
        <Info className="w-3.5 h-3.5 text-blue-400 mt-0.5 shrink-0" />
        <p className="text-[10px] text-blue-200/50 leading-relaxed">
          The Smart Scheduler skips Thursdays to preserve capacity for last-minute repairs and ensures all work is completed at least 1 day before the due date.
        </p>
      </div>
    </div>
  );
}
