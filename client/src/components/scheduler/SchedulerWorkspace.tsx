import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, Printer, Plus, Clock, User, Scissors, Ruler, ShoppingBag, Search, X } from 'lucide-react';
import { getBaseUrl } from '../../lib/apiConfig';
import {
  type AppointmentConflict,
  type AppointmentResource,
  weddingApi,
} from '../../lib/weddingApi';
import AppointmentModal from './AppointmentModal';
import { formatPhone } from '../../lib/utils.ts';
import { useBackofficeAuth } from '../../context/BackofficeAuthContextLogic';
import { mergedPosStaffHeaders } from '../../lib/posRegisterAuth';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { openPrintableHtml } from '../../lib/browserPrint';
import { useToast } from '../ui/ToastProviderLogic';
import { activateOnEnterOrSpace } from '../../lib/interaction';

const baseUrl = getBaseUrl();

interface PrintableRow {
  key: string;
  date?: string;
  time: string;
  customer: string;
  type: string;
  person: string;
  phone: string;
  notes: string;
}

const printEsc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const printStyles = () => `
  <style>
    :root { color-scheme: light; }
    @page { size: landscape; margin: 8mm; }
    html, body { width: 100%; margin: 0; padding: 0; background: #fff; color: #000; }
    body { font-family: Inter, Arial, sans-serif; }
    h1 { margin: 0 0 10px; font-size: 32px; letter-spacing: 0.16em; text-transform: uppercase; text-align: center; }
    p { margin: 0 0 8px; text-align: center; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #111; padding: 6px 8px; font-size: 11px; text-align: left; }
    th { background: #111; color: #fff; text-transform: uppercase; }
    tbody tr { page-break-inside: avoid; }
  </style>
`;

// Helper for formatting dates to match original UX
const formatApptDate = (date: Date) => {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

const localDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const appointmentLocalDateKey = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return localDateKey(date);
};

const appointmentLocalTimeKey = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(11, 16);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const isAppointmentInSlot = (appt: Appointment, dateStr: string, time: string) =>
  appointmentLocalDateKey(appt.datetime) === dateStr &&
  appointmentLocalTimeKey(appt.datetime) === time;

const CLOSED_APPOINTMENT_STATUSES = new Set(["attended", "missed", "cancelled", "canceled"]);

const isOpenAppointment = (appt: Appointment) =>
  !CLOSED_APPOINTMENT_STATUSES.has(String(appt.status || "").trim().toLowerCase());

const normalizeAppointmentRow = (row: Record<string, unknown>): Appointment => ({
  id: String(row.id ?? ""),
  datetime: String(row.datetime ?? row.starts_at ?? ""),
  endsAt: String(row.endsAt ?? row.ends_at ?? row.datetime ?? row.starts_at ?? ""),
  status: String(row.status ?? "Scheduled"),
  type: String(row.type ?? row.appointment_type ?? "Measurement"),
  customerName:
    (row.customerName as string | null | undefined) ??
    (row.customer_display_name as string | null | undefined) ??
    null,
  phone: (row.phone as string | null | undefined) ?? null,
  salesperson: (row.salesperson as string | null | undefined) ?? null,
  salespersonStaffId:
    row.salespersonStaffId != null
      ? String(row.salespersonStaffId)
      : row.salesperson_staff_id != null
        ? String(row.salesperson_staff_id)
        : null,
  notes: (row.notes as string | null | undefined) ?? null,
  partyId:
    row.partyId != null
      ? String(row.partyId)
      : row.wedding_party_id != null
        ? String(row.wedding_party_id)
        : null,
  memberId:
    row.memberId != null
      ? String(row.memberId)
      : row.wedding_member_id != null
        ? String(row.wedding_member_id)
        : null,
  customerId:
    row.customerId != null
      ? String(row.customerId)
      : row.customer_id != null
        ? String(row.customer_id)
        : null,
  customer_display_name: (row.customer_display_name as string | null | undefined) ?? null,
  appointment_type: (row.appointment_type as string | null | undefined) ?? null,
  serviceTypeId:
    row.serviceTypeId != null
      ? String(row.serviceTypeId)
      : row.service_type_id != null
        ? String(row.service_type_id)
        : null,
  resourceIds: Array.isArray(row.resourceIds)
    ? row.resourceIds.map(String)
    : Array.isArray(row.resource_ids)
      ? row.resource_ids.map(String)
      : [],
  revision: Number(row.revision ?? 1),
});

