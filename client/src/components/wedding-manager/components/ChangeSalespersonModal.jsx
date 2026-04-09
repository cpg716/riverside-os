import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import ManageSalespeopleModal from './ManageSalespeopleModal';
import { useModal } from '../hooks/useModal';

const ChangeSalespersonModal = ({ isOpen, onClose, currentSalesperson, onSave }) => {
    if (!isOpen) return null;

    const [salespeople, setSalespeople] = useState([]);
    const [selected, setSelected] = useState(currentSalesperson || '');
    const [isManageModalOpen, setIsManageModalOpen] = useState(false);

    useEffect(() => {
        if (isOpen) {
            fetchSalespeople();
            setSelected(currentSalesperson || '');
        }
    }, [isOpen, currentSalesperson]);

    const fetchSalespeople = async () => {
        try {
            const data = await api.getSalespeople();
            setSalespeople(data);
        } catch (err) {
            console.error("Failed to fetch salespeople", err);
            setSalespeople(['ROBYN', 'JERROD', 'MARK', 'TOM']);
        }
    };

    const { selectSalesperson } = useModal();

    const handleSave = async () => {
        if (selected === currentSalesperson) {
            onClose();
            return;
        }

        // Prompt for who is making the change
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        onSave(selected, updatedBy); // Pass updatedBy as second arg
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-xl w-full max-w-sm overflow-hidden border border-app-border">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Users" size={20} className="text-gold-500" /> Change Salesperson
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    <div>
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Select Salesperson</label>
                        <div className="flex gap-2">
                            <select
                                className="flex-1 p-2 border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none text-app-text bg-app-surface"
                                value={selected}
                                onChange={(e) => setSelected(e.target.value)}
                            >
                                <option value="" disabled>Select...</option>
                                {salespeople.map(sp => (
                                    <option key={sp} value={sp}>{sp}</option>
                                ))}
                            </select>
                            <button type="button"
                                onClick={() => setIsManageModalOpen(true)}
                                className="px-3 py-2 bg-app-surface-2 text-app-text rounded hover:bg-app-border/50 transition-colors"
                                title="Manage Salespeople"
                            >
                                <Icon name="Settings" size={16} />
                            </button>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-app-text font-bold hover:bg-app-surface-2 rounded transition-colors">Cancel</button>
                        <button type="button" onClick={handleSave} className="px-6 py-2 bg-navy-900 hover:bg-navy-800 text-white font-bold rounded shadow transition-colors">Save</button>
                    </div>
                </div>
            </div>

            <ManageSalespeopleModal
                isOpen={isManageModalOpen}
                onClose={() => {
                    setIsManageModalOpen(false);
                    fetchSalespeople();
                }}
            />
        </div>
    );
};

export default ChangeSalespersonModal;
