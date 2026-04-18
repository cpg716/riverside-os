import { useState, useEffect, useCallback } from "react";
import { 
  Search, 
  X, 
  Users, 
  CheckCircle2, 
  Circle, 
  Calendar,
  ChevronRight,
  UserPlus,
  ArrowLeft,
  Heart
} from "lucide-react";

import { splitWeddingPartyWithMembers } from "../../lib/weddingPartyApiShape";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

export interface WeddingMember {
  id: string;
  first_name: string;
  last_name: string;
  role: string;
  status: string;
  measured: boolean;
  suit_ordered: boolean;
  customer_id: string;
  customer_email?: string;
  customer_phone?: string;
  balance_due?: string; // Added for group pay
  suit_variant_id?: string | null;
  is_free_suit_promo: boolean;
}

export interface WeddingParty {
  id: string;
  party_name: string;
  groom_name: string;
  bride_name?: string;
  event_date: string;
  members: WeddingMember[];
}

interface WeddingLookupDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  onLinkMember: (member: WeddingMember, partyName: string) => void;
  onGroupPay?: (members: WeddingMember[], partyName: string) => void;
  /** When set, choosing a party opens Group Pay mode for split deposits / payouts. */
  preferGroupPay?: boolean;
  onPreferGroupPayConsumed?: () => void;
  onOpenFullParty?: (partyId: string) => void;

}

