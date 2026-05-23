import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, Info } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import ReviewInvitesSettingsCard from "./ReviewInvitesSettingsCard";
import {
  getPodiumOAuthRedirectUri,
  PODIUM_OAUTH_STATE_STORAGE_KEY,
  PODIUM_OAUTH_REDIRECT_STORAGE_KEY
} from "../../lib/podiumOAuth";

interface PodiumSmsConfig {
  sms_send_enabled: boolean;
  location_uid: string;
  templates: {
    ready_for_pickup: string;
    alteration_ready: string;
    unknown_sender_welcome: string;
    loyalty_reward_redeemed: string;
  };
  widget_embed_enabled: boolean;
  widget_snippet_html: string;
  credentials_configured: boolean;
  oauth_authorize_url: string;
  oauth_token_url_hint: string;
}

interface PodiumReadiness {
  api_base: string;
  webhook_secret_configured: boolean;
  allow_unsigned_webhook: boolean;
  inbound_inbox_preview_enabled: boolean;
}

interface PodiumAuthorizeUrlResponse {
  authorize_url: string;
}

interface PodiumSettingsPanelProps {
  baseUrl: string;
}

const PODIUM_TEMPLATE_DEFAULTS = {
  ready_for_pickup: "Hi {first_name}, your Riverside order {order_ref} is ready for pickup. We look forward to seeing you.",
  alteration_ready: "Hi {first_name}, your alteration {alteration_ref} is ready for your final fitting or pickup.",
  unknown_sender_welcome: "Hi from Riverside! We've saved your contact info. Reply here for questions about your order.",
  loyalty_reward_redeemed: "Hi {first_name}, you redeemed {points_redeemed} points for {reward_amount}. Your new balance is {new_balance} points.",
};

type SmsTemplateKey = keyof PodiumSmsConfig["templates"];

const PODIUM_SMS_TEMPLATE_BLOCKS: {
  key: SmsTemplateKey;
  label: string;
  description: string;
  tags: { token: string; label: string }[];
}[] = [
  {
    key: "ready_for_pickup",
    label: "Ready for pickup",
    description: "Sent when order items are ready for pickup.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{order_ref}", label: "Transaction" },
    ],
  },
  {
    key: "alteration_ready",
    label: "Alteration ready",
    description: "Sent when an alteration is marked ready.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{alteration_ref}", label: "Alteration" },
    ],
  },
  {
    key: "loyalty_reward_redeemed",
    label: "Loyalty reward",
    description: "Sent when a customer redeems loyalty points.",
    tags: [
      { token: "{first_name}", label: "First name" },
      { token: "{reward_amount}", label: "Reward amount" },
      { token: "{points_redeemed}", label: "Points used" },
      { token: "{new_balance}", label: "New balance" },
      { token: "{reward_breakdown}", label: "Reward breakdown" },
    ],
  },
  {
    key: "unknown_sender_welcome",
    label: "New text sender",
    description: "Sent once when a new inbound phone number creates a customer stub.",
    tags: [],
  },
] as const;

