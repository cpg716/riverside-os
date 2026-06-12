import { getBaseUrl, getBaseUrlDiagnostics, DEFAULT_BASE_URL } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import { checkServerLocalStatus, loadLocalStationConfig, type RiversideStationConfig, type ServerLocalStatus } from "../../lib/appUpdater";
import {
  Wifi,
  Monitor,
  Globe,
  Server,
  Copy,
  CheckCircle2,
  RefreshCw,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Smartphone,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

/* ── Types ── */

interface NetworkUrl {
  label: string;
  url: string;
  kind: string;
}

interface NetworkInfo {
  hostname: string;
  server_port: number;
  lan_ips: string[];
  urls: NetworkUrl[];
  tailscale_ip: string | null;
}

interface HealthStatus {
  ok: boolean;
  latency_ms: number;
  version?: string;
  error?: string;
  source?: string;
  checked_url?: string;
}

/* ── Helpers ── */

function normalizeApiBase(value: string): string {
  let url = value.trim();
  if (url && !url.startsWith("http")) url = `http://${url}`;
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !parsed.port) parsed.port = "3000";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "override": return "Manual override (localStorage)";
    case "vite-env": return "Build-time env (VITE_API_BASE)";
    case "same-origin": return "Same-origin (browser URL)";
    case "desktop-fallback": return "Desktop fallback (127.0.0.1:3000)";
    default: return source;
  }
}

async function probeApiStatus(targetBaseUrl: string) {
  const start = performance.now();
  const [healthRes, versionRes] = await Promise.all([
    fetch(`${targetBaseUrl}/api/health`).catch(() => null),
    fetch(`${targetBaseUrl}/api/version`).catch(() => null),
  ]);
  const versionData = versionRes?.ok
    ? await versionRes.json().catch(() => null)
    : null;
  return {
    ok: healthRes?.ok ?? false,
    latency_ms: Math.round(performance.now() - start),
    version: versionData?.version,
  };
}

/* ── Component ── */

