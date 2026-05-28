import { useEffect, useState, useMemo, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ShieldCheck } from "lucide-react";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffMiniSelector from "../ui/StaffMiniSelector";
import RiversideLogo from "../../assets/images/riverside_logo.jpg";
import { DEFAULT_BASE_URL } from "../../lib/apiConfig";

interface InstalledServerStartStatus {
  started: boolean;
  message: string;
}

interface ApiHostOption {
  label: string;
  url: string;
  helper: string;
}

function isLoopbackServerUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isWindowsDesktop(): boolean {
  return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}

function isBackofficeServerStation(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("ros.station.label") === "Backoffice / Server";
}

function shouldAutoStartLocalServer(serverUrl: string): boolean {
  return (
    isTauri() &&
    isWindowsDesktop() &&
    isBackofficeServerStation() &&
    isLoopbackServerUrl(serverUrl)
  );
}

function normalizeApiBase(value: string): string {
  let url = value.trim();
  if (url && !url.startsWith("http")) {
    url = `http://${url}`;
  }
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && !parsed.port) {
      parsed.port = "3000";
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/$/, "");
  }
}

function getBrowserOriginOption(): ApiHostOption | null {
  if (typeof window === "undefined") return null;
  const { origin, protocol } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return null;
  return {
    label: "This browser address",
    url: origin.replace(/\/$/, ""),
    helper: "Use when this app was opened from the Riverside server URL.",
  };
}

