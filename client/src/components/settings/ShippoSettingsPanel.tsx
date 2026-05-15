import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Package, RefreshCw, Save, Truck } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";

interface ShippoAddressFields {
  name: string;
  company?: string | null;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
  email?: string | null;
  is_residential?: boolean | null;
}

interface DefaultParcel {
  length_in: string | number;
  width_in: string | number;
  height_in: string | number;
  weight_oz: string | number;
}

interface ShippoSettingsResponse {
  enabled: boolean;
  live_rates_enabled: boolean;
  from_address: ShippoAddressFields;
  default_parcel: DefaultParcel;
  api_token_configured: boolean;
  webhook_secret_configured: boolean;
}

interface ShippoSettingsPanelProps {
  baseUrl: string;
}

function decimalInputValue(value: string | number | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

function decimalPayloadValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function ShippoSettingsPanel({
  baseUrl,
}: ShippoSettingsPanelProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [settings, setSettings] = useState<ShippoSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/shippo`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        setSettings((await res.json()) as ShippoSettingsResponse);
      }
    } catch (err) {
      console.error("Failed to fetch Shippo settings", err);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchSettings();
  }, [fetchSettings]);

  const saveSettings = async () => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/shippo`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          enabled: settings.enabled,
          live_rates_enabled: settings.live_rates_enabled,
          from_address: settings.from_address,
          default_parcel: {
            length_in: decimalPayloadValue(
              decimalInputValue(settings.default_parcel.length_in),
            ),
            width_in: decimalPayloadValue(
              decimalInputValue(settings.default_parcel.width_in),
            ),
            height_in: decimalPayloadValue(
              decimalInputValue(settings.default_parcel.height_in),
            ),
            weight_oz: decimalPayloadValue(
              decimalInputValue(settings.default_parcel.weight_oz),
            ),
          },
        }),
      });
      if (res.ok) {
        toast("Shippo configuration updated", "success");
        setSettings((await res.json()) as ShippoSettingsResponse);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save Shippo settings", "error");
      }
    } catch {
      toast("Shipping settings are unavailable right now.", "error");
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    if (testBusy) return;
    setTestBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/shippo/test-connection`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      const j = (await res.json().catch(() => ({}))) as {
        object_id?: string | null;
        is_complete?: boolean | null;
        error?: string;
      };
      if (!res.ok) {
        toast(j.error ?? "Shippo connection test failed", "error");
        return;
      }
      toast(
        j.is_complete === false
          ? "Shippo answered, but the origin address needs review."
          : "Shippo connection verified",
        j.is_complete === false ? "info" : "success",
      );
    } catch {
      toast("Shippo connection test is unavailable right now.", "error");
    } finally {
      setTestBusy(false);
    }
  };

  if (!settings) {
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
            brand="shippo"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-app-success/20 bg-app-surface px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
          Shipping Configuration
        </h2>
        <p className="mt-2 text-sm font-medium text-app-text-muted">
          Manage live carrier rates, Shippo-ready origin details, and the
          default parcel profile used by shipping workflows.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void saveSettings();
        }}
        className="ui-card max-w-5xl space-y-8 border-app-success/20 bg-app-surface p-8 shadow-xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-app-success/10 text-app-success shadow-inner">
              <Truck className="h-7 w-7" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Shippo Carrier Status
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Live rate quoting and label purchase run through Shippo when the
                store enables shipping and the carrier connection is ready.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`ui-pill text-xs font-bold ${
                settings.api_token_configured
                  ? "bg-app-success/10 text-app-success"
                  : "bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {settings.api_token_configured
                ? "Connection ready"
                : "Connection needed"}
            </span>
            <span
              className={`ui-pill text-xs font-bold ${
                settings.webhook_secret_configured
                  ? "bg-app-info/10 text-app-info"
                  : "bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {settings.webhook_secret_configured
                ? "Notifications ready"
                : "Notifications optional"}
            </span>
            <button
              type="button"
              onClick={() => void fetchSettings()}
              className="ui-btn-secondary inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-bold"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => void testConnection()}
              disabled={testBusy}
              className="ui-btn-secondary inline-flex min-h-11 items-center gap-2 px-4 py-2 text-sm font-bold disabled:opacity-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {testBusy ? "Testing..." : "Test connection"}
            </button>
          </div>
        </div>

        <IntegrationCredentialsCard
          baseUrl={baseUrl}
          integrationKey="shippo"
          title="Shippo Credentials"
          description="Save the Shippo API token and optional update signing secret here. Staff do not need access to server environment files."
          fields={[
            {
              key: "api_token",
              label: "API token",
              help: "Required for live rates and label purchase.",
            },
            {
              key: "webhook_secret",
              label: "Webhook signing secret",
              help: "Optional unless Shippo updates are verified by signature.",
            },
          ]}
          onSaved={fetchSettings}
        />

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-4 rounded-2xl border border-app-border bg-app-surface-2 p-5 transition-all hover:border-app-success/30">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-lg border-2 transition-all ${
                settings.enabled
                  ? "border-app-success bg-app-success text-white"
                  : "border-app-border"
              }`}
            >
              {settings.enabled && <CheckCircle2 className="h-3 w-3" />}
            </div>
            <input
              type="checkbox"
              className="sr-only"
              checked={settings.enabled}
              onChange={(e) =>
                setSettings({ ...settings, enabled: e.target.checked })
              }
            />
              <span className="text-sm font-black text-app-text">
              Enable shipping workflows
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-4 rounded-2xl border border-app-border bg-app-surface-2 p-5 transition-all hover:border-app-success/30">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-lg border-2 transition-all ${
                settings.live_rates_enabled
                  ? "border-app-success bg-app-success text-white"
                  : "border-app-border"
              }`}
            >
              {settings.live_rates_enabled && <CheckCircle2 className="h-3 w-3" />}
            </div>
            <input
              type="checkbox"
              className="sr-only"
              checked={settings.live_rates_enabled}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  live_rates_enabled: e.target.checked,
                })
              }
            />
              <span className="text-sm font-black text-app-text">
              Prefer live carrier rates
            </span>
          </label>
        </div>

        <section className="space-y-4 rounded-2xl border border-app-border bg-app-surface p-6">
          <div className="flex items-center gap-3">
            <IntegrationBrandLogo
              brand="shippo"
              kind="icon"
              className="inline-flex rounded-xl bg-app-surface-2 p-1.5 shadow-sm ring-1 ring-app-border"
              imageClassName="h-6 w-6 object-contain"
            />
            <div>
	              <h4 className="text-sm font-black text-app-text">
                From Address
              </h4>
              <p className="mt-1 text-xs text-app-text-muted">
                Default origin used for Shippo rates and label purchase.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <AddressAutocompleteInput
              className="md:col-span-2"
              label="Street 1"
              value={settings.from_address.street1}
              inputClassName="ui-input w-full bg-app-bg px-4 py-3 text-sm font-medium"
              validationContext={{
                name: settings.from_address.name,
                company: settings.from_address.company ?? undefined,
                address_line2: settings.from_address.street2 ?? undefined,
                country: settings.from_address.country,
                phone: settings.from_address.phone,
                email: settings.from_address.email ?? undefined,
                is_residential: !!settings.from_address.is_residential,
              }}
              onChange={(value) =>
                setSettings({
                  ...settings,
                  from_address: {
                    ...settings.from_address,
                    street1: value,
                  },
                })
              }
              onSelectAddress={(suggestion) =>
                setSettings({
                  ...settings,
                  from_address: {
                    ...settings.from_address,
                    street1: suggestion.address_line1,
                    city: suggestion.city,
                    state: suggestion.state,
                    zip: suggestion.postal_code,
                    country: suggestion.country || settings.from_address.country || "US",
                  },
                })
              }
            />
            {[
              ["name", "Sender / location name"],
              ["company", "Company"],
              ["street2", "Street 2"],
              ["city", "City"],
              ["state", "State"],
              ["zip", "ZIP"],
              ["country", "Country"],
              ["phone", "Phone"],
              ["email", "Email"],
            ].map(([key, label]) => (
              <label key={key} className="block">
	                <span className="mb-2 ml-1 block text-xs font-bold text-app-text-muted">
                  {label}
                </span>
                <input
                  className="ui-input w-full bg-app-bg px-4 py-3 text-sm font-medium"
                  value={String(
                    settings.from_address[
                      key as keyof ShippoAddressFields
                    ] ?? "",
                  )}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      from_address: {
                        ...settings.from_address,
                        [key]: e.target.value,
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
            <input
              type="checkbox"
              className="rounded border-app-border"
              checked={!!settings.from_address.is_residential}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  from_address: {
                    ...settings.from_address,
                    is_residential: e.target.checked,
                  },
                })
              }
            />
            <span className="text-xs font-bold text-app-text-muted">
              Origin is a residential address
            </span>
          </label>
        </section>

        <section className="space-y-4 rounded-2xl border border-app-border bg-app-surface p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-app-success/10 text-app-success">
              <Package className="h-5 w-5" aria-hidden />
            </div>
            <div>
	              <h4 className="text-sm font-black text-app-text">
                Default Parcel
              </h4>
              <p className="mt-1 text-xs text-app-text-muted">
                Used when checkout or the Shipments Hub requests quotes without
                a custom package profile.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["length_in", "Length (in)"],
              ["width_in", "Width (in)"],
              ["height_in", "Height (in)"],
              ["weight_oz", "Weight (oz)"],
            ].map(([key, label]) => (
              <label key={key} className="block">
	                <span className="mb-2 ml-1 block text-xs font-bold text-app-text-muted">
                  {label}
                </span>
                <input
                  inputMode="decimal"
                  className="ui-input w-full bg-app-bg px-4 py-3 text-sm font-medium"
                  value={decimalInputValue(
                    settings.default_parcel[key as keyof DefaultParcel],
                  )}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      default_parcel: {
                        ...settings.default_parcel,
                        [key]: e.target.value,
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap items-center gap-4 border-t border-app-border/40 pt-6">
          <button
            type="submit"
            disabled={busy}
	            className="ui-btn-primary inline-flex min-h-12 items-center gap-2 px-8 text-sm font-black shadow-lg shadow-lime-500/20"
          >
            <Save className="h-4 w-4" />
            {busy ? "Applying..." : "Save Shippo settings"}
          </button>
          <p className="text-xs font-semibold text-app-text-muted">
	            Private connection keys are managed above and hidden after save.
          </p>
        </div>
      </form>
    </div>
  );
}
