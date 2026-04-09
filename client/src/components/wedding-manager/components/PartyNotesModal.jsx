import React, { useState, useEffect } from 'react';
import Icon from './Icon';
import { formatDate } from '../lib/utils';
import { useModal } from '../hooks/useModal';

const PartyNotesModal = ({ isOpen, onClose, notes, onSave }) => {

    const [noteList, setNoteList] = useState([]);
    const [newNoteText, setNewNoteText] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editText, setEditText] = useState('');

    useEffect(() => {
        if (isOpen) {
            try {
                // Try to parse as JSON array
                const parsed = JSON.parse(notes);
                if (Array.isArray(parsed)) {
                    setNoteList(parsed);
                } else {
                    // Valid JSON but not an array? Treat as legacy string
                    throw new Error("Not an array");
                }
            } catch (e) {
                // Fallback: Treat as legacy plain text
                if (notes && notes.trim().length > 0) {
                    setNoteList([{
                        id: Date.now(),
                        text: notes,
                        date: new Date().toISOString(),
                        isLegacy: true
                    }]);
                } else {
                    setNoteList([]);
                }
            }
        }
    }, [isOpen, notes]);

    const { selectSalesperson } = useModal();

    const handleAddNote = async () => {
        if (!newNoteText.trim()) return;

        const author = await selectSalesperson();
        if (!author) return;

        const newNote = {
            id: Date.now(),
            text: `${newNoteText} - ${author}`,
            date: new Date().toISOString()
        };
        const updatedList = [newNote, ...noteList];
        setNoteList(updatedList);
        setNewNoteText('');
    };

    const handleDeleteNote = (id) => {
        setNoteList(noteList.filter(n => n.id !== id));
    };

    const startEditing = (note) => {
        setEditingId(note.id);
        setEditText(note.text);
    };

    const saveEdit = () => {
        setNoteList(noteList.map(n => n.id === editingId ? { ...n, text: editText } : n));
        setEditingId(null);
        setEditText('');
    };

    const handleSaveAll = () => {
        // Serialize back to JSON string
        onSave(JSON.stringify(noteList));
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-app-text/40 backdrop-blur-[2px] animate-fade-in">
            <div className="bg-app-surface rounded-lg shadow-2xl w-full max-w-2xl overflow-hidden border border-app-border transition-colors flex flex-col max-h-[85vh]">
                <div className="bg-app-surface border-b border-app-border/80 p-4 flex justify-between items-center text-app-text shrink-0">
                    <h3 className="font-extrabold text-lg flex items-center gap-2 uppercase tracking-tight">
                        <Icon name="Edit" className="text-gold-500" /> Important Notes
                    </h3>
                    <button type="button" onClick={onClose} className="hover:bg-app-surface-2 p-2 rounded-full transition-colors text-app-text-muted hover:text-app-text touch-target">
                        <Icon name="X" size={24} />
                    </button>
                </div>

                <div className="p-6 flex flex-col flex-1 overflow-hidden">
                    {/* Add New Note */}
                    <div className="mb-6 shrink-0">
                        <label className="block text-xs font-bold text-app-text uppercase tracking-wide mb-2">Add New Note</label>
                        <div className="flex gap-2">
                            <textarea
                                className="w-full p-3 border border-app-border rounded-lg focus:ring-2 focus:ring-navy-900 focus:outline-none resize-none text-app-text bg-app-surface transition-colors h-20"
                                value={newNoteText}
                                onChange={(e) => setNewNoteText(e.target.value)}
                                placeholder="Type a new note here..."
                            ></textarea>
                            <button type="button"
                                onClick={handleAddNote}
                                disabled={!newNoteText.trim()}
                                className="px-4 bg-navy-900 text-white rounded-lg font-bold hover:bg-navy-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex flex-col items-center justify-center gap-1 min-w-[80px] shadow-md"
                            >
                                <Icon name="Plus" size={20} />
                                <span className="text-xs">ADD</span>
                            </button>
                        </div>
                    </div>

                    {/* Notes List */}
                    <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin">
                        {noteList.length === 0 ? (
                            <div className="text-center text-app-text-muted italic py-8 bg-app-surface-2 rounded-lg border border-dashed border-app-border">No notes added yet.</div>
                        ) : (
                            noteList.map(note => (
                                <div key={note.id} className="bg-app-surface-2 border border-app-border/80 rounded-lg p-4 group hover:border-app-border transition-all shadow-sm">
                                    <div className="flex justify-between items-start mb-2">
                                        <span className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider">
                                            {formatDate(note.date)} {note.isLegacy && '(Legacy)'}
                                        </span>
                                        <div className="flex gap-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                            {editingId === note.id ? (
                                                <button type="button" onClick={saveEdit} className="text-green-600 hover:bg-green-100 p-2 rounded-full touch-target transition-colors"><Icon name="Check" size={16} /></button>
                                            ) : (
                                                <button type="button" onClick={() => startEditing(note)} className="text-app-text-muted hover:text-app-text hover:bg-app-surface-2 p-2 rounded-full shadow-sm touch-target transition-colors"><Icon name="Edit" size={16} /></button>
                                            )}
                                            <button type="button" onClick={() => handleDeleteNote(note.id)} className="text-app-text-muted hover:text-red-600 hover:bg-app-surface-2 p-2 rounded-full shadow-sm touch-target transition-colors"><Icon name="Trash" size={16} /></button>
                                        </div>
                                    </div>

                                    {editingId === note.id ? (
                                        <textarea
                                            className="w-full p-2 border border-navy-300 rounded text-sm focus:ring-1 focus:ring-navy-900 outline-none"
                                            value={editText}
                                            onChange={(e) => setEditText(e.target.value)}
                                            autoFocus
                                        />
                                    ) : (
                                        <p className="text-sm text-app-text whitespace-pre-wrap leading-relaxed font-medium">{note.text}</p>
                                    )}
                                </div>
                            ))
                        )}
                    </div>

                    <div className="mt-4 flex justify-end gap-3 pt-4 border-t border-app-border/80 shrink-0">
                        <button type="button" onClick={onClose} className="px-6 py-3 text-app-text hover:bg-app-surface-2 rounded-lg font-bold transition-colors touch-target">Cancel</button>
                        <button type="button" onClick={handleSaveAll} className="px-8 py-3 bg-gold-500 hover:bg-gold-600 text-white rounded-lg font-black shadow-lg shadow-gold-100 transition-all active:scale-95 uppercase tracking-wider text-sm">Save Notes</button>
                    </div>
                </div>
            </div>
        </div>
    )
};

export default PartyNotesModal;
