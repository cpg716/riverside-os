import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bell,
  Cloud,
  CloudRain,
  Heart,
  ListChecks,
  ShoppingCart,
  Snowflake,
  Sun,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  useNotificationCenter,
  type NotificationRow,
} from "../../context/NotificationCenterContextLogic";
import {
  buildMorningCompassQueue,
  compassBandLabel,
  type CompassActionRow,
  type RushOrderRow,
} from "../../lib/morningCompassQueue";
import { parseNotificationBundle } from "../../lib/notificationBundle";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import CompassMemberDetailDrawer from "../operations/CompassMemberDetailDrawer";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface CompassStats {
  needs_measure: number;
  needs_order: number;
  overdue_pickups: number;
  rush_orders: number;
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
  rush_orders: RushOrderRow[];
  today_floor_staff?: TodayFloorStaffRow[];
}


interface ForecastDay {
  temp_high: number;
  temp_low: number;
  condition: string;
}

interface ForecastCurrent {
  temp: number;
  feels_like: number;
  condition: string;
}

interface WeatherForecastPayload {
  days: ForecastDay[];
  current?: ForecastCurrent | null;
}

interface TenderTotal {
  payment_method: string;
  total_amount: string;
  tx_count: number;
}

interface XReportShape {
  tenders?: TenderTotal[];
}

function roleHeadline(role: string | null): string {
  if (role === "sales_support") return "Sales support";
  if (role === "salesperson") return "Sales";
  if (role === "admin") return "Admin";
  return "Team";
}

export interface RegisterDashboardProps {
  sessionId: string;
  registerOrdinal: number | null;
  cashierName: string | null;
  lifecycleStatus: string | null;
  onGoToRegister: () => void;
  onGoToWeddings: () => void;
  onGoToTasks: () => void;
  /** Opens full wedding workspace for a party (leaves POS). */
  onOpenWeddingParty?: (partyId: string) => void;
  refreshSignal?: number;
}

