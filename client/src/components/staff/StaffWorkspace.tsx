import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CircleDollarSign,
  ClipboardList,
  LayoutGrid,
  ListChecks,
  Percent,
  Search,
  Shield,
} from "lucide-react";
import CommissionPayoutsPanel from "./CommissionPayoutsPanel";
import StaffTasksPanel from "./StaffTasksPanel";
import StaffSchedulePanel from "./StaffSchedulePanel";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { STAFF_PERMISSION_CATALOG } from "../../lib/staffPermissions";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import StaffAvatarPicker from "./StaffAvatarPicker";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import CustomerSearchInput from "../ui/CustomerSearchInput";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type StaffRole = "admin" | "salesperson" | "sales_support";

interface HubRow {
  id: string;
  full_name: string;
  cashier_code: string;
  role: StaffRole;
  is_active: boolean;
  base_commission_rate: string | number;
  has_pin: boolean;
  sales_mtd: string | number | null;
  phone?: string | null;
  email?: string | null;
  avatar_key: string;
  max_discount_percent: string | number;
  employment_start_date?: string | null;
  employment_end_date?: string | null;
  employee_customer_id?: string | null;
  employee_customer_code?: string | null;
}

interface CategoryCommissionRow {
  category_id: string;
  category_name: string;
  commission_rate: string | number;
}

/** USD display — `parseFloat` here is only a finite-string guard before `parseMoneyToCents`. */
function money(n: string | number | null | undefined): string {
  if (n == null) return "—";
  const s = String(n).trim();
  if (!s) return "—";
  if (!Number.isFinite(Number.parseFloat(s))) return "—";
  return formatUsdFromCents(parseMoneyToCents(n));
}

/** Commission rate stored as 0–1 decimal → percent label for the grid (not currency). */
function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

/** Cashier-entered percent string → 0–1 decimal for PATCH payloads (not currency). */
function decimalFromPctInput(s: string): number | null {
  const t = s.trim().replace(/%/g, "");
  const v = Number.parseFloat(t);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v / 100;
}

interface StaffWorkspaceProps {
  activeSection?: string;
  tasksFocusInstanceId?: string | null;
  onTasksFocusConsumed?: () => void;
}

type StaffTab = "team" | "tasks" | "schedule" | "commission" | "commission-payouts" | "audit";

