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

import {
  BackofficeAuthContext,
  initialStaffCredentials,
  parseStaffRole,
  type StaffRole,
} from "./BackofficeAuthContextLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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
  const [staffRole, setStaffRole] = useState<StaffRole | null>(null);
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(null);

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
    const h: Record<string, string> = {
      "x-riverside-staff-code": staffCode.trim(),
    };
    if (staffPin.trim()) h["x-riverside-staff-pin"] = staffPin.trim();
    return h;
  }, [staffCode, staffPin]);

  const refreshPermissions = useCallback(async () => {
    if (!staffCode.trim()) {
      setPermissions([]);
      setStaffDisplayName("");
      setStaffAvatarKey("ros_default");
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
          setStaffRole(null);
          setEmployeeCustomerId(null);
        }
        return;
      }
      const d = (await res.json()) as {
        permissions?: string[];
        full_name?: string;
        avatar_key?: string;
        role?: unknown;
        employee_customer_id?: string | null;
      };
      setPermissions(Array.isArray(d.permissions) ? d.permissions : []);
      const n = typeof d.full_name === "string" ? d.full_name.trim() : "";
      setStaffDisplayName(n);
      const ak =
        typeof d.avatar_key === "string" && d.avatar_key.trim()
          ? d.avatar_key.trim()
          : "ros_default";
      setStaffAvatarKey(ak);
      setStaffRole(parseStaffRole(d.role));
      const ec =
        typeof d.employee_customer_id === "string" && d.employee_customer_id.trim()
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

