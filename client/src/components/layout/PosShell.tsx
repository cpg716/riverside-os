import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useTopBar } from "../../context/TopBarContextLogic";
import PosSidebar from "../pos/PosSidebar";
import {
  POS_SIDEBAR_SUB_SECTIONS,
  type PosTabId,
} from "../pos/posSidebarSections";
import Cart from "../pos/Cart";
import CloseRegisterModal from "../pos/CloseRegisterModal";
import RegisterShiftHandoffModal from "../pos/RegisterShiftHandoffModal";
import RegisterOverlay from "../pos/RegisterOverlay";
import RegisterReports from "../pos/RegisterReports";
import RegisterTasksPanel from "../tasks/RegisterTasksPanel";
import RegisterDashboard from "../pos/RegisterDashboard";
import LayawayWorkspace from "../pos/LayawayWorkspace";
const CustomersWorkspace = lazy(() => import("../customers/CustomersWorkspace"));
import PodiumMessagingInboxSection from "../customers/PodiumMessagingInboxSection";
const LoyaltyWorkspace = lazy(() => import("../loyalty/LoyaltyWorkspace"));
const ShipmentsHubSection = lazy(() => import("../customers/ShipmentsHubSection"));
const SettingsWorkspace = lazy(() => import("../settings/SettingsWorkspace"));
const PaymentsWorkspace = lazy(() => import("../payments/PaymentsWorkspace"));

const OrdersWorkspace = lazy(() => import("../orders/OrdersWorkspace"));
const ProcurementHub = lazy(() => import("../pos/ProcurementHub"));
const GiftCardsWorkspace = lazy(() => import("../gift-cards/GiftCardsWorkspace"));

const AlterationsWorkspace = lazy(() => import("../alterations/AlterationsWorkspace"));
const WeddingManagerApp = lazy(() => import("../wedding-manager/WeddingManagerApp"));
import type { Customer } from "../pos/CustomerSelector";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import type { SidebarTabId } from "./sidebarSections";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { ArrowLeft, ShieldCheck, ShieldAlert } from "lucide-react";
import { getAppIcon, APP_ICON_SIZES } from "../../lib/icons";

const REGISTER_ICON = getAppIcon("register");

/** Idle timeout: register open — 10 minutes of no interaction locks the session */
const REGISTER_IDLE_MS = 10 * 60 * 1000;
/** Idle timeout: PIN overlay showing — 5 minutes of no interaction returns to dashboard */
const PIN_IDLE_MS = 5 * 60 * 1000;


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
  receiptTimezone?: string;
  posApiToken?: string;
}

interface PosShellProps {
  activeTab: SidebarTabId;
  onTabChange: (tab: SidebarTabId) => void;
  isRegisterOpen: boolean;
  cashierName: string | null;
  cashierCode: string | null;
  registerOrdinal: number | null;
  registerLane: number | null;
  lifecycleStatus: string | null;
  sessionId: string | null;
  pendingPosCustomer: Customer | null;
  pendingPosTransactionId: string | null;
  pendingPosTransactionForPickup: boolean;
  setPendingPosTransactionId: (transactionId: string | null) => void;
  setPendingPosTransactionForPickup: (forPickup: boolean) => void;
  setPendingPosCustomer: (c: Customer | null) => void;
  clearPendingPosCustomer: () => void;
  clearPendingPosTransaction: () => void;
  pendingWeddingPosLink: RosOpenRegisterFromWmDetail | null;
  clearPendingWeddingPosLink: () => void;
  onSessionOpened: (p: SessionOpenedPayload) => void;
  showCloseModal: boolean;
  setShowCloseModal: (v: boolean) => void;
  handleSessionClosed: () => void;
  refreshOpenSessionMeta: () => Promise<void>;
  onRegisterReconcilingBegun: () => void;
  onRegisterTransactionCommitted: () => void;
  onOpenWeddingParty?: (partyId: string) => void;
  refreshSignal: number;
  receiptTimezone: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSubSection: string;
  onSubSectionChange: (id: string) => void;
  pendingWmPartyId: string | null;
  onClearPendingWmPartyId: () => void;
}

