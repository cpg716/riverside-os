import { getBaseUrl } from "../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { isTauri } from "@tauri-apps/api/core";

import {
  clearPersistedBackofficeSession,
  writePersistedBackofficeSession,
  readPersistedBackofficeSession,
} from "../lib/backofficeSessionPersistence";
import { CLIENT_SEMVER, GIT_SHORT } from "../clientBuildMeta";

import {
  BackofficeAuthContext,
  initialStaffCredentials,
  parseStaffRole,
  type StaffRole,
} from "./BackofficeAuthContextLogic";
import { getConnectionKey, getStableStationKey } from "../lib/stationIdentity";
import { readAppUpdateTelemetry } from "../lib/appUpdater";

function stationRuntimeMeta() {
  const tauri = isTauri();
  const standalonePwa =
    !tauri &&
    (window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true);
  return {
    runtime_surface: tauri
      ? "tauri_desktop"
      : standalonePwa
        ? "pwa_standalone"
        : "browser_tab",
    monitor_offline: tauri || standalonePwa,
  };
}

export function BackofficeAuthProvider({
  children,
  initialCode,
}: {
  children: ReactNode;
  initialCode: string | null;
}) {
  const [staffCode, setStaffCode] = useState(() => {
    const init = initialStaffCredentials(initialCode);
    return init.staffCode;
  });
  const [staffPin, setStaffPin] = useState(() => {
    const init = initialStaffCredentials(initialCode);
    return init.staffPin;
  });
  const [staffSessionToken, setStaffSessionToken] = useState(() => {
    const init = initialStaffCredentials(initialCode);
    return init.staffSessionToken;
  });
  const [staffSessionExpiresAt, setStaffSessionExpiresAt] = useState(() => {
    const init = initialStaffCredentials(initialCode);
    return init.staffSessionExpiresAt;
  });
  const [permissions, setPermissions] = useState<string[]>([]);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [staffDisplayName, setStaffDisplayName] = useState("");
  const [staffAvatarKey, setStaffAvatarKey] = useState("ros_default");
  const [staffAvatarPhotoUrl, setStaffAvatarPhotoUrl] = useState<string | null>(
    null,
  );
  const [staffId, setStaffId] = useState("");
  const [staffRole, setStaffRole] = useState<StaffRole | null>(null);
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const t = initialCode?.trim();
    if (!t) return;
    const p = readPersistedBackofficeSession();
    if (p) {
      setStaffCode(p.staffCode);
      setStaffPin("");
      setStaffSessionToken(p.sessionToken);
      setStaffSessionExpiresAt(p.sessionExpiresAt);
    } else {
      setStaffCode(t);
      setStaffPin("");
      setStaffSessionToken("");
      setStaffSessionExpiresAt("");
    }
  }, [initialCode]);

  const backofficeHeaders = useCallback((): HeadersInit => {
    const h: Record<string, string> = {};
    if (staffCode.trim()) {
      h["x-riverside-staff-code"] = staffCode.trim();
      if (staffSessionToken.trim()) {
        h["x-riverside-staff-session"] = staffSessionToken.trim();
        h["x-riverside-station-key"] = getStableStationKey();
        h["x-riverside-connection-key"] = getConnectionKey();
      } else if (staffPin.trim()) {
        h["x-riverside-staff-pin"] = staffPin.trim();
      }
    }
    return h;
  }, [staffCode, staffPin, staffSessionToken]);

  const refreshPermissions = useCallback(async () => {
    if (!staffCode.trim()) {
      setPermissions([]);
      setStaffDisplayName("");
      setStaffAvatarKey("ros_default");
      setStaffAvatarPhotoUrl(null);
      setStaffId("");
      setStaffRole(null);
      setEmployeeCustomerId(null);
      setPermissionsLoaded(true);
      return;
    }
    try {
      const res = await fetch(`${getBaseUrl()}/api/staff/effective-permissions`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setPermissions([]);
          setStaffDisplayName("");
          setStaffAvatarKey("ros_default");
          setStaffId("");
          setStaffRole(null);
          setEmployeeCustomerId(null);
        }
        return;
      }
      const d = (await res.json()) as {
        permissions?: string[];
        full_name?: string;
        avatar_key?: string;
        avatar_photo_url?: string | null;
        staff_id?: string;
        id?: string;
        role?: unknown;
        employee_customer_id?: string | null;
      };
      setPermissions(Array.isArray(d.permissions) ? d.permissions : []);
      const n = typeof d.full_name === "string" ? d.full_name.trim() : "";
      setStaffDisplayName(n);
      const sid =
        typeof d.staff_id === "string"
          ? d.staff_id.trim()
          : typeof d.id === "string"
            ? d.id.trim()
            : "";
      setStaffId(sid);
      const ak =
        typeof d.avatar_key === "string" && d.avatar_key.trim()
          ? d.avatar_key.trim()
          : "ros_default";
      setStaffAvatarKey(ak);
      setStaffAvatarPhotoUrl(d.avatar_photo_url ?? null);
      setStaffRole(parseStaffRole(d.role));
      const ec =
        typeof d.employee_customer_id === "string" &&
        d.employee_customer_id.trim()
          ? d.employee_customer_id.trim()
          : null;
      setEmployeeCustomerId(ec);
    } catch {
      /* Keep existing permissions — do not wipe a valid session on transient network errors. */
    } finally {
      setPermissionsLoaded(true);
    }
  }, [staffCode, backofficeHeaders]);

  useEffect(() => {
    setPermissionsLoaded(false);
    void refreshPermissions();
  }, [staffCode, staffPin, staffSessionToken, refreshPermissions]);

  useEffect(() => {
    if (!staffCode.trim() || (!staffSessionToken.trim() && !staffPin.trim())) return;

    const sendHeartbeat = async () => {
      try {
        const updateTelemetry = await readAppUpdateTelemetry();
        await fetch(`${getBaseUrl()}/api/ops/stations/heartbeat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({
            station_key: getStableStationKey(),
            station_label: window.location.hostname || "Riverside Station",
            app_version: CLIENT_SEMVER,
            git_sha: GIT_SHORT || null,
            tailscale_node: null,
            lan_ip: null,
            last_update_check_at: updateTelemetry.lastUpdateCheckAt,
            last_update_install_at: updateTelemetry.lastUpdateInstallAt,
            meta: {
              ...stationRuntimeMeta(),
              user_agent: navigator.userAgent,
              platform: navigator.platform,
              app_update_install_observation: {
                status: updateTelemetry.installObservationStatus,
                pending_target_version: updateTelemetry.pendingTargetVersion,
                pending_target_build: updateTelemetry.pendingTargetBuild,
                pending_started_at: updateTelemetry.pendingStartedAt,
                last_failure_at: updateTelemetry.lastFailureAt,
                last_failure_reason: updateTelemetry.lastFailureReason,
              },
            },
          }),
        });
      } catch {
        // Ignore transient failures; heartbeat should not affect staff session behavior.
      }
    };

    void sendHeartbeat();
    const timer = window.setInterval(() => {
      void sendHeartbeat();
    }, 60_000);
    const sendAfterReconnect = () => void sendHeartbeat();
    const sendWhenVisible = () => {
      if (document.visibilityState === "visible") void sendHeartbeat();
    };
    window.addEventListener("online", sendAfterReconnect);
    document.addEventListener("visibilitychange", sendWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", sendAfterReconnect);
      document.removeEventListener("visibilitychange", sendWhenVisible);
    };
  }, [backofficeHeaders, staffCode, staffPin, staffSessionToken]);

  const setStaffCredentials = useCallback(
    (code: string, pin: string, sessionToken: string, sessionExpiresAt: string) => {
      const c = code.trim();
      const p = pin.trim();
      const token = sessionToken.trim();
      const expiresAt = sessionExpiresAt.trim();
      setStaffCode(c);
      setStaffPin(p);
      setStaffSessionToken(token);
      setStaffSessionExpiresAt(expiresAt);
      writePersistedBackofficeSession(c, token, expiresAt);
    },
    [],
  );

  const adoptPermissionsFromServer = useCallback(
    (
      list: string[],
      nameFromServer?: string | null,
      avatarFromServer?: string | null,
      avatarPhotoFromServer?: string | null,
      roleFromServer?: StaffRole | null,
      idFromServer?: string | null,
    ) => {
      setPermissions(Array.isArray(list) ? list : []);
      if (nameFromServer != null) {
        setStaffDisplayName(nameFromServer.trim());
      }
      if (avatarFromServer != null) {
        const a = avatarFromServer.trim();
        setStaffAvatarKey(a || "ros_default");
      }
      if (avatarPhotoFromServer !== undefined) {
        setStaffAvatarPhotoUrl(avatarPhotoFromServer);
      }
      if (roleFromServer !== undefined) {
        setStaffRole(roleFromServer);
      }
      if (idFromServer != null) {
        setStaffId(idFromServer.trim());
      }
      setPermissionsLoaded(true);
    },
    [],
  );

  const clearStaffCredentials = useCallback(() => {
    const sessionHeaders = backofficeHeaders();
    if (staffSessionToken.trim()) {
      void fetch(`${getBaseUrl()}/api/staff/session`, {
        method: "DELETE",
        headers: sessionHeaders,
        keepalive: true,
      }).catch(() => undefined);
    }
    setStaffCode("");
    setStaffPin("");
    setStaffSessionToken("");
    setStaffSessionExpiresAt("");
    setPermissions([]);
    setStaffDisplayName("");
    setStaffAvatarKey("ros_default");
    setStaffAvatarPhotoUrl(null);
    setStaffId("");
    setStaffRole(null);
    setEmployeeCustomerId(null);
    clearPersistedBackofficeSession();
  }, [backofficeHeaders, staffSessionToken]);

  useEffect(() => {
    if (!staffSessionExpiresAt) return;
    const expiresAt = Date.parse(staffSessionExpiresAt);
    if (!Number.isFinite(expiresAt)) {
      clearStaffCredentials();
      return;
    }
    let timer = 0;
    const scheduleExpiryCheck = () => {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        clearStaffCredentials();
        return;
      }
      timer = window.setTimeout(
        scheduleExpiryCheck,
        Math.min(remainingMs, 2_147_000_000),
      );
    };
    scheduleExpiryCheck();
    return () => window.clearTimeout(timer);
  }, [clearStaffCredentials, staffSessionExpiresAt]);

  const hasPermission = useCallback(
    (key: string) => permissions.includes(key),
    [permissions],
  );

  const value = useMemo(
    () => ({
      staffCode,
      staffPin,
      staffSessionToken,
      staffSessionExpiresAt,
      staffId,
      staffDisplayName,
      staffAvatarKey,
      staffAvatarPhotoUrl,
      staffRole,
      employeeCustomerId,
      permissions,
      setStaffCredentials,
      clearStaffCredentials,
      adoptPermissionsFromServer,
      backofficeHeaders,
      hasPermission,
      refreshPermissions,
      permissionsLoaded,
    }),
    [
      staffCode,
      staffPin,
      staffSessionToken,
      staffSessionExpiresAt,
      staffId,
      staffDisplayName,
      staffAvatarKey,
      staffAvatarPhotoUrl,
      staffRole,
      employeeCustomerId,
      permissions,
      setStaffCredentials,
      clearStaffCredentials,
      adoptPermissionsFromServer,
      backofficeHeaders,
      hasPermission,
      refreshPermissions,
      permissionsLoaded,
    ],
  );

  return (
    <BackofficeAuthContext.Provider value={value}>
      {children}
    </BackofficeAuthContext.Provider>
  );
}
