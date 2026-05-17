import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Target,
  TrendingUp,
  Zap,
  ShieldCheck,
  Ruler,
  Scissors,
  ShoppingBag,
  Sun,
  Cloud,
  CloudRain,
  Snowflake,
  Users,
  Wind,
  ThermometerSun
} from "lucide-react";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import CompassMemberDetailDrawer from "./CompassMemberDetailDrawer";
import DashboardStatsCard from "../ui/DashboardStatsCard";
import DashboardGridCard from "../ui/DashboardGridCard";
import RosieInsightSummary from "../help/RosieInsightSummary";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  useNotificationCenter,
  useNotificationCenterOptional,
  type NotificationRow,
} from "../../context/NotificationCenterContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import PodiumMessagingInboxSection from "../customers/PodiumMessagingInboxSection";
import MailboxOperationsSection from "./MailboxOperationsSection";
import RegisterReports from "../pos/RegisterReports";
import FulfillmentCommandCenter from "./FulfillmentCommandCenter";
import ReviewsOperationsSection from "./ReviewsOperationsSection";
import type { OperationsCenterNavigateTarget } from "./RosOperationsCenter";
import SalesByHourSnapshotCard from "../reports/SalesByHourSnapshotCard";
import type { Customer } from "../pos/CustomerSelector";
import {
  buildMorningCompassQueue,
  compassBandLabel,
  type CompassActionRow,
  type RushOrderRow,
} from "../../lib/morningCompassQueue";

const baseUrl = getBaseUrl();

export type { CompassActionRow };

interface CompassStats {
  needs_measure: number;
  needs_order: number;
  overdue_pickups: number;
  rush_orders?: number;
}

interface TodayFloorStaffRow {
  id: string;
  full_name: string;
  role: string;
  avatar_key: string;
  shift_label?: string | null;
}

interface MorningCompassBundle {
  stats: CompassStats;
  needs_measure: CompassActionRow[];
  needs_order: CompassActionRow[];
  overdue_pickups: CompassActionRow[];
  rush_orders: RushOrderRow[];
  today_floor_staff?: TodayFloorStaffRow[];
}

interface ActivityFeedEntry {
  id: string;
  actor_name: string;
  action_type: string;
  description: string;
  created_at: string;
  party_name: string;
  member_name: string | null;
}

interface RegisterDaySummary {
  sales_count: number;
  net_sales: string;
  pickup_count: number;
  online_order_count: number;
  appointment_count: number;
  new_wedding_parties_count: number;
}

type OperationalFeedKey =
  | "tasks"
  | "salesHistory"
  | "todaySummary"
  | "fulfillment"
  | "alterations"
  | "notifications"
  | "registerSessions"
  | "morningCompass"
  | "activityFeed";

type FulfillmentUrgency = "rush" | "due_soon" | "standard" | "blocked" | "ready";

interface FulfillmentItem {
  order_id: string;
  urgency: FulfillmentUrgency;
  balance_due: number;
}

interface AlterationOpsRow {
  id: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  status: string;
  due_at: string | null;
  item_description: string | null;
  work_requested: string | null;
  source_type: string | null;
  created_at: string;
}

interface OpenRegisterSessionRow {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  opened_at: string;
  till_close_group_id: string;
  lifecycle_status: string;
}

interface OperationalHomeProps {
  onOpenWeddingParty: (partyId: string) => void;
  onOpenTransactionInBackoffice: (orderId: string) => void;
  onNavigateMetric?: (target: OperationsCenterNavigateTarget) => void;
  /** Podium inbox row → open customer hub Messages. */
  onOpenInboxCustomer: (customer: Customer) => void;
  /** Increment to refetch compass + activity (e.g. after wedding edits). */
  refreshSignal?: number;
  activeSection?: string;
  registerReportsDeepLinkTxnId?: string | null;
  onRegisterReportsDeepLinkTxnConsumed?: () => void;
}


function floorRoleLabel(role: string): string {
  if (role === "salesperson") return "Salesperson";
  return role.replace(/_/g, " ");
}

function money(value: string | number | null | undefined): string {
  const amount =
    typeof value === "number"
      ? value
      : value == null
        ? 0
        : Number.parseFloat(String(value));
  return `$${Number.isFinite(amount) ? amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) : "0.00"}`;
}

function notificationBundleKind(row: NotificationRow): string {
  const bundleKind = row.deep_link?.bundle_kind;
  return typeof bundleKind === "string" ? bundleKind.toLowerCase() : "";
}

function notificationMatches(row: NotificationRow, patterns: string[]): boolean {
  const kind = row.kind.toLowerCase();
  const bundleKind = notificationBundleKind(row);
  return patterns.some((pattern) => kind.includes(pattern) || bundleKind.includes(pattern));
}

function urgencyLabel(urgency: FulfillmentUrgency): string {
  switch (urgency) {
    case "ready":
      return "Ready for pickup";
    case "rush":
      return "Rush orders";
    case "due_soon":
      return "Due soon";
    case "blocked":
      return "Blocked follow-up";
    default:
      return "Pending orders";
  }
}

function formatWholeNumber(value: number): string {
  return value.toLocaleString();
}

const startOfLocalDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

