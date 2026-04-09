import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatMonth = (ym) => {
    if (!ym) return '';
    const [y, m] = ym.split('-');
    return `${MONTH_NAMES[parseInt(m) - 1]} '${y.slice(2)}`;
};

// --- Pure CSS Chart Components ---

const BarChart = ({ data, label, valueKey, labelKey, color = 'bg-navy-800', maxItems }) => {
    const items = maxItems ? data.slice(0, maxItems) : data;
    const max = Math.max(...items.map(d => d[valueKey]), 1);
    return (
        <div className="space-y-2">
            {items.map((item, i) => (
                <div key={i} className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-app-text w-20 truncate text-right" title={item[labelKey]}>
                        {item[labelKey] || 'N/A'}
                    </span>
                    <div className="flex-1 bg-app-surface-2 rounded-full h-7 overflow-hidden">
                        <div
                            className={`${color} h-full rounded-full flex items-center justify-end pr-2 transition-all duration-700`}
                            style={{ width: `${Math.max((item[valueKey] / max) * 100, 8)}%` }}
                        >
                            <span className="text-xs font-bold text-white">{item[valueKey]}</span>
                        </div>
                    </div>
                </div>
            ))}
            {items.length === 0 && (
                <p className="text-sm text-app-text-muted italic text-center py-4">No data yet</p>
            )}
        </div>
    );
};

const VerticalBarChart = ({ data }) => {
    const maxVal = Math.max(...data.map(d => d.members), ...data.map(d => d.parties), 1);
    return (
        <div className="flex items-end gap-1 h-44 px-2">
            {data.map((item, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-0">
                    <div className="w-full flex gap-0.5 items-end justify-center" style={{ height: '140px' }}>
                        <div
                            className="bg-navy-800 rounded-t w-2/5 min-w-[6px] transition-all duration-700"
                            style={{ height: `${Math.max((item.parties / maxVal) * 100, 3)}%` }}
                            title={`${item.parties} parties`}
                        />
                        <div
                            className="bg-gold-500 rounded-t w-2/5 min-w-[6px] transition-all duration-700"
                            style={{ height: `${Math.max((item.members / maxVal) * 100, 3)}%` }}
                            title={`${item.members} members`}
                        />
                    </div>
                    <span className="text-[9px] font-semibold text-app-text-muted leading-tight">{formatMonth(item.month)}</span>
                </div>
            ))}
            {data.length === 0 && (
                <p className="text-sm text-app-text-muted italic text-center py-4 w-full">No data yet</p>
            )}
        </div>
    );
};

const PipelineBar = ({ pipeline }) => {
    if (!pipeline || pipeline.totalMembers === 0) {
        return <p className="text-sm text-app-text-muted italic text-center py-4">No data yet</p>;
    }
    const stages = [
        { key: 'measured', label: 'Measured', color: 'bg-blue-500' },
        { key: 'ordered', label: 'Ordered', color: 'bg-indigo-500' },
        { key: 'received', label: 'Received', color: 'bg-purple-500' },
        { key: 'fitted', label: 'Fitted', color: 'bg-amber-500' },
        { key: 'pickedUp', label: 'Picked Up', color: 'bg-emerald-500' },
    ];
    const total = pipeline.totalMembers;
    return (
        <div className="space-y-3">
            {stages.map(stage => {
                const count = pipeline[stage.key] || 0;
                const pct = Math.round((count / total) * 100);
                return (
                    <div key={stage.key} className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-app-text w-20 text-right">{stage.label}</span>
                        <div className="flex-1 bg-app-surface-2 rounded-full h-6 overflow-hidden">
                            <div
                                className={`${stage.color} h-full rounded-full flex items-center justify-end pr-2 transition-all duration-700`}
                                style={{ width: `${Math.max(pct, 4)}%` }}
                            >
                                <span className="text-[10px] font-bold text-white">{pct}%</span>
                            </div>
                        </div>
                        <span className="text-xs text-app-text-muted w-14 text-right">{count}/{total}</span>
                    </div>
                );
            })}
        </div>
    );
};

// --- Stat Card ---
const StatCard = ({ icon, label, value, sub, color = 'text-app-text' }) => (
    <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm flex items-start gap-4">
        <div className={`w-11 h-11 rounded-lg flex items-center justify-center flex-shrink-0 ${color === 'text-app-text' ? 'bg-navy-50' : color === 'text-gold-600' ? 'bg-amber-50' : color === 'text-emerald-600' ? 'bg-emerald-50' : color === 'text-purple-600' ? 'bg-purple-50' : 'bg-app-surface-2'}`}>
            <Icon name={icon} size={20} className={color} />
        </div>
        <div className="min-w-0">
            <p className="text-xs font-semibold text-app-text-muted uppercase tracking-wide">{label}</p>
            <p className={`text-2xl font-extrabold ${color} leading-tight`}>{value}</p>
            {sub && <p className="text-xs text-app-text-muted mt-0.5">{sub}</p>}
        </div>
    </div>
);

