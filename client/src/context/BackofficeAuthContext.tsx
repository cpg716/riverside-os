import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

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

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
const STATION_KEY_STORAGE = "ros_station_key";

function getStableStationKey(): string {
  const existing = window.localStorage.getItem(STATION_KEY_STORAGE)?.trim();
  if (existing) return existing;
  const generated = (window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).toString();
  const value = `station-${generated}`;
  window.localStorage.setItem(STATION_KEY_STORAGE, value);
  return value;
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
  const [permissions, setPermissions] = useState<string[]>([]);
  const [permissionsLoaded, setPermissionsLoaded] = useState(false);
  const [staffDisplayName, setStaffDisplayName] = useState("");
  const [staffAvatarKey, setStaffAvatarKey] = useState("ros_default");
  const [staffId, setStaffId] = useState("");
  const [staffRole, setStaffRole] = useState<StaffRole | null>(null);
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const t = initialCode?.trim();
    if (!t) return;
    setStaffCode(t);
    const p = readPersistedBackofficeSession();
    if (p?.staffCode === t) {
      setStaffPin(p.staffPin);
    } else {
      setStaffPin("");
    }
  }, [initialCode]);

  const backofficeHeaders = useCallback((): HeadersInit => {
    const h: Record<string, string> = {};
    if (staffCode.trim()) {
      h["x-riverside-staff-code"] = staffCode.trim();
      if (staffPin.trim()) h["x-riverside-staff-pin"] = staffPin.trim();
    }
    return h;
  }, [staffCode, staffPin]);

  const refreshPermissions = useCallback(async () => {
    if (!staffCode.trim()) {
      setPermissions([]);
      setStaffDisplayName("");
      setStaffAvatarKey("ros_default");
      setStaffId("");
      setStaffRole(null);
      setEmployeeCustomerId(null);
      setPermissionsLoaded(true);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/staff/effective-permissions`, {
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
        staff_id?: string;
        id?: string;
        role?: unknown;
        employee_customer_id?: string | null;
      };
      setPermissions(Array.isArray(d.permissions) ? d.permissions : []);
      const n = typeof d.full_name === "string" ? d.full_name.trim() : "";
      setStaffDisplayName(n);
      const sid = typeof d.staff_id === "string" ? d.staff_id.trim() : (typeof d.id === "string" ? d.id.trim() : "");
      setStaffId(sid);
      const ak =
        typeof d.avatar_key === "string" && d.avatar_key.trim()
          ? d.avatar_key.trim()
          : "ros_default";
      setStaffAvatarKey(ak);
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
  }, [staffCode, staffPin, refreshPermissions]);

  useEffect(() => {
    if (!staffCode.trim() || !staffPin.trim()) return;

    const sendHeartbeat = async () => {
      try {
        await fetch(`${baseUrl}/api/ops/stations/heartbeat`, {
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
            meta: {
              user_agent: navigator.userAgent,
              platform: navigator.platform,
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
    return () => window.clearInterval(timer);
  }, [backofficeHeaders, staffCode, staffPin]);

  const setStaffCredentials = useCallback((code: string, pin: string) => {
    const c = code.trim();
    const p = pin.trim();
    setStaffCode(c);
    setStaffPin(p);
    writePersistedBackofficeSession(c, p);
  }, []);

  const adoptPermissionsFromServer = useCallback(
    (
      list: string[],
      nameFromServer?: string | null,
      avatarFromServer?: string | null,
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
    setStaffCode("");
    setStaffPin("");
    setPermissions([]);
    setStaffDisplayName("");
    setStaffAvatarKey("ros_default");
    setStaffId("");
    setStaffRole(null);
    setEmployeeCustomerId(null);
    clearPersistedBackofficeSession();
  }, []);

  const hasPermission = useCallback(
    (key: string) => permissions.includes(key),
    [permissions],
  );

  const value = useMemo(
    () => ({
      staffCode,
      staffPin,
      staffId,
      staffDisplayName,
      staffAvatarKey,
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
      staffId,
      staffDisplayName,
      staffAvatarKey,
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
