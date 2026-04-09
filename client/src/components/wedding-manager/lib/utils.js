import React from 'react';

// --- Shared Helper Functions ---
export const calculateProgress = (members) => {
    if (!members || members.length === 0) return 0;
    // 5 Stages: Measured, Ordered, Received, Fitted, Picked Up
    const totalTasks = members.length * 5;
    const completedTasks = members.reduce((acc, m) => acc + (m.measured ? 1 : 0) + (m.ordered ? 1 : 0) + (m.received ? 1 : 0) + (m.fitting ? 1 : 0) + (m.pickup ? 1 : 0), 0);
    return Math.round((completedTasks / totalTasks) * 100);
};

export const formatDate = (dateString) => {
    if (!dateString) return "No Date";

    let date;
    // Always use local-time safe parsing for YYYY-MM-DD to prevent UTC off-by-one day display
    if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        const [y, m, d] = dateString.split('-').map(Number);
        date = new Date(y, m - 1, d); // Local midnight — no timezone shift
    } else {
        date = new Date(dateString);
    }

    if (isNaN(date.getTime())) return dateString; // Fallback to raw string

    const options = { year: 'numeric', month: 'long', day: 'numeric' };
    return date.toLocaleDateString(undefined, options);
};

export const isSoon = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(date - now);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays < 30 && date > now;
};

// Checks if any appointments are scheduled but not completed
export const getAppointmentStatus = (member) => {
    const hasAppt = member.measureDate || member.fittingDate || member.pickupDate;
    const isComplete = member.measured && member.ordered && member.received && member.fitting && member.pickup;

    if (isComplete) return 'complete';
    if (hasAppt) return 'scheduled';
    return 'none';
}

// Standardize phone number: adds (716) if only 7 digits provided.
export const formatPhone = (phone) => {
    if (!phone) return phone;
    const cleaned = ('' + phone).replace(/\D/g, '');

    if (cleaned.length === 10) {
        return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 10)}`;
    }

    if (cleaned.length === 7) {
        // If it starts with 716, it's likely a partial 10-digit number, don't auto-prefix
        if (cleaned.startsWith('716')) return phone;
        return `(716) ${cleaned.slice(0, 3)}-${cleaned.slice(3, 7)}`;
    }

    return phone;
};

export const isWithinDays = (dateString, days) => {
    if (!dateString) return false;
    const date = new Date(dateString);
    const now = new Date();
    // Reset time to start of day for accurate comparison
    now.setHours(0, 0, 0, 0);

    // If date is in the past, return false (unless we want to include past events? usually dashboard is forward looking)
    // But maybe we want to see recent past? Let's assume forward looking for "Upcoming" logic, but "Next 90 Days" usually implies future.
    // However, if a wedding was yesterday, it might still be relevant. 
    // Let's stick to the requested "Next 90 Days" which implies >= Today.

    const future = new Date(now);
    future.setDate(future.getDate() + days);

    return date >= now && date <= future;
};

export const isInMonth = (dateString, monthIndex, year) => {
    if (!dateString) return false;
    // Handle potential timezone issues by treating the string as local date if possible, 
    // but standard new Date() is fine for now as long as we are consistent.
    // Ideally we'd parse YYYY-MM-DD explicitly to avoid timezone shifts.
    // Let's use a safer parse if it matches YYYY-MM-DD
    let date;
    if (typeof dateString === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        const [y, m, d] = dateString.split('-').map(Number);
        date = new Date(y, m - 1, d);
    } else {
        date = new Date(dateString);
    }

    return date.getMonth() === monthIndex && date.getFullYear() === year;
};
export const highlightMatch = (text, query) => {
    if (!query || !text) return text;
    const parts = String(text).split(new RegExp(`(${query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')})`, 'gi'));
    return React.createElement('span', null,
        parts.map((part, i) =>
            part.toLowerCase() === query.toLowerCase()
                ? React.createElement('mark', { key: i, className: "bg-gold-100 text-app-text rounded-px px-0.5 font-bold" }, part)
                : part
        )
    );
};
