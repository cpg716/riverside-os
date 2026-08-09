import { CheckCircle2, Save, Send } from "lucide-react";
import type { ReceiptMessageTemplates } from "./useCustomerCommunicationSettings";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

type TemplateKey = keyof ReceiptMessageTemplates;

const FIELDS: Array<[TemplateKey, string]> = [
  ["sms_caption", "Receipt MMS caption"],
  ["gift_sms_caption", "Gift receipt MMS caption"],
  ["email_subject", "Receipt email subject"],
  ["gift_email_subject", "Gift receipt email subject"],
];

export default function ReceiptDeliverySettingsCard({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { settings, setSettings, loading, saving, savePatch } =
    useCustomerCommunicationSettings(baseUrl);

  const updateTemplate = (key: TemplateKey, value: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            receipt_templates: { ...current.receipt_templates, [key]: value },
          }
        : current,
    );
  };

  if (loading || !settings) return null;

  const allInherited = Object.values(settings.receipt_templates).every(
    (value) => !value.trim(),
  );

  return (
    <section className="ui-card p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-accent">
            <Send className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Digital receipt delivery
            </h3>
            <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-app-text-muted">
              Podium sends text and image receipts; Store Email sends email receipts. The
              authoritative receipt content remains in the ReceiptLine templates above.
            </p>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border-2 ${
              settings.sms_features.receipts
                ? "border-app-accent bg-app-accent text-white"
                : "border-app-border"
            }`}
          >
            {settings.sms_features.receipts ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : null}
          </span>
          <input
            type="checkbox"
            checked={settings.sms_features.receipts}
            onChange={(event) =>
              setSettings((current) =>
                current
                  ? {
                      ...current,
                      sms_features: {
                        ...current.sms_features,
                        receipts: event.target.checked,
                      },
                    }
                  : current,
              )
            }
            className="sr-only"
          />
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
            Text receipts enabled
          </span>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {FIELDS.map(([key, label]) => (
          <label
            key={key}
            className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted"
          >
            {label}
            <textarea
              value={settings.receipt_templates[key]}
              placeholder={settings.receipt_templates_effective[key]}
              onChange={(event) => updateTemplate(key, event.target.value)}
              className="ui-input mt-2 min-h-24 w-full resize-y p-3 text-sm font-medium normal-case tracking-normal"
            />
          </label>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            void savePatch(
              {
                sms_features: { receipts: settings.sms_features.receipts },
                receipt_templates: settings.receipt_templates,
              },
              "Digital receipt delivery settings saved.",
            )
          }
          className="ui-btn-primary inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden />
          {saving ? "Saving..." : "Save Delivery Settings"}
        </button>
        <button
          type="button"
          disabled={allInherited}
          onClick={() =>
            setSettings((current) =>
              current
                ? {
                    ...current,
                    receipt_templates: {
                      sms_caption: "",
                      gift_sms_caption: "",
                      email_subject: "",
                      gift_email_subject: "",
                    },
                  }
                : current,
            )
          }
          className="ui-btn-secondary h-11 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
        >
          Use Riverside Defaults
        </button>
      </div>
    </section>
  );
}
