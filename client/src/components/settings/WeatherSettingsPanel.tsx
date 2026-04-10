import React, { useState, useEffect, useCallback } from "react";
import { Cloud, RefreshCw, Save } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

interface WeatherConfig {
  enabled: boolean;
  location: string;
  unit_group: string;
  timezone: string;
  api_key_configured: boolean;
}

interface WeatherSettingsPanelProps {
  baseUrl: string;
}

const WeatherSettingsPanel: React.FC<WeatherSettingsPanelProps> = ({ baseUrl }) => {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [weatherCfg, setWeatherCfg] = useState<WeatherConfig | null>(null);
  const [weatherApiKeyDraft, setWeatherApiKeyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchWeatherConfig = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as WeatherConfig;
        setWeatherCfg(j);
      }
    } catch (err) {
      console.error("Failed to fetch weather config", err);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void fetchWeatherConfig();
  }, [fetchWeatherConfig]);

  const saveWeatherSettings = async () => {
    if (!weatherCfg || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          enabled: weatherCfg.enabled,
          location: weatherCfg.location,
          unit_group: weatherCfg.unit_group,
          timezone: weatherCfg.timezone,
          api_key: weatherApiKeyDraft.trim() || undefined,
        }),
      });
      if (res.ok) {
        toast("Weather configuration updated", "success");
        setWeatherApiKeyDraft("");
        await fetchWeatherConfig();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save weather settings", "error");
      }
    } catch {
      toast("Communication error with server", "error");
    } finally {
      setBusy(false);
    }
  };

  const clearWeatherApiKey = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Server logic: PATCH with api_key: null clears the stored key
      const res = await fetch(`${baseUrl}/api/settings/weather`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ api_key: null }),
      });
      if (res.ok) {
        toast("Weather API key removed (reverted to mock mode)", "success");
        await fetchWeatherConfig();
      } else {
        toast("Failed to clear API key", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  if (!weatherCfg) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Visual Crossing Weather</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Configure live weather snapshots for the dashboard and Golden Rule logs.</p>
      </header>

      <section className="ui-card p-8 max-w-4xl border-sky-500/20 bg-gradient-to-br from-sky-500/5 to-transparent shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-500/15 text-sky-600 shadow-inner">
              <Cloud className="h-7 w-7" aria-hidden />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Weather Provider Status</h3>
              <p className="text-xs text-app-text-muted mt-1 max-w-xl leading-relaxed">
                Dashboard and Golden Rule snapshots use the{" "}
                <a
                  href="https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/"
                  target="_blank"
                  rel="noreferrer"
                  className="font-bold text-sky-600 underline decoration-sky-500/40 hover:decoration-sky-600"
                >
                  Timeline Weather API
                </a>
                . Without a key, the server uses deterministic mock data (Buffalo-style).
              </p>
            </div>
          </div>
          <span className={`ui-pill text-[10px] uppercase font-black tracking-widest ${weatherCfg.api_key_configured ? 'bg-emerald-500/10 text-emerald-600' : 'bg-app-surface-2 text-app-text-muted'}`}>
            {weatherCfg.api_key_configured ? "Live Key Configured" : "Mock Mode Active"}
          </span>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <label className="flex items-center gap-4 rounded-2xl border border-app-border bg-app-surface-2/80 p-5 cursor-pointer hover:border-sky-500/50 transition-all sm:col-span-2">
            <div className={`h-6 w-6 rounded-lg border-2 flex items-center justify-center transition-all ${weatherCfg.enabled ? 'bg-sky-500 border-sky-500 text-white' : 'border-app-border'}`}>
               {weatherCfg.enabled && <Save className="h-3 w-3" />}
            </div>
            <input
              type="checkbox"
              className="sr-only"
              checked={weatherCfg.enabled}
              onChange={(e) =>
                setWeatherCfg({ ...weatherCfg, enabled: e.target.checked })
              }
            />
            <span className="text-sm font-black uppercase tracking-widest text-app-text">Enable live Visual Crossing synchronization</span>
          </label>

          <div className="sm:col-span-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">
              Location Identity (Address, City, or Lat/Lon)
            </label>
            <input
              className="ui-input w-full px-4 py-3 text-sm font-bold tracking-tight bg-app-bg"
              value={weatherCfg.location}
              onChange={(e) =>
                setWeatherCfg({ ...weatherCfg, location: e.target.value })
              }
              placeholder="e.g. Buffalo,NY,US"
            />
          </div>

          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">
              System Units
            </label>
            <select
              className="ui-input w-full px-4 py-3 text-sm font-bold bg-app-bg cursor-pointer"
              value={weatherCfg.unit_group}
              onChange={(e) =>
                setWeatherCfg({ ...weatherCfg, unit_group: e.target.value })
              }
            >
              <option value="us">US Imperial (°F, Inches)</option>
              <option value="metric">Metric (Auto-converted to ROS standard)</option>
            </select>
          </div>

          <div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">
              Regional Timezone (IANA)
            </label>
            <input
              className="ui-input w-full px-4 py-3 font-mono text-xs tracking-tight bg-app-bg"
              value={weatherCfg.timezone}
              onChange={(e) =>
                setWeatherCfg({ ...weatherCfg, timezone: e.target.value })
              }
              placeholder="e.g. America/New_York"
            />
          </div>

          <div className="sm:col-span-2 pt-4 border-t border-app-border/40 mt-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2 ml-1">
              Visual Crossing API Key {weatherCfg.api_key_configured ? "(Encrypted on server)" : ""}
            </label>
            <input
              type="password"
              className="ui-input w-full px-4 py-3 text-sm font-mono tracking-widest bg-app-bg"
              value={weatherApiKeyDraft}
              onChange={(e) => setWeatherApiKeyDraft(e.target.value)}
              placeholder={weatherCfg.api_key_configured ? "••••••••••••••••" : "Paste your Timeline API key here"}
              autoComplete="off"
            />
            <p className="text-[9px] text-app-text-muted mt-2 font-bold uppercase tracking-wider italic opacity-60 px-1">
              Your key is relayed only to Visual Crossing and never exposed via client-side configuration.
            </p>
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => void saveWeatherSettings()}
            className="ui-btn-primary h-12 px-8 text-[11px] font-black uppercase tracking-[0.2em] shadow-lg shadow-sky-500/20 hover:scale-[1.02] transition-all"
          >
            {busy ? "Applying..." : "Commite configuration"}
          </button>
          
          {weatherCfg.api_key_configured && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearWeatherApiKey()}
              className="h-12 px-6 rounded-2xl border-2 border-rose-500/20 text-rose-600 text-[11px] font-black uppercase tracking-[0.15em] hover:bg-rose-500 hover:text-white hover:border-rose-500 transition-all"
            >
              Remove Provisioned Key
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

export default WeatherSettingsPanel;
