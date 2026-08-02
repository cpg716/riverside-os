import React, { useState } from 'react';
import Icon from './Icon';
import VariantSearchInput from '../../ui/VariantSearchInput';

import { useModal } from '../hooks/useModal';

const StyleEditModal = ({ isOpen, onClose, party, onSave }) => {
    const [localParty, setLocalParty] = useState(() => {
        const parsedAcc = typeof party.accessories === 'string'
            ? JSON.parse(party.accessories || '{}')
            : (party.accessories || {});

        return {
            ...party,
            accessories: parsedAcc
        };
    });

    const handleAccessoryChange = (key, val) => {
        setLocalParty(prev => ({
            ...prev,
            accessories: { ...prev.accessories, [key]: val }
        }));
    };

    const builderParentItems = Array.isArray(localParty.accessories?.builder_parent_items)
        ? localParty.accessories.builder_parent_items
        : [];

    const addBuilderParentItem = (variant) => {
        if (builderParentItems.some((item) => item.product_id === variant.product_id)) return;
        setLocalParty(prev => ({
            ...prev,
            accessories: {
                ...prev.accessories,
                builder_parent_items: [
                    ...(Array.isArray(prev.accessories?.builder_parent_items) ? prev.accessories.builder_parent_items : []),
                    {
                        product_id: variant.product_id,
                        variant_id: variant.variant_id,
                        product_name: variant.product_name,
                        sku: variant.sku
                    }
                ]
            }
        }));
    };

    const removeBuilderParentItem = (productId) => {
        setLocalParty(prev => ({
            ...prev,
            accessories: {
                ...prev.accessories,
                builder_parent_items: (prev.accessories?.builder_parent_items || [])
                    .filter((item) => item.product_id !== productId)
            }
        }));
    };


    const { selectSalesperson } = useModal();

    if (!isOpen) return null;

    const handleSave = async () => {
        const updatedBy = await selectSalesperson();
        if (!updatedBy) return;

        // We should probably log this change to the party notes or somewhere?
        // The user said "NOTES, Member Detail Contact History, and Activity Log".
        // Party-level changes don't have a "Contact History" per se, but they have "Important Notes".
        // Let's append a note to the Party Notes? Or just rely on Activity Log?
        // "The NAME of the user who did any changes should be listed in the NOTES..."
        // Let's assume Activity Log is sufficient for Party-level style changes, 
        // OR we can append to Party Notes if it's critical.
        // Given "Style & Pricing" is a specific section, maybe just the Activity Log is fine.
        // But to be safe and "perfect", let's pass `updatedBy` so the backend can log it properly.

        const { styleInfo, priceInfo, accessories, suit_variant_id } = localParty;

        onSave({
            styleInfo,
            priceInfo,
            accessories,
            suit_variant_id,
            updatedBy
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in overflow-y-auto">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-3xl overflow-hidden my-8 border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Tie" className="text-gold-500" /> Style & Order Details
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>
                <div className="p-6 space-y-6">

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                            <label className="text-xs font-bold text-app-text uppercase tracking-wide mb-2 flex justify-between items-center">
                                <span>Style Selection (Inventory Link)</span>
                                {localParty.suit_variant_id && (
                                    <span className="text-[10px] bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded font-black uppercase">Linked to SKUs</span>
                                )}
                            </label>
                            <div className="flex gap-2">
                                <VariantSearchInput 
                                    className="flex-1"
                                    placeholder="Search products by name or SKU to link style…"
                                    onSelect={(v) => {
                                        setLocalParty({
                                            ...localParty,
                                            styleInfo: `${v.product_name}${v.variation_label ? ` (${v.variation_label})` : ''}`,
                                            suit_variant_id: v.variant_id
                                        });
                                    }}
                                />
                                {localParty.suit_variant_id && (
                                    <button 
                                        type="button"
                                        onClick={() => setLocalParty({ ...localParty, suit_variant_id: null })}
                                        className="px-3 py-2 bg-app-surface border border-app-border text-app-text-muted hover:text-red-600 rounded text-xs font-bold transition-colors"
                                    >
                                        Unlink
                                    </button>
                                )}
                            </div>
                            <div className="mt-2 text-[10px] text-app-text-muted italic flex items-center gap-1">
                                <Icon name="Info" size={12} /> Search to link real inventory. Current: <span className="font-bold text-app-text">{localParty.styleInfo || "None"}</span>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs font-bold text-app-text uppercase tracking-wide mb-2 flex justify-between items-center">
                                <span>Manual Overide / Price Info</span>
                            </label>
                            <input type="text" className="w-full px-4 py-2 bg-app-surface border border-app-border rounded focus:ring-2 focus:ring-navy-900 outline-none transition-colors text-app-text"
                                value={localParty.priceInfo} onChange={(e) => setLocalParty({ ...localParty, priceInfo: e.target.value })} 
                                placeholder="e.g. $199.95 SPECIAL"
                            />
                        </div>
                    </div>

                    <div className="border-t border-app-border/80 pt-4">
                        <h4 className="text-sm font-bold text-app-text mb-2 flex items-center gap-2">
                            <span className="w-1 h-4 bg-app-accent rounded-full inline-block"></span> Wedding Builder parent items
                        </h4>
                        <p className="mb-3 text-xs text-app-text-muted">
                            Add the suit, shirt, tie, shoes, and other parent products that normally apply to the party. The Register Builder will show these for every member so staff choose that member&apos;s exact variation, skip the row, or search a different parent product.
                        </p>
                        <VariantSearchInput
                            placeholder="Search a parent product to add to every member checklist…"
                            onSelect={addBuilderParentItem}
                        />
                        {builderParentItems.length > 0 ? (
                            <div className="mt-3 grid gap-2 md:grid-cols-2">
                                {builderParentItems.map((item) => (
                                    <div key={item.product_id} className="flex items-center justify-between gap-2 rounded-lg border border-app-border bg-app-surface-2 px-3 py-2">
                                        <div className="min-w-0">
                                            <p className="truncate text-xs font-black text-app-text">{item.product_name}</p>
                                            <p className="truncate text-[10px] text-app-text-muted">Parent product · example SKU {item.sku}</p>
                                        </div>
                                        <button type="button" onClick={() => removeBuilderParentItem(item.product_id)} className="rounded border border-app-danger/30 px-2 py-1 text-[10px] font-black uppercase text-app-danger hover:bg-app-danger hover:text-white">Remove</button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="mt-2 text-xs font-semibold text-app-text-muted">No Builder parent items set yet.</p>
                        )}
                    </div>

                    <div className="border-t border-app-border/80 pt-4">
                        <h4 className="text-sm font-bold text-app-text mb-4 flex items-center gap-2">
                            <span className="w-1 h-4 bg-gold-500 rounded-full inline-block"></span> Accessories checklist
                        </h4>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
                            ].map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-xs text-app-text-muted mb-1 font-medium">{label}</label>
                                    <input
                                        type="text"
                                        className="w-full px-3 py-2 text-sm border border-app-border bg-app-surface text-app-text rounded focus:ring-2 focus:ring-navy-900 outline-none uppercase transition-colors"
                                        placeholder="-"
                                        value={(localParty.accessories && localParty.accessories[key]) || ''}
                                        onChange={(e) => handleAccessoryChange(key, e.target.value)}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
                <div className="bg-app-surface-2 p-6 border-t border-app-border/80 flex justify-end gap-3 transition-colors">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-app-text hover:bg-app-surface-2 rounded-lg font-bold transition-all min-h-[44px] active:scale-95">Cancel</button>
                    <button type="button" onClick={handleSave} className="px-6 py-2.5 bg-navy-900 hover:bg-navy-800 text-white rounded-lg font-bold shadow-lg transition-all active:scale-95 min-h-[44px]">Save Changes</button>
                </div>
            </div>
        </div>
    );
};

export default StyleEditModal;
