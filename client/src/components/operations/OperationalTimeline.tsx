import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  ListFilter,
  Package,
  ReceiptText,
  Scissors,
  Search,
  ShoppingBag,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { OperationsCenterNavigateTarget } from "./RosOperationsCenter";

type TimelineView = "agenda" | "week" | "month" | "workload";
type TimelineFilter =
  | "all"
  | "appointments"
  | "weddings"
  | "pickups"
  | "alterations"
  | "tasks"
  | "accounting"
  | "receiving"
  | "inventory"
  | "alerts"
  | "overdue"
  | "today"
  | "manager";
type TimelineSeverity = "critical" | "warning" | "normal" | "done";
type TimelineSource =
  | "appointment"
  | "wedding"
  | "pickup"
  | "alteration"
  | "task"
  | "accounting"
  | "receiving"
  | "inventory"
  | "alert"
  | "register";

export interface TimelineAppointment {
  id: string;
  datetime: string;
  status: string;
  type?: string | null;
  customerName?: string | null;
  customer_display_name?: string | null;
  appointment_type?: string | null;
  salesperson?: string | null;
  partyId?: string | null;
}

export interface TimelineFulfillmentItem {
  order_id: string;
  urgency: "rush" | "due_soon" | "standard" | "blocked" | "ready";
  balance_due: number;
  next_deadline?: string | null;
  wedding_party_id?: string | null;
  wedding_party_name?: string | null;
}

export interface TimelineAlterationItem {
  id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  status: string;
  due_at: string | null;
  item_description: string | null;
  work_requested: string | null;
}

export interface TimelineTaskItem {
  id: string;
  title_snapshot: string;
  due_date: string | null;
  assignee_name?: string | null;
}

export interface TimelineNotificationItem {
  id?: string;
  staff_notification_id?: string;
  notification_id?: string;
  title: string;
  body?: string | null;
  kind: string;
  severity?: string | null;
  created_at: string;
  completed_at?: string | null;
  archived_at?: string | null;
}

export interface TimelineRegisterSession {
  session_id: string;
  register_lane: number;
  cashier_name: string;
  opened_at: string;
  lifecycle_status: string;
}

export interface TimelineWeddingAction {
  id?: string;
  party_id?: string | null;
  party_name?: string | null;
  customer_name?: string | null;
  event_date?: string | null;
}

export interface TimelineRushOrder {
  order_id: string;
  customer_name: string;
  need_by_date?: string | null;
  total_price?: string | null;
}

export interface TimelineCompass {
  needs_measure?: TimelineWeddingAction[];
  needs_order?: TimelineWeddingAction[];
  overdue_pickups?: TimelineWeddingAction[];
  rush_orders?: TimelineRushOrder[];
}

export interface TimelineQboRow {
  id: string;
  sync_date: string;
  status: string;
  error_message?: string | null;
  payload?: Record<string, unknown>;
}

export interface TimelinePurchaseOrder {
  id: string;
  po_number: string;
  vendor_name: string;
  status: string;
  expected_at?: string | null;
}

export interface TimelinePhysicalSession {
  id: string;
  session_number: string;
  status: string;
  started_at: string;
  last_saved_at?: string | null;
}

