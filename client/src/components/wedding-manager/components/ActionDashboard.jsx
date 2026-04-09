import React from 'react';
import Icon from './Icon';
import { formatDate, formatPhone, highlightMatch } from '../lib/utils';
import { useDashboardActions } from '../hooks/useDashboardActions';
import ActionCard from './ActionCard';
import { api } from '../lib/api';
import { useModal } from '../hooks/useModal';

const ActionDashboard = ({ onMemberClick, filters, onViewOrders }) => {
    const { showConfirm, showAlert, selectSalesperson } = useModal();
    const searchTerm = filters.search || '';
    const { actionItems, loading, refresh } = useDashboardActions(filters);

    const handleItemClick = (item) => {
        onMemberClick(item.member, item.partyId, item);
    };

    const handleQuickAction = async (e, memberId, type) => {
        e.stopPropagation();

        // Prompt for attribution
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        let updateField = {};
        let dateField = '';

        if (type === 'Measurement') {
            updateField = { measured: true };
            dateField = 'measureDate';
        } else if (type === 'Fitting') {
            updateField = { fitting: true };
            dateField = 'fittingDate';
        } else if (type === 'Pickup') {
            updateField = { pickup: true };
            dateField = 'pickupDate';
        } else if (type === 'Order') {
            updateField = { ordered: true };
            dateField = 'orderedDate';
        }

        if (Object.keys(updateField).length === 0) return;

        try {
            await api.updateMember(memberId, {
                ...updateField,
                [dateField]: new Date().toISOString().split('T')[0],
                updatedBy
            });
            refresh();
        } catch (err) {
            console.error("Quick action failed:", err);
        }
    };

    const formatApptTime = (dateStr) => {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return dateStr;

        const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
        const datePart = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        if (!isDateOnly) {
            const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
            return `${datePart} @ ${timePart}`;
        }
        return datePart;
    };

    const getInitials = (name) => {
        return name
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .slice(0, 2);
    };

    const StatusBadge = ({ days, type, urgent }) => {
        let color = 'bg-app-surface-2 text-app-text';
        let text = `${days} days`;
        let animation = '';

        if (type === 'upcoming') {
            if (days === 0) {
                color = 'bg-red-500 text-white';
                text = 'Today';
                animation = 'animate-pulse-red shadow-sm';
            }
            else if (days === 1) { color = 'bg-amber-100 text-amber-800'; text = 'Tomorrow'; }
            else { color = 'bg-green-100 text-green-700'; text = `In ${days} days`; }
        } else if (urgent) {
            color = 'bg-red-100 text-red-700';
            text = 'Urgent';
        }

        return (
            <span className={`text-[10px] font-extrabold uppercase px-2 py-1 rounded-md tracking-wider ${color} ${animation}`}>
                {text}
            </span>
        );
    };

    // Helper for rendering standardized rows
    const renderRow = (item, type, badgeColor, badgeText, iconName, iconColor, showQuickAction = false) => (
        <>
            <div className="flex-shrink-0 mr-4">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shadow-sm ${badgeColor.replace('bg-', 'bg-opacity-20 bg-').replace('text-', 'text-')}`}>
                    {getInitials(item.member.name)}
                </div>
            </div>

            <div className="flex-1 min-w-0 pr-4">
                <div className="flex justify-between items-baseline mb-0.5">
                    <h4 className="font-bold text-app-text text-sm truncate">
                        {highlightMatch(item.member.name, searchTerm)}
                    </h4>
                </div>

                <div className="text-xs text-app-text-muted truncate mb-1">
                    {highlightMatch(item.partyName, searchTerm)}
                </div>
                {item.partyBalanceDueLabel ? (
                    <div className="text-[10px] font-black uppercase tracking-wide text-amber-800 mb-1">
                        Balance due {item.partyBalanceDueLabel}
                    </div>
                ) : null}
                {item.member.phone && (
                    <div className="text-xs text-app-text font-medium mb-1">
                        <Icon name="Phone" size={10} className="inline mr-1" />
                        {formatPhone(item.member.phone)}
                    </div>
                )}

                <div className="flex items-center gap-2 text-xs font-medium">
                    <span className={`${iconColor} flex items-center gap-1`}>
                        <Icon name={iconName} size={12} /> {item.type || type}
                    </span>
                    {item.date && <span className="text-app-text-muted">• {formatApptTime(item.date)}</span>}
                </div>
            </div>

            <div className="flex flex-col items-end gap-2 flex-shrink-0">
                <span className={`text-[10px] font-extrabold uppercase px-2 py-0.5 rounded tracking-wider ${badgeColor}`}>
                    {badgeText}
                </span>
                <div className="flex items-center gap-2 mt-auto">
                    {showQuickAction && (
                        <button type="button"
                            onClick={(e) => handleQuickAction(e, item.member.id, item.type || type)}
                            className="flex min-h-[36px] items-center gap-1.5 rounded-lg border-b-4 border-emerald-800 bg-emerald-600 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-white shadow-md shadow-emerald-900/20 transition-all hover:brightness-110 active:translate-y-0.5 active:border-b-2"
                            title={`Mark as ${type || item.type} Done`}
                        >
                            <Icon name="Check" size={14} /> Done
                        </button>
                    )}
                    <Icon name="ChevronRight" size={16} className="text-app-text-muted group-hover:text-app-accent transition-colors" />
                </div>
            </div>
        </>
    );

    return (
        <div className="mb-8">
            <h2 className="text-lg font-bold text-app-text mb-6 flex items-center gap-2">
                <Icon name="Activity" size={24} className="text-gold-500" />
                Action Dashboard
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-6">

                {/* 1. Upcoming Appointments */}
                <ActionCard
                    title="Upcoming Appts"
                    icon="Calendar"
                    colorClass="bg-navy-50"
                    items={actionItems.upcomingAppts}
                    emptyMsg="No upcoming appointments"
                    loading={loading}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            item.type,
                            item.days === 0 ? 'bg-red-100 text-red-700' : item.days === 1 ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-700',
                            item.days === 0 ? 'Today' : item.days === 1 ? 'Tomorrow' : `In ${item.days} days`,
                            "Clock",
                            "text-app-text"
                        )
                    }}
                />

                {/* 1.5. Missed Appointments */}
                <ActionCard
                    title="Missed Appts"
                    icon="CalendarX"
                    colorClass="bg-red-50"
                    items={actionItems.missedAppts || []}
                    emptyMsg="No missed appointments"
                    loading={loading}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            item.type,
                            'bg-red-100 text-red-700',
                            'Missed',
                            "AlertTriangle",
                            "text-red-500"
                        )
                    }}
                />

                {/* 2. Measurements Needed */}
                <ActionCard
                    title="Needs Measure"
                    icon="Ruler"
                    colorClass="bg-indigo-50"
                    items={actionItems.measurements}
                    emptyMsg="Everyone is measured!"
                    loading={loading}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            "Measurement",
                            item.urgent ? 'bg-red-100 text-red-700' : 'bg-indigo-100 text-indigo-700',
                            item.label || (item.urgent ? 'Urgent' : `${item.daysToWedding} Days`),
                            "Ruler",
                            item.urgent ? "text-red-500" : "text-indigo-500",
                            true
                        )
                    }}
                />

                {/* 3. Ordering Needed */}
                <ActionCard
                    title="Needs Order"
                    icon="ShoppingCart"
                    colorClass="bg-amber-50"
                    items={actionItems.ordering}
                    emptyMsg="All orders placed."
                    loading={loading}
                    actionAction={onViewOrders ? {
                        label: 'View Orders',
                        icon: 'List',
                        onClick: onViewOrders
                    } : null}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            "Order",
                            item.urgent ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-800',
                            item.label || (item.urgent ? 'Urgent' : `${item.daysToWedding} Days`),
                            "FileText",
                            item.urgent ? "text-red-500" : "text-amber-600",
                            true
                        )
                    }}
                />

                {/* 4. Fitting Needed */}
                <ActionCard
                    title="Needs Fitting"
                    icon="Scissors"
                    colorClass="bg-blue-50"
                    items={actionItems.fitting}
                    emptyMsg="No pending fittings."
                    loading={loading}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            "Fitting",
                            item.urgent ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700',
                            item.label || (item.urgent ? 'Urgent' : `${item.daysToWedding} Days`),
                            "Scissors",
                            item.urgent ? "text-red-500" : "text-blue-500",
                            true
                        )
                    }}
                />

                {/* 5. Pickups Needed */}
                <ActionCard
                    title="Needs Pickup"
                    icon="ShoppingBag"
                    colorClass="bg-green-50"
                    items={actionItems.pickups}
                    emptyMsg="Nothing to pick up."
                    loading={loading}
                    renderItem={{
                        onClick: handleItemClick,
                        content: (item) => renderRow(
                            item,
                            "Pickup",
                            item.urgent ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700',
                            item.daysOverdue === 0 ? 'Ready Today' : item.daysOverdue > 0 ? `Overdue ${item.daysOverdue}d` : 'Ready',
                            "ShoppingBag",
                            item.urgent ? "text-red-500" : "text-green-600",
                            true
                        )
                    }}
                />

            </div>
        </div>
    );
};

export default ActionDashboard;
