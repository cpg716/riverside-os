import { useCallback, lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTopBar } from "../../context/TopBarContextLogic";
import PosSidebar, { type PosTabId } from "../pos/PosSidebar";
import { PosWeddingWorkspace } from "../pos/PosWeddingWorkspace";
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
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { LogOut, ShieldCheck, ShieldAlert, ShoppingCart } from "lucide-react";


import { type SessionOpenedPayload } from "../pos/types";

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
  onOpenWeddingParty?: (partyId: string) => void;
  receiptTimezone: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSubSectionChange: (id: string) => void;
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
  onOpenWeddingParty,
  receiptTimezone,
  collapsed,
  onToggleCollapse,
  onSubSectionChange,
}: PosShellProps) {
  const [activePosTab, setActivePosTab] = useState<PosTabId>(() => {
    const search = new URLSearchParams(window.location.search);
    const t = search.get("tab");
    if (t === "dashboard" || t === "register" || t === "tasks" || t === "inventory" || t === "weddings" || t === "alterations" || t === "reports" || t === "gift-cards" || t === "loyalty" || t === "layaways" || t === "settings") {
      return t as PosTabId;
    }
    return "dashboard";
  });
  const [managerMode, setManagerMode] = useState(false);
  const [pendingInventorySku, setPendingInventorySku] = useState<string | null>(null);
  const { hasPermission, permissionsLoaded, setStaffCredentials } = useBackofficeAuth();
  const [shiftHandoffOpen, setShiftHandoffOpen] = useState(false);
  const lastLandingSessionRef = useRef<string | null>(null);

  const landingTabConsumedRef = useRef(false);
  useEffect(() => {
    if (!isRegisterOpen || !sessionId) { 
      lastLandingSessionRef.current = null; 
      landingTabConsumedRef.current = false;
      return; 
    }
    if (lastLandingSessionRef.current === sessionId) return;
    lastLandingSessionRef.current = sessionId;

    // If we landed with a specific URL tab, don't auto-reset to dashboard on the first run of this session
    if (!landingTabConsumedRef.current) {
      const search = new URLSearchParams(window.location.search);
      if (search.has("tab")) {
        landingTabConsumedRef.current = true;
        return;
      }
    }

    const pendingSku = pendingInventorySku?.trim() ?? "";
    const pending = pendingPosCustomer || pendingPosTransactionId || (pendingSku.length > 0 ? pendingSku : null) || pendingWeddingPosLink;
    if (pending) { 
      setActivePosTab("register"); 
    } else if (activePosTab === "register") {
      // If we are already in the register (cart), and no pending objects arrived to pull us there,
      // stay where we are instead of snapping to dashboard.
    } else { 
      setActivePosTab("dashboard"); 
    }
  }, [activePosTab, isRegisterOpen, sessionId, pendingPosCustomer, pendingPosTransactionId, pendingInventorySku, pendingWeddingPosLink]);

  useEffect(() => {
    if (activePosTab !== "alterations") return;
    if (permissionsLoaded && !hasPermission("alterations.manage")) {
      setActivePosTab(isRegisterOpen && sessionId ? "dashboard" : "register");
    }
  }, [activePosTab, permissionsLoaded, hasPermission, isRegisterOpen, sessionId]);

  useEffect(() => {
    onSubSectionChange(activePosTab);
  }, [activePosTab, onSubSectionChange]);

  const handleSessionOpenedWithAuth = useCallback(
    (p: SessionOpenedPayload) => {
      onSessionOpened(p);
    },
    [onSessionOpened],
  );

  const handleAddItemFromHub = (sku: string) => {
    const s = sku.trim();
    if (!s) return;
    setPendingInventorySku(s);
    setActivePosTab("register");
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
            <ShoppingCart size={12} className="text-app-accent" /> Register #{registerLane}
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
      />

      <div className="flex flex-1 flex-col">

        <div className="flex flex-1 flex-col workspace-snap" onClick={(e) => { if (e.target !== e.currentTarget) return; if (!collapsed) onToggleCollapse(); }}>
          {activePosTab === "dashboard" && (!isRegisterOpen || !sessionId ? (
              <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Matrix Inactive: Open till to initialize dashboard.</div>
            ) : (
              <RegisterDashboard registerOrdinal={registerOrdinal} cashierName={cashierName} onGoToRegister={() => setActivePosTab("register")} onGoToWeddings={() => setActivePosTab("weddings")} onOpenWeddingParty={onOpenWeddingParty} />
            ))}

          {activePosTab === "register" && (
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
                  initialWeddingPosLink={pendingWeddingPosLink}
                  onInitialWeddingPosLinkConsumed={clearPendingWeddingPosLink}
                  pendingInventorySku={pendingInventorySku}
                  onPendingInventorySkuConsumed={() => setPendingInventorySku(null)}
                  onSaleCompleted={() => setActivePosTab("register")}
                  onExitPosMode={onExitPosMode}
                  onCancelSignIn={() => setActivePosTab("dashboard")}
                />
              ) : null}
            </div>
          )}

          {activePosTab === "weddings" && (
            <PosWeddingWorkspace />
          )}

          {activePosTab === "tasks" && isRegisterOpen && sessionId ? ( <RegisterTasksPanel /> ) : activePosTab === "tasks" ? (
            <div className="flex flex-1 items-center justify-center bg-app-bg p-6 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Matrix Inactive: Open till to initialize task stream.</div>
          ) : null}

          {activePosTab === "inventory" && <ProcurementHub onAddItemToCart={handleAddItemFromHub} />}
          {activePosTab === "alterations" && (
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-black italic uppercase tracking-[0.3em] text-app-text-muted opacity-20">Synchronizing Alterations...</div>}>
                <AlterationsWorkspace />
              </Suspense>
            </div>
          )}
          {activePosTab === "reports" && <RegisterReports sessionId={sessionId} />}
          {activePosTab === "gift-cards" && ( <RegisterLookupHub initialTab="giftcard" registerSessionId={sessionId} /> )}
          {activePosTab === "loyalty" && ( <RegisterLookupHub initialTab="loyalty" registerSessionId={sessionId} /> )}
          {activePosTab === "layaways" && ( <LayawayWorkspace registerSessionId={sessionId} onOpenTransaction={(orderId) => { setPendingPosTransactionId(orderId); setActivePosTab("register"); }} /> )}
          {activePosTab === "settings" && ( <RegisterSettings sessionId={sessionId} cashierCode={cashierCode} lifecycleStatus={lifecycleStatus} onRefreshMeta={refreshOpenSessionMeta} /> )}
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
