import { useMemo } from "react";
import {
  FileBarChart,
  Gift,
  LayoutDashboard,
  ListChecks,
  Settings,
  ShoppingCart,
  Star,
  ChevronLeft,
  ChevronRight,
  Box,
  Heart,
  Scissors,
  Clock,
} from "lucide-react";
import SidebarRailTooltip from "../ui/SidebarRailTooltip";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

export type PosTabId =
  | "dashboard"
  | "register"
  | "tasks"
  | "inventory"
  | "weddings"
  | "alterations"
  | "reports"
  | "gift-cards"
  | "loyalty"
  | "layaways"
  | "settings";

interface PosSidebarProps {
  activeTab: PosTabId;
  onTabChange: (tab: PosTabId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export default function PosSidebar({
  activeTab,
  onTabChange,
  collapsed,
  onToggleCollapse,
}: PosSidebarProps) {
  const { hasPermission, permissionsLoaded } =
    useBackofficeAuth();


  const tabs = useMemo(() => {
    const out: {
      id: PosTabId;
      label: string;
      icon: typeof ShoppingCart;
    }[] = [
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { id: "register", label: "Register", icon: ShoppingCart },
      { id: "tasks", label: "Tasks", icon: ListChecks },
      { id: "weddings", label: "Weddings", icon: Heart },
    ];
    if (!permissionsLoaded || hasPermission("alterations.manage")) {
      out.push({ id: "alterations", label: "Alterations", icon: Scissors });
    }
    out.push(
      { id: "inventory", label: "Inventory", icon: Box },
      { id: "reports", label: "Reports", icon: FileBarChart },
      { id: "gift-cards", label: "Gift Cards", icon: Gift },
      { id: "loyalty", label: "Loyalty", icon: Star },
      { id: "layaways", label: "Layaways", icon: Clock },
      { id: "settings", label: "Settings", icon: Settings },
    );
    return out;
  }, [hasPermission, permissionsLoaded]);

  return (
    <aside
      className={`ui-rail z-40 flex shrink-0 flex-col border-r border-app-border bg-app-surface py-5 text-app-text transition-all duration-300 ease-material md:sticky md:top-[84px] md:h-[calc(100vh-84px)] overflow-y-auto custom-scrollbar ${
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
            return (
              <SidebarRailTooltip
                key={tab.id}
                enabled={collapsed}
                label={`${tab.label} (POS)`}
              >
                <button
                  type="button"
                  data-testid={
                    tab.id === "register"
                      ? "pos-sidebar-tab-register"
                      : tab.id === "dashboard"
                        ? "pos-sidebar-tab-dashboard"
                        : undefined
                  }
                  onClick={() => onTabChange(tab.id)}
                  aria-label={tab.label}
                  aria-current={isActive ? "page" : undefined}
                  className={`ui-touch-target group relative flex items-center gap-2.5 rounded-xl transition-all duration-150 ${
                    collapsed ? "h-11 w-full justify-center" : "min-h-11 w-full px-3 py-3"
                  } ${
                    isActive
                      ? "border border-app-border bg-app-surface-2 text-app-text shadow-sm"
                      : "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                  }`}
                >
                  {isActive && !collapsed && (
                    <span className="absolute left-0 top-2 bottom-2 w-1 rounded-r-full bg-app-accent" />
                  )}
                  <Icon size={18} aria-hidden className={`relative shrink-0 ${isActive ? 'text-app-accent' : ''}`} />
                  {!collapsed && <span className={`truncate text-sm ${isActive ? 'font-black' : 'font-semibold'}`}>{tab.label}</span>}
                </button>
              </SidebarRailTooltip>
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
            className={`flex w-full items-center rounded-xl bg-app-surface-2 text-app-text-muted transition-all hover:bg-app-surface hover:text-app-text border border-app-border shadow-sm touch-manipulation ${
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
