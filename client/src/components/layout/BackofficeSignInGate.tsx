import { useEffect, useState, type ReactNode } from "react";
import { Shield } from "lucide-react";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContext";
import { useToast } from "../ui/ToastProvider";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";

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

  useEffect(() => {
    if (!permissionsLoaded || !staffCode.trim()) return;
    if (permissions.length > 0) return;
    clearStaffCredentials();
  }, [permissionsLoaded, staffCode, permissions.length, clearStaffCredentials]);

  const hasStaffCode = staffCode.trim().length > 0;

  const trySignIn = async () => {
    const code = credential.trim();
    if (code.length !== 4) {
      setError("Enter your 4-digit staff code.");
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
        throw new Error(b.error ?? "Invalid code or not authorized");
      }
      const data = (await res.json()) as {
        permissions?: string[];
        full_name?: string;
        avatar_key?: string;
        role?: string;
      };
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
      setCredential("");
      toast("Signed in to Back Office.", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sign-in failed";
      setError(msg);
      toast(msg, "error");
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-app-bg p-6 font-sans antialiased">
      <div className="w-full max-w-md overflow-hidden rounded-[32px] border border-app-border/40 bg-app-surface shadow-2xl">
        <div className="border-b border-app-border bg-app-surface-2 px-8 py-10 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-surface))] text-[var(--app-accent)]">
            <Shield className="h-8 w-8" aria-hidden />
          </div>
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
            Riverside OS
          </p>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-app-text">
            Sign in to Riverside OS
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-app-text-muted">
            Enter your 4-digit staff code. Admins land in Back Office; sales staff
            land in the register workspace (open the till when you are ready to
            check out). You can switch modes from the sidebar anytime after sign-in.
          </p>
        </div>
        <div className="space-y-5 px-8 py-8">
          {error ? (
            <p className="rounded-2xl border border-app-danger/20 bg-app-danger/5 px-4 py-3 text-center text-xs font-bold text-app-danger">
              {error}
            </p>
          ) : null}
          <div className="space-y-2">
            <p className="text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Staff code
            </p>
            <PinDots length={credential.length} className="py-1" />
            <NumericPinKeypad
              value={credential}
              onChange={(v) => {
                setError(null);
                setCredential(v);
              }}
              disabled={busy}
            />
          </div>
          <button
            type="button"
            disabled={busy || credential.length !== 4}
            onClick={() => void trySignIn()}
            className="ui-btn-primary h-14 w-full text-sm font-black disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
