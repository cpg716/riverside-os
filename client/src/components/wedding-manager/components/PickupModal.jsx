import React, { useState } from 'react';
import Icon from './Icon';

const PickupModal = ({ isOpen, onClose, onSave, memberName }) => {

    const [type, setType] = useState('full'); // 'full' or 'partial'
    const [note, setNote] = useState('');
    const [error, setError] = useState('');

    const handleSave = () => {
        if (type === 'partial' && !note.trim()) {
            setError('A note is required for partial pickups (e.g., "Jacket only").');
            return;
        }
        onSave({ type, note });
        onClose();
        // Reset state
        setType('full');
        setNote('');
        setError('');
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-md border border-app-border overflow-hidden">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="ShoppingBag" className="text-gold-500" /> Confirm Pickup
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    <p className="text-app-text">
                        Marking pickup for <span className="font-bold text-app-text">{memberName}</span>.
                    </p>

                    <div className="space-y-3">
                        <label className="flex items-center gap-3 p-3 border border-app-border rounded-lg cursor-pointer hover:bg-app-surface-2 transition-colors">
                            <input
                                type="radio"
                                name="pickupType"
                                value="full"
                                checked={type === 'full'}
                                onChange={() => setType('full')}
                                className="w-5 h-5 text-app-text focus:ring-navy-900"
                            />
                            <div>
                                <div className="font-bold text-app-text">Full Pickup</div>
                                <div className="text-xs text-app-text-muted">All items are being picked up.</div>
                            </div>
                        </label>

                        <label className="flex items-center gap-3 p-3 border border-app-border rounded-lg cursor-pointer hover:bg-app-surface-2 transition-colors">
                            <input
                                type="radio"
                                name="pickupType"
                                value="partial"
                                checked={type === 'partial'}
                                onChange={() => setType('partial')}
                                className="w-5 h-5 text-app-text focus:ring-navy-900"
                            />
                            <div>
                                <div className="font-bold text-app-text">Partial Pickup</div>
                                <div className="text-xs text-app-text-muted">Only some items (e.g., Jacket only).</div>
                            </div>
                        </label>
                    </div>

                    {type === 'partial' && (
                        <div className="animate-fade-in">
                            <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">
                                Partial Pickup Details <span className="text-red-500">*</span>
                            </label>
                            <textarea
                                className="w-full p-3 border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none text-sm"
                                rows="3"
                                placeholder="e.g., Picked up Jacket and Vest only. Pants still being altered."
                                value={note}
                                onChange={(e) => {
                                    setNote(e.target.value);
                                    if (e.target.value.trim()) setError('');
                                }}
                                autoFocus
                            ></textarea>
                            {error && <p className="text-xs text-red-600 mt-1 font-bold">{error}</p>}
                        </div>
                    )}

                    <div className="flex justify-end gap-3 pt-2">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-app-text font-bold hover:bg-app-surface-2 rounded transition-colors">Cancel</button>
                        <button
                            onClick={handleSave}
                            className={`px-6 py-2 font-bold rounded shadow transition-colors text-white ${type === 'partial' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-navy-900 hover:bg-navy-800'}`}
                        >
                            {type === 'partial' ? 'Save Partial Pickup' : 'Confirm Full Pickup'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default PickupModal;
