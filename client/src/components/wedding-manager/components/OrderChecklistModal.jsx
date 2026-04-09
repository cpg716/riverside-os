import React, { useRef, useMemo } from 'react';
import Icon from './Icon';
import { formatDate } from '../lib/utils';
import { parseJSON } from '../lib/dataUtils';

const OrderChecklistModal = ({ isOpen, onClose, party }) => {
    const printRef = useRef();

    const members = useMemo(() => (party?.members || []).filter(m => m.role !== 'Info'), [party?.members]);
    const partyAcc = useMemo(() => parseJSON(party?.accessories), [party?.accessories]);

    // Calculate density to ensure one-page print
    const printScale = useMemo(() => {
        const memberCount = members.length;
        if (memberCount <= 6) return 1.0;
        if (memberCount <= 10) return 0.8;
        if (memberCount <= 15) return 0.65;
        return 0.5;
    }, [members]);

    if (!isOpen) return null;

    const handlePrint = () => {
        const printContent = printRef.current.innerHTML;

        const win = window.open('', '_blank');
        win.document.write(`
            <html>
                <head>
                    <title>Order Checklist - ${party.name}</title>
                    <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                    <style>
                        @media print {
                            @page { size: portrait; margin: 0.3in; }
                            body { 
                                -webkit-print-color-adjust: exact; 
                                font-family: sans-serif; 
                                font-size: 13px;
                                line-height: 1.2;
                                margin: 0;
                            }
                            .print-container {
                                transform: scale(${printScale});
                                transform-origin: top left;
                                width: ${100 / printScale}%;
                            }
                            .no-print { display: none !important; }
                        }
                        table { border-collapse: collapse; width: 100%; margin-bottom: 5px; }
                        th, td { border: 1px solid #cbd5e1; padding: 4px 10px; text-align: left; }
                        th { background-color: #f1f5f9; font-weight: 900; font-size: 11px; text-transform: uppercase; color: #1e293b; }
                        .item-row { font-size: 12px; }
                        .status-done { color: #059669; font-weight: 800; }
                        .status-pending { color: #94a3b8; font-style: italic; }
                        .member-box { border: 2px solid #e2e8f0; border-radius: 6px; overflow: hidden; margin-bottom: 12px; break-inside: avoid; }
                        .member-header { background-color: #f8fafc; padding: 6px 12px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
                    </style>
                </head>
                <body>
                    <div class="print-container">
                        ${printContent}
                    </div>
                    <script>
                        window.onload = function() { 
                            setTimeout(() => {
                                window.print(); 
                                window.close(); 
                            }, 500);
                        }
                    </script>
                </body>
            </html>
        `);
        win.document.close();
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-navy-900/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-app-surface rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden border border-app-border">
                {/* Header */}
                <div className="px-6 py-4 bg-app-surface-2 border-b border-app-border flex justify-between items-center">
                    <div>
                        <h2 className="text-xl font-bold text-app-text uppercase tracking-tight">Order Checklist: {party.name}</h2>
                        <p className="text-sm text-app-text-muted font-medium">
                            {formatDate(party.date)} • Rep: {party.salesperson || 'N/A'} • Style: {party.styleInfo || 'None'}
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <button type="button"
                            onClick={handlePrint}
                            className="flex items-center gap-2 bg-navy-900 text-white px-4 py-2 rounded-lg font-bold hover:bg-navy-800 transition-colors shadow-md text-sm"
                        >
                            <Icon name="Printer" size={18} /> Print Checklist
                        </button>
                        <button type="button" onClick={onClose} className="p-2 text-app-text-muted hover:text-app-text transition-colors">
                            <Icon name="X" size={24} />
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6" ref={printRef}>
                    <div className="mb-6 hidden print:block">
                        <div className="flex justify-between items-start border-b-4 border-navy-900 pb-3">
                            <div className="flex-1">
                                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted mb-1 block">Wedding Party Record</span>
                                <h1 className="text-3xl font-black uppercase text-app-text tracking-tighter leading-none mb-2">{party.name}</h1>
                                <div className="flex flex-wrap gap-x-6 gap-y-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[9px] font-black uppercase text-app-text-muted">Wedding Date</span>
                                        <span className="text-xs font-bold text-app-text">{formatDate(party.date)}</span>
                                    </div>
                                    <div className="flex items-center gap-2 border-l border-app-border pl-6">
                                        <span className="text-[9px] font-black uppercase text-app-text-muted">Salesperson</span>
                                        <span className="text-xs font-bold text-app-text">{party.salesperson || 'N/A'}</span>
                                    </div>
                                    <div className="flex items-center gap-2 border-l border-app-border pl-6">
                                        <span className="text-[9px] font-black uppercase text-app-text-muted">Style Info</span>
                                        <span className="text-xs font-bold text-app-text">{party.styleInfo || 'None Selected'}</span>
                                    </div>
                                </div>
                            </div>
                            <div className="text-right">
                                <div className="text-[9px] font-black uppercase leading-tight text-app-text-muted">
                                    Generated: {new Date().toLocaleDateString()}<br />
                                    {new Date().toLocaleTimeString()}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-2">
                        {members.length === 0 ? (
                            <div className="text-center py-20 text-app-text-muted italic">No members found for this party.</div>
                        ) : (
                            members.map(member => (
                                <div key={member.id} className="member-box border border-app-border rounded-lg overflow-hidden break-inside-avoid">
                                    <div className="member-header bg-app-surface-2 px-3 py-1 border-b border-app-border flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <span className="font-black text-app-text uppercase tracking-tighter text-xs">{member.name}</span>
                                            <span className="rounded border border-app-border bg-app-surface px-1.5 py-0.5 text-[9px] font-bold uppercase text-app-text-muted">{member.role}</span>
                                        </div>
                                        <div className="flex items-center gap-3 text-[9px] font-bold">
                                            <span className={member.measured ? 'text-emerald-600' : 'text-amber-500'}>
                                                MEASURED: {member.measured ? formatDate(member.measureDate) : 'PENDING'}
                                            </span>
                                            <span className={member.ordered ? 'text-emerald-600' : 'text-amber-500'}>
                                                ORDERED: {member.ordered ? formatDate(member.orderedDate) : 'PENDING'}
                                            </span>
                                        </div>
                                    </div>

                                    <table className="w-full text-[10px]">
                                        <thead>
                                            <tr>
                                                <th className="w-1/5">Item</th>
                                                <th className="w-3/5">Details & Measurements</th>
                                                <th className="w-1/5">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr className="item-row">
                                                <td className="font-bold text-app-text">Coat & Pant</td>
                                                <td>
                                                    {member.notes && member.notes.includes('SUIT OPTION:') ? (
                                                        <div className="font-black text-red-600 uppercase">
                                                            ★ {member.notes.split('SUIT OPTION:')[1].split('\n')[0].trim()}
                                                        </div>
                                                    ) : (
                                                        <div className="font-medium text-app-text">{party.styleInfo || 'No Style Selected'}</div>
                                                    )}
                                                    <div className="flex gap-4 mt-1 text-[11px]">
                                                        {member.suit && <span>Coat: <b className="text-app-text">{member.suit}</b></span>}
                                                        {member.waist && <span>Waist: <b className="text-app-text">{member.waist}</b></span>}
                                                    </div>
                                                </td>
                                                <td className={member.ordered ? 'status-done text-emerald-600' : 'status-pending text-app-text-muted font-bold italic'}>
                                                    {(() => {
                                                        const stockInfo = typeof member.stockInfo === 'string' ? JSON.parse(member.stockInfo || '{}') : (member.stockInfo || {});
                                                        if (stockInfo.suit === 'stock' || stockInfo.waist === 'stock') {
                                                            return <span className="text-emerald-600 font-black">★ IN STOCK</span>;
                                                        }
                                                        if (member.ordered) {
                                                            return (
                                                                <div className="flex flex-col">
                                                                    <span>✓ ORDERED</span>
                                                                    {member.orderedPO && <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400">PO: {member.orderedPO}</span>}
                                                                </div>
                                                            );
                                                        }
                                                        return '○ NEEDS ORDER';
                                                    })()}
                                                </td>
                                            </tr>
                                            {[
                                                { key: 'vest', label: 'Vest', size: member.vest },
                                                { key: 'shirt', label: 'Shirt', size: member.shirt },
                                                { key: 'ties', label: 'Tie', size: null },
                                                { key: 'shoes', label: 'Shoes', size: member.shoe },
                                                { key: 'pocketSq', label: 'Pocket Sq', size: null },
                                                { key: 'socks', label: 'Socks', size: null },
                                                { key: 'suspenders', label: 'Suspenders', size: null },
                                                { key: 'cufflinks', label: 'Cufflinks', size: null },
                                                { key: 'belt', label: 'Belt', size: null }
                                            ].map(item => {
                                                const description = partyAcc[item.key] || '-';
                                                if (description === '-' && !item.size) return null;

                                                return (
                                                    <tr key={item.key} className="item-row">
                                                        <td className="font-bold text-app-text">{item.label}</td>
                                                        <td>
                                                            <div className="font-medium">{description}</div>
                                                            {item.size && <div className="text-[11px] mt-0.5">Size: <b className="text-app-text">{item.size}</b></div>}
                                                        </td>
                                                        <td className={member.ordered ? 'status-done text-emerald-600' : 'status-pending text-app-text-muted font-bold italic'}>
                                                            {(() => {
                                                                const stockInfo = typeof member.stockInfo === 'string' ? JSON.parse(member.stockInfo || '{}') : (member.stockInfo || {});
                                                                const key = item.key === 'shoes' ? 'shoe' : item.key;
                                                                if (stockInfo[key] === 'stock') {
                                                                    return <span className="text-emerald-600 font-black">★ IN STOCK</span>;
                                                                }
                                                                if (member.ordered) {
                                                                    return (
                                                                        <div className="flex flex-col">
                                                                            <span>✓ ORDERED</span>
                                                                            {member.orderedPO && <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400">PO: {member.orderedPO}</span>}
                                                                        </div>
                                                                    );
                                                                }
                                                                return '○ NEEDS ORDER';
                                                            })()}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="mt-4 pt-4 border-t border-app-border text-[9px] text-app-text-muted uppercase font-black text-center tracking-widest hidden print:block">
                        Riverside Wedding Manager • Internal Ordering Document
                    </div>
                </div>

                {/* Footer */}
                <div className="px-6 py-4 bg-app-surface-2 border-t border-app-border flex justify-end">
                    <button type="button"
                        onClick={onClose}
                        className="px-6 py-2 bg-app-surface border border-app-border text-app-text rounded-lg font-bold hover:bg-app-surface-2 transition-colors shadow-sm"
                    >
                        Close
                    </button>
                </div>
            </div>
        </div>
    );
};

export default OrderChecklistModal;
