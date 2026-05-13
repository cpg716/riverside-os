import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, MessageSquare, Search } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

const baseUrl = getBaseUrl();

type InboxRow = {
  conversation_id: string;
  customer_id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  channel: string;
  last_message_at: string;
  snippet: string | null;
};

export default function PodiumMessagingInboxSection({
  onOpenCustomerHub,
}: {
  onOpenCustomerHub: (customer: Customer) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-inbox?limit=80`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        setLoadError("Could not refresh Podium inbox.");
        return;
      }
      const data = (await res.json()) as InboxRow[];
      setRows(Array.isArray(data) ? data : []);
      setLoadError(null);
      setLastLoadedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    } catch {
      setLoadError("Could not refresh Podium inbox.");
    } finally {
      setLoading(false);
    }
  }, [apiAuth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const channelOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.channel).filter(Boolean))).sort(),
    [rows],
  );

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (channelFilter !== "all" && row.channel !== channelFilter) return false;
      if (!needle) return true;
      return [
        row.first_name,
        row.last_name,
        row.customer_code,
        row.channel,
        row.snippet,
        row.last_message_at,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [channelFilter, rows, search]);

  return (
    <div className="ui-page flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <IntegrationBrandLogo
              brand="podium"
              className="inline-flex rounded-2xl border border-app-border bg-white px-3 py-2 shadow-sm"
              imageClassName="h-8 w-auto object-contain"
            />
            <h1 className="text-lg font-black uppercase tracking-tight text-app-text">
              Inbox
            </h1>
          </div>
          <p className="text-xs text-app-text-muted">
            Recent Podium SMS and email threads (inbound webhooks and replies). Open a row to view the full
            thread in the customer hub.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          Refresh
        </button>
      </div>

      {rows.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-3 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
              aria-hidden
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find customer, code, or message"
              className="ui-input h-10 w-full rounded-xl pl-9 pr-3 text-xs font-bold"
              aria-label="Search Podium inbox"
            />
          </div>
          <select
            value={channelFilter}
            onChange={(event) => setChannelFilter(event.target.value)}
            className="ui-input h-10 rounded-xl px-3 text-[10px] font-black uppercase tracking-widest"
            aria-label="Filter Podium inbox by channel"
          >
            <option value="all">All channels</option>
            {channelOptions.map((channel) => (
              <option key={channel} value={channel}>
                {channel}
              </option>
            ))}
          </select>
          <span className="whitespace-nowrap text-xs font-bold text-app-text-muted">
            {visibleRows.length} / {rows.length} threads
          </span>
        </div>
      ) : null}

      {loadError ? (
        <div className="rounded-xl border border-app-warning/40 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-app-warning" />
              <div>
                <p className="font-black">{loadError}</p>
                <p className="text-xs text-app-text-muted">
                  {rows.length > 0
                    ? `Showing last loaded conversations${lastLoadedAt ? ` from ${lastLoadedAt}` : ""}. Refreshing is safe; it does not send or change messages.`
                    : "No conversations loaded. Refresh again before treating the inbox as empty."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-lg border border-app-warning/40 bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
            >
              Try Again
            </button>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-app-border/60 bg-app-surface px-6 py-10 text-center text-app-text-muted">
          <MessageSquare size={40} className="mb-3 opacity-70" />
          <p className="text-sm font-black uppercase tracking-widest italic text-app-text">
            {loadError
              ? "Podium inbox could not refresh"
              : rows.length > 0
                ? "No conversations match this view"
                : "No Podium conversations yet"}
          </p>
          <p className="mt-2 max-w-sm text-sm font-medium normal-case tracking-normal text-app-text-muted">
            {loadError
              ? "Retry is safe. Do not treat the inbox as empty until refresh succeeds."
              : rows.length > 0
                ? "Clear the search or switch channels to see the remaining synced conversations."
              : "New inbound messages and replies will land here after the first synced customer conversation."}
          </p>
        </div>
      ) : (
        <div className="flex-1 rounded-xl border border-app-border bg-app-surface">
          <ul className="divide-y divide-app-border">
            {visibleRows.map((r) => (
              <li key={r.conversation_id}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenCustomerHub({
                      id: r.customer_id,
                      customer_code: r.customer_code,
                      first_name: r.first_name,
                      last_name: r.last_name,
                      company_name: null,
                      email: null,
                      phone: null,
                    })
                  }
                  className="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-app-surface-2/80"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <MessageSquare size={14} className="shrink-0 text-app-accent" aria-hidden />
                    <span className="font-bold text-app-text">
                      {r.first_name} {r.last_name}
                    </span>
                    <span className="font-mono text-[10px] text-app-text-muted">
                      {r.customer_code}
                    </span>
                    <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                      {r.channel}
                    </span>
                    <span className="ml-auto text-[10px] text-app-text-muted">
                      {new Date(r.last_message_at).toLocaleString()}
                    </span>
                  </div>
                  {r.snippet ? (
                    <p className="line-clamp-2 pl-[22px] text-xs text-app-text-muted">
                      {r.snippet}
                    </p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
