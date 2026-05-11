import { getBaseUrl } from "../../lib/apiConfig";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

const baseUrl = getBaseUrl();

interface GranularMapping {
  id: string;
  source_type: string;
  source_id: string;
  qbo_account_id: string;
  qbo_account_name: string;
}

interface LedgerMapping {
  id: string;
  internal_key: string;
  internal_description: string | null;
  qbo_account_id: string | null;
}

interface CredentialsPublic {
  realm_id: string | null;
  company_id: string;
  client_id_masked: string | null;
  client_id_set: boolean;
  has_client_secret: boolean;
  has_refresh_token: boolean;
  use_sandbox: boolean;
  token_expires_at: string | null;
  is_active: boolean;
}

interface SyncLogRow {
  id: string;
  sync_date: string;
  journal_entry_id: string | null;
  status: string;
  payload: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
}

type QboStageMetadata = {
  entry_type?: string;
  business_date?: string;
  revision_of?: Array<{
    staging_id?: string;
    status?: string;
    journal_entry_id?: string | null;
  }>;
  note?: string;
};

interface StagingDrilldown {
  line_index: number;
  memo: string;
  contributors: { order_id: string; amount: string }[];
}

interface AccessLogRow {
  id: string;
  staff_id: string;
  staff_name: string;
  staff_avatar_key?: string;
  event_kind: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

type ConfirmAction =
  | { kind: "approve"; id: string; label: string }
  | { kind: "sync"; id: string; label: string }
  | null;

function moneyJson(n: unknown): string {
  if (n == null) return "0";
  const s = String(n).trim();
  if (!s) return "0";
  if (!Number.isFinite(Number.parseFloat(s))) return String(n);
  return formatUsdFromCents(parseMoneyToCents(s));
}

function qboStageMetadata(payload: Record<string, unknown>): QboStageMetadata {
  const stage = payload.qbo_stage;
  if (!stage || typeof stage !== "object") return {};
  return stage as QboStageMetadata;
}

function qboStageLabel(payload: Record<string, unknown>): string {
  const stage = qboStageMetadata(payload);
  return stage.entry_type === "daily_general_journal_revision"
    ? "Revision"
    : "Daily JE";
}

function qboStageRevisionCount(payload: Record<string, unknown>): number {
  const stage = qboStageMetadata(payload);
  return Array.isArray(stage.revision_of) ? stage.revision_of.length : 0;
}

interface QboWorkspaceProps {
  activeSection?: string;
  deepLinkSyncLogId?: string | null;
  onDeepLinkSyncLogConsumed?: () => void;
}

export default function QboWorkspace({
  deepLinkSyncLogId,
  onDeepLinkSyncLogConsumed,
}: QboWorkspaceProps) {
  useEffect(() => {
    const id = deepLinkSyncLogId?.trim();
    if (!id) return;
    setExpandedId(id);
    onDeepLinkSyncLogConsumed?.();
  }, [deepLinkSyncLogId, onDeepLinkSyncLogConsumed]);
  const [granular, setGranular] = useState<GranularMapping[]>([]);
  const [ledger, setLedger] = useState<LedgerMapping[]>([]);
  const [creds, setCreds] = useState<CredentialsPublic | null>(null);
  const [staging, setStaging] = useState<SyncLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const [proposeDate, setProposeDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drilldown, setDrilldown] = useState<StagingDrilldown | null>(null);
  const [accessLog, setAccessLog] = useState<AccessLogRow[]>([]);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);

  const drillOpen = drilldown !== null;
  useShellBackdropLayer(drillOpen);
  const { dialogRef: drillDialogRef, titleId: drillTitleId } = useDialogAccessibility(drillOpen, {
    onEscape: () => setDrilldown(null),
  });

  const { backofficeHeaders, staffCode } = useBackofficeAuth();

