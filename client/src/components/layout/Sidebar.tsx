import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
} from "lucide-react";
import SidebarRailTooltip from "../ui/SidebarRailTooltip";
import RiversideJustLogo from "../../assets/images/logo1.png";

import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  SIDEBAR_TAB_PERMISSION,
  SIDEBAR_TAB_PERMISSIONS_ANY,
  subSectionVisible,
} from "../../context/BackofficeAuthPermissions";
import { useNotificationCenterOptional } from "../../context/NotificationCenterContextLogic";

import type { SidebarTabId, SubItem } from "./sidebarSections";
import { SIDEBAR_SUB_SECTIONS } from "./sidebarSections";
import { APP_NAV_ICON_NAMES, getAppIcon, getNavIconProps } from "../../lib/icons";

interface SidebarProps {
  activeTab: SidebarTabId;
  onTabChange: (tab: SidebarTabId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSubSection: string;
  onSubSectionChange: (section: string) => void;
}

type WorkspaceSurface = "POS-Core" | "BackOffice";

const PRIMARY_STAFF_TABS = new Set<SidebarTabId>([
  "home",
  "register",
  "appointments",
  "customers",
  "weddings",
  "alterations",
  "orders",
  "inventory",
  "staff",
  "payments",
  "reports",
]);

function visibleSubGroupItems(
  subItems: SubItem[],
  groupIndex: number,
  visibleSubIds: Set<string>,
): string[] {
  const itemIds: string[] = [];
  for (let i = groupIndex + 1; i < subItems.length; i += 1) {
    const sub = subItems[i];
    if (sub.kind === "group") break;
    if (visibleSubIds.has(sub.id)) itemIds.push(sub.id);
  }
  return itemIds;
}

export default function Sidebar({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  activeSubSection,
  onSubSectionChange,
}: SidebarProps) {
  const { hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const notifCtx = useNotificationCenterOptional();
  const [expandedSubGroups, setExpandedSubGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [showMoreWorkspaces, setShowMoreWorkspaces] = useState(false);
  const podiumInboxUnread = notifCtx?.podiumInboxUnread ?? 0;
  const mailboxUnread = notifCtx?.mailboxUnread ?? 0;
  const canPollNotifications = notifCtx?.canView ?? false;
  const showPodiumInboxDot =
    canPollNotifications &&
    permissionsLoaded &&
    hasPermission("customers.hub_view") &&
    podiumInboxUnread > 0;
  const showMailboxDot =
    canPollNotifications &&
    permissionsLoaded &&
    hasPermission("customers.hub_view") &&
    mailboxUnread > 0;
  const communicationsUnread =
    (showPodiumInboxDot ? podiumInboxUnread : 0) +
    (showMailboxDot ? mailboxUnread : 0);

  useEffect(() => {
    const subItems = SIDEBAR_SUB_SECTIONS[activeTab];
    let currentGroupId: string | null = null;
    for (const sub of subItems) {
      if (sub.kind === "group") {
        currentGroupId = sub.id;
      } else if (sub.id === activeSubSection && currentGroupId) {
        const groupKey = `${activeTab}:${currentGroupId}`;
        setExpandedSubGroups((current) => {
          if (current.has(groupKey)) return current;
          const next = new Set(current);
          next.add(groupKey);
          return next;
        });
        break;
      }
    }
  }, [activeSubSection, activeTab]);

  const menuItems = useMemo(
    () =>
      [
        { id: "home",         label: "Operations",  surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.home) },
        { id: "register",     label: "POS",          surface: "POS-Core",  icon: getAppIcon(APP_NAV_ICON_NAMES.register) },
        { id: "appointments", label: "Appointments", surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.appointments) },
        { id: "customers",    label: "Customers",    surface: "POS-Core",  icon: getAppIcon(APP_NAV_ICON_NAMES.customers) },
        { id: "weddings",     label: "Weddings",     surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.weddings) },
        { id: "alterations",  label: "Alterations",  surface: "POS-Core",  icon: getAppIcon(APP_NAV_ICON_NAMES.alterations) },
        { id: "orders",       label: "Orders",       surface: "POS-Core",  icon: getAppIcon(APP_NAV_ICON_NAMES.orders) },
        { id: "inventory",    label: "Inventory",    surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.inventory) },
        { id: "staff",        label: "Staff",        surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.staff) },
        { id: "payments",     label: "Payments",     surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.payments) },
        { id: "reports",      label: "Reports",      surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.reports) },
        { id: "dashboard",    label: "Insights",     surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.dashboard) },
        { id: "gift-cards",   label: "Gift Cards",   surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES["gift-cards"]) },
        { id: "loyalty",      label: "Loyalty",      surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.loyalty) },
        { id: "shipping",     label: "Shipping",     surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.shipping) },
        { id: "online-store", label: "Online Store", surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES["online-store"]) },
        { id: "qbo",          label: "QBO bridge",   surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.qbo) },
        { id: "settings",     label: "Settings",     surface: "BackOffice", icon: getAppIcon(APP_NAV_ICON_NAMES.settings) },
      ] as {
        id: SidebarTabId;
        label: string;
        surface: WorkspaceSurface;
        icon: ReturnType<typeof getAppIcon>;
      }[],
    [],
  );

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
  const secondaryWorkspaceCount = visibleMenuItems.filter(
    (item) => !PRIMARY_STAFF_TABS.has(item.id),
  ).length;
  const displayedMenuItems = visibleMenuItems.filter(
    (item) => showMoreWorkspaces || PRIMARY_STAFF_TABS.has(item.id) || item.id === activeTab,
  );

  return (
    <aside
      className={`ui-rail z-[70] flex shrink-0 flex-col overflow-hidden border-r border-app-border py-5 text-app-text transition-all duration-300 ease-material md:sticky md:top-[72px] md:z-40 md:h-[calc(100dvh-72px)] md:self-start ${
        collapsed
          ? "w-0 -translate-x-full md:w-16 md:translate-x-0 md:px-2"
          : "fixed bottom-0 left-0 top-[72px] w-[240px] px-4 md:sticky md:w-[220px] md:px-0"
      }`}
    >
      {/* Brand row */}
      <div className={`mb-5 flex min-h-[44px] items-center ${collapsed ? "justify-center" : "justify-between"}`}>
        <div className={`flex items-center gap-2 ${collapsed ? "justify-center" : ""}`}>
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-app-surface-2 shadow-sm border border-app-border">
            <img src={RiversideJustLogo} alt="Riverside" className="h-full w-full object-contain" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-xs font-black tracking-tight text-app-text">Riverside OS</p>
              <p className="truncate text-[9px] uppercase tracking-[0.14em] text-app-text-muted leading-tight">POS Office</p>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain no-scrollbar" aria-label="Main Navigation">
        {displayedMenuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          const subItems = SIDEBAR_SUB_SECTIONS[item.id];
          const visibleSubIds = new Set(
            subItems
              .filter((sub) =>
                sub.kind !== "group" &&
                subSectionVisible(item.id, sub.id, hasPermission, permissionsLoaded),
              )
              .map((sub) => sub.id),
          );

          const tipLabel =
            item.id === "register"
              ? "POS — selling & lane tools"
              : `${item.label} (${item.surface === "POS-Core" ? "POS" : "Back Office"})`;

          const navIconProps = getNavIconProps(isActive);

          return (
            <div key={item.id} data-testid={`sidebar-nav-group-${item.id}`}>
              <SidebarRailTooltip enabled={collapsed} label={tipLabel}>
                <button
                  type="button"
                  data-testid={`sidebar-nav-${item.id}`}
                  onClick={() => onTabChange(item.id)}
                  onDoubleClick={() => onToggleCollapse()}
                  aria-label={
                    collapsed
                      ? item.id === "home" && communicationsUnread > 0
                        ? `${item.label}, ${communicationsUnread} unread messages`
                        : item.label
                      : undefined
                  }
                  aria-current={isActive ? "page" : undefined}
                  className={`group relative flex w-full cursor-pointer items-center gap-2.5 rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${
                    collapsed ? "ui-touch-target justify-center px-2 py-2.5" : "min-h-11 px-3 py-2.5"
                  } ${
                    isActive
                      ? "border border-app-accent/35 bg-app-accent/10 text-app-text shadow-sm active:scale-[0.99]"
                      : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text hover:shadow-sm active:scale-[0.99]"
                  }`}
                >
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-app-accent" />
                  )}
                  <span className="relative flex h-[26px] w-[26px] shrink-0 items-center justify-center">
                    <Icon
                      {...navIconProps}
                      aria-hidden
                      className={`transition-all duration-150 ${
                        isActive
                          ? "scale-105 text-app-accent"
                          : "text-current group-hover:text-app-text"
                      }`}
                    />
                    {collapsed && item.id === "home" && communicationsUnread > 0 ? (
                      <span
                        className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-app-surface bg-rose-600 px-0.5 text-[9px] font-black leading-none text-white"
                        aria-hidden
                      >
                        {communicationsUnread > 9 ? "9+" : communicationsUnread}
                      </span>
                    ) : null}
                  </span>
                  {!collapsed && (
                    <span className={`truncate text-sm ${isActive ? 'font-black' : 'font-semibold'}`}>{item.label}</span>
                  )}
                </button>
              </SidebarRailTooltip>

              {/* Sub-items — active tab, expanded only */}
              {isActive && !collapsed && subItems.length > 0 && (
                <div className="ml-3 mt-1 mb-2 flex flex-col gap-0.5 border-l-2 border-app-border/40 pl-3">
                  {subItems.map((sub, index) => {
                    if (sub.kind === "group") {
                      const groupItems = visibleSubGroupItems(
                        subItems,
                        index,
                        visibleSubIds,
                      );
                      if (groupItems.length === 0) {
                        return null;
                      }
                      const groupKey = `${item.id}:${sub.id}`;
                      const isExpanded = expandedSubGroups.has(groupKey);
                      return (
                        <button
                          key={sub.id}
                          type="button"
                          aria-expanded={isExpanded}
                          onClick={() => {
                            setExpandedSubGroups((current) => {
                              const next = new Set(current);
                              if (next.has(groupKey)) next.delete(groupKey);
                              else next.add(groupKey);
                              return next;
                            });
                          }}
                          className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[10px] font-black uppercase tracking-[0.12em] text-app-text-muted transition-colors first:mt-0 hover:bg-app-surface-2 hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {sub.label}
                          </span>
                          <span className="rounded-full border border-app-border bg-app-bg px-1.5 py-0.5 text-[9px] tabular-nums tracking-normal text-app-text-muted">
                            {groupItems.length}
                          </span>
                          <ChevronDown
                            size={14}
                            aria-hidden
                            className={`shrink-0 transition-transform ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                          />
                        </button>
                      );
                    }
                    if (!visibleSubIds.has(sub.id)) return null;
                    let parentGroupId: string | null = null;
                    for (let i = index - 1; i >= 0; i -= 1) {
                      if (subItems[i].kind === "group") {
                        parentGroupId = subItems[i].id;
                        break;
                      }
                    }
                    if (
                      parentGroupId &&
                      !expandedSubGroups.has(`${item.id}:${parentGroupId}`)
                    ) {
                      return null;
                    }
                    return (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => onSubSectionChange(sub.id)}
                        className={`flex min-h-11 w-full cursor-pointer items-center gap-1 rounded-lg px-2.5 py-2 text-left text-xs transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20 ${
                          activeSubSection === sub.id
                            ? "border border-app-accent/25 bg-app-accent/10 font-black text-app-accent shadow-sm"
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
                        {sub.id === "mailbox" && showMailboxDot ? (
                          <span
                            className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-black tabular-nums text-white"
                            aria-hidden
                          >
                            {mailboxUnread > 99 ? "99+" : mailboxUnread}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {secondaryWorkspaceCount > 0 ? (
          <button
            type="button"
            data-testid="sidebar-more-workspaces"
            onClick={() => setShowMoreWorkspaces((current) => !current)}
            aria-expanded={showMoreWorkspaces}
            className={`mt-1 flex min-h-11 w-full items-center rounded-xl text-app-text-muted transition hover:bg-app-surface-2 hover:text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${
              collapsed ? "justify-center px-2" : "gap-2.5 px-3 text-sm font-semibold"
            }`}
          >
            <ChevronDown
              size={18}
              aria-hidden
              className={`shrink-0 transition-transform ${showMoreWorkspaces ? "rotate-180" : ""}`}
            />
            {!collapsed ? (
              <span>{showMoreWorkspaces ? "Fewer workspaces" : `More workspaces (${secondaryWorkspaceCount})`}</span>
            ) : null}
          </button>
        ) : null}
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
            className={`flex w-full cursor-pointer items-center rounded-xl border border-app-border bg-app-surface-2 text-app-text-muted shadow-sm transition-all duration-150 hover:bg-app-surface hover:text-app-text active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${
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
