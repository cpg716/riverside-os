import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shield,
  User,
  Percent,
  Calendar,
  Lock,
  RefreshCw,
  Unlink,
  ExternalLink,
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { STAFF_PERMISSION_CATALOG } from "../../lib/staffPermissions";
import StaffAvatarPicker from "./StaffAvatarPicker";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

type StaffRole = "admin" | "salesperson" | "sales_support" | "staff_support" | "alterations";

export interface HubRow {
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

interface WeeklyAvailabilityEntry {
  weekday: number;
  works: boolean;
  shift_label?: string;
}

interface ExceptionRow {
  id: string;
  exception_date: string;
  kind: string;
  notes?: string;
  shift_label?: string;
}

interface StaffEditDrawerProps {
  staff: HubRow;
  open: boolean;
  onClose: () => void;
  onUpdate: () => void;
}

function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

function decimalFromPctInput(s: string): number | null {
  const t = s.trim().replace(/%/g, "");
  const v = Number.parseFloat(t);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v / 100;
}

function todayYmd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function StaffEditDrawer({
  staff,
  open,
  onClose,
  onUpdate,
}: StaffEditDrawerProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<
    "overview" | "permissions" | "economics" | "lifecycle" | "attendance"
  >("overview");
  const [busy, setBusy] = useState(false);
  const [loadingPerms, setLoadingPerms] = useState(false);

  // Form State
  const [name, setName] = useState("");
  const [cashierCode, setCashierCode] = useState("");
  const [role, setRole] = useState<StaffRole>("salesperson");
  const [active, setActive] = useState(true);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [avatarKey, setAvatarKey] = useState("ros_default");

  const [newPin, setNewPin] = useState("");

  const [basePct, setBasePct] = useState("");
  const [maxDiscountPct, setMaxDiscountPct] = useState("");
  const [commissionEffectiveDate, setCommissionEffectiveDate] = useState(
    todayYmd(),
  );
  const [recalculateEligibleCommission, setRecalculateEligibleCommission] =
    useState(true);

  const [employmentStart, setEmploymentStart] = useState("");
  const [employmentEnd, setEmploymentEnd] = useState("");
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(
    null,
  );
  const [employeeCustomerCode, setEmployeeCustomerCode] = useState("");
  const [detachEmployeeCustomer, setDetachEmployeeCustomer] = useState(false);

  // Attendance State
  const [weeklyAvailability, setWeeklyAvailability] = useState<WeeklyAvailabilityEntry[]>([]);
  const [attendanceHistory, setAttendanceHistory] = useState<ExceptionRow[]>([]);

  const [granted, setGranted] = useState<string[]>([]);

  const loadPermissions = useCallback(async () => {
    if (staff.id === "NEW") return;
    setLoadingPerms(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staff.id)}/permissions`,
        { headers: backofficeHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setGranted(data.permissions || []);
      }
    } catch {
      toast("Could not load permissions", "error");
    } finally {
      setLoadingPerms(false);
    }
  }, [staff.id, backofficeHeaders, toast]);

  const loadAttendance = useCallback(async () => {
    if (staff.id === "NEW") return;
    try {
      const [availRes, historyRes] = await Promise.all([
        fetch(`${baseUrl}/api/staff/schedule/weekly/${encodeURIComponent(staff.id)}`, {
          headers: backofficeHeaders(),
        }),
        fetch(`${baseUrl}/api/staff/schedule/exceptions?staff_id=${encodeURIComponent(staff.id)}&from=2024-01-01&to=2030-12-31`, {
          headers: backofficeHeaders(),
        }),
      ]);
      if (availRes.ok) setWeeklyAvailability(await availRes.json());
      if (historyRes.ok) setAttendanceHistory(await historyRes.json());
    } catch {
      toast("Failed to load attendance data", "error");
    } finally {
      // nothing
    }
  }, [staff.id, backofficeHeaders, toast]);

  // Initialize form
  useEffect(() => {
    if (!open) return;
    setName(staff.full_name);
    setCashierCode(staff.cashier_code || "");
    setRole(staff.role);
    setActive(staff.is_active);
    setPhone(staff.phone ?? "");
    setEmail(staff.email ?? "");
    setAvatarKey(staff.avatar_key?.trim() || "ros_default");
    setBasePct(pctFromDecimal(staff.base_commission_rate));
    setMaxDiscountPct(String(staff.max_discount_percent ?? "30"));
    setCommissionEffectiveDate(todayYmd());
    setRecalculateEligibleCommission(true);
    setEmploymentStart(staff.employment_start_date?.slice(0, 10) ?? "");
    setEmploymentEnd(staff.employment_end_date?.slice(0, 10) ?? "");
    setEmployeeCustomerId(staff.employee_customer_id ?? null);
    setEmployeeCustomerCode(staff.employee_customer_code ?? "");
    setDetachEmployeeCustomer(false);
    setNewPin("");

    if (staff.role !== "admin") {
      void loadPermissions();
    } else {
      setGranted([]);
    }

    if (staff.id !== "NEW") {
      void loadAttendance();
    } else {
      // Default availability for new staff
      setWeeklyAvailability([0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, works: w !== 0, shift_label: "" })));
      setAttendanceHistory([]);
    }
  }, [open, staff, loadPermissions, loadAttendance]);

  const save = async () => {
    setBusy(true);
    try {
      const base = decimalFromPctInput(basePct);
      if (base === null) throw new Error("Base commission must be 0–100%.");

      const disc = Number.parseFloat(maxDiscountPct.trim());
      if (!Number.isFinite(disc) || disc < 0 || disc > 100)
        throw new Error("Max discount % must be 0–100.");

      const payload: Record<string, unknown> = {
        full_name: name.trim(),
        role,
        is_active: active,
        base_commission_rate: base,
        phone: phone.trim() || null,
        email: email.trim() || null,
        avatar_key: avatarKey.trim() || "ros_default",
        max_discount_percent: disc,
        employment_start_date: employmentStart.trim() || null,
        employment_end_date: employmentEnd.trim() || null,
      };

      const baseChanged =
        base !== decimalFromPctInput(pctFromDecimal(staff.base_commission_rate));
      if (baseChanged) {
        payload.commission_effective_start_date =
          commissionEffectiveDate.trim() || todayYmd();
        payload.recalculate_commissions_from_effective_date =
          recalculateEligibleCommission;
      }

      const nextPin = newPin.trim();
      if (staff.id === "NEW" && nextPin.length === 4) {
        payload.cashier_code = nextPin;
      }

      if (detachEmployeeCustomer) {
        payload.detach_employee_customer = true;
      } else if (
        employeeCustomerId &&
        employeeCustomerId !== staff.employee_customer_id
      ) {
        payload.employee_customer_id = employeeCustomerId;
      }

      // Core Profile Update
      const res = await fetch(
        `${baseUrl}/api/staff/admin${staff.id === "NEW" ? "" : `/${encodeURIComponent(staff.id)}`}`,
        {
          method: staff.id === "NEW" ? "POST" : "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...backofficeHeaders(),
          },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof body.error === "string" ? body.error : "Update failed");
      }

      let effectiveId = staff.id;
      if (staff.id === "NEW") {
        if (typeof body.id !== "string") {
          throw new Error("Server did not return new staff id.");
        }
        effectiveId = body.id;
      }

      // Permissions Update (if not admin)
      if (hasPermission("staff.manage_access") && role !== "admin") {
        const pr = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(effectiveId)}/permissions`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              ...backofficeHeaders(),
            },
            body: JSON.stringify({ granted: [...granted].sort() }),
          },
        );
        if (!pr.ok) {
          const p = await pr.json().catch(() => ({}));
          throw new Error(typeof p.error === "string" ? p.error : "Permissions update failed");
        }
      }

      // PIN Update
      if (staff.id !== "NEW" && nextPin.length === 4) {
        const pr = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(staff.id)}/set-pin`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...backofficeHeaders(),
            },
            body: JSON.stringify({ pin: nextPin }),
          }
        );
        if (!pr.ok) {
          const p = await pr.json().catch(() => ({}));
          throw new Error(typeof p.error === "string" ? p.error : "PIN update failed");
        }
      }

      // Attendance Update
      if (staff.id !== "NEW") {
        await fetch(`${baseUrl}/api/staff/schedule/weekly`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify({ staff_id: effectiveId, weekdays: weeklyAvailability }),
        });
      } else {
         // For NEW staff, we currently rely on the server's default seeding,
         // but we could also send a PUT here after creation.
         await fetch(`${baseUrl}/api/staff/schedule/weekly`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...backofficeHeaders() },
          body: JSON.stringify({ staff_id: effectiveId, weekdays: weeklyAvailability }),
        });
      }

      toast("Staff profile updated", "success");
      onUpdate();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const applyDefaults = async () => {
    if (role === "admin") return;
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staff.id)}/apply-role-defaults`,
        {
          method: "POST",
          headers: backofficeHeaders(),
        },
      );
      if (!res.ok) throw new Error("Failed to apply defaults");
      await loadPermissions();
      toast("Role defaults applied", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Reset failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const togglePerm = (key: string) => {
    setGranted((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const permGroups = useMemo(() => {
    const m: Record<string, typeof STAFF_PERMISSION_CATALOG> = {};
    for (const p of STAFF_PERMISSION_CATALOG) {
      m[p.group] = m[p.group] ?? [];
      m[p.group].push(p);
    }
    return m;
  }, []);

  const baseRateChanged = useMemo(() => {
    const original = decimalFromPctInput(
      pctFromDecimal(staff.base_commission_rate),
    );
    const current = decimalFromPctInput(basePct);
    if (original == null || current == null) return false;
    return original !== current;
  }, [basePct, staff.base_commission_rate]);

  return (
    <DetailDrawer
      isOpen={open}
      onClose={onClose}
      title={name || "Edit Staff"}
      subtitle={
        staff.cashier_code
          ? `Register ID: ${staff.cashier_code}`
          : "Profile Details"
      }
      panelMaxClassName="max-w-xl"
      noPadding
      contentContained
      footer={
        <div className="flex gap-3 w-full p-4 bg-app-surface border-t border-app-border">
          <button
            type="button"
            onClick={onClose}
            className="ui-btn-secondary flex-1 py-3"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="ui-btn-primary flex-1 py-3"
          >
            {busy ? "Saving..." : "Save Profile"}
          </button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Sub-navigation */}
        <div className="sticky top-0 z-10 flex border-b border-app-border bg-app-surface/90 backdrop-blur-md px-8">
          {[
            { id: "overview", label: "Overview", icon: User },
            { id: "economics", label: "Economics", icon: Percent },
            { id: "permissions", label: "Permissions", icon: Shield },
            { id: "attendance", label: "Attendance", icon: Calendar },
            { id: "lifecycle", label: "Status", icon: RefreshCw },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as typeof tab)}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${
                tab === t.id
                  ? "border-app-accent text-app-text"
                  : "border-transparent text-app-text-muted hover:text-app-text"
              }`}
            >
              <t.icon size={12} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-8 space-y-8">
          {tab === "overview" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                    Core Information
                  </h3>
                  <div
                    className="flex items-center gap-2 cursor-pointer select-none"
                    onClick={() => setActive(!active)}
                  >
                    <span
                      className={`text-[10px] font-black uppercase ${active ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {active ? "Account Active" : "Account Inactive"}
                    </span>
                    <div
                      className={`w-8 h-4 rounded-full transition-colors relative ${active ? "bg-emerald-500" : "bg-app-border"}`}
                    >
                      <div
                        className={`absolute top-1 w-2 h-2 rounded-full bg-white transition-all ${active ? "left-5" : "left-1"}`}
                      />
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      Full Name
                    </span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      className="ui-input w-full font-bold"
                      placeholder="e.g. Christopher G"
                    />
                  </label>

                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      Role
                    </span>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as StaffRole)}
                      className="ui-input w-full text-xs font-bold"
                    >
                      <option value="salesperson">Salesperson</option>
                      <option value="sales_support">Sales Support</option>
                      <option value="staff_support">Staff Support</option>
                      <option value="alterations">Alterations</option>
                      <option value="admin">Admin (Full Access)</option>
                    </select>
                  </label>

                  </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Security
                </h3>
                <form 
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                  className="p-4 rounded-2xl border border-app-border bg-app-surface-2/40 space-y-4"
                >
                  <label className="block">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] font-black uppercase text-app-text-muted">
                        {staff.id === "NEW" ? "Set Access PIN (4 Digits)" : "Update Access PIN (4 Digits)"}
                      </span>
                      <Lock size={12} className="text-app-text-muted" />
                    </div>
                    <input
                      type="password"
                      maxLength={4}
                      value={newPin}
                      onChange={(e) =>
                        setNewPin(e.target.value.replace(/\D/g, ""))
                      }
                      className="ui-input w-full font-mono text-lg tracking-[0.5em] text-app-accent text-center"
                      placeholder="••••"
                    />
                    <p className="mt-2 text-[10px] text-app-text-muted italic">
                      {staff.id === "NEW" 
                        ? "This PIN will be used for both register login and manager overrides."
                        : "Only enter a value if you wish to reset this staff member's security PIN."}
                    </p>
                  </label>
                  {/* Invisible submit button to handle Enter key in the password field */}
                  <button type="submit" className="hidden" aria-hidden="true" />
                </form>
              </section>

              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Contact Info
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      Phone
                    </span>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="ui-input w-full text-xs"
                      placeholder="Optional"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      Email
                    </span>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="ui-input w-full text-xs"
                      placeholder="Optional"
                    />
                  </label>
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Profile Icon
                </h3>
                <StaffAvatarPicker
                  value={avatarKey}
                  onChange={setAvatarKey}
                  disabled={busy}
                />
              </section>
            </div>
          )}

          {tab === "economics" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <section className="space-y-6">
                <div className="p-6 rounded-2xl bg-indigo-500/5 border border-indigo-500/20 space-y-6">
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-lg bg-indigo-500/10 text-indigo-400">
                      <Percent size={18} />
                    </div>
                    <div>
                      <h3 className="text-sm font-black text-app-text">
                        Compensation & Rules
                      </h3>
                      <p className="text-[10px] text-app-text-muted uppercase tracking-wider">
                        Financial guardrails for this profile
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                    <label className="block">
                      <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-1 block">
                        Base Commission %
                      </span>
                      <input
                        value={basePct}
                        onChange={(e) => setBasePct(e.target.value)}
                        className="ui-input w-full text-lg font-black text-white bg-indigo-950/20 border-indigo-500/30"
                      />
                      <p className="mt-1 text-[9px] text-app-text-muted uppercase tracking-tighter">
                        Overrides apply at category level
                      </p>
                    </label>
                    <label className="block">
                      <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-1 block">
                        Max Line Discount %
                      </span>
                      <input
                        value={maxDiscountPct}
                        onChange={(e) => setMaxDiscountPct(e.target.value)}
                        className="ui-input w-full text-lg font-black text-white bg-indigo-950/20 border-indigo-500/30"
                      />
                      <p className="mt-1 text-[9px] text-app-text-muted uppercase tracking-tighter">
                        Requires manager override if exceeded
                      </p>
                    </label>
                    <label className="block">
                      <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-1 block">
                        Employee Tracking ID
                      </span>
                      <input
                        value={cashierCode}
                        onChange={(e) => setCashierCode(e.target.value)}
                        className="ui-input w-full text-lg font-black text-white bg-indigo-950/20 border-indigo-500/30"
                        placeholder="Auto-assigned"
                        maxLength={4}
                      />
                      <p className="mt-1 text-[9px] text-app-text-muted uppercase tracking-tighter">
                        Used for reports and audit logs. Leave blank to auto-assign.
                      </p>
                    </label>
                  </div>

                  {baseRateChanged ? (
                    <div className="rounded-2xl border border-indigo-400/30 bg-indigo-500/10 p-4 space-y-4">
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-200">
                          Commission change timing
                        </p>
                        <p className="mt-1 text-[11px] text-app-text-muted">
                          Commission counts when the item is picked up or completed.
                          Choose when this rate starts and whether to review
                          eligible unfinished lines from that date.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <label className="block">
                          <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-1 block">
                            New rate starts on
                          </span>
                          <input
                            type="date"
                            value={commissionEffectiveDate}
                            onChange={(e) =>
                              setCommissionEffectiveDate(e.target.value)
                            }
                            className="ui-input w-full text-sm font-bold text-white bg-indigo-950/20 border-indigo-500/30"
                          />
                        </label>
                        <label className="flex items-start gap-3 rounded-xl border border-app-border bg-app-surface/60 px-4 py-3">
                          <input
                            type="checkbox"
                            checked={recalculateEligibleCommission}
                            onChange={(e) =>
                              setRecalculateEligibleCommission(
                                e.target.checked,
                              )
                            }
                            className="mt-1 h-4 w-4 rounded border-app-border text-app-accent"
                          />
                          <span className="text-[11px] text-app-text-muted">
                            Recalculate unfinalized commission lines from this
                            date. New reporting uses immutable commission event snapshots.
                          </span>
                        </label>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          )}

          {tab === "permissions" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                    Access Rights
                  </h3>
                  <p className="text-[10px] text-app-text-muted">
                    Configure what this staff can view and manage
                  </p>
                </div>
                {role !== "admin" && (
                  <button
                    type="button"
                    onClick={applyDefaults}
                    disabled={busy}
                    className="flex items-center gap-2 text-[9px] font-black uppercase text-app-accent hover:bg-app-accent/10 px-3 py-1.5 rounded-lg border border-app-accent/20"
                  >
                    <RefreshCw
                      size={10}
                      className={busy ? "animate-spin" : ""}
                    />
                    Reset Defaults
                  </button>
                )}
              </div>

              {role === "admin" ? (
                <div className="p-8 rounded-2xl border border-app-accent/30 bg-app-accent/5 flex flex-col items-center text-center space-y-3">
                  <Shield size={32} className="text-app-accent" />
                  <p className="text-xs font-black uppercase tracking-widest text-app-text">
                    Full System Authority
                  </p>
                  <p className="text-[11px] text-app-text-muted max-w-[240px]">
                    Administrators have unconditional access to all modules,
                    financial reporting, and staff management.
                  </p>
                </div>
              ) : loadingPerms ? (
                <div className="flex h-40 items-center justify-center">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
                </div>
              ) : (
                <div className="space-y-6">
                  {Object.entries(permGroups).map(([group, items]) => (
                    <div key={group} className="space-y-2">
                      <h4 className="text-[9px] font-black uppercase tracking-[0.2em] text-app-accent/80 px-1 border-l-2 border-app-accent/30 ml-1">
                        {group}
                      </h4>
                      <div className="grid grid-cols-1 gap-1">
                        {items.map((p) => (
                          <label
                            key={p.key}
                            className="flex items-center gap-3 p-3 rounded-xl border border-app-border bg-app-surface-2/30 hover:bg-app-surface-2/60 transition-colors cursor-pointer group"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-app-border text-app-accent"
                              checked={granted.includes(p.key)}
                              onChange={() => togglePerm(p.key)}
                            />
                            <div className="flex-1">
                              <p className="text-[11px] font-black text-app-text group-hover:text-app-accent transition-colors">
                                {p.label}
                              </p>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === "attendance" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Weekly Availability
                </h3>
                <p className="text-[10px] text-app-text-muted">
                  Set the recurring work pattern for this staff member.
                </p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, wd) => {
                    const entry = weeklyAvailability.find((a) => a.weekday === wd) || { works: false, shift_label: "" };
                    return (
                      <div key={label} className="flex flex-col gap-1">
                        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-app-border px-3 py-2 text-sm bg-app-surface-2/30">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-app-border"
                            checked={entry.works}
                            onChange={(e) => {
                              const next = [...weeklyAvailability];
                              const idx = next.findIndex((a) => a.weekday === wd);
                              if (idx >= 0) {
                                next[idx] = { ...next[idx], works: e.target.checked };
                              } else {
                                next.push({ weekday: wd, works: e.target.checked, shift_label: "" });
                              }
                              setWeeklyAvailability(next);
                            }}
                          />
                          <span className="font-bold">{label}</span>
                        </label>
                        <input
                          type="text"
                          placeholder="Shift"
                          className="ui-input h-8 px-2 text-[10px] font-bold"
                          value={entry.shift_label || ""}
                          disabled={!entry.works}
                          onChange={(e) => {
                            const next = [...weeklyAvailability];
                            const idx = next.findIndex((a) => a.weekday === wd);
                            if (idx >= 0) {
                              next[idx] = { ...next[idx], shift_label: e.target.value };
                              setWeeklyAvailability(next);
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Time Off & History
                </h3>
                <div className="rounded-2xl border border-app-border bg-app-surface-2/30 overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      <tr>
                        <th className="px-4 py-2">Date</th>
                        <th className="px-4 py-2">Type</th>
                        <th className="px-4 py-2">Notes</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {attendanceHistory.length === 0 ? (
                        <tr>
                          <td colSpan={3} className="px-4 py-8 text-center text-app-text-muted italic">
                            No attendance history recorded.
                          </td>
                        </tr>
                      ) : (
                        attendanceHistory.map((ex) => (
                          <tr key={ex.id}>
                            <td className="px-4 py-2 font-bold">{ex.exception_date}</td>
                            <td className="px-4 py-2">
                              <span className="rounded-full bg-app-surface-2 px-2 py-0.5 text-[10px] font-black uppercase">
                                {ex.kind.replace("_", " ")}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-app-text-muted">{ex.notes || "—"}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          )}
          {tab === "lifecycle" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <section className="space-y-4">
                <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                  Employment Window
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      Start Date
                    </span>
                    <div className="relative">
                      <Calendar
                        size={12}
                        className="absolute left-3 top-3 text-app-text-muted"
                      />
                      <input
                        type="date"
                        value={employmentStart}
                        onChange={(e) => setEmploymentStart(e.target.value)}
                        className="ui-input w-full pl-9 text-xs"
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-[9px] font-black uppercase text-app-text-muted mb-1 block">
                      End Date
                    </span>
                    <div className="relative">
                      <Calendar
                        size={12}
                        className="absolute left-3 top-3 text-app-text-muted"
                      />
                      <input
                        type="date"
                        value={employmentEnd}
                        onChange={(e) => setEmploymentEnd(e.target.value)}
                        className="ui-input w-full pl-9 text-xs"
                      />
                    </div>
                  </label>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                    Employee CRM Intelligence
                  </h3>
                  {staff.employee_customer_id && !detachEmployeeCustomer && (
                    <button
                      type="button"
                      onClick={() => {
                        setEmployeeCustomerId(null);
                        setDetachEmployeeCustomer(true);
                        setEmployeeCustomerCode("");
                      }}
                      className="flex items-center gap-1.5 text-[9px] font-black uppercase text-red-500 hover:text-red-400"
                    >
                      <Unlink size={10} />
                      Unlink Customer
                    </button>
                  )}
                </div>

                <div className="p-5 rounded-2xl border border-app-border bg-app-surface-2/40 space-y-4">
                  <p className="text-[10px] text-app-text-muted">
                    Linking a staff member to a customer record enables employee
                    discounts and unified purchase history.
                  </p>

                  {!employeeCustomerId || detachEmployeeCustomer ? (
                    <div className="space-y-2">
                      <CustomerSearchInput
                        onSelect={(c) => {
                          setEmployeeCustomerId(c.id);
                          setDetachEmployeeCustomer(false);
                          setEmployeeCustomerCode(c.customer_code ?? "");
                        }}
                        placeholder="Search for customer profile…"
                        className="w-full"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-between p-3 rounded-xl border border-app-accent/20 bg-app-accent/5">
                      <div className="flex items-center gap-3">
                        <div className="p-2 rounded-lg bg-app-accent/10 text-app-accent">
                          <ExternalLink size={16} />
                        </div>
                        <div>
                          <p className="text-[11px] font-black text-app-text capitalize">
                            {employeeCustomerCode}
                          </p>
                          <p className="text-[9px] font-bold text-app-accent uppercase tracking-tighter">
                            Linked Profile
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </DetailDrawer>
  );
}
