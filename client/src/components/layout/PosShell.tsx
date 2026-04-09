import { lazy, Suspense, useEffect, useRef, useState } from "react";
import PosSidebar, { type PosTabId } from "../pos/PosSidebar";
import Cart from "../pos/Cart";
import ProcurementHub from "../pos/ProcurementHub";
import CloseRegisterModal from "../pos/CloseRegisterModal";
import RegisterShiftHandoffModal from "../pos/RegisterShiftHandoffModal";
import RegisterOverlay from "../pos/RegisterOverlay";
import RegisterReports from "../pos/RegisterReports";
import RegisterLookupHub from "../pos/RegisterLookupHub";
import RegisterSettings from "../pos/RegisterSettings";
import RegisterTasksPanel from "../tasks/RegisterTasksPanel";
import RegisterDashboard from "../pos/RegisterDashboard";
import LayawayWorkspace from "../pos/LayawayWorkspace";

const AlterationsWorkspace = lazy(() => import("../alterations/AlterationsWorkspace"));
import type { Customer } from "../pos/CustomerSelector";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import type { SidebarTabId } from "./sidebarSections";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { LogOut, ShieldCheck, ShieldAlert, ChevronRight } from "lucide-react";
import NotificationCenterBell from "../notifications/NotificationCenterBell";
import { HelpCenterTriggerButton } from "../help/HelpCenterDrawer";
import { BugReportTriggerButton } from "../bug-report/BugReportFlow";

type ThemeMode = "light" | "dark" | "system";

export interface SessionOpenedPayload {
  cashierName: string;
  cashierCode: string;
  cashierAvatarKey: string;
  floatAmount: number;
  sessionId: string;
  registerLane: number;
  registerOrdinal: number;
  lifecycleStatus: string;
  role: string;
  /** IANA TZ from `GET /api/sessions/current` — matches receipt timestamp (live clock only; receipt uses server time at checkout). */
  receiptTimezone?: string;
  /** From server `pos_api_token` — required for customer API + checkout while session is open. */
  posApiToken?: string;
}

interface PosShellProps {
  activeTab: SidebarTabId;
  onTabChange: (tab: SidebarTabId) => void;
  onExitPosMode: () => void;
  isRegisterOpen: boolean;
  cashierName: string | null;
  /** Bundled avatar key for the open register session cashier (from `GET /api/sessions/current`). */
  cashierAvatarKey: string | null;
  cashierCode: string | null;
  registerOrdinal: number | null;
  registerLane: number | null;
  lifecycleStatus: string | null;
  sessionId: string | null;
  pendingPosCustomer: Customer | null;
  pendingPosOrderId: string | null;
  setPendingPosOrderId: (orderId: string | null) => void;
  setPendingPosCustomer: (c: Customer | null) => void;
  clearPendingPosCustomer: () => void;
  clearPendingPosOrder: () => void;
  pendingWeddingPosLink: RosOpenRegisterFromWmDetail | null;
  clearPendingWeddingPosLink: () => void;
  onSessionOpened: (p: SessionOpenedPayload) => void;
  showCloseModal: boolean;
  setShowCloseModal: (v: boolean) => void;
  handleSessionClosed: () => void;
  refreshOpenSessionMeta: () => Promise<void>;
  onRegisterReconcilingBegun: () => void;
  themeMode: ThemeMode;
  onThemeModeChange: (m: ThemeMode) => void;
  onOpenHelp?: () => void;
  onOpenBugReport?: () => void;
  /** Open Wedding Manager focused on a party (exits POS to full wedding workspace). */
  onOpenWeddingParty?: (partyId: string) => void;
  /** Store receipt timezone for POS clock (same zone as thermal receipt). */
  receiptTimezone: string;
}

