import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback } from "react";
import { 
  User, 
  Mail, 
  Phone, 
  Camera, 
  Save, 
  Loader2, 
  ShieldCheck, 
  ShieldAlert,
  CreditCard,
  Target,
  KeyRound,
  Check,
  X
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { 
  staffAvatarUrl, 
  STAFF_AVATAR_CATALOG,
  staffAvatarGroupLabel 
} from "../../lib/staffAvatars";

interface StaffProfile {
  id: string;
  full_name: string;
  cashier_code: string;
  role: string;
  is_active: boolean;
  base_commission_rate: string;
  has_pin: boolean;
  sales_mtd: string;
  phone: string | null;
  email: string | null;
  avatar_key: string;
  max_discount_percent: string;
  employee_customer_code: string | null;
}

export default function StaffProfilePanel() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  
  // Local form state
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [avatarKey, setAvatarKey] = useState("");

  const baseUrl = getBaseUrl();

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/self`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("We couldn't load your profile.");
      const data = await res.json() as StaffProfile;
      setProfile(data);
      setFullName(data.full_name);
      setEmail(data.email || "");
      setPhone(data.phone || "");
      setAvatarKey(data.avatar_key);
    } catch (e) {
      toast(e instanceof Error ? e.message : "We couldn't load your profile.", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast, baseUrl]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/self`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders(),
        },
        body: JSON.stringify({
          full_name: fullName.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          avatar_key: avatarKey,
        }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || "We couldn't save your profile.");
      }

      toast("Profile updated.", "success");
      await loadProfile();
    } catch (e) {
      toast(e instanceof Error ? e.message : "We couldn't save your profile.", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleUpdatePin = async () => {
    if (newPin.length !== 4 || !/^\d+$/.test(newPin)) {
      toast("PIN must be exactly 4 digits", "error");
      return;
    }
    setPinSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/self/set-pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders(),
        },
        body: JSON.stringify({ pin: newPin }),
      });
      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error || "Failed to update PIN");
      }
      toast("Access PIN updated. Your register code has been synchronized.", "success");
      setPinModalOpen(false);
      setNewPin("");
      await loadProfile();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Error updating PIN", "error");
    } finally {
      setPinSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-app-accent" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="ui-card p-12 text-center text-app-text-muted">
        <ShieldAlert className="mx-auto h-12 w-12 opacity-20 mb-4" />
        <p className="font-bold uppercase tracking-widest text-xs">Profile session unavailable</p>
      </div>
    );
  }

  // Grouped avatars
  const groups = Array.from(new Set(STAFF_AVATAR_CATALOG.map(a => a.group)));

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500 max-w-7xl mx-auto pb-20">
      <header className="mb-10">
        <h2 className="text-4xl font-black italic tracking-tighter uppercase text-app-text">
          Staff Profile
        </h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">
          Manage your workstation presence, credentials, and performance.
        </p>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-10">
        {/* Left Column: Core Identity */}
        <div className="xl:col-span-4 space-y-6">
          <section className="ui-card p-8 flex flex-col items-center text-center relative overflow-hidden">
            {/* Glossy background accent */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-app-accent/40 to-transparent" />
            
            <div className="relative group cursor-pointer" onClick={() => setAvatarPickerOpen(true)}>
              <div className="h-36 w-36 rounded-[2.5rem] overflow-hidden border-2 border-app-border shadow-2xl transition-all group-hover:border-app-accent group-hover:scale-[1.02]">
                <img 
                  src={staffAvatarUrl(avatarKey)} 
                  alt={fullName} 
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                   <p className="text-[10px] font-black uppercase text-white tracking-widest">Change</p>
                </div>
              </div>
              <div 
                className="absolute bottom-0 right-0 h-10 w-10 rounded-2xl bg-app-accent text-white flex items-center justify-center shadow-lg group-hover:scale-110 transition-all border-4 border-app-card"
              >
                <Camera size={18} />
              </div>
            </div>
            
            <div className="mt-6">
              <h3 className="text-2xl font-black text-app-text tracking-tight">{profile.full_name}</h3>
              <p className="text-[11px] font-black uppercase tracking-[0.25em] text-app-accent mt-1">
                {profile.role.replace(/_/g, " ")}
              </p>
            </div>

            <div className="w-full mt-8 pt-8 border-t border-app-border space-y-5">
              <div className="flex justify-between items-center bg-app-surface-2 p-3 rounded-2xl border border-app-border/40">
                <div className="flex items-center gap-3">
                   <div className="h-8 w-8 rounded-xl bg-app-accent/10 border border-app-accent/20 flex items-center justify-center text-app-accent">
                      <KeyRound size={16} />
                   </div>
                   <div className="text-left">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Access PIN</p>
                      <p className="text-xs font-black text-app-text">Workstation Gate</p>
                   </div>
                </div>
                <button 
                  onClick={() => setPinModalOpen(true)}
                  className="ui-btn-secondary px-3 py-1.5 text-[10px] uppercase font-black"
                >
                  Manage
                </button>
              </div>

              <div className="flex justify-between items-center bg-app-surface-2 p-3 rounded-2xl border border-app-border/40">
                <div className="flex items-center gap-3">
                   <div className="h-8 w-8 rounded-xl bg-app-text/5 border border-app-border flex items-center justify-center text-app-text-muted">
                      <ShieldCheck size={16} />
                   </div>
                   <div className="text-left">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Staff Code</p>
                      <p className="text-xs font-black text-app-text">#{profile.cashier_code}</p>
                   </div>
                </div>
                <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
              </div>
            </div>
          </section>

          {/* Performance Stats Snapshot */}
          <section className="ui-card p-8 bg-app-accent/5 border-app-accent/20 relative overflow-hidden group">
            <div className="absolute -right-4 -top-4 opacity-[0.03] group-hover:scale-110 transition-transform duration-700">
               <Target size={120} />
            </div>
            <div className="flex items-center gap-3 mb-8 font-black italic tracking-tighter uppercase text-app-text relative z-10">
              <Target className="w-5 h-5 text-app-accent" />
              <span>Personal Performance</span>
            </div>
            <div className="space-y-8 relative z-10">
              <div>
                <h4 className="text-[11px] font-black uppercase tracking-widest text-app-text-muted mb-1 opacity-70">
                  Sales this month (MTD)
                </h4>
                <p className="text-4xl font-black tracking-tight text-app-text tabular-nums">
                  ${parseFloat(profile.sales_mtd).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </p>
              </div>
              <div className="pt-6 border-t border-app-border/40 grid grid-cols-2 gap-6">
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1 opacity-70">
                    Commission
                  </h4>
                  <p className="text-lg font-black text-app-text">
                    {(parseFloat(profile.base_commission_rate) * 100).toFixed(1)}%
                  </p>
                </div>
                <div>
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-1 opacity-70">
                    Max Discount
                  </h4>
                  <p className="text-lg font-black text-app-text">
                    {profile.max_discount_percent}%
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Right Column: Editable Details */}
        <div className="xl:col-span-8 space-y-10">
          <section className="ui-card p-10 border-t-4 border-app-accent">
            <div className="flex items-center gap-3 mb-10">
              <div className="h-10 w-10 rounded-2xl bg-app-accent/10 flex items-center justify-center text-app-accent">
                <User size={20} />
              </div>
              <h3 className="text-lg font-black uppercase tracking-[0.15em] text-app-text italic">
                Account Details
              </h3>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              <label className="block space-y-3">
                <span className="text-[11px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-2">
                  <User size={12} className="text-app-accent" />
                  Full Display Name
                </span>
                <input 
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="ui-input w-full px-6 h-16 font-black text-lg bg-app-surface-2"
                  placeholder="Enter full name"
                />
              </label>

              <label className="block space-y-3">
                <span className="text-[11px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-2">
                  <Mail size={12} className="text-app-accent" />
                  Work Email Address
                </span>
                <input 
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="ui-input w-full px-6 h-16 font-black text-lg bg-app-surface-2"
                  placeholder="name@riverside.com"
                />
              </label>

              <label className="block space-y-3">
                <span className="text-[11px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-2">
                  <Phone size={12} className="text-app-accent" />
                  Mobile Phone
                </span>
                <input 
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="ui-input w-full px-6 h-16 font-black text-lg bg-app-surface-2"
                  placeholder="(555) 000-0000"
                />
              </label>

              {profile.employee_customer_code && (
                <div className="block space-y-3">
                  <span className="text-[11px] font-black uppercase tracking-widest text-app-text-muted ml-1 flex items-center gap-2">
                    <CreditCard size={12} className="text-app-accent" />
                    CRM Linkage
                  </span>
                  <div className="flex items-center gap-4 h-16 px-6 rounded-2xl bg-app-accent/5 border border-app-accent/20">
                    <CreditCard className="h-5 w-5 text-app-accent" />
                    <div>
                      <p className="text-xs font-black text-app-text">Linked Personal Account</p>
                      <p className="text-[11px] font-black text-app-accent mt-0.5 uppercase tracking-widest">
                        {profile.employee_customer_code}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-14 pt-10 border-t border-app-border flex justify-end">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="ui-btn-primary h-16 px-12 text-xs font-black uppercase tracking-[0.2em] flex items-center gap-4 shadow-2xl shadow-app-accent/30 hover:shadow-app-accent/40 transition-all disabled:opacity-50 active:scale-95 group"
              >
                {saving ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <>
                    <Save size={20} className="group-hover:rotate-12 transition-transform" />
                    Save Profile Changes
                  </>
                )}
              </button>
            </div>
          </section>

          {/* Security Banner */}
          <section className="ui-card p-8 border-l-4 border-amber-500 bg-amber-500/5 backdrop-blur-md">
             <div className="flex items-start gap-5">
                <div className="p-4 rounded-[1.25rem] bg-amber-500/10 text-amber-600 shadow-inner">
                  <ShieldAlert size={28} />
                </div>
                <div>
                   <h4 className="text-lg font-black uppercase text-app-text italic tracking-tighter">Security Protocol</h4>
                   <p className="mt-3 text-[13px] font-semibold text-app-text-muted leading-relaxed max-w-3xl opacity-80">
                     Sensitive demographic changes and role modifications are logged for audit transparency. To ensure maximal workstation security, your Access PIN should be rotated significantly if shared. Managers can perform remote resets via the Team Roster if your account is locked.
                   </p>
                </div>
             </div>
          </section>
        </div>
      </div>

      {/* Avatar Picker Modal */}
      {avatarPickerOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 sm:p-10 animate-in fade-in duration-300">
           <div className="fixed inset-0 bg-black/80 backdrop-blur-xl" onClick={() => setAvatarPickerOpen(false)} />
           <div className="relative w-full max-w-5xl bg-app-card rounded-[3rem] border border-app-border shadow-[0_50px_100px_-20px_rgba(0,0,0,0.6)] flex flex-col max-h-[90vh] overflow-hidden animate-in zoom-in-95 duration-300">
              <div className="p-10 border-b border-app-border flex justify-between items-center">
                 <div>
                    <h3 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Avatar Catalog</h3>
                    <p className="text-sm text-app-text-muted mt-2 font-medium">Choose the profile photo you want to use at this workstation.</p>
                 </div>
                 <button onClick={() => setAvatarPickerOpen(false)} className="h-14 w-14 rounded-2xl bg-app-surface-2 hover:bg-app-surface-3 transition-colors flex items-center justify-center text-app-text-muted">
                    <X size={24} />
                 </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-10 custom-scrollbar space-y-12">
                 {groups.map(group => (
                   <div key={group}>
                      <h4 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-accent mb-6 flex items-center gap-4">
                        {staffAvatarGroupLabel(group)}
                        <div className="flex-1 h-px bg-app-accent/20" />
                      </h4>
                      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-6">
                         {STAFF_AVATAR_CATALOG.filter(a => a.group === group).map(avatar => (
                           <button 
                             key={avatar.key}
                             onClick={() => {
                               setAvatarKey(avatar.key);
                               setAvatarPickerOpen(false);
                             }}
                             className={`group relative aspect-square rounded-[1.5rem] overflow-hidden border-4 transition-all hover:scale-110 active:scale-90 ${avatarKey === avatar.key ? "border-app-accent shadow-[0_15px_30px_-5px_rgba(var(--app-accent-rgb),0.4)]" : "border-app-border grayscale hover:grayscale-0"}`}
                           >
                              <img src={staffAvatarUrl(avatar.key)} className="w-full h-full object-cover" />
                              {avatarKey === avatar.key && (
                                <div className="absolute inset-0 bg-app-accent/20 flex items-center justify-center">
                                   <div className="h-8 w-8 rounded-full bg-app-accent text-white flex items-center justify-center shadow-lg">
                                      <Check size={16} strokeWidth={3} />
                                   </div>
                                </div>
                              )}
                           </button>
                         ))}
                      </div>
                   </div>
                 ))}
              </div>
           </div>
        </div>
      )}

      {/* PIN Update Modal */}
      {pinModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="fixed inset-0 bg-black/80 backdrop-blur-xl" onClick={() => setPinModalOpen(false)} />
           <div className="relative w-full max-w-md bg-app-card rounded-[2.5rem] border border-app-border shadow-2xl p-10 space-y-8 animate-in zoom-in-95 duration-300">
              <div className="text-center">
                <div className="mx-auto h-20 w-20 rounded-[1.5rem] bg-app-accent/10 flex items-center justify-center text-app-accent mb-6 shadow-inner">
                   <KeyRound size={32} />
                </div>
                <h3 className="text-2xl font-black italic tracking-tighter uppercase text-app-text">Access Credentials</h3>
                <p className="text-sm text-app-text-muted mt-2 font-medium">Update your 4-digit workstation PIN.</p>
              </div>

              <div className="space-y-4">
                 <input 
                   type="password"
                   maxLength={4}
                   value={newPin}
                   onChange={(e) => {
                     const val = e.target.value.replace(/\D/g, "");
                     setNewPin(val);
                   }}
                   className="w-full h-20 bg-app-surface-2 rounded-2xl border-2 border-app-border focus:border-app-accent text-center text-4xl font-black tracking-[0.5em] transition-all outline-none"
                   placeholder="••••"
                   autoFocus
                 />
                 <p className="text-[10px] font-black uppercase text-center text-app-text-muted opacity-60 tracking-widest">
                    Exactly 4 digits required
                 </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                 <button 
                   onClick={() => setPinModalOpen(false)}
                   className="ui-btn-secondary h-14 rounded-2xl font-black uppercase text-xs tracking-widest"
                 >
                    Cancel
                 </button>
                 <button 
                   onClick={handleUpdatePin}
                   disabled={pinSaving || newPin.length !== 4}
                   className="ui-btn-primary h-14 rounded-2xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 shadow-xl shadow-app-accent/20"
                 >
                    {pinSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck size={18} />}
                    Update PIN
                 </button>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
