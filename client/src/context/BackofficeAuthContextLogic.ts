import { createContext, useContext } from "react";
import { readPersistedBackofficeSession } from "../lib/backofficeSessionPersistence";

/** From `GET /api/staff/effective-permissions` `role` (snake_case). */
export type StaffRole = "admin" | "salesperson" | "sales_support";

export function parseStaffRole(raw: unknown): StaffRole | null {
  if (raw === "admin" || raw === "salesperson" || raw === "sales_support") {
    return raw;
  }
  return null;
}

export function initialStaffCredentials(initialCode: string | null): {
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
  /** Internal staff UUID from `effective-permissions`. */
  staffId: string;
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
    idFromServer?: string | null,
  ) => void;
  backofficeHeaders: () => HeadersInit;
  hasPermission: (key: string) => boolean;
  refreshPermissions: () => Promise<void>;
  permissionsLoaded: boolean;
};

export const BackofficeAuthContext = createContext<BackofficeAuthContextValue | null>(
  null,
);

export function useBackofficeAuth(): BackofficeAuthContextValue {
  const c = useContext(BackofficeAuthContext);
  if (!c) {
    throw new Error("useBackofficeAuth must be used within BackofficeAuthProvider");
  }
  return c;
}