const PODIUM_OAUTH_SCOPE = [
  "read_locations",
  "read_messages",
  "write_messages",
  "read_reviews",
  "write_reviews",
  "read_users",
  "write_contacts",
].join(" ");

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
    const redirectUri = getPodiumOAuthRedirectUri();
    if (!redirectUri) {
      toast("Podium callback URL is unavailable in this browser session.", "error");
      return;
    }
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      scope: PODIUM_OAUTH_SCOPE,
    });
    try {
      const res = await fetch(`${baseUrl}/api/settings/podium-oauth/authorize-url?${params}`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Podium authorization is not ready yet.", "error");
        return;
      }
      const body = (await res.json()) as PodiumAuthorizeUrlResponse;
      if (!body.authorize_url) {
        toast("Podium authorization URL was not returned.", "error");
        return;
      }
      sessionStorage.setItem(PODIUM_OAUTH_STATE_STORAGE_KEY, state);
      sessionStorage.setItem(PODIUM_OAUTH_REDIRECT_STORAGE_KEY, redirectUri);
      window.location.href = body.authorize_url;
    } catch {
      toast("Could not start Podium authorization.", "error");
    }
  };

  const insertSmsTag = (key: SmsTemplateKey, token: string) => {
    if (!podiumSms) return;
    const current = podiumSms.templates[key] ?? "";
    const next = current.trimEnd().length > 0 ? `${current.trimEnd()} ${token}` : token;
    setPodiumSms({
      ...podiumSms,
      templates: {
        ...podiumSms.templates,
        [key]: next,
      },
    });
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
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Text Messaging & Web Chat</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Coordinate Podium SMS templates, review invites, and web chat widgets. Store email is managed in the Riverside IONOS mailbox.</p>
      </header>

      <ReviewInvitesSettingsCard baseUrl={baseUrl} />

      <section className="ui-card ui-tint-accent p-8 max-w-4xl shadow-xl">
        {!podiumSms.credentials_configured && (
          <div className="ui-panel ui-tint-warning mb-8 p-6 text-sm">
            <h4 className="font-black uppercase tracking-widest text-app-warning flex items-center gap-2">
              <Info className="h-4 w-4" />
              Podium Credentials Needed
            </h4>
            <p className="mt-3 leading-relaxed text-app-text-muted font-medium">
              Outbound communication is currently offline. Save the Podium
              client credentials below, then authorize the account through
              Podium.
            </p>
            <button
               onClick={() => void startPodiumOAuthConnect()}
               className="mt-6 ui-btn-secondary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest border-app-accent/40 text-app-accent hover:bg-app-accent hover:text-white transition-all shadow-lg shadow-app-accent/10"
            >
               Authorize via Podium Portal
            </button>
          </div>
        )}

        <div className="mb-8">
          <IntegrationCredentialsCard
            baseUrl={baseUrl}
            integrationKey="podium"
            title="Podium Credentials"
            description="Save Podium messaging credentials here. The OAuth callback now saves the refresh token back to Riverside instead of asking staff to edit environment files."
            fields={[
              {
                key: "client_id",
                label: "Client ID",
                type: "text",
                help: "Required before starting the Podium authorization flow.",
              },
              {
                key: "client_secret",
                label: "Client secret",
                help: "Required before starting the Podium authorization flow.",
              },
              {
                key: "refresh_token",
                label: "Refresh token",
                help: "Usually saved automatically after Podium authorization.",
              },
              {
                key: "webhook_secret",
                label: "Webhook signing secret",
                help: "Used to verify incoming Podium updates.",
              },
              {
                key: "api_base_url",
                label: "API host",
                type: "url",
                placeholder: "https://api.podium.com",
              },
              {
                key: "oauth_token_url",
                label: "OAuth token URL",
                type: "url",
                placeholder: "https://api.podium.com/oauth/token",
              },
            ]}
            onSaved={fetchPodiumSmsSettings}
          />
        </div>

        {podiumReadiness && (
           <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
              {[
                { label: "API Channel", val: podiumReadiness.api_base.replace('https://', '') },
                { label: "Webhooks", val: podiumReadiness.webhook_secret_configured ? "Verified" : "Unsigned" },
                { label: "Inbox Sync", val: podiumReadiness.inbound_inbox_preview_enabled ? "Enabled" : "Disabled" },
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
                 <h3 className="text-lg font-black italic uppercase tracking-tight text-app-text">Text Message Controls</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Lifecycle SMS and inbound Podium messages</p>
              </div>
           </div>

           <div className="flex items-center gap-6">
              {[
                { key: 'sms_send_enabled', label: "SMS Active" },
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
                 <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">Automated Text Message Templates</h4>
                 <Info size={14} className="text-app-text-muted" />
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                 {PODIUM_SMS_TEMPLATE_BLOCKS.map((block) => (
                   <div key={block.key} className="ui-card ui-tint-neutral p-5 space-y-3">
                      <div className="flex justify-between items-start gap-3">
                         <div>
                           <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">{block.label}</span>
                           <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">{block.description}</p>
                         </div>
                         <button
                           onClick={() => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [block.key]: PODIUM_TEMPLATE_DEFAULTS[block.key]}})}
                           className="shrink-0 text-[8px] font-black uppercase tracking-widest text-app-accent hover:text-app-text transition-colors"
                         >
                           Reset
                         </button>
                      </div>
                      {block.tags.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {block.tags.map((tag) => (
                            <button
                              key={`${block.key}-${tag.token}`}
                              type="button"
                              onClick={() => insertSmsTag(block.key, tag.token)}
                              className="rounded-full border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-app-text-muted transition hover:border-app-accent hover:text-app-accent"
                            >
                              {tag.label} <span className="normal-case tracking-normal">{tag.token}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                      <textarea
                        className="ui-input w-full min-h-[100px] p-4 text-xs font-medium leading-relaxed border-app-border/60"
                        value={podiumSms.templates[block.key]}
                        onChange={e => setPodiumSms({...podiumSms, templates: {...podiumSms.templates, [block.key]: e.target.value}})}
                      />
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
                 value={podiumSms.widget_snippet_html}
                 onChange={e => setPodiumSms({...podiumSms, widget_snippet_html: e.target.value})}
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