export default function PosShell({
  onExitPosMode,
  isRegisterOpen,
  cashierName,
  cashierAvatarKey,
  cashierCode,
  registerOrdinal,
  registerLane,
  lifecycleStatus,
  sessionId,
  pendingPosCustomer,
  pendingPosOrderId,
  clearPendingPosCustomer,
  clearPendingPosOrder,
  pendingWeddingPosLink,
  clearPendingWeddingPosLink,
  onSessionOpened,
  showCloseModal,
  setShowCloseModal,
  handleSessionClosed,
  refreshOpenSessionMeta,
  onRegisterReconcilingBegun,
  themeMode,
  onThemeModeChange,
  onOpenHelp,
  onOpenBugReport,
  onOpenWeddingParty,
  receiptTimezone,
}: PosShellProps) {
  // PosShell manages its own internal tab and sidebar state.
  const [activePosTab, setActivePosTab] = useState<PosTabId>("register");
  const [managerMode, setManagerMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingInventorySku, setPendingInventorySku] = useState<string | null>(null);
  const { hasPermission, permissionsLoaded, setStaffCredentials } = useBackofficeAuth();
  const [shiftHandoffOpen, setShiftHandoffOpen] = useState(false);
  const lastLandingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isRegisterOpen || !sessionId) {
      lastLandingSessionRef.current = null;
      return;
    }
    if (lastLandingSessionRef.current === sessionId) return;
    lastLandingSessionRef.current = sessionId;
    const pendingSku = pendingInventorySku?.trim() ?? "";
    const pending =
      pendingPosCustomer ||
      pendingPosOrderId ||
      (pendingSku.length > 0 ? pendingSku : null) ||
      pendingWeddingPosLink;
    if (pending) {
      setActivePosTab("register");
    } else {
      setActivePosTab("dashboard");
    }
  }, [
    isRegisterOpen,
    sessionId,
    pendingPosCustomer,
    pendingPosOrderId,
    pendingInventorySku,
    pendingWeddingPosLink,
  ]);

  useEffect(() => {
    if (activePosTab !== "alterations") return;
    if (permissionsLoaded && !hasPermission("alterations.manage")) {
      setActivePosTab(isRegisterOpen && sessionId ? "dashboard" : "register");
    }
  }, [
    activePosTab,
    permissionsLoaded,
    hasPermission,
    isRegisterOpen,
    sessionId,
  ]);

  const handleSessionOpenedWithAuth: typeof onSessionOpened = (p) => {
    const code = p.cashierCode.trim();
    if (code.length === 4) {
      setStaffCredentials(code, code);
    }
    onSessionOpened(p);
  };

  const handleAddItemFromHub = (sku: string) => {
    const s = sku.trim();
    if (!s) return;
    setPendingInventorySku(s);
    setActivePosTab("register");
  };

  return (
    <div className="flex h-[100dvh] min-h-0 flex-row overflow-hidden bg-app-bg font-sans antialiased transition-colors duration-300">
      {/* Dedicated PosSidebar */}
      <PosSidebar
        activeTab={activePosTab}
        onTabChange={setActivePosTab}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        cashierName={cashierName}
        cashierAvatarKey={cashierAvatarKey}
        isRegisterOpen={isRegisterOpen}
        lifecycleStatus={lifecycleStatus}
      />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Simplified POS Top Bar */}
        <div
          className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-2 border-b border-app-border bg-app-surface px-3 py-2 shadow-sm sm:min-h-[3.5rem] sm:px-5 lg:px-8"
          style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:gap-3 lg:gap-4">
             {sidebarCollapsed && (
               <button
                type="button"
                onClick={() => setSidebarCollapsed(false)}
                className="ui-touch-target mr-2 flex items-center justify-center rounded-lg border border-app-border bg-app-surface-2 text-app-text-muted shadow-sm transition-all hover:text-app-text"
                aria-label="Show POS sidebar"
               >
                 <ChevronRight size={14} aria-hidden />
               </button>
             )}
             <button
                type="button"
                onClick={() => setManagerMode(!managerMode)}
                className={`inline-flex min-h-11 touch-manipulation items-center gap-2 rounded-xl border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all duration-200 ${
                  managerMode 
                    ? "border-amber-400/30 bg-amber-400/10 text-amber-500 shadow-[0_0_15px_-5px_rgba(245,158,11,0.3)]" 
                    : "border-app-border bg-app-surface-2 text-app-text-muted hover:text-app-text"
                  }`}
              >
                {managerMode ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
                {managerMode ? "Manager Active" : "Staff Mode"}
              </button>
            {managerMode &&
              isRegisterOpen &&
              sessionId &&
              permissionsLoaded &&
              hasPermission("register.shift_handoff") && (
                <button
                  type="button"
                  onClick={() => setShiftHandoffOpen(true)}
                  className="ui-btn-secondary min-h-11 border-app-border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                >
                  Shift handoff
                </button>
              )}
            {isRegisterOpen && registerLane != null ? (
              <span className="hidden rounded-lg border border-app-border bg-app-surface-2 px-2.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted min-[480px]:inline">
                Register #{registerLane}
              </span>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3 lg:gap-4">
            {onOpenHelp ? <HelpCenterTriggerButton onOpen={onOpenHelp} /> : null}
            {onOpenBugReport ? <BugReportTriggerButton onOpen={onOpenBugReport} /> : null}
            <NotificationCenterBell />
            {isRegisterOpen &&
              (activePosTab === "register" || activePosTab === "dashboard") &&
              (registerLane === 1 || registerLane == null) ? (
                <button
                  type="button"
                  onClick={() => setShowCloseModal(true)}
                  className="ui-btn-secondary min-h-11 border-red-200/40 bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all shadow-sm"
                >
                  Close till
                </button>
              ) : null}
            <button
              type="button"
              onClick={onExitPosMode}
              className="ui-btn-secondary flex min-h-11 max-w-[11rem] items-center gap-2 truncate border-app-accent/20 text-app-accent transition-all hover:bg-app-accent hover:text-white shadow-sm sm:max-w-none"
            >
              <LogOut size={14} aria-hidden className="shrink-0" />
              <span className="truncate">
                <span className="sm:hidden">Exit POS</span>
                <span className="hidden sm:inline">Exit POS mode</span>
              </span>
            </button>
          </div>
        </div>

        {/* Body — click collapses expanded POS sidebar (top bar excluded) */}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden workspace-snap"
          onClick={(e) => {
            // Only collapse when tapping empty chrome; do not handle bubbled clicks from Cart/keypad.
            if (e.target !== e.currentTarget) return;
            if (!sidebarCollapsed) setSidebarCollapsed(true);
          }}
        >
          {activePosTab === "dashboard" &&
            (!isRegisterOpen || !sessionId ? (
              <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm text-app-text-muted">
                Open the till to view your dashboard.
              </div>
            ) : (
              <RegisterDashboard
                sessionId={sessionId}
                registerOrdinal={registerOrdinal}
                cashierName={cashierName}
                lifecycleStatus={lifecycleStatus}
                onGoToRegister={() => setActivePosTab("register")}
                onGoToWeddings={() => setActivePosTab("weddings")}
                onGoToTasks={() => setActivePosTab("tasks")}
                onOpenWeddingParty={onOpenWeddingParty}
              />
            ))}

          {(activePosTab === "register" || activePosTab === "weddings") && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              {!isRegisterOpen ? (
                <RegisterOverlay onSessionOpened={handleSessionOpenedWithAuth} />
              ) : sessionId ? (
                <Cart
                  sessionId={sessionId}
                  receiptTimezone={receiptTimezone}
                  cashierName={cashierName}
                  cashierCode={cashierCode}
                  initialCustomer={pendingPosCustomer}
                  onInitialCustomerConsumed={clearPendingPosCustomer}
                  initialOrderId={pendingPosOrderId}
                  onInitialOrderConsumed={clearPendingPosOrder}
                  managerMode={managerMode}
                  initialWeddingLookupOpen={activePosTab === "weddings"}
                  initialWeddingPosLink={pendingWeddingPosLink}
                  onInitialWeddingPosLinkConsumed={clearPendingWeddingPosLink}
                  pendingInventorySku={pendingInventorySku}
                  onPendingInventorySkuConsumed={() => setPendingInventorySku(null)}
                  onSaleCompleted={() => setActivePosTab("register")}
                />
              ) : null}
            </div>
          )}

          {activePosTab === "tasks" && isRegisterOpen && sessionId ? (
            <RegisterTasksPanel />
          ) : activePosTab === "tasks" ? (
            <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm text-app-text-muted">
              Open the till to view shift tasks.
            </div>
          ) : null}

          {activePosTab === "inventory" && <ProcurementHub onAddItemToCart={handleAddItemFromHub} />}
          {activePosTab === "alterations" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-semibold text-app-text-muted">
                    Loading alterations…
                  </div>
                }
              >
                <AlterationsWorkspace />
              </Suspense>
            </div>
          )}
          {activePosTab === "reports" && <RegisterReports sessionId={sessionId} />}
          {activePosTab === "gift-cards" && (
            <RegisterLookupHub initialTab="giftcard" registerSessionId={sessionId} />
          )}
          {activePosTab === "loyalty" && (
            <RegisterLookupHub initialTab="loyalty" registerSessionId={sessionId} />
          )}
          {activePosTab === "layaways" && (
            <LayawayWorkspace 
                registerSessionId={sessionId} 
                onOpenOrder={(orderId) => {
                    setPendingPosOrderId(orderId);
                    setActivePosTab("register");
                }}
            />
          )}
          {activePosTab === "settings" && (
            <RegisterSettings 
              themeMode={themeMode} 
              onThemeModeChange={onThemeModeChange}
              sessionId={sessionId}
              cashierCode={cashierCode}
              lifecycleStatus={lifecycleStatus}
              onRefreshMeta={refreshOpenSessionMeta}
            />
          )}
        </div>
      </div>

      {/* Close register modal */}
      {showCloseModal && sessionId && (registerLane === 1 || registerLane == null) && (
        <CloseRegisterModal
          sessionId={sessionId}
          cashierName={cashierName}
          registerLane={registerLane}
          registerOrdinal={registerOrdinal}
          onReconcilingBegun={onRegisterReconcilingBegun}
          onCloseComplete={handleSessionClosed}
          onCancel={() => {
            setShowCloseModal(false);
            void refreshOpenSessionMeta();
          }}
        />
      )}

      {shiftHandoffOpen && sessionId ? (
        <RegisterShiftHandoffModal
          isOpen={shiftHandoffOpen}
          onClose={() => setShiftHandoffOpen(false)}
          sessionId={sessionId}
          onHandoffComplete={refreshOpenSessionMeta}
          onAdoptShiftCredentials={(code) => setStaffCredentials(code, code)}
        />
      ) : null}
    </div>
  );
}
