import { lazy, Suspense, useEffect, useState } from "react";
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

const OrdersWorkspace = lazy(() => import("../orders/OrdersWorkspace"));
const InventoryWorkspace = lazy(() => import("../inventory/InventoryWorkspace"));
const GiftCardsWorkspace = lazy(() => import("../gift-cards/GiftCardsWorkspace"));

const AlterationsWorkspace = lazy(() => import("../alterations/AlterationsWorkspace"));
const WeddingManagerApp = lazy(() => import("../wedding-manager/WeddingManagerApp"));
import type { Customer } from "../pos/CustomerSelector";
import type { RosOpenRegisterFromWmDetail } from "../../lib/weddingPosBridge";
import type { SidebarTabId } from "./sidebarSections";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { LogOut, ShieldCheck, ShieldAlert } from "lucide-react";
import { getAppIcon, APP_ICON_SIZES } from "../../lib/icons";

const REGISTER_ICON = getAppIcon("register");


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
  onExitPosMode: () => void;
  isRegisterOpen: boolean;
  cashierName: string | null;
  cashierCode: string | null;
  registerOrdinal: number | null;
  registerLane: number | null;
  lifecycleStatus: string | null;
  sessionId: string | null;
  pendingPosCustomer: Customer | null;
  pendingPosTransactionId: string | null;
  setPendingPosTransactionId: (orderId: string | null) => void;
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
  onExitPosMode,
  isRegisterOpen,
  cashierName,
  cashierCode,
  registerOrdinal,
  registerLane,
  lifecycleStatus,
  sessionId,
  pendingPosCustomer,
  pendingPosTransactionId,
  setPendingPosTransactionId,
  setPendingPosCustomer,
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
    setSlotContent(
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => setManagerMode(!managerMode)}
          className={`h-10 px-4 rounded-xl border-2 flex items-center gap-2 text-[9px] font-black uppercase tracking-widest italic transition-all active:scale-95 ${
            managerMode
              ? "border-amber-400/40 bg-amber-400/10 text-amber-500 shadow-glow-amber-xs"
              : "border-app-border bg-app-surface-2 text-app-text-muted"
          }`}
        >
          {managerMode ? <ShieldCheck size={16} strokeWidth={3} /> : <ShieldAlert size={16} />}
          <span>{managerMode ? "Manager Access" : "Staff Access"}</span>
        </button>

        {managerMode &&
          isRegisterOpen &&
          sessionId &&
          permissionsLoaded &&
          hasPermission("register.shift_handoff") && (
            <button
              type="button"
              onClick={() => setShiftHandoffOpen(true)}
              className="h-10 px-4 rounded-xl border-2 border-app-border bg-app-surface-2 text-[9px] font-black uppercase tracking-widest italic text-app-text-muted hover:border-app-accent hover:text-app-text transition-all active:scale-95"
            >
              Handoff
            </button>
          )}

        {isRegisterOpen && registerLane != null && (
          <div className="px-4 h-8 flex items-center gap-2 rounded-full bg-app-surface-2 border border-app-border text-[9px] font-black uppercase tracking-widest text-app-text-muted italic shadow-inner">
            <REGISTER_ICON size={APP_ICON_SIZES.badge} className="text-app-accent" /> Register #{registerLane}
          </div>
        )}

        <button
          type="button"
          onClick={onExitPosMode}
          className="h-10 px-6 rounded-xl bg-app-accent border-b-4 border-black/20 text-[10px] font-black uppercase tracking-widest text-white shadow-lg hover:brightness-110 active:translate-y-0.5 active:border-b-0 transition-all flex items-center gap-2 italic"
        >
          <LogOut size={16} strokeWidth={3} /> Exit POS
        </button>
      </div>
    );
    return () => setSlotContent(null);
  }, [
    managerMode,
    isRegisterOpen,
    sessionId,
    permissionsLoaded,
    hasPermission,
    registerLane,
    onExitPosMode,
    setSlotContent,
  ]);

  return (
    <div className="flex flex-1 w-full bg-app-bg font-sans antialiased transition-colors duration-300">
      <PosSidebar
        activeTab={activePosTab}
        onTabChange={setActivePosTab}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        activeSubSection={activeSubSection}
        onSubSectionChange={onSubSectionChange}
      />

      <div className="flex flex-1 flex-col">

        <div className="flex flex-1 flex-col workspace-snap" onClick={(e) => { if (e.target !== e.currentTarget) return; if (!collapsed) onToggleCollapse(); }}>
          {activePosTab === "pos-dashboard" && (!isRegisterOpen || !sessionId ? (
              <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Matrix Inactive: Open till to initialize dashboard.</div>
            ) : (
              <RegisterDashboard 
                registerOrdinal={registerOrdinal} 
                cashierName={cashierName} 
                onGoToRegister={() => setActivePosTab("register")} 
                onGoToWeddings={() => setActivePosTab("weddings")} 
                onOpenWeddingParty={(partyId) => {
                  setActivePosTab("weddings");
                  onOpenWeddingParty?.(partyId);
                }} 
              />
            ))}

          {(activePosTab === "register") && (
            <div className="relative flex min-h-0 flex-1 flex-col">
              {!isRegisterOpen ? ( <RegisterOverlay onSessionOpened={handleSessionOpenedWithAuth} /> ) : sessionId ? (
                <Cart
                  sessionId={sessionId}
                  receiptTimezone={receiptTimezone}
                  cashierName={cashierName}
                  cashierCode={cashierCode}
                  initialCustomer={pendingPosCustomer}
                  onInitialCustomerConsumed={clearPendingPosCustomer}
                  initialOrderId={pendingPosTransactionId}
                  onInitialOrderConsumed={clearPendingPosOrder}
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
                  onExitPosMode={onExitPosMode}
                />
              ) : null}
            </div>
          )}

          {activePosTab === "tasks" && isRegisterOpen && sessionId ? ( <RegisterTasksPanel /> ) : activePosTab === "tasks" ? (
            <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Matrix Inactive: Open till to initialize task stream.</div>
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
                    clearPendingPosOrder();
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
                    clearPendingPosOrder();
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
                <InventoryWorkspace activeSection="list" surface="pos" />
              </Suspense>
            </div>
          )}
          {activePosTab === "orders" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Order Hub...</div>}>
                <OrdersWorkspace 
                  activeSection="open"
                  refreshSignal={refreshSignal}
                  onOpenInRegister={(orderId) => {
                    setPendingPosTransactionId(orderId);
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
