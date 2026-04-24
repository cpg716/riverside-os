import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, Info } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { 
  getPodiumOAuthRedirectUri, 
  PODIUM_OAUTH_STATE_STORAGE_KEY, 
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY 
} from "../../lib/podiumOAuth";

interface PodiumSmsConfig {
  sms_send_enabled: boolean;
  email_send_enabled: boolean;
  location_uid: string;
  templates: {
    ready_for_pickup: string;
    alteration_ready: string;
    unknown_sender_welcome: string;
    loyalty_reward_redeemed: string;
  };
  email_templates: {
    ready_for_pickup_subject: string;
    ready_for_pickup_html: string;
    alteration_ready_subject: string;
    alteration_ready_html: string;
    appointment_confirmation_subject: string;
    appointment_confirmation_html: string;
    loyalty_reward_subject: string;
    loyalty_reward_html: string;
  };
  storefront_webchat_snippet: string;
  credentials_configured: boolean;
  oauth_authorize_url: string;
  oauth_token_url_hint: string;
}

interface PodiumReadiness {
  api_base: string;
  webhook_secret_configured: boolean;
  allow_unsigned_webhook: boolean;
  inbound_inbox_preview_enabled: boolean;
  email_send_enabled: boolean;
}

interface PodiumSettingsPanelProps {
  baseUrl: string;
}

const PODIUM_TEMPLATE_DEFAULTS = {
  ready_for_pickup: "Hi {first_name}, your Riverside order ({order_ref}) is ready for pickup! See you soon.",
  alteration_ready: "Hi {first_name}, your alteration ({alteration_ref}) is finished and ready for your final fitting/pickup.",
  unknown_sender_welcome: "Hi from Riverside! We've saved your contact info. Reply here for questions about your order.",
  loyalty_reward_redeemed: "Hi {first_name}, you just redeemed a loyalty reward! Your new balance is {new_balance} points.",
};

const PODIUM_EMAIL_TEMPLATE_DEFAULTS = {
  ready_for_pickup_subject: "Your Riverside Order is Ready",
  ready_for_pickup_html: "<h1>Hi {first_name}</h1><p>Your order <strong>{order_ref}</strong> is ready for pickup.</p>",
  alteration_ready_subject: "Alteration Finished",
  alteration_ready_html: "<h1>Hi {first_name}</h1><p>Your alteration <strong>{alteration_ref}</strong> is ready for your fitting.</p>",
  appointment_confirmation_subject: "Riverside Appointment Confirmation",
  appointment_confirmation_html: "<h1>Hi {first_name}</h1><p>Your <strong>{appointment_type}</strong> is confirmed for <strong>{starts_at}</strong>.</p>",
  loyalty_reward_subject: "Loyalty Reward Redeemed",
  loyalty_reward_html: "<h1>Hi {first_name}</h1><p>You redeemed <strong>{points_redeemed}</strong> points for <strong>{reward_amount}</strong>!</p>",
};

const PODIUM_EMAIL_UI_BLOCKS = [
  { label: "Pickup ready", subjectKey: "ready_for_pickup_subject", htmlKey: "ready_for_pickup_html" },
  { label: "Alteration ready", subjectKey: "alteration_ready_subject", htmlKey: "alteration_ready_html" },
  { label: "Appointment confirm", subjectKey: "appointment_confirmation_subject", htmlKey: "appointment_confirmation_html" },
  { label: "Loyalty reward", subjectKey: "loyalty_reward_subject", htmlKey: "loyalty_reward_html" },
] as const;

