import React, { useState } from 'react';
import Icon from './Icon';
import { isLegacyIndividualParty } from '../lib/partyLegacy';

const ContactEditModal = ({ isOpen, onClose, party, onSave }) => {
    if (!isOpen) return null;
    const [localParty, setLocalParty] = useState(party);

    const handleSave = () => {
        onSave(party.id, localParty);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in overflow-y-auto">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-3xl overflow-hidden my-8 border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Phone" className="text-gold-500" /> Edit Contact Info
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>
                <div className="p-6 space-y-8">

                    {/* Primary contact */}
                    <div className="pb-4 border-b border-app-border/80">
                        <h4 className="text-sm font-bold text-app-text mb-4">Primary contact</h4>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Phone</label>
                                <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                    value={localParty.groomPhone || ''} onChange={(e) => setLocalParty({ ...localParty, groomPhone: e.target.value })} />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Email</label>
                                <input type="email" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                    value={localParty.groomEmail || ''} onChange={(e) => setLocalParty({ ...localParty, groomEmail: e.target.value })} />
                            </div>
                        </div>
                    </div>

                    {/* Bride Contact */}
                    {!isLegacyIndividualParty(party) && (
                        <div>
                            <h4 className="text-sm font-bold text-app-text mb-4">Bride Contact</h4>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <input type="text" className="px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none transition-colors" placeholder="Bride Name"
                                    value={localParty.brideName || ''} onChange={(e) => setLocalParty({ ...localParty, brideName: e.target.value })} />
                                <input type="text" className="px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none transition-colors" placeholder="Phone Number"
                                    value={localParty.bridePhone || ''} onChange={(e) => setLocalParty({ ...localParty, bridePhone: e.target.value })} />
                                <input type="email" className="px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none transition-colors" placeholder="Email Address"
                                    value={localParty.brideEmail || ''} onChange={(e) => setLocalParty({ ...localParty, brideEmail: e.target.value })} />
                            </div>
                        </div>
                    )}

                </div>
                <div className="bg-app-surface-2 p-6 border-t border-app-border/80 flex justify-end gap-3 transition-colors">
                    <button type="button" onClick={onClose} className="px-5 py-2 text-app-text hover:bg-app-surface-2 rounded-lg font-bold transition-all min-h-[44px] active:scale-95">Cancel</button>
                    <button type="button" onClick={handleSave} className="px-6 py-2.5 bg-navy-900 hover:bg-navy-800 text-white rounded-lg font-bold shadow-lg shadow-navy-900/10 transition-all active:scale-95 transform min-h-[44px]">Save Changes</button>
                </div>
            </div>
        </div>
    );
};

export default ContactEditModal;
