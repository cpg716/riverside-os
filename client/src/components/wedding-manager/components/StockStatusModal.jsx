import React from 'react';
import Icon from './Icon';

const StockStatusModal = ({ isOpen, onClose, itemName, onSelect }) => {
    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-app-text/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-app-surface rounded-3xl shadow-2xl w-full max-w-sm border border-app-border/80 overflow-hidden transform animate-in zoom-in-95 duration-200">
                <div className="p-8 text-center">
                    <div className="w-20 h-20 bg-gold-50 border border-gold-100 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-inner shadow-gold-200/50">
                        <Icon name="ClipboardList" size={36} className="text-gold-500" />
                    </div>
                    <h3 className="text-2xl font-black text-app-text uppercase tracking-tight mb-2">Inventory Check</h3>
                    <p className="text-app-text-muted text-sm font-medium leading-relaxed mb-8">
                        Is the <span className="text-app-text font-bold uppercase">{itemName}</span> size for this member currently in stock, or does it need to be ordered?
                    </p>

                    <div className="grid grid-cols-1 gap-3">
                        <button type="button"
                            onClick={() => onSelect('stock')}
                            className="w-full py-4 bg-navy-900 text-white rounded-2xl font-black uppercase tracking-widest text-xs hover:bg-black transition-all shadow-lg active:scale-95 flex items-center justify-center gap-2"
                        >
                            <Icon name="Box" size={16} /> Mark as IN STOCK
                        </button>
                        <button type="button"
                            onClick={() => onSelect('order')}
                            className="w-full py-4 bg-app-surface border border-app-border text-app-text-muted rounded-2xl font-black uppercase tracking-widest text-xs hover:border-gold-500 hover:text-gold-600 transition-all active:scale-95 flex items-center justify-center gap-2"
                        >
                            <Icon name="ShoppingCart" size={16} /> Needs to be ORDERED
                        </button>
                    </div>
                </div>

                <div className="bg-app-surface-2 px-8 py-4 flex justify-center border-t border-app-border/80">
                    <button type="button" onClick={onClose} className="text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-colors">
                        Cancel & Keep Current Status
                    </button>
                </div>
            </div>
        </div>
    );
};

export default StockStatusModal;
