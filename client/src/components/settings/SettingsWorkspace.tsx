import { getBaseUrl } from "../../lib/apiConfig";


import {
  createElement,
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import {
  ChevronRight,
  BookOpen,
  Code2,
  Database,
  FileText,
  Trash2,
  Download,
  Play,
  RefreshCw,
  CheckCircle2,
  History,
  Gauge,
  Cloud,
  Info,
  Mail,
  MapPin,
  Monitor,
  Plug,
  Printer,
  ReceiptText,
  Server,
  ShieldCheck,
  ShieldAlert,
  Save,
  SlidersHorizontal,
  Store,
  Tags,
  UserCircle,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import { downloadBinaryFile } from "../../lib/desktopFileBridge";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { subSectionVisible } from "../../context/BackofficeAuthPermissions";

import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import OnlineStoreConfigPanel from "./OnlineStoreConfigPanel";
import HelpCenterSettingsPanel from "./HelpCenterSettingsPanel";
import CounterpointSyncSettingsPanel from "./CounterpointSyncSettingsPanel";
import StationNetworkPanel from "./StationNetworkPanel";
import { StaffRoleAccessPanel } from "../staff/StaffAccessPanels";
import StaffDiscountCapsPanel from "../staff/StaffDiscountCapsPanel";
import InsightsSettingsPanel from "./InsightsSettingsPanel";

import NuorderSettingsPanel from "./NuorderSettingsPanel";
import GeoapifySettingsPanel from "./GeoapifySettingsPanel";
import WeatherSettingsPanel from "./WeatherSettingsPanel";
import PodiumSettingsPanel from "./PodiumSettingsPanel";
import EmailSettingsPanel from "./EmailSettingsPanel";
import MeilisearchSettingsPanel from "./MeilisearchSettingsPanel";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import QuickBooksSettingsPanel from "./QuickBooksSettingsPanel";
import ConstantContactSettingsPanel from "./ConstantContactSettingsPanel";
import ShippoSettingsPanel from "./ShippoSettingsPanel";
import HelcimSettingsPanel from "./HelcimSettingsPanel";
import FalSettingsPanel from "./FalSettingsPanel";
import IntegrationBrandLogo, { type IntegrationBrand } from "../ui/IntegrationBrandLogo";
import RosieIcon from "../common/RosieIcon";
import DailyFinancialReportPanel from "./DailyFinancialReportPanel";
import RemoteAccessPanel from "./RemoteAccessPanel";
import RegisterSettings from "../pos/RegisterSettings";
import StaffProfilePanel from "./StaffProfilePanel";
import RosOperationsCenter, {
  type OperationsCenterNavigateTarget,
} from "../operations/RosOperationsCenter";
import RosDevCenterPanel from "./RosDevCenterPanel";
import RosieSettingsPanel from "./RosieSettingsPanel";
import { SIDEBAR_SUB_SECTIONS } from "../layout/sidebarSections";



const ReceiptBuilderPanel = lazy(() => import("./ReceiptBuilderPanel"));
const TagDesignerPanel = lazy(() => import("./TagDesignerPanel"));
const PrintersAndScannersPanel = lazy(() => import("./PrintersAndScannersPanel"));

export interface ReceiptConfig {
  store_name: string;
  show_address: boolean;
  show_phone: boolean;
  show_email: boolean;
  show_loyalty_earned: boolean;
  show_loyalty_balance: boolean;
  show_barcode: boolean;
  header_lines: string[];
  footer_lines: string[];
  timezone?: string;
  receipt_studio_project_json?: unknown;
  receipt_studio_exported_html?: string | null;
  receipt_thermal_mode?: string;
  receiptline_template?: string | null;
}

export interface BackupSettings {
  auto_cleanup_days: number;
  schedule_cron: string;
  cloud_storage_enabled: boolean;
  cloud_bucket_name: string;
  cloud_region: string;
  cloud_endpoint: string;
  cloud_provider?: string;
  cloud_root?: string;
  replication_targets?: string[];
  encryption_enabled?: boolean;
  backup_dir?: string;
  backup_dir_configured?: boolean;
  backup_dir_explicit_required?: boolean;
}

interface BackupFile {
  filename: string;
  size_bytes: number;
  created_at: string;
}





interface SettingsWorkspaceProps {
  activeSection?: string;
  settingsActiveSection?: string;
  mode?: "backoffice" | "pos";
  bugReportsDeepLinkId?: string | null;
  onBugReportsDeepLinkConsumed?: () => void;
  onOpenQbo?: () => void;
  onSettingsSectionNavigate?: (sectionId: string) => void;
  onNavigateOperationsTarget?: (target: OperationsCenterNavigateTarget) => void;
  onNavigateCustomers?: (section?: string) => void;
  // POS Specific
  posSessionId?: string | null;
  posCashierCode?: string | null;
  posLifecycleStatus?: string | null;
  onPosRefreshMeta?: () => Promise<void>;
  onNavigateToTab?: (tab: string) => void;
  onOpenOnlineStore?: () => void;
}

type IntegrationCardItem = {
  id: string;
  label: string;
  desc: string;
  color: string;
  icon?: LucideIcon;
  brand?: IntegrationBrand;
  brandKind?: "icon" | "wordmark";
};

type SettingsHubLink = {
  id: string;
  label: string;
  description: string;
  brand?: IntegrationBrand;
  icon: LucideIcon;
};

type SettingsHubGroup = {
  id: string;
  label: string;
  links: SettingsHubLink[];
};

const SETTINGS_HUB_DESCRIPTIONS: Record<string, string> = {
  profile: "Your staff profile, contact details, PIN, and notification preferences.",
  "staff-access-defaults": "Role templates, default access, and discount caps.",
  "online-store": "Storefront publishing, product exposure, and customer checkout setup.",
  printing: "Printers, scanners, labels, test tools, and workstation hardware.",
  "receipt-builder": "Receipt layout, branding, barcode, and delivery settings.",
  "tag-designer": "Merchandise tag layout and printing templates.",
  register: "Terminal overrides, register feedback, and lane device preferences.",
  "station-network": "Server connection, LAN IPs for registers and PWA devices, and network diagnostics.",
  backups: "Local snapshots, backup retention, restore tools, and maintenance tasks.",
  "daily-financial-report": "Automated daily financial summary, email delivery, and report archive.",
  "remote-access": "Remote support access and workstation connectivity.",
  updates: "App updates, PWA refresh, and server update steps.",
  integrations: "Overview cards for connected services and integration setup.",
  podium: "Podium messaging, review invites, and communication readiness.",
  email: "IONOS mailbox setup, automated email, inbox sync, and staff signatures.",
  shippo: "Shipping account setup, carrier rates, and label configuration.",
  helcim: "Helcim payments, terminal readiness, and card processing setup.",
  fal: "Fal.ai API key configuration, credit balance, and image queue logs.",
  quickbooks: "QuickBooks connection settings and accounting bridge controls.",
  "constant-contact": "Sync opted-in customer lists and map group codes to Constant Contact lists.",
  counterpoint: "Counterpoint sync status, mappings, staging, and issue handling.",
  nuorder: "NuORDER catalog and vendor sync configuration.",
  geoapify: "Address lookup setup for customer, vendor, and shipping entry.",
  weather: "Weather provider settings for store planning signals.",
  insights: "Reporting and Metabase launch configuration.",
  meilisearch: "Search index health, reindex controls, and diagnostics.",
  "help-center": "Help Center content, manuals, and staff guidance publishing.",
  rosie: "ROSIE assistant settings and runtime behavior.",
  "ros-operations-center": "Heartbeats, alerts, bug tracking, integrations, updates, operational readiness, and support snapshot.",
  "ros-dev-center": "Developer operations, runtime health, and guarded actions.",
};

const SETTINGS_HUB_GROUP_ORDER = [
  "settings-group-store-setup",
  "settings-group-register-setup",
  "settings-group-maintenance",
  "settings-group-system-support",
  "settings-group-integrations",
];

const SETTINGS_HUB_INTEGRATION_BRANDS: Partial<
  Record<string, IntegrationBrand>
> = {
  podium: "podium",
  shippo: "shippo",
  helcim: "helcim",
  quickbooks: "qbo",
  "constant-contact": "constant_contact",
  nuorder: "nuorder",
  weather: "weather",
  insights: "metabase",
  meilisearch: "meilisearch",
};

const SETTINGS_HUB_ICONS: Record<string, LucideIcon> = {
  profile: UserCircle,
  "staff-access-defaults": ShieldCheck,
  "online-store": Store,
  printing: Printer,
  "receipt-builder": ReceiptText,
  "tag-designer": Tags,
  register: SlidersHorizontal,
  "station-network": Wifi,
  backups: Database,
  "daily-financial-report": FileText,
  "remote-access": Wifi,
  updates: RefreshCw,
  integrations: Plug,
  podium: Plug,
  email: Mail,
  shippo: Plug,
  helcim: Plug,
  quickbooks: Plug,
  "constant-contact": Mail,
  counterpoint: Server,
  nuorder: Plug,
  geoapify: MapPin,
  weather: Plug,
  insights: Plug,
  meilisearch: Plug,
  fal: Info,
  "help-center": BookOpen,
  rosie: Info,
  "ros-operations-center": ShieldAlert,
  "ros-dev-center": Code2,
};

const POS_ALLOWED_SETTINGS = new Set(["profile", "printing"]);

export default function SettingsWorkspace({
  activeSection,
  settingsActiveSection,
  mode = "backoffice",
  bugReportsDeepLinkId,
  onBugReportsDeepLinkConsumed,
  onOpenQbo,
  onSettingsSectionNavigate,
  onNavigateOperationsTarget,
  onNavigateCustomers,
  posSessionId,
  posCashierCode,
  posLifecycleStatus,
  onPosRefreshMeta,
  onNavigateToTab,
  onOpenOnlineStore,
}: SettingsWorkspaceProps) {
  const baseUrl = getBaseUrl();

  // Navigation - synced with sidebar activeSection; default to profile
  const requestedActiveTab = activeSection || settingsActiveSection || "hub";
  let activeTab =
    requestedActiveTab.startsWith("settings-group-") ||
    requestedActiveTab === "general"
      ? "hub"
      : requestedActiveTab;
  // POS mode restricts settings to Profile and Printers & Scanners only
  if (mode === "pos" && !POS_ALLOWED_SETTINGS.has(activeTab)) {
    activeTab = "profile";
  }
  const navigateToTab = onNavigateToTab ?? onSettingsSectionNavigate;
  const navigateOperationsTarget = useCallback(
    (target: OperationsCenterNavigateTarget) => {
      if (target.tab === "settings") {
        navigateToTab?.(target.section ?? "ros-operations-center");
        return;
      }
      onNavigateOperationsTarget?.(target);
    },
    [navigateToTab, onNavigateOperationsTarget],
  );

  // Settings State
  const [backupCfg, setBackupCfg] = useState<BackupSettings | null>(null);
  const [busy, setBusy] = useState(false);

  // Database State
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  const [restoreConfirmFile, setRestoreConfirmFile] = useState<string | null>(
    null,
  );
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<string | null>(
    null,
  );
  const { toast } = useToast();
  const {
    backofficeHeaders,
    hasPermission,
    permissionsLoaded,
  } = useBackofficeAuth();

  const settingsHubGroups = useMemo(() => {
    const groups: SettingsHubGroup[] = [];
    let currentGroup: SettingsHubGroup | null = null;

    for (const section of SIDEBAR_SUB_SECTIONS.settings) {
      if (section.kind === "group") {
        currentGroup = { id: section.id, label: section.label, links: [] };
        groups.push(currentGroup);
        continue;
      }
      if (section.id === "hub") continue;
      if (mode === "pos" && !POS_ALLOWED_SETTINGS.has(section.id)) {
        continue;
      }
      if (
        !subSectionVisible(
          "settings",
          section.id,
          hasPermission,
          permissionsLoaded,
        )
      ) {
        continue;
      }
      if (!currentGroup) {
        currentGroup = {
          id: "settings-group-general",
          label: "Settings",
          links: [],
        };
        groups.push(currentGroup);
      }
      currentGroup.links.push({
        id: section.id,
        label: section.label,
        description:
          SETTINGS_HUB_DESCRIPTIONS[section.id] ??
          "Open this settings workspace.",
        brand: SETTINGS_HUB_INTEGRATION_BRANDS[section.id],
        icon: SETTINGS_HUB_ICONS[section.id] ?? Info,
      });
    }

    return groups
      .filter((group) => group.links.length > 0)
      .sort((a, b) => {
        const aIndex = SETTINGS_HUB_GROUP_ORDER.indexOf(a.id);
        const bIndex = SETTINGS_HUB_GROUP_ORDER.indexOf(b.id);
        return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
      });
  }, [hasPermission, permissionsLoaded, mode]);

  const fetchBackups = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/backups`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) setBackups((await res.json()) as BackupFile[]);
    } catch (e) {
      console.error("Failed to fetch backups", e);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchBackupSettings = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/backup/config`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) setBackupCfg((await res.json()) as BackupSettings);
    } catch (err) {
      console.error("Failed to fetch backup settings", err);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchBackups();
    void fetchBackupSettings();
  }, [
    baseUrl,
    backofficeHeaders,
    fetchBackups,
    fetchBackupSettings,
  ]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [activeTab]);

  const saveBackupSettings = async () => {
    if (!backupCfg) return;
    const payload = {
      auto_cleanup_days: backupCfg.auto_cleanup_days,
      schedule_cron: backupCfg.schedule_cron,
      cloud_storage_enabled: backupCfg.cloud_storage_enabled,
      cloud_bucket_name: backupCfg.cloud_bucket_name,
      cloud_region: backupCfg.cloud_region,
      cloud_endpoint: backupCfg.cloud_endpoint,
      cloud_provider: backupCfg.cloud_provider ?? "s3",
      cloud_root: backupCfg.cloud_root ?? "",
      replication_targets: backupCfg.replication_targets ?? [],
      encryption_enabled: backupCfg.encryption_enabled ?? false,
    };
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/backup/config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setBackupCfg((await res.json()) as BackupSettings);
        toast("Backup settings saved", "success");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBackup = async () => {
    setBackupBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/backups/create`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        await fetchBackups();
      }
    } finally {
      setBackupBusy(false);
    }
  };

  const handleDeleteBackup = (filename: string) => {
    setDeleteConfirmFile(filename);
  };

  const executeDeleteBackup = async () => {
    if (!deleteConfirmFile) return;
    const filename = deleteConfirmFile;
    setDeleteConfirmFile(null);
    try {
      const res = await fetch(`${baseUrl}/api/settings/backups/${filename}`, {
        method: "DELETE",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        setBackups((prev) => prev.filter((b) => b.filename !== filename));
        toast("Backup snapshot deleted", "success");
      }
    } catch (e) {
      console.error(e);
      toast("Deletion failed", "error");
    }
  };

  const handleRestoreBackup = async (filename: string) => {
    setBackupBusy(true);
    setRestoreConfirmFile(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/backups/restore/${filename}`,
        {
          method: "POST",
          headers: {
            ...(backofficeHeaders() as Record<string, string>),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ confirmation_filename: filename }),
        },
      );
      if (res.ok) {
        toast("Restore successful. Application reloading...", "success");
        setTimeout(() => window.location.reload(), 1500);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Restore failed. Check server logs.", "error");
      }
    } finally {
      setBackupBusy(false);
    }
  };

  const handleOptimize = async () => {
    setOptimizeBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/database/optimize`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        toast("Database optimized successfully", "success");
      }
    } finally {
      setOptimizeBusy(false);
    }
  };

  const downloadBackupFile = async (filename: string) => {
    try {
      const enc = encodeURIComponent(filename);
      const res = await fetch(
        `${baseUrl}/api/settings/backups/download/${enc}`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (!res.ok) {
        toast("Could not download backup", "error");
        return;
      }
      const bytes = new Uint8Array(await (await res.blob()).arrayBuffer());
      await downloadBinaryFile(filename, bytes, "application/octet-stream", [
        { name: "Backup", extensions: ["dump", "enc", "zip"] },
      ]);
    } catch {
      toast("Could not download backup", "error");
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const getDailyBackupTime = (schedule: string) => {
    const parts = schedule.split(" ");
    return { hour: parts[1] || "02", minute: parts[0] || "00" };
  };

  const setDailyBackupTime = (hour: string, minute: string) => {
    if (!backupCfg) return;
    setBackupCfg({ ...backupCfg, schedule_cron: `${minute} ${hour} * * *` });
  };

  return (
    <div className="flex flex-1 flex-col bg-app-bg">
      <div className="flex flex-1">
        {/* Content Area - Full Workspace */}
        <main className="flex-1 scroll-smooth">
          <div
            data-testid="settings-workspace-content"
            className="w-full animate-in fade-in slide-in-from-bottom-4 p-4 duration-500 sm:p-6 lg:p-10"
          >
            {activeTab === "hub" && (
              <div className="space-y-8">
                <header className="max-w-5xl">
                  <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                    Settings Hub
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                    Start here for store setup, register hardware, maintenance,
                    integrations, and system support.
                  </p>
                </header>

                <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                  {settingsHubGroups.map((group) => {
                    const isIntegrationsGroup =
                      group.id === "settings-group-integrations";

                    return (
                      <section
                        key={group.id}
                        className={`ui-card p-5 sm:p-6 ${
                          isIntegrationsGroup ? "xl:col-span-2" : ""
                        }`}
                      >
                        <div className="mb-5 flex items-center justify-between gap-3 border-b border-app-border pb-4">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-app-text-muted">
                              Settings
                            </p>
                            <h3 className="mt-1 text-lg font-black uppercase tracking-tight text-app-text">
                              {group.label}
                            </h3>
                          </div>
                          <span className="rounded-full border border-app-border bg-app-bg px-3 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {group.links.length}
                          </span>
                        </div>

                        <div
                          className={`grid grid-cols-1 gap-3 ${
                            isIntegrationsGroup
                              ? "md:grid-cols-2 xl:grid-cols-3"
                              : ""
                          }`}
                        >
                          {group.links.map((link) => (
                            <button
                              key={link.id}
                              type="button"
                              onClick={() => navigateToTab?.(link.id)}
                              className="group flex min-h-24 w-full items-center gap-4 rounded-xl border border-app-border bg-app-surface/60 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:bg-app-surface hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30"
                            >
                              <span
                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border text-xs font-black uppercase text-app-accent ${
                                  link.brand ? "bg-app-surface p-1.5" : "bg-app-bg"
                                } ${link.brand === "helcim" ? "overflow-hidden" : ""}`}
                              >
                                {link.brand ? (
                                  <IntegrationBrandLogo
                                    brand={link.brand}
                                    kind="icon"
                                    alt={link.label}
                                    className="inline-flex h-full w-full items-center justify-center"
                                    imageClassName={
                                      link.brand === "helcim"
                                        ? "h-full w-auto max-w-none rounded-md object-cover"
                                        : "max-h-full max-w-full rounded-md object-contain"
                                    }
                                  />
                                ) : link.id === "rosie" || link.id === "fal" ? (
                                  <RosieIcon size={22} alt="" />
                                ) : (
                                  createElement(link.icon, {
                                    size: 20,
                                    strokeWidth: 2.25,
                                    "aria-hidden": true,
                                  })
                                )}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-sm font-black uppercase tracking-wide text-app-text">
                                  {link.label}
                                </span>
                                <span className="mt-1 block text-xs font-medium leading-relaxed text-app-text-muted">
                                  {link.description}
                                </span>
                              </span>
                              <ChevronRight
                                className="shrink-0 text-app-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-app-accent"
                                size={18}
                                aria-hidden
                              />
                            </button>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === "profile" && (
              <StaffProfilePanel />
            )}

            {activeTab === "backups" && (
              <div className="space-y-12">
                <header className="mb-10">
                  <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                    Data Lifecycle & Backups
                  </h2>
                  <p className="text-sm text-app-text-muted mt-2 font-medium">
                    Create backups, verify storage, and keep database maintenance
                    clear.
                  </p>
                </header>

                <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
                  <div className="xl:col-span-8 space-y-10">
                    {/* Backups Section */}
                    <section className="ui-card overflow-hidden">
                      <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface/30">
                        <div className="flex items-center gap-3">
                          <History className="w-5 h-5 text-app-accent" />
                          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                            Local Snapshots
                          </h3>
                        </div>
                        <button
                          onClick={handleCreateBackup}
                          disabled={backupBusy}
                          className="h-10 px-6 rounded-xl bg-app-text text-white text-[10px] font-black uppercase tracking-widest hover:bg-black/80 disabled:opacity-50 transition-all flex items-center gap-2"
                        >
                          {backupBusy ? (
                            <RefreshCw className="w-3 h-3 animate-spin" />
                          ) : (
                            <Database className="w-3 h-3 text-app-accent" />
                          )}
                          Create Backup
                        </button>
                      </div>

                      {backupCfg && (
                        <div className="border-b border-app-border bg-app-bg/35 px-6 py-4">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Backup Directory
                              </p>
                              <p className="mt-1 truncate font-mono text-xs font-bold text-app-text">
                                {backupCfg.backup_dir || "backups"}
                              </p>
                            </div>
                            <span
                              className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest ${
                                backupCfg.backup_dir_configured
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                  : backupCfg.backup_dir_explicit_required
                                    ? "border-red-500/30 bg-red-500/10 text-red-600"
                                    : "border-amber-500/30 bg-amber-500/10 text-amber-600"
                              }`}
                            >
                              {backupCfg.backup_dir_configured
                                ? "Custom Path"
                                : backupCfg.backup_dir_explicit_required
                                  ? "Required"
                                  : "Default Path"}
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="overflow-x-auto">
                        <table className="w-full text-left">
                          <thead>
                            <tr className="bg-app-bg/50 text-[10px] uppercase font-black tracking-widest text-app-text-muted border-b border-app-border">
                              <th className="px-6 py-3">Snapshot Name</th>
                              <th className="px-6 py-3">Size</th>
                              <th className="px-6 py-3 text-right">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-app-border">
                            {backups.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={3}
                                  className="px-6 py-12 text-center text-sm text-app-text-muted font-bold italic"
                                >
                                  No snapshots found.
                                </td>
                              </tr>
                            ) : (
                              backups.map((b: BackupFile) => (
                                <tr
                                  key={b.filename}
                                  className="hover:bg-app-surface/20 transition-colors group"
                                >
                                  <td className="px-6 py-4">
                                    <div className="flex items-center gap-3">
                                      <div className="p-2 rounded bg-app-bg text-app-accent group-hover:scale-110 transition-transform">
                                        <Database size={14} />
                                      </div>
                                      <span className="font-mono text-xs font-bold text-app-text">
                                        {b.filename}
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-6 py-4 text-xs font-black text-app-text-muted">
                                    {formatSize(b.size_bytes)}
                                  </td>
                                  <td className="px-6 py-4 text-right">
                                    <div className="flex items-center justify-end gap-1">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          void downloadBackupFile(b.filename)
                                        }
                                        className="p-2.5 rounded-lg hover:bg-app-text hover:text-white text-app-text-muted transition-all"
                                      >
                                        <Download size={14} />
                                      </button>
                                      <button
                                        onClick={() =>
                                          setRestoreConfirmFile(b.filename)
                                        }
                                        className="p-2.5 rounded-lg hover:bg-emerald-600 hover:text-white text-app-text-muted transition-all"
                                      >
                                        <Play size={14} />
                                      </button>
                                      <button
                                        onClick={() =>
                                          handleDeleteBackup(b.filename)
                                        }
                                        className="p-2.5 rounded-lg hover:bg-red-600 hover:text-white text-app-text-muted transition-all"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    {backupCfg && (
                      <section className="ui-card p-8 border-l-4 border-indigo-600">
                        <div className="flex items-center justify-between mb-8">
                          <div className="flex items-center gap-3">
                            <Cloud className="w-5 h-5 text-indigo-500" />
                            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                              Automation & Cloud Sync
                            </h3>
                          </div>
                          <button
                            onClick={saveBackupSettings}
                            disabled={busy}
                            className="ui-btn-primary py-2 px-4 text-[10px] font-black uppercase tracking-widest flex items-center gap-2"
                          >
                            <Save className="w-3 h-3" /> Update
                          </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                            <div className="space-y-4">
                            <label className="block">
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Retention Policy (Days)
                              </span>
                              <input
                                type="number"
                                value={backupCfg.auto_cleanup_days}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    auto_cleanup_days:
                                      parseInt(e.target.value) || 0,
                                  })
                                }
                                className="ui-input mt-2 w-full font-black text-lg"
                              />
                            </label>
                            <label className="block">
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Daily Backup Window
                              </span>
                              <div className="flex items-center gap-2 mt-2">
                                {(() => {
                                  const { hour, minute } = getDailyBackupTime(
                                    backupCfg.schedule_cron,
                                  );
                                  return (
                                    <>
                                      <input
                                        type="number"
                                        min={0}
                                        max={23}
                                        value={hour}
                                        onChange={(e) =>
                                          setDailyBackupTime(
                                            e.target.value.padStart(2, "0"),
                                            minute,
                                          )
                                        }
                                        className="ui-input w-24 text-center font-black text-lg"
                                      />
                                      <span className="font-black text-xl">
                                        :
                                      </span>
                                      <input
                                        type="number"
                                        min={0}
                                        max={59}
                                        value={minute}
                                        onChange={(e) =>
                                          setDailyBackupTime(
                                            hour,
                                            e.target.value.padStart(2, "0"),
                                          )
                                        }
                                        className="ui-input w-24 text-center font-black text-lg"
                                      />
                                    </>
                                  );
                                })()}
                              </div>
                            </label>
                          </div>
                          <div className="space-y-4">
                            <label className="flex items-center gap-3 cursor-pointer group mb-6">
                              <div
                                className={`relative inline-flex h-6 w-12 items-center rounded-full transition-colors ${backupCfg.cloud_storage_enabled ? "bg-indigo-600 shadow-lg shadow-indigo-500/30" : "bg-app-border"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={backupCfg.cloud_storage_enabled}
                                  onChange={(e) =>
                                    setBackupCfg({
                                      ...backupCfg,
                                      cloud_storage_enabled: e.target.checked,
                                    })
                                  }
                                  className="sr-only"
                                />
                                <span
                                  className={`inline-block h-4 w-4 transform rounded-full bg-app-surface shadow-sm transition-transform ${backupCfg.cloud_storage_enabled ? "translate-x-7" : "translate-x-1"}`}
                                />
                              </div>
                              <span className="text-xs font-black uppercase tracking-tight text-app-text group-hover:text-indigo-500 transition-colors">
                                Off-Site Storage
                              </span>
                            </label>
                            <div className="space-y-3 opacity-60">
                              <select
                                value={backupCfg.cloud_provider ?? "s3"}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    cloud_provider: e.target.value,
                                  })
                                }
                                className="ui-input w-full text-[11px] font-bold"
                                disabled={!backupCfg.cloud_storage_enabled}
                              >
                                <option value="s3">
                                  S3 / Backblaze / Cloudflare
                                </option>
                                <option value="onedrive">OneDrive</option>
                                <option value="google_drive">
                                  Google Drive
                                </option>
                                <option value="dropbox">Dropbox</option>
                              </select>
                              <input
                                placeholder="S3 Bucket"
                                value={backupCfg.cloud_bucket_name}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    cloud_bucket_name: e.target.value,
                                  })
                                }
                                className="ui-input w-full text-[11px] font-bold"
                                disabled={!backupCfg.cloud_storage_enabled}
                              />
                              <input
                                placeholder="Region"
                                value={backupCfg.cloud_region}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    cloud_region: e.target.value,
                                  })
                                }
                                className="ui-input w-full text-[11px] font-bold"
                                disabled={!backupCfg.cloud_storage_enabled}
                              />
                              <input
                                placeholder="Endpoint for S3-compatible storage"
                                value={backupCfg.cloud_endpoint}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    cloud_endpoint: e.target.value,
                                  })
                                }
                                className="ui-input w-full text-[11px] font-bold"
                                disabled={!backupCfg.cloud_storage_enabled}
                              />
                              <input
                                placeholder="Cloud folder path"
                                value={backupCfg.cloud_root ?? ""}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    cloud_root: e.target.value,
                                  })
                                }
                                className="ui-input w-full text-[11px] font-bold"
                                disabled={!backupCfg.cloud_storage_enabled}
                              />
                            </div>
                            <IntegrationCredentialsCard
                              baseUrl={baseUrl}
                              integrationKey="backups"
                              title="Cloud Backup Credentials"
                              description="Save the off-site storage access keys here. Backup jobs use the saved keys without staff editing server environment files."
                              fields={[
                                {
                                  key: "s3_access_key",
                                  label: "S3 access key",
                                  help: "Required when off-site storage is enabled.",
                                },
                                {
                                  key: "s3_secret_key",
                                  label: "S3 secret key",
                                  help: "Hidden after save.",
                                },
                                {
                                  key: "cloud_access_token",
                                  label: "Cloud access token",
                                  help: "For OneDrive, Google Drive, or Dropbox when using a short-lived token.",
                                },
                                {
                                  key: "cloud_refresh_token",
                                  label: "Cloud refresh token",
                                  help: "Preferred for OneDrive, Google Drive, or Dropbox automation.",
                                },
                                {
                                  key: "cloud_client_id",
                                  label: "Cloud client ID",
                                  help: "Required with a refresh token.",
                                },
                                {
                                  key: "cloud_client_secret",
                                  label: "Cloud client secret",
                                  help: "Required with refresh tokens for Dropbox and Google Drive; optional for some OneDrive app types.",
                                },
                              ]}
                            />
                            <label className="flex items-center gap-3 cursor-pointer group">
                              <div
                                className={`relative inline-flex h-6 w-12 items-center rounded-full transition-colors ${(backupCfg.encryption_enabled ?? false) ? "bg-emerald-600 shadow-lg shadow-emerald-500/20" : "bg-app-border"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={backupCfg.encryption_enabled ?? false}
                                  onChange={(e) =>
                                    setBackupCfg({
                                      ...backupCfg,
                                      encryption_enabled: e.target.checked,
                                    })
                                  }
                                  className="sr-only"
                                />
                                <span
                                  className={`inline-block h-4 w-4 transform rounded-full bg-app-surface shadow-sm transition-transform ${(backupCfg.encryption_enabled ?? false) ? "translate-x-7" : "translate-x-1"}`}
                                />
                              </div>
                              <span className="text-xs font-black uppercase tracking-tight text-app-text group-hover:text-emerald-600 transition-colors">
                                Encrypt Backup Archives
                              </span>
                            </label>
                            <p className="text-[10px] font-bold uppercase leading-relaxed text-app-text-muted opacity-70">
                              Requires RIVERSIDE_BACKUP_ENCRYPTION_KEY on the
                              server. Encrypted snapshots restore only when
                              that key is available.
                            </p>
                            <label className="block">
                              <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Replication Folders
                              </span>
                              <textarea
                                value={(backupCfg.replication_targets ?? []).join(
                                  "\n",
                                )}
                                onChange={(e) =>
                                  setBackupCfg({
                                    ...backupCfg,
                                    replication_targets: e.target.value
                                      .split(/\r?\n/)
                                      .map((line) => line.trim())
                                      .filter(Boolean),
                                  })
                                }
                                placeholder="One mounted or synced folder per line"
                                className="ui-input mt-2 min-h-28 w-full font-mono text-[11px] font-bold leading-relaxed"
                              />
                              <p className="mt-2 text-[10px] font-bold uppercase leading-relaxed text-app-text-muted opacity-70">
                                Use synced cloud folders, mapped drives, NAS
                                mounts, or external drives. Each copy is
                                verified after write.
                              </p>
                            </label>
                          </div>
                        </div>
                      </section>
                    )}
                  </div>

                  <div className="xl:col-span-4 space-y-10">
                    <section className="ui-card p-6 bg-app-accent/5 border-app-accent/20">
                      <div className="flex items-center gap-3 mb-6 font-black italic tracking-tighter uppercase">
                        <Gauge className="w-5 h-5 text-app-accent" />
                        <span>Optimization</span>
                      </div>
                      <div className="space-y-6">
                        <div>
                          <h4 className="text-xs font-black uppercase tracking-widest text-app-text mb-2">
                            Database Health
                          </h4>
                          <p className="text-[10px] text-app-text-muted leading-relaxed font-bold uppercase opacity-60">
                            Reclaims disk space and updates query planner stats.
                          </p>
                          <button
                            onClick={handleOptimize}
                            disabled={optimizeBusy}
                            className="mt-4 w-full h-12 rounded-xl bg-app-accent text-white font-black uppercase tracking-widest hover:bg-app-accent-hover transition-all active:scale-95 shadow-lg shadow-app-accent/30"
                          >
                            {optimizeBusy ? "Optimizing..." : "Optimize Now"}
                          </button>
                        </div>
                        <div className="pt-6 border-t border-app-border/40">
                          <h4 className="text-xs font-black uppercase tracking-widest text-app-text mb-2">
                            Integrity Check
                          </h4>
                          <div className="flex items-center gap-2 text-emerald-500 font-black italic uppercase tracking-tighter">
                            <CheckCircle2 size={16} />
                            <span>All Systems Active</span>
                          </div>
                        </div>
                      </div>
                    </section>
                  </div>
                </div>
              </div>
            )}

            {activeTab === "printing" && (
              <Suspense
                fallback={
                   <p className="text-sm font-medium text-app-text-muted">
                    Loading Printers & Scanners…
                  </p>
                }
              >
                <PrintersAndScannersPanel
                  mode={mode}
                  posSessionId={posSessionId}
                  posCashierCode={posCashierCode}
                />
              </Suspense>
            )}
            {activeTab === "register" && (
              <RegisterSettings
                sessionId={posSessionId}
                cashierCode={posCashierCode}
                lifecycleStatus={posLifecycleStatus}
                onRefreshMeta={onPosRefreshMeta}
              />
            )}
            {activeTab === "station-network" && (
              <div className="space-y-10">
                <StationNetworkPanel />
              </div>
            )}
            {activeTab === "integrations" && (
              <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <header className="mb-10">
                  <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                    Integrations & Hub
                  </h2>
                  <p className="text-sm text-app-text-muted mt-2 font-medium leading-relaxed">
                    Each integration is now managed via its own dedicated
                    sub-page for better control.
                  </p>
                </header>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
                  {([
                    {
                      id: "meilisearch",
                      label: "Meilisearch",
                      desc: "Meilisearch index health",
                      color: "bg-app-surface",
                      brand: "meilisearch" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "insights",
                      label: "Metabase Insights",
                      desc: "Enterprise reporting & SSO",
                      color: "bg-app-surface",
                      brand: "metabase" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "weather",
                      label: "Live Weather",
                      desc: "Visual Crossing snapshots",
                      color: "bg-app-surface",
                      brand: "weather" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "shippo",
                      label: "Shippo",
                      desc: "Carrier rates & labels",
                      color: "bg-app-surface",
                      brand: "shippo" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "podium",
                      label: "Podium Comms",
                      desc: "Lifecycle SMS & HTML Email",
                      color: "bg-app-surface",
                      brand: "podium" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "nuorder",
                      label: "NuORDER",
                      desc: "Retail catalog & sync",
                      color: "bg-app-surface",
                      brand: "nuorder" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "geoapify",
                      label: "Geoapify",
                      desc: "Address lookup",
                      color: "bg-app-surface",
                      icon: MapPin,
                    },
                    {
                      id: "quickbooks",
                      label: "QuickBooks Online",
                      desc: "Launch QBO Data Bridge",
                      color: "bg-app-surface",
                      brand: "qbo" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "helcim",
                      label: "Helcim Payments",
                      desc: "Card Processing Hub",
                      color: "bg-app-surface",
                      brand: "helcim" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "constant-contact",
                      label: "Constant Contact",
                      desc: "Mailing List & Segments Sync",
                      color: "bg-app-surface",
                      brand: "constant_contact" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "fal",
                      label: "Fal.ai",
                      desc: "Visual diffusion pipelines",
                      color: "bg-app-surface",
                    },
                  ] satisfies IntegrationCardItem[]).map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      onClick={() => navigateToTab?.(item.id)}
                      className="ui-card group flex flex-col items-center p-8 text-center transition-all hover:-translate-y-0.5"
                    >
                      <div
                        className={`w-16 h-16 ${item.color} text-white rounded-2xl flex items-center justify-center mb-6 shadow-xl shadow-black/10 group-hover:scale-110 transition-transform ring-1 ring-black/5`}
                      >
                        {"brand" in item && item.brand ? (
                          <IntegrationBrandLogo
                            brand={item.brand}
                            kind={item.brandKind}
                            className="inline-flex"
                            imageClassName="max-h-10 max-w-10 rounded-md object-contain"
                          />
                        ) : item.id === "fal" ? (
                          <RosieIcon size={28} alt="" />
                        ) : "icon" in item && item.icon ? (
                          createElement(item.icon as LucideIcon, { size: 28 })
                        ) : null}
                      </div>
                      <h3 className="text-sm font-black uppercase tracking-widest text-app-text mb-2">
                        {item.label}
                      </h3>
                      <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-wider">
                        {item.desc}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {activeTab === "staff-access-defaults" &&
              (hasPermission("settings.admin") ||
                hasPermission("staff.manage_access")) && (
                <div className="space-y-10">
                  <header className="mb-2">
                    <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                      Staff access defaults
                    </h2>
                    <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                      Role-wide templates used when onboarding or when you click{" "}
                      <strong className="text-app-text">
                        Apply role defaults
                      </strong>{" "}
                      on an individual profile in Staff → Team. Day-to-day
                      permissions and discount caps are stored per staff member.
                    </p>
                  </header>
                  <StaffRoleAccessPanel />
                  <StaffDiscountCapsPanel />
                </div>
              )}

            {activeTab === "counterpoint" &&
              hasPermission("settings.admin") && (
                <div className="space-y-10">
                  <header className="mb-2">
                    <div className="flex flex-wrap items-start gap-4">
                      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-orange-500/25 bg-gradient-to-br from-orange-500/15 to-transparent text-orange-600 dark:text-orange-400">
                        <Monitor className="h-7 w-7" aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1 space-y-2">
                        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                          Counterpoint
                        </h2>
                        <p className="text-sm font-medium text-app-text-muted leading-relaxed max-w-3xl">
                          The Windows bridge on your Counterpoint SQL host posts
                          catalog, customers, gift cards, and ticket history
                          into Riverside. Manage bridge health, staging and
                          apply queues, and Counterpoint-to-ROS code maps here —
                          not mixed in with unrelated integrations.
                        </p>
                        <p className="text-xs text-app-text-muted leading-relaxed max-w-3xl">
                          Install and operate the bridge per{" "}
                          <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                            docs/COUNTERPOINT_SYNC_GUIDE.md
                          </code>
                          . Save the bridge token in this workspace so staff do
                          not need server environment file access.
                        </p>
                      </div>
                    </div>
                  </header>

                  <CounterpointSyncSettingsPanel
                    onNavigateCustomers={onNavigateCustomers}
                  />
                </div>
              )}



            {activeTab === "remote-access" && (
              <div className="space-y-10">
                <header className="mb-2">
                  <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                    Remote Access
                  </h2>
                  <p className="mt-2 text-sm font-medium text-app-text-muted">
                    Configure Tailscale to connect to your store network
                    securely.
                  </p>
                </header>
                <section className="ui-card p-4 sm:p-6 lg:p-10">
                  <RemoteAccessPanel />
                </section>
              </div>
            )}

            {activeTab === "daily-financial-report" && hasPermission("settings.admin") && (
              <DailyFinancialReportPanel baseUrl={baseUrl} />
            )}

            {activeTab === "online-store" && (
              <OnlineStoreConfigPanel onOpenOnlineStore={onOpenOnlineStore} />
            )}

            {activeTab === "rosie" && <RosieSettingsPanel />}
            {activeTab === "help-center" && <HelpCenterSettingsPanel />}
            {activeTab === "ros-operations-center" &&
              hasPermission("ops.dev_center.view") && (
                <RosOperationsCenter
                  onNavigate={navigateOperationsTarget}
                  bugReportsDeepLinkId={bugReportsDeepLinkId}
                  onBugReportsDeepLinkConsumed={onBugReportsDeepLinkConsumed}
                />
              )}
            {activeTab === "ros-dev-center" &&
              hasPermission("ops.dev_center.view") && (
                <RosDevCenterPanel />
              )}

            {activeTab === "meilisearch" && hasPermission("settings.admin") && (
              <MeilisearchSettingsPanel />
            )}

            {activeTab === "nuorder" && hasPermission("settings.admin") && (
              <NuorderSettingsPanel />
            )}

            {activeTab === "geoapify" && hasPermission("settings.admin") && (
              <GeoapifySettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "insights" && hasPermission("settings.admin") && (
              <InsightsSettingsPanel />
            )}

            {activeTab === "weather" && hasPermission("settings.admin") && (
              <WeatherSettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "shippo" && hasPermission("settings.admin") && (
              <ShippoSettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "podium" && hasPermission("settings.admin") && (
              <PodiumSettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "email" && hasPermission("settings.admin") && (
              <EmailSettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "quickbooks" && hasPermission("settings.admin") && (
              <QuickBooksSettingsPanel
                onOpenQbo={() => {
                  if (onOpenQbo) {
                    onOpenQbo();
                    return;
                  }
                  navigateToTab?.("qbo");
                }}
              />
            )}

            {activeTab === "constant-contact" && hasPermission("constant_contact.manage") && (
              <ConstantContactSettingsPanel />
            )}

            {activeTab === "helcim" && hasPermission("settings.admin") && (
              <HelcimSettingsPanel />
            )}

            {activeTab === "fal" && hasPermission("settings.admin") && (
              <FalSettingsPanel baseUrl={baseUrl} />
            )}

            {activeTab === "receipt-builder" && (
              <Suspense
                fallback={
                  <p className="text-sm font-medium text-app-text-muted">
                    Loading Receipt Builder…
                  </p>
                }
              >
                <ReceiptBuilderPanel baseUrl={baseUrl} />
              </Suspense>
            )}

            {activeTab === "tag-designer" && (
              <Suspense
                fallback={
                  <p className="text-sm font-medium text-app-text-muted">
                    Loading Tag Designer…
                  </p>
                }
              >
                <TagDesignerPanel />
              </Suspense>
            )}

          </div>
        </main>
      </div>

      {deleteConfirmFile && (
        <ConfirmationModal
          isOpen={true}
          title="Delete Backup Snapshot?"
          message={`Are you sure you want to delete the backup snapshot "${deleteConfirmFile}"? This cannot be undone.`}
          confirmLabel="Delete Snapshot"
          onConfirm={executeDeleteBackup}
          onClose={() => setDeleteConfirmFile(null)}
          variant="danger"
        />
      )}

      {restoreConfirmFile && (
        <ConfirmationModal
          isOpen={true}
          title="Destructive Restore?"
          message={`You are about to restore the database from snapshot "${restoreConfirmFile}". This will IRREVERSIBLY OVERWRITE your current data with the state of this snapshot. The application will reload after restoration.`}
          confirmLabel="Execute Overwrite"
          onConfirm={() => handleRestoreBackup(restoreConfirmFile)}
          onClose={() => setRestoreConfirmFile(null)}
          variant="danger"
        />
      )}
    </div>
  );
}
