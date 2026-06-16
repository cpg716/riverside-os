import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Database,
  Settings as SettingsIcon,
  Activity,
  Terminal,
  Play,
  Search,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
  Sparkles,
  Trash2,
  ArrowUpRight,
  Zap
} from "lucide-react";

const BRIDGE_API = "http://localhost:3002";
const ROS_BASE_URL = "http://localhost:3000";
const SYNC_WORKBENCH_BASE_URL = "http://127.0.0.1:3015";

interface BridgeSettings {
  sql_conn: string;
  ros_url: string;
  sync_token: string;
  sync_workbench_url: string;
  sync_workbench_token: string;
}

interface EntityStat {
  lastSync: string | null;
  durationMs: number;
  recordCount: number;
  error: string | null;
}

interface BridgeState {
  isSyncing: boolean;
  currentEntity: string | null;
  currentProgress: number; // 0-100
  totalRecordsLastRun: number;
  lastRunDurationMs: number;
  lastRun: string | null;
  entityStats: Record<string, EntityStat>;
  logs: { time: string; msg: string }[];
  isContinuous: boolean;
  runOnce: boolean;
}

interface UpdateCheckResult {
  enabled: boolean;
  available: boolean;
  version: string | null;
  date: string | null;
  notes: string | null;
  message: string | null;
  current_build: string | null;
  available_build: string | null;
}

interface InstallUpdateResult {
  enabled: boolean;
  installed: boolean;
  version: string | null;
  message: string | null;
  current_build: string | null;
  installed_build: string | null;
}

interface SyncWorkbenchCheck {
  ok: boolean;
  message: string;
  checkedAt: string;
}

const ENTITIES = [
  { key: "staff", label: "Staff", icon: "👤" },
  { key: "sales_rep_stubs", label: "Sales Reps", icon: "🏷️" },
  { key: "vendors", label: "Vendors", icon: "🚚" },
  { key: "customers", label: "Customers", icon: "👥" },
  { key: "store_credit_opening", label: "Store Credits", icon: "💳" },
  { key: "customer_notes", label: "Customer Notes", icon: "📝" },
  { key: "category_masters", label: "Categories", icon: "📂" },
  { key: "catalog", label: "Catalog", icon: "📦" },
  { key: "inventory", label: "Inventory", icon: "📊" },
  { key: "vendor_items", label: "Vendor Items", icon: "🔗" },
  { key: "gift_cards", label: "Gift Cards", icon: "🎁" },
  { key: "tickets", label: "Orders/Tickets", icon: "🧾" },
  { key: "open_docs", label: "Open Documents", icon: "📄" },
  { key: "receiving_history", label: "Receiving", icon: "📥" },
];