export interface Appointment {
  id: string;
  datetime: string;
  endsAt?: string;
  status: string;
  type?: string;
  customerName?: string | null;
  phone?: string | null;
  salesperson?: string | null;
  salespersonStaffId?: string | null;
  notes?: string | null;
  partyId?: string | null;
  memberId?: string | null;
  customerId?: string | null;
  customer_display_name?: string | null;
  appointment_type?: string | null;
  serviceTypeId?: string | null;
  resourceIds?: string[];
  revision?: number;
}

interface SchedulerWorkspaceProps {
  activeSection?: string;
  deepLinkAppointmentId?: string | null;
  onDeepLinkAppointmentConsumed?: () => void;
  prefillCustomer?: {
    customerId: string;
    customerName: string;
    phone?: string | null;
  } | null;
  onPrefillCustomerConsumed?: () => void;
}

const SchedulerWorkspace: React.FC<SchedulerWorkspaceProps> = ({
  activeSection = "scheduler",
  deepLinkAppointmentId,
  onDeepLinkAppointmentConsumed,
  prefillCustomer,
  onPrefillCustomerConsumed,
}) => {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const isCompactLayout = useMediaQuery("(max-width: 639px)");
  const wmHeaders = useMemo(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<'day' | 'week'>('day');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedAppt, setSelectedAppt] = useState<Partial<Appointment> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Appointment[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflictsRefreshKey, setConflictsRefreshKey] = useState(0);
  const searchRequestRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);
  const appointmentsRequestRef = useRef(0);
  const canMutate = hasPermission("weddings.mutate");

  const fetchAppointments = useCallback(async () => {
    const requestId = ++appointmentsRequestRef.current;
    try {
      let startStr, endStr;
      const start = new Date(selectedDate);

      if (viewMode === 'day') {
        const dateStr = localDateKey(start);
        startStr = `${dateStr}T00:00:00`;
        endStr = `${dateStr}T23:59:59`;
      } else {
        const day = start.getDay();
        const diff = start.getDate() - day + (day === 0 ? -6 : 1);
        start.setDate(diff);
        startStr = localDateKey(start) + 'T00:00:00';

        const end = new Date(start);
        end.setDate(start.getDate() + 6);
        endStr = localDateKey(end) + 'T23:59:59';
      }

      const data = await weddingApi.getAppointments({
        from: startStr,
        to: endStr,
        headers: wmHeaders,
      });
      if (requestId !== appointmentsRequestRef.current) return;
      setAppointments(data);
      setLoadError(null);
    } catch (err) {
      if (requestId !== appointmentsRequestRef.current) return;
      console.error("Failed to fetch appointments:", err);
      setLoadError("Appointments could not refresh. Check the connection and try again.");
    }
  }, [selectedDate, viewMode, wmHeaders]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) {
      setSearchResults([]);
      setSearchFailed(false);
      return;
    }
    const requestId = ++searchRequestRef.current;
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchLoading(true);
    setSearchFailed(false);
    setSearchResults([]);
    try {
      const res = await fetch(`${baseUrl}/api/weddings/appointments/search?q=${encodeURIComponent(q.trim())}`, {
        headers: wmHeaders,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Appointment search failed with status ${res.status}`);
      const rows = (await res.json()) as Record<string, unknown>[];
      if (requestId !== searchRequestRef.current) return;
      setSearchResults(rows.map(normalizeAppointmentRow));
      setSearchFailed(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (requestId !== searchRequestRef.current) return;
      setSearchResults([]);
      setSearchFailed(true);
    } finally {
      if (requestId === searchRequestRef.current) setSearchLoading(false);
      if (searchAbortRef.current === controller) searchAbortRef.current = null;
    }
  }, [wmHeaders]);

  const openAppointmentById = useCallback(async (appointmentId: string) => {
    const appt = await weddingApi.getAppointment(appointmentId, { headers: wmHeaders });
    const appointmentDate = new Date(appt.datetime);
    if (Number.isFinite(appointmentDate.getTime())) setSelectedDate(appointmentDate);
    setViewMode("day");
    setSelectedAppt(appt);
    setIsModalOpen(true);
  }, [wmHeaders]);

  useEffect(() => {
    searchRequestRef.current += 1;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    setSearchLoading(false);
    setSearchFailed(false);
    const t = setTimeout(() => {
      if (searchQuery) void runSearch(searchQuery);
      else setSearchResults([]);
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, runSearch]);

  useEffect(() => () => {
    searchRequestRef.current += 1;
    appointmentsRequestRef.current += 1;
    searchAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    fetchAppointments();
    // Manual poll as fallback (1 minute)
    const timer = setInterval(fetchAppointments, 60000);
    return () => clearInterval(timer);
  }, [fetchAppointments]);

  useEffect(() => {
    const appointmentId = deepLinkAppointmentId?.trim();
    if (!appointmentId) return;
    void (async () => {
      try {
        await openAppointmentById(appointmentId);
      } catch (err) {
        console.error("Failed to open appointment from notification:", err);
      } finally {
        onDeepLinkAppointmentConsumed?.();
      }
    })();
  }, [deepLinkAppointmentId, onDeepLinkAppointmentConsumed, openAppointmentById]);

  useEffect(() => {
    if (!prefillCustomer?.customerId) return;
    const dateStr = localDateKey(selectedDate);
    setSelectedAppt({
      datetime: `${dateStr}T10:00:00`,
      status: "Scheduled",
      customerId: prefillCustomer.customerId,
      customerName: prefillCustomer.customerName,
      customer_display_name: prefillCustomer.customerName,
      phone: prefillCustomer.phone ?? null,
      resourceIds: [],
      revision: 1,
    });
    setIsModalOpen(true);
    onPrefillCustomerConsumed?.();
  }, [onPrefillCustomerConsumed, prefillCustomer, selectedDate]);

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
    if (!canMutate) return;
    const dateStr = localDateKey(selectedDate);
    setSelectedAppt({
      datetime: `${dateStr}T${timeSlot || '10:00'}:00`,
      status: 'Scheduled'
    });
    setIsModalOpen(true);
  };

  const handleAddApptAtDate = (date: Date, timeSlot?: string) => {
    if (!canMutate) return;
    const dateStr = localDateKey(date);
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

  // Fifteen-minute booking grid, plus exact legacy/off-hours times so no appointment is hidden.
  const timeSlots = useMemo(() => {
    const slots = new Set<string>();
    for (let hour = 8; hour <= 21; hour += 1) {
      for (const minute of [0, 15, 30, 45]) {
        if (hour === 21 && minute > 0) continue;
        slots.add(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
      }
    }
    appointments.filter(isOpenAppointment).forEach((appointment) => {
      slots.add(appointmentLocalTimeKey(appointment.datetime));
    });
    return [...slots].sort();
  }, [appointments]);

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

  const selectedDayAppointments = useMemo(() => {
    const dateKey = localDateKey(selectedDate);
    return appointments.filter(
      (appointment) =>
        appointmentLocalDateKey(appointment.datetime) === dateKey &&
        isOpenAppointment(appointment),
    );
  }, [appointments, selectedDate]);

  const printableRows = useMemo<PrintableRow[]>(() => {
    if (viewMode === "day") {
      const dateStr = localDateKey(selectedDate);
      const dayRows: PrintableRow[] = [];
      timeSlots.forEach((time) => {
        const slotAppts = appointments.filter((a) => isAppointmentInSlot(a, dateStr, time) && isOpenAppointment(a));
        if (slotAppts.length === 0) {
          dayRows.push({
            key: `${selectedDate.toISOString()}:${time}`,
            time,
            customer: "—",
            type: "—",
            person: "—",
            phone: "",
            notes: "—",
          });
          return;
        }
        slotAppts.forEach((appt) => {
          dayRows.push({
            key: appt.id,
            time,
            customer: appt.customerName || appt.customer_display_name || "Customer",
            type: appt.appointment_type || appt.type || "Service",
            person: appt.salesperson || "—",
            phone: appt.phone || "",
            notes: appt.notes || appt.status || "—",
          });
        });
      });
      return dayRows;
    }

    const weekRows: PrintableRow[] = [];
    weekDates.forEach((date) => {
      const dateLabel = date.toLocaleDateString("en-US", {
        weekday: "short",
        month: "numeric",
        day: "numeric",
      });
      const dateStr = localDateKey(date);
      timeSlots.forEach((time) => {
        const slotAppts = appointments.filter((a) => isAppointmentInSlot(a, dateStr, time) && isOpenAppointment(a));
        if (slotAppts.length === 0) {
          weekRows.push({
            key: `${dateStr}:${time}:empty`,
            date: dateLabel,
            time,
            customer: "—",
            type: "—",
            person: "—",
            phone: "",
            notes: "—",
          });
          return;
        }
        slotAppts.forEach((appt) => {
          weekRows.push({
            key: appt.id,
            date: dateLabel,
            time,
            customer: appt.customerName || appt.customer_display_name || "Customer",
            type: appt.appointment_type || appt.type || "Service",
            person: appt.salesperson || "—",
            phone: appt.phone || "",
            notes: appt.notes || appt.status || "—",
          });
        });
      });
    });
    return weekRows;
  }, [appointments, selectedDate, timeSlots, viewMode, weekDates]);

  const printTitle = useMemo(() => {
    if (viewMode === "day") return formatApptDate(selectedDate);
    return `Week of ${formatApptDate(weekDates[0])} through ${formatApptDate(
      weekDates[weekDates.length - 1],
    )}`;
  }, [selectedDate, viewMode, weekDates]);

  const handlePrint = useCallback(() => {
    const head = printStyles();
    const title = printTitle;
    const includeDateColumn = viewMode === "week";
    const headers = [
      ...(includeDateColumn ? ["Date"] : []),
      "Time",
      "Customer",
      "Type",
      "Salesperson",
      "Phone",
      "Notes",
    ];
    const bodyRows = printableRows
      .map(
        (row) => `
          <tr>
            ${includeDateColumn ? `<td>${printEsc(row.date)}</td>` : ""}
            <td>${printEsc(row.time)}</td>
            <td>${printEsc(row.customer)}</td>
            <td>${printEsc(row.type)}</td>
            <td>${printEsc(row.person)}</td>
            <td>${printEsc(row.phone)}</td>
            <td>${printEsc(row.notes)}</td>
          </tr>
        `,
      )
      .join("");

    const doc = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Print Schedule</title>
          ${head}
        </head>
        <body>
          <div>
            <h1>Riverside Appointment Schedule</h1>
            <p style="font-size: 16px; font-weight: 800; letter-spacing: .18em;">PRINT SCHEDULE</p>
            <p style="font-size: 11px; color: #555; font-weight: 700; text-transform: uppercase;">${printEsc(title)}</p>
          </div>
          <table>
            <thead>
              <tr>
                ${headers.map((h) => `<th>${printEsc(h)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              ${bodyRows}
            </tbody>
          </table>
        </body>
      </html>`;

    void openPrintableHtml(doc, `Appointment Schedule ${title}`, {
      filename: `riverside-appointment-schedule-${title.replace(/[^a-z0-9]+/gi, "-")}.html`,
      width: 1100,
      height: 800,
    }).catch((error) => {
      toast(
        error instanceof Error ? error.message : "Could not open appointment schedule.",
        "error",
      );
    });
  }, [printTitle, printableRows, toast, viewMode]);

  if (activeSection === "conflicts") {
    return (
      <>
        <AppointmentConflictsPanel
          headers={wmHeaders}
          canMutate={canMutate}
          refreshKey={conflictsRefreshKey}
          onOpenAppointment={(id) => {
            void openAppointmentById(id).catch((error) => {
              toast(error instanceof Error ? error.message : "Could not open appointment.", "error");
            });
          }}
        />
        <AppointmentModal
          isOpen={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onSave={() => {
            void fetchAppointments();
            setConflictsRefreshKey((value) => value + 1);
          }}
          initialData={selectedAppt}
        />
      </>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-app-surface">
      {/* Header Controls */}
      <div className="flex flex-col gap-3 border-b border-app-border bg-app-surface-2 p-4 no-print xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
            <Calendar className="text-app-accent" size={20} />
            <div>
              <h2 className="text-lg font-black tracking-tight text-app-text uppercase italic">
                Appointment Schedule
              </h2>
              <p className="max-w-md text-[10px] font-semibold uppercase tracking-wider text-app-text-muted opacity-80">
                General store visits and services. Party-specific workflow stays in Wedding Manager unless you explicitly link a booking.
              </p>
            </div>
          </div>

            <div className="relative group/search min-w-[18rem] flex-1 xl:max-w-sm">
              <Search className={`absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transition-colors ${searchQuery ? 'text-app-accent' : 'text-app-text-muted'}`} />
              <input
                type="text"
                placeholder="Search appointments…"
                data-testid="scheduler-search-input"
                className="ui-input h-11 w-full pl-10 pr-10 text-sm font-bold"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setIsSearching(true)}
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setSearchResults([]);
                    setSearchFailed(false);
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-app-text-muted hover:text-app-text"
                >
                  <X size={14} />
                </button>
              )}

              {isSearching && searchQuery.trim() && (
                <div
                  data-testid="scheduler-search-popover"
                  className="absolute left-0 top-full z-[100] mt-2 max-h-[500px] w-[min(96vw,28rem)] overflow-y-auto rounded-2xl border border-app-border bg-app-surface p-4 text-left shadow-2xl sm:w-[min(92vw,400px)]"
                >
                  <div className="mb-3 flex items-center justify-between px-1">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Search Results</span>
                    <button onClick={() => setIsSearching(false)} className="text-app-text-muted hover:text-app-text"><X size={14}/></button>
                  </div>
                  {searchLoading ? (
                    <p className="p-4 text-center text-xs font-semibold text-app-text-muted">
                      Searching appointments…
                    </p>
                  ) : searchFailed ? (
                    <p className="rounded-xl border border-app-warning/30 bg-app-warning/10 p-4 text-center text-xs font-semibold text-app-warning">
                      Appointment search is unavailable right now.
                    </p>
                  ) : searchResults.length === 0 ? (
                    <p className="p-4 text-center text-xs text-app-text-muted italic">No matching appointments found.</p>
                  ) : (
                    <div className="space-y-2">
                      {searchResults.map(a => (
                        <div 
                          key={a.id} 
                          role="button"
                          tabIndex={0}
                          className="group/res cursor-pointer rounded-xl border border-app-border p-3 transition-all hover:border-app-accent hover:bg-app-accent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30"
                          onClick={() => {
                            const date = new Date(a.datetime);
                            setSelectedDate(date);
                            setViewMode('day');
                            setSelectedAppt(a);
                            setIsModalOpen(true);
                            setIsSearching(false);
                          }}
                          onKeyDown={(event) =>
                            activateOnEnterOrSpace(event, () => {
                              const date = new Date(a.datetime);
                              setSelectedDate(date);
                              setViewMode('day');
                              setSelectedAppt(a);
                              setIsModalOpen(true);
                              setIsSearching(false);
                            })
                          }
                        >
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="text-xs font-black uppercase text-app-text">{a.customerName || a.customer_display_name || 'Anonymous'}</div>
                              <div className="mt-0.5 text-[9px] font-bold text-app-text-muted">
                                {new Date(a.datetime).toLocaleDateString()} @ {new Date(a.datetime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {a.type || a.appointment_type}
                              </div>
                            </div>
                            <div className="text-[9px] font-black uppercase text-app-accent opacity-0 transition-opacity group-hover/res:opacity-100">Open →</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-app-border bg-app-surface p-1 shadow-sm">
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
              className="min-w-0 bg-transparent px-3 text-xs font-bold text-app-text outline-none"
              value={localDateKey(selectedDate)}
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
            
            <div className="flex rounded-md border border-app-border bg-app-surface-2 p-0.5">
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
            className="ui-touch-target inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-accent transition-colors hover:bg-app-surface-2"
          >
            Today
          </button>
          </div>
        </div>

        <div className="flex w-full flex-wrap gap-2 xl:w-auto">
          <button
            type="button"
            onClick={handlePrint}
            className="ui-touch-target flex min-h-[44px] items-center gap-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-all hover:bg-app-surface-2 hover:text-app-text"
          >
            <Printer size={14} /> Print Schedule
          </button>
          {canMutate ? <button
            type="button"
            onClick={() => handleAddAppt()}
            className="flex min-h-[44px] min-w-[44px] items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-emerald-600/20 transition-all hover:bg-emerald-500 active:scale-95"
          >
            <Plus size={14} strokeWidth={3} /> New Appt
          </button> : null}
        </div>
      </div>

      {/* Main Grid */}
      <div className="flex-1 overflow-auto no-scrollbar bg-app-bg/50 p-4 print:p-0">
        {loadError ? (
          <div className="mx-auto mb-4 max-w-5xl rounded-xl border border-app-warning/30 bg-app-warning/10 px-4 py-3 text-sm font-semibold text-app-warning">
            {loadError}
          </div>
        ) : null}
        {viewMode === 'day' ? (
          <div className="mx-auto max-w-5xl rounded-2xl border border-app-border bg-app-surface shadow-2xl shadow-black/10 overflow-hidden print:border-0 print:shadow-none">
            {!loadError && selectedDayAppointments.length === 0 ? (
              <div className="flex flex-col gap-3 border-b border-app-border bg-app-surface-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-black text-app-text">
                    No appointments scheduled for this day
                  </p>
                  <p className="mt-1 text-sm text-app-text-muted">
                    Choose any time slot below or create an appointment now.
                  </p>
                </div>
                {canMutate ? <button
                  type="button"
                  onClick={() => handleAddApptAtDate(selectedDate, "09:00")}
                  className="ui-btn-primary inline-flex items-center justify-center gap-2"
                >
                  <Plus size={16} aria-hidden />
                  New Appointment
                </button> : null}
              </div>
            ) : null}
            <div className={`grid ${isCompactLayout ? "grid-cols-[72px_1fr]" : "grid-cols-[100px_1fr]"} divide-y divide-app-border/40`}>
              {timeSlots.map(time => {
                const dateStr = localDateKey(selectedDate);
                const slotAppts = appointments.filter(a => isAppointmentInSlot(a, dateStr, time) && isOpenAppointment(a));
                const hour = parseInt(time.split(':')[0]);
                const displayTime = `${hour > 12 ? hour - 12 : hour}:${time.split(':')[1]} ${hour >= 12 ? 'PM' : 'AM'}`;

                return (
                  <div key={time} className="contents group">
                    <div className="flex items-center justify-end border-r border-app-border/40 bg-app-surface-2 p-4 text-[10px] font-black tracking-widest text-app-text-muted opacity-60">
                      {displayTime}
                    </div>
                    <div
                      tabIndex={canMutate ? 0 : -1}
                      aria-label={canMutate ? `Add appointment at ${displayTime}` : undefined}
                      className={`min-h-[80px] p-2 flex gap-2 overflow-x-auto no-scrollbar transition-colors relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent/30 ${canMutate ? "cursor-pointer hover:bg-app-surface-2/30" : ""}`}
                      onClick={() => canMutate && handleAddApptAtDate(selectedDate, time)}
                      onKeyDown={(event) =>
                        canMutate && activateOnEnterOrSpace(event, () => handleAddApptAtDate(selectedDate, time))
                      }
                    >
                      {slotAppts.map(appt => (
                        <AppointmentCard key={appt.id} appt={appt} onEdit={handleEditAppt} />
                      ))}
                      {canMutate ? <div className="opacity-0 group-hover:opacity-100 flex items-center justify-center border-2 border-dashed border-app-border rounded-xl w-12 shrink-0 transition-opacity print:hidden">
                        <Plus size={20} className="text-app-text-muted" />
                      </div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            data-testid="scheduler-week-grid-shell"
            className="w-full min-w-0 overflow-x-auto overscroll-x-contain rounded-2xl border border-app-border bg-app-surface shadow-2xl shadow-black/10 print:border-0 [-webkit-overflow-scrolling:touch]"
          >
            <div className="min-w-[420px] overflow-hidden sm:min-w-[560px] md:min-w-[740px] xl:min-w-[940px]">
             {/* Week Grid Header */}
             <div className={`sticky top-0 z-10 grid ${isCompactLayout ? "grid-cols-[72px_repeat(7,minmax(84px,1fr))]" : "grid-cols-[100px_repeat(7,1fr)]"} border-b border-app-border bg-app-surface-2`}>
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
             <div className={`grid ${isCompactLayout ? "grid-cols-[72px_repeat(7,minmax(84px,1fr))]" : "grid-cols-[100px_repeat(7,1fr)]"} divide-y divide-app-border/40`}>
                {timeSlots.map(time => {
                    const hour = parseInt(time.split(':')[0]);
                    const displayTime = `${hour > 12 ? hour - 12 : hour}:${time.split(':')[1]} ${hour >= 12 ? 'PM' : 'AM'}`;

                    return (
                        <React.Fragment key={time}>
                            <div
                                data-testid="scheduler-week-time-cell"
                                className="sticky left-0 z-[1] flex items-center justify-end border-r border-app-border/40 bg-app-surface-2 p-4 text-[10px] font-black tracking-widest text-app-text-muted opacity-60"
                            >
                                {displayTime}
                            </div>
                            {weekDates.map(date => {
                                const dateStr = localDateKey(date);
                                const slotAppts = appointments.filter(a => isAppointmentInSlot(a, dateStr, time) && isOpenAppointment(a));
                                const isToday = date.toDateString() === new Date().toDateString();

                                return (
                                    <div 
                                        key={`${dateStr}-${time}`} 
                                        tabIndex={canMutate ? 0 : -1}
                                        aria-label={canMutate ? `Add appointment on ${date.toLocaleDateString()} at ${displayTime}` : undefined}
                                        className={`min-h-[100px] p-2 flex flex-col gap-2 border-r border-app-border/40 transition-colors group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-app-accent/30 ${canMutate ? "cursor-pointer hover:bg-app-surface-2/30" : ""} ${isToday ? 'bg-app-accent/[0.02]' : ''}`}
                                        onClick={() => canMutate && handleAddApptAtDate(date, time)}
                                        onKeyDown={(event) =>
                                          canMutate && activateOnEnterOrSpace(event, () => handleAddApptAtDate(date, time))
                                        }
                                    >
                                        {slotAppts.map(appt => (
                                            <div key={appt.id} className="w-full">
                                                <AppointmentCard appt={appt} onEdit={handleEditAppt} isCompact />
                                            </div>
                                        ))}
                                        {canMutate ? <div className="mt-auto opacity-0 group-hover:opacity-100 flex items-center justify-center border border-dashed border-app-border/60 rounded-lg py-1 transition-opacity print:hidden">
                                            <Plus size={14} className="text-app-text-muted" />
                                        </div> : null}
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

    </div>
  );
};

const AppointmentConflictsPanel: React.FC<{
  headers: Record<string, string>;
  canMutate: boolean;
  refreshKey: number;
  onOpenAppointment: (id: string) => void;
}> = ({ headers, canMutate, refreshKey, onOpenAppointment }) => {
  const { toast } = useToast();
  const initialFrom = useMemo(() => localDateKey(new Date()), []);
  const initialTo = useMemo(() => {
    const value = new Date();
    value.setDate(value.getDate() + 90);
    return localDateKey(value);
  }, []);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [conflicts, setConflicts] = useState<AppointmentConflict[]>([]);
  const [resources, setResources] = useState<AppointmentResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState({ id: "", name: "", capacity: 1, notes: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [conflictRows, resourceRows] = await Promise.all([
        weddingApi.getAppointmentConflicts({
          from: `${from}T00:00:00`,
          to: `${to}T23:59:59`,
          headers,
        }),
        weddingApi.getAppointmentResources({ headers }),
      ]);
      setConflicts(conflictRows);
      setResources(resourceRows);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load appointment conflicts.", "error");
    } finally {
      setLoading(false);
    }
  }, [from, headers, to, toast]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  const saveResource = async () => {
    if (!draft.name.trim()) {
      toast("Resource name is required.", "error");
      return;
    }
    try {
      await weddingApi.saveAppointmentResource(
        {
          id: draft.id || undefined,
          name: draft.name,
          capacity: draft.capacity,
          notes: draft.notes,
        },
        { headers },
      );
      setDraft({ id: "", name: "", capacity: 1, notes: "" });
      await load();
      toast("Appointment resource saved.", "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save resource.", "error");
    }
  };

  return (
    <div className="flex flex-1 flex-col gap-5 bg-app-bg p-4 sm:p-6">
      <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-lg">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="text-app-warning" size={20} />
              <h2 className="text-lg font-black uppercase tracking-tight text-app-text">Appointment Conflicts</h2>
            </div>
            <p className="mt-1 text-sm text-app-text-muted">Staff overlaps and resource capacity conflicts from the authoritative ROS calendar.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              From
              <input className="ui-input mt-1 block" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Through
              <input className="ui-input mt-1 block" type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
        </div>
        <div className="mt-5 space-y-2">
          {loading ? <p className="text-sm text-app-text-muted">Checking schedules…</p> : null}
          {!loading && conflicts.length === 0 ? (
            <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-700 dark:text-emerald-200">No unresolved overlaps in this range.</p>
          ) : null}
          {conflicts.map((conflict) => (
            <button
              key={conflict.appointment_id}
              type="button"
              onClick={() => onOpenAppointment(conflict.appointment_id)}
              className="flex w-full flex-col gap-1 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-left hover:bg-red-500/10 sm:flex-row sm:items-center sm:justify-between"
            >
              <span>
                <span className="block text-sm font-black text-app-text">{conflict.customer_display_name || "One-off visit"} · {conflict.appointment_type}</span>
                <span className="text-xs text-app-text-muted">{new Date(conflict.starts_at).toLocaleString()}–{new Date(conflict.ends_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
              </span>
              <span className="text-xs font-bold text-red-700 dark:text-red-200">{[conflict.salesperson, ...conflict.resource_names].filter(Boolean).join(" · ") || "Open conflict"}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-app-border bg-app-surface p-5 shadow-lg">
        <h3 className="text-base font-black uppercase tracking-tight text-app-text">Rooms & Resources</h3>
        <p className="mt-1 text-sm text-app-text-muted">Capacity determines how many overlapping appointments may reserve a resource.</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr]">
          <div className="space-y-2">
            {resources.length === 0 ? <p className="text-sm text-app-text-muted">No appointment resources configured.</p> : null}
            {resources.map((resource) => (
              <button
                key={resource.id}
                type="button"
                disabled={!canMutate}
                onClick={() => setDraft({ id: resource.id, name: resource.name, capacity: resource.capacity, notes: resource.notes ?? "" })}
                className="flex w-full items-center justify-between rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-left disabled:cursor-default"
              >
                <span className="font-bold text-app-text">{resource.name}</span>
                <span className="text-xs text-app-text-muted">Capacity {resource.capacity}</span>
              </button>
            ))}
          </div>
          {canMutate ? (
            <div className="space-y-3 rounded-xl border border-app-border bg-app-surface-2 p-4">
              <input className="ui-input w-full" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Resource name" />
              <input className="ui-input w-full" type="number" min={1} max={50} value={draft.capacity} onChange={(event) => setDraft({ ...draft, capacity: Number(event.target.value) })} aria-label="Resource capacity" />
              <textarea className="ui-input min-h-[5rem] w-full" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Optional notes" />
              <div className="flex justify-end gap-2">
                {draft.id ? <button type="button" className="ui-btn-secondary" onClick={() => setDraft({ id: "", name: "", capacity: 1, notes: "" })}>New Resource</button> : null}
                <button type="button" className="ui-btn-primary" onClick={() => void saveResource()}>Save Resource</button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
};

const AppointmentCard: React.FC<{ appt: Appointment; onEdit: (a: Appointment) => void; isCompact?: boolean }> = ({ appt, onEdit, isCompact }) => {
  const appointmentType = appt.type || appt.appointment_type || "Service";
  const normalizedType = appointmentType.toLowerCase();
  const customerName = appt.customerName || appt.customer_display_name || "Anonymous";
  const isMeasurement = normalizedType === 'measurement';
  const isFitting = normalizedType === 'fitting';
  const isPickup = normalizedType === 'pickup';
  const timeRange = `${new Date(appt.datetime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${appt.endsAt ? `–${new Date(appt.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`;
  
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
      tabIndex={0}
      aria-label={`Edit ${customerName} ${appointmentType} appointment`}
      onClick={(e) => { e.stopPropagation(); onEdit(appt); }}
      onKeyDown={(event) => activateOnEnterOrSpace(event, () => onEdit(appt))}
      className={`group/card relative flex flex-col justify-between rounded-xl border-l-[6px] p-3 shadow-md transition-all hover:-translate-y-0.5 hover:shadow-lg active:scale-[0.98] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${isCompact ? 'min-w-0 max-w-full' : 'min-w-[180px] max-w-[240px]'} ${colorClass}`}
    >
      <div className="min-w-0">
        <h4 className="truncate text-xs font-black uppercase tracking-tight">{customerName}</h4>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold opacity-80">
          {icon} <span>{appointmentType} · {timeRange}</span>
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
      
    </div>
  );
};

export default SchedulerWorkspace;
