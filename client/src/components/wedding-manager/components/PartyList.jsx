import React from 'react';
import Icon from './Icon';
import Skeleton from './Skeleton';
import { calculateProgress, formatDate, isSoon, highlightMatch } from '../lib/utils';
import { isLegacyIndividualParty } from '../lib/partyLegacy';

const PartyList = ({ parties, loading, onPartyClick, currentPage, totalPages, setCurrentPage, totalParties, searchTerm, showDeleted, onRestore }) => {

    if (loading) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="bg-app-surface rounded-lg shadow-sm border border-app-border p-5 h-64 flex flex-col gap-4">
                        <div className="flex justify-between">
                            <Skeleton className="h-8 w-1/2" />
                            <Skeleton className="h-6 w-16" />
                        </div>
                        <Skeleton className="h-4 w-1/3" />
                        <div className="flex-1 space-y-2 mt-4">
                            <Skeleton className="h-4 w-full" />
                            <Skeleton className="h-4 w-3/4" />
                        </div>
                        <Skeleton className="h-2 w-full rounded-full" />
                        <div className="flex justify-between mt-2">
                            <Skeleton className="h-4 w-20" />
                            <Skeleton className="h-4 w-20" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (parties.length === 0) {
        return (
            <div className="text-center py-20 bg-app-surface rounded-lg border border-app-border border-dashed">
                <Icon name={showDeleted ? "Trash2" : "Search"} size={48} className="text-app-text-muted mx-auto mb-4" />
                <h3 className="text-lg font-bold text-app-text">
                    {showDeleted ? 'No deleted parties found' : 'No parties found'}
                </h3>
                <p className="text-app-text-muted">
                    {showDeleted ? 'All deleted parties match your filters, or none have been deleted.' : 'Try adjusting your search or filters.'}
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {parties.map(party => {
                    const progress = calculateProgress(party.members);
                    const urgent = isSoon(party.date);
                    const primaryContact =
                        party.members?.find(m => m.role === 'Groom') ||
                        party.members?.find(m => m.role === 'Customer') ||
                        party.members?.[0];

                    const hasUnmeasured = party.members.some(m => !m.measured);
                    const isCritical = urgent && hasUnmeasured;

                    return (
                        <div
                            key={party.id}
                            onClick={() => party.isDeleted !== 1 && onPartyClick(party)}
                            className={`bg-app-surface rounded-lg shadow-sm hover:shadow-xl transition-all duration-300 border border-app-border cursor-pointer group flex flex-col h-full active:scale-[0.98] hover:-translate-y-1 relative overflow-hidden ${party.isDeleted === 1 ? 'opacity-60 grayscale-[0.5]' : ''} ${isCritical ? 'ring-2 ring-red-500 shadow-lg shadow-red-100' : urgent ? 'ring-1 ring-red-100' : ''}`}
                        >
                            {/* Deleted / Archived Stamp */}
                            {party.isDeleted === 1 && (
                                <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
                                    <div className="border-4 border-red-600/30 text-red-600/30 font-black text-4xl px-4 py-2 uppercase tracking-widest rotate-[-12deg] rounded-xl scale-110">
                                        Deleted
                                    </div>
                                </div>
                            )}

                            {/* Urgent/Critical Indicator Strip */}
                            {isCritical ? (
                                <div className="absolute top-0 left-0 w-1.5 h-full bg-red-600 z-10 animate-pulse"></div>
                            ) : urgent ? (
                                <div className="absolute top-0 left-0 w-1 h-full bg-red-400 z-10"></div>
                            ) : null}

                            <div className="p-5 border-b border-app-border/80 bg-app-surface flex justify-between items-start relative">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="font-bold text-xl text-app-text group-hover:text-gold-600 transition-colors">
                                            {highlightMatch(party.trackingLabel || party.name, searchTerm)}
                                        </h3>
                                        {isCritical ? (
                                            <span className="bg-red-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest animate-pulse shadow-md flex items-center gap-1">
                                                <Icon name="AlertCircle" size={10} /> Needs Measures
                                            </span>
                                        ) : urgent && (
                                            <span className="bg-red-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full uppercase tracking-wider animate-pulse-red shadow-sm">Urgent</span>
                                        )}
                                    </div>
                                    <div className="text-sm font-semibold text-app-text mt-0.5">
                                        {primaryContact ? highlightMatch(primaryContact.name, searchTerm) : 'Unknown contact'}
                                    </div>
                                    <div className="flex items-center text-app-text-muted text-sm mt-1 gap-1.5 font-medium">
                                        <Icon name="Calendar" size={14} className="text-app-text-muted" />
                                        <span className={urgent ? 'text-red-600 font-bold' : ''}>{formatDate(party.date)}</span>
                                    </div>
                                </div>
                                <span className="bg-navy-50 text-app-text text-xs font-bold px-2.5 py-1 rounded border border-navy-100">
                                    {party.salesperson || 'Staff'}
                                </span>
                            </div>

                            <div className="p-5 flex-1 flex flex-col">
                                <div className="text-sm text-app-text mb-4 space-y-2 flex-1">
                                    <div className="flex justify-between items-center pb-2 border-b border-app-surface-2">
                                        <span className="text-app-text-muted text-xs uppercase font-bold tracking-wider">Style</span>
                                        <span className="font-semibold text-app-text truncate max-w-[150px]">{party.styleInfo || party.notes || '-'}</span>
                                    </div>
                                    {!isLegacyIndividualParty(party) && (
                                        <div className="flex justify-between items-center">
                                            <span className="text-app-text-muted text-xs uppercase font-bold tracking-wider">Bride</span>
                                            <span className="font-medium text-app-text">{party.brideName || '-'}</span>
                                        </div>
                                    )}
                                </div>

                                <div className="mt-auto">
                                    <div className="flex justify-between text-xs mb-1.5 items-end">
                                        <span className="text-app-text-muted uppercase font-bold tracking-widest text-[9px]">Completion</span>
                                        <span className={`font-extrabold ${progress === 100 ? 'text-green-600' : 'text-app-text'}`}>{progress}%</span>
                                    </div>
                                    <div className="w-full bg-app-surface-2 rounded-full h-2.5 overflow-hidden shadow-inner p-0.5">
                                        <div
                                            className={`h-1.5 rounded-full transition-all duration-1000 ease-out shadow-sm ${progress === 100 ? 'bg-green-500' : progress > 70 ? 'bg-blue-600' : progress > 30 ? 'bg-navy-800' : 'bg-app-text-muted'}`}
                                            style={{ width: `${progress}%` }}
                                        ></div>
                                    </div>
                                </div>
                            </div>

                            {/* Footer: Members count + action */}
                            <div className="bg-app-surface-2 px-5 py-3 text-xs text-app-text-muted border-t border-app-border/80 flex justify-between items-center group-hover:bg-navy-50 transition-colors">
                                <span className="font-medium">{party.members ? party.members.length : 0} Members</span>
                                {showDeleted && onRestore ? (
                                    <button type="button"
                                        onClick={(e) => { e.stopPropagation(); onRestore(party); }}
                                        className="flex items-center gap-1.5 text-emerald-700 font-bold hover:text-emerald-900 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-3 py-1 rounded-full transition-colors"
                                    >
                                        <Icon name="RotateCcw" size={12} /> Restore Party
                                    </button>
                                ) : (
                                    <span className="flex items-center gap-1 text-app-text font-bold group-hover:translate-x-1 transition-transform">
                                        Manage <Icon name="ArrowRight" size={12} />
                                    </span>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
                <div className="flex justify-between items-center mt-8 pb-8">
                    <button type="button"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                        className="px-6 py-2.5 bg-app-surface border border-app-border rounded-lg disabled:opacity-50 font-bold text-app-text hover:bg-app-surface-2 transition-all shadow-sm flex items-center gap-2 min-h-[44px] active:scale-95 active:bg-app-surface-2"
                    >
                        <Icon name="ArrowLeft" size={18} /> Previous
                    </button>
                    <span className="text-app-text font-bold bg-app-surface px-6 py-2.5 rounded-lg border border-app-border shadow-sm min-h-[44px] flex items-center">
                        Page {currentPage} of {totalPages}
                    </span>
                    <button type="button"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                        className="px-6 py-2.5 bg-app-surface border border-app-border rounded-lg disabled:opacity-50 font-bold text-app-text hover:bg-app-surface-2 transition-all shadow-sm flex items-center gap-2 min-h-[44px] active:scale-95 active:bg-app-surface-2"
                    >
                        Next <Icon name="ArrowRight" size={18} />
                    </button>
                </div>
            )}
        </>
    );
};

export default PartyList;
