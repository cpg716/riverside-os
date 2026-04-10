import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { X, Calendar, Check, AlertTriangle, Trash, CheckCircle, Loader2 } from 'lucide-react';
import CustomerSearchInput from '../ui/CustomerSearchInput';
import { weddingApi, type RosCustomerSearchHit } from '../../lib/weddingApi';
import { type Appointment } from './SchedulerWorkspace';
import { useToast } from '../ui/ToastProviderLogic';
import { useBackofficeAuth } from '../../context/BackofficeAuthContextLogic';
import { mergedPosStaffHeaders } from '../../lib/posRegisterAuth';
import ConfirmationModal from '../ui/ConfirmationModal';

const APPT_CUSTOMER_SEARCH_PAGE = 40;
const apiBase = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  initialData?: Partial<Appointment> | null;
}

const AppointmentModal: React.FC<AppointmentModalProps> = ({ isOpen, onClose, onSave, initialData }) => {
  const [formData, setFormData] = useState({
    type: 'Measurement',
    date: new Date().toISOString().split('T')[0],
    time: '10:00',
    customerName: '',
    phone: '',
    notes: '',
    partyId: '',
    memberId: '',
    customerId: '',
    salesperson: '',
    status: 'Scheduled'
  });

  const [salespeople, setSalespeople] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  /** Offer optional wedding-member link after picking a customer who is on an active party (most ROS bookings stay general). */
  const [weddingLinkOffer, setWeddingLinkOffer] = useState<{
    memberId: string;
    partyId: string;
    partyLabel?: string;
  } | null>(null);
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const wmHeaders = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const [confirmStatus, setConfirmStatus] = useState<{ status: string, statusKey: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setScheduleWarning(null);
      return;
    }
    const sp = formData.salesperson.trim();
    if (!sp) {
      setScheduleWarning(null);
      return;
    }
    const iso = new Date(`${formData.date}T${formData.time}:00`).toISOString();
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const q = new URLSearchParams({ full_name: sp, starts_at: iso });
          const res = await fetch(`${apiBase}/api/staff/schedule/validate-booking?${q}`, {
            headers: wmHeaders,
          });
          if (res.ok) {
            setScheduleWarning(null);
            return;
          }
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          setScheduleWarning(typeof b.error === "string" ? b.error : null);
        } catch {
          setScheduleWarning(null);
        }
      })();
    }, 400);
    return () => window.clearTimeout(t);
  }, [isOpen, formData.salesperson, formData.date, formData.time, wmHeaders]);

  useEffect(() => {
    const fetchSalespeople = async () => {
      try {
        const data = await weddingApi.getSalespeople({ headers: wmHeaders });
        setSalespeople(data as string[]);
      } catch (err) {
        console.error("Failed to fetch salespeople:", err);
      }
    };
    if (isOpen) fetchSalespeople();
  }, [isOpen, wmHeaders]);

  useEffect(() => {
    if (isOpen && initialData) {
      let dateStr = new Date().toISOString().split('T')[0];
      let timeStr = '10:00';

      if (initialData.datetime) {
        const dt = new Date(initialData.datetime);
        if (!isNaN(dt.getTime())) {
          dateStr = dt.toISOString().split('T')[0];
          timeStr = dt.toTimeString().slice(0, 5);
        }
      }

      setFormData({
        type: initialData.type || 'Measurement',
        date: dateStr,
        time: timeStr,
        customerName: initialData.customerName || '',
        phone: initialData.phone || '',
        notes: initialData.notes || '',
        partyId: initialData.partyId || '',
        memberId: initialData.memberId || '',
        customerId: initialData.customerId || '',
        salesperson: initialData.salesperson || '',
        status: initialData.status || 'Scheduled'
      });
      setSearchTerm(initialData.customerName || '');
      setWeddingLinkOffer(null);
    } else if (isOpen) {
      setWeddingLinkOffer(null);
      setFormData({
        type: 'Measurement',
        date: new Date().toISOString().split('T')[0],
        time: '10:00',
        customerName: '',
        phone: '',
        notes: '',
        partyId: '',
        memberId: '',
        customerId: '',
        salesperson: '',
        status: 'Scheduled'
      });
      setSearchTerm('');
    }
  }, [initialData, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const datetime = `${formData.date}T${formData.time}:00`;

    try {
      if (initialData?.id) {
        await weddingApi.updateAppointment(
          initialData.id,
          {
            customerName: searchTerm,
            phone: formData.phone,
            type: formData.type,
            datetime,
            notes: formData.notes,
            status: formData.status,
            salesperson: formData.salesperson,
          },
          { headers: wmHeaders },
        );
      } else {
        await weddingApi.addAppointment(
          {
            memberId: formData.memberId || null,
            customerId: formData.customerId || null,
            datetime,
            customerName: searchTerm,
            phone: formData.phone,
            type: formData.type,
            notes: formData.notes,
            status: formData.status,
            salesperson: formData.salesperson,
          },
          { headers: wmHeaders },
        );
      }
      onSave();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save appointment.";
      toast(msg, "error");
    }
  };

  const handleStatusUpdate = async (status: string) => {
    if (!initialData?.id) return;
    
    // Original "Attended" Smart Status Syncing
    if (status === 'Attended' && formData.memberId) {
      let statusKey = '';
      if (formData.type === 'Measurement') statusKey = 'measured';
      else if (formData.type === 'Fitting') statusKey = 'fitting';
      else if (formData.type === 'Pickup') statusKey = 'pickup';

      if (statusKey) {
        setConfirmStatus({ status, statusKey });
        return; // Wait for confirmation
      }
    }

    await executeStatusUpdate(status);
  };

  const executeStatusUpdate = async (status: string, syncMember = false) => {
    if (!initialData?.id) return;

    if (syncMember && confirmStatus?.statusKey && formData.memberId) {
      try {
        await weddingApi.updateMember(
          formData.memberId,
          { [confirmStatus.statusKey]: true },
          { headers: wmHeaders },
        );
      } catch (err) {
        console.error("Member status sync failed:", err);
      }
    }

    try {
      await weddingApi.updateAppointment(
        initialData.id,
        {
          customerName: searchTerm,
          phone: formData.phone,
          type: formData.type,
          datetime: `${formData.date}T${formData.time}:00`,
          notes: formData.notes,
          status,
          salesperson: formData.salesperson,
        },
        { headers: wmHeaders },
      );
      onSave();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to update status";
      toast(msg, "error");
    } finally {
      setConfirmStatus(null);
    }
  };

  const handleDelete = () => {
    if (!initialData?.id) return;
    setConfirmDelete(true);
  };

  const executeDelete = async () => {
    if (!initialData?.id) return;
    try {
      await weddingApi.deleteAppointment(initialData.id, { headers: wmHeaders });
      toast("Appointment deleted", "success");
      onSave();
      onClose();
    } catch (err) {
      console.error("Delete failed:", err);
      toast("Failed to delete appointment", "error");
    } finally {
      setConfirmDelete(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-app-bg/80 backdrop-blur-md p-4 animate-in fade-in zoom-in duration-200">
      <div className="w-full max-w-2xl rounded-3xl border border-app-border bg-app-surface shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent text-white shadow-lg shadow-app-accent/20">
              <Calendar size={24} />
            </div>
            <div>
              <h3 className="text-xl font-black italic tracking-tighter text-app-text uppercase">
                {initialData ? 'Update Appointment' : 'Book Appointment'}
              </h3>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                Store calendar — measurements, fittings, events, and visits
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-full bg-app-surface-3 p-2 text-app-text-muted hover:bg-app-accent hover:text-white transition-all">
            <X size={20} />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto no-scrollbar p-8 space-y-8">
          
          <div className="grid grid-cols-2 gap-8">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Appointment Type</label>
              <div className="relative">
                <select
                  className="ui-input w-full cursor-pointer appearance-none py-3 pl-4 pr-10 text-sm font-bold"
                  value={formData.type}
                  onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                >
                  <option>Measurement</option>
                  <option>Fitting</option>
                  <option>Pickup</option>
                  <option>Consultation</option>
                  <option>Other</option>
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Start Time</label>
              <input
                type="time"
                className="ui-input w-full px-4 py-3 text-sm font-bold"
                value={formData.time}
                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-8">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Date</label>
              <input
                type="date"
                className="ui-input w-full px-4 py-3 text-sm font-bold"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Salesperson</label>
              <p className="text-[10px] text-app-text-muted -mt-1 mb-1">
                Floor staff (salesperson or sales support) from Staff settings. Must match a scheduled
                work day.
              </p>
              <select
                className="ui-input w-full cursor-pointer appearance-none px-4 py-3 pr-10 text-sm font-bold"
                value={formData.salesperson}
                onChange={(e) => setFormData({ ...formData, salesperson: e.target.value })}
              >
                <option value="">Any / Unassigned</option>
                {salespeople.map((sp) => (
                  <option key={sp} value={sp}>
                    {sp}
                  </option>
                ))}
              </select>
              {scheduleWarning ? (
                <p className="mt-2 text-xs font-semibold text-amber-700 dark:text-amber-300">
                  {scheduleWarning}
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2 relative">
            <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Customer</label>
            <p className="text-[10px] text-app-text-muted -mt-1 mb-1">
              Search your customer list, or type a name for a one-off visit.
            </p>
            <div className="relative group">
              <CustomerSearchInput 
                onSelect={(c) => {
                  setFormData({
                    ...formData,
                    customerName: `${c.first_name} ${c.last_name}`.trim(),
                    phone: c.phone ?? '',
                    partyId: '',
                    memberId: '',
                    customerId: c.id,
                  });
                  setSearchTerm(`${c.first_name} ${c.last_name}`.trim());
                  if (c.wedding_member_id && c.wedding_party_id) {
                    setWeddingLinkOffer({
                      memberId: c.wedding_member_id,
                      partyId: c.wedding_party_id,
                      partyLabel: c.wedding_party_name ?? undefined,
                    });
                  } else {
                    setWeddingLinkOffer(null);
                  }
                }}
                placeholder="Search customers…"
                className="w-full"
                defaultValue={searchTerm}
              />
              <div className="absolute right-10 top-1/2 -translate-y-1/2 flex items-center gap-2">
                {(formData.memberId || formData.customerId) && (
                  <span
                    className="inline-flex"
                    title={
                      formData.memberId
                        ? "Also linked to a wedding party record (optional workflow sync)"
                        : "Customer on file"
                    }
                  >
                    <CheckCircle size={18} className="text-emerald-500" />
                  </span>
                )}
              </div>
            </div>

            {weddingLinkOffer && !formData.memberId && formData.customerId && (
              <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-[11px] text-app-text-muted">
                <p className="font-semibold text-app-text">
                  Optional:{" "}
                  {weddingLinkOffer.partyLabel
                    ? `Link to wedding party “${weddingLinkOffer.partyLabel}”`
                    : "Link to their wedding party record"}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setFormData((f) => ({
                        ...f,
                        memberId: weddingLinkOffer.memberId,
                        partyId: weddingLinkOffer.partyId,
                      }));
                      setWeddingLinkOffer(null);
                    }}
                    className="rounded-lg bg-app-accent px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-white"
                  >
                    Link wedding party
                  </button>
                  <button
                    type="button"
                    onClick={() => setWeddingLinkOffer(null)}
                    className="rounded-lg border border-app-border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                  >
                    Not needed
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-8">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Contact Phone</label>
              <input
                type="tel"
                className="ui-input w-full px-4 py-3 text-sm font-bold"
                placeholder="(555) 555-5555"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Logistics Notes</label>
              <textarea
                className="ui-input w-full min-h-[5rem] resize-y px-4 py-3 text-sm font-bold"
                placeholder="Event details, sizes, reminders…"
                value={formData.notes}
                onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
              />
            </div>
          </div>
          
          {/* Status Actions for Editing */}
          {initialData?.id && (
            <div className="flex gap-3 pt-4 border-t border-app-border">
              <button
                type="button"
                onClick={() => handleStatusUpdate('Attended')}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-emerald-600/10 border border-emerald-500/30 py-3 text-[10px] font-black uppercase tracking-widest text-emerald-500 hover:bg-emerald-600 hover:text-white transition-all"
              >
                <CheckCircle size={14} /> Mark Attended
              </button>
              <button
                type="button"
                onClick={() => handleStatusUpdate('Missed')}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-amber-600/10 border border-amber-500/30 py-3 text-[10px] font-black uppercase tracking-widest text-amber-500 hover:bg-amber-600 hover:text-white transition-all"
              >
                <AlertTriangle size={14} /> Mark Missed
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="flex items-center justify-center gap-2 rounded-xl bg-red-600/10 border border-red-500/30 px-6 py-3 text-[10px] font-black uppercase tracking-widest text-red-500 hover:bg-red-600 hover:text-white transition-all"
              >
                <Trash size={14} />
              </button>
            </div>
          )}

          <div className="flex justify-end gap-4 pt-6 border-t border-app-border">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-app-text-muted hover:text-app-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-full bg-app-accent px-10 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/20 hover:scale-[1.02] active:scale-95 transition-all"
            >
              {initialData ? 'Update Schedule' : 'Create Appointment'}
            </button>
          </div>

        </form>

        {confirmStatus && (
          <ConfirmationModal
            isOpen={true}
            title="Sync Wedding Party Status"
            message={`This appointment is linked to a wedding party. Also mark this member as ${confirmStatus.statusKey.toUpperCase()} in Wedding Manager?`}
            confirmLabel="Sync & Mark Attended"
            cancelLabel="Just Mark Attended"
            onConfirm={() => executeStatusUpdate('Attended', true)}
            onClose={() => executeStatusUpdate('Attended', false)}
            variant="info"
          />
        )}

        {confirmDelete && (
          <ConfirmationModal
            isOpen={true}
            title="Delete Appointment"
            message="Are you sure you want to permanently delete this appointment? This action cannot be undone."
            confirmLabel="Delete Appointment"
            onConfirm={executeDelete}
            onClose={() => setConfirmDelete(false)}
            variant="danger"
          />
        )}
      </div>
    </div>
  );
};

export default AppointmentModal;
