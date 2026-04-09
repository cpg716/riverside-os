import React from 'react';
import { formatDate } from '../lib/utils';
import Icon from './Icon';

const PrintPartyView = ({ party, onCancel }) => {
    // Calculate stats
    const total = party.members.length;
    const measuredCount = party.members.filter(m => m.measured).length;
    const orderedCount = party.members.filter(m => m.ordered).length;
    const receivedCount = party.members.filter(m => m.received).length;
    const fittedCount = party.members.filter(m => m.fitting).length;
    const pickedUpCount = party.members.filter(m => m.pickup).length;

    // Find Groom Name
    const groomMember = party.members.find(m => m.role === 'Groom');
    const groomName = groomMember ? groomMember.name : party.name;

    // Parse Notes
    let parsedNotes = null;
    try {
        const parsed = JSON.parse(party.notes);
        if (Array.isArray(parsed)) parsedNotes = parsed;
    } catch (e) {
        // Legacy string
    }

    // Calculate Content Score for Density
    let score = total;

    // Weight for member notes (approx 0.25 "member-equivalent" per note)
    const membersWithNotes = party.members.filter(m => m.notes && m.notes.length > 0).length;
    score += (membersWithNotes * 0.25);

    // Weight for important/footer notes
    if (parsedNotes) {
        // Bullet points: approx 0.5 "member-equivalent" per bullet
        score += (parsedNotes.length * 0.5);
    } else if (party.notes) {
        // Raw text: approx 0.5 per line or per 100 chars
        const lines = party.notes.split('\n').length;
        const lengthFactor = party.notes.length / 100;
        score += Math.max(lines, lengthFactor) * 0.5;
    }

    // Determine Density based on Content Score
    let density = 'spacious';
    if (score >= 35) density = 'ultra-compact';
    else if (score >= 20) density = 'compact';
    else if (score >= 12.5) density = 'balanced';
    else if (score >= 7) density = 'standard';

    // Config for densities
    const config = {
        spacious: {
            margin: '0.4in',
            zoom: 1,
            titleSize: 'text-3xl',
            salespersonSize: 'text-xl',
            gridGap: 'gap-4',
            sectionGap: 'mb-6',
            boxPadding: 'p-3',
            tableHeaderPy: 'py-2',
            tableBodyPy: 'py-2',
            baseText: 'text-sm',
            smallText: 'text-xs',
            label: 'Spacious Layout'
        },
        standard: {
            margin: '0.25in',
            zoom: 0.92,
            titleSize: 'text-2xl',
            salespersonSize: 'text-lg',
            gridGap: 'gap-4',
            sectionGap: 'mb-4',
            boxPadding: 'p-2',
            tableHeaderPy: 'py-1',
            tableBodyPy: 'py-1',
            baseText: 'text-xs',
            smallText: 'text-[10px]',
            label: 'Standard Layout'
        },
        balanced: {
            margin: '0.2in',
            zoom: 0.88,
            titleSize: 'text-xl',
            salespersonSize: 'text-lg',
            gridGap: 'gap-3',
            sectionGap: 'mb-3',
            boxPadding: 'p-1.5',
            tableHeaderPy: 'py-[3px]',
            tableBodyPy: 'py-[2px]',
            baseText: 'text-[11px]',
            smallText: 'text-[9px]',
            label: 'Balanced Layout'
        },
        compact: {
            margin: '0.1in',
            zoom: 0.75,
            titleSize: 'text-xl',
            salespersonSize: 'text-base',
            gridGap: 'gap-2',
            sectionGap: 'mb-2',
            boxPadding: 'p-1.5',
            tableHeaderPy: 'py-0.5',
            tableBodyPy: 'py-0.5',
            baseText: 'text-[10px]',
            smallText: 'text-[9px]',
            label: 'Compact Layout'
        },
        'ultra-compact': {
            margin: '0.05in',
            zoom: 0.65,
            titleSize: 'text-lg',
            salespersonSize: 'text-sm',
            gridGap: 'gap-1',
            sectionGap: 'mb-1',
            boxPadding: 'p-1',
            tableHeaderPy: 'py-0',
            tableBodyPy: 'py-0',
            baseText: 'text-[9px]',
            smallText: 'text-[9px]',
            label: 'Ultra-Compact'
        }
    };

    const s = config[density];

    // Compact date formatter for print
    const formatPrintDate = (dateString) => {
        if (!dateString) return '-';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '-';
        return date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
    };

    return (
        <div className={`min-h-screen bg-app-surface text-black font-sans box-border`}>
            {/* Dynamic CSS for print margins/zoom */}
            <style>{`
                @media print {
                    /* FORCE LANDSCAPE AND ZERO MARGINS */
                    @page { 
                        size: landscape; 
                        margin: 0mm !important; 
                    }
                    
                    html, body {
                        margin: 0 !important;
                        padding: 0 !important;
                        width: 100% !important;
                        height: 100% !important;
                        overflow: hidden !important;
                        -webkit-print-color-adjust: exact; 
                        print-color-adjust: exact; 
                    }

                    /* Wrapper to simulate margins manually and prevent overflow */
                    .print-page-wrapper {
                        padding: ${s.margin} !important;
                        width: 100% !important;
                        height: 100% !important;
                        max-height: 100vh !important;
                        box-sizing: border-box !important;
                        page-break-after: avoid !important;
                        page-break-before: avoid !important;
                        overflow: hidden !important;
                    }

                    .print-hidden { display: none !important; }
                    
                    /* Zoom Application */
                    .print-zoom { 
                        zoom: ${s.zoom} !important; 
                    }
                    
                    /* Table fixes to ensure it doesn't break pages */
                    table { page-break-inside: auto; }
                    tr { page-break-inside: avoid; page-break-after: auto; }
                    thead { display: table-header-group; }
                    tfoot { display: table-footer-group; }
                    
                    /* Fallback for browsers that don't support zoom well in print */
                    @supports not (zoom: 1) {
                         .print-zoom { transform: scale(${s.zoom}); transform-origin: top left; width: ${100 / s.zoom}%; }
                    }
                }
                /* Apply zoom on screen too for preview fidelity */
                .print-preview-zoom { 
                    transform: scale(${s.zoom}); 
                    transform-origin: top left; 
                    width: ${100 / s.zoom}%;
                    margin-bottom: 20px;
                }
            `}</style>

            {/* Scale wrapper for preview consistency */}
            <div className={`print-zoom print-preview-zoom md:p-0 print-page-wrapper`}>

                {/* Print-only controls */}
                <div className="print-hidden mb-4 flex justify-between items-center bg-app-surface-2 p-3 rounded border border-app-border shadow-sm w-full">
                    <button type="button" onClick={onCancel} className="flex items-center gap-2 px-3 py-1 text-app-text hover:text-app-text font-bold transition-colors text-sm">
                        <Icon name="ArrowLeft" size={16} /> Back
                    </button>
                    <div className="flex items-center gap-4">
                        <span className="text-xs text-app-text-muted hidden sm:inline">
                            Landscape Mode Recommended • {s.label} (Score: {score.toFixed(1)})
                        </span>
                        <button type="button" onClick={() => window.print()} className="flex items-center gap-2 bg-navy-900 text-white px-4 py-2 rounded font-bold hover:bg-navy-800 transition-colors shadow-md text-sm">
                            <Icon name="Printer" size={16} /> Print Now
                        </button>
                    </div>
                </div>

                {/* Header */}
                <div className={`flex justify-between items-end border-b-2 border-black pb-2 ${s.sectionGap}`}>
                    <div>
                        <h1 className={`${s.titleSize} font-black uppercase tracking-tight leading-none`}>{party.name} Wedding</h1>
                        <div className={`${s.baseText} font-medium flex items-center gap-3 text-gray-600 mt-1`}>
                            <span>{formatDate(party.date)}</span>
                            <span>|</span>
                            <span>ID: {party.id}</span>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className={`${s.smallText} font-bold uppercase tracking-wider text-gray-500`}>Salesperson</div>
                        <div className={`${s.salespersonSize} font-bold leading-none`}>{party.salesperson}</div>
                    </div>
                </div>

                {/* Info Grid: Stats | Contact | Style */}
                <div className={`grid grid-cols-12 ${s.gridGap} ${s.sectionGap}`}>
                    {/* Stats (3 cols) */}
                    <div className={`col-span-3 grid grid-cols-2 ${s.gridGap} content-start`}>
                        <div className={`${s.boxPadding} border border-gray-300 rounded text-center`}>
                            <div className={`${s.smallText} font-bold uppercase text-gray-500 leading-none`}>Members</div>
                            <div className={`${s.baseText} font-bold leading-none mt-0.5`}>{total}</div>
                        </div>
                        <div className={`${s.boxPadding} border border-gray-300 rounded text-center`}>
                            <div className={`${s.smallText} font-bold uppercase text-gray-500 leading-none`}>Measured</div>
                            <div className={`${s.baseText} font-bold leading-none mt-0.5`}>{measuredCount}/{total}</div>
                        </div>
                        <div className={`${s.boxPadding} border border-gray-300 rounded text-center`}>
                            <div className={`${s.smallText} font-bold uppercase text-gray-500 leading-none`}>Ordered</div>
                            <div className={`${s.baseText} font-bold leading-none mt-0.5`}>{orderedCount}/{total}</div>
                        </div>
                        <div className={`${s.boxPadding} border border-gray-300 rounded text-center`}>
                            <div className={`${s.smallText} font-bold uppercase text-gray-500 leading-none`}>Fitted</div>
                            <div className={`${s.baseText} font-bold leading-none mt-0.5`}>{fittedCount}/{total}</div>
                        </div>
                    </div>

                    {/* Contact (5 cols) */}
                    <div className={`col-span-5 grid grid-cols-2 ${s.gridGap} ${s.boxPadding} bg-gray-50 border border-gray-200 rounded ${s.baseText}`}>
                        <div className="overflow-hidden">
                            <h3 className={`font-bold uppercase border-b border-gray-300 pb-0.5 mb-1 ${s.smallText}`}>Groom</h3>
                            <p className="leading-tight truncate"><span className="font-medium">Name:</span> {groomName}</p>
                            <p className="leading-tight truncate"><span className="font-medium">Phone:</span> {party.groomPhone || '-'}</p>
                            <p className="leading-tight truncate"><span className="font-medium">Email:</span> {party.groomEmail || '-'}</p>
                        </div>
                        <div className="overflow-hidden">
                            <h3 className={`font-bold uppercase border-b border-gray-300 pb-0.5 mb-1 ${s.smallText}`}>Bride</h3>
                            <p className="leading-tight truncate"><span className="font-medium">Name:</span> {party.brideName || '-'}</p>
                            <p className="leading-tight truncate"><span className="font-medium">Phone:</span> {party.bridePhone || '-'}</p>
                            <p className="leading-tight truncate"><span className="font-medium">Email:</span> {party.brideEmail || '-'}</p>
                        </div>
                    </div>

                    {/* Style (4 cols) */}
                    <div className={`col-span-4 ${s.baseText}`}>
                        <div className="mb-1">
                            <span className="font-bold">Style:</span> {party.styleInfo || '-'}
                        </div>
                        <div className="mb-1">
                            <span className="font-bold">Price:</span> {party.priceInfo || '-'}
                        </div>
                        {party.accessories && (
                            <div className="grid grid-cols-3 gap-1">
                                {Object.entries(party.accessories).map(([key, val]) => {
                                    const labelMap = {
                                        vest: 'Vest',
                                        shirt: 'Shirt',
                                        ties: 'Tie',
                                        pocketSq: 'Pocket Sq',
                                        shoes: 'Shoes',
                                        socks: 'Socks',
                                        suspenders: 'Susp',
                                        cufflinks: 'Cuff',
                                        belt: 'Belt'
                                    };
                                    const label = labelMap[key] || key;
                                    return (
                                        <div key={key} className="border border-gray-200 p-0.5 rounded bg-app-surface">
                                            <span className={`block ${s.smallText} font-bold uppercase text-gray-500 leading-none`}>{label}</span>
                                            <span className={`font-medium truncate block leading-tight ${s.smallText}`} title={val}>{val || '-'}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Members Table */}
                <div className={`${s.sectionGap}`}>
                    <table className={`w-full ${s.baseText} border-collapse`}>
                        <thead>
                            <tr className="bg-gray-100 border-b border-gray-300">
                                <th className={`${s.tableHeaderPy} px-1 text-left border border-gray-300 w-[20%]`}>Member</th>

                                {/* Measurements */}
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[6%]`}>Coat</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[6%]`}>Waist</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[6%]`}>Vest</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[6%]`}>Shirt</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[6%]`}>Shoe</th>

                                {/* Status */}
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[10%]`}>Measured</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[10%]`}>Ordered</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[10%]`}>Received</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[10%]`}>Fitted</th>
                                <th className={`${s.tableHeaderPy} px-1 text-center border border-gray-300 w-[10%]`}>Picked Up</th>
                            </tr>
                        </thead>
                        <tbody>
                            {party.members.map((m, idx) => (
                                <tr key={m.id} className={idx % 2 === 0 ? 'bg-app-surface' : 'bg-gray-50'}>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 align-top`}>
                                        <div className="font-bold leading-tight">{m.name} {m.oot ? '(OOT)' : ''}</div>
                                        <div className={`${s.smallText} text-gray-600 italic leading-none`}>{m.role}</div>
                                        <div className={`${s.smallText} leading-none`}>{m.phone || '-'}</div>
                                        {m.notes && <div className="mt-0.5 text-[9px] italic leading-tight text-red-600">{m.notes}</div>}
                                    </td>

                                    {/* Measurements */}
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>{m.suit || '-'}</td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>{m.waist || '-'}</td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>{m.vest || '-'}</td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>{m.shirt || '-'}</td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>{m.shoe || '-'}</td>

                                    {/* Status */}
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>
                                        {m.measureDate ? formatPrintDate(m.measureDate) : (m.measured ? 'Yes' : '-')}
                                    </td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>
                                        {m.orderedDate ? formatPrintDate(m.orderedDate) : (m.ordered ? 'Yes' : '-')}
                                    </td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>
                                        {m.receivedDate ? formatPrintDate(m.receivedDate) : (m.received ? 'Yes' : '-')}
                                    </td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>
                                        {m.fittingDate ? formatPrintDate(m.fittingDate) : (m.fitting ? 'Yes' : '-')}
                                    </td>
                                    <td className={`${s.tableBodyPy} px-1 border border-gray-300 text-center align-middle`}>
                                        {m.pickupDate ? formatPrintDate(m.pickupDate) : (m.pickup ? (m.pickup === 'partial' ? 'Partial' : 'Yes') : '-')}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {/* Footer Notes */}
                {party.notes && (
                    <div className={`${s.smallText} border-t border-gray-300 pt-1`}>
                        <span className="font-bold uppercase mr-2 block mb-0.5">Important Notes:</span>
                        {parsedNotes ? (
                            <ul className="list-disc pl-4 space-y-0.5">
                                {parsedNotes.map(note => (
                                    <li key={note.id}>
                                        <span className="font-bold text-gray-500 mr-2">[{formatDate(note.date)}]</span>
                                        {note.text}
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <span className="font-mono whitespace-pre-wrap leading-tight">{party.notes}</span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default PrintPartyView;
