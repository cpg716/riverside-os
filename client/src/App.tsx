import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "./components/layout/Sidebar";
import { type SidebarTabId, SIDEBAR_SUB_SECTIONS } from "./components/layout/sidebarSections";
import Header, { type BreadcrumbSegment } from "./components/layout/Header";
import PosShell from "./components/layout/PosShell";
import WeddingShell from "./components/layout/WeddingShell";
import InsightsShell from "./components/layout/InsightsShell";
import GlobalSearchDrawerHost, {
  type GlobalSearchDrawerState,
} from "./components/layout/GlobalSearchDrawers";
const CommissionManagerWorkspace = lazy(() => import("./components/staff/CommissionManagerWorkspace"));
import CloseRegisterModal from "./components/pos/CloseRegisterModal";
import CustomersWorkspace from "./components/customers/CustomersWorkspace";
import OperationalHome from "./components/operations/OperationalHome";
import type { Customer } from "./components/pos/CustomerSelector";

const InventoryWorkspace = lazy(() => import("./components/inventory/InventoryWorkspace"));
const QboWorkspace = lazy(() => import("./components/qbo/QboWorkspace"));
const WeddingManagerApp = lazy(() => import("./components/wedding-manager/WeddingManagerApp"));
const OrdersWorkspace = lazy(() => import("./components/orders/OrdersWorkspace"));
const AlterationsWorkspace = lazy(() => import("./components/alterations/AlterationsWorkspace"));
const StaffWorkspace = lazy(() => import("./components/staff/StaffWorkspace"));
const GiftCardsWorkspace = lazy(() => import("./components/gift-cards/GiftCardsWorkspace"));
const LoyaltyWorkspace = lazy(() => import("./components/loyalty/LoyaltyWorkspace"));
const SettingsWorkspace = lazy(() => import("./components/settings/SettingsWorkspace"));
const SchedulerWorkspace = lazy(() => import("./components/scheduler/SchedulerWorkspace"));
const ReportsWorkspace = lazy(() => import("./components/reports/ReportsWorkspace"));
import {
  ROS_OPEN_REGISTER_FROM_WM,
  type RosOpenRegisterFromWmDetail,
} from "./lib/weddingPosBridge";
import { applyDocumentTheme, resolveThemeMode } from "./lib/rosDocumentTheme";
import { ShellBackdropProvider } from "./components/layout/ShellBackdropContext";
import { useShellBackdropDepth } from "./components/layout/ShellBackdropContextLogic";
import BackofficeSignInGate from "./components/layout/BackofficeSignInGate";
import RegisterSessionBootstrap from "./components/layout/RegisterSessionBootstrap";
import HelpCenterDrawer from "./components/help/HelpCenterDrawer";
import BugReportFlow from "./components/bug-report/BugReportFlow";
import {
  SIDEBAR_TAB_PERMISSION,
  subSectionVisible,
} from "./context/BackofficeAuthPermissions";
import { BackofficeAuthProvider } from "./context/BackofficeAuthContext";
import { useBackofficeAuth } from "./context/BackofficeAuthContextLogic";
import { RegisterGateProvider } from "./context/RegisterGateContext";
import { NotificationCenterProvider } from "./context/NotificationCenterContext";
import { type NotificationDeepLink } from "./context/NotificationCenterContextLogic";
import WeddingManagerAuthBridge from "./components/wedding-manager/WeddingManagerAuthBridge";
import { ShoppingCart, ArrowRight } from "lucide-react";
import { useToast } from "./components/ui/ToastProviderLogic";
import { readPersistedBackofficeSession } from "./lib/backofficeSessionPersistence";
import {
  clearPosRegisterAuth,
  hydratePosRegisterAuthIfNeeded,
  setPosRegisterAuth,
} from "./lib/posRegisterAuth";

type ThemeMode = "light" | "dark" | "system";

