import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Bug,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { apiGet, getServerUrl, authHeaders } from "../lib/api";
import { useDialogAccessibility } from "../hooks/useDialogAccessibility";

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

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 150);
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

function errorEventActorLabel(event: ErrorEventRow): string {
  if (event.staff_name) return event.staff_name;
  if (event.event_source.startsWith("server_")) return "Server runtime";
  return "Unknown";
}

function isServerError(event: ErrorEventRow): boolean {
  return event.event_source.startsWith("server_");
}

function buildAiDiagnosticPackage(event: ErrorEventRow): string {
  const isServer = event.event_source.startsWith("server_");
  const prompt = [
    `## Riverside OS — ${isServer ? "Server" : "Client"} Error Diagnostic`,
    "",
    `**Event source**: \`${event.event_source}\`  `,
    `**Severity**: ${event.severity}  `,
    `**Route**: ${event.route ?? "(none)"}  `,
    `**Occurred**: ${new Date(event.created_at).toLocaleString()}  `,
    `**Actor**: ${errorEventActorLabel(event)}`,
    "",
    "### Error message",
    event.message,
    "",
    "### Fix instructions",
    isServer
      ? "1. Read the route and error message to identify the failing handler.\n2. Check server_log_snapshot for the Rust tracing context near the error.\n3. Locate the handler in server/src/api/ or server/src/logic/ and apply the smallest safe fix.\n4. Follow AGENTS.md: thin handlers, business logic in logic/, no raw SQL mutations without transactions.\n5. Run: cargo fmt && cargo check && cd client && npm run lint && npm run typecheck"
      : "1. Read the route, message, and client metadata.\n2. Locate the failing React view, handler, or service in client/src/.\n3. Apply the smallest safe fix, ensure TypeScript typings, and run client-side lints.\n4. Run: cd client && npm run lint && npm run typecheck",
    "",
    "### Full diagnostic payload (JSON)",
  ].join("\n");

  return prompt + "\n" + JSON.stringify(event, null, 2);
}

