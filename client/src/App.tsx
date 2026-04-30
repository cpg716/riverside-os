import { getBaseUrl } from "./lib/apiConfig";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Sidebar from "./components/layout/Sidebar";
import {
  type SidebarTabId,
  SIDEBAR_SUB_SECTIONS,
} from "./components/layout/sidebarSections";
import GlobalTopBar from "./components/layout/GlobalTopBar";
import { TopBarProvider } from "./context/TopBarContext";
import type { BreadcrumbSegment } from "./components/layout/GlobalTopBar";
const PosShell = lazy(() => import("./components/layout/PosShell"));
const WeddingShell = lazy(() => import("./components/layout/WeddingShell"));
const InsightsShell = lazy(() => import("./components/layout/InsightsShell"));
const GlobalSearchDrawerHost = lazy(
  () => import("./components/layout/GlobalSearchDrawers"),
);
import type { GlobalSearchDrawerState } from "./components/layout/GlobalSearchDrawers";
const CommissionManagerWorkspace = lazy(
  () => import("./components/staff/CommissionManagerWorkspace"),
);
import CloseRegisterModal from "./components/pos/CloseRegisterModal";
const CustomersWorkspace = lazy(
  () => import("./components/customers/CustomersWorkspace"),
);
const OperationalHome = lazy(
  () => import("./components/operations/OperationalHome"),
);
// CommandPalette removed
import { type Customer } from "./components/pos/types";

const InventoryWorkspace = lazy(
  () => import("./components/inventory/InventoryWorkspace"),
);
const QboWorkspace = lazy(() => import("./components/qbo/QboWorkspace"));
const WeddingManagerApp = lazy(
  () => import("./components/wedding-manager/WeddingManagerApp"),
);
const OrdersWorkspace = lazy(
  () => import("./components/orders/OrdersWorkspace"),
);
const AlterationsWorkspace = lazy(
  () => import("./components/alterations/AlterationsWorkspace"),
);
const StaffWorkspace = lazy(() => import("./components/staff/StaffWorkspace"));
const GiftCardsWorkspace = lazy(
  () => import("./components/gift-cards/GiftCardsWorkspace"),
);
const LoyaltyWorkspace = lazy(
  () => import("./components/loyalty/LoyaltyWorkspace"),
);
const SettingsWorkspace = lazy(
  () => import("./components/settings/SettingsWorkspace"),
);
const SchedulerWorkspace = lazy(
  () => import("./components/scheduler/SchedulerWorkspace"),
);
const ReportsWorkspace = lazy(
  () => import("./components/reports/ReportsWorkspace"),
);
import {
  ROS_OPEN_REGISTER_FROM_WM,
  type RosOpenRegisterFromWmDetail,
} from "./lib/weddingPosBridge";
import { applyDocumentTheme, resolveThemeMode } from "./lib/rosDocumentTheme";
import { ShellBackdropProvider } from "./components/layout/ShellBackdropContext";
import { useShellBackdropDepth } from "./components/layout/ShellBackdropContextLogic";
import BackofficeSignInGate from "./components/layout/BackofficeSignInGate";
import RegisterSessionBootstrap from "./components/layout/RegisterSessionBootstrap";
import HelpCenterDrawer, {
  type HelpCenterDrawerMode,
} from "./components/help/HelpCenterDrawer";
import BugReportFlow from "./components/bug-report/BugReportFlow";
import {
  SIDEBAR_TAB_PERMISSION,
  subSectionVisible,
} from "./context/BackofficeAuthPermissions";
import { BackofficeAuthProvider } from "./context/BackofficeAuthContext";
import { useBackofficeAuth } from "./context/BackofficeAuthContextLogic";
import { RegisterGateProvider } from "./context/RegisterGateContext";
import { NotificationCenterProvider } from "./context/NotificationCenterContext";
import { type NotificationDeepLink, linkStr } from "./context/NotificationCenterContextLogic";
import WeddingManagerAuthBridge from "./components/wedding-manager/WeddingManagerAuthBridge";
import { ShoppingCart, ArrowRight } from "lucide-react";
import { useToast } from "./components/ui/ToastProviderLogic";
import { readPersistedBackofficeSession } from "./lib/backofficeSessionPersistence";
import {
  clearPosRegisterAuth,
  hydratePosRegisterAuthIfNeeded,
  setPosRegisterAuth,
} from "./lib/posRegisterAuth";

export type ThemeMode = "light" | "dark" | "system";

const INVENTORY_SECTION_KEYS = new Set([
  "hub",
  "list",
  "add",
  "purchase_orders",
  "receiving",
  "damaged",
  "physical",
  "vendors",
  "categories",
  "discount_events",
  "import",
  "rtv",
  "intelligence",
]);

const SETTINGS_SECTION_KEYS = new Set(
  SIDEBAR_SUB_SECTIONS.settings
    .filter((sub) => sub.kind !== "group")
    .map((sub) => sub.id),
);

const SETTINGS_DEFAULT_SECTION = "hub";

function parseSettingsPathname(pathname: string): {
  section: string;
  normalizedPath: string;
} | null {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  const trimmed = collapsed.replace(/\/+$/, "") || "/";
  const parts = trimmed.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "settings") return null;
  const candidate = parts[1]?.trim().toLowerCase() || "";
  const section = SETTINGS_SECTION_KEYS.has(candidate)
    ? candidate
    : SETTINGS_DEFAULT_SECTION;
  return {
    section,
    normalizedPath:
      section === SETTINGS_DEFAULT_SECTION ? "/settings" : `/settings/${section}`,
  };
}

