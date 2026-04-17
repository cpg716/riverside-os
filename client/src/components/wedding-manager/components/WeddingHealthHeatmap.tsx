import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api, type WmParty, type WmHealthScore } from '../lib/api';

interface PartyWithHealth {
    id: string;
    name: string;
    date: string;
    health: WmHealthScore | null;
}

interface WeddingHealthHeatmapProps {
    onPartyClick?: (party: PartyWithHealth) => void;
}

const WeddingHealthHeatmap: React.FC<WeddingHealthHeatmapProps> = ({ onPartyClick }) => {
    const [healthData, setHealthData] = useState<PartyWithHealth[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'critical' | 'concern'>('all');

    useEffect(() => {
        fetchHealth();
    }, []);

    const fetchHealth = async () => {
        setLoading(true);
        try {
            // Fetch next 90 days of parties
            const partiesRes = await api.getParties({ limit: 100, page: 1 });
            const scores = await Promise.all(
                partiesRes.data.map(async (party: WmParty) => {
                    try {
                        const health = await api.getWeddingHealth(party.id);
                        return { ...party, health } as PartyWithHealth;
                    } catch {
                        return { ...party, health: null } as PartyWithHealth;
                    }
                })
            );
            setHealthData(scores);
        } catch (err) {
            console.error("Failed to fetch health data:", err);
        } finally {
            setLoading(false);
        }
    };

    const filteredData = healthData.filter(p => {
        if (filter === 'all') return true;
        return p.health?.status === filter;
    });

    const stats = {
        critical: healthData.filter(p => p.health?.status === 'critical').length,
        concern: healthData.filter(p => p.health?.status === 'concern').length,
        healthy: healthData.filter(p => p.health?.status === 'healthy').length,
    };

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center p-20 gap-4 opacity-50">
                <div className="w-12 h-12 border-4 border-app-border border-t-gold-500 rounded-full animate-spin" />
                <p className="font-bold text-app-text-muted animate-pulse uppercase tracking-widest text-xs">Analyzing Party Health...</p>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 pb-20">
            {/* Quick Stats & Filters */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-app-surface p-4 rounded-xl border border-app-border shadow-sm">
                <div className="flex items-center gap-6 px-2">
                    <StatItem label="Critical" count={stats.critical} color="text-rose-600" active={filter === 'critical'} onClick={() => setFilter('critical')} />
                    <StatItem label="Concern" count={stats.concern} color="text-amber-600" active={filter === 'concern'} onClick={() => setFilter('concern')} />
                    <StatItem label="Healthy" count={stats.healthy} color="text-emerald-600" active={filter === 'all'} onClick={() => setFilter('all')} />
                </div>
                <button 
                    onClick={fetchHealth}
                    className="flex items-center gap-2 px-4 py-2 bg-app-surface-2 hover:bg-app-border/30 rounded-lg text-xs font-black transition-all border border-app-border"
                >
                    <Icon name="History" size={14} /> REFRESH ANALYSIS
                </button>
            </div>

            {filteredData.length === 0 ? (
                <div className="bg-app-surface border border-app-border border-dashed rounded-2xl p-20 text-center">
                    <p className="font-bold text-app-text-muted">No wedding parties matching the selected filter.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {filteredData.map((party) => (
                        <HealthCard key={party.id} party={party} onOpen={() => onPartyClick?.(party)} />
                    ))}
                </div>
            )}
        </div>
    );
};

const StatItem = ({ label, count, color, active, onClick }: { label: string, count: number, color: string, active: boolean, onClick: () => void }) => (
    <button 
        onClick={onClick}
        className={`flex flex-col items-start transition-all hover:scale-105 active:scale-95 ${active ? 'opacity-100' : 'opacity-40'}`}
    >
        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">{label}</span>
        <span className={`text-2xl font-black ${color}`}>{count}</span>
    </button>
);

const HealthCard = ({ party, onOpen }: { party: PartyWithHealth, onOpen: () => void }) => {
    const health = party.health;
    if (!health) return null;

    const statusConfig = {
        healthy: {
            theme: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700',
            badge: 'bg-emerald-500',
            icon: 'Check',
            shadow: 'hover:shadow-emerald-500/10'
        },
        concern: {
            theme: 'bg-amber-500/10 border-amber-500/20 text-amber-700',
            badge: 'bg-amber-500',
            icon: 'AlertCircle',
            shadow: 'hover:shadow-amber-500/10'
        },
        critical: {
            theme: 'bg-rose-500/10 border-rose-500/20 text-rose-700',
            badge: 'bg-rose-500',
            icon: 'Info',
            shadow: 'hover:shadow-rose-500/10'
        },
    };

    const config = statusConfig[health.status];

    return (
        <div className={`group p-6 rounded-2xl border flex flex-col gap-5 shadow-sm transition-all duration-300 ${config.theme} ${config.shadow} hover:-translate-y-1`}>
            <div className="flex justify-between items-start">
                <div className="space-y-1">
                    <h3 className="font-extrabold text-lg text-app-text group-hover:text-navy-900 transition-colors uppercase tracking-tight line-clamp-1">{party.name}</h3>
                    <div className="flex items-center gap-2 text-[11px] font-black opacity-70 uppercase tracking-widest">
                        <Icon name="Calendar" size={12} />
                        <span>{new Date(party.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span className="mx-1 opacity-30">•</span>
                        <span>{health.days_until_event > 0 ? `${health.days_until_event}d left` : 'Passed'}</span>
                    </div>
                </div>
                <div className={`px-2.5 py-1 rounded-md text-[10px] font-black uppercase text-white shadow-sm flex items-center gap-1.5 ${config.badge}`}>
                    {health.status}
                </div>
            </div>

            <div className="space-y-4">
                <ProgressBar label="Fittings / Measurements" current={health.measured_count} total={health.member_count} value={health.measurement_progress * 100} />
                <ProgressBar label="Financial Commitments" current={'Paid'} total={'Full'} value={health.payment_progress * 100} />
            </div>

            <div className="bg-white/40 group-hover:bg-white/60 transition-colors rounded-xl p-4 border border-black/5 text-xs font-bold leading-relaxed shadow-inner">
                <div className="flex items-center gap-2 mb-2 text-navy-900/60 font-black tracking-widest text-[9px] uppercase">
                    <Icon name={config.icon} size={14} />
                    <span>Decision Support Reason</span>
                </div>
                <p className="text-navy-900 leading-snug">{health.reason}</p>
            </div>
            
            <div className="flex gap-3 mt-auto">
                <button 
                    onClick={onOpen}
                    className="flex-1 bg-navy-900 hover:bg-navy-800 text-white py-3 rounded-xl text-xs font-black shadow-lg shadow-navy-900/20 transition-all active:scale-95 flex items-center justify-center gap-2"
                >
                    <Icon name="BookOpen" size={14} /> MANAGE PARTY
                </button>
                <button className="px-4 bg-app-surface-2 hover:bg-white text-app-text border border-app-border rounded-xl shadow-sm transition-all active:scale-95 group/btn">
                    <Icon name="MessageSquare" size={16} className="group-hover/btn:scale-110 transition-transform" />
                </button>
            </div>
        </div>
    );
};

const ProgressBar = ({ label, current, total, value }: { label: string, current: string | number, total: string | number, value: number }) => (
    <div className="space-y-1.5">
        <div className="flex justify-between text-[9px] font-black uppercase tracking-widest opacity-60">
            <span>{label}</span>
            <span>{current} / {total} — {Math.round(value)}%</span>
        </div>
        <div className="h-2 w-full bg-black/5 rounded-full overflow-hidden p-[1px]">
            <div 
                className="h-full bg-current rounded-full transition-all duration-1000 shadow-[0_0_8px_rgba(0,0,0,0.1)]" 
                style={{ width: `${value}%` }}
            />
        </div>
    </div>
);

export default WeddingHealthHeatmap;
