import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  Send,
  UserCircle,
  UserPlus,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();
const INBOX_LOCAL_REFRESH_MS = 60_000;
const PROVIDER_PULL_STALE_MS = 30 * 60 * 60 * 1000;

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

type PodiumMessageRow = {
  id: string;
  conversation_id: string;
  podium_conversation_uid: string | null;
  direction: string;
  channel: string;
  body: string;
  staff_id: string | null;
  staff_full_name: string | null;
  podium_sender_uid: string | null;
  podium_sender_name: string | null;
  created_at: string;
};

type DirectSmsCustomerResult = {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
};

function customerName(row: InboxRow) {
  return `${row.first_name} ${row.last_name}`.trim() || "Customer";
}

function initials(row: InboxRow) {
  const first = row.first_name.trim().charAt(0);
  const last = row.last_name.trim().charAt(0);
  return `${first}${last}`.toUpperCase() || "C";
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fullDateTime(value: string | null | undefined) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not yet";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isOlderThan(value: string | null | undefined, maxAgeMs: number) {
  if (!value) return true;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return true;
  return Date.now() - date.getTime() > maxAgeMs;
}

function channelIcon(channel: string) {
  return channel === "email" ? Mail : Phone;
}

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
  const [threadMessages, setThreadMessages] = useState<PodiumMessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [unmatchedRows, setUnmatchedRows] = useState<UnmatchedConversation[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [directCustomerSearch, setDirectCustomerSearch] = useState("");
  const [directCustomerResults, setDirectCustomerResults] = useState<DirectSmsCustomerResult[]>([]);
  const [directCustomer, setDirectCustomer] = useState<DirectSmsCustomerResult | null>(null);
  const [directPhone, setDirectPhone] = useState("");
  const [directFirstName, setDirectFirstName] = useState("");
  const [directLastName, setDirectLastName] = useState("");
  const [directBody, setDirectBody] = useState("");
  const [directSearchBusy, setDirectSearchBusy] = useState(false);
  const [directSendBusy, setDirectSendBusy] = useState(false);
  const autoProviderPullKeyRef = useRef<string | null>(null);

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

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    if (!opts?.background) setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-inbox?limit=80`, {
        headers: apiAuth(),
        cache: "no-store",
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
      if (!opts?.background) setLoading(false);
    }
  }, [apiAuth, loadHealth, loadUnmatched]);

  useEffect(() => {
    void refresh();
    void loadHealth();
    void loadUnmatched();
  }, [loadHealth, loadUnmatched, refresh]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh({ background: true });
      }
    }, INBOX_LOCAL_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

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

  useEffect(() => {
    if (selectedRow && visibleRows.some((row) => row.conversation_id === selectedRow.conversation_id)) {
      return;
    }
    setSelectedRow(visibleRows[0] ?? null);
  }, [selectedRow, visibleRows]);

  useEffect(() => {
    if (!selectedRow) {
      setThreadMessages([]);
      return;
    }
    let cancelled = false;
    const loadThread = async () => {
      setThreadLoading(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/${encodeURIComponent(selectedRow.customer_id)}/podium/messages`,
          { headers: apiAuth(), cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) setThreadMessages([]);
          return;
        }
        const data = (await res.json()) as PodiumMessageRow[];
        if (!cancelled) {
          setThreadMessages(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!cancelled) setThreadMessages([]);
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    };
    void loadThread();
    return () => {
      cancelled = true;
    };
  }, [apiAuth, selectedRow]);

  const runSync = useCallback(async (opts?: { quiet?: boolean }) => {
    setSyncBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ limit: 200 }),
      });
      if (!res.ok) {
        if (!opts?.quiet) {
          toast("Podium pull could not run. Check credentials and permissions.", "error");
        }
        return;
      }
      const result = (await res.json()) as {
        conversations_matched: number;
        conversations_unmatched: number;
        messages_inserted: number;
        errors?: string[];
      };
      if (!opts?.quiet) {
        toast(
          `Podium pull added ${result.messages_inserted} messages across ${result.conversations_matched} conversations. ${result.conversations_unmatched} need customer matching.`,
          "success",
        );
      }
      await refresh({ background: opts?.quiet });
    } finally {
      setSyncBusy(false);
    }
  }, [apiAuth, refresh, toast]);

  const providerPullDue = useMemo(
    () =>
      !!health?.credentials_configured &&
      !!health.location_uid_configured &&
      isOlderThan(health.last_sync_at, PROVIDER_PULL_STALE_MS),
    [health],
  );

  useEffect(() => {
    if (!providerPullDue || syncBusy) return;
    const key = health?.last_sync_at ?? "never";
    if (autoProviderPullKeyRef.current === key) return;
    autoProviderPullKeyRef.current = key;
    void runSync({ quiet: true });
  }, [health?.last_sync_at, providerPullDue, runSync, syncBusy]);

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
      const currentRow = selectedRow;
      await refresh();
      if (currentRow) {
        setSelectedRow(currentRow);
      }
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

  const unreadCount = rows.filter((row) => row.unread).length;
  const needsReplyCount = rows.filter((row) => row.needs_reply).length;
  const selectedMessages =
    selectedRow && threadMessages.length === 0 && selectedRow.snippet
      ? [
          {
            id: `${selectedRow.conversation_id}-preview`,
            conversation_id: selectedRow.conversation_id,
            podium_conversation_uid: null,
            direction: selectedRow.needs_reply ? "inbound" : "outbound",
            channel: selectedRow.channel,
            body: selectedRow.snippet ?? "",
            staff_id: null,
            staff_full_name: null,
            podium_sender_uid: null,
            podium_sender_name: null,
            created_at: selectedRow.last_message_at,
          } satisfies PodiumMessageRow,
        ]
      : threadMessages;
  const SelectedChannelIcon = selectedRow ? channelIcon(selectedRow.channel) : MessageCircle;

  return (
    <div className="ui-page flex flex-1 flex-col gap-5 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-app-text-muted">
            Customer messaging
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-black tracking-tight text-app-text">
              Podium Inbox
            </h1>
            <IntegrationBrandLogo
              brand="podium"
              kind="icon"
              className="inline-flex rounded-xl border border-app-border bg-white p-2 shadow-sm"
              imageClassName="h-5 w-5 object-contain"
            />
          </div>
          <p className="mt-2 max-w-2xl text-sm font-semibold text-app-text-muted">
            Review customer texts, reply in context, and open the customer record when a message needs follow-up.
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
            Pull from Podium
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Conversations", `${rows.length}`],
            ["Needs reply", `${needsReplyCount}`],
            ["Unread", `${unreadCount}`],
            ["Last Podium pull", health.last_sync_at ? fullDateTime(health.last_sync_at) : "Not yet"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-app-border bg-app-surface px-4 py-4 shadow-sm">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {label}
              </p>
              <p className="mt-2 text-2xl font-black text-app-text">{value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {health ? (
        <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-3 text-sm shadow-sm">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Inbox updating
              </p>
              <p className="mt-1 font-semibold text-app-text">
                This screen refreshes every minute while open. New Podium webhooks appear here after refresh.
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Last webhook: {fullDateTime(health.last_webhook_received_at)} · Last local message: {fullDateTime(health.last_message_at)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`ui-pill ${
                  health.webhook_secret_configured && health.inbound_ingest_enabled
                    ? "bg-app-success/10 text-app-success"
                    : "bg-app-warning/10 text-app-warning"
                }`}
              >
                {health.webhook_secret_configured && health.inbound_ingest_enabled
                  ? "Webhook ready"
                  : "Webhook needs setup"}
              </span>
              <span
                className={`ui-pill ${
                  providerPullDue ? "bg-app-warning/10 text-app-warning" : "bg-app-success/10 text-app-success"
                }`}
              >
                {providerPullDue
                  ? syncBusy
                    ? "Pulling missed history"
                    : "Missed-history pull due"
                  : "Missed-history pull current"}
              </span>
            </div>
          </div>
          {health.last_webhook_failure_at ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              Last webhook issue: {fullDateTime(health.last_webhook_failure_at)}
              {health.last_webhook_failure_reason ? ` - ${health.last_webhook_failure_reason}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-app-border bg-app-surface px-3 py-3 shadow-sm sm:flex-row sm:items-center">
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
        <div className="grid min-h-[620px] flex-1 gap-4 xl:grid-cols-[24rem_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="border-b border-app-border px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Conversations
              </p>
            </div>
            <ul className="max-h-[640px] divide-y divide-app-border overflow-y-auto">
              {visibleRows.map((r) => (
                <li key={r.conversation_id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRow(r);
                      setReplySubject("");
                      setReplyDraft("");
                    }}
                    className={`flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-app-surface-2/80 ${
                      selectedRow?.conversation_id === r.conversation_id ? "bg-app-accent/8" : ""
                    }`}
                  >
                    <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-app-accent/10 text-sm font-black text-app-accent">
                      {initials(r)}
                      {r.unread ? (
                        <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-app-surface bg-app-accent" aria-label="Unread" />
                      ) : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-black text-app-text">
                          {customerName(r)}
                        </p>
                        <span className="shrink-0 text-[10px] font-bold text-app-text-muted">
                          {relativeTime(r.last_message_at)}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                        {(() => {
                          const Icon = channelIcon(r.channel);
                          return <Icon size={12} aria-hidden />;
                        })()}
                        <span>{r.channel}</span>
                        <span>·</span>
                        <span>{r.customer_code}</span>
                      </div>
                      {r.snippet ? (
                        <p className="mt-1 line-clamp-2 text-xs font-semibold leading-relaxed text-app-text-muted">
                          {r.snippet}
                        </p>
                      ) : null}
                      {r.needs_reply ? (
                        <span className="mt-2 inline-flex rounded-full border border-app-warning/40 bg-app-warning/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-app-warning">
                          Reply needed
                        </span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            {selectedRow ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-app-border px-5 py-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-app-accent/10 text-base font-black text-app-accent">
                      {initials(selectedRow)}
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-black text-app-text">
                        {customerName(selectedRow)}
                      </h2>
                      <p className="flex items-center gap-2 text-xs font-semibold text-app-text-muted">
                        <SelectedChannelIcon size={13} aria-hidden />
                        {selectedRow.channel === "email" ? "Email" : "Text message"} · Last activity {relativeTime(selectedRow.last_message_at)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openCustomer(selectedRow)}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <UserCircle size={14} aria-hidden />
                    Open Customer
                  </button>
                </div>
                <div className="flex min-h-[360px] flex-1 flex-col gap-3 overflow-y-auto bg-app-bg/40 px-5 py-5">
                  {threadLoading ? (
                    <p className="text-sm font-semibold text-app-text-muted">
                      Loading conversation...
                    </p>
                  ) : selectedMessages.length > 0 ? (
                    selectedMessages.map((message) => {
                      const outbound = message.direction === "outbound";
                      return (
                        <div
                          key={message.id}
                          className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                        >
                          <div
                            className={`max-w-[78%] rounded-3xl px-4 py-3 text-sm shadow-sm ${
                              outbound
                                ? "rounded-br-md bg-app-accent text-white"
                                : "rounded-bl-md border border-app-border bg-app-surface text-app-text"
                            }`}
                          >
                            <p className="whitespace-pre-wrap leading-relaxed">{message.body}</p>
                            <p
                              className={`mt-2 text-[10px] font-semibold ${
                                outbound ? "text-white/75" : "text-app-text-muted"
                              }`}
                            >
                              {outbound
                                ? message.staff_full_name ?? message.podium_sender_name ?? "Riverside"
                                : customerName(selectedRow)}{" "}
                              · {fullDateTime(message.created_at)}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center text-center text-app-text-muted">
                      <MessageCircle size={36} className="mb-3 opacity-70" aria-hidden />
                      <p className="text-sm font-black text-app-text">
                        No messages loaded for this conversation yet.
                      </p>
                      <p className="mt-1 max-w-sm text-xs font-semibold">
                        Pull from Podium or open the customer record if this thread needs more history.
                      </p>
                    </div>
                  )}
                </div>
                <div className="border-t border-app-border bg-app-surface px-5 py-4">
                  {selectedRow.channel === "email" ? (
                    <input
                      value={replySubject}
                      onChange={(event) => setReplySubject(event.target.value)}
                      className="ui-input mb-2 w-full rounded-xl px-3 py-2 text-sm"
                      placeholder="Email subject"
                    />
                  ) : null}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <textarea
                      value={replyDraft}
                      onChange={(event) => setReplyDraft(event.target.value)}
                      className="ui-input min-h-20 flex-1 resize-y rounded-2xl p-3 text-sm"
                      placeholder={selectedRow.channel === "email" ? "Type an email reply..." : "Type a text message..."}
                    />
                    <button
                      type="button"
                      onClick={() => void sendReply()}
                      disabled={
                        replyBusy ||
                        !replyDraft.trim() ||
                        (selectedRow.channel === "email" && !replySubject.trim())
                      }
                      className="ui-btn-primary inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50 sm:self-end"
                    >
                      <Send size={14} aria-hidden />
                      {replyBusy ? "Sending..." : "Send"}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-app-text-muted">
                <MessageCircle size={40} className="mb-3 opacity-70" aria-hidden />
                <p className="text-sm font-semibold">
                  Select a conversation to read and reply.
                </p>
              </div>
            )}
          </section>
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
        <div className="rounded-2xl border border-app-warning/30 bg-app-warning/10 px-4 py-3">
          <button
            type="button"
            onClick={() => setShowUnmatched((value) => !value)}
            className="flex w-full items-start justify-between gap-3 text-left text-sm text-app-text"
          >
            <span className="flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-app-warning" aria-hidden />
              <span>
                <span className="block font-black">Unknown Podium senders</span>
                <span className="block text-xs font-semibold text-app-text-muted">
                  {unmatchedRows.length} synced threads need a matching customer before they become customer history.
                </span>
              </span>
            </span>
            {showUnmatched ? <ChevronUp size={18} aria-hidden /> : <ChevronDown size={18} aria-hidden />}
          </button>
          {showUnmatched ? (
            <div className="mt-3">
              <ul className="grid gap-2 lg:grid-cols-2">
                {unmatchedRows.map((row) => (
                  <li key={row.id} className="rounded-lg border border-app-warning/30 bg-app-surface px-3 py-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-black uppercase tracking-widest text-app-text-muted">
                        {row.channel}
                      </span>
                      <span className="font-mono text-app-text">{row.identifier ?? "No identifier"}</span>
                      <span className="ml-auto text-app-text-muted">
                        {fullDateTime(row.last_seen_at)}
                      </span>
                    </div>
                    {row.snippet ? (
                      <p className="mt-1 line-clamp-1 text-app-text-muted">{row.snippet}</p>
                    ) : null}
                    <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                      Find or create the customer, then sync again.
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
