import { useState, useEffect } from "react";
import { Loader2, LogIn, Plus, Trash2, Radio, Wifi, WifiOff } from "lucide-react";
import {
  getProfiles,
  getActiveProfileId,
  setActiveProfile,
  saveProfile,
  deleteProfile,
  getServerUrl,
  getStaffCode,
  type ServerProfile,
  checkTailscale,
  type TailscaleStatus,
  discoverServers,
  type DiscoveredServer,
} from "./lib/api";
import DevOpsDashboard from "./components/DevOpsDashboard";

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [profiles, setProfiles] = useState<ServerProfile[]>(getProfiles());
  const [activeId, setActiveId] = useState(getActiveProfileId());
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newCode, setNewCode] = useState("");
  const [isTailscale, setIsTailscale] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [tsStatus, setTsStatus] = useState<TailscaleStatus | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredServer[]>([]);
  const [scanning, setScanning] = useState(false);

  const active = profiles.find((p) => p.id === activeId) || profiles[0];

  useEffect(() => {
    checkTailscale().then(setTsStatus).catch(() => setTsStatus({ running: false }));
  }, []);

  const handleConnect = async () => {
    setError("");
    setChecking(true);
    try {
      const url = active.url.replace(/\/$/, "");
      const res = await fetch(`${url}/api/ops/overview`, {
        headers: { "x-riverside-staff-code": active.staffCode },
      });
      if (!res.ok) throw new Error("Invalid credentials or server unreachable");
      setActiveProfile(active.id);
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setChecking(false);
    }
  };

  const handleSaveProfile = () => {
    if (!newName.trim() || !newUrl.trim()) return;
    const profile: ServerProfile = {
      id: crypto.randomUUID(),
      name: newName.trim(),
      url: newUrl.trim(),
      staffCode: newCode.trim(),
      isTailscale,
    };
    saveProfile(profile);
    setProfiles(getProfiles());
    setActiveId(profile.id);
    setShowAdd(false);
    setNewName("");
    setNewUrl("");
    setNewCode("");
    setIsTailscale(false);
  };

  const handleDelete = (id: string) => {
    deleteProfile(id);
    setProfiles(getProfiles());
    setActiveId(getActiveProfileId());
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-lg ui-card p-8">
        <div className="mb-6 flex items-center gap-3">
          <img src="/logo1.png" alt="Riverside" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-black tracking-wide">ROS Dev Center</h1>
            <p className="text-xs text-app-text-muted">Standalone DevOps Manager</p>
          </div>
        </div>

        {/* Tailscale Status */}
        {tsStatus && (
          <div className={`mb-4 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
            tsStatus.running
              ? "bg-app-success/12 text-app-success"
              : "bg-app-warning/12 text-app-warning"
          }`}>
            {tsStatus.running ? <Wifi className="h-4 w-4" /> : <WifiOff className="h-4 w-4" />}
            <span className="font-bold">
              {tsStatus.running ? "Tailscale Connected" : "Tailscale Not Running"}
            </span>
            {tsStatus.tailnet && <span className="text-app-text-muted">· {tsStatus.tailnet}</span>}
          </div>
        )}

        {/* Auto-Discovery */}
        <div className="mb-4">
          <button
            onClick={async () => {
              setScanning(true);
              setDiscovered([]);
              try {
                const servers = await discoverServers();
                setDiscovered(servers);
              } catch {
                setDiscovered([]);
              } finally {
                setScanning(false);
              }
            }}
            disabled={scanning}
            className="ui-btn ui-btn-ghost ui-btn-sm mb-2 inline-flex w-full items-center justify-center gap-2"
          >
            {scanning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Radio className="h-4 w-4" />
            )}
            {scanning ? "Scanning network..." : "Scan for Riverside Servers"}
          </button>

          {discovered.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                Discovered Servers
              </p>
              {discovered.map((srv, i) => (
                <div
                  key={i}
                  onClick={() => {
                    const updated = { ...active, url: srv.url };
                    saveProfile(updated);
                    setProfiles(getProfiles());
                  }}
                  className="cursor-pointer rounded-lg border border-app-success/30 bg-app-success/5 p-3 transition-colors hover:bg-app-success/10"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-bold text-app-text">
                        {srv.name || "Riverside Server"}
                        {srv.tailscale && (
                          <span className="rounded-full bg-app-accent/20 px-2 py-0.5 text-[10px] text-app-accent">
                            Tailscale
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-app-text-muted">{srv.url}</div>
                    </div>
                    {srv.latency_ms && (
                      <span className="text-[10px] font-bold text-app-success">
                        {srv.latency_ms}ms
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!scanning && discovered.length === 0 && (
            <p className="text-center text-[10px] text-app-text-muted">
              No servers found. Try scanning or enter URL manually.
            </p>
          )}
        </div>

        {/* Profile Selector */}
        <div className="mb-4">
          <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-app-text-muted">
            Server Profile
          </label>
          <div className="space-y-2">
            {profiles.map((p) => (
              <div
                key={p.id}
                onClick={() => setActiveId(p.id)}
                className={`flex cursor-pointer items-center justify-between rounded-lg border p-3 transition-colors ${
                  p.id === activeId
                    ? "border-app-accent bg-app-accent/10"
                    : "border-app-border/60 hover:border-app-accent/50"
                }`}
              >
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold text-app-text">
                    {p.name}
                    {p.isTailscale && (
                      <span className="rounded-full bg-app-accent/20 px-2 py-0.5 text-[10px] text-app-accent">
                        Tailscale
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-app-text-muted">{p.url}</div>
                </div>
                <div className="flex items-center gap-2">
                  {p.id !== "local" && p.id !== "tailscale" && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(p.id);
                      }}
                      className="rounded p-1 text-app-text-muted hover:bg-app-danger/20 hover:text-app-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                  <div className={`h-3 w-3 rounded-full ${p.id === activeId ? "bg-app-accent" : "bg-app-border"}`} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Active Profile Details */}
        <div className="mb-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-app-text-muted">
              Server URL
            </label>
            <input
              type="url"
              value={active?.url || ""}
              onChange={(e) => {
                const updated = { ...active, url: e.target.value };
                saveProfile(updated);
                setProfiles(getProfiles());
              }}
              className="ui-input"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-app-text-muted">
              Staff PIN
            </label>
            <input
              type="password"
              value={active?.staffCode || ""}
              onChange={(e) => {
                const updated = { ...active, staffCode: e.target.value };
                saveProfile(updated);
                setProfiles(getProfiles());
              }}
              className="ui-input"
            />
          </div>
        </div>

        {/* Add Profile */}
        {showAdd ? (
          <div className="mb-4 space-y-3 rounded-lg border border-app-border/60 bg-app-bg p-4">
            <input
              placeholder="Profile name (e.g., Store Production)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="ui-input"
            />
            <input
              placeholder="Server URL (e.g., http://riverside-server:3000)"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              className="ui-input"
            />
            <input
              type="password"
              placeholder="Staff PIN"
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              className="ui-input"
            />
            <label className="flex items-center gap-2 text-xs text-app-text-muted">
              <input
                type="checkbox"
                checked={isTailscale}
                onChange={(e) => setIsTailscale(e.target.checked)}
                className="rounded border-app-border"
              />
              Uses Tailscale
            </label>
            <div className="flex gap-2">
              <button onClick={handleSaveProfile} className="ui-btn ui-btn-primary ui-btn-sm">
                Save Profile
              </button>
              <button onClick={() => setShowAdd(false)} className="ui-btn ui-btn-ghost ui-btn-sm">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAdd(true)}
            className="ui-btn ui-btn-ghost ui-btn-sm mb-4 inline-flex items-center gap-1"
          >
            <Plus className="h-4 w-4" />
            Add Server Profile
          </button>
        )}

        {error && (
          <p className="mb-4 rounded-lg bg-app-danger/12 px-3 py-2 text-xs text-app-danger">
            {error}
          </p>
        )}

        <button
          onClick={handleConnect}
          disabled={checking}
          className="ui-btn ui-btn-primary w-full justify-center gap-2"
        >
          <LogIn className="h-4 w-4" />
          {checking ? "Connecting..." : `Connect to ${active?.name || "Server"}`}
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    if (getStaffCode()) {
      setLoggedIn(true);
    }
  }, []);

  if (!loggedIn) {
    return <LoginScreen onLogin={() => setLoggedIn(true)} />;
  }

  return <DevOpsDashboard />;
}
