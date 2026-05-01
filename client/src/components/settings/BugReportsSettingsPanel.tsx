import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bug,
  Clipboard,
  Download,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";

const baseUrl = getBaseUrl();

type BugStatus = "pending" | "complete" | "dismissed";
type ErrorEventStatus = "pending" | "complete" | "archived";

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

type ErrorEventRow = {
  id: string;
  created_at: string;
  staff_id: string | null;
  staff_name: string | null;
  status: ErrorEventStatus;
  message: string;
  event_source: string;
  severity: string;
  route: string | null;
  client_meta: Record<string, unknown>;
  server_log_snapshot: string;
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

async function copyToClipboardOrDownload(
  payload: string,
  filename: string,
  onCopySuccess: () => void,
) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      onCopySuccess();
      return;
    }
  } catch {
    // fall through to download fallback
  }

  downloadTextFile(filename, payload);
  onCopySuccess();
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

function errorEventStatusPillClass(status: ErrorEventStatus): string {
  if (status === "complete") {
    return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200";
  }
  if (status === "archived") {
    return "bg-app-border/40 text-app-text-muted";
  }
  return "bg-amber-500/15 text-amber-900 dark:text-amber-100";
}

function errorEventStatusLabel(status: ErrorEventStatus): string {
  if (status === "complete") return "Completed";
  if (status === "archived") return "Archived";
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
  const [errorEvents, setErrorEvents] = useState<ErrorEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [eventDetail, setEventDetail] = useState<ErrorEventRow | null>(null);
  const [draftNotes, setDraftNotes] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [statusConfirm, setStatusConfirm] = useState<{
    id: string;
    next: BugStatus;
  } | null>(null);
  const [eventStatusConfirm, setEventStatusConfirm] = useState<{
    id: string;
    next: ErrorEventStatus;
  } | null>(null);
  const [eventDeleteConfirm, setEventDeleteConfirm] = useState<string | null>(null);
  const [listFilter, setListFilter] = useState<
    "all" | "pending" | "complete" | "dismissed"
  >("pending");
  const [eventListFilter, setEventListFilter] = useState<
    "all" | ErrorEventStatus
  >("pending");
  const [viewMode, setViewMode] = useState<"reports" | "events">("reports");

  const filteredRows =
    listFilter === "all" ? rows : rows.filter((r) => r.status === listFilter);
  const filteredErrorEvents =
    eventListFilter === "all"
      ? errorEvents
      : errorEvents.filter((event) => event.status === eventListFilter);
  const overlayRoot = document.getElementById("drawer-root") || document.body;

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

  const loadErrorEvents = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setEventsLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/bug-reports/error-events`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not load error events", "error");
        return;
      }
      const data = (await res.json()) as ErrorEventRow[];
      setErrorEvents(data);
    } catch {
      toast("Network error loading error events", "error");
    } finally {
      setEventsLoading(false);
    }
  }, [backofficeHeaders, hasPermission, toast]);

  useEffect(() => {
    void loadList();
    void loadErrorEvents();
  }, [loadErrorEvents, loadList]);

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

  const patchErrorEventStatus = async (
    id: string,
    next: ErrorEventStatus,
  ) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/bug-reports/error-events/${id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ status: next }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not update error event", "error");
        return;
      }
      const updated = (await res.json()) as ErrorEventRow;
      setErrorEvents((prev) =>
        prev.map((event) => (event.id === id ? updated : event)),
      );
      if (eventDetail?.id === id) {
        setEventDetail(updated);
      }
      toast(
        `Error event marked ${errorEventStatusLabel(next).toLowerCase()}`,
        "success",
      );
      void loadErrorEvents();
    } catch {
      toast("Network error", "error");
    } finally {
      setEventStatusConfirm(null);
    }
  };

  const deleteErrorEvent = async (id: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/settings/bug-reports/error-events/${id}`,
        {
          method: "DELETE",
          headers: {
            ...(backofficeHeaders() as Record<string, string>),
          },
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not delete error event", "error");
        return;
      }
      setErrorEvents((prev) => prev.filter((event) => event.id !== id));
      setEventDetail((current) => (current?.id === id ? null : current));
      toast("Error event deleted", "success");
      void loadErrorEvents();
    } catch {
      toast("Network error", "error");
    } finally {
      setEventDeleteConfirm(null);
    }
  };

  const saveTriageFields = () =>
    void patchReport({ resolver_notes: draftNotes, external_url: draftUrl });

  const errorEventCapture = useMemo(() => {
    if (!eventDetail) return null;
    const raw = eventDetail.client_meta?.event_capture;
    if (raw && typeof raw === "object") {
      return raw as Record<string, unknown>;
    }
    return null;
  }, [eventDetail]);

  const errorEventDiagTail = useMemo(() => {
    if (!eventDetail) return null;
    const tail = eventDetail.client_meta?.diag_tail_lines;
    return typeof tail === "string" ? tail : null;
  }, [eventDetail]);

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
            Staff reports include what happened, a screenshot when available,
            and support details for follow-up. Automated error reports are saved
            here so staff do not have to file a report for every failed action.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadList();
            void loadErrorEvents();
          }}
          className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ["reports", "Bug reports"],
          ["events", "Error events"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setViewMode(key)}
            className={`rounded-xl border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
              viewMode === key
                ? "border-app-accent bg-app-accent/15 text-app-text"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-border/20"
            }`}
          >
            {label}
            <span className="ml-1.5 tabular-nums opacity-70">
              ({key === "reports" ? rows.length : errorEvents.length})
            </span>
          </button>
        ))}
      </div>

      {viewMode === "events" ? (
        <div className="ui-card overflow-hidden">
          {eventsLoading ? (
            <p className="p-6 text-sm text-app-text-muted">Loading…</p>
          ) : filteredErrorEvents.length === 0 ? (
            <p className="p-6 text-sm text-app-text-muted">
              No automated error events in this filter.
            </p>
          ) : (
            <div>
              <div className="flex flex-wrap gap-2 border-b border-app-border bg-app-surface-2/40 p-3">
                {(
                  [
                    ["pending", "Pending"],
                    ["complete", "Completed"],
                    ["archived", "Archived"],
                    ["all", "All"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setEventListFilter(key)}
                    className={`rounded-lg border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
                      eventListFilter === key
                        ? "border-app-accent bg-app-accent/15 text-app-text"
                        : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-border/20"
                    }`}
                  >
                    {label}
                    <span className="ml-1.5 tabular-nums opacity-70">
                      ({key === "all"
                        ? errorEvents.length
                        : errorEvents.filter((e) => e.status === key).length})
                    </span>
                  </button>
                ))}
              </div>
              <div className="overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <tr>
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Staff</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Message</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Route</th>
                    <th className="px-4 py-3 text-right">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border">
                  {filteredErrorEvents.map((event) => (
                    <tr key={event.id} className="hover:bg-app-surface-2/80">
                      <td className="whitespace-nowrap px-4 py-3 text-xs text-app-text-muted">
                        {new Date(event.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-xs font-semibold text-app-text">
                        {event.staff_name ?? "Unknown"}
                      </td>
                      <td className="px-4 py-3">
                        <span className="ui-pill bg-app-danger/10 text-[9px] text-app-danger">
                          {event.event_source.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="max-w-md px-4 py-3 text-xs text-app-text line-clamp-2">
                        {event.message}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`ui-pill text-[9px] ${errorEventStatusPillClass(event.status)}`}
                        >
                          {errorEventStatusLabel(event.status)}
                        </span>
                      </td>
                      <td className="max-w-[14rem] truncate px-4 py-3 font-mono text-[10px] text-app-text-muted">
                        {event.route ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setEventDetail(event)}
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
            </div>
          )}
        </div>
      ) : (
        <>
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
          <div className="overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]">
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
        </>
      )}

      {detail ? createPortal(
        <div
          className="ui-overlay-backdrop"
          role="presentation"
          onPointerDown={() => setDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Bug report detail"
            className="ui-modal flex max-h-[min(92vh,900px)] w-full max-w-3xl flex-col overflow-hidden shadow-2xl [-webkit-overflow-scrolling:touch]"
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
                      Desktop app {String(detail.client_meta.tauri_shell_version)}
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
                  Support log (.txt)
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
                  Browser log (.txt)
                </button>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4 space-y-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Follow-up notes
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
              <details className="rounded-xl border border-app-border bg-app-surface-2/50 p-3">
                <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Advanced details
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Support data
                    </p>
                    <pre className="mt-1 max-h-40 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text">
                      {JSON.stringify(detail.client_meta, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Support log at submit
                    </p>
                    <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                      {detail.server_log_snapshot || "—"}
                    </pre>
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Browser log
                    </p>
                    <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                      {detail.client_console_log || "—"}
                    </pre>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>,
        overlayRoot
      ) : null}

      {eventDetail ? createPortal(
        <div
          className="ui-overlay-backdrop"
          role="presentation"
          onPointerDown={() => setEventDetail(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Error event detail"
            className="ui-card flex max-h-[min(92vh,760px)] w-full max-w-3xl flex-col overflow-hidden shadow-2xl"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-app-border px-5 py-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-danger">
                  <AlertTriangle className="h-4 w-4" aria-hidden />
                  Automated error event
                </p>
                <p className="mt-1 text-xs text-app-text-muted">
                  {new Date(eventDetail.created_at).toLocaleString()} ·{" "}
                  {eventDetail.staff_name ?? "Unknown staff"}
                </p>
                <p className="mt-2 text-sm font-bold text-app-text">
                  {eventDetail.message}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span
                    className={`ui-pill text-[9px] ${errorEventStatusPillClass(eventDetail.status)}`}
                  >
                    {errorEventStatusLabel(eventDetail.status)}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="ui-btn-secondary shrink-0 px-3 py-1.5 text-[10px] font-black uppercase"
                onClick={() => setEventDetail(null)}
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
                    void copyToClipboardOrDownload(
                      JSON.stringify(eventDetail, null, 2),
                      `ros-error-event-${eventDetail.id}-all.json`,
                      () => {
                        toast("Error event details copied", "success");
                      },
                    )
                  }
                >
                  <Clipboard className="h-3.5 w-3.5" aria-hidden />
                  Copy all
                </button>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Route
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-app-text">
                    {eventDetail.route ?? "—"}
                  </p>
                </div>
                <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Source
                  </p>
                  <p className="mt-1 text-xs font-bold text-app-text">
                    {eventDetail.event_source.replace(/_/g, " ")} ·{" "}
                    {eventDetail.severity}
                  </p>
                </div>
              </div>
              <div>
                <details className="rounded-xl border border-app-border bg-app-surface-2/50 p-3">
                  <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Advanced details
                  </summary>
                  <div className="mt-3 space-y-3">
                    {errorEventCapture ? (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Error context
                        </p>
                        <pre className="mt-1 max-h-48 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text">
                          {JSON.stringify(errorEventCapture, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {errorEventDiagTail ? (
                      <div>
                        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Browser details
                        </p>
                        <pre className="mt-1 max-h-52 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                          {errorEventDiagTail}
                        </pre>
                      </div>
                    ) : null}
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Support data
                      </p>
                      <pre className="mt-1 max-h-52 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text">
                        {JSON.stringify(eventDetail.client_meta, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Support log near event
                      </p>
                      <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-surface-2 p-3 text-[10px] text-app-text whitespace-pre-wrap">
                        {eventDetail.server_log_snapshot || "—"}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>
              <div className="flex flex-wrap gap-2 border-t border-app-border pt-2">
                {eventDetail.status === "pending" ? (
                  <>
                    <button
                      type="button"
                      className="ui-btn-primary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setEventStatusConfirm({
                          id: eventDetail.id,
                          next: "complete",
                        })
                      }
                    >
                      Mark completed
                    </button>
                    <button
                      type="button"
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setEventStatusConfirm({
                          id: eventDetail.id,
                          next: "archived",
                        })
                      }
                    >
                      Archive
                    </button>
                  </>
                ) : eventDetail.status === "complete" ? (
                  <>
                    <button
                      type="button"
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setEventStatusConfirm({
                          id: eventDetail.id,
                          next: "archived",
                        })
                      }
                    >
                      Archive
                    </button>
                    <button
                      type="button"
                      className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                      onClick={() =>
                        setEventStatusConfirm({
                          id: eventDetail.id,
                          next: "pending",
                        })
                      }
                    >
                      Reopen
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase"
                    onClick={() =>
                      setEventStatusConfirm({
                        id: eventDetail.id,
                        next: "pending",
                      })
                    }
                  >
                    Mark pending
                  </button>
                )}
                <button
                  type="button"
                  className="inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase text-app-danger hover:text-red-500"
                  onClick={() => setEventDeleteConfirm(eventDetail.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>,
        overlayRoot
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

      {eventStatusConfirm ? (
        <ConfirmationModal
          isOpen
          title={
            eventStatusConfirm.next === "complete"
              ? "Mark this error event complete?"
              : eventStatusConfirm.next === "archived"
                ? "Archive this error event?"
                : "Reopen this error event?"
          }
          message={
            eventStatusConfirm.next === "complete"
              ? "This marks this event as completed."
              : eventStatusConfirm.next === "archived"
                ? "This moves the event into the archived status."
                : "This moves the event back to pending."
          }
          confirmLabel={
            eventStatusConfirm.next === "complete"
              ? "Mark completed"
              : eventStatusConfirm.next === "archived"
                ? "Archive"
                : "Mark pending"
          }
          onClose={() => setEventStatusConfirm(null)}
          onConfirm={() =>
            void patchErrorEventStatus(
              eventStatusConfirm.id,
              eventStatusConfirm.next,
            )
          }
        />
      ) : null}

      {eventDeleteConfirm ? (
        <ConfirmationModal
          isOpen
          title="Delete this error event?"
          message="This removes the event permanently from the list."
          confirmLabel="Delete"
          onClose={() => setEventDeleteConfirm(null)}
          onConfirm={() => void deleteErrorEvent(eventDeleteConfirm)}
        />
      ) : null}
    </div>
  );
}
