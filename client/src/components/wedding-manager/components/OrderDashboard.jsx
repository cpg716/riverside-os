import React, { useState, useMemo, useEffect } from 'react';
import Icon from './Icon';
import { formatDate } from '../lib/utils';
import { api } from '../lib/api';
import { parseJSON } from '../lib/dataUtils';
import { useModal } from '../hooks/useModal';

const OrderDashboard = ({ onBack }) => {
    const { showConfirm, showAlert, selectSalesperson } = useModal();
    const [fetchedMembers, setFetchedMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [partyFilter, setPartyFilter] = useState('');
    const [itemFilter, setItemFilter] = useState('');

    useEffect(() => {
        fetchOrders();
    }, []);

    const fetchOrders = async () => {
        setLoading(true);
        try {
            const data = await api.getDashboardOrders();
            setFetchedMembers(data);
        } catch (err) {
            console.error("Failed to fetch orders:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleBatchOrder = async (target, type = 'party') => {
        const count = type === 'party' ?
            fetchedMembers.filter(m => m.partyId === target.id).length : 1;

        const confirmed = await showConfirm(
            `Mark ${count} member(s) as "Ordered"? This will update their status across the entire system.`,
            "Batch Order",
            { variant: 'info', confirmText: 'Yes, Mark Ordered' }
        );

        if (!confirmed) return;

        // Prompt for attribution
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        try {
            if (type === 'party') {
                const membersToUpdate = fetchedMembers.filter(m => m.partyId === target.id);
                const ids = membersToUpdate.map(m => m.id);
                await api.batchUpdateMembers(ids, {
                    ordered: true,
                    orderedDate: new Date().toISOString().split('T')[0],
                    updatedBy
                });
            } else {
                await api.updateMember(target.id, {
                    ordered: true,
                    orderedDate: new Date().toISOString().split('T')[0],
                    updatedBy
                });
            }
            fetchOrders();
        } catch (err) {
            console.error("Batch order failed:", err);
            showAlert("Failed to update status.");
        }
    };

    // Generate Order List Data
    const orderItems = useMemo(() => {
        const items = [];

        fetchedMembers.forEach(member => {
            // Parse party accessories
            const partyAcc = parseJSON(member.partyAccessories);
            const memberAcc = parseJSON(member.accessories);

            // Merge: member overrides take precedence
            const acc = { ...partyAcc, ...memberAcc };

            // Add Coat if applicable
            if (member.styleInfo && member.suit) {
                items.push({
                    id: `${member.id}-Coat`,
                    type: 'Coat',
                    partyId: member.partyId,
                    partyName: member.partyName || 'Unknown',
                    partyDate: member.partyDate || '',
                    memberName: member.name || 'Unknown',
                    memberId: member.id,
                    role: member.role || '',
                    description: (member.notes && member.notes.includes('SUIT OPTION:'))
                        ? `★ SUIT OVERRIDE: ${member.notes.split('SUIT OPTION:')[1].split('\n')[0].trim()}`
                        : (member.styleInfo || ''),
                    size: member.suit || ''
                });
            }

            // Add Pant if applicable
            if (member.styleInfo && member.waist) {
                items.push({
                    id: `${member.id}-Pant`,
                    type: 'Pant',
                    partyId: member.partyId,
                    partyName: member.partyName || 'Unknown',
                    partyDate: member.partyDate || '',
                    memberName: member.name || 'Unknown',
                    memberId: member.id,
                    role: member.role || '',
                    description: (member.notes && member.notes.includes('SUIT OPTION:'))
                        ? `★ SUIT OVERRIDE: ${member.notes.split('SUIT OPTION:')[1].split('\n')[0].trim()}`
                        : (member.styleInfo || ''),
                    size: member.waist || ''
                });
            }

            // Add Vest if member has size
            if (member.vest) {
                items.push({
                    id: `${member.id}-Vest`,
                    type: 'Vest',
                    partyId: member.partyId,
                    partyName: member.partyName || 'Unknown',
                    partyDate: member.partyDate || '',
                    memberName: member.name || 'Unknown',
                    memberId: member.id,
                    role: member.role || '',
                    description: (acc.vest || acc.Vest) ? String(acc.vest || acc.Vest) : 'Standard Vest',
                    size: member.vest
                });
            }

            // Add Shirt if member has size
            if (member.shirt) {
                items.push({
                    id: `${member.id}-Shirt`,
                    type: 'Shirt',
                    partyId: member.partyId,
                    partyName: member.partyName || 'Unknown',
                    partyDate: member.partyDate || '',
                    memberName: member.name || 'Unknown',
                    memberId: member.id,
                    role: member.role || '',
                    description: (acc.shirt || acc.Shirt) ? String(acc.shirt || acc.Shirt) : 'Standard Shirt',
                    size: member.shirt
                });
            }

            // Add Shoes if member has size
            if (member.shoe) {
                items.push({
                    id: `${member.id}-Shoes`,
                    type: 'Shoes',
                    partyId: member.partyId,
                    partyName: member.partyName || 'Unknown',
                    partyDate: member.partyDate || '',
                    memberName: member.name || 'Unknown',
                    memberId: member.id,
                    role: member.role || '',
                    description: (acc.shoes || acc.Shoes || acc.shoe || acc.Shoe) ? String(acc.shoes || acc.Shoes || acc.shoe || acc.Shoe) : 'Standard Shoes',
                    size: member.shoe
                });
            }
            // --- Apply Stock Status & PO ---
            const stockInfo = typeof member.stockInfo === 'string' ? JSON.parse(member.stockInfo || '{}') : (member.stockInfo || {});

            // Find items just added for this member and tag them
            const memberItems = items.filter(i => i.memberId === member.id);
            memberItems.forEach(item => {
                const itemTypeKey = item.type.toLowerCase();
                if (stockInfo[itemTypeKey] === 'stock') {
                    item.isStock = true;
                }
                item.orderedPO = member.orderedPO;
            });
        });

        return items;
    }, [fetchedMembers]);

    // Filter Items
    const filteredItems = useMemo(() => {
        return orderItems.filter(item => {
            const matchesSearch = !searchTerm ||
                item.memberName.toLowerCase().includes(searchTerm.toLowerCase()) ||
                item.partyName.toLowerCase().includes(searchTerm.toLowerCase());
            const matchesParty = !partyFilter || item.partyId === partyFilter;
            const matchesItem = !itemFilter || item.type === itemFilter;
            return matchesSearch && matchesParty && matchesItem;
        });
    }, [orderItems, searchTerm, partyFilter, itemFilter]);

    // Group by Party
    const groupedByParty = useMemo(() => {
        const groups = {};
        filteredItems.forEach(item => {
            if (!groups[item.partyId]) {
                groups[item.partyId] = {
                    id: item.partyId,
                    name: item.partyName,
                    date: item.partyDate,
                    items: []
                };
            }
            groups[item.partyId].items.push(item);
        });
        return Object.values(groups).sort((a, b) => {
            if (!a.date) return 1;
            if (!b.date) return -1;
            return new Date(a.date) - new Date(b.date);
        });
    }, [filteredItems]);

    // Get unique Item Types for filter
    const itemTypes = [...new Set(orderItems.map(i => i.type))].sort();

    // Get unique Parties for filter
    const partyOptions = useMemo(() => {
        const seen = new Map();
        orderItems.forEach(item => {
            if (!seen.has(item.partyId)) {
                seen.set(item.partyId, item.partyName);
            }
        });
        return Array.from(seen.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
    }, [orderItems]);

    return (
        <div className="fixed inset-0 z-50 bg-[#F8FAFC] flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            {/* Premium Header */}
            <div className="bg-app-surface px-8 py-6 flex justify-between items-center border-b border-app-border/80 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
                <div className="flex items-center gap-6">
                    <button type="button"
                        onClick={onBack}
                        className="w-12 h-12 bg-app-surface-2 border border-app-border/80 rounded-2xl flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 hover:shadow-md transition-all active:scale-95"
                    >
                        <Icon name="ArrowLeft" size={24} />
                    </button>
                    <div className="flex items-center gap-5 border-l border-app-border/80 pl-6">
                        <div className="w-14 h-14 bg-app-surface border border-app-border/80 rounded-2xl flex items-center justify-center shadow-lg shadow-navy-900/5">
                            <Icon name="ClipboardList" size={28} className="text-gold-500" />
                        </div>
                        <div>
                            <h1 className="text-app-text font-black text-3xl tracking-tight uppercase leading-none">Order Registry</h1>
                            <div className="mt-2 flex items-center gap-2">
                                <span className="text-gold-600 text-[10px] font-black tracking-[0.2em] uppercase bg-gold-50 px-3 py-1 rounded-full border border-gold-100 italic">
                                    Operational Dashboard
                                </span>
                                <span className="text-app-text-muted text-[10px] font-black tracking-[0.2em] uppercase">
                                    {filteredItems.length} ITEMS PENDING
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <button type="button"
                        onClick={() => window.print()}
                        className="h-14 px-8 bg-navy-900 text-white rounded-2xl font-black flex items-center gap-3 hover:bg-black shadow-xl shadow-navy-900/20 active:scale-95 transition-all text-sm uppercase tracking-widest"
                    >
                        <Icon name="Printer" size={20} /> Generate List
                    </button>
                </div>
            </div>

            {/* Premium Filter Bar */}
            <div className="bg-app-surface/80 backdrop-blur-md border-b border-app-border/80 px-8 py-4 flex gap-4 items-center">
                <div className="relative flex-1">
                    <Icon name="Search" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" />
                    <input
                        type="text"
                        placeholder="SEARCH MEMBERS OR PARTIES..."
                        className="w-full pl-12 pr-4 py-3 bg-app-surface-2 border border-transparent rounded-xl text-xs font-black text-app-text placeholder:text-app-text-muted focus:bg-app-surface focus:border-gold-500 outline-none transition-all"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                    />
                </div>
                <div className="flex items-center gap-2 bg-app-surface-2 p-1.5 rounded-xl border border-app-border/80">
                    <select
                        className="bg-transparent px-4 py-1.5 text-[10px] font-black uppercase text-app-text outline-none cursor-pointer"
                        value={partyFilter}
                        onChange={(e) => setPartyFilter(e.target.value)}
                    >
                        <option value="">All Active Parties</option>
                        {partyOptions.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>
                </div>
                <div className="flex items-center gap-2 bg-app-surface-2 p-1.5 rounded-xl border border-app-border/80">
                    <select
                        className="bg-transparent px-4 py-1.5 text-[10px] font-black uppercase text-app-text outline-none cursor-pointer"
                        value={itemFilter}
                        onChange={(e) => setItemFilter(e.target.value)}
                    >
                        <option value="">All Categories</option>
                        {itemTypes.map(t => (
                            <option key={t} value={t}>{t}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-12 custom-scrollbar">
                <div className="max-w-6xl mx-auto space-y-12 pb-24">
                    {loading ? (
                        <div className="text-center py-20 flex flex-col items-center gap-6">
                            <div className="w-16 h-16 border-4 border-navy-900/5 border-t-gold-500 rounded-full animate-spin"></div>
                            <p className="text-app-text-muted font-black uppercase tracking-[0.3em] text-[10px]">Processing Registry...</p>
                        </div>
                    ) : groupedByParty.length === 0 ? (
                        <div className="text-center py-32 bg-app-surface rounded-[3rem] border border-app-border/80 shadow-sm">
                            <div className="w-20 h-20 bg-app-surface-2 rounded-3xl flex items-center justify-center mx-auto mb-6">
                                <Icon name="Check" size={40} className="text-app-text-muted" />
                            </div>
                            <h3 className="text-app-text font-black text-2xl uppercase tracking-tight">Registry Clear</h3>
                            <p className="text-app-text-muted font-bold uppercase text-[10px] tracking-[0.2em] mt-2">All measured members have been ordered</p>
                        </div>
                    ) : (
                        groupedByParty.map(group => (
                            <div key={group.id} className="animate-in fade-in slide-in-from-bottom-8 duration-700">
                                {/* Party Section Header */}
                                <div className="flex items-end justify-between mb-6 px-4">
                                    <div>
                                        <div className="flex items-center gap-3 mb-1">
                                            <span className="w-2 h-6 bg-gold-500 rounded-full"></span>
                                            <h2 className="text-app-text font-black text-3xl tracking-tight uppercase">{group.name}</h2>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <span className="text-gold-600 text-[10px] font-black tracking-[0.2em] uppercase bg-gold-50 px-3 py-1 rounded-full border border-gold-100">
                                                {group.date ? formatDate(group.date) : 'DATE PENDING'}
                                            </span>
                                            <span className="text-app-text-muted text-[10px] font-black tracking-[0.2em] uppercase">
                                                {group.items.length} LINE ITEMS
                                            </span>
                                        </div>
                                    </div>
                                    <button type="button"
                                        onClick={() => handleBatchOrder(group, 'party')}
                                        className="mb-1 px-8 py-4 bg-app-surface border border-app-border text-app-text text-xs font-black uppercase tracking-widest rounded-2xl hover:bg-gold-500 hover:text-white hover:border-gold-600 transition-all shadow-sm active:scale-95 flex items-center gap-2"
                                    >
                                        <Icon name="Check" size={16} /> Mark Party Ordered
                                    </button>
                                </div>

                                {/* Items Card */}
                                <div className="bg-app-surface rounded-[2.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-app-border/80 overflow-hidden">
                                    <table className="w-full">
                                        <thead>
                                            <tr className="bg-app-surface-2/50 text-left border-b border-app-border/80">
                                                <th className="px-8 py-5 text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Member</th>
                                                <th className="px-8 py-5 text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Role</th>
                                                <th className="px-8 py-5 text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Category</th>
                                                <th className="px-8 py-5 text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Description</th>
                                                <th className="px-8 py-5 text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Size</th>
                                                <th className="px-8 py-5 text-right text-[10px] font-black text-app-text-muted uppercase tracking-[0.2em]">Action</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-app-surface-2">
                                            {group.items.map((item, idx) => (
                                                <tr key={`${item.id}-${idx}`} className="group/row hover:bg-app-surface-2/30 transition-colors">
                                                    <td className="px-8 py-5">
                                                        <div className="flex flex-col">
                                                            <span className="text-app-text font-black text-sm tracking-tight uppercase">{item.memberName}</span>
                                                            {item.orderedPO && (
                                                                <span className="text-[9px] font-bold text-amber-600 uppercase tracking-wider">PO: {item.orderedPO}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-8 py-5">
                                                        <span className="text-app-text-muted font-black text-[10px] uppercase tracking-widest">{item.role}</span>
                                                    </td>
                                                    <td className="px-8 py-5">
                                                        <span className="px-3 py-1.5 bg-navy-900 text-white rounded-lg text-[10px] font-black uppercase tracking-widest">
                                                            {item.type}
                                                        </span>
                                                    </td>
                                                    <td className="px-8 py-5">
                                                        <span className="text-app-text font-medium text-sm">{item.description}</span>
                                                    </td>
                                                    <td className="px-8 py-5">
                                                        <div className="flex flex-col items-center gap-1">
                                                            <span className="inline-flex items-center justify-center min-w-[3rem] h-8 bg-gold-50 border border-gold-200 rounded-lg text-gold-700 text-xs font-black uppercase">
                                                                {item.size}
                                                            </span>
                                                            {item.isStock && (
                                                                <span className="rounded border border-emerald-100 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.1em] text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300">In Stock</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="px-8 py-5 text-right">
                                                        <button type="button"
                                                            onClick={() => handleBatchOrder({ id: item.memberId }, 'member')}
                                                            className={`w-10 h-10 flex items-center justify-center rounded-xl transition-all shadow-sm active:scale-95 group-hover/row:opacity-100 ${item.isStock ? 'bg-emerald-500 text-white opacity-100' : 'bg-app-surface-2 text-app-text-muted hover:bg-gold-500 hover:text-white opacity-0'}`}
                                                            title={item.isStock ? 'Item is In Stock' : 'Mark Individual as Ordered'}
                                                            disabled={item.isStock}
                                                        >
                                                            <Icon name={item.isStock ? 'CheckCircle' : 'Check'} size={18} />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};

export default OrderDashboard;
