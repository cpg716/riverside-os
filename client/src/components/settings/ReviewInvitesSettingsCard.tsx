import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Save, Star } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import type { ReviewMessageTemplates } from "./useCustomerCommunicationSettings";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

type ReviewPolicy = {
  review_invites_enabled: boolean;
  send_review_invite_by_default: boolean;
};

type TemplateKey = keyof ReviewMessageTemplates;

export default function ReviewInvitesSettingsCard({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [policy, setPolicy] = useState<ReviewPolicy | null>(null);
  const [policyError, setPolicyError] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);
  const {
    settings,
    setSettings,
    loading: templatesLoading,
    saving: templatesSaving,
    savePatch,
  } = useCustomerCommunicationSettings(baseUrl);

  const loadPolicy = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setPolicyError("");
    try {
      const response = await fetch(`${baseUrl}/api/settings/review-policy`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!response.ok) throw new Error("review-policy");
      const body = (await response.json()) as ReviewPolicy;
      setPolicy({
        review_invites_enabled: body.review_invites_enabled !== false,
        send_review_invite_by_default:
          body.send_review_invite_by_default !== false,
      });
    } catch {
      setPolicy(null);
      setPolicyError("Review policy could not be loaded.");
    }
  }, [backofficeHeaders, baseUrl, hasPermission]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const savePolicy = async () => {
    if (!policy || policyBusy) return;
    setPolicyBusy(true);
    try {
      const response = await fetch(`${baseUrl}/api/settings/review-policy`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(policy),
      });
      const body = (await response.json().catch(() => ({}))) as
        | ReviewPolicy
        | { error?: string };
      if (!response.ok) {
        toast(
          "error" in body && body.error
            ? body.error
            : "Review policy could not be saved.",
          "error",
        );
        return;
      }
      setPolicy(body as ReviewPolicy);
      toast("Review invite policy saved.", "success");
    } catch {
      toast("Review policy could not be saved.", "error");
    } finally {
      setPolicyBusy(false);
    }
  };

  const updateTemplate = (key: TemplateKey, value: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            review_templates: { ...current.review_templates, [key]: value },
          }
        : current,
    );
  };

  const insertToken = (key: TemplateKey, token: string) => {
    if (!settings) return;
    const current = settings.review_templates[key];
    updateTemplate(
      key,
      current.trimEnd() ? `${current.trimEnd()} ${token}` : token,
    );
  };

  if (!hasPermission("settings.admin")) return null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header>
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
          <Star className="h-7 w-7" aria-hidden />
        </div>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          Customer Reviews
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Control post-sale review eligibility and the Podium message wording in one place.
          Fulfilled Transactions are scheduled for 10:00 AM five days later; the 180-day
          customer limit and customer opt-outs remain enforced.
        </p>
      </header>

      <section className="ui-card max-w-5xl p-6">
        <div className="mb-5 border-b border-app-border pb-4">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Review invite policy
          </h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
            The first switch is the global safety gate. The second controls whether eligible
            Transactions opt into scheduling by default.
          </p>
        </div>
        {policy ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <PolicyToggle
              label="Enable review invites"
              checked={policy.review_invites_enabled}
              onChange={(checked) =>
                setPolicy({ ...policy, review_invites_enabled: checked })
              }
            />
            <PolicyToggle
              label="Schedule eligible Transactions by default"
              checked={policy.send_review_invite_by_default}
              disabled={!policy.review_invites_enabled}
              onChange={(checked) =>
                setPolicy({ ...policy, send_review_invite_by_default: checked })
              }
            />
          </div>
        ) : (
          <p className="text-sm font-semibold text-app-warning">
            {policyError || "Loading review policy..."}
          </p>
        )}
        <button
          type="button"
          disabled={!policy || policyBusy}
          onClick={() => void savePolicy()}
          className="ui-btn-primary mt-5 inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden />
          {policyBusy ? "Saving..." : "Save Review Policy"}
        </button>
      </section>

      <section className="ui-card max-w-5xl p-6">
        <div className="mb-5 border-b border-app-border pb-4">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Review request wording
          </h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
            Podium delivers the text or email. Keep {"{review_url}"} in each message body.
            Blank fields inherit the Riverside default.
          </p>
        </div>
        {!templatesLoading && settings ? (
          <>
            <div className="mb-4 flex flex-wrap gap-2">
              {["{first_name}", "{transaction_ref}", "{store_name}", "{review_url}"].map(
                (token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => insertToken("sms_body", token)}
                    className="rounded-full border border-app-border bg-app-surface px-2.5 py-1 text-[9px] font-black text-app-text-muted hover:border-app-accent hover:text-app-accent"
                  >
                    {token}
                  </button>
                ),
              )}
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Podium SMS body
                <textarea
                  value={settings.review_templates.sms_body}
                  placeholder={settings.review_templates_effective.sms_body}
                  onChange={(event) => updateTemplate("sms_body", event.target.value)}
                  className="ui-input mt-2 min-h-32 w-full resize-y p-3 text-sm font-medium normal-case tracking-normal"
                />
              </label>
              <div className="space-y-4">
                <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium email subject
                  <input
                    value={settings.review_templates.email_subject}
                    placeholder={settings.review_templates_effective.email_subject}
                    onChange={(event) =>
                      updateTemplate("email_subject", event.target.value)
                    }
                    className="ui-input mt-2 h-11 w-full px-3 text-sm font-medium normal-case tracking-normal"
                  />
                </label>
                <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  Podium email body
                  <textarea
                    value={settings.review_templates.email_body}
                    placeholder={settings.review_templates_effective.email_body}
                    onChange={(event) => updateTemplate("email_body", event.target.value)}
                    className="ui-input mt-2 min-h-32 w-full resize-y p-3 text-sm font-medium normal-case tracking-normal"
                  />
                </label>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={templatesSaving}
                onClick={() =>
                  void savePatch(
                    { review_templates: settings.review_templates },
                    "Review request wording saved.",
                  )
                }
                className="ui-btn-primary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                <Save className="h-4 w-4" aria-hidden />
                {templatesSaving ? "Saving..." : "Save Review Wording"}
              </button>
              <button
                type="button"
                onClick={() =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          review_templates: {
                            sms_body: "",
                            email_subject: "",
                            email_body: "",
                          },
                        }
                      : current,
                  )
                }
                className="ui-btn-secondary h-11 px-5 text-[10px] font-black uppercase tracking-widest"
              >
                Use Riverside Defaults
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm font-semibold text-app-text-muted">
            Loading review wording...
          </p>
        )}
      </section>
    </div>
  );
}

function PolicyToggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
      <span
        className={`flex h-4 w-4 items-center justify-center rounded border-2 ${
          checked
            ? "border-app-accent bg-app-accent text-white"
            : "border-app-border"
        }`}
      >
        {checked ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : null}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span className="text-xs font-black uppercase tracking-widest text-app-text">
        {label}
      </span>
    </label>
  );
}
