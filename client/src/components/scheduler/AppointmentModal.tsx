import { getBaseUrl } from "../../lib/apiConfig";
import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, Calendar, AlertTriangle, CheckCircle } from 'lucide-react';
import CustomerSearchInput from '../ui/CustomerSearchInput';
import StaffMiniSelector from '../ui/StaffMiniSelector';
import {
  type AppointmentResource,
  type AppointmentServiceType,
  type AppointmentStaffRow,
  weddingApi,
} from '../../lib/weddingApi';
import { type Appointment } from './SchedulerWorkspace';
import { useToast } from '../ui/ToastProviderLogic';
import { useBackofficeAuth } from '../../context/BackofficeAuthContextLogic';
import { mergedPosStaffHeaders } from '../../lib/posRegisterAuth';
import ConfirmationModal from '../ui/ConfirmationModal';

const apiBase = getBaseUrl();

const localDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const localTimeKey = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

interface AppointmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: () => void;
  initialData?: Partial<Appointment> | null;
}

const AppointmentModal: React.FC<AppointmentModalProps> = ({ isOpen, onClose, onSave, initialData }) => {
  const [formData, setFormData] = useState({
    type: 'Measurement',
    date: localDateKey(new Date()),
    time: '10:00',
    customerName: '',
    phone: '',
    notes: '',
    partyId: '',
    memberId: '',
    customerId: '',
    salespersonStaffId: '',
    salesperson: '',
    status: 'Scheduled',
    durationMinutes: 60,
    serviceTypeId: '',
    resourceIds: [] as string[],
    cancellationReason: '',
  });

  const [salespeople, setSalespeople] = useState<AppointmentStaffRow[]>([]);
  const [serviceTypes, setServiceTypes] = useState<AppointmentServiceType[]>([]);
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  /** Offer optional wedding-member link after picking a customer who is on an active party (most ROS bookings stay general). */
  const [weddingLinkOffer, setWeddingLinkOffer] = useState<{
    memberId: string;
    partyId: string;
    partyLabel?: string;
  } | null>(null);
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const wmHeaders = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const [confirmStatus, setConfirmStatus] = useState<{ status: string, statusKey: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [scheduleWarning, setScheduleWarning] = useState<string | null>(null);
  const [overrideScheduleWarning, setOverrideScheduleWarning] = useState(false);
  const [scheduleOverrideReason, setScheduleOverrideReason] = useState("");
  const [conflictWarning, setConflictWarning] = useState<string | null>(null);
  const [overrideConflict, setOverrideConflict] = useState(false);
  const [conflictOverrideReason, setConflictOverrideReason] = useState("");
  const canMutate = hasPermission("weddings.mutate");
  const canOverrideSchedule = hasPermission("staff.manage_access") || hasPermission("tasks.manage");

  const selectedSalespersonId = useMemo(() => {
    if (formData.salespersonStaffId) return formData.salespersonStaffId;
    const current = formData.salesperson.trim().toLowerCase();
    if (!current) return "";
    return salespeople.find((sp) => sp.full_name.trim().toLowerCase() === current)?.id ?? "";
  }, [formData.salesperson, formData.salespersonStaffId, salespeople]);

  useEffect(() => {
    setOverrideScheduleWarning(false);
    setScheduleOverrideReason("");
    setConflictWarning(null);
    setOverrideConflict(false);
    setConflictOverrideReason("");
  }, [formData.salesperson, formData.date, formData.time, formData.durationMinutes, formData.resourceIds]);

  useEffect(() => {
    if (!isOpen || formData.status !== "Scheduled") {
      setScheduleWarning(null);
      return;
    }
    const sp = formData.salesperson.trim();
    if (!sp && !formData.salespersonStaffId) {
      setScheduleWarning(null);
      return;
    }
    const iso = new Date(`${formData.date}T${formData.time}:00`).toISOString();
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const q = new URLSearchParams({ full_name: sp, starts_at: iso });
          if (formData.salespersonStaffId) q.set("staff_id", formData.salespersonStaffId);
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
  }, [isOpen, formData.status, formData.salesperson, formData.salespersonStaffId, formData.date, formData.time, wmHeaders]);

  useEffect(() => {
    const fetchFormOptions = async () => {
      try {
        const [staffRows, serviceRows, resourceRows] = await Promise.all([
          weddingApi.getAppointmentStaff({ headers: wmHeaders }),
          weddingApi.getAppointmentServiceTypes({ headers: wmHeaders }),
          weddingApi.getAppointmentResources({ headers: wmHeaders }),
        ]);
        setSalespeople(staffRows);
        setServiceTypes(serviceRows);
        setResources(resourceRows);
      } catch (err) {
        console.error("Failed to fetch appointment options:", err);
      }
    };
    if (isOpen) void fetchFormOptions();
  }, [isOpen, wmHeaders]);

  useEffect(() => {
    if (!isOpen || formData.serviceTypeId || serviceTypes.length === 0) return;
    const service = serviceTypes.find(
      (item) => item.display_name.toLowerCase() === formData.type.toLowerCase(),
    );
    if (!service) return;
    setFormData((current) => ({
      ...current,
      serviceTypeId: service.id,
      durationMinutes: initialData?.id ? current.durationMinutes : service.duration_minutes,
    }));
  }, [formData.serviceTypeId, formData.type, initialData?.id, isOpen, serviceTypes]);

  useEffect(() => {
    if (isOpen && initialData) {
      let dateStr = localDateKey(new Date());
      let timeStr = '10:00';

      if (initialData.datetime) {
        const dt = new Date(initialData.datetime);
        if (!isNaN(dt.getTime())) {
          dateStr = localDateKey(dt);
          timeStr = localTimeKey(dt);
        }
      }
      const start = initialData.datetime ? new Date(initialData.datetime) : null;
      const end = initialData.endsAt ? new Date(initialData.endsAt) : null;
      const durationMinutes = start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())
        ? Math.max(15, Math.round((end.getTime() - start.getTime()) / 60000))
        : 60;

      setFormData({
        type: initialData.type || initialData.appointment_type || 'Measurement',
        date: dateStr,
        time: timeStr,
        customerName: initialData.customerName || initialData.customer_display_name || '',
        phone: initialData.phone || '',
        notes: initialData.notes || '',
        partyId: initialData.partyId || '',
        memberId: initialData.memberId || '',
        customerId: initialData.customerId || '',
        salespersonStaffId: initialData.salespersonStaffId || '',
        salesperson: initialData.salesperson || '',
        status: initialData.status || 'Scheduled',
        durationMinutes,
        serviceTypeId: initialData.serviceTypeId || '',
        resourceIds: initialData.resourceIds || [],
        cancellationReason: '',
      });
      setSearchTerm(initialData.customerName || initialData.customer_display_name || '');
      setWeddingLinkOffer(null);
    } else if (isOpen) {
      setWeddingLinkOffer(null);
      setFormData({
        type: 'Measurement',
        date: localDateKey(new Date()),
        time: '10:00',
        customerName: '',
        phone: '',
        notes: '',
        partyId: '',
        memberId: '',
        customerId: '',
        salespersonStaffId: '',
        salesperson: '',
        status: 'Scheduled',
        durationMinutes: 60,
        serviceTypeId: '',
        resourceIds: [],
        cancellationReason: '',
      });
      setSearchTerm('');
    }
  }, [initialData, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canMutate) return;
    if (scheduleWarning && !overrideScheduleWarning) {
      toast(
        canOverrideSchedule
          ? "Confirm the Manager Access override and enter a reason before saving."
          : "This staff member is not scheduled. Update the schedule or choose another teammate.",
        "error",
      );
      return;
    }
    if (scheduleWarning && overrideScheduleWarning && !scheduleOverrideReason.trim()) {
      toast("Manager Access override requires a reason.", "error");
      return;
    }
    if (conflictWarning && !overrideConflict) {
      toast("Choose another time or confirm a Manager Access overlap override.", "error");
      return;
    }
    if (overrideConflict && !conflictOverrideReason.trim()) {
      toast("Manager Access overlap override requires a reason.", "error");
      return;
    }
    const datetime = `${formData.date}T${formData.time}:00`;

    try {
      if (initialData?.id) {
        await weddingApi.updateAppointment(
          initialData.id,
          {
            customerName: searchTerm,
            phone: formData.phone,
            memberId: formData.memberId || null,
            customerId: formData.customerId || null,
            type: formData.type,
            datetime,
            notes: formData.notes,
            status: formData.status,
            salesperson: formData.salesperson,
            salespersonStaffId: formData.salespersonStaffId || null,
            scheduleOverrideReason: scheduleWarning && overrideScheduleWarning ? scheduleOverrideReason : null,
            conflictOverrideReason: overrideConflict ? conflictOverrideReason : null,
            durationMinutes: formData.durationMinutes,
            serviceTypeId: formData.serviceTypeId || null,
            resourceIds: formData.resourceIds,
            expectedRevision: initialData.revision,
            clearWeddingLink: Boolean(initialData.memberId && !formData.memberId),
            clearCustomerLink: Boolean(initialData.customerId && !formData.customerId && !formData.memberId),
            clearSalesperson: Boolean(
              (initialData.salespersonStaffId || initialData.salesperson) &&
              !formData.salespersonStaffId &&
              !formData.salesperson,
            ),
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
            salespersonStaffId: formData.salespersonStaffId || null,
            scheduleOverrideReason: scheduleWarning && overrideScheduleWarning ? scheduleOverrideReason : null,
            conflictOverrideReason: overrideConflict ? conflictOverrideReason : null,
            durationMinutes: formData.durationMinutes,
            serviceTypeId: formData.serviceTypeId || null,
            resourceIds: formData.resourceIds,
          },
          { headers: wmHeaders },
        );
      }
      onSave();
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save appointment.";
      if (msg.toLowerCase().includes("overlap")) setConflictWarning(msg);
      toast(msg, "error");
    }
  };

  const handleStatusUpdate = async (status: string) => {
    if (!initialData?.id) return;
    
    if (status === 'Attended' && initialData.memberId) {
      let statusKey = '';
      if (initialData.type === 'Measurement') statusKey = 'measured';
      else if (initialData.type === 'Fitting') statusKey = 'fitting';

      if (statusKey) {
        setConfirmStatus({ status, statusKey });
        return; // Wait for confirmation
      }
    }

    await executeStatusUpdate(status);
  };

  const executeStatusUpdate = async (status: string, syncMember = false) => {
    if (!initialData?.id) return;

    try {
      await weddingApi.updateAppointment(
        initialData.id,
        {
          status,
          expectedRevision: initialData.revision,
          completeMemberMilestone: syncMember,
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
    if (!formData.cancellationReason.trim()) {
      toast("Enter a cancellation reason before cancelling this appointment.", "error");
      return;
    }
    setConfirmDelete(true);
  };

  const executeDelete = async () => {
    if (!initialData?.id) return;
    try {
      await weddingApi.updateAppointment(
        initialData.id,
        {
          status: "Cancelled",
          cancellationReason: formData.cancellationReason,
          expectedRevision: initialData.revision,
        },
        { headers: wmHeaders },
      );
      toast("Appointment cancelled", "success");
      onSave();
      onClose();
    } catch (err) {
      console.error("Delete failed:", err);
      toast(err instanceof Error ? err.message : "Failed to cancel appointment", "error");
    } finally {
      setConfirmDelete(false);
    }
  };

  if (!isOpen) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop animate-in fade-in duration-200">
      <div
        data-testid="appointment-modal"
        className="ui-modal w-full max-w-none sm:max-w-2xl animate-in zoom-in-95 duration-300"
      >
        
        {/* Header */}
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-accent text-white shadow-lg shadow-app-accent/20">
              <Calendar size={24} />
            </div>
            <div>
              <h3 className="text-lg font-black italic tracking-tighter text-app-text uppercase sm:text-xl">
                {initialData?.id ? 'Update Appointment' : 'Book Appointment'}
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
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-4 sm:p-8 no-scrollbar">
          {!canMutate ? (
            <div className="mb-6 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm font-semibold text-app-text-muted">
              You have view-only access to this appointment.
            </div>
          ) : null}
          <fieldset disabled={!canMutate} className="space-y-6 sm:space-y-8">
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:gap-6">
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Appointment Type</label>
              <div className="relative">
                <select
                  className="ui-input w-full cursor-pointer appearance-none py-3 pl-4 pr-10 text-sm font-bold"
                  value={formData.type}
                  onChange={(e) => {
                    const service = serviceTypes.find((item) => item.display_name === e.target.value);
                    setFormData({
                      ...formData,
                      type: e.target.value,
                      serviceTypeId: service?.id ?? "",
                      durationMinutes: service?.duration_minutes ?? formData.durationMinutes,
                    });
                  }}
                >
                  {(serviceTypes.length > 0
                    ? serviceTypes.map((item) => item.display_name)
                    : ["Measurement", "Fitting", "Pickup", "Consultation", "Other"]
                  ).map((label) => <option key={label}>{label}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Start Time</label>
              <input
                type="time"
                step={900}
                className="ui-input w-full px-4 py-3 text-sm font-bold"
                value={formData.time}
                onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Duration</label>
              <select
                className="ui-input w-full px-4 py-3 text-sm font-bold"
                value={formData.durationMinutes}
                onChange={(e) => setFormData({ ...formData, durationMinutes: Number(e.target.value) })}
              >
                {[15, 30, 45, 60, 75, 90, 120, 180, 240, 300, 360, 480].map((minutes) => (
                  <option key={minutes} value={minutes}>{minutes} minutes</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-8">
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
              <StaffMiniSelector
                staff={salespeople}
                selectedId={selectedSalespersonId}
                onSelect={(id) => {
                  const selected = salespeople.find((sp) => sp.id === id);
                  setFormData({
                    ...formData,
                    salesperson: selected?.full_name ?? "",
                    salespersonStaffId: selected?.id ?? "",
                  });
                }}
                placeholder="Any / Unassigned"
                displayLabel={formData.salesperson || undefined}
                size="lg"
                fullWidth
              />
              {scheduleWarning ? (
                <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-800 dark:text-amber-200">
                  <p>{scheduleWarning}</p>
                  <label className={`mt-2 flex items-start gap-2 text-[11px] font-black uppercase tracking-widest ${
                    canOverrideSchedule ? "text-amber-900 dark:text-amber-100" : "text-app-text-muted"
                  }`}>
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-amber-500"
                      checked={overrideScheduleWarning}
                      disabled={!canOverrideSchedule}
                      onChange={(e) => setOverrideScheduleWarning(e.target.checked)}
                    />
                    Manager Access override
                  </label>
                  {overrideScheduleWarning && canOverrideSchedule ? (
                    <textarea
                      className="ui-input mt-2 min-h-[4rem] w-full px-3 py-2 text-xs font-semibold"
                      value={scheduleOverrideReason}
                      onChange={(e) => setScheduleOverrideReason(e.target.value)}
                      placeholder="Required reason for booking outside the published schedule"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {resources.length > 0 ? (
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Resources</label>
              <p className="text-[10px] text-app-text-muted">Reserve rooms, fitting areas, or shared equipment. Resource capacity is enforced by ROS.</p>
              <div className="flex flex-wrap gap-2">
                {resources.map((resource) => {
                  const selected = formData.resourceIds.includes(resource.id);
                  return (
                    <label
                      key={resource.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs font-bold ${selected ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-app-border bg-app-surface-2 text-app-text-muted"}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => setFormData({
                          ...formData,
                          resourceIds: event.target.checked
                            ? [...formData.resourceIds, resource.id]
                            : formData.resourceIds.filter((id) => id !== resource.id),
                        })}
                      />
                      {resource.name} {resource.capacity > 1 ? `(capacity ${resource.capacity})` : ""}
                    </label>
                  );
                })}
              </div>
            </div>
          ) : null}

          {conflictWarning ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs font-semibold text-red-800 dark:text-red-200">
              <p>{conflictWarning}</p>
              <label className={`mt-3 flex items-start gap-2 text-[11px] font-black uppercase tracking-widest ${canOverrideSchedule ? "text-red-900 dark:text-red-100" : "text-app-text-muted"}`}>
                <input
                  type="checkbox"
                  checked={overrideConflict}
                  disabled={!canOverrideSchedule}
                  onChange={(event) => setOverrideConflict(event.target.checked)}
                />
                Manager Access overlap override
              </label>
              {overrideConflict && canOverrideSchedule ? (
                <textarea
                  className="ui-input mt-2 min-h-[4rem] w-full px-3 py-2 text-xs font-semibold"
                  value={conflictOverrideReason}
                  onChange={(event) => setConflictOverrideReason(event.target.value)}
                  placeholder="Required reason for intentionally overlapping this booking"
                />
              ) : null}
            </div>
          ) : null}

          <div className="space-y-2 relative">
            <label className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">Customer</label>
            <p className="text-[10px] text-app-text-muted -mt-1 mb-1">
              Search your customer list, or type a name for a one-off visit.
            </p>
            <div className="relative group">
              <CustomerSearchInput 
                onQueryChange={(value) => {
                  setSearchTerm(value);
                  if (value.trim() !== formData.customerName.trim()) {
                    setFormData((current) => ({
                      ...current,
                      customerName: value,
                      partyId: "",
                      memberId: "",
                      customerId: "",
                    }));
                    setWeddingLinkOffer(null);
                  }
                }}
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
                showSelectedLabel
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

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-8">
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
            <div className="space-y-3 border-t border-app-border pt-4">
              {formData.memberId && formData.type === "Pickup" ? (
                <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-semibold text-app-text-muted">
                  Marking this visit attended does not complete merchandise pickup. Complete the pickup through Orders/Register so inventory, fulfillment, balance, and audit records remain correct.
                </p>
              ) : null}
              {initialData.status !== "Cancelled" ? (
                <textarea
                  className="ui-input min-h-[4rem] w-full px-3 py-2 text-sm font-semibold"
                  value={formData.cancellationReason}
                  onChange={(event) => setFormData({ ...formData, cancellationReason: event.target.value })}
                  placeholder="Cancellation reason (required only when cancelling)"
                />
              ) : null}
              <div className="flex flex-wrap gap-3">
              {initialData.status !== "Attended" ? <button
                type="button"
                onClick={() => handleStatusUpdate('Attended')}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-600/10 py-3 text-[10px] font-black uppercase tracking-widest text-emerald-500 transition-all hover:bg-emerald-600 hover:text-white sm:flex-1 sm:w-auto"
              >
                <CheckCircle size={14} /> Mark Attended
              </button> : null}
              {initialData.status !== "Missed" ? <button
                type="button"
                onClick={() => handleStatusUpdate('Missed')}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/30 bg-amber-600/10 py-3 text-[10px] font-black uppercase tracking-widest text-amber-500 transition-all hover:bg-amber-600 hover:text-white sm:flex-1 sm:w-auto"
              >
                <AlertTriangle size={14} /> Mark Missed
              </button> : null}
              {initialData.status !== "Cancelled" ? <button
                type="button"
                onClick={handleDelete}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/30 bg-red-600/10 px-6 py-3 text-[10px] font-black uppercase tracking-widest text-red-500 transition-all hover:bg-red-600 hover:text-white sm:w-auto"
              >
                Cancel Appointment
              </button> : null}
              </div>
            </div>
          )}

          </fieldset>

          <div className="sticky bottom-0 -mx-4 flex flex-wrap justify-end gap-3 border-t border-app-border bg-app-surface px-4 pt-4 pb-2 sm:static sm:mx-0 sm:px-0 sm:pt-6 sm:pb-0">
            <button
              type="button"
              onClick={onClose}
              data-testid="appointment-modal-cancel"
              className="w-full px-6 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-app-text-muted transition-colors hover:text-app-text sm:w-auto"
            >
              Close
            </button>
            {canMutate ? <button
              type="submit"
              data-testid="appointment-modal-submit"
              className="w-full rounded-full bg-app-accent px-10 py-3 text-[11px] font-black uppercase tracking-[0.2em] text-white shadow-xl shadow-app-accent/20 transition-all active:scale-95 hover:scale-[1.02] sm:w-auto"
            >
              {initialData?.id ? 'Update Schedule' : 'Create Appointment'}
            </button> : null}
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
            onCancel={() => executeStatusUpdate('Attended', false)}
            onClose={() => setConfirmStatus(null)}
            variant="info"
          />
        )}

        {confirmDelete && (
          <ConfirmationModal
            isOpen={true}
            title="Cancel Appointment"
            message="Cancel this appointment? ROS will preserve its history and notify the linked customer when notifications are enabled."
            confirmLabel="Cancel Appointment"
            onConfirm={executeDelete}
            onClose={() => setConfirmDelete(false)}
            variant="danger"
          />
        )}
      </div>
    </div>,
    root
  );
};

export default AppointmentModal;
