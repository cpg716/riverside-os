import { CheckCircle2, Info, Save } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import type {
  CustomerCommunicationPatch,
  CustomerCommunicationSettings,
  SmsFeatureSettings,
  SmsTemplates,
} from "./useCustomerCommunicationSettings";

type SmsTemplateKey = keyof SmsTemplates;
type SmsFeatureKey = keyof SmsFeatureSettings;

const SMS_TEMPLATE_BLOCKS: Array<{
  key: SmsTemplateKey;
  featureKey: SmsFeatureKey;
  label: string;
  description: string;
  tokens: string[];
}> = [
  {
    key: "ready_for_pickup",
    featureKey: "ready_for_pickup",
    label: "Ready for pickup",
    description: "Sent when Transaction items are ready for pickup.",
    tokens: ["{first_name}", "{transaction_ref}", "{store_phone}"],
  },
  {
    key: "alteration_ready",
    featureKey: "alteration_ready",
    label: "Alteration ready",
    description: "Sent when alteration work is ready.",
    tokens: ["{first_name}", "{alteration_ref}", "{store_phone}"],
  },
  {
    key: "appointment_confirmation",
    featureKey: "appointment_confirmation",
    label: "Appointment confirmation",
    description: "Sent after a customer appointment is created.",
    tokens: ["{first_name}", "{appointment_type}", "{starts_at}"],
  },
  {
    key: "appointment_reminder",
    featureKey: "appointment_reminder",
    label: "Appointment reminder",
    description: "Sent by the appointment reminder worker.",
    tokens: ["{first_name}", "{appointment_type}", "{starts_at}"],
  },
  {
    key: "unknown_sender_welcome",
    featureKey: "unknown_sender_welcome",
    label: "New text sender",
    description: "Sent once after the first inbound text from a number not yet linked to a customer.",
    tokens: [],
  },
];

type Props = {
  settings: CustomerCommunicationSettings;
  setSettings: Dispatch<SetStateAction<CustomerCommunicationSettings | null>>;
  savePatch: (
    patch: CustomerCommunicationPatch,
    successMessage: string,
  ) => Promise<boolean>;
  saving: boolean;
};

export default function PodiumSmsSettingsCard({
  settings,
  setSettings,
  savePatch,
  saving,
}: Props) {
  const updateFeature = (key: SmsFeatureKey, value: boolean) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            sms_features: { ...current.sms_features, [key]: value },
          }
        : current,
    );
  };

  const updateTemplate = (key: SmsTemplateKey, value: string) => {
    setSettings((current) =>
      current
        ? { ...current, templates: { ...current.templates, [key]: value } }
        : current,
    );
  };

  const insertToken = (key: SmsTemplateKey, token: string) => {
    const current = settings.templates[key];
    updateTemplate(
      key,
      current.trimEnd() ? `${current.trimEnd()} ${token}` : token,
    );
  };

  return (
    <section className="ui-card max-w-5xl p-6">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-5">
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Podium text messaging
          </h3>
          <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-app-text-muted">
            Each workflow is independent. Blank message fields inherit the Riverside default,
            so default wording stays centrally maintained.
          </p>
        </div>
        <Info className="h-4 w-4 text-app-text-muted" aria-hidden />
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        {([["staff_messages", "Staff-authored texts"]] as Array<
          [SmsFeatureKey, string]
        >).map(([key, label]) => (
          <FeatureToggle
            key={key}
            checked={settings.sms_features[key]}
            label={label}
            onChange={(checked) => updateFeature(key, checked)}
          />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {SMS_TEMPLATE_BLOCKS.map((block) => {
          const inherited = !settings.templates[block.key].trim();
          return (
            <div key={block.key} className="rounded-2xl border border-app-border bg-app-surface-2/60 p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                    {block.label}
                  </h4>
                  <p className="mt-1 text-xs font-medium leading-5 text-app-text-muted">
                    {block.description}
                  </p>
                </div>
                <FeatureToggle
                  checked={settings.sms_features[block.featureKey]}
                  label="Enabled"
                  compact
                  onChange={(checked) => updateFeature(block.featureKey, checked)}
                />
              </div>

              {block.tokens.length > 0 ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {block.tokens.map((token) => (
                    <button
                      key={token}
                      type="button"
                      onClick={() => insertToken(block.key, token)}
                      className="rounded-full border border-app-border bg-app-surface px-2.5 py-1 text-[9px] font-black text-app-text-muted hover:border-app-accent hover:text-app-accent"
                    >
                      {token}
                    </button>
                  ))}
                </div>
              ) : null}

              <textarea
                value={settings.templates[block.key]}
                placeholder={settings.templates_effective[block.key]}
                onChange={(event) => updateTemplate(block.key, event.target.value)}
                className="ui-input mt-4 min-h-28 w-full resize-y p-3 text-sm"
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                  {inherited ? "Using Riverside default" : "Custom wording"}
                </span>
                <button
                  type="button"
                  disabled={inherited}
                  onClick={() => updateTemplate(block.key, "")}
                  className="text-[9px] font-black uppercase tracking-widest text-app-accent disabled:opacity-40"
                >
                  Use default
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() =>
          void savePatch(
            {
              sms_features: {
                staff_messages: settings.sms_features.staff_messages,
                ready_for_pickup: settings.sms_features.ready_for_pickup,
                alteration_ready: settings.sms_features.alteration_ready,
                appointment_confirmation:
                  settings.sms_features.appointment_confirmation,
                appointment_reminder: settings.sms_features.appointment_reminder,
                unknown_sender_welcome:
                  settings.sms_features.unknown_sender_welcome,
              },
              templates: settings.templates,
            },
            "Podium text settings saved.",
          )
        }
        className="ui-btn-primary mt-6 inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
      >
        <Save className="h-4 w-4" aria-hidden />
        {saving ? "Saving..." : "Save Text Settings"}
      </button>
    </section>
  );
}

function FeatureToggle({
  checked,
  label,
  compact = false,
  onChange,
}: {
  checked: boolean;
  label: string;
  compact?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface p-3 ${
        compact ? "shrink-0" : ""
      }`}
    >
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
        onChange={(event) => onChange(event.target.checked)}
        className="sr-only"
      />
      <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
        {label}
      </span>
    </label>
  );
}
