import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import SchedulerModal from './SchedulerModal';

import { useModal } from '../hooks/useModal';

const MemberAppointmentsModal = ({ isOpen, onClose, member, parties, onRefresh }) => {
    if (!isOpen || !member) return null;

    const { showConfirm, selectSalesperson } = useModal();
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isSchedulerOpen, setIsSchedulerOpen] = useState(false);
    const [apptType, setApptType] = useState('Measurement');

    // Find Party and Salesperson
    const party = parties ? parties.find(p => p.id === member.partyId) : null;
    const partySalesperson = party ? party.salesperson : '';

    useEffect(() => {
        if (isOpen) {
            fetchAppointments();
        }
    }, [isOpen, member]);

    const fetchAppointments = async () => {
        setLoading(true);
        try {
            const allAppts = await api.getAppointments();
            // Filter for this member
            const memberAppts = allAppts.filter(a =>
                a.memberId === member.id &&
                a.partyId === member.partyId
            );
            setAppointments(memberAppts.sort((a, b) => a.datetime.localeCompare(b.datetime)));
        } catch (err) {
            console.error("Failed to fetch appointments:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleDelete = async (id) => {
        const apptToDelete = appointments.find(a => a.id === id);
        if (!apptToDelete) return;

        const confirmed = await showConfirm("Are you sure you want to delete this appointment?", "Delete Appointment", { variant: 'danger', confirmText: 'Delete' });
        if (!confirmed) return;

        const deletedBy = await selectSalesperson();
        if (!deletedBy) return;

        try {
            await api.deleteAppointment(id, deletedBy);

            // Log to Contact History
            const apptDate = new Date(apptToDelete.datetime).toLocaleDateString();
            const newNote = `Deleted appointment on ${apptDate} - ${deletedBy}`;
            const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };

            const updatedHistory = [...(member.contactHistory || []), historyEntry];
            await api.updateMember(member.id, { contactHistory: updatedHistory });

            fetchAppointments();
            if (onRefresh) onRefresh();
        } catch (err) {
            console.error("Failed to delete:", err);
        }
    };

    const handleOpenScheduler = (type) => {
        setApptType(type);
        setIsSchedulerOpen(true);
    };

    const handleEdit = (appt) => {
        setApptType(appt.type);
        setIsSchedulerOpen(true);
        setJumpDate(appt.datetime);
    };
    const [jumpDate, setJumpDate] = useState(null);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy-900/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-app-surface dark:bg-navy-800 rounded-lg shadow-2xl w-full max-w-lg border border-app-border dark:border-navy-700 flex flex-col max-h-[80vh] transition-colors">
                <div className="bg-navy-900 p-4 flex justify-between items-center text-white sticky top-0 z-10 rounded-t-lg">
                    <h3 className="font-bold text-lg flex items-center gap-2">
                        <Icon name="Calendar" /> Appointments: {member.name}
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2/10 p-1 rounded-full transition-colors text-app-text-muted hover:text-white">
                        <Icon name="X" size={20} />
                    </button>
                </div>

                <div className="p-6 overflow-y-auto flex-1">
                    {loading ? (
                        <div className="text-center py-8 text-app-text-muted">Loading...</div>
                    ) : appointments.length > 0 ? (
                        <div className="space-y-3">
                            {appointments.map(appt => (
                                <div key={appt.id} className={`bg-app-surface-2 dark:bg-navy-900 border rounded p-3 flex justify-between items-center hover:bg-app-surface-2 dark:hover:bg-navy-800 transition-colors cursor-pointer group ${appt.status === 'Missed' ? 'border-red-200 bg-red-50/50' : appt.status === 'Attended' ? 'border-green-200 bg-green-50/50' : 'border-app-border dark:border-navy-600'}`} onClick={() => handleEdit(appt)}>
                                    <div>
                                        <div className="font-bold text-app-text dark:text-white flex items-center gap-2">
                                            {new Date(appt.datetime).toLocaleDateString()}
                                            <span className="text-app-text-muted dark:text-app-text-muted text-xs font-normal">
                                                {new Date(appt.datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                            {appt.status === 'Missed' && <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded uppercase font-bold">Missed</span>}
                                            {appt.status === 'Attended' && <span className="text-[10px] bg-green-100 text-green-600 px-1.5 py-0.5 rounded uppercase font-bold">Done</span>}
                                        </div>
                                        <div className="text-sm text-app-text dark:text-app-text-muted font-medium">{appt.type}</div>
                                        {appt.salesperson && (
                                            <div className="text-xs text-app-text-muted dark:text-app-text-muted mt-1 flex items-center gap-1">
                                                <Icon name="User" size={10} /> {appt.salesperson}
                                            </div>
                                        )}
                                        <div className="text-xs text-blue-500 mt-1 font-bold">Click to View/Edit in Schedule</div>
                                    </div>
                                    <button type="button"
                                        onClick={(e) => { e.stopPropagation(); handleDelete(appt.id); }}
                                        className="text-app-text-muted hover:text-red-500 p-2 rounded hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                        title="Delete Appointment"
                                    >
                                        <Icon name="Trash" size={16} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-8 text-app-text-muted italic bg-app-surface-2 dark:bg-navy-900 rounded border border-app-border/80 dark:border-navy-700 border-dashed transition-colors">
                            No appointments scheduled.
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-app-border dark:border-navy-700 bg-app-surface-2 dark:bg-navy-900 rounded-b-lg flex gap-3 transition-colors">
                    <button type="button"
                        onClick={() => { setJumpDate(null); handleOpenScheduler('Measurement'); }}
                        className="flex-1 py-2 bg-app-surface dark:bg-navy-800 border border-app-border dark:border-navy-600 text-app-text dark:text-white font-bold rounded hover:bg-app-surface-2 dark:hover:bg-navy-700 shadow-sm text-sm transition-colors"
                    >
                        Schedule Measurement
                    </button>
                    <button type="button"
                        onClick={() => { setJumpDate(null); handleOpenScheduler('Fitting'); }}
                        className="flex-1 py-2 bg-app-surface dark:bg-navy-800 border border-app-border dark:border-navy-600 text-app-text dark:text-white font-bold rounded hover:bg-app-surface-2 dark:hover:bg-navy-700 shadow-sm text-sm transition-colors"
                    >
                        Schedule Fitting
                    </button>
                </div>
            </div>

            <SchedulerModal
                isOpen={isSchedulerOpen}
                onClose={() => {
                    setIsSchedulerOpen(false);
                    fetchAppointments(); // Refresh list after closing scheduler
                    setJumpDate(null);
                    if (onRefresh) onRefresh(); // Refresh parent (PartyDetail) to update calendar icon
                }}
                parties={parties}
                prefilledMember={{
                    customerName: member.name,
                    phone: member.phone,
                    partyId: member.partyId,
                    memberId: member.id,
                    type: apptType,
                    salesperson: partySalesperson,
                    initialDate: jumpDate
                }}
            />
        </div>
    );
};

export default MemberAppointmentsModal;
