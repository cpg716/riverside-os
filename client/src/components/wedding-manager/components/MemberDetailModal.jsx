import React, { useState, useEffect, useMemo } from 'react';
import Icon from './Icon';
import SchedulerModal from './SchedulerModal';
import { api } from '../lib/api';
import { parseJSON } from '../lib/dataUtils';
import { isLegacyIndividualParty } from '../lib/partyLegacy';
import { formatDate, formatPhone, formatMoney } from '../lib/utils';

const AppointmentList = ({ memberId, partyId }) => {
    const [appointments, setAppointments] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchAppts = async () => {
            try {
                const all = await api.getAppointments();
                const mine = all.filter(a => a.memberId === memberId && a.partyId === partyId && a.status !== 'Attended' && a.status !== 'Missed');
                setAppointments(mine.sort((a, b) => a.datetime.localeCompare(b.datetime)));
            } catch (err) {
                console.error(err);
            } finally {
                setLoading(false);
            }
        };
        if (memberId && partyId) fetchAppts();
    }, [memberId, partyId]);

    if (loading) return <div className="text-xs text-app-text-muted">Loading appointments...</div>;
    if (appointments.length === 0) return <div className="text-xs text-app-text-muted italic">No appointments found.</div>;

    return (
        <div className="space-y-2">
            {appointments.map(appt => (
                <div key={appt.id} className="flex justify-between items-center text-sm bg-app-surface  p-2 rounded border border-app-border/80  transition-colors">
                    <div>
                        <span className="font-bold text-app-text ">{new Date(appt.datetime).toLocaleDateString()}</span>
                        <span className="text-app-text-muted  ml-2">{new Date(appt.datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="ml-2 px-1.5 py-0.5 bg-app-surface-2  text-app-text  text-xs rounded border border-app-border ">{appt.type}</span>
                    </div>
                </div>
            ))}
        </div>
    );
};

import { useModal } from '../hooks/useModal';
import { dispatchOpenRegisterFromWeddingManager } from '../../../lib/weddingPosBridge';
import { WEDDING_MEMBER_RETAIL_SIZE_FIELDS } from '../../customers/retailMeasurementLabels';
import CustomerSearchInput from '../../ui/CustomerSearchInput';
import VariantSearchInput from '../../ui/VariantSearchInput';

const MemberDetailModal = ({ isOpen, onClose, member, onUpdate, onAdd, parties, onRefresh }) => {


    const { showConfirm, selectSalesperson } = useModal();
    const [localMember, setLocalMember] = useState(member);
    const [newLog, setNewLog] = useState({ date: new Date().toISOString().split('T')[0], note: '' });
    const [editingLogIndex, setEditingLogIndex] = useState(null);
    const [editingLogText, setEditingLogText] = useState('');
    const [isSchedulerOpen, setIsSchedulerOpen] = useState(false);
    const [apptType, setApptType] = useState('Measurement');
    const [financialBusy, setFinancialBusy] = useState(false);
    const [financialRow, setFinancialRow] = useState(null);
    const [financialLines, setFinancialLines] = useState([]);

    // Find Party and Salesperson
    // Find Party and Salesperson
    const party = (parties && member) ? parties.find(p => p.id === member.partyId) : null;
    const partySalesperson = party ? party.salesperson : '';

    useEffect(() => {
        if (!member) return;
        // Calculate Pickup Date
        let calculatedPickup = member.pickupDate;
        if (parties && member.partyId) {
            const p = parties.find(p => p.id === member.partyId);
            if (p) {
                if (isLegacyIndividualParty(p)) {
                    calculatedPickup = member.pickupDate || p.date;
                } else if (p.date) {
                    const weddingDate = new Date(p.date);
                    const pickupDate = new Date(weddingDate);
                    pickupDate.setDate(weddingDate.getDate() - 7);
                    calculatedPickup = member.pickupDate || pickupDate.toISOString().split('T')[0];
                }
            }
        }

        setLocalMember({
            ...member,
            pickupDate: calculatedPickup,
        });
    }, [member, parties]);

    useEffect(() => {
        if (!isOpen || !member?.customerId || member?.isNew) return;
        let cancelled = false;
        (async () => {
            try {
                const vault = await api.fetchCustomerMeasurementVault(member.customerId);
                if (cancelled || !vault?.latest) return;
                const l = vault.latest;
                setLocalMember((prev) => ({
                    ...prev,
                    ...(l.retail_suit != null && String(l.retail_suit).trim() !== ''
                        ? { suit: String(l.retail_suit) } : {}),
                    ...(l.retail_waist != null && String(l.retail_waist).trim() !== ''
                        ? { waist: String(l.retail_waist) } : {}),
                    ...(l.retail_vest != null && String(l.retail_vest).trim() !== ''
                        ? { vest: String(l.retail_vest) } : {}),
                    ...(l.retail_shirt != null && String(l.retail_shirt).trim() !== ''
                        ? { shirt: String(l.retail_shirt) } : {}),
                    ...(l.retail_shoe != null && String(l.retail_shoe).trim() !== ''
                        ? { shoe: String(l.retail_shoe) } : {}),
                }));
            } catch (err) {
                console.error('measurement vault load failed', err);
            }
        })();
        return () => { cancelled = true; };
    }, [isOpen, member?.customerId, member?.isNew]);

    useEffect(() => {
        if (!isOpen || !member?.partyId || !member?.id) {
            setFinancialRow(null);
            setFinancialLines([]);
            return;
        }
        const run = async () => {
            setFinancialBusy(true);
            try {
                const ctx = await api.getPartyFinancialContext(member.partyId);
                const rows = Array.isArray(ctx?.members) ? ctx.members : [];
                const lines = Array.isArray(ctx?.lines) ? ctx.lines : [];
                const row = rows.find((r) => r.wedding_member_id === member.id) || null;
                const mine = lines
                    .filter((ln) => ln.wedding_member_id === member.id)
                    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
                    .slice(0, 8);
                setFinancialRow(row);
                setFinancialLines(mine);
            } catch (err) {
                console.error("Failed to load member financial context:", err);
                setFinancialRow(null);
                setFinancialLines([]);
            } finally {
                setFinancialBusy(false);
            }
        };
        void run();
    }, [isOpen, member?.partyId, member?.id]);

    const pickupHistory = useMemo(() => {
        if (!member || !member.contactHistory) return [];
        return member.contactHistory
            .filter(h => h.note?.includes('PICKUP'))
            .sort((a, b) => b.date.localeCompare(a.date));
    }, [member]);

    const fulfillmentLabel = (profile) => {
        if (!profile) return null;
        const map = {
            takeaway: "Takeaway",
            wedding_order: "Wedding order",
            special_order: "Order",
            mixed: "Mixed fulfillment",
            other: "Order",
        };
        return map[profile] || profile;
    };

    const handleOpenInRegister = () => {
        const cid = localMember.customerId;
        if (!cid || member?.isNew) return;
        dispatchOpenRegisterFromWeddingManager({
            partyName: party?.name || party?.groomFirstName || "Wedding party",
            member: {
                id: localMember.id,
                first_name: localMember.firstName ?? "",
                last_name: localMember.lastName ?? "",
                role: localMember.role ?? "Member",
                status: localMember.status ?? "prospect",
                measured: Boolean(localMember.measured),
                suit_ordered: Boolean(localMember.ordered),
                customer_id: cid,
                customer_email: localMember.customerEmail || null,
                customer_phone: localMember.phone || null,
                suit_variant_id: localMember.suitVariantId || null,
                is_free_suit_promo: Boolean(localMember.isFreeSuitPromo),
            },
        });
    };

    const handleFieldChange = (field, value) => {
        setLocalMember({ ...localMember, [field]: value });
    };

    const handleSave = async () => {
        let finalMember = { ...localMember };

        // If there's a pending note that wasn't added, add it now
        if (newLog.note.trim()) {
            const updatedHistory = [...(finalMember.contactHistory || []), { ...newLog, id: Date.now() }];
            finalMember = { ...finalMember, contactHistory: updatedHistory };
            // Clear the pending log
            setNewLog({ date: new Date().toISOString().split('T')[0], note: '' });
        }

        // Prompt for attribution
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        // Add attribution to the update payload
        // For new members, we might want to log "Created by..."
        // For updates, "Updated by..."
        // The backend handles logging, but we need to pass `updatedBy`.

        // If it's a new member, we can add a history entry for creation too?
        // Or just rely on the backend log.
        // Let's add a history entry for "Member Details Updated" if it's an edit, to be thorough.
        if (!member.isNew) {
            // Detect changes for history logging? 
            // The backend does a diff log, but that goes to the global log.
            // User wants it in "Member CONTACT HISTORY" too? 
            // "The NAME of the user who did any changes should be listed in the NOTES, Member Detail Contact History..."
            // So yes, let's add a history note for the edit.
            const changeNote = `Member details updated by ${updatedBy}`;
            const historyEntry = { date: new Date().toISOString().split('T')[0], note: changeNote, id: Date.now() };
            const updatedHistory = [...(finalMember.contactHistory || []), historyEntry];
            finalMember = { ...finalMember, contactHistory: updatedHistory, updatedBy };
        } else {
            finalMember.updatedBy = updatedBy; // For creation log
        }

        if (member.isNew) {
            if (onAdd) onAdd(member.partyId, finalMember);
        } else {
            onUpdate(member.id, finalMember);
        }
        onClose();
    };

    const handleAddLog = async () => {
        if (!newLog.note.trim()) return;

        const author = await selectSalesperson();
        if (!author) return;

        const logWithAuthor = { ...newLog, note: `${newLog.note} - ${author}` };

        console.log("Adding log:", logWithAuthor);
        const updatedHistory = [...(localMember.contactHistory || []), { ...logWithAuthor, id: Date.now() }];
        const updatedMember = { ...localMember, contactHistory: updatedHistory };
        console.log("Updating member:", member.id, updatedMember);
        setLocalMember(updatedMember);
        onUpdate(member.id, updatedMember);
        setNewLog({ date: new Date().toISOString().split('T')[0], note: '' });
    };

    const handleDeleteLog = async (index) => {
        const confirmed = await showConfirm("Delete this note?", "Delete Note", { variant: 'danger', confirmText: 'Delete' });
        if (!confirmed) return;
        const updatedHistory = [...(localMember.contactHistory || [])];
        updatedHistory.splice(index, 1);
        const updatedMember = { ...localMember, contactHistory: updatedHistory };
        setLocalMember(updatedMember);
        onUpdate(member.id, updatedMember);
    };

    const startEditLog = (index, text) => {
        setEditingLogIndex(index);
        setEditingLogText(text);
    };

    const saveEditLog = (index) => {
        const updatedHistory = [...(localMember.contactHistory || [])];
        updatedHistory[index] = { ...updatedHistory[index], note: editingLogText };
        const updatedMember = { ...localMember, contactHistory: updatedHistory };
        setLocalMember(updatedMember);
        onUpdate(member.id, updatedMember);
        setEditingLogIndex(null);
        setEditingLogText('');
    };

    const handleOpenScheduler = (type) => {
        setApptType(type);
        setIsSchedulerOpen(true);
    };

    const handleDelete = async () => {
        const confirmed = await showConfirm(
            `Are you sure you want to delete ${localMember.name}? This will also remove all their scheduled appointments.`,
            "Delete Member",
            { variant: 'danger', confirmText: 'Delete Member' }
        );
        if (!confirmed) return;

        const actor = await selectSalesperson();
        if (!actor) return;

        try {
            await api.deleteMember(member.id, actor);
            onClose();
            if (onRefresh) onRefresh();
        } catch (err) {
            console.error(err);
        }
    };

    if (!isOpen || !member) return null;
    // Guard against localMember being null before effect runs
    // (This happens because useState(member) only runs on mount, and we rely on useEffect to sync)
    if (!localMember) return null;

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text sticky top-0 z-10 rounded-t-lg">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="User" className="text-gold-500" />
                        {localMember.isNew ? 'New Member' : localMember.name}
                        <span className="text-app-text-muted text-sm font-normal normal-case">({localMember.role})</span>
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {/* Type Selector (Member vs Note) */}
                    {localMember.isNew && (
                        <div className="mb-6 flex gap-4 p-1 bg-app-surface-2 rounded-lg">
                            <button type="button"
                                onClick={() => handleFieldChange('role', 'Groomsman')}
                                className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${localMember.role !== 'Info' ? 'bg-app-surface shadow text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                            >
                                <Icon name="User" size={16} className="inline mr-2" />
                                Party Member
                            </button>
                            <button type="button"
                                onClick={() => handleFieldChange('role', 'Info')}
                                className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${localMember.role === 'Info' ? 'bg-app-surface shadow text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                            >
                                <Icon name="Info" size={16} className="inline mr-2" />
                                Section Note
                            </button>
                        </div>
                    )}

                    {localMember.role === 'Info' ? (
                        /* Note/Section Mode */
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Note Content / Section Title</label>
                                <input
                                    type="text"
                                    className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors font-bold"
                                    placeholder="e.g., --- Ushers --- or Special Instructions"
                                    value={localMember.name || ''}
                                    onChange={(e) => handleFieldChange('name', e.target.value)}
                                    autoFocus
                                />
                                <p className="text-xs text-app-text-muted mt-2">
                                    This will appear as a full-width separator or note in the member list.
                                </p>
                            </div>
                        </div>
                    ) : (
                        /* Standard Member Mode */
                        <div className="space-y-6">
                            {/* Contact Info */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="md:col-span-2 bg-app-surface-2 p-4 rounded-xl border border-app-border">
                                    <label className="block text-xs font-bold text-app-text-muted uppercase mb-2">Link Existing Customer (Search by name or code)</label>
                                    <CustomerSearchInput 
                                        onSelect={(c) => {
                                            setLocalMember(prev => ({
                                                ...prev,
                                                name: `${c.first_name} ${c.last_name}`.trim(),
                                                firstName: c.first_name,
                                                lastName: c.last_name,
                                                phone: c.phone || '',
                                                customerEmail: c.email || '',
                                                customerId: c.id
                                            }));
                                        }}
                                        placeholder="Search customers to link…"
                                        className="w-full"
                                    />
                                    <p className="text-[10px] text-app-text-muted mt-2 italic">Linking a customer auto-fills name and contact details.</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Name</label>
                                    <input type="text" className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded-lg focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                        value={localMember.name || ''} onChange={(e) => handleFieldChange('name', e.target.value)} />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Phone</label>
                                    <input type="tel" className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded-lg focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                        value={localMember.phone || ''} onChange={(e) => handleFieldChange('phone', e.target.value)} />
                                </div>
                                <div className="md:col-span-2">
                                    <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Role</label>
                                    <input type="text" className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded-lg focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                        value={localMember.role || ''} onChange={(e) => handleFieldChange('role', e.target.value)} />
                                </div>
                                <div className="md:col-span-2 bg-gold-50/50 p-4 rounded-lg border border-gold-100 italic">
                                    <div className="flex justify-between items-center mb-2">
                                        <label className="text-xs font-bold text-gold-700 uppercase flex items-center gap-2">
                                            <Icon name="Star" size={14} /> Primary Member Note
                                        </label>
                                        <label className="flex items-center gap-2 cursor-pointer group">
                                            <span className="text-[10px] font-bold text-app-text-muted group-hover:text-gold-600 transition-colors uppercase tracking-widest">Pin to List</span>
                                            <div className="relative inline-block w-8 h-4 transition duration-200 ease-in mt-0.5">
                                                <input
                                                    type="checkbox"
                                                    className="opacity-0 w-0 h-0 peer"
                                                    checked={!!localMember.pinNote}
                                                    onChange={(e) => handleFieldChange('pinNote', e.target.checked ? 1 : 0)}
                                                />
                                                <span className={`absolute inset-0 rounded-full cursor-pointer transition-colors duration-200 ${localMember.pinNote ? 'bg-gold-500' : 'bg-app-border'}`}></span>
                                                <span className={`absolute left-0.5 top-0.5 w-3 h-3 bg-app-surface rounded-full transition-transform duration-200 ${localMember.pinNote ? 'translate-x-4' : 'translate-x-0'}`}></span>
                                            </div>
                                        </label>
                                    </div>
                                    <textarea
                                        className="w-full p-3 border border-gold-200 bg-app-surface text-app-text rounded focus:ring-2 focus:ring-gold-500 outline-none transition-colors text-sm font-medium"
                                        placeholder="Add an important note to display on the main list..."
                                        rows="2"
                                        value={localMember.notes || ''}
                                        onChange={(e) => handleFieldChange('notes', e.target.value)}
                                    />
                                </div>
                            </div>

                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1 flex justify-between items-center">
                                    <span>Suit Style (Inventory Link)</span>
                                    {localMember.suit_variant_id ? (
                                        <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-black uppercase">Individual SKU</span>
                                    ) : party?.suit_variant_id ? (
                                        <span className="text-[10px] bg-gold-100 text-gold-800 px-1.5 py-0.5 rounded font-black uppercase">Inherited from Party</span>
                                    ) : null}
                                </h4>
                                <div className="space-y-3">
                                    <div className="flex gap-2">
                                        <VariantSearchInput 
                                            className="flex-1"
                                            placeholder="Search inventory to link suit..."
                                            onSelect={(v) => {
                                                setLocalMember(prev => ({
                                                    ...prev,
                                                    suit: `${v.product_name}${v.variation_label ? ` (${v.variation_label})` : ''}`,
                                                    suit_variant_id: v.variant_id
                                                }));
                                            }}
                                        />
                                        {(localMember.suit_variant_id) && (
                                            <button 
                                                type="button"
                                                onClick={() => setLocalMember({ ...localMember, suit_variant_id: null })}
                                                className="px-3 py-2 bg-app-surface border border-app-border text-app-text-muted hover:text-red-600 rounded text-xs font-bold transition-colors"
                                            >
                                                Unlink
                                            </button>
                                        )}
                                    </div>
                                    <div className="text-[10px] text-app-text-muted italic flex items-center justify-between gap-1">
                                        <div className="flex items-center gap-1">
                                            <Icon name="Info" size={12} /> Linked: <span className="font-bold text-app-text">{localMember.suit || (party?.styleInfo ? `${party.styleInfo} (Party)` : "None")}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] uppercase font-black text-app-text-muted">Promo Free Suit:</span>
                                            <button 
                                                type="button"
                                                onClick={() => handleFieldChange('isFreeSuitPromo', !localMember.isFreeSuitPromo)}
                                                className={`px-3 py-1 rounded border text-[10px] font-black uppercase transition-all flex items-center gap-1 ${
                                                    localMember.isFreeSuitPromo
                                                        ? "bg-emerald-600 border-emerald-800 text-white"
                                                        : "bg-app-surface border-app-border text-app-text-muted hover:text-app-text"
                                                }`}
                                            >
                                                <Icon name={localMember.isFreeSuitPromo ? "CheckCircle" : "Circle"} size={10} />
                                                {localMember.isFreeSuitPromo ? "Active" : "Disabled"}
                                            </button>
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                        {WEDDING_MEMBER_RETAIL_SIZE_FIELDS.map(({ memberField, label }) => (
                                            <div key={memberField}>
                                                <label className="block text-xs font-bold text-app-text-muted uppercase mb-1 text-center">{label}</label>
                                                <input type="text" className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded-lg focus:ring-2 focus:ring-navy-900 outline-none text-center transition-colors font-bold text-lg"
                                                    value={localMember[memberField] || ''} onChange={(e) => handleFieldChange(memberField, e.target.value)}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
 
                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1 flex justify-between items-center">
                                    <span>Special Non-Inventory Needs</span>
                                    <span className="text-[10px] text-app-text-muted font-normal normal-case italic">For items not in master catalog</span>
                                </h4>
                                <div className="space-y-2">
                                    <div className="flex gap-2">
                                        <input 
                                            type="text"
                                            id="new-non-inv-desc"
                                            className="flex-1 px-3 py-2 text-sm border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                            placeholder="Item description (e.g. Brooks Bros Silk Tie)..."
                                        />
                                        <input 
                                            type="number"
                                            id="new-non-inv-qty"
                                            className="w-16 px-3 py-2 text-sm border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors"
                                            defaultValue="1"
                                        />
                                        <button 
                                            type="button"
                                            onClick={async () => {
                                                const desc = document.getElementById('new-non-inv-desc').value;
                                                const qty = parseInt(document.getElementById('new-non-inv-qty').value);
                                                if (!desc) return;
                                                const author = await selectSalesperson();
                                                if (!author) return;
                                                try {
                                                    await api.createNonInventoryItem({
                                                        wedding_party_id: localMember.partyId,
                                                        wedding_member_id: localMember.id,
                                                        description: desc,
                                                        quantity: qty,
                                                        actor_name: author
                                                    });
                                                    document.getElementById('new-non-inv-desc').value = '';
                                                    if (onRefresh) onRefresh();
                                                } catch (err) {
                                                    console.error("Failed to add non-inventory item", err);
                                                }
                                            }}
                                            className="px-4 py-2 bg-app-surface border border-app-border text-app-text hover:bg-app-surface-2 rounded text-xs font-bold transition-all"
                                        >
                                            Add Need
                                        </button>
                                    </div>
                                    <p className="text-[10px] text-app-text-muted italic">
                                        These items will appear on the Purchase Order "Due List" for procurement.
                                    </p>
                                </div>
                            </div>

                            {/* Order Information */}
                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1">Order Information</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                                    <div>
                                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Purchase Order (PO) #</label>
                                        <input
                                            type="text"
                                            className="w-full p-3 border border-app-border bg-app-surface text-app-text rounded-lg focus:ring-2 focus:ring-navy-900 outline-none transition-colors font-bold"
                                            placeholder="e.g., PO-12345"
                                            value={localMember.orderedPO || ''}
                                            onChange={(e) => handleFieldChange('orderedPO', e.target.value)}
                                        />
                                    </div>
                                    <div className="flex flex-col justify-end pb-1">
                                        <div className={`p-3 rounded-lg border flex items-center gap-3 ${localMember.ordered ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-app-surface-2 border-app-border text-app-text-muted'}`}>
                                            <Icon name={localMember.ordered ? 'CheckCircle' : 'Circle'} size={20} />
                                            <div>
                                                <div className="text-xs font-black uppercase leading-none">{localMember.ordered ? 'Ordered' : 'Needs Order'}</div>
                                                {localMember.orderedDate && <div className="text-[10px] font-bold opacity-80 mt-1">{new Date(localMember.orderedDate).toLocaleDateString()}</div>}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1">
                                    Payment & Deposit Status
                                </h4>
                                {financialBusy ? (
                                    <div className="rounded border border-app-border bg-app-surface-2 p-3 text-xs text-app-text-muted">
                                        Loading ROS financial status...
                                    </div>
                                ) : !financialRow ? (
                                    <div className="rounded border border-app-border bg-app-surface-2 p-3 text-xs text-app-text-muted italic">
                                        No payment/deposit records linked for this member yet.
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                                            <div className="rounded border border-blue-100 bg-blue-50 p-2">
                                                <div className="text-[10px] font-bold uppercase text-blue-700">Orders</div>
                                                <div className="text-lg font-black text-blue-900">{financialRow.order_count ?? 0}</div>
                                            </div>
                                            <div className="rounded border border-emerald-100 bg-emerald-50 p-2">
                                                <div className="text-[10px] font-bold uppercase text-emerald-700">Payments</div>
                                                <div className="text-lg font-black text-emerald-900">{financialRow.payment_count ?? 0}</div>
                                            </div>
                                            <div className="rounded border border-app-border bg-app-surface p-2">
                                                <div className="text-[10px] font-bold uppercase text-app-text-muted">Order Total</div>
                                                <div className="text-sm font-black text-app-text">{formatMoney(financialRow.order_total)}</div>
                                            </div>
                                            <div className="rounded border border-app-border bg-app-surface p-2">
                                                <div className="text-[10px] font-bold uppercase text-app-text-muted">Paid / Deposits</div>
                                                <div className="text-sm font-black text-emerald-700">{formatMoney(financialRow.paid_total)}</div>
                                            </div>
                                        </div>
                                        <div className={`rounded border p-2 text-sm font-black ${
                                            Number(financialRow.balance_due ?? 0) > 0
                                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                                : "border-emerald-200 bg-emerald-50 text-emerald-800"
                                        }`}>
                                            Balance Due: {formatMoney(financialRow.balance_due)}
                                        </div>
                                        {!member?.isNew && localMember.customerId ? (
                                            <button
                                                type="button"
                                                onClick={handleOpenInRegister}
                                                className="w-full rounded-lg border-b-4 border-emerald-800 bg-emerald-600 px-3 py-2.5 text-center text-sm font-black uppercase tracking-wide text-white shadow-sm transition hover:bg-emerald-500"
                                            >
                                                Open in Register (wedding order)
                                            </button>
                                        ) : null}
                                        <div className="rounded border border-app-border bg-app-surface p-2">
                                            <div className="mb-2 text-[10px] font-bold uppercase text-app-text-muted">Recent Transactions</div>
                                            {financialLines.length === 0 ? (
                                                <div className="text-xs text-app-text-muted italic">No transaction lines yet.</div>
                                            ) : (
                                                <div className="space-y-1">
                                                    {financialLines.map((ln, idx) => (
                                                        <div key={`${ln.kind}-${ln.created_at}-${idx}`} className="flex items-center justify-between text-xs">
                                                            <span className="truncate text-app-text">
                                                                {ln.kind}
                                                                {ln.kind === "order" && fulfillmentLabel(ln.fulfillment_profile)
                                                                    ? ` · ${fulfillmentLabel(ln.fulfillment_profile)}`
                                                                    : ""}
                                                                {" · "}
                                                                {ln.created_at ? new Date(ln.created_at).toLocaleString() : "No date"}
                                                            </span>
                                                            <span className="font-bold text-app-text">{formatMoney(ln.amount)}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Stock Status */}
                            {localMember.stockInfo && (
                                <div>
                                    <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1 flex justify-between items-center">
                                        Stock Status
                                        <span className="text-[10px] text-app-text-muted font-normal normal-case italic">Items marked as already in stock</span>
                                    </h4>
                                    <div className="flex flex-wrap gap-2 pt-1 border border-dashed border-app-border p-3 rounded-lg bg-app-surface-2/30">
                                        {(() => {
                                            const stockInfo = typeof localMember.stockInfo === 'string' ? JSON.parse(localMember.stockInfo || '{}') : (localMember.stockInfo || {});
                                            const stockItems = Object.entries(stockInfo).filter(([_, status]) => status === 'stock').map(([key]) => key);

                                            if (stockItems.length === 0) return <span className="text-xs text-app-text-muted italic">No items marked as in stock.</span>;

                                            return stockItems.map(item => (
                                                <span key={item} className="px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-[10px] font-black uppercase flex items-center gap-1.5 shadow-sm">
                                                    <Icon name="Archive" size={10} />
                                                    {item}
                                                </span>
                                            ));
                                        })()}
                                    </div>
                                </div>
                            )}

                            {/* Accessories */}
                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1">Accessories</h4>
                                <p className="text-xs text-app-text-muted mb-3">Inherited from party. Edit to customize for this member.</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {[
                                        { key: 'vest', label: 'Vest' },
                                        { key: 'shirt', label: 'Shirt' },
                                        { key: 'ties', label: 'Tie' },
                                        { key: 'pocketSq', label: 'Pocket Square' },
                                        { key: 'shoes', label: 'Shoes' },
                                        { key: 'socks', label: 'Socks' },
                                        { key: 'suspenders', label: 'Suspenders' },
                                        { key: 'cufflinks', label: 'Cufflinks' },
                                        { key: 'belt', label: 'Belt' }
                                    ].map(({ key, label }) => {
                                        // Get party value
                                        const partyAcc = parseJSON(party?.accessories);
                                        const partyVal = partyAcc[key] || '';

                                        // Get member override
                                        const memberAccArr = parseJSON(localMember.accessories);
                                        const memberVal = memberAccArr[key] || '';

                                        // Use member override if set, otherwise party value
                                        const currentValue = memberVal || partyVal;
                                        const isOverridden = !!memberVal;

                                        return (
                                            <div key={key} className={`p-2 border rounded ${isOverridden ? 'border-gold-500 bg-gold-50' : 'border-app-border bg-app-surface'}`}>
                                                <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">
                                                    {label}
                                                    {isOverridden && <span className="ml-1 text-gold-600" title="Customized for this member">★</span>}
                                                </label>
                                                <input
                                                    type="text"
                                                    className="w-full px-2 py-1 text-sm border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none"
                                                    placeholder={partyVal || '-'}
                                                    value={currentValue}
                                                    onChange={(e) => {
                                                        const newAccessories = { ...parseJSON(localMember.accessories), [key]: e.target.value };
                                                        handleFieldChange('accessories', newAccessories);
                                                    }}
                                                />
                                                {partyVal && !isOverridden && <div className="text-xs text-app-text-muted mt-1">Party: {partyVal}</div>}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Dates & Scheduling */}
                            <div>
                                <h4 className="font-bold text-app-text mb-2 border-b border-app-border pb-1">Scheduling</h4>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                                    <div>
                                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Measurement Date</label>
                                        <div
                                            onClick={() => handleOpenScheduler('Measurement')}
                                            className="w-full p-3 border border-app-border bg-app-surface rounded-lg focus:ring-2 focus:ring-navy-900 outline-none cursor-pointer hover:bg-app-surface-2 flex justify-between items-center transition-all active:bg-app-surface-2 min-h-[44px]"
                                        >
                                            <span className={`font-bold ${localMember.measureDate ? 'text-app-text' : 'text-app-text-muted'}`}>
                                                {localMember.measureDate ? new Date(localMember.measureDate).toLocaleDateString() : 'Schedule...'}
                                            </span>
                                            <Icon name="Calendar" size={16} className="text-app-text-muted" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Fitting Date</label>
                                        <div
                                            onClick={() => handleOpenScheduler('Fitting')}
                                        >
                                            <span className={localMember.fittingDate ? 'text-app-text' : 'text-app-text-muted'}>
                                                {localMember.fittingDate ? new Date(localMember.fittingDate).toLocaleDateString() : 'Schedule...'}
                                            </span>
                                            <Icon name="Calendar" size={14} className="text-app-text-muted" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-app-text-muted uppercase mb-1">Pickup Date (Target)</label>
                                        <div className="text-xs text-app-text-muted mb-1">{party && isLegacyIndividualParty(party) ? 'Event date' : '7 days before wedding'}</div>
                                        <input
                                            type="date"
                                            className="w-full p-2 border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none bg-app-surface-2 text-app-text transition-colors"
                                            value={localMember.pickupDate || ''}
                                            readOnly
                                            title={party && isLegacyIndividualParty(party) ? 'Based on the party event date' : 'Calculated: 7 days before wedding'}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Appointment List in Modal */}
                            <div className="mt-4 bg-app-surface-2 rounded border border-app-border p-3 transition-colors">
                                <h5 className="text-xs font-bold text-app-text-muted uppercase mb-2">Scheduled Appointments</h5>
                                <AppointmentList memberId={member.id} partyId={member.partyId} />
                            </div>
                        </div>
                    )}

                    {/* Contact History */}
                    <div>
                        <h4 className="font-bold text-app-text  mb-2 border-b border-app-border  pb-1">Contact History</h4>
                        <div className="bg-app-surface-2  rounded border border-app-border  p-3 h-32 overflow-y-auto mb-3 space-y-2 custom-scrollbar transition-colors">
                            {localMember.contactHistory && localMember.contactHistory.length > 0 ? (
                                localMember.contactHistory.map((log, i) => (
                                    <div key={i} className="text-sm border-b border-app-border last:border-0 pb-1 flex justify-between items-start group">
                                        {editingLogIndex === i ? (
                                            <div className="flex-1 flex gap-2 items-center">
                                                <input
                                                    type="text"
                                                    className="flex-1 p-1 border border-app-border rounded text-sm"
                                                    value={editingLogText}
                                                    onChange={(e) => setEditingLogText(e.target.value)}
                                                    autoFocus
                                                />
                                                <button type="button" onClick={() => saveEditLog(i)} className="text-green-600 hover:text-green-800"><Icon name="Check" size={16} /></button>
                                                <button type="button" onClick={() => setEditingLogIndex(null)} className="text-red-500 hover:text-red-700"><Icon name="X" size={16} /></button>
                                            </div>
                                        ) : (
                                            <>
                                                <div>
                                                    <span className="font-bold text-app-text ">{new Date(log.date).toLocaleDateString()}:</span> <span className="text-app-text ">{log.note}</span>
                                                </div>
                                                <div className="flex gap-1">
                                                    <button type="button" onClick={() => startEditLog(i, log.note)} className="text-app-text-muted hover:text-app-text p-0.5"><Icon name="Edit" size={14} /></button>
                                                    <button type="button" onClick={() => handleDeleteLog(i)} className="text-app-text-muted hover:text-red-600 p-0.5"><Icon name="Trash" size={14} /></button>
                                                </div>
                                            </>
                                        )}
                                    </div>
                                ))
                            ) : (
                                <div className="text-app-text-muted italic text-sm">No history yet.</div>
                            )}
                        </div>
                        <div className="flex gap-2">
                            <input type="text" className="flex-1 p-2 border border-app-border  bg-app-surface  text-app-text  rounded text-sm outline-none focus:ring-2 focus:ring-navy-900  transition-colors"
                                placeholder="Add a note..." value={newLog.note} onChange={(e) => setNewLog({ ...newLog, note: e.target.value })}
                                onKeyDown={(e) => e.key === 'Enter' && handleAddLog()}
                            />
                            <button type="button" onClick={handleAddLog} className="px-3 py-2 bg-app-border/50  text-app-text  font-bold rounded hover:bg-app-border  text-sm transition-colors">Add</button>
                        </div>
                    </div>

                    <div className="flex justify-between items-center pt-4 border-t border-app-border ">
                        <button type="button"
                            onClick={handleDelete}
                            className="px-4 py-2 text-red-500 font-bold hover:bg-red-50 rounded transition-colors flex items-center gap-2"
                            title="Delete this member"
                        >
                            <Icon name="Trash" size={16} /> Delete Member
                        </button>
                        <div className="flex gap-3">
                            <button type="button" onClick={onClose} className="px-4 py-2 text-app-text  font-bold hover:bg-app-surface-2  rounded transition-colors">Cancel</button>
                            <button type="button" onClick={handleSave} className="px-6 py-2 bg-navy-900 hover:bg-navy-800 text-white font-bold rounded shadow transition-colors">Save Changes</button>
                        </div>
                    </div>
                </div>
            </div>

            <SchedulerModal
                isOpen={isSchedulerOpen}
                onClose={() => {
                    setIsSchedulerOpen(false);
                    if (onRefresh) onRefresh();
                }}
                parties={parties}
                prefilledMember={{
                    customerName: localMember.name,
                    phone: localMember.phone,
                    partyId: localMember.partyId,
                    memberId: localMember.id,
                    type: apptType,
                    salesperson: partySalesperson
                }}
            />
        </div >
    );
};

export default MemberDetailModal;
