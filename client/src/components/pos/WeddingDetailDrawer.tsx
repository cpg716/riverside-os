import { useState, useEffect } from 'react';
import { 
  X, 
  Users, 
  CheckCircle2, 
  Circle, 
  ChevronRight, 
  ArrowLeft,
  CreditCard,
  Package,
  Scissors
} from 'lucide-react';
import { useWeddingSync, WeddingMember } from '../../hooks/useWeddingSync';
import { parseMoneyToCents } from '../../lib/money';
import { dispatchOpenRegisterFromWeddingManager } from '../../lib/weddingPosBridge';

interface WeddingDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  memberId?: string | null;
  partyId?: string | null;
  onRefresh?: () => void;
  /** If true, allows multi-selecting members to add to cart disbursements. */
  isSelectionMode?: boolean;
  onAddDisbursements?: (members: WeddingMember[]) => void;
}

export default function WeddingDetailDrawer({
  isOpen,
  onClose,
  memberId: initialMemberId,
  partyId: initialPartyId,
  onRefresh,
  isSelectionMode = false,
  onAddDisbursements
}: WeddingDetailDrawerProps) {
  const { 
    parties, 
    selectedParty, 
    financials,
    fetchParties, 
    fetchParty, 
    updateMember, 
    toggleStatus,
    setSelectedParty 
  } = useWeddingSync();

  const [search, setSearch] = useState('');
  const [activeMember, setActiveMember] = useState<WeddingMember | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) {
      if (initialPartyId) {
        fetchParty(initialPartyId);
      }
      if (!initialPartyId && search.length >= 2) {
        fetchParties(search);
      }
    }
  }, [isOpen, initialPartyId, fetchParties, fetchParty, search]);

  useEffect(() => {
    if (selectedParty && initialMemberId) {
      const m = selectedParty.members.find(m => m.id === initialMemberId);
      if (m) setActiveMember(m);
    }
  }, [selectedParty, initialMemberId]);

  const handleLinkToRegister = () => {
    if (!activeMember || !selectedParty) return;
    dispatchOpenRegisterFromWeddingManager({
      partyName: selectedParty.party_name,
      member: {
        ...activeMember,
        customer_email: activeMember.customer_email || null,
        customer_phone: activeMember.customer_phone || null,
        suit_variant_id: activeMember.suit_variant_id || null,
        is_free_suit_promo: activeMember.is_free_suit_promo
      }
    });
    onClose();
  };

  const handleConfirmSelection = () => {
    if (!selectedParty || !onAddDisbursements) return;
    const membersToAdd = selectedParty.members.filter(m => selectedMemberIds.has(m.id));
    onAddDisbursements(membersToAdd);
    onClose();
  };

  const toggleMemberSelection = (id: string) => {
    const next = new Set(selectedMemberIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedMemberIds(next);
  };

  const handleUpdateStatus = async (field: string, current: boolean | 'partial' | string | null) => {
    if (!activeMember) return;
    const success = await toggleStatus(activeMember.id, field, current);
    if (success && onRefresh) onRefresh();
  };

  const handleUpdateMeasure = async (field: string, value: string) => {
    if (!activeMember) return;
    const success = await updateMember(activeMember.id, { [field]: value });
    if (success && onRefresh) onRefresh();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex justify-end bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="h-full w-full max-w-[500px] bg-app-surface shadow-2xl flex flex-col border-l border-app-border animate-in slide-in-from-right duration-300">
        
        {/* Header */}
        <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface sticky top-0 z-20">
          <div className="flex items-center gap-3 text-app-text">
            {activeMember ? (
              <button 
                onClick={() => setActiveMember(null)}
                className="h-9 w-9 flex items-center justify-center rounded-xl bg-app-surface-2 text-app-text-muted hover:text-app-text transition-all"
              >
                <ArrowLeft size={18} />
              </button>
            ) : selectedParty && !initialPartyId ? (
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
              <h2 className="text-lg font-black uppercase italic tracking-tighter leading-tight">
                {activeMember ? `${activeMember.first_name} ${activeMember.last_name}` : selectedParty ? selectedParty.party_name : "Registry Details"}
              </h2>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">
                {activeMember ? activeMember.role : selectedParty ? `Event: ${selectedParty.event_date}` : "Registry Details"}
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="h-10 w-10 flex items-center justify-center rounded-2xl bg-app-surface-2 text-app-text-muted hover:bg-red-500/10 hover:text-red-500 transition-all border border-app-border shadow-sm"
          >
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 no-scrollbar space-y-6">
          {!selectedParty ? (
             <div className="space-y-4">
                <input 
                  type="text"
                  placeholder="Search Party Name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="ui-input h-14 w-full px-6 text-sm font-bold shadow-inner border-2 focus:border-app-accent tracking-wide"
                />
                <div className="grid gap-2">
                   {parties.map(p => (
                     <button 
                        key={p.id}
                        onClick={() => fetchParty(p.id)}
                        className="flex items-center justify-between p-4 rounded-3xl border border-app-border bg-app-surface-2 hover:border-app-accent hover:bg-app-surface transition-all text-left"
                     >
                        <div>
                          <h4 className="text-sm font-black italic tracking-tighter text-app-text">{p.party_name}</h4>
                          <p className="text-[10px] uppercase font-bold text-app-text-muted">{p.event_date}</p>
                        </div>
                        <ChevronRight size={16} className="text-app-text-muted" />
                     </button>
                   ))}
                </div>
             </div>
          ) : !activeMember ? (
            <div className="grid gap-3">
                {selectedParty.members.map(m => {
                  const fin = financials[m.id];
                  const balance = fin?.balance_due ?? "0.00";
                  const isSelected = selectedMemberIds.has(m.id);
                  const hasBalance = parseMoneyToCents(balance) > 0;

                  return (
                    <button 
                       key={m.id}
                       onClick={() => isSelectionMode ? toggleMemberSelection(m.id) : setActiveMember(m)}
                       className={`flex items-center justify-between p-4 rounded-[2rem] border transition-all text-left ${
                         isSelected 
                           ? "border-app-accent bg-app-accent/5 ring-2 ring-app-accent ring-inset" 
                           : "border-app-border bg-app-surface-2 hover:border-app-accent"
                       }`}
                    >
                       <div className="flex items-center gap-3">
                          {isSelectionMode ? (
                            <div className={`h-8 w-8 flex items-center justify-center rounded-xl border-2 transition-all ${isSelected ? 'bg-app-accent border-app-accent text-white' : 'border-app-border bg-app-surface'}`}>
                              {isSelected && <CheckCircle2 size={16} />}
                            </div>
                          ) : (
                            <div className="h-10 w-10 flex items-center justify-center rounded-2xl bg-app-surface border border-app-border text-app-accent font-black italic">
                               {m.first_name[0]}{m.last_name[0]}
                            </div>
                          )}
                          <div>
                             <h4 className="text-sm font-black text-app-text leading-tight">{m.first_name} {m.last_name}</h4>
                             <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">{m.role}</p>
                          </div>
                       </div>
                       <div className="text-right">
                          <p className="text-[10px] font-black text-app-text-muted uppercase opacity-40 leading-none mb-1">Balance</p>
                          <p className={`text-sm font-black italic tracking-tighter ${hasBalance ? "text-rose-500" : "text-emerald-500"}`}>
                            ${balance}
                          </p>
                       </div>
                    </button>
                  );
                })}
            </div>
          ) : (
            <div className="space-y-8 animate-in slide-in-from-right duration-300">
               {/* Member Stats/Status */}
               <div className="grid grid-cols-2 gap-3">
                  <div className="p-4 rounded-3xl bg-app-surface-2 border border-app-border">
                     <p className="text-[10px] font-black uppercase text-app-text-muted mb-1">Balance Due</p>
                     <p className={`text-2xl font-black italic tracking-tighter ${parseMoneyToCents(financials[activeMember.id]?.balance_due ?? "0") > 0 ? "text-rose-500" : "text-emerald-500"}`}>
                        ${financials[activeMember.id]?.balance_due ?? "0.00"}
                     </p>
                  </div>
                  <button 
                    onClick={handleLinkToRegister}
                    className="flex flex-col items-center justify-center p-4 rounded-3xl bg-app-accent text-white shadow-lg active:scale-95 transition-all"
                  >
                     <CreditCard size={20} className="mb-1" />
                     <span className="text-[10px] font-black uppercase tracking-widest">Open in Register</span>
                  </button>
               </div>

               {/* Workflow Status */}
               <div className="space-y-3">
                  <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted px-2">Order Progress</h3>
                  <div className="grid grid-cols-1 gap-2">
                     <StatusToggle 
                        active={activeMember.measured} 
                        label="Measured" 
                        date={activeMember.measure_date}
                        onClick={() => handleUpdateStatus('measured', activeMember.measured)} 
                     />
                     <StatusToggle 
                        active={activeMember.suit_ordered} 
                        label="Suit Ordered" 
                        date={activeMember.ordered_date}
                        onClick={() => handleUpdateStatus('suit_ordered', activeMember.suit_ordered)} 
                     />
                     <StatusToggle 
                        active={activeMember.received} 
                        label="Goods Received" 
                        date={activeMember.received_date}
                        onClick={() => handleUpdateStatus('received', activeMember.received)} 
                     />
                     <StatusToggle 
                        active={activeMember.pickup === true} 
                        label="Order Picked Up" 
                        date={activeMember.pickup_date}
                        onClick={() => handleUpdateStatus('pickup', activeMember.pickup)} 
                     />
                  </div>
               </div>

               {/* Measurements */}
               <div className="space-y-4">
                  <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted px-2 flex items-center gap-2">
                    <Scissors size={14} /> Measurements
                  </h3>
                  <div className="grid grid-cols-5 gap-2">
                     <MeasureInput label="Suit" value={activeMember.suit} onChange={(v) => handleUpdateMeasure('suit', v)} />
                     <MeasureInput label="Waist" value={activeMember.waist} onChange={(v) => handleUpdateMeasure('waist', v)} />
                     <MeasureInput label="Vest" value={activeMember.vest} onChange={(v) => handleUpdateMeasure('vest', v)} />
                     <MeasureInput label="Shirt" value={activeMember.shirt} onChange={(v) => handleUpdateMeasure('shirt', v)} />
                     <MeasureInput label="Shoe" value={activeMember.shoe} onChange={(v) => handleUpdateMeasure('shoe', v)} />
                  </div>
               </div>

               {/* Linked Style */}
               <div className="space-y-3">
                  <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted px-2 flex items-center gap-2">
                    <Package size={14} /> Linked Suit Style
                  </h3>
                  <div className="p-4 rounded-3xl bg-app-bg border border-app-border flex items-center justify-between">
                     <div className="flex items-center gap-3">
                        <div className="h-10 w-10 flex items-center justify-center rounded-2xl bg-app-surface border border-app-border text-app-accent">
                           <Package size={20} />
                        </div>
                        <div>
                           <p className="text-sm font-black text-app-text">{activeMember.suit_variant_id ? "Linked Style" : "Default Party Style"}</p>
                           <p className="text-[10px] font-bold text-app-text-muted uppercase">Stock Link: Active</p>
                        </div>
                     </div>
                     <button className="h-10 px-4 rounded-xl border border-app-border bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all">
                        Change
                     </button>
                  </div>
               </div>
            </div>
          )}
        </div>

        {/* Action Bar for Selection Mode */}
        {isSelectionMode && selectedParty && !activeMember && (
          <div className="p-6 border-t border-app-border bg-app-surface sticky bottom-0 z-20 animate-in slide-in-from-bottom duration-300">
             <button 
                onClick={handleConfirmSelection}
                disabled={selectedMemberIds.size === 0}
                className="ui-btn-primary h-14 w-full text-sm font-black uppercase tracking-[0.2em] shadow-glow-emerald hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
             >
                Add {selectedMemberIds.size} Members to Cart
             </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusToggle({ active, label, date, onClick }: { active: boolean; label: string; date?: string; onClick: () => void }) {
  return (
    <button 
      onClick={onClick}
      className={`flex items-center justify-between p-4 rounded-3xl border transition-all ${
        active 
          ? "border-emerald-500 bg-emerald-50/50 shadow-sm" 
          : "border-app-border bg-app-surface-2 opacity-60 grayscale"
      }`}
    >
      <div className="flex items-center gap-3">
         <div className={`h-8 w-8 flex items-center justify-center rounded-xl ${active ? 'bg-emerald-500 text-white' : 'bg-app-surface text-app-text-muted'}`}>
            {active ? <CheckCircle2 size={18} /> : <Circle size={18} />}
         </div>
         <div className="text-left">
            <p className={`text-sm font-black ${active ? 'text-emerald-900' : 'text-app-text-muted'}`}>{label}</p>
            {active && date && <p className="text-[10px] font-bold text-emerald-600 uppercase mt-0.5">{date}</p>}
         </div>
      </div>
      {active && <span className="text-[10px] font-black text-emerald-600 uppercase tracking-widest">Done</span>}
    </button>
  );
}

function MeasureInput({ label, value, onChange }: { label: string, value?: string, onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value || '');
  useEffect(() => { setLocal(value || ''); }, [value]);

  return (
    <div className="flex flex-col gap-1.5">
       <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted text-center">{label}</span>
       <input 
          type="text" 
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => onChange(local)}
          className="ui-input h-12 w-full text-center font-black italic text-lg bg-app-surface-2 border-app-border focus:border-app-accent"
       />
    </div>
  );
}