// --- Main Component ---
const ReportsDashboard = () => {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                setLoading(true);
                const data = await api.getReportStats();
                setStats(data);
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };
        fetchStats();
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-navy-800 border-t-transparent" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="text-center py-20">
                <Icon name="AlertTriangle" size={32} className="text-red-400 mx-auto mb-3" />
                <p className="text-app-text">Failed to load reports: {error}</p>
            </div>
        );
    }

    const { popularStyles, salesStats, eligibleParties, monthlyTrends, leaderboard, pipeline, appointmentStats } = stats;

    const completionRate = pipeline && pipeline.totalMembers > 0
        ? Math.round((pipeline.pickedUp / pipeline.totalMembers) * 100)
        : 0;

    const attendanceRate = appointmentStats && appointmentStats.total > 0
        ? Math.round((appointmentStats.attended / (appointmentStats.attended + appointmentStats.missed)) * 100) || 0
        : 0;

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Stats Row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard
                    icon="Users"
                    label="Parties (90 Days)"
                    value={salesStats?.totalParties || 0}
                    sub={`${salesStats?.totalMembers || 0} members`}
                    color="text-app-text"
                />
                <StatCard
                    icon="CheckCircle"
                    label="Completion Rate"
                    value={`${completionRate}%`}
                    sub="Members fully processed"
                    color="text-emerald-600"
                />
                <StatCard
                    icon="Calendar"
                    label="Appointments"
                    value={appointmentStats?.upcoming || 0}
                    sub={`upcoming  ·  ${attendanceRate}% attendance`}
                    color="text-purple-600"
                />
                <StatCard
                    icon="Award"
                    label="Free Suit Eligible"
                    value={eligibleParties?.length || 0}
                    sub={`${eligibleParties?.reduce((sum, p) => sum + p.freeSuits, 0) || 0} free suits earned`}
                    color="text-gold-600"
                />
            </div>

            {/* Charts Row */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Monthly Trends */}
                <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-extrabold text-app-text uppercase tracking-wide flex items-center gap-2">
                            <Icon name="TrendingUp" size={16} className="text-gold-500" />
                            Monthly Trends
                        </h3>
                        <div className="flex items-center gap-3 text-[10px] font-semibold">
                            <span className="flex items-center gap-1">
                                <span className="w-2.5 h-2.5 bg-navy-800 rounded-sm" />Parties
                            </span>
                            <span className="flex items-center gap-1">
                                <span className="w-2.5 h-2.5 bg-gold-500 rounded-sm" />Members
                            </span>
                        </div>
                    </div>
                    <VerticalBarChart data={monthlyTrends || []} />
                </div>

                {/* Pipeline Completion */}
                <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm">
                    <h3 className="text-sm font-extrabold text-app-text uppercase tracking-wide mb-4 flex items-center gap-2">
                        <Icon name="Activity" size={16} className="text-gold-500" />
                        Pipeline Status (12 Months)
                    </h3>
                    <PipelineBar pipeline={pipeline} />
                </div>
            </div>

            {/* Bottom Row */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Popular Styles */}
                <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm">
                    <h3 className="text-sm font-extrabold text-app-text uppercase tracking-wide mb-4 flex items-center gap-2">
                        <Icon name="Star" size={16} className="text-gold-500" />
                        Top Styles
                    </h3>
                    <BarChart data={popularStyles || []} valueKey="count" labelKey="styleInfo" color="bg-navy-800" />
                </div>

                {/* Salesperson Leaderboard */}
                <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm">
                    <h3 className="text-sm font-extrabold text-app-text uppercase tracking-wide mb-4 flex items-center gap-2">
                        <Icon name="Trophy" size={16} className="text-gold-500" />
                        Salesperson Leaderboard
                    </h3>
                    <BarChart data={leaderboard || []} valueKey="partyCount" labelKey="salesperson" color="bg-gold-500" />
                </div>

                {/* Free Suit Eligible Parties */}
                <div className="bg-app-surface rounded-xl border border-app-border p-5 shadow-sm">
                    <h3 className="text-sm font-extrabold text-app-text uppercase tracking-wide mb-4 flex items-center gap-2">
                        <Icon name="Gift" size={16} className="text-gold-500" />
                        Free Suit Eligible
                    </h3>
                    {eligibleParties && eligibleParties.length > 0 ? (
                        <div className="space-y-2 max-h-52 overflow-y-auto custom-scrollbar">
                            {eligibleParties.map((p) => (
                                <div key={p.id} className="flex items-center justify-between py-2 px-3 bg-app-surface-2 rounded-lg">
                                    <div className="min-w-0">
                                        <p className="text-sm font-bold text-app-text truncate">{p.name}</p>
                                        <p className="text-[10px] text-app-text-muted">{p.memberCount} members · {p.date}</p>
                                    </div>
                                    <span className="bg-emerald-100 text-emerald-700 text-xs font-extrabold px-2.5 py-1 rounded-full flex-shrink-0">
                                        {p.freeSuits} free
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-app-text-muted italic text-center py-4">No eligible parties</p>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ReportsDashboard;