function alterationCustomerName(row: AlterationOpsRow): string {
  return `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim() || "Unassigned customer";
}

function alterationSourceLabel(sourceType: string | null): string {
  switch (sourceType) {
    case "current_cart_item":
      return "Current sale";
    case "past_transaction_line":
      return "Past purchase";
    case "catalog_item":
      return "Stock/catalog";
    case "custom_item":
      return "Custom/manual";
    default:
      return "Garment";
  }
}

function isOpenAlteration(row: AlterationOpsRow): boolean {
  return row.status !== "picked_up";
}

function isAlterationDueToday(row: AlterationOpsRow, now = new Date()): boolean {
  if (!row.due_at || row.status === "ready" || row.status === "picked_up") return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() === startOfLocalDay(now).getTime();
}

function isAlterationOverdue(row: AlterationOpsRow, now = new Date()): boolean {
  if (!row.due_at || row.status === "ready" || row.status === "picked_up") return false;
  return startOfLocalDay(new Date(row.due_at)).getTime() < startOfLocalDay(now).getTime();
}

function percentDeltaLabel(current: number, previous: number): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }
  const delta = ((current - previous) / previous) * 100;
  const rounded = Math.round(delta);
  if (rounded === 0) return "Flat versus the prior week";
  return `${rounded > 0 ? "+" : ""}${rounded}% versus the prior week`;
}

function SummaryPill({
  label,
  value,
  tone = "default",
  onClick,
  ariaLabel,
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "danger";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const toneClass =
    tone === "good"
      ? "ui-tint-success text-app-text"
      : tone === "warn"
        ? "ui-tint-warning text-app-text"
        : tone === "danger"
          ? "ui-tint-danger text-app-text"
          : "ui-tint-neutral text-app-text";

  const Root = onClick ? "button" : "div";

  return (
    <Root
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-label={ariaLabel}
      className={`min-w-0 rounded-2xl border px-4 py-3 text-left shadow-[0_8px_22px_rgba(15,23,42,0.05),0_2px_5px_rgba(15,23,42,0.03)] ${onClick ? "transition-colors hover:border-app-input-border hover:bg-app-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30" : ""} ${toneClass}`}
    >
      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        {label}
      </p>
      <p className="mt-1 max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(1.15rem,1.6vw,1.5rem)] font-black leading-tight text-app-text">
        {value}
      </p>
    </Root>
  );
}

function FeedDegradedNotice({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-app-warning/25 bg-app-warning/10 px-4 py-3 text-sm font-semibold text-app-text">
      <div className="flex items-start gap-3">
        <AlertCircle
          size={16}
          className="mt-0.5 shrink-0 text-app-warning"
          aria-hidden
        />
        <p className="leading-relaxed">{message}</p>
      </div>
    </div>
  );
}


interface ForecastDay {
  date: string;
  temp_high: number;
  temp_low: number;
  precipitation_inches: number;
  condition: string;
}

interface ForecastCurrent {
  temp: number;
  feels_like: number;
  condition: string;
  humidity_pct?: number;
  wind_mph?: number;
}

interface WeatherForecastPayload {
  days: ForecastDay[];
  current?: ForecastCurrent | null;
  source?: string;
}

function WeatherDashboardWidget({
  refreshSignal,
  compact = false,
}: {
  refreshSignal: number;
  compact?: boolean;
}) {
  const [forecast, setForecast] = useState<WeatherForecastPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/weather/forecast`);
      if (res.ok) setForecast((await res.json()) as WeatherForecastPayload);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWeather();
    const interval = setInterval(loadWeather, 30 * 60 * 1000); // 30 mins
    return () => clearInterval(interval);
  }, [loadWeather, refreshSignal]);

  const days = forecast?.days ?? [];
  if (loading || days.length === 0) return null;

  const today = days[0];
  const tomorrow = days[1] ?? days[0];
  const current = forecast?.current;
  const headlineCondition = (
    current?.condition ?? today.condition
  ).toLowerCase();
  const condition = headlineCondition;

  const isRain = condition.includes("rain");
  const isSnow = condition.includes("snow");
  const isCloudy = condition.includes("cloudy");

  const Icon = isSnow ? Snowflake : isRain ? CloudRain : isCloudy ? Cloud : Sun;


  if (compact) {
    return (
      <div
        className={cn(
          "ui-card relative min-w-[280px] max-w-[420px] flex-1 px-4 py-3"
        )}
      >
        <div className="relative z-10 flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-app-accent/20 bg-app-accent/10 text-app-accent">
              <Icon size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[9px] font-black uppercase tracking-[0.16em] text-app-text-muted">
                  Buffalo, NY
                </span>
                <div className={`h-1.5 w-1.5 rounded-full ${forecast?.source === "mock" ? "bg-app-warning" : "bg-app-success"}`} />
                {forecast?.source === "mock" ? (
                  <span className="rounded-full border border-app-warning/20 bg-app-warning/10 px-2 py-0.5 text-[8px] font-black uppercase tracking-widest text-app-warning">
                    Mock Weather
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <h3 className="text-2xl font-black leading-none text-app-text">
                  {current != null ? `${current.temp.toFixed(0)}°` : `${today.temp_high.toFixed(0)}°`}
                </h3>
                <span className="truncate text-xs font-semibold text-app-text-muted">
                  {condition.charAt(0).toUpperCase() + condition.slice(1)}
                </span>
              </div>
              <p className="mt-1 truncate text-[11px] font-medium text-app-text-muted">
                Today {today.temp_high.toFixed(0)}° / {today.temp_low.toFixed(0)}° · Tomorrow {tomorrow.temp_high.toFixed(0)}°
              </p>
            </div>
          </div>

          <div className="hidden shrink-0 items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 lg:flex">
            <div>
              <p className="text-[8px] font-black uppercase tracking-[0.16em] text-app-text-muted">Tomorrow</p>
              <p className="mt-1 text-sm font-black text-app-text">{tomorrow.temp_high.toFixed(0)}°</p>
            </div>
            <div className="h-7 w-px bg-app-border" />
            <div className="flex flex-col items-center gap-1 opacity-40">
              <Wind size={12} />
              <ThermometerSun size={12} />
            </div>
          </div>
        </div>
        <div className="absolute -right-8 -top-8 size-24 rounded-full bg-app-accent/5 blur-2xl" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "ui-card relative p-6"
      )}
    >
      <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
        <div className="flex items-center gap-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-app-accent/10 border border-app-accent/20 text-app-accent">
            <Icon size={32} />
          </div>
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Buffalo, NY</span>
              <div className={`h-1.5 w-1.5 rounded-full ${forecast?.source === "mock" ? "bg-app-warning" : "bg-app-success"}`} />
              {forecast?.source === "mock" ? (
                <span className="rounded-full border border-app-warning/20 bg-app-warning/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-warning">
                  Mock Weather
                </span>
              ) : null}
            </div>
            <h3 className="text-4xl font-bold tracking-tight text-app-text leading-none">
              {current != null ? `${current.temp.toFixed(0)}°` : `${today.temp_high.toFixed(0)}°`}
              <span className="text-base font-medium text-app-text-muted ml-3">
                {condition.charAt(0).toUpperCase() + condition.slice(1)}
              </span>
            </h3>
            <p className="text-xs font-medium text-app-text-muted">
              {today.temp_high.toFixed(0)}° / {today.temp_low.toFixed(0)}° · {today.precipitation_inches > 0 ? `${today.precipitation_inches}"` : "0"} Precip
            </p>
            {forecast?.source === "mock" ? (
              <p className="text-[11px] font-medium text-app-warning">
                Live weather is unavailable, so this dashboard is showing deterministic fallback conditions.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-8 px-6 py-4 rounded-xl bg-app-surface-2 border border-app-border w-full md:w-auto">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted mb-1">Tomorrow</p>
            <div className="flex items-center gap-3">
              <span className="text-2xl font-bold text-app-text">{tomorrow.temp_high.toFixed(0)}°</span>
              <span className="text-xs font-medium text-app-text-muted truncate max-w-[100px]">{tomorrow.condition}</span>
            </div>
          </div>
          <div className="h-8 w-[1px] bg-app-border" />
          <div className="flex flex-col items-center gap-1 opacity-40">
            <Wind size={14} />
            <ThermometerSun size={14} />
          </div>
        </div>
      </div>
      
      {/* Background decoration */}
      <div className="absolute -right-10 -top-10 size-40 rounded-full bg-app-accent/5 blur-3xl" />
    </div>
  );
}

function cn(...inputs: (string | boolean | undefined | null | Record<string, boolean>)[]) {
  return inputs.filter(Boolean).join(" ");
}

export default function OperationalHome({
  onOpenWeddingParty,
  onOpenTransactionInBackoffice,
  onNavigateMetric,
  onOpenInboxCustomer,
  refreshSignal = 0,
  activeSection,
  registerReportsDeepLinkTxnId,
  onRegisterReportsDeepLinkTxnConsumed,
}: OperationalHomeProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const [taskMeOpen, setTaskMeOpen] = useState<
    { id: string; title_snapshot: string; due_date: string | null }[]
  >([]);
  const [taskDrawerId, setTaskDrawerId] = useState<string | null>(null);
  const [feedLoadErrors, setFeedLoadErrors] = useState<
    Partial<Record<OperationalFeedKey, string>>
  >({});

  const taskAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const clearFeedLoadError = useCallback((key: OperationalFeedKey) => {
    setFeedLoadErrors((prev) => {
      if (prev[key] == null) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const markFeedLoadError = useCallback(
    (key: OperationalFeedKey, message: string) => {
      setFeedLoadErrors((prev) =>
        prev[key] === message ? prev : { ...prev, [key]: message },
      );
    },
    [],
  );

  const loadTasksMe = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("tasks.complete")) {
      clearFeedLoadError("tasks");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("tasks");
      const data = (await res.json()) as {
        open?: {
          id: string;
          title_snapshot: string;
          due_date: string | null;
        }[];
      };
      setTaskMeOpen(Array.isArray(data.open) ? data.open : []);
      clearFeedLoadError("tasks");
    } catch {
      markFeedLoadError(
        "tasks",
        "Assigned tasks could not refresh. The task count may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadTasksMe();
  }, [loadTasksMe, refreshSignal]);

  const notifOpt = useNotificationCenterOptional();
  const refreshNotifUnread = notifOpt?.refreshUnread;
  const { openDrawer } = useNotificationCenter();
  useEffect(() => {
    if (activeSection === "inbox" && refreshNotifUnread)
      void refreshNotifUnread();
  }, [activeSection, refreshNotifUnread]);
  const [salesHistory, setSalesHistory] = useState<{ value: number }[]>([]);
  const [todaySummary, setTodaySummary] = useState<RegisterDaySummary | null>(null);
  const [fulfillmentQueue, setFulfillmentQueue] = useState<FulfillmentItem[]>([]);
  const [alterationsQueue, setAlterationsQueue] = useState<AlterationOpsRow[]>([]);
  const loadSalesHistory = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("insights.view")) {
      clearFeedLoadError("salesHistory");
      return;
    }
    try {
      const today = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(today.getDate() - 30);
      
      const from = thirtyDaysAgo.toISOString().split('T')[0];
      const to = today.toISOString().split('T')[0];
      
      const res = await fetch(`${baseUrl}/api/insights/sales-pivot?group_by=date&basis=sale&from=${from}&to=${to}`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("sales-history");
      const data = await res.json() as { rows: { gross_revenue: string }[] };
      const history = data.rows.map((r) => ({ value: Number(r.gross_revenue) })).reverse();
      setSalesHistory(history);
      clearFeedLoadError("salesHistory");
    } catch {
      markFeedLoadError(
        "salesHistory",
        "Sales pace could not refresh. Trend details may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadSalesHistory();
  }, [loadSalesHistory, refreshSignal]);

  const loadTodaySummary = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("register.reports")) {
      setTodaySummary(null);
      clearFeedLoadError("todaySummary");
      return;
    }
    try {
      const params = new URLSearchParams({
        preset: "today",
        basis: "booked",
      });
      const res = await fetch(`${baseUrl}/api/insights/register-day-activity?${params}`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("today-summary");
      setTodaySummary((await res.json()) as RegisterDaySummary);
      clearFeedLoadError("todaySummary");
    } catch {
      markFeedLoadError(
        "todaySummary",
        "Today’s sales activity could not refresh. Sales cards may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadTodaySummary();
  }, [loadTodaySummary, refreshSignal]);

  const loadFulfillmentQueue = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("orders.view")) {
      setFulfillmentQueue([]);
      clearFeedLoadError("fulfillment");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/transactions/fulfillment-queue`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("fulfillment");
      setFulfillmentQueue((await res.json()) as FulfillmentItem[]);
      clearFeedLoadError("fulfillment");
    } catch {
      markFeedLoadError(
        "fulfillment",
        "Pickup queue could not refresh. Order counts may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadFulfillmentQueue();
  }, [loadFulfillmentQueue, refreshSignal]);

  const loadAlterationsQueue = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("alterations.manage")) {
      setAlterationsQueue([]);
      clearFeedLoadError("alterations");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/alterations`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("alterations");
      setAlterationsQueue((await res.json()) as AlterationOpsRow[]);
      clearFeedLoadError("alterations");
    } catch {
      markFeedLoadError(
        "alterations",
        "Alterations could not refresh. Tailoring counts may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadAlterationsQueue();
  }, [loadAlterationsQueue, refreshSignal]);

  const [notifPreview, setNotifPreview] = useState<NotificationRow[]>([]);
  const loadNotifPreview = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("notifications.view")) {
      setNotifPreview([]);
      clearFeedLoadError("notifications");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/notifications?limit=16`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("notifications");
      setNotifPreview((await res.json()) as NotificationRow[]);
      clearFeedLoadError("notifications");
    } catch {
      markFeedLoadError(
        "notifications",
        "Inventory and inbox alerts could not refresh. Alert counts may be out of date.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadNotifPreview();
  }, [loadNotifPreview, refreshSignal]);

  const [openRegisterSessions, setOpenRegisterSessions] = useState<OpenRegisterSessionRow[]>([]);
  const loadOpenRegisterSessions = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("register.session_attach")) {
      setOpenRegisterSessions([]);
      clearFeedLoadError("registerSessions");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/sessions/list-open`, {
        headers: taskAuth(),
      });
      if (!res.ok) throw new Error("register-sessions");
      const data = (await res.json()) as OpenRegisterSessionRow[];
      setOpenRegisterSessions(Array.isArray(data) ? data : []);
      clearFeedLoadError("registerSessions");
    } catch {
      markFeedLoadError(
        "registerSessions",
        "Register close readiness could not refresh. Confirm open drawers from Daily Sales before closing.",
      );
    }
  }, [
    permissionsLoaded,
    hasPermission,
    taskAuth,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadOpenRegisterSessions();
  }, [loadOpenRegisterSessions, refreshSignal]);

  const [compass, setCompass] = useState<MorningCompassBundle | null>(null);
  const [activityFeed, setActivityFeed] = useState<ActivityFeedEntry[]>([]);
  const [compassDrawerRow, setCompassDrawerRow] =
    useState<CompassActionRow | null>(null);

  const loadMorningBoard = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("weddings.view")) {
      setCompass(null);
      setActivityFeed([]);
      clearFeedLoadError("morningCompass");
      clearFeedLoadError("activityFeed");
      return;
    }
    const [cResult, fResult] = await Promise.allSettled([
      fetch(`${baseUrl}/api/weddings/morning-compass`, {
        headers: taskAuth(),
      }),
      fetch(`${baseUrl}/api/weddings/activity-feed?limit=40`, {
        headers: taskAuth(),
      }),
    ]);
    if (cResult.status === "fulfilled" && cResult.value.ok) {
      try {
        const data = (await cResult.value.json()) as MorningCompassBundle;
        if (data) {
          setCompass({
            ...data,
            stats: {
              needs_measure: Number(data.stats?.needs_measure || 0),
              needs_order: Number(data.stats?.needs_order || 0),
              overdue_pickups: Number(data.stats?.overdue_pickups || 0),
            },
            needs_measure: data.needs_measure || [],
            needs_order: data.needs_order || [],
            overdue_pickups: data.overdue_pickups || [],
            today_floor_staff: Array.isArray(data.today_floor_staff)
              ? data.today_floor_staff
              : [],
          });
        }
        clearFeedLoadError("morningCompass");
      } catch {
        markFeedLoadError(
          "morningCompass",
          "Morning priorities could not refresh. Action Board and floor staffing may be out of date.",
        );
      }
    } else {
      markFeedLoadError(
        "morningCompass",
        "Morning priorities could not refresh. Action Board and floor staffing may be out of date.",
      );
    }
    if (fResult.status === "fulfilled" && fResult.value.ok) {
      try {
        setActivityFeed((await fResult.value.json()) as ActivityFeedEntry[]);
        clearFeedLoadError("activityFeed");
      } catch {
        markFeedLoadError(
          "activityFeed",
          "Recent activity could not refresh. The activity list may be out of date.",
        );
      }
    } else {
      markFeedLoadError(
        "activityFeed",
        "Recent activity could not refresh. The activity list may be out of date.",
      );
    }
  }, [
    taskAuth,
    permissionsLoaded,
    hasPermission,
    clearFeedLoadError,
    markFeedLoadError,
  ]);

  useEffect(() => {
    void loadMorningBoard();
    const interval = setInterval(loadMorningBoard, 60 * 1000); 
    return () => clearInterval(interval);
  }, [loadMorningBoard, refreshSignal]);




  const suggestedMorningQueue = useMemo(
    () =>
      buildMorningCompassQueue({
        overduePickups: compass?.overdue_pickups ?? [],
        needsOrder: compass?.needs_order ?? [],
        needsMeasure: compass?.needs_measure ?? [],
        rushOrders: compass?.rush_orders ?? [],
        openTasks: taskMeOpen,
        notifications: notifPreview,
        limit: 12,
      }),
    [compass, taskMeOpen, notifPreview],
  );

  const activeNotifications = useMemo(
    () =>
      notifPreview.filter(
        (row) =>
          row.archived_at == null &&
          row.completed_at == null,
      ),
    [notifPreview],
  );

  const lowStockNotifications = useMemo(
    () =>
      activeNotifications.filter((row) =>
        notificationMatches(row, ["low_stock", "stock", "negative_available_stock"]),
      ),
    [activeNotifications],
  );

  const issueNotifications = useMemo(
    () =>
      activeNotifications.filter((row) =>
        notificationMatches(row, ["negative_available_stock", "failed", "error", "discrepancy", "backup", "sync"]),
      ),
    [activeNotifications],
  );

  const fulfillmentStats = useMemo(() => {
    const stats = {
      total: fulfillmentQueue.length,
      ready: 0,
      rush: 0,
      dueSoon: 0,
      blocked: 0,
      unpaid: 0,
    };
    for (const item of fulfillmentQueue) {
      if (item.urgency === "ready") stats.ready += 1;
      if (item.urgency === "rush") stats.rush += 1;
      if (item.urgency === "due_soon") stats.dueSoon += 1;
      if (item.urgency === "blocked") stats.blocked += 1;
      if (item.balance_due > 0) stats.unpaid += 1;
    }
    return stats;
  }, [fulfillmentQueue]);

  const registerCloseStats = useMemo(() => {
    const groups = new Set<string>();
    let reconciling = 0;
    for (const session of openRegisterSessions) {
      groups.add(session.till_close_group_id);
      if (session.lifecycle_status === "reconciling") reconciling += 1;
    }
    return {
      openSessions: openRegisterSessions.length,
      openDrawers: groups.size,
      reconciling,
    };
  }, [openRegisterSessions]);

  const alterationStats = useMemo(() => {
    const stats = {
      totalOpen: 0,
      overdue: 0,
      dueToday: 0,
      ready: 0,
    };
    for (const item of alterationsQueue) {
      if (isOpenAlteration(item)) stats.totalOpen += 1;
      if (isAlterationOverdue(item)) stats.overdue += 1;
      if (isAlterationDueToday(item)) stats.dueToday += 1;
      if (item.status === "ready") stats.ready += 1;
    }
    return stats;
  }, [alterationsQueue]);

  const alterationAttentionRows = useMemo(
    () =>
      alterationsQueue
        .filter((row) => isAlterationOverdue(row) || isAlterationDueToday(row) || row.status === "ready")
        .sort((a, b) => {
          const rank = (row: AlterationOpsRow) =>
            isAlterationOverdue(row) ? 0 : isAlterationDueToday(row) ? 1 : row.status === "ready" ? 2 : 3;
          const rankDelta = rank(a) - rank(b);
          if (rankDelta !== 0) return rankDelta;
          return new Date(a.due_at ?? a.created_at).getTime() - new Date(b.due_at ?? b.created_at).getTime();
        })
        .slice(0, 6),
    [alterationsQueue],
  );

  const topIssues = useMemo(() => {
    const items: {
      id: string;
      label: string;
      detail: string;
      tone: "danger" | "warn" | "default";
    }[] = [];

    if (feedLoadErrors.fulfillment) {
      items.push({
        id: "pickup-feed",
        label: "Pickup queue not refreshed",
        detail: feedLoadErrors.fulfillment,
        tone: "warn",
      });
    }
    if (feedLoadErrors.alterations) {
      items.push({
        id: "alterations-feed",
        label: "Alterations not refreshed",
        detail: feedLoadErrors.alterations,
        tone: "warn",
      });
    }
    if (feedLoadErrors.notifications) {
      items.push({
        id: "alerts-feed",
        label: "Alerts not refreshed",
        detail: feedLoadErrors.notifications,
        tone: "warn",
      });
    }
    if (feedLoadErrors.tasks) {
      items.push({
        id: "tasks-feed",
        label: "Tasks not refreshed",
        detail: feedLoadErrors.tasks,
        tone: "warn",
      });
    }
    if (feedLoadErrors.registerSessions) {
      items.push({
        id: "register-close-feed",
        label: "Register close status not refreshed",
        detail: feedLoadErrors.registerSessions,
        tone: "warn",
      });
    }
    if (feedLoadErrors.morningCompass) {
      items.push({
        id: "priorities-feed",
        label: "Morning priorities not refreshed",
        detail: feedLoadErrors.morningCompass,
        tone: "warn",
      });
    }
    if (registerCloseStats.reconciling > 0) {
      items.push({
        id: "register-close",
        label: "Register close in progress",
        detail: `${registerCloseStats.reconciling} open register session${registerCloseStats.reconciling === 1 ? " is" : "s are"} already reconciling. Finish that close before starting another.`,
        tone: "warn",
      });
    }

    if (fulfillmentStats.blocked > 0) {
      items.push({
        id: "blocked-orders",
        label: "Blocked pickup work",
        detail: `${fulfillmentStats.blocked} ${urgencyLabel("blocked").toLowerCase()} in the pickup queue.`,
        tone: "danger",
      });
    }
    if (fulfillmentStats.rush > 0) {
      items.push({
        id: "rush-orders",
        label: "Rush follow-up",
        detail: `${fulfillmentStats.rush} rush order${fulfillmentStats.rush === 1 ? "" : "s"} need quick attention.`,
        tone: "warn",
      });
    }
    if (alterationStats.overdue > 0) {
      items.push({
        id: "overdue-alterations",
        label: "Alterations overdue",
        detail: `${alterationStats.overdue} garment${alterationStats.overdue === 1 ? "" : "s"} are past the promised due date.`,
        tone: "danger",
      });
    } else if (alterationStats.dueToday > 0) {
      items.push({
        id: "alterations-due-today",
        label: "Alterations due today",
        detail: `${alterationStats.dueToday} garment${alterationStats.dueToday === 1 ? "" : "s"} need tailoring follow-up today.`,
        tone: "warn",
      });
    }
    if (lowStockNotifications.length > 0) {
      items.push({
        id: "low-stock",
        label: "Low stock alerts",
        detail: `${lowStockNotifications.length} inventory alert${lowStockNotifications.length === 1 ? "" : "s"} are already in the inbox.`,
        tone: notificationMatches(lowStockNotifications[0], ["negative_available_stock"]) ? "danger" : "warn",
      });
    }
    if (taskMeOpen.length > 0) {
      items.push({
        id: "tasks",
        label: "Open tasks",
        detail: `${taskMeOpen.length} assigned task${taskMeOpen.length === 1 ? "" : "s"} still open.`,
        tone: "default",
      });
    }
    if (activeNotifications.length > 0) {
      items.push({
        id: "notifications",
        label: "Unread notifications",
        detail: `${activeNotifications.length} inbox item${activeNotifications.length === 1 ? "" : "s"} waiting for review.`,
        tone: "default",
      });
    }

    return items.slice(0, 5);
  }, [
    activeNotifications.length,
    alterationStats.dueToday,
    alterationStats.overdue,
    feedLoadErrors.alterations,
    feedLoadErrors.fulfillment,
    feedLoadErrors.morningCompass,
    feedLoadErrors.notifications,
    feedLoadErrors.registerSessions,
    feedLoadErrors.tasks,
    fulfillmentStats.blocked,
    fulfillmentStats.rush,
    lowStockNotifications,
    registerCloseStats.reconciling,
    taskMeOpen.length,
  ]);

  const weeklySalesTakeaway = useMemo(() => {
    if (salesHistory.length < 14) return null;
    const thisWeek = salesHistory
      .slice(0, 7)
      .reduce((sum, day) => sum + day.value, 0);
    const lastWeek = salesHistory
      .slice(7, 14)
      .reduce((sum, day) => sum + day.value, 0);
    const deltaLabel = percentDeltaLabel(thisWeek, lastWeek);
    return {
      thisWeek,
      lastWeek,
      deltaLabel,
    };
  }, [salesHistory]);

  const todayDecisionTakeaways = useMemo(() => {
    const items: {
      id: string;
      label: string;
      detail: string;
      tone: "good" | "warn" | "danger" | "default";
    }[] = [];

    if (feedLoadErrors.todaySummary) {
      items.push({
        id: "sales-feed",
        label: "Sales movement",
        detail: feedLoadErrors.todaySummary,
        tone: "warn",
      });
    } else if (todaySummary) {
      if (todaySummary.sales_count > 0) {
        items.push({
          id: "sales-movement",
          label: "Sales movement",
          detail: `${formatWholeNumber(todaySummary.sales_count)} sale${todaySummary.sales_count === 1 ? "" : "s"} booked today for ${money(todaySummary.net_sales)} net.`,
          tone: "good",
        });
      } else {
        items.push({
          id: "sales-movement",
          label: "Sales movement",
          detail: "No booked sales have posted yet today, so floor activity may still be building.",
          tone: "warn",
        });
      }

      if (todaySummary.pickup_count > 0 || todaySummary.online_order_count > 0) {
        items.push({
          id: "channel-mix",
          label: "Channel mix",
          detail: `${formatWholeNumber(todaySummary.pickup_count)} pickup${todaySummary.pickup_count === 1 ? "" : "s"} and ${formatWholeNumber(todaySummary.online_order_count)} online order${todaySummary.online_order_count === 1 ? "" : "s"} moved through today.`,
          tone: "default",
        });
      }

      if (todaySummary.appointment_count > 0 || todaySummary.new_wedding_parties_count > 0) {
        items.push({
          id: "appointments",
          label: "Client demand",
          detail: `${formatWholeNumber(todaySummary.appointment_count)} appointment${todaySummary.appointment_count === 1 ? "" : "s"} and ${formatWholeNumber(todaySummary.new_wedding_parties_count)} new wedding ${todaySummary.new_wedding_parties_count === 1 ? "party" : "parties"} added today.`,
          tone: "default",
        });
      }
    }

    if (feedLoadErrors.salesHistory) {
      items.push({
        id: "weekly-sales-feed",
        label: "Weekly sales pace",
        detail: feedLoadErrors.salesHistory,
        tone: "warn",
      });
    }

    if (weeklySalesTakeaway?.deltaLabel) {
      items.push({
        id: "weekly-sales",
        label: "Weekly sales pace",
        detail: `${money(weeklySalesTakeaway.thisWeek)} this week. ${weeklySalesTakeaway.deltaLabel}.`,
        tone: weeklySalesTakeaway.thisWeek >= weeklySalesTakeaway.lastWeek ? "good" : "warn",
      });
    }

    return items.slice(0, 4);
  }, [
    feedLoadErrors.salesHistory,
    feedLoadErrors.todaySummary,
    todaySummary,
    weeklySalesTakeaway,
  ]);

  const decisionTakeaways = useMemo(() => {
    const items: {
      id: string;
      label: string;
      detail: string;
      tone: "good" | "warn" | "danger" | "default";
    }[] = [];

    if (feedLoadErrors.fulfillment) {
      items.push({
        id: "pickup-queue",
        label: "Pickup queue",
        detail: feedLoadErrors.fulfillment,
        tone: "warn",
      });
    } else if (fulfillmentStats.blocked > 0) {
      items.push({
        id: "pickup-queue",
        label: "Pickup queue risk",
        detail: `${fulfillmentStats.blocked} blocked pickup ${fulfillmentStats.blocked === 1 ? "order is" : "orders are"} holding the queue back right now.`,
        tone: "danger",
      });
    } else if (fulfillmentStats.ready > 0) {
      items.push({
        id: "pickup-queue",
        label: "Pickup queue",
        detail: `${fulfillmentStats.ready} order${fulfillmentStats.ready === 1 ? "" : "s"} are ready for pickup and can move without waiting on product.`,
        tone: "good",
      });
    } else {
      items.push({
        id: "pickup-queue",
        label: "Pickup queue",
        detail: "No ready pickup pressure is building right now.",
        tone: "default",
      });
    }

    if (feedLoadErrors.registerSessions) {
      items.push({
        id: "register-close",
        label: "Register close",
        detail: feedLoadErrors.registerSessions,
        tone: "warn",
      });
    } else if (registerCloseStats.reconciling > 0) {
      items.push({
        id: "register-close",
        label: "Register close",
        detail: `${registerCloseStats.reconciling} register session${registerCloseStats.reconciling === 1 ? " is" : "s are"} already in close review.`,
        tone: "warn",
      });
    } else if (registerCloseStats.openSessions > 0) {
      items.push({
        id: "register-close",
        label: "Register close",
        detail: `${registerCloseStats.openDrawers} till drawer${registerCloseStats.openDrawers === 1 ? "" : "s"} open across ${registerCloseStats.openSessions} register session${registerCloseStats.openSessions === 1 ? "" : "s"}.`,
        tone: "default",
      });
    } else {
      items.push({
        id: "register-close",
        label: "Register close",
        detail: "No open register sessions are currently waiting on close review.",
        tone: "good",
      });
    }

    if (feedLoadErrors.notifications) {
      items.push({
        id: "inventory-alerts",
        label: "Inventory pressure",
        detail: feedLoadErrors.notifications,
        tone: "warn",
      });
    } else if (lowStockNotifications.length > 0) {
      items.push({
        id: "inventory-alerts",
        label: "Inventory pressure",
        detail: `${lowStockNotifications.length} stock alert${lowStockNotifications.length === 1 ? "" : "s"} already need review before they turn into fulfillment problems.`,
        tone: notificationMatches(lowStockNotifications[0], ["negative_available_stock"]) ? "danger" : "warn",
      });
    } else {
      items.push({
        id: "inventory-alerts",
        label: "Inventory pressure",
        detail: "No live low-stock or negative-available inventory alerts are active right now.",
        tone: "good",
      });
    }

    if (feedLoadErrors.tasks || feedLoadErrors.notifications) {
      items.push({
        id: "staff-load",
        label: "Staff follow-up load",
        detail:
          feedLoadErrors.tasks ??
          feedLoadErrors.notifications ??
          "Staff follow-up could not refresh.",
        tone: "warn",
      });
    } else if (taskMeOpen.length > 0 || activeNotifications.length > 0) {
      items.push({
        id: "staff-load",
        label: "Staff follow-up load",
        detail: `${taskMeOpen.length} open task${taskMeOpen.length === 1 ? "" : "s"} and ${activeNotifications.length} inbox item${activeNotifications.length === 1 ? "" : "s"} are still waiting on review.`,
        tone: activeNotifications.length > 8 ? "warn" : "default",
      });
    } else {
      items.push({
        id: "staff-load",
        label: "Staff follow-up load",
        detail: "Tasks and inbox follow-up are both clear, so the floor can stay focused on active selling work.",
        tone: "good",
      });
    }

    return items.slice(0, 4);
  }, [
    activeNotifications.length,
    feedLoadErrors.fulfillment,
    feedLoadErrors.notifications,
    feedLoadErrors.registerSessions,
    feedLoadErrors.tasks,
    fulfillmentStats.blocked,
    fulfillmentStats.ready,
    lowStockNotifications,
    registerCloseStats.openDrawers,
    registerCloseStats.openSessions,
    registerCloseStats.reconciling,
    taskMeOpen.length,
  ]);

  const dailyBriefingFacts = useMemo(
    () => ({
      title: "Today at Riverside",
      bullets: [
        ...todayDecisionTakeaways.map((item) => ({
          id: `today-${item.id}`,
          label: `${item.label}: ${item.detail}`,
          severity: item.tone,
        })),
        ...topIssues.map((issue) => ({
          id: `issue-${issue.id}`,
          label: `${issue.label}: ${issue.detail}`,
          severity: issue.tone,
        })),
        ...decisionTakeaways.map((item) => ({
          id: `decision-${item.id}`,
          label: `${item.label}: ${item.detail}`,
          severity: item.tone,
        })),
        {
          id: "fulfillment-summary",
          label: `Pickup queue: ${fulfillmentStats.total} pending, ${fulfillmentStats.ready} ready, ${fulfillmentStats.blocked} blocked, ${fulfillmentStats.rush} rush.`,
          severity: fulfillmentStats.blocked > 0 || fulfillmentStats.rush > 0 ? "warn" : "default",
        },
        {
          id: "register-close-summary",
          label: `Register close: ${registerCloseStats.openSessions} open sessions, ${registerCloseStats.openDrawers} till drawers, ${registerCloseStats.reconciling} reconciling.`,
          severity: registerCloseStats.reconciling > 0 ? "warn" : "default",
        },
        {
          id: "alterations-summary",
          label: `Alterations: ${alterationStats.totalOpen} open, ${alterationStats.overdue} overdue, ${alterationStats.dueToday} due today, ${alterationStats.ready} ready.`,
          severity: alterationStats.overdue > 0 ? "danger" : alterationStats.dueToday > 0 ? "warn" : "default",
        },
        {
          id: "staff-followup",
          label: `Staff follow-up: ${taskMeOpen.length} open tasks and ${activeNotifications.length} inbox items.`,
          severity: activeNotifications.length > 8 ? "warn" : "default",
        },
        {
          id: "inventory-alerts",
          label: `Inventory alerts: ${lowStockNotifications.length} low-stock alerts and ${issueNotifications.length} issue alerts.`,
          severity: issueNotifications.length > 0 ? "warn" : "default",
        },
        {
          id: "morning-queue",
          label: `Morning queue: ${suggestedMorningQueue.length} deterministic items surfaced for review.`,
          severity: "default",
        },
      ].slice(0, 12),
      disclaimers: [
        "Summarize displayed operational facts only. Do not recommend outreach, scheduling, fulfillment, inventory, payment, or accounting actions.",
      ],
    }),
    [
      activeNotifications.length,
      alterationStats.dueToday,
      alterationStats.overdue,
      alterationStats.ready,
      alterationStats.totalOpen,
      decisionTakeaways,
      fulfillmentStats.blocked,
      fulfillmentStats.ready,
      fulfillmentStats.rush,
      fulfillmentStats.total,
      issueNotifications.length,
      lowStockNotifications.length,
      registerCloseStats.openDrawers,
      registerCloseStats.openSessions,
      registerCloseStats.reconciling,
      suggestedMorningQueue.length,
      taskMeOpen.length,
      todayDecisionTakeaways,
      topIssues,
    ],
  );

  const failedFeedMessages = Object.values(feedLoadErrors).filter(
    (message): message is string => Boolean(message),
  );
  const hasFeedLoadErrors = failedFeedMessages.length > 0;
  const actionBoardLoadError =
    feedLoadErrors.morningCompass ||
    feedLoadErrors.tasks ||
    feedLoadErrors.notifications;

  const openOperationalSignal = useCallback((id: string) => {
    if (id.includes("daily-sales") || id.includes("sales")) {
      onNavigateMetric?.({ tab: "home", section: "daily-sales" });
      return;
    }
    if (id.includes("register-close")) {
      onNavigateMetric?.({ tab: "home", section: "daily-sales" });
      return;
    }
    if (id.includes("appointment")) {
      onNavigateMetric?.({ tab: "appointments", section: "scheduler" });
      return;
    }
    if (id.includes("wedding")) {
      onNavigateMetric?.({ tab: "weddings" });
      return;
    }
    if (id.includes("alteration")) {
      onNavigateMetric?.({ tab: "alterations", section: "queue" });
      return;
    }
    if (id.includes("inventory") || id.includes("stock")) {
      onNavigateMetric?.({ tab: "inventory", section: "intelligence" });
      return;
    }
    if (id.includes("pickup") || id.includes("order") || id.includes("fulfillment")) {
      onNavigateMetric?.({ tab: "home", section: "fulfillment" });
      return;
    }
    if (id.includes("task") && taskMeOpen[0]?.id) {
      setTaskDrawerId(taskMeOpen[0].id);
      return;
    }
    openDrawer();
  }, [onNavigateMetric, openDrawer, taskMeOpen]);


  if (activeSection === "daily-sales") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Synchronizing Ledger...</div>
          ) : !hasPermission("register.reports") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
               <ShieldCheck size={64} className="text-app-danger opacity-20" />
               <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
	                 Daily sales access is required to view the sales matrix.
               </p>
            </div>
          ) : (
            <RegisterReports
              sessionId={null}
              onOpenWeddingParty={onOpenWeddingParty}
              deepLinkTransactionId={registerReportsDeepLinkTxnId}
              onDeepLinkConsumed={onRegisterReportsDeepLinkTxnConsumed}
            />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "inbox") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Opening Podium Inbox...</div>
          ) : !hasPermission("customers.hub_view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-app-danger opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
	                Customer messaging access is required to open the Podium inbox.
              </p>
            </div>
          ) : (
            <PodiumMessagingInboxSection
              onOpenCustomerHub={onOpenInboxCustomer}
            />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "mailbox") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Opening Mailbox...</div>
          ) : !hasPermission("customers.hub_view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-app-danger opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
	                Customer messaging access is required to open the mailbox.
              </p>
            </div>
          ) : (
            <MailboxOperationsSection onOpenCustomerHub={onOpenInboxCustomer} />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "fulfillment") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Opening Pickup Queue...</div>
          ) : !hasPermission("orders.view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-app-danger opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
	                Order access is required to monitor the pickup queue.
              </p>
            </div>
          ) : (
            <FulfillmentCommandCenter
              onOpenTransaction={onOpenTransactionInBackoffice}
              onOpenWeddingParty={onOpenWeddingParty}
              refreshSignal={refreshSignal}
            />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "reviews") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Consulting Public Sentiment...</div>
          ) : !hasPermission("reviews.view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-app-danger opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
	                Reviews access is required to monitor customer feedback.
              </p>
            </div>
          ) : (
            <ReviewsOperationsSection
              onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
            />
          )}
        </div>
      </div>
    );
  }

  const renderDashboard = () => (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
            Back Office Command Center
          </p>
          <h2 className="text-3xl font-black tracking-tight text-app-text">
            Operations Dashboard
          </h2>
          <p className="text-sm font-semibold leading-relaxed text-app-text-muted">
            Start here: sales movement, open drawers, pickup pressure, tailoring due dates, inventory alerts, and staff follow-up all route back to their source workspace.
          </p>
        </div>
        <div className="flex w-full justify-start lg:w-auto lg:justify-end">
          <WeatherDashboardWidget refreshSignal={refreshSignal} compact />
        </div>
      </div>

      {hasFeedLoadErrors ? (
        <FeedDegradedNotice message="Some operational feeds did not refresh. Review the marked sections before treating the dashboard as clear." />
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <DashboardStatsCard
          title="Today's Sales"
          value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary ? money(todaySummary.net_sales) : "$0.00"}
          icon={CircleDollarSign}
          sparklineData={salesHistory}
          trend={{
            value: todaySummary?.sales_count ?? 0,
            isUp: true,
            label: "sales today",
          }}
          color="blue"
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
          ariaLabel="Open Daily Sales"
        />
        <DashboardStatsCard
          title="Register Close"
          value={feedLoadErrors.registerSessions ? "Not loaded" : registerCloseStats.openDrawers}
          icon={ClipboardCheck}
          trend={{
            value: registerCloseStats.reconciling,
            isUp: false,
            label: "in close review",
          }}
          color={registerCloseStats.reconciling > 0 ? "orange" : "green"}
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
          ariaLabel="Open Register Close Review"
        />
        <DashboardStatsCard
          title="Pickup Queue"
          value={feedLoadErrors.fulfillment ? "Not loaded" : fulfillmentStats.total}
          icon={ShoppingBag}
          trend={{
            value: fulfillmentStats.ready,
            isUp: true,
            label: "ready for pickup",
          }}
          color="purple"
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "home", section: "fulfillment" })}
          ariaLabel="Open Pickup Queue"
        />
        <DashboardStatsCard
          title="Alterations"
          value={feedLoadErrors.alterations ? "Not loaded" : alterationStats.totalOpen}
          icon={Scissors}
          trend={{
            value: alterationStats.ready,
            isUp: true,
            label: "ready",
          }}
          color="blue"
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
          ariaLabel="Open Alterations Queue"
        />
        <DashboardStatsCard
          title="Inventory Alerts"
          value={feedLoadErrors.notifications ? "Not loaded" : lowStockNotifications.length}
          icon={Ruler}
          trend={{
            value: issueNotifications.length,
            isUp: false,
            label: "issue alerts",
          }}
          color="orange"
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "inventory", section: "intelligence" })}
          ariaLabel="Open Inventory Stock Guidance"
        />
        <DashboardStatsCard
          title="Needs Attention"
          value={hasFeedLoadErrors ? "Review" : Math.max(topIssues.length, activeNotifications.length)}
          icon={AlertCircle}
          trend={{
            value: activeNotifications.length,
            isUp: false,
            label: "open inbox items",
          }}
          color="rose"
          className="min-h-[142px] p-4"
          onClick={() => onNavigateMetric?.({ tab: "home", section: "inbox" })}
          ariaLabel="Open Podium Inbox"
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-8">
          <DashboardGridCard
            title="What Changed Today"
            subtitle="Booked activity, appointments, pickups, and weddings with source links"
            icon={TrendingUp}
            actionLabel="Daily Sales"
            onAction={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
          >
            {feedLoadErrors.todaySummary || feedLoadErrors.salesHistory ? (
              <FeedDegradedNotice
                message={
                  feedLoadErrors.todaySummary ??
                  feedLoadErrors.salesHistory ??
                  "Today’s movement could not refresh."
                }
              />
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <SummaryPill
                label="Net sales"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary ? money(todaySummary.net_sales) : "$0.00"}
                tone="good"
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Daily Sales"
              />
              <SummaryPill
                label="Sales count"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary?.sales_count ?? 0}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Daily Sales"
              />
              <SummaryPill
                label="Pickups"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary?.pickup_count ?? 0}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "fulfillment" })}
                ariaLabel="Open Pickup Queue"
              />
              <SummaryPill
                label="Online orders"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary?.online_order_count ?? 0}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Daily Sales"
              />
              <SummaryPill
                label="Appointments"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary?.appointment_count ?? 0}
                onClick={() => onNavigateMetric?.({ tab: "appointments", section: "scheduler" })}
                ariaLabel="Open Scheduler"
              />
              <SummaryPill
                label="New weddings"
                value={feedLoadErrors.todaySummary ? "Not loaded" : todaySummary?.new_wedding_parties_count ?? 0}
                onClick={() => onNavigateMetric?.({ tab: "weddings" })}
                ariaLabel="Open Weddings"
              />
            </div>
            <div className="mt-4 grid gap-3 lg:grid-cols-2">
              {todayDecisionTakeaways.length === 0 ? (
                <div className="ui-panel px-4 py-3 text-sm font-semibold text-app-text-muted">
                  Today&apos;s reporting feeds have not posted enough activity yet to summarize movement.
                </div>
              ) : (
                todayDecisionTakeaways.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => openOperationalSignal(item.id)}
                    className={`rounded-2xl border px-4 py-3 text-left shadow-[0_8px_22px_rgba(15,23,42,0.05),0_2px_5px_rgba(15,23,42,0.03)] transition-colors hover:border-app-input-border hover:bg-app-surface-3 ${
                      item.tone === "good"
                        ? "border-app-success/16 bg-app-success/10"
                        : item.tone === "warn"
                          ? "border-app-warning/16 bg-app-warning/10"
                          : item.tone === "danger"
                            ? "border-app-danger/16 bg-app-danger/10"
                            : "border-app-border bg-app-surface-3"
                    }`}
                  >
                    <p className="text-xs font-black text-app-text">{item.label}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-app-text-muted">{item.detail}</p>
                  </button>
                ))
              )}
            </div>
            <RosieInsightSummary
              surface="daily_operational_briefing"
              title="Today at Riverside"
              facts={dailyBriefingFacts}
              getHeaders={taskAuth}
            />
          </DashboardGridCard>

          <DashboardGridCard
            title="Action Board"
            subtitle="Highest-priority source records from weddings, tasks, rush orders, and inbox"
            icon={Zap}
          >
            {actionBoardLoadError ? (
              <FeedDegradedNotice message={actionBoardLoadError} />
            ) : suggestedMorningQueue.length === 0 ? (
              <div className="py-16 text-center text-sm font-semibold text-app-text-muted">
                <Target size={42} className="mx-auto mb-4 opacity-25" />
                All priorities cleared.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {suggestedMorningQueue.slice(0, 8).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => {
                      if (item.kind === "wedding") setCompassDrawerRow(item.row);
                      else if (item.kind === "task") setTaskDrawerId(item.taskId);
                      else if (item.kind === "rush_order") onOpenTransactionInBackoffice(item.row.order_id);
                      else openDrawer();
                    }}
                    className="flex items-center justify-between rounded-xl border border-app-border bg-app-surface-2 p-4 text-left transition-colors hover:bg-app-surface-3"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <div
                        className={cn(
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                          item.tier === "urgent"
                            ? "border-app-danger/20 bg-app-danger/10 text-app-danger"
                            : "border-app-accent/20 bg-app-accent/10 text-app-accent",
                        )}
                      >
                        <Zap size={16} />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-app-text">
                          {item.kind === "wedding"
                            ? `${item.row.customer_name} · ${compassBandLabel(item.band)}`
                            : item.kind === "task"
                              ? item.title
                              : item.kind === "rush_order"
                                ? `Rush order · ${item.row.customer_name}`
                                : item.row.title}
                        </p>
                        <p className="truncate text-[10px] font-medium text-app-text-muted">
                          {item.kind === "wedding"
                            ? `${item.row.party_name} · ${item.row.event_date}`
                            : item.kind === "task" && item.dueDate
                              ? `Due: ${item.dueDate}`
                              : item.kind === "rush_order"
                                ? `${money(item.row.total_price)} · need by ${item.row.need_by_date ?? "not set"}`
                                : "Notification source"}
                        </p>
                      </div>
                    </div>
                    <ChevronRight size={18} className="shrink-0 text-app-text-muted opacity-40" />
                  </button>
                ))}
              </div>
            )}
          </DashboardGridCard>

          <div data-testid="operations-alterations-section">
            <DashboardGridCard
              title="Alterations"
              subtitle="Due, overdue, and ready garments with a direct route to the tailoring queue"
              icon={Scissors}
              actionLabel="Open Queue"
              onAction={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
            >
              {feedLoadErrors.alterations ? (
                <FeedDegradedNotice message={feedLoadErrors.alterations} />
              ) : null}
              <div className="grid gap-3 md:grid-cols-4">
                <SummaryPill
                  label="Overdue"
                  value={feedLoadErrors.alterations ? "Not loaded" : alterationStats.overdue}
                  tone={alterationStats.overdue > 0 ? "danger" : "default"}
                  onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
                  ariaLabel="Open Alterations Queue"
                />
                <SummaryPill
                  label="Due today"
                  value={feedLoadErrors.alterations ? "Not loaded" : alterationStats.dueToday}
                  tone={alterationStats.dueToday > 0 ? "warn" : "default"}
                  onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
                  ariaLabel="Open Alterations Queue"
                />
                <SummaryPill
                  label="Ready pickup"
                  value={feedLoadErrors.alterations ? "Not loaded" : alterationStats.ready}
                  tone={alterationStats.ready > 0 ? "good" : "default"}
                  onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
                  ariaLabel="Open Alterations Queue"
                />
                <SummaryPill
                  label="Total open"
                  value={feedLoadErrors.alterations ? "Not loaded" : alterationStats.totalOpen}
                  onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
                  ariaLabel="Open Alterations Queue"
                />
              </div>
              {feedLoadErrors.alterations ? null : alterationAttentionRows.length === 0 ? (
                <div className="mt-4 rounded-2xl border border-app-border bg-app-surface-3 px-4 py-5 text-sm font-semibold text-app-text-muted">
                  No due, overdue, or ready alteration work is active right now.
                </div>
              ) : (
                <div className="mt-4 grid gap-3 lg:grid-cols-2">
                  {alterationAttentionRows.map((row) => {
                    const isOverdue = isAlterationOverdue(row);
                    const isDueToday = isAlterationDueToday(row);
                    const statusLabel = isOverdue
                      ? "Overdue"
                      : isDueToday
                        ? "Due today"
                        : row.status === "ready"
                          ? "Ready"
                          : row.status.replace(/_/g, " ");
                    return (
                      <button
                        type="button"
                        key={row.id}
                        onClick={() => onNavigateMetric?.({ tab: "alterations", section: "queue" })}
                        className="rounded-2xl border border-app-border bg-app-surface-3 px-4 py-3 text-left shadow-[0_8px_22px_rgba(15,23,42,0.05),0_2px_5px_rgba(15,23,42,0.03)] transition-colors hover:border-app-input-border hover:bg-app-surface-2"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-black text-app-text">{alterationCustomerName(row)}</p>
                            <p className="mt-1 truncate text-xs font-semibold text-app-text-muted">
                              {row.item_description || "Garment not specified"}
                            </p>
                          </div>
                          <span
                            className={`shrink-0 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-widest ${
                              isOverdue
                                ? "border-app-danger/20 bg-app-danger/10 text-app-danger"
                                : isDueToday
                                  ? "border-app-warning/20 bg-app-warning/10 text-app-warning"
                                  : "border-app-success/20 bg-app-success/10 text-app-success"
                            }`}
                          >
                            {statusLabel}
                          </span>
                        </div>
                        <p className="mt-2 line-clamp-2 text-[11px] font-medium leading-relaxed text-app-text-muted">
                          {row.work_requested || "Work details not specified"}
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          <span>{alterationSourceLabel(row.source_type)}</span>
                          <span>{row.due_at ? new Date(row.due_at).toLocaleDateString() : "No due date"}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </DashboardGridCard>
          </div>

          <DashboardGridCard
            title="Recent Activity"
            subtitle="Store floor and wedding events"
            icon={Activity}
          >
            <div className="space-y-5">
              {feedLoadErrors.activityFeed ? (
                <FeedDegradedNotice message={feedLoadErrors.activityFeed} />
              ) : activityFeed.length === 0 ? (
                <div className="py-12 text-center text-sm font-semibold text-app-text-muted">
                  No recent activity has posted yet.
                </div>
              ) : activityFeed.slice(0, 8).map((act) => (
                <div key={act.id} className="flex gap-4">
                  <div className="mt-1">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-app-accent/10 text-app-accent">
                      <Users size={14} />
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-xs font-bold text-app-text">
                      {act.actor_name} <span className="font-medium text-app-text-muted">performed</span> {act.action_type.replace(/_/g, " ")}
                    </p>
                    <p className="line-clamp-2 text-[10px] leading-relaxed text-app-text-muted">{act.description}</p>
                    <p className="text-[9px] font-bold text-app-text-muted/60">{new Date(act.created_at).toLocaleTimeString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </DashboardGridCard>
        </div>

        <div className="space-y-6 xl:col-span-4">
          <DashboardGridCard
            title="What Needs Attention"
            subtitle="Decision list; every row opens the source workflow"
            icon={Target}
            actionLabel="Inbox"
            onAction={openDrawer}
          >
            {topIssues.length === 0 ? (
              <div className="py-10 text-center text-sm font-semibold text-app-text-muted">
                No priority issues are active right now.
              </div>
            ) : (
              <div className="space-y-3">
                {topIssues.map((issue) => (
                  <button
                    type="button"
                    key={issue.id}
                    onClick={() => openOperationalSignal(issue.id)}
                    className={`w-full rounded-2xl border px-4 py-3 text-left shadow-[0_8px_22px_rgba(15,23,42,0.05),0_2px_5px_rgba(15,23,42,0.03)] transition-colors hover:border-app-input-border hover:bg-app-surface-3 ${
                      issue.tone === "danger"
                        ? "border-app-danger/16 bg-app-danger/10"
                        : issue.tone === "warn"
                          ? "border-app-warning/16 bg-app-warning/10"
                          : "border-app-border bg-app-surface-3"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs font-black text-app-text">{issue.label}</p>
                        <p className="mt-1 text-[11px] leading-relaxed text-app-text-muted">{issue.detail}</p>
                      </div>
                      <ChevronRight size={16} className="mt-0.5 shrink-0 text-app-text-muted opacity-40" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </DashboardGridCard>

          <DashboardGridCard
            title="Register Close"
            subtitle="Open drawers and close-review pressure"
            icon={ClipboardCheck}
            actionLabel="Daily Sales"
            onAction={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
          >
            {feedLoadErrors.registerSessions ? (
              <FeedDegradedNotice message={feedLoadErrors.registerSessions} />
            ) : null}
            <div className="grid grid-cols-3 gap-3">
              <SummaryPill
                label="Drawers"
                value={feedLoadErrors.registerSessions ? "—" : registerCloseStats.openDrawers}
                tone={registerCloseStats.reconciling > 0 ? "warn" : "default"}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Register Reports"
              />
              <SummaryPill
                label="Sessions"
                value={feedLoadErrors.registerSessions ? "—" : registerCloseStats.openSessions}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Register Reports"
              />
              <SummaryPill
                label="Closing"
                value={feedLoadErrors.registerSessions ? "—" : registerCloseStats.reconciling}
                tone={registerCloseStats.reconciling > 0 ? "warn" : "good"}
                onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                ariaLabel="Open Register Reports"
              />
            </div>
            <div className="mt-4 space-y-2">
              {openRegisterSessions.slice(0, 4).map((session) => (
                <button
                  type="button"
                  key={session.session_id}
                  onClick={() => onNavigateMetric?.({ tab: "home", section: "daily-sales" })}
                  className="flex w-full items-center justify-between rounded-xl border border-app-border bg-app-surface-3 px-3 py-2 text-left transition-colors hover:border-app-input-border hover:bg-app-surface-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-xs font-black text-app-text">
                      Register #{session.register_lane} · {session.cashier_name}
                    </p>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-app-text-muted">
                      {session.lifecycle_status.replace(/_/g, " ")}
                    </p>
                  </div>
                  <ChevronRight size={15} className="shrink-0 text-app-text-muted opacity-40" />
                </button>
              ))}
              {!feedLoadErrors.registerSessions && openRegisterSessions.length === 0 ? (
                <div className="rounded-xl border border-app-border bg-app-surface-3 px-3 py-4 text-sm font-semibold text-app-text-muted">
                  No open register sessions right now.
                </div>
              ) : null}
            </div>
          </DashboardGridCard>

          <SalesByHourSnapshotCard
            authHeaders={taskAuth}
            canLoad={
              permissionsLoaded &&
              (hasPermission("register.reports") || hasPermission("insights.view"))
            }
            refreshSignal={refreshSignal}
          />

          <DashboardGridCard
            title="Team on Floor"
            subtitle="Published schedule roster for today"
            icon={Users}
            actionLabel="Staff"
            onAction={() => onNavigateMetric?.({ tab: "staff", section: "schedule" })}
          >
            <div
              className={cn(
                "space-y-3 pr-1",
                (compass?.today_floor_staff ?? []).length > 10 && "max-h-[520px] overflow-y-auto",
              )}
            >
              {feedLoadErrors.morningCompass ? (
                <FeedDegradedNotice message={feedLoadErrors.morningCompass} />
              ) : (compass?.today_floor_staff ?? []).length === 0 ? (
                <div className="py-10 text-center text-xs font-semibold text-app-text-muted">
                  No staff scheduled for today.
                </div>
              ) : (
                compass?.today_floor_staff?.map((staff) => (
                  <button
                    type="button"
                    key={staff.id}
                    onClick={() => onNavigateMetric?.({ tab: "staff", section: "schedule" })}
                    className="flex w-full items-center justify-between rounded-xl bg-app-bg/30 p-3 text-left transition-colors hover:bg-app-surface-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <img src={staffAvatarUrl(staff.avatar_key)} className="h-8 w-8 shrink-0 rounded-lg bg-app-accent/20" alt="" />
                      <div className="min-w-0">
                        <p className="truncate text-xs font-bold text-app-text">{staff.full_name}</p>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <p className="truncate text-[9px] font-medium text-app-text-muted">{floorRoleLabel(staff.role)}</p>
                          {staff.shift_label && (
                            <>
                              <span className="text-[9px] text-app-text-muted opacity-40">·</span>
                              <span className="truncate text-[9px] font-black uppercase tracking-tighter text-app-accent">{staff.shift_label}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className={cn("h-2 w-2 shrink-0 rounded-full", staff.shift_label?.toLowerCase().includes("off") ? "bg-app-danger/30" : "bg-app-success")} />
                  </button>
                ))
              )}
            </div>
          </DashboardGridCard>
        </div>
      </div>
    </div>
  );

  if (activeSection === "dashboard" || !activeSection) {
    return (
      <>
        <div className="flex flex-1 flex-col bg-transparent">
          <div className="flex-1 p-6 sm:p-12">
            {renderDashboard()}
          </div>
        </div>

        <CompassMemberDetailDrawer
          row={compassDrawerRow}
          onClose={() => setCompassDrawerRow(null)}
          onOpenFullParty={(partyId) => {
            setCompassDrawerRow(null);
            onOpenWeddingParty?.(partyId);
          }}
        />

        <TaskChecklistDrawer
          open={taskDrawerId != null}
          instanceId={taskDrawerId}
          authHeaders={taskAuth}
          onClose={() => setTaskDrawerId(null)}
          onUpdated={() => void loadTasksMe()}
        />

      </>
    );
  }
}
