import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

type CredentialStatusResponse = {
  integration_key: string;
  supported_keys: string[];
  configured: Record<string, boolean>;
};

export type IntegrationCredentialField = {
  key: string;
  label: string;
  placeholder?: string;
  help?: string;
  type?: "password" | "url" | "text" | "textarea";
};

type IntegrationCredentialsCardProps = {
  baseUrl: string;
  integrationKey: string;
  title: string;
  description: string;
  fields: IntegrationCredentialField[];
  onSaved?: () => void | Promise<void>;
};

export default function IntegrationCredentialsCard({
  baseUrl,
  integrationKey,
  title,
  description,
  fields,
  onSaved,
}: IntegrationCredentialsCardProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<CredentialStatusResponse | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [clearConfirmKey, setClearConfirmKey] = useState<string | null>(null);

  const configured = status?.configured ?? {};
  const hasDraft = useMemo(
    () => fields.some((field) => (draft[field.key] ?? "").trim().length > 0),
    [draft, fields],
  );

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/integration-credentials/${integrationKey}`,
        {
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (res.ok) {
        setStatus((await res.json()) as CredentialStatusResponse);
      }
    } catch (error) {
      console.error(`Failed to load ${integrationKey} credential status`, error);
    }
  }, [backofficeHeaders, baseUrl, integrationKey]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const saveCredentials = async () => {
    if (busy || !hasDraft) return;
    setBusy(true);
    try {
      const credentials: Record<string, string> = {};
      for (const field of fields) {
        const value = (draft[field.key] ?? "").trim();
        if (value) credentials[field.key] = value;
      }
      const res = await fetch(
        `${baseUrl}/api/settings/integration-credentials/${integrationKey}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ credentials }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save credentials", "error");
        return;
      }
      setStatus((await res.json()) as CredentialStatusResponse);
      setDraft({});
      await onSaved?.();
      toast(`${title} credentials saved`, "success");
    } catch {
      toast("Credential settings are unavailable right now.", "error");
    } finally {
      setBusy(false);
    }
  };

  const clearCredential = async (credentialKey: string) => {
    if (busy) return;
    if (clearConfirmKey !== credentialKey) {
      setClearConfirmKey(credentialKey);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/integration-credentials/${integrationKey}/${credentialKey}`,
        {
          method: "DELETE",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not clear credential", "error");
        return;
      }
      setStatus((await res.json()) as CredentialStatusResponse);
      setDraft((current) => ({ ...current, [credentialKey]: "" }));
      setClearConfirmKey(null);
      await onSaved?.();
      toast("Credential cleared", "success");
    } catch {
      toast("Credential settings are unavailable right now.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-app-border bg-app-surface p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-xl border border-app-border bg-app-surface-2 p-2 text-app-success">
            <ShieldCheck className="h-4 w-4" aria-hidden />
          </div>
          <div>
            <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
              {title}
            </h4>
            <p className="mt-1 max-w-2xl text-xs font-semibold leading-5 text-app-text-muted">
              {description}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadStatus()}
          className="ui-btn-secondary inline-flex min-h-9 items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          <RefreshCw className="h-3 w-3" aria-hidden />
          Check
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((field) => {
          const isConfigured = Boolean(configured[field.key]);
          return (
            <label key={field.key} className="block">
              <span className="mb-1 flex items-center justify-between gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <span>{field.label}</span>
                <span
                  className={
                    isConfigured ? "text-app-success" : "text-app-warning"
                  }
                >
                  {isConfigured ? "Saved" : "Needed"}
                </span>
              </span>
              {field.type === "textarea" ? (
                <textarea
                  value={draft[field.key] ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))
                  }
                  placeholder={
                    field.placeholder ??
                    (isConfigured
                      ? "Saved - enter only to replace"
                      : "Enter value")
                  }
                  autoComplete="off"
                  rows={4}
                  className="min-h-28 w-full rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 font-mono text-xs font-semibold text-app-text outline-none transition focus:border-app-accent"
                />
              ) : (
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-app-text-muted" />
                  <input
                    type={field.type ?? "password"}
                    value={draft[field.key] ?? ""}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                    placeholder={
                      field.placeholder ??
                      (isConfigured
                        ? "Saved - enter only to replace"
                        : "Enter value")
                    }
                    autoComplete="off"
                    className="min-h-11 w-full rounded-xl border border-app-border bg-app-surface-2 py-2 pl-9 pr-3 text-sm font-semibold text-app-text outline-none transition focus:border-app-accent"
                  />
                </div>
              )}
              {field.help ? (
                <p className="mt-1 text-[10px] font-semibold leading-4 text-app-text-muted">
                  {field.help}
                </p>
              ) : null}
              {isConfigured ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void clearCredential(field.key)}
                  className="mt-2 text-[10px] font-black uppercase tracking-widest text-app-warning hover:text-app-danger disabled:opacity-50"
                >
                  {clearConfirmKey === field.key
                    ? "Confirm clear"
                    : "Clear saved value"}
                </button>
              ) : null}
            </label>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-app-border pt-4">
        <p className="text-xs font-semibold leading-5 text-app-text-muted">
          Values are encrypted on the server and hidden after save. Blank fields
          keep the current saved value.
        </p>
        <button
          type="button"
          disabled={busy || !hasDraft}
          onClick={() => void saveCredentials()}
          className="ui-btn-primary inline-flex min-h-11 items-center gap-2 px-5 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
        >
          <Save className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Saving..." : "Save Credentials"}
        </button>
      </div>
    </section>
  );
}
