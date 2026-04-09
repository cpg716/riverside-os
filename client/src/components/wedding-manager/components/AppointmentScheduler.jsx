import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import { api, socket } from '../lib/api';
import AppointmentModal from './AppointmentModal';
import { formatDate } from '../lib/utils';

import { useModal } from '../hooks/useModal';

const AppointmentScheduler = ({ parties, prefilledMember, initialDate, onSave }) => {
    const { showConfirm, selectSalesperson } = useModal();
    const [appointments, setAppointments] = useState([]);

    const [selectedDate, setSelectedDate] = useState(initialDate ? new Date(initialDate) : new Date());
    const [viewMode, setViewMode] = useState('day'); // 'day' or 'week'
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedAppt, setSelectedAppt] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchAppointments();

        socket.on('appointments_updated', () => {
            fetchAppointments();
        });

        return () => {
            socket.off('appointments_updated');
        };
    }, [selectedDate, viewMode]);

    const fetchAppointments = async () => {
        setLoading(true);
        try {
            let startStr, endStr;
            const start = new Date(selectedDate);

            if (viewMode === 'day') {
                startStr = start.toISOString().split('T')[0] + 'T00:00:00';
                endStr = start.toISOString().split('T')[0] + 'T23:59:59';
            } else {
                // Week view logic
                const day = start.getDay();
                const diff = start.getDate() - day + (day === 0 ? -6 : 1);
                start.setDate(diff);
                startStr = start.toISOString().split('T')[0] + 'T00:00:00';

                const end = new Date(start);
                end.setDate(start.getDate() + 6);
                endStr = end.toISOString().split('T')[0] + 'T23:59:59';
            }

            const data = await api.getAppointments(startStr, endStr);
            setAppointments(data);
        } catch (err) {
            console.error("Failed to fetch appointments:", err);
        } finally {
            setLoading(false);
        }
    };

    const handlePrev = () => {
        const newDate = new Date(selectedDate);
        if (viewMode === 'day') newDate.setDate(newDate.getDate() - 1);
        else newDate.setDate(newDate.getDate() - 7);
        setSelectedDate(newDate);
    };

    const handleNext = () => {
        const newDate = new Date(selectedDate);
        if (viewMode === 'day') newDate.setDate(newDate.getDate() + 1);
        else newDate.setDate(newDate.getDate() + 7);
        setSelectedDate(newDate);
    };

    const handleToday = () => {
        setSelectedDate(new Date());
    };

    const handleAddAppt = (timeSlot) => {
        setSelectedAppt({
            datetime: `${selectedDate.toISOString().split('T')[0]}T${timeSlot || '10:00'}:00`,
            ...(prefilledMember || {})
        });
        setIsModalOpen(true);
    };

    const handleEditAppt = (appt) => {
        setSelectedAppt(appt);
        setIsModalOpen(true);
    };

    const handleDeleteAppt = async (e, apptId) => {
        e.stopPropagation();
        const confirmed = await showConfirm(
            "Are you sure you want to delete this appointment?",
            "Delete Appointment",
            { variant: 'danger', confirmText: 'Delete' }
        );
        if (confirmed) {
            const deletedBy = await selectSalesperson();
            if (!deletedBy) return;

            try {
                // We need to get the appointment details first to log it properly if we want to add to member history
                // But we only have the ID here. 
                // We can find it in the `appointments` prop if available?
                // `appointments` is passed as prop.
                const apptToDelete = appointments.find(a => a.id === apptId);

                await api.deleteAppointment(apptId, deletedBy);

                if (apptToDelete && apptToDelete.memberId) {
                    const apptDate = new Date(apptToDelete.datetime).toLocaleDateString();
                    const newNote = `Deleted appointment on ${apptDate} - ${deletedBy}`;
                    try {
                        // Fetch member to get current history
                        const member = await api.getMember(apptToDelete.memberId);
                        if (member) {
                            const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
                            const updatedHistory = [...(member.contactHistory || []), historyEntry];
                            await api.updateMember(apptToDelete.memberId, { contactHistory: updatedHistory });
                        }
                    } catch (err) {
                        console.error("Failed to update member history on delete:", err);
                    }
                }

                if (onSave) onSave();
            } catch (err) {
                console.error("Failed to delete appointment:", err);
                showAlert("Failed to delete appointment.", "Error", { variant: 'danger' });
            }
        }
    };

    // Filter appointments for display
    const filteredAppointments = useMemo(() => {
        // Construct YYYY-MM-DD in local time to match the selectedDate display
        const year = selectedDate.getFullYear();
        const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
        const day = String(selectedDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        return appointments
            .filter(a => a.datetime.startsWith(dateStr) && a.status !== 'Attended' && a.status !== 'Missed')
            .sort((a, b) => a.datetime.localeCompare(b.datetime));
    }, [appointments, selectedDate]);

    // Generate time slots for Day View
    const timeSlots = [];
    for (let i = 9; i <= 18; i++) {
        timeSlots.push(`${i.toString().padStart(2, '0')}:00`);
        timeSlots.push(`${i.toString().padStart(2, '0')}:30`);
    }

    return (
        <div className="h-full flex flex-col bg-app-surface rounded-lg shadow-sm border border-app-border overflow-hidden print:fixed print:inset-0 print:z-[9999] print:bg-app-surface print:h-screen print:w-screen print:overflow-visible print:scale-[0.85] print:origin-top">
            {/* Header Controls */}
            <div className="p-4 border-b border-app-border flex justify-between items-center bg-app-surface-2 print:hidden">
                <div className="flex items-center gap-4">
                    <h2 className="text-xl font-bold text-app-text flex items-center gap-2">
                        <Icon name="Calendar" /> Appointment Schedule
                    </h2>
                    <div className="flex items-center bg-app-surface rounded-lg border border-app-border p-1 shadow-sm">
                        <button type="button" onClick={handlePrev} className="p-1.5 hover:bg-app-border/50 rounded text-app-text"><Icon name="ChevronLeft" /></button>
                        <input
                            type="date"
                            className="outline-none text-sm font-bold text-app-text px-2 bg-transparent"
                            value={selectedDate.toISOString().split('T')[0]}
                            onChange={(e) => {
                                if (e.target.value) {
                                    const [y, m, d] = e.target.value.split('-').map(Number);
                                    setSelectedDate(new Date(y, m - 1, d));
                                }
                            }}
                        />
                        <button type="button" onClick={handleNext} className="p-1.5 hover:bg-app-border/50 rounded text-app-text"><Icon name="ChevronRight" /></button>
                        <div className="flex bg-app-surface rounded-lg border border-app-border p-0.5 shadow-sm ml-4">
                            <button type="button"
                                onClick={() => setViewMode('day')}
                                className={`px-3 py-1 text-xs font-bold rounded ${viewMode === 'day' ? 'bg-navy-900 text-white' : 'text-app-text-muted hover:bg-app-surface-2'}`}
                            >
                                Day
                            </button>
                            <button type="button"
                                onClick={() => setViewMode('week')}
                                className={`px-3 py-1 text-xs font-bold rounded ${viewMode === 'week' ? 'bg-navy-900 text-white' : 'text-app-text-muted hover:bg-app-surface-2'}`}
                            >
                                Week
                            </button>
                        </div>
                    </div>
                    <button type="button" onClick={handleToday} className="ml-2 text-sm font-bold text-app-text hover:underline">Today</button>
                </div>

                <div className="flex gap-2">
                    <button type="button"
                        onClick={() => window.print()}
                        className="flex items-center gap-1 px-3 py-2 bg-app-surface border border-app-border text-app-text font-bold rounded hover:bg-app-surface-2 text-sm"
                    >
                        <Icon name="Printer" size={16} /> Print
                    </button>
                    <button type="button"
                        onClick={() => handleAddAppt()}
                        className="flex items-center gap-1 px-3 py-2 bg-gold-500 text-white font-bold rounded hover:bg-gold-600 shadow-sm text-sm"
                    >
                        <Icon name="Plus" size={16} /> New Appt
                    </button>
                </div>
            </div>

            {/* Print Header */}
            <div className="hidden print:block text-center mb-8 mt-8">
                <h1 className="text-3xl font-bold text-app-text">{formatDate(selectedDate)}</h1>
                <p className="text-app-text-muted text-lg">Daily Schedule</p>
            </div>

            {/* Scheduler Grid */}
            <div className="flex-1 overflow-y-auto p-4 print:p-0 print:overflow-visible bg-app-surface-2/50">
                {viewMode === 'day' ? (
                    <div className="max-w-4xl mx-auto bg-app-surface border border-app-border shadow-sm rounded-lg overflow-hidden print:shadow-none print:border-0 print:w-full">
                        <div className="grid grid-cols-[80px_1fr] divide-y divide-app-border/80">
                            {timeSlots.map(time => {
                                const dateStr = selectedDate.toISOString().split('T')[0];
                                const slotAppts = appointments.filter(a => a.datetime === `${dateStr}T${time}:00`);

                                return (
                                    <div key={time} className="contents group">
                                        <div className="p-3 text-right text-xs font-bold text-app-text-muted border-r border-app-border/80 bg-app-surface-2/50">
                                            {parseInt(time.split(':')[0]) > 12 ? parseInt(time.split(':')[0]) - 12 : parseInt(time.split(':')[0])}:{time.split(':')[1]} {parseInt(time.split(':')[0]) >= 12 ? 'PM' : 'AM'}
                                        </div>
                                        <div
                                            className="p-1 min-h-[60px] relative hover:bg-app-surface-2 transition-colors cursor-pointer border-b border-app-border/80 flex gap-1 overflow-x-auto print:overflow-visible print:flex-wrap"
                                            onClick={() => handleAddAppt(time)}
                                        >
                                            {slotAppts.map(appt => (
                                                <AppointmentCard key={appt.id} appt={appt} onEdit={handleEditAppt} onDelete={handleDeleteAppt} />
                                            ))}
                                            <button type="button"
                                                onClick={(e) => { e.stopPropagation(); handleAddAppt(time); }}
                                                className="min-w-[40px] bg-app-surface-2 hover:bg-app-surface-2 text-app-text-muted hover:text-app-text rounded border border-dashed border-app-border flex items-center justify-center transition-colors print:hidden mb-1"
                                                title="Add another appointment"
                                            >
                                                <Icon name="Plus" size={16} />
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    /* Week View */
                    <div className="bg-app-surface border border-app-border shadow-sm rounded-lg overflow-hidden min-w-[800px]">
                        <div className="grid grid-cols-8 divide-x divide-app-border border-b border-app-border">
                            <div className="bg-app-surface-2 p-2 border-r border-app-border"></div>
                            {Array.from({ length: 7 }).map((_, i) => {
                                const d = new Date(selectedDate);
                                const day = d.getDay();
                                const diff = d.getDate() - day + (day === 0 ? -6 : 1) + i;
                                d.setDate(diff);
                                const isToday = d.toDateString() === new Date().toDateString();
                                return (
                                    <div key={i} className={`p-2 text-center bg-app-surface-2 ${isToday ? 'bg-blue-50' : ''}`}>
                                        <div className="text-[10px] font-bold text-app-text-muted uppercase">
                                            {d.toLocaleDateString('en-US', { weekday: 'short' })}
                                        </div>
                                        <div className={`text-sm font-bold ${isToday ? 'text-blue-600' : 'text-app-text'}`}>
                                            {d.getDate()}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="grid grid-cols-8 divide-x divide-app-border h-[600px] overflow-y-auto relative">
                            {/* Time Column */}
                            <div className="flex flex-col bg-app-surface-2/50">
                                {timeSlots.filter((_, i) => i % 2 === 0).map(time => (
                                    <div key={time} className="h-20 p-2 text-right text-[10px] font-bold text-app-text-muted border-b border-app-border/80">
                                        {parseInt(time.split(':')[0]) > 12 ? parseInt(time.split(':')[0]) - 12 : parseInt(time.split(':')[0])} {parseInt(time.split(':')[0]) >= 12 ? 'PM' : 'AM'}
                                    </div>
                                ))}
                            </div>
                            {/* Days Columns */}
                            {Array.from({ length: 7 }).map((_, colIdx) => {
                                const columnDate = new Date(selectedDate);
                                const day = columnDate.getDay();
                                const diff = columnDate.getDate() - day + (day === 0 ? -6 : 1) + colIdx;
                                columnDate.setDate(diff);
                                const dateStr = columnDate.toISOString().split('T')[0];

                                return (
                                    <div key={colIdx} className="flex flex-col relative group">
                                        {timeSlots.filter((_, i) => i % 2 === 0).map(time => (
                                            <div
                                                key={time}
                                                className="h-20 border-b border-app-border/80 hover:bg-app-surface-2 transition-colors cursor-pointer p-1 space-y-1"
                                                onClick={() => {
                                                    setSelectedDate(columnDate);
                                                    handleAddAppt(time);
                                                }}
                                            >
                                                {appointments.filter(a => a.datetime.startsWith(`${dateStr}T${time.slice(0, 2)}`))
                                                    .map(appt => (
                                                        <div
                                                            key={appt.id}
                                                            onClick={(e) => { e.stopPropagation(); handleEditAppt(appt); }}
                                                            className={`p-1 rounded text-[9px] font-bold border-l-2 shadow-sm truncate
                                                                ${appt.type === 'Measurement' ? 'bg-blue-50 border-blue-500 text-blue-900' :
                                                                    appt.type === 'Fitting' ? 'bg-gold-50 border-gold-500 text-gold-900' :
                                                                        appt.type === 'Pickup' ? 'bg-green-50 border-green-500 text-green-900' :
                                                                            'bg-app-surface-2 border-app-text-muted text-app-text'}`}
                                                            title={`${appt.customerName} - ${appt.type}`}
                                                        >
                                                            {appt.customerName.split(' ')[0]} - {appt.type.charAt(0)}
                                                        </div>
                                                    ))}
                                            </div>
                                        ))}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>

            <AppointmentModal
                isOpen={isModalOpen}
                onClose={() => setIsModalOpen(false)}
                onSave={() => {
                    fetchAppointments();
                    if (onSave) onSave();
                }}
                initialData={selectedAppt}
                parties={parties}
            />
        </div>
    );
};

const AppointmentCard = ({ appt, onEdit, onDelete }) => (
    <div
        onClick={(e) => { e.stopPropagation(); onEdit(appt); }}
        className={`mb-1 p-2 rounded border-l-4 shadow-sm text-xs cursor-pointer hover:brightness-95 transition-all flex flex-col justify-between flex-1 min-w-[140px]
            ${appt.type === 'Measurement' ? 'bg-blue-50 border-blue-500 text-blue-900' :
                appt.type === 'Fitting' ? 'bg-gold-50 border-gold-500 text-gold-900' :
                    appt.type === 'Pickup' ? 'bg-green-50 border-green-500 text-green-900' :
                        'bg-app-surface-2 border-app-text-muted text-app-text'}`}
    >
        <div>
            <div className="font-bold text-sm truncate">{appt.customerName || 'Unknown'}</div>
            <div className="opacity-80 truncate">{appt.type} • {appt.phone}</div>
            {appt.salesperson && (
                <div className="text-xs font-bold text-app-text mt-0.5 flex items-center gap-1">
                    <Icon name="User" size={10} /> {appt.salesperson}
                </div>
            )}
            {appt.notes && <div className="mt-1 italic opacity-70 truncate max-w-[120px]">{appt.notes}</div>}
        </div>
        <button type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(e, appt.id); }}
            className="text-app-text-muted hover:text-red-500 p-2 -mr-1 -mb-1 self-end print:hidden touch-target"
            title="Delete Appointment"
        >
            <Icon name="Trash" size={16} />
        </button>
    </div>
);

export default AppointmentScheduler;
