import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { api } from '../lib/api';
import { useModal } from '../hooks/useModal';

const ManageSalespeopleModal = ({ isOpen, onClose, onUpdate }) => {
    const { showConfirm } = useModal();
    const [salespeople, setSalespeople] = useState([]);
    const [editingName, setEditingName] = useState(null);
    const [newName, setNewName] = useState(''); // For editing
    const [addName, setAddName] = useState(''); // For adding new

    useEffect(() => {
        if (isOpen) fetchSalespeople();
    }, [isOpen]);

    const fetchSalespeople = async () => {
        try {
            const data = await api.getSalespeople();
            setSalespeople(data);
        } catch (err) { console.error(err); }
    };

    const handleDelete = async (name) => {
        const confirmed = await showConfirm(`Delete ${name}? This will not remove their name from existing history logs.`, "Delete Staff", { variant: 'danger', confirmText: 'Delete' });
        if (!confirmed) return;
        try {
            await api.deleteSalesperson(name);
            fetchSalespeople();
            if (onUpdate) onUpdate();
        } catch (err) { console.error(err); }
    };

    const startEdit = (name) => {
        setEditingName(name);
        setNewName(name);
    };

    const handleSaveEdit = async () => {
        try {
            await api.updateSalesperson(editingName, newName);
            setEditingName(null);
            fetchSalespeople();
            if (onUpdate) onUpdate();
        } catch (err) { console.error(err); }
    };

    const handleAdd = async () => {
        if (!addName.trim()) return;
        try {
            await api.addSalesperson(addName);
            setAddName('');
            fetchSalespeople();
            if (onUpdate) onUpdate();
        } catch (err) { console.error(err); }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-navy-900/60 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-app-surface rounded-[2.5rem] shadow-[0_32px_80px_-16px_rgba(15,23,42,0.3)] w-full max-w-md overflow-hidden border border-app-border flex flex-col transform transition-all ring-1 ring-black/5">

                {/* Header */}
                <div className="px-8 pt-8 pb-6 border-b border-app-border/80 flex justify-between items-center bg-app-surface">
                    <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-app-surface-2 border border-app-border/80 rounded-2xl flex items-center justify-center shadow-sm">
                            <Icon name="Users" size={24} className="text-gold-500" />
                        </div>
                        <div>
                            <h3 className="text-app-text font-black text-2xl tracking-tight uppercase">Staff Gallery</h3>
                            <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest mt-1">Manage Salespeople & Roles</p>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} className="w-10 h-10 flex items-center justify-center hover:bg-app-surface-2 rounded-xl transition-all text-app-text-muted hover:text-app-text">
                        <Icon name="X" size={20} />
                    </button>
                </div>

                {/* List Content */}
                <div className="flex-1 overflow-y-auto p-8 space-y-4 max-h-[50vh] bg-app-surface-2/50 custom-scrollbar">
                    {salespeople.map(name => (
                        <div key={name} className="group flex items-center justify-between bg-app-surface p-4 rounded-2xl border border-app-border shadow-sm hover:border-gold-500/30 hover:shadow-md transition-all">
                            {editingName === name ? (
                                <div className="flex gap-2 w-full">
                                    <input
                                        value={newName}
                                        onChange={e => setNewName(e.target.value.toUpperCase())}
                                        className="w-full border-2 border-gold-500 rounded-xl px-4 py-2 text-sm font-black text-app-text outline-none shadow-inner"
                                        autoFocus
                                    />
                                    <button type="button" onClick={handleSaveEdit} className="w-10 h-10 bg-emerald-500 text-white flex items-center justify-center rounded-xl shadow-lg hover:bg-emerald-600 transition-colors"><Icon name="Check" size={18} /></button>
                                    <button type="button" onClick={() => setEditingName(null)} className="w-10 h-10 bg-red-100 text-red-500 flex items-center justify-center rounded-xl hover:bg-red-200 transition-colors"><Icon name="X" size={18} /></button>
                                </div>
                            ) : (
                                <>
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded-full bg-app-surface-2 border border-app-border flex items-center justify-center text-[10px] font-black text-app-text-muted">
                                            {name.charAt(0)}
                                        </div>
                                        <span className="font-black text-app-text tracking-tight">{name}</span>
                                    </div>
                                    <div className="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button type="button" onClick={() => startEdit(name)} className="w-9 h-9 flex items-center justify-center text-app-text-muted hover:text-app-text hover:bg-app-surface-2 rounded-xl transition-all"><Icon name="Edit" size={16} /></button>
                                        <button type="button" onClick={() => handleDelete(name)} className="w-9 h-9 flex items-center justify-center text-app-text-muted hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"><Icon name="Trash" size={16} /></button>
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                    {salespeople.length === 0 && (
                        <div className="text-center py-12 flex flex-col items-center gap-3">
                            <Icon name="Search" size={48} className="text-app-text-muted" />
                            <p className="text-app-text-muted font-bold uppercase text-[10px] tracking-widest">No staff registered</p>
                        </div>
                    )}
                </div>

                {/* Add New Section */}
                <div className="p-8 bg-app-surface border-t border-app-border/80">
                    <div className="flex gap-3">
                        <div className="relative flex-1">
                            <Icon name="Plus" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" />
                            <input
                                type="text"
                                placeholder="REGISTER NEW NAME..."
                                className="w-full pl-11 pr-4 py-4 bg-app-surface-2 border-2 border-transparent rounded-2xl text-sm font-black text-app-text placeholder:text-app-text-muted focus:bg-app-surface focus:border-gold-500 outline-none transition-all shadow-inner"
                                value={addName}
                                onChange={(e) => setAddName(e.target.value.toUpperCase())}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAdd();
                                }}
                            />
                        </div>
                        <button type="button"
                            onClick={handleAdd}
                            disabled={!addName}
                            className={`px-8 py-4 rounded-2xl font-black text-sm uppercase tracking-wider shadow-lg transition-all
                                ${addName
                                    ? 'bg-gold-500 text-white hover:bg-gold-600 hover:scale-[1.02] shadow-gold-500/20'
                                    : 'bg-app-surface-2 text-app-text-muted cursor-not-allowed'}`}
                        >
                            Register
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ManageSalespeopleModal;
