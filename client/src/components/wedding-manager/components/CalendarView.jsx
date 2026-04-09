import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import { api, socket } from '../lib/api';
import { formatDate } from '../lib/utils';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const TYPE_COLORS = {
    'Measurement': { bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
    'Fitting': { bg: 'bg-amber-100', text: 'text-amber-700', dot: 'bg-amber-500' },
    'Pickup': { bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
    'Other': { bg: 'bg-app-surface-2', text: 'text-app-text', dot: 'bg-app-text-muted' },
};

const STATUS_STYLES = {
    'Scheduled': '',
    'Attended': 'opacity-50 line-through',
    'Missed': 'opacity-40 line-through decoration-red-400',
    'Cancelled': 'opacity-30 line-through',
};

const CalendarView = ({ parties, onEditAppt }) => {
    const [currentDate, setCurrentDate] = useState(new Date());
    const [appointments, setAppointments] = useState([]);
    const [selectedDay, setSelectedDay] = useState(null);
    const [loading, setLoading] = useState(true);

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    // Fetch appointments for the current month (plus surrounding days visible in the grid)
    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const firstDay = new Date(year, month, 1);
                const lastDay = new Date(year, month + 1, 0);
                // Extend range to cover visible overflow days
                const start = new Date(firstDay);
                start.setDate(start.getDate() - firstDay.getDay());
                const end = new Date(lastDay);
                end.setDate(end.getDate() + (6 - lastDay.getDay()));

                const startStr = start.toISOString().split('T')[0];
                const endStr = end.toISOString().split('T')[0] + 'T23:59:59';

                const data = await api.getAppointments(startStr, endStr);
                setAppointments(data);
            } catch (err) {
                console.error('Failed to load appointments:', err);
            } finally {
                setLoading(false);
            }
        };
        fetchData();
    }, [year, month]);

    // Listen for real-time updates
    useEffect(() => {
        const handler = () => {
            const firstDay = new Date(year, month, 1);
            const lastDay = new Date(year, month + 1, 0);
            const start = new Date(firstDay);
            start.setDate(start.getDate() - firstDay.getDay());
            const end = new Date(lastDay);
            end.setDate(end.getDate() + (6 - lastDay.getDay()));
            api.getAppointments(
                start.toISOString().split('T')[0],
                end.toISOString().split('T')[0] + 'T23:59:59'
            ).then(setAppointments).catch(console.error);
        };
        socket.on('appointments_updated', handler);
        return () => socket.off('appointments_updated', handler);
    }, [year, month]);

    // Build calendar grid
    const calendarDays = useMemo(() => {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startOffset = firstDay.getDay();
        const totalDays = lastDay.getDate();

        const days = [];

        // Previous month's overflow
        for (let i = startOffset - 1; i >= 0; i--) {
            const d = new Date(year, month, -i);
            days.push({ date: d, isCurrentMonth: false, day: d.getDate() });
        }

        // Current month
        for (let d = 1; d <= totalDays; d++) {
            days.push({ date: new Date(year, month, d), isCurrentMonth: true, day: d });
        }

        // Next month's overflow to fill 6 rows
        const remaining = 42 - days.length;
        for (let d = 1; d <= remaining; d++) {
            const date = new Date(year, month + 1, d);
            days.push({ date, isCurrentMonth: false, day: d });
        }

        return days;
    }, [year, month]);

    // Group appointments by day key
    const apptsByDay = useMemo(() => {
        const map = {};
        appointments.forEach(appt => {
            const dayKey = appt.datetime.split('T')[0];
            if (!map[dayKey]) map[dayKey] = [];
            map[dayKey].push(appt);
        });
        // Sort each day's appointments by time
        Object.values(map).forEach(arr => arr.sort((a, b) => a.datetime.localeCompare(b.datetime)));
        return map;
    }, [appointments]);

    // Get wedding dates for the visible range (mark on calendar)
    const weddingDates = useMemo(() => {
        if (!parties) return new Set();
        return new Set(parties.filter(p => p.date).map(p => p.date));
    }, [parties]);

    const today = new Date();
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const getDayKey = (date) => {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };

    const goToday = () => {
        setCurrentDate(new Date());
        setSelectedDay(todayKey);
    };

    const goPrev = () => {
        setCurrentDate(new Date(year, month - 1, 1));
        setSelectedDay(null);
    };

    const goNext = () => {
        setCurrentDate(new Date(year, month + 1, 1));
        setSelectedDay(null);
    };

    const selectedAppts = selectedDay ? (apptsByDay[selectedDay] || []) : [];

    const formatTime = (dt) => {
        if (!dt) return '';
        const timePart = dt.split('T')[1];
        if (!timePart) return '';
        const [h, m] = timePart.split(':');
        const hour = parseInt(h);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const hour12 = hour % 12 || 12;
        return `${hour12}:${m} ${ampm}`;
    };

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-app-surface rounded-xl shadow-sm border border-app-border mb-4">
                <div className="flex items-center gap-2">
                    <button type="button" onClick={goPrev} className="p-2 hover:bg-app-surface-2 rounded-lg transition-colors active:scale-95">
                        <Icon name="ChevronLeft" size={18} className="text-app-text" />
                    </button>
                    <button type="button" onClick={goNext} className="p-2 hover:bg-app-surface-2 rounded-lg transition-colors active:scale-95">
                        <Icon name="ChevronRight" size={18} className="text-app-text" />
                    </button>
                    <h2 className="text-lg font-extrabold text-app-text ml-2">
                        {MONTH_NAMES[month]} {year}
                    </h2>
                </div>
                <div className="flex items-center gap-2">
                    <button type="button" onClick={goToday} className="px-4 py-1.5 bg-navy-800 text-white text-xs font-bold rounded-lg hover:bg-navy-900 transition-colors active:scale-95">
                        Today
                    </button>
                    {/* Legend */}
                    <div className="hidden md:flex items-center gap-3 ml-4 text-[10px] font-semibold text-app-text-muted">
                        {Object.entries(TYPE_COLORS).filter(([k]) => k !== 'Other').map(([type, c]) => (
                            <span key={type} className="flex items-center gap-1">
                                <span className={`w-2 h-2 rounded-full ${c.dot}`} />{type}
                            </span>
                        ))}
                        <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-full bg-pink-400" />Wedding
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
                {/* Calendar Grid */}
                <div className="flex-1 bg-app-surface rounded-xl shadow-sm border border-app-border overflow-hidden flex flex-col">
                    {/* Day Headers */}
                    <div className="grid grid-cols-7 border-b border-app-border">
                        {DAY_NAMES.map(d => (
                            <div key={d} className="text-center text-[10px] font-extrabold text-app-text-muted uppercase tracking-wider py-2.5 bg-app-surface-2">
                                {d}
                            </div>
                        ))}
                    </div>

                    {/* Day Cells */}
                    <div className="grid grid-cols-7 flex-1 auto-rows-fr">
                        {calendarDays.map((dayObj, idx) => {
                            const key = getDayKey(dayObj.date);
                            const dayAppts = apptsByDay[key] || [];
                            const isToday = key === todayKey;
                            const isSelected = key === selectedDay;
                            const isWedding = weddingDates.has(key);
                            const activeAppts = dayAppts.filter(a => a.status !== 'Cancelled');

                            return (
                                <div
                                    key={idx}
                                    onClick={() => setSelectedDay(isSelected ? null : key)}
                                    className={`
                                        border-b border-r border-app-border/80 p-1.5 cursor-pointer transition-all min-h-[70px] relative
                                        ${!dayObj.isCurrentMonth ? 'bg-app-surface-2/50' : 'hover:bg-app-surface-2'}
                                        ${isSelected ? 'bg-navy-50 ring-2 ring-navy-400 ring-inset' : ''}
                                    `}
                                >
                                    <div className="flex items-center justify-between mb-0.5">
                                        <span className={`
                                            text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full
                                            ${isToday ? 'bg-navy-800 text-white' : ''}
                                            ${!dayObj.isCurrentMonth ? 'text-app-text-muted' : 'text-app-text'}
                                        `}>
                                            {dayObj.day}
                                        </span>
                                        {isWedding && (
                                            <span className="w-2 h-2 rounded-full bg-pink-400 flex-shrink-0" title="Wedding date" />
                                        )}
                                    </div>

                                    {/* Appointment dots/chips */}
                                    <div className="space-y-0.5">
                                        {activeAppts.slice(0, 3).map((appt, i) => {
                                            const colors = TYPE_COLORS[appt.type] || TYPE_COLORS['Other'];
                                            return (
                                                <div key={i} className={`${colors.bg} ${colors.text} text-[9px] font-semibold rounded px-1 py-0.5 truncate leading-tight`}>
                                                    {formatTime(appt.datetime)} {appt.customerName?.split(' ')[0] || appt.type}
                                                </div>
                                            );
                                        })}
                                        {activeAppts.length > 3 && (
                                            <div className="text-[9px] font-bold text-app-text-muted px-1">+{activeAppts.length - 3} more</div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Selected Day Detail Panel */}
                <div className={`lg:w-80 bg-app-surface rounded-xl shadow-sm border border-app-border flex flex-col transition-all ${selectedDay ? '' : 'hidden lg:flex'}`}>
                    <div className="p-4 border-b border-app-border">
                        <h3 className="text-sm font-extrabold text-app-text">
                            {selectedDay
                                ? formatDate(selectedDay)
                                : 'Select a day'
                            }
                        </h3>
                        {selectedDay && (
                            <p className="text-xs text-app-text-muted mt-0.5">
                                {selectedAppts.length} appointment{selectedAppts.length !== 1 ? 's' : ''}
                            </p>
                        )}
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
                        {!selectedDay ? (
                            <div className="flex flex-col items-center justify-center py-10 text-app-text-muted">
                                <Icon name="Calendar" size={32} className="mb-2 opacity-40" />
                                <p className="text-sm font-medium">Click a day to view details</p>
                            </div>
                        ) : selectedAppts.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-10 text-app-text-muted">
                                <Icon name="CalendarOff" size={28} className="mb-2 opacity-40" />
                                <p className="text-sm font-medium">No appointments</p>
                            </div>
                        ) : (
                            selectedAppts.map(appt => {
                                const colors = TYPE_COLORS[appt.type] || TYPE_COLORS['Other'];
                                const statusStyle = STATUS_STYLES[appt.status] || '';
                                return (
                                    <div
                                        key={appt.id}
                                        className={`p-3 rounded-lg border border-app-border hover:border-app-border transition-colors ${statusStyle}`}
                                    >
                                        <div className="flex items-center justify-between mb-1">
                                            <span className={`text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full ${colors.bg} ${colors.text}`}>
                                                {appt.type}
                                            </span>
                                            <span className="text-xs font-bold text-app-text">{formatTime(appt.datetime)}</span>
                                        </div>
                                        <p className="text-sm font-bold text-app-text truncate">{appt.customerName}</p>
                                        {appt.phone && (
                                            <p className="text-[10px] text-app-text-muted">{appt.phone}</p>
                                        )}
                                        {appt.salesperson && (
                                            <p className="text-[10px] text-app-text-muted mt-0.5">
                                                <span className="font-semibold">Staff:</span> {appt.salesperson}
                                            </p>
                                        )}
                                        {appt.notes && (
                                            <p className="text-[10px] text-app-text-muted mt-1 italic truncate">{appt.notes}</p>
                                        )}
                                        {appt.status && appt.status !== 'Scheduled' && (
                                            <span className={`inline-block mt-1 text-[9px] font-bold px-1.5 py-0.5 rounded ${appt.status === 'Attended' ? 'bg-emerald-100 text-emerald-700' :
                                                    appt.status === 'Missed' ? 'bg-red-100 text-red-700' :
                                                        'bg-app-surface-2 text-app-text-muted'
                                                }`}>
                                                {appt.status}
                                            </span>
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CalendarView;
