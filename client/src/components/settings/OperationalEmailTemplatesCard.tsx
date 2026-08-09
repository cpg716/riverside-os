import { Mail, Save } from "lucide-react";
import type { OperationalEmailTemplates } from "./useCustomerCommunicationSettings";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

type TemplateKey = keyof OperationalEmailTemplates;

const TEMPLATE_BLOCKS: Array<{
  label: string;
  description: string;
  subjectKey: TemplateKey;
  bodyKey: TemplateKey;
  tokens: string[];
}> = [
  {
    label: "Ready for pickup",
    description: "Sent through Store Email when Transaction items are ready.",
    subjectKey: "ready_for_pickup_subject",
    bodyKey: "ready_for_pickup_html",
    tokens: ["{first_name}", "{transaction_ref}", "{store_phone}"],
  },
  {
    label: "Alteration ready",
    description: "Sent through Store Email when alteration work is ready.",
    subjectKey: "alteration_ready_subject",
    bodyKey: "alteration_ready_html",
    tokens: ["{first_name}", "{alteration_ref}", "{store_phone}"],
  },
  {
    label: "Appointment confirmation",
    description: "Sent with the calendar attachment after appointment creation.",
    subjectKey: "appointment_confirmation_subject",
    bodyKey: "appointment_confirmation_html",
    tokens: ["{first_name}", "{appointment_type}", "{starts_at}", "{notes_block}"],
  },
  {
    label: "Appointment reminder",
    description: "Sent by the appointment reminder worker.",
    subjectKey: "appointment_reminder_subject",
    bodyKey: "appointment_reminder_html",
    tokens: ["{first_name}", "{appointment_type}", "{starts_at}", "{store_phone}"],
  },
];

export default function OperationalEmailTemplatesCard({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { settings, setSettings, loading, saving, savePatch } =
    useCustomerCommunicationSettings(baseUrl);

  const update = (key: TemplateKey, value: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            email_templates: { ...current.email_templates, [key]: value },
          }
        : current,
    );
  };

  const insertToken = (key: TemplateKey, token: string) => {
    if (!settings) return;
    const current = settings.email_templates[key];
    update(key, current.trimEnd() ? `${current.trimEnd()} ${token}` : token);
  };

  if (loading || !settings) return null;

  return (
    <section className="ui-card max-w-5xl p-6">
      <div className="mb-5 flex items-start gap-3 border-b border-app-border pb-4">
        <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-accent">
          <Mail className="h-4 w-4" aria-hidden />
        </div>
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Automated email wording
          </h3>
          <p className="mt-1 text-xs font-semibold leading-5 text-app-text-muted">
            These messages use the Store Email mailbox above. Blank fields inherit the
            centrally maintained Riverside default.
          </p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {TEMPLATE_BLOCKS.map((block) => {
          const subjectInherited =
            !settings.email_templates[block.subjectKey].trim();
          const bodyInherited = !settings.email_templates[block.bodyKey].trim();
          return (
            <div key={block.subjectKey} className="rounded-2xl border border-app-border bg-app-surface-2/60 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                    {block.label}
                  </h4>
                  <p className="mt-1 text-xs font-medium leading-5 text-app-text-muted">
                    {block.description}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={subjectInherited && bodyInherited}
                  onClick={() => {
                    update(block.subjectKey, "");
                    update(block.bodyKey, "");
                  }}
                  className="shrink-0 text-[9px] font-black uppercase tracking-widest text-app-accent disabled:opacity-40"
                >
                  Use defaults
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {block.tokens.map((token) => (
                  <button
                    key={token}
                    type="button"
                    onClick={() => insertToken(block.bodyKey, token)}
                    className="rounded-full border border-app-border bg-app-surface px-2.5 py-1 text-[9px] font-black text-app-text-muted hover:border-app-accent hover:text-app-accent"
                  >
                    {token}
                  </button>
                ))}
              </div>
              <label className="mt-4 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                Subject
                <input
                  value={settings.email_templates[block.subjectKey]}
                  placeholder={settings.email_templates_effective[block.subjectKey]}
                  onChange={(event) => update(block.subjectKey, event.target.value)}
                  className="ui-input mt-2 h-11 w-full px-3 text-sm font-medium normal-case tracking-normal"
                />
              </label>
              <label className="mt-3 block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                HTML body
                <textarea
                  value={settings.email_templates[block.bodyKey]}
                  placeholder={settings.email_templates_effective[block.bodyKey]}
                  onChange={(event) => update(block.bodyKey, event.target.value)}
                  className="ui-input mt-2 min-h-32 w-full resize-y p-3 font-mono text-xs font-medium normal-case tracking-normal"
                />
              </label>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() =>
          void savePatch(
            { email_templates: settings.email_templates },
            "Automated email wording saved.",
          )
        }
        className="ui-btn-primary mt-6 inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
      >
        <Save className="h-4 w-4" aria-hidden />
        {saving ? "Saving..." : "Save Email Wording"}
      </button>
    </section>
  );
}