function uniqueHostOptions(options: ApiHostOption[]): ApiHostOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = normalizeApiBase(option.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Blocks the Back Office shell until a valid 4-digit staff credential is stored.
 * Independent of the register: POS / checkout still require an open session where enforced.
 */
export default function BackofficeSignInGate({
  children,
}: {
  children: ReactNode;
}) {
  const {
    staffCode,
    setStaffCredentials,
    clearStaffCredentials,
    adoptPermissionsFromServer,
    permissions,
    permissionsLoaded,
  } = useBackofficeAuth();
  const { toast } = useToast();
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<{ id: string; full_name: string }[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState<string>(() => {
    return localStorage.getItem("ros_last_staff_id") || "";
  });
  const [serverUrl, setServerUrl] = useState(() => {
    return localStorage.getItem("ros_api_base_override") || DEFAULT_BASE_URL;
  });
  const [showServerSetup, setShowServerSetup] = useState(false);
  const [tempUrl, setTempUrl] = useState(serverUrl);
  const [serverStartupNotice, setServerStartupNotice] = useState<string | null>(null);

  const apiHostOptions = useMemo(() => {
    const current = normalizeApiBase(serverUrl);
    const browserOrigin = getBrowserOriginOption();
    return uniqueHostOptions([
      ...(current
        ? [
            {
              label: "Current saved host",
              url: current,
              helper: "The host this device is using right now.",
            },
          ]
        : []),
      {
        label: isBackofficeServerStation()
          ? "Backoffice / Server direct"
          : "This PC local server",
        url: "http://127.0.0.1:3000",
        helper: "Use only on the Backoffice / Server PC.",
      },
      {
        label: "Default app host",
        url: DEFAULT_BASE_URL,
        helper: "The packaged default or same-origin Riverside host.",
      },
      ...(browserOrigin ? [browserOrigin] : []),
    ]);
  }, [serverUrl]);

  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  const saveServerUrl = () => {
    const url = normalizeApiBase(tempUrl);

    if (url === DEFAULT_BASE_URL) {
      localStorage.removeItem("ros_api_base_override");
    } else {
      localStorage.setItem("ros_api_base_override", url);
    }

    setServerUrl(url || DEFAULT_BASE_URL);
    setShowServerSetup(false);
    window.location.reload(); // Reload to re-trigger the roster fetch with new URL
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`${serverUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setRoster(data);
          setServerStartupNotice(null);
          return;
        }
      } catch {
        // The Windows server app can recover the installed local server task below.
      }

      if (cancelled) return;
      setRoster([]);

      if (!shouldAutoStartLocalServer(serverUrl)) {
        return;
      }

      setServerStartupNotice("Starting the local Riverside server...");
      try {
        const startResult = await invoke<InstalledServerStartStatus>(
          "start_installed_windows_server",
          { serverUrl },
        );
        if (cancelled) return;
        setServerStartupNotice(startResult.message);

        const retry = await fetch(`${serverUrl}/api/staff/list-for-pos`);
        if (retry.ok) {
          const data = await retry.json();
          if (cancelled) return;
          setRoster(data);
          setServerStartupNotice(null);
          return;
        }

        setServerStartupNotice("Local server started, but the staff list did not load.");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setServerStartupNotice(msg);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  const handleStaffChange = (id: string) => {
    setSelectedStaffId(id);
    localStorage.setItem("ros_last_staff_id", id);
  };

  useEffect(() => {
    if (!permissionsLoaded || !staffCode.trim()) return;
    if (permissions.length > 0) return;
    clearStaffCredentials();
  }, [permissionsLoaded, staffCode, permissions.length, clearStaffCredentials]);

  const hasStaffCode = staffCode.trim().length > 0;

  const trySignIn = async () => {
    const code = credential.trim();
    if (!selectedStaffId) {
      setError("Select your name first.");
      return;
    }
    if (code.length !== 4) {
      setError("Enter 4-digit PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${serverUrl}/api/staff/effective-permissions`, {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Invalid PIN");
      }
      const data = (await res.json()) as {
        id?: string;
        staff_id?: string;
        permissions?: string[];
        full_name?: string;
        avatar_key?: string;
        avatar_photo_url?: string | null;
        role?: string;
      };

      if (selectedStaffId && data.id && selectedStaffId !== data.id) {
        throw new Error("PIN belongs to another staff member.");
      }

      const list = Array.isArray(data.permissions) ? data.permissions : [];
      if (list.length === 0) {
        throw new Error("No permissions for this account.");
      }
      setStaffCredentials(code, code);
      const display =
        typeof data.full_name === "string" ? data.full_name.trim() : "";
      const avatar =
        typeof data.avatar_key === "string" ? data.avatar_key.trim() : "";
      const avatarPhoto =
        typeof data.avatar_photo_url === "string" ? data.avatar_photo_url.trim() : null;
      const roleParsed: StaffRole | null =
        data.role === "admin" ||
        data.role === "salesperson" ||
        data.role === "sales_support"
          ? (data.role as StaffRole)
          : null;
      adoptPermissionsFromServer(list, display, avatar || null, avatarPhoto, roleParsed, data.id || data.staff_id);

      if (data.id) {
        handleStaffChange(data.id);
      }

      setCredential("");
      toast("Signed in.", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  if (hasStaffCode && permissionsLoaded && permissions.length > 0) {
    return <>{children}</>;
  }

  if (hasStaffCode && !permissionsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-app-bg font-sans text-app-text-muted antialiased">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-app-bg p-6 font-sans antialiased w-full h-full">
      <div className="w-full max-w-md overflow-hidden rounded-[32px] border border-app-border/40 bg-app-surface shadow-2xl">
        <div className="border-b border-app-border bg-app-surface-2 px-8 py-6 text-center">
          <div className="mx-auto mb-4 h-16 w-auto flex items-center justify-center overflow-hidden rounded-xl">
             <img src={RiversideLogo} alt="Riverside Men's Shop" className="h-full w-auto object-contain" />
          </div>
          <h1 className="mt-1 text-xl font-black tracking-tight text-app-text">
            Sign in
          </h1>
        </div>
        <div className="space-y-6 px-8 py-8">
          {error ? (
            <p className="rounded-2xl border border-app-danger/20 bg-app-danger/5 px-4 py-3 text-center text-xs font-bold text-app-danger">
              {error}
            </p>
          ) : null}
          {serverStartupNotice && !error ? (
            <p className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-center text-xs font-bold text-amber-700">
              {serverStartupNotice}
            </p>
          ) : null}

          <div className="space-y-3">
            <p className="text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              Select Your Name
            </p>
            <div className="w-full">
              <StaffMiniSelector
                staff={roster.map((s) => ({ id: s.id, full_name: s.full_name }))}
                selectedId={selectedStaffId}
                onSelect={handleStaffChange}
                placeholder="Select staff member..."
                size="lg"
                showAvatar={true}
                className="w-full"
              />
            </div>
            {!selectedStaffId && (
              <p className="text-center text-[10px] font-bold text-amber-600">
                Please select a name first
              </p>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted">
              PIN
            </p>
            <PinDots length={credential.length} className="py-0.5" />
            <NumericPinKeypad
              value={credential}
              onChange={(v) => {
                setError(null);
                setCredential(v);
              }}
              onEnter={trySignIn}
              disabled={busy}
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setCredential("");
                setError(null);
              }}
              className="ui-btn-secondary h-14 flex-1 text-sm font-black"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={busy || credential.length !== 4 || !selectedStaffId}
              onClick={() => void trySignIn()}
              className="ui-btn-primary h-14 flex-[2] text-sm font-black disabled:opacity-50"
            >
              {busy ? "…" : "Continue"}
            </button>
          </div>
        </div>
        {isTailscaleRemote && (
          <div className="bg-indigo-600/10 border-t border-app-border flex items-center justify-center gap-2 py-3">
             <ShieldCheck size={14} className="text-indigo-600" />
             <span className="text-[10px] font-black uppercase tracking-widest text-indigo-600">
               Remote Tailscale Session
             </span>
          </div>
        )}
      </div>

      {/* Server connection — inline panel */}
      <div className="mt-6 w-full max-w-md">
        {!showServerSetup ? (
          <button
            onClick={() => setShowServerSetup(true)}
            className="w-full flex items-center justify-between rounded-2xl border border-app-border/40 bg-app-surface/60 px-5 py-3 hover:bg-app-surface transition-colors"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                roster.length > 0 ? "bg-emerald-500" : "bg-red-500 animate-pulse"
              }`} />
              <div className="text-left min-w-0">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Server</p>
                <p className="text-[11px] font-mono font-bold text-app-text truncate">{serverUrl}</p>
              </div>
            </div>
            <span className="text-[9px] font-black uppercase tracking-widest text-app-accent shrink-0 ml-2">Change</span>
          </button>
        ) : (
          <div className="rounded-2xl border border-app-border/40 bg-app-surface overflow-hidden animate-in slide-in-from-bottom-2 duration-200">
            <div className="px-5 py-3 border-b border-app-border/40 bg-app-bg/40">
              <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text">Server Connection</h3>
              <p className="text-[9px] text-app-text-muted mt-0.5">Select a known server or enter a custom IP address.</p>
            </div>
            <div className="p-5 space-y-4">
              {/* Quick-pick known hosts */}
              <div className="space-y-1.5">
                {apiHostOptions.map((option) => {
                  const isSelected = normalizeApiBase(option.url) === normalizeApiBase(tempUrl);
                  return (
                    <button
                      key={option.url}
                      type="button"
                      onClick={() => setTempUrl(option.url)}
                      className={`w-full text-left rounded-xl border px-4 py-2.5 transition-colors ${
                        isSelected
                          ? "border-app-accent bg-app-accent/10"
                          : "border-app-border/60 bg-app-bg/60 hover:border-app-accent/40"
                      }`}
                    >
                      <p className={`text-xs font-bold ${isSelected ? "text-app-accent" : "text-app-text"}`}>{option.label}</p>
                      <p className="text-[10px] font-mono text-app-text-muted">{option.url}</p>
                    </button>
                  );
                })}
              </div>
              {/* Manual URL input */}
              <div>
                <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Or enter IP address / URL
                </label>
                <input
                  type="text"
                  value={tempUrl}
                  onChange={(e) => setTempUrl(e.target.value)}
                  placeholder="http://192.168.1.100:3000"
                  className="mt-1 w-full bg-app-bg border border-app-border rounded-xl px-4 py-2.5 text-xs font-mono text-app-text outline-none focus:border-app-accent"
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={saveServerUrl}
                  className="ui-btn-primary h-10 flex-[2] text-xs font-black"
                >
                  Save &amp; Connect
                </button>
                <button
                  onClick={() => setShowServerSetup(false)}
                  className="ui-btn-secondary h-10 flex-1 text-xs font-black"
                >
                  Cancel
                </button>
              </div>
              <button
                onClick={() => {
                  setTempUrl(DEFAULT_BASE_URL);
                  localStorage.removeItem("ros_api_base_override");
                  setServerUrl(DEFAULT_BASE_URL);
                  setShowServerSetup(false);
                  window.location.reload();
                }}
                className="w-full text-[9px] font-black uppercase tracking-widest text-app-text-muted/60 hover:text-app-text transition-all"
              >
                Reset to Default
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
