import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Heart, Search, CheckCircle2 } from "lucide-react";
import { weddingApi } from "../../lib/weddingApi";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

interface PartyRow {
  id: string;
  party_name: string;
  groom_name: string;
  event_date: string;
}

interface AttachOrderToWeddingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  orderId: string;
  customerName: string;
}

export default function AttachOrderToWeddingModal({
  isOpen,
  onClose,
  onSuccess,
  orderId,
  customerName,
}: AttachOrderToWeddingModalProps) {
  const { toast } = useToast();
  const { backofficeHeaders, staffDisplayName } = useBackofficeAuth();
  const headers = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);

  const [mode, setMode] = useState<"search" | "create">("search");
  const [parties, setParties] = useState<PartyRow[]>([]);
  const [partySearch, setPartySearch] = useState("");
  const [selectedPartyId, setSelectedPartyId] = useState<string | null>(null);
  const [role, setRole] = useState("Groomsman");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  // New Party Form
  const [newPartyName, setNewPartyName] = useState("");
  const [newGroomName, setNewGroomName] = useState("");
  const [newEventDate, setNewEventDate] = useState("");

  const fetchParties = useCallback(async () => {
    setLoading(true);
    try {
      // getParties returns a specialized paginated structure
      const data = await weddingApi.getParties({ search: partySearch, headers });
      // The API structure is { data: [ { party: {...}, members: [...] }, ... ] }
      setParties(data.data.map((p: { party: PartyRow }) => p.party));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [partySearch, headers]);

  useEffect(() => {
    if (isOpen && mode === "search") {
      void fetchParties();
    }
  }, [isOpen, mode, fetchParties]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "search" && !selectedPartyId) {
      toast("Please select a wedding party", "error");
      return;
    }
    if (mode === "create" && !newGroomName) {
      toast("Groom name is required", "error");
      return;
    }
    if (mode === "create" && !newEventDate) {
      toast("Event date is required", "error");
      return;
    }

    setBusy(true);
    try {
      await weddingApi.attachOrderToWedding(
        {
          orderId,
          weddingPartyId: mode === "search" ? selectedPartyId : null,
          newPartyInfo: mode === "create" ? {
            party_name: newPartyName || null,
            groom_name: newGroomName,
            event_date: newEventDate,
            party_type: "Wedding",
          } : null,
          role,
          actorName: staffDisplayName || "Riverside OS",
        },
        { headers }
      );
      toast("Wedding link saved.", "success");
      onSuccess();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to attach order", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!isOpen) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]" onClick={onClose}>
      <div 
        className="w-full max-w-xl rounded-3xl border border-app-border bg-app-surface shadow-2xl overflow-hidden flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent text-white shadow-lg shadow-app-accent/20">
              <Heart size={20} />
            </div>
            <div>
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase">
                Attach to Wedding
              </h3>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                {customerName} · link this order to the correct wedding party and member role.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-full bg-app-surface-3 p-2 text-app-text-muted hover:bg-app-accent hover:text-white transition-all">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto no-scrollbar p-8 space-y-6">
          <div className="flex p-1 bg-app-surface-2 rounded-2xl border border-app-border">
            <button
              type="button"
              onClick={() => setMode("search")}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${mode === "search" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}
            >
              Existing Party
            </button>
            <button
              type="button"
              onClick={() => setMode("create")}
              className={`flex-1 py-2 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all ${mode === "create" ? "bg-app-surface text-app-accent shadow-sm" : "text-app-text-muted hover:text-app-text"}`}
            >
              New Wedding Party
            </button>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Wedding Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="ui-input w-full text-sm font-bold bg-app-surface"
              >
                <option>Groom</option>
                <option>Groomsman</option>
                <option>Best Man</option>
                <option>Father of Groom</option>
                <option>Father of Bride</option>
                <option>Child</option>
                <option>Usher</option>
                <option>Other</option>
              </select>
            </div>

            {mode === "search" ? (
              <div className="space-y-4">
                <div className="relative group">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors" size={16} />
                  <input
                    value={partySearch}
                    onChange={(e) => setPartySearch(e.target.value)}
                    placeholder="Search by party name or groom..."
                    className="ui-input w-full pl-10 text-sm font-bold bg-app-surface"
                  />
                </div>

                <div className="max-h-60 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                  {parties.length === 0 && !loading && (
                    <p className="py-8 text-center text-xs font-black uppercase tracking-widest text-app-text-muted opacity-40">No parties found</p>
                  )}
                  {parties.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedPartyId(p.id)}
                      className={`w-full p-4 rounded-2xl border text-left transition-all ${selectedPartyId === p.id ? "border-app-accent bg-app-accent/10" : "border-app-border bg-app-surface-2/50 hover:border-app-accent/30 hover:bg-white shadow-sm"}`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="font-black uppercase tracking-tighter truncate text-app-text">
                            {p.party_name || `${p.groom_name}'s Wedding`}
                          </p>
                          <p className={`text-[10px] font-bold ${selectedPartyId === p.id ? "text-app-accent" : "text-app-text-muted"}`}>
                            {p.groom_name} • {p.event_date}
                          </p>
                        </div>
                        {selectedPartyId === p.id && <CheckCircle2 size={18} className="text-app-accent shrink-0" />}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Groom Name</label>
                  <input
                    value={newGroomName}
                    onChange={(e) => setNewGroomName(e.target.value)}
                    placeholder="Enter groom's full name..."
                    className="ui-input w-full text-sm font-bold bg-app-surface"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Event Date</label>
                  <input
                    type="date"
                    value={newEventDate}
                    onChange={(e) => setNewEventDate(e.target.value)}
                    className="ui-input w-full text-sm font-bold bg-app-surface"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Party Name (Optional)</label>
                  <input
                    value={newPartyName}
                    onChange={(e) => setNewPartyName(e.target.value)}
                    placeholder="e.g. Smith Wedding"
                    className="ui-input w-full text-sm font-bold bg-app-surface"
                  />
                </div>
              </div>
            )}
          </div>

          <div className="pt-6 border-t border-app-border flex justify-end gap-4">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="px-10 py-3 rounded-full bg-app-accent text-white text-[11px] font-black uppercase tracking-widest shadow-xl shadow-app-accent/20 hover:scale-[1.02] active:scale-95 disabled:opacity-50 transition-all"
            >
              {busy ? "Saving..." : "Save Wedding Link"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    root
  );
}
