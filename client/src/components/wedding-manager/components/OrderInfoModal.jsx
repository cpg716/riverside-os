import React, { useState } from 'react';
import Icon from './Icon';

const OrderInfoModal = ({ isOpen, onClose, onSave, memberName }) => {
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [po, setPo] = useState('');

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-app-text/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-app-surface rounded-3xl shadow-2xl w-full max-w-sm border border-app-border/80 overflow-hidden transform animate-in zoom-in-95 duration-200 text-app-text">
                <div className="p-8">
                    <div className="flex items-center gap-4 mb-8">
                        <div className="w-12 h-12 bg-amber-50 border border-amber-100 rounded-2xl flex items-center justify-center shadow-inner shadow-amber-200/20">
                            <Icon name="FileText" size={24} className="text-amber-500" />
                        </div>
                        <div>
                            <h3 className="text-xl font-black uppercase tracking-tight leading-none">Order Tracking</h3>
                            <p className="text-[10px] font-black uppercase text-app-text-muted mt-1.5 tracking-[0.1em]">{memberName}</p>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="group">
                            <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted mb-2 group-focus-within:text-gold-500 transition-colors">Order Date</label>
                            <div className="relative">
                                <Icon name="Calendar" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted pointer-events-none" />
                                <input
                                    type="date"
                                    className="w-full bg-app-surface-2 border border-transparent rounded-2xl pl-12 pr-4 py-4 text-sm font-bold focus:bg-app-surface focus:border-gold-500 outline-none transition-all"
                                    value={date}
                                    onChange={(e) => setDate(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="group">
                            <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted mb-2 group-focus-within:text-gold-500 transition-colors">PO Number</label>
                            <div className="relative">
                                <Icon name="Hash" size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted pointer-events-none" />
                                <input
                                    type="text"
                                    placeholder="ENTER PO# (OPTIONAL)"
                                    className="w-full bg-app-surface-2 border border-transparent rounded-2xl pl-12 pr-4 py-4 text-xs font-black uppercase tracking-widest placeholder:text-app-text-muted focus:bg-app-surface focus:border-gold-500 outline-none transition-all"
                                    value={po}
                                    onChange={(e) => setPo(e.target.value.toUpperCase())}
                                    autoFocus
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-8 grid grid-cols-2 gap-3">
                        <button type="button"
                            onClick={onClose}
                            className="py-4 bg-app-surface-2 text-app-text-muted rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-app-surface-2 transition-all active:scale-95"
                        >
                            Cancel
                        </button>
                        <button type="button"
                            onClick={() => onSave({ date, po })}
                            className="py-4 bg-navy-900 text-white rounded-2xl font-black uppercase tracking-widest text-[10px] hover:bg-black transition-all shadow-lg active:scale-95"
                        >
                            Confirm Order
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OrderInfoModal;
