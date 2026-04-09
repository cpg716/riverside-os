import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Printer, Plus, Clock, User, Trash, Scissors, Ruler, ShoppingBag } from 'lucide-react';
import { weddingApi } from '../../lib/weddingApi';
import AppointmentModal from './AppointmentModal';
import ConfirmationModal from '../ui/ConfirmationModal';
import { formatPhone } from '../../lib/utils.ts';
import { useBackofficeAuth } from '../../context/BackofficeAuthContextLogic';
import { mergedPosStaffHeaders } from '../../lib/posRegisterAuth';

// Helper for formatting dates to match original UX
const formatApptDate = (date: Date) => {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

export interface Appointment {
  id: string;
  datetime: string;
  status: string;
  type?: string;
  customer_name?: string | null; // Align with back-end if possible, or mapping
  customerName?: string | null;
  phone?: string | null;
  salesperson?: string | null;
  notes?: string | null;
  partyId?: string | null;
  memberId?: string | null;
  customerId?: string | null;
}

interface SchedulerWorkspaceProps {
  activeSection?: string;
}

const SchedulerWorkspace: React.FC<SchedulerWorkspaceProps> = () => {
  const { backofficeHeaders } = useBackofficeAuth();
  const wmHeaders = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedAppt, setSelectedAppt] = useState<Partial<Appointment> | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const fetchAppointments = useCallback(async () => {
    try {
      let startStr, endStr;
      const start = new Date(selectedDate);

      if (viewMode === 'day') {
        const dateStr = start.toISOString().split('T')[0];
        startStr = `${dateStr}T00:00:00`;
        endStr = `${dateStr}T23:59:59`;
      } else {
        const day = start.getDay();
        const diff = start.getDate() - day + (day === 0 ? -6 : 1);
        start.setDate(diff);
        startStr = start.toISOString().split('T')[0] + 'T00:00:00';

        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        endStr = end.toISOString().split('T')[0] + 'T23:59:59';
      }

      const data = await weddingApi.getAppointments({
        from: startStr,
        to: endStr,
        headers: wmHeaders,
      });
      setAppointments(data);
    } catch (err) {
      console.error("Failed to fetch appointments:", err);
    }
  }, [selectedDate, viewMode, wmHeaders]);

  useEffect(() => {
    fetchAppointments();
    // Manual poll as fallback (1 minute)
    const timer = setInterval(fetchAppointments, 60000);
    return () => clearInterval(timer);
  }, [fetchAppointments]);

  const handlePrev = () => {
    const newDate = new Date(selectedDate);
    if (viewMode === 'day') newDate.setDate(newDate.getDate() - 1);
    else newDate.setDate(newDate.getDate() - 7);
    setSelectedDate(newDate);
  };

  const handleNext = () => {
    const newDate = new Date(selectedDate);
    if (viewMode === 'day') newDate.setDate(newDate.getDate() + 1);
    else newDate.setDate(newDate.getDate() + 7);
    setSelectedDate(newDate);
  };

  const handleToday = () => setSelectedDate(new Date());

  const handleAddAppt = (timeSlot?: string) => {
    const dateStr = selectedDate.toISOString().split('T')[0];
    setSelectedAppt({
      datetime: `${dateStr}T${timeSlot || '10:00'}:00`,
      status: 'Scheduled'
    });
    setIsModalOpen(true);
  };

  const handleAddApptAtDate = (date: Date, timeSlot?: string) => {
    const dateStr = date.toISOString().split('T')[0];
    setSelectedAppt({
      datetime: `${dateStr}T${timeSlot || '10:00'}:00`,
      status: 'Scheduled'
    });
    setIsModalOpen(true);
  };

  const handleEditAppt = (appt: Appointment) => {
    setSelectedAppt(appt);
    setIsModalOpen(true);
  };

  const handleDeleteAppt = (e: React.MouseEvent, apptId: string) => {
    e.stopPropagation();
    setDeleteConfirm(apptId);
  };

  const executeDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await weddingApi.deleteAppointment(deleteConfirm, { headers: wmHeaders });
      fetchAppointments();
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Failed to delete appointment:", err);
    }
  };

  // Time slots: 9 AM to 6:30 PM
  const timeSlots = useMemo(() => {
    const slots = [];
    for (let i = 9; i <= 18; i++) {
      slots.push(`${i.toString().padStart(2, '0')}:00`);
      slots.push(`${i.toString().padStart(2, '0')}:30`);
    }
    return slots;
  }, []);

  // Helper to get 7 dates for the week (starting Monday)
  const weekDates = useMemo(() => {
    const start = new Date(selectedDate);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    start.setDate(diff);
    
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        dates.push(d);
    }
    return dates;
  }, [selectedDate]);

  return (
    <div className="flex h-full flex-col bg-app-surface overflow-hidden">
      {/* Header Controls (1:1 UI/UX Restoration) */}
      <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 p-4 no-print">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="text-app-accent" size={20} />
            <div>
              <h2 className="text-lg font-black tracking-tight text-app-text uppercase italic">
                Appointment Schedule
              </h2>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted opacity-80 max-w-md">
                General store visits and services. Party-specific workflow stays in Wedding Manager unless you explicitly link a booking.
              </p>
            </div>
          </div>
          
          <div className="flex items-center bg-app-surface rounded-lg border border-app-border p-1 shadow-sm">
            <button
              type="button"
              onClick={handlePrev}
              aria-label="Previous day or week"
              className="ui-touch-target inline-flex items-center justify-center rounded p-1 px-2 text-app-text-muted transition-colors hover:bg-app-surface-2"
            >
              <ChevronLeft size={16} />
            </button>
            <input
              type="date"
              className="bg-transparent px-3 text-xs font-bold text-app-text outline-none"
              value={selectedDate.toISOString().split('T')[0]}
              onChange={(e) => {
                if (e.target.value) {
                  const [y, m, d] = e.target.value.split('-').map(Number);
                  setSelectedDate(new Date(y, m - 1, d));
                }
              }}
            />
            <button
              type="button"
              onClick={handleNext}
              aria-label="Next day or week"
              className="ui-touch-target inline-flex items-center justify-center rounded p-1 px-2 text-app-text-muted transition-colors hover:bg-app-surface-2"
            >
              <ChevronRight size={16} />
            </button>
            
            <div className="ml-4 flex rounded-md bg-app-surface-2 p-0.5 border border-app-border">
              <button
                type="button"
                onClick={() => setViewMode('day')}
                className={`min-h-[44px] min-w-[44px] px-3 py-2 text-[10px] font-black uppercase tracking-wider rounded touch-manipulation ${viewMode === 'day' ? 'bg-app-accent text-white shadow-sm' : 'text-app-text-muted hover:text-app-text'}`}
              >
                Day
              </button>
              <button
                type="button"
                onClick={() => setViewMode('week')}
                className={`min-h-[44px] min-w-[44px] px-3 py-2 text-[10px] font-black uppercase tracking-wider rounded touch-manipulation ${viewMode === 'week' ? 'bg-app-accent text-white shadow-sm' : 'text-app-text-muted hover:text-app-text'}`}
              >
                Week
              </button>
            </div>
          </div>
          
          <button
            type="button"
            onClick={handleToday}
            className="ui-touch-target inline-flex items-center justify-center rounded px-3 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
          >
            Today
          </button>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="ui-touch-target flex min-h-[44px] items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-all hover:bg-app-surface-2 hover:text-app-text"
          >
            <Printer size={14} /> Print
          </button>
          <button
            type="button"
            onClick={() => handleAddAppt()}
            className="flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95"
          >
            <Plus size={14} strokeWidth={3} /> New Appt
          </button>
        </div>
      </div>

      {/* Print-only Header */}
      <div className="hidden print:block text-center p-8 bg-white text-black">
        <h1 className="text-2xl font-black uppercase italic">{formatApptDate(selectedDate)}</h1>
        <p className="text-sm font-bold opacity-70">DAILY APPOINTMENT SCHEDULE</p>
      </div>

      {/* Main Grid */}
      <div className="flex-1 overflow-auto no-scrollbar bg-app-bg/50 p-4 print:p-0">
        {viewMode === 'day' ? (
          <div className="mx-auto max-w-5xl rounded-2xl border border-app-border bg-app-surface shadow-2xl shadow-black/10 overflow-hidden print:border-0 print:shadow-none">
            <div className="grid grid-cols-[100px_1fr] divide-y divide-app-border/40">
              {timeSlots.map(time => {
                const dateStr = selectedDate.toISOString().split('T')[0];
                const slotAppts = appointments.filter(a => a.datetime === `${dateStr}T${time}:00`);
                const hour = parseInt(time.split(':')[0]);
                const displayTime = `${hour > 12 ? hour - 12 : hour}:${time.split(':')[1]} ${hour >= 12 ? 'PM' : 'AM'}`;

                return (
                  <div key={time} className="contents group">
                    <div className="flex items-center justify-end border-r border-app-border/40 bg-app-surface-2 p-4 text-[10px] font-black tracking-widest text-app-text-muted opacity-60">
                      {displayTime}
                    </div>
                    <div
                      className="min-h-[80px] p-2 flex gap-2 overflow-x-auto no-scrollbar hover:bg-app-surface-2/30 transition-colors cursor-pointer relative"
                      onClick={() => handleAddApptAtDate(selectedDate, time)}
                    >
                      {slotAppts.map(appt => (
                        <AppointmentCard key={appt.id} appt={appt} onEdit={handleEditAppt} onDelete={handleDeleteAppt} />
                      ))}
                      <div className="opacity-0 group-hover:opacity-100 flex items-center justify-center border-2 border-dashed border-app-border rounded-xl w-12 shrink-0 transition-opacity print:hidden">
                        <Plus size={20} className="text-app-text-muted" />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-2xl border border-app-border bg-app-surface shadow-2xl shadow-black/10 print:border-0 [-webkit-overflow-scrolling:touch]">
            <div className="min-w-[720px] overflow-hidden md:min-w-[960px] xl:min-w-[1200px]">
             {/* Week Grid Header */}
             <div className="grid grid-cols-[100px_repeat(7,1fr)] border-b border-app-border bg-app-surface-2 sticky top-0 z-10">
                <div className="p-4 border-r border-app-border/40 bg-app-surface-3"></div>
                {weekDates.map(date => {
                    const isToday = date.toDateString() === new Date().toDateString();
                    return (
                        <div key={date.toISOString()} className={`p-4 text-center border-r border-app-border/40 ${isToday ? 'bg-app-accent/5' : ''}`}>
                            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                                {date.toLocaleDateString('en-US', { weekday: 'short' })}
                            </p>
                            <p className={`mt-1 text-lg font-black italic tracking-tighter ${isToday ? 'text-app-accent' : 'text-app-text'}`}>
                                {date.getDate().toString().padStart(2, '0')}
                            </p>
                        </div>
                    );
                })}
             </div>
             
             {/* Week Grid Body */}
             <div className="grid grid-cols-[100px_repeat(7,1fr)] divide-y divide-app-border/40">
                {timeSlots.map(time => {
                    const hour = parseInt(time.split(':')[0]);
                    const displayTime = `${hour > 12 ? hour - 12 : hour}:${time.split(':')[1]} ${hour >= 12 ? 'PM' : 'AM'}`;

                    return (
                        <React.Fragment key={time}>
                            <div className="flex items-center justify-end border-r border-app-border/40 bg-app-surface-2 p-4 text-[10px] font-black tracking-widest text-app-text-muted opacity-60 sticky left-0 z-[1]">
                                {displayTime}
                            </div>
                            {weekDates.map(date => {
                                const dateStr = date.toISOString().split('T')[0];
                                const slotAppts = appointments.filter(a => a.datetime === `${dateStr}T${time}:00`);
                                const isToday = date.toDateString() === new Date().toDateString();

                                return (
                                    <div 
                                        key={`${dateStr}-${time}`} 
                                        className={`min-h-[100px] p-2 flex flex-col gap-2 border-r border-app-border/40 hover:bg-app-surface-2/30 transition-colors cursor-pointer group ${isToday ? 'bg-app-accent/[0.02]' : ''}`}
                                        onClick={() => handleAddApptAtDate(date, time)}
                                    >
                                        {slotAppts.map(appt => (
                                            <div key={appt.id} className="w-full">
                                                <AppointmentCard appt={appt} onEdit={handleEditAppt} onDelete={handleDeleteAppt} isCompact />
                                            </div>
                                        ))}
                                        <div className="mt-auto opacity-0 group-hover:opacity-100 flex items-center justify-center border border-dashed border-app-border/60 rounded-lg py-1 transition-opacity print:hidden">
                                            <Plus size={14} className="text-app-text-muted" />
                                        </div>
                                    </div>
                                );
                            })}
                        </React.Fragment>
                    );
                })}
             </div>
            </div>
          </div>
        )}
      </div>

      <AppointmentModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={fetchAppointments}
        initialData={selectedAppt}
      />

      {deleteConfirm && (
        <ConfirmationModal
          isOpen={true}
          title="Delete Appointment"
          message="Are you sure you want to permanently delete this appointment? This action cannot be undone."
          confirmLabel="Delete Appointment"
          onConfirm={executeDelete}
          onClose={() => setDeleteConfirm(null)}
          variant="danger"
        />
      )}
    </div>
  );
};

const AppointmentCard: React.FC<{ appt: Appointment; onEdit: (a: Appointment) => void; onDelete: (e: React.MouseEvent, id: string) => void, isCompact?: boolean }> = ({ appt, onEdit, onDelete, isCompact }) => {
  const isMeasurement = appt.type === 'Measurement';
  const isFitting = appt.type === 'Fitting';
  const isPickup = appt.type === 'Pickup';
  
  let colorClass = "bg-app-surface-3 border-app-border text-app-text";
  let icon = <Clock size={12} />;
  
  if (isMeasurement) {
    colorClass =
      "bg-blue-600/10 border-blue-500/50 text-blue-900 dark:text-blue-100";
    icon = <Ruler size={12} />;
  } else if (isFitting) {
    colorClass =
      "bg-amber-600/10 border-amber-500/50 text-amber-950 dark:text-amber-100";
    icon = <Scissors size={12} />;
  } else if (isPickup) {
    colorClass =
      "bg-emerald-600/10 border-emerald-500/50 text-emerald-900 dark:text-emerald-100";
    icon = <ShoppingBag size={12} />;
  }

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onEdit(appt); }}
      className={`group/card relative flex flex-col justify-between rounded-xl border-l-[6px] p-3 shadow-md transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98] cursor-pointer ${isCompact ? 'min-w-0 max-w-full' : 'min-w-[180px] max-w-[240px]'} ${colorClass}`}
    >
      <div className="min-w-0">
        <h4 className="truncate text-xs font-black uppercase tracking-tight">{appt.customerName || 'Anonymous'}</h4>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold opacity-80">
          {icon} <span>{appt.type}</span>
          {!isCompact && appt.phone && <span className="opacity-40">• {formatPhone(appt.phone)}</span>}
        </div>
        {!isCompact && appt.salesperson && (
          <div className="mt-2 flex items-center gap-1.5 text-[9px] font-black uppercase tracking-widest text-app-accent">
            <User size={10} /> {appt.salesperson}
          </div>
        )}
        {!isCompact && appt.notes && (
          <p className="mt-2 truncate text-[9px] italic opacity-60 leading-tight">
            "{appt.notes}"
          </p>
        )}
      </div>
      
      <button
        onClick={(e) => onDelete(e, appt.id)}
        className="absolute bottom-2 right-2 rounded-md p-1.5 text-app-text-muted hover:bg-red-500/20 hover:text-red-400 opacity-0 group-hover/card:opacity-100 transition-all no-print"
      >
        <Trash size={12} />
      </button>
    </div>
  );
};

export default SchedulerWorkspace;
