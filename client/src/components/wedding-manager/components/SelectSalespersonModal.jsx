import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';

const SelectSalespersonModal = ({ isOpen, onClose, onSelect }) => {
    const [salespeople, setSalespeople] = useState([]);
    const [selected, setSelected] = useState('');

    useEffect(() => {
        if (isOpen) {
            const fetchSalespeople = async () => {
                try {
                    const data = await api.getSalespeople();
                    setSalespeople(data);
                } catch (err) {
                    console.error("Failed to fetch salespeople:", err);
                }
            };
            fetchSalespeople();
            setSelected('');
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [isOpen, onClose]);

    if (!isOpen) return null;

    const handleConfirm = () => {
        if (selected) {
            onSelect(selected);
        }
    };

    return (
        <div
            className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-navy-900/60 backdrop-blur-sm animate-in fade-in duration-300"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wm-select-salesperson-title"
        >
            <div className="bg-app-surface rounded-[2.5rem] shadow-[0_32px_64px_-16px_rgba(15,23,42,0.3)] w-full max-w-sm overflow-hidden border border-app-border flex flex-col transform transition-all ring-1 ring-black/5">

                {/* Header */}
                <div className="px-8 pt-8 pb-4 flex justify-between items-center">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-app-surface-2 border border-app-border/80 rounded-xl flex items-center justify-center shadow-sm">
                            <Icon name="Activity" size={20} className="text-gold-500" />
                        </div>
                        <div>
                            <h3 id="wm-select-salesperson-title" className="text-app-text font-black text-xl tracking-tight uppercase">User ID</h3>
                            <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest mt-0.5">Who is recording this?</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="w-10 h-10 flex items-center justify-center hover:bg-app-surface-2 rounded-xl transition-all text-app-text-muted hover:text-app-text"
                        aria-label="Close"
                    >
                        <Icon name="X" size={18} />
                    </button>
                </div>

                {/* Selection Area */}
                <div className="px-8 pb-8 pt-4">
                    <div className="grid grid-cols-2 gap-3">
                        {salespeople.map(sp => (
                            <button
                                type="button"
                                key={sp}
                                onClick={() => setSelected(sp)}
                                className={`group relative p-4 rounded-2xl border-2 transition-all duration-300 flex flex-col items-center justify-center gap-2
                                    ${selected === sp
                                        ? 'bg-navy-900 border-navy-900 text-white shadow-xl shadow-navy-900/20 scale-[1.02] z-10'
                                        : 'bg-app-surface-2 border-transparent text-app-text hover:bg-app-surface-2 hover:border-gold-400 hover:shadow-lg hover:shadow-gold-500/5'
                                    }`}
                            >
                                <span className={`text-xs font-black uppercase tracking-widest ${selected === sp ? 'text-gold-400' : 'text-app-text-muted group-hover:text-gold-600'}`}>Staff</span>
                                <span className="text-sm font-black uppercase tracking-tight">{sp}</span>

                                {selected === sp && (
                                    <div className="absolute top-2 right-2">
                                        <div className="w-5 h-5 bg-gold-500 rounded-full flex items-center justify-center shadow-inner">
                                            <Icon name="Check" size={12} className="text-white" />
                                        </div>
                                    </div>
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Action Button */}
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!selected}
                        className={`w-full mt-8 py-4 rounded-2xl font-black text-sm uppercase tracking-[0.2em] transition-all duration-300 shadow-xl
                            ${selected
                                ? 'bg-navy-900 text-white hover:bg-black hover:shadow-2xl active:scale-95'
                                : 'bg-app-surface-2 text-app-text-muted cursor-not-allowed'
                            }`}
                    >
                        Confirm Identity
                    </button>

                    <p className="text-center mt-6 text-[10px] font-bold text-app-text-muted uppercase tracking-[0.1em]">
                        All actions are logged for the audit trail
                    </p>
                </div>
            </div>
        </div>
    );
};

export default SelectSalespersonModal;
