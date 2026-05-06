import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import IntegrationCredentialsCard from "./IntegrationCredentialsCard";

type CoreCardSettingsPanelProps = {
  baseUrl: string;
};

type CoreCardReadinessStatus = {
  credentials_saved: boolean;
  configured: Record<string, boolean>;
  credential_source: "encrypted_settings" | "env" | "missing" | string;
  runtime_config_loaded: boolean;
  restart_required: boolean;
  live_read_confirmed: boolean;
  warning_codes?: string[];
  environment: string;
  region: string;
  masked_base_url?: string | null;
  merchant_number?: string | null;
  merchant_id?: string | null;
  tenant_probe_path_configured?: boolean;
  webhook_secret_configured: boolean;
  webhook_unsigned_allowed: boolean;
  repair_polling_enabled: boolean;
  repair_poll_secs: number;
  last_repair_poll_at?: string | null;
  last_corecard_request_at?: string | null;
};

type CoreCardTenantProbeStatus = {
  configured: boolean;
  runtime_loaded: boolean;
  merchant_number?: string | null;
  merchant_id?: string | null;
  source: "corecard_live" | "manual" | "local_fallback" | "unavailable" | string;
  last_checked_at: string;
  masked_base_url?: string | null;
  api_host_reachable: boolean;
  read_call_succeeded: boolean;
  warning_codes?: string[];
};

function fmtDate(value?: string | null) {
  if (!value) return "Not recorded";
  return new Date(value).toLocaleString();
}

function statusTone(ok: boolean) {
  return ok
    ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-800"
    : "border-amber-300/50 bg-amber-500/10 text-amber-800";
}

