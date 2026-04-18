import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shield,
  User,
  Percent,
  Calendar,
  Unlink,
  ExternalLink,
  ChevronRight,
  Info,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { STAFF_PERMISSION_CATALOG } from "../../lib/staffPermissions";
import StaffAvatarPicker from "../staff/StaffAvatarPicker";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import { useToast } from "../ui/ToastProviderLogic";
import { HubRow } from "../staff/StaffEditDrawer";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface StaffProfilePanelProps {
  isPos?: boolean;
}

function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

export default function StaffProfilePanel({ isPos }: StaffProfilePanelProps) {
  const { backofficeHeaders, staffId, refreshPermissions } = useBackofficeAuth();
  const { toast } = useToast();

  const [staff, setStaff] = useState<HubRow | null>(null);
  const [tab, setTab] = useState<
    "overview" | "economics" | "permissions" | "lifecycle"
  >("overview");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // Form State
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [avatarKey, setAvatarKey] = useState("ros_default");
  const [employeeCustomerId, setEmployeeCustomerId] = useState<string | null>(null);
  const [employeeCustomerCode, setEmployeeCustomerCode] = useState("");
  const [detachEmployeeCustomer, setDetachEmployeeCustomer] = useState(false);

  const [granted, setGranted] = useState<string[]>([]);

  const fetchProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/self`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load profile");
      const d = (await res.json()) as HubRow;
      setStaff(d);
      
      // Init form
      setName(d.full_name);
      setPhone(d.phone ?? "");
      setEmail(d.email ?? "");
      setAvatarKey(d.avatar_key?.trim() || "ros_default");
      setEmployeeCustomerId(d.employee_customer_id ?? null);
      setEmployeeCustomerCode(d.employee_customer_code ?? "");
      setDetachEmployeeCustomer(false);
    } catch {
      toast("Failed to load your profile", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  const loadPermissions = useCallback(async () => {
    if (!staffId) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}/permissions`,
        {
          headers: backofficeHeaders(),
        },
      );
      if (!res.ok) throw new Error("Could not load permissions");
      const d = await res.json();
      setGranted(Array.isArray(d.granted) ? [...d.granted] : []);
    } catch {
      // Quiet fail for permissions in self-profile
    }
  }, [staffId, backofficeHeaders]);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  useEffect(() => {
    if (tab === "permissions") {
      void loadPermissions();
    }
  }, [tab, loadPermissions]);

  const savePersonal = async () => {
    setBusy(true);
    try {
      const payload: Partial<HubRow> & { detach_employee_customer?: boolean } = {
        full_name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        avatar_key: avatarKey.trim() || "ros_default",
      };

      if (detachEmployeeCustomer) {
        payload.detach_employee_customer = true;
      } else if (employeeCustomerId && employeeCustomerId !== staff?.employee_customer_id) {
        payload.employee_customer_id = employeeCustomerId;
      }

      const res = await fetch(`${baseUrl}/api/staff/self`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders(),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? "Update failed");
      }

      toast("Personal information updated", "success");
      void fetchProfile();
      void refreshPermissions(); // Sync sidebar avatar
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const permGroups = useMemo(() => {
    const m: Record<string, typeof STAFF_PERMISSION_CATALOG> = {};
    for (const p of STAFF_PERMISSION_CATALOG) {
      m[p.group] = m[p.group] ?? [];
      m[p.group].push(p);
    }
    return m;
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
      </div>
    );
  }

  if (!staff) return null;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
            Your Staff Profile
          </h2>
          <p className="mt-2 text-sm font-medium text-app-text-muted">
            Manage your identity and view your access rights within Riverside OS.
          </p>
        </div>
        {!isPos && (
          <div className="hidden md:flex items-center gap-2 px-4 py-2 rounded-full bg-app-accent/10 border border-app-accent/20">
            < Shield size={14} className="text-app-accent" />
            <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">
              Back Office Mode (Full Edit)
            </span>
          </div>
        )}
      </header>

      <div className="flex flex-col xl:flex-row gap-8">
        {/* Navigation Sidebar */}
        <div className="w-full xl:w-64 shrink-0 space-y-1">
          {[
            { id: "overview", label: "Overview", icon: User, desc: "Personal info & icon" },
            { id: "economics", label: "Economics", icon: Percent, desc: "Commission & Discounts" },
            { id: "permissions", label: "Permissions", icon: Shield, desc: "System Access Keys" },
            { id: "lifecycle", label: "Lifecycle", icon: Calendar, desc: "Employment & CRM Link" },
          ].map((t) => (
            <button
              key={t.id}
            onClick={() => setTab(t.id as "overview" | "economics" | "permissions" | "lifecycle")}
              className={`w-full flex items-center justify-between p-4 rounded-[20px] transition-all group ${
                tab === t.id
                  ? "bg-app-text text-white shadow-lg shadow-black/20"
                  : "hover:bg-app-surface border border-transparent hover:border-app-border"
              }`}
            >
              <div className="flex items-center gap-4 text-left">
                <div className={`p-2 rounded-xl ${tab === t.id ? "bg-white/10" : "bg-app-bg text-app-accent group-hover:bg-app-accent group-hover:text-white"}`}>
                  <t.icon size={18} />
                </div>
                <div>
                  <p className="text-xs font-black uppercase tracking-widest leading-none">
                    {t.label}
                  </p>
                  <p className={`mt-1 text-[9px] font-bold ${tab === t.id ? "text-white/60" : "text-app-text-muted"}`}>
                    {t.desc}
                  </p>
                </div>
              </div>
              <ChevronRight size={14} className={tab === t.id ? "opacity-100" : "opacity-0 group-hover:opacity-40"} />
            </button>
          ))}
        </div>

        {/* Content Area */}
        <div className="flex-1 space-y-8">
          {tab === "overview" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <section className="ui-card p-6 space-y-6">
                <div className="flex items-center gap-3 border-b border-app-border pb-4">
                  <User size={18} className="text-app-accent" />
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Personal Information
                  </h3>
                </div>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <label className="block">
                    <span className="text-[10px] font-black uppercase text-app-text-muted mb-2 block">
                      Full Name
                    </span>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      readOnly={isPos}
                      className={`ui-input w-full font-bold ${isPos ? "bg-app-bg/50 opacity-80" : ""}`}
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-black uppercase text-app-text-muted mb-2 block">
                      Role
                    </span>
                    <div className="ui-input w-full bg-app-bg/50 opacity-80 flex items-center justify-between">
                      <span className="font-bold text-xs uppercase tracking-widest">
                        {staff.role.replace("_", " ")}
                      </span>
                      <Shield size={12} className="text-app-text-muted opacity-40" />
                    </div>
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-black uppercase text-app-text-muted mb-2 block">
                      Phone Number
                    </span>
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="ui-input w-full font-bold"
                      placeholder="Optional"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-black uppercase text-app-text-muted mb-2 block">
                      Email Address
                    </span>
                    <input
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="ui-input w-full font-bold"
                      placeholder="Optional"
                    />
                  </label>
                </div>
              </section>

              <section className="ui-card p-6 space-y-6">
                <div className="flex items-center gap-3 border-b border-app-border pb-4">
                  <User size={18} className="text-app-accent" />
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Profile Icon
                  </h3>
                </div>
                <StaffAvatarPicker
                  value={avatarKey}
                  onChange={setAvatarKey}
                  disabled={busy}
                />
              </section>

              <div className="flex justify-end pt-4 border-t border-app-border">
                <button
                  onClick={savePersonal}
                  disabled={busy}
                  className="ui-btn-primary h-12 px-10 text-[11px] font-black uppercase tracking-widest shadow-xl shadow-app-accent/20"
                >
                  {busy ? "Updating Profile..." : "Apply Personal Changes"}
                </button>
              </div>
            </div>
          )}

          {tab === "economics" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
              <section className="ui-card p-8 bg-indigo-500/5 border-indigo-500/20">
                <div className="flex items-center gap-4 mb-8">
                  <div className="p-3 rounded-2xl bg-indigo-500 text-white shadow-lg shadow-indigo-500/20">
                    <Percent size={24} />
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-app-text italic uppercase tracking-tighter">
                      Compensation & Financial Rules
                    </h3>
                    <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">
                      Your operational guardrails
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="p-5 rounded-2xl bg-white/5 border border-white/10">
                    <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-2 block">
                      Base Commission Rate
                    </span>
                    <div className="flex items-end gap-1">
                      <span className="text-4xl font-black text-indigo-400 leading-none">
                        {pctFromDecimal(staff.base_commission_rate)}
                      </span>
                      <span className="text-xl font-black text-indigo-400/40 mb-1">%</span>
                    </div>
                    <p className="mt-3 text-[9px] font-medium text-app-text-muted leading-relaxed uppercase tracking-tight">
                      Standard earnings before category-specific overrides.
                    </p>
                  </div>
                  
                  <div className="p-5 rounded-2xl bg-white/5 border border-white/10">
                    <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-2 block">
                      Max Line Discount
                    </span>
                    <div className="flex items-end gap-1">
                      <span className="text-4xl font-black text-indigo-400 leading-none">
                        {staff.max_discount_percent}
                      </span>
                      <span className="text-xl font-black text-indigo-400/40 mb-1">%</span>
                    </div>
                    <p className="mt-3 text-[9px] font-medium text-app-text-muted leading-relaxed uppercase tracking-tight">
                      Discounts exceeding this require manager approval.
                    </p>
                  </div>

                  <div className="p-5 rounded-2xl bg-white/5 border border-white/10">
                    <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-2 block">
                      Employee Tracking ID
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="text-3xl font-mono font-black text-indigo-400 tracking-widest">
                        {staff.cashier_code}
                      </span>
                    </div>
                    <p className="mt-3 text-[9px] font-medium text-app-text-muted leading-relaxed uppercase tracking-tight">
                      Used for audit-traceable actions and report attribution.
                    </p>
                  </div>
                  
                  <div className="p-5 rounded-2xl bg-white/5 border border-white/10">
                    <span className="text-[9px] font-black uppercase text-indigo-300/60 mb-2 block">
                      MTD Attributed Sales
                    </span>
                    <div className="flex items-end gap-1">
                      <span className="text-2xl font-black text-emerald-400 leading-none">
                        ${Number(staff.sales_mtd || 0).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-3 text-[9px] font-medium text-app-text-muted leading-relaxed uppercase tracking-tight">
                      Net revenue attributed to your ID this month.
                    </p>
                  </div>
                </div>
                
                <div className="mt-8 p-4 rounded-xl bg-app-bg/50 border border-app-border flex items-start gap-3">
                  <Info size={14} className="text-app-accent mt-0.5 shrink-0" />
                  <p className="text-[10px] font-medium text-app-text-muted uppercase leading-relaxed tracking-wider">
                    Economic rules—including commission rates and discount authority—are managed by administrators. 
                    Contact your system manager if you believe these values are incorrect.
                  </p>
                </div>
              </section>
            </div>
          )}

          {tab === "permissions" && (
            <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
                <section className="ui-card p-6">
                    <div className="flex items-center justify-between mb-8 border-b border-app-border pb-6">
                        <div className="flex items-center gap-4">
                            <div className="p-3 rounded-2xl bg-app-accent text-white">
                                <Shield size={20} />
                            </div>
                            <div>
                                <h3 className="text-lg font-black text-app-text italic uppercase tracking-tighter">
                                    System Access & Authority
                                </h3>
                                <p className="text-[10px] font-bold text-app-accent uppercase tracking-widest">
                                    Your active permission profile
                                </p>
                            </div>
                        </div>
                    </div>

                    {staff.role === "admin" ? (
                        <div className="p-12 rounded-[32px] border border-app-accent/30 bg-app-accent/5 flex flex-col items-center text-center space-y-6">
                            <div className="w-20 h-20 rounded-full bg-app-accent flex items-center justify-center shadow-2xl shadow-app-accent/40 animate-pulse">
                                <Shield size={40} className="text-white" />
                            </div>
                            <h4 className="text-xl font-black italic uppercase tracking-tighter text-app-text">
                                Full System Master Access
                            </h4>
                            <p className="text-xs font-medium text-app-text-muted max-w-[400px] leading-relaxed">
                                As an Administrator, you have unconditional authority over all system modules, 
                                financial reporting, staff management, and security settings.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-8">
                            {Object.entries(permGroups).map(([group, items]) => {
                                const activeInGroup = items.filter(p => granted.includes(p.key));
                                if (activeInGroup.length === 0) return null;
                                
                                return (
                                    <div key={group} className="space-y-3">
                                        <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted px-2 border-l-4 border-app-accent/40 ml-1">
                                            {group}
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            {activeInGroup.map((p) => (
                                                <div
                                                    key={p.key}
                                                    className="flex items-center gap-4 p-4 rounded-[20px] bg-app-surface border border-app-border/40"
                                                >
                                                    <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500">
                                                        <Shield size={14} />
                                                    </div>
                                                    <p className="text-[11px] font-black uppercase tracking-tight text-app-text whitespace-nowrap overflow-hidden text-ellipsis">
                                                        {p.label}
                                                    </p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </section>
            </div>
          )}

          {tab === "lifecycle" && (
            <div className="space-y-8 animate-in fade-in slide-in-from-right-4 duration-300">
              <section className="ui-card p-6 space-y-6">
                <div className="flex items-center gap-3 border-b border-app-border pb-4">
                  <Calendar size={18} className="text-app-accent" />
                  <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                    Employment Window
                  </h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-1">
                    <span className="text-[9px] font-black uppercase text-app-text-muted tracking-widest block">
                      Hire Date
                    </span>
                    <p className="text-lg font-black text-app-text italic">
                      {staff.employment_start_date ? new Date(staff.employment_start_date).toLocaleDateString(undefined, { dateStyle: 'long' }) : 'Unknown'}
                    </p>
                  </div>
                  {staff.employment_end_date && (
                    <div className="space-y-1">
                        <span className="text-[9px] font-black uppercase text-red-400 tracking-widest block">
                        Termination/End Date
                        </span>
                        <p className="text-lg font-black text-red-500 italic">
                        {new Date(staff.employment_end_date).toLocaleDateString(undefined, { dateStyle: 'long' })}
                        </p>
                    </div>
                  )}
                </div>
              </section>

              <section className="ui-card p-6 space-y-6 overflow-hidden">
                <div className="flex items-center justify-between border-b border-app-border pb-4">
                  <div className="flex items-center gap-3">
                    <ExternalLink size={18} className="text-app-accent" />
                    <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                        Employee CRM Linkage
                    </h3>
                  </div>
                  {employeeCustomerId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEmployeeCustomerId(null);
                        setDetachEmployeeCustomer(true);
                        setEmployeeCustomerCode("");
                      }}
                      className="flex items-center gap-1.5 text-[9px] font-black uppercase text-red-500 hover:text-red-400 transition-colors"
                    >
                      <Unlink size={12} />
                      Unlink Customer
                    </button>
                  )}
                </div>

                <div className="p-6 rounded-[24px] bg-app-surface-2/40 border-2 border-dashed border-app-border hover:border-app-accent transition-all">
                  <p className="text-xs font-medium text-app-text-muted mb-6 leading-relaxed">
                    By linking your staff profile to a customer account, the system automatically applies employee price levels and streamlines staff purchase workflows.
                  </p>

                  {!employeeCustomerId ? (
                    <div className="animate-in fade-in slide-in-from-bottom-2">
                      <CustomerSearchInput
                        onSelect={(c) => {
                          setEmployeeCustomerId(c.id);
                          setDetachEmployeeCustomer(false);
                          setEmployeeCustomerCode(c.customer_code ?? "");
                        }}
                        placeholder="Search for your customer profile..."
                        className="w-full"
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-between p-5 rounded-[20px] bg-app-accent text-white shadow-xl shadow-app-accent/30 animate-in zoom-in-95 duration-500">
                      <div className="flex items-center gap-5">
                        <div className="p-3 rounded-2xl bg-white/20">
                          <User size={24} />
                        </div>
                        <div>
                          <p className="text-lg font-black uppercase italic tracking-tighter">
                            {employeeCustomerCode}
                          </p>
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/70">
                            Verified Linked Profile
                          </p>
                        </div>
                      </div>
                      <Shield size={20} className="opacity-40" />
                    </div>
                  )}
                </div>
              </section>

              <div className="flex justify-end pt-4 border-t border-app-border">
                <button
                  onClick={savePersonal}
                  disabled={busy}
                  className="ui-btn-primary h-12 px-10 text-[11px] font-black uppercase tracking-widest shadow-xl shadow-app-accent/20"
                >
                  {busy ? "Updating Profile..." : "Apply Lifecycle Changes"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
