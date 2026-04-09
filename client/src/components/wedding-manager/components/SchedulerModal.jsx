import React from 'react';
import Icon from './Icon';
import AppointmentScheduler from './AppointmentScheduler';

const SchedulerModal = ({ isOpen, onClose, parties, prefilledMember }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/80 backdrop-blur-sm animate-fade-in">
            <div className="bg-app-surface dark:bg-navy-800 rounded-lg shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col relative transition-colors">
                <button type="button"
                    onClick={onClose}
                    className="absolute -top-3 -right-3 z-50 p-2 bg-app-surface dark:bg-navy-700 rounded-full shadow-lg hover:bg-app-surface-2 dark:hover:bg-navy-600 transition-colors border border-app-border dark:border-navy-600 text-app-text-muted dark:text-white"
                >
                    <Icon name="X" size={20} />
                </button>

                <div className="flex-1 overflow-hidden p-2">
                    <AppointmentScheduler
                        parties={parties}
                        prefilledMember={prefilledMember}
                        initialDate={prefilledMember?.initialDate}
                        onSave={onClose} // Close modal on save, and maybe trigger refresh?
                    // Actually AppointmentScheduler doesn't have onSave prop yet.
                    // We need to add it.
                    />
                </div>
            </div>
        </div>
    );
};

export default SchedulerModal;
