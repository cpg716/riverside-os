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
  Database,
  Trash2,
  Download,
  Play,
  RefreshCw,
  CheckCircle2,
  History,
  Gauge,
  Cloud,
  Info,
  ClipboardList,
  Monitor,
  Star,
  Save,
  type LucideIcon,
} from "lucide-react";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { subSectionVisible } from "../../context/BackofficeAuthPermissions";

import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import OnlineStoreConfigPanel from "./OnlineStoreConfigPanel";
import HelpCenterSettingsPanel from "./HelpCenterSettingsPanel";
import CounterpointSyncSettingsPanel from "./CounterpointSyncSettingsPanel";
import { StaffRoleAccessPanel } from "../staff/StaffAccessPanels";
import StaffDiscountCapsPanel from "../staff/StaffDiscountCapsPanel";
import InsightsSettingsPanel from "./InsightsSettingsPanel";
import BugReportsSettingsPanel from "./BugReportsSettingsPanel";
import NuorderSettingsPanel from "./NuorderSettingsPanel";
import WeatherSettingsPanel from "./WeatherSettingsPanel";
import PodiumSettingsPanel from "./PodiumSettingsPanel";
import MeilisearchSettingsPanel from "./MeilisearchSettingsPanel";
import QuickBooksSettingsPanel from "./QuickBooksSettingsPanel";
import ShippoSettingsPanel from "./ShippoSettingsPanel";
import StripeSettingsPanel from "./StripeSettingsPanel";
import IntegrationBrandLogo, { type IntegrationBrand } from "../ui/IntegrationBrandLogo";
import RemoteAccessPanel from "./RemoteAccessPanel";
import RegisterSettings from "../pos/RegisterSettings";
import StaffProfilePanel from "./StaffProfilePanel";
import RosDevCenterPanel from "./RosDevCenterPanel";
import RosieSettingsPanel from "./RosieSettingsPanel";
import UpdateManagerPanel from "./UpdateManagerPanel";
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

const SETTINGS_HUB_DESCRIPTIONS: Record<string, string> = {
  profile: "Your staff profile, contact details, PIN, and notification preferences.",
  general: "Core store settings, staff playbook, review invites, and build details.",
  "staff-access-defaults": "Role templates, default access, and discount caps.",
  "online-store": "Storefront publishing, product exposure, and customer checkout setup.",
  printing: "Printers, scanners, labels, test tools, and workstation hardware.",
  "receipt-builder": "Receipt layout, branding, barcode, and delivery settings.",
  "tag-designer": "Merchandise tag layout and printing templates.",
  register: "Terminal overrides, register feedback, and lane device preferences.",
  backups: "Local snapshots, backup retention, restore tools, and maintenance tasks.",
  "remote-access": "Remote support access and workstation connectivity.",
  updates: "App updates, PWA refresh, and server update steps.",
  integrations: "Overview cards for connected services and integration setup.",
  podium: "Podium messaging, review invites, and communication readiness.",
  shippo: "Shipping account setup, carrier rates, and label configuration.",
  stripe: "Stripe payments, terminal readiness, and card processing setup.",
  quickbooks: "QuickBooks connection settings and accounting bridge controls.",
  counterpoint: "Counterpoint sync status, mappings, staging, and issue handling.",
  nuorder: "NuORDER catalog and vendor sync configuration.",
  weather: "Weather provider settings for store planning signals.",
  insights: "Reporting and Metabase launch configuration.",
  meilisearch: "Search index health, reindex controls, and diagnostics.",
  "help-center": "Help Center content, manuals, and staff guidance publishing.",
  rosie: "ROSIE assistant settings and runtime behavior.",
  "bug-reports": "Bug reports, captured incidents, and diagnostics triage.",
  "ros-dev-center": "Developer operations, runtime health, and guarded actions.",
};

