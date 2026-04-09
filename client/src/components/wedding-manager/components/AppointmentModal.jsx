import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';

import { useModal } from '../hooks/useModal';

const APPT_CUSTOMER_SEARCH_PAGE = 40;

const AppointmentModal = ({ isOpen, onClose, onSave, initialData, parties: _parties = [] }) => {
    if (!isOpen) return null;

    const { showAlert, showConfirm, selectSalesperson } = useModal();
    const [formData, setFormData] = useState({
        type: 'Measurement',
        date: new Date().toISOString().split('T')[0],
        time: '10:00',
        customerName: '',
        phone: '',
        notes: '',
        partyId: '',
        memberId: '',
        customerId: '',
        salesperson: ''
    });

    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [searchLoadMoreBusy, setSearchLoadMoreBusy] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const [salespeople, setSalespeople] = useState([]);
    const [conflicts, setConflicts] = useState([]);

    useEffect(() => {
        const fetchSalespeople = async () => {
            try {
                const data = await api.getSalespeopleForAppointments();
                setSalespeople(data);
            } catch (err) {
                console.error("Failed to fetch salespeople:", err);
            }
        };
        fetchSalespeople();
    }, []);

    useEffect(() => {
        if (initialData) {
            // If datetime is provided, use it. Otherwise default to today/now.
            let dateStr = new Date().toISOString().split('T')[0];
            let timeStr = '10:00';

            if (initialData.datetime) {
                const dt = new Date(initialData.datetime);
                if (!isNaN(dt.getTime())) {
                    dateStr = dt.toISOString().split('T')[0];
                    timeStr = dt.toTimeString().slice(0, 5);
                }
            }

            setFormData(prev => ({
                ...prev,
                ...initialData,
                date: dateStr,
                time: timeStr,
                partyId: initialData.partyId || '',
                memberId: initialData.memberId || '',
                customerId: initialData.customerId || '',
                salesperson: (initialData.salesperson || '').trim()
            }));

            if (initialData.customerName) setSearchTerm(initialData.customerName);
        } else {
            // Reset
            setFormData({
                type: 'Measurement',
                date: new Date().toISOString().split('T')[0],
                time: '10:00',
                customerName: '',
                phone: '',
                notes: '',
                partyId: '',
                memberId: '',
                customerId: '',
                salesperson: ''
            });
            setSearchTerm('');
        }
    }, [initialData, isOpen]);

    /** Party / legacy appointments may name someone not in the ROS salesperson-role list; keep them selectable. */
    const normSp = (s) => (s || '').trim().toLowerCase();

    const salespersonOptions = useMemo(() => {
        const base = [...salespeople];
        const cur = (formData.salesperson || '').trim();
        if (cur && !base.some((sp) => normSp(sp) === normSp(cur))) {
            base.push(cur);
        }
        return base.sort((a, b) =>
            a.localeCompare(b, undefined, { sensitivity: 'base' })
        );
    }, [salespeople, formData.salesperson]);

    const salespersonSelectValue = useMemo(() => {
        const raw = formData.salesperson || '';
        const t = raw.trim();
        if (!t) return '';
        const hit = salespersonOptions.find((sp) => normSp(sp) === normSp(t));
        return hit ?? '';
    }, [formData.salesperson, salespersonOptions]);

    // Align stored value with ROS display name when it matches (case / whitespace).
    useEffect(() => {
        if (!salespeople.length) return;
        setFormData((prev) => {
            const t = (prev.salesperson || '').trim();
            if (!t) return prev;
            const hit = salespeople.find((sp) => normSp(sp) === normSp(t));
            if (hit && hit !== prev.salesperson) {
                return { ...prev, salesperson: hit };
            }
            return prev;
        });
    }, [salespeople]);

    const rosCustomerLabel = (c) => {
        const n = `${c.first_name || ''} ${c.last_name || ''}`.trim();
        if (n) return n;
        if (c.company_name && String(c.company_name).trim()) return String(c.company_name).trim();
        return c.customer_code || '';
    };

    // Search ROS customers (same directory as POS / CRM)
    useEffect(() => {
        if (searchTerm.length < 2 || formData.memberId) {
            setSearchResults([]);
            setSearchHasMore(false);
            return;
        }

        const t = setTimeout(async () => {
            setIsSearching(true);
            try {
                const rows = await api.searchCustomers(searchTerm, {
                    limit: APPT_CUSTOMER_SEARCH_PAGE,
                    offset: 0,
                });
                const list = rows || [];
                setSearchResults(list);
                setSearchHasMore(list.length === APPT_CUSTOMER_SEARCH_PAGE);
            } catch (err) {
                console.error('Customer search failed:', err);
                setSearchResults([]);
                setSearchHasMore(false);
            } finally {
                setIsSearching(false);
            }
        }, 300);
        return () => clearTimeout(t);
    }, [searchTerm, formData.memberId]);

    // Check for conflicts in real-time
    useEffect(() => {
        const checkConflicts = async () => {
            if (!formData.date || !formData.salesperson || !formData.time) {
                setConflicts([]);
                return;
            }
            try {
                const results = await api.getConflicts(formData.date, formData.salesperson, initialData?.id);
                // Filter specifically for the same time
                const sameTime = results.filter(a => a.datetime.includes(formData.time));
                setConflicts(sameTime);
            } catch (err) {
                console.error("Conflict check failed:", err);
            }
        };
        const timer = setTimeout(checkConflicts, 500);
        return () => clearTimeout(timer);
    }, [formData.date, formData.time, formData.salesperson, initialData]);

    const handleSelectRosCustomer = (c) => {
        const label = rosCustomerLabel(c);
        if (c.wedding_member_id && c.wedding_party_id) {
            setFormData({
                ...formData,
                customerName: label,
                phone: c.phone || '',
                partyId: c.wedding_party_id,
                memberId: c.wedding_member_id,
                customerId: c.id
            });
        } else {
            setFormData({
                ...formData,
                customerName: label,
                phone: c.phone || '',
                partyId: '',
                memberId: '',
                customerId: c.id
            });
        }
        setSearchTerm(label);
        setSearchResults([]);
    };

    const checkAvailability = async (date, time, salesperson) => {
        if (!salesperson) return true; // No salesperson selected, no conflict
        try {
            // Fetch appointments for the day
            const start = `${date}T00:00:00`;
            const end = `${date}T23:59:59`;
            const dayAppts = await api.getAppointments(start, end);

            // Check for conflict
            const conflict = dayAppts.find(a =>
                a.salesperson === salesperson &&
                a.datetime.includes(time) &&
                a.id !== initialData?.id // Ignore self if editing
            );

            if (conflict) {
                const confirmed = await showConfirm(
                    `${salesperson} already has an appointment at ${time}. Do you want to schedule this anyway?`,
                    "Schedule Conflict",
                    { variant: 'warning', confirmText: 'Yes, Schedule Anyway', cancelText: 'No, Cancel' }
                );
                if (!confirmed) return false;
            }
            return true;
        } catch (err) {
            console.error("Failed to check availability:", err);
            return true; // Assume ok on error? Or block?
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // 1. Check Availability
        const isAvailable = await checkAvailability(formData.date, formData.time, formData.salesperson);
        if (!isAvailable) return;

        // 2. Confirm Working Day
        if (formData.salesperson) {
            // Append T00:00:00 to ensure local time parsing, preventing off-by-one error due to UTC conversion
            const dateObj = new Date(`${formData.date}T00:00:00`);
            const confirmed = await showConfirm(`Is ${formData.salesperson} working on ${dateObj.toLocaleDateString()}?`, "Confirm Schedule");
            if (!confirmed) return;
        }

        // 3. Prompt for "Who is Scheduling"
        const scheduler = await selectSalesperson();
        if (!scheduler) return;

        const datetime = `${formData.date}T${formData.time}:00`;

        const apptData = {
            ...formData,
            datetime,
            customerName: searchTerm, // Ensure name is captured even if not linked
            createdBy: scheduler // Log who created/updated this
        };

        try {
            if (initialData && initialData.id) {
                await api.updateAppointment(initialData.id, apptData);
            } else {
                await api.addAppointment(apptData);
            }
            onSave();
            onClose();
        } catch (err) {
            console.error("Failed to save appointment:", err);
            showAlert("Failed to save appointment.", "Error", { variant: 'danger' });
        }
    };
    const handleAttended = async () => {
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        // SMART STATUS SYNCING
        if (initialData && initialData.memberId) {
            let statusKey = '';
            let statusLabel = '';

            if (formData.type === 'Measurement') {
                statusKey = 'measured';
                statusLabel = 'Measured';
            } else if (formData.type === 'Fitting') {
                statusKey = 'fitting';
                statusLabel = 'Fitted';
            } else if (formData.type === 'Pickup') {
                statusKey = 'pickup';
                statusLabel = 'Picked Up';
            }

            if (statusKey) {
                const confirmed = await showConfirm(`Mark this member as "${statusLabel}" in the system?`, `${statusLabel}?`, { variant: 'info', confirmText: `Yes, Mark ${statusLabel}` });
                if (confirmed) {
                    try {
                        await api.updateMember(initialData.memberId, { [statusKey]: true, updatedBy });
                    } catch (err) {
                        console.error(`Failed to mark as ${statusLabel}:`, err);
                        showAlert(`Failed to update member status to ${statusLabel}.`, "Error", { variant: 'danger' });
                    }
                }
            }
        }

        const datetime = `${formData.date}T${formData.time}:00`;
        const apptData = {
            ...formData,
            status: 'Attended',
            datetime,
            customerName: searchTerm,
            updatedBy
        };

        try {
            await api.updateAppointment(initialData.id, apptData);
            onSave();
            onClose();
        } catch (err) {
            console.error("Failed to save appointment:", err);
            showAlert("Failed to save appointment.", "Error", { variant: 'danger' });
        }
    };

    const handleMissed = async () => {
        const confirmed = await showConfirm(
            "Do you want to mark this appointment as missed? Member detail will be noted. Please reschedule.",
            "Mark as Missed?",
            { variant: 'warning', confirmText: 'Yes, Mark Missed' }
        );
        if (!confirmed) return;

        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        const datetime = `${formData.date}T${formData.time}:00`;
        const apptData = {
            ...formData,
            status: 'Missed',
            datetime,
            customerName: searchTerm,
            updatedBy
        };

        try {
            await api.updateAppointment(initialData.id, apptData);
            onSave();
            onClose();
        } catch (err) {
            console.error("Failed to save appointment:", err);
            showAlert("Failed to save appointment.", "Error", { variant: 'danger' });
        }
    };

    const handleDelete = async () => {
        const confirmed = await showConfirm(
            "Are you sure you want to DELETE this appointment? This cannot be undone.",
            "Delete Appointment",
            { variant: 'danger', confirmText: 'Delete Forever' }
        );
        if (!confirmed) return;

        const deletedBy = await selectSalesperson();
        if (!deletedBy) return;

        try {
            await api.deleteAppointment(initialData.id, deletedBy);

            // Log to Member History if linked
            if (initialData.memberId) {
                const apptDate = new Date(formData.date).toLocaleDateString();
                const newNote = `Deleted appointment on ${apptDate} - ${deletedBy}`;
                // We can't easily append to history without fetching member first, 
                // but we can try to use a specialized endpoint or just let the backend logging handle it?
                // The user specifically asked for "Member CONTACT HISTORY".
                // We should try to update the member.
                try {
                    const member = await api.getMember(initialData.memberId);
                    if (member) {
                        const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
                        const updatedHistory = [...(member.contactHistory || []), historyEntry];
                        await api.updateMember(initialData.memberId, { contactHistory: updatedHistory });
                    }
                } catch (e) {
                    console.error("Failed to update member history on delete:", e);
                }
            }

            onSave();
            onClose();
        } catch (err) {
            console.error("Failed to delete appointment:", err);
            showAlert("Failed to delete appointment.", "Error", { variant: 'danger' });
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in" >
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-2xl border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text rounded-t-lg">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Calendar" className="text-gold-500" /> {initialData ? 'Edit Appointment' : 'New Appointment'}
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    {/* Type & Time */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Type</label>
                            <select
                                className="ui-input w-full cursor-pointer appearance-none p-2.5 pr-8 text-sm font-semibold text-app-text"
                                value={formData.type}
                                onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                            >
                                <option>Measurement</option>
                                <option>Fitting</option>
                                <option>Pickup</option>
                                <option>Consultation</option>
                                <option>Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Time</label>
                            <input
                                type="time"
                                className="ui-input w-full p-2.5 text-sm font-semibold text-app-text"
                                value={formData.time}
                                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                                required
                            />
                        </div>
                    </div>

                    {/* Date & Salesperson */}
                    <div className="grid grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Date</label>
                            <input
                                type="date"
                                className="ui-input w-full p-2.5 text-sm font-semibold text-app-text"
                                value={formData.date}
                                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                                required
                            />
                        </div>
                        <div>
                            <label className={`block text-xs font-bold uppercase mb-1 ${conflicts.length > 0 ? 'text-red-500 animate-pulse' : 'text-app-text-muted'}`}>
                                Salesperson (ROS) {conflicts.length > 0 && '(CONFLICT)'}
                            </label>
                            <p className="text-[10px] text-app-text-muted mb-1">Staff with role Salesperson in ROS.</p>
                            <select
                                className={`ui-input w-full cursor-pointer appearance-none p-2.5 pr-8 text-sm font-semibold text-app-text ${conflicts.length > 0 ? 'ring-2 ring-red-500 ring-offset-0' : ''}`}
                                value={salespersonSelectValue}
                                onChange={(e) => setFormData({ ...formData, salesperson: e.target.value })}
                            >
                                <option value="">Any / Unassigned</option>
                                {salespersonOptions.map((sp) => (
                                    <option key={sp} value={sp}>{sp}</option>
                                ))}
                            </select>
                            {conflicts.length > 0 && (
                                <p className="text-[10px] text-red-500 mt-1 font-bold">
                                    Already has {conflicts.length} appointment(s) at this time.
                                </p>
                            )}
                        </div>
                    </div>

                    {/* Customer Search */}
                    <div className="relative">
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Customer (ROS search)</label>
                        <div className="flex gap-2 items-center">
                            <input
                                type="text"
                                className="ui-input w-full min-w-0 flex-1 p-2.5 text-sm font-semibold text-app-text"
                                placeholder="Name, phone, email, or customer code…"
                                value={searchTerm}
                                onChange={(e) => {
                                    setSearchTerm(e.target.value);
                                    if (formData.memberId || formData.customerId) {
                                        setFormData({ ...formData, memberId: '', partyId: '', customerId: '' });
                                    }
                                }}
                                required
                            />
                            {isSearching && (
                                <span className="text-[10px] font-bold text-app-text-muted whitespace-nowrap">Searching…</span>
                            )}
                            {(formData.memberId || formData.customerId) && (
                                <div className="flex items-center text-green-600 shrink-0" title={formData.memberId ? "Linked to wedding member" : "ROS customer selected"}>
                                    <Icon name="Check" size={20} />
                                </div>
                            )}
                        </div>

                        {/* Search Results Dropdown */}
                        {searchResults.length > 0 && (
                            <div className="absolute z-10 w-full rounded-xl border border-app-input-border bg-app-surface shadow-lg mt-1 max-h-72 overflow-y-auto">
                                {searchResults.map((c) => (
                                    <div
                                        key={c.id}
                                        className="p-2 hover:bg-app-surface-2 cursor-pointer text-sm border-b border-app-border/80 last:border-0"
                                        onClick={() => handleSelectRosCustomer(c)}
                                    >
                                        <div className="font-bold text-app-text">{rosCustomerLabel(c)}</div>
                                        <div className="text-xs text-app-text-muted">
                                            {c.wedding_party_name
                                                ? `${c.wedding_party_name} · wedding`
                                                : "No active wedding · walk-in / general"}
                                            {c.phone ? ` · ${c.phone}` : c.customer_code ? ` · ${c.customer_code}` : ""}
                                        </div>
                                    </div>
                                ))}
                                {searchHasMore ? (
                                    <button
                                        type="button"
                                        disabled={searchLoadMoreBusy || isSearching}
                                        className="w-full border-t border-app-border/80 p-2 text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface-2 disabled:opacity-50"
                                        onClick={async () => {
                                            if (!searchHasMore || searchLoadMoreBusy || isSearching) return;
                                            setSearchLoadMoreBusy(true);
                                            try {
                                                const rows = await api.searchCustomers(searchTerm, {
                                                    limit: APPT_CUSTOMER_SEARCH_PAGE,
                                                    offset: searchResults.length,
                                                });
                                                const list = rows || [];
                                                setSearchResults((prev) => [...prev, ...list]);
                                                setSearchHasMore(list.length === APPT_CUSTOMER_SEARCH_PAGE);
                                            } finally {
                                                setSearchLoadMoreBusy(false);
                                            }
                                        }}
                                    >
                                        {searchLoadMoreBusy ? 'Loading…' : 'Load more'}
                                    </button>
                                ) : null}
                            </div>
                        )}
                    </div>

                    {/* Phone */}
                    <div>
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Phone</label>
                        <input
                            type="tel"
                            className="ui-input w-full p-2.5 text-sm font-semibold text-app-text"
                            placeholder="(555) 555-5555"
                            value={formData.phone}
                            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        />
                    </div>

                    {/* Notes */}
                    <div>
                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Notes</label>
                        <textarea
                            className="ui-input w-full min-h-[5rem] resize-y p-2.5 text-sm font-semibold text-app-text"
                            placeholder="Additional details..."
                            value={formData.notes}
                            onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                        ></textarea>
                    </div>

                    <div className="flex flex-wrap items-center justify-between pt-4 gap-4 border-t border-app-border/80 mt-2">
                        {initialData && initialData.id && (
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={handleAttended}
                                    className="px-3 py-1.5 bg-green-100 text-green-700 hover:bg-green-200 font-bold rounded text-xs flex items-center gap-1"
                                >
                                    <Icon name="Check" size={14} /> Attended
                                </button>
                                <button
                                    type="button"
                                    onClick={handleMissed}
                                    className="px-3 py-1.5 bg-amber-100 text-amber-700 hover:bg-amber-200 font-bold rounded text-xs flex items-center gap-1"
                                >
                                    <Icon name="X" size={14} /> Missed
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDelete}
                                    className="px-3 py-1.5 bg-red-100 text-red-700 hover:bg-red-200 font-bold rounded text-xs flex items-center gap-1"
                                >
                                    <Icon name="Trash" size={14} /> Delete
                                </button>
                            </div>
                        )}
                        <div className="flex gap-3 ml-auto">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-4 py-2 text-app-text font-bold hover:bg-app-surface-2 rounded transition-colors text-sm"
                            >
                                Cancel
                            </button>
                            <button
                                id="save-btn"
                                type="submit"
                                className="px-6 py-2 bg-navy-900 hover:bg-navy-800 text-white font-bold rounded shadow transition-colors text-sm"
                            >
                                Save Appointment
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div >
    );
};

export default AppointmentModal;