function App() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SidebarTabId>("home");
  const [posMode, setPosMode] = useState(false);
  const [weddingMode, setWeddingMode] = useState(false);
  const [insightsMode, setInsightsMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSubSection, setActiveSubSection] = useState<string>(() => SIDEBAR_SUB_SECTIONS["home"][0].id);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [cashierName, setCashierName] = useState<string | null>(null);
  const [cashierAvatarKey, setCashierAvatarKey] = useState<string | null>(null);
  const [cashierCode, setCashierCode] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [registerLane, setRegisterLane] = useState<number | null>(null);
  const [registerOrdinal, setRegisterOrdinal] = useState<number | null>(null);
  const [lifecycleStatus, setLifecycleStatus] = useState<string | null>(null);
  const [receiptTimezone, setReceiptTimezone] = useState("America/New_York");
  const [loading, setLoading] = useState(true);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [pendingPosCustomer, setPendingPosCustomer] = useState<Customer | null>(null);
  const [pendingPosOrderId, setPendingPosOrderId] = useState<string | null>(null);
  const [ordersDeepLinkOrderId, setOrdersDeepLinkOrderId] = useState<string | null>(null);
  const [pendingWeddingPosLink, setPendingWeddingPosLink] = useState<RosOpenRegisterFromWmDetail | null>(null);
  const [pendingWmPartyId, setPendingWmPartyId] = useState<string | null>(null);
  const [alterationsDeepLinkId, setAlterationsDeepLinkId] = useState<string | null>(null);
  const [procurementDeepLinkPoId, setProcurementDeepLinkPoId] = useState<string | null>(null);
  const [inventoryProductHubProductId, setInventoryProductHubProductId] = useState<
    string | null
  >(null);
  const [qboDeepLinkSyncLogId, setQboDeepLinkSyncLogId] = useState<string | null>(null);
  const [staffTasksFocusInstanceId, setStaffTasksFocusInstanceId] = useState<
    string | null
  >(null);
  const [customersMessagingFocusCustomerId, setCustomersMessagingFocusCustomerId] =
    useState<string | null>(null);
  const [customersMessagingFocusHubTab, setCustomersMessagingFocusHubTab] = useState<
    string | null
  >(null);
  const [globalSearchDrawer, setGlobalSearchDrawer] = useState<GlobalSearchDrawerState | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem("ros.theme.mode");
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
    return "light";
  });
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [registerReportsDeepLinkOrderId, setRegisterReportsDeepLinkOrderId] = useState<string | null>(null);
  const [helpDrawerOpen, setHelpDrawerOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);

  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const registerMetaRefreshRef = useRef<(() => Promise<void>) | null>(null);

  const onRegisterReconcilingBegun = useCallback(() => {
    setLifecycleStatus("reconciling");
  }, []);

  const refreshOpenSessionMeta = useCallback(async () => {
    await registerMetaRefreshRef.current?.();
  }, []);

  const goToOpenRegister = useCallback(() => {
    setPosMode(true);
    setActiveTab("register");
  }, []);

  useEffect(() => {
    if (window.innerWidth < 1024) setSidebarCollapsed(true);
  }, []);

  useEffect(() => {
    const subs = SIDEBAR_SUB_SECTIONS[activeTab];
    if (subs.length > 0) {
      setActiveSubSection(subs[0].id);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!ordersDeepLinkOrderId) return;
    if (activeTab !== "orders") return;
    setActiveSubSection("all");
  }, [ordersDeepLinkOrderId, activeTab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wp = params.get("wedding_party");
    if (wp) {
      setActiveTab("weddings");
      setWeddingMode(true);
      setPosMode(false);
      setInsightsMode(false);
      setPendingWmPartyId(wp);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  /** Deep link for staff manuals / MCP capture: open POS shell after session bootstrap. */
  useEffect(() => {
    if (loading) return;
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/pos") {
      setPosMode(true);
      setInsightsMode(false);
      setActiveTab("register");
    }
  }, [loading]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = resolveThemeMode(themeMode);
      applyDocumentTheme(resolved);
    };
    window.localStorage.setItem("ros.theme.mode", themeMode);
    applyTheme();
    mq.addEventListener("change", applyTheme);
    return () => mq.removeEventListener("change", applyTheme);
  }, [themeMode]);

  const handleSessionOpened = (p: {
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
  }) => {
    setCashierName(p.cashierName);
    setCashierCode(p.cashierCode);
    setCashierAvatarKey(p.cashierAvatarKey?.trim() || "ros_default");
    setSessionId(p.sessionId);
    setRegisterLane(p.registerLane);
    setRegisterOrdinal(p.registerOrdinal);
    setLifecycleStatus(p.lifecycleStatus);
    setReceiptTimezone(
      typeof p.receiptTimezone === "string" && p.receiptTimezone.trim()
        ? p.receiptTimezone.trim()
        : "America/New_York",
    );
    setIsRegisterOpen(true);
    if (p.posApiToken) {
      setPosRegisterAuth({ sessionId: p.sessionId, token: p.posApiToken });
    } else {
      const bo = readPersistedBackofficeSession();
      const authHeaders: Record<string, string> = {};
      if (bo?.staffCode.trim()) {
        authHeaders["x-riverside-staff-code"] = bo.staffCode.trim();
      }
      if (bo?.staffPin.trim()) {
        authHeaders["x-riverside-staff-pin"] = bo.staffPin.trim();
      }
      const openerPin =
        bo?.staffCode.trim() === p.cashierCode.trim() && bo.staffPin.trim()
          ? bo.staffPin
          : p.cashierCode;
      void hydratePosRegisterAuthIfNeeded({
        baseUrl,
        sessionId: p.sessionId,
        authHeaders,
        openerCashierCode: p.cashierCode,
        openerPin,
      });
    }

    if (p.role === "admin") {
      setActiveTab("home");
      setPosMode(false);
    } else {
      setActiveTab("register");
      setPosMode(true);
    }
  };

  const handleSessionClosed = () => {
    setShowCloseModal(false);
    setIsRegisterOpen(false);
    setSessionId(null);
    setCashierName(null);
    setCashierAvatarKey(null);
    setRegisterLane(null);
    setRegisterOrdinal(null);
    setLifecycleStatus(null);
    setReceiptTimezone("America/New_York");
    clearPosRegisterAuth();
  };

  const clearPendingPosCustomer = useCallback(() => setPendingPosCustomer(null), []);
  const clearPendingPosOrder = useCallback(() => setPendingPosOrderId(null), []);
  const clearPendingWeddingPosLink = useCallback(() => setPendingWeddingPosLink(null), []);

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<RosOpenRegisterFromWmDetail>;
      const d = ce.detail;
      if (!d?.member?.customer_id) return;
      setPendingWeddingPosLink(d);
      setActiveTab("register");
      setWeddingMode(false);
      setPosMode(true);
    };
    window.addEventListener(ROS_OPEN_REGISTER_FROM_WM, handler as EventListener);
    return () => window.removeEventListener(ROS_OPEN_REGISTER_FROM_WM, handler as EventListener);
  }, []);

  const navigateRegister = useCallback(() => {
    setActiveTab("register");
    setWeddingMode(false);
    setInsightsMode(false);
    setPosMode(true);
  }, []);

  const navigateWedding = useCallback((partyId?: string | null) => {
    setPosMode(false);
    setActiveTab("weddings");
    setWeddingMode(true);
    setInsightsMode(false);
    setPendingWmPartyId(partyId ?? null);
  }, []);

  const clearPendingWmPartyId = useCallback(() => {
    setPendingWmPartyId(null);
  }, []);

  const handleStaffTasksFocusConsumed = useCallback(() => {
    setStaffTasksFocusInstanceId(null);
  }, []);

  const openCustomerHubFromInbox = useCallback((c: Customer) => {
    setActiveTab("customers");
    setActiveSubSection("all");
    setCustomersMessagingFocusCustomerId(c.id);
    setCustomersMessagingFocusHubTab("messages");
  }, []);

  const handleNotificationNavigate = useCallback((link: NotificationDeepLink) => {
    const t = link.type;
    setInsightsMode(false);
    if (t === "staff_tasks" && link.instance_id?.trim()) {
      setStaffTasksFocusInstanceId(link.instance_id.trim());
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("staff");
      setActiveSubSection("tasks");
      return;
    }
    if (t === "order" && link.order_id) {
      setOrdersDeepLinkOrderId(link.order_id);
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("orders");
      return;
    }
    if (t === "wedding_party" && link.party_id) {
      navigateWedding(link.party_id);
      return;
    }
    if (t === "alteration" && link.alteration_id) {
      setAlterationsDeepLinkId(link.alteration_id);
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("alterations");
      return;
    }
    if (t === "purchase_order" && link.po_id) {
      setProcurementDeepLinkPoId(link.po_id);
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("inventory");
      setActiveSubSection("receiving");
      return;
    }
    if (t === "qbo_staging" && link.sync_log_id) {
      setQboDeepLinkSyncLogId(link.sync_log_id);
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("qbo");
      setActiveSubSection("staging");
      return;
    }
    if (t === "orders") {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("orders");
      const sub = link.subsection?.trim();
      setActiveSubSection(sub === "all" ? "all" : "open");
      return;
    }
    if (t === "settings" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("settings");
      const sec = link.section.trim();
      const allowed = new Set([
        "profile",
        "general",
        "backups",
        "printing",
        "integrations",
        "counterpoint",
        "online-store",
        "help-center",
        "bug-reports",
        "meilisearch",
      ]);
      setActiveSubSection(allowed.has(sec) ? sec : "general");
      return;
    }
    if (t === "inventory" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("inventory");
      const sec = link.section.trim();
      const allowed = new Set([
        "list",
        "add",
        "receiving",
        "categories",
        "discount_events",
        "import",
        "vendors",
        "physical",
      ]);
      setActiveSubSection(allowed.has(sec) ? sec : "list");
      const pid = link.product_id?.trim();
      if (pid) {
        setInventoryProductHubProductId(pid);
      }
      return;
    }
    if (t === "dashboard" && link.subsection) {
      setPosMode(false);
      setWeddingMode(false);
      const sub = link.subsection.trim();
      if (sub === "payouts") {
        setInsightsMode(false);
        setActiveTab("staff");
        setActiveSubSection("commission-payouts");
        return;
      }
      setActiveTab("dashboard");
      setInsightsMode(true);
      return;
    }
    if (t === "register") {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("register");
      return;
    }
    if (t === "home" && link.subsection) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("home");
      const sub = link.subsection.trim();
      const allowedHome = new Set(["dashboard", "inbox", "reviews", "daily-sales"]);
      // Legacy deep links used "activity"; content now lives on Dashboard.
      const normalizedSub = sub === "activity" ? "dashboard" : sub;
      setActiveSubSection(allowedHome.has(normalizedSub) ? normalizedSub : "dashboard");
      return;
    }
    if (t === "customers" && link.subsection) {
      setPosMode(false);
      setWeddingMode(false);
      const subRaw = link.subsection.trim();
      if (subRaw === "messaging") {
        const cid = link.customer_id?.trim();
        if (cid) {
          setActiveTab("customers");
          setActiveSubSection("all");
          setCustomersMessagingFocusCustomerId(cid);
          setCustomersMessagingFocusHubTab(link.hub_tab?.trim() ?? "messages");
        } else {
          setActiveTab("home");
          setActiveSubSection("inbox");
        }
        return;
      }
      setActiveTab("customers");
      const allowedCustomers = new Set([
        "all",
        "add",
        "ship",
        "rms-charge",
        "duplicate-review",
      ]);
      setActiveSubSection(allowedCustomers.has(subRaw) ? subRaw : "all");
      const cid = link.customer_id?.trim();
      if (cid) {
        setCustomersMessagingFocusCustomerId(cid);
        setCustomersMessagingFocusHubTab(link.hub_tab?.trim() ?? null);
      }
      return;
    }
    if (t === "appointments" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("appointments");
      const sec = link.section.trim();
      setActiveSubSection(sec === "conflicts" ? "conflicts" : "scheduler");
      return;
    }
    if (t === "qbo" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("qbo");
      const sec = link.section.trim();
      const allowedQ = new Set(["connection", "staging", "history"]);
      setActiveSubSection(allowedQ.has(sec) ? sec : "staging");
      return;
    }
    if (t === "staff" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      const sec = link.section.trim();
      const toSettingsAccess = new Set(["roles", "discounts", "access", "pins"]);
      if (toSettingsAccess.has(sec)) {
        setActiveTab("settings");
        setActiveSubSection("staff-access-defaults");
        return;
      }
      setActiveTab("staff");
      const allowedS = new Set([
        "team",
        "tasks",
        "schedule",
        "commission",
        "commission-payouts",
        "audit",
      ]);
      setActiveSubSection(allowedS.has(sec) ? sec : "team");
      return;
    }
    if (t === "gift-cards" && link.section) {
      setPosMode(false);
      setWeddingMode(false);
      setActiveTab("gift-cards");
      const sec = link.section.trim();
      const allowedG = new Set(["inventory", "issue-purchased", "issue-donated"]);
      setActiveSubSection(allowedG.has(sec) ? sec : "inventory");
      return;
    }
  }, [navigateWedding]);

  const navigateDashboard = useCallback(() => {
    setPosMode(false);
    setWeddingMode(false);
    setInsightsMode(false);
    setActiveTab("home");
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/pos") {
      window.history.replaceState({}, "", "/");
    }
  }, []);

  const triggerDashboardRefresh = useCallback(() => {
    setRefreshSignal(s => s + 1);
  }, []);

  const breadcrumbSegments: BreadcrumbSegment[] = useMemo(() => {
    const subLabel = SIDEBAR_SUB_SECTIONS[activeTab].find(s => s.id === activeSubSection)?.label;
    if (activeTab === "home") return [{ label: "Operations" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "register") return [{ label: "POS" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "weddings") return [{ label: "Weddings" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "customers") return [{ label: "Customers" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "alterations")
      return [{ label: "Alterations" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "orders") return [{ label: "Orders" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "inventory") return [{ label: "Inventory" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "settings") return [{ label: "Settings" }];
    if (activeTab === "reports") return [{ label: "Reports" }];
    if (activeTab === "dashboard") return [{ label: "Insights" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "staff") return [{ label: "Staff" }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "qbo") return [{ label: "QBO Bridge" }, ...(subLabel ? [{ label: subLabel }] : [])];
    return [{ label: activeTab }];
  }, [activeTab, activeSubSection]);

  return (
    <BackofficeAuthProvider initialCode={cashierCode}>
    <RegisterGateProvider goToOpenRegister={goToOpenRegister}>
    <RegisterSessionBootstrap
      baseUrl={baseUrl}
      toast={toast}
      setLoading={setLoading}
      setCashierName={setCashierName}
      setCashierCode={setCashierCode}
      setCashierAvatarKey={setCashierAvatarKey}
      setSessionId={setSessionId}
      setRegisterLane={setRegisterLane}
      setRegisterOrdinal={setRegisterOrdinal}
      setLifecycleStatus={setLifecycleStatus}
      setReceiptTimezone={setReceiptTimezone}
      setIsRegisterOpen={setIsRegisterOpen}
      setActiveTab={setActiveTab}
      setPosMode={setPosMode}
      metaRefreshRef={registerMetaRefreshRef}
    />
    {loading ? (
      <div className="flex h-screen items-center justify-center bg-app-bg font-sans text-app-text-muted antialiased">Loading Riverside POS…</div>
    ) : (
    <NotificationCenterProvider onNavigate={handleNotificationNavigate}>
    <WeddingManagerAuthBridge />
    <InsightsAccessSync
      insightsMode={insightsMode}
      setInsightsMode={setInsightsMode}
      setActiveTab={setActiveTab}
    />
    {posMode ? (
    <PosShell
      activeTab={activeTab}
      onTabChange={(tab) => {
        const posTabs: SidebarTabId[] = [
          "register",
          "customers",
          "orders",
          "alterations",
        ];
        if (!posTabs.includes(tab)) {
          setPosMode(false);
          triggerDashboardRefresh();
        }
        setActiveTab(tab);
      }}
      onExitPosMode={() => { 
        navigateDashboard();
        setSidebarCollapsed(false); 
        triggerDashboardRefresh();
      }}
      isRegisterOpen={isRegisterOpen}
      cashierName={cashierName}
      cashierAvatarKey={cashierAvatarKey}
      cashierCode={cashierCode}
      registerOrdinal={registerOrdinal}
      registerLane={registerLane}
      lifecycleStatus={lifecycleStatus}
      sessionId={sessionId}
      receiptTimezone={receiptTimezone}
      pendingPosCustomer={pendingPosCustomer}
      pendingPosOrderId={pendingPosOrderId}
      setPendingPosOrderId={setPendingPosOrderId}
      setPendingPosCustomer={setPendingPosCustomer}
      clearPendingPosCustomer={clearPendingPosCustomer}
      clearPendingPosOrder={clearPendingPosOrder}
      pendingWeddingPosLink={pendingWeddingPosLink}
      clearPendingWeddingPosLink={clearPendingWeddingPosLink}
      onSessionOpened={handleSessionOpened}
      showCloseModal={showCloseModal}
      setShowCloseModal={setShowCloseModal}
      handleSessionClosed={handleSessionClosed}
      refreshOpenSessionMeta={refreshOpenSessionMeta}
      onRegisterReconcilingBegun={onRegisterReconcilingBegun}
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
      onOpenHelp={() => setHelpDrawerOpen(true)}
      onOpenBugReport={() => setBugReportOpen(true)}
      onOpenWeddingParty={(partyId) => navigateWedding(partyId)}
    />
    ) : insightsMode ? (
    <InsightsShell
      actorLabel={cashierName}
      onExitInsightsMode={() => {
        setInsightsMode(false);
        setSidebarCollapsed(false);
        setActiveTab("home");
        triggerDashboardRefresh();
      }}
    />
    ) : weddingMode ? (
    <WeddingShell
      actorLabel={cashierName}
      initialPartyId={pendingWmPartyId}
      onInitialPartyConsumed={clearPendingWmPartyId}
      onExitWeddingMode={() => { 
        setWeddingMode(false); 
        setSidebarCollapsed(false); 
        setActiveTab("home"); 
        setPendingWmPartyId(null);
        triggerDashboardRefresh();
      }}
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
    />
    ) : (
    <BackofficeSignInGate>
    <div className="ui-shell-root font-sans antialiased">
      <div className="ui-shell-board">
        <Sidebar
          activeTab={activeTab}
          onTabChange={(tab) => {
            if (tab === "register") {
              setPosMode(true);
            }
            if (tab === "weddings") {
              setPosMode(false);
              setWeddingMode(true);
            } else {
              setWeddingMode(false);
            }
            if (tab === "dashboard") {
              setInsightsMode(true);
              setPosMode(false);
            } else {
              setInsightsMode(false);
            }
            setActiveTab(tab);
            if (window.innerWidth < 1024) setSidebarCollapsed(true);
          }}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(c => !c)}
          activeSubSection={activeSubSection}
          onSubSectionChange={(section) => {
            if (window.innerWidth < 1024) setSidebarCollapsed(true);
            setActiveSubSection(section);
          }}
          cashierName={cashierName}
          cashierAvatarKey={cashierAvatarKey}
          isRegisterOpen={isRegisterOpen}
        />
        {!sidebarCollapsed && <div className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden transition-opacity" onClick={() => setSidebarCollapsed(true)} />}
        <ShellBackdropProvider>
          <AppMainColumn
            onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            activeSubSection={activeSubSection}
            setActiveSubSection={setActiveSubSection}
            onWorkspaceClick={() => { if (!sidebarCollapsed) setSidebarCollapsed(true); }}
            breadcrumbSegments={breadcrumbSegments}
            cashierName={cashierName}
            registerOrdinal={registerOrdinal}
            registerLane={registerLane}
            setShowCloseModal={setShowCloseModal}
            navigateRegister={navigateRegister}
            navigateWedding={navigateWedding}
            pendingWmPartyId={pendingWmPartyId}
            onClearPendingWmPartyId={clearPendingWmPartyId}
            setPendingPosCustomer={setPendingPosCustomer}
            setPendingPosOrderId={setPendingPosOrderId}
            ordersDeepLinkOrderId={ordersDeepLinkOrderId}
            onOrdersDeepLinkConsumed={() => setOrdersDeepLinkOrderId(null)}
            onOpenOrderInBackoffice={(orderId) => {
              setOrdersDeepLinkOrderId(orderId);
              setActiveTab("orders");
            }}
            setGlobalSearchDrawer={setGlobalSearchDrawer}
            globalSearchDrawer={globalSearchDrawer}
            sessionId={sessionId}
            onRegisterReconcilingBegun={onRegisterReconcilingBegun}
            handleSessionClosed={handleSessionClosed}
            showCloseModal={showCloseModal}
            refreshOpenSessionMeta={refreshOpenSessionMeta}
            themeMode={themeMode}
            setThemeMode={setThemeMode}
            setPosMode={setPosMode}
            setInsightsMode={setInsightsMode}
            isRegisterOpen={isRegisterOpen}
            refreshSignal={refreshSignal}
            alterationsDeepLinkId={alterationsDeepLinkId}
            onAlterationsDeepLinkConsumed={() => setAlterationsDeepLinkId(null)}
            procurementDeepLinkPoId={procurementDeepLinkPoId}
            onProcurementDeepLinkConsumed={() => setProcurementDeepLinkPoId(null)}
            inventoryProductHubProductId={inventoryProductHubProductId}
            onInventoryProductHubConsumed={() => setInventoryProductHubProductId(null)}
            qboDeepLinkSyncLogId={qboDeepLinkSyncLogId}
            onQboDeepLinkConsumed={() => setQboDeepLinkSyncLogId(null)}
            staffTasksFocusInstanceId={staffTasksFocusInstanceId}
            onStaffTasksFocusConsumed={handleStaffTasksFocusConsumed}
            onOpenHelp={() => setHelpDrawerOpen(true)}
            onOpenBugReport={() => setBugReportOpen(true)}
            customersMessagingFocusCustomerId={customersMessagingFocusCustomerId}
            customersMessagingFocusHubTab={customersMessagingFocusHubTab}
            onCustomersMessagingFocusConsumed={() => {
              setCustomersMessagingFocusCustomerId(null);
              setCustomersMessagingFocusHubTab(null);
            }}
            onOpenCustomerHubFromInbox={openCustomerHubFromInbox}
            onOpenMetabaseExplore={() => {
              setInsightsMode(true);
              setActiveTab("dashboard");
            }}
            onNavigateRegisterReports={(transactionId) => {
              if (transactionId) setRegisterReportsDeepLinkOrderId(transactionId);
              setActiveTab("home");
              setActiveSubSection("daily-sales");
            }}
            onNavigateCommissionPayouts={() => {
              setActiveTab("staff");
              setActiveSubSection("commission-payouts");
            }}
            registerReportsDeepLinkOrderId={registerReportsDeepLinkOrderId}
            setRegisterReportsDeepLinkOrderId={setRegisterReportsDeepLinkOrderId}
          />
        </ShellBackdropProvider>
      </div>
    </div>
    </BackofficeSignInGate>
    )}
    <HelpCenterDrawer isOpen={helpDrawerOpen} onClose={() => setHelpDrawerOpen(false)} />
    <BugReportFlow
      isOpen={bugReportOpen}
      onClose={() => setBugReportOpen(false)}
      navigationContext={{
        active_tab: activeTab,
        active_sub_section: activeSubSection,
        pos_mode: posMode,
        wedding_mode: weddingMode,
        insights_mode: insightsMode,
        register_session_id: sessionId,
      }}
    />
    </NotificationCenterProvider>
    )}
    </RegisterGateProvider>
    </BackofficeAuthProvider>
  );
}

function InsightsAccessSync({
  insightsMode,
  setInsightsMode,
  setActiveTab,
}: {
  insightsMode: boolean;
  setInsightsMode: (v: boolean) => void;
  setActiveTab: (t: SidebarTabId) => void;
}) {
  const { hasPermission, permissionsLoaded } = useBackofficeAuth();
  useEffect(() => {
    if (!permissionsLoaded) return;
    if (insightsMode && !hasPermission("insights.view")) {
      setInsightsMode(false);
      setActiveTab("home");
    }
  }, [insightsMode, permissionsLoaded, hasPermission, setInsightsMode, setActiveTab]);
  return null;
}

type AppMainColumnProps = {
  activeTab: SidebarTabId;
  setActiveTab: (t: SidebarTabId) => void;
  activeSubSection: string;
  setActiveSubSection: (id: string) => void;
  onWorkspaceClick: () => void;
  breadcrumbSegments: BreadcrumbSegment[];
  cashierName: string | null;
  registerLane: number | null;
  registerOrdinal: number | null;
  setShowCloseModal: (v: boolean) => void;
  navigateRegister: () => void;
  navigateWedding: (partyId?: string | null) => void;
  pendingWmPartyId: string | null;
  onClearPendingWmPartyId: () => void;
  setPendingPosCustomer: (c: Customer | null) => void;
  setPendingPosOrderId: (orderId: string | null) => void;
  ordersDeepLinkOrderId: string | null;
  onOrdersDeepLinkConsumed: () => void;
  onOpenOrderInBackoffice: (orderId: string) => void;
  setGlobalSearchDrawer: (s: GlobalSearchDrawerState | null) => void;
  globalSearchDrawer: GlobalSearchDrawerState | null;
  sessionId: string | null;
  showCloseModal: boolean;
  handleSessionClosed: () => void;
  refreshOpenSessionMeta: () => Promise<void>;
  onRegisterReconcilingBegun: () => void;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  onToggleSidebar: () => void;
  setPosMode: (v: boolean) => void;
  setInsightsMode: (v: boolean) => void;
  isRegisterOpen: boolean;
  refreshSignal: number;
  alterationsDeepLinkId: string | null;
  onAlterationsDeepLinkConsumed: () => void;
  procurementDeepLinkPoId: string | null;
  onProcurementDeepLinkConsumed: () => void;
  inventoryProductHubProductId: string | null;
  onInventoryProductHubConsumed: () => void;
  qboDeepLinkSyncLogId: string | null;
  onQboDeepLinkConsumed: () => void;
  staffTasksFocusInstanceId: string | null;
  onStaffTasksFocusConsumed: () => void;
  onOpenHelp: () => void;
  onOpenBugReport: () => void;
  customersMessagingFocusCustomerId: string | null;
  customersMessagingFocusHubTab: string | null;
  onCustomersMessagingFocusConsumed: () => void;
  onOpenCustomerHubFromInbox: (customer: Customer) => void;
  onOpenMetabaseExplore: () => void;
  onNavigateRegisterReports: (transactionId?: string) => void;
  onNavigateCommissionPayouts: () => void;
  registerReportsDeepLinkOrderId: string | null;
  setRegisterReportsDeepLinkOrderId: (id: string | null) => void;
};

function AppMainColumn({
  activeTab,
  setActiveTab,
  activeSubSection,
  setActiveSubSection,
  onWorkspaceClick,
  breadcrumbSegments,
  cashierName,
  registerLane,
  registerOrdinal,
  setShowCloseModal,
  navigateRegister,
  navigateWedding,
  pendingWmPartyId,
  onClearPendingWmPartyId,
  setPendingPosCustomer,
  setPendingPosOrderId,
  ordersDeepLinkOrderId,
  onOrdersDeepLinkConsumed,
  onOpenOrderInBackoffice,
  setGlobalSearchDrawer,
  globalSearchDrawer,
  sessionId,
  showCloseModal,
  handleSessionClosed,
  refreshOpenSessionMeta,
  onRegisterReconcilingBegun,
  themeMode,
  setThemeMode,
  onToggleSidebar,
  setPosMode,
  setInsightsMode,
  isRegisterOpen,
  refreshSignal,
  alterationsDeepLinkId,
  onAlterationsDeepLinkConsumed,
  procurementDeepLinkPoId,
  onProcurementDeepLinkConsumed,
  inventoryProductHubProductId,
  onInventoryProductHubConsumed,
  qboDeepLinkSyncLogId,
  onQboDeepLinkConsumed,
  staffTasksFocusInstanceId,
  onStaffTasksFocusConsumed,
  onOpenHelp,
  onOpenBugReport,
  customersMessagingFocusCustomerId,
  customersMessagingFocusHubTab,
  onCustomersMessagingFocusConsumed,
  onOpenCustomerHubFromInbox,
  onOpenMetabaseExplore,
  onNavigateRegisterReports,
  onNavigateCommissionPayouts,
  registerReportsDeepLinkOrderId,
  setRegisterReportsDeepLinkOrderId,
}: AppMainColumnProps) {
  const { hasPermission, permissionsLoaded } = useBackofficeAuth();
  const shellDepth = useShellBackdropDepth();
  const canvasRecessed = shellDepth > 0;

  useEffect(() => {
    if (!permissionsLoaded) return;
    const req = SIDEBAR_TAB_PERMISSION[activeTab];
    if (req && !hasPermission(req)) {
      if (activeTab === "dashboard") setInsightsMode(false);
      setActiveTab("home");
    }
  }, [activeTab, hasPermission, permissionsLoaded, setActiveTab, setInsightsMode]);

  useEffect(() => {
    if (!permissionsLoaded) return;
    const subs = SIDEBAR_SUB_SECTIONS[activeTab];
    if (!subs?.length) return;
    if (subSectionVisible(activeTab, activeSubSection, hasPermission, permissionsLoaded)) {
      return;
    }
    const first =
      subs.find((s) => subSectionVisible(activeTab, s.id, hasPermission, permissionsLoaded)) ??
      subs[0];
    if (first && first.id !== activeSubSection) {
      setActiveSubSection(first.id);
    }
  }, [
    activeTab,
    activeSubSection,
    hasPermission,
    permissionsLoaded,
    setActiveSubSection,
  ]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "i" || e.key === "I") { e.preventDefault(); setActiveTab("inventory"); }
      else if (e.key === "c" || e.key === "C") { e.preventDefault(); setActiveTab("customers"); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setActiveTab]);

  return (
    <div
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${activeTab === "register" || activeTab === "customers" || activeTab === "alterations" || activeTab === "orders" ? "density-compact" : "density-standard"}`}
      onClick={onWorkspaceClick}
    >
  <Header segments={breadcrumbSegments} onNavigateRegister={navigateRegister} onSelectCustomerForPos={(c) => setPendingPosCustomer(c)} onSearchOpenCustomerDrawer={(c) => setGlobalSearchDrawer({ kind: "customer", customer: c })} onSearchOpenProductDrawer={(sku, hintName) => setGlobalSearchDrawer({ kind: "product", sku, hintName })} onSearchOpenWeddingPartyCustomers={(partyQuery) => setGlobalSearchDrawer({ kind: "wedding-party-customers", partyQuery })} onToggleSidebar={onToggleSidebar} isRegisterOpen={isRegisterOpen} onOpenHelp={onOpenHelp} onOpenBugReport={onOpenBugReport} />
      <GlobalSearchDrawerHost state={globalSearchDrawer} onClose={() => setGlobalSearchDrawer(null)} onOpenWeddingParty={(id: string) => { navigateWedding(id); }} onUseCustomerInRegister={(c) => setPendingPosCustomer(c)} onNavigateRegister={navigateRegister} onAddCustomerToWedding={() => { navigateWedding(); }} onBookCustomerAppointment={() => setActiveTab("appointments")} onOpenOrderInBackoffice={onOpenOrderInBackoffice} />
      <div className="relative flex min-h-0 flex-1 flex-col p-4">
        <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface transition-all duration-300 ease-standard ${canvasRecessed ? "origin-top shadow-[0_16px_40px_-24px_rgba(20,20,20,0.28)]" : "shadow-[0_10px_28px_-22px_rgba(20,20,20,0.2)]"}`}>
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm font-semibold text-app-text-muted">
                Loading workspace…
              </div>
            }
          >
          <div key={activeTab} className="workspace-snap flex min-h-0 flex-1 flex-col overflow-hidden">
            {(() => {
              if (activeTab === "home")
                return (
                  <OperationalHome
                    refreshSignal={refreshSignal}
                    activeSection={activeSubSection}
                    onOpenWeddingParty={(id) => {
                      navigateWedding(id);
                    }}
                    onOpenOrderInBackoffice={onOpenOrderInBackoffice}
                    onOpenInboxCustomer={onOpenCustomerHubFromInbox}
                    registerReportsDeepLinkOrderId={registerReportsDeepLinkOrderId}
                    onRegisterReportsDeepLinkConsumed={() => setRegisterReportsDeepLinkOrderId(null)}
                  />
                );
              if (activeTab === "inventory")
                return (
                  <InventoryWorkspace
                    activeSection={activeSubSection}
                    procurementDeepLinkPoId={procurementDeepLinkPoId}
                    onProcurementDeepLinkConsumed={onProcurementDeepLinkConsumed}
                    openProductHubProductId={inventoryProductHubProductId}
                    onProductHubDeepLinkConsumed={onInventoryProductHubConsumed}
                  />
                );
              if (activeTab === "orders") return <OrdersWorkspace activeSection={activeSubSection} deepLinkOrderId={ordersDeepLinkOrderId} onDeepLinkOrderConsumed={onOrdersDeepLinkConsumed} onOpenInRegister={(orderId) => { setPendingPosOrderId(orderId); navigateRegister(); }} />;
              if (activeTab === "customers")
                return (
                  <CustomersWorkspace
                    activeSection={activeSubSection}
                    onNavigateSubSection={setActiveSubSection}
                    onOpenWeddingParty={(id) => {
                      navigateWedding(id);
                    }}
                    onStartSaleInPos={(c) => setPendingPosCustomer(c)}
                    onNavigateRegister={navigateRegister}
                    onAddToWedding={() => {
                      navigateWedding();
                    }}
                    onBookAppointment={() => setActiveTab("appointments")}
                    onOpenOrderInBackoffice={onOpenOrderInBackoffice}
                    messagingFocusCustomerId={customersMessagingFocusCustomerId}
                    messagingFocusHubTab={customersMessagingFocusHubTab ?? undefined}
                    onMessagingFocusConsumed={onCustomersMessagingFocusConsumed}
                  />
                );
              if (activeTab === "alterations")
                return (
                  <AlterationsWorkspace
                    highlightAlterationId={alterationsDeepLinkId}
                    onHighlightConsumed={onAlterationsDeepLinkConsumed}
                  />
                );
              if (activeTab === "weddings") return <WeddingManagerApp rosActorName={cashierName} initialPartyId={pendingWmPartyId} onInitialPartyConsumed={onClearPendingWmPartyId} />;
              if (activeTab === "appointments") return <SchedulerWorkspace activeSection={activeSubSection} />;
              if (activeTab === "register") return (
                <div className="flex flex-1 flex-col items-center justify-center p-12 text-center bg-app-surface">
                  <div className="mb-6 h-20 w-20 rounded-[2.5rem] bg-[linear-gradient(135deg,var(--app-accent),#f472b6)] flex items-center justify-center text-white shadow-2xl shadow-app-accent/20">
                     <ShoppingCart size={36} strokeWidth={2.5} />
                  </div>
                  <h2 className="text-3xl font-black tracking-tighter text-app-text sm:text-4xl mb-3 uppercase italic">
                    POS
                  </h2>
                  <p className="mb-10 max-w-md text-sm font-bold uppercase leading-relaxed tracking-widest text-app-text-muted opacity-70">
                    Selling, dashboard & lane tools
                    <br />
                    <span className="text-[10px] text-app-accent opacity-100">
                      Register is the active sale screen inside POS.
                    </span>
                  </p>
                  <button 
                    type="button"
                    onClick={() => setPosMode(true)}
                    className={`group relative flex min-h-[52px] touch-manipulation items-center gap-4 rounded-full px-8 py-5 text-[11px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 shadow-[0_20px_40px_-12px_rgba(0,0,0,0.3)] hover:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] sm:min-h-14 sm:px-10 ${isRegisterOpen ? 'bg-app-accent text-white' : 'bg-app-text text-app-surface'}`}
                  >
                    <span className="relative z-10">
                      {isRegisterOpen ? "Return to POS" : "Enter POS"}
                    </span>
                    <div className={`flex h-8 w-8 items-center justify-center rounded-full transition-transform group-hover:translate-x-1 ${isRegisterOpen ? 'bg-white text-app-accent' : 'bg-app-accent text-white'}`}>
                      <ArrowRight size={16} />
                    </div>
                  </button>
                </div>
              );
              if (activeTab === "gift-cards") return <GiftCardsWorkspace activeSection={activeSubSection} />;
              if (activeTab === "loyalty") return <LoyaltyWorkspace activeSection={activeSubSection} />;
              if (activeTab === "reports") {
                return (
                  <ReportsWorkspace
                    onOpenMetabaseExplore={onOpenMetabaseExplore}
                    onNavigateRegisterReports={onNavigateRegisterReports}
                    onNavigateCommissionPayouts={onNavigateCommissionPayouts}
                  />
                );
              }
              if (activeTab === "staff" && activeSubSection === "commission-manager") {
                return <CommissionManagerWorkspace />;
              }
              if (activeTab === "dashboard") {
                return (
                  <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-app-text-muted">
                    <p>Open Insights from the sidebar to load Metabase in full view.</p>
                  </div>
                );
              }
              if (activeTab === "staff")
                return (
                  <StaffWorkspace
                    activeSection={activeSubSection}
                    tasksFocusInstanceId={staffTasksFocusInstanceId}
                    onTasksFocusConsumed={onStaffTasksFocusConsumed}
                  />
                );
              if (activeTab === "qbo")
                return (
                  <QboWorkspace
                    activeSection={activeSubSection}
                    deepLinkSyncLogId={qboDeepLinkSyncLogId}
                    onDeepLinkSyncLogConsumed={onQboDeepLinkConsumed}
                  />
                );
              if (activeTab === "settings")
                return (
                  <SettingsWorkspace
                    themeMode={themeMode}
                    onThemeChange={setThemeMode}
                    onOpenQbo={() => setActiveTab("qbo")}
                    settingsActiveSection={activeSubSection}
                    onSettingsSectionNavigate={setActiveSubSection}
                  />
                );
              
              return (
                <div className="flex flex-1 items-center justify-center p-8 text-center font-medium text-app-text-muted">
                  <p><span className="font-semibold text-app-text">{activeTab}</span> module coming soon.</p>
                </div>
              );
            })()}
          </div>
          </Suspense>
        </div>
      </div>
      {showCloseModal && sessionId && (registerLane === 1 || registerLane == null) && (
        <CloseRegisterModal sessionId={sessionId} cashierName={cashierName} registerLane={registerLane} registerOrdinal={registerOrdinal} onReconcilingBegun={onRegisterReconcilingBegun} onCloseComplete={handleSessionClosed} onCancel={() => { setShowCloseModal(false); refreshOpenSessionMeta(); }} />
      )}
    </div>
  );
}

export default App;
