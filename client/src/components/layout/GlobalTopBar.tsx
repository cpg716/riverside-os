import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  ChevronRight, 
  Menu,
  Sun,
  Moon,
  LogOut,
  Users,
  User,
  ShieldCheck,
} from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import { useOfflineSync } from "../../lib/offlineQueue";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import NotificationCenterBell from "../notifications/NotificationCenterBell";
import {
  HelpCenterTriggerButton,
  RosieTriggerButton,
} from "../help/HelpCenterDrawer";
import { BugReportTriggerButton } from "../bug-report/BugReportFlow";
import { useTopBar } from "../../context/TopBarContextLogic";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import type { ThemeMode } from "../../App";
import type { SidebarTabId } from "./sidebarSections";
import GlobalCommandSearch from "./GlobalCommandSearch";


const baseUrl = getBaseUrl();

export interface BreadcrumbSegment {
  label: string;
  onClick?: () => void;
}

interface GlobalTopBarProps {
  segments: BreadcrumbSegment[];
  onNavigateRegister: () => void;
  onSelectCustomerForPos?: (customer: Customer) => void;
  /** When set, customer hits open the command-center drawer instead of jumping to the register. */
  onSearchOpenCustomerDrawer?: (customer: Customer) => void;
  /** SKU / product hits open a slide-over with scan resolution and pricing. */
  onSearchOpenProductDrawer?: (sku: string, hintName?: string) => void;
  /** Opens customer list filtered by wedding party name. */
  onSearchOpenWeddingPartyCustomers?: (partyQuery: string) => void;
  onSearchOpenOrder?: (transactionId: string) => void;
  onSearchOpenShipment?: (shipmentId: string) => void;
  onSearchOpenWeddingParty?: (partyId: string) => void;
  onSearchOpenAlteration?: (alterationId: string) => void;
  /** Toggles the responsive sidebar. */
  onToggleSidebar?: () => void;
  /** When false, show optional Back Office "Switch staff" (register not required for BO). */
  isRegisterOpen?: boolean;
  onOpenHelp?: () => void;
  onOpenRosie?: () => void;
  onOpenBugReport?: () => void;
  themeMode: ThemeMode;
  onThemeToggle: () => void;
  cashierName?: string | null;
  cashierAvatarKey?: string | null;
  onNavigateToTab?: (tab: SidebarTabId, section?: string) => void;
}

