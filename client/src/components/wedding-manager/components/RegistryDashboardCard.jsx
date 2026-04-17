import React from 'react';
import Icon from './Icon';
import Skeleton from './Skeleton';

const RegistryDashboardCard = ({ title, icon, colorClass, items, emptyMsg, renderItem, loading, actionAction }) => {
    const list = Array.isArray(items) ? items : [];

    if (loading) {
        return (
            <div className="bg-app-surface rounded-xl shadow-sm border border-app-border flex flex-col h-72 overflow-hidden">
                <div className={`px-5 py-4 border-b border-app-border/80 flex justify-between items-center ${colorClass} bg-opacity-40`}>
                    <div className="flex items-center gap-3">
                        <Skeleton className="w-4 h-4" />
                        <Skeleton className="w-24 h-4" />
                    </div>
                </div>
                <div className="p-4 space-y-4">
                    {[1, 2, 3].map(i => (
                        <div key={i} className="flex gap-4 items-center">
                            <Skeleton className="w-10 h-10 rounded-full" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="w-1/2 h-3" />
                                <Skeleton className="w-1/4 h-2" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    const textColorClass = colorClass.replace('bg-', 'text-').replace('50', '800');

    return (
        <div className="bg-app-surface rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 border border-app-border flex flex-col h-full animate-fade-in overflow-hidden cursor-default group/card">
            <div className={`px-5 py-4 border-b border-app-border/80 flex justify-between items-center ${colorClass} bg-opacity-40`}>
                <div className="flex items-center gap-3">
                    <h3 className={`text-sm font-extrabold uppercase tracking-wide flex items-center gap-2 ${textColorClass}`}>
                        <Icon name={icon} size={18} />
                        {title}
                    </h3>
                    {actionAction && (
                        <button type="button"
                            onClick={(e) => { e.stopPropagation(); actionAction.onClick(); }}
                            className="bg-app-surface hover:bg-app-surface-2/80 text-app-text border border-app-border hover:border-navy-300 p-1 px-2 rounded text-[10px] font-bold shadow-sm transition-all flex items-center gap-1"
                            title={actionAction.label}
                        >
                            <Icon name={actionAction.icon || 'List'} size={12} />
                            {actionAction.label}
                        </button>
                    )}
                </div>
                <span className={`text-xs font-bold bg-app-surface px-2.5 py-1 rounded-full shadow-sm ${list.length > 0 ? textColorClass : 'text-app-text-muted'}`}>
                    {list.length}
                </span>
            </div>
            <div className="p-0 overflow-y-auto max-h-[24rem] custom-scrollbar flex-1 bg-app-surface">
                {list.length === 0 ? (
                    <div className="p-8 text-center flex flex-col items-center justify-center h-48 text-app-text-muted gap-3">
                        <div className={`p-4 rounded-full ${colorClass} bg-opacity-20`}>
                            <Icon name="Check" size={24} className={textColorClass} />
                        </div>
                        <span className="text-base font-medium text-app-text-muted">{emptyMsg}</span>
                    </div>
                ) : (
                    <div className="divide-y divide-app-surface-2">
                        {list.map((item, idx) => (
                            <div
                                key={idx}
                                onClick={() => renderItem.onClick(item)}
                                className="p-4 hover:bg-app-surface-2 active:bg-app-surface-2 cursor-pointer transition-colors group animate-fade-in flex items-center"
                                style={{ animationDelay: `${idx * 50}ms` }}
                            >
                                {renderItem.content(item)}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default RegistryDashboardCard;
