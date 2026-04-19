import { useEffect, useState, useMemo, type ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffMiniSelector from "../ui/StaffMiniSelector";
import RiversideLogo from "../../assets/images/riverside_logo.jpg";

const DEFAULT_BASE_URL = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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

  const isTailscaleRemote = useMemo(() => {
    if (typeof window === "undefined") return false;
    const h = window.location.hostname;
    return h.startsWith("100.") || h.endsWith(".tailscale.net") || h.endsWith(".ts.net");
  }, []);

  const saveServerUrl = () => {
    let url = tempUrl.trim();
    if (url && !url.startsWith("http")) {
      url = `http://${url}`;
    }
    if (url && url.endsWith("/")) {
      url = url.slice(0, -1);
    }
    
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
    void (async () => {
      try {
        const res = await fetch(`${serverUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          setRoster(data);
        }
      } catch (e) {
        console.error("Could not load roster", e);
      }
    })();
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
      const roleParsed: StaffRole | null =
        data.role === "admin" ||
        data.role === "salesperson" ||
        data.role === "sales_support"
          ? (data.role as StaffRole)
          : null;
      adoptPermissionsFromServer(list, display, avatar || null, roleParsed, data.id || data.staff_id);

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

      {/* Manual Server Connection Overlay */}
      <div className="mt-8">
        <button
          onClick={() => setShowServerSetup(true)}
          className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
        >
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Server Settings
        </button>
      </div>

      {showServerSetup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-6">
          <div className="w-full max-w-sm rounded-3xl bg-app-surface border border-app-border shadow-2xl p-8 space-y-6">
            <div className="text-center space-y-2">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Server Configuration</h3>
              <p className="text-[10px] font-medium text-app-text-muted">Point this register to your Main Server PC's IP address.</p>
            </div>
            <div className="space-y-2">
              <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">API Base URL</label>
              <input
                type="text"
                value={tempUrl}
                onChange={(e) => setTempUrl(e.target.value)}
                placeholder="http://192.168.1.XX:3000"
                className="w-full bg-app-bg border border-app-border rounded-xl px-4 py-3 text-xs font-mono text-app-text outline-none focus:border-app-accent"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowServerSetup(false)}
                className="ui-btn-secondary h-12 flex-1 text-xs font-black"
              >
                Cancel
              </button>
              <button
                onClick={saveServerUrl}
                className="ui-btn-primary h-12 flex-1 text-xs font-black"
              >
                Save & Connect
              </button>
            </div>
            <button 
              onClick={() => setTempUrl(DEFAULT_BASE_URL)}
              className="w-full text-[9px] font-black uppercase tracking-widest text-app-text-muted/60 hover:text-app-text transition-all"
            >
              Reset to Localhost
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
