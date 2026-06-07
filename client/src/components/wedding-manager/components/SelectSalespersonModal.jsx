import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import StaffMiniSelector from '../../ui/StaffMiniSelector';

const SelectSalespersonModal = ({ isOpen, onClose, onSelect }) => {
    const [salespeople, setSalespeople] = useState([]);
    const [selected, setSelected] = useState('');

    useEffect(() => {
        if (isOpen) {
            const fetchSalespeople = async () => {
                try {
                    const data = await api.getSalespeopleRows();
                    setSalespeople(data);
                } catch (err) {
                    console.error("Failed to fetch salespeople:", err);
                    setSalespeople([]);
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
    const selectedSalespersonId = salespeople.find((sp) => sp.full_name === selected)?.id || '';

    return (
        <div
            className="fixed inset-0 z-[110] flex items-start justify-center overflow-y-auto p-4 bg-navy-900/60 backdrop-blur-sm animate-in fade-in duration-300 sm:items-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wm-select-salesperson-title"
        >
            <div className="bg-app-surface rounded-2xl shadow-[0_32px_64px_-16px_rgba(15,23,42,0.3)] w-full max-w-lg max-h-[calc(100vh-2rem)] overflow-hidden border border-app-border flex flex-col transform transition-all ring-1 ring-black/5">

                {/* Header */}
                <div className="px-6 pt-6 pb-4 flex justify-between items-center border-b border-app-border/70">
                    <div className="flex items-center gap-4">
                        <div className="w-10 h-10 bg-app-surface-2 border border-app-border/80 rounded-xl flex items-center justify-center shadow-sm">
                            <Icon name="Activity" size={20} className="text-gold-500" />
                        </div>
                        <div>
                            <h3 id="wm-select-salesperson-title" className="text-app-text font-black text-xl tracking-tight uppercase">Record Staff</h3>
                            <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest mt-0.5">Standalone audit attribution</p>
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
                <div className="min-h-0 overflow-y-auto px-6 py-4">
                    <StaffMiniSelector
                        staff={salespeople}
                        selectedId={selectedSalespersonId}
                        onSelect={(id) => {
                            const picked = salespeople.find((sp) => sp.id === id);
                            setSelected(picked?.full_name || '');
                        }}
                        placeholder="Select Staff"
                        displayLabel={selected || undefined}
                        size="lg"
                        fullWidth
                    />
                </div>

                {/* Action Button */}
                <div className="border-t border-app-border/70 px-6 py-5">
                    <button
                        type="button"
                        onClick={handleConfirm}
                        disabled={!selected}
                        className={`w-full py-4 rounded-2xl font-black text-sm uppercase tracking-[0.2em] transition-all duration-300 shadow-xl
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