  const refreshCore = useCallback(async () => {
    const h = backofficeHeaders();
    const [g, l, cr, st] = await Promise.all([
      fetch(`${baseUrl}/api/qbo/granular-mappings`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/mappings`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/credentials`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/staging`, { headers: h }),
    ]);
    if (g.ok) setGranular((await g.json()) as GranularMapping[]);
    if (l.ok) setLedger((await l.json()) as LedgerMapping[]);
    if (cr.ok) {
      const pub = (await cr.json()) as CredentialsPublic;
      setCreds(pub);
    }
    if (st.ok) setStaging((await st.json()) as SyncLogRow[]);
  }, [backofficeHeaders]);

  useEffect(() => {
    void refreshCore();
  }, [refreshCore]);

  useEffect(() => {
    const loadAccess = async () => {
      if (!staffCode.trim()) {
        setAccessLog([]);
        return;
      }
      const res = await fetch(`${baseUrl}/api/staff/admin/access-log?limit=600`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        setAccessLog([]);
        return;
      }
      const rows = (await res.json()) as AccessLogRow[];
      const qboRows = rows.filter((r) => r.event_kind.startsWith("qbo_"));
      setAccessLog(qboRows);
    };
    void loadAccess();
  }, [staffCode, staging.length, backofficeHeaders]);

  const connectionReady = useMemo(
    () =>
      !!creds &&
      !!creds.realm_id &&
      creds.client_id_set &&
      creds.has_client_secret,
    [creds],
  );
  const mappingsReady = useMemo(
    () =>
      granular.length > 0 || ledger.some((row) => !!row.qbo_account_id?.trim()),
    [granular.length, ledger],
  );

  const proposeJournal = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/staging/propose`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ activity_date: proposeDate }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Propose failed");
      }
      await refreshCore();
      toast("Daily journal staged for review.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Propose failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const approveRow = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/approve`,
        { method: "POST", headers: backofficeHeaders() },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Approve failed");
      }
      await refreshCore();
      toast("Marked approved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Approve failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const syncRow = async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/sync`,
        { method: "POST", headers: backofficeHeaders() },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Sync failed");
      }
      const data = (await res.json()) as { journal_entry_id?: string };
      await refreshCore();
      toast(
        data.journal_entry_id
          ? `Synced (simulated): ${data.journal_entry_id}`
          : "Synced.",
        "success"
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Sync failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    if (confirmAction.kind === "approve") {
      await approveRow(confirmAction.id);
    } else if (confirmAction.kind === "sync") {
      await syncRow(confirmAction.id);
    }
    setConfirmAction(null);
  };

  const loadDrilldown = async (id: string, lineIndex: number) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/qbo/staging/${encodeURIComponent(id)}/drilldown?line_index=${lineIndex}`,
        { headers: backofficeHeaders() },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        line_index?: number;
        memo?: string;
        contributors?: { order_id: string; amount: string }[];
      };
      if (!res.ok) throw new Error(body.error ?? "Drill-down failed");
      setDrilldown({
        line_index: body.line_index ?? lineIndex,
        memo: body.memo ?? "Journal line",
        contributors: body.contributors ?? [],
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Drill-down failed", "error");
    }
  };

  return (
    <div className="ui-page overflow-auto">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-4">
          <IntegrationBrandLogo
            brand="qbo"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-emerald-500/20 bg-white px-3 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
              Accounting Bridge
            </p>
            <h2 className="text-2xl font-black tracking-tight text-app-text">
              Staging & History
            </h2>
          </div>
        </div>
      </div>

      <div className="ui-card bg-app-surface-2 px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Workspace scope
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-widest">
          <span
            className={`rounded-full px-2 py-1 ${
              connectionReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            1 Connection {connectionReady ? "ready" : "pending"}
          </span>
          <span
            className={`rounded-full px-2 py-1 ${
              mappingsReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            2 Mappings {mappingsReady ? "ready" : "pending"}
          </span>
            <span className="rounded-full bg-app-surface px-2 py-1 text-app-text-muted">
            3 Stage + approve + sync
          </span>
        </div>
      </div>
      <div className="ui-card bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2)),color-mix(in_srgb,var(--app-accent-2)_12%,var(--app-surface-2)))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          Financial bridge panel
        </p>
        <p className="mt-1 text-sm font-semibold text-app-text">
          Stage Daily General Journal entries by business date, review source
          lines, approve balanced entries, and send current or historical dates
          to QuickBooks. Manage connection and mappings in Settings →
          Integrations → QuickBooks Online.
        </p>
      </div>

      <div className="ui-card bg-[color-mix(in_srgb,var(--app-accent-2)_10%,var(--app-surface-2))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Staff session
        </p>
        <p className="mt-1 text-xs text-app-text-muted">
          QBO API calls use your Back Office staff credentials (unlock Staff, or the
          cashier code from an open register session when you are in Back Office).
        </p>
      </div>

        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2/80 p-4">
            <label className="text-[10px] font-black uppercase text-app-text-muted">
              Business date
              <input
                type="date"
                value={proposeDate}
                onChange={(e) => setProposeDate(e.target.value)}
                className="ui-input mt-1 block text-sm"
              />
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void proposeJournal()}
              className="ui-btn-primary px-5 py-2.5 disabled:opacity-50"
            >
              Stage / refresh journal
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refreshCore()}
              className="ui-btn-secondary px-5 py-2.5"
            >
              Reload queue
            </button>
          </div>

          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-app-border bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Entry</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Balance</th>
                  <th className="px-4 py-3">QBO JE</th>
                  <th className="px-4 py-3">Fault</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => {
                  const p = r.payload as {
                    qbo_stage?: QboStageMetadata;
                    totals?: { debits?: string; credits?: string; balanced?: boolean };
                    lines?: { debit: string; credit: string; memo: string }[];
                  };
                  const bal = p.totals?.balanced ? "Yes" : "No";
                  const revisionCount = qboStageRevisionCount(r.payload);
                  return (
                    <Fragment key={r.id}>
                      <tr className="hover:bg-app-surface-2/80">
                        <td className="px-4 py-3 font-mono text-xs">{r.sync_date}</td>
                        <td className="px-4 py-3 text-xs">
                          <span className="font-black uppercase tracking-wider text-app-text">
                            {qboStageLabel(r.payload)}
                          </span>
                          {revisionCount > 0 ? (
                            <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-[9px] font-black uppercase text-violet-800">
                              {revisionCount} prior
                            </span>
                          ) : null}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase ${
                              r.status === "synced"
                                ? "bg-emerald-100 text-emerald-800"
                                : r.status === "approved"
                                  ? "bg-blue-100 text-blue-800"
                                  : r.status === "pending"
                                    ? "bg-amber-100 text-amber-900"
                                    : "bg-app-surface-2 text-app-text-muted"
                            }`}
                          >
                            {r.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          DR {moneyJson(p.totals?.debits)} / CR{" "}
                          {moneyJson(p.totals?.credits)} · {bal}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">
                          {r.journal_entry_id ?? "—"}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {r.error_message ? (
                            <span className="rounded bg-red-50 px-2 py-1 font-semibold text-red-700">
                              {r.error_message}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            className="mr-2 text-[10px] font-black uppercase text-violet-700"
                            onClick={() =>
                              setExpandedId((x) => (x === r.id ? null : r.id))
                            }
                          >
                            {expandedId === r.id ? "Hide" : "Lines"}
                          </button>
                          {r.status === "pending" ? (
                            <button
                              type="button"
                              disabled={busy}
                              className="mr-2 text-[10px] font-black uppercase text-blue-700"
                              onClick={() =>
                                setConfirmAction({
                                  kind: "approve",
                                  id: r.id,
                                  label: `Approve staged journal ${r.sync_date}?`,
                                })
                              }
                            >
                              Approve
                            </button>
                          ) : null}
                          {r.status === "approved" ? (
                            <button
                              type="button"
                              disabled={busy}
                              className="text-[10px] font-black uppercase text-emerald-700"
                              onClick={() =>
                                setConfirmAction({
                                  kind: "sync",
                                  id: r.id,
                                  label:
                                    "Send this approved journal to QuickBooks now?",
                                })
                              }
                            >
                              Send to QBO
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expandedId === r.id ? (
                        <tr>
                          <td colSpan={7} className="bg-app-text px-4 py-3">
                            <div className="space-y-2">
                              {(p.lines ?? []).map((ln, idx) => (
                                <div
                                  key={`${r.id}-line-${idx}`}
                                  className="flex items-center justify-between rounded border border-white/15 bg-black/35 px-3 py-2 text-[11px] text-emerald-100"
                                >
                                  <span>
                                    {ln.memo} · DR {moneyJson(ln.debit)} / CR{" "}
                                    {moneyJson(ln.credit)}
                                  </span>
                                  <button
                                    type="button"
                                    className="text-[10px] font-black uppercase text-cyan-300"
                                    onClick={() => void loadDrilldown(r.id, idx)}
                                  >
                                    Source orders
                                  </button>
                                </div>
                              ))}
                              {(p.lines ?? []).length === 0 ? (
                                <pre className="max-h-64 overflow-auto text-[10px] leading-relaxed text-emerald-100">
                                  {JSON.stringify(r.payload, null, 2)}
                                </pre>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {staging.length === 0 ? (
              <p className="p-8 text-center text-sm text-app-text-muted">
                No staged journals. Propose one for a day with fulfilled sales.
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="border-b border-app-border bg-app-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Sync history
            </div>
            <table className="w-full text-left text-xs">
              <thead className="bg-app-surface-2/60 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">QBO ID</th>
                  <th className="px-4 py-2">Approved by</th>
                  <th className="px-4 py-2">Fault detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => (
                  <tr key={`history-${r.id}`}>
                    <td className="px-4 py-2 font-mono text-[11px]">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 font-mono">{r.sync_date}</td>
                    <td className="px-4 py-2">{r.status}</td>
                    <td className="px-4 py-2 font-mono">{r.journal_entry_id ?? "—"}</td>
                    <td className="px-4 py-2 text-app-text-muted">
                      {accessLog.find(
                        (a) =>
                          a.event_kind === "qbo_staging_approve" &&
                          String(a.metadata?.staging_id ?? "") === r.id,
                      )?.staff_name ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-red-700">{r.error_message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      {drilldown && (
        <div className="ui-overlay-backdrop justify-end">
          <div
            ref={drillDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={drillTitleId}
            tabIndex={-1}
            className="ui-modal h-full max-w-md overflow-auto outline-none"
          >
            <div className="ui-modal-header flex items-center justify-between">
              <h3 id={drillTitleId} className="text-sm font-black uppercase tracking-widest text-app-text">
                Reconciliation drill-down
              </h3>
              <button
                type="button"
                className="ui-touch-target text-xs font-black uppercase text-app-text-muted"
                onClick={() => setDrilldown(null)}
              >
                Close
              </button>
            </div>
            <div className="ui-modal-body">
            <p className="mt-2 text-xs text-app-text-muted">
              {drilldown.memo} · line {drilldown.line_index + 1}
            </p>
            <div className="mt-4 space-y-2">
              {drilldown.contributors.map((c) => (
                <div
                  key={`${c.order_id}-${c.amount}`}
                  className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2 text-xs"
                >
                  <span className="font-mono text-app-text">{c.order_id}</span>
                  <span className="font-semibold text-app-text">
                    {moneyJson(c.amount)}
                  </span>
                </div>
              ))}
              {drilldown.contributors.length === 0 ? (
                <p className="text-xs text-app-text-muted">No contributing orders found.</p>
              ) : null}
            </div>
            </div>
          </div>
        </div>
      )}

      {confirmAction && (
        <ConfirmationModal
          isOpen={true}
          title="Confirm Financial Action"
          message={confirmAction.label}
          confirmLabel="Execute"
          onConfirm={runConfirmedAction}
          onClose={() => setConfirmAction(null)}
          variant="info"
        />
      )}
    </div>
  );
}
