import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { api, type WmParty, type WmReadinessDashboard, type WmReadinessSummary, type WmReadinessStatus } from '../lib/api';

interface WeddingReadinessDashboardProps {
    onPartyClick?: (party: WmParty) => void;
}

const STATUS_OPTIONS: Array<{ value: 'all' | WmReadinessStatus; label: string }> = [
    { value: 'all', label: 'All readiness' },
    { value: 'critical', label: 'Critical' },
    { value: 'at_risk', label: 'At risk' },
    { value: 'watch', label: 'Watch' },
    { value: 'safe', label: 'Safe' },
    { value: 'complete', label: 'Complete' },
];

const WINDOW_OPTIONS = [
    { value: 30, label: '30 days' },
    { value: 60, label: '60 days' },
    { value: 120, label: '120 days' },
    { value: 365, label: 'Year' },
];

const WeddingHealthHeatmap: React.FC<WeddingReadinessDashboardProps> = ({ onPartyClick }) => {
    const [dashboard, setDashboard] = useState<WmReadinessDashboard | null>(null);
    const [salespeople, setSalespeople] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [openingPartyId, setOpeningPartyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [statusFilter, setStatusFilter] = useState<'all' | WmReadinessStatus>('all');
    const [windowDays, setWindowDays] = useState(120);
    const [salesperson, setSalesperson] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    const dateRange = useMemo(() => {
        const start = new Date();
        const end = new Date(start);
        end.setDate(start.getDate() + windowDays);
        return {
            startDate: start.toISOString().split('T')[0],
            endDate: end.toISOString().split('T')[0],
        };
    }, [windowDays]);

    useEffect(() => {
        void api.getSalespeople().then(setSalespeople).catch(() => setSalespeople([]));
    }, []);

    const fetchReadiness = async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await api.getReadinessDashboard({
                ...dateRange,
                salesperson: salesperson || undefined,
                status: statusFilter === 'all' ? undefined : statusFilter,
                limit: 150,
            });
            setDashboard(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load wedding readiness.');
            setDashboard(null);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void fetchReadiness();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateRange.startDate, dateRange.endDate, salesperson, statusFilter]);

    const openParty = async (summary: WmReadinessSummary) => {
        if (!onPartyClick) return;
        setOpeningPartyId(summary.wedding_party_id);
        try {
            const party = await api.getParty(summary.wedding_party_id);
            if (party) onPartyClick(party);
        } finally {
            setOpeningPartyId(null);
        }
    };

    const stats = dashboard ?? {
        safe_count: 0,
        watch_count: 0,
        at_risk_count: 0,
        critical_count: 0,
        complete_count: 0,
        parties: [],
    };
    const filteredParties = useMemo(() => {
        const query = searchTerm.trim().toLowerCase();
        if (!query) return stats.parties;
        return stats.parties.filter((party) => {
            const blockerText = party.blockers
                ?.map((blocker) => `${blocker.label} ${blocker.explanation} ${blocker.next_safe_action}`)
                .join(' ') ?? '';
            return [
                party.party_name,
                party.event_date,
                party.salesperson,
                party.status,
                party.next_safe_action,
                blockerText,
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(query);
        });
    }, [searchTerm, stats.parties]);

    return (
        <div className="space-y-6 pb-20" data-testid="wedding-readiness-dashboard">
            <div className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-sm">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Wedding readiness intelligence</p>
                        <h2 className="mt-1 text-2xl font-black text-app-text">Readiness Dashboard</h2>
                        <p className="mt-2 max-w-3xl text-sm font-semibold text-app-text-muted">
                            At-risk parties first. Scores are read from wedding members, lifecycle status, vendor ordering, balances, and pickup readiness.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={fetchReadiness}
                        className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-4 py-2 text-xs font-black uppercase tracking-widest text-app-text transition-all hover:bg-app-surface"
                    >
                        <Icon name="History" size={14} /> Refresh
                    </button>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                    <SummaryStat label="Critical" count={stats.critical_count} tone="rose" />
                    <SummaryStat label="At risk" count={stats.at_risk_count} tone="amber" />
                    <SummaryStat label="Watch" count={stats.watch_count} tone="blue" />
                    <SummaryStat label="Safe" count={stats.safe_count} tone="emerald" />
                    <SummaryStat label="Complete" count={stats.complete_count} tone="slate" />
                </div>

                <div className="mt-5 flex flex-col gap-3 lg:flex-row">
                    <label className="min-w-[16rem] flex-[2] text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Search
                        <div className="mt-2 flex min-h-[44px] items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 focus-within:border-navy-500 focus-within:ring-2 focus-within:ring-navy-100">
                            <Icon name="Search" size={15} />
                            <input
                                value={searchTerm}
                                onChange={(event) => setSearchTerm(event.target.value)}
                                aria-label="Search wedding readiness"
                                placeholder="Party, blocker, vendor, next action..."
                                className="w-full bg-transparent text-sm font-bold normal-case tracking-normal text-app-text outline-none placeholder:text-app-text-muted"
                            />
                        </div>
                    </label>
                    <SelectField
                        label="Status"
                        value={statusFilter}
                        onChange={(value) => setStatusFilter(value as 'all' | WmReadinessStatus)}
                        options={STATUS_OPTIONS}
                    />
                    <SelectField
                        label="Event window"
                        value={String(windowDays)}
                        onChange={(value) => setWindowDays(Number(value))}
                        options={WINDOW_OPTIONS.map((option) => ({ ...option, value: String(option.value) }))}
                    />
                    <SelectField
                        label="Salesperson"
                        value={salesperson}
                        onChange={setSalesperson}
                        options={[
                            { value: '', label: 'All salespeople' },
                            ...salespeople.map((name) => ({ value: name, label: name })),
                        ]}
                    />
                </div>
                <p className="mt-3 text-xs font-bold text-app-text-muted">
                    Showing {filteredParties.length} of {stats.parties.length} party readiness record(s).
                </p>
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-app-border bg-app-surface p-20 opacity-70">
                    <div className="h-12 w-12 animate-spin rounded-full border-4 border-app-border border-t-gold-500" />
                    <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Analyzing wedding readiness...</p>
                </div>
            ) : error ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-8 text-sm font-bold text-rose-700">{error}</div>
            ) : stats.parties.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-app-border bg-app-surface p-16 text-center text-sm font-bold text-app-text-muted">
                    No wedding parties match the selected readiness filters.
                </div>
            ) : filteredParties.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-app-border bg-app-surface p-16 text-center text-sm font-bold text-app-text-muted">
                    No wedding parties match that search. Clear the search or widen the event window.
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 xl:grid-cols-3">
                    {filteredParties.map((party) => (
                        <ReadinessCard
                            key={party.wedding_party_id}
                            party={party}
                            opening={openingPartyId === party.wedding_party_id}
                            onOpen={() => void openParty(party)}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

function SelectField({
    label,
    value,
    options,
    onChange,
}: {
    label: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
}) {
    return (
        <label className="min-w-[13rem] flex-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            {label}
            <select
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="mt-2 min-h-[44px] w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm font-black normal-case tracking-normal text-app-text outline-none focus:border-navy-500 focus:ring-2 focus:ring-navy-100"
            >
                {options.map((option) => (
                    <option key={option.value || 'all'} value={option.value}>
                        {option.label}
                    </option>
                ))}
            </select>
        </label>
    );
}

function SummaryStat({ label, count, tone }: { label: string; count: number; tone: 'rose' | 'amber' | 'blue' | 'emerald' | 'slate' }) {
    const color = {
        rose: 'text-rose-700 bg-rose-50 border-rose-200',
        amber: 'text-amber-800 bg-amber-50 border-amber-200',
        blue: 'text-blue-700 bg-blue-50 border-blue-200',
        emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
        slate: 'text-slate-700 bg-slate-50 border-slate-200',
    }[tone];
    return (
        <div className={`rounded-xl border p-4 ${color}`}>
            <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{label}</p>
            <p className="mt-1 text-3xl font-black">{count}</p>
        </div>
    );
}

function ReadinessCard({ party, opening, onOpen }: { party: WmReadinessSummary; opening: boolean; onOpen: () => void }) {
    const config = statusConfig(party.status);
    const primaryBlocker = party.blockers?.[0];
    return (
        <button
            type="button"
            onClick={onOpen}
            className={`group flex h-full flex-col rounded-2xl border bg-app-surface p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-lg ${config.border}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        {party.days_until_event >= 0 ? `${party.days_until_event} days left` : 'Event passed'}
                    </p>
                    <h3 className="mt-1 line-clamp-2 text-lg font-black uppercase text-app-text">{party.party_name}</h3>
                    <p className="mt-1 text-xs font-bold text-app-text-muted">{formatDate(party.event_date)}</p>
                </div>
                <span className={`rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${config.badge}`}>
                    {config.label}
                </span>
            </div>

            <div className="mt-5">
                <div className="mb-1 flex justify-between text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    <span>Readiness score</span>
                    <span>{Math.round((party.readiness_score || 0) * 100)}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-app-border">
                    <div className={`h-full rounded-full ${config.bar}`} style={{ width: `${Math.round((party.readiness_score || 0) * 100)}%` }} />
                </div>
            </div>

            <div className="mt-5 rounded-xl border border-app-border bg-app-surface-2 p-4">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {primaryBlocker ? primaryBlocker.label : 'Next safe action'}
                </p>
                <p className="mt-2 text-sm font-bold leading-snug text-app-text">
                    {primaryBlocker?.explanation || party.next_safe_action}
                </p>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <MiniMetric label="NTBO" value={party.lifecycle?.ntbo ?? 0} />
                <MiniMetric label="Ready" value={party.lifecycle?.ready_for_pickup ?? 0} />
                <MiniMetric label="Blocked" value={party.pickup?.blocked_members ?? 0} />
            </div>

            <div className="mt-auto flex items-center justify-between pt-5 text-xs font-black uppercase tracking-widest text-app-accent">
                <span>{opening ? 'Opening...' : 'Open readiness'}</span>
                <Icon name="ArrowRight" size={16} className="transition-transform group-hover:translate-x-1" />
            </div>
        </button>
    );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-lg border border-app-border bg-app-surface px-2 py-2">
            <p className="text-base font-black text-app-text">{value}</p>
            <p>{label}</p>
        </div>
    );
}

function statusConfig(status: WmReadinessStatus) {
    switch (status) {
        case 'critical':
            return { label: 'Critical', border: 'border-rose-300', badge: 'bg-rose-600 text-white', bar: 'bg-rose-500' };
        case 'at_risk':
            return { label: 'At risk', border: 'border-amber-300', badge: 'bg-amber-500 text-white', bar: 'bg-amber-500' };
        case 'watch':
            return { label: 'Watch', border: 'border-blue-200', badge: 'bg-blue-100 text-blue-700', bar: 'bg-blue-500' };
        case 'complete':
            return { label: 'Complete', border: 'border-slate-200', badge: 'bg-slate-100 text-slate-700', bar: 'bg-slate-500' };
        default:
            return { label: 'Safe', border: 'border-emerald-200', badge: 'bg-emerald-100 text-emerald-700', bar: 'bg-emerald-500' };
    }
}

function formatDate(value: string) {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default WeddingHealthHeatmap;
