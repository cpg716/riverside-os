import { useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { RefreshCw, ShieldCheck, Sparkles, Wifi } from "lucide-react";
import { CLIENT_SEMVER } from "../../clientBuildMeta";
import {
  checkForAppUpdate,
  installAppUpdate,
} from "../../lib/appUpdater";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffMiniSelector from "../ui/StaffMiniSelector";
import RiversideLogo from "../../assets/images/riverside_logo.jpg";
import { DEFAULT_BASE_URL } from "../../lib/apiConfig";
import { getConnectionKey, getStableStationKey } from "../../lib/stationIdentity";

interface InstalledServerStartStatus {
  started: boolean;
  message: string;
}

interface ApiHostOption {
  label: string;
  url: string;
  helper: string;
}

const SIGN_IN_BOOTSTRAP_TIMEOUT_MS = 6_000;
const SIGN_IN_REQUEST_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SIGN_IN_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeout);
  }
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

function isTailscaleUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  } catch {
    return false;
  }
}

function stripV(v: string): string {
  return v.replace(/^v/, "");
}

function serverIsAhead(serverVer: string, clientVer: string): boolean {
  const parse = (v: string) => stripV(v).split(".").map(Number);
  const [sm, sn, sp] = parse(serverVer);
  const [cm, cn, cp] = parse(clientVer);
  if (sm !== cm) return sm > cm;
  if (sn !== cn) return sn > cn;
  return sp > cp;
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
  const autoSignInKeyRef = useRef<string | null>(null);
  const trySignInRef = useRef<() => void>(() => undefined);
  const [serverUrl, setServerUrl] = useState(() => {
    return localStorage.getItem("ros_api_base_override") || DEFAULT_BASE_URL;
  });
  const [showServerSetup, setShowServerSetup] = useState(false);
  const [tempUrl, setTempUrl] = useState(serverUrl);
  const [serverStartupNotice, setServerStartupNotice] = useState<string | null>(null);
  const [savedTailscaleUrl, setSavedTailscaleUrl] = useState<string>(() => {
    return localStorage.getItem("ros_tailscale_url") || "";
  });
  const [showTailscaleInput, setShowTailscaleInput] = useState(false);
  const [tempTailscaleUrl, setTempTailscaleUrl] = useState("");
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [versionGateBlocked, setVersionGateBlocked] = useState(false);
  const [appUpdateBusy, setAppUpdateBusy] = useState(false);
  const [appUpdateDone, setAppUpdateDone] = useState(false);

  const apiHostOptions = useMemo(() => {
    const current = normalizeApiBase(serverUrl);
    const browserOrigin = getBrowserOriginOption();
    const tailscaleNorm = savedTailscaleUrl ? normalizeApiBase(savedTailscaleUrl) : "";
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
      ...(tailscaleNorm
        ? [
            {
              label: "Store server (Tailscale / remote)",
              url: tailscaleNorm,
              helper: "Your store's Tailscale remote address. Requires Tailscale to be running on this device.",
            },
          ]
        : []),
      ...(browserOrigin ? [browserOrigin] : []),
    ]);
  }, [serverUrl, savedTailscaleUrl]);

  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  // True when the current serverUrl looks like a Tailscale address but we have no roster
  const tailscaleConnectionFailed =
    roster.length === 0 &&
    !serverStartupNotice &&
    isTailscaleUrl(serverUrl);

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
      let connectionFailed = false;
      try {
        // Check version first — if server is ahead of client, gate the UI.
        const verRes = await fetchWithTimeout(
          `${serverUrl}/api/version`,
          { cache: "no-store" },
          SIGN_IN_BOOTSTRAP_TIMEOUT_MS,
        ).catch(() => null);
        if (verRes?.ok) {
          const verData = await verRes.json() as { version: string };
          if (cancelled) return;
          setServerVersion(verData.version);
          if (serverIsAhead(verData.version, CLIENT_SEMVER)) {
            setVersionGateBlocked(true);
            return;
          }
        }

        const res = await fetchWithTimeout(
          `${serverUrl}/api/staff/list-for-pos`,
          {},
          SIGN_IN_BOOTSTRAP_TIMEOUT_MS,
        );
        if (res.ok) {
          const data = await res.json();
          if (cancelled) return;
          setRoster(data);
          setServerStartupNotice(null);
          return;
        }
      } catch {
        connectionFailed = true;
        // The Windows server app can recover the installed local server task below.
      }

      if (cancelled) return;
      setRoster([]);

      if (!shouldAutoStartLocalServer(serverUrl)) {
        setServerStartupNotice(
          connectionFailed && !isTailscaleUrl(serverUrl)
            ? "Cannot reach the Main Hub server. Check the server address, Wi-Fi, and that Riverside Server is running."
            : null,
        );
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

        const retry = await fetchWithTimeout(
          `${serverUrl}/api/staff/list-for-pos`,
          {},
          SIGN_IN_BOOTSTRAP_TIMEOUT_MS,
        );
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
    setCredential("");
    setError(null);
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
      setError("Enter your 4-digit Access PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const tauri = isTauri();
      const standalonePwa =
        !tauri &&
        (window.matchMedia?.("(display-mode: standalone)").matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true);
      const res = await fetchWithTimeout(
        `${serverUrl}/api/staff/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            staff_id: selectedStaffId,
            pin: code,
            station_key: getStableStationKey(),
            connection_key: getConnectionKey(),
            runtime_surface: tauri
              ? "tauri_desktop"
              : standalonePwa
                ? "pwa_standalone"
                : "browser_tab",
            user_agent: navigator.userAgent.slice(0, 512),
            api_base: serverUrl.slice(0, 512),
          }),
        },
      );
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
        session_token?: string;
        session_expires_at?: string;
      };

      const authenticatedStaffId = data.id || data.staff_id || "";
      if (selectedStaffId && authenticatedStaffId !== selectedStaffId) {
        throw new Error("PIN belongs to another staff member.");
      }

      const list = Array.isArray(data.permissions) ? data.permissions : [];
      if (list.length === 0) {
        throw new Error("No permissions for this account.");
      }
      const sessionToken = data.session_token?.trim() ?? "";
      const sessionExpiresAt = data.session_expires_at?.trim() ?? "";
      if (!sessionToken || !sessionExpiresAt) {
        throw new Error("The server did not create a Staff Access session.");
      }
      setStaffCredentials(authenticatedStaffId, "", sessionToken, sessionExpiresAt);
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
      adoptPermissionsFromServer(
        list,
        display,
        avatar || null,
        avatarPhoto,
        roleParsed,
        authenticatedStaffId,
      );

      if (authenticatedStaffId) {
        handleStaffChange(authenticatedStaffId);
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
  trySignInRef.current = () => {
    void trySignIn();
  };

  useEffect(() => {
    const code = credential.trim();
    if (code.length !== 4) {
      autoSignInKeyRef.current = null;
      return;
    }
    if (busy || !selectedStaffId) return;

    const key = `${selectedStaffId}:${code}`;
    if (autoSignInKeyRef.current === key) return;
    autoSignInKeyRef.current = key;
    trySignInRef.current();
  }, [busy, credential, selectedStaffId]);

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

  // Version gate: server has been updated but this station hasn't yet.
  if (versionGateBlocked && serverVersion) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-6 bg-app-bg p-6 font-sans antialiased">
        <div className="w-full max-w-sm overflow-hidden rounded-[32px] border border-app-border/40 bg-app-surface shadow-2xl">
          <div className="border-b border-app-border bg-app-surface-2 px-8 py-6 text-center">
            <div className="mx-auto mb-4 h-16 w-auto flex items-center justify-center overflow-hidden rounded-xl">
              <img src={RiversideLogo} alt="Riverside Men's Shop" className="h-full w-auto object-contain" />
            </div>
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
              <Sparkles className="h-3.5 w-3.5" />
              Update Required
            </div>
          </div>
          <div className="space-y-5 px-8 py-7">
            <p className="text-sm font-bold text-app-text text-center leading-relaxed">
              The server has been updated to v{serverVersion}.
            </p>
            <p className="text-xs text-app-text-muted text-center leading-relaxed">
              This station is running v{CLIENT_SEMVER}. You must update this app before signing in to keep everything in sync.
            </p>
            {isTauri() ? (
              <>
                {appUpdateDone ? (
                  <p className="rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-center text-xs font-bold text-emerald-800">
                    Update installed — please relaunch Riverside.
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={appUpdateBusy}
                    onClick={async () => {
                      setAppUpdateBusy(true);
                      try {
                        const check = await checkForAppUpdate();
                        if (!check.available) {
                          toast("No update found in the updater channel. Ask your manager to update this station manually.", "error");
                          return;
                        }
                        await installAppUpdate();
                        setAppUpdateDone(true);
                      } catch (e) {
                        toast(String(e), "error");
                      } finally {
                        setAppUpdateBusy(false);
                      }
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-2xl bg-app-accent px-4 py-3 text-sm font-black text-white disabled:opacity-60"
                  >
                    {appUpdateBusy
                      ? <><RefreshCw className="h-4 w-4 animate-spin" />Updating...</>
                      : `Update to v${serverVersion}`
                    }
                  </button>
                )}
              </>
            ) : (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-xs font-semibold text-amber-800">
                Reload this page after the server admin has pushed the updated web files.
              </p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="w-full text-center text-xs text-app-text-muted underline"
            >
              Recheck after manual update
            </button>
          </div>
        </div>
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
          {tailscaleConnectionFailed && !error ? (
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs font-semibold text-indigo-800 space-y-1">
              <div className="flex items-center gap-1.5">
                <Wifi className="h-3.5 w-3.5 shrink-0" />
                <span>Cannot reach server over Tailscale.</span>
              </div>
              <p className="text-indigo-600 font-medium">Make sure the Tailscale app is running and connected on this device, then try again.</p>
            </div>
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
              <p className="text-[9px] text-app-text-muted mt-0.5">Select a known server or enter a custom IP / Tailscale address.</p>
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
              {/* Tailscale address saver */}
              <div className="border-t border-app-border/40 pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Wifi className="h-3 w-3 text-indigo-500" />
                    <span className="text-[9px] font-black uppercase tracking-widest text-indigo-600">Tailscale / Remote Address</span>
                  </div>
                  {!showTailscaleInput && (
                    <button
                      type="button"
                      onClick={() => { setShowTailscaleInput(true); setTempTailscaleUrl(savedTailscaleUrl); }}
                      className="text-[9px] font-black uppercase tracking-widest text-app-accent"
                    >
                      {savedTailscaleUrl ? "Edit" : "Set"}
                    </button>
                  )}
                </div>
                {savedTailscaleUrl && !showTailscaleInput && (
                  <p className="text-[10px] font-mono text-app-text-muted">{savedTailscaleUrl}</p>
                )}
                {!savedTailscaleUrl && !showTailscaleInput && (
                  <p className="text-[10px] text-app-text-muted leading-relaxed">
                    Save your store&apos;s Tailscale address here so it appears as a quick-pick when working remotely.
                    Tailscale must be installed and signed in on this device separately.
                  </p>
                )}
                {showTailscaleInput && (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={tempTailscaleUrl}
                      onChange={(e) => setTempTailscaleUrl(e.target.value)}
                      placeholder="https://your-server.ts.net:3000 or http://100.x.x.x:3000"
                      className="w-full bg-app-bg border border-indigo-300 rounded-xl px-4 py-2.5 text-xs font-mono text-app-text outline-none focus:border-indigo-500"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const url = normalizeApiBase(tempTailscaleUrl);
                          if (url) {
                            localStorage.setItem("ros_tailscale_url", url);
                            setSavedTailscaleUrl(url);
                          } else {
                            localStorage.removeItem("ros_tailscale_url");
                            setSavedTailscaleUrl("");
                          }
                          setShowTailscaleInput(false);
                        }}
                        className="ui-btn-primary h-8 flex-1 text-[10px] font-black"
                      >
                        Save
                      </button>
                      {savedTailscaleUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            localStorage.removeItem("ros_tailscale_url");
                            setSavedTailscaleUrl("");
                            setShowTailscaleInput(false);
                          }}
                          className="ui-btn-secondary h-8 flex-1 text-[10px] font-black"
                        >
                          Clear
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowTailscaleInput(false)}
                        className="ui-btn-secondary h-8 px-3 text-[10px] font-black"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
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
