import React, { useMemo } from 'react';
import Icon from './Icon';
import { formatDate } from '../lib/utils';

const OrderReviewTab = ({ members, partyId, toggleStatus, onMemberClick, paymentStatusByMemberId = {} }) => {
    // Stage definitions for the pipeline
    const stages = useMemo(() => [
        { key: 'measured', label: 'Measured', icon: 'Ruler', color: 'blue', dateKey: 'measureDate', activeColor: 'text-blue-600', bgColor: 'bg-blue-50', borderColor: 'border-blue-200' },
        { key: 'ordered', label: 'Ordered', icon: 'Save', color: 'amber', dateKey: 'orderedDate', activeColor: 'text-amber-600', bgColor: 'bg-amber-50', borderColor: 'border-amber-200' },
        { key: 'received', label: 'In Stock', icon: 'CheckCircle', color: 'emerald', dateKey: 'receivedDate', activeColor: 'text-emerald-600', bgColor: 'bg-emerald-50', borderColor: 'border-emerald-200' },
        { key: 'fitting', label: 'Fitted', icon: 'Scissors', color: 'indigo', dateKey: 'fittingDate', activeColor: 'text-indigo-600', bgColor: 'bg-indigo-50', borderColor: 'border-indigo-200' },
        { key: 'pickup', label: 'Ready', icon: 'ShoppingBag', color: 'navy', dateKey: 'pickupDate', activeColor: 'text-app-text', bgColor: 'bg-navy-50', borderColor: 'border-navy-200' }
    ], []);

    const calculateMemberProgress = (member) => {
        const completedCount = stages.filter(stage => !!member[stage.key]).length;
        return Math.round((completedCount / stages.length) * 100);
    };

    const getStatusStyles = (member, stage, isNext) => {
        const val = member[stage.key];

        if (stage.key === 'pickup') {
            if (val === 'partial') return 'bg-amber-100 text-amber-700 border-amber-300 shadow-sm';
            if (val) return 'bg-navy-700 text-white border-navy-800 shadow-md transform scale-105';
            if (isNext) return 'bg-app-surface border-app-border text-app-text-muted border-dashed animate-pulse cursor-pointer';
            return 'bg-app-surface-2 text-app-text-muted border-app-border/80';
        }

        if (val) {
            return `${stage.bgColor} ${stage.activeColor} ${stage.borderColor} shadow-sm border-2 transform scale-105 font-bold z-10`;
        }

        if (isNext) {
            return 'bg-app-surface border-2 border-dashed border-app-border text-app-text-muted hover:border-navy-500 hover:text-app-text-muted transition-all cursor-pointer';
        }

        return 'bg-app-surface-2 text-app-text-muted border-app-border/80 opacity-60';
    };

    const sortedMembers = useMemo(() => {
        return members.filter(m => m.role !== 'Info').sort((a, b) => {
            // Groom first
            if (a.role === 'Groom') return -1;
            if (b.role === 'Groom') return 1;
            return a.name.localeCompare(b.name);
        });
    }, [members]);

    return (
        <div className="bg-app-surface min-h-[400px]">
            <div className="overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-0">
                    <thead className="bg-app-surface-2/50">
                        <tr>
                            <th className="px-6 py-5 text-left text-[10px] font-black text-app-text-muted uppercase tracking-widest sticky left-0 bg-app-surface/95 backdrop-blur-sm z-20 border-b border-r border-app-border w-64">
                                Member & Progress
                            </th>
                            {stages.map((stage, idx) => (
                                <th key={stage.key} className="px-4 py-5 text-center border-b border-app-border min-w-[120px]">
                                    <div className="flex flex-col items-center gap-1.5">
                                        <div className={`p-2 rounded-lg bg-app-surface shadow-sm border border-app-border ${stage.activeColor}`}>
                                            <Icon name={stage.icon} size={16} />
                                        </div>
                                        <span className="text-[10px] font-bold text-app-text uppercase tracking-wider">{stage.label}</span>
                                        <div className="h-0.5 w-8 bg-app-border/50 rounded-full"></div>
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sortedMembers.map((member) => {
                            const progress = calculateMemberProgress(member);
                            const paymentStatus = paymentStatusByMemberId[member.id] || 'UNPAID';
                            const paymentBadgeClass =
                                paymentStatus === 'PAID'
                                    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
                                    : paymentStatus === 'PARTIAL'
                                        ? 'bg-amber-100 text-amber-700 border-amber-200'
                                        : 'bg-rose-100 text-rose-700 border-rose-200';
                            return (
                                <tr key={member.id} className="group transition-colors hover:bg-app-surface-2/30">
                                    <td className="px-6 py-4 sticky left-0 bg-app-surface group-hover:bg-app-surface-2/30 z-10 border-r border-b border-app-border/80 transition-colors">
                                        <div className="flex flex-col gap-2">
                                            <div className="flex items-center justify-between">
                                                <div className="flex flex-col">
                                                    <span className="text-app-text font-bold text-sm flex items-center gap-1.5">
                                                        {member.name}
                                                        {member.role === 'Groom' && <Icon name="Heart" size={12} className="text-rose-500 fill-rose-500" />}
                                                    </span>
                                                    <span className={`text-[10px] font-black uppercase tracking-tight ${member.role === 'Groom' ? 'text-gold-600' : 'text-app-text-muted'}`}>
                                                        {member.role} {member.oot ? '• OOT' : ''}
                                                    </span>
                                                    <span className={`mt-1 inline-flex w-fit rounded border px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${paymentBadgeClass}`}>
                                                        {paymentStatus}
                                                    </span>
                                                </div>
                                                <div className="text-[11px] font-bold text-app-text-muted bg-navy-50 px-2 py-0.5 rounded-full border border-navy-100">
                                                    {progress}%
                                                </div>
                                            </div>
                                            {/* Mini Progress Bar */}
                                            <div className="w-full h-1 bg-app-surface-2 rounded-full overflow-hidden">
                                                <div
                                                    className="h-full bg-navy-500 transition-all duration-500 ease-out"
                                                    style={{ width: `${progress}%` }}
                                                ></div>
                                            </div>
                                        </div>
                                    </td>
                                    {stages.map((stage, idx) => {
                                        const isCurrent = !!member[stage.key];
                                        const isNext = !isCurrent && (idx === 0 || !!member[stages[idx - 1].key]);
                                        const dateVal = member[stage.dateKey];

                                        return (
                                            <td key={stage.key} className="px-4 py-6 text-center border-b border-app-surface-2 relative">
                                                {/* Connecting Line between stages */}
                                                {idx < stages.length - 1 && (
                                                    <div className={`absolute top-1/2 -translate-y-1/2 right-0 w-full h-[2px] z-0 hidden md:block ${isCurrent && member[stages[idx + 1].key] ? 'bg-navy-500' : 'bg-app-surface-2'}`} style={{ left: '50%', width: '100%' }}></div>
                                                )}

                                                <button type="button"
                                                    onClick={() => toggleStatus(partyId, member.id, stage.key)}
                                                    className={`relative z-10 flex flex-col items-center group/btn`}
                                                >
                                                    <div className={`w-12 h-12 rounded-full border flex items-center justify-center transition-all duration-300 ${getStatusStyles(member, stage, isNext)}`}>
                                                        <Icon name={isCurrent ? 'Check' : (stage.key === 'pickup' && member.pickup === 'partial' ? 'MinusSquare' : stage.icon)} size={isCurrent ? 24 : 18} />

                                                        {/* Tooltip */}
                                                        <div className="absolute bottom-full mb-3 hidden group-hover/btn:block bg-navy-900 text-white text-[10px] px-3 py-1.5 rounded-lg whitespace-nowrap z-30 shadow-xl pointer-events-none font-bold">
                                                            {isCurrent ? `${stage.label} on ${dateVal ? formatDate(dateVal) : 'N/A'}${stage.key === 'ordered' && member.orderedPO ? ` (PO: ${member.orderedPO})` : ''}` : `Mark as ${stage.label}`}
                                                            <div className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-navy-900"></div>
                                                        </div>
                                                    </div>

                                                    {/* Date/Status Label below circle */}
                                                    <div className="mt-2 min-h-[14px]">
                                                        {isCurrent ? (
                                                            <span className="text-[9px] font-bold text-app-text-muted tabular-nums">
                                                                <span>{dateVal ? formatDate(dateVal) : 'Complete'}</span>
                                                                {stage.key === 'ordered' && member.orderedPO && (
                                                                    <span className="text-[9px] font-black tabular-nums text-amber-600 dark:text-amber-400">PO: {member.orderedPO}</span>
                                                                )}
                                                            </span>
                                                        ) : isNext ? (
                                                            <span className="text-[9px] font-black text-gold-600 uppercase tracking-tighter animate-pulse">
                                                                Next Up
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                </button>
                                            </td>
                                        );
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="p-4 bg-app-surface-2 border-t border-app-border flex items-center justify-between text-[11px] text-app-text-muted italic">
                <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-blue-100 border border-blue-300"></div> Completed</span>
                    <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full border border-dashed border-app-border bg-app-surface"></div> Next Recommended Step</span>
                </div>
                <div>* Click any stage to toggle status or view historical dates.</div>
            </div>
        </div>
    );
};

export default OrderReviewTab;
