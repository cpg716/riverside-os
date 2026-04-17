import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  useBackofficeAuth,
  type StaffRole,
} from "../../context/BackofficeAuthContextLogic";
import {
  clearPosRegisterAuth,
  getPosRegisterAuth,
  hasRegisterSessionPollCredentials,
  hydratePosRegisterAuthIfNeeded,
  mergedPosStaffHeaders,
  syncPosRegisterSessionId,
} from "../../lib/posRegisterAuth";
import type { SidebarTabId } from "./sidebarSections";
import RegisterPickModal, {
  type OpenRegisterOption,
} from "./RegisterPickModal";

const SESSION_CURRENT_FETCH_MS = 12_000;

async function fetchSessionCurrent(
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SESSION_CURRENT_FETCH_MS);
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

type CurrentSessionJson = {
  cashier_name: string;
  cashier_avatar_key?: string;
  cashier_code: string;
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  lifecycle_status: string;
  role: string;
  receipt_timezone?: string;
};

function isPosDeepLinkPath(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/pos";
}

/** After login: admin → Back Office; salesperson / sales_support → POS shell first. */
function applyShellForLoggedInRole(
  role: StaffRole | null,
  setActiveTab: (t: SidebarTabId) => void,
  setPosMode: (v: boolean) => void,
) {
  if (isPosDeepLinkPath()) {
    setActiveTab("register");
    setPosMode(true);
    return;
  }
  if (role === "admin") {
    setActiveTab("home");
    setPosMode(false);
    return;
  }
  if (role === "salesperson" || role === "sales_support") {
    setActiveTab("register");
    setPosMode(true);
    return;
  }
  setActiveTab("home");
  setPosMode(false);
}

export type RegisterSessionBootstrapProps = {
  baseUrl: string;
  toast: (message: string, variant?: "error" | "success" | "info") => void;
  setLoading: (v: boolean) => void;
  setCashierName: (v: string | null) => void;
  setCashierCode: (v: string | null) => void;
  setCashierAvatarKey: (v: string | null) => void;
  setSessionId: (v: string | null) => void;
  setRegisterLane: (v: number | null) => void;
  setRegisterOrdinal: (v: number | null) => void;
  setLifecycleStatus: (v: string | null) => void;
  setReceiptTimezone: (v: string) => void;
  setIsRegisterOpen: (v: boolean) => void;
  setActiveTab: (t: SidebarTabId) => void;
  setPosMode: (v: boolean) => void;
  metaRefreshRef: MutableRefObject<(() => Promise<void>) | null>;
};

/**
 * Hydrates register session using `mergedPosStaffHeaders(backofficeHeaders)` so polls match
 * in-app Back Office credentials (React state), not sessionStorage alone.
 */
