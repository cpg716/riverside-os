import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ChevronRight,
  Target,
  TrendingUp,
  Zap,
  ShieldCheck,
  Ruler,
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
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  useNotificationCenter,
  useNotificationCenterOptional,
  type NotificationRow,
} from "../../context/NotificationCenterContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import TaskChecklistDrawer from "../tasks/TaskChecklistDrawer";
import PodiumMessagingInboxSection from "../customers/PodiumMessagingInboxSection";
import RegisterReports from "../pos/RegisterReports";
import FulfillmentCommandCenter from "./FulfillmentCommandCenter";
import ReviewsOperationsSection from "./ReviewsOperationsSection";
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

interface OperationalHomeProps {
  onOpenWeddingParty: (partyId: string) => void;
  onOpenTransactionInBackoffice: (orderId: string) => void;
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
  const headlineCondition = (
    current?.condition ?? today.condition
  ).toLowerCase();
  const condition = headlineCondition;

  const isRain = condition.includes("rain");
  const isSnow = condition.includes("snow");
  const isCloudy = condition.includes("cloudy");

  const Icon = isSnow ? Snowflake : isRain ? CloudRain : isCloudy ? Cloud : Sun;


  return (
    <div
      className={cn(
        "relative mb-8 rounded-2xl border border-app-border bg-app-surface p-6 shadow-sm overflow-hidden",
        "bg-gradient-to-br from-app-surface to-app-surface/50"
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
              <div className={`h-1.5 w-1.5 rounded-full ${forecast?.source === "mock" ? "bg-amber-500" : "bg-emerald-500"}`} />
              {forecast?.source === "mock" ? (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-200">
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
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                Live weather is unavailable, so this dashboard is showing deterministic fallback conditions.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-8 px-6 py-4 rounded-xl bg-app-bg/50 border border-app-border w-full md:w-auto">
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

  const taskAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );


  const loadTasksMe = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("tasks.complete")) return;
    try {
      const res = await fetch(`${baseUrl}/api/tasks/me`, {
        headers: taskAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        open?: {
          id: string;
          title_snapshot: string;
          due_date: string | null;
        }[];
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
  const { openDrawer } = useNotificationCenter();
  useEffect(() => {
    if (activeSection === "inbox" && refreshNotifUnread)
      void refreshNotifUnread();
  }, [activeSection, refreshNotifUnread]);
  const [salesHistory, setSalesHistory] = useState<{ value: number }[]>([]);
  const loadSalesHistory = useCallback(async () => {
    if (!permissionsLoaded || !hasPermission("insights.view")) return;
    try {
      const today = new Date();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(today.getDate() - 30);
      
      const from = thirtyDaysAgo.toISOString().split('T')[0];
      const to = today.toISOString().split('T')[0];
      
      const res = await fetch(`${baseUrl}/api/insights/sales-pivot?group_by=date&basis=sale&from=${from}&to=${to}`, {
        headers: taskAuth(),
      });
      if (res.ok) {
        const data = await res.json() as { rows: { gross_revenue: string }[] };
        const history = data.rows.map((r) => ({ value: Number(r.gross_revenue) })).reverse();
        setSalesHistory(history);
      }
    } catch { /* ignore */ }
  }, [permissionsLoaded, hasPermission, taskAuth]);

  useEffect(() => {
    void loadSalesHistory();
  }, [loadSalesHistory, refreshSignal]);

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
          today_floor_staff: Array.isArray(data.today_floor_staff)
            ? data.today_floor_staff
            : [],
        });
      }
    }
    if (fRes.ok) setActivityFeed((await fRes.json()) as ActivityFeedEntry[]);
  }, [taskAuth, permissionsLoaded, hasPermission]);

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