export interface OperationalTimelineProps {
  appointments: TimelineAppointment[];
  fulfillmentQueue: TimelineFulfillmentItem[];
  alterationsQueue: TimelineAlterationItem[];
  tasks: TimelineTaskItem[];
  notifications: TimelineNotificationItem[];
  registerSessions: TimelineRegisterSession[];
  compass: TimelineCompass | null;
  qboStaging: TimelineQboRow[];
  purchaseOrders: TimelinePurchaseOrder[];
  physicalSessions: TimelinePhysicalSession[];
  feedErrors?: string[];
  onNavigate: (target: OperationsCenterNavigateTarget) => void;
  onOpenWeddingParty: (partyId: string) => void;
  onOpenTransaction: (orderId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAlerts: () => void;
}

interface TimelineItem {
  id: string;
  source: TimelineSource;
  title: string;
  detail: string;
  startsAt: Date;
  severity: TimelineSeverity;
  owner?: string | null;
  managerOnly?: boolean;
  group: string;
  onOpen: () => void;
}

const MS_PER_DAY = 86_400_000;
const AGENDA_ITEM_LIMIT = 80;
const AGENDA_DAY_GROUP_LIMIT = 18;
const WORKLOAD_PREVIEW_LIMIT = 10;

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseOperationalDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const parsed =
    /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
      ? new Date(`${trimmed}T09:00:00`)
      : new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dayDelta(date: Date, now = new Date()): number {
  return Math.round((startOfLocalDay(date).getTime() - startOfLocalDay(now).getTime()) / MS_PER_DAY);
}

function urgencyFor(date: Date, fallback: TimelineSeverity = "normal"): TimelineSeverity {
  const delta = dayDelta(date);
  if (delta < 0) return "critical";
  if (delta <= 1) return "warning";
  return fallback;
}

function statusLabel(item: TimelineItem): string {
  const delta = dayDelta(item.startsAt);
  if (delta < 0) return `${Math.abs(delta)}d overdue`;
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  return `${delta}d out`;
}

function sourceLabel(source: TimelineSource): string {
  switch (source) {
    case "appointment":
      return "Appointment";
    case "wedding":
      return "Wedding";
    case "pickup":
      return "Pickup";
    case "alteration":
      return "Alteration";
    case "task":
      return "Task";
    case "accounting":
      return "QBO";
    case "receiving":
      return "Receiving";
    case "inventory":
      return "Inventory";
    case "register":
      return "Register";
    default:
      return "Alert";
  }
}

function sourceIcon(source: TimelineSource) {
  switch (source) {
    case "appointment":
      return CalendarDays;
    case "wedding":
      return Users;
    case "pickup":
      return ShoppingBag;
    case "alteration":
      return Scissors;
    case "task":
      return ClipboardCheck;
    case "accounting":
      return ReceiptText;
    case "receiving":
      return Package;
    case "inventory":
      return ListFilter;
    case "register":
      return CheckCircle2;
    default:
      return AlertCircle;
  }
}

function severityClass(severity: TimelineSeverity): string {
  if (severity === "critical") return "border-app-danger/35 bg-app-danger/10 text-app-danger";
  if (severity === "warning") return "border-app-warning/35 bg-app-warning/10 text-app-warning";
  if (severity === "done") return "border-app-success/30 bg-app-success/10 text-app-success";
  return "border-app-border bg-app-surface-2 text-app-text-muted";
}

function itemRailClass(severity: TimelineSeverity): string {
  if (severity === "critical") return "bg-app-danger";
  if (severity === "warning") return "bg-app-warning";
  if (severity === "done") return "bg-app-success";
  return "bg-app-accent";
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDay(date: Date): string {
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function customerNameForAlteration(row: TimelineAlterationItem): string {
  return `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim() || "Alteration customer";
}

function qboWarningCount(row: TimelineQboRow): number {
  const warnings = row.payload?.warnings;
  return Array.isArray(warnings) ? warnings.length : 0;
}

function buildMonthDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

export default function OperationalTimeline({
  appointments,
  fulfillmentQueue,
  alterationsQueue,
  tasks,
  notifications,
  registerSessions,
  compass,
  qboStaging,
  purchaseOrders,
  physicalSessions,
  feedErrors = [],
  onNavigate,
  onOpenWeddingParty,
  onOpenTransaction,
  onOpenTask,
  onOpenAlerts,
}: OperationalTimelineProps) {
  const [view, setView] = useState<TimelineView>("agenda");
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [query, setQuery] = useState("");
  const [anchorDate, setAnchorDate] = useState(() => startOfLocalDay(new Date()));

  const allItems = useMemo<TimelineItem[]>(() => {
    const rows: TimelineItem[] = [];

    for (const appointment of appointments) {
      const date = parseOperationalDate(appointment.datetime);
      if (!date) continue;
      rows.push({
        id: `appointment-${appointment.id}`,
        source: "appointment",
        title: appointment.customerName ?? appointment.customer_display_name ?? "Appointment",
        detail: `${appointment.type ?? appointment.appointment_type ?? "Appointment"} · ${formatTime(date)}`,
        startsAt: date,
        severity: appointment.status.toLowerCase().includes("cancel") ? "done" : urgencyFor(date),
        owner: appointment.salesperson,
        group: "Customer schedule",
        onOpen: () => onNavigate({ tab: "appointments", section: "scheduler" }),
      });
    }

    for (const item of fulfillmentQueue) {
      const date = parseOperationalDate(item.next_deadline);
      if (!date) continue;
      rows.push({
        id: `pickup-${item.order_id}`,
        source: "pickup",
        title: item.wedding_party_name ?? "Pickup commitment",
        detail: `${item.urgency.replace(/_/g, " ")} · ${item.balance_due > 0 ? "balance due" : "balance clear"}`,
        startsAt: date,
        severity: item.urgency === "blocked" ? "critical" : item.urgency === "rush" ? "warning" : urgencyFor(date),
        managerOnly: item.balance_due > 0 || item.urgency === "blocked",
        group: "Fulfillment",
        onOpen: () => onOpenTransaction(item.order_id),
      });
    }

    for (const row of alterationsQueue) {
      const date = parseOperationalDate(row.due_at);
      if (!date || row.status === "picked_up") continue;
      rows.push({
        id: `alteration-${row.id}`,
        source: "alteration",
        title: customerNameForAlteration(row),
        detail: `${row.item_description ?? "Garment"} · ${row.status.replace(/_/g, " ")}`,
        startsAt: date,
        severity: row.status === "ready" ? "done" : urgencyFor(date),
        group: "Tailoring",
        onOpen: () => onNavigate({ tab: "alterations", section: "queue" }),
      });
    }

    for (const task of tasks) {
      const date = parseOperationalDate(task.due_date);
      if (!date) continue;
      rows.push({
        id: `task-${task.id}`,
        source: "task",
        title: task.title_snapshot,
        detail: task.assignee_name ? `Assigned to ${task.assignee_name}` : "Open shift task",
        startsAt: date,
        severity: urgencyFor(date),
        owner: task.assignee_name,
        group: "Staff follow-up",
        onOpen: () => onOpenTask(task.id),
      });
    }

    for (const row of compass?.needs_measure ?? []) {
      const date = parseOperationalDate(row.event_date);
      if (!date) continue;
      rows.push({
        id: `wedding-measure-${row.id ?? row.party_id ?? row.customer_name}`,
        source: "wedding",
        title: row.customer_name ?? "Wedding measurement",
        detail: `${row.party_name ?? "Wedding party"} · needs measurements`,
        startsAt: date,
        severity: urgencyFor(date, "warning"),
        group: "Wedding readiness",
        onOpen: () => row.party_id ? onOpenWeddingParty(row.party_id) : onNavigate({ tab: "weddings" }),
      });
    }

    for (const row of compass?.needs_order ?? []) {
      const date = parseOperationalDate(row.event_date);
      if (!date) continue;
      rows.push({
        id: `wedding-order-${row.id ?? row.party_id ?? row.customer_name}`,
        source: "wedding",
        title: row.customer_name ?? "Wedding order",
        detail: `${row.party_name ?? "Wedding party"} · needs ordering`,
        startsAt: date,
        severity: urgencyFor(date, "warning"),
        managerOnly: true,
        group: "Wedding readiness",
        onOpen: () => row.party_id ? onOpenWeddingParty(row.party_id) : onNavigate({ tab: "weddings" }),
      });
    }

    for (const row of compass?.overdue_pickups ?? []) {
      const date = parseOperationalDate(row.event_date);
      if (!date) continue;
      rows.push({
        id: `wedding-pickup-${row.id ?? row.party_id ?? row.customer_name}`,
        source: "wedding",
        title: row.customer_name ?? "Wedding pickup",
        detail: `${row.party_name ?? "Wedding party"} · overdue pickup`,
        startsAt: date,
        severity: "critical",
        managerOnly: true,
        group: "Wedding pickups",
        onOpen: () => row.party_id ? onOpenWeddingParty(row.party_id) : onNavigate({ tab: "weddings" }),
      });
    }

    for (const row of compass?.rush_orders ?? []) {
      const date = parseOperationalDate(row.need_by_date);
      if (!date) continue;
      rows.push({
        id: `rush-order-${row.order_id}`,
        source: "pickup",
        title: `Rush order · ${row.customer_name}`,
        detail: row.total_price ? `Need-by commitment · $${row.total_price}` : "Need-by commitment",
        startsAt: date,
        severity: urgencyFor(date, "warning"),
        managerOnly: true,
        group: "Rush work",
        onOpen: () => onOpenTransaction(row.order_id),
      });
    }

    for (const row of qboStaging) {
      const date = parseOperationalDate(row.sync_date);
      if (!date) continue;
      const warnings = qboWarningCount(row);
      const status = row.status.toLowerCase();
      const needsReview = status === "pending" || status === "approved" || status === "failed" || warnings > 0;
      if (!needsReview) continue;
      rows.push({
        id: `qbo-${row.id}`,
        source: "accounting",
        title: `QBO ${row.status}`,
        detail: warnings > 0 ? `${warnings} review item${warnings === 1 ? "" : "s"}` : row.error_message ?? "Accounting review",
        startsAt: date,
        severity: status === "failed" ? "critical" : warnings > 0 || status === "pending" ? "warning" : "normal",
        managerOnly: true,
        group: "Accounting",
        onOpen: () => onNavigate({ tab: "qbo", section: "staging" }),
      });
    }

    for (const po of purchaseOrders) {
      const date = parseOperationalDate(po.expected_at);
      if (!date || po.status === "closed" || po.status === "cancelled") continue;
      rows.push({
        id: `po-${po.id}`,
        source: "receiving",
        title: po.po_number,
        detail: `${po.vendor_name} · ${po.status.replace(/_/g, " ")}`,
        startsAt: date,
        severity: urgencyFor(date),
        group: "Receiving",
        onOpen: () => onNavigate({ tab: "inventory", section: "receiving" }),
      });
    }

    for (const session of physicalSessions) {
      const date = parseOperationalDate(session.last_saved_at ?? session.started_at);
      if (!date || session.status === "published" || session.status === "cancelled") continue;
      rows.push({
        id: `physical-${session.id}`,
        source: "inventory",
        title: `Physical count ${session.session_number}`,
        detail: session.status.replace(/_/g, " "),
        startsAt: date,
        severity: session.status === "reviewing" ? "warning" : "normal",
        managerOnly: true,
        group: "Inventory count",
        onOpen: () => onNavigate({ tab: "inventory", section: "physical" }),
      });
    }

    for (const session of registerSessions) {
      const date = parseOperationalDate(session.opened_at);
      if (!date) continue;
      rows.push({
        id: `register-${session.session_id}`,
        source: "register",
        title: `Register #${session.register_lane}`,
        detail: `${session.cashier_name} · ${session.lifecycle_status.replace(/_/g, " ")}`,
        startsAt: date,
        severity: session.lifecycle_status === "reconciling" ? "warning" : "normal",
        managerOnly: true,
        group: "Register close",
        onOpen: () => onNavigate({ tab: "home", section: "daily-sales" }),
      });
    }

