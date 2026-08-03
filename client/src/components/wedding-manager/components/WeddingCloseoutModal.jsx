import React, { useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import WeddingModalPortal from './WeddingModalPortal';
import { api } from '../lib/api';
import { formatMoney } from '../lib/utils';

const OUTCOMES = [
    ['completed_outside_ros', 'Event completed; tracking incomplete'],
    ['cancelled', 'Wedding cancelled'],
    ['not_completed', 'Event did not proceed'],
    ['legacy_record', 'Historical tracking record'],
    ['duplicate_or_test', 'Duplicate or test record'],
];

export default function WeddingCloseoutModal({ isOpen, party, onClose, onClosed }) {
    const [summary, setSummary] = useState(null);
    const [outcome, setOutcome] = useState('legacy_record');
    const [reason, setReason] = useState('');
    const [notes, setNotes] = useState('');
    const [acknowledge, setAcknowledge] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!isOpen || !party?.id) return;
        let ignore = false;
        setSummary(null);
        setError('');
        setReason('');
        setNotes('');
        setAcknowledge(false);
        void api.getWeddingCloseoutSummary(party.id)
            .then((value) => { if (!ignore) setSummary(value); })
            .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : 'Could not load the linked ROS snapshot.'); });
        return () => { ignore = true; };
    }, [isOpen, party?.id]);

    const hasOpenWork = useMemo(() => summary && (
        Number(summary.open_transaction_count) > 0 ||
        Math.abs(Number(summary.balance_due)) > 0.004 ||
        Math.abs(Number(summary.held_deposit_balance)) > 0.004 ||
        Number(summary.open_fulfillment_line_count) > 0 ||
        Number(summary.scheduled_appointment_count) > 0 ||
        Number(summary.open_alteration_count) > 0
    ), [summary]);

    if (!isOpen) return null;

    const submit = async (event) => {
        event.preventDefault();
        if (!summary || busy) return;
        setBusy(true);
        setError('');
        try {
            await api.closeoutWedding(party.id, {
                outcome,
                reason: reason.trim(),
                notes: notes.trim(),
                acknowledgeOpenWork: acknowledge,
            });
            onClosed();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Wedding tracking could not be archived.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <WeddingModalPortal
            role="dialog"
            aria-modal="true"
            aria-labelledby="wedding-closeout-title"
            className="flex items-start justify-center overflow-y-auto bg-navy-950/65 p-4 py-8 backdrop-blur-sm"
        >
            <form onSubmit={submit} className="w-full max-w-2xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-2xl">
                <div className="flex items-start justify-between border-b border-app-border bg-app-surface-2 px-6 py-5">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-amber-600">Manager archive</p>
                        <h2 id="wedding-closeout-title" className="mt-1 text-xl font-black text-app-text">Archive tracking for {party?.trackingLabel || party?.name}</h2>
                        <p className="mt-1 text-xs font-semibold text-app-text-muted">Removes this tracker from active Wedding boards. It does not complete or change work in any linked ROS workspace.</p>
                    </div>
                    <button type="button" onClick={onClose} className="rounded-full p-2 text-app-text-muted hover:bg-app-border/50" aria-label="Close wedding tracking archive">
                        <Icon name="X" size={20} />
                    </button>
                </div>

                <div className="space-y-5 p-6">
                    {error ? <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-700">{error}</div> : null}

                    <div>
                        <label className="mb-1 block text-xs font-black uppercase tracking-wide text-app-text-muted">Tracking outcome</label>
                        <select className="ui-input w-full p-3 font-bold" value={outcome} onChange={(event) => setOutcome(event.target.value)} required>
                            {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-black uppercase tracking-wide text-app-text-muted">Why is this tracking record being archived?</label>
                        <textarea className="ui-input min-h-24 w-full p-3" value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} required placeholder="Required operational reason (at least 10 characters)" />
                    </div>

                    <div>
                        <label className="mb-1 block text-xs font-black uppercase tracking-wide text-app-text-muted">Additional tracking or historical notes</label>
                        <textarea className="ui-input min-h-20 w-full p-3" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional information that will help a future audit" />
                    </div>

                    <section className={`rounded-xl border p-4 ${hasOpenWork ? 'border-amber-300 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                        <h3 className="text-xs font-black uppercase tracking-wide text-app-text">Linked ROS snapshot (read only)</h3>
                        {!summary ? <p className="mt-2 text-sm font-semibold text-app-text-muted">Reviewing linked records…</p> : (
                            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                                <div><b>{summary.transaction_count}</b><br />Linked Transactions</div>
                                <div><b>{summary.open_transaction_count}</b><br />Linked open Transactions</div>
                                <div><b>{formatMoney(summary.balance_due)}</b><br />Linked balance due</div>
                                <div><b>{formatMoney(summary.held_deposit_balance)}</b><br />Held deposits (ledger)</div>
                                <div><b>{summary.open_fulfillment_line_count}</b><br />Open Fulfillment lines</div>
                                <div><b>{summary.scheduled_appointment_count}</b><br />Scheduled wedding appointments</div>
                                <div><b>{summary.open_alteration_count}</b><br />Linked alterations</div>
                            </div>
                        )}
                        <p className="mt-3 text-xs font-semibold text-app-text-muted">The Wedding Hub only reads these records from Transactions, Fulfillment Orders, the deposit ledger, Scheduling, and Alterations. Archiving this tracker changes none of them.</p>
                    </section>

                    {hasOpenWork ? (
                        <label className="flex items-start gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm font-bold text-amber-950">
                            <input type="checkbox" className="mt-1 h-5 w-5" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} required />
                            <span>I understand that archiving this tracker does not close or alter linked Transactions, balances, deposits, fulfillment, appointments, or alterations. Each remains controlled by its owning ROS workspace.</span>
                        </label>
                    ) : null}
                </div>

                <div className="flex justify-end gap-3 border-t border-app-border bg-app-surface-2 px-6 py-4">
                    <button type="button" onClick={onClose} className="min-h-11 rounded-xl px-4 text-sm font-black text-app-text">Cancel</button>
                    <button type="submit" disabled={!summary || busy || reason.trim().length < 10 || (hasOpenWork && !acknowledge)} className="min-h-11 rounded-xl bg-amber-600 px-5 text-sm font-black text-white shadow-sm disabled:cursor-not-allowed disabled:opacity-50">
                        {busy ? 'Archiving…' : 'Archive Wedding Tracking'}
                    </button>
                </div>
            </form>
        </WeddingModalPortal>
    );
}
