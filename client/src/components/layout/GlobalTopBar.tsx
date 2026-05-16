import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { 
  ChevronRight, 
  LayoutDashboard,
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
  searchVariant?: "backoffice" | "pos";
  /** Toggles the responsive sidebar. */
  onToggleSidebar?: () => void;
  shellReturnLabel?: string;
  onShellReturn?: () => void;
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
  searchVariant = "backoffice",
  onToggleSidebar,
  shellReturnLabel,
  onShellReturn,
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
  const { isOnline, queueCount, pendingCount, blockedCount } = useOfflineSync(baseUrl, apiAuth);
  const isPosVariant = searchVariant === "pos";
  
  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  return (
    <header className="sticky top-0 z-50 flex h-16 shrink-0 flex-nowrap items-center gap-2 border-b border-app-border bg-[color-mix(in_srgb,var(--app-rail)_94%,transparent)] px-3 py-0 backdrop-blur-md sm:px-4 lg:gap-4 lg:px-6">
      <div
        className={cn(
          "flex min-w-0 flex-none items-center gap-2 lg:h-full lg:gap-3",
          isPosVariant ? "lg:min-w-0" : "lg:min-w-[200px]",
        )}
      >
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
        {onShellReturn ? (
          <button
            type="button"
            onClick={onShellReturn}
            className="inline-flex h-10 shrink-0 touch-manipulation items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[11px] font-black uppercase tracking-widest text-app-text shadow-sm transition-colors hover:border-app-accent/40 hover:bg-app-surface"
          >
            <LayoutDashboard size={16} aria-hidden />
            <span className="hidden whitespace-nowrap min-[480px]:inline">
              {shellReturnLabel ?? "Back to Back Office"}
            </span>
            <span className="whitespace-nowrap min-[480px]:hidden">Back</span>
          </button>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-start min-[720px]:justify-center">
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
          variant={searchVariant}
        />
      </div>

      <div className="flex flex-none items-center justify-end gap-2 sm:gap-3">
        {/* Dynamic Slot Region */}
        <div
          className={cn(
            "hidden items-center border-r border-app-border empty:hidden",
            onShellReturn && !isPosVariant ? "hidden" :
            isPosVariant ? "gap-2 px-2 min-[720px]:flex xl:px-3" : "gap-4 px-4 2xl:flex",
          )}
        >
          {slotContent}
        </div>

        {/* Global Action Cluster */}
        <div className="flex items-center gap-1 border-r border-app-border pr-2 sm:gap-1.5 sm:pr-3 md:mr-1">
          {onOpenRosie ? <RosieTriggerButton onOpen={onOpenRosie} /> : null}
          {onOpenHelp ? <HelpCenterTriggerButton onOpen={onOpenHelp} /> : null}
          {onOpenBugReport ? <BugReportTriggerButton onOpen={onOpenBugReport} /> : null}
          
          <button
            type="button"
            onClick={onThemeToggle}
            className="flex h-9 w-9 items-center justify-center rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all active:scale-95"
            title={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "light" ? <Moon size={20} /> : <Sun size={20} />}
          </button>

          <NotificationCenterBell />
        </div>

        {/* User Profile Hookup */}
        <div className="flex items-center gap-2 pl-1 sm:pl-2">
            {isTailscaleRemote && (
              <div 
                className="hidden items-center gap-1.5 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-indigo-500 animate-in fade-in slide-in-from-right-2 lg:flex"
                title="Connected via secure remote access"
              >
                <ShieldCheck size={12} className="shrink-0" />
                Remote Access
              </div>
            )}
            <div className="hidden text-right lg:block">
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
                 "flex h-10 w-10 items-center justify-center rounded-2xl border-2 overflow-hidden transition-all",
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
        <div className="flex flex-none items-center gap-1 overflow-visible xl:gap-2">
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
              className={cn(
                "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-widest",
                blockedCount > 0
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
              )}
              title={
                blockedCount > 0
                  ? `${blockedCount} completed POS checkout${blockedCount === 1 ? "" : "s"} need manager recovery. ${pendingCount} still pending sync.`
                  : `${pendingCount} completed POS checkout${pendingCount === 1 ? "" : "s"} waiting to sync when connectivity returns.`
              }
            >
              <div className={cn("h-2 w-2 rounded-full animate-pulse", blockedCount > 0 ? "bg-rose-500" : "bg-amber-500")} />
              <span className="sm:hidden">
                {blockedCount > 0 ? `${blockedCount} blocked` : `${pendingCount} sync${pendingCount === 1 ? "" : "s"}`}
              </span>
              <span className="hidden lg:inline">
                {blockedCount > 0
                  ? `${blockedCount} blocked checkout${blockedCount === 1 ? "" : "s"}`
                  : `${pendingCount} pending sync${pendingCount === 1 ? "" : "s"}`}
              </span>
              <span className="hidden sm:inline lg:hidden">
                {blockedCount > 0 ? `${blockedCount} blocked` : `${pendingCount} pending`}
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
