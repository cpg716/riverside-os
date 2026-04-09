import React, { useState } from 'react';
import Icon from './Icon';

import { useModal } from '../hooks/useModal';

const MeasurementInfoModal = ({ isOpen, onClose, onSave }) => {
    if (!isOpen) return null;

    const { showAlert } = useModal();
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [source, setSource] = useState('');

    const handleSave = () => {
        if (!source.trim()) {
            showAlert("Please enter who provided the measurements.", "Missing Information", { variant: 'warning' });
            return;
        }
        onSave({ date, source });
        setSource(''); // Reset
        setDate(new Date().toISOString().split('T')[0]);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-xl w-full max-w-md overflow-hidden border border-app-border">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Ruler" className="text-gold-500" /> Record Measurements
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    <p className="text-sm text-app-text mb-2">
                        This member has no measurement appointment. Please record the details of these measurements.
                    </p>

                    <div>
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Date Received</label>
                        <input
                            type="date"
                            className="w-full p-2 border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none text-app-text"
                            value={date}
                            onChange={(e) => setDate(e.target.value)}
                        />
                    </div>

                    <div>
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Source (Who/Where)</label>
                        <input
                            type="text"
                            className="w-full p-2 border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none text-app-text"
                            placeholder="e.g. Called in by Groom, Men's Wearhouse, etc."
                            value={source}
                            onChange={(e) => setSource(e.target.value)}
                            autoFocus
                        />
                    </div>

                    <div className="flex justify-end gap-3 pt-4">
                        <button type="button" onClick={onClose} className="px-4 py-2 text-app-text font-bold hover:bg-app-surface-2 rounded transition-colors">Cancel</button>
                        <button type="button" onClick={handleSave} className="px-6 py-2 bg-navy-900 hover:bg-navy-800 text-white font-bold rounded shadow transition-colors">Save & Mark Done</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MeasurementInfoModal;
