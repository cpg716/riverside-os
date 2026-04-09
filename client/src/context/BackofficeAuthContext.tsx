import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  clearPersistedBackofficeSession,
  readPersistedBackofficeSession,
  writePersistedBackofficeSession,
} from "../lib/backofficeSessionPersistence";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

/** From `GET /api/staff/effective-permissions` `role` (snake_case). */
export type StaffRole = "admin" | "salesperson" | "sales_support";

function parseStaffRole(raw: unknown): StaffRole | null {
  if (raw === "admin" || raw === "salesperson" || raw === "sales_support") {
    return raw;
  }
  return null;
}

function initialStaffCredentials(initialCode: string | null): {
  staffCode: string;
  staffPin: string;
} {
  const reg = initialCode?.trim() ?? "";
  const p = readPersistedBackofficeSession();
  if (reg) {
    if (p && p.staffCode === reg) {
      return { staffCode: reg, staffPin: p.staffPin };
    }
    return { staffCode: reg, staffPin: "" };
  }
  if (p) {
    return { staffCode: p.staffCode, staffPin: p.staffPin };
  }
  return { staffCode: "", staffPin: "" };
}

export type BackofficeAuthContextValue = {
  staffCode: string;
  staffPin: string;
  /** Display name from the server (`full_name`) after a successful `effective-permissions` response; empty when unknown. */
  staffDisplayName: string;
  /** Bundled portrait key from `effective-permissions` (`avatar_key`). */
  staffAvatarKey: string;
  /** DB role from effective-permissions; null before load or without credentials. */
  staffRole: StaffRole | null;
  /** Linked CRM customer for employee-cost POS pricing (`staff.employee_customer_id`). */
  employeeCustomerId: string | null;
  permissions: string[];
  setStaffCredentials: (code: string, pin: string) => void;
  clearStaffCredentials: () => void;
  /** Apply a permissions list from a successful sign-in or server response (avoids a blank flash if the follow-up refresh fails transiently). */
  adoptPermissionsFromServer: (
    permissions: string[],
    staffDisplayName?: string | null,
    staffAvatarKey?: string | null,
    staffRole?: StaffRole | null,
  ) => void;
  backofficeHeaders: () => HeadersInit;
  hasPermission: (key: string) => boolean;
  refreshPermissions: () => Promise<void>;
  permissionsLoaded: boolean;
};

const BackofficeAuthContext = createContext<BackofficeAuthContextValue | null>(
  null,
);

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
  }, [staffCode, staffPin, backofficeHeaders]);

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

export function useBackofficeAuth(): BackofficeAuthContextValue {
  const c = useContext(BackofficeAuthContext);
  if (!c) {
    throw new Error("useBackofficeAuth must be used within BackofficeAuthProvider");
  }
  return c;
}

/** Sidebar tab → minimum permission (omit = always visible in Back Office shell). */
export const SIDEBAR_TAB_PERMISSION: Partial<Record<string, string>> = {
  reports: "insights.view",
  dashboard: "insights.view",
  staff: "staff.view",
  qbo: "qbo.view",
  orders: "orders.view",
  weddings: "weddings.view",
  alterations: "alterations.manage",
  "gift-cards": "gift_cards.manage",
  appointments: "weddings.view",
};

/** Tab is visible if the user has any of these permissions (see Loyalty: program vs adjust). */
export const SIDEBAR_TAB_PERMISSIONS_ANY: Record<string, string[]> = {
  loyalty: ["loyalty.program_settings", "loyalty.adjust_points"],
  settings: ["settings.admin", "staff.manage_access"],
};

/** `${tabId}:${subSectionId}` → extra permission beyond the tab (omit = allowed if tab is allowed). */
export const SIDEBAR_SUB_SECTION_PERMISSION: Record<string, string> = {
  "inventory:physical": "physical_inventory.view",
  "staff:team": "staff.view",
  "staff:schedule": "staff.view",
  "staff:commission": "staff.manage_commission",
  "staff:audit": "staff.view_audit",
  "staff:tasks": "tasks.complete",
  "loyalty:adjust": "loyalty.adjust_points",
  "loyalty:eligible": "loyalty.program_settings",
  "loyalty:settings": "loyalty.program_settings",
  "customers:duplicate-review": "customers_duplicate_review",
  "home:register-reports": "register.reports",
  "home:inbox": "customers.hub_view",
  "customers:rms-charge": "customers.rms_charge",
  "customers:ship": "shipments.view",
  "settings:help-center": "help.manage",
  "settings:bug-reports": "settings.admin",
  "home:reviews": "reviews.view",
};

/** Subsection requires every listed permission (AND). */
export const SIDEBAR_SUB_SECTION_PERMISSIONS_ALL: Record<string, string[]> = {
  "staff:commission-payouts": ["insights.view", "insights.commission_finalize"],
};

/** Subsection visible if any listed permission is held (OR). */
export const SIDEBAR_SUB_SECTION_PERMISSIONS_ANY: Record<string, string[]> = {
  "settings:staff-access-defaults": ["settings.admin", "staff.manage_access"],
};

export function subSectionPermissionKey(
  tabId: string,
  subId: string,
): string | undefined {
  return SIDEBAR_SUB_SECTION_PERMISSION[`${tabId}:${subId}`];
}

/** Sidebar subsection visibility: single extra permission or all of `PERMISSIONS_ALL`. */
export function subSectionVisible(
  tabId: string,
  subId: string,
  hasPermission: (key: string) => boolean,
  permissionsLoaded: boolean,
): boolean {
  if (!permissionsLoaded) return true;
  const anySubs = SIDEBAR_SUB_SECTION_PERMISSIONS_ANY[`${tabId}:${subId}`];
  if (anySubs?.length) return anySubs.some((k) => hasPermission(k));
  const all = SIDEBAR_SUB_SECTION_PERMISSIONS_ALL[`${tabId}:${subId}`];
  if (all?.length) return all.every((k) => hasPermission(k));
  const one = SIDEBAR_SUB_SECTION_PERMISSION[`${tabId}:${subId}`];
  if (one) return hasPermission(one);
  return true;
}