export default function RegisterDashboard({
  sessionId,
  registerOrdinal,
  cashierName,
  lifecycleStatus,
  onGoToRegister,
  onGoToWeddings,
  onGoToTasks,
  onOpenWeddingParty,
  refreshSignal = 0,
}: RegisterDashboardProps) {
  const {
    backofficeHeaders,
    hasPermission,
    permissionsLoaded,
    staffDisplayName,
    staffRole,
  } = useBackofficeAuth();
  const { openDrawer } = useNotificationCenter();

  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [taskOpen, setTaskOpen] = useState<
    { id: string; title_snapshot: string; due_date: string | null }[]
  >([]);
  const [taskDrawerId, setTaskDrawerId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [compass, setCompass] = useState<MorningCompassBundle | null>(null);
  const [compassDrawerRow, setCompassDrawerRow] = useState<CompassActionRow | null>(null);
  const [forecast, setForecast] = useState<WeatherForecastPayload | null>(null);
  const [xReport, setXReport] = useState<XReportShape | null>(null);
  const [metrics, setMetrics] = useState<{
    line_count: number;
    attributed_gross: string;
    store_date: string;
  } | null>(null);

  const loadTasks = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("tasks.complete")) return;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: apiAuth() });
      if (!res.ok) return;
      const data = (await res.json()) as {
        open?: { id: string; title_snapshot: string; due_date: string | null }[];
        completed_recent?: unknown[];
      };
      setTaskOpen(Array.isArray(data.open) ? data.open : []);
    } catch {
      /* ignore */
    }
  }, [apiAuth, hasPermission, permissionsLoaded]);

  const loadNotifications = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("notifications.view")) return;
    try {
      const res = await fetch(`${baseUrl}/api/notifications?limit=8`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      setNotifications((await res.json()) as NotificationRow[]);
    } catch {
      /* ignore */
    }
  }, [apiAuth, hasPermission, permissionsLoaded]);

  const loadCompass = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("weddings.view")) {
      setCompass(null);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/weddings/morning-compass`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as MorningCompassBundle;
      setCompass({
        stats: {
          needs_measure: Number(data.stats?.needs_measure ?? 0),
          needs_order: Number(data.stats?.needs_order ?? 0),
          overdue_pickups: Number(data.stats?.overdue_pickups ?? 0),
          rush_orders: Number(data.stats?.rush_orders ?? 0),
        },
        needs_measure: Array.isArray(data.needs_measure) ? data.needs_measure : [],
        needs_order: Array.isArray(data.needs_order) ? data.needs_order : [],
        overdue_pickups: Array.isArray(data.overdue_pickups) ? data.overdue_pickups : [],
        rush_orders: Array.isArray(data.rush_orders) ? data.rush_orders : [],
        today_floor_staff: Array.isArray(data.today_floor_staff) ? data.today_floor_staff : [],
      });
    } catch {
      /* ignore */
    }
  }, [apiAuth, hasPermission, permissionsLoaded]);

  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/weather/forecast`);
      if (res.ok) setForecast((await res.json()) as WeatherForecastPayload);
    } catch {
      /* ignore */
    }
  }, []);

  const loadXReport = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("register.reports")) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/x-report`,
        { headers: apiAuth() },
      );
      if (!res.ok) return;
      setXReport((await res.json()) as XReportShape);
    } catch {
      /* ignore */
    }
  }, [apiAuth, hasPermission, permissionsLoaded, sessionId]);

  const _loadMetrics = useCallback(async () => {
    if (!permissionsLoaded) return;
    if (staffRole !== "salesperson" && staffRole !== "sales_support") {
      setMetrics(null);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/staff/self/register-metrics`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        line_count?: number;
        attributed_gross?: string;
        store_date?: string;
      };
      setMetrics({
        line_count: Number(data.line_count ?? 0),
        attributed_gross: String(data.attributed_gross ?? "0"),
        store_date: String(data.store_date ?? ""),
      });
    } catch {
      /* ignore */
    }
  }, [backofficeHeaders, permissionsLoaded, staffRole]);

  useEffect(() => {
    void loadTasks();
    void _loadMetrics();
    void loadXReport();
    void loadWeather();
  }, [loadTasks, _loadMetrics, loadXReport, loadWeather, refreshSignal]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications, refreshSignal]);

  useEffect(() => {
    void loadCompass();
  }, [loadCompass, refreshSignal]);

  useEffect(() => {
    void loadWeather();
  }, [loadWeather, refreshSignal]);

  useEffect(() => {
    void loadXReport();
  }, [loadXReport, refreshSignal]);

  const notifAction = async (
    id: string,
    path: "read" | "complete" | "archive",
  ) => {
    try {
      const res = await fetch(`${baseUrl}/api/notifications/${id}/${path}`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) return;
      void loadNotifications();
    } catch {
      /* ignore */
    }
  };

  const headline = useMemo(
    () => roleHeadline(staffRole),
    [staffRole],
  );

  const suggestedQueue = useMemo(
    () =>
      buildMorningCompassQueue({
        overduePickups: compass?.overdue_pickups ?? [],
        needsOrder: (compass as any)?.needs_order ?? [],
        needsMeasure: compass?.needs_measure ?? [],
        rushOrders: compass?.rush_orders ?? [],
        openTasks: taskOpen,
        notifications,
        limit: 7,
      }),
    [compass, taskOpen, notifications],
  );

  const showMorningCompassCoach =
    permissionsLoaded &&
    (hasPermission("weddings.view") ||
      hasPermission("tasks.complete") ||
      hasPermission("notifications.view"));

  const todayWeather = forecast?.days?.[0];
  const current = forecast?.current;
  const cond = (current?.condition ?? todayWeather?.condition ?? "").toLowerCase();
  const WxIcon =
    cond.includes("snow") ? Snowflake : cond.includes("rain") ? CloudRain : cond.includes("cloud") ? Cloud : Sun;

  const stats = compass?.stats;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto bg-app-bg p-4 sm:p-5 lg:gap-4 lg:p-6"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            POS · Dashboard
          </p>
          <h1 className="text-xl font-black tracking-tight text-app-text lg:text-2xl">
            {headline}
            <span className="text-app-text-muted font-semibold">
              {" "}
              · {cashierName?.trim() || staffDisplayName.trim() || "Staff"}
            </span>
          </h1>
          <p className="mt-1 text-xs text-app-text-muted">
            Register #{registerOrdinal ?? "—"}
            {lifecycleStatus === "reconciling" ? " · Reconciling" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={onGoToRegister}
          className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-4 py-2.5 text-xs font-black uppercase tracking-widest text-white shadow-md touch-manipulation lg:px-5"
        >
          <ShoppingCart size={18} aria-hidden />
          Open register
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>

      {showMorningCompassCoach ? (
        <div
          data-testid="register-morning-compass-coach"
          className="rounded-2xl border border-app-accent/25 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--app-accent)_12%,var(--app-surface)),var(--app-surface-2))] p-3 shadow-sm"
        >
          <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
            Suggested next
          </p>
          {suggestedQueue.length === 0 ? (
            <p data-testid="register-morning-compass-coach-empty" className="text-xs font-semibold text-app-text-muted">
              No prioritized actions right now.
            </p>
          ) : (
            <ul className="space-y-1.5" data-testid="register-morning-compass-coach-list">
              {suggestedQueue.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`register-morning-compass-coach-item-${item.kind}`}
                    onClick={() => {
                      if (item.kind === "wedding") setCompassDrawerRow(item.row);
                      else if (item.kind === "task") setTaskDrawerId(item.taskId);
                      else if (item.kind === "rush_order") {
                        // TODO: Open order detail or navigate to Order Workspace
                      }
                      else openDrawer();
                    }}
                    className="flex w-full items-start gap-2 rounded-xl border border-app-border/70 bg-app-surface/90 px-3 py-2 text-left transition hover:border-app-accent/40"
                  >
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide ${
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
                      <span className="block text-sm font-bold leading-snug text-app-text">
                        {item.kind === "wedding"
                          ? `${item.row.customer_name} · ${compassBandLabel(item.band)}`
                          : item.kind === "task"
                            ? item.title
                            : item.kind === "rush_order"
                              ? `${item.row.customer_name} · URGENT`
                              : item.row.title}
                      </span>
                      <span className="mt-0.5 block text-[11px] font-semibold text-app-text-muted">
                        {item.kind === "wedding"
                          ? `${item.row.party_name} · ${item.row.event_date}`
                          : item.kind === "task"
                            ? item.dueDate
                              ? `Due ${item.dueDate}`
                              : "Task"
                            : item.kind === "rush_order"
                              ? `Need by ${item.row.need_by_date || 'ASAP'} · $${item.row.total_price}`
                              : "Open inbox"}
                      </span>
                    </span>
                    {item.kind === "notification" ? (
                      <Bell className="mt-1 h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {todayWeather ? (
        <div className="flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface px-4 py-3">
          <WxIcon className="h-8 w-8 shrink-0 text-app-accent" aria-hidden />
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Weather · Today
            </p>
            <p className="truncate text-sm font-bold text-app-text">
              {current != null
                ? `${current.temp.toFixed(0)}° · ${current.condition}`
                : `${todayWeather.temp_high.toFixed(0)}° / ${todayWeather.temp_low.toFixed(0)}° · ${todayWeather.condition}`}
            </p>
          </div>
        </div>
      ) : null}

      {metrics && (staffRole === "salesperson" || staffRole === "sales_support") ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-2xl border border-app-border bg-app-surface p-4">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Your attributed lines · {metrics.store_date}
            </p>
            <p className="mt-1 text-2xl font-black text-app-text">{metrics.line_count}</p>
            <p className="text-xs text-app-text-muted">Lines on orders paid today</p>
          </div>
          <div className="rounded-2xl border border-app-border bg-app-surface p-4">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Attributed gross
            </p>
            <p className="mt-1 text-2xl font-black text-app-text">
              ${metrics.attributed_gross}
            </p>
            <p className="text-xs text-app-text-muted">Pre-tax line total</p>
          </div>
        </div>
      ) : null}

      {permissionsLoaded && hasPermission("register.reports") && xReport?.tenders?.length ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
            Session tenders (X report)
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {xReport.tenders.slice(0, 6).map((t) => (
              <li
                key={t.payment_method}
                className="flex justify-between gap-2 border-b border-app-border/40 py-1 last:border-0"
              >
                <span className="font-semibold text-app-text">{t.payment_method}</span>
                <span className="text-app-text-muted">
                  ${t.total_amount} · {t.tx_count} tx
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {permissionsLoaded && hasPermission("weddings.view") && stats ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Wedding pulse
            </p>
            <button
              type="button"
              onClick={onGoToWeddings}
              className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase"
            >
              <Heart size={14} className="mr-1 inline" aria-hidden />
              Weddings
            </button>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-center">
            <div className="rounded-xl bg-app-surface-2 p-2">
              <p className="text-lg font-black text-app-text">{stats.needs_measure}</p>
              <p className="text-[9px] font-bold uppercase text-app-text-muted">Measure</p>
            </div>
            <div className="rounded-xl bg-app-surface-2 p-2">
              <p className="text-lg font-black text-app-text">{stats.needs_order}</p>
              <p className="text-[9px] font-bold uppercase text-app-text-muted">Order</p>
            </div>
            <div className="rounded-xl bg-app-surface-2 p-2">
              <p className="text-lg font-black text-amber-600">{stats.overdue_pickups}</p>
              <p className="text-[9px] font-bold uppercase text-app-text-muted">Overdue</p>
            </div>
            <div className="rounded-xl bg-app-surface-2 p-2">
              <p className="text-lg font-black text-red-600">{stats.rush_orders}</p>
              <p className="text-[9px] font-bold uppercase text-app-text-muted">Rush</p>
            </div>
          </div>
        </div>
      ) : null}

      {permissionsLoaded && hasPermission("tasks.complete") ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Shift tasks
            </p>
            <button
              type="button"
              onClick={onGoToTasks}
              className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase"
            >
              <ListChecks size={14} className="mr-1 inline" aria-hidden />
              All tasks
            </button>
          </div>
          {taskOpen.length === 0 ? (
            <p className="mt-2 text-sm text-app-text-muted">No open checklist items.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {taskOpen.slice(0, 5).map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setTaskDrawerId(t.id)}
                    className="w-full rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-left text-sm font-semibold text-app-text hover:bg-app-surface"
                  >
                    {t.title_snapshot}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {permissionsLoaded && hasPermission("notifications.view") ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-wider text-app-text-muted">
              Notifications
            </p>
            <button
              type="button"
              onClick={openDrawer}
              className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase"
            >
              Open inbox
            </button>
          </div>
          {notifications.length === 0 ? (
            <p className="mt-2 text-sm text-app-text-muted">No unread items in preview.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {notifications.map((r) => {
                const bundle = parseNotificationBundle(r.deep_link);
                return (
                <li
                  key={r.staff_notification_id}
                  className="rounded-xl border border-app-border bg-app-surface-2 p-2"
                >
                  <p className="line-clamp-2 text-xs font-bold text-app-text">
                    {r.title}
                  </p>
                  {bundle ? (
                    <p className="mt-1 text-[10px] text-app-text-muted">
                      {bundle.length} items — open inbox to expand
                    </p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {!r.read_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[10px]"
                        onClick={() => void notifAction(r.staff_notification_id, "read")}
                      >
                        Read
                      </button>
                    ) : null}
                    {!r.completed_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[10px]"
                        onClick={() => void notifAction(r.staff_notification_id, "complete")}
                      >
                        Complete
                      </button>
                    ) : null}
                    {!r.archived_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[10px]"
                        onClick={() => void notifAction(r.staff_notification_id, "archive")}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </li>
              );
              })}
            </ul>
          )}
        </div>
      ) : null}

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
        authHeaders={apiAuth}
        onClose={() => setTaskDrawerId(null)}
        onUpdated={() => void loadTasks()}
      />
    </div>
  );
}
