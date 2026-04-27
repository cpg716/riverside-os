import React from 'react';
import Icon from './Icon';
import { formatPhone, formatDate } from '../lib/utils';

const MemberListDesktop = React.memo(({ members, partyId, paymentStatusByMemberId = {}, onMemberClick, onUpdateMember, toggleStatus, onAppointmentClick }) => {
    return (
        <div className="hidden md:block overflow-x-auto">
            <table className="min-w-full divide-y divide-app-border">
                <thead className="bg-app-surface-2/80 backdrop-blur-sm">
                    <tr>
                        <th scope="col" className="px-6 py-4 text-left text-xs font-bold text-app-text uppercase tracking-wider sticky left-0 bg-app-surface-2/95 backdrop-blur-sm border-r border-app-border shadow-[4px_0_8px_-4px_rgba(0,0,0,0.1)] z-20 w-64">Party Member</th>
                        <th scope="col" className="px-4 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16" title="Appointments Set">Appt</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-12 bg-amber-50/30 text-amber-600">OOT</th>
                        <th scope="col" className="px-4 py-4 text-left text-xs font-bold text-app-text-muted uppercase tracking-wider w-36">Phone</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16 bg-navy-50/30">Suit</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16 bg-navy-50/30">Waist</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16 bg-navy-50/30">Vest</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16 bg-navy-50/30">Shirt</th>
                        <th scope="col" className="px-2 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-16 bg-navy-50/30">Shoe</th>
                        <th scope="col" className="px-4 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-20">Measured</th>
                        <th scope="col" className="px-1 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-24">Ordered</th>
                        <th scope="col" className="px-1 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-24">Received</th>
                        <th scope="col" className="px-1 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-24">Fitted</th>
                        <th scope="col" className="px-1 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-24">Alt</th>
                        <th scope="col" className="px-1 py-4 text-center text-xs font-bold text-app-text-muted uppercase tracking-wider w-24">Picked Up</th>
                    </tr>
                </thead>
                <tbody className="bg-app-surface divide-y divide-app-border">
                    {members.length === 0 ? (
                        <tr>
                            <td colSpan="14" className="px-6 py-10 text-center text-app-text-muted italic">
                                No members added yet. Click "Add Member" to get started.
                            </td>
                        </tr>
                    ) : (
                        members.map((member, idx) => {
                            if (member.role === 'Info') {
                                return (
                                    <tr key={member.id} className="bg-app-surface-2/80 hover:bg-app-border/50/80 transition-colors cursor-pointer group" onClick={() => onMemberClick(member)}>
                                        <td colSpan="14" className="px-6 py-3 text-sm font-bold text-app-text uppercase tracking-wider border-y-2 border-app-border sticky left-0 z-10 bg-app-surface-2 group-hover:bg-app-border/50 transition-colors">
                                            <div className="flex items-center justify-between">
                                                <span className="flex items-center gap-2">
                                                    <Icon name="Info" size={16} className="text-app-text-muted" />
                                                    {member.name}
                                                </span>
                                                <Icon name="Edit" size={14} className="text-app-text-muted hover:text-app-text transition-colors" />
                                            </div>
                                        </td>
                                    </tr>
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

                            const upcomingAppts = [
                                member.measureDate ? `${member.measured ? 'Measured' : 'Measure Appt'}: ${formatDate(member.measureDate)}` : null,
                                member.fittingDate ? `${member.fitting ? 'Fitted' : 'Fitting Appt'}: ${formatDate(member.fittingDate)}` : null,
                                member.pickupDate ? `${member.pickup ? 'Picked Up' : 'Pickup Appt'}: ${formatDate(member.pickupDate)}` : null
                            ].filter(Boolean).join(', ');
                            const paymentStatus = paymentStatusByMemberId[member.id] || 'UNPAID';
                            const paymentBadgeClass =
                                paymentStatus === 'PAID'
                                    ? 'bg-emerald-100 text-emerald-700'
                                    : paymentStatus === 'PARTIAL'
                                        ? 'bg-amber-100 text-amber-700'
                                        : 'bg-rose-100 text-rose-700';

                            return (
                                <tr key={member.id} className="hover:bg-app-surface-2 transition-colors group border-b border-app-border/80 last:border-0">
                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex flex-col cursor-pointer" onClick={() => onMemberClick(member)}>
                                                <div className="flex items-center gap-2">
                                                    <div className="font-bold text-app-text">{member.name}</div>
                                                    {inconsistency && (
                                                        <div className="text-red-500 hover:text-red-600 transition-colors" title={inconsistency}>
                                                            <Icon name="AlertTriangle" size={14} />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${['Groom', 'Customer'].includes(member.role) ? 'text-gold-600' : 'text-app-text-muted'}`}>{member.role}</span>
                                                    {member.oot && <span className="bg-amber-100 text-amber-700 text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">OOT</span>}
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${paymentBadgeClass}`}>
                                                        {paymentStatus}
                                                    </span>
                                                </div>
                                                {member.pinNote === 1 && member.notes && (
                                                    <div className="mt-1.5 px-2 py-1 bg-gold-50 border border-gold-200 rounded text-[10px] text-gold-700 font-medium italic break-words max-w-[200px] whitespace-normal shadow-sm">
                                                        {member.notes}
                                                    </div>
                                                )}
                                            </div>
                                            <button type="button"
                                                onClick={(e) => { e.stopPropagation(); onMemberClick(member); }}
                                                className={`p-1.5 rounded transition-all duration-200 ${hasNotes ? 'text-gold-600 bg-gold-50 hover:bg-gold-100' : 'text-app-text-muted hover:text-app-text hover:bg-app-surface-2'}`}
                                                title="Manage Member Notes & Appointments"
                                            >
                                                <Icon name="Edit" size={16} />
                                            </button>
                                        </div>
                                    </td>
                                    <td className="px-2 sm:px-4 py-3 whitespace-nowrap text-center">
                                        <div
                                            className={`cursor-pointer hover:scale-110 transition-transform ${(() => {
                                                const isOverdue = (dateStr) => {
                                                    if (!dateStr) return false;
                                                    const d = new Date(dateStr);
                                                    const now = new Date();
                                                    now.setHours(0, 0, 0, 0);
                                                    // If date is before today, it's overdue
                                                    return d < now;
                                                };

                                                if (member.pickup) return 'text-blue-600';
                                                if (member.fitting) return member.pickupDate ? (isOverdue(member.pickupDate) ? 'text-amber-600' : 'text-green-600') : 'text-red-400';
                                                if (member.measured) return member.fittingDate ? (isOverdue(member.fittingDate) ? 'text-amber-600' : 'text-green-600') : 'text-red-400';
                                                return member.measureDate ? (isOverdue(member.measureDate) ? 'text-amber-600' : 'text-green-600') : 'text-red-400';
                                            })()
                                                }`}
                                            title={upcomingAppts || "No appointments scheduled"}
                                            onClick={() => onAppointmentClick(member)}
                                        >
                                            <Icon name="Calendar" size={16} />
                                        </div>
                                    </td>
                                    <td className="px-2 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'oot')}
                                            className={`w-10 h-10 mx-auto rounded-lg flex items-center justify-center transition-all ${member.oot ? 'bg-amber-100 text-amber-600 border border-amber-200' : 'bg-app-surface-2 text-app-text-muted hover:bg-app-border/50 active:bg-app-border'}`}
                                            title="Toggle Out of Town"
                                        >
                                            {member.oot ? <Icon name="Check" size={18} /> : <span className="w-2 h-2 rounded-full bg-app-border"></span>}
                                        </button>
                                    </td>
                                    <td className="px-2 sm:px-4 py-3 whitespace-nowrap">
                                        <div className="text-sm text-app-text font-medium">
                                            {formatPhone(member.phone) || <span className="text-app-text-muted italic">None</span>}
                                        </div>
                                    </td>
                                    {['suit', 'waist', 'vest', 'shirt', 'shoe'].map(field => (
                                        <td key={field} className="px-2 py-2 whitespace-nowrap bg-navy-50/10 p-2">
                                            <input
                                                type="text"
                                                className="table-input w-full text-center bg-app-surface border border-app-border rounded-md text-sm py-1.5 text-app-text font-medium placeholder:text-app-text-muted focus:ring-2 focus:ring-navy-900 focus:border-transparent outline-none transition-all hover:border-navy-300"
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
                                        </td>
                                    ))}
                                    {/* Status Toggles */}
                                    <td className="px-2 sm:px-4 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'measured')}
                                            className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex items-center justify-center gap-1 min-h-[44px] shadow-sm transform active:scale-95 ${member.measured ? 'bg-blue-600 text-white border-blue-700 shadow-blue-200' : 'bg-app-surface text-app-text-muted border-app-border hover:border-app-border hover:bg-app-surface-2'}`}
                                        >
                                            {member.measured ? <><Icon name="Ruler" size={14} /> DONE</> : 'PENDING'}
                                        </button>
                                    </td>
                                    <td className="px-1 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'ordered')}
                                            className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex items-center justify-center gap-1 min-h-[44px] shadow-sm transform active:scale-95 ${member.ordered ? 'bg-amber-500 text-white border-amber-600 shadow-amber-200' : 'bg-app-surface text-app-text-muted border-app-border hover:border-app-border hover:bg-app-surface-2'}`}
                                        >
                                            {member.ordered ? <><Icon name="FileText" size={14} /> DONE</> : 'PENDING'}
                                        </button>
                                    </td>
                                    <td className="px-1 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'received')}
                                            className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex items-center justify-center gap-1 min-h-[44px] shadow-sm transform active:scale-95 ${member.received ? 'bg-indigo-600 text-white border-indigo-700 shadow-indigo-200' : 'bg-app-surface text-app-text-muted border-app-border hover:border-app-border hover:bg-app-surface-2'}`}
                                        >
                                            {member.received ? <><Icon name="Package" size={14} /> DONE</> : 'PENDING'}
                                        </button>
                                    </td>
                                    <td className="px-1 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'fitting')}
                                            className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex items-center justify-center gap-1 min-h-[44px] shadow-sm transform active:scale-95 ${member.fitting ? 'bg-emerald-600 text-white border-emerald-700 shadow-emerald-200' : 'bg-app-surface text-app-text-muted border-app-border hover:border-app-border hover:bg-app-surface-2'}`}
                                        >
                                            {member.fitting ? <><Icon name="Scissors" size={14} /> DONE</> : 'PENDING'}
                                        </button>
                                    </td>
                                    <td className="px-1 py-3 whitespace-nowrap text-center">
                                        <div className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex flex-col items-center justify-center gap-0.5 min-h-[44px] shadow-sm ${member.alteration_status ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-app-surface text-app-text-muted border-app-border'}`} title={member.alteration_status ? `Alteration Status: ${member.alteration_status}` : 'No Alterations'}>
                                            <Icon name="Activity" size={14} />
                                            <span className="text-[9px] truncate max-w-[60px]">{member.alteration_status || '-'}</span>
                                        </div>
                                    </td>
                                    <td className="px-1 py-3 whitespace-nowrap text-center">
                                        <button type="button"
                                            onClick={() => toggleStatus(partyId, member.id, 'pickup')}
                                            className={`w-full py-2.5 rounded-lg text-xs font-black border-2 transition-all flex items-center justify-center gap-1 min-h-[44px] shadow-sm transform active:scale-95 ${member.pickup === 'partial' ? 'bg-orange-500 text-white border-orange-600 shadow-orange-200' : member.pickup ? 'bg-navy-900 text-white border-navy-950 shadow-navy-200' : 'bg-app-surface text-app-text-muted border-app-border hover:border-app-border hover:bg-app-surface-2'}`}
                                        >
                                            {member.pickup === 'partial' ? <><Icon name="ShoppingBag" size={14} /> PARTIAL</> : member.pickup ? <><Icon name="ShoppingBag" size={14} /> DONE</> : 'PENDING'}
                                        </button>
                                    </td>
                                </tr>
                            )
                        })
                    )}
                </tbody>
            </table>
        </div>
    );
});

export default MemberListDesktop;