export default function GlobalTopBar({
  segments,
  onNavigateRegister,
  onSelectCustomerForPos,
  onSearchOpenCustomerDrawer,
  onSearchOpenProductDrawer,
  onSearchOpenWeddingPartyCustomers,
  onSearchOpenOrder,
  onSearchOpenShipment,
  onSearchOpenWeddingParty,
  onSearchOpenAlteration,
  onToggleSidebar,
  isRegisterOpen = false,
  onOpenHelp,
  onOpenRosie,
  onOpenBugReport,
  themeMode,
  onThemeToggle,
  cashierName,
  cashierAvatarKey,
  onNavigateToTab,
}: GlobalTopBarProps) {
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const { slotContent } = useTopBar();

  const {
    backofficeHeaders,
    clearStaffCredentials,
    staffDisplayName,
    staffAvatarKey
  } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const { isOnline, queueCount } = useOfflineSync(baseUrl, apiAuth);
  
  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  return (
    <header className="sticky top-0 z-50 flex min-h-[84px] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-app-border bg-app-surface/90 px-3 py-3 backdrop-blur-md sm:px-4 lg:h-[84px] lg:flex-nowrap lg:gap-6 lg:px-8 lg:py-0">
      <div className="flex min-w-0 flex-1 items-center gap-3 lg:h-full lg:min-w-[240px] lg:flex-none lg:gap-4">
        {onToggleSidebar && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSidebar();
            }}
            className="ui-touch-target flex shrink-0 items-center justify-center rounded-xl bg-app-surface-2 text-app-text-muted hover:bg-app-surface hover:text-app-text lg:hidden"
            aria-label="Toggle menu"
          >
            <Menu size={20} />
          </button>
        )}
        <nav
          className="hidden min-w-0 shrink-0 items-center gap-1 text-sm font-semibold text-app-text-muted lg:flex"
          aria-label="Breadcrumb"
        >
          {segments.map((seg, i) => (
            <span key={`${seg.label}-${i}`} className="flex items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-4 w-4 shrink-0 text-app-text-muted" aria-hidden />
              )}
              {seg.onClick ? (
                <button
                  type="button"
                  onClick={seg.onClick}
                  className="truncate rounded px-2 py-1 text-left text-app-text hover:bg-app-accent/10 hover:text-app-accent transition-colors"
                >
                  {seg.label}
                </button>
              ) : (
                <span
                  className={cn(
                    "truncate px-2",
                    i === segments.length - 1
                      ? "font-bold text-app-text"
                      : "text-app-text-muted/60"
                  )}
                >
                  {seg.label}
                </span>
              )}
            </span>
          ))}
        </nav>
      </div>

      <GlobalCommandSearch
        onNavigateRegister={onNavigateRegister}
        onSelectCustomerForPos={onSelectCustomerForPos}
        onSearchOpenCustomerDrawer={onSearchOpenCustomerDrawer}
        onSearchOpenProductDrawer={onSearchOpenProductDrawer}
        onSearchOpenWeddingPartyCustomers={onSearchOpenWeddingPartyCustomers}
        onSearchOpenOrder={onSearchOpenOrder}
        onSearchOpenShipment={onSearchOpenShipment}
        onSearchOpenWeddingParty={onSearchOpenWeddingParty}
        onSearchOpenAlteration={onSearchOpenAlteration}
        onNavigateToTab={onNavigateToTab}
      />

      <div className="ml-auto flex min-w-0 shrink-0 items-center justify-end gap-2 sm:gap-3 lg:min-w-[400px]">
        {/* Dynamic Slot Region */}
        <div className="hidden items-center gap-4 border-r border-app-border px-4 empty:hidden xl:flex">
          {slotContent}
        </div>

        {/* Global Action Cluster */}
        <div className="flex items-center gap-1 border-r border-app-border pr-2 sm:gap-1.5 sm:pr-4 md:mr-2">
          {onOpenRosie ? <RosieTriggerButton onOpen={onOpenRosie} /> : null}
          {onOpenHelp ? <HelpCenterTriggerButton onOpen={onOpenHelp} /> : null}
          {onOpenBugReport ? <BugReportTriggerButton onOpen={onOpenBugReport} /> : null}
          
          <button
            type="button"
            onClick={onThemeToggle}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all active:scale-95"
            title={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "light" ? <Moon size={20} /> : <Sun size={20} />}
          </button>

          <NotificationCenterBell />
        </div>

        {/* User Profile Hookup */}
        <div className="flex items-center gap-3 pl-2">
            {isTailscaleRemote && (
              <div 
                className="hidden items-center gap-1.5 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 animate-in fade-in slide-in-from-right-2 lg:flex"
                title="Connected via Tailscale Remote Access"
              >
                <ShieldCheck size={12} className="shrink-0" />
                Remote Node
              </div>
            )}
            <div className="text-right hidden md:block">
            <p className="text-xs font-bold text-app-text leading-tight">
              {staffDisplayName || (isRegisterOpen ? (cashierName || "Cashier") : "User")}
            </p>
            <div className="flex items-center justify-end gap-1.5">
               <div className={cn("h-1.5 w-1.5 rounded-full", isRegisterOpen ? "bg-emerald-500" : "bg-rose-500")} />
               <p className="text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-60">
                 Till {isRegisterOpen ? "Open" : "Closed"}
               </p>
            </div>
          </div>
          
          <div className="relative" ref={userMenuRef}>
            <button
               type="button"
               onClick={() => setUserMenuOpen(!userMenuOpen)}
               className={cn(
                 "flex h-11 w-11 items-center justify-center rounded-2xl border-2 overflow-hidden transition-all",
                 isRegisterOpen ? "border-emerald-500/20" : "border-app-border hover:border-app-accent/40",
                 userMenuOpen && "border-app-accent ring-4 ring-app-accent/10"
               )}
               aria-expanded={userMenuOpen}
               aria-haspopup="true"
            >
              <img 
                src={staffAvatarUrl(staffAvatarKey || (isRegisterOpen ? cashierAvatarKey : null))} 
                alt="" 
                className="h-full w-full object-cover" 
              />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-[100] mt-2 w-56 origin-top-right rounded-2xl border border-app-border bg-app-surface p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                <div className="px-3 py-2 border-b border-app-border mb-1.5">
                   <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Identity</p>
                   <p className="text-xs font-black truncate text-app-text">{staffDisplayName || "Authenticated Staff"}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    if (onNavigateToTab) {
                      onNavigateToTab("settings", "profile");
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-app-text hover:bg-app-surface-2 transition-all active:scale-95"
                >
                  <User size={16} className="text-app-accent" />
                  <span>My Profile</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    clearStaffCredentials();
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-app-text hover:bg-app-surface-2 transition-all active:scale-95"
                >
                  <Users size={16} className="text-app-accent" />
                  <span>Change Staff Member</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    clearStaffCredentials();
                  }}
                  className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-xs font-bold text-rose-500 hover:bg-rose-500/5 transition-all active:scale-95"
                >
                  <LogOut size={16} />
                  <span>Logout</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Status Indicators */}
        <div className="order-4 flex w-full items-center gap-2 overflow-x-auto pb-0.5 lg:order-none lg:w-auto lg:justify-end lg:overflow-visible lg:pb-0">
          {!isOnline && (
            <div
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-rose-700 dark:text-rose-200"
              title="Offline: only completed POS checkouts can queue until connectivity returns. Inventory, settings, and most back-office changes still need the server."
            >
              <div className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
              <span className="sm:hidden">Offline</span>
              <span className="hidden lg:inline">
                Offline: POS checkout can queue
              </span>
              <span className="hidden sm:inline lg:hidden">Offline</span>
            </div>
          )}
          {queueCount > 0 && (
            <div
              className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[10px] font-black uppercase tracking-widest text-amber-800 dark:text-amber-200"
              title={`${queueCount} completed POS checkout${queueCount === 1 ? "" : "s"} waiting to sync when connectivity returns.`}
            >
              <div className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              <span className="sm:hidden">
                {queueCount} sync{queueCount === 1 ? "" : "s"}
              </span>
              <span className="hidden lg:inline">
                {queueCount} pending sync{queueCount === 1 ? "" : "s"}
              </span>
              <span className="hidden sm:inline lg:hidden">
                {queueCount} pending
              </span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function cn(...inputs: (string | boolean | undefined | null | Record<string, boolean>)[]) {
  return inputs
    .filter(Boolean)
    .map((x) => {
      if (typeof x === "object" && x !== null) {
        return Object.entries(x as Record<string, boolean>)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(" ");
      }
      return x;
    })
    .join(" ");
}