const PodiumSettingsPanel: React.FC<PodiumSettingsPanelProps> = ({ baseUrl }) => {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [podiumSms, setPodiumSms] = useState<PodiumSmsConfig | null>(null);
  const [podiumReadiness, setPodiumReadiness] = useState<PodiumReadiness | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchPodiumSmsSettings = useCallback(async () => {
    try {
      const resp = await fetch(`${baseUrl}/api/settings/podium-sms`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (resp.ok) {
        setPodiumSms((await resp.json()) as PodiumSmsConfig);
      }
      const readResp = await fetch(`${baseUrl}/api/settings/podium-sms/readiness`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (readResp.ok) {
        setPodiumReadiness((await readResp.json()) as PodiumReadiness);
      }
    } catch (err) {
      console.error("Failed to fetch podium settings", err);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchPodiumSmsSettings();
  }, [fetchPodiumSmsSettings]);

  const savePodiumSmsSettings = async () => {
    if (!podiumSms || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-sms`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(podiumSms),
      });
      if (res.ok) {
        toast("Podium communication settings saved", "success");
        await fetchPodiumSmsSettings();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save Podium settings", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const startPodiumOAuthConnect = async () => {
    if (!podiumSms) return;
    const state = crypto.randomUUID();
    sessionStorage.setItem(PODIUM_OAUTH_STATE_STORAGE_KEY, state);
    sessionStorage.setItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY, window.location.pathname + window.location.search);
    
    const url = new URL(podiumSms.oauth_authorize_url);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", getPodiumOAuthRedirectUri() ?? "");
    window.location.href = url.toString();
  };

  if (!podiumSms) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="podium"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-app-border bg-app-surface px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Messaging & Web Chat</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Coordinate operational SMS, HTML email templates, and web chat widgets.</p>
      </header>

      <section className="ui-card ui-tint-accent p-8 max-w-4xl shadow-xl">
        {!podiumSms.credentials_configured && (
          <div className="ui-panel ui-tint-warning mb-8 p-6 text-sm">
            <h4 className="font-black uppercase tracking-widest text-app-warning flex items-center gap-2">
              <Info className="h-4 w-4" />
              Environment Provisioning Required
            </h4>
            <p className="mt-3 leading-relaxed text-app-text-muted font-medium">
              Outbound communication is currently offline. Ensure <code className="bg-app-surface-2 px-1 rounded">RIVERSIDE_PODIUM_CLIENT_ID</code> and <code className="bg-app-surface-2 px-1 rounded">CLIENT_SECRET</code> are provisioned on the host.
            </p>
            <button
               onClick={() => void startPodiumOAuthConnect()}
               className="mt-6 ui-btn-secondary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest border-app-accent/40 text-app-accent hover:bg-app-accent hover:text-white transition-all shadow-lg shadow-app-accent/10"
            >
               Authorize via Podium Portal
            </button>
          </div>
        )}

        {podiumReadiness && (
           <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {[
                { label: "API Channel", val: podiumReadiness.api_base.replace('https://', '') },
                { label: "Webhooks", val: podiumReadiness.webhook_secret_configured ? "Verified" : "Unsigned" },
                { label: "Inbox Sync", val: podiumReadiness.inbound_inbox_preview_enabled ? "Enabled" : "Disabled" },
                { label: "Email Engine", val: podiumReadiness.email_send_enabled ? "Active" : "Ready" },
              ].map(stat => (
                <div key={stat.label} className="ui-metric-cell ui-tint-neutral p-3">
                   <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">{stat.label}</p>
                   <p className="text-xs font-black text-app-text truncate">{stat.val}</p>
                </div>
              ))}
           </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 mb-10 pb-10 border-b border-app-border/40">
           <div className="flex items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-app-surface shadow-xl shadow-app-accent/20 ring-1 ring-app-border">
                 <IntegrationBrandLogo
                   brand="podium"
                   kind="icon"
                   className="inline-flex"
                   imageClassName="h-10 w-10 rounded-md object-contain"
                 />
              </div>
              <div>
                 <h3 className="text-lg font-black italic uppercase tracking-tight text-app-text">Communication Controls</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Lifecycle SMS & HTML Correspondence</p>
              </div>
           </div>
           
           <div className="flex items-center gap-6">
              {[
                { key: 'sms_send_enabled', label: "SMS Active" },
                { key: 'email_send_enabled', label: "Email Active" },
              ].map(toggle => (
                <label key={toggle.key} className="flex items-center gap-2 cursor-pointer group">
                   <div className={`h-4 w-4 rounded-md border-2 flex items-center justify-center transition-all ${podiumSms[toggle.key as keyof PodiumSmsConfig] ? 'bg-app-accent border-app-accent text-white' : 'border-app-border group-hover:border-app-accent'}`}>
                      {podiumSms[toggle.key as keyof PodiumSmsConfig] && <CheckCircle2 size={10} />}
                   </div>
                   <input 
                     type="checkbox" 
                     className="sr-only" 
                     checked={!!podiumSms[toggle.key as keyof PodiumSmsConfig]} 
                     onChange={e => setPodiumSms({...podiumSms, [toggle.key]: e.target.checked})} 
                   />
                   <span className="text-[10px] font-black uppercase tracking-widest text-app-text">{toggle.label}</span>
                </label>
              ))}
           </div>
        </div>

        <div className="space-y-12">
           {/* SMS TEMPLATES */}
           <div>
              <div className="flex items-center justify-between mb-4">
                 <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Automated SMS Templates</h4>
                 <Info size={14} className="text-app-text-muted" />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                 {(Object.entries(PODIUM_TEMPLATE_DEFAULTS) as [keyof PodiumSmsConfig['templates'], string][]).map(([key, def]) => (
                   <div key={key} className="space-y-2">
                      <div className="flex justify-between items-center px-1">
                         <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{key.replace(/_/g, ' ')}</span>
                         <button 
                           onClick={() => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [key]: def}})}
                           className="text-[8px] font-black uppercase tracking-widest text-app-accent hover:text-app-text transition-colors"
                         >
                           Reset
                         </button>
                      </div>
                      <textarea 
                        className="ui-input w-full min-h-[100px] p-4 text-xs font-medium leading-relaxed border-app-border/60"
                        value={podiumSms.templates[key]}
                        onChange={e => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [key]: e.target.value}})}
                      />
                   </div>
                 ))}
              </div>
           </div>

           {/* EMAIL TEMPLATES */}
           <div className="pt-10 border-t border-app-border/40">
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text mb-6">HTML Email System</h4>
              <div className="space-y-8">
                 {PODIUM_EMAIL_UI_BLOCKS.map(block => (
                   <div key={block.label} className="ui-card ui-tint-neutral p-6 space-y-4">
                      <div className="flex justify-between items-center">
                         <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">{block.label} Configuration</span>
                         <button 
                            onClick={() => setPodiumSms({
                              ...podiumSms, 
                              email_templates: {
                                ...podiumSms.email_templates, 
                                [block.subjectKey]: PODIUM_EMAIL_TEMPLATE_DEFAULTS[block.subjectKey as keyof typeof PODIUM_EMAIL_TEMPLATE_DEFAULTS],
                                [block.htmlKey]: PODIUM_EMAIL_TEMPLATE_DEFAULTS[block.htmlKey as keyof typeof PODIUM_EMAIL_TEMPLATE_DEFAULTS]
                              }
                             })}
                           className="text-[8px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                        >
                           Reset Block
                         </button>
                      </div>
                      <div className="grid gap-4">
                         <input 
                           placeholder="Email Subject"
                           className="ui-input w-full px-4 py-3 text-xs font-bold"
                           value={podiumSms.email_templates[block.subjectKey]}
                           onChange={e => setPodiumSms({...podiumSms, email_templates: {...podiumSms.email_templates, [block.subjectKey]: e.target.value}})}
                         />
                         <textarea 
                           placeholder="HTML Source Code"
                           className="ui-input w-full min-h-[160px] p-4 font-mono text-[10px] leading-relaxed"
                           value={podiumSms.email_templates[block.htmlKey]}
                           onChange={e => setPodiumSms({...podiumSms, email_templates: {...podiumSms.email_templates, [block.htmlKey]: e.target.value}})}
                         />
                      </div>
                   </div>
                 ))}
              </div>
           </div>

           {/* WEB CHAT */}
           <div className="pt-10 border-t border-app-border/40">
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text mb-4">Web Chat Storefront Widget</h4>
              <p className="text-xs text-app-text-muted mb-4 leading-relaxed font-medium">
                Embed code provisioned from your Podium Control Panel. When <code className="bg-app-surface-2 px-1">VITE_STOREFRONT_EMBEDS</code> is active, this snippet is safely injected into public-facing terminals.
              </p>
              <textarea 
                 placeholder="<script>... podium.widget ...</script>"
                 className="ui-input w-full min-h-[120px] p-4 font-mono text-[10px]"
                 value={podiumSms.storefront_webchat_snippet}
                 onChange={e => setPodiumSms({...podiumSms, storefront_webchat_snippet: e.target.value})}
              />
           </div>
        </div>

        <div className="mt-12 pt-8 border-t border-app-border/40">
           <button 
             onClick={() => void savePodiumSmsSettings()}
             disabled={busy}
             className="w-full md:w-auto ui-btn-primary h-14 px-12 text-xs font-black uppercase tracking-[0.2em] shadow-xl shadow-violet-600/20 hover:scale-[1.02] transition-all"
           >
              {busy ? "Applying Changes..." : "Save Podium configuration"}
           </button>
        </div>
      </section>
    </div>
  );
};

export default PodiumSettingsPanel;
