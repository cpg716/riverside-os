import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { formatDate } from '../lib/utils';

const PartyHistoryModal = ({ isOpen, onClose, partyId, partyName }) => {
    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        const fetchHistory = async () => {
            if (!isOpen || !partyId) return;
            setLogs([]);
            setLoading(true);
            try {
                const data = await api.getPartyHistory(partyId);
                setLogs(data);
            } catch (err) {
                console.error("Failed to fetch history:", err);
            } finally {
                setLoading(false);
            }
        };
        fetchHistory();
    }, [isOpen, partyId]);

    const formatTime = (timestamp) => {
        if (!timestamp) return '';
        const date = new Date(timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z');
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const filteredLogs = useMemo(() => {
        if (!searchTerm) return logs;
        const lowSearch = searchTerm.toLowerCase();
        return logs.filter((log) =>
            String(log.action ?? "").toLowerCase().includes(lowSearch) ||
            String(log.details ?? "").toLowerCase().includes(lowSearch)
        );
    }, [logs, searchTerm]);

    const renderLogDetail = (detail) => {
        // 1. Regex for New Format: "Changed X to Y (was Z)" or "Updated X accessory to Y (was Z)"
        const newFormatMatch = detail.match(/^(.*?):? ?(?:Changed|Updated) (.*?) (?:to|accessory to) "(.*?)" \(was "(.*?)"\)(.*)$/);

        // 2. Regex for Old Format: "Field: Old -> New"
        // Pattern: [Optional Prefix]: [Field]: [Old] -> [New] [Optional Suffix]
        const oldFormatMatch = detail.match(/^(.*?):? ?(.*?): (.*?) -> (.*?)( \(by .*?\))?$/);

        if (newFormatMatch) {
            const [_, prefix, field, newVal, oldVal, suffix] = newFormatMatch;
            return (
                <div className="flex flex-col gap-2">
                    {prefix && <div className="text-xs font-bold text-app-text border-b border-app-border/80 pb-1">{prefix}</div>}
                    <div className="flex flex-col gap-1.5 py-1">
                        <div className="text-[10px] font-black text-app-text-muted uppercase tracking-widest">{field}</div>
                        <div className="flex items-center gap-2">
                            <div className="px-2 py-1 bg-app-surface-2 border border-app-border rounded text-xs text-app-text-muted line-through decoration-app-text-muted italic">
                                {oldVal || 'Empty'}
                            </div>
                            <Icon name="ArrowRight" size={14} className="text-gold-500 shrink-0" />
                            <div className="px-3 py-1 bg-app-surface border-2 border-gold-500 text-gold-600 rounded-lg text-xs font-black shadow-sm">
                                {newVal === '[object Object]' ? 'Updated' : newVal}
                            </div>
                        </div>
                    </div>
                    {suffix && <div className="text-[10px] font-bold text-app-text-muted italic bg-app-surface-2 px-2 py-1 rounded inline-block w-fit mt-1">{suffix.trim()}</div>}
                </div>
            );
        }

        if (oldFormatMatch) {
            const [_, prefix, field, oldVal, newVal, suffix] = oldFormatMatch;
            return (
                <div className="flex flex-col gap-2">
                    {prefix && !prefix.includes(field) && <div className="text-xs font-bold text-app-text border-b border-app-border/80 pb-1">{prefix}</div>}
                    <div className="flex flex-col gap-1.5 py-1">
                        <div className="text-[10px] font-black text-app-text-muted uppercase tracking-widest">{field}</div>
                        <div className="flex items-center gap-2">
                            <div className="px-2 py-1 bg-app-surface-2 border border-app-border rounded text-xs text-app-text-muted line-through decoration-app-text-muted italic">
                                {oldVal === '{}' ? 'None' : oldVal === 'Empty' ? 'Empty' : oldVal}
                            </div>
                            <Icon name="ArrowRight" size={14} className="text-gold-500 shrink-0" />
                            <div className="px-3 py-1 bg-app-surface border-2 border-gold-500 text-gold-600 rounded-lg text-xs font-black shadow-sm">
                                {newVal === '[object Object]' ? 'Updated Content' : newVal}
                            </div>
                        </div>
                    </div>
                    {suffix && <div className="text-[10px] font-bold text-app-text-muted italic bg-app-surface-2 px-2 py-1 rounded inline-block w-fit mt-1">{suffix.trim()}</div>}
                </div>
            );
        }

        return <p className="text-sm text-app-text font-medium leading-relaxed">{detail}</p>;
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-navy-900/40 backdrop-blur-sm animate-fade-in">
            <div className="bg-app-surface-2 rounded-[2.5rem] shadow-[0_32px_80px_-16px_rgba(15,23,42,0.3)] w-full max-w-2xl max-h-[85vh] overflow-hidden border border-app-border flex flex-col transform transition-all ring-1 ring-black/5">

                {/* Header Section */}
                <div className="px-8 pt-8 pb-6 bg-app-surface flex flex-col gap-6 relative border-b border-app-border/80">
                    <div className="flex justify-between items-center">
                        <div className="flex items-center gap-5">
                            {/* Icon Restored: Now using the correct History icon from Icon.jsx */}
                            <div className="w-14 h-14 bg-app-surface border border-app-border/80 rounded-2xl flex items-center justify-center shadow-lg shadow-navy-900/5">
                                <Icon name="History" size={28} className="text-gold-500" />
                            </div>
                            <div>
                                <h3 className="text-app-text font-black text-3xl tracking-tight uppercase leading-none">History</h3>
                                <div className="mt-2">
                                    <span className="text-gold-600 text-[10px] font-black tracking-[0.2em] uppercase bg-gold-50 px-3 py-1 rounded-full border border-gold-100">
                                        {partyName}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <button type="button"
                            onClick={onClose}
                            className="w-12 h-12 flex items-center justify-center hover:bg-app-surface-2 rounded-2xl transition-all active:scale-90 text-app-text-muted hover:text-app-text border border-transparent hover:border-app-border"
                        >
                            <Icon name="X" size={24} />
                        </button>
                    </div>

                    {/* Filter Sidebar */}
                    <div className="relative group">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-gold-600 transition-colors">
                            <Icon name="Search" size={18} />
                        </div>
                        <input
                            type="text"
                            placeholder="Find changes (e.g. 'Waist', 'JERROD', 'Measure')..."
                            className="w-full pl-12 pr-4 py-4 bg-app-surface-2 border-2 border-app-border/80 rounded-2xl text-sm font-bold placeholder:text-app-text-muted focus:bg-app-surface focus:border-gold-500 outline-none transition-all shadow-inner"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                        />
                    </div>
                </div>

                {/* Timeline Content */}
                <div className="flex-1 overflow-y-auto px-8 pb-8 custom-scrollbar space-y-8 bg-app-surface-2/50">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-32 gap-6">
                            <div className="w-10 h-10 border-4 border-app-border border-t-gold-500 rounded-full animate-spin"></div>
                            <span className="font-black uppercase text-[10px] tracking-[0.5em] text-app-text-muted">Synchronizing...</span>
                        </div>
                    ) : filteredLogs.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-40">
                            <Icon name="Search" size={64} className="text-app-text-muted mb-6" />
                            <h4 className="text-app-text font-black uppercase text-xs tracking-widest mb-2">No Records Found</h4>
                            <p className="text-app-text-muted text-sm italic text-center px-12">Adjust your filter or check back later. Every change is tracked automatically.</p>
                        </div>
                    ) : (
                        <div className="relative pt-6">
                            <div className="absolute left-7 top-0 bottom-0 w-1 bg-app-border/40 rounded-full"></div>

                            <div className="space-y-12">
                                {filteredLogs.map((log) => {
                                    const isMember = log.entityType === 'Member';
                                    const action = String(log.action ?? "");
                                    const isAppt = action.includes('Appointment');
                                    const detailStr = String(log.details ?? '');
                                    const parts =
                                        detailStr.trim().length > 0 ? detailStr.split(', ') : ['—'];

                                    return (
                                        <div key={log.id} className="relative pl-14 group">
                                            <div className={`absolute left-4 top-1 w-6 h-6 rounded-full border-4 border-white shadow-md z-10 transition-transform group-hover:scale-110
                                                ${isMember ? 'bg-indigo-500' : isAppt ? 'bg-emerald-500' : 'bg-gold-500'}`}>
                                            </div>

                                            <div className="flex flex-col gap-2">
                                                <div className="flex justify-between items-center pr-2">
                                                    <div className="flex items-center gap-3">
                                                        <span className={`text-[11px] font-black uppercase tracking-wider
                                                            ${isMember ? 'text-indigo-600' : isAppt ? 'text-emerald-600' : 'text-gold-600'}`}>
                                                            {action || '—'}
                                                        </span>
                                                        <span className="text-[10px] font-bold text-app-text-muted uppercase">
                                                            {formatDate(log.timestamp).split(',')[0]} @ {formatTime(log.timestamp)}
                                                        </span>
                                                    </div>
                                                    <span className="text-[9px] font-black text-app-text-muted uppercase tracking-widest bg-app-surface px-2.5 py-1 rounded-lg border border-app-border shadow-sm">
                                                        {log.entityType ?? '—'}
                                                    </span>
                                                </div>

                                                <div className="bg-app-surface p-6 rounded-3xl border border-app-border shadow-sm hover:shadow-md transition-all duration-300 group-hover:border-gold-500/10">
                                                    <div className="grid grid-cols-1 gap-6">
                                                        {parts.map((p, i) => (
                                                            <div key={i} className="border-l-2 border-app-border/80 pl-4">
                                                                {renderLogDetail(p)}
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>

                {/* Light Footer */}
                <div className="p-8 bg-app-surface border-t border-app-border/80 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="w-3 h-3 rounded-full bg-gold-500 animate-pulse"></div>
                        <span className="text-xs font-black text-app-text uppercase tracking-wider">{filteredLogs.length} Events Logged</span>
                    </div>
                    <button type="button"
                        onClick={onClose}
                        className="px-12 py-4 bg-navy-900 text-white font-black rounded-2xl shadow-xl hover:bg-black active:scale-95 transition-all text-sm uppercase tracking-[0.2em]"
                    >
                        Close History
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PartyHistoryModal;