export default function CoreCardSettingsPanel({
  baseUrl,
}: CoreCardSettingsPanelProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const [readiness, setReadiness] = useState<CoreCardReadinessStatus | null>(null);
  const [probe, setProbe] = useState<CoreCardTenantProbeStatus | null>(null);
  const [readinessError, setReadinessError] = useState("");
  const [probeBusy, setProbeBusy] = useState(false);

  const loadReadiness = useCallback(async () => {
    try {
      setReadinessError("");
      const res = await fetch(`${baseUrl}/api/settings/corecard/readiness`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "CoreCard status could not load.");
      }
      setReadiness((await res.json()) as CoreCardReadinessStatus);
    } catch (error) {
      setReadinessError(error instanceof Error ? error.message : "CoreCard status could not load.");
    }
  }, [backofficeHeaders, baseUrl]);

  const runTenantProbe = useCallback(async () => {
    try {
      setProbeBusy(true);
      setReadinessError("");
      const res = await fetch(`${baseUrl}/api/settings/corecard/tenant-probe`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "CoreCard tenant probe could not run.");
      }
      setProbe((await res.json()) as CoreCardTenantProbeStatus);
      await loadReadiness();
    } catch (error) {
      setReadinessError(
        error instanceof Error ? error.message : "CoreCard tenant probe could not run.",
      );
    } finally {
      setProbeBusy(false);
    }
  }, [backofficeHeaders, baseUrl, loadReadiness]);

  useEffect(() => {
    void loadReadiness();
  }, [loadReadiness]);

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

        <section className="rounded-2xl border border-app-border bg-app-bg p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                Pre-Live Proof
              </h4>
              <p className="mt-1 max-w-2xl text-xs font-semibold leading-5 text-app-text-muted">
                These indicators prove whether the running server is using live
                manual RMS Charge is active by default. These indicators show
                whether optional live CoreCard reads are also validated.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void runTenantProbe()}
              disabled={probeBusy}
              className="ui-btn-secondary inline-flex min-h-9 items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              {probeBusy ? "Checking..." : "Run Probe"}
            </button>
          </div>

          {readinessError ? (
            <div className="mt-4 rounded-xl border border-amber-300/40 bg-amber-500/10 p-3 text-sm font-semibold text-amber-800">
              {readinessError}
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {[
              ["Saved credentials", readiness?.credentials_saved ? "Saved" : "Missing", Boolean(readiness?.credentials_saved)],
              ["Runtime config", readiness?.runtime_config_loaded ? "Loaded" : "Not loaded", Boolean(readiness?.runtime_config_loaded)],
              ["Restart state", readiness?.restart_required ? "Restart required" : "Current", !readiness?.restart_required],
              ["Tenant probe", probe?.source === "corecard_live" ? "Live CoreCard read confirmed" : probe ? "Manual workflow active" : "Not validated yet", probe?.source === "corecard_live"],
            ].map(([label, value, ok]) => (
              <div key={String(label)} className={`rounded-xl border p-4 ${statusTone(Boolean(ok))}`}>
                <div className="text-[10px] font-black uppercase tracking-widest">
                  {label}
                </div>
                <div className="mt-2 text-sm font-black">{value}</div>
              </div>
            ))}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-4 text-xs font-semibold leading-5 text-app-text-muted">
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Runtime Details
              </div>
              <div>Credential source: {readiness?.credential_source ?? "unknown"}</div>
              <div>CoreCard host: {readiness?.masked_base_url ?? "Not loaded"}</div>
              <div>Environment: {readiness?.environment ?? "unknown"} / {readiness?.region ?? "unknown"}</div>
              <div>Merchant Number: {readiness?.merchant_number ?? "Not configured"}</div>
              <div>Merchant ID: {readiness?.merchant_id ?? "Not configured"}</div>
              <div>Tenant probe path: {readiness?.tenant_probe_path_configured ? "Configured" : "Default read-only path"}</div>
              <div>Last live read: {fmtDate(readiness?.last_corecard_request_at)}</div>
              <div>Last tenant probe: {fmtDate(probe?.last_checked_at)}</div>
              <div>Probe source: {probe?.source ?? "Not run"}</div>
              <div>Repair polling: {readiness?.repair_polling_enabled ? `${readiness.repair_poll_secs}s` : "Not enabled"}</div>
              <div>Last repair poll: {fmtDate(readiness?.last_repair_poll_at)}</div>
            </div>

            <div className={`rounded-xl border p-4 text-xs font-semibold leading-5 ${
              readiness?.webhook_unsigned_allowed
                ? "border-rose-300/50 bg-rose-500/10 text-rose-800"
                : "border-app-border bg-app-surface-2 text-app-text-muted"
            }`}>
              <div className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                Warnings
              </div>
              <div>Webhook secret: {readiness?.webhook_secret_configured ? "Configured" : "Missing"}</div>
              <div>Unsigned webhooks: {readiness?.webhook_unsigned_allowed ? "Enabled" : "Disabled"}</div>
              {probe ? (
                <>
                  <div>API host reachable: {probe.api_host_reachable ? "Yes" : "No"}</div>
                  <div>Read call: {probe.read_call_succeeded ? "Succeeded" : "Not confirmed"}</div>
                </>
              ) : null}
              {((readiness?.warning_codes?.length ?? 0) + (probe?.warning_codes?.length ?? 0)) > 0 ? (
                <div className="mt-2 font-mono text-[11px]">
                  {[...(readiness?.warning_codes ?? []), ...(probe?.warning_codes ?? [])].join(", ")}
                </div>
              ) : (
                <div className="mt-2">No readiness warnings reported.</div>
              )}
            </div>
          </div>
        </section>

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
            {
              key: "merchant_number",
              label: "Merchant Number",
              type: "text",
              placeholder: "12115",
              help: "Riverside Men's Shop merchant number under R2S Financial.",
            },
            {
              key: "merchant_id",
              label: "Merchant ID",
              type: "text",
              placeholder: "11324",
              help: "Riverside Men's Shop merchant ID under R2S Financial.",
            },
            {
              key: "tenant_probe_path",
              label: "Tenant probe path",
              type: "text",
              placeholder: "/merchants/{merchant_id}/status",
              help: "Optional read-only path for CoreCard tenant validation.",
            },
          ]}
          onSaved={async () => {
            setProbe(null);
            await loadReadiness();
          }}
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
