import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import ManagerApprovalModal from '../../pos/ManagerApprovalModal';

const LIFECYCLE_OPTIONS = [
    { value: 'needs_measurements', label: 'Needs measurements' },
    { value: 'ntbo', label: 'Ready to order' },
    { value: 'ordered', label: 'Ordered' },
    { value: 'received', label: 'Received' },
    { value: 'ready_for_pickup', label: 'Ready for pickup' },
];

const STATUS_LABELS = {
    not_required: 'Not started',
    needs_review: 'Needs review',
    in_review: 'In review',
    blocked: 'Manager review',
    reviewed: 'Reviewed',
};

function money(value) {
    const n = Number(value || 0);
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function lifecycleSummary(party) {
    const parts = [
        ['Measure', party.needs_measurements],
        ['NTBO', party.ntbo],
        ['Ordered', party.ordered],
        ['Received', party.received],
        ['Ready', party.ready_for_pickup],
        ['Picked up', party.picked_up],
    ].filter(([, count]) => Number(count) > 0);
    return parts.length ? parts.map(([label, count]) => `${label}: ${count}`).join(' · ') : 'No linked lifecycle yet';
}

export default function CutoverReviewPanel() {
    const [parties, setParties] = useState([]);
    const [selectedPartyId, setSelectedPartyId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [loading, setLoading] = useState(true);
    const [detailLoading, setDetailLoading] = useState(false);
    const [error, setError] = useState('');
    const [savingId, setSavingId] = useState(null);
    const [statusByTransaction, setStatusByTransaction] = useState({});
    const [approvalCandidate, setApprovalCandidate] = useState(null);

    const loadSummary = async () => {
        setLoading(true);
        setError('');
        try {
            const data = await api.getCutoverSummary();
            const rows = Array.isArray(data?.parties) ? data.parties : [];
            setParties(rows);
            if (!selectedPartyId && rows.length) setSelectedPartyId(rows[0].party_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load cutover review.');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void loadSummary();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!selectedPartyId) {
            setDetail(null);
            return;
        }
        let ignore = false;
        const run = async () => {
            setDetailLoading(true);
            setError('');
            try {
                const data = await api.getPartyCutover(selectedPartyId);
                if (ignore) return;
                setDetail(data);
                const next = {};
                for (const candidate of data?.candidates || []) {
                    next[candidate.transaction_id] = next[candidate.transaction_id] || 'needs_measurements';
                }
                setStatusByTransaction(next);
            } catch (err) {
                if (!ignore) setError(err instanceof Error ? err.message : 'Could not load party review.');
            } finally {
                if (!ignore) setDetailLoading(false);
            }
        };
        void run();
        return () => {
            ignore = true;
        };
    }, [selectedPartyId]);

    const stats = useMemo(() => {
        const needsReview = parties.filter((p) => p.review_status !== 'reviewed').length;
        const candidates = parties.reduce((sum, p) => sum + Number(p.candidate_transaction_count || 0), 0);
        const measurement = parties.reduce((sum, p) => sum + Number(p.needs_measurements || 0), 0);
        const ntbo = parties.reduce((sum, p) => sum + Number(p.ntbo || 0), 0);
        return { needsReview, candidates, measurement, ntbo };
    }, [parties]);

    const acceptCandidate = async (candidate, managerPin, managerStaffId) => {
        const lineIds = (Array.isArray(candidate.lines) ? candidate.lines : [])
            .map((line) => line?.line_id)
            .filter(Boolean);
        if (!lineIds.length) {
            setError('This Transaction Record has no explicit eligible item selection. Nothing was changed.');
            return false;
        }
        setSavingId(candidate.transaction_id);
        setError('');
        try {
            await api.linkCutoverTransaction({
                party_id: detail.party.party_id,
                member_id: candidate.suggested_member_id,
                transaction_id: candidate.transaction_id,
                transaction_line_ids: lineIds,
                lifecycle_status: statusByTransaction[candidate.transaction_id] || 'needs_measurements',
                manager_staff_id: managerStaffId,
                manager_pin: managerPin,
            });
            await loadSummary();
            const refreshed = await api.getPartyCutover(detail.party.party_id);
            setDetail(refreshed);
            setApprovalCandidate(null);
            return true;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not link this Transaction Record.');
            return false;
        } finally {
            setSavingId(null);
        }
    };

    const markReviewed = async (status) => {
        if (!detail?.party?.party_id) return;
        setSavingId(`review-${status}`);
        setError('');
        try {
            await api.markCutoverReviewed(detail.party.party_id, {
                status,
                actor_name: 'Cutover Review',
                notes: status === 'reviewed'
                    ? 'Party cutover reviewed and ready for ROS lifecycle tracking.'
                    : 'Party needs manager review before readiness is trusted.',
            });
            await loadSummary();
            const refreshed = await api.getPartyCutover(detail.party.party_id);
            setDetail(refreshed);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not update review status.');
        } finally {
            setSavingId(null);
        }
    };

    return (
        <div className="space-y-6 pb-20">
            <div className="bg-app-surface border border-app-border rounded-xl shadow-sm p-5">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Counterpoint cutover</p>
                        <h2 className="text-2xl font-black text-app-text">Wedding Cutover Review</h2>
                        <p className="mt-1 text-sm font-semibold text-app-text-muted max-w-3xl">
                            Connect imported wedding parties to Counterpoint-synced ROS Transaction Records. Money stays on the Transaction Record; this review only confirms the member link and item status.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={loadSummary}
                        className="px-4 py-2.5 rounded-lg border border-app-border bg-app-surface-2 text-app-text text-xs font-black uppercase tracking-widest hover:bg-app-border/50"
                    >
                        Refresh
                    </button>
                </div>
                <div className="mt-5 grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <Stat label="Parties to review" value={stats.needsReview} />
                    <Stat label="Suggested records" value={stats.candidates} />
                    <Stat label="Need measurements" value={stats.measurement} />
                    <Stat label="Ready to order" value={stats.ntbo} />
                </div>
            </div>

            {error && (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
                    {error}
                </div>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-[24rem_1fr] gap-5">
                <div className="bg-app-surface border border-app-border rounded-xl shadow-sm overflow-hidden">
                    <div className="px-4 py-3 border-b border-app-border bg-app-surface-2">
                        <div className="text-xs font-black uppercase tracking-widest text-app-text-muted">Parties</div>
                    </div>
                    <div className="divide-y divide-app-border max-h-[46rem] overflow-y-auto">
                        {loading ? (
                            <div className="p-6 text-sm font-bold text-app-text-muted">Loading cutover parties...</div>
                        ) : parties.length === 0 ? (
                            <div className="p-6 text-sm font-bold text-app-text-muted">No wedding parties found.</div>
                        ) : parties.map((party) => (
                            <button
                                type="button"
                                key={party.party_id}
                                onClick={() => setSelectedPartyId(party.party_id)}
                                className={`w-full text-left p-4 transition-colors ${selectedPartyId === party.party_id ? 'bg-gold-50' : 'bg-app-surface hover:bg-app-surface-2'}`}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <div className="font-black text-app-text">{party.party_name}</div>
                                        <div className="text-xs font-bold text-app-text-muted">{party.event_date} · {party.member_count} members</div>
                                    </div>
                                    <StatusBadge status={party.review_status} />
                                </div>
                                <div className="mt-2 text-[11px] font-bold text-app-text-muted">
                                    {party.candidate_transaction_count} suggested · {party.linked_transaction_count} linked
                                </div>
                                <div className="mt-1 text-[11px] text-app-text-muted">
                                    {lifecycleSummary(party)}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="bg-app-surface border border-app-border rounded-xl shadow-sm overflow-hidden min-h-[32rem]">
                    {!detail || detailLoading ? (
                        <div className="p-8 text-sm font-bold text-app-text-muted">Select a party to review.</div>
                    ) : (
                        <div>
                            <div className="px-5 py-4 border-b border-app-border bg-app-surface-2 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-xl font-black text-app-text">{detail.party.party_name}</h3>
                                        <StatusBadge status={detail.party.review_status} />
                                    </div>
                                    <p className="text-xs font-bold text-app-text-muted">
                                        Review matched Transaction Records, then mark this party reviewed when the current status is trusted.
                                    </p>
                                </div>
                                <div className="flex gap-2">
                                    <button
                                        type="button"
                                        disabled={Boolean(savingId)}
                                        onClick={() => markReviewed('blocked')}
                                        className="px-4 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 text-xs font-black uppercase tracking-widest disabled:opacity-50"
                                    >
                                        Manager Review
                                    </button>
                                    <button
                                        type="button"
                                        disabled={Boolean(savingId)}
                                        onClick={() => markReviewed('reviewed')}
                                        className="px-4 py-2 rounded-lg border border-emerald-700 bg-emerald-600 text-white text-xs font-black uppercase tracking-widest disabled:opacity-50"
                                    >
                                        Mark Reviewed
                                    </button>
                                </div>
                            </div>

                            <div className="p-5 grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-5">
                                <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                                    <div className="text-xs font-black uppercase tracking-widest text-app-text-muted">Members</div>
                                    <div className="mt-3 space-y-2">
                                        {detail.members.map((member) => (
                                            <div key={member.member_id} className="rounded-lg bg-app-surface border border-app-border p-3">
                                                <div className="font-black text-sm text-app-text">{member.name}</div>
                                                <div className="text-[11px] font-bold text-app-text-muted">{member.role}</div>
                                                <div className="mt-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                                    {member.customer_verified ? 'Customer linked' : 'Needs customer check'}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-3">
                                    <div className="text-xs font-black uppercase tracking-widest text-app-text-muted">Suggested Transaction Records</div>
                                    {detail.candidates.length === 0 ? (
                                        <div className="rounded-xl border border-app-border bg-app-surface-2 p-6 text-sm font-bold text-app-text-muted">
                                            No unlinked Counterpoint-synced Transaction Records matched these members. Use Orders attach flow for manual exceptions.
                                        </div>
                                    ) : detail.candidates.map((candidate) => {
                                        const member = detail.members.find((m) => m.member_id === candidate.suggested_member_id);
                                        const lineCount = Array.isArray(candidate.lines) ? candidate.lines.length : 0;
                                        return (
                                            <div key={`${candidate.suggested_member_id}-${candidate.transaction_id}`} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-sm">
                                                <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <Icon name="FileText" size={16} className="text-app-text-muted" />
                                                            <div className="font-black text-app-text">{candidate.display_id}</div>
                                                        </div>
                                                        <div className="mt-1 text-xs font-bold text-app-text-muted">
                                                            Suggested for {member?.name || 'member'} · {candidate.customer_name} · {candidate.customer_code || 'No customer code'}
                                                        </div>
                                                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-black uppercase tracking-widest">
                                                            <span className="rounded-full bg-app-surface-2 border border-app-border px-2 py-1">{money(candidate.total_price)} total</span>
                                                            <span className="rounded-full bg-app-surface-2 border border-app-border px-2 py-1">{money(candidate.balance_due)} balance</span>
                                                            <span className="rounded-full bg-blue-50 text-blue-700 px-2 py-1">{candidate.confidence} confidence</span>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-col sm:flex-row gap-2">
                                                        <select
                                                            value={statusByTransaction[candidate.transaction_id] || 'needs_measurements'}
                                                            onChange={(event) => setStatusByTransaction((prev) => ({ ...prev, [candidate.transaction_id]: event.target.value }))}
                                                            className="min-h-[42px] rounded-lg border border-app-border bg-app-surface-2 px-3 text-xs font-black uppercase tracking-widest text-app-text"
                                                        >
                                                            {LIFECYCLE_OPTIONS.map((option) => (
                                                                <option key={option.value} value={option.value}>{option.label}</option>
                                                            ))}
                                                        </select>
                                                        <button
                                                            type="button"
                                                            disabled={savingId === candidate.transaction_id}
                                                            onClick={() => setApprovalCandidate(candidate)}
                                                            className="min-h-[42px] rounded-lg bg-navy-900 px-4 text-xs font-black uppercase tracking-widest text-white disabled:opacity-50"
                                                        >
                                                            {savingId === candidate.transaction_id ? 'Saving...' : 'Link'}
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="mt-3 rounded-lg bg-app-surface-2 border border-app-border p-3">
                                                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{lineCount} item(s)</div>
                                                    <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                                                        {(candidate.lines || []).map((line) => (
                                                            <div key={line.line_id} className="rounded-lg bg-app-surface border border-app-border px-3 py-2">
                                                                <div className="text-sm font-black text-app-text">{line.description || 'Line item'}</div>
                                                                <div className="text-[11px] font-bold text-app-text-muted">
                                                                    {line.sku || 'No SKU'} · Qty {line.quantity || 1} · {line.lifecycle_status || 'No status'}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <ManagerApprovalModal
                isOpen={Boolean(approvalCandidate)}
                onClose={() => setApprovalCandidate(null)}
                title="Approve exact cutover scope"
                message={approvalCandidate
                    ? `Approve linking exactly ${(approvalCandidate.lines || []).length} item(s) on ${approvalCandidate.display_id}. Picked Up is intentionally unavailable here and must be completed through Register pickup.`
                    : ''}
                onApprove={async (pin, managerId) => {
                    if (!approvalCandidate) return false;
                    return acceptCandidate(approvalCandidate, pin, managerId);
                }}
            />
        </div>
    );
}

function Stat({ label, value }) {
    return (
        <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
            <div className="text-2xl font-black text-app-text">{value}</div>
            <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{label}</div>
        </div>
    );
}

function StatusBadge({ status }) {
    const classes = status === 'reviewed'
        ? 'bg-emerald-100 text-emerald-700'
        : status === 'blocked'
            ? 'bg-amber-100 text-amber-700'
            : status === 'in_review'
                ? 'bg-blue-100 text-blue-700'
                : 'bg-rose-100 text-rose-700';
    return (
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest ${classes}`}>
            {STATUS_LABELS[status] || status}
        </span>
    );
}
