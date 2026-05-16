import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, MessageSquare, RefreshCw, Search, Send, UserPlus } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

type InboxRow = {
  conversation_id: string;
  customer_id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  channel: string;
  last_message_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_viewed_at: string | null;
  needs_reply: boolean;
  unread: boolean;
  snippet: string | null;
};

type PodiumHealth = {
  credentials_configured: boolean;
  sms_send_enabled: boolean;
  location_uid_configured: boolean;
  webhook_secret_configured: boolean;
  inbound_ingest_enabled: boolean;
  local_conversation_count: number;
  unmatched_conversation_count: number;
  last_webhook_received_at: string | null;
  last_webhook_failure_at: string | null;
  last_webhook_failure_reason: string | null;
  last_message_at: string | null;
  last_outbound_at: string | null;
  last_sync_at: string | null;
};

type UnmatchedConversation = {
  id: string;
  provider_conversation_uid: string;
  channel: string;
  identifier: string | null;
  last_message_at: string | null;
  snippet: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

type DirectSmsCustomerResult = {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
};

export default function PodiumMessagingInboxSection({
  onOpenCustomerHub,
}: {
  onOpenCustomerHub: (customer: Customer) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
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
  const [triageFilter, setTriageFilter] = useState<"all" | "needs_reply" | "unread">("all");
  const [health, setHealth] = useState<PodiumHealth | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [selectedRow, setSelectedRow] = useState<InboxRow | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [unmatchedRows, setUnmatchedRows] = useState<UnmatchedConversation[]>([]);
  const [directCustomerSearch, setDirectCustomerSearch] = useState("");
  const [directCustomerResults, setDirectCustomerResults] = useState<DirectSmsCustomerResult[]>([]);
  const [directCustomer, setDirectCustomer] = useState<DirectSmsCustomerResult | null>(null);
  const [directPhone, setDirectPhone] = useState("");
  const [directFirstName, setDirectFirstName] = useState("");
  const [directLastName, setDirectLastName] = useState("");
  const [directBody, setDirectBody] = useState("");
  const [directSearchBusy, setDirectSearchBusy] = useState(false);
  const [directSendBusy, setDirectSendBusy] = useState(false);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-health`, {
        headers: apiAuth(),
        cache: "no-store",
      });
      if (res.ok) setHealth((await res.json()) as PodiumHealth);
    } catch {
      setHealth(null);
    }
  }, [apiAuth]);

  const loadUnmatched = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-unmatched?limit=25`, {
        headers: apiAuth(),
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as UnmatchedConversation[];
        setUnmatchedRows(Array.isArray(data) ? data : []);
      }
    } catch {
      setUnmatchedRows([]);
    }
  }, [apiAuth]);

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
      void loadHealth();
      void loadUnmatched();
    } catch {
      setLoadError("Could not refresh Podium inbox.");
    } finally {
      setLoading(false);
    }
  }, [apiAuth, loadHealth, loadUnmatched]);

  useEffect(() => {
    void refresh();
    void loadHealth();
    void loadUnmatched();
  }, [loadHealth, loadUnmatched, refresh]);

  const channelOptions = useMemo(
    () => Array.from(new Set(rows.map((row) => row.channel).filter(Boolean))).sort(),
    [rows],
  );

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (channelFilter !== "all" && row.channel !== channelFilter) return false;
      if (triageFilter === "needs_reply" && !row.needs_reply) return false;
      if (triageFilter === "unread" && !row.unread) return false;
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
  }, [channelFilter, rows, search, triageFilter]);

  const runSync = async () => {
    setSyncBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ limit: 200 }),
      });
      if (!res.ok) {
        toast("Podium sync could not run. Check credentials and scopes.", "error");
        return;
      }
      const result = (await res.json()) as {
        conversations_matched: number;
        conversations_unmatched: number;
        messages_inserted: number;
        errors?: string[];
      };
      toast(
        `Podium sync added ${result.messages_inserted} messages across ${result.conversations_matched} conversations. ${result.conversations_unmatched} need customer matching.`,
        "success",
      );
      await refresh();
    } finally {
      setSyncBusy(false);
    }
  };

  const markRead = async (row: InboxRow) => {
    await fetch(`${baseUrl}/api/customers/podium/conversations/${row.conversation_id}/read`, {
      method: "POST",
      headers: apiAuth(),
    }).catch(() => {});
  };

  const openCustomer = async (row: InboxRow) => {
    await markRead(row);
    onOpenCustomerHub({
      id: row.customer_id,
      customer_code: row.customer_code,
      first_name: row.first_name,
      last_name: row.last_name,
      company_name: null,
      email: null,
      phone: null,
    });
    void refresh();
  };

  const sendReply = async () => {
    if (!selectedRow) return;
    const body = replyDraft.trim();
    if (!body) return;
    setReplyBusy(true);
    try {
      const channel = selectedRow.channel === "email" ? "email" : "sms";
      const subject = replySubject.trim();
      if (channel === "email" && !subject) {
        toast("Subject is required for email replies.", "error");
        return;
      }
      const res = await fetch(`${baseUrl}/api/customers/${selectedRow.customer_id}/podium/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ channel, subject, body }),
      });
      if (!res.ok) {
        toast("Could not send Podium reply.", "error");
        return;
      }
      toast(channel === "email" ? "Email sent" : "Podium SMS sent", "success");
      setReplyDraft("");
      setReplySubject("");
      await markRead(selectedRow);
      await refresh();
    } finally {
      setReplyBusy(false);
    }
  };

  const searchDirectCustomers = async () => {
    const q = directCustomerSearch.trim();
    if (q.length < 2) {
      toast("Enter at least two characters to search customers.", "error");
      return;
    }
    setDirectSearchBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=8`,
        { headers: apiAuth(), cache: "no-store" },
      );
      if (!res.ok) {
        toast("Could not search customers.", "error");
        return;
      }
      const data = (await res.json()) as DirectSmsCustomerResult[];
      setDirectCustomerResults(Array.isArray(data) ? data : []);
    } finally {
      setDirectSearchBusy(false);
    }
  };

  const chooseDirectCustomer = (customer: DirectSmsCustomerResult) => {
    setDirectCustomer(customer);
    setDirectPhone(customer.phone ?? "");
    setDirectFirstName("");
    setDirectLastName("");
    setDirectCustomerResults([]);
  };

  const clearDirectCustomer = () => {
    setDirectCustomer(null);
    setDirectCustomerSearch("");
    setDirectCustomerResults([]);
  };

  const sendDirectSms = async () => {
    const body = directBody.trim();
    if (!body) {
      toast("Message text is required.", "error");
      return;
    }
    if (directCustomer && !directCustomer.phone) {
      toast("Selected customer has no phone on file.", "error");
      return;
    }
    if (!directCustomer && !directPhone.trim()) {
      toast("Phone number is required.", "error");
      return;
    }
    if (!directCustomer && (!directFirstName.trim() || !directLastName.trim())) {
      toast("First and last name are required for a new Podium contact.", "error");
      return;
    }
    setDirectSendBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/direct-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          customer_id: directCustomer?.id,
          phone: directPhone,
          first_name: directFirstName,
          last_name: directLastName,
          body,
        }),
      });
      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as { error?: string };
        toast(error.error ?? "Could not send Podium SMS.", "error");
        return;
      }
      const result = (await res.json()) as { customer_created?: boolean };
      toast(result.customer_created ? "Contact created and SMS sent" : "Podium SMS sent", "success");
      setDirectBody("");
      if (!directCustomer) {
        setDirectPhone("");
        setDirectFirstName("");
        setDirectLastName("");
      }
      await refresh();
    } finally {
      setDirectSendBusy(false);
    }
  };

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
            Current Podium SMS and email conversations from matched customers.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={syncBusy}
            className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncBusy ? "animate-spin" : ""} aria-hidden />
            Sync Podium
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
          >
            Refresh
          </button>
        </div>
      </div>

      {health ? (
        <div className="grid gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Credentials", health.credentials_configured ? "Configured" : "Missing"],
            ["Webhook", health.last_webhook_received_at ? new Date(health.last_webhook_received_at).toLocaleString() : "No delivery"],
            ["Last message", health.last_message_at ? new Date(health.last_message_at).toLocaleString() : "None"],
            ["Unmatched", `${health.unmatched_conversation_count} provider threads`],
            ["Last failure", health.last_webhook_failure_at ? health.last_webhook_failure_reason ?? "Webhook rejected" : "None recorded"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-app-surface-2 px-3 py-2">
              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                {label}
              </p>
              <p className="mt-1 font-bold text-app-text">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

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
          <select
            value={triageFilter}
            onChange={(event) => setTriageFilter(event.target.value as typeof triageFilter)}
            className="ui-input h-10 rounded-xl px-3 text-[10px] font-black uppercase tracking-widest"
            aria-label="Filter Podium inbox by triage state"
          >
            <option value="all">All states</option>
            <option value="needs_reply">Needs reply</option>
            <option value="unread">Unread</option>
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
        <p className="text-sm text-app-text-muted">Loading...</p>
      ) : visibleRows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-app-border/60 bg-app-surface px-6 py-10 text-center text-app-text-muted">
          <MessageSquare size={40} className="mb-3 opacity-70" />
          <p className="text-sm font-black uppercase tracking-widest italic text-app-text">
            {loadError
              ? "Podium inbox could not refresh"
              : rows.length > 0
                ? "No conversations match this view"
                : "No ROS-synced Podium conversations yet"}
          </p>
          <p className="mt-2 max-w-sm text-sm font-medium normal-case tracking-normal text-app-text-muted">
            {loadError
              ? "Retry is safe. Do not treat the inbox as empty until refresh succeeds."
              : rows.length > 0
                ? "Clear the search or switch channels to see the remaining synced conversations."
                : "This view only shows Podium messages that reached Riverside OS through webhooks or replies sent from ROS. If Podium has live conversations but this stays empty, verify Podium webhook delivery in Settings."}
          </p>
        </div>
      ) : (
        <div className="grid flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface">
            <ul className="divide-y divide-app-border">
              {visibleRows.map((r) => (
                <li key={r.conversation_id}>
                  <div
                    className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-app-surface-2/80 ${
                      selectedRow?.conversation_id === r.conversation_id ? "bg-app-accent/8" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <MessageSquare size={14} className="shrink-0 text-app-accent" aria-hidden />
                      {r.unread ? (
                        <span className="h-2 w-2 rounded-full bg-app-accent" aria-label="Unread" />
                      ) : null}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openCustomer(r);
                        }}
                        className="rounded-md px-1 py-0.5 text-left font-black text-app-text underline decoration-app-accent/50 underline-offset-4 hover:text-app-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30"
                        title="Open this customer in the Messages tab"
                      >
                        {r.first_name} {r.last_name}
                      </button>
                      <span className="font-mono text-[10px] text-app-text-muted">
                        {r.customer_code}
                      </span>
                      <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                        {r.channel}
                      </span>
                      {r.needs_reply ? (
                        <span className="rounded border border-app-warning/40 bg-app-warning/10 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-warning">
                          Needs reply
                        </span>
                      ) : null}
                      <span className="ml-auto text-[10px] text-app-text-muted">
                        {new Date(r.last_message_at).toLocaleString()}
                      </span>
                    </div>
                    {r.snippet ? (
                      <p className="line-clamp-2 pl-[22px] text-xs text-app-text-muted">
                        {r.snippet}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2 pl-[22px]">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedRow(r);
                          setReplySubject("");
                          setReplyDraft("");
                        }}
                        className="mt-1 rounded-full border border-app-border px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted hover:border-app-accent/40 hover:text-app-accent"
                      >
                        Quick Reply
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void openCustomer(r);
                        }}
                        className="mt-1 rounded-full border border-app-accent/30 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-accent hover:bg-app-accent hover:text-white"
                      >
                        Open Messages
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <aside className="rounded-xl border border-app-border bg-app-surface p-4">
            {selectedRow ? (
              <div className="space-y-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Quick {selectedRow.channel === "email" ? "email" : "SMS"} reply
                  </p>
                  <h2 className="mt-1 text-sm font-black text-app-text">
                    {selectedRow.first_name} {selectedRow.last_name}
                  </h2>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Last customer:{" "}
                    {selectedRow.last_inbound_at
                      ? new Date(selectedRow.last_inbound_at).toLocaleString()
                      : "No inbound message"}
                  </p>
                </div>
                {selectedRow.channel === "email" ? (
                  <input
                    value={replySubject}
                    onChange={(event) => setReplySubject(event.target.value)}
                    className="ui-input w-full px-3 py-2 text-sm"
                    placeholder="Email subject"
                  />
                ) : null}
                <textarea
                  value={replyDraft}
                  onChange={(event) => setReplyDraft(event.target.value)}
                  className="ui-input min-h-32 w-full resize-y p-3 text-sm"
                  placeholder={selectedRow.channel === "email" ? "Type an email reply..." : "Type an SMS reply..."}
                />
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={
                    replyBusy ||
                    !replyDraft.trim() ||
                    (selectedRow.channel === "email" && !replySubject.trim())
                  }
                  className="ui-btn-primary inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                >
                  <Send size={13} aria-hidden />
                  {replyBusy ? "Sending..." : selectedRow.channel === "email" ? "Send Email" : "Send SMS"}
                </button>
                <button
                  type="button"
                  onClick={() => void openCustomer(selectedRow)}
                  className="ui-btn-secondary w-full px-4 py-2 text-[10px] font-black uppercase tracking-widest"
                >
                  Open Messages Thread
                </button>
              </div>
            ) : (
              <p className="text-sm text-app-text-muted">
                Select a conversation for a quick reply.
              </p>
            )}
          </aside>
        </div>
      )}

      <div className="rounded-xl border border-app-border bg-app-surface px-4 py-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserPlus size={16} className="text-app-accent" aria-hidden />
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-app-text">
                Send Text
              </h2>
              <p className="text-xs font-semibold text-app-text-muted">
                Select a current customer or enter any phone number.
              </p>
            </div>
          </div>
          {directCustomer ? (
            <button
              type="button"
              onClick={clearDirectCustomer}
              className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              Use New Number
            </button>
          ) : null}
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Current customer
            </label>
            {directCustomer ? (
              <div className="rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-sm">
                <p className="font-black text-app-text">
                  {directCustomer.first_name} {directCustomer.last_name}
                </p>
                <p className="text-xs font-semibold text-app-text-muted">
                  {directCustomer.customer_code} · {directCustomer.phone ?? "No phone on file"}
                </p>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <input
                    type="search"
                    value={directCustomerSearch}
                    onChange={(event) => setDirectCustomerSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void searchDirectCustomers();
                    }}
                    className="ui-input h-10 min-w-0 flex-1 rounded-xl px-3 text-sm"
                    placeholder="Name, code, phone, or email"
                    aria-label="Search customers for Podium SMS"
                  />
                  <button
                    type="button"
                    onClick={() => void searchDirectCustomers()}
                    disabled={directSearchBusy}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                  >
                    <Search size={13} aria-hidden />
                    Find
                  </button>
                </div>
                {directCustomerResults.length > 0 ? (
                  <ul className="max-h-40 overflow-y-auto rounded-lg border border-app-border bg-app-surface">
                    {directCustomerResults.map((customer) => (
                      <li key={customer.id} className="border-b border-app-border last:border-b-0">
                        <button
                          type="button"
                          onClick={() => chooseDirectCustomer(customer)}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-app-surface-2"
                        >
                          <span className="font-black text-app-text">
                            {customer.first_name} {customer.last_name}
                          </span>
                          <span className="ml-2 font-mono text-app-text-muted">
                            {customer.customer_code}
                          </span>
                          <span className="block font-semibold text-app-text-muted">
                            {customer.phone ?? "No phone on file"}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}

            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Phone number
            </label>
            <input
              value={directPhone}
              onChange={(event) => setDirectPhone(event.target.value)}
              disabled={!!directCustomer}
              className="ui-input h-10 w-full rounded-xl px-3 text-sm disabled:opacity-70"
              placeholder="+1 (555) 555-5555"
              aria-label="Phone number for Podium SMS"
            />

            {!directCustomer ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    First name
                  </label>
                  <input
                    value={directFirstName}
                    onChange={(event) => setDirectFirstName(event.target.value)}
                    className="ui-input h-10 w-full rounded-xl px-3 text-sm"
                    placeholder="First"
                    aria-label="First name for new Podium contact"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Last name
                  </label>
                  <input
                    value={directLastName}
                    onChange={(event) => setDirectLastName(event.target.value)}
                    className="ui-input h-10 w-full rounded-xl px-3 text-sm"
                    placeholder="Last"
                    aria-label="Last name for new Podium contact"
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Message
            </label>
            <textarea
              value={directBody}
              onChange={(event) => setDirectBody(event.target.value)}
              className="ui-input min-h-36 w-full resize-y rounded-xl p-3 text-sm"
              placeholder="Type a text message..."
              aria-label="Text message body"
            />
            <button
              type="button"
              onClick={() => void sendDirectSms()}
              disabled={
                directSendBusy ||
                !directBody.trim() ||
                (!!directCustomer && !directCustomer.phone) ||
                (!directCustomer &&
                  (!directPhone.trim() || !directFirstName.trim() || !directLastName.trim()))
              }
              className="ui-btn-primary inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
            >
              <Send size={13} aria-hidden />
              {directSendBusy ? "Sending..." : "Send Text"}
            </button>
          </div>
        </div>
      </div>

      {unmatchedRows.length > 0 ? (
        <div className="rounded-xl border border-app-warning/30 bg-app-warning/10 px-4 py-3">
          <div className="mb-2 flex items-start gap-2 text-sm text-app-text">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-app-warning" aria-hidden />
            <div>
              <p className="font-black">Unknown Podium senders</p>
              <p className="text-xs font-semibold text-app-text-muted">
                These synced provider threads are not matched to a ROS customer yet. Match by phone or email before treating them as customer history.
              </p>
            </div>
          </div>
          <ul className="grid gap-2 lg:grid-cols-2">
            {unmatchedRows.map((row) => (
              <li key={row.id} className="rounded-lg border border-app-warning/30 bg-app-surface px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-black uppercase tracking-widest text-app-text-muted">
                    {row.channel}
                  </span>
                  <span className="font-mono text-app-text">{row.identifier ?? "No identifier"}</span>
                  <span className="ml-auto text-app-text-muted">
                    {new Date(row.last_seen_at).toLocaleString()}
                  </span>
                </div>
                {row.snippet ? (
                  <p className="mt-1 line-clamp-1 text-app-text-muted">{row.snippet}</p>
                ) : null}
                <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                  Use the identifier to find or create the customer, then sync again so the thread can attach.
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
