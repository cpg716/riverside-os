import { RefreshCw } from "lucide-react";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

type CoreCardSettingsPanelProps = {
  baseUrl: string;
};

export default function CoreCardSettingsPanel({
  baseUrl,
}: CoreCardSettingsPanelProps) {
  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-2">
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="corecredit"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-app-border bg-white px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic uppercase tracking-tighter text-app-text">
          CoreCard / CoreCredit
        </h2>
        <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
          Configure the server-side financing host used by RMS Charge,
          customer-linked CoreCredit accounts, CoreCard posting, and payment
          update verification.
        </p>
      </header>

      <section className="ui-card max-w-5xl space-y-6 border-app-accent/20 bg-app-surface p-8 shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-app-surface-2 shadow-inner ring-1 ring-app-border">
              <IntegrationBrandLogo
                brand="corecredit"
                kind="icon"
                className="inline-flex"
                imageClassName="h-9 w-9 object-contain"
              />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Host Connection
              </h3>
              <p className="mt-1 max-w-2xl text-xs font-semibold leading-5 text-app-text-muted">
                Credential changes affect future CoreCard requests. Existing
                RMS Charge records and reconciliation history are not changed.
                CoreCard runtime configuration is loaded when the server
                starts, so live CoreCard requests may need a server restart
                before newly saved credentials are used.
              </p>
            </div>
          </div>
          <span className="ui-pill inline-flex items-center gap-2 bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <RefreshCw className="h-3 w-3" aria-hidden />
            Server-side only
          </span>
        </div>

        <IntegrationCredentialsCard
          baseUrl={baseUrl}
          integrationKey="corecard"
          title="CoreCard Credentials"
          description="Save, replace, or clear CoreCard credentials here. The browser never receives raw CoreCard credentials. A server restart may be required before live CoreCard requests use newly saved values."
          fields={[
            {
              key: "base_url",
              label: "CoreCard API host",
              type: "url",
              placeholder: "https://...",
              help: "Required for live CoreCard requests.",
            },
            {
              key: "client_id",
              label: "Client ID",
              type: "text",
              help: "Used by the server to request CoreCard access tokens.",
            },
            {
              key: "client_secret",
              label: "Client secret",
              help: "Hidden after save.",
            },
            {
              key: "webhook_secret",
              label: "Payment update signing secret",
              help: "Used to verify inbound CoreCard payment updates.",
            },
          ]}
        />

        <div className="grid gap-4 md:grid-cols-3">
          {[
            {
              label: "Daily work",
              body: "Use Customers and RMS Charge for account linking, posting, exception review, and customer account history.",
            },
            {
              label: "Credential safety",
              body: "Use this Settings page for keys only. Do not paste credentials into notes, customer records, or support chats. Restart the server before validating new live CoreCard credentials.",
            },
            {
              label: "Not changed here",
              body: "Amounts, postings, customer links, and reconciliation records stay under the RMS Charge workflows.",
            },
          ].map((item) => (
            <div
              key={item.label}
              className="rounded-2xl border border-app-border bg-app-surface-2 p-4"
            >
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text">
                {item.label}
              </h4>
              <p className="mt-2 text-xs font-semibold leading-5 text-app-text-muted">
                {item.body}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
