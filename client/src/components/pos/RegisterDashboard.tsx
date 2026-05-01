import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bell,
  ChevronRight,
  Cloud,
  CloudRain,
  Heart,
  ShoppingCart,
  Snowflake,
  Sun,
  Target,
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
  type RushOrderRow,
} from "../../lib/morningCompassQueue";
import {
  hasStaffOrPosAuthHeaders,
  mergedPosStaffHeaders,
} from "../../lib/posRegisterAuth";
import CompassMemberDetailDrawer from "../operations/CompassMemberDetailDrawer";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import DashboardGridCard from "../ui/DashboardGridCard";

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
  source?: string;
}



function roleHeadline(role: string | null): string {
  if (role === "sales_support") return "Sales Support";
  if (role === "salesperson") return "Sales Specialist";
  if (role === "admin") return "Manager";
  return "Team Member";
}

export interface RegisterDashboardProps {
  registerOrdinal: number | null;
  cashierName: string | null;
  onGoToRegister: () => void;
  onGoToWeddings: () => void;
  onOpenWeddingParty?: (partyId: string) => void;
  refreshSignal?: number;
}

export default function RegisterDashboard({
  registerOrdinal,
  cashierName,
  onGoToRegister,
  onGoToWeddings,
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

  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders), [backofficeHeaders]);
  const hasDashboardAuth = useCallback(
    () => hasStaffOrPosAuthHeaders(apiAuth()),
    [apiAuth],
  );

  const [taskOpen, setTaskOpen] = useState<{ id: string; title_snapshot: string; due_date: string | null }[]>([]);
  const [taskDrawerId, setTaskDrawerId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [compass, setCompass] = useState<MorningCompassBundle | null>(null);
  const [compassDrawerRow, setCompassDrawerRow] = useState<CompassActionRow | null>(null);
  const [forecast, setForecast] = useState<WeatherForecastPayload | null>(null);

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

  const loadNotifications = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("notifications.view")) return;
    try {
      const res = await fetch(`${baseUrl}/api/notifications?limit=8`, { headers: apiAuth() });
      if (!res.ok) return;
      setNotifications((await res.json()) as NotificationRow[]);
    } catch { /* ignore */ }
  }, [apiAuth, hasPermission, permissionsLoaded]);

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
    } catch { /* ignore */ }
  }, []);




  useEffect(() => {
    if (!forecast) void loadWeather();
  }, [loadWeather, forecast]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshSignal]);

  useEffect(() => { void loadNotifications(); }, [loadNotifications, refreshSignal]);
  useEffect(() => { void loadCompass(); }, [loadCompass, refreshSignal]);

  const notifAction = async (id: string, path: "read" | "complete" | "archive") => {
    try {
      const res = await fetch(`${baseUrl}/api/notifications/${id}/${path}`, { method: "POST", headers: apiAuth() });
      if (!res.ok) return;
      void loadNotifications();
    } catch { /* ignore */ }
  };

  const headline = useMemo(() => roleHeadline(staffRole), [staffRole]);
  const canOpenWeddingManager =
    permissionsLoaded && hasPermission("wedding_manager.open");

  const suggestedQueue = useMemo(
    () => buildMorningCompassQueue({
      overduePickups: compass?.overdue_pickups ?? [],
      needsOrder: compass?.needs_order ?? [],
      needsMeasure: compass?.needs_measure ?? [],
      rushOrders: compass?.rush_orders ?? [],
      openTasks: taskOpen,
      notifications,
      limit: 7,
    }),
    [compass, taskOpen, notifications],
  );

  const todayWeather = forecast?.days?.[0];
  const current = forecast?.current;
  const cond = (current?.condition ?? todayWeather?.condition ?? "").toLowerCase();
  const WxIcon = cond.includes("snow") ? Snowflake : cond.includes("rain") ? CloudRain : cond.includes("cloud") ? Cloud : Sun;

  const stats = compass?.stats;

  return (
    <>
      <div className="flex flex-1 flex-col gap-6 bg-app-bg p-6 lg:p-8 animate-in fade-in duration-500">
        
        {/* Header Section */}
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight text-app-text">
              {headline} <span className="text-app-text-muted font-medium mx-2">·</span> <span className="text-app-accent">{cashierName?.trim() || staffDisplayName.trim() || "User"}</span>
            </h1>
            <div className="flex items-center gap-2">
               <div className="h-2 w-2 rounded-full bg-app-success" />
               <p className="text-xs font-medium text-app-text-muted">Register {registerOrdinal ?? "0"} · System Online</p>
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

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mt-4">
           {/* Left Column: Priority Feed & Pulse */}
           <div className="xl:col-span-8 space-y-8">
              <DashboardGridCard 
                title="Priority Feed" 
                subtitle="Items requiring transition"
                icon={Zap}
              >
                  {suggestedQueue.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 opacity-30 grayscale">
                      <Heart size={48} className="mb-4" strokeWidth={1} />
                      <p className="text-sm font-bold uppercase tracking-widest text-app-text-muted">Order Cleared</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {suggestedQueue.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => {
                            if (item.kind === "wedding") setCompassDrawerRow(item.row);
                            else if (item.kind === "task") setTaskDrawerId(item.taskId);
                            else openDrawer();
                          }}
                          className={cn(
                            "flex w-full items-center justify-between gap-6 p-4 rounded-2xl border transition-all active:scale-[0.98] group/item",
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
                                 {item.kind === "wedding" ? `${item.row.customer_name} · ${compassBandLabel(item.band)}` : item.kind === "task" ? item.title : item.kind === "rush_order" ? `Rush: ${item.row.customer_name}` : item.id}
                               </p>
                               <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                                 {item.kind === "wedding" ? `${item.row.party_name} · ${item.row.event_date}` : item.kind === "task" && item.dueDate ? item.dueDate : "General Protocol"}
                               </p>
                             </div>
                          </div>
                          <ChevronRight size={18} className="text-app-text-disabled group-hover/item:translate-x-1 group-hover/item:text-app-text transition-all" />
                        </button>
                      ))}
                    </div>
                  )}
              </DashboardGridCard>

              <DashboardGridCard 
                title="Wedding Pulse" 
                subtitle="Registry activity and status"
                icon={Heart}
                actionLabel={
                  canOpenWeddingManager ? "Open Wedding Manager" : undefined
                }
                onAction={canOpenWeddingManager ? onGoToWeddings : undefined}
              >
                  {canOpenWeddingManager ? (
                    <div className="p-12 text-center opacity-30 italic font-medium text-app-text-muted text-sm uppercase tracking-[0.2em]">
                      Real-time wedding activity stream initializing...
                    </div>
                  ) : (
                    <div className="p-8 text-center">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                        Wedding Manager Access
                      </p>
                      <p className="mt-3 text-sm font-medium text-app-text-muted">
                        This role does not currently include Wedding Manager
                        access. Enable <span className="font-black">wedding_manager.open</span>{" "}
                        in Admin staff permissions to open it from POS.
                      </p>
                    </div>
                  )}
              </DashboardGridCard>
           </div>

           {/* Right Column: Performance & Environment */}
           <div className="xl:col-span-4 space-y-8">
              {/* Environment Widget */}
              <DashboardGridCard title="Weather" icon={WxIcon}>
                 <div className="flex items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 px-4 py-4">
                    <div>
                       <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Buffalo, NY</span>
                          <div className={`h-1 w-1 rounded-full ${forecast?.source === "mock" ? "bg-app-warning" : "bg-app-success"}`} />
                          {forecast?.source === "mock" ? (
                            <span className="rounded-full border border-app-warning/30 bg-app-warning/12 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-warning">
                              Mock Weather
                            </span>
                          ) : null}
                       </div>
                       <p className="text-3xl font-bold text-app-text">
                         {current != null ? `${current.temp.toFixed(0)}°` : todayWeather ? `${todayWeather.temp_high.toFixed(0)}°` : "72°"}
                       </p>
                       <p className="text-xs font-bold text-app-text-muted uppercase tracking-widest mt-1">
                         {cond || "Clear Skies"}
                       </p>
                       {forecast?.source === "mock" ? (
                         <p className="mt-2 max-w-[16rem] text-[11px] font-medium ui-caution-text">
                           Live weather is unavailable, so this register view is showing fallback conditions.
                         </p>
                       ) : null}
                    </div>
                    <WxIcon size={48} className="text-app-accent opacity-20" />
                 </div>
              </DashboardGridCard>

              {/* Staff Pulse Cards */}
              {stats && (
                <DashboardGridCard title="Performance" icon={Target}>
                   <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
                         <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider mb-1">Measure</p>
                         <p className="text-2xl font-bold text-app-text">{stats.needs_measure}</p>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
                         <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider mb-1">Order</p>
                         <p className="text-2xl font-bold text-app-text">{stats.needs_order}</p>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
                         <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-app-danger">Overdue</p>
                         <p className="text-2xl font-bold text-app-danger">{stats.overdue_pickups}</p>
                      </div>
                      <div className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3">
                         <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-app-accent">Rush</p>
                         <p className="text-2xl font-bold text-app-accent">{stats.rush_orders}</p>
                      </div>
                   </div>
                </DashboardGridCard>
              )}

              {/* Notifications */}
              {notifications.length > 0 && (
                <DashboardGridCard
                  title="Notifications"
                  icon={Bell}
                  actionLabel="Show Feedback"
                  onAction={openDrawer}
                >
                   <div className="space-y-3">
                      {notifications.slice(0, 3).map((r) => (
                        <div key={r.staff_notification_id} className="p-3 rounded-xl border border-app-border hover:border-app-accent/30 transition-all cursor-pointer group/notif">
                           <p className="text-xs font-bold text-app-text truncate group-hover/notif:text-app-accent">{r.title}</p>
                           <div className="flex gap-3 mt-2">
                              <button onClick={() => notifAction(r.staff_notification_id, "read")} className="text-[10px] font-bold text-app-accent">Dismiss</button>
                              <button onClick={openDrawer} className="text-[10px] font-bold text-app-text-muted">Details</button>
                           </div>
                        </div>
                      ))}
                   </div>
                </DashboardGridCard>
              )}
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

function cn(...inputs: (string | boolean | undefined | null | Record<string, boolean>)[]) {
  return inputs.filter(Boolean).join(" ");
}
