import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { Activity, Clock, ShieldCheck, ShieldAlert, Target, Zap } from "lucide-react";

const WeddingHealthHeatmap = ({ onPartyClick }) => {
    const [scores, setScores] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchHealth = async () => {
            try {
                const data = await api.getHealthPivot();
                // We want to sort critical/concern to the top
                const sorted = data.sort((a, b) => {
                    const statusOrder = { 'critical': 0, 'concern': 1, 'healthy': 2 };
                    if (statusOrder[a.status] !== statusOrder[b.status]) {
                        return statusOrder[a.status] - statusOrder[b.status];
                    }
                    return a.days_until_event - b.days_until_event;
                });
                setScores(sorted);
            } catch (err) {
                console.error("Failed to fetch health heatmap:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchHealth();
    }, []);

    if (loading) return (
        <div className="p-16 flex flex-col items-center justify-center space-y-10 animate-pulse">
            <div className="h-4 w-64 bg-app-border rounded-full" />
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 w-full">
                {[1,2,3,4].map(i => <div key={i} className="h-48 bg-app-surface/40 rounded-[32px] border-4 border-app-border" />)}
            </div>
        </div>
    );

    const getStatusColor = (status) => {
        switch (status) {
            case 'critical': return 'bg-rose-500 shadow-glow-rose';
            case 'concern': return 'bg-amber-500 shadow-glow-amber';
            case 'healthy': return 'bg-emerald-500 shadow-glow-emerald';
            default: return 'bg-app-text-muted';
        }
    };

    const getStatusLabel = (status) => {
        switch (status) {
            case 'critical': return 'Critical Shard';
            case 'concern': return 'Flux Detected';
            case 'healthy': return 'Stable Core';
            default: return 'Unknown';
        }
    };

    return (
        <div className="bg-transparent p-12 space-y-12">
            <div className="flex flex-col lg:flex-row items-center justify-between gap-10">
                <div className="flex flex-col">
                    <div className="flex items-center gap-3 mb-2">
                        <Activity className="text-app-accent" size={16} />
                        <span className="text-[10px] font-black uppercase tracking-[0.4em] text-app-text-muted opacity-40 italic">Predictive Intelligence</span>
                    </div>
                    <h3 className="text-4xl font-black italic tracking-tighter text-app-text uppercase">Registry Health Monitoring</h3>
                </div>
                
                <div className="flex bg-app-surface/40 border-4 border-app-border rounded-[24px] p-2 gap-4 backdrop-blur-xl">
                    <div className="flex items-center gap-3 px-4 py-1.5 rounded-xl bg-emerald-500/10 border-2 border-emerald-500/20 italic">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                        <span className="text-[9px] font-black uppercase tracking-widest text-emerald-500">Nominal</span>
                    </div>
                    <div className="flex items-center gap-3 px-4 py-1.5 rounded-xl bg-amber-500/10 border-2 border-amber-500/20 italic">
                        <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></div>
                        <span className="text-[9px] font-black uppercase tracking-widest text-amber-500">Concern</span>
                    </div>
                    <div className="flex items-center gap-3 px-4 py-1.5 rounded-xl bg-rose-500/10 border-2 border-rose-500/20 italic">
                        <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></div>
                        <span className="text-[9px] font-black uppercase tracking-widest text-rose-500">Critical</span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
                {scores.length === 0 ? (
                    <div className="col-span-full py-24 text-center space-y-8 opacity-20 grayscale scale-75">
                         <Target size={64} className="mx-auto" />
                         <p className="text-xl font-black italic uppercase tracking-tighter text-app-text">Registry Sparse — No Telemetry Detected</p>
                    </div>
                ) : (
                    scores.map(s => (
                        <button
                            key={s.wedding_id}
                            type="button"
                            onClick={() => onPartyClick(s.wedding_id)}
                            className="group relative flex flex-col p-8 bg-app-bg border-4 border-app-border rounded-[40px] shadow-2xl transition-all hover:border-app-accent hover:translate-y-[-4px] active:scale-95 text-left overflow-hidden italic animate-in slide-in-from-bottom-8 duration-700"
                        >
                            <div className="flex items-center justify-between mb-6 relative z-10">
                                <div className={`px-4 py-1 rounded-full text-[9px] font-black uppercase text-white shadow-xl ${getStatusColor(s.status)}`}>
                                    {getStatusLabel(s.status)}
                                </div>
                                <span className="text-[9px] font-black text-app-text-muted flex items-center gap-2 uppercase tracking-widest opacity-40">
                                    <Clock size={12} />
                                    {s.days_until_event}d Out
                                </span>
                            </div>

                            <div className="text-2xl font-black italic tracking-tighter text-app-text uppercase mb-6 truncate relative z-10">
                                {s.party_name || "Unidentified Core"}
                            </div>

                            <div className="space-y-6 relative z-10">
                                <div>
                                    <div className="flex justify-between text-[10px] font-black text-app-text-muted uppercase tracking-widest mb-2 italic">
                                        <span>Payment Sync</span>
                                        <span className="text-app-text tabular-nums text-sm">{Math.round(s.payment_progress * 100)}%</span>
                                    </div>
                                    <div className="h-3 w-full bg-app-border rounded-full overflow-hidden p-0.5">
                                        <div 
                                            className="h-full bg-app-accent rounded-full shadow-glow-sm transition-all duration-1000"
                                            style={{ width: `${s.payment_progress * 100}%` }}
                                        ></div>
                                    </div>
                                </div>

                                <div>
                                    <div className="flex justify-between text-[10px] font-black text-app-text-muted uppercase tracking-widest mb-2 italic">
                                        <span>Measure Ingress ({s.measured_count}/{s.member_count})</span>
                                        <span className="text-app-text tabular-nums text-sm">{Math.round(s.measurement_progress * 100)}%</span>
                                    </div>
                                    <div className="h-3 w-full bg-app-border rounded-full overflow-hidden p-0.5">
                                        <div 
                                            className="h-full bg-white rounded-full shadow-glow-lg transition-all duration-1000"
                                            style={{ width: `${s.measurement_progress * 100}%` }}
                                        ></div>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="absolute top-0 right-0 w-32 h-32 bg-app-accent/5 blur-3xl pointer-events-none" />
                        </button>
                    ))
                )}
            </div>
        </div>
    );
};

export default WeddingHealthHeatmap;
