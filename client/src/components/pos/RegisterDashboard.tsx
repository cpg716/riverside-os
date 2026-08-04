import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bell,
  ChevronRight,
  Cloud,
  CloudRain,
  ClipboardCheck,
  DollarSign,
  Heart,
  Package,
  PackageCheck,
  Scissors,
  ShoppingCart,
  Snowflake,
  Sun,
  Zap,
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
  type MorningCompassQueueItem,
  type RushOrderRow,
} from "../../lib/morningCompassQueue";
import {
  hasStaffOrPosAuthHeaders,
  mergedPosStaffHeaders,
} from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import CompassMemberDetailDrawer from "../operations/CompassMemberDetailDrawer";
import SalesByHourSnapshotCard from "../reports/SalesByHourSnapshotCard";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import DashboardGridCard from "../ui/DashboardGridCard";
import DashboardStatsCard from "../ui/DashboardStatsCard";

const baseUrl = getBaseUrl();

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

interface WeatherForecastPayload {
  days: Array<{
    temp_high: number;
    temp_low: number;
    condition: string;
  }>;
  current?: {
    temp: number;
    feels_like: number;
    condition: string;
  } | null;
  source?: string;
  location?: string;
}

function roleHeadline(role: string | null): string {
  if (role === "sales_support") return "Sales Support";
  if (role === "salesperson") return "Sales Specialist";
  if (role === "admin") return "Manager";
  return "Team Member";
}

export interface RegisterDashboardProps {
  registerLane: number | null;
  registerOrdinal: number | null;
  cashierName: string | null;
  onGoToRegister: () => void;
  onGoToWeddings: () => void;
  onGoToOrders?: () => void;
  onGoToAlterations?: () => void;
  onGoToInventory?: () => void;
  onGoToTasks?: () => void;
  onOpenOrderInRegister?: (orderId: string) => void;
  onOpenWeddingParty?: (partyId: string) => void;
  refreshSignal?: number;
}

