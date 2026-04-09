import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from "react";
import { Database, Save, Trash2, Download, Play, RefreshCw, CheckCircle2, History, Gauge, Cloud, Printer, FileText, Settings as SettingsIcon, Link, Info, User, ClipboardList, MessageSquare, ShoppingBag, Search, BookOpen, Monitor, Shield, Star, Bug } from "lucide-react";
import { CLIENT_SEMVER, GIT_SHORT } from "../../clientBuildMeta";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { readPersistedBackofficeSession } from "../../lib/backofficeSessionPersistence";
import {
  getPodiumOAuthRedirectUri,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
} from "../../lib/podiumOAuth";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import StaffAvatarPicker from "../staff/StaffAvatarPicker";
import OnlineStoreSettingsPanel from "./OnlineStoreSettingsPanel";
import HelpCenterSettingsPanel from "./HelpCenterSettingsPanel";
import CounterpointSyncSettingsPanel from "./CounterpointSyncSettingsPanel";
import { StaffRoleAccessPanel } from "../staff/StaffAccessPanels";
import StaffDiscountCapsPanel from "../staff/StaffDiscountCapsPanel";
import InsightsIntegrationSettings from "./InsightsIntegrationSettings";
import BugReportsSettingsPanel from "./BugReportsSettingsPanel";
import NuorderSettingsPanel from "./NuorderSettingsPanel";
const ReceiptBuilderPanel = lazy(() => import("./ReceiptBuilderPanel"));

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
}

export interface BackupSettings {
  auto_cleanup_days: number;
  schedule_cron: string;
  cloud_storage_enabled: boolean;
  cloud_bucket_name: string;
  cloud_region: string;
  cloud_endpoint: string;
}

interface BackupFile {
  filename: string;
  size_bytes: number;
  created_at: string;
}

interface DbStats {
  database_size: string;
  table_count: number;
}

interface WeatherSettings {
  enabled: boolean;
  location: string;
  unit_group: string;
  timezone: string;
  api_key_configured: boolean;
  provider: string;
}

/** Matches `GET /api/settings/podium-sms` (flattened `settings` + meta). */
interface PodiumEmailTemplatesApi {
  ready_for_pickup_subject: string;
  ready_for_pickup_html: string;
  alteration_ready_subject: string;
  alteration_ready_html: string;
  appointment_confirmation_subject: string;
  appointment_confirmation_html: string;
  loyalty_reward_redeemed_subject: string;
  loyalty_reward_redeemed_html: string;
}

/** Flattened with `settings` from `GET /api/settings/podium-sms`. */
interface PodiumSmsSettingsApi {
  sms_send_enabled: boolean;
  email_send_enabled: boolean;
  location_uid: string;
  widget_embed_enabled: boolean;
  widget_snippet_html: string;
  templates: {
    ready_for_pickup: string;
    alteration_ready: string;
    unknown_sender_welcome: string;
    loyalty_reward_redeemed: string;
  };
  email_templates: PodiumEmailTemplatesApi;
  templates_effective: {
    ready_for_pickup: string;
    alteration_ready: string;
    unknown_sender_welcome: string;
    loyalty_reward_redeemed: string;
  };
  email_templates_effective: PodiumEmailTemplatesApi;
  credentials_configured: boolean;
  oauth_authorize_url: string;
  oauth_token_url_hint: string;
}

/** `GET /api/settings/podium-sms/readiness` — no live Podium calls. */
interface PodiumSmsReadinessApi {
  credentials_configured: boolean;
  webhook_secret_configured: boolean;
  allow_unsigned_webhook: boolean;
  inbound_inbox_preview_enabled: boolean;
  api_base: string;
  sms_send_enabled: boolean;
  email_send_enabled: boolean;
  location_uid_configured: boolean;
  widget_embed_enabled: boolean;
}

const PODIUM_TEMPLATE_DEFAULTS = {
  ready_for_pickup:
    "Hi {first_name}, your Riverside order ({order_ref}) is ready for pickup! See you soon.",
  alteration_ready:
    "Hi {first_name}, your alteration ({alteration_ref}) is ready at Riverside. See you soon.",
  unknown_sender_welcome:
    "Thank you for contacting Riverside Men's Shop. Please reply with your first and last name and someone will be with you as soon as possible during regular business hours. Thank you.",
  loyalty_reward_redeemed:
    "Hi {first_name}, your ${reward_amount} Riverside loyalty reward is processed. {reward_breakdown} Your balance is now {new_balance} points. We may also mail a physical card. Thank you!",
} as const;

const PODIUM_EMAIL_TEMPLATE_DEFAULTS: PodiumEmailTemplatesApi = {
  ready_for_pickup_subject: "Your Riverside order is ready",
  ready_for_pickup_html:
    "<p>Hi {first_name},</p><p>Your Riverside order <b>{order_ref}</b> is ready for pickup. See you soon.</p>",
  alteration_ready_subject: "Your alteration is ready",
  alteration_ready_html:
    "<p>Hi {first_name},</p><p>Your alteration <b>{alteration_ref}</b> is ready at Riverside. See you soon.</p>",
  appointment_confirmation_subject: "Appointment confirmed — Riverside",
  appointment_confirmation_html:
    "<p>Hi {first_name},</p><p>Your <b>{appointment_type}</b> appointment is scheduled for <b>{starts_at}</b>.</p>{notes_block}",
  loyalty_reward_redeemed_subject: "Your Riverside loyalty reward",
  loyalty_reward_redeemed_html:
    "<p>Hi {first_name},</p><p>We have processed your <b>${reward_amount}</b> loyalty reward.</p>{reward_breakdown_html}<p>Your loyalty balance is now <b>{new_balance}</b> points.</p><p>We may also mail a physical gift card when applicable.</p><p>Thank you for shopping with us.</p>",
};

const PODIUM_EMAIL_UI_BLOCKS: {
  label: string;
  subjectKey: keyof PodiumEmailTemplatesApi;
  htmlKey: keyof PodiumEmailTemplatesApi;
}[] = [
  {
    label: "Ready for pickup",
    subjectKey: "ready_for_pickup_subject",
    htmlKey: "ready_for_pickup_html",
  },
  {
    label: "Alteration ready",
    subjectKey: "alteration_ready_subject",
    htmlKey: "alteration_ready_html",
  },
  {
    label: "Appointment confirmation",
    subjectKey: "appointment_confirmation_subject",
    htmlKey: "appointment_confirmation_html",
  },
  {
    label: "Loyalty reward (at redemption)",
    subjectKey: "loyalty_reward_redeemed_subject",
    htmlKey: "loyalty_reward_redeemed_html",
  },
];

type ThemeMode = "light" | "dark" | "system";

interface SettingsWorkspaceProps {
  themeMode: ThemeMode;
  onThemeChange: (t: ThemeMode) => void;
  onOpenQbo: () => void;
  /** Sidebar subsection under Settings (`profile` | `general`). */
  settingsActiveSection?: string;
  /** Keeps app sidebar subsection in sync when using the in-workspace System Control rail. */
  onSettingsSectionNavigate?: (sectionId: string) => void;
}

