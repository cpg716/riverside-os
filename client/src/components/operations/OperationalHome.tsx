import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell,
  Clock,
  ListChecks,
  Ruler,
  ShoppingBag,
  Sun,
  Cloud,
  CloudRain,
  Snowflake,
  ThermometerSun,
  Users,
  Wind,
} from "lucide-react";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import CompassMemberDetailDrawer from "./CompassMemberDetailDrawer";
import DetailDrawer from "../layout/DetailDrawer";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  useNotificationCenter,
  useNotificationCenterOptional,
  type NotificationRow,
} from "../../context/NotificationCenterContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import ReviewsOperationsSection from "./ReviewsOperationsSection";
import PodiumMessagingInboxSection from "../customers/PodiumMessagingInboxSection";
import RegisterReports from "../pos/RegisterReports";
import type { Customer } from "../pos/CustomerSelector";
import {
  buildMorningCompassQueue,
  compassBandLabel,
  type CompassActionRow,
} from "../../lib/morningCompassQueue";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

export type { CompassActionRow };

interface CompassStats {
  needs_measure: number;
  needs_order: number;
  overdue_pickups: number;
}

interface TodayFloorStaffRow {
  id: string;
  full_name: string;
  role: string;
  avatar_key: string;
}

interface MorningCompassBundle {
  stats: CompassStats;
  needs_measure: CompassActionRow[];
  needs_order: CompassActionRow[];
  overdue_pickups: CompassActionRow[];
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

interface OperationalHomeProps {
  onOpenWeddingParty: (partyId: string) => void;
  onOpenOrderInBackoffice: (orderId: string) => void;
  /** Podium inbox row → open customer hub Messages. */
  onOpenInboxCustomer: (customer: Customer) => void;
  /** Increment to refetch compass + activity (e.g. after wedding edits). */
  refreshSignal?: number;
  activeSection?: string;
}

type CompassQueueKind = "overdue" | "measure" | "order";

function floorRoleLabel(role: string): string {
  if (role === "sales_support") return "Sales support";
  if (role === "salesperson") return "Salesperson";
  return role.replace(/_/g, " ");
}

function uniquePulseRows(c: MorningCompassBundle): CompassActionRow[] {
  const seen = new Set<string>();
  const out: CompassActionRow[] = [];
  const merged = [
    ...(c.overdue_pickups || []),
    ...(c.needs_measure || []),
    ...(c.needs_order || []),
  ];
  for (const r of merged) {
    if (seen.has(r.wedding_member_id)) continue;
    seen.add(r.wedding_member_id);
    out.push(r);
  }
  return out.slice(0, 16);
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
}

function WeatherDashboardWidget({ refreshSignal }: { refreshSignal: number }) {
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
  const headlineCondition = (current?.condition ?? today.condition).toLowerCase();
  const condition = headlineCondition;
  
  const isRain = condition.includes("rain");
  const isSnow = condition.includes("snow");
  const isCloudy = condition.includes("cloudy");

  const gradientClass = isSnow 
    ? "bg-[linear-gradient(135deg,#f0f9ff_0%,#e0f2fe_100%)] text-blue-900 border-blue-200"
    : isRain
    ? "bg-[linear-gradient(135deg,#f0fdf4_0%,#dcfce7_100%)] text-emerald-900 border-emerald-200"
    : isCloudy
    ? "border-app-border bg-[linear-gradient(135deg,var(--app-bg)_0%,var(--app-surface-2)_100%)] text-app-text"
    : "bg-[linear-gradient(135deg,#fffbeb_0%,#fef3c7_100%)] text-amber-900 border-amber-200";

  const Icon = isSnow ? Snowflake : isRain ? CloudRain : isCloudy ? Cloud : Sun;

  return (
    <div className={`mb-5 flex flex-col sm:flex-row items-stretch gap-0 rounded-[24px] border ${gradientClass} overflow-hidden shadow-sm animate-workspace-snap`}>
      <div className="flex-1 p-6 flex items-center gap-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-app-surface/50 shadow-inner dark:bg-app-surface-2/40">
          <Icon size={32} className={isSnow ? "text-blue-500" : isRain ? "text-emerald-500" : isCloudy ? "text-app-text-muted" : "text-amber-500"} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">Buffalo, NY</span>
            <div className="h-1 w-1 rounded-full bg-current opacity-30" />
            <span className="text-[10px] font-black uppercase tracking-[0.2em] opacity-60">Today</span>
          </div>
          <h3 className="text-2xl font-black tracking-tight leading-none mb-1">
            {current != null ? (
              <>
                {current.temp.toFixed(0)}°
                <span className="text-sm opacity-40 font-bold">
                  {" "}
                  now
                  <span className="mx-1 opacity-30">·</span>
                  {today.temp_high.toFixed(0)}° / {today.temp_low.toFixed(0)}°
                </span>
              </>
            ) : (
              <>
                {today.temp_high.toFixed(0)}°
                <span className="text-sm opacity-40"> / {today.temp_low.toFixed(0)}°</span>
              </>
            )}
          </h3>
          <p className="text-sm font-bold opacity-70">
            {current != null && Math.abs(current.feels_like - current.temp) >= 1
              ? `Feels like ${current.feels_like.toFixed(0)}° · `
              : ""}
            {current?.condition ?? today.condition}
            {current != null && current.wind_mph != null && current.wind_mph > 0
              ? ` · Wind ${current.wind_mph.toFixed(0)} mph`
              : ""}
            {" · "}
            {today.precipitation_inches > 0 ? `${today.precipitation_inches}"` : "no"} precip today
          </p>
        </div>
      </div>

      <div className="w-full sm:w-[240px] bg-app-surface/40 border-l border-current/5 p-6 flex items-center gap-5 dark:bg-app-surface-2/30">
        <div className="flex-1">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] opacity-50 mb-1">Tomorrow</p>
          <div className="flex items-center gap-2">
            <span className="text-lg font-black">{tomorrow.temp_high.toFixed(0)}°</span>
            <span className="text-xs font-bold opacity-40">{tomorrow.condition}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
           <Wind size={16} className="opacity-30" />
           <ThermometerSun size={16} className="opacity-30" />
        </div>
      </div>
    </div>
  );
}

