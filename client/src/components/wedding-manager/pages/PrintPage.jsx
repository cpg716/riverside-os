import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import PrintPartyView from '../components/PrintPartyView';

const PrintPage = ({ partyId }) => {
    const [party, setParty] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchParty = async () => {
            try {
                const parties = await api.getParties();
                const found = parties.find(p => p.id === partyId);
                setParty(found);
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        fetchParty();
    }, [partyId]);

    if (loading) return <div className="p-8 font-bold">Loading Party Record...</div>;
    if (!party) return <div className="p-8 text-red-600 font-bold">Party not found. Please close this window and try again.</div>;

    return <PrintPartyView party={party} onCancel={() => window.close()} />;
};

export default PrintPage;
