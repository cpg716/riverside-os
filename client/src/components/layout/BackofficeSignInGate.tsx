import { useEffect, useState, type ReactNode } from "react";
import { Shield } from "lucide-react";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffMiniSelector from "../ui/StaffMiniSelector";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          setRoster(data);
        }
      } catch (e) {
        console.error("Could not load roster", e);
      }
    })();
  }, []);

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
    if (code.length !== 4) {
      setError("Enter 4-digit PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/effective-permissions`, {
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
          ? data.role
          : null;
      adoptPermissionsFromServer(list, display, avatar || null, roleParsed);

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
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-surface))] text-[var(--app-accent)]">
            <Shield className="h-6 w-6" aria-hidden />
          </div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Riverside OS
          </p>
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
              disabled={busy || credential.length !== 4}
              onClick={() => void trySignIn()}
              className="ui-btn-primary h-14 flex-[2] text-sm font-black disabled:opacity-50"
            >
              {busy ? "…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
