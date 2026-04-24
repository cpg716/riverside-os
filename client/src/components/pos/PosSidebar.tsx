import { useMemo } from "react";
import {
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import SidebarRailTooltip from "../ui/SidebarRailTooltip";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { subSectionVisible } from "../../context/BackofficeAuthPermissions";
import { SidebarTabId } from "../layout/sidebarSections";
import { POS_SIDEBAR_SUB_SECTIONS, type PosTabId } from "./posSidebarSections";
import { APP_NAV_ICON_NAMES, getAppIcon, getNavIconProps } from "../../lib/icons";

interface PosSidebarProps {
  activeTab: PosTabId;
  onTabChange: (tab: PosTabId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSubSection?: string;
  onSubSectionChange?: (section: string) => void;
}

export default function PosSidebar({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
  activeSubSection,
  onSubSectionChange,
}: PosSidebarProps) {
  const { hasPermission, permissionsLoaded } =
    useBackofficeAuth();


  const tabs = useMemo(() => {
    const out: {
      id: PosTabId;
      label: string;
      icon: ReturnType<typeof getAppIcon>;
    }[] = [
      { id: "pos-dashboard", label: "Dashboard", icon: getAppIcon(APP_NAV_ICON_NAMES["pos-dashboard"]) },
      { id: "register", label: "Register", icon: getAppIcon(APP_NAV_ICON_NAMES.register) },
      { id: "tasks", label: "Tasks", icon: getAppIcon(APP_NAV_ICON_NAMES.tasks) },
      { id: "customers", label: "Customers", icon: getAppIcon(APP_NAV_ICON_NAMES.customers) },
      { id: "rms-charge", label: "RMS Charge", icon: getAppIcon(APP_NAV_ICON_NAMES["rms-charge"]) },
    ];

    // Mirroring Back Office permission gate logic for POS rails
    const items: { id: PosTabId; label: string; icon: ReturnType<typeof getAppIcon>; permission?: string; permissionsAny?: string[] }[] = [
      {
        id: "podium-inbox",
        label: "Podium Inbox",
        icon: getAppIcon(APP_NAV_ICON_NAMES["podium-inbox"]),
        permission: "customers.hub_view",
      },
      { id: "weddings", label: "Weddings", icon: getAppIcon(APP_NAV_ICON_NAMES.weddings), permission: "wedding_manager.open" },
      { id: "alterations", label: "Alterations", icon: getAppIcon(APP_NAV_ICON_NAMES.alterations), permission: "alterations.manage" },
      { id: "inventory", label: "Inventory", icon: getAppIcon(APP_NAV_ICON_NAMES.inventory) }, // catalog.view is usually a baseline for catalog discovery
      { id: "orders", label: "Orders", icon: getAppIcon(APP_NAV_ICON_NAMES.orders), permission: "orders.view" },
      { id: "reports", label: "Reports", icon: getAppIcon(APP_NAV_ICON_NAMES.reports), permission: "insights.view" },
      { id: "gift-cards", label: "Gift Cards", icon: getAppIcon(APP_NAV_ICON_NAMES["gift-cards"]), permission: "gift_cards.manage" },
      { id: "loyalty", label: "Loyalty", icon: getAppIcon(APP_NAV_ICON_NAMES.loyalty), permissionsAny: ["loyalty.program_settings", "loyalty.adjust_points"] },
      { id: "layaways", label: "Layaways", icon: getAppIcon(APP_NAV_ICON_NAMES.layaways) }, // customer-hub access usually includes layaways
      { id: "shipping", label: "Shipping", icon: getAppIcon(APP_NAV_ICON_NAMES.shipping), permission: "shipments.view" },
      { id: "settings", label: "Settings", icon: getAppIcon(APP_NAV_ICON_NAMES.settings) }, // settings.admin or staff.manage_access
    ];

    for (const item of items) {
       if (!permissionsLoaded) {
         out.push(item);
         continue;
       }
       if (item.permission && !hasPermission(item.permission)) continue;
       if (item.permissionsAny && !item.permissionsAny.some(p => hasPermission(p))) continue;
       
       // Extra check for settings: mirror SIDEBAR_TAB_PERMISSIONS_ANY
       if (item.id === "settings") {
         const canAdmin = hasPermission("settings.admin") || hasPermission("staff.manage_access");
         if (!canAdmin) continue;
       }

       out.push(item);
    }

    return out;
  }, [hasPermission, permissionsLoaded]);

  return (
    <aside
      className={`ui-rail z-40 flex shrink-0 flex-col border-r border-app-border py-5 text-app-text transition-all duration-300 ease-material md:sticky md:top-[84px] md:h-[calc(100vh-84px)] overflow-y-auto custom-scrollbar ${
        collapsed
          ? "w-16 px-2 justify-between"
          : "w-[240px] px-4 lg:w-[260px] lg:px-5"
      }`}
    >
      <div className="flex flex-col flex-1">
        {/* Brand row */}
        <div className={`mb-5 flex min-h-[44px] items-center ${collapsed ? "justify-center" : "justify-between"}`}>
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-app-border bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent)_18%,var(--app-surface-2)),var(--app-surface-2))] text-[10px] font-black tracking-tight text-app-text">
              ROS
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-xs font-black tracking-tight text-app-text">Riverside OS</p>
                <p className="truncate text-[9px] uppercase tracking-[0.14em] text-app-text-muted">
                  Point of sale
                </p>
              </div>
            )}
          </div>
        </div>


        {/* Nav */}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto no-scrollbar" aria-label="POS Navigation">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const subItems = POS_SIDEBAR_SUB_SECTIONS[tab.id] ?? [];


            return (
              <div key={tab.id}>
                <SidebarRailTooltip
                  enabled={collapsed}
                  label={`${tab.label} (POS)`}
                >
                  <button
                    type="button"
                    onClick={() => onTabChange(tab.id)}
                    onDoubleClick={() => onToggleCollapse()}
                    aria-label={tab.label}
                    aria-current={isActive ? "page" : undefined}
                    className={`ui-touch-target group relative flex cursor-pointer items-center gap-2.5 rounded-xl transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${
                      collapsed ? "h-11 w-full justify-center" : "min-h-11 w-full px-3 py-3"
                    } ${
                      isActive
                        ? "border border-app-border bg-app-surface-2 text-app-text shadow-sm active:scale-[0.99]"
                        : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text hover:shadow-sm active:scale-[0.99]"
                    }`}
                  >
                    {isActive && !collapsed && (
                      <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-app-accent" />
                    )}
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      <Icon
                        {...getNavIconProps(isActive)}
                        aria-hidden
                        className={`transition-all duration-150 ${
                          isActive
                            ? "scale-105 text-app-accent"
                            : "text-current group-hover:text-app-text"
                        }`}
                      />
                    </span>
                    {!collapsed && <span className={`truncate text-sm ${isActive ? 'font-black' : 'font-semibold'}`}>{tab.label}</span>}
                  </button>
                </SidebarRailTooltip>

                {isActive && !collapsed && subItems.length > 0 && (
                  <div className="ml-3 mt-1 mb-2 flex flex-col gap-0.5 border-l-2 border-app-border/40 pl-3">
                    {subItems.filter(sub => subSectionVisible(tab.id as SidebarTabId, sub.id, hasPermission, permissionsLoaded)).map(sub => (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() => onSubSectionChange?.(sub.id)}
                        className={`flex w-full cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1.5 text-left text-[11px] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/20 ${
                          activeSubSection === sub.id
                            ? "bg-app-surface-2 font-black text-app-accent"
                            : "font-semibold text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{sub.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Bottom Toggle */}
      <div className="mt-4 flex flex-col gap-2 border-t border-app-border pt-4">
        <SidebarRailTooltip enabled={collapsed} label="Expand sidebar">
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`flex w-full cursor-pointer items-center rounded-xl bg-app-surface-2 text-app-text-muted transition-all duration-150 hover:bg-app-surface hover:text-app-text active:scale-[0.99] border border-app-border shadow-sm touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30 ${
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
