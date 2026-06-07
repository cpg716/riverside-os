import { useState, useEffect } from 'react';
import { api, socket } from '../lib/api';

const EMPTY_ACTION_ITEMS = {
    measurements: [],
    ordering: [],
    fitting: [],
    pickups: [],
    upcomingAppts: [],
    missedAppts: [],
};

function formatPartyBalanceDue(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Days from today to YYYY-MM-DD (local calendar). */
function daysUntilEventDate(naiveDateStr) {
    if (!naiveDateStr || typeof naiveDateStr !== 'string') return null;
    const parts = naiveDateStr.split('-').map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    const [y, m, d] = parts;
    const event = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    event.setHours(0, 0, 0, 0);
    return Math.round((event.getTime() - today.getTime()) / 86400000);
}

function daysUntilAppointmentDate(value) {
    if (!value) return null;
    const appointment = new Date(value);
    if (Number.isNaN(appointment.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    appointment.setHours(0, 0, 0, 0);
    return Math.round((appointment.getTime() - today.getTime()) / 86400000);
}

/** ROS `/weddings/actions` returns snake_case rows; UI expects member/partyId shapes. */
function mapActionApiRow(row, defaultType) {
    const daysToWedding = daysUntilEventDate(row.event_date);
    const urgent = daysToWedding != null && daysToWedding >= 0 && daysToWedding <= 14;
    return {
        partyId: row.wedding_party_id,
        partyName: row.party_name ?? '',
        partyBalanceDueLabel: formatPartyBalanceDue(row.party_balance_due),
        member: {
            id: row.wedding_member_id,
            name: row.customer_name || 'Unknown',
            phone: '',
            role: row.role,
            status: row.status,
        },
        type: defaultType,
        daysToWedding: daysToWedding ?? 0,
        urgent,
        label: daysToWedding != null && daysToWedding >= 0 ? `${daysToWedding} Days` : 'Date TBD',
        date: row.event_date,
    };
}

function mapAppointmentApiRow(row) {
    const memberId = row.wedding_member_id ?? row.memberId ?? null;
    const customerName = row.customer_display_name ?? row.customerName ?? 'Unassigned appointment';
    const startsAt = row.starts_at ?? row.datetime ?? null;
    const days = daysUntilAppointmentDate(startsAt);

    return {
        id: row.id,
        partyId: row.wedding_party_id ?? row.partyId ?? null,
        partyName: row.party_name ?? row.partyName ?? ((row.wedding_party_id || row.wedding_member_id) ? 'Wedding appointment' : 'No wedding party linked'),
        member: {
            id: memberId,
            name: customerName,
            phone: row.phone ?? '',
        },
        customerId: row.customer_id ?? row.customerId ?? null,
        type: row.appointment_type ?? row.type ?? 'Appointment',
        date: startsAt,
        days: days ?? 0,
        status: row.status ?? 'Scheduled',
        salesperson: row.salesperson ?? null,
        notes: row.notes ?? '',
    };
}

function normalizeDashboardPayload(data) {
    if (!data || typeof data !== 'object') {
        return { ...EMPTY_ACTION_ITEMS };
    }

    const needsMeasure = data.needs_measure ?? data.needsMeasure;
    const needsOrder = data.needs_order ?? data.needsOrder;

    return {
        ...EMPTY_ACTION_ITEMS,
        measurements: Array.isArray(needsMeasure)
            ? needsMeasure.map((r) => mapActionApiRow(r, 'Measurement'))
            : [],
        ordering: Array.isArray(needsOrder) ? needsOrder.map((r) => mapActionApiRow(r, 'Order')) : [],
        fitting: Array.isArray(data.fitting) ? data.fitting.map((r) => mapActionApiRow(r, 'Fitting')) : [],
        pickups: Array.isArray(data.pickups) ? data.pickups.map((r) => mapActionApiRow(r, 'Pickup')) : [],
        upcomingAppts: Array.isArray(data.upcomingAppts) ? data.upcomingAppts.map(mapAppointmentApiRow) : [],
        missedAppts: Array.isArray(data.missedAppts) ? data.missedAppts.map(mapAppointmentApiRow) : [],
    };
}

export const useDashboardActions = (filters = {}) => {
    const [actionItems, setActionItems] = useState(() => ({ ...EMPTY_ACTION_ITEMS }));
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchActions = async () => {
        setLoading(true);
        try {
            const data = await api.getDashboardActions(filters);
            setActionItems(normalizeDashboardPayload(data));
            setError(null);
        } catch (err) {
            console.error("Failed to fetch dashboard actions:", err);
            setError(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchActions();

        // Listen for updates that might affect actions — remove first to prevent double-registration
        const onPartiesUpdated = () => fetchActions();
        const onAppointmentsUpdated = () => fetchActions();
        socket.off('parties_updated');
        socket.off('appointments_updated');
        socket.on('parties_updated', onPartiesUpdated);
        socket.on('appointments_updated', onAppointmentsUpdated);

        // Auto-refresh every 10 minutes
        const interval = setInterval(fetchActions, 600000);

        return () => {
            socket.off('parties_updated', onPartiesUpdated);
            socket.off('appointments_updated', onAppointmentsUpdated);
            clearInterval(interval);
        };
    }, [filters.search, filters.startDate, filters.endDate, filters.salesperson]); // Re-run when filters change

    return { actionItems, loading, error, refresh: fetchActions };
};
