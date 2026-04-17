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

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type StaffRole = "admin" | "salesperson" | "sales_support";

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

export default function StaffEditDrawer({
  staff,
  open,
  onClose,
  onUpdate,
}: StaffEditDrawerProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [tab, setTab] = useState<
    "overview" | "permissions" | "economics" | "lifecycle"
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

  const [employmentStart, setEmploymentStart] = useState("");
  const [employmentEnd, setEmploymentEnd] = useState("");
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(
    null,
  );
  const [employeeCustomerCode, setEmployeeCustomerCode] = useState("");
  const [detachEmployeeCustomer, setDetachEmployeeCustomer] = useState(false);

  const [granted, setGranted] = useState<string[]>([]);

  const loadPermissions = useCallback(async () => {
    setLoadingPerms(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staff.id)}/permissions`,
        {
          headers: backofficeHeaders(),
        },
      );
      if (!res.ok) throw new Error("Could not load permissions");
      const d = await res.json();
      setGranted(Array.isArray(d.granted) ? [...d.granted] : []);
    } catch {
      toast("Failed to load staff permissions", "error");
    } finally {
      setLoadingPerms(false);
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
  }, [open, staff, loadPermissions]);

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

      if (staff.id === "NEW") {
        payload.cashier_code = newPin.trim();
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
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Update failed");
      }

      let effectiveId = staff.id;
      if (staff.id === "NEW") {
        const body = await res.json().catch(() => ({}));
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
        if (!pr.ok) throw new Error("Permissions update failed");
      }

      // PIN Update
      if (hasPermission("staff.manage_pins") && newPin.trim().length === 4) {
        const pinRes = await fetch(
          `${baseUrl}/api/staff/admin/${encodeURIComponent(staff.id)}/set-pin`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...backofficeHeaders(),
            },
            body: JSON.stringify({ pin: newPin.trim() }),
          },
        );
        if (!pinRes.ok) throw new Error("PIN update failed");
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
            { id: "lifecycle", label: "Lifecycle", icon: Calendar },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as "overview" | "permissions" | "economics" | "lifecycle")}
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
