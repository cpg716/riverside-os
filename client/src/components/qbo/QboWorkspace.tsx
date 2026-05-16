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

type QboWarningTone = "blocking" | "warning" | "info";

type QboWarningItem = {
  message: string;
  tone: QboWarningTone;
};

type QboPayload = {
  qbo_stage?: QboStageMetadata;
  activity_date?: string;
  business_timezone?: string;
  generated_at?: string;
  warnings?: string[];
  totals?: { debits?: string; credits?: string; balanced?: boolean };
  lines?: { debit: string; credit: string; memo: string }[];
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
  | { kind: "approve"; id: string; label: string; message: string }
  | { kind: "sync"; id: string; label: string; message: string }
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

function qboPayload(row: SyncLogRow): QboPayload {
  return row.payload as QboPayload;
}

function qboStageLabel(payload: Record<string, unknown>): string {
  const stage = qboStageMetadata(payload);
  return stage.entry_type === "daily_general_journal_revision"
    ? "Revision"
    : "Daily journal";
}

function classifyQboWarning(message: string, row?: SyncLogRow): QboWarningTone {
  const lower = message.toLowerCase();
  if (
    row?.status === "failed" ||
    lower.includes("not balanced") ||
    lower.includes("journal not balanced") ||
    lower.includes("missing") ||
    lower.includes("no `") ||
    lower.includes("omitted") ||
    lower.includes("failed")
  ) {
    return "blocking";
  }
  if (
    lower.includes("refund") ||
    lower.includes("deposit") ||
    lower.includes("effective_date") ||
    lower.includes("correction") ||
    lower.includes("merchant") ||
    lower.includes("imported") ||
    lower.includes("asynchronous") ||
    lower.includes("store credit") ||
    lower.includes("gift card") ||
    lower.includes("tax")
  ) {
    return "warning";
  }
  return "info";
}

function qboWarningsForRow(row: SyncLogRow): QboWarningItem[] {
  const payload = qboPayload(row);
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const items = warnings.map((message) => ({
    message,
    tone: classifyQboWarning(message, row),
  }));
  if (payload.totals?.balanced === false) {
    items.unshift({
      message: "Journal is not balanced. Fix mappings and regenerate before approval or posting.",
      tone: "blocking",
    });
  }
  if (row.status === "failed" && row.error_message) {
    items.unshift({
      message: `QuickBooks posting failed: ${row.error_message}`,
      tone: "blocking",
    });
  }
  return items;
}

function warningCounts(items: QboWarningItem[]) {
  return {
    blocking: items.filter((item) => item.tone === "blocking").length,
    warning: items.filter((item) => item.tone === "warning").length,
    info: items.filter((item) => item.tone === "info").length,
  };
}

function warningSummaryLabel(items: QboWarningItem[]): string {
  const counts = warningCounts(items);
  if (counts.blocking > 0) return `${counts.blocking} blocking`;
  if (counts.warning > 0) return `${counts.warning} review`;
  if (counts.info > 0) return `${counts.info} note`;
  return "No warnings";
}

function statusLabel(row: SyncLogRow): string {
  switch (row.status) {
    case "pending":
      return "Needs review";
    case "approved":
      return "Ready to send";
    case "synced":
      return "Sent to QuickBooks";
    case "failed":
      return "Posting failed";
    default:
      return row.status.replace(/_/g, " ");
  }
}

function statusClassName(row: SyncLogRow, hasBlocking: boolean): string {
  if (hasBlocking || row.status === "failed") return "bg-red-100 text-red-800";
  if (row.status === "synced") return "bg-emerald-100 text-emerald-800";
  if (row.status === "approved") return "bg-blue-100 text-blue-800";
  if (row.status === "pending") return "bg-amber-100 text-amber-900";
  return "bg-app-surface-2 text-app-text-muted";
}

function latestByDate(rows: SyncLogRow[]): SyncLogRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )[0];
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
  activeSection = "staging",
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
  const accountingSummary = useMemo(() => {
    const rowWarnings = staging.map((row) => ({
      row,
      warnings: qboWarningsForRow(row),
    }));
    const blockingRows = rowWarnings.filter(
      ({ warnings }) => warningCounts(warnings).blocking > 0,
    );
    const warningRows = rowWarnings.filter(
      ({ warnings }) => warningCounts(warnings).warning > 0,
    );
    const infoRows = rowWarnings.filter(
      ({ warnings }) => warningCounts(warnings).info > 0,
    );
    const latestPosted = latestByDate(staging.filter((row) => row.status === "synced"));
    const latestFailed = latestByDate(staging.filter((row) => row.status === "failed"));
    const latestStaged = latestByDate(staging);
    return {
      blockingRows,
      warningRows,
      infoRows,
      latestPosted,
      latestFailed,
      latestStaged,
      pendingCount: staging.filter((row) => row.status === "pending").length,
      approvedCount: staging.filter((row) => row.status === "approved").length,
      postedCount: staging.filter((row) => row.status === "synced").length,
      failedCount: staging.filter((row) => row.status === "failed").length,
    };
  }, [staging]);

  const copySupportSnapshot = async () => {
    const latestPosted = accountingSummary.latestPosted;
    const latestFailed = accountingSummary.latestFailed;
    const lines = [
      "ROS Financial Support Snapshot",
      `Generated: ${new Date().toLocaleString()}`,
      `Connection: ${connectionReady ? "ready" : "needs setup"}`,
      `Mappings: ${mappingsReady ? "ready" : "needs review"}`,
      `Queue: ${staging.length} staged rows`,
      `Pending review: ${accountingSummary.pendingCount}`,
      `Approved, not posted: ${accountingSummary.approvedCount}`,
      `Posted to QuickBooks: ${accountingSummary.postedCount}`,
      `Posting failed: ${accountingSummary.failedCount}`,
      `Blocking rows: ${accountingSummary.blockingRows.length}`,
      `Rows requiring accounting review: ${accountingSummary.warningRows.length}`,
      `Info-note rows: ${accountingSummary.infoRows.length}`,
      `Latest posted: ${
        latestPosted
          ? `${latestPosted.sync_date} / JE ${latestPosted.journal_entry_id ?? "unknown"} / ${new Date(latestPosted.created_at).toLocaleString()}`
          : "none in current queue"
      }`,
      `Latest failed: ${
        latestFailed
          ? `${latestFailed.sync_date} / ${latestFailed.error_message ?? "no error detail"}`
          : "none in current queue"
      }`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("Financial support snapshot copied.", "success");
    } catch {
      toast("Could not copy the support snapshot.", "error");
    }
  };

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
      toast("Approved for QuickBooks posting.", "success");
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
          ? `Posted to QuickBooks: ${data.journal_entry_id}`
          : "Posted to QuickBooks.",
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

  const buildConfirmMessage = (row: SyncLogRow, kind: "approve" | "sync") => {
    const warnings = qboWarningsForRow(row);
    const counts = warningCounts(warnings);
    const action =
      kind === "approve"
        ? "Approve this staged journal for QuickBooks posting"
        : "Post this approved JournalEntry to QuickBooks";
    return [
      `${action}: ${row.sync_date}`,
      `Status: ${statusLabel(row)}`,
      `Balance: ${qboPayload(row).totals?.balanced ? "balanced" : "not balanced"}`,
      `Accounting review: ${counts.blocking} blocking / ${counts.warning} review / ${counts.info} info`,
      counts.blocking > 0
        ? "Blocking issues must be resolved before this can be treated as safe."
        : counts.warning > 0
          ? "Review warning-bearing journals before continuing. Balanced does not mean fully safe."
          : "No warning-bearing issues are visible on this proposal.",
    ].join("\n");
  };

  const currentSection = ["connection", "mappings", "staging", "history"].includes(activeSection)
    ? activeSection
    : "staging";
  const sectionTitle =
    currentSection === "connection"
      ? "Connection"
      : currentSection === "mappings"
        ? "Account Mapping"
        : currentSection === "history"
          ? "Sent History"
          : "Review & Send";
  const sectionDescription =
    currentSection === "connection"
      ? "Confirm QuickBooks is connected before sending daily journals. Setup changes are managed in Settings."
      : currentSection === "mappings"
        ? "Confirm Riverside accounts have QuickBooks accounts assigned before review and send."
        : currentSection === "history"
          ? "Review what was sent to QuickBooks, who approved it, and any posting problem details."
          : "Pick a business date, review the daily totals, then send the approved journal to QuickBooks.";
  const mappedLedgerCount = ledger.filter((row) => !!row.qbo_account_id?.trim()).length;
  const unmappedLedgerCount = Math.max(ledger.length - mappedLedgerCount, 0);

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
              QuickBooks closeout
            </p>
            <h2 className="text-2xl font-black tracking-tight text-app-text">
              {sectionTitle}
            </h2>
          </div>
        </div>
      </div>

      <div className="ui-card bg-app-surface-2 px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Daily workflow
        </p>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-widest">
          <span
            className={`rounded-full px-2 py-1 ${
              connectionReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            1 Connect {connectionReady ? "ready" : "needed"}
          </span>
          <span
            className={`rounded-full px-2 py-1 ${
              mappingsReady
                ? "bg-emerald-100 text-emerald-800"
                : "bg-amber-100 text-amber-800"
            }`}
          >
            2 Map accounts {mappingsReady ? "ready" : "needed"}
          </span>
            <span className="rounded-full bg-app-surface px-2 py-1 text-app-text-muted">
            3 Review + send
          </span>
        </div>
      </div>
      <div className="ui-card bg-[linear-gradient(145deg,color-mix(in_srgb,var(--app-accent)_14%,var(--app-surface-2)),color-mix(in_srgb,var(--app-accent-2)_12%,var(--app-surface-2)))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          What this view does
        </p>
        <p className="mt-1 text-sm font-semibold text-app-text">
          {sectionDescription} Setup and account mapping stay in Settings → Integrations →
          QuickBooks Online.
        </p>
      </div>

      {currentSection === "connection" ? (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="ui-card bg-app-surface-2 px-5 py-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Connection status
            </p>
            <p className={`mt-3 text-3xl font-black ${connectionReady ? "text-emerald-700" : "text-amber-700"}`}>
              {connectionReady ? "Ready" : "Needs setup"}
            </p>
            <p className="mt-2 text-xs font-semibold text-app-text-muted">
              Riverside can only send approved journals after the QuickBooks company, client ID, and client secret are configured.
            </p>
          </div>
          <div className="ui-card bg-app-surface-2 px-5 py-4 xl:col-span-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              What to check
            </p>
            <div className="mt-3 grid gap-2 text-xs font-semibold text-app-text sm:grid-cols-2">
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Company ID: <span className="font-black">{creds?.company_id || "Not loaded"}</span>
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Realm ID: <span className="font-black">{creds?.realm_id || "Missing"}</span>
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Client ID: <span className="font-black">{creds?.client_id_set ? "Saved" : "Missing"}</span>
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Client secret: <span className="font-black">{creds?.has_client_secret ? "Saved" : "Missing"}</span>
              </p>
            </div>
            <p className="mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-semibold text-app-text-muted">
              To fix this, open Settings → Integrations → QuickBooks Online, save the connection details, then return here and reload.
            </p>
            <button type="button" disabled={busy} onClick={() => void refreshCore()} className="mt-3 ui-btn-secondary px-5 py-2.5">
              Reload connection
            </button>
          </div>
        </div>
      ) : null}

      {currentSection === "mappings" ? (
        <div className="grid gap-4 xl:grid-cols-3">
          <div className="ui-card bg-app-surface-2 px-5 py-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Mapping status
            </p>
            <p className={`mt-3 text-3xl font-black ${mappingsReady ? "text-emerald-700" : "text-amber-700"}`}>
              {mappingsReady ? "Ready" : "Needs mapping"}
            </p>
            <p className="mt-2 text-xs font-semibold text-app-text-muted">
              Account mapping tells Riverside where revenue, tax, tenders, deposits, refunds, and gift cards belong in QuickBooks.
            </p>
          </div>
          <div className="ui-card bg-app-surface-2 px-5 py-4 xl:col-span-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Mapping counts
            </p>
            <div className="mt-3 grid gap-2 text-xs font-semibold text-app-text sm:grid-cols-3">
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Product/category rules <span className="block text-2xl font-black">{granular.length}</span>
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Ledger accounts mapped <span className="block text-2xl font-black">{mappedLedgerCount}</span>
              </p>
              <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2">
                Ledger accounts missing <span className="block text-2xl font-black text-amber-700">{unmappedLedgerCount}</span>
              </p>
            </div>
            <p className="mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-semibold text-app-text-muted">
              To edit mappings, open Settings → Integrations → QuickBooks Online. Return here afterward and reload the queue before sending.
            </p>
          </div>
        </div>
      ) : null}

      {currentSection === "staging" ? (
        <>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="ui-card bg-app-surface-2 px-5 py-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Needs attention
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Cannot send
              </p>
              <p className="mt-1 text-2xl font-black text-red-700">
                {accountingSummary.blockingRows.length}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Check first
              </p>
              <p className="mt-1 text-2xl font-black text-amber-700">
                {accountingSummary.warningRows.length}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Ready to send
              </p>
              <p className="mt-1 text-lg font-black text-blue-700">
                {accountingSummary.approvedCount}
              </p>
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Sent
              </p>
              <p className="mt-1 text-lg font-black text-emerald-700">
                {accountingSummary.postedCount}
              </p>
            </div>
          </div>
          <p className="mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-xs font-semibold text-app-text-muted">
            Balanced means the debits and credits match. It can still need review when
            refunds, deposits, card clearing, imported sales, or date corrections are involved.
          </p>
          <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">
            Still open: {accountingSummary.pendingCount + accountingSummary.approvedCount + accountingSummary.failedCount} journal row{accountingSummary.pendingCount + accountingSummary.approvedCount + accountingSummary.failedCount === 1 ? "" : "s"} need review, sending, or failure follow-up.
          </p>
        </div>

        <div className="ui-card bg-app-surface-2 px-5 py-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Recent QuickBooks activity
          </p>
          <div className="mt-3 space-y-3 text-xs font-semibold text-app-text">
            <p>
              Last sent:{" "}
              <span className="font-black">
                {accountingSummary.latestPosted
                  ? `${accountingSummary.latestPosted.sync_date} / ${accountingSummary.latestPosted.journal_entry_id ?? "JE pending"}`
                  : "Nothing sent in this queue"}
              </span>
            </p>
            <p>
              Last problem:{" "}
              <span className="font-black text-red-700">
                {accountingSummary.latestFailed
                  ? `${accountingSummary.latestFailed.sync_date}: ${accountingSummary.latestFailed.error_message ?? "review failure detail"}`
                  : "No failed sending in this queue"}
              </span>
            </p>
            <p className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-app-text-muted">
              Refreshing a date rebuilds an unsent journal. Dates already approved or sent create
              a revision for review, so history is not silently replaced.
            </p>
          </div>
        </div>

        <div className="ui-card bg-app-surface-2 px-5 py-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Dates, in plain English
          </p>
          <div className="mt-3 space-y-2 text-xs font-semibold text-app-text-muted">
            <p>
              Sale date is when the register created the sale.
            </p>
            <p>
              Completed date is when pickup or shipping recognized revenue, tax, and commission.
            </p>
            <p>
              Payment date can differ after a correction. Card fees can settle later; that is a
              review item, not automatically a bad journal.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void copySupportSnapshot()}
            className="mt-4 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text"
          >
            Copy support snapshot
          </button>
        </div>
      </div>

      <div className="ui-card bg-[color-mix(in_srgb,var(--app-warning)_10%,var(--app-surface-2))] px-5 py-4">
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Refunds, exchanges, deposits, and gift cards
        </p>
        <p className="mt-2 text-sm font-semibold text-app-text">
          These items can affect different accounts on different dates. Review any journal with a
          warning before sending it, especially when a refund payout and the return activity happen
          on different business dates.
        </p>
        <p className="mt-2 text-xs font-bold text-amber-900">
          Repeated warnings usually mean the workflow needs manager review, not a posting shortcut.
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
              Stage journal
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
                  <th className="px-4 py-3">Review</th>
                  <th className="px-4 py-3">QuickBooks ID</th>
                  <th className="px-4 py-3">Problem</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => {
                  const p = qboPayload(r);
                  const warnings = qboWarningsForRow(r);
                  const counts = warningCounts(warnings);
                  const hasBlocking = counts.blocking > 0;
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
                              statusClassName(r, hasBlocking)
                            }`}
                          >
                            {statusLabel(r)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          DR {moneyJson(p.totals?.debits)} / CR{" "}
                          {moneyJson(p.totals?.credits)} · {bal}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span
                            className={`rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-widest ${
                              hasBlocking
                                ? "bg-red-100 text-red-800"
                                : counts.warning > 0
                                  ? "bg-amber-100 text-amber-900"
                                  : counts.info > 0
                                    ? "bg-sky-100 text-sky-800"
                                    : "bg-emerald-100 text-emerald-800"
                            }`}
                          >
                            {warningSummaryLabel(warnings)}
                          </span>
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
                                  message: buildConfirmMessage(r, "approve"),
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
                                  message: buildConfirmMessage(r, "sync"),
                                })
                              }
                            >
                              Post to QBO
                            </button>
                          ) : null}
                        </td>
                      </tr>
                      {expandedId === r.id ? (
                        <tr>
                          <td colSpan={8} className="bg-app-text px-4 py-3">
                            <div className="space-y-3">
                              {warnings.length > 0 ? (
                                <div className="space-y-2 rounded border border-white/15 bg-black/35 p-3">
                                  <p className="text-[10px] font-black uppercase tracking-widest text-cyan-200">
                                    Accounting review items
                                  </p>
                                  {warnings.map((warning, index) => (
                                    <div
                                      key={`${r.id}-warning-${index}`}
                                      className={`rounded px-3 py-2 text-[11px] font-semibold ${
                                        warning.tone === "blocking"
                                          ? "bg-red-900/50 text-red-100"
                                          : warning.tone === "warning"
                                            ? "bg-amber-900/45 text-amber-100"
                                            : "bg-sky-900/45 text-sky-100"
                                      }`}
                                    >
                                      <span className="mr-2 font-black uppercase">
                                        {warning.tone === "blocking"
                                          ? "Blocking"
                                          : warning.tone === "warning"
                                            ? "Requires review"
                                            : "Info"}
                                      </span>
                                      {warning.message}
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="rounded border border-white/15 bg-black/35 px-3 py-2 text-[11px] font-semibold text-emerald-100">
                                  No proposal warnings are visible. Continue normal journal-line review before posting.
                                </div>
                              )}
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
        </div>
        </>
      ) : null}

      {currentSection === "history" ? (
        <div className="flex flex-col gap-4">
          <div className="ui-card bg-app-surface-2 px-5 py-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              History summary
            </p>
            <p className="mt-2 text-sm font-semibold text-app-text">
              Sent journals, approval staff, and QuickBooks posting problems are listed below.
            </p>
          </div>
          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="border-b border-app-border bg-app-surface-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Sent history
            </div>
            <table className="w-full text-left text-xs">
              <thead className="bg-app-surface-2/60 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Review</th>
                  <th className="px-4 py-2">QuickBooks ID</th>
                  <th className="px-4 py-2">Approved by</th>
                  <th className="px-4 py-2">Problem detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {staging.map((r) => {
                  const warnings = qboWarningsForRow(r);
                  return (
                    <tr key={`history-${r.id}`}>
                      <td className="px-4 py-2 font-mono text-[11px]">
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-2 font-mono">{r.sync_date}</td>
                      <td className="px-4 py-2">{statusLabel(r)}</td>
                      <td className="px-4 py-2">{warningSummaryLabel(warnings)}</td>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
          message={confirmAction.message}
          confirmLabel={confirmAction.kind === "sync" ? "Post to QBO" : "Approve"}
          onConfirm={runConfirmedAction}
          onClose={() => setConfirmAction(null)}
          variant="info"
        />
      )}
    </div>
  );
}