export default function SettingsWorkspace({
  themeMode,
  onThemeChange,
  onOpenQbo,
  settingsActiveSection,
  onSettingsSectionNavigate,
}: SettingsWorkspaceProps) {
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  // Navigation
  const [activeTab, setActiveTab] = useState("backups");
  
  // Settings State
  const [cfg, setCfg] = useState<ReceiptConfig | null>(null);
  const [backupCfg, setBackupCfg] = useState<BackupSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // Database State
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [stats, setStats] = useState<DbStats | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [optimizeBusy, setOptimizeBusy] = useState(false);
  const [restoreConfirmFile, setRestoreConfirmFile] = useState<string | null>(null);
  const [deleteConfirmFile, setDeleteConfirmFile] = useState<string | null>(null);
  const { toast } = useToast();
  const { backofficeHeaders, staffAvatarKey, refreshPermissions, hasPermission } =
    useBackofficeAuth();
  const [profileAvatarDraft, setProfileAvatarDraft] = useState(staffAvatarKey);
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    setProfileAvatarDraft(staffAvatarKey);
  }, [staffAvatarKey]);

  useEffect(() => {
    const s = settingsActiveSection?.trim();
    if (s === "profile") setActiveTab("profile");
    else if (s === "general") setActiveTab("general");
    else if (s === "backups") setActiveTab("backups");
    else if (s === "printing") setActiveTab("printing");
    else if (s === "integrations") setActiveTab("integrations");
    else if (s === "staff-access-defaults") setActiveTab("staff-access-defaults");
    else if (s === "counterpoint") setActiveTab("counterpoint");
    else if (s === "online-store") setActiveTab("online-store");
    else if (s === "help-center") setActiveTab("help-center");
    else if (s === "bug-reports") setActiveTab("bug-reports");
    else if (s === "receipt-builder") setActiveTab("receipt-builder");
    else if (s === "nuorder") setActiveTab("nuorder");
  }, [settingsActiveSection]);
  const [weatherCfg, setWeatherCfg] = useState<WeatherSettings | null>(null);
  const [weatherApiKeyDraft, setWeatherApiKeyDraft] = useState("");
  const [podiumSms, setPodiumSms] = useState<PodiumSmsSettingsApi | null>(null);
  const [podiumReadiness, setPodiumReadiness] = useState<PodiumSmsReadinessApi | null>(
    null,
  );
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

  const [meiliConfigured, setMeiliConfigured] = useState<boolean | null>(null);
  const [meiliReindexBusy, setMeiliReindexBusy] = useState(false);
  const [meiliReindexConfirmOpen, setMeiliReindexConfirmOpen] = useState(false);

  const fetchMeilisearchStatus = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/meilisearch/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as { configured?: boolean };
        setMeiliConfigured(j.configured === true);
      } else {
        setMeiliConfigured(null);
      }
    } catch {
      setMeiliConfigured(null);
    }
  }, [baseUrl, backofficeHeaders, hasPermission]);

  useEffect(() => {
    if (activeTab !== "integrations" || !hasPermission("settings.admin")) return;
    void fetchMeilisearchStatus();
  }, [activeTab, fetchMeilisearchStatus, hasPermission]);

  const runMeilisearchReindex = async () => {
    setMeiliReindexConfirmOpen(false);
    setMeiliReindexBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/meilisearch/reindex`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        toast("Search index rebuild completed", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Search index rebuild failed", "error");
      }
    } catch {
      toast("Search index rebuild failed", "error");
    } finally {
      setMeiliReindexBusy(false);
    }
  };

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

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/database/stats`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) setStats((await res.json()) as DbStats);
    } catch (e) {
      console.error("Failed to fetch stats", e);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchBackupSettings = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/backup/config`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) setBackupCfg((await res.json()) as BackupSettings);
    } catch (e) {
      console.error("Failed to fetch backup settings", e);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchWeatherSettings = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        headers: backofficeHeaders(),
      });
      if (res.ok) {
        setWeatherCfg((await res.json()) as WeatherSettings);
        setWeatherApiKeyDraft("");
      }
    } catch (e) {
      console.error("Failed to fetch weather settings", e);
    }
  }, [baseUrl, backofficeHeaders]);

  const fetchPodiumSmsSettings = useCallback(async () => {
    try {
      const [smsRes, readyRes] = await Promise.all([
        fetch(`${baseUrl}/api/settings/podium-sms`, {
          headers: backofficeHeaders() as Record<string, string>,
        }),
        fetch(`${baseUrl}/api/settings/podium-sms/readiness`, {
          headers: backofficeHeaders() as Record<string, string>,
        }),
      ]);
      if (smsRes.ok) {
        const j = (await smsRes.json()) as Partial<PodiumSmsSettingsApi>;
        setPodiumSms({
          ...j,
          sms_send_enabled: j.sms_send_enabled ?? false,
          email_send_enabled: j.email_send_enabled ?? false,
          location_uid: j.location_uid ?? "",
          widget_embed_enabled: j.widget_embed_enabled ?? false,
          widget_snippet_html: j.widget_snippet_html ?? "",
          templates: {
            ready_for_pickup:
              j.templates?.ready_for_pickup ??
              PODIUM_TEMPLATE_DEFAULTS.ready_for_pickup,
            alteration_ready:
              j.templates?.alteration_ready ??
              PODIUM_TEMPLATE_DEFAULTS.alteration_ready,
            unknown_sender_welcome:
              j.templates?.unknown_sender_welcome ??
              PODIUM_TEMPLATE_DEFAULTS.unknown_sender_welcome,
            loyalty_reward_redeemed:
              j.templates?.loyalty_reward_redeemed ??
              PODIUM_TEMPLATE_DEFAULTS.loyalty_reward_redeemed,
          },
          email_templates: {
            ...PODIUM_EMAIL_TEMPLATE_DEFAULTS,
            ...(j.email_templates ?? {}),
          },
          templates_effective: {
            ready_for_pickup:
              j.templates_effective?.ready_for_pickup ??
              PODIUM_TEMPLATE_DEFAULTS.ready_for_pickup,
            alteration_ready:
              j.templates_effective?.alteration_ready ??
              PODIUM_TEMPLATE_DEFAULTS.alteration_ready,
            unknown_sender_welcome:
              j.templates_effective?.unknown_sender_welcome ??
              PODIUM_TEMPLATE_DEFAULTS.unknown_sender_welcome,
            loyalty_reward_redeemed:
              j.templates_effective?.loyalty_reward_redeemed ??
              PODIUM_TEMPLATE_DEFAULTS.loyalty_reward_redeemed,
          },
          email_templates_effective: {
            ...PODIUM_EMAIL_TEMPLATE_DEFAULTS,
            ...(j.email_templates_effective ?? {}),
          },
          credentials_configured: j.credentials_configured ?? false,
          oauth_authorize_url: j.oauth_authorize_url ?? "",
          oauth_token_url_hint: j.oauth_token_url_hint ?? "",
        });
      } else {
        setPodiumSms(null);
      }
      if (readyRes.ok) {
        const r = (await readyRes.json()) as Partial<PodiumSmsReadinessApi>;
        setPodiumReadiness({
          ...r,
          credentials_configured: r.credentials_configured ?? false,
          webhook_secret_configured: r.webhook_secret_configured ?? false,
          allow_unsigned_webhook: r.allow_unsigned_webhook ?? false,
          inbound_inbox_preview_enabled: r.inbound_inbox_preview_enabled ?? false,
          api_base: r.api_base ?? "",
          sms_send_enabled: r.sms_send_enabled ?? false,
          email_send_enabled: r.email_send_enabled ?? false,
          location_uid_configured: r.location_uid_configured ?? false,
          widget_embed_enabled: r.widget_embed_enabled ?? false,
        });
      } else {
        setPodiumReadiness(null);
      }
    } catch (e) {
      console.error("Failed to fetch Podium SMS settings", e);
      setPodiumSms(null);
      setPodiumReadiness(null);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings/receipt`, {
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (res.ok) setCfg((await res.json()) as ReceiptConfig);
      } catch { /* ignore */ }
    })();
    void fetchBackups();
    void fetchStats();
    void fetchBackupSettings();
    void fetchWeatherSettings();
    void fetchPodiumSmsSettings();
  }, [baseUrl, backofficeHeaders, fetchBackups, fetchStats, fetchBackupSettings, fetchWeatherSettings, fetchPodiumSmsSettings]);

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
            send_review_invite_by_default: j.send_review_invite_by_default !== false,
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
          send_review_invite_by_default: reviewPolicy.send_review_invite_by_default,
        }),
      });
      if (res.ok) {
        const j = (await res.json()) as {
          review_invites_enabled?: boolean;
          send_review_invite_by_default?: boolean;
        };
        setReviewPolicy({
          review_invites_enabled: j.review_invites_enabled !== false,
          send_review_invite_by_default: j.send_review_invite_by_default !== false,
        });
        toast("Review invite policy saved", "success");
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(typeof err.error === "string" ? err.error : "Could not save review policy", "error");
      }
    } catch {
      toast("Could not save review policy", "error");
    } finally {
      setReviewPolicyBusy(false);
    }
  };

  const saveReceiptSettings = async () => {
    if (!cfg) return;
    setBusy(true); setSaved(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/receipt`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(cfg),
      });
      if (res.ok) {
        setCfg((await res.json()) as ReceiptConfig);
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const saveBackupSettings = async () => {
    if (!backupCfg) return;
    setBusy(true); setSaved(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/backup/config`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(backupCfg),
      });
      if (res.ok) {
        setBackupCfg((await res.json()) as BackupSettings);
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const saveWeatherSettings = async () => {
    if (!weatherCfg) return;
    setBusy(true);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        enabled: weatherCfg.enabled,
        location: weatherCfg.location.trim(),
        unit_group: weatherCfg.unit_group,
        timezone: weatherCfg.timezone.trim(),
      };
      if (weatherApiKeyDraft.trim()) {
        body.api_key = weatherApiKeyDraft.trim();
      }
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setWeatherCfg((await res.json()) as WeatherSettings);
        setWeatherApiKeyDraft("");
        setSaved(true);
        toast("Weather integration saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save weather settings", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const startPodiumOAuthConnect = async () => {
    const sess = readPersistedBackofficeSession();
    if (!sess?.staffCode) {
      toast("Sign in to Back Office in this browser tab, then try again.", "error");
      return;
    }
    const state = crypto.randomUUID();
    try {
      sessionStorage.setItem(PODIUM_OAUTH_STATE_STORAGE_KEY, state);
    } catch {
      toast("Could not store OAuth state. Check browser storage permissions.", "error");
      return;
    }
    const redirectUri = getPodiumOAuthRedirectUri();
    if (!redirectUri) {
      toast("Could not build callback URL.", "error");
      return;
    }
    try {
      sessionStorage.setItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY, redirectUri);
    } catch {
      toast("Could not store OAuth redirect URI.", "error");
      return;
    }
    const params = new URLSearchParams({ redirect_uri: redirectUri, state });
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/podium-oauth/authorize-url?${params}`,
        { headers: backofficeHeaders() as Record<string, string> },
      );
      const j = (await res.json()) as { authorize_url?: string; error?: string };
      if (!res.ok) {
        toast(j.error ?? "Could not start Podium OAuth", "error");
        return;
      }
      if (!j.authorize_url) {
        toast("Invalid response from server", "error");
        return;
      }
      window.location.href = j.authorize_url;
    } catch (e) {
      console.error(e);
      toast("Network error starting Podium OAuth", "error");
    }
  };

  const savePodiumSmsSettings = async () => {
    if (!podiumSms) return;
    setBusy(true);
    setSaved(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-sms`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          sms_send_enabled: podiumSms.sms_send_enabled,
          email_send_enabled: podiumSms.email_send_enabled,
          location_uid: podiumSms.location_uid.trim(),
          widget_embed_enabled: podiumSms.widget_embed_enabled,
          widget_snippet_html: podiumSms.widget_snippet_html,
          templates: podiumSms.templates,
          email_templates: podiumSms.email_templates,
        }),
      });
      if (res.ok) {
        await fetchPodiumSmsSettings();
        setSaved(true);
        toast("Podium / SMS settings saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save Podium settings", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const clearWeatherApiKey = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ api_key: null }),
      });
      if (res.ok) {
        setWeatherCfg((await res.json()) as WeatherSettings);
        setWeatherApiKeyDraft("");
        toast("API key cleared", "success");
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
        setBackups(prev => prev.filter(b => b.filename !== filename));
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
      const res = await fetch(`${baseUrl}/api/settings/backups/restore/${filename}`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        toast("Restore successful. Application reloading...", "success");
        setTimeout(() => window.location.reload(), 1500);
      } else {
        toast("Restore failed. Check server logs.", "error");
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
        void fetchStats();
      }
    } finally {
      setOptimizeBusy(false);
    }
  };

  const downloadBackupFile = async (filename: string) => {
    try {
      const enc = encodeURIComponent(filename);
      const res = await fetch(`${baseUrl}/api/settings/backups/download/${enc}`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
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

  const [tauriShellVersion, setTauriShellVersion] = useState<string | null>(null);

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

  const [receiptPrinterIp, setReceiptPrinterIp] = useState(() => window.localStorage.getItem("ros.pos.printerIp") || "127.0.0.1");
  const [receiptPrinterPort, setReceiptPrinterPort] = useState(() => window.localStorage.getItem("ros.pos.printerPort") || "9100");
  const [reportPrinterIp, setReportPrinterIp] = useState(() => window.localStorage.getItem("ros.report.printerIp") || "");

  const saveReceiptPrinter = (ip: string, port: string) => {
    setReceiptPrinterIp(ip);
    setReceiptPrinterPort(port);
    window.localStorage.setItem("ros.pos.printerIp", ip);
    window.localStorage.setItem("ros.pos.printerPort", port);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveReportPrinter = (ip: string) => {
    setReportPrinterIp(ip);
    window.localStorage.setItem("ros.report.printerIp", ip);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const tabs = useMemo(() => {
    const base: {
      id: string;
      label: string;
      icon: typeof User;
    }[] = [
      { id: "profile", label: "Profile", icon: User },
      { id: "backups", label: "Data & Backups", icon: Database },
      { id: "printing", label: "Printing Hub", icon: Printer },
      { id: "receipt-builder", label: "Receipt Builder", icon: FileText },
      { id: "integrations", label: "Integrations", icon: Link },
    ];
    if (hasPermission("settings.admin") || hasPermission("staff.manage_access")) {
      base.push({
        id: "staff-access-defaults",
        label: "Staff access defaults",
        icon: Shield,
      });
    }
    if (hasPermission("settings.admin")) {
      base.push({ id: "counterpoint", label: "Counterpoint", icon: Monitor });
    }
    base.push({ id: "online-store", label: "Online store", icon: ShoppingBag });
    if (hasPermission("help.manage")) {
      base.push({ id: "help-center", label: "Help center", icon: BookOpen });
    }
    if (hasPermission("settings.admin")) {
      base.push({ id: "bug-reports", label: "Bug reports", icon: Bug });
    }
    base.push({ id: "general", label: "General", icon: SettingsIcon });
    return base;
  }, [hasPermission]);

  const saveStaffSop = async () => {
    if (staffSopBusy) return;
    if (new TextEncoder().encode(staffSopMarkdown).length > STAFF_SOP_MAX_BYTES) {
      toast(`Store playbook is too large (max ${STAFF_SOP_MAX_BYTES} bytes UTF-8)`, "error");
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
        setStaffSopMarkdown(typeof j.markdown === "string" ? j.markdown : staffSopMarkdown);
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

  const saveProfileAvatar = async () => {
    setProfileSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/self/avatar`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ avatar_key: profileAvatarDraft.trim() || "ros_default" }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save profile icon", "error");
        return;
      }
      await refreshPermissions();
      toast("Profile icon updated", "success");
    } catch {
      toast("Could not save profile icon", "error");
    } finally {
      setProfileSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-bg">
      <div className="flex h-full overflow-hidden">
        {/* Settings Sidebar */}
        <aside className="w-64 shrink-0 border-r border-app-border bg-app-surface/50 p-6 flex flex-col gap-8">
           <div>
              <h1 className="text-xl font-black uppercase tracking-tight text-app-text italic">System Control</h1>
              <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-[0.2em] mt-1">Environment Overrides</p>
           </div>
           
           <nav className="flex flex-col gap-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => {
                    setActiveTab(tab.id);
                    onSettingsSectionNavigate?.(tab.id);
                  }}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-black transition-all group ${activeTab === tab.id ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900 shadow-xl shadow-black/20 translate-x-2' : 'text-app-text-muted hover:text-app-text hover:bg-app-border/30'}`}
                >
                  <tab.icon size={18} className={activeTab === tab.id ? '' : 'text-app-accent group-hover:scale-110 transition-transform'} />
                  <span className="uppercase tracking-widest text-[11px]">{tab.label}</span>
                </button>
              ))}
           </nav>

           <div className="mt-auto space-y-4">
              {stats && (
                <div className="ui-card p-4 bg-app-text/5 border-app-border/50">
                   <div className="flex items-center gap-3 mb-2">
                      <Database size={14} className="text-app-accent" />
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Storage Info</span>
                   </div>
                   <p className="text-xl font-black tabular-nums tracking-tighter text-app-text">{stats.database_size}</p>
                   <p className="text-[9px] font-bold uppercase text-app-text-muted opacity-60 mt-1">{stats.table_count} tables initialized</p>
                </div>
              )}
           </div>
        </aside>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto no-scrollbar scroll-smooth">
           <div
             className={`p-10 mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 ${
               activeTab === "counterpoint" ? "max-w-6xl" : "max-w-5xl"
             }`}
           >
              
              {activeTab === "profile" && (
                <div className="space-y-8">
                  <header className="mb-6">
                    <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                      Your profile
                    </h2>
                    <p className="mt-2 text-sm font-medium text-app-text-muted">
                      Choose a portrait for the sidebar, notifications, and staff lists. Icons are bundled in the app (no external requests at runtime).
                    </p>
                  </header>
                  <section className="ui-card p-6">
                    <StaffAvatarPicker
                      value={profileAvatarDraft}
                      onChange={setProfileAvatarDraft}
                      disabled={profileSaving}
                    />
                    <button
                      type="button"
                      disabled={
                        profileSaving || profileAvatarDraft.trim() === staffAvatarKey.trim()
                      }
                      onClick={() => void saveProfileAvatar()}
                      className="ui-btn-primary mt-6 h-11 px-6 text-sm font-black disabled:opacity-50"
                    >
                      {profileSaving ? "Saving…" : "Save profile icon"}
                    </button>
                  </section>
                </div>
              )}

              {activeTab === 'backups' && (
                <div className="space-y-12">
                   <header className="mb-10">
                      <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Data Lifecycle & Backups</h2>
                      <p className="text-sm text-app-text-muted mt-2 font-medium">Protect and optimize your enterprise data with point-in-time snapshots.</p>
                   </header>

                   <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
                      <div className="xl:col-span-8 space-y-10">
                         {/* Backups Section */}
                         <section className="ui-card overflow-hidden">
                            <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface/30">
                              <div className="flex items-center gap-3">
                                <History className="w-5 h-5 text-app-accent" />
                                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Local Snapshots</h3>
                              </div>
                              <button 
                                onClick={handleCreateBackup}
                                disabled={backupBusy}
                                className="h-10 px-6 rounded-xl bg-app-text text-white text-[10px] font-black uppercase tracking-widest hover:bg-black/80 disabled:opacity-50 transition-all flex items-center gap-2"
                              >
                                {backupBusy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3 text-app-accent" />}
                                Manual Trigger
                              </button>
                            </div>

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
                                    <tr><td colSpan={3} className="px-6 py-12 text-center text-sm text-app-text-muted font-bold italic">No snapshots found.</td></tr>
                                  ) : (
                                    backups.map((b: BackupFile) => (
                                      <tr key={b.filename} className="hover:bg-app-surface/20 transition-colors group">
                                        <td className="px-6 py-4">
                                          <div className="flex items-center gap-3">
                                            <div className="p-2 rounded bg-app-bg text-app-accent group-hover:scale-110 transition-transform"><Database size={14} /></div>
                                            <span className="font-mono text-xs font-bold text-app-text">{b.filename}</span>
                                          </div>
                                        </td>
                                        <td className="px-6 py-4 text-xs font-black text-app-text-muted">{formatSize(b.size_bytes)}</td>
                                        <td className="px-6 py-4 text-right">
                                          <div className="flex items-center justify-end gap-1">
                                            <button 
                                              type="button"
                                              onClick={() => void downloadBackupFile(b.filename)}
                                              className="p-2.5 rounded-lg hover:bg-app-text hover:text-white text-app-text-muted transition-all"
                                            ><Download size={14} /></button>
                                            <button 
                                              onClick={() => setRestoreConfirmFile(b.filename)}
                                              className="p-2.5 rounded-lg hover:bg-emerald-600 hover:text-white text-app-text-muted transition-all"
                                            ><Play size={14} /></button>
                                            <button 
                                              onClick={() => handleDeleteBackup(b.filename)}
                                              className="p-2.5 rounded-lg hover:bg-red-600 hover:text-white text-app-text-muted transition-all"
                                            ><Trash2 size={14} /></button>
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
                                 <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Automation & Cloud Sync</h3>
                               </div>
                               <button onClick={saveBackupSettings} disabled={busy} className="ui-btn-primary py-2 px-4 text-[10px] font-black uppercase tracking-widest flex items-center gap-2">
                                 <Save className="w-3 h-3" /> Update
                               </button>
                             </div>

                             <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                               <div className="space-y-4">
                                  <label className="block">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Retention Policy (Days)</span>
                                    <input type="number" value={backupCfg.auto_cleanup_days} onChange={e => setBackupCfg({ ...backupCfg, auto_cleanup_days: parseInt(e.target.value) || 0 })} className="ui-input mt-2 w-full font-black text-lg" />
                                  </label>
                                  <label className="block">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Daily Sync Window</span>
                                    <div className="flex items-center gap-2 mt-2">
                                      {(() => {
                                        const { hour, minute } = getCronTime(backupCfg.schedule_cron);
                                        return (
                                          <><input type="number" min={0} max={23} value={hour} onChange={e => setCronTime(e.target.value.padStart(2, '0'), minute)} className="ui-input w-24 text-center font-black text-lg" />
                                          <span className="font-black text-xl">:</span>
                                          <input type="number" min={0} max={59} value={minute} onChange={e => setCronTime(hour, e.target.value.padStart(2, '0'))} className="ui-input w-24 text-center font-black text-lg" /></>
                                        );
                                      })()}
                                    </div>
                                  </label>
                               </div>
                               <div className="space-y-4">
                                  <label className="flex items-center gap-3 cursor-pointer group mb-6">
                                     <div className={`relative inline-flex h-6 w-12 items-center rounded-full transition-colors ${backupCfg.cloud_storage_enabled ? 'bg-indigo-600 shadow-lg shadow-indigo-500/30' : 'bg-app-border'}`}>
                                        <input type="checkbox" checked={backupCfg.cloud_storage_enabled} onChange={e => setBackupCfg({ ...backupCfg, cloud_storage_enabled: e.target.checked })} className="sr-only" />
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-app-surface shadow-sm transition-transform ${backupCfg.cloud_storage_enabled ? 'translate-x-7' : 'translate-x-1'}`} />
                                     </div>
                                     <span className="text-xs font-black uppercase tracking-tight text-app-text group-hover:text-indigo-500 transition-colors">Off-Site Storage</span>
                                  </label>
                                  <div className="space-y-3 opacity-60">
                                     <input placeholder="S3 Bucket" value={backupCfg.cloud_bucket_name} onChange={e => setBackupCfg({ ...backupCfg, cloud_bucket_name: e.target.value })} className="ui-input w-full text-[11px] font-bold" disabled={!backupCfg.cloud_storage_enabled} />
                                     <input placeholder="Region" value={backupCfg.cloud_region} onChange={e => setBackupCfg({ ...backupCfg, cloud_region: e.target.value })} className="ui-input w-full text-[11px] font-bold" disabled={!backupCfg.cloud_storage_enabled} />
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
                                  <h4 className="text-xs font-black uppercase tracking-widest text-app-text mb-2">Db Structure Health</h4>
                                  <p className="text-[10px] text-app-text-muted leading-relaxed font-bold uppercase opacity-60">Reclaims disk space and updates query planner stats.</p>
                                  <button onClick={handleOptimize} disabled={optimizeBusy} className="mt-4 w-full h-12 rounded-xl bg-app-accent text-white font-black uppercase tracking-widest hover:bg-app-accent-hover transition-all active:scale-95 shadow-lg shadow-app-accent/30">
                                     {optimizeBusy ? "VACUUMING..." : "Optimize Now"}
                                  </button>
                               </div>
                               <div className="pt-6 border-t border-app-border/40">
                                  <h4 className="text-xs font-black uppercase tracking-widest text-app-text mb-2">Integrity Check</h4>
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

              {activeTab === 'printing' && (
                <div className="space-y-12">
                   <header className="mb-10">
                      <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Printing Hub & Layouts</h2>
                      <p className="text-sm text-app-text-muted mt-2 font-medium">Manage station-specific thermal printers and universal reporting destinations.</p>
                   </header>

                   <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
                      <div className="xl:col-span-12 xl:grid xl:grid-cols-2 gap-10">
                         
                         {/* Station Printer Hub */}
                         <section className="ui-card p-8 border-l-4 border-app-accent">
                            <div className="flex items-center gap-4 mb-4">
                               <div className="p-3 rounded-2xl bg-app-accent/10 text-app-accent"><Printer size={24} /></div>
                               <div>
                                  <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">Hardware Bridging</h3>
                                  <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">Local Thermal Station</p>
                               </div>
                            </div>

                            {saved && activeTab === 'printing' && (
                              <div className="mb-6 rounded-lg bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-500 font-black uppercase tracking-widest border border-emerald-500/20 flex items-center gap-2 animate-in fade-in zoom-in duration-300">
                                 <CheckCircle2 className="w-3 h-3" /> Hardware configs cached.
                              </div>
                            )}

                            <div className="space-y-6">
                               <div className="grid grid-cols-2 gap-4">
                                  <label className="block">
                                     <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Receipt Printer IP</span>
                                     <input 
                                       value={receiptPrinterIp} 
                                       onChange={e => saveReceiptPrinter(e.target.value, receiptPrinterPort)} 
                                       placeholder="127.0.0.1"
                                       className="ui-input mt-2 w-full font-mono font-bold" 
                                     />
                                  </label>
                                  <label className="block">
                                     <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">TCP Port</span>
                                     <input 
                                       value={receiptPrinterPort} 
                                       onChange={e => saveReceiptPrinter(receiptPrinterIp, e.target.value)} 
                                       placeholder="9100"
                                       className="ui-input mt-2 w-full font-mono font-bold" 
                                     />
                                  </label>
                               </div>

                               <label className="block pt-4 border-t border-app-border">
                                  <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Universal Report Printer</span>
                                  <input 
                                    value={reportPrinterIp} 
                                    onChange={e => saveReportPrinter(e.target.value)} 
                                    placeholder="e.g. office-laser.local or IP"
                                    className="ui-input mt-2 w-full font-mono font-bold" 
                                  />
                                  <p className="text-[10px] text-app-text-muted mt-2 italic">Destination for PDF End-of-Day and Commission Reports.</p>
                               </label>
                            </div>
                         </section>

                         {/* Receipt Content Builder */}
                         {cfg && (
                           <section className="ui-card p-8 border-l-4 border-app-text">
                              <div className="flex items-center justify-between mb-8">
                                 <div className="flex items-center gap-4">
                                    <div className="p-3 rounded-2xl bg-app-text text-white shadow-lg"><FileText size={24} /></div>
                                    <div>
                                       <h3 className="text-lg font-black uppercase tracking-tighter italic text-app-text">Thermal receipt (ZPL)</h3>
                                       <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest">Header text &amp; line toggles</p>
                                    </div>
                                 </div>
                                 <button onClick={saveReceiptSettings} disabled={busy} className="h-10 px-6 rounded-xl bg-app-text text-white text-[10px] font-black uppercase tracking-widest hover:bg-black/80 transition-all flex items-center gap-2">
                                    {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save size={14} />}
                                    Apply
                                 </button>
                              </div>

                              <div className="space-y-6">
                                 <label className="block">
                                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Store Identifier (Header)</span>
                                    <input value={cfg.store_name} onChange={e => setCfg({...cfg, store_name: e.target.value})} className="ui-input mt-2 w-full font-black text-lg tracking-tighter italic" />
                                 </label>
                                 
                                 <div className="grid grid-cols-2 gap-4">
                                    {[
                                      ["show_address", "Store Address", "123 Main St..."],
                                      ["show_phone", "Phone Number", "(555) 123..."],
                                      ["show_email", "Email Contact", "sales@..."],
                                      ["show_barcode", "Order Barcode", "CODE-128"],
                                      ["show_loyalty_earned", "Loyalty Rewards", "Earned Points"],
                                      ["show_loyalty_balance", "Points Balance", "Total Tier"],
                                    ].map(([k, label, sub]) => (
                                      <label key={k} className="flex items-center gap-3 p-3 rounded-xl border border-app-border hover:border-app-accent cursor-pointer group transition-all">
                                         <div className={`h-5 w-5 rounded border-2 flex items-center justify-center transition-all ${cfg[k as keyof ReceiptConfig] === true ? 'bg-app-accent border-app-accent text-white' : 'border-app-border group-hover:border-app-accent'}`}>
                                            {cfg[k as keyof ReceiptConfig] === true ? <CheckCircle2 size={12} /> : null}
                                         </div>
                                         <input type="checkbox" checked={cfg[k as keyof ReceiptConfig] === true} onChange={e => setCfg({...cfg, [k]: e.target.checked})} className="sr-only" />
                                         <div>
                                            <p className="text-[10px] font-black uppercase text-app-text tracking-widest leading-none">{label}</p>
                                            <p className="text-[9px] text-app-text-muted mt-1 opacity-60 font-bold">{sub}</p>
                                         </div>
                                      </label>
                                    ))}
                                 </div>
                              </div>
                           </section>
                         )}
                      </div>
                   </div>
                </div>
              )}

              {activeTab === 'integrations' && (
                <div className="space-y-12">
                   <header className="mb-10">
                      <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Integrations & Bridges</h2>
                      <p className="text-sm text-app-text-muted mt-2 font-medium leading-relaxed">
                        Connect external ledgers and enterprise services.
                        <span className="mt-2 block text-xs font-medium">
                          NCR Counterpoint (Windows SQL bridge) lives in its own{" "}
                          <strong className="text-app-text">Counterpoint</strong> area in System Control — not here.
                        </span>
                      </p>
                   </header>

                   {hasPermission("settings.admin") ? (
                     <section className="ui-card p-8 max-w-3xl border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent">
                       <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                         <div className="flex items-center gap-3">
                           <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
                             <Search className="h-6 w-6" aria-hidden />
                           </div>
                           <div>
                             <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                               Meilisearch (fuzzy search)
                             </h3>
                             <p className="text-xs text-app-text-muted mt-1 max-w-xl leading-relaxed">
                               Rebuilds all search indexes from PostgreSQL (inventory variants, store catalog,
                               customers, weddings, orders). Use after enabling Meilisearch, restoring its data
                               volume, or if search results look stale. Large catalogs can take several minutes;
                               the app keeps working and falls back to SQL search if Meilisearch is unavailable.
                             </p>
                           </div>
                         </div>
                         <span className="ui-pill bg-app-surface-2 text-app-text-muted text-[9px]">
                           {meiliConfigured === null
                             ? "Status unknown"
                             : meiliConfigured
                               ? "Configured on server"
                               : "Not configured"}
                         </span>
                       </div>
                       {!meiliConfigured && meiliConfigured !== null ? (
                         <p className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-app-text leading-relaxed">
                           <span className="font-black uppercase tracking-widest text-amber-800 dark:text-amber-200">
                             Server env required
                           </span>
                           <span className="block mt-2 text-app-text-muted">
                             Set{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                               RIVERSIDE_MEILISEARCH_URL
                             </code>{" "}
                             (and{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                               RIVERSIDE_MEILISEARCH_API_KEY
                             </code>{" "}
                             when the instance requires it) on the API host, then restart the server.
                           </span>
                         </p>
                       ) : null}
                       <div className="flex flex-wrap items-center gap-3">
                         <button
                           type="button"
                           disabled={meiliReindexBusy || meiliConfigured !== true}
                           onClick={() => setMeiliReindexConfirmOpen(true)}
                           className="ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest"
                         >
                           {meiliReindexBusy ? "Rebuilding…" : "Rebuild search index"}
                         </button>
                         <button
                           type="button"
                           disabled={meiliReindexBusy}
                           onClick={() => void fetchMeilisearchStatus()}
                           className="ui-btn-secondary px-4 py-2.5 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
                         >
                           <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                           Refresh status
                         </button>
                       </div>
                     </section>
                   ) : null}

                   <InsightsIntegrationSettings />

                   {weatherCfg ? (
                     <section className="ui-card p-8 max-w-3xl border-sky-500/20 bg-gradient-to-br from-sky-500/5 to-transparent">
                       <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                         <div className="flex items-center gap-3">
                           <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-600">
                             <Cloud className="h-6 w-6" aria-hidden />
                           </div>
                           <div>
                             <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Visual Crossing Weather</h3>
                             <p className="text-xs text-app-text-muted mt-1 max-w-xl">
                               Dashboard and Golden Rule snapshots use the{" "}
                               <a
                                 href="https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/"
                                 target="_blank"
                                 rel="noreferrer"
                                 className="font-bold text-sky-600 underline decoration-sky-500/40 hover:decoration-sky-600"
                               >
                                 Timeline Weather API
                               </a>
                               . Without a key, the server uses deterministic mock data (Buffalo-style). The API key is stored only on the server.
                             </p>
                           </div>
                         </div>
                         <span className="ui-pill bg-app-surface-2 text-app-text-muted text-[9px]">
                           {weatherCfg.api_key_configured ? "Key on file" : "Mock mode"}
                         </span>
                       </div>
                       <div className="grid gap-4 sm:grid-cols-2">
                         <label className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3">
                           <input
                             type="checkbox"
                             className="h-4 w-4 rounded border-app-border"
                             checked={weatherCfg.enabled}
                             onChange={(e) =>
                               setWeatherCfg({ ...weatherCfg, enabled: e.target.checked })
                             }
                           />
                           <span className="text-xs font-bold text-app-text">Use Visual Crossing for live weather</span>
                         </label>
                         <div className="sm:col-span-2">
                           <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                             Location (address, city, or lat,lon)
                           </label>
                           <input
                             className="ui-input w-full px-3 py-2 text-sm"
                             value={weatherCfg.location}
                             onChange={(e) =>
                               setWeatherCfg({ ...weatherCfg, location: e.target.value })
                             }
                             placeholder="Buffalo,NY,US"
                           />
                         </div>
                         <div>
                           <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                             Units
                           </label>
                           <select
                             className="ui-input w-full px-3 py-2 text-sm"
                             value={weatherCfg.unit_group}
                             onChange={(e) =>
                               setWeatherCfg({ ...weatherCfg, unit_group: e.target.value })
                             }
                           >
                             <option value="us">US (°F, inches)</option>
                             <option value="metric">Metric (converted to °F / in for ROS)</option>
                           </select>
                         </div>
                         <div>
                           <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                             Store timezone (IANA)
                           </label>
                           <input
                             className="ui-input w-full px-3 py-2 font-mono text-xs"
                             value={weatherCfg.timezone}
                             onChange={(e) =>
                               setWeatherCfg({ ...weatherCfg, timezone: e.target.value })
                             }
                             placeholder="America/New_York"
                           />
                         </div>
                         <div className="sm:col-span-2">
                           <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                             API key {weatherCfg.api_key_configured ? "(leave blank to keep existing)" : ""}
                           </label>
                           <input
                             type="password"
                             className="ui-input w-full px-3 py-2 text-sm font-mono"
                             value={weatherApiKeyDraft}
                             onChange={(e) => setWeatherApiKeyDraft(e.target.value)}
                             placeholder={weatherCfg.api_key_configured ? "••••••••" : "Paste key from Visual Crossing account"}
                             autoComplete="off"
                           />
                         </div>
                       </div>
                       <div className="mt-6 flex flex-wrap items-center gap-3">
                         <button
                           type="button"
                           disabled={busy}
                           onClick={() => void saveWeatherSettings()}
                           className="ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest"
                         >
                           Save weather settings
                         </button>
                         {weatherCfg.api_key_configured ? (
                           <button
                             type="button"
                             disabled={busy}
                             onClick={() => void clearWeatherApiKey()}
                             className="ui-btn-secondary px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-red-600 border-red-200"
                           >
                             Remove API key
                           </button>
                         ) : null}
                       </div>
                     </section>
                   ) : null}

                   {podiumSms ? (
                     <section
                       data-testid="podium-sms-settings-section"
                       className="ui-card p-8 max-w-4xl border-violet-500/20 bg-gradient-to-br from-violet-500/5 to-transparent"
                     >
                       {!podiumSms.credentials_configured ? (
                         <div
                           className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-app-text"
                           role="status"
                         >
                           <p className="font-black uppercase tracking-widest text-amber-800 dark:text-amber-200">
                             Podium API credentials missing
                           </p>
                           <p className="mt-2 leading-relaxed text-app-text-muted">
                             Outbound SMS stays disabled until{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                               RIVERSIDE_PODIUM_CLIENT_ID
                             </code>
                             ,{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                               RIVERSIDE_PODIUM_CLIENT_SECRET
                             </code>
                             , and{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                               RIVERSIDE_PODIUM_REFRESH_TOKEN
                             </code>{" "}
                             are set on the API host. You can still save templates and the storefront snippet below.
                           </p>
                           <p className="mt-3 text-[10px] text-app-text-muted leading-relaxed">
                             In the Podium developer app, register this redirect URI (must match exactly):{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono">
                               {typeof window !== "undefined"
                                 ? getPodiumOAuthRedirectUri() ?? "/callback"
                                 : "/callback"}
                             </code>
                             . Local dev often uses{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[9px]">
                               http://localhost:5173/callback
                             </code>
                             ; if Podium’s portal only accepts HTTPS, set{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[9px]">
                               VITE_PODIUM_OAUTH_REDIRECT_URI
                             </code>{" "}
                             and use Vite{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono text-[9px]">
                               server.https
                             </code>{" "}
                             or a tunnel. Then use Connect Podium to obtain{" "}
                             <code className="rounded bg-app-surface-2 px-1 font-mono">
                               RIVERSIDE_PODIUM_REFRESH_TOKEN
                             </code>{" "}
                             without putting the client secret in the browser.
                           </p>
                           <div className="mt-4">
                             <button
                               type="button"
                               data-testid="podium-oauth-connect"
                               onClick={() => void startPodiumOAuthConnect()}
                               className="ui-btn-secondary px-4 py-2.5 text-[10px] font-black uppercase tracking-widest border-violet-300 text-violet-800"
                             >
                               Connect Podium (get refresh token)
                             </button>
                           </div>
                         </div>
                       ) : null}
                       {podiumReadiness ? (
                         <div className="mb-6 rounded-xl border border-app-border bg-app-surface-2/50 px-4 py-3 text-[10px] font-mono text-app-text-muted leading-relaxed">
                           <span className="font-black uppercase tracking-widest text-app-text">
                             Readiness
                           </span>
                           <span className="mx-2 text-app-border">|</span>
                           API base: {podiumReadiness.api_base}
                           <span className="mx-2 text-app-border">|</span>
                           Webhook secret:{" "}
                           {podiumReadiness.webhook_secret_configured ? "set" : "unset"}
                           {podiumReadiness.allow_unsigned_webhook ? (
                             <span className="text-amber-600"> (unsigned allowed)</span>
                           ) : null}
                           <span className="mx-2 text-app-border">|</span>
                           Inbox preview:{" "}
                           {podiumReadiness.inbound_inbox_preview_enabled ? "on" : "off"}
                           <span className="mx-2 text-app-border">|</span>
                           Email send:{" "}
                           {podiumReadiness.email_send_enabled ? "on" : "off"}
                         </div>
                       ) : null}
                       <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                         <div className="flex items-center gap-3">
                           <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-600">
                             <MessageSquare className="h-6 w-6" aria-hidden />
                           </div>
                           <div>
                             <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                               Podium (SMS + email + web chat)
                             </h3>
                             <p className="text-xs text-app-text-muted mt-1 max-w-2xl leading-relaxed">
                               Operational SMS and HTML email (pickup, alteration ready, appointment confirmations, loyalty threshold) send through Podium when enabled. Follow{" "}
                               <a
                                 href="https://docs.podium.com/docs/getting-started"
                                 target="_blank"
                                 rel="noreferrer"
                                 className="font-bold text-violet-600 underline decoration-violet-500/40 hover:decoration-violet-600"
                               >
                                 Podium — Get Started
                               </a>
                               : developer app, OAuth (
                               <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                                 {podiumSms.oauth_authorize_url}
                               </code>
                               ), then{" "}
                               <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                                 GET /v4/locations
                               </code>{" "}
                               for your{" "}
                               <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                                 locationUid
                               </code>
                               . OAuth client id, secret, and refresh token are server environment variables only (never stored in the database).
                             </p>
                           </div>
                         </div>
                         <span
                           className={`ui-pill text-[9px] ${podiumSms.credentials_configured ? "bg-emerald-500/15 text-emerald-700" : "bg-app-surface-2 text-app-text-muted"}`}
                         >
                           {podiumSms.credentials_configured ? "Env credentials present" : "Env credentials missing"}
                         </span>
                       </div>

                       <p className="text-[10px] font-mono text-app-text-muted mb-4 leading-relaxed break-all">
                         Token URL: {podiumSms.oauth_token_url_hint}
                       </p>

                       <div className="rounded-xl border border-app-border bg-app-surface-2/60 p-4 mb-6">
                         <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">
                           Server environment (set on API host)
                         </p>
                         <ul className="text-xs font-mono text-app-text space-y-1 list-disc list-inside">
                           <li>RIVERSIDE_PODIUM_CLIENT_ID</li>
                           <li>RIVERSIDE_PODIUM_CLIENT_SECRET</li>
                           <li>RIVERSIDE_PODIUM_REFRESH_TOKEN</li>
                           <li className="text-app-text-muted">Optional: RIVERSIDE_PODIUM_OAUTH_TOKEN_URL</li>
                         </ul>
                       </div>

                       <div className="grid gap-4 sm:grid-cols-2 mb-6">
                         <label className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3 sm:col-span-2">
                           <input
                             type="checkbox"
                             className="h-4 w-4 rounded border-app-border"
                             checked={podiumSms.sms_send_enabled}
                             onChange={(e) =>
                               setPodiumSms({ ...podiumSms, sms_send_enabled: e.target.checked })
                             }
                           />
                           <span className="text-xs font-bold text-app-text">
                             Send operational SMS via Podium (pickup / alteration ready)
                           </span>
                         </label>
                         <label className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3 sm:col-span-2">
                           <input
                             type="checkbox"
                             className="h-4 w-4 rounded border-app-border"
                             checked={podiumSms.email_send_enabled}
                             onChange={(e) =>
                               setPodiumSms({
                                 ...podiumSms,
                                 email_send_enabled: e.target.checked,
                               })
                             }
                           />
                           <span className="text-xs font-bold text-app-text">
                             Send operational email via Podium (pickup, alterations, appointments, loyalty)
                           </span>
                         </label>
                         <div className="sm:col-span-2">
                           <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                             Podium location UID
                           </label>
                           <input
                             className="ui-input w-full px-3 py-2 font-mono text-xs"
                             value={podiumSms.location_uid}
                             onChange={(e) =>
                               setPodiumSms({ ...podiumSms, location_uid: e.target.value })
                             }
                             placeholder="From GET https://api.podium.com/v4/locations"
                           />
                         </div>
                       </div>

                       <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                         Automated SMS copy
                       </h4>
                       <p className="text-[10px] text-app-text-muted mb-4">
                         Placeholders:{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{first_name}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{order_ref}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{alteration_ref}"}</code>.
                         Unknown-sender welcome is stored for a future inbound flow; it is not sent yet.
                         Loyalty SMS sends only when staff checks SMS at redemption.
                       </p>
                       <div className="space-y-4 mb-6">
                         {(
                           [
                             ["ready_for_pickup", "Ready for pickup"],
                             ["alteration_ready", "Alteration ready"],
                             ["unknown_sender_welcome", "Unknown-sender welcome (future)"],
                             ["loyalty_reward_redeemed", "Loyalty reward (at redemption)"],
                           ] as const
                         ).map(([key, label]) => (
                           <div key={key}>
                             <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                               <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                 {label}
                               </span>
                               <button
                                 type="button"
                                 className="text-[10px] font-bold uppercase tracking-wider text-violet-600 hover:underline"
                                 onClick={() =>
                                   setPodiumSms({
                                     ...podiumSms,
                                     templates: {
                                       ...podiumSms.templates,
                                       [key]: PODIUM_TEMPLATE_DEFAULTS[key],
                                     },
                                   })
                                 }
                               >
                                 Reset to default
                               </button>
                             </div>
                             <textarea
                               className="ui-input min-h-[88px] w-full resize-y text-sm"
                               value={podiumSms.templates[key]}
                               onChange={(e) =>
                                 setPodiumSms({
                                   ...podiumSms,
                                   templates: { ...podiumSms.templates, [key]: e.target.value },
                                 })
                               }
                               spellCheck
                             />
                           </div>
                         ))}
                       </div>

                       <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                         Automated email (subject + HTML)
                       </h4>
                       <p className="text-[10px] text-app-text-muted mb-4">
                         Placeholders include{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{first_name}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{order_ref}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{alteration_ref}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{starts_at}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{appointment_type}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{notes_block}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{reward_amount}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{new_balance}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{points_redeemed}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{reward_breakdown}"}</code>,{" "}
                         <code className="rounded bg-app-surface-2 px-1">{"{reward_breakdown_html}"}</code>.
                       </p>
                       <div className="space-y-6 mb-6">
                         {PODIUM_EMAIL_UI_BLOCKS.map(({ label, subjectKey, htmlKey }) => (
                           <div
                             key={subjectKey}
                             className="rounded-xl border border-app-border bg-app-surface-2/40 p-4 space-y-3"
                           >
                             <div className="flex flex-wrap items-center justify-between gap-2">
                               <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                 {label}
                               </span>
                               <button
                                 type="button"
                                 className="text-[10px] font-bold uppercase tracking-wider text-violet-600 hover:underline"
                                 onClick={() =>
                                   setPodiumSms({
                                     ...podiumSms,
                                     email_templates: {
                                       ...podiumSms.email_templates,
                                       [subjectKey]: PODIUM_EMAIL_TEMPLATE_DEFAULTS[subjectKey],
                                       [htmlKey]: PODIUM_EMAIL_TEMPLATE_DEFAULTS[htmlKey],
                                     },
                                   })
                                 }
                               >
                                 Reset to default
                               </button>
                             </div>
                             <div>
                               <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                                 Subject
                               </label>
                               <input
                                 className="ui-input w-full px-3 py-2 text-sm"
                                 value={podiumSms.email_templates[subjectKey]}
                                 onChange={(e) =>
                                   setPodiumSms({
                                     ...podiumSms,
                                     email_templates: {
                                       ...podiumSms.email_templates,
                                       [subjectKey]: e.target.value,
                                     },
                                   })
                                 }
                                 spellCheck
                               />
                             </div>
                             <div>
                               <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                                 HTML body
                               </label>
                               <textarea
                                 className="ui-input min-h-[100px] w-full resize-y font-mono text-xs"
                                 value={podiumSms.email_templates[htmlKey]}
                                 onChange={(e) =>
                                   setPodiumSms({
                                     ...podiumSms,
                                     email_templates: {
                                       ...podiumSms.email_templates,
                                       [htmlKey]: e.target.value,
                                     },
                                   })
                                 }
                                 spellCheck={false}
                               />
                             </div>
                           </div>
                         ))}
                       </div>

                       <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                         Storefront web chat widget
                       </h4>
                       <p className="text-xs text-app-text-muted mb-3 leading-relaxed">
                         Paste the embed snippet from the Podium dashboard. Public sites should set{" "}
                         <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                           VITE_STOREFRONT_EMBEDS=true
                         </code>{" "}
                         so the shell loads{" "}
                         <code className="rounded bg-app-surface-2 px-1 font-mono text-[10px]">
                           GET /api/public/storefront-embeds
                         </code>{" "}
                         once and injects this HTML (keep staff builds without that flag so the widget does not load in Back Office).
                       </p>
                       <label className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2/80 px-4 py-3 mb-3">
                         <input
                           type="checkbox"
                           className="h-4 w-4 rounded border-app-border"
                           checked={podiumSms.widget_embed_enabled}
                           onChange={(e) =>
                             setPodiumSms({ ...podiumSms, widget_embed_enabled: e.target.checked })
                           }
                         />
                         <span className="text-xs font-bold text-app-text">Enable snippet for public storefront embed API</span>
                       </label>
                       <textarea
                         className="ui-input min-h-[120px] w-full resize-y font-mono text-xs"
                         value={podiumSms.widget_snippet_html}
                         onChange={(e) =>
                           setPodiumSms({ ...podiumSms, widget_snippet_html: e.target.value })
                         }
                         placeholder="Paste Podium script / HTML embed…"
                         spellCheck={false}
                       />

                       <div className="mt-6 flex flex-wrap gap-3">
                         <button
                           type="button"
                           disabled={busy}
                           onClick={() => void savePodiumSmsSettings()}
                           className="ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest"
                         >
                           Save Podium / messaging settings
                         </button>
                         {podiumSms.credentials_configured ? (
                           <button
                             type="button"
                             disabled={busy}
                             data-testid="podium-oauth-connect-again"
                             onClick={() => void startPodiumOAuthConnect()}
                             className="ui-btn-secondary px-4 py-2.5 text-[10px] font-black uppercase tracking-widest"
                           >
                             Connect Podium (refresh token)
                           </button>
                         ) : null}
                       </div>
                     </section>
                   ) : (
                     <section className="ui-card p-8 max-w-4xl border-app-border">
                       <p className="text-sm font-bold text-app-text">
                         Could not load Podium settings (check permissions or network).
                       </p>
                       <button
                         type="button"
                         disabled={busy}
                         onClick={() => void fetchPodiumSmsSettings()}
                         className="mt-4 ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-widest"
                       >
                         Retry
                       </button>
                     </section>
                   )}

                   <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
                      <section className="ui-card p-10 flex flex-col items-center text-center">
                         <div className="w-20 h-20 bg-[#2ca01c]/10 text-[#2ca01c] rounded-[2rem] flex items-center justify-center mb-6">
                            <span className="font-black text-4xl italic tracking-tighter">qb</span>
                         </div>
                         <h3 className="text-xl font-black italic tracking-tight uppercase mb-2">QuickBooks Online</h3>
                         <p className="text-xs font-bold text-app-text-muted uppercase tracking-widest mb-8 leading-relaxed">Financial Ledger & Inventory Sync</p>
                         <button onClick={onOpenQbo} className="w-full h-14 rounded-2xl bg-[#2ca01c] text-white font-black uppercase tracking-[0.2em] shadow-xl shadow-[#2ca01c]/20 hover:scale-[1.02] transition-all">Launch Bridge</button>
                      </section>

                      <section className="ui-card p-10 flex flex-col items-center text-center opacity-40">
                         <div className="w-20 h-20 bg-indigo-500/10 text-indigo-500 rounded-[2rem] flex items-center justify-center mb-6">
                            <span className="font-black text-4xl italic tracking-tighter">sk</span>
                         </div>
                         <h3 className="text-xl font-black italic tracking-tight uppercase mb-2">Stripe Terminal</h3>
                         <p className="text-xs font-bold text-app-text-muted uppercase tracking-widest mb-8 leading-relaxed">Integrated Payments</p>
                         <button disabled className="w-full h-14 rounded-2xl bg-app-surface-2 text-app-text-muted font-black uppercase tracking-[0.2em] cursor-not-allowed">Coming Soon</button>
                      </section>
                   </div>
                </div>
              )}

              {activeTab === "staff-access-defaults" &&
                (hasPermission("settings.admin") || hasPermission("staff.manage_access")) && (
                  <div className="space-y-10">
                    <header className="mb-2">
                      <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
                        Staff access defaults
                      </h2>
                      <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                        Role-wide templates used when onboarding or when you click{" "}
                        <strong className="text-app-text">Apply role defaults</strong> on an individual
                        profile in Staff → Team. Day-to-day permissions and discount caps are stored per staff
                        member.
                      </p>
                    </header>
                    <StaffRoleAccessPanel />
                    <StaffDiscountCapsPanel />
                  </div>
                )}

              {activeTab === "counterpoint" && hasPermission("settings.admin") && (
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
                          The Windows bridge on your Counterpoint SQL host posts catalog, customers, gift cards,
                          and ticket history into Riverside. Manage bridge health, staging and apply queues, and
                          Counterpoint-to-ROS code maps here — not mixed in with unrelated integrations.
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

              {activeTab === "online-store" && (
                <OnlineStoreSettingsPanel baseUrl={baseUrl} />
              )}

              {activeTab === "help-center" && <HelpCenterSettingsPanel />}
              {activeTab === "bug-reports" && hasPermission("settings.admin") && (
                <BugReportsSettingsPanel />
              )}
              
              {activeTab === "nuorder" && hasPermission("settings.admin") && (
                <NuorderSettingsPanel />
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

              {activeTab === 'general' && (
                <div className="space-y-12">
                   <header className="mb-10">
                      <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">System Settings</h2>
                      <p className="text-sm text-app-text-muted mt-2 font-medium">Environmental and UI overrides.</p>
                   </header>

                   <section className="ui-card p-8 max-w-2xl">
                      <label className="block">
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Interface Theme Architecture</span>
                        <div className="grid grid-cols-3 gap-4 mt-4">
                           {(['light', 'dark', 'system'] as ThemeMode[]).map(mode => (
                             <button
                                key={mode}
                                onClick={() => onThemeChange(mode)}
                                className={`flex flex-col items-center gap-3 p-6 rounded-2xl border-2 transition-all ${themeMode === mode ? 'border-app-text bg-app-text text-white shadow-xl' : 'border-app-border bg-app-surface text-app-text-muted hover:border-app-text'}`}
                             >
                                <span className="text-[10px] font-black uppercase tracking-widest">{mode}</span>
                                <div className={`h-1.5 w-1.5 rounded-full ${themeMode === mode ? 'bg-app-accent shadow-[0_0_8px_rgba(141,128,255,1)]' : 'bg-app-border'}`} />
                             </button>
                           ))}
                        </div>
                      </label>
                   </section>

                   {hasPermission("settings.admin") ? (
                     <section className="ui-card p-8 max-w-2xl">
                       <div className="mb-4 flex items-start gap-3">
                         <Star className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
                         <div className="min-w-0 flex-1">
                           <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                             Post-sale review invites
                           </h3>
                           <p className="mt-1 text-xs font-medium text-app-text-muted leading-relaxed">
                             Store-wide defaults for Podium review flows. The receipt summary (POS) still lets
                             cashiers opt out per sale when invites are enabled. Completing Podium review
                             sending remains in Integrations.
                           </p>
                         </div>
                       </div>
                       {!reviewPolicyLoaded || !reviewPolicy ? (
                         <p className="text-sm font-medium text-app-text-muted">Loading…</p>
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
                                     ? { ...p, review_invites_enabled: e.target.checked }
                                     : p,
                                 )
                               }
                             />
                             <span className="text-sm font-medium text-app-text">
                               Enable post-sale review invites (when Podium is configured on the server).
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
                                     ? { ...p, send_review_invite_by_default: e.target.checked }
                                     : p,
                                 )
                               }
                             />
                             <span className="text-sm font-medium text-app-text">
                               Default receipt summary to send an invite (unchecked means cashiers must
                               confirm sending, or check &quot;do not send&quot; to suppress).
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

                   <section className="ui-card p-8 max-w-4xl">
                      <div className="mb-4 flex items-start gap-3">
                        <ClipboardList className="mt-0.5 h-5 w-5 shrink-0 text-app-accent" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                            Store staff playbook
                          </h3>
                          <p className="mt-1 text-xs font-medium text-app-text-muted leading-relaxed">
                            Markdown notes for <strong className="text-app-text">this store</strong> (contacts, void rules,
                            cash tolerance, seasonal policy). Staff can read it via{" "}
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
                        <p className="text-sm font-medium text-app-text-muted">Loading…</p>
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
                                  new TextEncoder().encode(staffSopMarkdown).length > STAFF_SOP_MAX_BYTES
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
                        <Info className="h-5 w-5 text-app-accent shrink-0" aria-hidden />
                        <div>
                          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">About this build</h3>
                          <p className="text-xs text-app-text-muted mt-1 font-medium">
                            Share these details with support when reporting an issue. PWA users may need a hard refresh after deploy if the shell looks outdated.
                          </p>
                        </div>
                      </div>
                      <dl className="grid gap-3 text-sm">
                        <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                          <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">Surface</dt>
                          <dd className="font-mono text-app-text tabular-nums">{tauriShellVersion != null ? `Desktop (Tauri ${tauriShellVersion})` : "Web / PWA"}</dd>
                        </div>
                        <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                          <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">Client version</dt>
                          <dd className="font-mono text-app-text tabular-nums">{CLIENT_SEMVER}</dd>
                        </div>
                        <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                          <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">Git revision</dt>
                          <dd className="font-mono text-app-text tabular-nums">{GIT_SHORT}</dd>
                        </div>
                        <div className="flex flex-wrap justify-between gap-2 pt-1">
                          <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">API base</dt>
                          <dd className="font-mono text-xs text-app-text break-all text-right max-w-[min(100%,20rem)]">{import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000 (default)"}</dd>
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

      {meiliReindexConfirmOpen && (
        <ConfirmationModal
          isOpen={true}
          title="Rebuild search index?"
          message="This reloads Meilisearch from PostgreSQL (all indexes). It can take a while on large catalogs. Staff can keep working; search uses SQL fallback if Meilisearch is busy or down."
          confirmLabel="Rebuild index"
          onConfirm={() => void runMeilisearchReindex()}
          onClose={() => setMeiliReindexConfirmOpen(false)}
          variant="info"
        />
      )}
    </div>
  );
}
