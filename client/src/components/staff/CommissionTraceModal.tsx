import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect } from "react";
import { Info, CheckCircle, ShieldCheck, X } from "lucide-react";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";

interface TraceData {
    event_id: string;
    transaction_id: string | null;
    transaction_line_id: string | null;
    salesperson_name: string;
    role: string | null;
    line_gross: string;
    base_rate: string;
    applied_rate: string;
    flat_spiff: string;
    adjustment_amount: string;
    total_commission: string;
    source: string;
    explanation: string;
    snapshot_json: Record<string, unknown>;
}

interface CommissionTraceModalProps {
    lineId: string;
    onClose: () => void;
    authHeaders: () => HeadersInit;
}

export default function CommissionTraceModal({ lineId, onClose, authHeaders }: CommissionTraceModalProps) {
    const [trace, setTrace] = useState<TraceData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchTrace = async () => {
            try {
                const baseUrl = getBaseUrl();
                const res = await fetch(`${baseUrl}/api/insights/commission-trace/${lineId}`, {
                    headers: authHeaders(),
                });
                if (!res.ok) throw new Error("Trace lookup failed");
                const data = await res.json();
                setTrace(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : "Failed to load trace");
            } finally {
                setLoading(false);
            }
        };
        if (lineId) fetchTrace();
    }, [lineId, authHeaders]);

    if (loading) return null; // Parent handles spinner if needed

    const money = (s: string) => formatUsdFromCents(parseMoneyToCents(s));
    const percent = (s: string) => `${(parseFloat(s) * 100).toFixed(1)}%`;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-navy-950/40 backdrop-blur-sm">
            <div className="bg-app-surface w-full max-w-lg rounded-[2rem] shadow-2xl border border-app-border overflow-hidden animate-in fade-in zoom-in duration-200">
                <div className="p-6 border-b border-app-border flex justify-between items-center bg-app-surface-2">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500 rounded-xl text-white">
                            <ShieldCheck size={20} />
                        </div>
                        <div>
                            <h3 className="text-sm font-black text-app-text uppercase tracking-widest">Truth Trace</h3>
                            <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-tighter">Commission Payout Transparency</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-app-border rounded-full transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="p-8">
                    {error ? (
                        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl text-rose-900 text-sm font-bold flex items-center gap-3">
                            <Info className="shrink-0" /> {error}
                        </div>
                    ) : trace ? (
                        <div className="space-y-6">
                            <div className="flex justify-between items-end border-b border-dashed border-app-border pb-6">
                                <div>
                                    <p className="text-[10px] font-black text-app-text-muted uppercase mb-1">Total Payout</p>
                                    <p className="text-4xl font-black text-app-text">{money(trace.total_commission)}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-[10px] font-black text-app-text-muted uppercase mb-1">Effective Rate</p>
                                    <div className="px-3 py-1 bg-emerald-500 text-white rounded-lg text-sm font-black shadow-sm">
                                        {percent(trace.applied_rate)}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="p-4 bg-app-surface-2 rounded-2xl border border-app-border">
                                    <p className="text-[9px] font-black text-app-text-muted uppercase mb-1">Base Rate ({trace.role ?? "adjustment"})</p>
                                    <p className="text-lg font-black text-app-text">{percent(trace.base_rate)}</p>
                                </div>
                                <div className="p-4 bg-app-surface-2 rounded-2xl border border-app-border">
                                    <p className="text-[9px] font-black text-app-text-muted uppercase mb-1">Incentive / Adjustment</p>
                                    <p className="text-lg font-black text-app-text">
                                        {money(String((parseFloat(trace.flat_spiff || "0") + parseFloat(trace.adjustment_amount || "0")).toFixed(2)))}
                                    </p>
                                </div>
                            </div>

                            <div className="p-5 bg-indigo-50/50 rounded-2xl border border-indigo-100 relative group overflow-hidden">
                                <div className="absolute top-0 right-0 p-3 text-indigo-200 group-hover:text-indigo-300 transition-colors">
                                    <CheckCircle size={24} />
                                </div>
                                <p className="text-[10px] font-black text-indigo-700 uppercase tracking-widest mb-2">Applied Logic: {trace.source}</p>
                                <p className="text-sm font-bold text-indigo-900 leading-relaxed pr-8">
                                    {trace.explanation}
                                </p>
                            </div>

                            <div className="text-center">
                                <p className="text-[9px] font-black text-app-text-muted uppercase tracking-[0.2em]">Audit Passed • Immutable record</p>
                            </div>
                        </div>
                    ) : null}
                </div>

                <div className="p-6 bg-app-surface-2 border-t border-app-border text-center">
                    <button 
                        onClick={onClose}
                        className="w-full py-3 bg-navy-900 text-white rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-navy-950 transition-all active:scale-95"
                    >
                        Close Explainer
                    </button>
                </div>
            </div>
        </div>
    );
}