  if (activeSection === "daily-sales") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Synchronizing Ledger...</div>
          ) : !hasPermission("register.reports") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
               <ShieldCheck size={64} className="text-rose-500 opacity-20" />
               <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
                 Access restricted. Directive <span className="text-app-text">register.reports</span> is required to access the daily sales matrix.
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
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Opening Communication Portal...</div>
          ) : !hasPermission("customers.hub_view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-rose-500 opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
                Access restricted. Directive <span className="text-app-text">customers.hub_view</span> is required for inbox orchestration.
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

  if (activeSection === "fulfillment") {
    return (
      <div className="flex flex-1 flex-col bg-transparent">
        <div className="flex flex-1 flex-col bg-app-surface">
          {!permissionsLoaded ? (
            <div className="p-10 text-[10px] font-black uppercase tracking-[0.5em] text-app-text-muted opacity-40 animate-pulse">Initializing Fulfillment Command Center...</div>
          ) : !hasPermission("orders.view") ? (
            <div className="p-12 flex flex-col items-center justify-center h-full text-center space-y-6">
              <ShieldCheck size={64} className="text-rose-500 opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
                Access restricted. Directive <span className="text-app-text">orders.view</span> is required to monitor the fulfillment stream.
              </p>
            </div>
          ) : (
            <FulfillmentCommandCenter
              onOpenTransaction={onOpenTransactionInBackoffice}
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
              <ShieldCheck size={64} className="text-rose-500 opacity-20" />
              <p className="text-sm font-black uppercase tracking-widest text-app-text-muted leading-relaxed max-w-md">
                Access restricted. Directive <span className="text-app-text">reviews.view</span> is required to monitor social proof.
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
    <div className="space-y-8 animate-in fade-in duration-500">
      
      <div className="flex flex-wrap items-center justify-between gap-6 mb-8">
        <div className="space-y-1">
          <h2 className="text-3xl font-bold tracking-tight text-app-text">Operations Overview</h2>
          <p className="text-sm font-medium text-app-text-muted">Real-time snapshots of your store operations</p>
        </div>
        <div className="flex items-center gap-3">
           <div className="h-2 w-2 rounded-full bg-emerald-500" />
           <span className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Live Dashboard Active</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
         <DashboardStatsCard
           title="Sales (30d)"
           value={salesHistory.length > 0 ? `$${salesHistory.reduce((acc, curr) => acc + curr.value, 0).toLocaleString()}` : "$0"}
           icon={TrendingUp}
           sparklineData={salesHistory}
           color="blue"
         />
         <DashboardStatsCard
           title="Needs Measure"
           value={compass?.stats.needs_measure ?? 0}
           icon={Ruler}
           color="orange"
         />
         <DashboardStatsCard
           title="Needs Order"
           value={compass?.stats.needs_order ?? 0}
           icon={ShoppingBag}
           color="purple"
         />
         <DashboardStatsCard
           title="Overdue"
           value={compass?.stats.overdue_pickups ?? 0}
           icon={AlertCircle}
           color="rose"
         />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        
        {/* Main Priorities */}
        <div className="xl:col-span-8 space-y-6">
          <DashboardGridCard
            title="Action Board"
            subtitle="Today's priority tasks and directives"
            icon={Zap}
          >
            {suggestedMorningQueue.length === 0 ? (
               <div className="py-20 text-center opacity-30">
                  <Target size={48} className="mx-auto mb-4" />
                  <p className="font-semibold">All priorities cleared</p>
               </div>
            ) : (
               <div className="grid grid-cols-1 gap-3">
                  {suggestedMorningQueue.slice(0, 8).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        if (item.kind === "wedding") setCompassDrawerRow(item.row);
                        else if (item.kind === "task") setTaskDrawerId(item.taskId);
                        else openDrawer();
                      }}
                      className="flex items-center justify-between p-4 rounded-xl border border-app-border bg-app-bg/50 hover:bg-app-bg transition-all"
                    >
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-lg border",
                          item.tier === 'urgent' ? "bg-rose-500/10 border-rose-500/20 text-rose-500" : "bg-app-accent/10 border-app-accent/20 text-app-accent"
                        )}>
                           <Zap size={16} />
                        </div>
                        <div className="text-left">
                           <p className="text-sm font-bold text-app-text">
                              {item.kind === "wedding" ? `${item.row.customer_name} · ${compassBandLabel(item.band)}` : item.kind === "task" ? item.title : item.kind === "rush_order" ? `Rush: ${item.row.customer_name}` : item.row.title}
                           </p>
                           <p className="text-[10px] font-medium text-app-text-muted">
                              {item.kind === "wedding" ? `${item.row.party_name} · ${item.row.event_date}` : item.kind === "task" && item.dueDate ? `Due: ${item.dueDate}` : 'General Status'}
                           </p>
                        </div>
                      </div>
                      <ChevronRight size={18} className="text-app-text-muted opacity-40" />
                    </button>
                  ))}
               </div>
            )}
          </DashboardGridCard>

          {/* Activity Feed */}
          <DashboardGridCard
            title="Recent Activity"
            subtitle="Store floor and order events"
            icon={Activity}
          >
            <div className="space-y-6">
               {activityFeed.slice(0, 10).map((act) => (
                 <div key={act.id} className="flex gap-4 group/act">
                   <div className="mt-1">
                      <div className="h-8 w-8 rounded-full bg-app-accent/10 flex items-center justify-center text-app-accent">
                         <Users size={14} />
                      </div>
                   </div>
                   <div className="flex-1 space-y-1">
                      <p className="text-xs font-bold text-app-text group-hover/act:text-app-accent transition-colors">
                        {act.actor_name} <span className="font-medium text-app-text-muted">performed</span> {act.action_type.replace(/_/g, ' ')}
                      </p>
                      <p className="text-[10px] text-app-text-muted leading-relaxed">{act.description}</p>
                      <p className="text-[9px] font-bold text-app-text-muted/60">{new Date(act.created_at).toLocaleTimeString()}</p>
                   </div>
                 </div>
               ))}
            </div>
          </DashboardGridCard>
        </div>

        {/* Floor Management */}
        <div className="xl:col-span-4 space-y-6">
           <WeatherDashboardWidget refreshSignal={refreshSignal} />

           <DashboardGridCard
             title="Team on Floor"
             subtitle="Active personnel status"
             icon={Users}
           >
              <div className="space-y-4">
                 {(compass?.today_floor_staff ?? []).length === 0 ? (
                    <div className="py-12 text-center opacity-30 italic text-xs font-semibold">No staff scheduled for today</div>
                 ) : (
                   compass?.today_floor_staff?.map((staff) => (
                      <div key={staff.id} className="flex items-center justify-between p-3 rounded-xl bg-app-bg/30">
                         <div className="flex items-center gap-3">
                            <img src={staffAvatarUrl(staff.avatar_key)} className="h-8 w-8 rounded-lg bg-app-accent/20" alt="" />
                            <div>
                               <p className="text-xs font-bold text-app-text">{staff.full_name}</p>
                               <div className="flex items-center gap-1.5">
                                 <p className="text-[9px] font-medium text-app-text-muted">{floorRoleLabel(staff.role)}</p>
                                 {staff.shift_label && (
                                   <>
                                     <span className="text-[9px] text-app-text-muted opacity-40">·</span>
                                     <span className="text-[9px] font-black text-app-accent uppercase tracking-tighter">{staff.shift_label}</span>
                                   </>
                                 )}
                               </div>
                            </div>
                         </div>
                         <div className={cn("h-2 w-2 rounded-full", staff.shift_label?.toLowerCase().includes("off") ? "bg-rose-500/30" : "bg-emerald-500")} />
                      </div>
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