export default function OperationalHome({
  onOpenWeddingParty,
  onOpenOrderInBackoffice,
  onOpenInboxCustomer,
  refreshSignal = 0,
  activeSection,
}: OperationalHomeProps) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } = useBackofficeAuth();
  const [taskMeOpen, setTaskMeOpen] = useState<
    { id: string; title_snapshot: string; due_date: string | null }[]
  >([]);
  const [taskDrawerId, setTaskDrawerId] = useState<string | null>(null);

  const taskAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const canViewWeddingBoard =
    permissionsLoaded && hasPermission("weddings.view");

  const loadTasksMe = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("tasks.complete")) return;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: taskAuth() });
      if (!res.ok) return;
      const data = (await res.json()) as {
        open?: { id: string; title_snapshot: string; due_date: string | null }[];
      };
      setTaskMeOpen(Array.isArray(data.open) ? data.open : []);
    } catch {
      /* ignore */
    }
  }, [permissionsLoaded, hasPermission, taskAuth]);

  useEffect(() => {
    void loadTasksMe();
  }, [loadTasksMe, refreshSignal]);

  const notifOpt = useNotificationCenterOptional();
  const refreshNotifUnread = notifOpt?.refreshUnread;
  const { openDrawer: openNotificationDrawer } = useNotificationCenter();
  useEffect(() => {
    if (activeSection === "inbox" && refreshNotifUnread) void refreshNotifUnread();
  }, [activeSection, refreshNotifUnread]);

  const [notifPreview, setNotifPreview] = useState<NotificationRow[]>([]);
  const loadNotifPreview = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("notifications.view")) {
      setNotifPreview([]);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/notifications?limit=16`, {
        headers: taskAuth(),
      });
      if (res.ok) setNotifPreview((await res.json()) as NotificationRow[]);
    } catch {
      /* ignore */
    }
  }, [permissionsLoaded, hasPermission, taskAuth]);

  useEffect(() => {
    void loadNotifPreview();
  }, [loadNotifPreview, refreshSignal]);

  const [compass, setCompass] = useState<MorningCompassBundle | null>(null);
  const [activityFeed, setActivityFeed] = useState<ActivityFeedEntry[]>([]);
  const [compassDrawerRow, setCompassDrawerRow] =
    useState<CompassActionRow | null>(null);
  const [queueDrawer, setQueueDrawer] = useState<CompassQueueKind | null>(null);

  const loadMorningBoard = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("weddings.view")) {
      setCompass(null);
      setActivityFeed([]);
      return;
    }
    const [cRes, fRes] = await Promise.all([
      fetch(`${baseUrl}/api/weddings/morning-compass`, {
        headers: taskAuth(),
      }),
      fetch(`${baseUrl}/api/weddings/activity-feed?limit=40`, {
        headers: taskAuth(),
      }),
    ]);
    if (cRes.ok) {
      const data = (await cRes.json()) as MorningCompassBundle;
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
          today_floor_staff: Array.isArray(data.today_floor_staff) ? data.today_floor_staff : [],
        });
      }
    }
    if (fRes.ok) setActivityFeed((await fRes.json()) as ActivityFeedEntry[]);
  }, [taskAuth, permissionsLoaded, hasPermission]);

  useEffect(() => {
    void loadMorningBoard();
    const interval = setInterval(loadMorningBoard, 60 * 1000); // 1 min auto-refresh
    return () => clearInterval(interval);
  }, [loadMorningBoard, refreshSignal]);

  const queueMeta = useMemo(() => {
    if (!queueDrawer || !compass) return null;
    if (queueDrawer === "overdue")
      return {
        title: "Overdue pickups",
        subtitle: "Past event · not picked up",
        rows: compass.overdue_pickups,
      };
    if (queueDrawer === "measure")
      return {
        title: "Needs measure",
        subtitle: "Within window · not measured",
        rows: compass.needs_measure,
      };
    return {
      title: "Needs order",
      subtitle: "Measured · vendor PO pending",
      rows: compass.needs_order,
    };
  }, [queueDrawer, compass]);

  const pulseRows = useMemo(
    () => (compass ? uniquePulseRows(compass) : []),
    [compass],
  );

  const suggestedMorningQueue = useMemo(
    () =>
      buildMorningCompassQueue({
        overduePickups: compass?.overdue_pickups ?? [],
        needsOrder: compass?.needs_order ?? [],
        needsMeasure: compass?.needs_measure ?? [],
        openTasks: taskMeOpen,
        notifications: notifPreview,
        limit: 12,
      }),
    [compass, taskMeOpen, notifPreview],
  );

  const showOperationsMorningCoach =
    permissionsLoaded &&
    (canViewWeddingBoard ||
      hasPermission("tasks.complete") ||
      hasPermission("notifications.view"));

  if (activeSection === "register-reports") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-transparent p-3 sm:p-6">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] sm:rounded-[28px] border border-app-border bg-app-surface">
          {!permissionsLoaded ? (
            <p className="p-6 text-sm text-app-text-muted">Loading…</p>
          ) : !hasPermission("register.reports") ? (
            <div className="p-6">
              <p className="text-sm text-app-text-muted">
                You need the <span className="font-semibold text-app-text">register.reports</span> permission
                to view register and daily sales activity.
              </p>
            </div>
          ) : (
            <RegisterReports sessionId={null} onOpenWeddingParty={onOpenWeddingParty} />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "inbox") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-transparent p-3 sm:p-6">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[20px] sm:rounded-[28px] border border-app-border bg-app-surface">
          {!permissionsLoaded ? (
            <p className="p-6 text-sm text-app-text-muted">Loading…</p>
          ) : !hasPermission("customers.hub_view") ? (
            <div className="p-6">
              <p className="text-sm text-app-text-muted">
                You need the <span className="font-semibold text-app-text">customers.hub_view</span>{" "}
                permission to use the inbox.
              </p>
            </div>
          ) : (
            <PodiumMessagingInboxSection onOpenCustomerHub={onOpenInboxCustomer} />
          )}
        </div>
      </div>
    );
  }

  if (activeSection === "reviews") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-transparent p-3 sm:p-6">
        <div className="min-h-0 flex-1 overflow-auto rounded-[20px] sm:rounded-[28px] border border-app-border bg-app-surface p-4 sm:p-7">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
                Operations
              </p>
              <h2 className="text-2xl font-black tracking-tight text-app-text">Reviews</h2>
            </div>
          </div>
          {!permissionsLoaded ? (
            <p className="text-sm text-app-text-muted">Loading…</p>
          ) : !hasPermission("reviews.view") ? (
            <p className="text-sm text-app-text-muted">
              You need the <span className="font-semibold text-app-text">reviews.view</span> permission
              to see this list.
            </p>
          ) : (
            <ReviewsOperationsSection
              onOpenOrderInBackoffice={onOpenOrderInBackoffice}
              refreshSignal={refreshSignal}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent p-3 sm:p-6">
      <CompassMemberDetailDrawer
        row={compassDrawerRow}
        onClose={() => setCompassDrawerRow(null)}
        onOpenFullParty={onOpenWeddingParty}
      />

      <TaskChecklistDrawer
        open={taskDrawerId !== null}
        instanceId={taskDrawerId}
        authHeaders={taskAuth}
        onClose={() => setTaskDrawerId(null)}
        onUpdated={() => void loadTasksMe()}
      />

      <DetailDrawer
        isOpen={queueDrawer !== null && queueMeta !== null}
        onClose={() => setQueueDrawer(null)}
        title={queueMeta?.title ?? ""}
        subtitle={queueMeta?.subtitle}
      >
        {!queueMeta ? null : queueMeta.rows.length === 0 ? (
          <p className="text-sm text-app-text-muted">Nothing in this queue.</p>
        ) : (
          <ul className="space-y-2">
            {queueMeta.rows.map((r) => (
              <li key={r.wedding_member_id}>
                <button
                  type="button"
                  onClick={() => {
                    setQueueDrawer(null);
                    setCompassDrawerRow(r);
                  }}
                  className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-left shadow-sm transition-all hover:bg-app-surface"
                >
                  <div className="min-w-0">
                    <p className="font-black uppercase tracking-tight text-app-text">
                      {r.customer_name} · {r.role}
                    </p>
                    <p className="text-xs text-app-text-muted">
                      {r.party_name} · {r.event_date}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted opacity-0 transition-opacity group-hover:opacity-100">
                    Open
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </DetailDrawer>

      <div className="min-h-0 flex-1 overflow-auto rounded-[20px] sm:rounded-[28px] border border-app-border bg-app-surface p-4 sm:p-7">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">Operations</p>
            <h2 className="text-2xl font-black tracking-tight text-app-text">Morning Dashboard</h2>
          </div>
          <div className="flex items-center gap-2">
            <span className="ui-pill bg-app-surface-2 text-app-text-muted">Live updates (1m)</span>
          </div>
        </div>

        {showOperationsMorningCoach ? (
          <section
            data-testid="operations-morning-compass-coach"
            className="mb-5 rounded-2xl border border-app-accent/30 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2)),var(--app-surface))] p-4 sm:p-5"
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black uppercase tracking-wide text-app-text">Suggested next</h3>
              <span className="text-[10px] font-semibold text-app-text-muted">
                Ranked from weddings, tasks, and inbox (explainable rules — not predictions).
              </span>
            </div>
            {suggestedMorningQueue.length === 0 ? (
              <p data-testid="operations-morning-compass-coach-empty" className="text-sm font-semibold text-app-text-muted">
                No prioritized actions right now.
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2" data-testid="operations-morning-compass-coach-list">
                {suggestedMorningQueue.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid={`operations-morning-compass-coach-item-${item.kind}`}
                      onClick={() => {
                        if (item.kind === "wedding") setCompassDrawerRow(item.row);
                        else if (item.kind === "task") setTaskDrawerId(item.taskId);
                        else openNotificationDrawer();
                      }}
                      className="flex h-full w-full items-start gap-3 rounded-2xl border border-app-border bg-app-surface/95 px-4 py-3 text-left shadow-sm transition hover:border-app-accent/45"
                    >
                      <span
                        className={`mt-0.5 shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
                          item.tier === "urgent"
                            ? "bg-red-500/15 text-red-800 dark:text-red-200"
                            : item.tier === "soon"
                              ? "bg-amber-500/15 text-amber-900 dark:text-amber-100"
                              : "bg-app-surface-2 text-app-text-muted"
                        }`}
                      >
                        {item.tier === "urgent" ? "Now" : item.tier === "soon" ? "Soon" : "FYI"}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-bold leading-snug text-app-text">
                          {item.kind === "wedding"
                            ? `${item.row.customer_name} · ${compassBandLabel(item.band)}`
                            : item.kind === "task"
                              ? item.title
                              : item.row.title}
                        </span>
                        <span className="mt-1 block text-xs font-semibold text-app-text-muted">
                          {item.kind === "wedding"
                            ? `${item.row.party_name} · event ${item.row.event_date}`
                            : item.kind === "task"
                              ? item.dueDate
                                ? `Due ${item.dueDate}`
                                : "Staff task"
                              : "Notification inbox"}
                        </span>
                      </span>
                      {item.kind === "notification" ? (
                        <Bell className="mt-1 h-4 w-4 shrink-0 text-app-accent" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <div className="mb-5 rounded-2xl border border-app-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent-2)_24%,var(--app-surface-2)),color-mix(in_srgb,var(--app-accent)_12%,var(--app-surface-2)))] p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
            Executive pulse strip
          </p>
          <p className="mt-1 text-sm font-semibold text-app-text">
            Critical queue metrics and throughput are refreshed continuously for floor operations.
          </p>
        </div>

        {compass ? (
          <section className="mb-5 rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="mb-3 flex items-center gap-2">
              <Users className="h-[18px] w-[18px] text-app-accent" aria-hidden />
              <h3 className="text-sm font-black text-app-text">Today&apos;s floor team</h3>
              <span className="ui-pill bg-app-surface text-app-text-muted">
                {(compass.today_floor_staff ?? []).length} scheduled
              </span>
            </div>
            <p className="mb-3 text-xs text-app-text-muted">
              Store-local today from Staff → Schedule (salesperson &amp; sales support). Refreshes with the
              morning board.
            </p>
            {(compass.today_floor_staff ?? []).length === 0 ? (
              <p className="text-sm text-app-text-muted">
                No floor staff on the schedule for today, or schedule data is not available yet.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-3">
                {(compass.today_floor_staff ?? []).map((s) => (
                  <li
                    key={s.id}
                    className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2"
                  >
                    <img
                      src={staffAvatarUrl(s.avatar_key)}
                      alt=""
                      className="h-9 w-9 shrink-0 rounded-full border border-app-border object-cover"
                    />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-app-text">{s.full_name}</p>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                        {floorRoleLabel(s.role)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {permissionsLoaded && hasPermission("tasks.complete") ? (
          <section className="mb-5 rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="mb-2 flex items-center gap-2">
              <ListChecks className="text-app-accent" size={18} />
              <h3 className="text-sm font-black text-app-text">My tasks</h3>
              <span className="ui-pill bg-app-surface text-app-text-muted">
                {taskMeOpen.length} open
              </span>
            </div>
            {taskMeOpen.length === 0 ? (
              <p className="text-sm text-app-text-muted">No open tasks right now.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {taskMeOpen.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setTaskDrawerId(t.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-left text-sm"
                    >
                      <span className="font-semibold text-app-text">{t.title_snapshot}</span>
                      <span className="text-[10px] text-app-text-muted">{t.due_date ?? "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {canViewWeddingBoard ? (
          <div className="mb-5 grid grid-cols-1 gap-4 md:grid-cols-3">
            <button
              type="button"
              onClick={() => setQueueDrawer("measure")}
              className="rounded-2xl border border-[#e6dbff] bg-[#f6f1ff] p-4 text-left"
            >
              <div className="mb-2 flex items-center gap-2 text-[#6e4bb3]">
                <Ruler size={16} />
                <span className="text-[11px] font-black uppercase tracking-[0.14em]">Needs measure</span>
              </div>
              <p className="text-4xl font-black text-[#3e2d66]">{compass?.stats.needs_measure ?? 0}</p>
            </button>
            <button
              type="button"
              onClick={() => setQueueDrawer("order")}
              className="rounded-2xl border border-[#cfe7ef] bg-[#e8f5fa] p-4 text-left"
            >
              <div className="mb-2 flex items-center gap-2 text-[#2f6d86]">
                <ShoppingBag size={16} />
                <span className="text-[11px] font-black uppercase tracking-[0.14em]">Needs order</span>
              </div>
              <p className="text-4xl font-black text-[#1d4b5d]">{compass?.stats.needs_order ?? 0}</p>
            </button>
            <button
              type="button"
              onClick={() => setQueueDrawer("overdue")}
              className="rounded-2xl border border-[#ffe2c7] bg-[#fff1e4] p-4 text-left"
            >
              <div className="mb-2 flex items-center gap-2 text-[#a0602b]">
                <Clock size={16} />
                <span className="text-[11px] font-black uppercase tracking-[0.14em]">Overdue pickup</span>
              </div>
              <p className="text-4xl font-black text-[#6d3e18]">{compass?.stats.overdue_pickups ?? 0}</p>
            </button>
          </div>
        ) : permissionsLoaded ? (
          <p className="mb-5 rounded-2xl border border-app-border bg-app-surface-2 p-4 text-sm text-app-text-muted">
            Wedding queue metrics and activity feed require the{" "}
            <span className="font-semibold text-app-text">weddings.view</span> permission.
          </p>
        ) : null}

        <WeatherDashboardWidget refreshSignal={refreshSignal} />

        <div className="ui-section-stack">
          <section className="ui-zone-primary p-5">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-6">
              <div className="min-w-[300px] flex-1">
                <h3 className="mb-4 text-sm font-black text-app-text">Urgent actions</h3>
                {!canViewWeddingBoard ? (
                  <p className="text-sm text-app-text-muted">
                    Wedding queue data requires the{" "}
                    <span className="font-semibold text-app-text">weddings.view</span> permission.
                  </p>
                ) : !compass ? (
                  <p className="text-sm text-app-text-muted">Loading...</p>
                ) : pulseRows.length === 0 ? (
                  <p className="text-sm text-app-text-muted">No urgent members.</p>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead className="text-[10px] font-black uppercase tracking-[0.14em] text-app-text-muted">
                      <tr>
                        <th className="py-2">Customer / Role</th>
                        <th className="py-2">Party / Event</th>
                        <th className="py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pulseRows.map((r) => (
                        <tr key={r.wedding_member_id} className="border-t border-app-border">
                          <td className="py-2.5">
                            <p className="font-semibold text-app-text">{r.customer_name}</p>
                            <p className="text-[11px] text-app-text-muted">{r.role}</p>
                          </td>
                          <td className="py-2.5 text-app-text-muted">
                            <p className="text-app-text-muted">{r.party_name}</p>
                            <p className="text-[11px] text-app-text-muted">{r.event_date}</p>
                          </td>
                          <td className="py-2.5 text-right">
                            <button
                              type="button"
                              onClick={() => setCompassDrawerRow(r)}
                              className="ui-btn-secondary px-3 py-1.5"
                            >
                              Open
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="min-w-[300px] flex-1 border-l border-app-border pl-6">
                <h3 className="mb-4 text-sm font-black text-app-text">Global activity feed</h3>
                {!canViewWeddingBoard ? (
                  <p className="text-sm text-app-text-muted">
                    Activity feed requires the{" "}
                    <span className="font-semibold text-app-text">weddings.view</span> permission.
                  </p>
                ) : activityFeed.length === 0 ? (
                  <p className="text-sm text-app-text-muted">No activity yet.</p>
                ) : (
                  <ul className="space-y-4">
                    {activityFeed.map((ev) => (
                      <li
                        key={ev.id}
                        className="border-b border-app-border pb-3 text-sm last:border-0 last:pb-0"
                      >
                        <p className="font-semibold text-app-text">
                          {ev.actor_name}{" "}
                          <span className="px-1 font-normal text-app-text-muted">did</span> {ev.action_type}
                        </p>
                        <p className="mt-0.5 text-app-text-muted">{ev.description}</p>
                        <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                          {new Date(ev.created_at).toLocaleString()} · {ev.party_name}{" "}
                          {ev.member_name ? `(${ev.member_name})` : ""}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
