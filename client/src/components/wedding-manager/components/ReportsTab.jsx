import React, { useState, useEffect } from 'react';
import Icon from './Icon';

import { formatDate } from '../lib/utils';

const ReportsTab = ({ isOpen }) => {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen) {
            fetchStats();
        }
    }, [isOpen]);

    const fetchStats = async () => {
        setLoading(true);
        try {
            const res = await fetch('http://localhost:3000/api/reports/stats');
            if (!res.ok) throw new Error('Failed to fetch reports');
            const json = await res.json();
            setData(json);
        } catch (err) {
            console.error(err);
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    if (loading) return <div className="p-8 text-center text-app-text-muted">Loading reports...</div>;
    if (error) return <div className="p-8 text-center text-red-500">Error: {error}</div>;
    if (!data) return null;

    return (
        <div className="space-y-6">
            {/* Sales Overview */}
            <div className="grid grid-cols-2 gap-4">
                <div className="bg-app-surface p-4 rounded-lg border border-app-border shadow-sm">
                    <div className="text-xs font-bold text-app-text-muted uppercase mb-1">New Parties (90 Days)</div>
                    <div className="text-3xl font-bold text-app-text">{data.salesStats?.totalParties || 0}</div>
                </div>
                <div className="bg-app-surface p-4 rounded-lg border border-app-border shadow-sm">
                    <div className="text-xs font-bold text-app-text-muted uppercase mb-1">Members Suit-ed (90 Days)</div>
                    <div className="text-3xl font-bold text-app-text">{data.salesStats?.totalMembers || 0}</div>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Popular Styles */}
                <div className="bg-app-surface p-4 rounded-lg border border-app-border shadow-sm">
                    <h3 className="font-bold text-app-text mb-4 flex items-center gap-2">
                        <Icon name="Star" size={16} className="text-gold-500" /> Popular Styles
                    </h3>
                    <div className="space-y-3">
                        {data.popularStyles.map((style, idx) => (
                            <div key={idx} className="relative">
                                <div className="flex justify-between text-sm mb-1 relative z-10">
                                    <span className="font-medium text-app-text">{style.styleInfo}</span>
                                    <span className="font-bold text-app-text">{style.count}</span>
                                </div>
                                <div className="w-full bg-app-surface-2 rounded-full h-2 overflow-hidden">
                                    <div
                                        className="bg-navy-600 h-full rounded-full"
                                        style={{ width: `${(style.count / data.popularStyles[0].count) * 100}%` }}
                                    ></div>
                                </div>
                            </div>
                        ))}
                        {data.popularStyles.length === 0 && <div className="text-sm text-app-text-muted italic">No style data available.</div>}
                    </div>
                </div>

                {/* Free Suit Promo */}
                <div className="bg-app-surface p-4 rounded-lg border border-app-border shadow-sm">
                    <h3 className="font-bold text-app-text mb-4 flex items-center gap-2">
                        <Icon name="Gift" size={16} className="text-red-500" /> Free Suit Eligibility
                    </h3>
                    <p className="text-xs text-app-text-muted mb-3">Parties with 6+ members (Buy 5, Get 1 Free)</p>

                    <div className="overflow-y-auto max-h-60 border border-app-border rounded">
                        <table className="w-full text-sm text-left">
                            <thead className="bg-app-surface-2 sticky top-0">
                                <tr>
                                    <th className="p-2 border-b border-app-border font-bold text-app-text">Party</th>
                                    <th className="p-2 border-b border-app-border font-bold text-app-text text-center">Members</th>
                                    <th className="p-2 border-b border-app-border font-bold text-app-text text-center">Free Suits</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-app-border/80">
                                {data.eligibleParties.map((p, idx) => (
                                    <tr key={idx} className="hover:bg-app-surface-2">
                                        <td className="p-2 font-medium text-app-text">
                                            {p.name}
                                            <div className="text-[10px] text-app-text-muted">{formatDate(p.date)}</div>
                                        </td>
                                        <td className="p-2 text-center text-app-text">{p.memberCount}</td>
                                        <td className="p-2 text-center font-bold text-green-600 bg-green-50">
                                            {p.freeSuits}
                                        </td>
                                    </tr>
                                ))}
                                {data.eligibleParties.length === 0 && (
                                    <tr>
                                        <td colSpan="3" className="p-4 text-center text-app-text-muted italic">No eligible parties found.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ReportsTab;
