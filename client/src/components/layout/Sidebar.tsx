import { useMemo } from "react";
import {
  BarChart3,
  Box,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
  Gem,
  Gift,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  Scissors,
  Settings,
  Shield,
  ShoppingCart,
  Star,
  Users,
} from "lucide-react";
import SidebarRailTooltip from "../ui/SidebarRailTooltip";
import {
  useBackofficeAuth,
  SIDEBAR_TAB_PERMISSION,
  SIDEBAR_TAB_PERMISSIONS_ANY,
  subSectionVisible,
} from "../../context/BackofficeAuthContext";
import { useNotificationCenterOptional } from "../../context/NotificationCenterContext";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import type { SidebarTabId } from "./sidebarSections";
import { SIDEBAR_SUB_SECTIONS } from "./sidebarSections";

interface SidebarProps {
  activeTab: SidebarTabId;
  onTabChange: (tab: SidebarTabId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSubSection: string;
  onSubSectionChange: (section: string) => void;
  cashierName: string | null;
  cashierAvatarKey: string | null;
  isRegisterOpen: boolean;
}

type WorkspaceSurface = "POS-Core" | "BackOffice";

export default function Sidebar({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  activeSubSection,
  onSubSectionChange,
  cashierName,
  cashierAvatarKey,
  isRegisterOpen,
}: SidebarProps) {
  const { hasPermission, permissionsLoaded, staffDisplayName, staffAvatarKey } =
    useBackofficeAuth();
  const notifCtx = useNotificationCenterOptional();
  const podiumInboxUnread = notifCtx?.podiumInboxUnread ?? 0;
  const canPollNotifications = notifCtx?.canView ?? false;
  const showPodiumInboxDot =
    canPollNotifications &&
    permissionsLoaded &&
    hasPermission("customers.hub_view") &&
    podiumInboxUnread > 0;

  const profilePrimaryLabel =
    cashierName ??
    (staffDisplayName.trim() ? staffDisplayName.trim() : null) ??
    "No Active Session";

  const profileAvatarSrc = staffAvatarUrl(
    isRegisterOpen && cashierAvatarKey?.trim()
      ? cashierAvatarKey.trim()
      : staffAvatarKey,
  );

  const menuItems: {
    id: SidebarTabId;
    label: string;
    surface: WorkspaceSurface;
    icon: typeof ShoppingCart;
  }[] = [
    { id: "home", label: "Operations", surface: "BackOffice", icon: LayoutGrid },
    { id: "register", label: "POS", surface: "POS-Core", icon: ShoppingCart },
    { id: "customers", label: "Customers", surface: "POS-Core", icon: Users },
    { id: "alterations", label: "Alterations", surface: "POS-Core", icon: Scissors },
    { id: "orders", label: "Orders", surface: "POS-Core", icon: ShoppingCart },
    { id: "inventory", label: "Inventory", surface: "BackOffice", icon: Box },
    { id: "weddings", label: "Weddings", surface: "BackOffice", icon: Gem },
    { id: "gift-cards", label: "Gift Cards", surface: "BackOffice", icon: Gift },
    { id: "loyalty", label: "Loyalty", surface: "BackOffice", icon: Star },
    { id: "staff", label: "Staff", surface: "BackOffice", icon: Shield },
    { id: "qbo", label: "QBO bridge", surface: "BackOffice", icon: Landmark },
    { id: "reports", label: "Reports", surface: "BackOffice", icon: BarChart3 },
    { id: "dashboard", label: "Insights", surface: "BackOffice", icon: LayoutDashboard },
    { id: "appointments", label: "Appointments", surface: "BackOffice", icon: CalendarClock },
    { id: "settings", label: "Settings", surface: "BackOffice", icon: Settings },
  ];

  const visibleMenuItems = useMemo(
    () =>
      menuItems.filter((item) => {
        const anyReq = SIDEBAR_TAB_PERMISSIONS_ANY[item.id];
        if (anyReq?.length) {
          if (!permissionsLoaded) return true;
          return anyReq.some((k) => hasPermission(k));
        }
        const req = SIDEBAR_TAB_PERMISSION[item.id];
        if (!req) return true;
        if (!permissionsLoaded) return true;
        return hasPermission(req);
      }),
    [menuItems, hasPermission, permissionsLoaded],
  );

  return (
    <aside
      className={`ui-rail z-40 flex shrink-0 flex-col border-r border-app-border py-5 text-app-text transition-all duration-300 ease-material overflow-hidden ${
        collapsed 
          ? "w-0 -translate-x-full md:w-16 md:translate-x-0 md:px-2" 
          : "fixed inset-y-0 left-0 w-[240px] px-4 md:relative md:w-[220px]"
      } bg-app-surface md:bg-transparent`}
    >
      {/* Brand row */}
      <div className={`mb-5 flex min-h-[44px] items-center ${collapsed ? "justify-center" : "justify-between"}`}>
        {!collapsed && (
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent)_18%,var(--app-surface-2)),var(--app-surface-2))] text-[10px] font-black tracking-tight text-app-text">
              ROS
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-black tracking-tight text-app-text">Riverside OS</p>
              <p className="truncate text-[9px] uppercase tracking-[0.14em] text-app-text-muted leading-tight">POS Office</p>
            </div>
          </div>
        )}
      </div>

      {/* Profile */}
      {!collapsed ? (
        <div className="ui-panel mb-4 bg-app-surface-2 p-3 shadow-sm border-app-border/40">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full border border-app-border bg-app-surface">
              <img
                src={profileAvatarSrc}
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-app-text">
                {profilePrimaryLabel}
              </p>
              <p className={`truncate text-[9px] font-black uppercase tracking-widest mt-0.5 ${isRegisterOpen ? 'text-app-success' : 'text-app-text-muted'}`}>
                {isRegisterOpen ? "Till open" : "Till closed"}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mb-4 flex justify-center">
          <SidebarRailTooltip
            enabled={collapsed}
            label={`${profilePrimaryLabel} — ${isRegisterOpen ? "Till open" : "Till closed"}`}
          >
            <div
              className="h-8 w-8 overflow-hidden rounded-full border border-app-border bg-app-surface shadow-sm outline-none ring-app-border focus-visible:ring-2"
              tabIndex={0}
              role="img"
              aria-label={`Staff avatar. ${profilePrimaryLabel}. ${isRegisterOpen ? "Till open" : "Till closed"}. Double-click to expand sidebar.`}
              onDoubleClick={() => onToggleCollapse()}
            >
              <img
                src={profileAvatarSrc}
                alt=""
                className="h-full w-full object-cover"
              />
            </div>
          </SidebarRailTooltip>
        </div>
      )}

      {/* Nav */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto no-scrollbar" aria-label="Main Navigation">
        {visibleMenuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          const subItems = SIDEBAR_SUB_SECTIONS[item.id];

          const tipLabel =
            item.id === "register"
              ? "POS — selling & lane tools"
              : `${item.label} (${item.surface === "POS-Core" ? "POS" : "Back Office"})`;

          return (
            <div key={item.id}>
              <SidebarRailTooltip enabled={collapsed} label={tipLabel}>
                <button
                  type="button"
                  data-testid={`sidebar-nav-${item.id}`}
                  onClick={() => onTabChange(item.id)}
                  onDoubleClick={() => onToggleCollapse()}
                  aria-label={
                    collapsed
                      ? item.id === "home" && showPodiumInboxDot
                        ? `${item.label}, ${podiumInboxUnread} unread Inbox`
                        : item.label
                      : undefined
                  }
                  aria-current={isActive ? "page" : undefined}
                  className={`group relative flex w-full items-center gap-2.5 rounded-xl transition-all duration-150 ${
                    collapsed ? "ui-touch-target justify-center px-2 py-2.5" : "min-h-11 px-3 py-2.5"
                  } ${
                    isActive
                      ? "border border-app-border bg-app-surface-2 text-app-text shadow-sm"
                      : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                  }`}
                >
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-app-accent" />
                  )}
                  <span className="relative shrink-0">
                    <Icon size={17} aria-hidden className={isActive ? "text-app-accent" : ""} />
                    {collapsed && item.id === "home" && showPodiumInboxDot ? (
                      <span
                        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-app-surface bg-rose-600 px-0.5 text-[9px] font-black leading-none text-white"
                        aria-hidden
                      >
                        {podiumInboxUnread > 9 ? "9+" : podiumInboxUnread}
                      </span>
                    ) : null}
                  </span>
                  {!collapsed && (
                    <>
                      <span className={`truncate text-sm ${isActive ? 'font-black' : 'font-semibold'}`}>{item.label}</span>
                      {item.id !== "register" ? (
                        <span className="ml-auto shrink-0 rounded border border-app-border bg-app-bg px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                          {item.surface === "POS-Core" ? "POS" : "BO"}
                        </span>
                      ) : null}
                    </>
                  )}
                </button>
              </SidebarRailTooltip>

              {/* Sub-items — active tab, expanded only */}
              {isActive && !collapsed && subItems.length > 0 && (
                <div className="ml-3 mt-1 mb-2 flex flex-col gap-0.5 border-l-2 border-app-border/40 pl-3">
                  {subItems.filter((sub) =>
                    subSectionVisible(item.id, sub.id, hasPermission, permissionsLoaded),
                  ).map((sub) => (
                    <button
                      key={sub.id}
                      type="button"
                      onClick={() => onSubSectionChange(sub.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                        activeSubSection === sub.id
                          ? "bg-app-surface-2 font-black text-app-accent"
                          : "font-semibold text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">{sub.label}</span>
                      {sub.id === "inbox" && showPodiumInboxDot ? (
                        <span
                          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-black tabular-nums text-white"
                          aria-hidden
                        >
                          {podiumInboxUnread > 99 ? "99+" : podiumInboxUnread}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Bottom Toggle */}
      <div className="mt-4 border-t border-app-border pt-4">
        <SidebarRailTooltip
          enabled={collapsed}
          label="Expand sidebar"
        >
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`flex w-full items-center rounded-xl border border-app-border bg-app-surface-2 text-app-text-muted shadow-sm transition-all hover:bg-app-surface hover:text-app-text ${
              collapsed ? "ui-touch-target justify-center px-0" : "min-h-11 gap-3 px-4 py-3"
            }`}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronRight size={18} /> : (
              <>
                <ChevronLeft size={18} />
                <span className="text-[10px] font-black uppercase tracking-widest leading-none">Collapse Sidebar</span>
              </>
            )}
          </button>
        </SidebarRailTooltip>
      </div>
    </aside>
  );
}