export default function BugReportsPanel() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [errorEvents, setErrorEvents] = useState<ErrorEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [eventDetail, setEventDetail] = useState<ErrorEventRow | null>(null);
  const [draftNotes, setDraftNotes] = useState("");
  const [draftUrl, setDraftUrl] = useState("");
  const [toastMsg, setToastMsg] = useState<{ text: string; type: "success" | "error" } | null>(null);

  const [listFilter, setListFilter] = useState<"all" | "pending" | "complete" | "dismissed">("pending");
  const [eventListFilter, setEventListFilter] = useState<"all" | ErrorEventStatus>("pending");
  const [eventSourceFilter, setEventSourceFilter] = useState<"all" | "server" | "client">("all");
  const [viewMode, setViewMode] = useState<"reports" | "events">("reports");

  const showToast = useCallback((text: string, type: "success" | "error" = "success") => {
    setToastMsg({ text, type });
    setTimeout(() => setToastMsg(null), 3000);
  }, []);

  const { dialogRef: bugDetailRef } = useDialogAccessibility(detail !== null, {
    onEscape: () => setDetail(null),
  });
  const { dialogRef: eventDetailRef } = useDialogAccessibility(eventDetail !== null, {
    onEscape: () => setEventDetail(null),
  });

  const filteredRows = useMemo(() => {
    return listFilter === "all" ? rows : rows.filter((r) => r.status === listFilter);
  }, [rows, listFilter]);

  const filteredErrorEvents = useMemo(() => {
    const statusFiltered =
      eventListFilter === "all"
        ? errorEvents
        : errorEvents.filter((event) => event.status === eventListFilter);
    return eventSourceFilter === "all"
      ? statusFiltered
      : eventSourceFilter === "server"
        ? statusFiltered.filter((e) => isServerError(e))
        : statusFiltered.filter((e) => !isServerError(e));
  }, [errorEvents, eventListFilter, eventSourceFilter]);

  const pendingServerErrorCount = useMemo(() => {
    return errorEvents.filter((e) => isServerError(e) && e.status === "pending").length;
  }, [errorEvents]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGet<ListRow[]>("/api/settings/bug-reports");
      setRows(data);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load bug reports", "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  const loadErrorEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const data = await apiGet<ErrorEventRow[]>("/api/settings/bug-reports/error-events");
      setErrorEvents(data);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load error events", "error");
    } finally {
      setEventsLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void loadList();
    void loadErrorEvents();
  }, [loadList, loadErrorEvents]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const d = await apiGet<Detail>(`/api/settings/bug-reports/${id}`);
      setDetail(d);
      setDraftNotes(d.resolver_notes ?? "");
      setDraftUrl(d.external_url ?? "");
    } catch (e) {
      showToast("Could not load bug report details", "error");
    }
  }, [showToast]);

  const patchReport = async (body: Record<string, unknown>) => {
    if (!detail) return;
    try {
      const res = await fetch(`${getServerUrl()}/api/settings/bug-reports/${detail.id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Could not update report");
      const d = (await res.json()) as Detail;
      setDetail(d);
      setDraftNotes(d.resolver_notes ?? "");
      setDraftUrl(d.external_url ?? "");
      showToast("Saved settings");
      void loadList();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Error saving", "error");
    }
  };

  const patchErrorEventStatus = async (id: string, next: ErrorEventStatus) => {
    try {
      const res = await fetch(`${getServerUrl()}/api/settings/bug-reports/error-events/${id}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("Could not update error status");
      const updated = (await res.json()) as ErrorEventRow;
      setErrorEvents((prev) => prev.map((event) => (event.id === id ? updated : event)));
      if (eventDetail?.id === id) {
        setEventDetail(updated);
      }
      showToast(`Error marked ${next}`);
      void loadErrorEvents();
    } catch (e) {
      showToast("Error updating status", "error");
    }
  };

  const deleteErrorEvent = async (id: string) => {
    try {
      const res = await fetch(`${getServerUrl()}/api/settings/bug-reports/error-events/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Could not delete error");
      setErrorEvents((prev) => prev.filter((event) => event.id !== id));
      setEventDetail((current) => (current?.id === id ? null : current));
      showToast("Error event deleted");
      void loadErrorEvents();
    } catch (e) {
      showToast("Error deleting", "error");
    }
  };

  const errorEventCapture = useMemo(() => {
    if (!eventDetail) return null;
    const raw = eventDetail.client_meta?.event_capture;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  }, [eventDetail]);

  const errorEventDiagTail = useMemo(() => {
    if (!eventDetail) return null;
    const tail = eventDetail.client_meta?.diag_tail_lines;
    return typeof tail === "string" ? tail : null;
  }, [eventDetail]);

  return (
    <div className="space-y-6">
      {toastMsg && (
        <div className={`fixed top-4 right-4 z-[400] rounded-xl px-4 py-3 shadow-lg border ${
          toastMsg.type === "success" 
            ? "bg-app-success/15 border-app-success/35 text-app-success" 
            : "bg-app-danger/15 border-app-danger/35 text-app-danger"
        }`}>
          {toastMsg.text}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
            <Bug className="h-7 w-7 text-app-accent" aria-hidden />
            Developer Bug & Error Manager
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-app-text-muted">
            Track, reproduce, and resolve exceptions. Copy fully packaged prompts containing traces and log contexts to resolve issues using local AI tools.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void loadList();
            void loadErrorEvents();
          }}
          className="ui-btn ui-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest border border-app-border/60 hover:border-app-accent/40"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ["reports", "Bug Reports"],
          ["events", "Developer Errors"],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setViewMode(key)}
            className={`relative rounded-xl border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
              viewMode === key
                ? "border-app-accent bg-app-accent/15 text-app-text"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-border/20"
            }`}
          >
            {label}
            <span className="ml-1.5 tabular-nums opacity-70">
              ({key === "reports" ? rows.length : errorEvents.length})
            </span>
            {key === "events" && pendingServerErrorCount > 0 ? (
              <span className="ml-1.5 inline-flex items-center gap-0.5 rounded-full bg-app-danger px-1.5 py-0.5 text-[8px] font-black text-white">
                <Server className="h-2 w-2" aria-hidden />
                {pendingServerErrorCount}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {viewMode === "events" ? (
        <div className="ui-card overflow-hidden">
          {eventsLoading ? (
            <p className="p-6 text-sm text-app-text-muted">Loading Developer Errors…</p>
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
                      ({key === "all" ? errorEvents.length : errorEvents.filter((e) => e.status === key).length})
                    </span>
                  </button>
                ))}
                <span className="mx-1 border-r border-app-border" aria-hidden />
                {(
                  [
                    ["all", "All Sources"],
                    ["server", "Server Errors"],
                    ["client", "Client Errors"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setEventSourceFilter(key)}
                    className={`rounded-lg border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
                      eventSourceFilter === key
                        ? key === "server"
                          ? "border-app-danger bg-app-danger/10 text-app-danger"
                          : "border-app-accent bg-app-accent/15 text-app-text"
                        : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-border/20"
                    }`}
                  >
                    {key === "server" && <Server className="mr-1 inline h-3 w-3" aria-hidden />}
                    {label}
                    <span className="ml-1.5 tabular-nums opacity-70">
                      ({key === "all"
                        ? errorEvents.length
                        : key === "server"
                          ? errorEvents.filter((e) => isServerError(e)).length
                          : errorEvents.filter((e) => !isServerError(e)).length})
                    </span>
                  </button>
                ))}
              </div>

              {filteredErrorEvents.length === 0 ? (
                <p className="p-6 text-sm text-app-text-muted">No automated developer errors in this filter.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                    <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      <tr>
                        <th className="px-4 py-3">When</th>
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3">Source</th>
                        <th className="px-4 py-3">Message</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">Route</th>
                        <th className="px-4 py-3 text-right">Open</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {filteredErrorEvents.map((event) => (
                        <tr
                          key={event.id}
                          className={`hover:bg-app-surface-2/80 ${
                            isServerError(event) && event.status === "pending" ? "bg-app-danger/5" : ""
                          }`}
                        >
                          <td className="whitespace-nowrap px-4 py-3 text-xs text-app-text-muted">
                            {new Date(event.created_at).toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-xs font-semibold text-app-text">
                            {errorEventActorLabel(event)}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[9px] ${
                                isServerError(event)
                                  ? "bg-app-danger/15 font-black text-app-danger"
                                  : "bg-app-surface-2 text-app-text-muted"
                              }`}
                            >
                              {isServerError(event) && <Server className="mr-0.5 inline h-2.5 w-2.5" aria-hidden />}
                              {event.event_source.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="max-w-md px-4 py-3 text-xs text-app-text truncate">{event.message}</td>
                          <td className="px-4 py-3">
                            <span className="text-[9px] font-bold uppercase tracking-wider">{event.status}</span>
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
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="ui-card overflow-hidden">
          <div className="flex flex-wrap gap-2 border-b border-app-border bg-app-surface-2/40 p-3">
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
                <span className="ml-1.5 tabular-nums opacity-70">
                  ({key === "all" ? rows.length : rows.filter((r) => r.status === key).length})
                </span>
              </button>
            ))}
          </div>

          {loading ? (
            <p className="p-6 text-sm text-app-text-muted">Loading Bug Reports…</p>
          ) : filteredRows.length === 0 ? (
            <p className="p-6 text-sm text-app-text-muted">No bug reports match this filter.</p>
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
                      <td className="px-4 py-3 text-xs font-semibold text-app-text">{r.staff_name}</td>
                      <td className="max-w-md px-4 py-3 text-xs text-app-text truncate">{r.summary}</td>
                      <td className="px-4 py-3">
                        <span className="text-[9px] font-bold uppercase tracking-wider">{r.status}</span>
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
      )}

      {detail &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" role="presentation" onPointerDown={() => setDetail(null)}>
            <div
              ref={bugDetailRef}
              role="dialog"
              aria-modal="true"
              aria-label="Bug report detail"
              className="bg-app-surface/95 border border-app-border/80 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl shadow-2xl"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-app-border px-5 py-4">
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {new Date(detail.created_at).toLocaleString()} · {detail.staff_name}
                  </p>
                  <p className="mt-1 text-sm font-bold text-app-text">{detail.summary}</p>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase border border-app-border/60"
                  onClick={() => setDetail(null)}
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                    onClick={() =>
                      void copyToClipboardOrDownload(
                        JSON.stringify(detail, null, 2),
                        `ros-bug-${detail.id}-full.json`,
                        () => showToast("Diagnostic JSON copied"),
                      )
                    }
                  >
                    Copy diagnostic JSON
                  </button>
                  {detail.screenshot_png_base64 && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase border border-app-border/60"
                      onClick={() => downloadTextFile(`ros-bug-${detail.id}-screenshot.txt`, detail.screenshot_png_base64)}
                    >
                      Export Screenshot Base64
                    </button>
                  )}
                </div>

                <div className="rounded-xl border border-app-border bg-app-surface-2/50 p-4 space-y-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Triage notes</p>
                  <label className="block">
                    <span className="text-[10px] font-semibold text-app-text-muted">Issue Link / URL</span>
                    <input
                      type="url"
                      className="ui-input mt-1 w-full text-sm bg-app-bg border-app-border"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      placeholder="GitHub issue or tracking link"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[10px] font-semibold text-app-text-muted">Internal notes</span>
                    <textarea
                      className="ui-input mt-1 min-h-[72px] w-full text-sm bg-app-bg border-app-border"
                      value={draftNotes}
                      onChange={(e) => setDraftNotes(e.target.value)}
                      placeholder="Resolution details..."
                    />
                  </label>
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary px-3 py-2 text-[10px] font-black uppercase"
                    onClick={() => void patchReport({ resolver_notes: draftNotes, external_url: draftUrl })}
                  >
                    Save Notes
                  </button>
                </div>

                <div className="flex gap-2">
                  {detail.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary px-3 py-2 text-[10px] font-black uppercase"
                        onClick={() => void patchReport({ status: "complete" })}
                      >
                        Mark Fixed
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost px-3 py-2 text-[10px] font-black uppercase border border-app-border"
                        onClick={() => void patchReport({ status: "dismissed" })}
                      >
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost px-3 py-2 text-[10px] font-black uppercase border border-app-border"
                      onClick={() => void patchReport({ status: "pending" })}
                    >
                      Reopen
                    </button>
                  )}
                </div>

                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Context</p>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-app-text leading-relaxed">{detail.steps_context}</p>
                </div>
                {detail.server_log_snapshot && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Logs Snapshot</p>
                    <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-bg p-3 text-[10px] text-app-text font-mono whitespace-pre-wrap">
                      {detail.server_log_snapshot}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

      {eventDetail &&
        createPortal(
          <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" role="presentation" onPointerDown={() => setEventDetail(null)}>
            <div
              ref={eventDetailRef}
              role="dialog"
              aria-modal="true"
              aria-label="Error event detail"
              className="bg-app-surface/95 border border-app-border/80 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl shadow-2xl"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-3 border-b border-app-border px-5 py-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-danger">
                    <AlertTriangle className="h-4 w-4" />
                    Developer Error
                  </p>
                  <p className="mt-1 text-sm font-bold text-app-text">{eventDetail.message}</p>
                </div>
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost px-3 py-1.5 text-[10px] font-black uppercase border border-app-border/60"
                  onClick={() => setEventDetail(null)}
                >
                  Close
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase"
                    onClick={() =>
                      void copyToClipboardOrDownload(
                        buildAiDiagnosticPackage(eventDetail),
                        `ros-error-event-${eventDetail.id}-ai-diagnostic.md`,
                        () => showToast("AI diagnostic package copied to clipboard"),
                      )
                    }
                  >
                    Copy AI Package
                  </button>
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase border border-app-border text-app-danger"
                    onClick={() =>
                      downloadTextFile(
                        `ros-${isServerError(eventDetail) ? "server" : "client"}-error-${eventDetail.id}-ai-diagnostic.md`,
                        buildAiDiagnosticPackage(eventDetail),
                      )
                    }
                  >
                    Download AI Diagnostic
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="rounded-xl border border-app-border bg-app-bg p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Route</p>
                    <p className="mt-1 break-all font-mono text-xs text-app-text">{eventDetail.route ?? "—"}</p>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Source</p>
                    <p className="mt-1 text-xs font-bold text-app-text">
                      {eventDetail.event_source.replace(/_/g, " ")} · {eventDetail.severity}
                    </p>
                  </div>
                </div>

                {errorEventCapture && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Error Context</p>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-xl border border-app-border bg-app-bg p-3 text-[10px] text-app-text font-mono">
                      {JSON.stringify(errorEventCapture, null, 2)}
                    </pre>
                  </div>
                )}

                {errorEventDiagTail && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Browser Trace</p>
                    <pre className="mt-1 max-h-52 overflow-auto rounded-xl border border-app-border bg-app-bg p-3 text-[10px] text-app-text font-mono whitespace-pre-wrap">
                      {errorEventDiagTail}
                    </pre>
                  </div>
                )}

                {eventDetail.server_log_snapshot && (
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Logs near exception</p>
                    <pre className="mt-1 max-h-56 overflow-auto rounded-xl border border-app-border bg-app-bg p-3 text-[10px] text-app-text font-mono whitespace-pre-wrap">
                      {eventDetail.server_log_snapshot}
                    </pre>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 border-t border-app-border pt-4">
                  {eventDetail.status === "pending" ? (
                    <>
                      <button
                        type="button"
                        className="ui-btn ui-btn-primary px-3 py-2 text-[10px] font-black uppercase"
                        onClick={() => void patchErrorEventStatus(eventDetail.id, "complete")}
                      >
                        Mark Completed
                      </button>
                      <button
                        type="button"
                        className="ui-btn ui-btn-ghost px-3 py-2 text-[10px] font-black uppercase border border-app-border"
                        onClick={() => void patchErrorEventStatus(eventDetail.id, "archived")}
                      >
                        Archive
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ui-btn ui-btn-ghost px-3 py-2 text-[10px] font-black uppercase border border-app-border"
                      onClick={() => void patchErrorEventStatus(eventDetail.id, "pending")}
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase text-app-danger hover:text-red-500 ml-auto"
                    onClick={() => {
                      if (confirm("Delete this error permanently?")) {
                        void deleteErrorEvent(eventDetail.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
