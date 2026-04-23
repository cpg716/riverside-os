import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Package, RefreshCw, Save, Truck } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

interface ShippoAddressFields {
  name: string;
  street1: string;
  street2?: string | null;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone: string;
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
      toast("Communication error with server", "error");
    } finally {
      setBusy(false);
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
            className="inline-flex rounded-2xl border border-lime-500/20 bg-white px-4 py-2 shadow-sm"
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
        className="ui-card max-w-5xl space-y-8 border-lime-500/20 bg-gradient-to-br from-lime-500/5 to-transparent p-8 shadow-xl"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-lime-500/15 text-lime-700 shadow-inner">
              <Truck className="h-7 w-7" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Shippo Carrier Status
              </h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-app-text-muted">
                Live rate quoting and label purchase run through Shippo when the
                store enables shipping and the server host has the required
                environment token.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
                settings.api_token_configured
                  ? "bg-emerald-500/10 text-emerald-600"
                  : "bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {settings.api_token_configured
                ? "API token ready"
                : "Token missing"}
            </span>
            <span
              className={`ui-pill text-[10px] font-black uppercase tracking-widest ${
                settings.webhook_secret_configured
                  ? "bg-sky-500/10 text-sky-600"
                  : "bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {settings.webhook_secret_configured
                ? "Webhook secret ready"
                : "Webhook optional"}
            </span>
            <button
              type="button"
              onClick={() => void fetchSettings()}
              className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex cursor-pointer items-center gap-4 rounded-2xl border border-app-border bg-app-surface-2/80 p-5 transition-all hover:border-lime-500/50">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-lg border-2 transition-all ${
                settings.enabled
                  ? "border-lime-500 bg-lime-500 text-white"
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
            <span className="text-sm font-black uppercase tracking-widest text-app-text">
              Enable shipping workflows
            </span>
          </label>

          <label className="flex cursor-pointer items-center gap-4 rounded-2xl border border-app-border bg-app-surface-2/80 p-5 transition-all hover:border-lime-500/50">
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-lg border-2 transition-all ${
                settings.live_rates_enabled
                  ? "border-lime-500 bg-lime-500 text-white"
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
            <span className="text-sm font-black uppercase tracking-widest text-app-text">
              Prefer live carrier rates
            </span>
          </label>
        </div>

        <section className="space-y-4 rounded-2xl border border-app-border bg-app-surface/50 p-6">
          <div className="flex items-center gap-3">
            <IntegrationBrandLogo
              brand="shippo"
              kind="icon"
              className="inline-flex rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-black/5"
              imageClassName="h-6 w-6 object-contain"
            />
            <div>
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">
                From Address
              </h4>
              <p className="mt-1 text-xs text-app-text-muted">
                Default origin used for Shippo rates and label purchase.
              </p>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {[
              ["name", "Sender / location name"],
              ["street1", "Street 1"],
              ["street2", "Street 2"],
              ["city", "City"],
              ["state", "State"],
              ["zip", "ZIP"],
              ["country", "Country"],
              ["phone", "Phone"],
            ].map(([key, label]) => (
              <label key={key} className="block">
                <span className="mb-2 ml-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
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
        </section>

        <section className="space-y-4 rounded-2xl border border-app-border bg-app-surface/50 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-lime-500/15 text-lime-700">
              <Package className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text">
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
                <span className="mb-2 ml-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
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
            className="ui-btn-primary inline-flex h-12 items-center gap-2 px-8 text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-lime-500/20"
          >
            <Save className="h-4 w-4" />
            {busy ? "Applying..." : "Save Shippo settings"}
          </button>
          <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
            Server env still controls API token and webhook secret.
          </p>
        </div>
      </form>
    </div>
  );
}
