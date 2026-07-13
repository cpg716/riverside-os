import { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { api, type WmReadinessBlocker, type WmReadinessStatus } from '../lib/api';

type Counts = {
    ntbo: number;
    ordered: number;
    received: number;
    ready_for_pickup: number;
    picked_up: number;
    open: number;
};

type ReadinessMember = {
    wedding_member_id: string;
    customer_name: string;
    role: string;
    status: 'ready' | 'blocked' | 'partial' | 'complete' | 'balance_blocked';
    balance_due: string;
    lifecycle: Counts;
    blockers: WmReadinessBlocker[];
    next_safe_action: string;
};

type PartyReadiness = {
    wedding_party_id: string;
    party_name: string;
    event_date: string;
    days_until_event: number;
    readiness_score: number;
    status: WmReadinessStatus;
    lifecycle: Counts;
    member_counts: {
        total: number;
        measured: number;
        ordered: number;
        received: number;
        fitting: number;
        pickup_complete: number;
    };
    pickup: {
        ready_members: number;
        blocked_members: number;
        partial_ready_members: number;
        balance_blocked_members: number;
    };
    deposit_contributions: {
        total: string | number;
        funded_members: number;
        payer_count: number;
    };
    vendor_risk: {
        ntbo_count: number;
        stale_ordered_count: number;
        missing_vendor_count: number;
        delayed_vendor_count: number;
        next_eta?: string | null;
    };
    blockers: WmReadinessBlocker[];
    next_safe_action: string;
    members: ReadinessMember[];
};

export default function WeddingReadinessPanel({ partyId }: { partyId: string }) {
    const [data, setData] = useState<PartyReadiness | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const readiness = await api.getPartyReadiness(partyId) as PartyReadiness;
            setData(readiness);
        } catch (err) {
            setData(null);
            setError(err instanceof Error ? err.message : 'Could not load party readiness.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [partyId]);

    const grouped = useMemo(() => {
        const members = data?.members ?? [];
        return {
            ready: members.filter((member) => member.status === 'ready'),
            partial: members.filter((member) => member.status === 'partial'),
            blocked: members.filter((member) => member.status === 'blocked' || member.status === 'balance_blocked'),
            complete: members.filter((member) => member.status === 'complete'),
        };
    }, [data?.members]);

    if (loading) {
        return (
            <section className="rounded-xl border border-app-border bg-app-surface p-5 shadow-sm">
                <p className="text-xs font-black uppercase tracking-widest text-app-text-muted">Loading readiness...</p>
            </section>
        );
    }

    if (error || !data) {
        return (
            <section className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm font-bold text-rose-700">
                {error || 'Readiness unavailable.'}
            </section>
        );
    }

    const config = statusConfig(data.status);
    const timeline = [
        { label: 'Measure', value: data.member_counts?.measured ?? 0, total: data.member_counts?.total ?? 0 },
        { label: 'Order', value: data.lifecycle.ordered + data.lifecycle.received + data.lifecycle.ready_for_pickup + data.lifecycle.picked_up, total: lineTotal(data.lifecycle) },
        { label: 'Receive', value: data.lifecycle.received + data.lifecycle.ready_for_pickup + data.lifecycle.picked_up, total: lineTotal(data.lifecycle) },
        { label: 'Ready', value: data.lifecycle.ready_for_pickup + data.lifecycle.picked_up, total: lineTotal(data.lifecycle) },
        { label: 'Pickup', value: data.lifecycle.picked_up, total: lineTotal(data.lifecycle) },
    ];
    const blockedPickupCount = data.pickup.blocked_members + data.pickup.balance_blocked_members;
    const pickupAnswerCards = [
        {
            label: 'Answer now',
            value: data.pickup.ready_members > 0 ? `${data.pickup.ready_members} ready` : 'Not ready yet',
            helper: data.pickup.ready_members > 0 ? 'Can start pickup conversation.' : 'Use next action before promising pickup.',
            tone: data.pickup.ready_members > 0 ? 'emerald' : 'slate',
        },
        {
            label: 'Blocked',
            value: blockedPickupCount,
            helper: blockedPickupCount > 0 ? 'Resolve before pickup.' : 'No pickup blockers.',
            tone: blockedPickupCount > 0 ? 'rose' : 'emerald',
        },
        {
            label: 'Balance holds',
            value: data.pickup.balance_blocked_members,
            helper: data.pickup.balance_blocked_members > 0 ? 'Collect balance before release.' : 'No balance holds.',
            tone: data.pickup.balance_blocked_members > 0 ? 'amber' : 'slate',
        },
        {
            label: 'Wedding deposits',
            value: formatMoney(data.deposit_contributions?.total ?? 0),
            helper: `${data.deposit_contributions?.funded_members ?? 0} member${data.deposit_contributions?.funded_members === 1 ? '' : 's'} funded.`,
            tone: (data.deposit_contributions?.funded_members ?? 0) > 0 ? 'emerald' : 'slate',
        },
        {
            label: 'Completed',
            value: `${data.member_counts.pickup_complete}/${data.member_counts.total}`,
            helper: data.status === 'complete' ? 'Pickup is complete.' : 'Still open.',
            tone: data.status === 'complete' ? 'emerald' : 'slate',
        },
    ] as const;

    return (
        <section className="rounded-xl border border-app-border bg-app-surface p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Party readiness</p>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                        <h3 className="text-xl font-black text-app-text">{config.title}</h3>
                        <span className={`rounded-lg px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${config.badge}`}>
                            {config.label}
                        </span>
                        <span className="text-xs font-bold text-app-text-muted">
                            {data.days_until_event >= 0 ? `${data.days_until_event} days until event` : 'Event date has passed'}
                        </span>
                    </div>
                    <p className="mt-2 max-w-4xl text-sm font-semibold text-app-text-muted">{data.next_safe_action}</p>
                </div>
                <div className="min-w-[10rem] rounded-xl border border-app-border bg-app-surface-2 p-4 text-right">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Readiness score</p>
                    <p className="mt-1 text-3xl font-black text-app-text">{Math.round(data.readiness_score * 100)}%</p>
                </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
                {timeline.map((step) => (
                    <TimelineStep key={step.label} {...step} />
                ))}
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-5">
                {pickupAnswerCards.map((card) => (
                    <QuickAnswerCard key={card.label} {...card} />
                ))}
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ReadinessStrip
                    title="Pickup readiness"
                    icon="ShoppingBag"
                    rows={[
                        ['Ready members', data.pickup.ready_members],
                        ['Partial-ready members', data.pickup.partial_ready_members],
                        ['Blocked members', data.pickup.blocked_members],
                        ['Balance-blocked members', data.pickup.balance_blocked_members],
                    ]}
                />
                <ReadinessStrip
                    title="Vendor risk"
                    icon="ShoppingCart"
                    rows={[
                        ['NTBO', data.vendor_risk.ntbo_count],
                        ['Stale ordered', data.vendor_risk.stale_ordered_count],
                        ['Delayed vendor', data.vendor_risk.delayed_vendor_count],
                        ['Missing vendor / PO', data.vendor_risk.missing_vendor_count],
                    ]}
                    footer={data.vendor_risk.next_eta ? `Next ETA ${formatDate(data.vendor_risk.next_eta)}` : 'No upcoming vendor ETA'}
                />
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                    <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <Icon name="AlertCircle" size={14} /> Current blockers
                    </p>
                    <div className="mt-3 space-y-2">
                        {data.blockers.length ? data.blockers.slice(0, 4).map((blocker, idx) => (
                            <Blocker key={`${blocker.label}-${idx}`} blocker={blocker} />
                        )) : (
                            <p className="text-sm font-bold text-emerald-700">No active readiness blockers.</p>
                        )}
                    </div>
                    {data.blockers.length ? (
                        <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
                            Pilot watch: repeated blockers on this party need manager follow-up before promising pickup.
                        </p>
                    ) : null}
                </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 xl:grid-cols-4">
                <MemberGroup title="Blocked" members={grouped.blocked} tone="rose" />
                <MemberGroup title="Ready" members={grouped.ready} tone="emerald" />
                <MemberGroup title="Partial" members={grouped.partial} tone="blue" />
                <MemberGroup title="Complete" members={grouped.complete} tone="slate" />
            </div>
        </section>
    );
}

function QuickAnswerCard({ label, value, helper, tone }: { label: string; value: string | number; helper: string; tone: 'emerald' | 'rose' | 'amber' | 'slate' }) {
    const color = {
        emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
        rose: 'border-rose-200 bg-rose-50 text-rose-800',
        amber: 'border-amber-200 bg-amber-50 text-amber-900',
        slate: 'border-app-border bg-app-surface-2 text-app-text',
    }[tone];
    return (
        <div className={`rounded-xl border px-4 py-3 ${color}`}>
            <p className="text-[9px] font-black uppercase tracking-widest opacity-70">{label}</p>
            <p className="mt-1 text-lg font-black tabular-nums">{value}</p>
            <p className="mt-1 text-[11px] font-semibold opacity-75">{helper}</p>
        </div>
    );
}

function TimelineStep({ label, value, total }: { label: string; value: number; total: number }) {
    const pct = total > 0 ? Math.round((value / total) * 100) : 0;
    return (
        <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
            <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>{label}</span>
                <span>{pct}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-app-border">
                <div className="h-full rounded-full bg-gold-500" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-2 text-xs font-bold text-app-text">{value} / {total}</p>
        </div>
    );
}

function ReadinessStrip({ title, icon, rows, footer }: { title: string; icon: string; rows: Array<[string, number]>; footer?: string }) {
    return (
        <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
            <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Icon name={icon} size={14} /> {title}
            </p>
            <div className="mt-3 space-y-2">
                {rows.map(([label, value]) => (
                    <div key={label} className="flex justify-between text-sm">
                        <span className="font-semibold text-app-text-muted">{label}</span>
                        <span className="font-black text-app-text">{value}</span>
                    </div>
                ))}
            </div>
            {footer ? <p className="mt-3 text-xs font-bold text-app-text-muted">{footer}</p> : null}
        </div>
    );
}

function Blocker({ blocker }: { blocker: WmReadinessBlocker }) {
    const color = blocker.severity === 'blocking' ? 'text-rose-700' : blocker.severity === 'warning' ? 'text-amber-700' : 'text-blue-700';
    return (
        <div className="rounded-lg border border-app-border bg-app-surface px-3 py-2">
            <p className={`text-xs font-black uppercase tracking-wider ${color}`}>{blocker.label}</p>
            <p className="mt-1 text-xs font-semibold text-app-text-muted">{blocker.next_safe_action}</p>
        </div>
    );
}

function MemberGroup({ title, members, tone }: { title: string; members: ReadinessMember[]; tone: 'emerald' | 'blue' | 'rose' | 'slate' }) {
    const color = {
        emerald: 'text-emerald-700 bg-emerald-50 border-emerald-200',
        blue: 'text-blue-700 bg-blue-50 border-blue-200',
        rose: 'text-rose-700 bg-rose-50 border-rose-200',
        slate: 'text-slate-700 bg-slate-50 border-slate-200',
    }[tone];
    return (
        <div className={`rounded-xl border p-4 ${color}`}>
            <div className="flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-widest">{title}</p>
                <span className="text-lg font-black">{members.length}</span>
            </div>
            <div className="mt-3 space-y-2">
                {members.length ? members.slice(0, 5).map((member) => (
                    <div key={member.wedding_member_id} className="rounded-lg bg-app-surface/70 px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-black text-app-text">{member.customer_name}</p>
                            {parseFloat(member.balance_due || '0') > 0 ? (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-800">
                                    Due ${member.balance_due}
                                </span>
                            ) : null}
                        </div>
                        <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">{member.next_safe_action}</p>
                    </div>
                )) : (
                    <p className="text-xs font-bold opacity-70">None</p>
                )}
            </div>
        </div>
    );
}

function statusConfig(status: WmReadinessStatus) {
    switch (status) {
        case 'critical':
            return { title: 'Pickup is blocked', label: 'Blocked', badge: 'bg-rose-600 text-white' };
        case 'at_risk':
            return { title: 'Action needed before pickup', label: 'Action needed', badge: 'bg-amber-500 text-white' };
        case 'watch':
            return { title: 'Review before promising pickup', label: 'Review', badge: 'bg-blue-100 text-blue-700' };
        case 'complete':
            return { title: 'Wedding pickup is complete', label: 'Complete', badge: 'bg-slate-100 text-slate-700' };
        default:
            return { title: 'Wedding is operationally safe', label: 'Safe', badge: 'bg-emerald-100 text-emerald-700' };
    }
}

function lineTotal(counts: Counts) {
    return counts.ntbo + counts.ordered + counts.received + counts.ready_for_pickup + counts.picked_up;
}

function formatDate(value: string) {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatMoney(value: string | number) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return '$0.00';
    return amount.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
}
