import React, { useState } from 'react';
import Icon from './Icon';

import { useModal } from '../hooks/useModal';

const StyleEditModal = ({ isOpen, onClose, party, onSave }) => {
    const [localParty, setLocalParty] = useState(() => {
        const parsedAcc = typeof party.accessories === 'string'
            ? JSON.parse(party.accessories || '{}')
            : (party.accessories || {});

        return {
            ...party,
            accessories: parsedAcc
        };
    });

    const handleAccessoryChange = (key, val) => {
        setLocalParty(prev => ({
            ...prev,
            accessories: { ...prev.accessories, [key]: val }
        }));
    };


    const { selectSalesperson } = useModal();

    if (!isOpen) return null;

    const handleSave = async () => {
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        // We should probably log this change to the party notes or somewhere?
        // The user said "NOTES, Member Detail Contact History, and Activity Log".
        // Party-level changes don't have a "Contact History" per se, but they have "Important Notes".
        // Let's append a note to the Party Notes? Or just rely on Activity Log?
        // "The NAME of the user who did any changes should be listed in the NOTES..."
        // Let's assume Activity Log is sufficient for Party-level style changes, 
        // OR we can append to Party Notes if it's critical.
        // Given "Style & Pricing" is a specific section, maybe just the Activity Log is fine.
        // But to be safe and "perfect", let's pass `updatedBy` so the backend can log it properly.

        const { styleInfo, priceInfo, accessories } = localParty;

        onSave({
            styleInfo,
            priceInfo,
            accessories,
            updatedBy
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in overflow-y-auto">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-3xl overflow-hidden my-8 border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Tie" className="text-gold-500" /> Style & Order Details
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>
                <div className="p-6 space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Style Info (Suit/Color)</label>
                            <input type="text" className="w-full px-4 py-2 bg-app-surface border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors text-app-text"
                                value={localParty.styleInfo} onChange={(e) => setLocalParty({ ...localParty, styleInfo: e.target.value })} />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Price / Sale Info</label>
                            <input type="text" className="w-full px-4 py-2 bg-app-surface border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors text-app-text"
                                value={localParty.priceInfo} onChange={(e) => setLocalParty({ ...localParty, priceInfo: e.target.value })} />
                        </div>
                    </div>

                    <div className="border-t border-app-border/80 pt-4">
                        <h4 className="text-sm font-bold text-app-text mb-4 flex items-center gap-2">
                            <span className="w-1 h-4 bg-gold-500 rounded-full inline-block"></span> Accessories checklist
                        </h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            {[
                                { key: 'vest', label: 'Vest' },
                                { key: 'shirt', label: 'Shirt' },
                                { key: 'ties', label: 'Tie' },
                                { key: 'pocketSq', label: 'Pocket Square' },
                                { key: 'shoes', label: 'Shoes' },
                                { key: 'socks', label: 'Socks' },
                                { key: 'suspenders', label: 'Suspenders' },
                                { key: 'cufflinks', label: 'Cufflinks' },
                                { key: 'belt', label: 'Belt' }
                            ].map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-xs text-app-text-muted mb-1 font-medium">{label}</label>
                                    <input
                                        type="text"
                                        className="w-full px-3 py-2 text-sm border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none uppercase transition-colors"
                                        placeholder="-"
                                        value={(localParty.accessories && localParty.accessories[key]) || ''}
                                        onChange={(e) => handleAccessoryChange(key, e.target.value)}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="bg-app-surface-2 p-6 border-t border-app-border/80 flex justify-end gap-3 transition-colors">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-app-text hover:bg-app-surface-2 rounded-lg font-bold transition-all min-h-[44px] active:scale-95">Cancel</button>
                    <button type="button" onClick={handleSave} className="px-6 py-2.5 bg-navy-900 hover:bg-navy-800 text-white rounded-lg font-bold shadow-lg transition-all active:scale-95 min-h-[44px]">Save Changes</button>
                </div>
            </div>
        </div>
    );
};

export default StyleEditModal;
