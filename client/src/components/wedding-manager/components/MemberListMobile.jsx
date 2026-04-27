import React from 'react';
import Icon from './Icon';
import { formatPhone } from '../lib/utils';

const WEDDING_WORKFLOW_STEPS = [
    { key: 'measured', label: 'Measure' },
    { key: 'ordered', label: 'Order' },
    { key: 'received', label: 'Receive' },
    { key: 'fitting', label: 'Fit' },
    { key: 'pickup', label: 'Pickup' },
];

function buildWeddingWorkflow(member) {
    const steps = WEDDING_WORKFLOW_STEPS.map((step) => ({
        ...step,
        complete: step.key === 'pickup' ? Boolean(member?.pickup) : Boolean(member?.[step.key]),
    }));
    const currentIndex = steps.findIndex((step) => !step.complete);
    return {
        steps,
        activeIndex: currentIndex === -1 ? steps.length - 1 : currentIndex,
        nextStep: currentIndex === -1 ? null : steps[currentIndex],
    };
}

const MemberListMobile = React.memo(({ members, partyId, paymentStatusByMemberId = {}, onMemberClick, onUpdateMember, toggleStatus, onAppointmentClick }) => {
    if (members.length === 0) {
        return (
            <div className="md:hidden p-8 text-center text-app-text-muted italic bg-app-surface-2 border-b border-app-border">
                No members added yet. Tap "Add Member" to get started.
            </div>
        );
    }

    return (
        <div className="md:hidden space-y-4 p-4 bg-app-surface-2">
            {members.map(member => {
                if (member.role === 'Info') {
                    return (
                        <div
                            key={member.id}
                            onClick={() => onMemberClick(member)}
                            className="font-bold text-app-text uppercase text-sm tracking-wider py-3 px-2 border-y-2 border-app-border sticky top-0 bg-app-surface-2 z-10 flex items-center justify-between active:bg-app-border/50 transition-colors"
                        >
                            <span className="flex items-center gap-2">
                                <Icon name="Info" size={16} className="text-app-text-muted" />
                                {member.name}
                            </span>
                            <Icon name="Edit" size={16} className="text-app-text-muted" />
                        </div>
                    );
                }
                const hasNotes = member.notes || (member.contactHistory && member.contactHistory.length > 0);

                const checkInconsistency = () => {
                    if (member.ordered && !member.measured) return "Marked 'Ordered' but not 'Measured'";
                    if (member.received && !member.ordered) return "Marked 'Received' but not 'Ordered'";
                    if (member.fitting && !member.received) return "Marked 'Fitted' but not 'Received'";
                    return null;
                };

                const inconsistency = checkInconsistency();
                const paymentStatus = paymentStatusByMemberId[member.id] || 'UNPAID';
                const paymentBadgeClass =
                    paymentStatus === 'PAID'
                        ? 'bg-emerald-100 text-emerald-700'
                        : paymentStatus === 'PARTIAL'
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-rose-100 text-rose-700';
                const workflow = buildWeddingWorkflow(member);

                return (
                    <div key={member.id} className="bg-app-surface rounded-lg shadow-sm border border-app-border p-4 active:scale-[0.99] transition-transform duration-200">
                        <div className="flex justify-between items-start mb-3">
                            <div className="flex-1 min-w-0 pr-2">
                                <div className="flex items-center gap-2">
                                    <div className="font-bold text-app-text text-lg truncate">{member.name}</div>
                                    {inconsistency && (
                                        <div className="text-red-500" title={inconsistency}>
                                            <Icon name="AlertTriangle" size={16} />
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 text-xs mt-1">
                                    <span className={`font-bold uppercase ${['Groom', 'Customer'].includes(member.role) ? 'text-gold-600' : 'text-app-text-muted'}`}>{member.role}</span>
                                    {member.oot && <span className="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-bold">OOT</span>}
                                    <span className={`px-1.5 py-0.5 rounded font-bold uppercase ${paymentBadgeClass}`}>{paymentStatus}</span>
                                    {member.alteration_status && (
                                        <span className="bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded font-bold uppercase flex items-center gap-1">
                                            <Icon name="Activity" size={10} /> {member.alteration_status}
                                        </span>
                                    )}
                                 </div>
                                {member.pinNote === 1 && member.notes && (
                                    <div className="mt-2 p-2 bg-gold-50 border border-gold-200 rounded text-[11px] text-gold-700 font-medium italic shadow-sm">
                                        {member.notes}
                                    </div>
                                )}
                                <div className="text-sm text-app-text mt-1 flex items-center gap-1">
                                    <Icon name="Phone" size={12} /> {formatPhone(member.phone) || 'No Phone'}
                                </div>
                            </div>
                            <div className="flex gap-2">
                                <button type="button"
                                    onClick={() => onAppointmentClick(member)}
                                    className={`p-3 rounded-full transition-colors touch-target ${member.measureDate || member.fittingDate ? 'bg-blue-50 text-blue-600' : 'bg-app-surface-2 text-app-text-muted'}`}
                                >
                                    <Icon name="Calendar" size={20} />
                                </button>
                                <button type="button"
                                    onClick={() => onMemberClick(member)}
                                    className={`p-3 rounded-full transition-colors touch-target ${hasNotes ? 'bg-gold-50 text-gold-600' : 'bg-app-surface-2 text-app-text-muted'}`}
                                >
                                    <Icon name="Edit" size={20} />
                                </button>
                            </div>
                        </div>

                        {/* Measurements Grid */}
                        <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-4 bg-app-surface-2 p-2 rounded border border-app-border/80">
                            {['suit', 'waist', 'vest', 'shirt', 'shoe'].map(field => (
                                <div key={field} className="text-center">
                                    <div className="text-[10px] uppercase font-bold text-app-text-muted mb-1">{field}</div>
                                    <input
                                        type="text"
                                        className="w-full text-center bg-app-surface border border-app-border rounded text-sm py-2 text-app-text font-bold focus:ring-1 focus:ring-navy-900 outline-none transition-shadow"
                                        placeholder="-"
                                        value={member[field] || ''}
                                        onChange={(e) => {
                                            // Update UI immediately (optimistic)
                                            onUpdateMember(member.id, { ...member, [field]: e.target.value }, false);
                                        }}
                                        onBlur={(e) => {
                                            // Save to DB only on blur
                                            onUpdateMember(member.id, { ...member, [field]: e.target.value }, true);
                                        }}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') {
                                                e.target.blur(); // Triggers onBlur logic
                                            }
                                        }}
                                    />
                                </div>
                            ))}
                        </div>

                        <div className="mb-4 rounded-lg border border-app-border bg-app-surface-2 p-3">
                            <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Member workflow
                            </div>
                            <div className="mt-2 grid grid-cols-3 gap-2">
                                {workflow.steps.map((step, index) => {
                                    const isCurrent = index === workflow.activeIndex && !step.complete;
                                    const isComplete = step.complete;
                                    return (
                                        <div
                                            key={step.key}
                                            className={`rounded-lg border px-2 py-2 text-center ${
                                                isCurrent
                                                    ? 'border-app-accent bg-app-accent/10 text-app-text'
                                                    : isComplete
                                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                                        : 'border-app-border bg-app-surface text-app-text-muted'
                                            }`}
                                        >
                                            <div className="text-[9px] font-black uppercase tracking-widest opacity-75">
                                                {index + 1}
                                            </div>
                                            <div className="mt-1 text-[10px] font-black uppercase">
                                                {step.label}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <div className="mt-2 text-[11px] text-app-text-muted">
                                {workflow.nextStep
                                    ? `Next step: ${workflow.nextStep.label}`
                                    : 'Lifecycle complete'}
                            </div>
                        </div>

                        {/* Status Toggles Grid */}
                        <div className="grid grid-cols-2 gap-2">
                            <button type="button"
                                onClick={() => toggleStatus(partyId, member.id, 'measured')}
                                className={`py-3 px-3 rounded-lg text-[10px] font-black border-2 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm ${member.measured ? 'bg-blue-600 text-white border-blue-700' : 'bg-app-surface text-app-text-muted border-app-border'}`}
                            >
                                <Icon name="Ruler" size={14} /> {member.measured ? 'DONE' : 'MEASURE'}
                            </button>
                            <button type="button"
                                onClick={() => toggleStatus(partyId, member.id, 'ordered')}
                                className={`py-3 px-3 rounded-lg text-[10px] font-black border-2 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm ${member.ordered ? 'bg-amber-500 text-white border-amber-600' : 'bg-app-surface text-app-text-muted border-app-border'}`}
                            >
                                <Icon name="FileText" size={14} /> {member.ordered ? 'DONE' : 'ORDER'}
                            </button>
                            <button type="button"
                                onClick={() => toggleStatus(partyId, member.id, 'received')}
                                className={`py-3 px-3 rounded-lg text-[10px] font-black border-2 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm ${member.received ? 'bg-indigo-600 text-white border-indigo-700' : 'bg-app-surface text-app-text-muted border-app-border'}`}
                            >
                                <Icon name="Package" size={14} /> {member.received ? 'DONE' : 'RECEIVE'}
                            </button>
                            <button type="button"
                                onClick={() => toggleStatus(partyId, member.id, 'fitting')}
                                className={`py-3 px-3 rounded-lg text-[10px] font-black border-2 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm ${member.fitting ? 'bg-emerald-600 text-white border-emerald-700' : 'bg-app-surface text-app-text-muted border-app-border'}`}
                            >
                                <Icon name="Scissors" size={14} /> {member.fitting ? 'DONE' : 'FIT'}
                            </button>
                            <button type="button"
                                onClick={() => toggleStatus(partyId, member.id, 'pickup')}
                                className={`py-3 px-3 rounded-lg text-[10px] font-black border-2 flex items-center justify-center gap-2 transition-all active:scale-95 shadow-sm col-span-2 ${member.pickup === 'partial' ? 'bg-orange-500 text-white border-orange-600' : member.pickup ? 'bg-navy-900 text-white border-navy-950 shadow-sm' : 'bg-app-surface text-app-text-muted border-app-border'}`}
                            >
                                <Icon name="ShoppingBag" size={14} /> {member.pickup === 'partial' ? 'PARTIAL' : member.pickup ? 'DONE' : 'PICKUP'}
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
});

export default MemberListMobile;
