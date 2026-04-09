import React, { useState } from 'react';
import Icon from './Icon';

/** Match SheetJS-style serial dates for existing excelDateToJSDate(). */
function dateToExcelSerial(d) {
  const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return utc / 86400000 + 25569;
}

function normalizeCellValue(cell) {
  if (!cell) return undefined;
  const v = cell.value;
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return dateToExcelSerial(v);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) {
      return v.richText.map((t) => t.text).join('');
    }
    if (v.text !== undefined && v.hyperlink !== undefined) return v.text;
    if (v.formula !== undefined || v.sharedFormula !== undefined) {
      if (v.result !== undefined && v.result !== null) return v.result;
      if (v.text !== undefined) return v.text;
      return undefined;
    }
  }
  return v;
}

/** 2D array of raw cell values (0-based rows), similar to XLSX.utils.sheet_to_json(sheet, { header: 1 }). */
function worksheetToAoA(worksheet) {
  const last = worksheet.lastRow?.number ?? 0;
  if (last < 1) return [];
  const rows = [];
  for (let r = 1; r <= last; r++) {
    const row = worksheet.getRow(r);
    const arr = [];
    if (row.hasValues) {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        arr[colNumber - 1] = normalizeCellValue(cell);
      });
    }
    rows.push(arr);
  }
  return rows;
}