export default function RegisterSessionBootstrap({
  baseUrl,
  toast,
  setLoading,
  setCashierName,
  setCashierCode,
  setCashierAvatarKey,
  setSessionId,
  setRegisterLane,
  setRegisterOrdinal,
  setLifecycleStatus,
  setReceiptTimezone,
  setIsRegisterOpen,
  setActiveTab,
  setPosMode,
  metaRefreshRef,
}: RegisterSessionBootstrapProps) {
  const {
    backofficeHeaders,
    staffCode,
    staffPin,
    staffRole,
    permissionsLoaded,
  } = useBackofficeAuth();

  const [registerPickSessions, setRegisterPickSessions] = useState<
    OpenRegisterOption[] | null
  >(null);

  /** Prevents {@link applyShellForLoggedInRole} from firing on every bootstrap re-run while the same register session stays open (would steal focus from QBO/Staff/etc. for admin). */
  const lastShellApplySessionIdRef = useRef<string | null>(null);

  /**
   * No open till (`/api/sessions/current` not OK, non-409) runs bootstrap whenever staff deps change.
   * Without this guard, each re-run calls {@link applyShellForLoggedInRole} and snaps admin back to Operations,
   * undoing navigation (e.g. Reports, Staff). Still apply when a session just closed or credentials/role change.
   */
  const lastNoSessionShellKeyRef = useRef<string | null>(null);
  const lastBootstrapDataRef = useRef<string | null>(null);

  const pollHeaders = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const fetchCurrentSession = useCallback(async (): Promise<Response> => {
    const path = `${baseUrl}/api/sessions/current`;
    let headers = pollHeaders();
    let res = await fetchSessionCurrent(path, headers);
    if (res.status === 401 && getPosRegisterAuth()) {
      clearPosRegisterAuth();
      headers = pollHeaders();
      if (hasRegisterSessionPollCredentials(headers)) {
        res = await fetchSessionCurrent(path, headers);
      }
    }
    return res;
  }, [baseUrl, pollHeaders]);

  const runMetaRefresh = useCallback(async () => {
    try {
      if (!hasRegisterSessionPollCredentials(pollHeaders())) return;
      const res = await fetchCurrentSession();
      if (!res.ok) return;
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        console.error(
          "Server returned non-JSON response from /api/sessions/current",
          res.status,
          contentType,
        );
        return;
      }
      const data = (await res.json()) as Pick<
        CurrentSessionJson,
        | "register_lane"
        | "register_ordinal"
        | "lifecycle_status"
        | "cashier_name"
        | "cashier_avatar_key"
        | "cashier_code"
        | "role"
        | "receipt_timezone"
      >;
      if (data.register_lane !== undefined) setRegisterLane(data.register_lane);
      if (data.register_ordinal !== undefined) setRegisterOrdinal(data.register_ordinal);
      if (data.lifecycle_status) setLifecycleStatus(data.lifecycle_status);
      if (data.cashier_name) setCashierName(data.cashier_name);
      if (data.cashier_code) setCashierCode(data.cashier_code);
      const ak =
        typeof data.cashier_avatar_key === "string" &&
          data.cashier_avatar_key.trim()
          ? data.cashier_avatar_key.trim()
          : "ros_default";
      setCashierAvatarKey(ak);
      const rz =
        typeof data.receipt_timezone === "string" &&
          data.receipt_timezone.trim()
          ? data.receipt_timezone.trim()
          : "America/New_York";
      setReceiptTimezone(rz);
    } catch {
      /* ignore */
    }
  }, [
    pollHeaders,
    fetchCurrentSession,
    setRegisterLane,
    setRegisterOrdinal,
    setLifecycleStatus,
    setCashierName,
    setCashierCode,
    setCashierAvatarKey,
    setReceiptTimezone,
  ]);

  useEffect(() => {
    metaRefreshRef.current = runMetaRefresh;
    return () => {
      metaRefreshRef.current = null;
    };
  }, [metaRefreshRef, runMetaRefresh]);

  const runBootstrap = useCallback(
    async (showLoadingGate: boolean) => {
      try {
        if (!hasRegisterSessionPollCredentials(pollHeaders())) {
          return;
        }
        if (!permissionsLoaded) {
          return;
        }
        const res = await fetchCurrentSession();
        if (res.ok) {
          setRegisterPickSessions(null);
          const contentType = res.headers.get("content-type");
          if (!contentType || !contentType.includes("application/json")) {
            console.error(
              "Server returned non-JSON response from /api/sessions/current",
              res.status,
              contentType,
            );
            return;
          }
          const data = (await res.json()) as CurrentSessionJson;
          const shouldApplyShell =
            lastShellApplySessionIdRef.current !== data.session_id;
          lastShellApplySessionIdRef.current = data.session_id;
          const dataStr = JSON.stringify(data);
          if (lastBootstrapDataRef.current === dataStr) {
            if (shouldApplyShell) {
              applyShellForLoggedInRole(staffRole, setActiveTab, setPosMode);
            }
            return;
          }
          lastBootstrapDataRef.current = dataStr;

          if (data.cashier_name) setCashierName(data.cashier_name);
          if (data.cashier_code) setCashierCode(data.cashier_code);
          const ak =
            typeof data.cashier_avatar_key === "string" &&
              data.cashier_avatar_key.trim()
              ? data.cashier_avatar_key.trim()
              : "ros_default";
          setCashierAvatarKey(ak);
          setSessionId(data.session_id);
          setRegisterLane(data.register_lane);
          setRegisterOrdinal(data.register_ordinal);
          setLifecycleStatus(data.lifecycle_status);
          const rz =
            typeof data.receipt_timezone === "string" &&
              data.receipt_timezone.trim()
              ? data.receipt_timezone.trim()
              : "America/New_York";
          setReceiptTimezone(rz);
          setIsRegisterOpen(true);
          syncPosRegisterSessionId(data.session_id);
          await hydratePosRegisterAuthIfNeeded({
            baseUrl,
            sessionId: data.session_id,
            authHeaders: pollHeaders(),
            openerCashierCode: staffCode,
            openerPin: staffPin,
          });
          if (shouldApplyShell)
            applyShellForLoggedInRole(staffRole, setActiveTab, setPosMode);
        } else if (res.status === 409) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            open_sessions?: OpenRegisterOption[];
          };
          if (
            body.error === "register_selection_required" &&
            Array.isArray(body.open_sessions) &&
            body.open_sessions.length > 0
          ) {
            setRegisterPickSessions(body.open_sessions);
          }
          lastBootstrapDataRef.current = null;
          lastShellApplySessionIdRef.current = null;
          setIsRegisterOpen(false);
          setSessionId(null);
          setRegisterLane(null);
          setRegisterOrdinal(null);
          setLifecycleStatus(null);
          setCashierName(null);
          setCashierCode(null);
          setCashierAvatarKey(null);
          setReceiptTimezone("America/New_York");
          applyShellForLoggedInRole(staffRole, setActiveTab, setPosMode);
        } else if (res.status >= 500 || res.status === 408) {
          // Transient server error: do NOT clear the session state. 
          // This prevents infinite flip-flop loops in the shell when the network/server is under pressure.
          return;
        } else {
          setRegisterPickSessions(null);
          const hadSession = lastShellApplySessionIdRef.current !== null;
          lastBootstrapDataRef.current = null;
          lastShellApplySessionIdRef.current = null;
          setIsRegisterOpen(false);
          setSessionId(null);
          setRegisterLane(null);
          setRegisterOrdinal(null);
          setLifecycleStatus(null);
          setCashierName(null);
          setCashierCode(null);
          setCashierAvatarKey(null);
          setReceiptTimezone("America/New_York");
          const noSessionKey = `${staffCode.trim()}|${staffPin.trim()}|${staffRole ?? ""}`;
          const shouldApplyNoSessionShell =
            hadSession || lastNoSessionShellKeyRef.current !== noSessionKey;
          if (shouldApplyNoSessionShell) {
            applyShellForLoggedInRole(staffRole, setActiveTab, setPosMode);
            lastNoSessionShellKeyRef.current = noSessionKey;
          }
        }
      } catch (err) {
        console.error("Failed to fetch session status", err);
        /* Do not call {@link applyShellForLoggedInRole} or clear the session ref here: transient errors
         * would snap admin users back to Operations while they are in QBO/Staff and make the shell feel "stuck". */
        if (import.meta.env.PROD) {
          toast(
            "Cannot reach the Riverside API. Check your network and API address in Settings (General).",
            "error",
          );
        }
      } finally {
        if (showLoadingGate) setLoading(false);
      }
    },
    [
      baseUrl,
      pollHeaders,
      permissionsLoaded,
      staffRole,
      staffCode,
      staffPin,
      fetchCurrentSession,
      setLoading,
      setCashierName,
      setCashierCode,
      setCashierAvatarKey,
      setSessionId,
      setRegisterLane,
      setRegisterOrdinal,
      setLifecycleStatus,
      setReceiptTimezone,
      setIsRegisterOpen,
      setActiveTab,
      setPosMode,
      toast,
    ],
  );

  const showInitialLoadingGateRef = useRef(true);

  useEffect(() => {
    const gate = showInitialLoadingGateRef.current;
    showInitialLoadingGateRef.current = false;
    void runBootstrap(gate);
  }, [
    baseUrl,
    staffCode,
    staffPin,
    staffRole,
    permissionsLoaded,
    runBootstrap,
  ]);

  useEffect(() => {
    const onBoSession = () => {
      void runBootstrap(false);
    };
    window.addEventListener("ros-backoffice-session-changed", onBoSession);
    return () =>
      window.removeEventListener("ros-backoffice-session-changed", onBoSession);
  }, [runBootstrap]);

  const onPickSuccess = useCallback(
    (data: CurrentSessionJson) => {
      setRegisterPickSessions(null);
      lastShellApplySessionIdRef.current = data.session_id;
      setCashierName(data.cashier_name);
      setCashierCode(data.cashier_code);
      setCashierAvatarKey(
        typeof data.cashier_avatar_key === "string" &&
          data.cashier_avatar_key.trim()
          ? data.cashier_avatar_key.trim()
          : "ros_default",
      );
      setSessionId(data.session_id);
      setRegisterLane(data.register_lane);
      setRegisterOrdinal(data.register_ordinal);
      setLifecycleStatus(data.lifecycle_status);
      setReceiptTimezone(
        typeof data.receipt_timezone === "string" &&
          data.receipt_timezone.trim()
          ? data.receipt_timezone.trim()
          : "America/New_York",
      );
      setIsRegisterOpen(true);
      syncPosRegisterSessionId(data.session_id);
      applyShellForLoggedInRole(staffRole, setActiveTab, setPosMode);
    },
    [
      staffRole,
      setCashierName,
      setCashierCode,
      setCashierAvatarKey,
      setSessionId,
      setRegisterLane,
      setRegisterOrdinal,
      setLifecycleStatus,
      setReceiptTimezone,
      setIsRegisterOpen,
      setActiveTab,
      setPosMode,
    ],
  );

  return (
    <>
      <RegisterPickModal
        open={Boolean(registerPickSessions && registerPickSessions.length > 0)}
        sessions={registerPickSessions ?? []}
        baseUrl={baseUrl}
        onDismiss={() => setRegisterPickSessions(null)}
        onSuccess={onPickSuccess}
      />
    </>
  );
}