export default function StaffWorkspace({
  activeSection,
  tasksFocusInstanceId,
  onTasksFocusConsumed,
}: StaffWorkspaceProps) {
  const {
    backofficeHeaders,
    setStaffCredentials,
    clearStaffCredentials,
    staffCode: ctxStaffCode,
    hasPermission,
    permissionsLoaded,
  } = useBackofficeAuth();

  const [gateCredential, setGateCredential] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);

  const [tab, setTab] = useState<StaffTab>("team");

  useEffect(() => {
    const t = ctxStaffCode.trim();
    if (t.length === 4)
      setGateCredential((prev) => (prev.trim().length === 4 ? prev : t));
  }, [ctxStaffCode]);

  const canStaffHub = hasPermission("staff.view");

  useEffect(() => {
    if (unlocked) return;
    if (!permissionsLoaded) return;
    if (!canStaffHub) return;
    const code = ctxStaffCode.trim();
    if (!code) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/admin/roster`, {
          headers: backofficeHeaders(),
        });
        if (cancelled) return;
        if (res.ok) {
          const rows = (await res.json()) as HubRow[];
          setRoster(Array.isArray(rows) ? rows : []);
          setUnlocked(true);
          if (code.length === 4) setGateCredential(code);
        }
      } catch {
        /* remain on unlock gate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    unlocked,
    permissionsLoaded,
    canStaffHub,
    ctxStaffCode,
    backofficeHeaders,
  ]);

  // Sync sidebar sub-section to internal tab.
  useEffect(() => {
    if (
      activeSection === "team" ||
      activeSection === "tasks" ||
      activeSection === "schedule" ||
      activeSection === "commission" ||
      activeSection === "commission-payouts" ||
      activeSection === "audit"
    ) {
      setTab(activeSection as StaffTab);
    }
  }, [activeSection]);
  const [roster, setRoster] = useState<HubRow[]>([]);
  const [categories, setCategories] = useState<CategoryCommissionRow[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [auditSearchInput, setAuditSearchInput] = useState("");

  const [editRow, setEditRow] = useState<HubRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [editRole, setEditRole] = useState<StaffRole>("salesperson");
  const [editActive, setEditActive] = useState(true);
  const [editBasePct, setEditBasePct] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editAvatarKey, setEditAvatarKey] = useState("ros_default");
  const [editMaxDiscountPct, setEditMaxDiscountPct] = useState("");
  const [editEmploymentStart, setEditEmploymentStart] = useState("");
  const [editEmploymentEnd, setEditEmploymentEnd] = useState("");
  const [editEmployeeCustomerId, setEditEmployeeCustomerId] = useState<string | null>(null);
  const [editDetachEmployeeCustomer, setEditDetachEmployeeCustomer] = useState(false);
  const [editCustomerCodeLookup, setEditCustomerCodeLookup] = useState("");
  const [editNewPin, setEditNewPin] = useState("");
  const [profileGranted, setProfileGranted] = useState<string[]>([]);
  const [profilePermLoading, setProfilePermLoading] = useState(false);

  const staffEditOpen = editRow !== null;
  useShellBackdropLayer(staffEditOpen);
  const { dialogRef: staffEditDialogRef, titleId: staffEditTitleId } = useDialogAccessibility(staffEditOpen, {
    onEscape: () => setEditRow(null),
    closeOnEscape: !busy,
  });

  interface AccessLogRow {
    id: string;
    staff_id: string;
    staff_name: string;
    staff_avatar_key: string;
    event_kind: string;
    metadata: Record<string, unknown>;
    created_at: string;
  }
  const [accessLog, setAccessLog] = useState<AccessLogRow[]>([]);
  const [accessLogLoading, setAccessLogLoading] = useState(false);

  const tryUnlock = async () => {
    setGateError(null);
    setBusy(true);
    try {
      const code = gateCredential.trim();
      if (code.length !== 4) {
        setGateError("Enter your 4-digit staff code.");
        return;
      }
      const res = await fetch(`${baseUrl}/api/staff/admin/roster`, {
        headers: {
          "x-riverside-staff-code": code,
          "x-riverside-staff-pin": code,
        },
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Access denied");
      }
      const rows = (await res.json()) as HubRow[];
      setStaffCredentials(code, code);
      setRoster(Array.isArray(rows) ? rows : []);
      setUnlocked(true);
    } catch (e) {
      setGateError(e instanceof Error ? e.message : "Unlock failed");
    } finally {
      setBusy(false);
    }
  };

  const refreshRoster = useCallback(async () => {
    if (!unlocked) return;
    setLoadErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/roster`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load roster");
      const rows = (await res.json()) as HubRow[];
      setRoster(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Load failed");
    }
  }, [unlocked, backofficeHeaders]);

  const refreshCategories = useCallback(async () => {
    if (!unlocked) return;
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/category-commissions`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load categories");
      const rows = (await res.json()) as CategoryCommissionRow[];
      setCategories(Array.isArray(rows) ? rows : []);
    } catch {
      setCategories([]);
    }
  }, [unlocked, backofficeHeaders]);

  const refreshAccessLog = useCallback(async () => {
    if (!unlocked) return;
    setAccessLogLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/access-log?limit=400`,
        { headers: backofficeHeaders() },
      );
      if (!res.ok) throw new Error("Could not load audit log");
      const rows = (await res.json()) as AccessLogRow[];
      setAccessLog(Array.isArray(rows) ? rows : []);
    } catch {
      setAccessLog([]);
    } finally {
      setAccessLogLoading(false);
    }
  }, [unlocked, backofficeHeaders]);

  useEffect(() => {
    if (!unlocked) return;
    void refreshRoster();
    void refreshCategories();
  }, [unlocked, refreshRoster, refreshCategories]);

  useEffect(() => {
    if (!unlocked || tab !== "audit") return;
    void refreshAccessLog();
  }, [unlocked, tab, refreshAccessLog]);

  const loadStaffProfilePermissions = useCallback(
    async (staffId: string, role: StaffRole) => {
      if (role === "admin") {
        setProfileGranted([]);
        return;
      }
      setProfilePermLoading(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}/permissions`,
          { headers: backofficeHeaders() },
        );
        if (!res.ok) throw new Error("Could not load permissions");
        const d = (await res.json()) as { granted?: string[] };
        setProfileGranted(Array.isArray(d.granted) ? [...d.granted] : []);
      } catch {
        setProfileGranted([]);
      } finally {
        setProfilePermLoading(false);
      }
    },
    [backofficeHeaders],
  );

  const toggleProfilePermission = (key: string) => {
    setProfileGranted((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const applyRoleDefaultsForProfile = async () => {
    if (!editRow) return;
    if (editRow.role === "admin") return;
    setBusy(true);
    setLoadErr(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(editRow.id)}/apply-role-defaults`,
        { method: "POST", headers: { ...backofficeHeaders() } },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Apply defaults failed");
      }
      await loadStaffProfilePermissions(editRow.id, editRow.role);
      await refreshRoster();
      const rRes = await fetch(`${baseUrl}/api/staff/admin/roster`, {
        headers: backofficeHeaders(),
      });
      if (rRes.ok) {
        const rows = (await rRes.json()) as HubRow[];
        const hit = Array.isArray(rows) ? rows.find((x) => x.id === editRow.id) : undefined;
        if (hit) {
          setEditMaxDiscountPct(String(hit.max_discount_percent ?? "30"));
        }
      }
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Apply defaults failed");
    } finally {
      setBusy(false);
    }
  };

  const linkCustomerByCode = async () => {
    const code = editCustomerCodeLookup.trim();
    if (!code) {
      setLoadErr("Enter a customer code to link.");
      return;
    }
    setBusy(true);
    setLoadErr(null);
    try {
      const u = new URL(`${baseUrl}/api/customers/browse`);
      u.searchParams.set("q", code);
      u.searchParams.set("limit", "20");
      u.searchParams.set("offset", "0");
      const res = await fetch(u.toString(), { headers: backofficeHeaders() });
      if (!res.ok) throw new Error("Customer search failed");
      const rows = (await res.json()) as { customer_code?: string; id?: string }[];
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("No customer matched that search.");
      }
      const exact =
        rows.find((r) => String(r.customer_code ?? "").trim().toUpperCase() === code.toUpperCase()) ??
        rows[0];
      if (!exact?.id) throw new Error("Could not resolve customer.");
      setEditEmployeeCustomerId(exact.id);
      setEditDetachEmployeeCustomer(false);
      setEditCustomerCodeLookup(String(exact.customer_code ?? code));
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Link failed");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (r: HubRow) => {
    setEditRow(r);
    setEditName(r.full_name);
    setEditCode(r.cashier_code);
    setEditRole(r.role);
    setEditActive(r.is_active);
    setEditBasePct(pctFromDecimal(r.base_commission_rate));
    setEditPhone(r.phone ?? "");
    setEditEmail(r.email ?? "");
    setEditAvatarKey(r.avatar_key?.trim() || "ros_default");
    setEditMaxDiscountPct(String(r.max_discount_percent ?? "30"));
    setEditEmploymentStart(r.employment_start_date?.slice(0, 10) ?? "");
    setEditEmploymentEnd(r.employment_end_date?.slice(0, 10) ?? "");
    setEditEmployeeCustomerId(r.employee_customer_id ?? null);
    setEditDetachEmployeeCustomer(false);
    setEditCustomerCodeLookup(r.employee_customer_code?.trim() ?? "");
    setEditNewPin("");
    void loadStaffProfilePermissions(r.id, r.role);
  };

  const saveEdit = async () => {
    if (!editRow) return;
    setBusy(true);
    setLoadErr(null);
    try {
      if (hasPermission("staff.manage_pins") && editNewPin.trim().length === 4) {
        const pin = editNewPin.trim();
        if (pin !== editCode.trim()) {
          setLoadErr("PIN must match this staff member's 4-digit cashier code.");
          return;
        }
      }

      const base = decimalFromPctInput(editBasePct);
      if (base === null) {
        setLoadErr("Base commission must be 0–100%.");
        return;
      }
      const disc = Number.parseFloat(editMaxDiscountPct.trim());
      if (!Number.isFinite(disc) || disc < 0 || disc > 100) {
        setLoadErr("Max discount % must be 0–100.");
        return;
      }

      const origEc = editRow.employee_customer_id ?? null;
      const ecChanged = editDetachEmployeeCustomer || editEmployeeCustomerId !== origEc;

      const profileBody: Record<string, unknown> = {
        full_name: editName.trim(),
        cashier_code: editCode.trim(),
        role: editRole,
        is_active: editActive,
        base_commission_rate: base,
        phone: editPhone.trim() || null,
        email: editEmail.trim() || null,
        avatar_key: editAvatarKey.trim() || "ros_default",
        max_discount_percent: disc,
      };
      if (editEmploymentStart.trim()) {
        profileBody.employment_start_date = editEmploymentStart.trim();
      }
      if (editEmploymentEnd.trim()) {
        profileBody.employment_end_date = editEmploymentEnd.trim();
      }
      if (ecChanged) {
        if (editDetachEmployeeCustomer) {
          profileBody.detach_employee_customer = true;
        } else if (editEmployeeCustomerId) {
          profileBody.employee_customer_id = editEmployeeCustomerId;
        }
      }

      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(editRow.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify(profileBody),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Update failed");
      }

      if (hasPermission("staff.manage_access") && editRow.role !== "admin") {
        const grantedSorted = [...profileGranted].sort();
        const pr = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(editRow.id)}/permissions`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...backofficeHeaders() },
            body: JSON.stringify({ granted: grantedSorted }),
          },
        );
        if (!pr.ok) {
          const b = (await pr.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? "Permissions update failed");
        }
      }

      if (hasPermission("staff.manage_pins") && editNewPin.trim().length === 4) {
        const pin = editNewPin.trim();
        const pr = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(editRow.id)}/set-pin`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...backofficeHeaders() },
            body: JSON.stringify({ pin }),
          },
        );
        if (!pr.ok) {
          const b = (await pr.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? "PIN update failed");
        }
        setEditNewPin("");
      }

      setEditRow(null);
      await refreshRoster();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const saveCategoryRate = async (categoryId: string, pctStr: string) => {
    const rate = decimalFromPctInput(pctStr);
    if (rate === null) return;
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/category-commissions/${encodeURIComponent(categoryId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify({ commission_rate: rate }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Update failed");
      }
      await refreshCategories();
      await refreshRoster();
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (r: StaffRole) =>
    r === "admin"
      ? "Admin"
      : r === "salesperson"
        ? "Salesperson"
        : "Sales Support";

  const tabs = useMemo(() => {
    const all: {
      id: StaffTab;
      label: string;
      icon: typeof LayoutGrid;
      perm?: string;
      requireAll?: string[];
    }[] = [
      { id: "team", label: "Team", icon: LayoutGrid, perm: "staff.view" },
      { id: "tasks", label: "Tasks", icon: ListChecks, perm: "tasks.complete" },
      { id: "schedule", label: "Schedule", icon: CalendarDays, perm: "staff.view" },
      { id: "commission", label: "Commission", icon: Percent, perm: "staff.manage_commission" },
      {
        id: "commission-payouts",
        label: "Commission payouts",
        icon: CircleDollarSign,
        requireAll: ["insights.view", "insights.commission_finalize"],
      },
      { id: "audit", label: "Audit", icon: ClipboardList, perm: "staff.view_audit" },
    ];
    return all.filter((t) => {
      if (t.requireAll?.length) return t.requireAll.every((k) => hasPermission(k));
      if (t.perm) return hasPermission(t.perm);
      return false;
    });
  }, [hasPermission]);

  useEffect(() => {
    if (!unlocked) return;
    if (tabs.length > 0 && !tabs.some((t) => t.id === tab)) {
      setTab(tabs[0].id);
    }
  }, [unlocked, tabs, tab]);

  const permGroups = useMemo(() => {
    const m: Record<
      string,
      { key: string; label: string; group: string }[]
    > = {};
    for (const p of STAFF_PERMISSION_CATALOG) {
      m[p.group] = m[p.group] ?? [];
      m[p.group].push(p);
    }
    return m;
  }, []);

  if (!unlocked) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-6">
        <div className="ui-modal">
          <div className="ui-modal-header">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--app-accent)_16%,var(--app-surface-2))] text-[var(--app-accent)]">
              <Shield className="h-8 w-8" aria-hidden />
            </div>
            <h1 className="text-xl font-black text-app-text">Staff workspace</h1>
            <p className="mt-1 text-sm text-app-text-muted">
              Enter your 4-digit staff code. Access and commission changes are audited.
            </p>
          </div>
          </div>
          <div className="ui-modal-body">
          {gateError ? (
            <p className="mb-4 text-center text-sm font-semibold text-red-600">
              {gateError}
            </p>
          ) : null}
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Staff code
              </p>
              <PinDots length={gateCredential.length} />
              <NumericPinKeypad
                value={gateCredential}
                onChange={setGateCredential}
                disabled={busy}
              />
            </div>
            <button
              type="button"
              disabled={busy || gateCredential.length !== 4}
              onClick={() => void tryUnlock()}
              className="ui-btn-primary w-full py-4 text-sm disabled:opacity-50"
            >
              {busy ? "Checking…" : "Unlock"}
            </button>
          </div>
          </div>
        </div>
      </div>
    );
  }


  const activeTabLabel = tabs.find((t) => t.id === tab)?.label ?? "Staff";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4 gap-4">
      {/* Section header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">Staff</p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">{activeTabLabel}</h2>
        </div>
        <button
          type="button"
          onClick={() => {
            setUnlocked(false);
            setGateCredential("");
            clearStaffCredentials();
          }}
          className="ui-btn-secondary px-4 py-2 text-xs"
        >
          Lock workspace
        </button>
      </div>

      {loadErr ? (
        <p className="text-sm font-semibold text-red-600">{loadErr}</p>
      ) : null}

      {tab === "tasks" ? (
        <StaffTasksPanel
          focusInstanceId={tasksFocusInstanceId}
          onFocusConsumed={onTasksFocusConsumed}
        />
      ) : null}

      {tab === "schedule" ? <StaffSchedulePanel /> : null}

      {tab === "team" ? (
        <section className="ui-card min-h-0 flex-1 flex flex-col overflow-hidden p-4 gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted" />
              <input
                type="text"
                placeholder="Search staff by name, code or role…"
                className="ui-input w-full pl-10"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              {roster.length} Total · {roster.filter(r => r.is_active).length} Active
            </p>
          </div>

          <div className="flex-1 overflow-y-auto pt-2">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {roster
                .filter((r) => {
                  if (!searchInput.trim()) return true;
                  const q = searchInput.toLowerCase();
                  return (
                    r.full_name.toLowerCase().includes(q) ||
                    r.cashier_code.toLowerCase().includes(q) ||
                    r.role.toLowerCase().includes(q)
                  );
                })
                .map((r) => (
              <div
                key={r.id}
                className="ui-card p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-3">
                    <img
                      src={staffAvatarUrl(r.avatar_key)}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-full border border-app-border object-cover"
                    />
                    <div className="min-w-0">
                    <p className="text-lg font-black text-app-text">
                      {r.full_name}
                    </p>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                      {roleLabel(r.role)}
                      {!r.is_active ? " · Inactive" : ""}
                    </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                      r.has_pin
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {r.has_pin ? "PIN on" : "Badge only"}
                  </span>
                </div>
                <dl className="mt-3 grid gap-1 text-xs text-app-text-muted">
                  <div className="flex justify-between gap-2">
                    <dt>Sales MTD</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {money(r.sales_mtd)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Base commission</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {pctFromDecimal(r.base_commission_rate)}%
                    </dd>
                  </div>
                  {r.phone ? (
                    <div className="flex justify-between gap-2">
                      <dt>Phone</dt>
                      <dd className="font-bold text-app-text">{r.phone}</dd>
                    </div>
                  ) : null}
                  {r.email ? (
                    <div className="flex justify-between gap-2">
                      <dt>Email</dt>
                      <dd className="max-w-[10rem] truncate font-bold text-app-text" title={r.email}>
                        {r.email}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-2">
                    <dt>Max discount</dt>
                    <dd className="font-bold tabular-nums text-app-text">
                      {String(r.max_discount_percent ?? "—")}%
                    </dd>
                  </div>
                  {r.employee_customer_code ? (
                    <div className="flex justify-between gap-2">
                      <dt>Employee CRM</dt>
                      <dd className="truncate font-bold text-app-text" title={r.employee_customer_code}>
                        {r.employee_customer_code}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openEdit(r)}
                  className="ui-btn-secondary mt-4 w-full py-2"
                >
                  Edit staff
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "audit" ? (
        <section className="ui-card flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-app-text-muted">
              Chronological PIN and high-authority events (checkout, overrides,
              register, payouts, attribution edits).
            </p>
            <div className="flex gap-4 items-center">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-app-text-muted" />
                <input
                  className="ui-input w-full pl-8 py-1.5 text-xs"
                  placeholder="Search events or staff…"
                  value={auditSearchInput}
                  onChange={(e) => setAuditSearchInput(e.target.value)}
                />
              </div>
              <button
                type="button"
                disabled={accessLogLoading}
                onClick={() => void refreshAccessLog()}
                className="ui-btn-secondary px-3 py-1.5"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="ui-card min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-app-border bg-app-surface text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-3 py-2">When (UTC)</th>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border font-mono text-[11px]">
                {accessLogLoading && accessLog.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                      Loading…
                    </td>
                  </tr>
                ) : null}
                {accessLog
                  .filter((row) => {
                    if (!auditSearchInput.trim()) return true;
                    const q = auditSearchInput.toLowerCase();
                    return (
                      row.staff_name.toLowerCase().includes(q) ||
                      row.event_kind.toLowerCase().includes(q) ||
                      JSON.stringify(row.metadata).toLowerCase().includes(q)
                    );
                  })
                  .map((row) => (
                    <tr key={row.id} className="align-top hover:bg-app-surface-2 transition-colors">
                      <td className="whitespace-nowrap px-3 py-2 text-app-text-muted">
                        {new Date(row.created_at).toISOString().replace("T", " ").slice(0, 19)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <img
                            src={staffAvatarUrl(row.staff_avatar_key)}
                            alt=""
                            className="h-7 w-7 shrink-0 rounded-full border border-app-border object-cover"
                          />
                          <span className="font-semibold text-app-text">{row.staff_name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[var(--app-accent)]">
                        {row.event_kind}
                      </td>
                      <td className="max-w-md break-all px-3 py-2 text-app-text-muted">
                        {JSON.stringify(row.metadata)}
                      </td>
                    </tr>
                  ))}
                {!accessLogLoading && accessLog.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-app-text-muted">
                      No events yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {tab === "commission-payouts" ? <CommissionPayoutsPanel /> : null}

      {tab === "commission" ? (
        <section className="ui-card min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <p className="text-sm text-app-text-muted">
            Category overrides apply to commission-eligible staff when a line’s
            product maps to that category. Sales Support earns no commission.
          </p>
          <div className="ui-card overflow-hidden">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-app-border bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Override %</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <CategoryRateRow
                    key={c.category_id}
                    row={c}
                    disabled={busy}
                    onSave={(pct) => void saveCategoryRate(c.category_id, pct)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {editRow ? (
        <div className="ui-overlay-backdrop">
          <div
            ref={staffEditDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={staffEditTitleId}
            tabIndex={-1}
            className="ui-modal max-h-[90vh] overflow-y-auto outline-none"
          >
            <div className="ui-modal-header">
              <h2 id={staffEditTitleId} className="text-lg font-black text-app-text">
                Edit staff
              </h2>
              <p className="text-xs text-app-text-muted">{editRow.full_name}</p>
            </div>
            <div className="ui-modal-body space-y-4">
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Full name
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Cashier code
                <input
                  value={editCode}
                  onChange={(e) => setEditCode(e.target.value)}
                  className="ui-input mt-1 w-full font-mono text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Role
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as StaffRole)}
                  className="ui-input mt-1 w-full text-sm"
                >
                  <option value="admin">Admin</option>
                  <option value="salesperson">Salesperson</option>
                  <option value="sales_support">Sales Support</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold text-app-text">
                <input
                  type="checkbox"
                  checked={editActive}
                  onChange={(e) => setEditActive(e.target.checked)}
                />
                Active
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Base commission %
                <input
                  value={editBasePct}
                  onChange={(e) => setEditBasePct(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Max line discount % (this person)
                <input
                  value={editMaxDiscountPct}
                  onChange={(e) => setEditMaxDiscountPct(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                />
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Employment start
                  <input
                    type="date"
                    value={editEmploymentStart}
                    onChange={(e) => setEditEmploymentStart(e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                  />
                </label>
                <label className="block text-[10px] font-black uppercase text-app-text-muted">
                  Employment end
                  <input
                    type="date"
                    value={editEmploymentEnd}
                    onChange={(e) => setEditEmploymentEnd(e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                  />
                </label>
              </div>
              <div className="rounded-xl border border-app-border p-3">
                <p className="text-[10px] font-black uppercase text-app-text-muted">
                  Employee CRM (employee pricing, no commission on those sales)
                </p>
                <div className="mt-2">
                  <CustomerSearchInput 
                    onSelect={(c) => {
                      setEditEmployeeCustomerId(c.id);
                      setEditDetachEmployeeCustomer(false);
                      setEditCustomerCodeLookup(c.customer_code);
                    }}
                    placeholder="Search customer to link…"
                    className="w-full"
                  />
                  {editRow.employee_customer_id && !editDetachEmployeeCustomer ? (
                    <button
                      type="button"
                      className="mt-2 text-[10px] font-black uppercase text-red-600 hover:text-red-800"
                      onClick={() => {
                        setEditEmployeeCustomerId(null);
                        setEditDetachEmployeeCustomer(true);
                        setEditCustomerCodeLookup("");
                      }}
                    >
                      Clear link
                    </button>
                  ) : null}
                </div>
                {editDetachEmployeeCustomer ? (
                  <p className="mt-2 text-xs text-amber-700">Link will clear when you save.</p>
                ) : editEmployeeCustomerId ? (
                  <p className="mt-2 text-xs text-app-text-muted">
                    Linked customer:{" "}
                    <span className="font-bold text-app-text">{editCustomerCodeLookup}</span>
                  </p>
                ) : null}
              </div>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Phone
                <input
                  type="tel"
                  value={editPhone}
                  onChange={(e) => setEditPhone(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Optional"
                />
              </label>
              <label className="block text-[10px] font-black uppercase text-app-text-muted">
                Email
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Optional"
                />
              </label>
              <div>
                <p className="text-[10px] font-black uppercase text-app-text-muted">
                  Profile icon
                </p>
                <StaffAvatarPicker
                  value={editAvatarKey}
                  onChange={setEditAvatarKey}
                  disabled={busy}
                />
              </div>

              {hasPermission("staff.manage_pins") ? (
                <div className="rounded-xl border border-app-border p-3">
                  <p className="text-[10px] font-black uppercase text-app-text-muted">PIN</p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    New code must match this staff member&apos;s cashier code (four digits). Stored as
                    Argon2 hash only.
                  </p>
                  <input
                    type="password"
                    inputMode="numeric"
                    value={editNewPin}
                    onChange={(e) =>
                      setEditNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))
                    }
                    className="ui-input mt-2 w-full max-w-xs font-mono text-lg tracking-[0.3em]"
                    placeholder="••••"
                  />
                </div>
              ) : null}

              {hasPermission("staff.manage_access") ? (
                <div className="rounded-xl border border-app-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[10px] font-black uppercase text-app-text-muted">
                      Access (this person)
                    </p>
                    {editRow.role !== "admin" ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase"
                        disabled={busy || profilePermLoading}
                        onClick={() => void applyRoleDefaultsForProfile()}
                      >
                        Apply role defaults
                      </button>
                    ) : null}
                  </div>
                  {editRow.role === "admin" ? (
                    <p className="mt-2 text-xs text-app-text-muted">
                      Admin accounts receive the full permission catalog in software.
                    </p>
                  ) : profilePermLoading ? (
                    <p className="mt-2 text-sm text-app-text-muted">Loading permissions…</p>
                  ) : (
                    <div className="mt-3 max-h-[40vh] space-y-3 overflow-y-auto pr-1">
                      {Object.entries(permGroups).map(([group, items]) => (
                        <div key={group}>
                          <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {group}
                          </p>
                          <ul className="mt-1 space-y-1">
                            {items.map((p) => (
                              <li key={p.key}>
                                <label className="flex cursor-pointer items-start gap-2 text-xs">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={profileGranted.includes(p.key)}
                                    onChange={() => toggleProfilePermission(p.key)}
                                  />
                                  <span>
                                    <span className="font-semibold text-app-text">{p.label}</span>
                                    <span className="block font-mono text-[10px] text-app-text-muted">
                                      {p.key}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
            <div className="ui-modal-footer">
              <button
                type="button"
                onClick={() => setEditRow(null)}
                className="ui-btn-secondary flex-1 py-3 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void saveEdit()}
                className="ui-btn-primary flex-1 py-3 text-sm disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CategoryRateRow({
  row,
  disabled,
  onSave,
}: {
  row: CategoryCommissionRow;
  disabled: boolean;
  onSave: (pct: string) => void;
}) {
  const [local, setLocal] = useState(pctFromDecimal(row.commission_rate));
  useEffect(() => {
    setLocal(pctFromDecimal(row.commission_rate));
  }, [row.commission_rate]);

  return (
    <tr className="border-b border-app-border/50">
      <td className="px-4 py-3 font-semibold text-app-text">
        {row.category_name}
      </td>
      <td className="px-4 py-3">
        <input
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          disabled={disabled}
          className="ui-input w-24 py-1.5 font-mono text-sm"
        />
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSave(local)}
          className="ui-btn-primary px-3 py-1.5 disabled:opacity-50"
        >
          Apply
        </button>
      </td>
    </tr>
  );
}
