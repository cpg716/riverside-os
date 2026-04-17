import { useCallback, useEffect, useState } from "react";
import { Bug, Download, RefreshCw } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type BugStatus = "pending" | "complete" | "dismissed";

type ListRow = {
  id: string;
  correlation_id: string;
  created_at: string;
  status: BugStatus;
  summary: string;
  staff_id: string;
  staff_name: string;
};

type Detail = {
  id: string;
  correlation_id: string;
  created_at: string;
  updated_at: string;
  status: BugStatus;
  summary: string;
  steps_context: string;
  client_console_log: string;
  client_meta: Record<string, unknown>;
  screenshot_png_base64: string;
  server_log_snapshot: string;
  resolver_notes: string;
  external_url: string;
  staff_id: string;
  staff_name: string;
  resolved_at: string | null;
  resolver_name: string | null;
};

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadPng(filename: string, base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function statusPillClass(status: BugStatus): string {
  if (status === "complete") {
    return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
  }
  if (status === "dismissed") {
    return "bg-app-border/40 text-app-text-muted";
  }
  return "bg-amber-500/15 text-amber-900 dark:text-amber-100";
}

function statusLabel(status: BugStatus): string {
  if (status === "complete") return "Fixed";
  if (status === "dismissed") return "Dismissed";
  return "Pending";
}

export default function BugReportsSettingsPanel({
  deepLinkReportId = null,
  onDeepLinkConsumed,
}: {
  deepLinkReportId?: string | null;
  onDeepLinkConsumed?: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draftNotes, setDraftNotes] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [statusConfirm, setStatusConfirm] = useState<{
    id: string;
    next: BugStatus;
  } | null>(null);
  const [listFilter, setListFilter] = useState<
    "all" | "pending" | "complete" | "dismissed"
  >("pending");

  const filteredRows =
    listFilter === "all" ? rows : rows.filter((r) => r.status === listFilter);

  const loadList = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/bug-reports`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not load bug reports", "error");
        return;
      }
      const data = (await res.json()) as ListRow[];
      setRows(data);
    } catch {
      toast("Network error loading bug reports", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, hasPermission, toast]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/settings/bug-reports/${id}`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        toast("Could not load report", "error");
        return;
      }
      const d = (await res.json()) as Detail;
      setDetail(d);
      setDraftNotes(d.resolver_notes ?? "");
      setDraftUrl(d.external_url ?? "");
    } catch {
      toast("Network error", "error");
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    if (!deepLinkReportId) return;
    void openDetail(deepLinkReportId);
    onDeepLinkConsumed?.();
  }, [deepLinkReportId, onDeepLinkConsumed, openDetail]);

  const patchReport = async (body: Record<string, unknown>) => {
    if (!detail) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/bug-reports/${detail.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not update report", "error");
        return;
      }
      const d = (await res.json()) as Detail;
      setDetail(d);
      setDraftNotes(d.resolver_notes ?? "");
      setDraftUrl(d.external_url ?? "");
      toast("Saved", "success");
      void loadList();
    } catch {
      toast("Network error", "error");
    } finally {
      setStatusConfirm(null);
    }
  };

  const saveTriageFields = () =>
    void patchReport({ resolver_notes: draftNotes, external_url: draftUrl });

  if (!hasPermission("settings.admin")) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
            <Bug className="h-7 w-7 text-app-accent" aria-hidden />
            Bug reports
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-app-text-muted">
            Submissions from the bug icon (Tauri, PWA, or browser): optional
            screenshot, client console, API tracing snapshot, correlation id,
            and triage fields. Notifications go to staff with settings.admin.
            Old reports purge per{" "}
            <code className="font-mono text-[10px]">
              RIVERSIDE_BUG_REPORT_RETENTION_DAYS
            </code>{" "}
            (default 365 days, min 30).
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadList()}
          className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["pending", "Pending"],
            ["complete", "Fixed"],
            ["dismissed", "Dismissed"],
            ["all", "All"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setListFilter(key)}
            className={`rounded-lg border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
              listFilter === key
                ? "border-app-accent bg-app-accent/15 text-app-text"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-border/20"
            }`}
          >
            {label}
            {key !== "all" ? (
              <span className="ml-1.5 tabular-nums opacity-70">
                ({rows.filter((r) => r.status === key).length})
              </span>
            ) : (
              <span className="ml-1.5 tabular-nums opacity-70">
                ({rows.length})
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="ui-card overflow-hidden">
        {loading ? (
          <p className="p-6 text-sm text-app-text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-app-text-muted">No bug reports yet.</p>
        ) : filteredRows.length === 0 ? (
          <p className="p-6 text-sm text-app-text-muted">
            No reports in this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Ref</th>
                  <th className="px-4 py-3">Staff</th>
                  <th className="px-4 py-3">Summary</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {filteredRows.map((r) => (
                  <tr key={r.id} className="hover:bg-app-surface-2/80">
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-app-text-muted">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-[10px] text-app-text-muted">
                      {r.correlation_id.slice(0, 8)}…
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-app-text">
                      {r.staff_name}
                    </td>
                    <td className="max-w-md px-4 py-3 text-xs text-app-text line-clamp-2">
                      {r.summary}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`ui-pill text-[9px] ${statusPillClass(r.status)}`}
                      >
                        {statusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void openDetail(r.id)}
                        className="text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="presentation"
          onPointerDown={() => setDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Bug report detail"
            className="ui-card flex max-h-[min(92vh,900px)] w-full max-w-3xl flex-col overflow-hidden shadow-2xl [-webkit-overflow-scrolling:touch]"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-app-border px-5 py-4">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {new Date(detail.created_at).toLocaleString()} ·{" "}
                  {detail.staff_name}
                </p>
                <p className="mt-1 font-mono text-[10px] text-app-text-muted">
                  Correlation: {detail.correlation_id}
                </p>
                <p className="mt-1 text-sm font-bold text-app-text line-clamp-2">
                  {detail.summary}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span
                    className={`ui-pill text-[9px] ${statusPillClass(detail.status)}`}
                  >
                    {statusLabel(detail.status)}
                  </span>
                  {typeof detail.client_meta?.runtime_surface === "string" ? (
                    <span className="ui-pill bg-app-surface-2 text-[9px] font-semibold capitalize text-app-text">
                      {String(detail.client_meta.runtime_surface).replace(
                        /_/g,
                        " ",
                      )}
                    </span>
                  ) : null}
                  {detail.client_meta?.tauri_shell_version != null ? (
                    <span className="ui-pill bg-app-surface-2 text-[9px] font-mono text-app-text">
                      Tauri {String(detail.client_meta.tauri_shell_version)}
                    </span>
                  ) : null}
                  {detail.client_meta?.likely_ios_family === true ? (
                    <span className="ui-pill bg-app-surface-2 text-[9px] text-app-text">
                      iOS / iPad-class UA
                    </span>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                className="ui-btn-secondary shrink-0 px-3 py-1.5 text-[10px] font-black uppercase"
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                  onClick={() =>
                    downloadJson(`ros-bug-${detail.id}-full.json`, detail)
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Full report JSON
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                  onClick={() =>
                    downloadPng(
                      `ros-bug-${detail.id}.png`,
                      detail.screenshot_png_base64,
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Screenshot PNG
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                  onClick={() =>
                    downloadTextFile(
                      `ros-bug-${detail.id}-server-log.txt`,
                      detail.server_log_snapshot || "",
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Server log (.txt)
                </button>
                <button
                  type="button"
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                  onClick={() =>
                    downloadTextFile(
                      `ros-bug-${detail.id}-client-console.txt`,
                      detail.client_console_log || "",
                    )
                  }
                >
                  <Download className="h-3.5 w-3.5" aria-hidden />
                  Client console (.txt)
                </button>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Triage (saved to database)
                </p>
                <label className="block">
                  <span className="text-[10px] font-semibold text-app-text-muted">
                    Tracker / issue URL
                  </span>
                  <input
                    type="url"
                    className="ui-input mt-1 w-full text-sm"
                    value={draftUrl}
                    onChange={(e) => setDraftUrl(e.target.value)}
                    placeholder="https://github.com/org/repo/issues/123"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-semibold text-app-text-muted">
                    Internal notes (not visible to submitter)
                  </span>
                  <textarea
                    className="ui-input mt-1 min-h-[72px] w-full text-sm"
                    value={draftNotes}
                    onChange={(e) => setDraftNotes(e.target.value)}
                    placeholder="Repro context, RCA, assignee…"
                  />
                </label>
                <button
                  type="button"
                  className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                  onClick={() => void saveTriageFields()}
                >
                  Save notes &amp; URL
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
                {detail.status === "pending" ? (
                  <>
                    <button
                      type="button"
                      className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setStatusConfirm({ id: detail.id, next: "complete" })
                      }
                    >
                      Mark fixed
                    </button>
                    <button
                      type="button"
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setStatusConfirm({ id: detail.id, next: "dismissed" })
                      }
                    >
                      Dismiss (won&apos;t fix)
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                    onClick={() =>
                      setStatusConfirm({ id: detail.id, next: "pending" })
                    }
                  >
                    Reopen as pending
                  </button>
                )}
              </div>

              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Screenshot
                </p>
                <img
                  src={`data:image/png;base64,${detail.screenshot_png_base64}`}
                  alt=""
                  className="mt-2 max-h-64 w-full rounded-xl border border-app-border object-contain object-top bg-app-surface-2"
                />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  What they were doing
                </p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-app-text">
                  {detail.steps_context}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Client meta
                </p>
                <pre className="mt-1 max-h-40 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text">
                  {JSON.stringify(detail.client_meta, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  API server log (snapshot at submit)
                </p>
                <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                  {detail.server_log_snapshot || "—"}
                </pre>
                <p className="mt-1 text-[10px] text-app-text-muted">
                  Bounded in-memory <code className="font-mono">tracing</code>{" "}
                  buffer on the process that handled submit — not the full
                  terminal session or other replicas.
                </p>
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Browser console / error buffer
                </p>
                <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                  {detail.client_console_log || "—"}
                </pre>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {statusConfirm ? (
        <ConfirmationModal
          isOpen
          title={
            statusConfirm.next === "complete"
              ? "Mark bug fixed?"
              : statusConfirm.next === "dismissed"
                ? "Dismiss this report?"
                : "Reopen as pending?"
          }
          message={
            statusConfirm.next === "complete"
              ? "This marks the report complete (fixed) for your team."
              : statusConfirm.next === "dismissed"
                ? "Marks the report as dismissed (won't fix / not actionable). You can reopen later."
                : "Status will return to pending."
          }
          confirmLabel={
            statusConfirm.next === "complete"
              ? "Mark fixed"
              : statusConfirm.next === "dismissed"
                ? "Dismiss"
                : "Mark pending"
          }
          onClose={() => setStatusConfirm(null)}
          onConfirm={() =>
            void patchReport({
              status: statusConfirm.next,
              resolver_notes: draftNotes,
              external_url: draftUrl,
            })
          }
        />
      ) : null}
    </div>
  );
}
