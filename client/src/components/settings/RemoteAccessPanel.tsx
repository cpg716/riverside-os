import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  WifiOff,
  ExternalLink,
  ShieldCheck,
  RefreshCcw,
  Terminal,
  Server,
  Key,
  AlertTriangle,
  Globe2,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { cn } from "@/lib/utils";
import QRCode from "qrcode";

interface TailscaleNode {
  ID: string;
  HostName: string;
  DNSName: string;
  TailscaleIPs: string[];
}

interface TailscaleStatus {
  Self: TailscaleNode | null;
  BackendState: string;
}

type UnifiedServerLifecycle = "stopped" | "starting" | "running" | "failed";

interface UnifiedServerStatus {
  lifecycle: UnifiedServerLifecycle;
  bind_addr: string | null;
  listen_port: number | null;
  frontend_dist: string | null;
  message: string | null;
  last_error: string | null;
}

interface UnifiedHostNetworkIdentity {
  hostname: string | null;
  lan_ipv4s: string[];
}

interface EdgeAccessStatus {
  public_base_url: string | null;
  public_host: string | null;
  public_https_configured: boolean;
  cloudflared_installed: boolean;
  cloudflared_launch_agent_configured: boolean;
  cloudflare_tunnel_hint_configured: boolean;
  helcim_webhook_secret_configured: boolean;
  podium_webhook_secret_configured: boolean;
  shippo_webhook_secret_configured: boolean;
  strict_production: boolean;
  helcim_webhook_url: string | null;
  podium_webhook_url: string | null;
  shippo_webhook_url: string | null;
  helcim_provider_delivery: ProviderDeliveryProof;
  podium_provider_delivery: ProviderDeliveryProof;
  status: "ready" | "attention" | "local_only" | string;
  warning_codes: string[];
}

interface ProviderDeliveryProof {
  provider: string;
  status: "verified_recent" | "seen_before" | "failure_only" | "no_delivery" | string;
  recent_delivery_count: number;
  last_received_at: string | null;
  last_failure_at: string | null;
  last_failure_detail: string | null;
  message: string;
}

interface EdgeAccessProbe {
  status: "passed" | "failed" | "not_configured" | string;
  probe_url: string | null;
  http_status: number | null;
  response_ms: number | null;
  checked_at: string;
  message: string;
  error: string | null;
}

const DEFAULT_DB_URL = "postgresql://postgres:password@localhost:5433/riverside_os";
const DEFAULT_LISTEN_PORT = 3000;

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function isTailscaleHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized.startsWith("100.") ||
    normalized.endsWith(".tailscale.net") ||
    normalized.endsWith(".ts.net")
  );
}

function candidateLocalHostFromBaseUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.trim();
    if (!host || isLoopbackHost(host) || isTailscaleHost(host)) {
      return null;
    }
    return host;
  } catch {
    return null;
  }
}

function hostSurfaceLabel(lifecycle: UnifiedServerLifecycle): string {
  switch (lifecycle) {
    case "running":
      return "Host running";
    case "starting":
      return "Starting";
    case "failed":
      return "Start failed";
    default:
      return "Host stopped";
  }
}

function edgeStatusLabel(status: EdgeAccessStatus["status"] | null | undefined): string {
  switch (status) {
    case "ready":
      return "Public edge ready";
    case "attention":
      return "Needs review";
    case "local_only":
      return "Local only";
    default:
      return "Not checked";
  }
}

function edgeStatusClass(status: EdgeAccessStatus["status"] | null | undefined): string {
  switch (status) {
    case "ready":
      return "bg-emerald-500 text-white";
    case "attention":
      return "bg-amber-500 text-white";
    case "local_only":
      return "bg-app-text-muted/20 text-app-text-muted";
    default:
      return "bg-app-text-muted/20 text-app-text-muted";
  }
}

function probeStatusClass(status: EdgeAccessProbe["status"] | null | undefined): string {
  switch (status) {
    case "passed":
      return "border-emerald-500/30 bg-emerald-500/10 text-app-success";
    case "failed":
      return "border-rose-500/30 bg-rose-500/10 text-rose-500";
    case "not_configured":
      return "border-amber-500/30 bg-amber-500/10 text-app-warning";
    default:
      return "border-app-border bg-app-surface-2 text-app-text-muted";
  }
}