const ImportDataModal = ({ isOpen, onClose, onImport }) => {
    const [file, setFile] = useState(null);
    const [error, setError] = useState('');
    const [processing, setProcessing] = useState(false);
    const [importResult, setImportResult] = useState(null);

    // Reset state when closing
    React.useEffect(() => {
        if (!isOpen) {
            setFile(null);
            setError('');
            setProcessing(false);
            setImportResult(null);
        }
    }, [isOpen]);

    // Load exceljs only when the import modal is open (separate chunk; warms cache before "Import Data")
    React.useEffect(() => {
        if (!isOpen) return;
        void import('exceljs');
    }, [isOpen]);

    const handleFileChange = (e) => {
        setFile(e.target.files[0]);
        setError('');
    };

    const processFile = () => {
        if (!file) {
            setError("Please select a file first.");
            return;
        }

        setProcessing(true);

        const name = (file.name || '').toLowerCase();
        if (!name.endsWith('.xlsx')) {
            setError('Please use an Excel .xlsx file (Save As → Excel Workbook).');
            setProcessing(false);
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const { default: ExcelJS } = await import('exceljs');
                const buffer = e.target.result;
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(buffer);
                await processWorkbook(workbook);
            } catch (err) {
                console.error("Error reading file:", err);
                setError("Failed to parse file. Please ensure it is a valid Excel .xlsx file.");
                setProcessing(false);
            }
        };
        reader.onerror = () => {
            setError("Error reading file.");
            setProcessing(false);
        };
        reader.readAsArrayBuffer(file);
    };

    const excelDateToJSDate = (serial) => {
        if (!serial || isNaN(serial)) return "";
        // Excel base date is Dec 30 1899
        const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
        // Adjust for timezone if needed, but usually we just want the date part
        // Adding 12 hours to avoid timezone shifting issues for pure dates
        date.setHours(date.getHours() + 12);
        return date.toISOString().split('T')[0];
    };

    const processWorkbook = async (workbook) => {
        const partiesFound = [];

        workbook.worksheets.forEach((worksheet) => {
            const sheetName = worksheet.name;
            if (sheetName === 'MASTER') return; // Skip Master template if it's just a template

            const rows = worksheetToAoA(worksheet);

            if (rows.length < 5) return; // Not enough data

            // Parse Header Info
            // Row 0: Party Name (A), Date (D), Salesperson (I)
            const row0 = rows[0] || [];
            const partyName = row0[0];
            const dateSerial = row0[3];
            const salesperson = row0[8];

            if (!partyName) return; // Skip if no name

            // Row 1: Sign Up Date (D), Style (H)
            const row1 = rows[1] || [];
            const signUpDateSerial = row1[3];
            const styleRef = row1[7]; // "40901-11 NEW BEIGE"

            // Row 2: Price (A), Style Code (H)
            const row2 = rows[2] || [];
            const priceInfo = row2[0];
            const styleCode = row2[7]; // "JBOND/2BV"

            // Construct Style Info
            const styleInfo = [styleRef, styleCode].filter(Boolean).join(' / ');

            const partyDate = typeof dateSerial === 'number' ? excelDateToJSDate(dateSerial) : (dateSerial || '');
            const signUpDate = typeof signUpDateSerial === 'number' ? excelDateToJSDate(signUpDateSerial) : (signUpDateSerial || '');

            const currentParty = {
                id: `${partyName.trim().toUpperCase()}-${partyDate.split('-')[0]}`, // Generate ID
                name: partyName.trim().toUpperCase(),
                date: partyDate,
                salesperson: salesperson || 'ROBYN',
                signUpDate: signUpDate,
                styleInfo: styleInfo,
                priceInfo: priceInfo || '',
                groomPhone: '',
                groomEmail: '',
                brideName: '',
                bridePhone: '',
                brideEmail: '',
                accessories: { shirt: 'ASK', shoes: '', ties: '', pocketSq: '', belt: '' },
                notes: '',
                members: []
            };

            // Parse Members starting at Row 5
            // Headers are at Row 4
            for (let i = 5; i < rows.length; i++) {
                const row = rows[i];
                const name = row[0];
                const phone = row[1];

                // --- METADATA & FOOTER CHECKS ---

                // Check if this is a Metadata/Footer row
                // Case 1: Row starts with a label (SHIRT, NOTES)
                if (name && typeof name === 'string') {
                    if (name.startsWith("SHIRT:")) {
                        currentParty.accessories.shirt = name.replace('SHIRT:', '').trim();
                        if (phone && typeof phone === 'string') currentParty.accessories.shoes = phone.replace('SHOES:', '').trim();
                        if (row[3] && typeof row[3] === 'string') currentParty.accessories.ties = row[3].replace('TIES:', '').trim();
                        continue;
                    }
                    if (name.startsWith("NOTES:")) {
                        currentParty.notes = name.replace('NOTES:', '').trim();
                        if (phone && typeof phone === 'string' && phone.includes("BRIDE NAME:")) {
                            currentParty.brideName = phone.replace('BRIDE NAME:', '').trim();
                        }
                        continue;
                    }
                }

                // Case 2: Row has data in Col 1 (Phone/Email) but maybe not Col 0
                if (phone && typeof phone === 'string') {
                    const phoneUpper = phone.toUpperCase();
                    if (phoneUpper.includes("BRIDE PHONE:")) {
                        currentParty.bridePhone = phone.replace(/BRIDE PHONE:/i, '').trim();
                        continue;
                    }
                    if (phoneUpper.includes("BRIDE EMAIL:")) {
                        currentParty.brideEmail = phone.replace(/BRIDE EMAIL:/i, '').trim();
                        continue;
                    }
                    if (phoneUpper.includes("BRIDE NAME:")) {
                        currentParty.brideName = phone.replace(/BRIDE NAME:/i, '').trim();
                        continue;
                    }
                }

                // --- INSTRUCTION / INFO ROW DETECTION ---
                // Check if the row is actually an instruction or note
                const nameUpper = name ? name.toString().toUpperCase() : '';
                const instructionKeywords = ['COLOR', 'SUIT', 'VEST', 'TIE', 'POCKET', 'BELT', 'SUSPENDER', 'NOTE', 'IMPORTANT', 'DIRECTIONS', 'PRICE', 'STYLE', 'OPTIONAL'];

                let isInfoRow = false;
                if (instructionKeywords.some(kw => nameUpper.startsWith(kw)) || nameUpper.includes("OPTIONS") || nameUpper.includes("ONLY")) {
                    isInfoRow = true;
                }

                // --- MEMBER PARSING ---

                // Skip if no name (and wasn't metadata)
                if (!name) continue;

                // OOT Detection
                let isOOT = false;
                let cleanName = name;
                if (typeof name === 'string') {
                    const ootKeywords = ['OOT', 'ROCH', 'SYR', 'BUFFALO', 'OUT OF TOWN', 'OUT-OF-TOWN'];
                    const upper = name.toUpperCase();

                    // Check if any keyword is present
                    if (ootKeywords.some(kw => upper.includes(kw))) {
                        isOOT = true;

                        // Remove keywords from name (case insensitive)
                        ootKeywords.forEach(kw => {
                            // Match word boundary or start/end of string, handle parens optionally
                            const regex = new RegExp(`\\(?\\b${kw}\\b\\)?`, 'gi');
                            cleanName = cleanName.replace(regex, '');
                        });

                        // Clean up extra spaces, commas, or empty parens
                        cleanName = cleanName
                            .replace(/\(\s*\)/g, '') // Empty parens
                            .replace(/,\s*$/, '') // Trailing comma
                            .replace(/^\s*,\s*/, '') // Leading comma
                            .replace(/\s+/g, ' ') // Multiple spaces
                            .trim();
                    }
                }

                // Role detection
                let role = 'Groomsman';
                if (isInfoRow) {
                    role = 'Info'; // Special role for instruction rows
                    cleanName = name; // Keep full text for info rows
                } else if (i === 5) {
                    role = 'Groom'; // First member is Groom
                } else if (typeof name === 'string') {
                    if (name.toUpperCase().includes('FATHER')) role = 'Father';
                    if (name.toUpperCase().includes('RING')) role = 'Ring Bearer';
                    if (name.toUpperCase().includes('USHER')) role = 'Usher';
                }

                // Groom Contact
                if (role === 'Groom') {
                    currentParty.groomPhone = phone || '';
                }

                // Measurements
                const suit = row[2];
                const waist = row[3];
                const vest = row[4];
                const shirt = row[5];
                // Col 6 is "P/ U" ?
                const shoe = row[7];

                const dateReceived = row[8];
                const fitting = row[9];
                const pickup = row[10];

                const measured = !!(suit || waist || vest || shirt);
                const received = !!dateReceived;
                const isFitted = !!fitting; // Checkmark or value
                const isPickedUp = !!pickup;

                currentParty.members.push({
                    id: currentParty.members.length + 1,
                    name: cleanName,
                    phone: phone || '',
                    role: role,
                    suit: suit || '',
                    waist: waist || '',
                    vest: vest || '',
                    shirt: shirt || '',
                    shoe: shoe || '',
                    measured: measured,
                    ordered: received, // Assumption
                    received: received,
                    fitting: isFitted,
                    pickup: isPickedUp,
                    contactHistory: [],
                    oot: isOOT
                });
            }
            partiesFound.push(currentParty);
        });

        console.log("Parties found:", partiesFound.length);
        if (partiesFound.length > 0) {
            try {
                console.log("Calling onImport...");
                const result = await onImport(partiesFound);
                console.log("onImport result:", result);
                const finalResult = result || { count: partiesFound.length };
                console.log("Setting importResult:", finalResult);
                setImportResult(finalResult);
                setProcessing(false);
            } catch (err) {
                console.error("onImport failed:", err);
                setProcessing(false);
                // Error is handled/alerted in parent, but we can show it here too if needed
                setError("Import failed. See console.");
            }
        } else {
            console.warn("No parties found");
            setError("No valid parties found in the Excel file.");
            setProcessing(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-md overflow-hidden border border-app-border transition-colors">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Upload" className="text-gold-500" /> Import Party Data
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text">
                        <Icon name="X" size={20} />
                    </button>
                </div>
                <div className="p-6 space-y-4">
                    {importResult ? (
                        <div className="text-center space-y-4">
                            <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto">
                                <Icon name="Check" size={32} />
                            </div>
                            <h4 className="text-xl font-bold text-app-text">Import Successful!</h4>

                            <div className="grid grid-cols-2 gap-4 bg-app-surface-2 p-4 rounded-lg border border-app-border">
                                <div className="text-center">
                                    <div className="text-2xl font-bold text-app-text">{importResult.added !== undefined ? importResult.added : (importResult.count || '-')}</div>
                                    <div className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Added</div>
                                </div>
                                <div className="text-center">
                                    <div className="text-2xl font-bold text-app-text">{importResult.updated !== undefined ? importResult.updated : '-'}</div>
                                    <div className="text-xs font-bold text-app-text-muted uppercase tracking-wider">Updated</div>
                                </div>
                            </div>

                            <button type="button"
                                onClick={onClose}
                                className="w-full py-3 bg-navy-900 hover:bg-navy-800 text-white rounded-lg font-bold shadow-md transition-colors"
                            >
                                Done
                            </button>
                        </div>
                    ) : (
                        <>
                            <p className="text-sm text-app-text">
                                Upload the <strong>Wedding Parties Excel (.xlsx)</strong> file. The app will import all parties found in the sheets.
                            </p>

                            <div className="border-2 border-dashed border-app-border rounded-lg p-8 text-center hover:bg-app-surface-2 transition-colors">
                                <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={handleFileChange} className="hidden" id="file-upload" />
                                <label htmlFor="file-upload" className="cursor-pointer flex flex-col items-center gap-2">
                                    <Icon name="Upload" size={32} className="text-app-text-muted" />
                                    <span className="text-app-text font-bold">{file ? file.name : "Click to Select File"}</span>
                                    <span className="text-xs text-app-text-muted">Supported: .xlsx only</span>
                                </label>
                            </div>

                            {error && <div className="text-red-600 text-sm font-medium bg-red-50 p-2 rounded">{error}</div>}

                            <div className="flex justify-end gap-3 pt-2">
                                <button type="button" onClick={onClose} className="px-4 py-2 text-app-text hover:bg-app-surface-2 rounded font-medium transition-colors">Cancel</button>
                                <button type="button"
                                    onClick={processFile}
                                    disabled={!file || processing}
                                    className={`px-6 py-2 bg-navy-900 hover:bg-navy-800 text-white rounded font-bold shadow-sm flex items-center gap-2 transition-colors ${(!file || processing) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                >
                                    {processing ? 'Processing...' : 'Import Data'}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ImportDataModal;
