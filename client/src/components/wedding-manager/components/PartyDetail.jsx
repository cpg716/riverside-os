import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { formatDate, formatPhone } from '../lib/utils';
import { useModal } from '../hooks/useModal';

import PartyNotesModal from './PartyNotesModal';
import StyleEditModal from './StyleEditModal';
import ContactEditModal from './ContactEditModal';
import MemberDetailModal from './MemberDetailModal';
import MemberAppointmentsModal from './MemberAppointmentsModal';
import MeasurementInfoModal from './MeasurementInfoModal';
import ChangeSalespersonModal from './ChangeSalespersonModal';
import PickupModal from './PickupModal';
import MemberListMobile from './MemberListMobile';
import MemberListDesktop from './MemberListDesktop';
import OrderReviewTab from './OrderReviewTab';
import OrderChecklistModal from './OrderChecklistModal';
import PartyHistoryModal from './PartyHistoryModal';
import OrderInfoModal from './OrderInfoModal';
import StockStatusModal from './StockStatusModal';
import { isLegacyIndividualParty } from '../lib/partyLegacy';

const PartyDetail = ({ party, parties, onBack, onUpdate, onRefresh, onPrint, onNewAppointment }) => {
    const { showAlert, showConfirm, selectSalesperson } = useModal();

    // Modal States
    const [isNotesModalOpen, setIsNotesModalOpen] = useState(false);
    const [isStyleModalOpen, setIsStyleModalOpen] = useState(false);
    const [isContactModalOpen, setIsContactModalOpen] = useState(false);
    const [isMemberModalOpen, setIsMemberModalOpen] = useState(false);
    const [isMeasureInfoModalOpen, setIsMeasureInfoModalOpen] = useState(false);
    const [isChangeSalespersonModalOpen, setIsChangeSalespersonModalOpen] = useState(false);

    const [viewMode, setViewMode] = useState('list'); // 'list' or 'review'
    const [isOrderListModalOpen, setIsOrderListModalOpen] = useState(false);
    const [selectedMember, setSelectedMember] = useState(null);
    const [memberForAppointments, setMemberForAppointments] = useState(null);
    const [pendingMeasureToggle, setPendingMeasureToggle] = useState(null);
    const [pendingPickupToggle, setPendingPickupToggle] = useState(null);
    const [isPickupModalOpen, setIsPickupModalOpen] = useState(false);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    const [isOrderInfoModalOpen, setIsOrderInfoModalOpen] = useState(false);
    const [isStockModalOpen, setIsStockModalOpen] = useState(false);
    const [pendingOrderToggle, setPendingOrderToggle] = useState(null);
    const [pendingStockUpdate, setPendingStockUpdate] = useState(null); // { memberId, field, value }
    const [paymentStatusByMemberId, setPaymentStatusByMemberId] = useState({});

    useEffect(() => {
        if (!party?.id) {
            setPaymentStatusByMemberId({});
            return;
        }
        const run = async () => {
            try {
                const ctx = await api.getPartyFinancialContext(party.id);
                const rows = Array.isArray(ctx?.members) ? ctx.members : [];
                const next = {};
                rows.forEach((row) => {
                    const paid = Number(row.paid_total ?? 0);
                    const order = Number(row.order_total ?? 0);
                    let status = "UNPAID";
                    if (paid > 0 && paid < order) status = "PARTIAL";
                    if (order > 0 && paid >= order) status = "PAID";
                    next[row.wedding_member_id] = status;
                });
                setPaymentStatusByMemberId(next);
            } catch (err) {
                console.error("Failed to load payment status:", err);
                setPaymentStatusByMemberId({});
            }
        };
        void run();
    }, [party?.id, party?.members]);

    /** Scoped appointment fetch + short TTL cache (avoids full-calendar pulls on every status toggle). */
    const apptsGateCacheRef = useRef({ partyId: null, list: null, expires: 0, inflight: null });

    useEffect(() => {
        apptsGateCacheRef.current = { partyId: null, list: null, expires: 0, inflight: null };
    }, [party?.id]);

    const getAppointmentsForGating = useCallback(async () => {
        const pid = party?.id;
        if (!pid) return [];
        const r = apptsGateCacheRef.current;
        const now = Date.now();
        if (r.partyId === pid && Array.isArray(r.list) && r.expires > now) {
            return r.list;
        }
        if (r.partyId === pid && r.inflight) {
            return r.inflight;
        }

        let from;
        let to;
        const ev = party?.date;
        if (ev && typeof ev === 'string') {
            const base = new Date(/^\d{4}-\d{2}-\d{2}$/.test(ev) ? `${ev}T12:00:00` : ev);
            if (!Number.isNaN(base.getTime())) {
                const f = new Date(base);
                f.setMonth(f.getMonth() - 9);
                const t = new Date(base);
                t.setMonth(t.getMonth() + 9);
                from = f.toISOString();
                to = t.toISOString();
            }
        }
        if (!from) {
            const t = new Date();
            const f = new Date();
            f.setFullYear(f.getFullYear() - 2);
            from = f.toISOString();
            to = t.toISOString();
        }

        const inflight = api.getAppointments(from, to).then((list) => {
            apptsGateCacheRef.current = {
                partyId: pid,
                list,
                expires: Date.now() + 90_000,
                inflight: null,
            };
            return list;
        }).catch((e) => {
            apptsGateCacheRef.current.inflight = null;
            throw e;
        });
        apptsGateCacheRef.current = {
            partyId: pid,
            list: r.partyId === pid ? r.list : null,
            expires: 0,
            inflight,
        };
        return inflight;
    }, [party?.id, party?.date]);

    // Handlers wrapped in useCallback
    const handleUpdateMember = useCallback(async (memberId, updatedMemberData, shouldSave = true) => {
        // Find existing member for comparison
        const member = party.members.find(m => m.id === memberId);

        // Optimistic Update (Immediate UI Refresh)
        const updatedMembers = party.members.map(m => m.id === memberId ? updatedMemberData : m);
        const updatedParty = { ...party, members: updatedMembers };
        onUpdate(updatedParty);

        // Update selectedMember if it's the one currently open in a modal
        if (selectedMember && selectedMember.id === memberId) {
            setSelectedMember(updatedMemberData);
        }

        if (!shouldSave) return; // Exit early if we only wanted to update the UI (e.g., while typing)

        // --- NEW: Measurement Stock Check ---
        const measurementFields = ['suit', 'waist', 'vest', 'shirt', 'shoe'];
        const changedField = measurementFields.find(f =>
            updatedMemberData[f] &&
            updatedMemberData[f] !== (member ? member[f] : '')
        );

        if (changedField && !updatedMemberData._stockCheckDone) {
            setPendingStockUpdate({
                memberId,
                field: changedField,
                value: updatedMemberData[changedField],
                fullUpdate: updatedMemberData
            });
            setIsStockModalOpen(true);
            return;
        }
        // Remove internal flag before saving
        const { _stockCheckDone, ...dataToSaveFinal } = updatedMemberData;
        // ------------------------------------

        try {
            let dataToSave = { ...dataToSaveFinal };
            // Ensure attribution for inline edits
            if (!dataToSave.updatedBy) {
                const actor = await selectSalesperson();
                if (!actor) {
                    onRefresh(); // Revert UI if attribution cancelled
                    return;
                }
                dataToSave.updatedBy = actor;
            }

            await api.updateMember(memberId, dataToSave);
        } catch (err) {
            console.error("Failed to update member:", err);
            showAlert(`Failed to save changes: ${err.message}`, "Error", { variant: 'danger' });
            onRefresh(); // Revert on error by refreshing from server
        }
    }, [party, onUpdate, selectedMember, showAlert, onRefresh, selectSalesperson]);

    const handleUpdatePartyNotes = useCallback(async (newNotes) => {
        try {
            await api.updateParty(party.id, { notes: newNotes });
            onUpdate({ ...party, notes: newNotes });
        } catch (err) {
            console.error("Failed to update notes:", err);
        }
    }, [party, onUpdate]);

    const handleUpdatePartyStyle = useCallback(async (updatedPartyData) => {
        try {
            // Calculate Changes for Logging
            const changes = [];
            if (party.styleInfo !== updatedPartyData.styleInfo) {
                changes.push(`Style: "${party.styleInfo || ''}" -> "${updatedPartyData.styleInfo || ''}"`);
            }
            if (party.priceInfo !== updatedPartyData.priceInfo) {
                changes.push(`Price: "${party.priceInfo || ''}" -> "${updatedPartyData.priceInfo || ''}"`);
            }

            const oldAcc = party.accessories || {};
            const newAcc = updatedPartyData.accessories || {};
            const allKeys = new Set([...Object.keys(oldAcc), ...Object.keys(newAcc)]);
            allKeys.forEach(key => {
                if (oldAcc[key] !== newAcc[key]) {
                    changes.push(`Accessory [${key}]: "${oldAcc[key] || ''}" -> "${newAcc[key] || ''}"`);
                }
            });

            let newNotesString = party.notes;

            if (changes.length > 0) {
                const changeLog = `Style/Pricing Updated by ${updatedPartyData.updatedBy}:\n` + changes.join('\n');

                // Parse existing notes
                let currentNotes = [];
                try {
                    const parsed = JSON.parse(party.notes || '[]');
                    if (Array.isArray(parsed)) currentNotes = parsed;
                    else throw new Error();
                } catch (e) {
                    if (party.notes && party.notes.trim()) {
                        currentNotes.push({
                            id: Date.now(),
                            text: party.notes,
                            date: new Date().toISOString(),
                            isLegacy: true
                        });
                    }
                }

                // Add new note
                currentNotes.unshift({
                    id: Date.now(),
                    text: changeLog,
                    date: new Date().toISOString()
                });

                newNotesString = JSON.stringify(currentNotes);
            }

            await api.updateParty(party.id, {
                styleInfo: updatedPartyData.styleInfo,
                priceInfo: updatedPartyData.priceInfo,
                accessories: updatedPartyData.accessories,
                updatedBy: updatedPartyData.updatedBy,
                notes: newNotesString
            });

            onUpdate({
                ...party,
                styleInfo: updatedPartyData.styleInfo,
                priceInfo: updatedPartyData.priceInfo,
                accessories: updatedPartyData.accessories,
                notes: newNotesString
            });
        } catch (err) {
            console.error("Failed to update style:", err);
            showAlert("Failed to update style.", "Error", { variant: 'danger' });
        }
    }, [party, onUpdate, showAlert]);

    const handleUpdatePartyContact = useCallback(async (partyId, updatedPartyData) => {
        try {
            await api.updateParty(partyId, {
                groomPhone: updatedPartyData.groomPhone,
                groomEmail: updatedPartyData.groomEmail,
                brideName: updatedPartyData.brideName,
                bridePhone: updatedPartyData.bridePhone,
                brideEmail: updatedPartyData.brideEmail,
                updatedBy: updatedPartyData.updatedBy
            });
            onUpdate({ ...party, ...updatedPartyData });
        } catch (err) {
            console.error("Failed to update contact:", err);
        }
    }, [party, onUpdate]);

    const handleAddMember = useCallback(async (partyId) => {
        const newMember = {
            partyId: partyId,
            name: '',
            role: 'Groomsman',
            phone: '',
            oot: false,
            suit: '', waist: '', vest: '', shirt: '', shoe: '',
            measured: false, ordered: false, received: false, fitting: false, pickup: false,
            contactHistory: [],
            isNew: true
        };
        setSelectedMember(newMember);
        setIsMemberModalOpen(true);
    }, []);

    const handleMemberClick = useCallback((member) => {
        setSelectedMember(member);
        setIsMemberModalOpen(true);
    }, []);

    const handleAddNewMemberConfirm = useCallback(async (partyId, memberData) => {
        const { isNew, ...dataToSave } = memberData;
        try {
            await api.addMember(partyId, dataToSave);
            onRefresh(); // Refresh to get the new member with ID
        } catch (err) {
            console.error("Failed to add member:", err);
            showAlert("Failed to add member.", "Error", { variant: 'danger' });
        }
    }, [onRefresh, showAlert]);

    const handleSalespersonSave = useCallback(async (newName, updatedBy) => {
        if (newName && newName !== party.salesperson) {
            try {
                await api.updateParty(party.id, { salesperson: newName, updatedBy });
                onUpdate({ ...party, salesperson: newName });
            } catch (err) {
                console.error("Failed to update salesperson:", err);
                showAlert("Failed to update salesperson.", "Error", { variant: 'danger' });
            }
        }
    }, [party, onUpdate, showAlert]);

    const handleDeleteParty = useCallback(async () => {
        const confirmed = await showConfirm(
            `Are you sure you want to delete the entire party "${party.trackingLabel || party.name}"? This will permanently remove all ${party.members?.length || 0} members and all related appointments. This cannot be undone.`,
            "Delete Entire Party",
            { variant: 'danger', confirmText: 'Delete Everything' }
        );
        if (!confirmed) return;

        const actor = await selectSalesperson();
        if (!actor) return;

        try {
            await api.deleteParty(party.id, actor);
            onBack(); // Go back to dashboard
            if (onRefresh) onRefresh();
        } catch (err) {
            console.error("Failed to delete party:", err);
            showAlert("Failed to delete party.", "Error", { variant: 'danger' });
        }
    }, [party, showConfirm, selectSalesperson, onBack, onRefresh, showAlert]);

    const toggleStatus = useCallback(async (partyId, memberId, field) => {
        const member = party.members.find(m => m.id === memberId);
        if (member) {
            // Workflow Validation
            // Only check if we are turning the status ON (it is currently false/null)
            if (!member[field]) {
                let dependency = null;
                let depLabel = '';

                if (field === 'ordered' && !member.measured) { dependency = 'measured'; depLabel = 'Measured'; }
                else if (field === 'received' && !member.ordered) { dependency = 'ordered'; depLabel = 'Ordered'; }
                else if (field === 'fitting' && !member.received) { dependency = 'received'; depLabel = 'Received'; }
                else if (field === 'pickup' && !member.fitting) { dependency = 'fitting'; depLabel = 'Fitted'; }

                if (dependency) {
                    const confirmed = await showConfirm(
                        `The previous step "${depLabel}" is not complete. Are you sure you want to mark this as Done?`,
                        "Workflow Warning",
                        { variant: 'warning', confirmText: 'Yes, Mark Done', cancelText: 'No, Cancel' }
                    );
                    if (!confirmed) return;
                }
            }

            // Start Measured Toggle Logic Update
            if (field === 'measured' && !member.measured) {
                // Check for scheduled appointments before allowing manual toggle
                try {
                    const appts = await getAppointmentsForGating();
                    const pendingAppt = appts.find(a =>
                        a.memberId === memberId &&
                        a.type === 'Measurement' &&
                        a.status !== 'Attended' &&
                        a.status !== 'Missed' &&
                        a.status !== 'Cancelled'
                    );

                    if (pendingAppt) {
                        await showConfirm(
                            `This member has a scheduled Measurement appointment on ${formatDate(pendingAppt.datetime)}. Please mark that appointment as "Attended" in the Calendar to automatically complete this step.`,
                            "Appointment Exists",
                            { variant: 'info', confirmText: 'OK', cancelText: null } // Single button alert style
                        );
                        return; // BLOCK action
                    }
                } catch (e) {
                    console.error("Failed to check appointments", e);
                    // On error, maybe allow fallback or warn? Let's allow fallback but warn console.
                }

                if (!member.measureDate) {
                    setPendingMeasureToggle({ partyId, memberId });
                    setIsMeasureInfoModalOpen(true);
                    return;
                }
            }
            // End Measured Toggle Logic Update

            // Start Fitting Toggle Logic Update
            if (field === 'fitting' && !member.fitting) {
                // Check for scheduled appointments before allowing manual toggle
                try {
                    const appts = await getAppointmentsForGating();
                    const pendingAppt = appts.find(a =>
                        a.memberId === memberId &&
                        a.type === 'Fitting' &&
                        a.status !== 'Attended' &&
                        a.status !== 'Missed' &&
                        a.status !== 'Cancelled'
                    );

                    if (pendingAppt) {
                        await showConfirm(
                            `This member has a scheduled Fitting appointment on ${formatDate(pendingAppt.datetime)}. Please mark that appointment as "Attended" in the Calendar to automatically complete this step.`,
                            "Appointment Exists",
                            { variant: 'info', confirmText: 'OK', cancelText: null }
                        );
                        return; // BLOCK action
                    }
                } catch (e) {
                    console.error("Failed to check appointments", e);
                }
            }
            // End Fitting Toggle Logic Update

            if (field === 'pickup' && !member.pickup) {
                setPendingPickupToggle({ partyId, memberId });
                setIsPickupModalOpen(true);
                return;
            }

            if (field === 'ordered' && !member.ordered) {
                setPendingOrderToggle({ partyId, memberId });
                setIsOrderInfoModalOpen(true);
                return;
            }
            // If turning off pickup (or partial -> off), prompt and clear
            if (field === 'pickup' && member.pickup) {
                const actor = await selectSalesperson();
                if (!actor) return;
                handleUpdateMember(memberId, { ...member, pickup: 0, updatedBy: actor });
                return;
            }

            // Prompt for Salesperson for ANY status change (ON or OFF)
            const updatedBy = await selectSalesperson();
            if (!updatedBy) return; // Cancelled

            const newValue = !member[field];
            const updates = {
                [field]: newValue,
                updatedBy
            };

            // Auto-set date if marking as done
            if (newValue) {
                const dateField = `${field}Date`;
                if (!member[dateField]) {
                    updates[dateField] = new Date().toISOString().split('T')[0];
                }
            }

            // Add to Contact History
            const statusLabel = newValue ? 'DONE' : 'PENDING';
            const displayField = field.charAt(0).toUpperCase() + field.slice(1);
            const newNote = `Marked ${displayField} as ${statusLabel} - ${updatedBy}`;
            const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
            updates.contactHistory = [...(member.contactHistory || []), historyEntry];

            handleUpdateMember(memberId, {
                ...member,
                ...updates
            });
        }
    }, [party.members, handleUpdateMember, showConfirm, selectSalesperson, getAppointmentsForGating]);

    const handleMeasureInfoSave = useCallback(async ({ date, source }) => {
        if (pendingMeasureToggle) {
            const { memberId } = pendingMeasureToggle;
            const member = party.members.find(m => m.id === memberId);
            if (member) {
                const updatedBy = await selectSalesperson();
                if (!updatedBy) return;

                const newNote = `Measurements called in on ${date} by ${source} (Entered by ${updatedBy})`;
                const updatedNotes = member.notes ? member.notes + '\n' + newNote : newNote;
                const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
                const updatedHistory = [...(member.contactHistory || []), historyEntry];

                handleUpdateMember(memberId, {
                    ...member,
                    measured: true,
                    measureDate: date,
                    notes: updatedNotes,
                    contactHistory: updatedHistory,
                    updatedBy
                });
            }
            setPendingMeasureToggle(null);
            setIsMeasureInfoModalOpen(false);
        }
    }, [pendingMeasureToggle, party.members, handleUpdateMember, selectSalesperson]);

    // Check for completion and prompt to print
    const checkCompletionAndPrompt = useCallback(async (updatedParty) => {
        const allPickedUp = updatedParty.members.every(m => m.pickup);
        if (allPickedUp) {
            // Wait a moment for the UI to update
            setTimeout(async () => {
                const confirmed = await showConfirm(
                    "All members have been picked up! Would you like to print the final party record?",
                    "Party Complete",
                    { variant: 'success', confirmText: 'Yes, Print', cancelText: 'No, Thanks' }
                );
                if (confirmed) {
                    onPrint();
                }
            }, 500);
        }
    }, [showConfirm, onPrint]);

    const handlePickupSave = useCallback(async ({ type, note }) => {
        if (pendingPickupToggle) {
            const { memberId } = pendingPickupToggle;
            const member = party.members.find(m => m.id === memberId);
            if (member) {
                const updatedBy = await selectSalesperson();
                if (!updatedBy) return;

                let updates = {
                    pickup: type === 'partial' ? 'partial' : 1,
                    pickupDate: new Date().toISOString().split('T')[0], // Ensure date is set
                    updatedBy
                };

                // Always add history entry for pickup with attribution
                const actionLabel = type === 'partial' ? 'PARTIAL PICKUP' : 'PICKUP';
                const noteContent = note ? ` - ${note}` : '';
                const newNote = `[${actionLabel}]${noteContent} - ${updatedBy} `;

                const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
                const updatedHistory = [...(member.contactHistory || []), historyEntry];
                updates.contactHistory = updatedHistory;

                // Optimistic update for check
                const updatedMember = { ...member, ...updates };
                const updatedMembers = party.members.map(m => m.id === memberId ? updatedMember : m);
                const updatedParty = { ...party, members: updatedMembers };

                await handleUpdateMember(memberId, { ...member, ...updates });

                // Check completion after update
                checkCompletionAndPrompt(updatedParty);
            }
            setPendingPickupToggle(null);
            setIsPickupModalOpen(false);
        }
    }, [pendingPickupToggle, party.members, handleUpdateMember, selectSalesperson, checkCompletionAndPrompt]);

    const handleStockSave = useCallback(async (status) => {
        if (pendingStockUpdate) {
            const { memberId, field, fullUpdate } = pendingStockUpdate;
            const currentStockInfo = typeof fullUpdate.stockInfo === 'string' ? JSON.parse(fullUpdate.stockInfo || '{}') : (fullUpdate.stockInfo || {});
            const updatedStockInfo = { ...currentStockInfo, [field]: status };

            await handleUpdateMember(memberId, {
                ...fullUpdate,
                stockInfo: JSON.stringify(updatedStockInfo),
                _stockCheckDone: true
            });

            setPendingStockUpdate(null);
            setIsStockModalOpen(false);
        }
    }, [pendingStockUpdate, handleUpdateMember]);

    const handleOrderInfoSave = useCallback(async ({ date, po }) => {
        if (pendingOrderToggle) {
            const { memberId } = pendingOrderToggle;
            const member = party.members.find(m => m.id === memberId);
            if (member) {
                const updatedBy = await selectSalesperson();
                if (!updatedBy) return;

                const newNote = `Ordered on ${date}${po ? ` (PO: ${po})` : ''} - ${updatedBy}`;
                const historyEntry = { date: new Date().toISOString().split('T')[0], note: newNote, id: Date.now() };
                const updatedHistory = [...(member.contactHistory || []), historyEntry];

                handleUpdateMember(memberId, {
                    ...member,
                    ordered: true,
                    orderedDate: date,
                    orderedPO: po,
                    contactHistory: updatedHistory,
                    updatedBy
                });
            }
            setPendingOrderToggle(null);
            setIsOrderInfoModalOpen(false);
        }
    }, [pendingOrderToggle, party.members, handleUpdateMember, selectSalesperson]);

    // Helper to parse notes
    const parsedNotes = useMemo(() => {
        try {
            const parsed = JSON.parse(party.notes);
            return Array.isArray(parsed) ? parsed : null;
        } catch (e) {
            return null;
        }
    }, [party.notes]);

    // Stats Memoization
    const stats = useMemo(() => {
        const members = party.members || [];
        const total = members.length;
        const needsAppointment = members.filter(m => !m.measured && (!m.measureDate && !m.fittingDate)).length;
        const needsOrdering = members.filter(m => m.measured && !m.ordered).length;
        const needsReceiving = members.filter(m => m.ordered && !m.received).length;
        const needsFitting = members.filter(m => m.received && !m.fitting).length;
        const needsPickup = members.filter(m => m.fitting && !m.pickup).length;

        const measuredCount = members.filter(m => m.measured).length;
        const orderedCount = members.filter(m => m.ordered).length;
        const receivedCount = members.filter(m => m.received).length;
        const fittedCount = members.filter(m => m.fitting).length;
        const pickedUpCount = members.filter(m => m.pickup).length;

        return {
            total,
            needsAppointment,
            needsOrdering,
            needsReceiving,
            needsFitting,
            needsPickup,
            measuredCount,
            orderedCount,
            receivedCount,
            fittedCount,
            pickedUpCount
        };
    }, [party.members]);

    // Compact date formatter for print
    const formatPrintDate = (dateString) => {
        if (!dateString) return '-';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '-';
        return date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
    };

    const legacyIndividual = isLegacyIndividualParty(party);

    return (
        <div className="min-h-screen bg-app-surface-2 flex flex-col transition-colors">
            {/* Print Styles */}
            <style>{`
                @media print {
                    @page { margin: 0.5cm; size: landscape; }
                    body { -webkit-print-color-adjust: exact; }
                    .no-print, .print\\:hidden { display: none !important; }
                    .print-only { display: block !important; }
                    
                    /* Compact Layout */
                    .print-container { 
                        font-size: 10px; 
                        inline-size: 100%;
                        max-inline-size: 100%;
                    }
                    .print-header {
                        display: flex;
                        justify-content: space-between;
                        border-block-end: 2px solid #000;
                        padding-block-end: 5px;
                        margin-block-end: 10px;
                    }
                    .print-header h1 { font-size: 18px; font-weight: bold; margin: 0; }
                    .print-header p { margin: 0; font-size: 12px; }
                    
                    .print-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr 1fr;
                        gap: 10px;
                        margin-block-end: 10px;
                    }
                    .print-box { border: 1px solid #ccc; padding: 5px; border-radius: 4px; }
                    .print-box h3 { font-size: 11px; font-weight: bold; border-block-end: 1px solid #eee; margin-block-end: 3px; padding-block-end: 2px; }
                    
                    /* Table Compact */
                    .print-table { inline-size: 100%; border-collapse: collapse; font-size: 9px; }
                    .print-table th { background: #f0f0f0; font-weight: bold; text-align: start; padding: 4px; border-block-end: 1px solid #000; }
                    .print-table td { padding: 4px; border-block-end: 1px solid #ddd; vertical-align: top; }
                    .print-table tr:nth-child(even) { background: #f9f9f9; }
                    
                    /* Hide default UI */
                    nav, header, footer, button { display: none !important; }
                    .min-h-screen { block-size: auto; overflow: visible; }
                }
            `}</style>

            {/* Print View (Hidden on Screen) */}
            <div className="hidden print:block print-container bg-app-surface p-4">
                <div className="print-header">
                    <div>
                        <h1>{party.trackingLabel || party.name}{legacyIndividual ? '' : ' Wedding'}</h1>
                        <p>Event date: {formatDate(party.date)}</p>
                    </div>
                    <div className="text-right">
                        <p>Salesperson: {party.salesperson}</p>
                        <p>Printed: {new Date().toLocaleDateString()}</p>
                    </div>
                </div>

                <div className="print-grid">
                    <div className="print-box">
                        <h3>Contact Info</h3>
                        <div><strong>Primary contact:</strong> {(party.members || []).find(m => m.role === 'Groom' || m.role === 'Customer')?.name || party.name}</div>
                        <div>{formatPhone(party.groomPhone)}</div>
                        {!legacyIndividual && (
                            <>
                                <div className="mt-1"><strong>Bride:</strong> {party.brideName}</div>
                                <div>{formatPhone(party.bridePhone)}</div>
                            </>
                        )}
                    </div>
                    <div className="print-box">
                        <h3>Style & Pricing</h3>
                        <div><strong>Style:</strong> {party.styleInfo || 'None'}</div>
                        <div><strong>Price:</strong> {party.priceInfo || 'Pending'}</div>
                    </div>
                    <div className="print-box">
                        <h3>Accessories</h3>
                        <div className="flex flex-wrap gap-2">
                            {party.accessories && Object.entries(party.accessories).map(([k, v]) => (
                                <span key={k}><strong>{k}:</strong> {v}</span>
                            ))}
                        </div>
                    </div>
                </div>

                <table className="print-table">
                    <thead>
                        <tr>
                            <th style={{ inlineSize: '25%' }}>Member</th>
                            <th style={{ inlineSize: '25%' }}>Sizes (S/W/V/Sh/Shoe)</th>
                            <th style={{ inlineSize: '10%' }}>Measured</th>
                            <th style={{ inlineSize: '10%' }}>Ordered</th>
                            <th style={{ inlineSize: '10%' }}>Received</th>
                            <th style={{ inlineSize: '10%' }}>Fitted</th>
                            <th style={{ inlineSize: '10%' }}>Picked Up</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(party.members || []).map(m => (
                            <tr key={m.id}>
                                <td>
                                    <div className="font-bold text-[10px]">{m.name}</div>
                                    <div className="text-[9px] text-app-text italic">{m.role}</div>
                                    <div className="text-[9px]">{formatPhone(m.phone)}</div>
                                </td>
                                <td>{`${m.suit || '-'} / ${m.waist || '-'} / ${m.vest || '-'} / ${m.shirt || '-'} / ${m.shoe || '-'} `}</td>
                                <td>{formatPrintDate(m.measureDate) !== '-' ? formatPrintDate(m.measureDate) : (m.measured ? 'Yes' : '-')}</td>
                                <td>{formatPrintDate(m.orderedDate) !== '-' ? formatPrintDate(m.orderedDate) : (m.ordered ? 'Yes' : '-')}</td>
                                <td>{formatPrintDate(m.receivedDate) !== '-' ? formatPrintDate(m.receivedDate) : (m.received ? 'Yes' : '-')}</td>
                                <td>{formatPrintDate(m.fittingDate) !== '-' ? formatPrintDate(m.fittingDate) : (m.fitting ? 'Yes' : '-')}</td>
                                <td>{formatPrintDate(m.pickupDate) !== '-' ? formatPrintDate(m.pickupDate) : (m.pickup ? (m.pickup === 'partial' ? 'Partial' : 'Yes') : '-')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>

                {party.notes && (
                    <div className="mt-4 border-t pt-2">
                        <strong>Notes:</strong>
                        <pre className="whitespace-pre-wrap font-sans text-[9px] mt-1">{
                            parsedNotes ? parsedNotes.map(n => `[${formatDate(n.date)}] ${n.text} `).join('\n') : party.notes
                        }</pre>
                    </div>
                )}
            </div>

            <PartyNotesModal
                isOpen={isNotesModalOpen}
                onClose={() => setIsNotesModalOpen(false)}
                notes={party.notes || ''}
                onSave={handleUpdatePartyNotes}
            />
            <StyleEditModal
                isOpen={isStyleModalOpen}
                onClose={() => setIsStyleModalOpen(false)}
                party={party}
                onSave={handleUpdatePartyStyle}
            />
            <ContactEditModal
                isOpen={isContactModalOpen}
                onClose={() => setIsContactModalOpen(false)}
                party={party}
                onSave={(partyId, data) => handleUpdatePartyContact(partyId, data)}
            />
            <MemberDetailModal
                isOpen={isMemberModalOpen}
                onClose={() => {
                    setIsMemberModalOpen(false);
                    onRefresh();
                }}
                member={selectedMember}
                onUpdate={handleUpdateMember}
                onAdd={handleAddNewMemberConfirm}
                parties={parties}
                onRefresh={onRefresh}
            />
            <MemberAppointmentsModal
                isOpen={!!memberForAppointments}
                onClose={() => setMemberForAppointments(null)}
                member={memberForAppointments}
                parties={parties}
                onRefresh={onRefresh}
            />
            <MeasurementInfoModal
                isOpen={isMeasureInfoModalOpen}
                onClose={() => {
                    setIsMeasureInfoModalOpen(false);
                    setPendingMeasureToggle(null);
                }}
                onSave={handleMeasureInfoSave}
            />
            <ChangeSalespersonModal
                isOpen={isChangeSalespersonModalOpen}
                onClose={() => setIsChangeSalespersonModalOpen(false)}
                currentSalesperson={party?.salesperson}
                onSave={handleSalespersonSave}
            />
            <PickupModal
                isOpen={isPickupModalOpen}
                onClose={() => {
                    setIsPickupModalOpen(false);
                    setPendingPickupToggle(null);
                }}
                onSave={handlePickupSave}
                memberName={pendingPickupToggle ? (party.members || []).find(m => m.id === pendingPickupToggle.memberId)?.name : ''}
            />
            <OrderChecklistModal
                isOpen={isOrderListModalOpen}
                onClose={() => setIsOrderListModalOpen(false)}
                party={party}
            />
            <PartyHistoryModal
                isOpen={isHistoryModalOpen}
                onClose={() => setIsHistoryModalOpen(false)}
                partyId={party.id}
                partyName={party.trackingLabel || party.name}
            />

            <OrderInfoModal
                isOpen={isOrderInfoModalOpen}
                onClose={() => setIsOrderInfoModalOpen(false)}
                memberName={pendingOrderToggle ? (party.members.find(m => m.id === pendingOrderToggle.memberId)?.name || '') : ''}
                onSave={handleOrderInfoSave}
            />

            <StockStatusModal
                isOpen={isStockModalOpen}
                onClose={() => {
                    setIsStockModalOpen(false);
                    setPendingStockUpdate(null);
                    onRefresh(); // To clear the optimistic update if choice cancelled
                }}
                itemName={pendingStockUpdate?.field || 'item'}
                onSelect={handleStockSave}
            />

            {/* Top Navigation Bar */}
            <div className="bg-gradient-to-r from-neutral-950 to-neutral-900 border-b border-white/10 sticky top-0 z-20 shadow-lg backdrop-blur-sm bg-opacity-95 text-white print:hidden">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex flex-col sm:flex-row justify-between items-center h-auto sm:h-16 py-3 sm:py-0 gap-3 sm:gap-0">
                        <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-start">
                            <div className="flex items-center gap-4">
                                <button type="button"
                                    onClick={onBack}
                                    className="p-2 rounded-full hover:bg-app-surface-2/10 text-app-text-muted hover:text-white transition-colors print:hidden touch-target"
                                >
                                    <Icon name="ArrowLeft" size={24} />
                                </button>
                                <div>
                                    <h2 className="text-lg font-bold tracking-tight flex items-center gap-2">
                                        {party.trackingLabel || party.name}
                                        <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-widest bg-white/15 text-white/90">
                                            {legacyIndividual ? 'Party' : 'Wedding Party'}
                                        </span>
                                    </h2>
                                    <p className="text-xs text-white/80 flex items-center gap-1.5 font-medium">
                                        <Icon name="Calendar" size={12} />
                                        Event date: {formatDate(party.date)}
                                    </p>
                                </div>
                            </div>
                            <button type="button" onClick={onPrint} className="sm:hidden text-white/80 hover:text-white transition-colors" title="Print Party Record">
                                <Icon name="Printer" size={18} />
                            </button>
                        </div>
                        <div className="flex gap-6 text-sm items-center w-full sm:w-auto justify-between sm:justify-end border-t border-white/10 sm:border-0 pt-3 sm:pt-0">
                            <button type="button"
                                onClick={() => onNewAppointment({
                                    partyId: party.id,
                                    salesperson: party.salesperson,
                                    customerName: party.name,
                                    phone: party.groomPhone
                                })}
                                className="flex items-center gap-2 px-4 py-2 bg-gold-500/10 text-gold-500 hover:bg-gold-500 hover:text-white transition-all font-black rounded-lg border-2 border-gold-500/50 shadow-sm active:scale-95 text-xs uppercase tracking-wider"
                                title="Schedule New Appointment"
                            >
                                <Icon name="Calendar" size={16} /> Schedule Appt
                            </button>
                            <button type="button"
                                onClick={() => setIsHistoryModalOpen(true)}
                                className="flex items-center gap-2 px-4 py-2 bg-white/10 text-white hover:bg-white/20 hover:text-white transition-all font-bold rounded-lg border-2 border-white/20 shadow-sm active:scale-95 text-xs uppercase tracking-wider"
                                title="View Party Audit History"
                            >
                                <Icon name="History" size={16} /> History
                            </button>
                            <button type="button"
                                onClick={onPrint}
                                className="hidden sm:flex items-center gap-2 px-4 py-2 bg-app-surface/5 text-white/80 hover:bg-app-surface-2/10 hover:text-white transition-all font-bold rounded-lg border-2 border-white/10 shadow-sm active:scale-95 text-xs uppercase tracking-wider"
                                title="Print Party Record"
                            >
                                <Icon name="Printer" size={16} /> Print
                            </button>
                            <div className="text-left sm:text-right">
                                <div className="text-[10px] text-white/60 uppercase font-bold tracking-wider">Salesperson</div>
                                <div className="font-bold text-white">{party.salesperson}</div>
                            </div>
                            <div className="h-8 w-px bg-white/15 hidden sm:block"></div>
                            <div className="text-right">
                                <div className="text-[10px] text-white/60 uppercase font-bold tracking-wider">Signed Up</div>
                                <div className="font-medium text-white">{party.signUpDate || '-'}</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 max-w-[100vw] overflow-x-hidden print:hidden">
                <div className="max-w-7xl mx-auto p-4 md:p-8 space-y-6">


                    {/* Row 1: Key Information */}
                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                        {/* Contact Info */}
                        <div className="bg-app-surface rounded-lg shadow-sm hover:shadow-md border border-app-border overflow-hidden flex flex-col relative group lg:col-span-1 transition-all duration-300">
                            <div className="bg-app-surface-2 px-4 py-3 border-b border-app-border flex justify-between items-center">
                                <h3 className="text-xs font-bold text-app-text uppercase tracking-wide">Contact Information</h3>
                                <div className="flex gap-2">
                                    <button type="button"
                                        onClick={handleDeleteParty}
                                        className="p-1.5 rounded-full bg-app-surface text-red-500 shadow-sm hover:bg-red-50 border border-app-border transition-colors"
                                        title="Delete party"
                                    >
                                        <Icon name="Trash" size={14} />
                                    </button>
                                    <button type="button"
                                        onClick={() => setIsContactModalOpen(true)}
                                        className="p-1.5 rounded-full bg-app-surface text-app-text-muted shadow-sm hover:bg-app-surface-2 border border-app-border transition-colors"
                                    >
                                        <Icon name="Edit" size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="p-5 space-y-4">
                                <div className="pb-3 border-b border-app-border/80">
                                    <div className="text-[10px] text-gold-600 font-bold uppercase mb-1">Primary contact</div>
                                    <div className="font-bold text-lg text-app-text">{(party.members || []).find(m => m.role === 'Groom' || m.role === 'Customer')?.name || party.name}</div>
                                    <div className="flex flex-col gap-1 mt-1">
                                        <div className="text-sm text-app-text flex items-center gap-2">
                                            <Icon name="Phone" size={14} />
                                            {formatPhone(party.groomPhone) || <span className="text-app-text-muted italic">No Phone</span>}
                                        </div>
                                        {party.groomEmail && (
                                            <a href={`mailto:${party.groomEmail} `} className="text-sm text-blue-600 hover:underline flex items-center gap-2">
                                                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full"></span> {party.groomEmail}
                                            </a>
                                        )}
                                    </div>
                                </div>
                                {!legacyIndividual && (
                                    <div>
                                        <div className="text-[10px] text-gold-600 font-bold uppercase mb-1">Bride</div>
                                        <div className="font-bold text-lg text-app-text">{party.brideName || 'No Name Listed'}</div>
                                        <div className="flex flex-col gap-1 mt-1">
                                            <div className="text-sm text-app-text flex items-center gap-2">
                                                <Icon name="Phone" size={14} />
                                                {formatPhone(party.bridePhone) || <span className="text-app-text-muted italic">No Phone</span>}
                                            </div>
                                            {party.brideEmail && (
                                                <a href={`mailto:${party.brideEmail} `} className="text-sm text-blue-600 hover:underline flex items-center gap-2">
                                                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full"></span> {party.brideEmail}
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Style & Pricing */}
                        <div className="bg-app-surface rounded-lg shadow-sm hover:shadow-md border border-app-border overflow-hidden flex flex-col relative group lg:col-span-2 transition-all duration-300">
                            <div className="bg-app-surface-2 px-4 py-3 border-b border-app-border flex justify-between items-center">
                                <h3 className="text-xs font-bold text-app-text uppercase tracking-wide">Style & Pricing</h3>
                                <div className="flex items-center gap-2">
                                    <button type="button"
                                        onClick={() => setIsOrderListModalOpen(true)}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-navy-50 text-app-text font-bold rounded-lg border border-navy-100 hover:bg-navy-100 transition-colors text-xs shadow-sm"
                                        title="View Order Checklist"
                                    >
                                        <Icon name="List" size={14} /> Order List
                                    </button>
                                    <button type="button"
                                        onClick={() => setIsStyleModalOpen(true)}
                                        className="p-1.5 rounded-full bg-app-surface text-app-text-muted shadow-sm hover:bg-app-surface-2 border border-app-border transition-colors"
                                    >
                                        <Icon name="Edit" size={14} />
                                    </button>
                                </div>
                            </div>
                            <div className="p-5 flex-1 flex flex-col">
                                <div className="text-xl font-bold text-app-text mb-2">{party.styleInfo || 'No style selected'}</div>
                                <div className="text-sm font-semibold text-app-text-muted mb-4">{party.priceInfo || 'Price pending'}</div>

                                <h4 className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider mb-2">Accessories</h4>
                                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center text-xs">
                                    {party.accessories && Object.entries(party.accessories).map(([key, val]) => (
                                        <div key={key} className="bg-navy-50 rounded p-2 border border-navy-100">
                                            <div className="font-bold text-sm text-app-text">{val || '-'}</div>
                                            <div className="text-[9px] text-app-text-muted uppercase mt-0.5">{key}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        {/* Notes */}
                        <div className="bg-amber-50 rounded-lg border border-amber-200 p-5 lg:col-span-1 shadow-sm hover:shadow-md relative group transition-all duration-300">
                            <div className="flex justify-between items-start mb-3">
                                <h3 className="text-xs font-bold text-amber-800 uppercase flex items-center gap-2">
                                    <Icon name="Info" size={14} /> Important Notes
                                </h3>
                                <button type="button"
                                    onClick={() => setIsNotesModalOpen(true)}
                                    className="p-1.5 rounded-full bg-app-surface text-amber-600 shadow-sm hover:bg-amber-100 border border-amber-200 transition-colors"
                                >
                                    <Icon name="Edit" size={14} />
                                </button>
                            </div>
                            <div className="max-h-32 overflow-y-auto custom-scrollbar pr-2">
                                {parsedNotes ? (
                                    <div className="space-y-2">
                                        {parsedNotes.map(note => (
                                            <div key={note.id} className="text-xs border-l-2 border-gold-300 pl-2">
                                                <div className="text-[9px] text-app-text-muted font-bold uppercase mb-0.5">{formatDate(note.date)}</div>
                                                <div className="text-amber-900/80 whitespace-pre-wrap">{note.text}</div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-sm text-amber-900/80 leading-relaxed italic whitespace-pre-line">
                                        {party.notes || "No specific notes recorded for this party."}
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Progress */}
                    <div className="bg-app-surface rounded-lg shadow-sm border border-app-border overflow-hidden transition-colors">
                        <div className="bg-app-surface-2 px-4 py-2 border-b border-app-border flex justify-between items-center">
                            <h3 className="text-xs font-bold text-app-text uppercase tracking-wide">Party Progress & Status</h3>
                            <div className="text-xs font-semibold text-app-text-muted">{stats.total} Members</div>
                        </div>
                        <div className="p-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
                            <div className="lg:col-span-2">
                                <h3 className="text-xs font-bold text-app-text uppercase tracking-wide mb-3">Party Status Overview</h3>
                                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                                    <div className="text-center bg-red-50 p-4 rounded-lg border border-red-200 shadow-sm hover:shadow-md transition-shadow">
                                        <div className="text-3xl font-bold text-red-700">{stats.needsAppointment}</div>
                                        <div className="text-xs text-red-700 font-bold uppercase mt-1">Needs Meas.</div>
                                    </div>
                                    <div className="text-center bg-amber-50 p-4 rounded-lg border border-amber-200 shadow-sm hover:shadow-md transition-shadow">
                                        <div className="text-3xl font-bold text-amber-700">{stats.needsOrdering}</div>
                                        <div className="text-xs text-amber-700 font-bold uppercase mt-1">Needs Order</div>
                                    </div>
                                    <div className="text-center bg-blue-50 p-4 rounded-lg border border-blue-200 shadow-sm hover:shadow-md transition-shadow">
                                        <div className="text-3xl font-bold text-blue-700">{stats.needsReceiving}</div>
                                        <div className="text-xs text-blue-700 font-bold uppercase mt-1">Needs Receive</div>
                                    </div>
                                    <div className="text-center bg-gold-100 p-4 rounded-lg border border-gold-200 shadow-sm hover:shadow-md transition-shadow">
                                        <div className="text-3xl font-bold text-gold-600">{stats.needsFitting}</div>
                                        <div className="text-xs text-gold-600 font-bold uppercase mt-1">Ready for Fit</div>
                                    </div>
                                    <div className="text-center bg-navy-100 p-4 rounded-lg border border-navy-200 shadow-sm hover:shadow-md transition-shadow">
                                        <div className="text-3xl font-bold text-app-text">{stats.needsPickup}</div>
                                        <div className="text-xs text-app-text font-bold uppercase mt-1">Needs Pickup</div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2 lg:col-span-1 flex flex-col justify-center">
                                <h4 className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider mb-1">Completion Progress</h4>
                                {[{ label: 'Measured', count: stats.measuredCount, color: 'bg-blue-500' },
                                { label: 'Ordered', count: stats.orderedCount, color: 'bg-amber-500' },
                                { label: 'Received', count: stats.receivedCount, color: 'bg-blue-700' },
                                { label: 'Fitted', count: stats.fittedCount, color: 'bg-gold-500' },
                                { label: 'Picked Up', count: stats.pickedUpCount, color: 'bg-green-500' }
                                ].map((item, i) => (
                                    <div key={i}>
                                        <div className="flex justify-between items-center mb-0.5">
                                            <span className="text-xs font-medium text-app-text">{item.label}</span>
                                            <span className="text-xs font-bold text-app-text">{item.count} / {stats.total}</span>
                                        </div>
                                        <div className="w-full bg-app-surface-2 rounded-full h-1">
                                            <div
                                              className={`${item.color} h-1 rounded-full shadow-sm transition-all duration-500`}
                                              style={{ inlineSize: `${stats.total ? (item.count / stats.total) * 100 : 0}%` }}
                                            ></div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Members Table */}
                    <div className="bg-app-surface shadow-md border border-app-border rounded-lg overflow-hidden transition-colors">
                        <div className="bg-app-surface-2 px-4 py-3 border-b border-app-border flex justify-between items-center">
                            <h3 className="text-sm font-bold text-app-text uppercase tracking-wide flex items-center gap-2">
                                <Icon name="Ruler" size={16} className="text-gold-600" /> Member Details
                            </h3>
                            <div className="flex items-center gap-4">
                                <div className="flex p-1 bg-app-border/50/50 rounded-lg mr-2">
                                    <button type="button"
                                        onClick={() => setViewMode('list')}
                                        className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${viewMode === 'list' ? 'bg-app-surface shadow-sm text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                                    >
                                        Member List
                                    </button>
                                    <button type="button"
                                        onClick={() => setViewMode('review')}
                                        className={`px-3 py-1 text-[10px] font-bold uppercase rounded-md transition-all ${viewMode === 'review' ? 'bg-app-surface shadow-sm text-app-text' : 'text-app-text-muted hover:text-app-text'}`}
                                    >
                                        Order Review
                                    </button>
                                </div>
                                <button type="button"
                                    onClick={() => setIsChangeSalespersonModalOpen(true)}
                                    className="flex items-center gap-1.5 px-3 py-2 bg-app-surface text-app-text font-bold rounded-lg border-2 border-app-border hover:border-app-border hover:bg-app-surface-2 transition-all text-xs active:scale-95 shadow-sm"
                                >
                                    <Icon name="User" size={14} /> Salesperson
                                </button>
                                {!legacyIndividual && (
                                    <button type="button"
                                        onClick={() => handleAddMember(party.id)}
                                        className="text-xs font-black text-white bg-gold-600 border-2 border-gold-700 px-4 py-2 rounded-lg transition-all flex items-center gap-2 shadow-md shadow-gold-500/20 active:scale-95 uppercase tracking-wider"
                                    >
                                        <Icon name="Plus" size={14} /> Add Member
                                    </button>
                                )}
                            </div>
                        </div>

                        {viewMode === 'list' ? (
                            <>
                                {/* Mobile View */}
                                <MemberListMobile
                                    members={party.members || []}
                                    partyId={party.id}
                                    paymentStatusByMemberId={paymentStatusByMemberId}
                                    onMemberClick={handleMemberClick}
                                    onUpdateMember={handleUpdateMember}
                                    toggleStatus={toggleStatus}
                                    onAppointmentClick={(member) => setMemberForAppointments(member)}
                                />

                                {/* Desktop View */}
                                <MemberListDesktop
                                    members={party.members || []}
                                    partyId={party.id}
                                    paymentStatusByMemberId={paymentStatusByMemberId}
                                    onMemberClick={handleMemberClick}
                                    onUpdateMember={handleUpdateMember}
                                    toggleStatus={toggleStatus}
                                    onAppointmentClick={(member) => setMemberForAppointments(member)}
                                />
                            </>
                        ) : (
                            <OrderReviewTab
                                members={party.members || []}
                                partyId={party.id}
                                paymentStatusByMemberId={paymentStatusByMemberId}
                                toggleStatus={toggleStatus}
                                onMemberClick={handleMemberClick}
                            />
                        )}
                    </div>

                </div>
            </div>
        </div>
    );
};

export default PartyDetail;
