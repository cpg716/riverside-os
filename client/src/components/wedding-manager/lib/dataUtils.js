/**
 * Centralized utility for parsing database fields that may be stored as strings or objects
 */

export const parseJSON = (data, fallback = {}) => {
    if (!data) return fallback;
    if (typeof data === 'object') return data;
    try {
        return JSON.parse(data);
    } catch (e) {
        console.warn("Failed to parse JSON field:", e);
        return fallback;
    }
};

export const getMemberAccessories = (member, party) => {
    const partyAcc = parseJSON(party?.accessories);
    const memberAcc = parseJSON(member?.accessories);
    return { ...partyAcc, ...memberAcc };
};

export const getMemberNotes = (member) => {
    // Member notes might be a string, but contactHistory is JSON.
    // This utility ensures we always have a clean array for history
    return {
        notes: member.notes || '',
        history: parseJSON(member.contactHistory, [])
    };
};
