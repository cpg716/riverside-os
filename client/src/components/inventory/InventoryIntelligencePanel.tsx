import { useState, useEffect } from "react";
import { Brain, ArrowRight, RotateCcw, TrendingUp, Zap, Layers, Activity } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";

interface Recommendation {
    variant_id: string;
    product_id: string;
    sku: string;
    product_name: string;
    recommendation_type: 'reorder' | 'clearance' | 'bundle' | 'price_review';
    confidence: number;
    velocity_45: number;
    stock_on_hand: number;
    suggested_action: string;
    reason: string;
}

export default function InventoryIntelligencePanel() {
    const { toast } = useToast();
    const [recs, setRecs] = useState<Recommendation[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchRecs = async () => {
            try {
                const res = await fetch("/api/inventory/recommendations", {
                    headers: {
                      "x-riverside-staff-id": localStorage.getItem("staff_id") || "",
                    }
                });
                if (!res.ok) throw new Error("Failed to fetch recommendations");
                const data = await res.json();
                setRecs(data);
            } catch (err) {
                console.error(err);
                toast("Could not load inventory intelligence data", "error");
            } finally {
                setLoading(false);
            }
        };
        fetchRecs();
    }, []);

    if (loading) {
        return (
            <div className="flex flex-col gap-10 animate-in fade-in duration-700">
                <div className="h-48 bg-app-surface-2 rounded-[40px] border-4 border-app-border animate-pulse" />
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {[1, 2, 3, 4, 5, 6, 7, 8].map(i => (
                        <div key={i} className="h-64 bg-app-surface-2 rounded-[32px] border-4 border-app-border animate-pulse" />
                    ))}
                </div>
            </div>
        );
    }

    const reorderCount = recs.filter(r => r.recommendation_type === 'reorder').length;
    const clearanceCount = recs.filter(r => r.recommendation_type === 'clearance').length;

    return (
        <div className="flex flex-col gap-10 animate-in fade-in slide-in-from-bottom-8 duration-1000">
            {/* Cinematic Intelligence Header */}
            <div className="bg-gradient-to-br from-blue-700 to-indigo-900 p-10 rounded-[48px] text-white shadow-4xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-96 h-96 bg-white/5 rounded-full -mr-32 -mt-32 blur-[100px] group-hover:bg-white/10 transition-all duration-1000" />
                <div className="absolute bottom-0 left-0 w-64 h-64 bg-app-accent/10 rounded-full -ml-20 -mb-20 blur-[80px]" />
                
                <div className="relative z-10 flex flex-col lg:flex-row items-center gap-10">
                    <div className="relative">
                        <div className="p-8 bg-white/10 backdrop-blur-2xl rounded-[32px] shadow-2xl ring-1 ring-white/20 relative z-10">
                            <Brain className="h-16 w-16 text-app-accent animate-pulse" strokeWidth={2.5} />
                        </div>
                        <div className="absolute inset-0 bg-app-accent blur-2xl opacity-20 animate-pulse" />
                    </div>
                    
                    <div className="flex-1 text-center lg:text-left">
                        <div className="flex items-center justify-center lg:justify-start gap-4 mb-4">
                            <span className="px-4 py-1.5 rounded-full bg-white/10 border border-white/20 text-[10px] font-black uppercase tracking-[0.4em] italic opacity-80">Predictive Engine v2.4</span>
                            <div className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_#10b981] animate-pulse" />
                        </div>
                        <h2 className="text-5xl font-black italic tracking-tighter mb-4 leading-none">Intelligence Plane</h2>
                        <p className="text-blue-100/70 text-lg font-bold max-w-xl italic leading-relaxed">
                            Autonomous replenishment vectors and stock-rescue heuristics derived from the previous 45-day operational velocity.
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4 w-full lg:w-auto">
                        <div className="px-8 py-6 bg-red-500/20 backdrop-blur-3xl rounded-[32px] border-4 border-red-500/20 text-center group/card transition-all hover:scale-105">
                            <p className="text-[10px] font-black uppercase text-red-300 tracking-[0.3em] mb-2 italic">Alert Buffers</p>
                            <p className="text-5xl font-black italic tracking-tighter">{reorderCount}</p>
                        </div>
                        <div className="px-8 py-6 bg-amber-500/20 backdrop-blur-3xl rounded-[32px] border-4 border-amber-500/20 text-center group/card transition-all hover:scale-105">
                            <p className="text-[10px] font-black uppercase text-amber-300 tracking-[0.3em] mb-2 italic">Rescue Nodes</p>
                            <p className="text-5xl font-black italic tracking-tighter">{clearanceCount}</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Insight Discovery Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
                {recs.length === 0 ? (
                    <div className="col-span-full py-32 text-center bg-app-bg border-8 border-app-border rounded-[48px] shadow-inner space-y-6">
                        <div className="h-24 w-24 rounded-full bg-app-bg border-8 border-app-border flex items-center justify-center mx-auto opacity-20">
                           <Activity size={48} />
                        </div>
                        <div className="space-y-2">
                          <p className="text-xl font-black text-app-text-muted uppercase tracking-[0.4em] italic">Heuristic Engine Idle</p>
                          <p className="text-xs font-bold text-app-text-muted opacity-60">Awaiting additional operational telemetry or index recalibration.</p>
                        </div>
                    </div>
                ) : (
                    recs.map(r => (
                        <div 
                            key={r.variant_id}
                            className="bg-app-bg border-4 border-app-border rounded-[40px] p-8 hover:shadow-4xl hover:border-app-accent/40 transition-all group relative overflow-hidden flex flex-col h-full translate-z-0"
                        >
                            {/* Alert Vector Shadow */}
                            <div className={`absolute top-0 right-0 w-32 h-32 blur-[60px] opacity-10 transition-opacity group-hover:opacity-20 ${
                                r.recommendation_type === 'reorder' ? 'bg-red-500' : 'bg-amber-500'
                            }`} />

                            <div className="flex items-start justify-between mb-8">
                                <div className={`p-4 rounded-2xl border-4 shadow-xl transition-transform group-hover:scale-110 ${
                                    r.recommendation_type === 'reorder' ? 'bg-red-500/10 border-red-500/20 text-red-500' : 'bg-amber-500/10 border-amber-500/20 text-amber-500'
                                }`}>
                                    {r.recommendation_type === 'reorder' ? <Zap size={24} strokeWidth={2.5} /> : <RotateCcw size={24} strokeWidth={2.5} />}
                                </div>
                                <div className="text-[10px] font-black text-app-text-muted uppercase tracking-[0.3em] italic opacity-40">
                                    {Math.round(r.confidence * 100)}% Logic Conf.
                                </div>
                            </div>

                            <div className="mb-8">
                                <h4 className="text-xl font-black text-app-text leading-none group-hover:text-app-accent transition-colors italic tracking-tighter truncate mb-2" title={r.product_name}>
                                    {r.product_name}
                                </h4>
                                <code className="inline-block px-3 py-1 bg-app-surface-2 border-2 border-app-border rounded-xl font-mono text-[11px] font-black text-app-text-muted uppercase tracking-widest">
                                    {r.sku}
                                </code>
                            </div>

                            <div className="grid grid-cols-2 gap-4 mb-8">
                                <div className="bg-app-bg p-5 rounded-[24px] border-4 border-app-border shadow-inner text-center">
                                    <p className="text-[10px] font-black text-app-text-muted uppercase tracking-[0.1em] mb-2 italic opacity-40">Buffer</p>
                                    <p className="text-3xl font-black italic tracking-tighter text-app-text">{r.stock_on_hand}</p>
                                </div>
                                <div className="bg-app-bg p-5 rounded-[24px] border-4 border-app-border shadow-inner text-center">
                                    <p className="text-[10px] font-black text-app-text-muted uppercase tracking-[0.1em] mb-2 italic opacity-40">Velocity</p>
                                    <p className="text-3xl font-black italic tracking-tighter text-app-text">{r.velocity_45.toFixed(0)}</p>
                                </div>
                            </div>

                            <div className="mt-auto space-y-4">
                                <div className={`p-5 rounded-[24px] border-4 flex flex-col gap-2 ${
                                  r.recommendation_type === 'reorder' ? 'bg-red-500/[0.03] border-red-500/10' : 'bg-amber-500/[0.03] border-amber-500/10'
                                }`}>
                                    <p className={`text-[10px] font-black uppercase tracking-[0.2em] italic flex items-center gap-2 ${
                                      r.recommendation_type === 'reorder' ? 'text-red-500' : 'text-amber-500'
                                    }`}>
                                        <ArrowRight size={14} strokeWidth={3} /> Vector Protocol
                                    </p>
                                    <p className="text-sm font-black italic text-app-text tracking-tight uppercase leading-none">{r.suggested_action}</p>
                                </div>
                                <p className="text-[11px] font-bold text-app-text-muted italic px-2 leading-relaxed opacity-60">
                                    {r.reason}
                                </p>
                            </div>

                            {/* Predictive Action Vector */}
                            <button 
                                className={`mt-10 w-full h-16 rounded-[24px] text-[10px] font-black uppercase tracking-[0.3em] transition-all italic flex items-center justify-center gap-3 active:scale-95 shadow-xl border-b-8 ${
                                  r.recommendation_type === 'reorder' 
                                    ? 'bg-app-accent border-app-accent/60 text-white hover:brightness-110' 
                                    : 'bg-app-surface-2 border-app-border text-app-text-muted hover:bg-app-bg hover:text-app-text'
                                }`}
                                onClick={() => toast(`Deploying vector for ${r.sku}...`, "info")}
                            >
                                {r.recommendation_type === 'reorder' ? <Layers size={18} /> : <TrendingUp size={18} />}
                                {r.recommendation_type === 'reorder' ? "Draft Reorder" : "Execute Markdown"}
                            </button>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
