import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { formatPhone } from '../lib/utils';
import { useModal } from '../hooks/useModal';

const AddPartyModal = ({ isOpen, onClose, onAdd }) => {
    if (!isOpen) return null;

    const { showAlert, selectSalesperson } = useModal();

    const [formData, setFormData] = useState({
        name: '',
        groomFirstName: '',
        date: '',
        signUpDate: new Date().toISOString().split('T')[0],
        salesperson: 'ROBYN',
        styleInfo: '',
        priceInfo: '',
        brideName: '',
        bridePhone: '',
        brideEmail: '',
        groomPhone: '',
        groomEmail: '',
        notes: '',
        accessories: {
            vest: '',
            shirt: '',
            shoes: '',
            ties: '',
            pocketSq: '',
            socks: '',
            suspenders: '',
            cufflinks: '',
            belt: ''
        },
        scheduleGroomMeasure: false
    });

    const [initialMembers, setInitialMembers] = useState([]);
    const [newMember, setNewMember] = useState({ name: '', role: 'Groomsman', phone: '', oot: false, suitOverride: '', customRole: '' });

    const [salespeople, setSalespeople] = useState([]);

    useEffect(() => {
        if (isOpen) {
            fetchSalespeople();
        }
    }, [isOpen]);

    const fetchSalespeople = async () => {
        try {
            const data = await api.getSalespeople();
            setSalespeople(data);
            if (Array.isArray(data) && data.length > 0) {
                setFormData((prev) => ({ ...prev, salesperson: prev.salesperson || data[0] }));
            }
        } catch (err) {
            console.error("Failed to fetch salespeople", err);
            setSalespeople(['ROBYN', 'JERROD', 'MARK', 'TOM']);
        }
    };

    const handlePhoneChange = (field, value) => {
        setFormData(prev => ({
            ...prev,
            [field]: formatPhone(value)
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        // Groom name construction: First + Last (Party Name)
        const groomName = formData.groomFirstName
            ? `${formData.groomFirstName} ${formData.name}`
            : `${formData.name} (Groom)`;

        const groom = {
            id: 1,
            name: groomName,
            role: 'Groom',
            phone: formData.groomPhone,
            oot: false, suit: '', waist: '', vest: '', shirt: '', shoe: '',
            measured: false, fitting: false, pickup: false, ordered: false, received: false,
            contactHistory: []
        };

        const addedMembers = initialMembers.map((m, idx) => ({
            ...m,
            id: idx + 2,
            ordered: false,
            received: false,
            contactHistory: []
        }));

        const fullMemberList = [groom, ...addedMembers];
        // Improved unique ID: LASTNAME-FIRSTNAME-YYYY-MM-DD
        const newPartyId = `${formData.name.toUpperCase()}-${formData.groomFirstName.toUpperCase()}-${formData.date}`;

        // Prompt for attribution (who is creating this party?)
        const createdBy = await selectSalesperson();
        if (!createdBy) return;

        // Pass full data object to App component for saving
        await onAdd({
            ...formData,
            id: newPartyId,
            members: fullMemberList,
            updatedBy: createdBy // Use updatedBy for backend logging
        });

        onClose();
    };

    const handleAddInitialMember = () => {
        if (!newMember.name) return;

        // Validation: Duplicate Name Check
        const isDuplicate = initialMembers.some(m => m.name.toUpperCase() === newMember.name.toUpperCase());
        if (isDuplicate) {
            showAlert(`A member named "${newMember.name}" is already in this party.`, "Duplicate Name", { variant: 'warning' });
            return;
        }

        const roleToSave = newMember.role === 'Other' ? (newMember.customRole || 'Member') : newMember.role;
        const notes = newMember.suitOverride ? `SUIT OPTION: ${newMember.suitOverride.toUpperCase()}` : '';

        setInitialMembers([...initialMembers, {
            ...newMember,
            role: roleToSave,
            suit: newMember.suitOverride.toUpperCase(), // Pre-fill suit field if override provided
            notes: notes,
            pinNote: newMember.suitOverride ? 1 : 0,
            waist: '', vest: '', shirt: '', shoe: '',
            measured: false, fitting: false, pickup: false, ordered: false, received: false
        }]);
        setNewMember({ name: '', role: 'Groomsman', phone: '', oot: false, suitOverride: '', customRole: '' });
    };

    const handleRemoveInitialMember = (indexToRemove) => {
        setInitialMembers(initialMembers.filter((_, index) => index !== indexToRemove));
    };

    const handleAccessoryChange = (key, val) => {
        setFormData(prev => ({
            ...prev,
            accessories: { ...prev.accessories, [key]: val }
        }));
    };

    const isPastDate = formData.date && new Date(formData.date) < new Date(new Date().setHours(0, 0, 0, 0));

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in overflow-y-auto">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-3xl overflow-hidden my-8 border border-app-border flex flex-col max-h-[95vh] transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text sticky top-0 z-10 shrink-0">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="ClipBoard" className="text-gold-500" /> New Wedding Party Form
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text">
                        <Icon name="X" size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
                    <div className="overflow-y-auto p-8 space-y-8 flex-1">

                        {/* Row 1: Basic Info */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Party Last Name</label>
                                <input required type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded hover:border-navy-700 focus:border-navy-900 outline-none transition-colors" placeholder="e.g. SMITH"
                                    value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value.toUpperCase() })} />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Groom First Name</label>
                                <input required type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded hover:border-navy-700 focus:border-navy-900 outline-none transition-colors" placeholder="e.g. JOHN"
                                    value={formData.groomFirstName} onChange={(e) => setFormData({ ...formData, groomFirstName: e.target.value.toUpperCase() })} />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Wedding Date</label>
                                <div className="relative">
                                    <input required type="date" className={`w-full px-4 py-2 border ${isPastDate ? 'border-amber-500 bg-amber-50' : 'border-app-border'} bg-app-surface text-app-text rounded outline-none transition-colors`}
                                        value={formData.date} onChange={(e) => setFormData({ ...formData, date: e.target.value })} />
                                    {isPastDate && (
                                        <div className="absolute top-10 left-0 right-0 z-20 bg-amber-600 text-white text-[10px] py-1 px-2 rounded shadow-lg flex items-center gap-1.5 animate-in slide-in-from-top-1">
                                            <Icon name="AlertTriangle" size={10} /> Careful: This date is in the past!
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Row 2: Contact Info */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-app-surface-2 p-6 rounded-lg border border-app-border overflow-visible">
                            <div className="space-y-4">
                                <h4 className="text-xs font-black text-app-text uppercase tracking-widest border-b border-app-border pb-2">Groom Contact</h4>
                                <div className="grid grid-cols-1 gap-4">
                                    <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none" placeholder="Groom Phone"
                                        value={formData.groomPhone} onChange={(e) => handlePhoneChange('groomPhone', e.target.value)} />
                                    <input type="email" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none" placeholder="Groom Email"
                                        value={formData.groomEmail} onChange={(e) => setFormData({ ...formData, groomEmail: e.target.value })} />
                                </div>
                            </div>
                            <div className="space-y-4">
                                <h4 className="text-xs font-black text-app-text uppercase tracking-widest border-b border-app-border pb-2">Bride Contact</h4>
                                <div className="grid grid-cols-1 gap-4">
                                    <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none" placeholder="Bride Name"
                                        value={formData.brideName} onChange={(e) => setFormData({ ...formData, brideName: e.target.value })} />
                                    <div className="grid grid-cols-2 gap-2">
                                        <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none text-sm" placeholder="Bride Phone"
                                            value={formData.bridePhone} onChange={(e) => handlePhoneChange('bridePhone', e.target.value)} />
                                        <input type="email" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none text-sm" placeholder="Bride Email"
                                            value={formData.brideEmail} onChange={(e) => setFormData({ ...formData, brideEmail: e.target.value })} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Row 3: Admin Info */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Salesperson</label>
                                <select
                                    className="w-full rounded border border-app-border bg-app-surface px-4 py-2 text-app-text outline-none"
                                    value={formData.salesperson}
                                    onChange={(e) => setFormData({ ...formData, salesperson: e.target.value })}
                                >
                                    {salespeople.map((p) => (
                                        <option key={p} value={p}>
                                            {p}
                                        </option>
                                    ))}
                                </select>
                                <p className="mt-1 text-[10px] text-app-text-muted">Managed in ROS (read-only list).</p>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Sign Up Date</label>
                                <input type="date" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none"
                                    value={formData.signUpDate} onChange={(e) => setFormData({ ...formData, signUpDate: e.target.value })} />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Price Info</label>
                                <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none" placeholder="e.g. REG $375 / SALE $260"
                                    value={formData.priceInfo} onChange={(e) => setFormData({ ...formData, priceInfo: e.target.value })} />
                            </div>
                        </div>

                        {/* Accessories Section */}
                        <div className="border-t border-app-border pt-6">
                            <h4 className="text-sm font-black text-app-text mb-4 flex items-center gap-2">
                                <Icon name="Tie" size={18} className="text-gold-500" /> Attire & Accessories
                            </h4>
                            <div className="grid grid-cols-1 gap-4 mb-6">
                                <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-1">Style Info (Suite/Tux)</label>
                                <input type="text" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none" placeholder="e.g. 40901-1 BLACK"
                                    value={formData.styleInfo} onChange={(e) => setFormData({ ...formData, styleInfo: e.target.value })} />
                            </div>
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                                {[
                                    { key: 'vest', label: 'Vest' },
                                    { key: 'shirt', label: 'Shirt' },
                                    { key: 'ties', label: 'Tie' },
                                    { key: 'pocketSq', label: 'Pocket Sq' },
                                    { key: 'shoes', label: 'Shoes' },
                                    { key: 'socks', label: 'Socks' },
                                    { key: 'suspenders', label: 'Suspenders' },
                                    { key: 'cufflinks', label: 'Cufflinks' },
                                    { key: 'belt', label: 'Belt' }
                                ].map(item => (
                                    <div key={item.key}>
                                        <label className="block text-[10px] text-app-text-muted mb-1 font-black uppercase">{item.label}</label>
                                        <input type="text" className="w-full px-3 py-1.5 text-xs border border-app-border bg-app-surface text-app-text rounded outline-none uppercase" placeholder="-"
                                            value={formData.accessories[item.key]} onChange={(e) => handleAccessoryChange(item.key, e.target.value)} />
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Initial Members Section */}
                        <div className="border-t border-app-border pt-6">
                            <h4 className="text-sm font-black text-app-text mb-4 flex items-center gap-2">
                                <Icon name="Users" size={18} className="text-gold-500" /> Add Party Members
                            </h4>
                            <div className="bg-app-surface-2 p-4 rounded-lg border border-app-border">
                                <div className="space-y-4">
                                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                                        <input type="text" className="sm:col-span-1 border border-app-border bg-app-surface text-app-text rounded px-3 py-2 text-sm" placeholder="Name"
                                            value={newMember.name} onChange={(e) => setNewMember({ ...newMember, name: e.target.value.toUpperCase() })} />
                                        <div className="flex flex-col gap-2">
                                            <select className="border border-app-border bg-app-surface text-app-text rounded px-3 py-2 text-sm font-bold"
                                                value={newMember.role} onChange={(e) => setNewMember({ ...newMember, role: e.target.value })}>
                                                <option>Groomsman</option>
                                                <option>Best Man</option>
                                                <option>Father</option>
                                                <option>Ring Bearer</option>
                                                <option>Usher</option>
                                                <option value="Other">Other...</option>
                                            </select>
                                            {newMember.role === 'Other' && (
                                                <input
                                                    type="text"
                                                    placeholder="Enter Role"
                                                    className="border border-app-border bg-app-surface text-app-text rounded px-3 py-1.5 text-xs animate-in slide-in-from-top-1"
                                                    value={newMember.customRole}
                                                    onChange={(e) => setNewMember({ ...newMember, customRole: e.target.value.toUpperCase() })}
                                                />
                                            )}
                                        </div>
                                        <input type="text" className="border border-app-border bg-app-surface text-app-text rounded px-3 py-2 text-sm" placeholder="Phone"
                                            value={newMember.phone} onChange={(e) => setNewMember({ ...newMember, phone: formatPhone(e.target.value) })} />
                                        <div className="flex items-center gap-2">
                                            <label className="text-xs text-app-text flex items-center gap-1 cursor-pointer flex-1">
                                                <input type="checkbox" checked={newMember.oot} onChange={(e) => setNewMember({ ...newMember, oot: e.target.checked })} className="rounded text-app-text" />
                                                OOT
                                            </label>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <div className="flex-1 flex items-center gap-2">
                                            <Icon name="Tie" size={14} className="text-app-text-muted" />
                                            <input
                                                type="text"
                                                placeholder="Suit / Color Override (Optional - e.g. TUX or BLUE SUIT)"
                                                className="flex-1 border border-app-border bg-app-surface text-app-text rounded px-3 py-2 text-xs"
                                                value={newMember.suitOverride}
                                                onChange={(e) => setNewMember({ ...newMember, suitOverride: e.target.value.toUpperCase() })}
                                            />
                                        </div>
                                        <button type="button" onClick={handleAddInitialMember} className="bg-navy-900 text-white px-8 py-2 rounded text-xs font-black hover:bg-navy-800 transition-colors shadow-lg active:scale-95">
                                            ADD MEMBER
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {initialMembers.length > 0 && (
                                <div className="mt-4 space-y-2">
                                    {initialMembers.map((m, i) => (
                                        <div key={i} className="flex justify-between items-center bg-app-surface px-4 py-2 border border-app-border rounded-md text-sm shadow-sm">
                                            <div className="flex items-center gap-3">
                                                <span className="font-bold text-app-text">{m.name}</span>
                                                <span className="text-[10px] text-app-text-muted font-bold uppercase py-0.5 px-2 bg-app-surface-2 rounded">{m.role}</span>
                                                {m.oot && <span className="text-[10px] text-amber-600 font-black uppercase">OOT</span>}
                                            </div>
                                            <div className="flex items-center gap-4">
                                                <span className="text-app-text-muted font-medium">{m.phone || '-'}</span>
                                                <button type="button" onClick={() => handleRemoveInitialMember(i)} className="text-red-500 hover:bg-red-50 p-1.5 rounded-full transition-colors">
                                                    <Icon name="Trash" size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Onboarding Hook Section */}
                        <div className="border-t border-app-border pt-6">
                            <div className="bg-navy-50 p-4 rounded-lg border border-navy-100 flex items-center gap-4">
                                <div className="p-3 bg-app-surface rounded-full shadow-sm text-app-text">
                                    <Icon name="Calendar" size={24} />
                                </div>
                                <div className="flex-1">
                                    <h5 className="text-sm font-bold text-app-text">Proactive Onboarding</h5>
                                    <p className="text-xs text-app-text-muted">Would you like to schedule the Groom's measurement appointment immediately after clicking save?</p>
                                </div>
                                <label className="flex items-center gap-3 cursor-pointer group">
                                    <span className="text-xs font-black text-app-text uppercase tracking-tight group-hover:text-gold-600">Schedule Now</span>
                                    <input
                                        type="checkbox"
                                        className="w-5 h-5 rounded border-app-border text-app-text focus:ring-navy-900"
                                        checked={formData.scheduleGroomMeasure}
                                        onChange={(e) => setFormData({ ...formData, scheduleGroomMeasure: e.target.checked })}
                                    />
                                </label>
                            </div>
                        </div>

                        {/* Internal Notes */}
                        <div>
                            <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Internal Notes</label>
                            <textarea rows="2" className="w-full px-4 py-2 border border-app-border bg-app-surface text-app-text rounded outline-none transition-colors"
                                placeholder="Add any specific details about color matching, alterations, etc."
                                value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })}></textarea>
                        </div>

                    </div>

                    {/* Footer Buttons */}
                    <div className="bg-app-surface-2 p-6 border-t border-app-border flex justify-end gap-4 shrink-0 transition-colors">
                        <button type="button" onClick={onClose} className="px-6 py-2 text-app-text hover:text-app-text font-bold transition-colors">Cancel</button>
                        <button type="submit" className="bg-navy-900 hover:bg-navy-800 text-white font-bold py-3 px-10 rounded-lg shadow-xl shadow-navy-900/20 transition-all hover:shadow-2xl hover:scale-105 active:scale-95 transform">
                            Complete Party File
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default AddPartyModal;