    for (const notification of notifications) {
      if (notification.completed_at || notification.archived_at) continue;
      const date = parseOperationalDate(notification.created_at);
      if (!date) continue;
      const kind = notification.kind.toLowerCase();
      const notificationId =
        notification.id ?? notification.staff_notification_id ?? notification.notification_id;
      rows.push({
        id: `alert-${notificationId}`,
        source: "alert",
        title: notification.title,
        detail: notification.body ?? notification.kind.replace(/_/g, " "),
        startsAt: date,
        severity:
          notification.severity === "critical" || kind.includes("failed") || kind.includes("negative")
            ? "critical"
            : "warning",
        group: "Operational alerts",
        onOpen: onOpenAlerts,
      });
    }

    return rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }, [
    appointments,
    fulfillmentQueue,
    alterationsQueue,
    tasks,
    compass,
    qboStaging,
    purchaseOrders,
    physicalSessions,
    registerSessions,
    notifications,
    onNavigate,
    onOpenWeddingParty,
    onOpenTransaction,
    onOpenTask,
    onOpenAlerts,
  ]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const todayKey = localDateKey(new Date());
    return allItems.filter((item) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "appointments" && item.source === "appointment") ||
        (filter === "weddings" && item.source === "wedding") ||
        (filter === "pickups" && item.source === "pickup") ||
        (filter === "alterations" && item.source === "alteration") ||
        (filter === "tasks" && item.source === "task") ||
        (filter === "accounting" && item.source === "accounting") ||
        (filter === "receiving" && item.source === "receiving") ||
        (filter === "inventory" && item.source === "inventory") ||
        (filter === "alerts" && item.source === "alert") ||
        (filter === "overdue" && dayDelta(item.startsAt) < 0) ||
        (filter === "today" && localDateKey(item.startsAt) === todayKey) ||
        (filter === "manager" && item.managerOnly === true);
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [item.title, item.detail, item.group, item.owner, sourceLabel(item.source)]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [allItems, filter, query]);

  const visibleItems = useMemo(() => {
    if (view === "agenda" || view === "workload") return filteredItems.slice(0, AGENDA_ITEM_LIMIT);
    if (view === "week") {
      const start = startOfLocalDay(anchorDate);
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return filteredItems.filter((item) => item.startsAt >= start && item.startsAt < end);
    }
    const monthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    const monthEnd = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 1);
    return filteredItems.filter((item) => item.startsAt >= monthStart && item.startsAt < monthEnd);
  }, [anchorDate, filteredItems, view]);

  const stats = useMemo(() => {
    const todayKey = localDateKey(new Date());
    return {
      today: allItems.filter((item) => localDateKey(item.startsAt) === todayKey).length,
      overdue: allItems.filter((item) => dayDelta(item.startsAt) < 0).length,
      manager: allItems.filter((item) => item.managerOnly).length,
      critical: allItems.filter((item) => item.severity === "critical").length,
    };
  }, [allItems]);

  const workloadBySource = useMemo(() => {
    const counts = new Map<TimelineSource, number>();
    for (const item of filteredItems) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
  }, [filteredItems]);

  const dayItems = useMemo(() => {
    const grouped = new Map<string, TimelineItem[]>();
    for (const item of visibleItems) {
      const key = localDateKey(item.startsAt);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    return grouped;
  }, [visibleItems]);

  const agendaDayEntries = useMemo(
    () => Array.from(dayItems.entries()),
    [dayItems],
  );

  const hiddenResultCount =
    view === "agenda" || view === "workload"
      ? Math.max(0, filteredItems.length - visibleItems.length)
      : 0;
  const hiddenAgendaDayCount =
    view === "agenda"
      ? Math.max(0, agendaDayEntries.length - AGENDA_DAY_GROUP_LIMIT)
      : 0;

  const filters: { id: TimelineFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "today", label: "Today" },
    { id: "overdue", label: "Overdue" },
    { id: "manager", label: "Manager" },
    { id: "appointments", label: "Appointments" },
    { id: "weddings", label: "Weddings" },
    { id: "pickups", label: "Pickups" },
    { id: "alterations", label: "Alterations" },
    { id: "tasks", label: "Tasks" },
    { id: "accounting", label: "QBO" },
    { id: "receiving", label: "Receiving" },
    { id: "inventory", label: "Inventory" },
    { id: "alerts", label: "Alerts" },
  ];

  const moveAnchor = (days: number) => {
    setAnchorDate((current) => {
      const next = new Date(current);
      next.setDate(current.getDate() + days);
      return next;
    });
  };

  const renderItem = (item: TimelineItem, compact = false) => {
    const Icon = sourceIcon(item.source);
    return (
      <button
        type="button"
        key={item.id}
        onClick={item.onOpen}
        className={`group relative flex w-full min-w-0 items-start gap-3 rounded-xl border bg-app-surface px-3 py-3 text-left shadow-sm transition-colors hover:border-app-input-border hover:bg-app-surface-2 ${compact ? "py-2" : ""}`}
      >
        <span className={`absolute left-0 top-3 h-[calc(100%-1.5rem)] w-1 rounded-r-full ${itemRailClass(item.severity)}`} />
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${severityClass(item.severity)}`}>
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-black text-app-text">{item.title}</span>
            <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-text-muted">
              {sourceLabel(item.source)}
            </span>
            {item.managerOnly ? (
              <span className="rounded-full border border-app-warning/25 bg-app-warning/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-warning">
                Manager
              </span>
            ) : null}
          </span>
          <span className="mt-1 block line-clamp-2 text-[11px] font-semibold leading-relaxed text-app-text-muted">
            {item.detail}
          </span>
          <span className="mt-2 flex items-center justify-between gap-3 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
            <span>{formatDay(item.startsAt)} · {formatTime(item.startsAt)}</span>
            <span>{statusLabel(item)}</span>
          </span>
        </span>
        <ChevronRight size={15} className="mt-1 shrink-0 text-app-text-muted opacity-40 transition-transform group-hover:translate-x-0.5" />
      </button>
    );
  };

  return (
    <div className="flex flex-1 flex-col bg-app-bg">
      <div className="space-y-5 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-3xl">
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
              Operations
            </p>
            <h2 className="mt-1 text-3xl font-black tracking-tight text-app-text">
              Operational Timeline
            </h2>
            <p className="mt-2 text-sm font-semibold leading-relaxed text-app-text-muted">
              One planning surface for appointments, wedding readiness, pickup commitments, tailoring due dates, tasks, receiving, inventory counts, QBO review, alerts, and register close work.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:w-[520px]">
            <MetricTile label="Today" value={stats.today} tone={stats.today > 0 ? "normal" : "muted"} />
            <MetricTile label="Overdue" value={stats.overdue} tone={stats.overdue > 0 ? "critical" : "muted"} />
            <MetricTile label="Manager" value={stats.manager} tone={stats.manager > 0 ? "warning" : "muted"} />
            <MetricTile label="Critical" value={stats.critical} tone={stats.critical > 0 ? "critical" : "muted"} />
          </div>
        </div>

        {feedErrors.length > 0 ? (
          <div
            data-testid="timeline-feed-warning"
            className="rounded-xl border border-app-warning/30 bg-app-warning/10 px-4 py-3 text-sm font-semibold text-app-text"
          >
            <p>Some source feeds did not refresh. Treat the timeline as partial until the marked workflow loads.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs font-semibold text-app-text-muted">
              {feedErrors.slice(0, 5).map((message) => (
                <li key={message}>{message}</li>
              ))}
              {feedErrors.length > 5 ? <li>{feedErrors.length - 5} more source warnings</li> : null}
            </ul>
          </div>
        ) : null}

        <div className="rounded-2xl border border-app-border bg-app-surface p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {(["agenda", "week", "month", "workload"] as TimelineView[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  className={`rounded-lg border px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
                    view === mode
                      ? "border-app-accent bg-app-accent/10 text-app-accent"
                      : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface-3"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {(view === "week" || view === "month") ? (
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => moveAnchor(view === "week" ? -7 : -30)} className="rounded-lg border border-app-border px-3 py-2 text-xs font-black text-app-text-muted hover:bg-app-surface-2">
                    Prev
                  </button>
                  <button type="button" onClick={() => setAnchorDate(startOfLocalDay(new Date()))} className="rounded-lg border border-app-border px-3 py-2 text-xs font-black text-app-text-muted hover:bg-app-surface-2">
                    Today
                  </button>
                  <button type="button" onClick={() => moveAnchor(view === "week" ? 7 : 30)} className="rounded-lg border border-app-border px-3 py-2 text-xs font-black text-app-text-muted hover:bg-app-surface-2">
                    Next
                  </button>
                </div>
              ) : null}
              <div className="relative min-w-0 sm:w-72">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Find customer, source, or owner"
                  className="ui-input h-10 w-full rounded-xl pl-9 pr-3 text-xs font-bold"
                  aria-label="Search operational timeline"
                />
              </div>
            </div>
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            {filters.map((option) => (
              <button
                type="button"
                key={option.id}
                onClick={() => setFilter(option.id)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest ${
                  filter === option.id
                    ? "border-app-accent bg-app-accent/10 text-app-accent"
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface-3"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {hiddenResultCount > 0 || hiddenAgendaDayCount > 0 ? (
          <div
            data-testid="timeline-result-limit"
            className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-xs font-bold text-app-text-muted"
          >
            Showing the nearest {visibleItems.length} matching item{visibleItems.length === 1 ? "" : "s"} for performance.
            {hiddenResultCount > 0 ? ` ${hiddenResultCount} later item${hiddenResultCount === 1 ? "" : "s"} are hidden until you narrow the filters or search.` : ""}
            {hiddenAgendaDayCount > 0 ? ` ${hiddenAgendaDayCount} later day group${hiddenAgendaDayCount === 1 ? "" : "s"} are outside this agenda preview.` : ""}
          </div>
        ) : null}

        {visibleItems.length === 0 ? (
          <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-16 text-center text-sm font-semibold text-app-text-muted">
            No timeline items match this view. Clear filters or move the calendar window.
          </div>
        ) : view === "week" ? (
          <div className="grid gap-3 lg:grid-cols-7">
            {Array.from({ length: 7 }, (_, index) => {
              const day = new Date(startOfLocalDay(anchorDate));
              day.setDate(anchorDate.getDate() + index);
              const items = dayItems.get(localDateKey(day)) ?? [];
              return (
                <div key={localDateKey(day)} className="min-h-[360px] rounded-2xl border border-app-border bg-app-surface p-3">
                  <div className="mb-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{day.toLocaleDateString([], { weekday: "short" })}</p>
                    <p className="text-xl font-black text-app-text">{day.getDate()}</p>
                  </div>
                  <div className="space-y-2">
                    {items.slice(0, 6).map((item) => renderItem(item, true))}
                    {items.length > 6 ? (
                      <p className="px-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        +{items.length - 6} more
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : view === "month" ? (
          <div className="grid grid-cols-7 gap-2">
            {buildMonthDays(anchorDate).map((day) => {
              const items = dayItems.get(localDateKey(day)) ?? [];
              const inMonth = day.getMonth() === anchorDate.getMonth();
              const critical = items.filter((item) => item.severity === "critical").length;
              const warning = items.filter((item) => item.severity === "warning").length;
              return (
                <button
                  type="button"
                  key={localDateKey(day)}
                  onClick={() => {
                    setAnchorDate(day);
                    setView("week");
                  }}
                  className={`min-h-[112px] rounded-xl border p-2 text-left transition-colors hover:border-app-input-border ${
                    inMonth ? "border-app-border bg-app-surface" : "border-app-border/50 bg-app-surface-2/40 opacity-60"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-black text-app-text">{day.getDate()}</span>
                    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{items.length}</span>
                  </div>
                  <div className="mt-3 flex gap-1">
                    {critical > 0 ? <span className="h-2 flex-1 rounded-full bg-app-danger" /> : null}
                    {warning > 0 ? <span className="h-2 flex-1 rounded-full bg-app-warning" /> : null}
                    {items.length - critical - warning > 0 ? <span className="h-2 flex-1 rounded-full bg-app-accent" /> : null}
                  </div>
                  <div className="mt-2 space-y-1">
                    {items.slice(0, 2).map((item) => (
                      <p key={item.id} className="truncate text-[10px] font-semibold text-app-text-muted">
                        {item.title}
                      </p>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        ) : view === "workload" ? (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
            <div className="rounded-2xl border border-app-border bg-app-surface p-4">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Workload by source</h3>
              <div className="mt-4 space-y-3">
                {workloadBySource.map(({ source, count }) => {
                  const pct = Math.max(6, Math.round((count / Math.max(1, filteredItems.length)) * 100));
                  return (
                    <button
                      type="button"
                      key={source}
                      onClick={() => setFilter(source === "appointment" ? "appointments" : source === "pickup" ? "pickups" : source === "alteration" ? "alterations" : source === "accounting" ? "accounting" : source === "receiving" ? "receiving" : source === "inventory" ? "inventory" : source === "wedding" ? "weddings" : source === "task" ? "tasks" : source === "alert" ? "alerts" : "all")}
                      className="w-full rounded-xl border border-app-border bg-app-surface-2 px-3 py-3 text-left hover:bg-app-surface-3"
                    >
                      <div className="flex items-center justify-between text-xs font-black text-app-text">
                        <span>{sourceLabel(source)}</span>
                        <span>{count}</span>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-app-border">
                        <div className="h-full rounded-full bg-app-accent" style={{ width: `${pct}%` }} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3">
              {visibleItems.slice(0, WORKLOAD_PREVIEW_LIMIT).map((item) => renderItem(item))}
            </div>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[180px_minmax(0,1fr)]">
            {agendaDayEntries.slice(0, AGENDA_DAY_GROUP_LIMIT).map(([key, items]) => {
              const day = parseOperationalDate(key);
              return (
                <div key={key} className="contents">
                  <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-3 xl:sticky xl:top-4 xl:self-start">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {day ? day.toLocaleDateString([], { weekday: "long" }) : key}
                    </p>
                    <p className="mt-1 text-xl font-black text-app-text">{day ? day.toLocaleDateString([], { month: "short", day: "numeric" }) : key}</p>
                    <p className="mt-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">{items.length} item{items.length === 1 ? "" : "s"}</p>
                  </div>
                  <div className="space-y-3">
                    {items.map((item) => renderItem(item))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "normal" | "warning" | "critical" | "muted";
}) {
  const toneClass =
    tone === "critical"
      ? "border-app-danger/30 bg-app-danger/10 text-app-danger"
      : tone === "warning"
        ? "border-app-warning/30 bg-app-warning/10 text-app-warning"
        : tone === "normal"
          ? "border-app-accent/25 bg-app-accent/10 text-app-accent"
          : "border-app-border bg-app-surface text-app-text-muted";
  return (
    <div className={`rounded-xl border px-3 py-3 ${toneClass}`}>
      <p className="text-[9px] font-black uppercase tracking-widest opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-black leading-none">{value}</p>
    </div>
  );
}