export default function WeddingLookupDrawer({
  isOpen,
  onClose,
  onLinkMember,
  onGroupPay,
  preferGroupPay = false,
  onPreferGroupPayConsumed,
  onOpenFullParty,
}: WeddingLookupDrawerProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const posHeaders = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [search, setSearch] = useState("");
  const [parties, setParties] = useState<WeddingParty[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedParty, setSelectedParty] = useState<WeddingParty | null>(null);
  const [groupPayMode, setGroupPayMode] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [financials, setFinancials] = useState<Record<string, { balance_due: string }>>({});

  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  const fetchParties = useCallback(async (query: string) => {
    if (!query || query.length < 2) {
      setParties([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/weddings/parties?search=${encodeURIComponent(query)}&limit=20`, {
        headers: posHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        const rows = Array.isArray(data.data) ? data.data : [];
        const mapped = rows
          .map((item: unknown) => {
            const { party, members } = splitWeddingPartyWithMembers(item);
            if (!party?.id) return null;
            const groom = String(party.groom_name ?? "");
            return {
              id: String(party.id),
              party_name: String(party.party_name ?? `${groom} Wedding`),
              groom_name: groom,
              bride_name: party.bride_name != null ? String(party.bride_name) : undefined,
              event_date: String(party.event_date ?? ""),
              members: (members as Array<Record<string, unknown>>).map((m) => ({
                id: String(m.id),
                first_name: m.first_name ?? "",
                last_name: m.last_name ?? "",
                role: m.role ?? "",
                status: m.status ?? "",
                measured: Boolean(m.measured),
                suit_ordered: Boolean(m.suit_ordered),
                customer_id: String(m.customer_id ?? ""),
                customer_email: m.customer_email,
                customer_phone: m.customer_phone,
                suit_variant_id: m.suit_variant_id != null ? String(m.suit_variant_id) : null,
                is_free_suit_promo: Boolean(m.is_free_suit_promo),
              })),
            };
          })
          .filter(Boolean) as WeddingParty[];
        setParties(mapped);
      }
    } catch (err) {
      console.error("Failed to fetch wedding parties", err);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, posHeaders]);

  const fetchFinancials = useCallback(async (partyId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/weddings/parties/${partyId}/financial-context`, {
        headers: posHeaders(),
      });
      if (res.ok) {
        const data = await res.json() as { members: Array<{ wedding_member_id: string; balance_due: string }> };
        const map: Record<string, { balance_due: string }> = {};
        data.members.forEach((m) => {
          map[m.wedding_member_id] = { balance_due: m.balance_due };
        });
        setFinancials(map);
      }
    } catch (err) {
      console.error("Failed to fetch financials", err);
    }
  }, [baseUrl, posHeaders]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim()) fetchParties(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search, fetchParties]);

  useEffect(() => {
    if (selectedParty) {
      fetchFinancials(selectedParty.id);
    } else {
      setGroupPayMode(false);
      setSelectedMemberIds(new Set());
    }
  }, [selectedParty, fetchFinancials]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedParty(null);
      setSearch("");
      setGroupPayMode(false);
      setSelectedMemberIds(new Set());
    }
  }, [isOpen]);

  const toggleMember = (id: string) => {
    const next = new Set(selectedMemberIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedMemberIds(next);
  };

  const handleGroupPaySubmit = () => {
    if (!selectedParty || !onGroupPay) return;
    const selectedMembers = selectedParty.members.filter(m => selectedMemberIds.has(m.id));
    const membersWithBalances = selectedMembers.map(m => ({
      ...m,
      balance_due: financials[m.id]?.balance_due ?? "0.00"
    }));
    onGroupPay(membersWithBalances, selectedParty.party_name);
    onClose();
  };

  if (!isOpen) return null;

  const totalSelectedBalanceCents =
    selectedParty?.members
      .filter((m) => selectedMemberIds.has(m.id))
      .reduce(
        (sum, m) =>
          sum + parseMoneyToCents(financials[m.id]?.balance_due ?? "0"),
        0,
      ) ?? 0;

  return (
    <div className="fixed inset-0 z-[110] flex justify-end bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="h-full w-[450px] bg-app-surface shadow-2xl flex flex-col border-l border-app-border animate-in slide-in-from-right duration-300">
        {/* Header */}
        <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface sticky top-0 z-20">
          <div className="flex items-center gap-3">
            {selectedParty ? (
              <button 
                onClick={() => setSelectedParty(null)}
                className="h-9 w-9 flex items-center justify-center rounded-xl bg-app-surface-2 text-app-text-muted hover:text-app-text transition-all"
              >
                <ArrowLeft size={18} />
              </button>
            ) : (
              <div className="h-9 w-9 flex items-center justify-center rounded-xl bg-app-accent/10 text-app-accent">
                <Users size={20} />
              </div>
            )}
            <div>
              <h2 className="text-lg font-black uppercase italic tracking-tighter text-app-text leading-tight">
                {selectedParty ? selectedParty.party_name : "Wedding Lookup"}
              </h2>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
                {selectedParty ? `Event: ${selectedParty.event_date}` : "Search & Link Context"}
              </p>
            </div>
            {selectedParty && onOpenFullParty && (
               <button
                 type="button"
                 onClick={() => {
                   onOpenFullParty(selectedParty.id);
                   onClose();
                 }}
                 className="ml-auto h-9 px-4 flex items-center gap-2 rounded-xl bg-app-accent/10 border border-app-accent/20 text-[9px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent hover:text-white transition-all shadow-sm"
               >
                 <Heart size={14} fill="currentColor" />
                 Manage Party
               </button>
            )}
          </div>

          <button 
            onClick={onClose}
            className="h-10 w-10 flex items-center justify-center rounded-2xl bg-app-surface-2 text-app-text-muted hover:bg-red-500/10 hover:text-red-500 transition-all border border-app-border shadow-sm"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 no-scrollbar">
          {!selectedParty ? (
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" size={18} />
                <input 
                  autoFocus
                  type="text"
                  placeholder="Party Name, Groom, or Member..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="ui-input h-14 w-full pl-12 text-sm font-bold shadow-inner border-2 focus:border-app-accent tracking-wide"
                />
              </div>

              <div className="grid gap-2">
                {parties.length > 0 ? (
                  parties.map(party => (
                    <button
                      key={party.id}
                      onClick={() => {
                        setSelectedParty(party);
                        if (preferGroupPay && onGroupPay) {
                          setGroupPayMode(true);
                          onPreferGroupPayConsumed?.();
                        }
                      }}
                      className="group flex flex-col p-4 rounded-3xl border border-app-border bg-app-surface-2 hover:border-app-accent hover:bg-app-surface transition-all text-left shadow-sm"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[11px] font-black uppercase tracking-[0.15em] text-app-accent">Party</span>
                        <div className="flex items-center gap-1.5 rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-bold text-app-text-muted">
                          <Calendar size={10} />
                          {party.event_date}
                        </div>
                      </div>
                      <h3 className="text-base font-black italic tracking-tighter text-app-text leading-tight mb-1">{party.party_name}</h3>
                      <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest leading-none mb-3">
                        Groom: {party.groom_name} {party.bride_name ? `& ${party.bride_name}` : ""}
                      </p>
                      <div className="flex items-center justify-between mt-auto">
                        <div className="flex -space-x-2">
                          {[1,2,3].map(i => (
                            <div key={i} className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-app-surface-2 bg-app-border/40 text-[9px] font-bold text-app-text-muted">
                              {i}
                            </div>
                          ))}
                          {party.members.length > 3 && (
                            <div className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-app-surface-2 bg-app-accent text-[9px] font-bold text-white">
                              +{party.members.length - 3}
                            </div>
                          )}
                        </div>
                        <ChevronRight size={16} className="text-app-text-muted group-hover:text-app-accent transition-transform group-hover:translate-x-1" />
                      </div>
                    </button>
                  ))
                ) : loading ? (
                  <div className="flex h-32 items-center justify-center text-app-text-muted">
                    <div className="animate-spin h-5 w-5 border-2 border-app-accent border-t-transparent rounded-full" />
                  </div>
                ) : search.length >= 2 ? (
                  <div className="text-center py-12 opacity-40">
                    <p className="text-xs font-bold uppercase tracking-widest">No parties found</p>
                  </div>
                ) : (
                  <div className="text-center py-12 opacity-40">
                     <Users size={32} className="mx-auto mb-3 opacity-20" />
                     <p className="text-[10px] font-black uppercase tracking-[0.2em]">Enter 2+ characters to search</p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3 pb-32">
              <div className="flex items-center justify-between px-2 mb-4">
                 <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Party Members ({selectedParty.members.length})</span>
                 <button 
                  onClick={() => setGroupPayMode(!groupPayMode)}
                  className={`text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full transition-all ${
                    groupPayMode ? 'bg-app-accent text-white shadow-lg' : 'bg-app-surface-2 text-app-text-muted border border-app-border'
                  }`}
                 >
                   {groupPayMode ? "Cancel Group Pay" : "Enter Group Pay"}
                 </button>
              </div>

              {selectedParty.members.map(member => {
                const fin = financials[member.id];
                const balance = fin?.balance_due ?? "0.00";
                const isSelected = selectedMemberIds.has(member.id);

                return (
                  <div 
                    key={member.id}
                    onClick={() => groupPayMode && toggleMember(member.id)}
                    className={`flex flex-col p-4 rounded-[2rem] border transition-all cursor-pointer ${
                      isSelected && groupPayMode
                        ? "border-emerald-500 bg-emerald-50/50 shadow-md"
                        : "border-app-border bg-app-surface-2"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className={`h-10 w-10 flex items-center justify-center rounded-2xl border font-black italic transition-colors ${
                          isSelected && groupPayMode ? 'bg-emerald-500 text-white' : 'bg-app-surface border-app-border text-app-accent'
                        }`}>
                          {groupPayMode && isSelected ? <CheckCircle2 size={18} /> : `${member.first_name[0]}${member.last_name[0]}`}
                        </div>
                        <div>
                          <h4 className="text-sm font-black text-app-text leading-tight">{member.first_name} {member.last_name}</h4>
                          <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">{member.role}</p>
                        </div>
                      </div>
                      {!groupPayMode ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); onLinkMember(member, selectedParty.party_name); }}
                          className="flex h-10 items-center justify-center gap-2 rounded-2xl bg-app-accent px-4 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 hover:bg-app-accent-hover active:scale-95 transition-all"
                        >
                          <UserPlus size={14} />
                          Link
                        </button>
                      ) : (
                        <div className="text-right">
                          <p className="text-[10px] font-black text-app-text-muted uppercase opacity-40 leading-none mb-1">Balance</p>
                          <p
                            className={`text-sm font-black italic tracking-tighter ${
                              parseMoneyToCents(balance) > 0
                                ? "text-red-500"
                                : "text-emerald-600"
                            }`}
                          >
                            ${balance}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <StatusPill active={member.measured} label="Measured" />
                      <StatusPill active={member.suit_ordered} label="Ordered" />
                      <StatusPill
                        active={parseMoneyToCents(balance) <= 0}
                        label="Paid"
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer for Group Pay */}
        {groupPayMode && selectedMemberIds.size > 0 && (
          <div className="absolute bottom-0 inset-x-0 p-6 bg-app-surface border-t border-app-border shadow-[0_-20px_40px_rgba(0,0,0,0.1)] animate-in slide-in-from-bottom duration-300">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">Payout Group ({selectedMemberIds.size})</p>
                <p className="text-2xl font-black italic tracking-tighter text-app-text leading-none mt-1">
                  ${centsToFixed2(totalSelectedBalanceCents)}
                </p>
              </div>
              <button
                onClick={handleGroupPaySubmit}
                className="flex items-center gap-3 h-14 px-8 rounded-3xl bg-emerald-600 text-white font-black uppercase tracking-widest italic shadow-xl shadow-emerald-500/20 border-b-8 border-emerald-800 active:translate-y-1 active:border-b-4 transition-all"
              >
                Add Combined to Cart
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusPill({ active, label, icon }: { active: boolean; label: string; icon?: React.ReactNode }) {
  return (
    <div className={`flex items-center justify-center gap-1.5 rounded-full py-1.5 px-3 text-[9px] font-black uppercase tracking-widest transition-colors ${
      active 
        ? "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20" 
        : "bg-app-surface border border-app-border text-app-text-muted opacity-40 shadow-inner"
    }`}>
      {icon ? icon : active ? <CheckCircle2 size={10} /> : <Circle size={10} />}
      {label}
    </div>
  );
}
