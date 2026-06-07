import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import ManageSalespeopleModal from './ManageSalespeopleModal';
import { useModal } from '../hooks/useModal';
import StaffMiniSelector from '../../ui/StaffMiniSelector';

const ChangeSalespersonModal = ({ isOpen, onClose, currentSalesperson, onSave }) => {
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
            const data = await api.getSalespeopleRows();
            setSalespeople(data);
        } catch (err) {
            console.error("Failed to fetch salespeople", err);
            setSalespeople([]);
        }
    };

    const { selectSalesperson } = useModal();
    const selectedSalespersonId = salespeople.find((sp) => sp.full_name === selected)?.id || '';

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

    if (!isOpen) return null;

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
                            <StaffMiniSelector
                                staff={salespeople}
                                selectedId={selectedSalespersonId}
                                onSelect={(id) => {
                                    const picked = salespeople.find((sp) => sp.id === id);
                                    setSelected(picked?.full_name || '');
                                }}
                                placeholder="Select Salesperson"
                                displayLabel={selected || undefined}
                                size="md"
                                fullWidth
                                className="flex-1"
                            />
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
