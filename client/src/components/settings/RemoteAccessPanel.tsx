import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  WifiOff,
  ExternalLink,
  ShieldCheck,
  RefreshCcw,
  Terminal,
  Server,
  Key,
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

export default function RemoteAccessPanel() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TailscaleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [authKey, setAuthKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [qrCodeData, setQrCodeData] = useState<string | null>(null);
  const [dbUrl, setDbUrl] = useState("postgres://postgres:password@localhost/riverside_os");
  const [srvPort, setSrvPort] = useState(3000);
  const [isEngineRunning, setIsEngineRunning] = useState(false);
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
        "Connection Error: Could not reach Tailscale service. Is the binary configured?",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }, [baseUrl, backofficeHeaders, toast]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.Self?.DNSName) {
      // MagicDNS names often have a trailing dot like "machine.tailnet.net."
      const cleanDns = status.Self.DNSName.replace(/\.$/, "");
      const url = `http://${cleanDns}:3000`;
      QRCode.toDataURL(url, { margin: 2, scale: 10, color: { dark: "#059669", light: "#ffffff" } })
        .then(setQrCodeData)
        .catch(console.error);
    } else {
      setQrCodeData(null);
    }
  }, [status]);

  useEffect(() => {
    const checkEngine = async () => {
      try {
        const running = await invoke<boolean>("get_unified_server_status");
        setIsEngineRunning(running);
      } catch (e) {
        console.warn("Unified Engine status check failed (are you in a browser?)", e);
      }
    };
    void checkEngine();
  }, []);

  const handleStartEngine = async () => {
    try {
      const res = await invoke<string>("start_unified_server", {
        databaseUrl: dbUrl,
        stripeKey: "sk_test_placeholder", // Will draw from env or encrypted storage later
        port: srvPort,
      });
      toast(res, "success");
      setIsEngineRunning(true);
    } catch (e) {
      toast(`Engine Start Failed: ${e}`, "error");
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
      toast("Success: Tailscale connection initiated.", "success");
      setAuthKey("");
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connect failed";
      toast(`Error: ${msg}`, "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/remote-access/disconnect`,
        {
          method: "POST",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (!res.ok) throw new Error("Failed to disconnect");
      toast("Disconnected: Tailscale session closed.", "info");
      await fetchStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Disconnect failed";
      toast(`Error: ${msg}`, "error");
    }
  };

  const isConnected = status?.BackendState === "Running";

  // Basic heuristic: if we are accessing via a 100.x.x.x IP or a .tailscale.net / .ts.net domain, we are remote.
  const isRemoteSession =
    typeof window !== "undefined" &&
    (window.location.hostname.startsWith("100.") ||
      window.location.hostname.endsWith(".tailscale.net") ||
      window.location.hostname.endsWith(".ts.net"));

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {isRemoteSession && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-center gap-4 animate-pulse">
          <div className="p-2 bg-amber-500 rounded-lg text-white">
            <ExternalLink className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="text-xs font-black uppercase tracking-widest text-amber-500">
              Remote Session Active
            </p>
            <p className="text-[11px] font-medium text-app-text-muted">
              You are accessing ROS via Tailscale. Be extremely careful when
              managing connectivity.
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
              Managed Remote Access & Tailscale Connectivity
            </p>
          </div>
        </div>
        <button
          onClick={fetchStatus}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-app-bg-accent rounded-xl text-xs font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
        >
          <RefreshCcw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Check Status
        </button>
      </div>
      
      {/* Unified Engine Control - The "Server PC" Switch */}
      <div className="ui-card p-8 bg-indigo-500/5 border-indigo-500/20 shadow-xl overflow-hidden relative group">
        <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none group-hover:opacity-10 transition-opacity">
          <Server size={120} />
        </div>
        
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-8 relative z-10">
          <div className="space-y-2 max-w-xl">
            <div className="flex items-center gap-3">
              <div className={cn("w-2 h-2 rounded-full", isEngineRunning ? "bg-emerald-500 animate-pulse" : "bg-app-text-muted/40")} />
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Shop Engine (Unified Host)
              </h3>
            </div>
            <p className="text-xs font-medium text-app-text-muted leading-relaxed">
              Enable this mode only on your **Main Server PC**. When active, this application 
              manages the database and serves as the anchor for all other registers and iPads in your shop.
            </p>
          </div>

          <div className="flex items-center gap-4">
            {!isEngineRunning ? (
              <button
                onClick={handleStartEngine}
                className="ui-btn-primary px-8 py-3 rounded-2xl flex items-center gap-2 group/btn"
              >
                <Server className="w-4 h-4 group-hover/btn:scale-110 transition-transform" />
                Start Unified Engine
              </button>
            ) : (
              <div className="flex items-center gap-2 px-6 py-3 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl text-emerald-500 text-xs font-black uppercase tracking-widest">
                <ShieldCheck className="w-4 h-4" />
                Engine Active on Port {srvPort}
              </div>
            )}
          </div>
        </div>

        {!isEngineRunning && (
          <div className="mt-8 pt-8 border-t border-app-border grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in slide-in-from-top-4 duration-500">
             <div className="space-y-2">
               <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">PostgreSQL URL</label>
               <input 
                 type="text" 
                 value={dbUrl}
                 onChange={(e) => setDbUrl(e.target.value)}
                 className="w-full bg-app-bg/50 border border-app-border rounded-xl px-4 py-2 text-xs font-mono text-app-text outline-none focus:border-indigo-500/50"
               />
             </div>
             <div className="space-y-2">
               <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Server Listen Port</label>
               <input 
                 type="number" 
                 value={srvPort}
                 onChange={(e) => setSrvPort(parseInt(e.target.value))}
                 className="w-full bg-app-bg/50 border border-app-border rounded-xl px-4 py-2 text-xs font-mono text-app-text outline-none focus:border-indigo-500/50"
               />
             </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Status Dashboard */}
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
              {isConnected && status?.Self && (
                <div className="flex items-center gap-2 text-app-text-muted text-[10px] font-black uppercase tracking-widest">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  Broadcasting
                </div>
              )}
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
                          navigator.clipboard.writeText(
                            status.Self!.TailscaleIPs[0],
                          );
                          toast("Copied IP to clipboard.", "success");
                        }}
                        className="ml-2 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Terminal className="w-4 h-4 text-app-accent" />
                      </button>
                    </div>
                  </div>
                </div>

                {status.Self.DNSName && (
                  <div className="p-6 rounded-2xl bg-white/50 border border-app-border flex items-center justify-between gap-6">
                    <div className="flex-1">
                      <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                        MagicDNS Discovery Address
                      </span>
                      <div className="text-sm font-black text-app-text mt-1 truncate">
                        http://{status.Self.DNSName.replace(/\.$/, "")}:3000
                      </div>
                      <button
                        onClick={() => {
                          const url = `http://${status.Self!.DNSName.replace(/\.$/, "")}:3000`;
                          navigator.clipboard.writeText(url);
                          toast("Copied MagicDNS URL.", "success");
                        }}
                        className="mt-2 text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                      >
                        Copy address
                      </button>
                    </div>
                    {qrCodeData ? (
                      <div className="shrink-0 p-2 bg-white rounded-xl shadow-lg border border-app-border">
                        <img src={qrCodeData} alt="MagicDNS QR Code" className="w-24 h-24" title="Scan to open on iPhone" />
                      </div>
                    ) : (
                      <div className="w-24 h-24 bg-app-bg-accent rounded-xl animate-pulse" />
                    )}
                  </div>
                )}

                <div className="pt-6 border-t border-app-border/40 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ShieldCheck className="w-5 h-5 text-emerald-500" />
                    <span className="text-xs font-bold text-app-text">
                      Connection is encrypted and private.
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      if (isRemoteSession) {
                        if (
                          confirm(
                            "CRITICAL WARNING: You are connected remotely. Disconnecting Tailscale will terminate your access IMMEDIATELY and you will be locked out until you are physically at the shop. Proceed?",
                          )
                        ) {
                          handleDisconnect();
                        }
                      } else {
                        handleDisconnect();
                      }
                    }}
                    className="text-[10px] font-black uppercase tracking-widest text-rose-500 hover:text-rose-600 transition-colors"
                  >
                    Terminate Session
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
                    This machine is currently invisible to remote devices.
                    Connect below to enable off-site access.
                  </p>
                </div>
              </div>
            )}
          </div>

          {!isConnected && (
            <div className="ui-card p-8 space-y-6">
              <div className="flex items-center gap-3">
                <Key className="w-6 h-6 text-app-primary" />
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  One-Click Link
                </h3>
              </div>
              <div className="space-y-4">
                <p className="text-xs font-medium text-app-text-muted leading-relaxed">
                  Generate a "Join Key" from your Tailscale dashboard to
                  securely link this host.
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
                    {connecting ? "Initializing..." : "Link Machine"}
                  </button>
                </form>
                <div className="pt-2">
                  <a
                    href="https://login.tailscale.com/admin/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] font-bold uppercase tracking-widest text-app-primary hover:underline inline-flex items-center gap-2"
                  >
                    Go to Tailscale Key Center{" "}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* User Manual / Guide Sidebar */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-app-accent/5 border border-app-accent/20 rounded-3xl p-8 space-y-6">
            <h3 className="text-xs font-black uppercase tracking-[0.2em] text-app-accent">
              Setup Manual
            </h3>

            <ol className="space-y-6">
              {[
                {
                  step: "01",
                  title: "Deploy Host",
                  desc: "Running ROS on this machine (Host) is the first step. This app will act as your store's digital brain.",
                },
                {
                  step: "02",
                  title: "Obtain Join Key",
                  desc: "Visit Tailscale Admin and create an 'Auth Key'. Copy it to the clipboard.",
                },
                {
                  step: "03",
                  title: "Link and Bridge",
                  desc: "Paste the key into 'One-Click Link' on the left. Your machine is now part of your private cloud.",
                },
                {
                  step: "04",
                  title: "Remote Apps",
                  desc: "Install Tailscale on your iPhone or Home Laptop. Log in with the same account.",
                },
                {
                  step: "05",
                  title: "Secure Access",
                  desc: "Open your browser to the Private IP shown here. You are now inside ROS from anywhere.",
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
                  Zero-Trust Environment
                </h4>
                <p className="text-[11px] font-medium text-app-text-muted leading-relaxed">
                  Riverside never opens ports to the public web. All traffic is
                  tunneled through your private Tailscale mesh.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