function App() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<SidebarTabId>("home");
  const [posMode, setPosMode] = useState(false);
  const [weddingMode, setWeddingMode] = useState(false);
  const [weddingReturnTarget, setWeddingReturnTarget] = useState<"backoffice" | "pos">("backoffice");
  const [insightsMode, setInsightsMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSubSection, setActiveSubSection] = useState<string>(
    () => SIDEBAR_SUB_SECTIONS["home"][0].id,
  );
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
  const activeTabRef = useRef(activeTab);
  const shellNavigationEpochRef = useRef(0);
  // Only log on actual state change or mount to reduce console noise
  const prevRef = useRef({ tab: activeTab, sub: activeSubSection });
  useEffect(() => {
    activeTabRef.current = activeTab;
    if (prevRef.current.tab !== activeTab || prevRef.current.sub !== activeSubSection) {
      console.log(`[ROS App] Navigation: ${activeTab} > ${activeSubSection}`);
      prevRef.current = { tab: activeTab, sub: activeSubSection };
    }
  }, [activeTab, activeSubSection]);

  const [showCloseModal, setShowCloseModal] = useState(false);
  const [pendingPosCustomer, setPendingPosCustomer] = useState<Customer | null>(
    null,
  );
  const [pendingPosTransactionId, setPendingPosTransactionId] = useState<string | null>(
    null,
  );
  const [transactionsDeepLinkTxnId, setTransactionsDeepLinkTxnId] = useState<
    string | null
  >(null);
  const [pendingWeddingPosLink, setPendingWeddingPosLink] =
    useState<RosOpenRegisterFromWmDetail | null>(null);
  const [pendingWmPartyId, setPendingWmPartyId] = useState<string | null>(null);
  const [alterationsDeepLinkId, setAlterationsDeepLinkId] = useState<
    string | null
  >(null);
  const [procurementDeepLinkPoId, setProcurementDeepLinkPoId] = useState<
    string | null
  >(null);
  const [inventoryProductHubProductId, setInventoryProductHubProductId] =
    useState<string | null>(null);
  const [qboDeepLinkSyncLogId, setQboDeepLinkSyncLogId] = useState<
    string | null
  >(null);
  const [appointmentsDeepLinkId, setAppointmentsDeepLinkId] = useState<
    string | null
  >(null);
  const [staffTasksFocusInstanceId, setStaffTasksFocusInstanceId] = useState<
    string | null
  >(null);
  const [
    customersMessagingFocusCustomerId,
    setCustomersMessagingFocusCustomerId,
  ] = useState<string | null>(null);
  const [customersMessagingFocusHubTab, setCustomersMessagingFocusHubTab] =
    useState<string | null>(null);
  const [globalSearchDrawer, setGlobalSearchDrawer] =
    useState<GlobalSearchDrawerState | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const saved = window.localStorage.getItem("ros.theme.mode");
    if (saved === "light" || saved === "dark" || saved === "system")
      return saved;
    return "light";
  });
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [registerReportsDeepLinkTxnId, setRegisterReportsDeepLinkTxnId] =
    useState<string | null>(null);
  const [bugReportsDeepLinkId, setBugReportsDeepLinkId] = useState<
    string | null
  >(null);
  const [helpDrawerOpen, setHelpDrawerOpen] = useState(false);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const baseUrl = getBaseUrl();
  const registerMetaRefreshRef = useRef<(() => Promise<void>) | null>(null);

  const onRegisterReconcilingBegun = useCallback(() => {
    setLifecycleStatus("reconciling");
  }, []);

  const enterBackofficeShell = useCallback(
    (tab: SidebarTabId, section?: string) => {
      setPosMode(false);
      setWeddingMode(false);
      setWeddingReturnTarget("backoffice");
      setInsightsMode(false);
      setActiveTab(tab);
      if (section) {
        setActiveSubSection(section);
      } else if (tab === "inventory") {
        setActiveSubSection("hub");
      }
    },
    [],
  );

  const enterInsightsShell = useCallback(() => {
    setPosMode(false);
    setWeddingMode(false);
    setInsightsMode(true);
    setActiveTab("dashboard");
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
    if (subs.length === 0) return;
    const hasValidSubSection =
      activeTab === "inventory"
        ? INVENTORY_SECTION_KEYS.has(activeSubSection)
        : subs.some(
            (sub) => sub.kind !== "group" && sub.id === activeSubSection,
          );
    if (!hasValidSubSection) {
      const firstSection = subs.find((sub) => sub.kind !== "group");
      setActiveSubSection(
        activeTab === "inventory" ? "hub" : (firstSection?.id ?? "hub"),
      );
    }
  }, [activeTab, activeSubSection]);

  useEffect(() => {
    if (!transactionsDeepLinkTxnId) return;
    if (activeTab !== "orders") return;
    setActiveSubSection("all");
  }, [transactionsDeepLinkTxnId, activeTab]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wp = params.get("wedding_party");
    if (wp) {
      setActiveTab("weddings");
      setWeddingReturnTarget("backoffice");
      setWeddingMode(true);
      setPosMode(false);
      setInsightsMode(false);
      setPendingWmPartyId(wp);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  /**
   * Path-based shell entry:
   * - `/pos` opens POS shell.
   * - `/settings` and `/settings/:section` open Settings with section normalization.
   */
  useEffect(() => {
    if (loading) return;
    const settingsRoute = parseSettingsPathname(window.location.pathname);
    if (settingsRoute) {
      enterBackofficeShell("settings", settingsRoute.section);
      const normalizedUrl = `${settingsRoute.normalizedPath}${window.location.search}${window.location.hash}`;
      const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (currentUrl !== normalizedUrl) {
        window.history.replaceState({}, "", normalizedUrl);
      }
      return;
    }

    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    if (path === "/pos") {
      setPosMode(true);
      setInsightsMode(false);
      setActiveTab("register");
    }
  }, [loading, enterBackofficeShell]);

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

    setWeddingMode(false);
    setInsightsMode(false);
    setActiveTab("register");
    setPosMode(true);
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

  const clearPendingPosCustomer = useCallback(
    () => setPendingPosCustomer(null),
    [],
  );
  const clearPendingPosTransaction = useCallback(
    () => setPendingPosTransactionId(null),
    [],
  );
  const clearPendingWeddingPosLink = useCallback(
    () => setPendingWeddingPosLink(null),
    [],
  );

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
    window.addEventListener(
      ROS_OPEN_REGISTER_FROM_WM,
      handler as EventListener,
    );
    return () =>
      window.removeEventListener(
        ROS_OPEN_REGISTER_FROM_WM,
        handler as EventListener,
      );
  }, []);

  const navigateRegister = useCallback(() => {
    setActiveTab("register");
    setWeddingMode(false);
    setInsightsMode(false);
    setPosMode(true);
  }, []);

  const navigateWedding = useCallback((partyId?: string | null) => {
    setPendingWmPartyId(partyId ?? null);
    setWeddingReturnTarget(posMode ? "pos" : "backoffice");
    if (posMode) {
      setActiveTab("weddings");
    } else {
      setPosMode(false);
      setActiveTab("weddings");
      setWeddingMode(true);
      setInsightsMode(false);
    }
  }, [posMode]); 


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

  const handleNotificationNavigate = useCallback(
    (link: NotificationDeepLink) => {
      console.log("[App] handleNotificationNavigate:", link);
      const t = link.type;

      setInsightsMode(false);
      setPosMode(false);
      setWeddingMode(false);

      // 1. Task instance focus
      const instanceId = linkStr(link, "instance_id");
      if (t === "staff_tasks" && instanceId) {
        setStaffTasksFocusInstanceId(instanceId);
        setActiveTab("home");
        setActiveSubSection("dashboard");
        return;
      }

      // 2. Specific item focus (Orders, Alterations, POs, QBO log)
      const orderId = linkStr(link, "order_id") || linkStr(link, "transaction_id");
      if (t === "order" && orderId) {
        setTransactionsDeepLinkTxnId(orderId);
        setActiveTab("orders");
        setActiveSubSection("open");
        return;
      }
      const partyId = linkStr(link, "party_id");
      if (t === "wedding_party" && partyId) {
        navigateWedding(partyId);
        return;
      }
      const alterationId = linkStr(link, "alteration_id");
      if (t === "alteration" && alterationId) {
        setAlterationsDeepLinkId(alterationId);
        setActiveTab("alterations");
        setActiveSubSection("queue");
        return;
      }
      const poId = linkStr(link, "po_id");
      if (t === "purchase_order" && poId) {
        setProcurementDeepLinkPoId(poId);
        setActiveTab("inventory");
        setActiveSubSection("purchase_orders");
        return;
      }
      const syncLogId = linkStr(link, "sync_log_id");
      if (t === "qbo_staging" && syncLogId) {
        setQboDeepLinkSyncLogId(syncLogId);
        setActiveTab("qbo");
        setActiveSubSection("staging");
        return;
      }

      // 3. Tab-based landing (with optional subsections)
      if (t === "orders") {
        setActiveTab("orders");
        const sub = linkStr(link, "subsection") || "open";
        setActiveSubSection(sub === "all" ? "all" : "open");
        return;
      }

      if (t === "settings") {
        enterBackofficeShell("settings");
        const sec = linkStr(link, "section") || "profile";
        const allowed = new Set([
          "hub",
          "profile",
          "general",
          "printing",
          "register",
          "receipt-builder",
          "tag-designer",
          "staff-access-defaults",
          "integrations",
          "nuorder",
          "counterpoint",
          "remote-access",
          "ros-dev-center",
          "rosie",
          "online-store",
          "help-center",
          "backups",
          "bug-reports",
          "meilisearch",
          "shippo",
          "stripe",
          "quickbooks",
          "weather",
          "podium",
          "insights",
        ]);
        setActiveSubSection(allowed.has(sec) ? sec : "general");
        const bugId = linkStr(link, "bug_report_id");
        if (bugId) {
          setBugReportsDeepLinkId(bugId);
        }
        return;
      }

      if (t === "inventory") {
        enterBackofficeShell("inventory");
        const pid = linkStr(link, "product_id");
        const fallbackSec = pid ? "list" : "hub";
        const sec = linkStr(link, "section") || fallbackSec;
        setActiveSubSection(INVENTORY_SECTION_KEYS.has(sec) ? sec : fallbackSec);
        if (pid) setInventoryProductHubProductId(pid);
        return;
      }

      if (t === "dashboard") {
        enterBackofficeShell("home");
        const sec = linkStr(link, "subsection") || "dashboard";
        const allowedD = new Set([
          "dashboard",
          "daily-sales",
          "fulfillment",
          "inbox",
          "reviews",
        ]);
        const normalizedSec =
          sec === "payouts" || sec === "morning_digest" ? "dashboard" : sec;
        setActiveSubSection(
          allowedD.has(normalizedSec) ? normalizedSec : "dashboard",
        );
        return;
      }

      if (t === "register") {
        setActiveTab("register");
        setActiveSubSection("floor");
        return;
      }

      if (t === "home") {
        enterBackofficeShell("home");
        const sub = linkStr(link, "subsection") || "dashboard";
        const allowedHome = new Set([
          "dashboard",
          "daily-sales",
          "fulfillment",
          "inbox",
          "reviews",
        ]);
        const normalizedSub =
          sub === "activity" || sub === "payouts" || sub === "morning_digest"
            ? "dashboard"
            : sub;
        setActiveSubSection(
          allowedHome.has(normalizedSub) ? normalizedSub : "dashboard",
        );
        const homeOrderId = linkStr(link, "order_id");
        if (homeOrderId) {
          setRegisterReportsDeepLinkTxnId(homeOrderId);
        }
        return;
      }

      if (t === "weddings") {
        setActiveTab("weddings");
        setWeddingMode(true);
        const sec = linkStr(link, "section") || "action-board";
        const allowedW = new Set(["action-board", "parties", "calendar"]);
        setActiveSubSection(allowedW.has(sec) ? sec : "action-board");
        const wPartyId = linkStr(link, "party_id");
        if (wPartyId) setPendingWmPartyId(wPartyId);
        return;
      }

      if (t === "customers" || t === "layaways") {
        enterBackofficeShell("customers");
        const subRaw =
          t === "layaways" ? "layaways" : linkStr(link, "subsection") || "all";
        if (subRaw === "messaging") {
          const cid = linkStr(link, "customer_id");
          if (cid) {
            setActiveSubSection("all");
            setCustomersMessagingFocusCustomerId(cid);
            setCustomersMessagingFocusHubTab(
              linkStr(link, "hub_tab") || "messages",
            );
          } else {
            setActiveTab("home");
            setActiveSubSection("inbox");
          }
          return;
        }
        const allowedCustomers = new Set([
          "all",
          "add",
          "layaways",
          "ship",
          "rms-charge",
          "duplicate-review",
        ]);
        setActiveSubSection(allowedCustomers.has(subRaw) ? subRaw : "all");
        const custId = linkStr(link, "customer_id");
        if (custId) {
          setCustomersMessagingFocusCustomerId(custId);
          setCustomersMessagingFocusHubTab(linkStr(link, "hub_tab") || null);
        }
        return;
      }

      if (t === "appointments") {
        enterBackofficeShell("appointments");
        const sec = linkStr(link, "section") || "scheduler";
        setActiveSubSection(sec === "conflicts" ? "conflicts" : "scheduler");
        const appointmentId = linkStr(link, "appointment_id");
        if (appointmentId) {
          setAppointmentsDeepLinkId(appointmentId);
        }
        return;
      }

      if (t === "qbo") {
        enterBackofficeShell("qbo");
        const sec = linkStr(link, "section") || "staging";
        const allowedQ = new Set([
          "connection",
          "mappings",
          "staging",
          "history",
        ]);
        setActiveSubSection(allowedQ.has(sec) ? sec : "staging");
        return;
      }

      if (t === "staff") {
        const sec = linkStr(link, "section") || "team";
        const toSettingsAccess = new Set([
          "roles",
          "discounts",
          "access",
          "pins",
        ]);
        if (toSettingsAccess.has(sec)) {
          enterBackofficeShell("settings", "staff-access-defaults");
        } else {
          enterBackofficeShell("staff");
          const allowedS = new Set([
            "team",
            "tasks",
            "schedule",
            "commission",
            "commission-payouts",
            "audit",
          ]);
          setActiveSubSection(
            allowedS.has(sec)
              ? sec === "commission-payouts"
                ? "commission"
                : sec
              : "team",
          );
        }
        return;
      }

      if (t === "gift-cards") {
        enterBackofficeShell("gift-cards");
        const sec = linkStr(link, "section") || "inventory";
        const allowedG = new Set([
          "inventory",
          "issue-donated",
        ]);
        setActiveSubSection(allowedG.has(sec) ? sec : "inventory");
        return;
      }

      if (t === "loyalty") {
        enterBackofficeShell("loyalty");
        const sec = linkStr(link, "section") || "eligible";
        const allowedL = new Set(["eligible", "history", "adjust", "settings"]);
        setActiveSubSection(allowedL.has(sec) ? sec : "eligible");
        return;
      }

      if (t === "reports") {
        enterBackofficeShell("reports");
        return;
      }
    },
    [enterBackofficeShell, navigateWedding],
  );

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
    setRefreshSignal((s) => s + 1);
  }, []);

  const breadcrumbSegments: BreadcrumbSegment[] = useMemo(() => {
    const subLabel = SIDEBAR_SUB_SECTIONS[activeTab].find(
      (s) => s.id === activeSubSection,
    )?.label;
    
    const baseClick = () => {
      if (activeTab === "home") return;
      setActiveTab("home");
    };

    const tabClick = () => {
      const subs = SIDEBAR_SUB_SECTIONS[activeTab];
      if (subs.length > 0 && activeSubSection !== subs[0].id) {
        setActiveSubSection(subs[0].id);
      }
    };

    if (activeTab === "home")
      return [
        { label: "Operations", onClick: baseClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "register")
      return [
        { label: "POS", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : [])
      ];
    if (activeTab === "weddings")
      return [
        { label: "Weddings", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "customers")
      return [
        { label: "Customers", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "alterations")
      return [
        { label: "Alterations", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "orders")
      return [
        { label: "Orders", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : [])
      ];
    if (activeTab === "inventory")
      return [
        { label: "Inventory", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "settings")
      return [
        { label: "Settings", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "reports") return [{ label: "Reports", onClick: tabClick }];
    if (activeTab === "pos-dashboard")
      return [
        { label: "POS", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "dashboard")
      return [
        { label: "Insights", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "staff")
      return [{ label: "Staff", onClick: tabClick }, ...(subLabel ? [{ label: subLabel }] : [])];
    if (activeTab === "qbo")
      return [
        { label: "QBO Bridge", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "gift-cards")
      return [
        { label: "Gift Cards", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "loyalty")
      return [
        { label: "Loyalty", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    if (activeTab === "appointments")
      return [
        { label: "Appointments", onClick: tabClick },
        ...(subLabel ? [{ label: subLabel }] : []),
      ];
    return [
      {
        label: (activeTab as string)
          .split("-")
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" "),
        onClick: tabClick,
      },
    ];
  }, [activeTab, activeSubSection]);

  const onWorkspaceClick = useCallback(() => {
    if (window.innerWidth < 1024) setSidebarCollapsed(true);
  }, []);

  const markShellNavigationIntent = useCallback(() => {
    shellNavigationEpochRef.current += 1;
  }, []);

  const onOpenTransactionInBackoffice = useCallback((orderId: string) => {
    setTransactionsDeepLinkTxnId(orderId);
    enterBackofficeShell("orders", "all");
  }, [enterBackofficeShell]);

  const onOpenMetabaseExplore = useCallback(() => {
    enterInsightsShell();
  }, [enterInsightsShell]);

  const onNavigateRegisterReports = useCallback(
    (transactionId?: string) => {
      setActiveTab("home");
      setActiveSubSection("daily-sales");
      if (transactionId) setRegisterReportsDeepLinkTxnId(transactionId);
    },
    [],
  );

  const onNavigateCommissionPayouts = useCallback(() => {
    setActiveTab("staff");
    setActiveSubSection("commission");
  }, []);

  return (
    <TopBarProvider>
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
          activeTabRef={activeTabRef}
          setActiveTab={setActiveTab}
          setPosMode={setPosMode}
          metaRefreshRef={registerMetaRefreshRef}
          shellNavigationEpochRef={shellNavigationEpochRef}
        />
        {loading ? (
          <div className="flex h-screen items-center justify-center bg-app-bg font-sans text-app-text-muted antialiased">
            Loading Riverside POS…
          </div>
        ) : (
        <NotificationCenterProvider onNavigate={handleNotificationNavigate}>
          <WeddingManagerAuthBridge />
          <InsightsAccessSync
            insightsMode={insightsMode}
            setInsightsMode={setInsightsMode}
            setActiveTab={setActiveTab}
          />
          <AppShell
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            posMode={posMode}
            setPosMode={setPosMode}
            weddingMode={weddingMode}
            setWeddingMode={setWeddingMode}
            weddingReturnTarget={weddingReturnTarget}
            setWeddingReturnTarget={setWeddingReturnTarget}
            insightsMode={insightsMode}
            setInsightsMode={setInsightsMode}
            sidebarCollapsed={sidebarCollapsed}
            setSidebarCollapsed={setSidebarCollapsed}
            activeSubSection={activeSubSection}
            setActiveSubSection={setActiveSubSection}
            isRegisterOpen={isRegisterOpen}
            cashierName={cashierName}
            cashierAvatarKey={cashierAvatarKey}
            cashierCode={cashierCode}
            sessionId={sessionId}
            registerLane={registerLane}
            registerOrdinal={registerOrdinal}
            lifecycleStatus={lifecycleStatus}
            receiptTimezone={receiptTimezone}
            breadcrumbSegments={breadcrumbSegments}
            themeMode={themeMode}
            setThemeMode={setThemeMode}
            navigateRegister={navigateRegister}
            navigateDashboard={navigateDashboard}
            navigateWedding={navigateWedding}
            enterBackofficeShell={enterBackofficeShell}
            enterInsightsShell={enterInsightsShell}
            pendingWmPartyId={pendingWmPartyId}
            onClearPendingWmPartyId={clearPendingWmPartyId}
            handleSessionOpened={handleSessionOpened}
            handleSessionClosed={handleSessionClosed}
            showCloseModal={showCloseModal}
            setShowCloseModal={setShowCloseModal}
            refreshOpenSessionMeta={refreshOpenSessionMeta}
            onRegisterReconcilingBegun={onRegisterReconcilingBegun}
            pendingPosCustomer={pendingPosCustomer}
            setPendingPosCustomer={setPendingPosCustomer}
            pendingPosTransactionId={pendingPosTransactionId}
            setPendingPosTransactionId={setPendingPosTransactionId}
            clearPendingPosCustomer={clearPendingPosCustomer}
            clearPendingPosTransaction={clearPendingPosTransaction}
            pendingWeddingPosLink={pendingWeddingPosLink}
            clearPendingWeddingPosLink={clearPendingWeddingPosLink}
            transactionsDeepLinkTxnId={transactionsDeepLinkTxnId}
            setTransactionsDeepLinkTxnId={setTransactionsDeepLinkTxnId}
            onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
            globalSearchDrawer={globalSearchDrawer}
            setGlobalSearchDrawer={setGlobalSearchDrawer}
            refreshSignal={refreshSignal}
            triggerDashboardRefresh={triggerDashboardRefresh}
            alterationsDeepLinkId={alterationsDeepLinkId}
            setAlterationsDeepLinkId={setAlterationsDeepLinkId}
            procurementDeepLinkPoId={procurementDeepLinkPoId}
            setProcurementDeepLinkPoId={setProcurementDeepLinkPoId}
            inventoryProductHubProductId={inventoryProductHubProductId}
            setInventoryProductHubProductId={setInventoryProductHubProductId}
            qboDeepLinkSyncLogId={qboDeepLinkSyncLogId}
            setQboDeepLinkSyncLogId={setQboDeepLinkSyncLogId}
            appointmentsDeepLinkId={appointmentsDeepLinkId}
            setAppointmentsDeepLinkId={setAppointmentsDeepLinkId}
            staffTasksFocusInstanceId={staffTasksFocusInstanceId}
            setStaffTasksFocusInstanceId={setStaffTasksFocusInstanceId}
            handleStaffTasksFocusConsumed={handleStaffTasksFocusConsumed}
            customersMessagingFocusCustomerId={customersMessagingFocusCustomerId}
            setCustomersMessagingFocusCustomerId={setCustomersMessagingFocusCustomerId}
            customersMessagingFocusHubTab={customersMessagingFocusHubTab}
            setCustomersMessagingFocusHubTab={setCustomersMessagingFocusHubTab}
            openCustomerHubFromInbox={openCustomerHubFromInbox}
            onOpenMetabaseExplore={onOpenMetabaseExplore}
            onNavigateRegisterReports={onNavigateRegisterReports}
            onNavigateCommissionPayouts={onNavigateCommissionPayouts}
            registerReportsDeepLinkTxnId={registerReportsDeepLinkTxnId}
            setRegisterReportsDeepLinkTxnId={setRegisterReportsDeepLinkTxnId}
            bugReportsDeepLinkId={bugReportsDeepLinkId}
            setBugReportsDeepLinkId={setBugReportsDeepLinkId}
            onWorkspaceClick={onWorkspaceClick}
            helpDrawerOpen={helpDrawerOpen}
            setHelpDrawerOpen={setHelpDrawerOpen}
            bugReportOpen={bugReportOpen}
            setBugReportOpen={setBugReportOpen}
            markShellNavigationIntent={markShellNavigationIntent}
          />
        </NotificationCenterProvider>
      )}
    </RegisterGateProvider>
    </BackofficeAuthProvider>
    </TopBarProvider>
  );
}

interface PosSessionInfo {
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

interface AppShellProps {
  activeTab: SidebarTabId;
  setActiveTab: (tab: SidebarTabId) => void;
  posMode: boolean;
  setPosMode: (v: boolean) => void;
  weddingMode: boolean;
  setWeddingMode: (v: boolean) => void;
  weddingReturnTarget: "backoffice" | "pos";
  setWeddingReturnTarget: (v: "backoffice" | "pos") => void;
  insightsMode: boolean;
  setInsightsMode: (v: boolean) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  activeSubSection: string;
  setActiveSubSection: (id: string) => void;
  isRegisterOpen: boolean;
  cashierName: string | null;
  cashierAvatarKey: string | null;
  cashierCode: string | null;
  sessionId: string | null;
  registerLane: number | null;
  registerOrdinal: number | null;
  lifecycleStatus: string | null;
  receiptTimezone: string | null;
  breadcrumbSegments: BreadcrumbSegment[];
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  navigateRegister: () => void;
  navigateDashboard: () => void;
  navigateWedding: (partyId?: string | null) => void;
  enterBackofficeShell: (tab: SidebarTabId, section?: string) => void;
  enterInsightsShell: () => void;
  pendingWmPartyId: string | null;
  onClearPendingWmPartyId: () => void;
  handleSessionOpened: (p: PosSessionInfo) => void;
  handleSessionClosed: () => void;
  showCloseModal: boolean;
  setShowCloseModal: (v: boolean) => void;
  refreshOpenSessionMeta: () => Promise<void>;
  onRegisterReconcilingBegun: () => void;
  pendingPosCustomer: Customer | null;
  setPendingPosCustomer: (c: Customer | null) => void;
  pendingPosTransactionId: string | null;
  setPendingPosTransactionId: (id: string | null) => void;
  clearPendingPosCustomer: () => void;
  clearPendingPosTransaction: () => void;
  pendingWeddingPosLink: RosOpenRegisterFromWmDetail | null;
  clearPendingWeddingPosLink: () => void;
  transactionsDeepLinkTxnId: string | null;
  setTransactionsDeepLinkTxnId: (id: string | null) => void;
  onOpenTransactionInBackoffice: (transactionId: string) => void;
  globalSearchDrawer: GlobalSearchDrawerState | null;
  setGlobalSearchDrawer: (s: GlobalSearchDrawerState | null) => void;
  refreshSignal: number;
  triggerDashboardRefresh: () => void;
  alterationsDeepLinkId: string | null;
  setAlterationsDeepLinkId: (id: string | null) => void;
  procurementDeepLinkPoId: string | null;
  setProcurementDeepLinkPoId: (id: string | null) => void;
  inventoryProductHubProductId: string | null;
  setInventoryProductHubProductId: (id: string | null) => void;
  qboDeepLinkSyncLogId: string | null;
  setQboDeepLinkSyncLogId: (id: string | null) => void;
  appointmentsDeepLinkId: string | null;
  setAppointmentsDeepLinkId: (id: string | null) => void;
  staffTasksFocusInstanceId: string | null;
  setStaffTasksFocusInstanceId: (id: string | null) => void;
  handleStaffTasksFocusConsumed: () => void;
  customersMessagingFocusCustomerId: string | null;
  setCustomersMessagingFocusCustomerId: (id: string | null) => void;
  customersMessagingFocusHubTab: string | null;
  setCustomersMessagingFocusHubTab: (tab: string | null) => void;
  openCustomerHubFromInbox: (c: Customer) => void;
  onOpenMetabaseExplore: () => void;
  onNavigateRegisterReports: (transactionId?: string) => void;
  onNavigateCommissionPayouts: () => void;
  registerReportsDeepLinkTxnId: string | null;
  setRegisterReportsDeepLinkTxnId: (id: string | null) => void;
  bugReportsDeepLinkId: string | null;
  setBugReportsDeepLinkId: (id: string | null) => void;
  onWorkspaceClick: () => void;
  helpDrawerOpen: boolean;
  setHelpDrawerOpen: (v: boolean) => void;
  bugReportOpen: boolean;
  setBugReportOpen: (v: boolean) => void;
  markShellNavigationIntent: () => void;
}

const POS_SHELL_TABS = new Set<SidebarTabId>([
  "pos-dashboard",
  "register",
  "tasks",
  "customers",
  "rms-charge",
  "podium-inbox",
  "inventory",
  "orders",
  "weddings",
  "alterations",
  "reports",
  "gift-cards",
  "loyalty",
  "layaways",
  "shipping",
  "settings",
]);

function AppShell({
  posMode,
  activeTab,
  setActiveTab,
  setPosMode,
  triggerDashboardRefresh,
  activeSubSection,
  setActiveSubSection,
  sidebarCollapsed,
  setSidebarCollapsed,
  isRegisterOpen,
  cashierName,
  cashierCode,
  cashierAvatarKey,
  registerOrdinal,
  registerLane,
  lifecycleStatus,
  sessionId,
  receiptTimezone,
  pendingPosCustomer,
  pendingPosTransactionId,
  setPendingPosTransactionId,
  setPendingPosCustomer,
  clearPendingPosCustomer,
  clearPendingPosTransaction,
  pendingWeddingPosLink,
  clearPendingWeddingPosLink,
  navigateDashboard,
  navigateRegister,
  navigateWedding,
  enterBackofficeShell,
  enterInsightsShell,
  pendingWmPartyId,
  onClearPendingWmPartyId,
  handleSessionOpened,
  handleSessionClosed,
  showCloseModal,
  setShowCloseModal,
  refreshOpenSessionMeta,
  onRegisterReconcilingBegun,
  onOpenTransactionInBackoffice,
  onWorkspaceClick,
  transactionsDeepLinkTxnId,
  setTransactionsDeepLinkTxnId,
  setGlobalSearchDrawer,
  globalSearchDrawer,
  refreshSignal,
  alterationsDeepLinkId,
  setAlterationsDeepLinkId,
  procurementDeepLinkPoId,
  setProcurementDeepLinkPoId,
  inventoryProductHubProductId,
  setInventoryProductHubProductId,
  qboDeepLinkSyncLogId,
  setQboDeepLinkSyncLogId,
  appointmentsDeepLinkId,
  setAppointmentsDeepLinkId,
  staffTasksFocusInstanceId,
  handleStaffTasksFocusConsumed,
  customersMessagingFocusCustomerId,
  setCustomersMessagingFocusCustomerId,
  customersMessagingFocusHubTab,
  setCustomersMessagingFocusHubTab,
  openCustomerHubFromInbox,
  onOpenMetabaseExplore,
  onNavigateRegisterReports,
  onNavigateCommissionPayouts,
  registerReportsDeepLinkTxnId,
  setRegisterReportsDeepLinkTxnId,
  bugReportsDeepLinkId,
  setBugReportsDeepLinkId,
  helpDrawerOpen,
  setHelpDrawerOpen,
  bugReportOpen,
  setBugReportOpen,
  markShellNavigationIntent,
  breadcrumbSegments,
  themeMode,
  setThemeMode,
  weddingMode,
  setWeddingMode,
  weddingReturnTarget,
  setWeddingReturnTarget,
  insightsMode,
  setInsightsMode,
}: AppShellProps) {
  const { staffCode, permissionsLoaded, permissions } = useBackofficeAuth();
  const [helpDrawerMode, setHelpDrawerMode] =
    useState<HelpCenterDrawerMode>("browse");
  const isAuthenticated = !!(staffCode.trim() && permissionsLoaded && permissions.length > 0);
  useEffect(() => {
    // Shell entry tabs should reconcile their owning mode if the parent tab and mode drift.
    if (
      !posMode &&
      (activeTab === "register" ||
        activeTab === "pos-dashboard" ||
        activeTab === "tasks" ||
        activeTab === "rms-charge" ||
        activeTab === "podium-inbox" ||
        activeTab === "shipping" ||
        activeTab === "layaways")
    ) {
      setPosMode(true);
      return;
    }
    if (!posMode && !weddingMode && activeTab === "weddings") {
      setPosMode(false);
      setInsightsMode(false);
      setWeddingMode(true);
      return;
    }
    if (!insightsMode && activeTab === "dashboard") {
      setPosMode(false);
      setWeddingMode(false);
      setInsightsMode(true);
    }
  }, [
    activeTab,
    insightsMode,
    posMode,
    setInsightsMode,
    setPosMode,
    setWeddingMode,
    weddingMode,
  ]);

  const handlePosShellTabChange = useCallback(
    (tab: SidebarTabId) => {
      // Valid POS shell tabs stay inside POS; explicit exits are handled separately.
      setActiveTab(tab);
    },
    [setActiveTab],
  );

  const content = (
    <BackofficeSignInGate>
      <div
        className="flex flex-1"
        data-testid="app-shell-state"
        data-active-tab={activeTab}
        data-pos-mode={posMode ? "true" : "false"}
      >
        {posMode ? (
          <PosShell
            activeTab={activeTab}
            onTabChange={handlePosShellTabChange}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            activeSubSection={activeSubSection}
            onSubSectionChange={setActiveSubSection}
            onExitPosMode={() => {
              navigateDashboard();
              setSidebarCollapsed(false);
              triggerDashboardRefresh();
            }}
            isRegisterOpen={isRegisterOpen}
            cashierName={cashierName}
            cashierCode={cashierCode}
            registerOrdinal={registerOrdinal}
            registerLane={registerLane}
            lifecycleStatus={lifecycleStatus}
            sessionId={sessionId}
            receiptTimezone={receiptTimezone ?? "UTC"}
            pendingPosCustomer={pendingPosCustomer}
            pendingPosTransactionId={pendingPosTransactionId}
            setPendingPosTransactionId={setPendingPosTransactionId}
            setPendingPosCustomer={setPendingPosCustomer}
            clearPendingPosCustomer={clearPendingPosCustomer}
            clearPendingPosTransaction={clearPendingPosTransaction}
            pendingWeddingPosLink={pendingWeddingPosLink}
            clearPendingWeddingPosLink={clearPendingWeddingPosLink}
            onSessionOpened={handleSessionOpened}
            showCloseModal={showCloseModal}
            setShowCloseModal={setShowCloseModal}
            handleSessionClosed={handleSessionClosed}
            refreshOpenSessionMeta={refreshOpenSessionMeta}
            onRegisterReconcilingBegun={onRegisterReconcilingBegun}
            onRegisterTransactionCommitted={triggerDashboardRefresh}
            onOpenWeddingParty={(partyId: string) => navigateWedding(partyId)}
            pendingWmPartyId={pendingWmPartyId}
            onClearPendingWmPartyId={onClearPendingWmPartyId}
            refreshSignal={refreshSignal}
          />

        ) : insightsMode ? (
          <InsightsShell
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
            onInitialPartyConsumed={onClearPendingWmPartyId}
            returnLabel={weddingReturnTarget === "pos" ? "Return to POS" : "Back to Back Office"}
            onExitWeddingMode={() => {
              setWeddingMode(false);
              setSidebarCollapsed(false);
              if (weddingReturnTarget === "pos") {
                setPosMode(true);
                setActiveTab(isRegisterOpen ? "register" : "pos-dashboard");
              } else {
                setActiveTab("home");
                triggerDashboardRefresh();
              }
              setWeddingReturnTarget("backoffice");
            }}
          />
        ) : (
          <div className="flex flex-1">
            <Sidebar
              activeTab={activeTab}
              onTabChange={(tab) => {
                markShellNavigationIntent();
                if (tab === "register") {
                  setPosMode(true);
                  setWeddingMode(false);
                  setInsightsMode(false);
                } else if (tab === "weddings") {
                  setPosMode(false);
                  setWeddingReturnTarget("backoffice");
                  setWeddingMode(true);
                  setInsightsMode(false);
                } else if (tab === "dashboard") {
                  setInsightsMode(true);
                  setPosMode(false);
                  setWeddingMode(false);
                } else {
                  setPosMode(false);
                  setWeddingMode(false);
                  setInsightsMode(false);
                }
                setActiveTab(tab);
                if (tab === "inventory") {
                  setActiveSubSection("hub");
                } else if (tab === "settings") {
                  setActiveSubSection("hub");
                }
                if (window.innerWidth < 1024) setSidebarCollapsed(true);
              }}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              activeSubSection={activeSubSection}
              onSubSectionChange={(section) => {
                markShellNavigationIntent();
                if (window.innerWidth < 1024) setSidebarCollapsed(true);
                setActiveSubSection(section);
              }}
            />
            {!sidebarCollapsed && (
              <button
                type="button"
                className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden transition-opacity w-full h-full border-none p-0 cursor-default focus:outline-none"
                onClick={() => setSidebarCollapsed(true)}
                aria-label="Close sidebar"
                tabIndex={-1}
              />
            )}
            <ShellBackdropProvider>
              <AppMainColumn
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                activeSubSection={activeSubSection}
                setActiveSubSection={setActiveSubSection}
                onWorkspaceClick={onWorkspaceClick}
                navigateRegister={navigateRegister}
                navigateWedding={navigateWedding}
                pendingWmPartyId={pendingWmPartyId}
                onClearPendingWmPartyId={onClearPendingWmPartyId}
                setPendingPosCustomer={setPendingPosCustomer}
                setPendingPosTransactionId={setPendingPosTransactionId}
                transactionsDeepLinkTxnId={transactionsDeepLinkTxnId}
                onTransactionsDeepLinkConsumed={() => setTransactionsDeepLinkTxnId(null)}
                onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
                setGlobalSearchDrawer={setGlobalSearchDrawer}
                globalSearchDrawer={globalSearchDrawer}
                cashierName={cashierName}
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
                appointmentsDeepLinkId={appointmentsDeepLinkId}
                setAppointmentsDeepLinkId={setAppointmentsDeepLinkId}
                staffTasksFocusInstanceId={staffTasksFocusInstanceId}
                onStaffTasksFocusConsumed={handleStaffTasksFocusConsumed}
                customersMessagingFocusCustomerId={customersMessagingFocusCustomerId}
                customersMessagingFocusHubTab={customersMessagingFocusHubTab}
                onCustomersMessagingFocusConsumed={() => {
                  setCustomersMessagingFocusCustomerId(null);
                  setCustomersMessagingFocusHubTab(null);
                }}
                onOpenCustomerHubFromInbox={openCustomerHubFromInbox}
                onOpenMetabaseExplore={onOpenMetabaseExplore}
                onNavigateRegisterReports={onNavigateRegisterReports}
                onNavigateCommissionPayouts={onNavigateCommissionPayouts}
                registerReportsDeepLinkTxnId={registerReportsDeepLinkTxnId}
                setRegisterReportsDeepLinkTxnId={setRegisterReportsDeepLinkTxnId}
                bugReportsDeepLinkId={bugReportsDeepLinkId}
                setBugReportsDeepLinkId={setBugReportsDeepLinkId}
              />
            </ShellBackdropProvider>
          </div>
        )}
      </div>

      <HelpCenterDrawer
        isOpen={helpDrawerOpen}
        openMode={helpDrawerMode}
        onClose={() => setHelpDrawerOpen(false)}
      />

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

      {showCloseModal &&
        sessionId &&
        (registerLane === 1 || registerLane == null) && (
          <CloseRegisterModal
            sessionId={sessionId}
            cashierName={cashierName}
            registerLane={registerLane}
            registerOrdinal={registerOrdinal}
            onReconcilingBegun={onRegisterReconcilingBegun}
            onCloseComplete={handleSessionClosed}
            onCancel={() => {
              setShowCloseModal(false);
              refreshOpenSessionMeta();
            }}
          />
        )}
    </BackofficeSignInGate>
  );

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col min-h-screen bg-app-bg">
        {content}
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-app-bg antialiased font-sans">
      <GlobalTopBar
        segments={breadcrumbSegments}
        onNavigateRegister={navigateRegister}
        onSelectCustomerForPos={(c: Customer) => setPendingPosCustomer(c)}
        onSearchOpenCustomerDrawer={(c: Customer) =>
          setGlobalSearchDrawer({ kind: "customer", customer: c })
        }
        onSearchOpenProductDrawer={(sku: string, hintName?: string) =>
          setGlobalSearchDrawer({ kind: "product", sku, hintName })
        }
        onSearchOpenWeddingPartyCustomers={(partyQuery: string) =>
          setGlobalSearchDrawer({ kind: "wedding-party-customers", partyQuery })
        }
        onSearchOpenOrder={(transactionId: string) => {
          enterBackofficeShell("orders");
          onOpenTransactionInBackoffice(transactionId);
        }}
        onSearchOpenShipment={(shipmentId: string) =>
          setGlobalSearchDrawer({ kind: "shipment", shipmentId })
        }
        onSearchOpenWeddingParty={(partyId: string) => {
          setPosMode(false);
          setInsightsMode(false);
          navigateWedding(partyId);
        }}
        onSearchOpenAlteration={(alterationId: string) => {
          enterBackofficeShell("alterations");
          setAlterationsDeepLinkId(alterationId);
        }}
        searchVariant={posMode ? "pos" : "backoffice"}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
        isRegisterOpen={isRegisterOpen}
        onOpenHelp={() => {
          setHelpDrawerMode("browse");
          setHelpDrawerOpen(true);
        }}
        onOpenRosie={() => {
          setHelpDrawerMode("conversation");
          setHelpDrawerOpen(true);
        }}
        onOpenBugReport={() => setBugReportOpen(true)}
        onNavigateToTab={(tab, section) => {
          if (tab === "dashboard") {
            enterInsightsShell();
            if (section) {
              setActiveSubSection(section);
            }
            return;
          }
          if (tab === "weddings") {
            setPosMode(false);
            setWeddingMode(true);
            setInsightsMode(false);
            setActiveTab("weddings");
            if (section) {
              setActiveSubSection(section);
            }
            return;
          }
          if (tab === "register") {
            navigateRegister();
            if (section) {
              setActiveSubSection(section);
            }
            return;
          }
          if (posMode && POS_SHELL_TABS.has(tab)) {
            setActiveTab(tab);
            if (section) {
              setActiveSubSection(section);
            }
            return;
          }
          enterBackofficeShell(tab, section);
        }}
        themeMode={themeMode}
        onThemeToggle={() =>
          setThemeMode(themeMode === "light" ? "dark" : "light")
        }
        cashierName={cashierName}
        cashierAvatarKey={cashierAvatarKey}
      />
      {content}
    </div>
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
  }, [
    insightsMode,
    permissionsLoaded,
    hasPermission,
    setInsightsMode,
    setActiveTab,
  ]);
  return null;
}

type AppMainColumnProps = {
  activeTab: SidebarTabId;
  setActiveTab: (t: SidebarTabId) => void;
  activeSubSection: string;
  setActiveSubSection: (id: string) => void;
  onWorkspaceClick: () => void;
  navigateRegister: () => void;
  navigateWedding: (partyId?: string | null) => void;
  pendingWmPartyId: string | null;
  onClearPendingWmPartyId: () => void;
  setPendingPosCustomer: (c: Customer | null) => void;
  setPendingPosTransactionId: (orderId: string | null) => void;
  transactionsDeepLinkTxnId: string | null;
  onTransactionsDeepLinkConsumed: () => void;
  onOpenTransactionInBackoffice: (orderId: string) => void;
  setGlobalSearchDrawer: (s: GlobalSearchDrawerState | null) => void;
  globalSearchDrawer: GlobalSearchDrawerState | null;
  cashierName: string | null;
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
  appointmentsDeepLinkId: string | null;
  setAppointmentsDeepLinkId: (id: string | null) => void;
  staffTasksFocusInstanceId: string | null;
  onStaffTasksFocusConsumed: () => void;
  customersMessagingFocusCustomerId: string | null;
  customersMessagingFocusHubTab: string | null;
  onCustomersMessagingFocusConsumed: () => void;
  onOpenCustomerHubFromInbox: (customer: Customer) => void;
  onOpenMetabaseExplore: () => void;
  onNavigateRegisterReports: (transactionId?: string) => void;
  onNavigateCommissionPayouts: () => void;
  registerReportsDeepLinkTxnId: string | null;
  setRegisterReportsDeepLinkTxnId: (id: string | null) => void;
  bugReportsDeepLinkId: string | null;
  setBugReportsDeepLinkId: (id: string | null) => void;
};

function AppMainColumn({
  activeTab,
  setActiveTab,
  activeSubSection,
  setActiveSubSection,
  onWorkspaceClick,
  navigateRegister,
  navigateWedding,
  pendingWmPartyId,
  onClearPendingWmPartyId,
  setPendingPosCustomer,
  setPendingPosTransactionId,
  transactionsDeepLinkTxnId,
  onTransactionsDeepLinkConsumed,
  onOpenTransactionInBackoffice,
  setGlobalSearchDrawer,
  globalSearchDrawer,
  cashierName,
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
  appointmentsDeepLinkId,
  setAppointmentsDeepLinkId,
  staffTasksFocusInstanceId,
  onStaffTasksFocusConsumed,
  customersMessagingFocusCustomerId,
  customersMessagingFocusHubTab,
  onCustomersMessagingFocusConsumed,
  onOpenCustomerHubFromInbox,
  onOpenMetabaseExplore,
  onNavigateRegisterReports,
  onNavigateCommissionPayouts,
  registerReportsDeepLinkTxnId,
  setRegisterReportsDeepLinkTxnId,
  bugReportsDeepLinkId,
  setBugReportsDeepLinkId,
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
  }, [
    activeTab,
    hasPermission,
    permissionsLoaded,
    setActiveTab,
    setInsightsMode,
  ]);

  useEffect(() => {
    if (!permissionsLoaded) return;
    const subs = SIDEBAR_SUB_SECTIONS[activeTab];
    if (!subs?.length) return;
    if (
      activeTab === "inventory" &&
      INVENTORY_SECTION_KEYS.has(activeSubSection) &&
      subSectionVisible(
        activeTab,
        activeSubSection,
        hasPermission,
        permissionsLoaded,
      )
    ) {
      return;
    }
    const isValidAndVisible = subs.some(
      (s) =>
        s.id === activeSubSection &&
        subSectionVisible(activeTab, s.id, hasPermission, permissionsLoaded),
    );
    if (isValidAndVisible) return;
    const first =
      subs.find((s) =>
        subSectionVisible(activeTab, s.id, hasPermission, permissionsLoaded),
      ) ?? subs[0];
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

  return (
    <div
      role="presentation"
      className={`relative flex min-w-0 flex-1 flex-col ${activeTab === "register" || activeTab === "customers" || activeTab === "alterations" || activeTab === "orders" ? "density-compact" : "density-standard"}`}
      onClick={onWorkspaceClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          onWorkspaceClick();
        }
      }}
    >
      {globalSearchDrawer ? (
        <Suspense fallback={null}>
          <GlobalSearchDrawerHost
            state={globalSearchDrawer}
            onClose={() => setGlobalSearchDrawer(null)}
            onOpenWeddingParty={(id: string) => {
              navigateWedding(id);
            }}
            onUseCustomerInRegister={(c) => setPendingPosCustomer(c)}
            onNavigateRegister={navigateRegister}
            onAddCustomerToWedding={() => {
              navigateWedding();
            }}
            onBookCustomerAppointment={() => setActiveTab("appointments")}
            onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
          />
        </Suspense>
      ) : null}
      <div className={`relative flex flex-1 flex-col ${activeTab === "alterations" ? "p-2 sm:p-4" : "p-0"}`}>
        <div
          className={`relative flex flex-1 flex-col bg-app-bg transition-all duration-300 ease-standard ${activeTab === "alterations" ? "rounded-2xl border border-app-border shadow-[0_10px_28px_-22px_rgba(20,20,20,0.2)] lg:min-h-0 lg:overflow-hidden" : ""} ${canvasRecessed ? "origin-top shadow-[0_16px_40px_-24px_rgba(20,20,20,0.28)]" : ""}`}
        >
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm font-semibold text-app-text-muted">
                Loading workspace…
              </div>
            }
          >
            <div
              key={activeTab}
              className={`workspace-snap flex flex-1 flex-col ${activeTab === "alterations" ? "lg:min-h-0 lg:overflow-hidden" : ""}`}
            >
              {(() => {
                if (activeTab === "home")
                  return (
                    <OperationalHome
                      refreshSignal={refreshSignal}
                      activeSection={activeSubSection}
                      onOpenWeddingParty={(id) => {
                        navigateWedding(id);
                      }}
                      onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
                      onNavigateMetric={(target) => {
                        setActiveTab(target.tab);
                        if (target.section) {
                          setActiveSubSection(target.section);
                        }
                      }}
                      onOpenInboxCustomer={onOpenCustomerHubFromInbox}
                      registerReportsDeepLinkTxnId={
                        registerReportsDeepLinkTxnId
                      }
                      onRegisterReportsDeepLinkTxnConsumed={() =>
                        setRegisterReportsDeepLinkTxnId(null)
                      }
                    />
                  );
                if (activeTab === "inventory")
                  return (
                    <InventoryWorkspace
                      activeSection={activeSubSection}
                      procurementDeepLinkPoId={procurementDeepLinkPoId}
                      onProcurementDeepLinkConsumed={
                        onProcurementDeepLinkConsumed
                      }
                      openProductHubProductId={inventoryProductHubProductId}
                      onProductHubDeepLinkConsumed={
                        onInventoryProductHubConsumed
                      }
                    />
                  );
                if (activeTab === "orders")
                  return (
                    <OrdersWorkspace
                      activeSection={activeSubSection}
                      refreshSignal={refreshSignal}
                      deepLinkTxnId={transactionsDeepLinkTxnId}
                      onDeepLinkTxnConsumed={onTransactionsDeepLinkConsumed}
                      onOpenInRegister={(orderId) => {
                        setPendingPosTransactionId(orderId);
                        navigateRegister();
                      }}
                    />
                  );
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
                      onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
                      messagingFocusCustomerId={
                        customersMessagingFocusCustomerId
                      }
                      messagingFocusHubTab={
                        customersMessagingFocusHubTab ?? undefined
                      }
                      onMessagingFocusConsumed={
                        onCustomersMessagingFocusConsumed
                      }
                    />
                  );
                if (activeTab === "alterations")
                  return (
                    <AlterationsWorkspace
                      highlightAlterationId={alterationsDeepLinkId}
                      onHighlightConsumed={onAlterationsDeepLinkConsumed}
                    />
                  );
                if (activeTab === "weddings")
                  return (
                    <WeddingManagerApp
                      rosActorName={cashierName}
                      initialPartyId={pendingWmPartyId}
                      onInitialPartyConsumed={onClearPendingWmPartyId}
                    />
                  );
                if (activeTab === "appointments")
                  return (
                    <SchedulerWorkspace
                      activeSection={activeSubSection}
                      deepLinkAppointmentId={appointmentsDeepLinkId}
                      onDeepLinkAppointmentConsumed={() =>
                        setAppointmentsDeepLinkId(null)
                      }
                    />
                  );
                if (activeTab === "register")
                  return (
                    <div className="flex flex-1 flex-col items-center justify-center bg-app-bg p-12 text-center">
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
                        className={`group relative flex min-h-[52px] touch-manipulation items-center gap-4 rounded-full px-8 py-5 text-[11px] font-black uppercase tracking-[0.2em] transition-all active:scale-95 shadow-[0_20px_40px_-12px_rgba(0,0,0,0.3)] hover:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] sm:min-h-14 sm:px-10 ${isRegisterOpen ? "bg-app-accent text-white" : "bg-app-text text-app-surface"}`}
                      >
                        <span className="relative z-10">
                          {isRegisterOpen ? "Return to POS" : "Enter POS"}
                        </span>
                        <div
                          className={`flex h-8 w-8 items-center justify-center rounded-full transition-transform group-hover:translate-x-1 ${isRegisterOpen ? "bg-white text-app-accent" : "bg-app-accent text-white"}`}
                        >
                          <ArrowRight size={16} />
                        </div>
                      </button>
                    </div>
                  );
                if (activeTab === "gift-cards")
                  return (
                    <GiftCardsWorkspace activeSection={activeSubSection} />
                  );
                if (activeTab === "loyalty")
                  return <LoyaltyWorkspace activeSection={activeSubSection} />;
                if (activeTab === "reports") {
                  return (
                    <ReportsWorkspace
                      onOpenMetabaseExplore={onOpenMetabaseExplore}
                      onNavigateRegisterReports={onNavigateRegisterReports}
                      onNavigateCommissionPayouts={onNavigateCommissionPayouts}
                    />
                  );
                }
                if (
                  activeTab === "staff" &&
                  activeSubSection === "commission-manager"
                ) {
                  return <CommissionManagerWorkspace />;
                }
                if (activeTab === "dashboard") {
                  return (
                    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm text-app-text-muted">
                      <p>
                        Open Insights from the sidebar to load Metabase in full
                        view.
                      </p>
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
                        activeSection={activeSubSection}
                        bugReportsDeepLinkId={bugReportsDeepLinkId}
                        onBugReportsDeepLinkConsumed={() =>
                          setBugReportsDeepLinkId(null)
                        }
                        onNavigateToTab={setActiveSubSection}
                      />
                  );

                return (
                  <div className="flex flex-1 items-center justify-center p-8 text-center font-medium text-app-text-muted">
                    <p>
                      <span className="font-semibold text-app-text">
                        {activeTab}
                      </span>{" "}
                      module coming soon.
                    </p>
                  </div>
                );
              })()}
            </div>
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export default App;