export default function SettingsWorkspace({
  activeSection,
  settingsActiveSection,
  mode = "backoffice",
  bugReportsDeepLinkId,
  onBugReportsDeepLinkConsumed,
  onOpenQbo,
  onSettingsSectionNavigate,
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
  const activeTab = requestedActiveTab.startsWith("settings-group-")
    ? "hub"
    : requestedActiveTab;
  const navigateToTab = onNavigateToTab ?? onSettingsSectionNavigate;

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
    const groups: {
      id: string;
      label: string;
      links: { id: string; label: string; description: string }[];
    }[] = [];
    let currentGroup:
      | {
          id: string;
          label: string;
          links: { id: string; label: string; description: string }[];
        }
      | null = null;

    for (const section of SIDEBAR_SUB_SECTIONS.settings) {
      if (section.kind === "group") {
        currentGroup = { id: section.id, label: section.label, links: [] };
        groups.push(currentGroup);
        continue;
      }
      if (section.id === "hub") continue;
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
      });
    }

    return groups.filter((group) => group.links.length > 0);
  }, [hasPermission, permissionsLoaded]);



  const [staffSopMarkdown, setStaffSopMarkdown] = useState("");
  const [staffSopLoaded, setStaffSopLoaded] = useState(false);
  const [staffSopBusy, setStaffSopBusy] = useState(false);

  const [reviewPolicy, setReviewPolicy] = useState<{
    review_invites_enabled: boolean;
    send_review_invite_by_default: boolean;
  } | null>(null);
  const [reviewPolicyLoaded, setReviewPolicyLoaded] = useState(false);
  const [reviewPolicyBusy, setReviewPolicyBusy] = useState(false);

  const STAFF_SOP_MAX_BYTES = 131_072;

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
    if (activeTab !== "general") return;
    setStaffSopLoaded(false);
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings/staff-sop`, {
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (res.ok) {
          const j = (await res.json()) as { markdown?: string };
          setStaffSopMarkdown(typeof j.markdown === "string" ? j.markdown : "");
        } else {
          setStaffSopMarkdown("");
        }
      } catch {
        setStaffSopMarkdown("");
      } finally {
        setStaffSopLoaded(true);
      }
    })();
  }, [activeTab, baseUrl, backofficeHeaders]);

  useEffect(() => {
    if (activeTab !== "general" || !hasPermission("settings.admin")) return;
    setReviewPolicyLoaded(false);
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings/review-policy`, {
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (res.ok) {
          const j = (await res.json()) as {
            review_invites_enabled?: boolean;
            send_review_invite_by_default?: boolean;
          };
          setReviewPolicy({
            review_invites_enabled: j.review_invites_enabled !== false,
            send_review_invite_by_default:
              j.send_review_invite_by_default !== false,
          });
        } else {
          setReviewPolicy({
            review_invites_enabled: true,
            send_review_invite_by_default: true,
          });
        }
      } catch {
        setReviewPolicy({
          review_invites_enabled: true,
          send_review_invite_by_default: true,
        });
      } finally {
        setReviewPolicyLoaded(true);
      }
    })();
  }, [activeTab, baseUrl, backofficeHeaders, hasPermission]);

  const saveReviewPolicy = async () => {
    if (!reviewPolicy || !hasPermission("settings.admin")) return;
    setReviewPolicyBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/review-policy`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          review_invites_enabled: reviewPolicy.review_invites_enabled,
          send_review_invite_by_default:
            reviewPolicy.send_review_invite_by_default,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as {
          review_invites_enabled?: boolean;
          send_review_invite_by_default?: boolean;
        };
        setReviewPolicy({
          review_invites_enabled: j.review_invites_enabled !== false,
          send_review_invite_by_default:
            j.send_review_invite_by_default !== false,
        });
        toast("Review invite policy saved", "success");
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          typeof err.error === "string"
            ? err.error
            : "Could not save review policy",
          "error",
        );
      }
    } catch {
      toast("Could not save review policy", "error");
    } finally {
      setReviewPolicyBusy(false);
    }
  };

  const saveBackupSettings = async () => {
    if (!backupCfg) return;
    const payload = {
      auto_cleanup_days: backupCfg.auto_cleanup_days,
      schedule_cron: backupCfg.schedule_cron,
      cloud_storage_enabled: backupCfg.cloud_storage_enabled,
      cloud_bucket_name: backupCfg.cloud_bucket_name,
      cloud_region: backupCfg.cloud_region,
      cloud_endpoint: backupCfg.cloud_endpoint,
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
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
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

  // Helper to parse cron "0 2 * * *" to time "02" and "00"
  const getCronTime = (cron: string) => {
    const parts = cron.split(" ");
    return { hour: parts[1] || "02", minute: parts[0] || "00" };
  };

  const setCronTime = (hour: string, minute: string) => {
    if (!backupCfg) return;
    setBackupCfg({ ...backupCfg, schedule_cron: `${minute} ${hour} * * *` });
  };

  const [tauriShellVersion, setTauriShellVersion] = useState<string | null>(
    null,
  );

  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        setTauriShellVersion(v);
      } catch {
        setTauriShellVersion(null);
      }
    })();
  }, []);

  const saveStaffSop = async () => {
    if (staffSopBusy) return;
    if (
      new TextEncoder().encode(staffSopMarkdown).length > STAFF_SOP_MAX_BYTES
    ) {
      toast(
        `Store playbook is too large (max ${STAFF_SOP_MAX_BYTES} bytes UTF-8)`,
        "error",
      );
      return;
    }
    setStaffSopBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/staff-sop`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ markdown: staffSopMarkdown }),
      });
      if (res.ok) {
        const j = (await res.json()) as { markdown?: string };
        setStaffSopMarkdown(
          typeof j.markdown === "string" ? j.markdown : staffSopMarkdown,
        );
        toast("Store staff playbook saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save store playbook", "error");
      }
    } catch {
      toast("Could not save store playbook", "error");
    } finally {
      setStaffSopBusy(false);
    }
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
                  {settingsHubGroups.map((group) => (
                    <section key={group.id} className="ui-card p-5 sm:p-6">
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

                      <div className="grid grid-cols-1 gap-3">
                        {group.links.map((link) => (
                          <button
                            key={link.id}
                            type="button"
                            onClick={() => navigateToTab?.(link.id)}
                            className="group flex min-h-24 w-full items-center gap-4 rounded-xl border border-app-border bg-app-surface/60 p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:bg-app-surface hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30"
                          >
                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-bg text-xs font-black uppercase text-app-accent">
                              {link.label.slice(0, 2)}
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
                  ))}
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
                    Protect and optimize your enterprise data with point-in-time
                    snapshots.
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
                          Manual Trigger
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
                                ? "Explicit Path"
                                : backupCfg.backup_dir_explicit_required
                                  ? "Required"
                                  : "Dev Fallback"}
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
                                Daily Sync Window
                              </span>
                              <div className="flex items-center gap-2 mt-2">
                                {(() => {
                                  const { hour, minute } = getCronTime(
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
                                          setCronTime(
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
                                          setCronTime(
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
                            </div>
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
                            Db Structure Health
                          </h4>
                          <p className="text-[10px] text-app-text-muted leading-relaxed font-bold uppercase opacity-60">
                            Reclaims disk space and updates query planner stats.
                          </p>
                          <button
                            onClick={handleOptimize}
                            disabled={optimizeBusy}
                            className="mt-4 w-full h-12 rounded-xl bg-app-accent text-white font-black uppercase tracking-widest hover:bg-app-accent-hover transition-all active:scale-95 shadow-lg shadow-app-accent/30"
                          >
                            {optimizeBusy ? "VACUUMING..." : "Optimize Now"}
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
                <PrintersAndScannersPanel mode={mode} />
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
                      color: "bg-white",
                      brand: "meilisearch" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "insights",
                      label: "Metabase Insights",
                      desc: "Enterprise reporting & SSO",
                      color: "bg-white",
                      brand: "metabase" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "weather",
                      label: "Live Weather",
                      desc: "Visual Crossing snapshots",
                      color: "bg-white",
                      brand: "weather" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "shippo",
                      label: "Shippo",
                      desc: "Carrier rates & labels",
                      color: "bg-white",
                      brand: "shippo" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "podium",
                      label: "Podium Comms",
                      desc: "Lifecycle SMS & HTML Email",
                      color: "bg-white",
                      brand: "podium" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "nuorder",
                      label: "NuORDER",
                      desc: "Retail catalog & sync",
                      color: "bg-white",
                      brand: "nuorder" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "quickbooks",
                      label: "QuickBooks Online",
                      desc: "Launch QBO Data Bridge",
                      color: "bg-white",
                      brand: "qbo" as IntegrationBrand,
                      brandKind: "icon" as const,
                    },
                    {
                      id: "stripe",
                      label: "Stripe Terminal",
                      desc: "Card Processing Hub",
                      color: "bg-white",
                      brand: "stripe" as IntegrationBrand,
                      brandKind: "icon" as const,
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
                          . Server token:{" "}
                          <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                            COUNTERPOINT_SYNC_TOKEN
                          </code>
                          .
                        </p>
                      </div>
                    </div>
                  </header>

                  <CounterpointSyncSettingsPanel variant="workspace" />
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

            {activeTab === "updates" && <UpdateManagerPanel />}

            {activeTab === "online-store" && (
              <OnlineStoreConfigPanel onOpenOnlineStore={onOpenOnlineStore} />
            )}

            {activeTab === "rosie" && <RosieSettingsPanel />}
            {activeTab === "help-center" && <HelpCenterSettingsPanel />}
            {activeTab === "bug-reports" && hasPermission("settings.admin") && (
              <BugReportsSettingsPanel
                deepLinkReportId={bugReportsDeepLinkId}
                onDeepLinkConsumed={onBugReportsDeepLinkConsumed}
              />
            )}
            {activeTab === "ros-dev-center" &&
              hasPermission("ops.dev_center.view") && (
                <RosDevCenterPanel
                  bugReportsDeepLinkId={bugReportsDeepLinkId}
                  onBugReportsDeepLinkConsumed={onBugReportsDeepLinkConsumed}
                />
              )}

            {activeTab === "meilisearch" && hasPermission("settings.admin") && (
              <MeilisearchSettingsPanel />
            )}

            {activeTab === "nuorder" && hasPermission("settings.admin") && (
              <NuorderSettingsPanel />
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

            {activeTab === "stripe" && hasPermission("settings.admin") && (
              <StripeSettingsPanel />
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

            {activeTab === "general" && (
              <div className="space-y-8 sm:space-y-12">
                <header className="mb-10">
                  <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                    System Settings
                  </h2>
                  <p className="text-sm text-app-text-muted mt-2 font-medium">
                    Environmental and UI overrides.
                  </p>
                </header>


                {hasPermission("settings.admin") ? (
                  <section className="ui-card max-w-2xl p-4 sm:p-6 lg:p-8">
                    <div className="mb-4 flex items-start gap-3">
                      <Star
                        className="mt-0.5 h-5 w-5 shrink-0 text-app-accent"
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                          Post-sale review invites
                        </h3>
                        <p className="mt-1 text-xs font-medium text-app-text-muted leading-relaxed">
                          Store-wide defaults for Podium review flows. The
                          receipt summary (POS) still lets cashiers opt out per
                          sale when invites are enabled. Completing Podium
                          review sending remains in Integrations.
                        </p>
                      </div>
                    </div>
                    {!reviewPolicyLoaded || !reviewPolicy ? (
                      <p className="text-sm font-medium text-app-text-muted">
                        Loading…
                      </p>
                    ) : (
                      <div className="space-y-4">
                        <label className="flex cursor-pointer items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-app-border"
                            checked={reviewPolicy.review_invites_enabled}
                            onChange={(e) =>
                              setReviewPolicy((p) =>
                                p
                                  ? {
                                      ...p,
                                      review_invites_enabled: e.target.checked,
                                    }
                                  : p,
                              )
                            }
                          />
                          <span className="text-sm font-medium text-app-text">
                            Enable post-sale review invites (when Podium is
                            configured on the server).
                          </span>
                        </label>
                        <label
                          className={`flex cursor-pointer items-start gap-3 ${!reviewPolicy.review_invites_enabled ? "opacity-50" : ""}`}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-app-border"
                            disabled={!reviewPolicy.review_invites_enabled}
                            checked={reviewPolicy.send_review_invite_by_default}
                            onChange={(e) =>
                              setReviewPolicy((p) =>
                                p
                                  ? {
                                      ...p,
                                      send_review_invite_by_default:
                                        e.target.checked,
                                    }
                                  : p,
                              )
                            }
                          />
                          <span className="text-sm font-medium text-app-text">
                            Default receipt summary to send an invite (unchecked
                            means cashiers must confirm sending, or check
                            &quot;do not send&quot; to suppress).
                          </span>
                        </label>
                        <button
                          type="button"
                          disabled={reviewPolicyBusy}
                          onClick={() => void saveReviewPolicy()}
                          className="ui-btn-primary h-11 px-6 text-sm font-black disabled:opacity-50"
                        >
                          {reviewPolicyBusy ? "Saving…" : "Save review policy"}
                        </button>
                      </div>
                    )}
                  </section>
                ) : null}

                <section className="ui-card max-w-4xl p-4 sm:p-6 lg:p-8">
                  <div className="mb-4 flex items-start gap-3">
                    <ClipboardList
                      className="mt-0.5 h-5 w-5 shrink-0 text-app-accent"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                        Store staff playbook
                      </h3>
                      <p className="mt-1 text-xs font-medium text-app-text-muted leading-relaxed">
                        Markdown notes for{" "}
                        <strong className="text-app-text">this store</strong>{" "}
                        (contacts, void rules, cash tolerance, seasonal policy).
                        Staff can read it via{" "}
                        <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                          GET /api/staff/store-sop
                        </code>{" "}
                        when signed in. Suggested sections live in repo{" "}
                        <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                          docs/staff/STORE-SOP-TEMPLATE.md
                        </code>
                        .
                      </p>
                    </div>
                  </div>
                  {!staffSopLoaded ? (
                    <p className="text-sm font-medium text-app-text-muted">
                      Loading…
                    </p>
                  ) : (
                    <>
                      <textarea
                        value={staffSopMarkdown}
                        onChange={(e) => setStaffSopMarkdown(e.target.value)}
                        spellCheck={false}
                        className="ui-input min-h-[320px] w-full resize-y font-mono text-sm leading-relaxed"
                        placeholder={
                          "# Store playbook\n\nFill tables for your location (manager phone, void policy, …). See docs/staff/STORE-SOP-TEMPLATE.md for ideas."
                        }
                        aria-label="Store staff playbook markdown"
                      />
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                          UTF-8 size{" "}
                          <span
                            className={
                              new TextEncoder().encode(staffSopMarkdown)
                                .length > STAFF_SOP_MAX_BYTES
                                ? "text-red-600"
                                : "text-app-text"
                            }
                          >
                            {new TextEncoder().encode(staffSopMarkdown).length}
                          </span>
                          {" / "}
                          {STAFF_SOP_MAX_BYTES} bytes
                        </p>
                        <button
                          type="button"
                          disabled={staffSopBusy}
                          onClick={() => void saveStaffSop()}
                          className="ui-btn-primary h-11 px-6 text-sm font-black disabled:opacity-50"
                        >
                          {staffSopBusy ? "Saving…" : "Save playbook"}
                        </button>
                      </div>
                    </>
                  )}
                </section>

                <section className="ui-card p-8 max-w-2xl">
                  <div className="flex items-center gap-3 mb-4">
                    <Info
                      className="h-5 w-5 text-app-accent shrink-0"
                      aria-hidden
                    />
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                        About this build
                      </h3>
                      <p className="text-xs text-app-text-muted mt-1 font-medium">
                        Share these details with support when reporting an
                        issue. Use Settings → Updates for app update checks.
                      </p>
                    </div>
                  </div>
                  <dl className="grid gap-3 text-sm">
                    <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                      <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                        Surface
                      </dt>
                      <dd className="font-mono text-app-text tabular-nums">
                        {tauriShellVersion != null
                          ? `Desktop (Tauri ${tauriShellVersion})`
                          : "Web / PWA"}
                      </dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                      <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                        Client version
                      </dt>
                      <dd className="font-mono text-app-text tabular-nums">
                        {CLIENT_SEMVER}
                      </dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                      <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                        Git revision
                      </dt>
                      <dd className="font-mono text-app-text tabular-nums">
                        {GIT_SHORT}
                      </dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 pt-1">
                      <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                        API base
                      </dt>
                      <dd className="font-mono text-xs text-app-text break-all text-right max-w-[min(100%,20rem)]">
                        {baseUrl}
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
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