export default function RegisterDashboard({
  registerLane,
  registerOrdinal,
  cashierName,
  onGoToRegister,
  onGoToWeddings,
  onGoToOrders,
  onGoToAlterations,
  onGoToInventory,
  onGoToTasks,
  onOpenOrderInRegister,
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
  const { notifications, openDrawer, unread } = useNotificationCenter();

  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const hasDashboardAuth = useCallback(
    () => hasStaffOrPosAuthHeaders(apiAuth()),
    [apiAuth],
  );

  const [taskOpen, setTaskOpen] = useState<{ id: string; title_snapshot: string; due_date: string | null }[]>([]);
  const [taskDrawerId, setTaskDrawerId] = useState<string | null>(null);
  const [compass, setCompass] = useState<MorningCompassBundle | null>(null);
  const [compassDrawerRow, setCompassDrawerRow] = useState<CompassActionRow | null>(null);
  const [forecast, setForecast] = useState<WeatherForecastPayload | null>(null);
  const [todayBookedSales, setTodayBookedSales] = useState<{ total: string; count: number } | null>(null);

  // Keep this card on the same canonical booked Daily Sales calculation used
  // by Back Office, Register Reports, and register close.
  const loadTodaySales = useCallback(async () => {
    if (!permissionsLoaded) return;
    if (!hasDashboardAuth()) return;
    setTodayBookedSales(null);
    try {
      const params = new URLSearchParams({
        preset: "today",
        basis: "booked",
      });
      const res = await fetch(
        `${baseUrl}/api/insights/register-day-activity?${params}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("today-sales");
      const payload = (await res.json()) as {
        net_sales?: string;
        sales_count?: number;
      };
      setTodayBookedSales({
        total: payload.net_sales ?? "0",
        count: Number(payload.sales_count ?? 0),
      });
    } catch {
      setTodayBookedSales(null);
    }
  }, [apiAuth, hasDashboardAuth, permissionsLoaded]);

  const loadTasks = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("tasks.complete")) return;
    if (!hasDashboardAuth()) return;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, { headers: apiAuth() });
      if (!res.ok) return;
      const data = (await res.json());
      setTaskOpen(Array.isArray(data.open) ? data.open : []);
    } catch { /* ignore */ }
  }, [apiAuth, hasDashboardAuth, hasPermission, permissionsLoaded]);

  const loadCompass = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("weddings.view")) { setCompass(null); return; }
    try {
      const res = await fetch(`${baseUrl}/api/weddings/morning-compass`, { headers: apiAuth() });
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
    } catch { /* ignore */ }
  }, [apiAuth, hasPermission, permissionsLoaded]);

  const loadWeather = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/weather/forecast`);
      if (res.ok) setForecast((await res.json()) as WeatherForecastPayload);
    } catch {
      // Weather is supplementary; the operational dashboard remains usable.
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshSignal]);

  useEffect(() => { void loadCompass(); }, [loadCompass, refreshSignal]);
  useEffect(() => { void loadTodaySales(); }, [loadTodaySales, refreshSignal]);
  useEffect(() => { void loadWeather(); }, [loadWeather, refreshSignal]);

  const headline = useMemo(() => roleHeadline(staffRole), [staffRole]);
  const canOpenWeddingManager =
    permissionsLoaded && hasPermission("wedding_manager.open");
  const canOpenTasks = permissionsLoaded && hasPermission("tasks.complete");
  const canOpenAlterations =
    permissionsLoaded && hasPermission("alterations.manage");

  const activeNotifications = useMemo(
    () =>
      notifications.filter(
        (row) =>
          !row.archived_at &&
          !row.completed_at &&
          row.kind !== "morning_refund_queue",
      ),
    [notifications],
  );

  const suggestedQueue = useMemo(
    () => buildMorningCompassQueue({
      overduePickups: compass?.overdue_pickups ?? [],
      needsOrder: compass?.needs_order ?? [],
      needsMeasure: compass?.needs_measure ?? [],
      rushOrders: compass?.rush_orders ?? [],
      openTasks: taskOpen,
      notifications: activeNotifications,
      limit: 7,
    }),
    [activeNotifications, compass, taskOpen],
  );

  const stats = compass?.stats;
  const alterationAlerts = activeNotifications.filter((row) =>
    semanticNotificationKind(row).includes("alteration"),
  );
  const inventoryAlerts = activeNotifications.filter((row) => {
    const kind = semanticNotificationKind(row);
    return (
      kind.includes("low_stock") ||
      kind.includes("negative_available_stock") ||
      kind.startsWith("po_")
    );
  });
  const todayWeather = forecast?.days?.[0];
  const currentWeather = forecast?.current;
  const weatherCondition = (
    currentWeather?.condition ?? todayWeather?.condition ?? ""
  ).toLowerCase();
  const WeatherIcon = weatherCondition.includes("snow")
    ? Snowflake
    : weatherCondition.includes("rain")
      ? CloudRain
      : weatherCondition.includes("cloud")
        ? Cloud
        : Sun;

  return (
    <>
      <div className="flex flex-1 flex-col gap-6 bg-app-bg p-4 animate-in fade-in duration-500 sm:p-6 lg:p-8">

        {/* Header Section */}
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0 space-y-2">
            <p className="text-[10px] font-black uppercase tracking-[0.28em] text-app-text-muted">
              Register command center
            </p>
            <h1 className="truncate text-3xl font-black tracking-tight text-app-text lg:text-4xl">
              {headline}{" "}
              <span className="mx-2 font-medium text-app-text-muted">·</span>
              <span className="text-app-accent">
                {staffDisplayName.trim() || cashierName?.trim() || "Staff"}
              </span>
            </h1>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-app-success" />
              <p className="text-xs font-bold text-app-text-muted">
                Register #{registerLane ?? "?"}
                {registerOrdinal != null ? ` · Session #${registerOrdinal}` : ""}
                {" · System Online"}
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="pos-dashboard-open-matrix"
            onClick={onGoToRegister}
            className="group relative h-14 px-8 bg-app-accent text-white rounded-xl text-xs font-bold uppercase tracking-widest shadow-lg shadow-app-accent/20 hover:brightness-105 active:scale-95 transition-all flex items-center gap-3 overflow-hidden"
          >
            <ShoppingCart size={20} strokeWidth={2.5} />
            <span>Go to Register</span>
            <ArrowRight size={20} strokeWidth={2.5} className="group-hover:translate-x-1 transition-transform" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <DashboardStatsCard
            title="Today's Sales"
            value={todayBookedSales == null ? "Not loaded" : formatUsdFromCents(parseMoneyToCents(todayBookedSales.total))}
            icon={DollarSign}
            color="green"
            trend={{
              value: todayBookedSales?.count ?? 0,
              label: "booked today",
            }}
            className="min-h-[138px] p-4"
            onClick={onGoToRegister}
            ariaLabel="Today's booked sales total"
          />
          <DashboardStatsCard
            title="Notifications"
            value={activeNotifications.length}
            icon={Bell}
            color={unread > 0 ? "rose" : "green"}
            trend={{
              value: unread,
              label: unread === 0 ? "all read" : "unread",
            }}
            className="min-h-[138px] p-4"
            onClick={openDrawer}
            ariaLabel="Open Notifications Drawer"
          />
          <DashboardStatsCard
            title="Overdue Pickups"
            value={stats?.overdue_pickups ?? 0}
            icon={PackageCheck}
            color={(stats?.overdue_pickups ?? 0) > 0 ? "rose" : "green"}
            trend={{ value: stats?.rush_orders ?? 0, label: "rush orders" }}
            className="min-h-[138px] p-4"
            onClick={onGoToOrders}
            ariaLabel="Open Orders"
          />
          <DashboardStatsCard
            title="Alterations"
            value={alterationAlerts.length}
            icon={Scissors}
            color={alterationAlerts.length > 0 ? "rose" : "green"}
            trend={{ value: alterationAlerts.length, label: "in inbox" }}
            className="min-h-[138px] p-4"
            onClick={canOpenAlterations ? onGoToAlterations : undefined}
            ariaLabel="Open Alterations"
          />
          <DashboardStatsCard
            title="Tasks"
            value={taskOpen.length}
            icon={ClipboardCheck}
            color={taskOpen.length > 0 ? "orange" : "green"}
            trend={{ value: taskOpen.filter((task) => task.due_date != null).length, label: "dated" }}
            className="min-h-[138px] p-4"
            onClick={canOpenTasks ? onGoToTasks : undefined}
            ariaLabel="Open Tasks"
          />
          <DashboardStatsCard
            title="Inventory Alerts"
            value={inventoryAlerts.length}
            icon={Package}
            color={inventoryAlerts.length > 0 ? "orange" : "green"}
            trend={{ value: activeNotifications.length, label: "total alerts" }}
            className="min-h-[138px] p-4"
            onClick={onGoToInventory ?? openDrawer}
            ariaLabel="Open Inventory Alerts"
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
           <div className="space-y-6 xl:col-span-8">
              <DashboardGridCard
                title="Priority Feed"
                subtitle="Tap any row to open its source workflow"
                icon={Zap}
                actionLabel="Open Register"
                onAction={onGoToRegister}
              >
                  {suggestedQueue.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-14 opacity-40 grayscale">
                      <Heart size={48} className="mb-4" strokeWidth={1} />
                      <p className="text-sm font-bold uppercase tracking-widest text-app-text-muted">Floor queue clear</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {suggestedQueue.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            if (item.kind === "wedding") setCompassDrawerRow(item.row);
                            else if (item.kind === "task") setTaskDrawerId(item.taskId);
                            else if (item.kind === "rush_order") onOpenOrderInRegister?.(item.row.order_id);
                            else openDrawer();
                          }}
                          className={cn(
                            "flex w-full items-center justify-between gap-4 rounded-2xl border p-4 transition-all active:scale-[0.98] group/item",
                            item.tier === "urgent"
                              ? "bg-app-danger/[0.06] border-app-danger/15 hover:border-app-danger/35"
                              : "bg-app-surface-2/72 border-app-border hover:border-app-accent/30"
                          )}
                        >
                          <div className="flex items-center gap-4 min-w-0">
                             <div className={cn(
                               "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                               item.tier === "urgent" ? "bg-app-danger text-white" : "bg-app-accent text-white"
                             )}>
                                <Zap size={18} strokeWidth={2.5} />
                             </div>
                             <div className="text-left min-w-0">
                               <p className="text-sm font-bold text-app-text truncate group-hover/item:text-app-accent transition-colors">
                                 {queueItemTitle(item)}
                               </p>
                               <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                                 {queueItemMeta(item)}
                               </p>
                             </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="hidden text-[9px] font-black uppercase tracking-widest text-app-text-muted lg:inline">
                              {queueItemAction(item)}
                            </span>
                            <ChevronRight size={18} className="text-app-text-disabled group-hover/item:translate-x-1 group-hover/item:text-app-text transition-all" />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
              </DashboardGridCard>

              <DashboardGridCard
                title="Wedding Pulse"
                subtitle="Open measurement, order, and pickup follow-up"
                icon={Heart}
                actionLabel={
                  canOpenWeddingManager ? "Open Wedding Manager" : undefined
                }
                onAction={canOpenWeddingManager ? onGoToWeddings : undefined}
              >
                {canOpenWeddingManager ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <button
                      type="button"
                      onClick={onGoToWeddings}
                      className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left transition-all hover:border-app-accent/40 hover:bg-app-accent/5"
                    >
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Needs measure
                      </p>
                      <p className="mt-2 text-3xl font-black text-app-text">
                        {stats?.needs_measure ?? 0}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={onGoToWeddings}
                      className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left transition-all hover:border-app-accent/40 hover:bg-app-accent/5"
                    >
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Needs order
                      </p>
                      <p className="mt-2 text-3xl font-black text-app-text">
                        {stats?.needs_order ?? 0}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={onGoToOrders}
                      className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left transition-all hover:border-app-danger/40 hover:bg-app-danger/5"
                    >
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                        Overdue pickup
                      </p>
                      <p className="mt-2 text-3xl font-black text-app-danger">
                        {stats?.overdue_pickups ?? 0}
                      </p>
                    </button>
                  </div>
                ) : (
                  <div className="p-8 text-center text-sm font-semibold text-app-text-muted">
                    Wedding Manager access is not included for this staff role.
                  </div>
                )}
              </DashboardGridCard>
           </div>

           <div className="space-y-6 xl:col-span-4">
             <DashboardGridCard title="Weather" icon={WeatherIcon}>
               <div className="flex items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 px-4 py-4">
                 <div>
                   <div className="mb-1 flex items-center gap-2">
                     <span className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                       {forecast?.location?.trim() || "Store weather"}
                     </span>
                     <div
                       className={`h-1 w-1 rounded-full ${
                         forecast?.source === "mock"
                           ? "bg-app-warning"
                           : "bg-app-success"
                       }`}
                     />
                   </div>
                   <p className="text-3xl font-bold text-app-text">
                     {currentWeather != null
                       ? `${currentWeather.temp.toFixed(0)}°`
                       : todayWeather
                         ? `${todayWeather.temp_high.toFixed(0)}°`
                         : "—"}
                   </p>
                   <p className="mt-1 text-xs font-bold uppercase tracking-widest text-app-text-muted">
                     {weatherCondition || "Weather unavailable"}
                   </p>
                   {forecast?.source === "mock" ? (
                     <p className="mt-2 text-[11px] font-medium ui-caution-text">
                       Fallback conditions; live weather is unavailable.
                     </p>
                   ) : null}
                 </div>
                 <WeatherIcon size={48} className="text-app-accent opacity-20" />
               </div>
             </DashboardGridCard>

             <SalesByHourSnapshotCard
               authHeaders={apiAuth}
               canLoad={
                 permissionsLoaded &&
                 (hasPermission("register.reports") ||
                   hasPermission("insights.view"))
               }
               refreshSignal={refreshSignal}
             />

             {activeNotifications.length > 0 ? (
               <DashboardGridCard
                 title="Notifications"
                 icon={Bell}
                 actionLabel="Open inbox"
                 onAction={openDrawer}
               >
                 <div className="space-y-3">
                   {activeNotifications.slice(0, 3).map((row) => (
                     <button
                       type="button"
                       key={row.staff_notification_id}
                       onClick={openDrawer}
                       className="w-full rounded-xl border border-app-border p-3 text-left transition-all hover:border-app-accent/30"
                     >
                       <p className="truncate text-xs font-bold text-app-text">
                         {row.title}
                       </p>
                       <p className="mt-1 truncate text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                         {row.read_at ? "Reviewed" : "New"} · open inbox for source
                       </p>
                     </button>
                   ))}
                 </div>
               </DashboardGridCard>
             ) : null}
           </div>
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
        authHeaders={apiAuth}
        onClose={() => setTaskDrawerId(null)}
        onUpdated={() => void loadTasks()}
      />
    </>
  );
}

function semanticNotificationKind(row: NotificationRow): string {
  const link = row.deep_link;
  if (link && typeof link === "object") {
    const record = link as Record<string, unknown>;
    const bundleKind = record.bundle_kind;
    if (record.type === "notification_bundle" && typeof bundleKind === "string") {
      return bundleKind.toLowerCase();
    }
  }
  return row.kind.toLowerCase();
}

function queueItemTitle(item: MorningCompassQueueItem): string {
  if (item.kind === "wedding") {
    return `${item.row.customer_name} · ${compassBandLabel(item.band)}`;
  }
  if (item.kind === "task") return item.title;
  if (item.kind === "rush_order") return `Rush order · ${item.row.customer_name}`;
  return item.row.title;
}

function queueItemMeta(item: MorningCompassQueueItem): string {
  if (item.kind === "wedding") {
    return `${item.row.party_name} · ${item.row.event_date}`;
  }
  if (item.kind === "task") {
    return item.dueDate ? `Task due ${item.dueDate}` : "Task checklist";
  }
  if (item.kind === "rush_order") {
    return item.row.need_by_date ? `Needed by ${item.row.need_by_date}` : "Rush fulfillment";
  }
  return item.row.read_at ? "Notification reviewed" : "New notification";
}

function queueItemAction(item: MorningCompassQueueItem): string {
  if (item.kind === "wedding") return "Review member";
  if (item.kind === "task") return "Open task";
  if (item.kind === "rush_order") return "Open sale";
  return "Open inbox";
}

function cn(...inputs: (string | boolean | undefined | null | Record<string, boolean>)[]) {
  return inputs.filter(Boolean).join(" ");
}