export default function PosShell({
  isRegisterOpen,
  cashierName,
  cashierCode,
  registerOrdinal,
  registerLane,
  lifecycleStatus,
  sessionId,
  pendingPosCustomer,
  pendingPosTransactionId,
  pendingPosTransactionForPickup,
  setPendingPosTransactionId,
  setPendingPosTransactionForPickup,
  setPendingPosCustomer,
  clearPendingPosCustomer,
  clearPendingPosTransaction,
  pendingWeddingPosLink,
  clearPendingWeddingPosLink,
  onSessionOpened,
  showCloseModal,
  setShowCloseModal,
  handleSessionClosed,
  refreshOpenSessionMeta,
  onRegisterReconcilingBegun,
  onRegisterTransactionCommitted,
  onOpenWeddingParty,
  refreshSignal,
  receiptTimezone,
  collapsed,
  onToggleCollapse,
  activeSubSection,
  onSubSectionChange,
  pendingWmPartyId,
  onClearPendingWmPartyId,
  activeTab,
  onTabChange,
}: PosShellProps) {
  const [activePosTab, setActivePosTab] = useState<PosTabId>(activeTab as PosTabId || "pos-dashboard");

  useEffect(() => {
    // Keep this parent -> local hydration one-way.
    // Including activePosTab in this effect's dependencies makes local POS tab clicks
    // fight with the parent shell tab, which remounts dashboard/register/tasks and
    // floods their mount-time fetches.
    if (activeTab) {
      setActivePosTab((current) =>
        current === (activeTab as PosTabId) ? current : (activeTab as PosTabId),
      );
    }
  }, [activeTab]);
  const [managerMode, setManagerMode] = useState(false);
  const [pendingInventorySku, setPendingInventorySku] = useState<string | null>(null);

  // ─── Idle timeout ────────────────────────────────────────────────────────────
  // 10-min register idle  → call handleSessionClosed (PIN overlay reappears)
  // 5-min  PIN-overlay idle → navigate to pos-dashboard
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);

    if (isRegisterOpen && sessionId) {
      // Register is open — fire after REGISTER_IDLE_MS of inactivity
      idleTimerRef.current = setTimeout(() => {
        handleSessionClosed();
      }, REGISTER_IDLE_MS);
    } else if (!isRegisterOpen) {
      // PIN overlay is showing — navigate to dashboard after PIN_IDLE_MS
      idleTimerRef.current = setTimeout(() => {
        setActivePosTab("pos-dashboard");
      }, PIN_IDLE_MS);
    }
  }, [isRegisterOpen, sessionId, handleSessionClosed]);

  useEffect(() => {
    // Start the idle timer and reset on any user interaction
    resetIdleTimer();
    const events = ["mousemove", "pointerdown", "keydown", "touchstart", "scroll"] as const;
    const handler = () => resetIdleTimer();
    events.forEach((ev) => document.addEventListener(ev, handler, { passive: true }));
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      events.forEach((ev) => document.removeEventListener(ev, handler));
    };
  }, [resetIdleTimer]);
  // ─────────────────────────────────────────────────────────────────────────────
  const [posMessagingFocusCustomerId, setPosMessagingFocusCustomerId] =
    useState<string | null>(null);
  const [posMessagingFocusHubTab, setPosMessagingFocusHubTab] = useState<
    string | null
  >(null);
  const { hasPermission, permissionsLoaded, setStaffCredentials } = useBackofficeAuth();
  const [shiftHandoffOpen, setShiftHandoffOpen] = useState(false);
  useEffect(() => {
    if (!isRegisterOpen || !sessionId) return;

    const landingKey = `ros.pos.landed.${sessionId}`;
    if (sessionStorage.getItem(landingKey)) return;
    sessionStorage.setItem(landingKey, "true");

    const pendingSku = pendingInventorySku?.trim() ?? "";
    const pending = pendingPosCustomer || pendingPosTransactionId || (pendingSku.length > 0 ? pendingSku : null) || pendingWeddingPosLink;
    if (pending) {
      setActivePosTab("register");
    } else {
      setActivePosTab("pos-dashboard");
    }
  }, [isRegisterOpen, sessionId, pendingPosCustomer, pendingPosTransactionId, pendingInventorySku, pendingWeddingPosLink]);

  useEffect(() => {
    if (activePosTab !== "alterations") return;
    if (permissionsLoaded && !hasPermission("alterations.manage")) {
      setActivePosTab(isRegisterOpen && sessionId ? "pos-dashboard" : "register");
    }
  }, [activePosTab, permissionsLoaded, hasPermission, isRegisterOpen, sessionId]);

  useEffect(() => {
    const nextTab = activePosTab as SidebarTabId;
    if (activeTab !== nextTab) {
      onTabChange(nextTab);
    }

    const subSections = POS_SIDEBAR_SUB_SECTIONS[activePosTab] ?? [];
    const defaultSubSection = subSections[0]?.id;
    if (defaultSubSection && activeSubSection !== defaultSubSection) {
      onSubSectionChange(defaultSubSection);
    }
  }, [
    activePosTab,
    activeTab,
    activeSubSection,
    onSubSectionChange,
    onTabChange,
  ]);

  const handleSessionOpenedWithAuth: typeof onSessionOpened = (p) => {
    const code = p.cashierCode.trim();
    if (code.length === 4) { setStaffCredentials(code, code); }
    onSessionOpened(p);
  };

  const { setSlotContent } = useTopBar();

  useEffect(() => {
    if (activePosTab === "weddings") {
      setSlotContent(
        <button
          type="button"
          onClick={() => setActivePosTab(isRegisterOpen && sessionId ? "register" : "pos-dashboard")}
          className="h-10 rounded-xl border-2 border-app-border bg-app-surface-2 px-4 text-[9px] font-black uppercase tracking-widest italic text-app-text-muted transition-all hover:border-app-accent hover:text-app-text active:scale-95 flex items-center gap-2"
        >
          <ArrowLeft size={16} strokeWidth={3} /> Return to POS
        </button>,
      );
      return () => setSlotContent(null);
    }

    setSlotContent(
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setManagerMode(!managerMode)}
          className={`h-10 px-3 xl:px-4 rounded-xl border-2 flex items-center gap-2 text-[9px] font-black uppercase tracking-widest italic transition-all active:scale-95 ${
            managerMode
              ? "border-amber-400/40 bg-amber-400/10 text-amber-500 shadow-glow-amber-xs"
              : "border-app-border bg-app-surface-2 text-app-text-muted"
          }`}
        >
          {managerMode ? <ShieldCheck size={16} strokeWidth={3} /> : <ShieldAlert size={16} />}
          <span className="hidden xl:inline">{managerMode ? "Manager Access" : "Staff Access"}</span>
          <span className="xl:hidden">{managerMode ? "Manager" : "Staff"}</span>
        </button>

        {managerMode &&
          isRegisterOpen &&
          sessionId &&
          permissionsLoaded &&
          hasPermission("register.shift_handoff") && (
            <button
              type="button"
              onClick={() => setShiftHandoffOpen(true)}
              className="h-10 px-3 xl:px-4 rounded-xl border-2 border-app-border bg-app-surface-2 text-[9px] font-black uppercase tracking-widest italic text-app-text-muted hover:border-app-accent hover:text-app-text transition-all active:scale-95"
            >
              Handoff
            </button>
          )}

        {isRegisterOpen && sessionId && registerLane === 1 && (
          <button
            type="button"
            onClick={() => setShowCloseModal(true)}
            className="h-10 px-3 xl:px-4 rounded-xl border-2 border-app-warning/30 bg-app-warning/10 text-[9px] font-black uppercase tracking-widest italic text-app-warning hover:border-app-warning/50 hover:bg-app-warning/15 transition-all active:scale-95"
          >
            <span className="hidden xl:inline">Close Register</span>
            <span className="xl:hidden">Close</span>
          </button>
        )}

        {isRegisterOpen && sessionId && registerLane != null && registerLane !== 1 && (
          <div className="h-10 px-3 xl:px-4 rounded-xl border border-app-border bg-app-surface-2 text-[9px] font-black uppercase tracking-widest italic text-app-text-muted flex items-center">
            <span className="hidden xl:inline">Close on Register #1</span>
            <span className="xl:hidden">Close on #1</span>
          </div>
        )}

        {isRegisterOpen && registerLane != null && (
          <div className="hidden px-4 h-8 xl:flex items-center gap-2 rounded-full bg-app-surface-2 border border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted italic shadow-inner">
            <REGISTER_ICON size={APP_ICON_SIZES.badge} className="text-app-accent" /> Register #{registerLane}
          </div>
        )}
      </div>
    );
    return () => setSlotContent(null);
  }, [
    activePosTab,
    managerMode,
    isRegisterOpen,
    sessionId,
    permissionsLoaded,
    hasPermission,
    registerLane,
    setShowCloseModal,
    setSlotContent,
  ]);

  return (
    <div
      className="flex flex-1 w-full bg-app-bg font-sans antialiased transition-colors duration-300"
      data-testid="pos-shell-root"
      data-pos-active-tab={activePosTab}
      data-register-open={isRegisterOpen ? "true" : "false"}
      data-register-session-ready={isRegisterOpen && sessionId ? "true" : "false"}
    >
      <PosSidebar
        activeTab={activePosTab}
        onTabChange={setActivePosTab}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        activeSubSection={activeSubSection}
        onSubSectionChange={onSubSectionChange}
      />

      <div className="flex flex-1 flex-col">

        <div className="flex flex-1 flex-col workspace-snap" onClick={(e) => { const t = e.target; if (t instanceof HTMLElement && t.closest('[data-pin-entry="true"]')) return; if (!collapsed) onToggleCollapse(); }}>
          {activePosTab === "pos-dashboard" && (!isRegisterOpen || !sessionId ? (
              <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-40">Open register to view the sales dashboard.</div>
            ) : (
              <RegisterDashboard
                registerOrdinal={registerOrdinal}
                cashierName={cashierName}
                onGoToRegister={() => setActivePosTab("register")}
                onGoToWeddings={() => setActivePosTab("weddings")}
                onGoToOrders={() => setActivePosTab("orders")}
                onGoToAlterations={() => setActivePosTab("alterations")}
                onGoToInventory={() => setActivePosTab("inventory")}
                onGoToTasks={() => setActivePosTab("tasks")}
                onOpenOrderInRegister={(orderId) => {
                  setPendingPosTransactionId(orderId);
                  clearPendingPosCustomer();
                  setActivePosTab("register");
                }}
                onOpenWeddingParty={(partyId) => {
                  setActivePosTab("weddings");
                  onOpenWeddingParty?.(partyId);
                }}
              />
            ))}

          {(activePosTab === "register") && (
            <div
              className="relative flex min-h-0 flex-1 flex-col"
              data-testid="pos-register-panel"
              data-register-state={
                !isRegisterOpen ? "needs-open" : sessionId ? "mounted" : "missing-session"
              }
            >
              {!isRegisterOpen ? (
                <RegisterOverlay
                  onSessionOpened={handleSessionOpenedWithAuth}
                  onCancel={() => {
                    const savedTab = sessionStorage.getItem("ros.pos.active_tab") as SidebarTabId | null;
                    setActivePosTab(savedTab && savedTab !== "register" ? (savedTab as PosTabId) : "pos-dashboard");
                  }}
                />
              ) : sessionId ? (
                <Cart
                  sessionId={sessionId}
                  registerLane={registerLane}
                  receiptTimezone={receiptTimezone}
                  cashierName={cashierName}
                  cashierCode={cashierCode}
                  initialCustomer={pendingPosCustomer}
                  onInitialCustomerConsumed={clearPendingPosCustomer}
                  initialTransactionId={pendingPosTransactionId}
                  initialTransactionForPickup={pendingPosTransactionForPickup}
                  onInitialTransactionConsumed={clearPendingPosTransaction}
                  managerMode={managerMode}
                  initialWeddingLookupOpen={false}
                  initialWeddingPosLink={pendingWeddingPosLink}
                  onInitialWeddingPosLinkConsumed={clearPendingWeddingPosLink}
                  pendingInventorySku={pendingInventorySku}
                  onPendingInventorySkuConsumed={() => setPendingInventorySku(null)}
                  onCartInteraction={() => {
                    if (!collapsed) onToggleCollapse();
                  }}
                  onOpenWeddingParty={(id) => {
                    setActivePosTab("weddings");
                    onOpenWeddingParty?.(id);
                  }}
                  onSaleCompleted={() => setActivePosTab("register")}
                  onRegisterTransactionCommitted={onRegisterTransactionCommitted}
                  onExitPosMode={() => setActivePosTab("pos-dashboard")}
                />
              ) : null}
            </div>
          )}

          {activePosTab === "tasks" && isRegisterOpen && sessionId ? ( <RegisterTasksPanel /> ) : activePosTab === "tasks" ? (
            <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-40">Open register to view register tasks.</div>
          ) : null}

          {activePosTab === "customers" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Customers...</div>}>
                <CustomersWorkspace
                  activeSection={activeSubSection || "all"}
                  onNavigateSubSection={onSubSectionChange}
                  surface="pos"
                  onOpenWeddingParty={(id) => {
                    setActivePosTab("weddings");
                    onOpenWeddingParty?.(id);
                  }}
                  onStartSaleInPos={(customer) => {
                    clearPendingPosTransaction();
                    setPendingPosCustomer(customer);
                    setActivePosTab("register");
                  }}
                  onNavigateRegister={() => setActivePosTab("register")}
                  onAddToWedding={() => setActivePosTab("weddings")}
                  onBookAppointment={() => setActivePosTab("tasks")}
                  onOpenTransactionInBackoffice={(orderId) => {
                    setPendingPosTransactionId(orderId);
                    clearPendingPosCustomer();
                    setActivePosTab("register");
                  }}
                  messagingFocusCustomerId={posMessagingFocusCustomerId}
                  messagingFocusHubTab={posMessagingFocusHubTab ?? undefined}
                  onMessagingFocusConsumed={() => {
                    setPosMessagingFocusCustomerId(null);
                    setPosMessagingFocusHubTab(null);
                  }}
                />
              </Suspense>
            </div>
          )}

          {activePosTab === "rms-charge" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing RMS Charge...</div>}>
                <CustomersWorkspace
                  activeSection="rms-charge"
                  surface="pos"
                  onOpenWeddingParty={(id) => {
                    setActivePosTab("weddings");
                    onOpenWeddingParty?.(id);
                  }}
                  onStartSaleInPos={(customer) => {
                    clearPendingPosTransaction();
                    setPendingPosCustomer(customer);
                    setActivePosTab("register");
                  }}
                  onNavigateRegister={() => setActivePosTab("register")}
                  onAddToWedding={() => setActivePosTab("weddings")}
                  onBookAppointment={() => setActivePosTab("tasks")}
                  onOpenTransactionInBackoffice={(orderId) => {
                    setPendingPosTransactionId(orderId);
                    clearPendingPosCustomer();
                    setActivePosTab("register");
                  }}
                />
              </Suspense>
            </div>
          )}

          {activePosTab === "podium-inbox" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <PodiumMessagingInboxSection
                onOpenCustomerHub={(customer) => {
                  onSubSectionChange("all");
                  setPosMessagingFocusCustomerId(customer.id);
                  setPosMessagingFocusHubTab("messages");
                  setActivePosTab("customers");
                }}
              />
            </div>
          )}

	          {activePosTab === "inventory" && (
	            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
	              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Inventory...</div>}>
	                <ProcurementHub
	                  onAddItemToCart={(sku) => {
	                    setPendingInventorySku(sku);
	                    setActivePosTab("register");
	                  }}
	                />
	              </Suspense>
	            </div>
	          )}
          {activePosTab === "orders" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Order Hub...</div>}>
                <OrdersWorkspace
                  activeSection="open"
                  refreshSignal={refreshSignal}
                  onOpenInRegister={(orderId, forPickup) => {
                    setPendingPosTransactionId(orderId);
                    setPendingPosTransactionForPickup(forPickup || false);
                    clearPendingPosCustomer();
                    setActivePosTab("register");
                  }}
                />
              </Suspense>
            </div>
          )}
          {activePosTab === "alterations" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Alterations...</div>}>
                <AlterationsWorkspace />
              </Suspense>
            </div>
          )}
          {activePosTab === "weddings" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Wedding Hub...</div>}>
                <WeddingManagerApp
                  rosActorName={cashierName}
                  initialPartyId={pendingWmPartyId}
                  onInitialPartyConsumed={onClearPendingWmPartyId}
                />
              </Suspense>
            </div>
          )}
          {activePosTab === "reports" && <RegisterReports sessionId={sessionId} />}
          {activePosTab === "payments" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Payments...</div>}>
                <PaymentsWorkspace surface="pos" activeSection="transactions" />
              </Suspense>
            </div>
          )}
          {activePosTab === "gift-cards" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Gift Card Hub...</div>}>
                <GiftCardsWorkspace activeSection="inventory" />
              </Suspense>
            </div>
          )}
          {activePosTab === "loyalty" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Loyalty Hub...</div>}>
                <LoyaltyWorkspace activeSection="eligible" />
              </Suspense>
            </div>
          )}
          {activePosTab === "layaways" && ( <LayawayWorkspace registerSessionId={sessionId} onOpenTransaction={(orderId) => { setPendingPosTransactionId(orderId); setActivePosTab("register"); }} /> )}
          {activePosTab === "shipping" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Shipping...</div>}>
                <ShipmentsHubSection
                  onOpenTransactionInBackoffice={(orderId) => {
                    setPendingPosTransactionId(orderId);
                    clearPendingPosCustomer();
                    setActivePosTab("register");
                  }}
                />
              </Suspense>
            </div>
          )}
          {activePosTab === "settings" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Settings...</div>}>
                <SettingsWorkspace
                  mode="pos"
                  activeSection={activeSubSection}
                  posSessionId={sessionId}
                  posCashierCode={cashierCode}
                  posLifecycleStatus={lifecycleStatus}
                  onPosRefreshMeta={refreshOpenSessionMeta}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      {showCloseModal && sessionId && (registerLane === 1 || registerLane == null) && (
        <CloseRegisterModal sessionId={sessionId} cashierName={cashierName} registerLane={registerLane} registerOrdinal={registerOrdinal} onReconcilingBegun={onRegisterReconcilingBegun} onCloseComplete={handleSessionClosed} onCancel={() => { setShowCloseModal(false); void refreshOpenSessionMeta(); }} />
      )}

      {shiftHandoffOpen && sessionId ? (
        <RegisterShiftHandoffModal isOpen={shiftHandoffOpen} onClose={() => setShiftHandoffOpen(false)} sessionId={sessionId} onHandoffComplete={refreshOpenSessionMeta} onAdoptShiftCredentials={(code) => setStaffCredentials(code, code)} />
      ) : null}
    </div>
  );
}