export default function StationNetworkPanel() {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [networkLoading, setNetworkLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [localServerStatus, setLocalServerStatus] = useState<ServerLocalStatus | null>(null);
  const [stationConfig, setStationConfig] = useState<RiversideStationConfig | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Connection editor
  const [editing, setEditing] = useState(false);
  const [editUrl, setEditUrl] = useState("");

  const headers = useCallback(
    () => backofficeHeaders() as Record<string, string>,
    [backofficeHeaders],
  );

  const diagnostics = useMemo(() => getBaseUrlDiagnostics(), []);

  const browserStationLabel = useMemo(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("ros.station.label");
  }, []);

  const stationLabel =
    stationConfig?.register?.stationLabel?.trim() || browserStationLabel;

  const localInstallLabel = localServerStatus?.is_local
    ? "Main Hub detected"
    : localServerStatus
      ? "Satellite station"
      : "Not checked";

  const installedApiBase = stationConfig?.register?.apiBase?.trim();

  /* ── Fetch network info from server ── */

  const fetchNetworkInfo = useCallback(async () => {
    setNetworkLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/network-info`, { headers: headers() });
      if (res.ok) {
        setNetworkInfo((await res.json()) as NetworkInfo);
      }
    } catch { /* silent */ }
    finally { setNetworkLoading(false); }
  }, [baseUrl, headers]);

  /* ── Health check ── */

  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const primary = await probeApiStatus(baseUrl);
      let localFallback: ServerLocalStatus | null = null;
      if (!primary.ok) {
        try {
          localFallback = await checkServerLocalStatus();
          setLocalServerStatus(localFallback);
        } catch {
          localFallback = null;
        }
        const configFallback = await loadLocalStationConfig().catch(() => null);
        setStationConfig(configFallback);
        const fallbackApi = configFallback?.register?.apiBase?.trim();
        if (fallbackApi && fallbackApi !== baseUrl) {
          const fallback = await probeApiStatus(fallbackApi);
          if (fallback.ok) {
            setHealth({
              ok: true,
              latency_ms: fallback.latency_ms,
              version: fallback.version,
              error: "Selected API host failed; installed Main Hub API is reachable",
              source: "installed-config",
              checked_url: fallbackApi,
            });
            return;
          }
        }
      }
      setHealth({
        ok: primary.ok,
        latency_ms: primary.latency_ms,
        version: primary.version,
        error: primary.ok
          ? undefined
          : localFallback?.is_local
            ? "Selected API host failed; Main Hub install detected locally"
            : "Server unreachable from selected API host",
        source: localFallback?.is_local ? "local-probe" : "api",
        checked_url: baseUrl,
      });
    } catch {
      let localFallback: ServerLocalStatus | null = null;
      try {
        localFallback = await checkServerLocalStatus();
        setLocalServerStatus(localFallback);
      } catch {
        localFallback = null;
      }
      setHealth({
        ok: false,
        latency_ms: 0,
        error: localFallback?.is_local
          ? "Selected API host failed; Main Hub install detected locally"
          : "Connection failed",
        source: localFallback?.is_local ? "local-probe" : "api",
        checked_url: baseUrl,
      });
    } finally {
      setHealthLoading(false);
    }
  }, [baseUrl]);

  const refreshLocalStation = useCallback(async () => {
    const [status, config] = await Promise.all([
      checkServerLocalStatus().catch(() => null),
      loadLocalStationConfig().catch(() => null),
    ]);
    setLocalServerStatus(status);
    setStationConfig(config);
  }, []);

  useEffect(() => {
    void refreshLocalStation();
    void fetchNetworkInfo();
    void checkHealth();
  }, [refreshLocalStation, fetchNetworkInfo, checkHealth]);

  /* ── Copy URL ── */

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(url);
      toast("Copied to clipboard", "success");
      setTimeout(() => setCopied(null), 2000);
    });
  };

  /* ── Save connection ── */

  const saveConnection = () => {
    const normalized = normalizeApiBase(editUrl);
    if (!normalized) {
      toast("Enter a valid URL", "error");
      return;
    }
    if (normalized === DEFAULT_BASE_URL || normalized === "http://127.0.0.1:3000") {
      localStorage.removeItem("ros_api_base_override");
    } else {
      localStorage.setItem("ros_api_base_override", normalized);
    }
    toast("Server connection updated. Reloading…", "success");
    setTimeout(() => window.location.reload(), 500);
  };

  const resetConnection = () => {
    localStorage.removeItem("ros_api_base_override");
    toast("Reset to default. Reloading…", "success");
    setTimeout(() => window.location.reload(), 500);
  };

  const isAdmin = hasPermission("settings.admin");

  return (
    <section className="space-y-8">
      {/* ── Header ── */}
      <div>
        <h2 className="text-2xl font-black italic tracking-tighter uppercase text-app-text">
          Station & Network
        </h2>
        <p className="mt-1 text-sm text-app-text-muted max-w-2xl">
          Connection status, server addresses for registers and PWA devices, and this station&apos;s configuration.
        </p>
      </div>

      {/* ── This Station ── */}
      <div className="rounded-2xl border border-app-border bg-app-surface-2/40 overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border bg-app-bg/40 flex items-center gap-2">
          <Monitor className="h-4 w-4 text-app-accent" />
          <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
            This Station
          </h3>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <InfoTile label="Station Label" value={stationLabel || "Not set"} muted={!stationLabel} />
            <InfoTile label="API Host" value={diagnostics.resolved} mono />
            <InfoTile label="Installed Role" value={localInstallLabel} muted={!localServerStatus} />
            <InfoTile label="Installed API" value={installedApiBase || "Not set"} mono muted={!installedApiBase} />
            <div className="rounded-xl border border-app-border bg-app-bg/60 p-3">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">Connection</p>
              {healthLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-app-accent" />
              ) : health ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    {health.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    )}
                    <span className={`text-sm font-black ${health.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                      {health.ok ? `OK — ${health.latency_ms}ms` : health.error}
                    </span>
                    {health.version && (
                      <span className="text-[10px] text-app-text-muted ml-1">v{health.version}</span>
                    )}
                  </div>
                  {health.error && health.ok ? (
                    <p className="text-[10px] font-semibold text-amber-700 dark:text-amber-200">{health.error}</p>
                  ) : null}
                  {health.checked_url ? (
                    <p className="break-all font-mono text-[10px] text-app-text-muted">{health.checked_url}</p>
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-app-text-muted">—</span>
              )}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <InfoTile label="Selected Source" value={sourceLabel(diagnostics.source)} />
            <InfoTile
              label="Main Hub Files"
              value={
                localServerStatus
                  ? [
                      localServerStatus.config_exists ? "config" : "no config",
                      localServerStatus.server_binary_exists ? "server app" : "no server app",
                    ].join(" / ")
                  : "Not checked"
              }
              muted={!localServerStatus?.config_exists && !localServerStatus?.server_binary_exists}
            />
          </div>

          {/* Connection editor */}
          {isAdmin && (
            <div className="border-t border-app-border pt-4">
              {!editing ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => { setEditUrl(diagnostics.resolved); setEditing(true); }}
                    className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
                  >
                    Change Server Connection
                  </button>
                  <button
                    type="button"
                    onClick={() => void checkHealth()}
                    disabled={healthLoading}
                    className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${healthLoading ? "animate-spin" : ""}`} />
                    Test Connection
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Server URL
                    </label>
                    <input
                      type="text"
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      placeholder="http://192.168.1.100:3000"
                      className="mt-1 w-full bg-app-bg border border-app-border rounded-xl px-4 py-3 text-xs font-mono text-app-text outline-none focus:border-app-accent"
                    />
                  </div>
                  {/* Quick-pick buttons */}
                  {networkInfo && networkInfo.urls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {networkInfo.urls.map((u) => (
                        <button
                          key={u.url}
                          type="button"
                          onClick={() => setEditUrl(u.url)}
                          className={`rounded-lg border px-2.5 py-1.5 text-[10px] font-bold transition-colors ${
                            normalizeApiBase(editUrl) === normalizeApiBase(u.url)
                              ? "border-app-accent bg-app-accent/10 text-app-accent"
                              : "border-app-border bg-app-bg/60 text-app-text-muted hover:border-app-accent/40"
                          }`}
                        >
                          {u.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveConnection}
                      className="ui-btn-primary px-4 py-2 text-xs font-bold"
                    >
                      Save & Reconnect
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="ui-btn-secondary px-4 py-2 text-xs font-bold"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={resetConnection}
                      className="ui-btn-secondary px-4 py-2 text-xs font-bold text-red-600"
                    >
                      Reset to Default
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Server Network ── */}
      <div className="rounded-2xl border border-app-border bg-app-surface-2/40 overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border bg-app-bg/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-app-accent" />
            <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
              Server Network
            </h3>
          </div>
          <button
            type="button"
            onClick={() => void fetchNetworkInfo()}
            disabled={networkLoading}
            className="inline-flex items-center gap-1 text-[10px] font-bold text-app-text-muted hover:text-app-text"
          >
            <RefreshCw className={`h-3 w-3 ${networkLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
        {networkInfo ? (
          <div className="p-5 space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <InfoTile label="Server Hostname" value={networkInfo.hostname || "Unknown"} />
              <InfoTile label="Port" value={String(networkInfo.server_port)} mono />
              <InfoTile
                label="LAN IP"
                value={networkInfo.lan_ips.length > 0 ? networkInfo.lan_ips.join(", ") : "Not detected"}
                mono
                muted={networkInfo.lan_ips.length === 0}
              />
            </div>

            {/* Connection URLs for other devices */}
            <div>
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                Connection URLs — use these on other devices
              </h4>
              <div className="space-y-2">
                {networkInfo.urls.map((u) => (
                  <UrlCard
                    key={u.url}
                    label={u.label}
                    url={u.url}
                    kind={u.kind}
                    copied={copied === u.url}
                    onCopy={() => copyUrl(u.url)}
                  />
                ))}
              </div>
            </div>

            <div>
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-3">
                Physical Inventory Scanner URLs
              </h4>
              <div className="space-y-2">
                {networkInfo.urls.map((u) => {
                  const scannerUrl = `${u.url.replace(/\/$/, "")}/physical-inventory/scanner`;
                  return (
                    <UrlCard
                      key={scannerUrl}
                      label={`${u.label} — Physical Inventory Scanner`}
                      url={scannerUrl}
                      kind={u.kind}
                      copied={copied === scannerUrl}
                      onCopy={() => copyUrl(scannerUrl)}
                    />
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] font-semibold text-app-text-muted">
                Use this focused URL for iPad PWA camera scanning, iPad Bluetooth scanners, or PC USB scanners during count sessions.
              </p>
            </div>

            {networkInfo.tailscale_ip && (
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/5 p-3">
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4 text-indigo-500" />
                  <p className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                    Tailscale detected: {networkInfo.tailscale_ip}
                  </p>
                </div>
                <p className="mt-1 text-[10px] text-app-text-muted">
                  Use this IP for remote access from off-site devices connected to your Tailscale network.
                </p>
              </div>
            )}
          </div>
        ) : networkLoading ? (
          <div className="p-8 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-app-accent" />
            <p className="mt-2 text-xs text-app-text-muted">Loading server network info…</p>
          </div>
        ) : (
          <div className="p-8 text-center">
            <AlertTriangle className="mx-auto h-6 w-6 text-amber-500" />
            <p className="mt-2 text-xs text-app-text-muted">Could not reach the server for network info.</p>
          </div>
        )}
      </div>

      {/* ── How to Connect Guide ── */}
      <div className="rounded-2xl border border-app-border bg-app-surface-2/40 overflow-hidden">
        <div className="px-5 py-3 border-b border-app-border bg-app-bg/40 flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-app-accent" />
          <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
            How to Connect Devices
          </h3>
        </div>
        <div className="p-5 space-y-4">
          <GuideStep
            number={1}
            title="Registers (Windows Desktop App)"
            description="On the register PC, open the Riverside OS app. At the sign-in screen, tap 'API Host Settings' at the bottom. Select or enter the LAN URL shown above. Save & sign in."
          />
          <GuideStep
            number={2}
            title="PWA — Tablet or Phone"
            description={`Open a browser on the device and navigate to the LAN URL (e.g., ${
              networkInfo?.urls.find((u) => u.kind === "lan")?.url ?? "http://192.168.1.X:3000"
            }). Add it to the home screen when prompted for the full PWA experience.`}
          />
          <GuideStep
            number={3}
            title="Physical Inventory Scanner"
            description="Open the Physical Inventory Scanner URL on the counting device. PC USB scanners and iPad Bluetooth scanners work when configured as keyboard input with Enter after each scan; iPad camera scanning uses the PWA camera scanner."
          />
          <GuideStep
            number={4}
            title="Back Office — Second Computer"
            description="Same as a register: use the LAN URL. If using the desktop app, configure the API host at sign-in. If using a browser, just navigate to the LAN URL."
          />
          <GuideStep
            number={5}
            title="Remote Access (Tailscale)"
            description="Install Tailscale on both the server and the remote device. Use the Tailscale IP shown above (100.x.x.x) as the API host."
          />
        </div>
      </div>
    </section>
  );
}

/* ── Sub-components ── */

function InfoTile({
  label,
  value,
  mono,
  muted,
}: {
  label: string;
  value: string;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-xl border border-app-border bg-app-bg/60 p-3">
      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">{label}</p>
      <p className={`text-sm font-bold break-all ${mono ? "font-mono" : ""} ${muted ? "text-app-text-muted" : "text-app-text"}`}>
        {value}
      </p>
    </div>
  );
}

function UrlCard({
  label,
  url,
  kind,
  copied,
  onCopy,
}: {
  label: string;
  url: string;
  kind: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const kindIcon = kind === "loopback" ? (
    <Monitor className="h-3.5 w-3.5" />
  ) : kind === "tailscale" ? (
    <Globe className="h-3.5 w-3.5" />
  ) : (
    <Wifi className="h-3.5 w-3.5" />
  );

  return (
    <div className="flex items-center gap-3 rounded-xl border border-app-border bg-app-bg/60 px-4 py-3 group hover:border-app-accent/30 transition-colors">
      <div className="text-app-accent">{kindIcon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
        <p className="text-sm font-mono font-bold text-app-text truncate">{url}</p>
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onCopy}
          className="rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text-muted hover:text-app-text transition-colors"
          title="Copy URL"
        >
          {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text-muted hover:text-app-text transition-colors"
          title="Open in browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </div>
  );
}

function GuideStep({
  number,
  title,
  description,
}: {
  number: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-app-accent/15 text-app-accent text-xs font-black">
        {number}
      </div>
      <div>
        <p className="text-xs font-black text-app-text">{title}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-app-text-muted">{description}</p>
      </div>
    </div>
  );
}
