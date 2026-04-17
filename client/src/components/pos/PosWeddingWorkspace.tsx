import { useState, useEffect } from 'react';
import { 
  Search, 
  Users, 
  Calendar, 
  ArrowLeft,
  Gem,
  Plus
} from 'lucide-react';
import { useWeddingSync } from '../../hooks/useWeddingSync';
import DashboardStatsCard from '../ui/DashboardStatsCard';
import DashboardGridCard from '../ui/DashboardGridCard';
import WeddingDetailDrawer from './WeddingDetailDrawer';

export function PosWeddingWorkspace() {
  const { 
    parties, 
    selectedParty, 
    loading, 
    financials,
    fetchParties, 
    fetchParty, 
    setSelectedParty 
  } = useWeddingSync();

  const [search, setSearch] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<'view' | 'selection'>('view');
  useEffect(() => {
    // Initial fetch and search debounce
    const t = setTimeout(() => {
      fetchParties(search);
    }, 300);
    return () => clearTimeout(t);
  }, [search, fetchParties]);

  const handleSelectParty = (id: string) => {
    fetchParty(id);
  };

  const handleOpenMember = (memberId: string) => {
    setActiveMemberId(memberId);
    setDrawerMode('view');
    setDrawerOpen(true);
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-app-bg animate-in fade-in duration-500">
      <div className="flex-1 overflow-y-auto no-scrollbar pb-20">
        <div className="max-w-[1400px] mx-auto p-6 md:p-8 space-y-8">
          
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {selectedParty ? (
                <button 
                  onClick={() => setSelectedParty(null)}
                  className="h-10 w-10 flex items-center justify-center rounded-2xl bg-app-surface-2 border border-app-border text-app-text-muted hover:text-app-text transition-all active:scale-95"
                >
                  <ArrowLeft size={20} />
                </button>
              ) : null}
              <div>
                <h1 className="text-3xl font-black italic tracking-tighter text-app-text leading-tight uppercase">
                  {selectedParty ? selectedParty.party_name : "Wedding Registry"}
                </h1>
                <p className="text-xs font-black uppercase tracking-[0.25em] text-app-text-muted opacity-60">
                  {selectedParty ? `Event Date: ${selectedParty.event_date}` : "Registry Dashboard"}
                </p>
              </div>
            </div>

            {!selectedParty && (
              <div className="relative w-full md:w-[400px]">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted transition-colors group-focus-within:text-app-accent" size={18} />
                <input 
                  type="text"
                  placeholder="Search Party, Groom, or Bride..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="ui-input h-14 w-full pl-12 text-sm font-bold shadow-inner border-2 focus:border-app-accent transition-all bg-app-surface"
                />
              </div>
            )}
          </div>

          {!selectedParty ? (
            <div className="space-y-6">
              {/* Management Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <DashboardStatsCard 
                  title="Upcoming Weddings"
                  value={String(parties.filter(p => new Date(p.event_date) > new Date()).length)}
                  icon={Calendar}
                  trend={{ value: "Next 30 Days", label: "window", isUp: true }}
                  color="blue"
                />
                <DashboardStatsCard 
                  title="Needs Attention"
                  value={String(parties.reduce((acc, p) => acc + p.members.filter(m => !m.measured || !m.suit_ordered).length, 0))}
                  icon={Users}
                  trend={{ value: "Needs Attention", label: "Pending", isUp: false }}
                  color="orange"
                />
                <DashboardStatsCard 
                  title="Ready for Pickup"
                  value={String(parties.reduce((acc, p) => acc + p.members.filter(m => m.received && m.pickup !== true).length, 0))}
                  icon={Plus}
                  trend={{ value: "Order Status", label: "Readiness", isUp: true }}
                  color="green"
                />
                <DashboardStatsCard 
                  title="Total Parties"
                  value={String(parties.length)}
                  icon={Gem}
                  trend={{ value: "Total Registry", label: "Active", isUp: true }}
                  color="purple"
                />
              </div>

              {/* Party List section header */}
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-black uppercase tracking-[0.3em] text-app-text-muted">
                  {search ? "Search Results" : "Upcoming Wedding Parties"}
                </h2>
              </div>

            {/* Party List */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {parties.map(party => (
                <button 
                  key={party.id}
                  onClick={() => handleSelectParty(party.id)}
                  className="text-left transition-transform active:scale-[0.98]"
                >
                  <DashboardGridCard 
                    title={party.party_name}
                    subtitle={`Groom: ${party.groom_name} ${party.bride_name ? `& ${party.bride_name}` : ""}`}
                    icon={Users}
                  >
                    <div className="mt-4 flex items-center justify-between">
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted bg-app-surface border border-app-border px-3 py-1.5 rounded-full">
                        <Calendar size={12} className="text-app-accent" />
                        {party.event_date}
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="text-[10px] font-black italic text-app-accent">{party.members.length} Members</span>
                        <div className="flex gap-1 mt-1">
                          {party.members.every(m => m.measured) && (
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title="All Measured" />
                          )}
                          {party.members.some(m => !m.suit_ordered) && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Pending Orders" />
                          )}
                        </div>
                      </div>
                    </div>
                  </DashboardGridCard>
                </button>
              ))}

                {parties.length === 0 && !loading && (
                   <div className="col-span-full py-24 text-center border-2 border-dashed border-app-border rounded-[3rem] bg-app-surface/30">
                      <Gem size={48} className="mx-auto mb-4 text-app-accent opacity-20" />
                      <h3 className="text-lg font-black italic tracking-tighter text-app-text mb-2">
                        {search ? "No Matches Found" : "No Wedding Parties Active"}
                      </h3>
                      <p className="text-xs font-black uppercase tracking-[0.2em] text-app-text-muted">
                        {search ? "Try adjusting your search terms" : "Search to manage weddings"}
                      </p>
                   </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-6 animate-in slide-in-from-bottom duration-500">
              {/* Party Header Actions */}
              <div className="flex items-center justify-between bg-app-surface p-4 rounded-[2rem] border border-app-border">
                <div className="flex items-center gap-4 px-2">
                   <div className="h-12 w-12 flex items-center justify-center rounded-2xl bg-blue-500/10 text-blue-600">
                      <Gem size={24} />
                   </div>
                   <div>
                      <h2 className="text-xl font-black italic tracking-tighter text-app-text uppercase">{selectedParty.party_name}</h2>
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">Event Date: {selectedParty.event_date}</p>
                   </div>
                </div>
                <div className="flex gap-2">
                   {/* This button essentially opens the register with multiple disbursement lines */}
                   <button 
                      onClick={() => {
                        setActiveMemberId(null);
                        setDrawerMode('selection');
                        setDrawerOpen(true);
                      }}
                      className="h-12 px-6 flex items-center gap-2 rounded-2xl bg-indigo-600 text-white text-xs font-black uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all shadow-lg shadow-indigo-600/20"
                   >
                     <Users size={16} />
                     Enter Group Pay
                   </button>
                </div>
              </div>

              {/* Member Grid for Selected Party */}
              <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted px-4">Member Registry</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {selectedParty.members.map(member => (
                  <button
                    key={member.id}
                    onClick={() => handleOpenMember(member.id)}
                    className="group relative flex flex-col p-5 rounded-[2.5rem] bg-app-surface border border-app-border hover:border-app-accent transition-all text-left shadow-sm hover:shadow-glow-xs active:scale-[0.98]"
                  >
                    <div className="flex items-center justify-between mb-4">
                       <div className="h-12 w-12 flex items-center justify-center rounded-2xl bg-app-surface-2 border border-app-border text-app-accent font-black italic shadow-inner group-hover:bg-app-accent group-hover:text-white transition-colors">
                         {member.first_name[0]}{member.last_name[0]}
                       </div>
                       <div className="flex flex-col items-end">
                         <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-1 rounded-full ${
                           member.status === 'ordered' ? 'bg-amber-100 text-amber-700' : 
                           member.status === 'pickup' ? 'bg-emerald-100 text-emerald-700' : 'bg-app-surface-2 text-app-text-muted'
                         }`}>
                           {member.status}
                         </span>
                         <span className="text-[14px] font-black italic text-app-text mt-1">
                           ${financials[member.id]?.balance_due ?? '0.00'}
                         </span>
                       </div>
                    </div>

                    <h3 className="text-lg font-black italic tracking-tighter text-app-text leading-tight group-hover:text-app-accent transition-colors">
                      {member.first_name} {member.last_name}
                    </h3>
                    <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest opacity-60">
                      {member.role}
                    </p>

                    <div className="mt-6 grid grid-cols-4 gap-2">
                       <StatusIndicator active={member.measured} label="M" />
                       <StatusIndicator active={member.suit_ordered} label="O" />
                       <StatusIndicator active={member.received} label="R" />
                       <StatusIndicator active={member.pickup === true} label="P" />
                    </div>
                  </button>
                ))}

                {/* Add Member Placeholder */}
                <button 
                  className="flex flex-col items-center justify-center p-8 rounded-[2.5rem] border-2 border-dashed border-app-border opacity-40 hover:opacity-100 hover:border-app-accent hover:bg-app-accent/5 transition-all text-app-text-muted hover:text-app-accent group"
                >
                  <div className="h-14 w-14 flex items-center justify-center rounded-3xl bg-app-surface-2 border border-app-border group-hover:border-app-accent transition-all mb-3 text-app-text-muted group-hover:text-app-accent">
                    <Plus size={24} />
                  </div>
                  <span className="text-[10px] font-black uppercase tracking-[0.2em]">Add Member</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <WeddingDetailDrawer 
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        memberId={activeMemberId}
        partyId={selectedParty?.id}
        onRefresh={() => selectedParty && fetchParty(selectedParty.id)}
        isSelectionMode={drawerMode === 'selection'}
      />
    </div>
  );
}

function StatusIndicator({ active, label }: { active: boolean; label: string }) {
  return (
    <div className={`flex items-center justify-center h-8 w-8 rounded-xl border text-[10px] font-black italic transition-all ${
      active 
        ? "bg-emerald-500 border-emerald-600 text-white shadow-glow-emerald-xs" 
        : "bg-app-surface-2 border-app-border text-app-text-muted opacity-40"
    }`}>
      {label}
    </div>
  );
}
