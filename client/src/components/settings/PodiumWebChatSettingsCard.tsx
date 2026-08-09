import { CheckCircle2, MessageSquare, Save } from "lucide-react";
import { useCustomerCommunicationSettings } from "./useCustomerCommunicationSettings";

export default function PodiumWebChatSettingsCard({
  baseUrl,
}: {
  baseUrl: string;
}) {
  const { settings, setSettings, loading, saving, savePatch } =
    useCustomerCommunicationSettings(baseUrl);

  if (loading || !settings) return null;

  return (
    <section className="ui-card p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-app-border pb-4">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-accent">
            <MessageSquare className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Podium web chat
            </h3>
            <p className="mt-1 max-w-3xl text-xs font-semibold leading-5 text-app-text-muted">
              Paste the exact widget snippet supplied by Podium. Riverside only loads it on
              public storefront builds where storefront embeds are enabled.
            </p>
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border-2 ${
              settings.widget_embed_enabled
                ? "border-app-accent bg-app-accent text-white"
                : "border-app-border"
            }`}
          >
            {settings.widget_embed_enabled ? (
              <CheckCircle2 className="h-3 w-3" aria-hidden />
            ) : null}
          </span>
          <input
            type="checkbox"
            checked={settings.widget_embed_enabled}
            onChange={(event) =>
              setSettings((current) =>
                current
                  ? { ...current, widget_embed_enabled: event.target.checked }
                  : current,
              )
            }
            className="sr-only"
          />
          <span className="text-[10px] font-black uppercase tracking-widest text-app-text">
            Enable widget
          </span>
        </label>
      </div>
      <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        Podium embed snippet
        <textarea
          value={settings.widget_snippet_html}
          onChange={(event) =>
            setSettings((current) =>
              current
                ? { ...current, widget_snippet_html: event.target.value }
                : current,
            )
          }
          placeholder="Paste the snippet copied from the Podium dashboard"
          className="ui-input mt-2 min-h-36 w-full resize-y p-3 font-mono text-xs font-medium normal-case tracking-normal"
        />
      </label>
      <button
        type="button"
        disabled={saving || (settings.widget_embed_enabled && !settings.widget_snippet_html.trim())}
        onClick={() =>
          void savePatch(
            {
              widget_embed_enabled: settings.widget_embed_enabled,
              widget_snippet_html: settings.widget_snippet_html,
            },
            "Podium web chat settings saved.",
          )
        }
        className="ui-btn-primary mt-5 inline-flex h-11 items-center gap-2 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
      >
        <Save className="h-4 w-4" aria-hidden />
        {saving ? "Saving..." : "Save Web Chat"}
      </button>
    </section>
  );
}
