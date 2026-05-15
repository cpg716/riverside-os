import { MapPin, ShieldCheck } from "lucide-react";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

type GeoapifySettingsPanelProps = {
  baseUrl: string;
};

export default function GeoapifySettingsPanel({
  baseUrl,
}: GeoapifySettingsPanelProps) {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="ui-card overflow-hidden p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
              <MapPin className="h-6 w-6" aria-hidden />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
                Address Lookup
              </p>
              <h2 className="mt-1 text-3xl font-black italic uppercase tracking-tighter text-app-text">
                Geoapify
              </h2>
              <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-app-text-muted">
                Geoapify powers address typeahead across customer, vendor, and
                shipping entry. Shippo still validates the selected address
                before ROS uses it for shipping.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-xs font-black uppercase tracking-widest text-app-success">
            Settings Managed
          </div>
        </div>
      </header>

      <IntegrationCredentialsCard
        baseUrl={baseUrl}
        integrationKey="geoapify"
        title="Geoapify Credentials"
        description="Save the Geoapify API key here. Address search reads this encrypted Settings value; staff do not need access to server environment files."
        fields={[
          {
            key: "api_key",
            label: "API Key",
            type: "password",
            help: "Required for address suggestions near Riverside ZIP 14043.",
          },
        ]}
      />

      <section className="rounded-2xl border border-app-border bg-app-surface p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-success">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h3 className="text-xs font-black uppercase tracking-widest text-app-text">
              Validation Flow
            </h3>
            <p className="mt-1 text-sm font-semibold leading-6 text-app-text-muted">
              Geoapify suggests matching addresses. Shippo remains the address
              validation layer before shipping labels and customer shipping
              records are saved.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