function App() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "settings" | "tester" | "logs">("dashboard");
  const [bridgeState, setBridgeState] = useState<BridgeState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [isProcessRunning, setIsProcessRunning] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [autodetectedFields, setAutodetectedFields] = useState<string[]>([]);
  const [isAutoconfiguring, setIsAutoconfiguring] = useState(false);
  const [syncProgress, setSyncProgress] = useState(0);
  const [testQueryEntity, setTestQueryEntity] = useState("customers");
  const [testQuerySql, setTestQuerySql] = useState("");
  const [testQueryResults, setTestQueryResults] = useState<any[]>([]);
  const [testQueryError, setTestQueryError] = useState("");
  const [testingQuery, setTestingQuery] = useState(false);

  const [rustLogs, setRustLogs] = useState<string[]>([]);
  const [selfUpdateCheck, setSelfUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [selfUpdateBusy, setSelfUpdateBusy] = useState(false);

  // Settings fields
  const [sqlConn, setSqlConn] = useState("");
  const [rosUrl, setRosUrl] = useState("");
  const [syncToken, setSyncToken] = useState("");
  const [syncWorkbenchUrl, setSyncWorkbenchUrl] = useState("");
  const [syncWorkbenchToken, setSyncWorkbenchToken] = useState("");
  const [syncWorkbenchCheck, setSyncWorkbenchCheck] = useState<SyncWorkbenchCheck | null>(null);
  const [syncWorkbenchChecking, setSyncWorkbenchChecking] = useState(false);

  const consoleEndRef = useRef<HTMLDivElement>(null);

  const hasRequiredBridgeSettings = useCallback((settings: BridgeSettings) => {
    return (
      settings.sql_conn.trim().length > 0 &&
      settings.sync_workbench_url.trim().length > 0
    );
  }, []);

  const normalizedRosUrl = useMemo(() => {
    const value = rosUrl.trim() || ROS_BASE_URL;
    return value.replace(/\/+$/, "");
  }, [rosUrl]);

  const normalizedSyncWorkbenchUrl = useMemo(() => {
    const value = syncWorkbenchUrl.trim() || SYNC_WORKBENCH_BASE_URL;
    return value.replace(/\/+$/, "");
  }, [syncWorkbenchUrl]);

  const openSyncWorkbench = useCallback(async () => {
    const url = normalizedSyncWorkbenchUrl;
    try {
      await openUrl(url);
    } catch (e: any) {
      setStatusMessage(`Could not open Counterpoint SYNC Workbench: ${e?.message ?? String(e)}`);
    }
  }, [normalizedSyncWorkbenchUrl]);

  const checkSyncWorkbenchReachability = useCallback(async (): Promise<boolean> => {
    const url = normalizedSyncWorkbenchUrl;
    setSyncWorkbenchChecking(true);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 5000);
      const headers: Record<string, string> = {};
      if (syncWorkbenchToken.trim()) {
        headers["x-counterpoint-sync-token"] = syncWorkbenchToken.trim();
      }
      const response = await fetch(`${url}/health`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (!response.ok) {
        const message = `SYNC Workbench answered ${response.status} at ${url}/health.`;
        setSyncWorkbenchCheck({ ok: false, message, checkedAt: new Date().toLocaleTimeString() });
        setStatusMessage(message);
        return false;
      }
      const health = await response.json() as { service?: string; ok?: boolean };
      const service = health.service === "counterpoint_sync_workbench" ? "Counterpoint SYNC Workbench" : "service";
      const message = `${service} is reachable at ${url}.`;
      setSyncWorkbenchCheck({ ok: true, message, checkedAt: new Date().toLocaleTimeString() });
      setStatusMessage(message);
      return true;
    } catch (e: any) {
      const message = `SYNC Workbench is not reachable at ${url}. Open the Workbench and confirm ${url}/health loads before starting extraction. ${e?.message ?? String(e)}`;
      setSyncWorkbenchCheck({ ok: false, message, checkedAt: new Date().toLocaleTimeString() });
      setStatusMessage(message);
      return false;
    } finally {
      setSyncWorkbenchChecking(false);
    }
  }, [normalizedSyncWorkbenchUrl, syncWorkbenchToken]);

  const loadEnvSettings = useCallback(async (): Promise<BridgeSettings | null> => {
    try {
      const data = await invoke<BridgeSettings>("load_settings");
      setSqlConn(data.sql_conn);
      setRosUrl(data.ros_url);
      setSyncToken(data.sync_token);
      setSyncWorkbenchUrl(data.sync_workbench_url);
      setSyncWorkbenchToken(data.sync_workbench_token);
      return data;
    } catch (e: any) {
      console.error("Failed to load settings:", e);
      setStatusMessage(`Failed to load bridge settings: ${e}`);
      return null;
    }
  }, []);

  const handleSaveSettings = async () => {
    try {
      const nextSettings = { sql_conn: sqlConn, ros_url: rosUrl, sync_token: syncToken, sync_workbench_url: syncWorkbenchUrl, sync_workbench_token: syncWorkbenchToken };
      if (!hasRequiredBridgeSettings(nextSettings)) {
        setStatusMessage("Enter the SQL connection and SYNC Workbench URL before starting the bridge.");
        return;
      }
      setStatusMessage("Saving bridge connection settings...");
      const result = await invoke<string>("save_settings", {
        sqlConn,
        rosUrl,
        syncToken,
        syncWorkbenchUrl,
        syncWorkbenchToken
      });
      setStatusMessage(result);
      // Restart the bridge to pick up new config
      await handleStartBridge(dryRun, nextSettings);
    } catch (e: any) {
      setStatusMessage(`Failed to save settings: ${e}`);
    }
  };

  // Load saved settings on mount; starting the bridge remains an explicit operator action.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const settings = await loadEnvSettings();
      if (!mounted) return;
      if (settings && hasRequiredBridgeSettings(settings)) {
        setStatusMessage("Bridge configuration loaded. Click Start Engine when ready.");
      } else {
        setStatusMessage("Bridge configuration is incomplete. Enter the SQL connection and SYNC Workbench URL, then Save Configuration.");
      }
    })();
    return () => {
      mounted = false;
      handleStopBridge();
    };
  }, [hasRequiredBridgeSettings, loadEnvSettings]);

  // Poll local bridge server status and Tauri process state (optimized with longer interval)
  useEffect(() => {
    let mounted = true;
    let lastBridgeState: BridgeState | null = null;
    let lastRustLogs: string[] = [];

    const pollStatus = async () => {
      if (!mounted) return;

      // 1. Check background subprocess status from Tauri
      try {
        const engine = await invoke<{ is_running: boolean; exit_code: number | null; rust_logs: string[] }>("get_engine_status");
        if (mounted) {
          setIsProcessRunning(engine.is_running);
          // Only update logs if they changed
          if (JSON.stringify(engine.rust_logs) !== JSON.stringify(lastRustLogs)) {
            setRustLogs(engine.rust_logs);
            lastRustLogs = engine.rust_logs;
          }
          if (!engine.is_running && engine.exit_code !== null) {
            setStatusMessage(`Sync engine exited with code: ${engine.exit_code}`);
          }
        }
      } catch (e) {
        console.error("Failed to query Tauri engine status:", e);
      }

      // 2. Query HTTP control API
      try {
        const res = await fetch(`${BRIDGE_API}/api/status`, { cache: 'no-store' });
        if (res.ok && mounted) {
          const data = await res.json();
          // Only update state if it changed
          if (JSON.stringify(data) !== JSON.stringify(lastBridgeState)) {
            setBridgeState(data);
            lastBridgeState = data;
            // Update progress if syncing
            if (data.isSyncing && data.currentProgress !== undefined) {
              setSyncProgress(data.currentProgress);
            }
          }
          setIsConnected(true);
        } else if (mounted) {
          setIsConnected(false);
        }
      } catch (e) {
        if (mounted) setIsConnected(false);
      }
    };

    // Initial poll
    pollStatus();
    // Poll every 5 seconds instead of 2 seconds for better performance
    const interval = setInterval(pollStatus, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Auto scroll logs
  useEffect(() => {
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [bridgeState?.logs, rustLogs]);

  const handleStartBridge = async (isDry = dryRun, settingsOverride?: BridgeSettings) => {
    try {
      const nextSettings = settingsOverride ?? { sql_conn: sqlConn, ros_url: rosUrl, sync_token: syncToken, sync_workbench_url: syncWorkbenchUrl, sync_workbench_token: syncWorkbenchToken };
      if (!hasRequiredBridgeSettings(nextSettings)) {
        setActiveTab("settings");
        setStatusMessage("Enter the SQL connection and SYNC Workbench URL before starting the bridge.");
        return;
      }
      setStatusMessage("Checking Counterpoint SYNC Workbench before extraction...");
      const syncReachable = await checkSyncWorkbenchReachability();
      if (!syncReachable) return;
      setStatusMessage("Starting background sync engine...");
      const result = await invoke<string>("start_bridge", { dryRun: isDry });
      setIsProcessRunning(true);
      setStatusMessage(result);
    } catch (err: any) {
      setStatusMessage(`Error starting bridge: ${err}`);
    }
  };

  const handleStopBridge = async () => {
    try {
      setStatusMessage("Stopping sync engine...");
      const result = await invoke<string>("stop_bridge");
      setIsProcessRunning(false);
      setIsConnected(false);
      setBridgeState(null);
      setStatusMessage(result);
    } catch (err: any) {
      setStatusMessage(`Error: ${err}`);
    }
  };

  const handleCheckAppUpdate = async () => {
    if (selfUpdateBusy) return;
    setSelfUpdateBusy(true);
    try {
      const result = await invoke<UpdateCheckResult>("check_app_update");
      setSelfUpdateCheck(result);
      setStatusMessage(
        result.available
          ? `Bridge GUI update available: ${result.version}${result.available_build ? ` (${result.available_build})` : ""}`
          : result.message ?? "No Bridge GUI update available.",
      );
    } catch (e: any) {
      setStatusMessage(`Bridge GUI update check failed: ${e}`);
    } finally {
      setSelfUpdateBusy(false);
    }
  };

  const handleInstallAppUpdate = async () => {
    if (selfUpdateBusy) return;
    setSelfUpdateBusy(true);
    try {
      const result = await invoke<InstallUpdateResult>("install_app_update");
      setStatusMessage(
        result.installed
          ? result.message ?? `Bridge GUI updated to ${result.version}.`
          : result.message ?? "No Bridge GUI update available.",
      );
    } catch (e: any) {
      setStatusMessage(`Bridge GUI install failed: ${e}`);
    } finally {
      setSelfUpdateBusy(false);
    }
  };

  const triggerFullSync = useCallback(async () => {
    if (!isConnected) return;
    try {
      setStatusMessage("Starting full Counterpoint extraction...");
      setSyncProgress(0);
      const res = await fetch(`${BRIDGE_API}/api/trigger-entity?name=full`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to trigger extraction');
      setStatusMessage("Counterpoint extraction started. Raw batches will land in the SYNC Workbench.");
    } catch (e: any) {
      setStatusMessage(`Failed to trigger sync: ${e.message}`);
    }
  }, [isConnected]);

  const triggerSingleSync = useCallback(async (key: string) => {
    if (!isConnected) return;
    try {
      setStatusMessage(`Extracting ${key}...`);
      setSyncProgress(0);
      const res = await fetch(`${BRIDGE_API}/api/trigger-entity?name=${key}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to trigger extraction');
      setStatusMessage(`${key} extraction started. Raw batches will land in the SYNC Workbench.`);
    } catch (e: any) {
      setStatusMessage(`Failed to trigger ${key} sync: ${e.message}`);
    }
  }, [isConnected]);

  const runAutoConfig = useCallback(async () => {
    setIsAutoconfiguring(true);
    setStatusMessage("Probing Counterpoint v8.4 schema and building runtime mappings...");
    try {
      const response = await fetch(`${BRIDGE_API}/api/auto-config`, {
        method: "POST",
        cache: "no-store"
      });
      const data = await response.json();
      if (data.success) {
        const changes = Array.isArray(data.changes) ? data.changes : [];
        setAutodetectedFields(
          changes.length > 0
            ? changes
            : ["Schema probe completed; standard Counterpoint SQL mappings are usable."]
        );
        setStatusMessage("Auto-config generated runtime mappings from the live Counterpoint schema.");
      } else {
        setStatusMessage(`Auto-config check encountered issues: ${data.error}`);
      }
    } catch (e: any) {
      setStatusMessage(`Auto-config failed to probe connection: ${e.message}`);
    } finally {
      setIsAutoconfiguring(false);
    }
  }, []);

  const testConfiguredQuery = useCallback(async () => {
    setTestingQuery(true);
    setTestQueryError("");
    setTestQueryResults([]);
    try {
      const res = await fetch(`${BRIDGE_API}/api/test-query?query=${testQueryEntity}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        setTestQueryResults(data.rows || []);
      } else {
        setTestQueryError(data.error || "Query failed");
      }
    } catch (e: any) {
      setTestQueryError(e.message);
    } finally {
      setTestingQuery(false);
    }
  }, [testQueryEntity]);

  const testCustomSql = useCallback(async () => {
    if (!testQuerySql.trim()) return;
    setTestingQuery(true);
    setTestQueryError("");
    setTestQueryResults([]);
    try {
      const res = await fetch(`${BRIDGE_API}/api/test-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: testQuerySql }),
        cache: 'no-store'
      });
      const data = await res.json();
      if (data.success) {
        setTestQueryResults(data.rows || []);
      } else {
        setTestQueryError(data.error || "Custom SQL execution failed");
      }
    } catch (e: any) {
      setTestQueryError(e.message);
    } finally {
      setTestingQuery(false);
    }
  }, [testQuerySql]);

  const fmtDuration = useCallback((ms: number) => {
    if (!ms) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  }, []);

  // Memoize entity stats to prevent unnecessary re-renders
  const entityStatsMemo = useMemo(() => {
    return ENTITIES.map((e) => {
      const st = bridgeState?.entityStats?.[e.key];
      const isRunning = bridgeState?.currentEntity === e.key;
      return { entity: e, stat: st, isRunning };
    });
  }, [bridgeState]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#08090c] text-[#e0e4ec] overflow-hidden select-none">
      {/* Top Header Bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-white/5 bg-[#0f1117]/80 backdrop-blur-md z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-linear-to-br from-[#f97316] to-[#ea580c] flex items-center justify-center shadow-lg shadow-orange-500/20">
            <Database className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-wider uppercase text-white">Riverside Countersync</h1>
            <p className="text-[10px] text-gray-500 font-medium">Counterpoint SQL → SYNC Workbench Extractor</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[10px] font-bold uppercase tracking-wider ${
            isConnected
              ? "bg-green-500/10 border-green-500/20 text-green-400"
              : "bg-red-500/10 border-red-500/20 text-red-400"
          }`}>
            <span className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500 animate-pulse" : "bg-red-500"}`} />
            {isConnected ? "Engine Connected" : "Engine Offline"}
          </div>

          <div className="flex items-center gap-2 bg-[#161922] border border-white/5 rounded-xl p-1">
            <button
              onClick={() => {
                const isDry = !dryRun;
                setDryRun(isDry);
                handleStartBridge(isDry);
              }}
              className={`px-3 py-1 text-[10px] font-bold rounded-lg transition-all ${
                dryRun
                  ? "bg-amber-500/25 text-amber-400 border border-amber-500/30"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              DRY RUN {dryRun ? "ON" : "OFF"}
            </button>
            {isProcessRunning ? (
              <button
                onClick={handleStopBridge}
                className="px-3 py-1 text-[10px] font-bold text-red-400 bg-red-500/15 rounded-lg hover:bg-red-500/25 border border-red-500/20 transition-all"
              >
                Stop Engine
              </button>
            ) : (
              <button
                onClick={() => handleStartBridge(dryRun)}
                className="px-3 py-1 text-[10px] font-bold text-green-400 bg-green-500/15 rounded-lg hover:bg-green-500/25 border border-green-500/20 transition-all"
              >
                Start Engine
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Main Grid View */}
      <div className="flex flex-1 min-height-0 overflow-hidden">
        {/* Sidebar Nav rail */}
        <aside className="w-60 bg-[#0f1117]/50 border-r border-white/5 p-4 flex flex-col gap-2 shrink-0">
          <button
            onClick={() => setActiveTab("dashboard")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-semibold tracking-wide transition-all ${
              activeTab === "dashboard"
                ? "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 font-bold"
                : "text-gray-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Activity className="w-4 h-4" />
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab("settings")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-semibold tracking-wide transition-all ${
              activeTab === "settings"
                ? "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 font-bold"
                : "text-gray-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <SettingsIcon className="w-4 h-4" />
            Connection Config
          </button>
          <button
            onClick={() => setActiveTab("tester")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-semibold tracking-wide transition-all ${
              activeTab === "tester"
                ? "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 font-bold"
                : "text-gray-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Search className="w-4 h-4" />
            SQL Query Tester
          </button>
          <button
            onClick={() => setActiveTab("logs")}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl text-xs font-semibold tracking-wide transition-all ${
              activeTab === "logs"
                ? "bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 font-bold"
                : "text-gray-400 hover:bg-white/5 hover:text-white"
            }`}
          >
            <Terminal className="w-4 h-4" />
            Process Console
          </button>

          <div className="mt-auto flex flex-col gap-3">
            <button
              onClick={() => void openSyncWorkbench()}
              className="flex items-center justify-center gap-2 px-4 py-3 bg-linear-to-r from-orange-600 to-orange-500 hover:from-orange-500 hover:to-orange-400 text-white text-xs font-bold uppercase rounded-xl transition-all shadow-lg shadow-orange-500/20"
            >
              <ArrowUpRight className="w-4 h-4" />
              Open Counterpoint SYNC Workbench
            </button>
            <div className="p-4 rounded-xl bg-[#161922] border border-white/5 text-[10px] text-gray-500">
              <div className="font-semibold text-gray-400 mb-1">Local Bridge API</div>
              <div>Listening on:</div>
              <div className="font-mono text-[#f97316] mt-0.5">{BRIDGE_API}</div>
              <div className="font-semibold text-gray-400 mt-3 mb-1">SYNC Workbench</div>
              <div className="font-mono text-[#f97316] mt-0.5 break-all">{normalizedSyncWorkbenchUrl}</div>
              <div className={`mt-2 rounded-lg border px-2 py-1.5 font-semibold ${
                syncWorkbenchCheck?.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : syncWorkbenchCheck
                    ? "border-red-500/30 bg-red-500/10 text-red-300"
                    : "border-white/10 bg-white/5 text-gray-400"
              }`}>
                {syncWorkbenchCheck ? syncWorkbenchCheck.message : "Not checked from Bridge GUI yet."}
                {syncWorkbenchCheck ? <div className="mt-0.5 text-[9px] text-gray-500">Checked {syncWorkbenchCheck.checkedAt}</div> : null}
              </div>
              <button
                type="button"
                onClick={() => void checkSyncWorkbenchReachability()}
                disabled={syncWorkbenchChecking}
                className="mt-2 w-full rounded-lg border border-white/10 px-2 py-2 font-bold text-gray-300 hover:border-orange-500/50 hover:text-white disabled:opacity-50"
              >
                {syncWorkbenchChecking ? "Checking..." : "Check SYNC Workbench"}
              </button>
              <div className="font-semibold text-gray-400 mt-3 mb-1">ROS Final Importer</div>
              <div className="font-mono text-gray-400 mt-0.5 break-all">{normalizedRosUrl}</div>
            </div>
            <div className="p-4 rounded-xl bg-[#161922] border border-white/5 text-[10px] text-gray-500">
              <div className="font-semibold text-gray-400 mb-1">Bridge GUI Update</div>
              <div>
                {selfUpdateCheck?.available
                  ? `Ready: ${selfUpdateCheck.version}${selfUpdateCheck.available_build ? ` (${selfUpdateCheck.available_build})` : ""}`
                  : selfUpdateCheck?.message ?? "Signed GUI updater channel."}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handleCheckAppUpdate()}
                  disabled={selfUpdateBusy}
                  className="rounded-lg border border-white/10 px-2 py-2 font-bold text-gray-300 hover:border-orange-500/50 hover:text-white disabled:opacity-50"
                >
                  Check
                </button>
                <button
                  type="button"
                  onClick={() => void handleInstallAppUpdate()}
                  disabled={selfUpdateBusy}
                  className="rounded-lg bg-orange-600 px-2 py-2 font-bold text-white hover:bg-orange-500 disabled:opacity-50"
                >
                  {selfUpdateBusy ? "Working" : "Install"}
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* Tab Contents Frame */}
        <main className="flex-1 p-6 overflow-y-auto bg-[#08090c] min-width-0">
          {activeTab === "dashboard" && (
            <div className="flex flex-col gap-6">
              {/* Stats Bar */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-[#0f1117] border border-white/5 p-4 rounded-xl">
	                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Extraction State</div>
                  <div className="text-lg font-bold text-white mt-1 flex items-center gap-2">
                    {bridgeState?.isSyncing ? (
                      <>
                        <RefreshCw className="w-4 h-4 text-orange-500 animate-spin" />
	                        Extracting
                      </>
                    ) : (
                      <>
                        <CheckCircle className="w-4 h-4 text-green-500" />
                        Idle
                      </>
                    )}
                  </div>
                </div>
                <div className="bg-[#0f1117] border border-white/5 p-4 rounded-xl">
	                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Records Last Extraction</div>
                  <div className="text-lg font-bold text-orange-500 mt-1">
                    {bridgeState?.totalRecordsLastRun?.toLocaleString() ?? "—"}
                  </div>
                </div>
                <div className="bg-[#0f1117] border border-white/5 p-4 rounded-xl">
	                  <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Extraction Duration</div>
                  <div className="text-lg font-bold text-white mt-1">
                    {fmtDuration(bridgeState?.lastRunDurationMs ?? 0)}
                  </div>
                </div>
                <div className="bg-[#0f1117] border border-white/5 p-4 rounded-xl flex items-center justify-between">
                  <div>
                    <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Run Full Extraction</div>
	                    <div className="text-[10px] text-gray-400 mt-0.5">Sends raw batches to SYNC</div>
                  </div>
                  <button
                    onClick={triggerFullSync}
                    disabled={!isConnected || bridgeState?.isSyncing}
                    className="p-2.5 bg-orange-600 hover:bg-orange-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    <Play className="w-4 h-4 fill-current" />
                  </button>
                </div>
              </div>

              {/* Sync Progress Bar */}
              {bridgeState?.isSyncing && (
                <div className="bg-[#0f1117] border border-white/5 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Zap className="w-4 h-4 text-orange-500" />
                      <span className="text-xs font-bold text-white uppercase tracking-wider">
                        {bridgeState.currentEntity ? `Extracting ${bridgeState.currentEntity}` : "Processing"}
                      </span>
                    </div>
                    <span className="text-xs font-mono text-orange-400">{syncProgress}%</span>
                  </div>
                  <div className="h-2 bg-[#08090c] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-linear-to-r from-orange-600 to-orange-500 transition-all duration-300 ease-out"
                      style={{ width: `${syncProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Extraction Errors Panel */}
              {bridgeState?.entityStats && Object.entries(bridgeState.entityStats).some(([_, stat]) => stat.error) && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5 flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-red-400 font-extrabold text-xs uppercase tracking-wider">
                    <AlertTriangle className="w-4 h-4" />
                    Database Extraction Errors Detected
                  </div>
                  <div className="flex flex-col gap-2.5 max-h-48 overflow-y-auto">
                    {Object.entries(bridgeState.entityStats)
                      .filter(([_, stat]) => stat.error)
                      .map(([key, stat]) => {
                        const label = ENTITIES.find((ent) => ent.key === key)?.label || key;
                        return (
                          <div key={key} className="bg-black/40 border border-red-500/10 rounded-lg p-3 font-mono text-[10px] text-red-300 flex flex-col gap-1 select-text">
                            <div className="font-bold uppercase tracking-wider text-red-400 flex items-center justify-between">
                              <span>⚠️ {label} Sync Failure</span>
                              <span className="text-[9px] text-zinc-500 font-semibold uppercase">{stat.lastSync ? new Date(stat.lastSync).toLocaleTimeString() : ""}</span>
                            </div>
                            <div className="mt-1 leading-normal break-all">{stat.error}</div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Entity Breakdown Table */}
              <div className="bg-[#0f1117] border border-white/5 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
	                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-white">Counterpoint Extraction Entities</h3>
                  {dryRun && <span className="text-[10px] text-amber-400 font-bold uppercase tracking-widest bg-amber-500/10 px-2 py-0.5 rounded">DRY RUN PREVENTING WRITES</span>}
                </div>
                <div className="divide-y divide-white/5 max-h-[500px] overflow-y-auto">
                  {entityStatsMemo.map(({ entity: e, stat: st, isRunning }) => (
                    <div key={e.key} className="flex items-center justify-between px-5 py-3 hover:bg-white/2 transition-all">
                      <div className="flex items-center gap-3">
                        <span className="text-base flex items-center justify-center w-6 h-6">
                          {isRunning ? <RefreshCw className="w-4 h-4 text-[#f97316] animate-spin" /> : e.icon}
                        </span>
                        <span className="text-xs font-semibold text-white">{e.label}</span>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <div className="text-[10px] font-medium text-gray-500">Processed</div>
                          <div className="text-xs font-bold text-white">{st?.recordCount ?? 0} rows</div>
                        </div>
                        <div className="text-right">
                          <div className="text-[10px] font-medium text-gray-500">Time</div>
                          <div className="text-xs font-bold text-white">{st?.durationMs ? fmtDuration(st.durationMs) : "—"}</div>
                        </div>
                        <button
                          onClick={() => triggerSingleSync(e.key)}
                          disabled={!isConnected || bridgeState?.isSyncing}
                          className="px-3 py-1.5 bg-[#161922] border border-white/5 hover:border-orange-500/30 hover:text-orange-500 text-[10px] font-bold uppercase rounded-lg disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                        >
                          Extract
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "settings" && (
            <div className="flex flex-col gap-6 max-w-3xl">
              <div className="bg-[#0f1117] border border-white/5 rounded-xl p-6 flex flex-col gap-4">
	                <h3 className="text-xs font-extrabold uppercase tracking-wider text-white border-b border-white/5 pb-3">Bridge Config & SYNC Workbench Target</h3>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">SQL Server Connection String</label>
                  <input
                    type="password"
                    value={sqlConn}
                    placeholder="Server=...;Database=...;User Id=...;Password=..."
                    onChange={(e) => setSqlConn(e.target.value)}
                    className="bg-[#08090c] border border-white/5 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-orange-500/50"
                  />
                </div>

	                <div className="grid grid-cols-2 gap-4">
	                  <div className="flex flex-col gap-1">
	                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Main Hub SYNC Workbench URL</label>
	                    <input
	                      type="text"
	                      value={syncWorkbenchUrl}
	                      placeholder="http://127.0.0.1:3015"
	                      onChange={(e) => setSyncWorkbenchUrl(e.target.value)}
	                      className="bg-[#08090c] border border-white/5 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-orange-500/50"
	                    />
	                  </div>
	                  <div className="flex flex-col gap-1">
	                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">ROS Base URL (optional)</label>
	                    <input
	                      type="text"
	                      value={rosUrl}
                      placeholder="http://localhost:3000"
                      onChange={(e) => setRosUrl(e.target.value)}
                      className="bg-[#08090c] border border-white/5 rounded-lg px-3 py-2 text-xs font-mono text-white focus:outline-none focus:border-orange-500/50"
                    />
	                  </div>
	                </div>

                <div className="flex gap-3 justify-end mt-4">
                  <button
                    onClick={runAutoConfig}
                    disabled={isAutoconfiguring || !isConnected}
                    className="px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-extrabold uppercase rounded-lg flex items-center gap-2 disabled:opacity-50 transition-all"
                  >
                    <Sparkles className="w-4 h-4 text-orange-500" />
                    Auto-Config Schema Probe
                  </button>
                  <button
                    onClick={handleSaveSettings}
                    className="px-4 py-2.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-extrabold uppercase rounded-lg transition-all"
                  >
                    Save Configuration
                  </button>
                </div>
              </div>

              {autodetectedFields.length > 0 && (
                <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 flex flex-col gap-3">
                  <div className="flex items-center gap-2 text-green-400 font-extrabold text-xs uppercase tracking-wider">
                    <CheckCircle className="w-4 h-4" />
                    Schema Alignment Verified
                  </div>
                  <ul className="text-xs text-gray-300 list-disc pl-5 flex flex-col gap-1.5">
                    {autodetectedFields.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {activeTab === "tester" && (
            <div className="flex flex-col gap-6">
              {/* Tester Header Options */}
              <div className="bg-[#0f1117] border border-white/5 rounded-xl p-5 flex flex-col gap-4">
                <div className="flex items-center justify-between border-b border-white/5 pb-3">
                  <h3 className="text-xs font-extrabold uppercase tracking-wider text-white">Extraction Query Tester</h3>
                  <div className="text-[10px] text-gray-500">Safely runs queries and returns up to 10 rows for validation.</div>
                </div>

                <div className="flex items-end gap-4">
                  <div className="flex-1 flex flex-col gap-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Test Configured Entity</label>
                    <select
                      value={testQueryEntity}
                      onChange={(e) => setTestQueryEntity(e.target.value)}
                      className="bg-[#08090c] border border-white/5 rounded-lg px-3 py-2 text-xs font-semibold text-white focus:outline-none"
                    >
                      {ENTITIES.map((e) => (
                        <option key={e.key} value={e.key}>{e.label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    onClick={testConfiguredQuery}
                    disabled={testingQuery || !isConnected}
                    className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white text-xs font-extrabold uppercase rounded-lg disabled:opacity-50 transition-all shrink-0"
                  >
                    Test Entity Extract
                  </button>
                </div>

                <div className="flex flex-col gap-2 mt-2">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">Run Arbitrary SQL Probe</label>
                  <textarea
                    value={testQuerySql}
                    onChange={(e) => setTestQuerySql(e.target.value)}
                    placeholder="SELECT TOP 10 * FROM PS_DOC_HDR"
                    className="bg-[#08090c] border border-white/5 rounded-lg p-3 text-xs font-mono text-white h-20 focus:outline-none focus:border-orange-500/50 resize-none"
                  />
                  <div className="flex justify-end">
                    <button
                      onClick={testCustomSql}
                      disabled={testingQuery || !isConnected || !testQuerySql.trim()}
                      className="px-4 py-2 bg-[#161922] border border-white/5 hover:border-orange-500/30 text-white text-xs font-extrabold uppercase rounded-lg disabled:opacity-50 transition-all"
                    >
                      Execute Raw SQL
                    </button>
                  </div>
                </div>
              </div>

              {/* Tester Results */}
              {testQueryResults.length > 0 && (
                <div className="bg-[#0f1117] border border-white/5 rounded-xl overflow-hidden flex flex-col">
                  <div className="px-5 py-4 border-b border-white/5 bg-[#161922]/50 text-xs font-extrabold uppercase tracking-wider text-white">
                    Probed Extraction Preview ({testQueryResults.length} records)
                  </div>
                  <div className="overflow-x-auto max-w-full">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-white/5 bg-[#161922]/20">
                          {Object.keys(testQueryResults[0]).map((key) => (
                            <th key={key} className="px-4 py-2.5 text-[10px] font-bold uppercase text-gray-400 tracking-wider font-mono">
                              {key}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5 font-mono text-[10px]">
                        {testQueryResults.map((row, idx) => (
                          <tr key={idx} className="hover:bg-white/1">
                            {Object.values(row).map((val: any, cellIdx) => (
                              <td key={cellIdx} className="px-4 py-2 text-gray-300 truncate max-w-xs">
                                {val === null ? "NULL" : String(val)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {testQueryError && (
                <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-5 rounded-xl flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="text-xs font-mono break-all">{testQueryError}</div>
                </div>
              )}
            </div>
          )}

          {activeTab === "logs" && (
            <div className="bg-[#000000] border border-white/5 rounded-xl overflow-hidden flex flex-col h-[550px]">
              <div className="px-5 py-4 border-b border-white/5 bg-[#0f1117] text-xs font-extrabold uppercase tracking-wider text-white flex items-center justify-between shrink-0">
                <span>Process Stdout/Stderr Output</span>
                <button
                  onClick={async () => {
                    try {
                      await invoke("clear_process_logs");
                      setRustLogs([]);
                    } catch (e) {
                      console.error("Failed to clear process logs:", e);
                    }
                  }}
                  className="p-1.5 hover:bg-white/5 rounded text-gray-400 hover:text-white transition-all"
                  title="Clear Console"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5 font-mono text-[10px] leading-relaxed flex flex-col gap-1.5 select-text">
                {rustLogs.length === 0 ? (
                  <div className="text-zinc-500 text-center py-10 italic select-none">No console output yet. Start the sync engine or trigger sync to display activity.</div>
                ) : (
                  rustLogs.map((logLine, i) => (
                    <div key={i} className="flex gap-4">
                      <span className={`break-all ${
                        logLine.toLowerCase().includes("error") || logLine.toLowerCase().includes("failed") || logLine.includes("[ERROR]")
                          ? "text-red-400"
                          : logLine.includes("[SYSTEM]")
                          ? "text-amber-400 font-bold"
                          : logLine.toLowerCase().includes("ok") || logLine.toLowerCase().includes("completed") || logLine.toLowerCase().includes("success")
                          ? "text-green-400 font-semibold"
                          : logLine.toLowerCase().includes("starting")
                          ? "text-blue-400"
                          : "text-zinc-300"
                      }`}>
                        {logLine}
                      </span>
                    </div>
                  ))
                )}
                <div ref={consoleEndRef} />
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Footer Status Panel */}
      <footer className="px-6 py-2.5 border-t border-white/5 bg-[#0f1117] text-[9px] font-bold uppercase tracking-wider text-gray-600 flex justify-between shrink-0">
        <div>Status: <span className="text-gray-400 font-semibold">{statusMessage || "Sync bridge loaded."}</span></div>
        <div>Tauri GUI Host · v0.90.0</div>
      </footer>
    </div>
  );
}

export default App;