function providerProofClass(status: ProviderDeliveryProof["status"] | null | undefined): string {
  switch (status) {
    case "verified_recent":
      return "border-emerald-500/30 bg-emerald-500/10";
    case "seen_before":
      return "border-sky-500/30 bg-sky-500/10";
    case "failure_only":
      return "border-rose-500/30 bg-rose-500/10";
    default:
      return "border-amber-500/30 bg-amber-500/10";
  }
}

function providerProofLabel(status: ProviderDeliveryProof["status"] | null | undefined): string {
  switch (status) {
    case "verified_recent":
      return "Recently verified";
    case "seen_before":
      return "Seen before";
    case "failure_only":
      return "Rejected delivery";
    default:
      return "Awaiting test";
  }
}

function formatEdgeTimestamp(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function warningLabel(code: string): string {
  switch (code) {
    case "public_base_url_missing":
      return "No public HTTPS base URL is configured.";
    case "public_base_url_not_https":
      return "The public base URL is not HTTPS.";
    case "cloudflared_not_installed":
      return "Cloudflare Tunnel is expected, but cloudflared was not found on PATH.";
    case "cloudflared_service_not_detected":
      return "Cloudflare Tunnel is expected, but the host service was not detected.";
    case "helcim_webhook_secret_missing":
      return "Helcim webhook signing secret is missing.";
    case "podium_webhook_secret_missing":
      return "Podium webhook signing secret is missing.";
    case "strict_production_without_public_https":
      return "Strict production is enabled without a public HTTPS base URL.";
    default:
      return code.replace(/_/g, " ");
  }
}

export default function RemoteAccessPanel() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [authKey, setAuthKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [dbUrl, setDbUrl] = useState(DEFAULT_DB_URL);
  const [srvPort, setSrvPort] = useState(DEFAULT_LISTEN_PORT);
  const [hostStatus, setHostStatus] = useState<UnifiedServerStatus | null>(null);
  const [hostIdentity, setHostIdentity] = useState<UnifiedHostNetworkIdentity | null>(null);
  const [edgeStatus, setEdgeStatus] = useState<EdgeAccessStatus | null>(null);
  const [edgeProbe, setEdgeProbe] = useState<EdgeAccessProbe | null>(null);
  const [edgeProbeBusy, setEdgeProbeBusy] = useState(false);
  const [hostBusy, setHostBusy] = useState(false);
  const [disconnectArmed, setDisconnectArmed] = useState(false);
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();

  const refreshHostStatus = useCallback(async () => {
    try {
      const [nextStatus, nextIdentity] = await Promise.all([
        invoke<UnifiedServerStatus>("get_unified_server_status"),
        invoke<UnifiedHostNetworkIdentity>("get_unified_host_network_identity"),
      ]);
      setHostStatus(nextStatus);
      setHostIdentity(nextIdentity);
      if (typeof nextStatus.listen_port === "number") {
        setSrvPort(nextStatus.listen_port);
      }
    } catch (error) {
      console.warn("Unified host status check failed", error);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/remote-access/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("Failed to fetch Tailscale status");
      const data = (await res.json()) as TailscaleStatus;
      setStatus(data);
    } catch (err) {
      console.error(err);
      toast(
        "Could not reach the Tailscale service on this station. Check the local setup before using remote access.",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders, toast]);

  const fetchEdgeStatus = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/edge-access/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("Failed to fetch edge access status");
      setEdgeStatus((await res.json()) as EdgeAccessStatus);
    } catch (error) {
      console.warn("Edge access status check failed", error);
      setEdgeStatus(null);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchStatus();
    void refreshHostStatus();
    void fetchEdgeStatus();
  }, [fetchEdgeStatus, fetchStatus, refreshHostStatus]);

  const localSatelliteUrls = useMemo(() => {
    if (hostStatus?.lifecycle !== "running" || typeof hostStatus.listen_port !== "number") {
      return [];
    }

    const seen = new Set<string>();
    const urls: string[] = [];
    const append = (host: string | null | undefined) => {
      const trimmed = host?.trim();
      if (!trimmed || isLoopbackHost(trimmed) || isTailscaleHost(trimmed)) {
        return;
      }
      const url = `http://${trimmed}:${hostStatus.listen_port}`;
      if (!seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    };

    hostIdentity?.lan_ipv4s.forEach(append);
    append(hostIdentity?.hostname ?? null);
    append(candidateLocalHostFromBaseUrl(baseUrl));

    return urls;
  }, [baseUrl, hostIdentity, hostStatus]);

  const hostAccessUrl = localSatelliteUrls[0] ?? null;

  const remoteAccessUrl = useMemo(() => {
    if (
      hostStatus?.lifecycle !== "running" ||
      typeof hostStatus.listen_port !== "number" ||
      !status?.Self
    ) {
      return null;
    }

    const cleanDns = status.Self.DNSName?.replace(/\.$/, "").trim();
    const remoteHost = cleanDns || status.Self.TailscaleIPs[0];
    if (!remoteHost) {
      return null;
    }
    return `http://${remoteHost}:${hostStatus.listen_port}`;
  }, [hostStatus, status]);

  useEffect(() => {
    if (!hostAccessUrl) {
      setQrCodeData(null);
      return;
    }
    QRCode.toDataURL(hostAccessUrl, {
      margin: 2,
      scale: 10,
      color: { dark: "#059669", light: "#ffffff" },
    })
      .then(setQrCodeData)
      .catch((error) => {
        console.error(error);
        setQrCodeData(null);
      });
  }, [hostAccessUrl]);

  const handleStartEngine = async () => {
    setHostBusy(true);
    try {
      const next = await invoke<UnifiedServerStatus>("start_unified_server", {
        databaseUrl: dbUrl,
        port: srvPort,
      });
      setHostStatus(next);
      if (typeof next.listen_port === "number") {
        setSrvPort(next.listen_port);
      }
      toast(next.message ?? "Unified host started.", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(message, "error");
      await refreshHostStatus();
    } finally {
      setHostBusy(false);
    }
  };

  const handleConnect = async () => {
    if (!authKey.trim()) return;
    setConnecting(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/remote-access/connect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ auth_key: authKey }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || "Failed to connect");
      }
      toast("Tailscale connection initiated.", "success");
      setAuthKey("");
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connect failed";
      toast(msg, "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/remote-access/disconnect`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      setDisconnectArmed(false);
      toast("Tailscale session closed.", "info");
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Disconnect failed";
      toast(msg, "error");
    }
  };

  const handleEdgeProbe = async () => {
    setEdgeProbeBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/edge-access/probe`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      const data = (await res.json().catch(() => ({}))) as Partial<EdgeAccessProbe> & {
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || "Live callback check failed");
      }
      setEdgeProbe(data as EdgeAccessProbe);
      toast(
        data.status === "passed"
          ? "Public callback path reached this ROS server."
          : data.message || "Public callback path needs review.",
        data.status === "passed" ? "success" : "error",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live callback check failed";
      toast(message, "error");
    } finally {
      setEdgeProbeBusy(false);
    }
  };

  const isConnected = status?.BackendState === "Running";

  const isRemoteSession =
    typeof window !== "undefined" &&
    (window.location.hostname.startsWith("100.") ||
      window.location.hostname.endsWith(".tailscale.net") ||
      window.location.hostname.endsWith(".ts.net"));

  const armDisconnect = () => {
    if (!isRemoteSession) {
      void handleDisconnect();
      return;
    }
    if (disconnectArmed) {
      void handleDisconnect();
      return;
    }
    setDisconnectArmed(true);
    toast(
      "This is a remote session. Tap Terminate Session again to disconnect and lose access.",
      "error",
    );
  };

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {isRemoteSession && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-4">
          <div className="p-2 bg-amber-500 rounded-lg text-white">
            <ExternalLink className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-black uppercase tracking-widest text-amber-500">
              Remote Session Active
            </p>
            <p className="text-[11px] font-medium text-app-text-muted">
              You are inside Riverside over Tailscale. Host/network changes here affect every connected device.
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-b border-app-border pb-6">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-app-accent/10 rounded-2xl text-app-accent">
            <Server className="w-8 h-8" />
          </div>
          <div>
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              Network Bridge
            </h2>
            <p className="text-sm font-medium text-app-text-muted">
              Windows host mode for local satellite clients, plus separate Tailscale remote access
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            void fetchStatus();
            void refreshHostStatus();
            void fetchEdgeStatus();
          }}
          disabled={loading || hostBusy}
          className="flex items-center gap-2 px-4 py-2 bg-app-bg-accent rounded-xl text-xs font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
        >
          <RefreshCcw className={`w-4 h-4 ${loading || hostBusy ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="ui-card border-app-border bg-app-surface p-6 shadow-xl">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-app-accent/10 text-app-accent">
              <Globe2 className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Edge & Webhook Access
                </h3>
                <span
                  className={cn(
                    "rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]",
                    edgeStatusClass(edgeStatus?.status),
                  )}
                >
                  {edgeStatusLabel(edgeStatus?.status)}
                </span>
              </div>
              <p className="mt-2 max-w-2xl text-xs font-medium leading-relaxed text-app-text-muted">
                Public HTTPS access is only needed for outside services such as Helcim and Podium webhooks.
                Riverside does not manage Cloudflare DNS or WAF from here; this panel checks the local runtime pieces staff need for callback reliability.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleEdgeProbe()}
                  disabled={edgeProbeBusy || !edgeStatus?.public_https_configured}
                  className="inline-flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-xs font-black uppercase tracking-widest text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCcw className={cn("h-4 w-4", edgeProbeBusy && "animate-spin")} />
                  Run Live Callback Check
                </button>
                <p className="text-[11px] font-semibold leading-5 text-app-text-muted">
                  Tests the configured public HTTPS route against a ROS probe endpoint.
                </p>
              </div>
              <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <dt className="font-black uppercase tracking-widest text-app-text-muted">
                    Public host
                  </dt>
                  <dd className="mt-1 break-all font-mono text-app-text">
                    {edgeStatus?.public_base_url ?? "Not configured"}
                  </dd>
                </div>
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <dt className="font-black uppercase tracking-widest text-app-text-muted">
                    Cloudflare Tunnel
                  </dt>
                  <dd className="mt-1 font-bold text-app-text">
                    {edgeStatus?.cloudflare_tunnel_hint_configured
                      ? edgeStatus.cloudflared_installed &&
                        edgeStatus.cloudflared_launch_agent_configured
                        ? "Expected and detected"
                        : "Expected; check host service"
                      : "No tunnel requirement configured"}
                  </dd>
                </div>
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <dt className="font-black uppercase tracking-widest text-app-text-muted">
                    Helcim webhook
                  </dt>
                  <dd className="mt-1 break-all font-mono text-app-text">
                    {edgeStatus?.helcim_webhook_url ?? "/api/webhooks/helcim"}
                  </dd>
                </div>
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <dt className="font-black uppercase tracking-widest text-app-text-muted">
                    Podium webhook
                  </dt>
                  <dd className="mt-1 break-all font-mono text-app-text">
                    {edgeStatus?.podium_webhook_url ?? "/api/webhooks/podium"}
                  </dd>
                </div>
              </dl>
              {edgeProbe && (
                <div
                  className={cn(
                    "mt-4 rounded-xl border p-3 text-[11px] font-semibold leading-5",
                    probeStatusClass(edgeProbe.status),
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-black uppercase tracking-widest">
                      Live callback check: {edgeProbe.status.replace(/_/g, " ")}
                    </span>
                    <span>
                      {edgeProbe.http_status ? `HTTP ${edgeProbe.http_status}` : "No HTTP response"}
                      {typeof edgeProbe.response_ms === "number" ? ` · ${edgeProbe.response_ms}ms` : ""}
                    </span>
                  </div>
                  <p className="mt-2 text-app-text-muted">{edgeProbe.message}</p>
                  {edgeProbe.probe_url && (
                    <p className="mt-2 break-all font-mono text-app-text-muted">
                      {edgeProbe.probe_url}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {[
                  { label: "Helcim provider delivery", proof: edgeStatus?.helcim_provider_delivery },
                  { label: "Podium provider delivery", proof: edgeStatus?.podium_provider_delivery },
                ].map(({ label, proof }) => (
                  <div
                    key={label}
                    className={cn(
                      "rounded-xl border p-3 text-[11px] font-semibold leading-5",
                      providerProofClass(proof?.status),
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-black uppercase tracking-widest text-app-text">
                        {label}
                      </span>
                      <span className="font-black uppercase tracking-widest text-app-text-muted">
                        {providerProofLabel(proof?.status)}
                      </span>
                    </div>
                    <p className="mt-2 text-app-text-muted">
                      {proof?.message ??
                        "Send a provider dashboard test event, then refresh this panel."}
                    </p>
                    <dl className="mt-3 grid gap-2 text-app-text-muted">
                      <div className="flex justify-between gap-3">
                        <dt>Last received</dt>
                        <dd className="text-right">{formatEdgeTimestamp(proof?.last_received_at)}</dd>
                      </div>
                      <div className="flex justify-between gap-3">
                        <dt>Recent deliveries</dt>
                        <dd>{proof?.recent_delivery_count ?? 0}</dd>
                      </div>
                      {proof?.last_failure_at && (
                        <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-2">
                          <dt className="font-black uppercase tracking-widest text-rose-500">
                            Last rejection
                          </dt>
                          <dd className="mt-1 text-app-text-muted">
                            {formatEdgeTimestamp(proof.last_failure_at)}
                            {proof.last_failure_detail ? ` · ${proof.last_failure_detail}` : ""}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="w-full shrink-0 rounded-2xl border border-app-border bg-app-surface-2 p-4 lg:w-72">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Runtime checks
            </p>
            <div className="mt-3 space-y-2 text-xs font-semibold text-app-text-muted">
              <div className="flex items-center justify-between gap-3">
                <span>Public HTTPS</span>
                <span className={edgeStatus?.public_https_configured ? "text-app-success" : "text-app-warning"}>
                  {edgeStatus?.public_https_configured ? "Ready" : "Needed for callbacks"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Helcim secret</span>
                <span className={edgeStatus?.helcim_webhook_secret_configured ? "text-app-success" : "text-app-warning"}>
                  {edgeStatus?.helcim_webhook_secret_configured ? "Configured" : "Missing"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Podium secret</span>
                <span className={edgeStatus?.podium_webhook_secret_configured ? "text-app-success" : "text-app-warning"}>
                  {edgeStatus?.podium_webhook_secret_configured ? "Configured" : "Missing"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>cloudflared</span>
                <span className={edgeStatus?.cloudflared_installed ? "text-app-success" : "text-app-text-muted"}>
                  {edgeStatus?.cloudflared_installed ? "Installed" : "Not detected"}
                </span>
              </div>
            </div>
            {edgeStatus?.warning_codes.length ? (
              <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] font-semibold leading-5 text-app-text-muted">
                {edgeStatus.warning_codes.slice(0, 4).map((code) => (
                  <div key={code}>{warningLabel(code)}</div>
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[11px] font-semibold leading-5 text-app-text-muted">
                No edge warnings reported.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="ui-card p-8 bg-indigo-500/5 border-indigo-500/20 shadow-xl overflow-hidden relative group">
        <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity">
          <Server size={120} />
        </div>

        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-8 relative z-10">
          <div className="space-y-4 max-w-2xl">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "w-2 h-2 rounded-full",
                  hostStatus?.lifecycle === "running"
                    ? "bg-emerald-500 animate-pulse"
                    : hostStatus?.lifecycle === "failed"
                      ? "bg-rose-500"
                      : hostStatus?.lifecycle === "starting"
                        ? "bg-amber-500 animate-pulse"
                        : "bg-app-text-muted/40",
                )}
              />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Shop Host
              </h3>
              <span
                className={cn(
                  "rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]",
                  hostStatus?.lifecycle === "running"
                    ? "bg-emerald-500 text-white"
                    : hostStatus?.lifecycle === "failed"
                      ? "bg-rose-500 text-white"
                      : hostStatus?.lifecycle === "starting"
                        ? "bg-amber-500 text-white"
                        : "bg-app-text-muted/20 text-app-text-muted",
                )}
              >
                {hostSurfaceLabel(hostStatus?.lifecycle ?? "stopped")}
              </span>
            </div>

            <p className="text-xs font-medium text-app-text-muted leading-relaxed">
              Start this only on the one Windows machine that should act as the shop host.
              That host serves local-network satellite clients. Off-site remote access is separate and depends on Tailscale.
              Host mode now requires a real frontend bundle on disk and reports startup failures directly instead of claiming success early.
            </p>

            {hostStatus?.message ? (
              <div className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-3 text-xs font-medium text-app-text">
                {hostStatus.message}
              </div>
            ) : null}

            {hostStatus?.last_error ? (
              <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-xs font-medium text-rose-200 dark:text-rose-100">
                <div className="flex items-center gap-2 font-black uppercase tracking-widest text-[10px] mb-1">
                  <AlertTriangle className="w-4 h-4" />
                  Start Failure
                </div>
                <p className="break-words">{hostStatus.last_error}</p>
              </div>
            ) : null}

            <dl className="grid gap-3 text-sm">
              <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                  Bind address
                </dt>
                <dd className="font-mono text-app-text tabular-nums">
                  {hostStatus?.bind_addr ?? `0.0.0.0:${srvPort}`}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2 border-b border-app-border/60 pb-3">
                <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                  Frontend bundle
                </dt>
                <dd className="font-mono text-xs text-app-text break-all text-right max-w-[min(100%,28rem)]">
                  {hostStatus?.frontend_dist ?? "Not resolved yet"}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="font-bold text-app-text-muted uppercase tracking-wider text-[10px]">
                  Local satellite URL
                </dt>
                <dd className="font-mono text-xs text-app-text break-all text-right max-w-[min(100%,28rem)]">
                  {hostAccessUrl ?? "Start host mode to generate the local satellite URL. Connect Tailscale separately if off-site remote access is required."}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-col gap-4 min-w-[18rem]">
            {hostStatus?.lifecycle !== "running" ? (
              <button
                onClick={() => void handleStartEngine()}
                disabled={hostBusy}
                className="ui-btn-primary px-8 py-3 rounded-2xl flex items-center justify-center gap-2 group/btn"
              >
                <Server className="w-4 h-4 group-hover/btn:scale-110 transition-transform" />
                {hostBusy ? "Starting..." : "Start Shop Host"}
              </button>
            ) : (
              <div className="flex items-center justify-center gap-2 px-6 py-3 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl text-emerald-500 text-xs font-black uppercase tracking-widest">
                <ShieldCheck className="w-4 h-4" />
                Serving on port {hostStatus.listen_port ?? srvPort}
              </div>
            )}

            {hostStatus?.lifecycle !== "running" ? (
              <div className="grid grid-cols-1 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    PostgreSQL URL
                  </label>
                  <input
                    type="text"
                    value={dbUrl}
                    onChange={(e) => setDbUrl(e.target.value)}
                    className="w-full bg-app-bg/50 border border-app-border rounded-xl px-4 py-2 text-xs font-mono text-app-text outline-none focus:border-indigo-500/50"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Host listen port
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={srvPort}
                    onChange={(e) =>
                      setSrvPort(Number.parseInt(e.target.value || `${DEFAULT_LISTEN_PORT}`, 10))
                    }
                    className="w-full bg-app-bg/50 border border-app-border rounded-xl px-4 py-2 text-xs font-mono text-app-text outline-none focus:border-indigo-500/50"
                  />
                </div>
                <p className="text-[11px] font-medium text-app-text-muted leading-relaxed">
                  Payment provider keys are no longer entered here. Host mode uses the environment already provisioned on this machine.
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-7 space-y-6">
          <div
            className={`p-8 rounded-3xl border-2 transition-all shadow-2xl ${
              isConnected
                ? "bg-emerald-500/5 border-emerald-500/20"
                : "bg-app-bg-accent border-app-border shadow-none"
            }`}
          >
            <div className="flex items-center justify-between mb-8">
              <span
                className={`px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-[0.2em] ${
                  isConnected
                    ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/40"
                    : "bg-app-text-muted/20 text-app-text-muted"
                }`}
              >
                {status?.BackendState || "System Offline"}
              </span>
              {isConnected && status?.Self ? (
                <div className="flex items-center gap-2 text-app-text-muted text-[10px] font-black uppercase tracking-widest">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Broadcasting
                </div>
              ) : null}
            </div>

            {isConnected && status?.Self ? (
              <div className="space-y-8">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                      Store Node Name
                    </span>
                    <div className="text-2xl font-black italic tracking-tight text-app-text">
                      {status.Self.HostName}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                      Private Tailscale IP
                    </span>
                    <div className="text-2xl font-black tabular-nums tracking-tighter text-app-text group relative">
                      {status.Self.TailscaleIPs[0]}
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(status.Self!.TailscaleIPs[0]);
                          toast("Copied IP to clipboard.", "success");
                        }}
                        className="ml-2 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Terminal className="w-4 h-4 text-app-accent" />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-6 rounded-2xl bg-app-surface/50 border border-app-border flex items-center justify-between gap-6">
                  <div className="flex-1">
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                      Local satellite address
                    </span>
                    <div className="text-sm font-black text-app-text mt-1 break-all">
                      {hostAccessUrl ?? "Start host mode to generate a local-network satellite URL."}
                    </div>
                    <p className="mt-2 text-[11px] font-medium text-app-text-muted leading-relaxed">
                      Use this address for iPads and other local-network satellite browsers that should talk to the host machine.
                      Off-site remote devices still need Tailscale and should use the same host only through that private remote path.
                    </p>
                    {hostStatus?.lifecycle === "running" && !hostAccessUrl ? (
                      <p className="mt-2 text-[11px] font-medium text-amber-600">
                        Shop Host is running, but Riverside could not detect a local-network hostname or LAN IPv4 on this machine yet.
                        Confirm the host is on the store network, then use the host PC&apos;s LAN address with port {hostStatus.listen_port ?? srvPort}.
                      </p>
                    ) : null}
                    {localSatelliteUrls.length > 1 ? (
                      <div className="mt-3 space-y-1">
                        {localSatelliteUrls.slice(1).map((url) => (
                          <p
                            key={url}
                            className="font-mono text-[11px] text-app-text-muted break-all"
                          >
                            Alternate local path: {url}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {hostAccessUrl ? (
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(hostAccessUrl);
                          toast("Copied local satellite URL.", "success");
                        }}
                        className="mt-2 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                      >
                        Copy address
                      </button>
                    ) : null}
                  </div>
                  {qrCodeData ? (
                    <div className="shrink-0 p-2 bg-app-surface rounded-xl shadow-lg border border-app-border">
                      <img
                        src={qrCodeData}
                        alt="Private client QR Code"
                        className="w-24 h-24"
                        title="Scan to open on a satellite device"
                      />
                    </div>
                  ) : (
                    <div className="w-24 h-24 bg-app-bg-accent rounded-xl flex items-center justify-center text-[10px] font-black uppercase tracking-widest text-app-text-muted text-center px-2">
                      No URL yet
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Host smoke check
                    </p>
                    <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">
                      Same local network only
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] font-medium text-app-text-muted leading-relaxed">
                    On a second iPad or phone that is on the same local network as this host, open the local satellite URL above and confirm the Riverside sign-in screen loads before store open.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Host network name
                    </p>
                    <p className="mt-2 font-mono text-xs text-app-text break-all">
                      {hostIdentity?.hostname ?? "Not detected"}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      LAN IPv4 addresses
                    </p>
                    <div className="mt-2 space-y-1">
                      {hostIdentity?.lan_ipv4s?.length ? (
                        hostIdentity.lan_ipv4s.map((ip) => (
                          <p key={ip} className="font-mono text-xs text-app-text">
                            {ip}
                          </p>
                        ))
                      ) : (
                        <p className="text-xs text-app-text-muted">Not detected</p>
                      )}
                    </div>
                  </div>
                </div>

                {remoteAccessUrl ? (
                  <div className="rounded-2xl border border-app-border bg-app-surface/70 px-4 py-4">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Tailscale remote path
                    </p>
                    <p className="mt-2 font-mono text-xs text-app-text break-all">
                      {remoteAccessUrl}
                    </p>
                    <p className="mt-2 text-[11px] font-medium text-app-text-muted leading-relaxed">
                      Use this only for off-site remote access over Tailscale, not for same-network iPads or phones inside the store.
                    </p>
                  </div>
                ) : null}

                <div className="pt-6 border-t border-app-border/40 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-500" />
                    <span className="text-xs font-bold text-app-text">
                      Off-site remote access stays inside your private Tailscale network.
                    </span>
                  </div>
                  <button
                    onClick={armDisconnect}
                    className={cn(
                      "text-[10px] font-black uppercase tracking-widest transition-colors",
                      disconnectArmed ? "text-rose-600" : "text-rose-500 hover:text-rose-600",
                    )}
                  >
                    {disconnectArmed ? "Confirm disconnect" : "Terminate Session"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-12 flex flex-col items-center justify-center text-center space-y-4">
                <WifiOff className="w-16 h-16 text-app-text-muted/20" />
                <div>
                  <h3 className="text-lg font-black uppercase italic tracking-tighter text-app-text">
                    Not Connected
                  </h3>
                  <p className="text-sm font-medium text-app-text-muted max-w-xs mx-auto">
                    This machine is not linked to Tailscale yet. Local host-mode service can still be configured separately, but off-site remote access will not work until Tailscale is connected.
                  </p>
                </div>
              </div>
            )}
          </div>

          {!isConnected ? (
            <div className="ui-card p-8 space-y-6">
              <div className="flex items-center gap-3">
                <Key className="w-6 h-6 text-app-primary" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Link This Machine
                </h3>
              </div>
              <div className="space-y-4">
                <p className="text-xs font-medium text-app-text-muted leading-relaxed">
                  Generate a join key in the Tailscale admin console, then link the host machine to the same private network your off-site remote devices will use.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleConnect();
                  }}
                  className="flex gap-3"
                >
                  <input
                    type="password"
                    placeholder="tskey-auth-xxxxxx..."
                    value={authKey}
                    onChange={(e) => setAuthKey(e.target.value)}
                    className="flex-1 bg-app-bg border-2 border-app-border rounded-2xl px-6 py-3 text-app-text font-mono text-sm focus:border-app-primary outline-none transition-all"
                  />
                  <button
                    type="submit"
                    disabled={connecting || !authKey}
                    className="h-12 px-8 bg-app-primary text-white text-[10px] font-black uppercase tracking-widest rounded-2xl hover:brightness-110 disabled:opacity-50 transition-all shadow-lg shadow-app-primary/20"
                  >
                    {connecting ? "Linking..." : "Link Machine"}
                  </button>
                </form>
                <div className="pt-2">
                  <a
                    href="https://login.tailscale.com/admin/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] font-bold uppercase tracking-widest text-app-primary hover:underline inline-flex items-center gap-2"
                  >
                    Open Tailscale key center <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="lg:col-span-5 space-y-6">
          <div className="bg-app-accent/5 border border-app-accent/20 rounded-3xl p-8 space-y-6">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-accent">
              Host Checklist
            </h3>

            <ol className="space-y-6">
              {[
                {
                  step: "01",
                  title: "Provision this Windows host",
                  desc: "Install the Riverside desktop app on the one Windows machine that should act as the shop host for local-network satellite clients.",
                },
                {
                  step: "02",
                  title: "Link remote access",
                  desc: "Connect the host machine to Tailscale only if off-site remote devices also need private access when they are away from the local network.",
                },
                {
                  step: "03",
                  title: "Start Shop Host",
                  desc: "Start host mode only after the PostgreSQL URL is correct. This serves local-network satellite clients and verifies the frontend bundle before claiming the host is ready.",
                },
                {
                  step: "04",
                  title: "Use the correct access path",
                  desc: "Use the host URL shown here for local-network satellites. Use Tailscale only for off-site remote devices that are not on the same local network.",
                },
                {
                  step: "05",
                  title: "Watch runtime state",
                  desc: "If host startup fails, this panel now shows the exact failure instead of silently reporting a running state.",
                },
              ].map((item) => (
                <li key={item.step} className="flex gap-4">
                  <span className="text-xs font-black text-app-accent opacity-40">
                    {item.step}
                  </span>
                  <div>
                    <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text mb-1">
                      {item.title}
                    </h4>
                    <p className="text-[11px] font-medium text-app-text-muted leading-relaxed">
                      {item.desc}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="p-6 bg-app-surface/40 rounded-3xl border border-app-border">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-app-text-muted mt-0.5" />
              <div className="space-y-1">
                <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Explicit host contract
                </h4>
                <p className="text-[11px] font-medium text-app-text-muted leading-relaxed">
                  Host mode is for the dedicated Windows host machine. The main register is a different Tauri machine, local PWA access is for devices on the same network as the host, and remote access is a separate Tailscale path for off-site devices.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
