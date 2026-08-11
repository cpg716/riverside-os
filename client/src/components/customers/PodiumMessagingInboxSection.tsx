import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Circle,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  RefreshCw,
  Search,
  Send,
  UserCircle,
  UserPlus,
  Users,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useNotificationCenterOptional } from "../../context/NotificationCenterContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";
import { AddCustomerDrawer } from "./CustomersWorkspace";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();
const INBOX_LOCAL_REFRESH_MS = 60_000;
const PROVIDER_PULL_STALE_MS = 30 * 60 * 1000;

type InboxRow = {
  conversation_id: string;
  podium_conversation_uid: string | null;
  customer_id: string | null;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  unmatched_id: string | null;
  contact_identifier: string | null;
  channel: string;
  last_message_at: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_viewed_at: string | null;
  needs_reply: boolean;
  unread: boolean;
  closed: boolean;
  provider_assignee_name: string | null;
  snippet: string | null;
};

type PodiumConversationAssignee = {
  provider_user_uid: string;
  provider_name: string;
  staff_id: string | null;
  staff_name: string | null;
  linked: boolean;
};

type PodiumHealth = {
  credentials_configured: boolean;
  sms_send_enabled: boolean;
  location_uid_configured: boolean;
  webhook_secret_configured: boolean;
  inbound_ingest_enabled: boolean;
  local_conversation_count: number;
  local_message_count: number;
  incomplete_history_count: number;
  unmatched_conversation_count: number;
  last_webhook_received_at: string | null;
  last_webhook_failure_at: string | null;
  last_webhook_failure_reason: string | null;
  last_message_at: string | null;
  last_outbound_at: string | null;
  last_sync_at: string | null;
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
  if (!row.customer_id) return "Unknown sender";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Customer";
}

function initials(row: InboxRow) {
  if (!row.customer_id) return "?";
  const first = row.first_name?.trim().charAt(0) ?? "";
  const last = row.last_name?.trim().charAt(0) ?? "";
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

function messageDayLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Conversation";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, yesterday)) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
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
  initialFocusId,
  onInitialFocusConsumed,
}: {
  onOpenCustomerHub: (customer: Customer) => void;
  /** Conversation ID for current alerts; customer ID supports older Podium alerts. */
  initialFocusId?: string | null;
  onInitialFocusConsumed?: () => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const notificationCenter = useNotificationCenterOptional();
  const refreshNavigationCounts = notificationCenter?.refreshUnread;
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
  const [triageFilter, setTriageFilter] = useState<"active" | "needs_reply" | "unread" | "closed">("active");
  const [health, setHealth] = useState<PodiumHealth | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncIssue, setSyncIssue] = useState<string | null>(null);
  const [showSystemStatus, setShowSystemStatus] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [selectedRow, setSelectedRow] = useState<InboxRow | null>(null);
  const [threadMessages, setThreadMessages] = useState<PodiumMessageRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [assignees, setAssignees] = useState<PodiumConversationAssignee[]>([]);
  const [assigneesLoading, setAssigneesLoading] = useState(false);
  const [assigneeLoadError, setAssigneeLoadError] = useState(false);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [conversationActionBusy, setConversationActionBusy] = useState(false);
  const [pendingClosedState, setPendingClosedState] = useState<{
    conversationIds: string[];
    closed: boolean;
  } | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [matchingRow, setMatchingRow] = useState<InboxRow | null>(null);
  const [addCustomerRow, setAddCustomerRow] = useState<InboxRow | null>(null);
  const [unmatchedCustomerSearch, setUnmatchedCustomerSearch] = useState("");
  const [unmatchedCustomerResults, setUnmatchedCustomerResults] = useState<DirectSmsCustomerResult[]>([]);
  const [unmatchedSearchBusy, setUnmatchedSearchBusy] = useState(false);
  const [unmatchedResolveBusy, setUnmatchedResolveBusy] = useState(false);
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
  const refreshInFlightRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const newMessageRef = useRef<HTMLDivElement>(null);

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

  const refresh = useCallback(async (opts?: { background?: boolean }) => {
    const background = Boolean(opts?.background);
    if (background && refreshInFlightRef.current) return;
    const seq = refreshSeqRef.current + 1;
    refreshSeqRef.current = seq;
    refreshInFlightRef.current = true;
    if (!background) setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-inbox?limit=80`, {
        headers: apiAuth(),
        cache: "no-store",
      });
      if (!res.ok) {
        if (seq === refreshSeqRef.current) {
          setLoadError("Could not refresh Podium inbox.");
        }
        return;
      }
      const data = (await res.json()) as InboxRow[];
      if (seq === refreshSeqRef.current) {
        setRows(Array.isArray(data) ? data : []);
        setLoadError(null);
        setLastLoadedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
        void loadHealth();
      }
    } catch {
      if (seq === refreshSeqRef.current) {
        setLoadError("Could not refresh Podium inbox.");
      }
    } finally {
      if (seq === refreshSeqRef.current) {
        refreshInFlightRef.current = false;
        if (!background) setLoading(false);
      }
    }
  }, [apiAuth, loadHealth]);

  useEffect(() => {
    void refresh();
    void loadHealth();
  }, [loadHealth, refresh]);

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
      if (triageFilter === "active" && row.closed) return false;
      if (triageFilter === "needs_reply" && (row.closed || !row.needs_reply)) return false;
      if (triageFilter === "unread" && (row.closed || !row.unread)) return false;
      if (triageFilter === "closed" && !row.closed) return false;
      if (!needle) return true;
      return [
        row.first_name,
        row.last_name,
        row.customer_code,
        row.contact_identifier,
        row.channel,
        row.snippet,
        row.last_message_at,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [channelFilter, rows, search, triageFilter]);

  const setConversationReadState = useCallback(async (
    conversationIds: string[],
    read: boolean,
    announceSuccess = false,
  ) => {
    if (conversationIds.length === 0) return;
    const idSet = new Set(conversationIds);
    const viewedAt = read ? new Date().toISOString() : null;
    setRows((current) =>
      current.map((candidate) =>
        idSet.has(candidate.conversation_id)
          ? { ...candidate, unread: !read, last_viewed_at: viewedAt }
          : candidate,
      ),
    );
    setSelectedRow((current) =>
      current && idSet.has(current.conversation_id)
        ? { ...current, unread: !read, last_viewed_at: viewedAt }
        : current,
    );
    setConversationActionBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/podium/conversations/read-state`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ conversation_ids: conversationIds, read }),
        },
      );
      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? "Could not update the conversation read state.");
      }
      await refreshNavigationCounts?.();
      if (announceSuccess) {
        toast(
          `${conversationIds.length} conversation${conversationIds.length === 1 ? "" : "s"} marked ${read ? "read" : "unread"}.`,
          "success",
        );
      }
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not update the conversation read state.",
        "error",
      );
      void refresh({ background: true });
    } finally {
      setConversationActionBusy(false);
    }
  }, [apiAuth, refresh, refreshNavigationCounts, toast]);

  useEffect(() => {
    if (
      initialFocusId &&
      rows.some(
        (row) =>
          row.conversation_id === initialFocusId || row.customer_id === initialFocusId,
      )
    ) {
      return;
    }
    const currentVisibleRow = selectedRow
      ? visibleRows.find((row) => row.conversation_id === selectedRow.conversation_id)
      : null;
    if (currentVisibleRow) {
      if (currentVisibleRow !== selectedRow) setSelectedRow(currentVisibleRow);
      return;
    }
    // Keep the open conversation visible after it is marked read from the Unread filter.
    // Otherwise removing it from the list would auto-open and mark every remaining row read.
    if (triageFilter === "unread" && selectedRow && !selectedRow.unread) return;
    const nextRow = visibleRows[0] ?? null;
    setSelectedRow(nextRow);
    if (nextRow?.unread) void setConversationReadState([nextRow.conversation_id], true);
  }, [initialFocusId, rows, selectedRow, setConversationReadState, triageFilter, visibleRows]);

  useEffect(() => {
    if (!initialFocusId || rows.length === 0) return;
    const focusedRow = rows.find(
      (row) => row.conversation_id === initialFocusId || row.customer_id === initialFocusId,
    );
    if (!focusedRow) return;
    setSearch("");
    setChannelFilter("all");
    setTriageFilter(focusedRow.closed ? "closed" : "active");
    setSelectedConversationIds(new Set());
    setSelectedRow(focusedRow);
    setReplySubject("");
    setReplyDraft("");
    if (focusedRow.unread) {
      void setConversationReadState([focusedRow.conversation_id], true);
    }
    onInitialFocusConsumed?.();
  }, [initialFocusId, onInitialFocusConsumed, rows, setConversationReadState]);

  useEffect(() => {
    const el = threadScrollRef.current;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [threadMessages, threadLoading]);

  useEffect(() => {
    if (showNewMessage) {
      newMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [showNewMessage]);

  useEffect(() => {
    if (!selectedRow) {
      setAssignees([]);
      setAssigneeLoadError(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      setAssigneesLoading(true);
      setAssigneeLoadError(false);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(selectedRow.conversation_id)}/assignees`,
          { headers: apiAuth(), cache: "no-store" },
        );
        if (!res.ok) {
          if (!cancelled) {
            setAssignees([]);
            setAssigneeLoadError(true);
          }
          return;
        }
        const data = (await res.json()) as PodiumConversationAssignee[];
        if (!cancelled) {
          setAssignees(Array.isArray(data) ? data : []);
        }
      } catch {
        if (!cancelled) {
          setAssignees([]);
          setAssigneeLoadError(true);
        }
      } finally {
        if (!cancelled) setAssigneesLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [apiAuth, selectedRow]);

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
          `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(selectedRow.conversation_id)}/messages`,
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
        setSyncIssue("Podium history could not be pulled. Check credentials and permissions.");
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
      const errorCount = Array.isArray(result.errors) ? result.errors.length : 0;
      if (errorCount > 0) {
        const issue = `${errorCount} Podium conversation ${errorCount === 1 ? "history" : "histories"} could not be loaded. Riverside did not mark the pull complete.`;
        setSyncIssue(issue);
        if (!opts?.quiet) {
          toast(
            `Podium pull incomplete: ${result.messages_inserted} messages added; ${errorCount} histories failed.`,
            "error",
          );
        }
      } else {
        setSyncIssue(null);
      }
      if (!opts?.quiet && errorCount === 0) {
        toast(
          `Podium pull added ${result.messages_inserted} messages across ${result.conversations_matched + result.conversations_unmatched} conversations.`,
          "success",
        );
      }
      await refresh({ background: opts?.quiet });
    } catch {
      setSyncIssue("Podium history could not be pulled. Check the Main Hub connection and try again.");
      if (!opts?.quiet) {
        toast("Podium pull could not run. Check the Main Hub connection and try again.", "error");
      }
    } finally {
      setSyncBusy(false);
    }
  }, [apiAuth, refresh, toast]);

  const historyIncomplete = useMemo(
    () =>
      !!health &&
      ((health.local_conversation_count > 0 && health.local_message_count === 0) ||
        health.incomplete_history_count > 0),
    [health],
  );

  const providerPullStale = useMemo(
    () => !!health && isOlderThan(health.last_sync_at, PROVIDER_PULL_STALE_MS),
    [health],
  );

  const providerPullDue = useMemo(
    () =>
      !!health?.credentials_configured &&
      !!health.location_uid_configured &&
      (historyIncomplete || providerPullStale),
    [
      health?.credentials_configured,
      health?.location_uid_configured,
      historyIncomplete,
      providerPullStale,
    ],
  );

  const activeWebhookFailure = useMemo(() => {
    if (!health?.last_webhook_failure_at) return false;
    if (!health.last_webhook_received_at) return true;
    return new Date(health.last_webhook_failure_at).getTime() >
      new Date(health.last_webhook_received_at).getTime();
  }, [health?.last_webhook_failure_at, health?.last_webhook_received_at]);

  useEffect(() => {
    if (!providerPullDue) {
      autoProviderPullKeyRef.current = null;
      return;
    }
    if (syncBusy) return;
    const key = historyIncomplete ? "history-incomplete" : "history-refresh-due";
    if (autoProviderPullKeyRef.current === key) return;
    autoProviderPullKeyRef.current = key;
    void runSync({ quiet: true });
  }, [historyIncomplete, providerPullDue, runSync, syncBusy]);

  const openCustomer = async (row: InboxRow) => {
    if (!row.customer_id) return;
    if (row.unread) {
      await setConversationReadState([row.conversation_id], true);
    }
    onOpenCustomerHub({
      id: row.customer_id,
      customer_code: row.customer_code ?? "",
      first_name: row.first_name ?? "",
      last_name: row.last_name ?? "",
      company_name: null,
      email: null,
      phone: null,
    });
    void refresh();
  };

  const sendReply = async () => {
    if (!selectedRow?.customer_id) return;
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
      await setConversationReadState([selectedRow.conversation_id], true);
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

  const searchUnmatchedCustomers = async () => {
    const q = unmatchedCustomerSearch.trim();
    if (q.length < 2) {
      toast("Enter at least two characters to search customers.", "error");
      return;
    }
    setUnmatchedSearchBusy(true);
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
      setUnmatchedCustomerResults(Array.isArray(data) ? data : []);
    } finally {
      setUnmatchedSearchBusy(false);
    }
  };

  const resolveUnmatchedConversation = async (
    row: InboxRow,
    customer: Pick<DirectSmsCustomerResult, "id">,
  ) => {
    if (!row.unmatched_id || unmatchedResolveBusy) return;
    setUnmatchedResolveBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/podium/messaging-unmatched/${encodeURIComponent(row.unmatched_id)}/resolve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ customer_id: customer.id }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        sync_completed?: boolean;
      };
      if (!res.ok) {
        toast(payload.error ?? "Could not resolve the Podium conversation.", "error");
        return;
      }
      toast(
        payload.sync_completed === false
          ? "Customer matched. Podium history will refresh automatically."
          : "Customer matched to this conversation.",
        "success",
      );
      setMatchingRow(null);
      setAddCustomerRow(null);
      setUnmatchedCustomerSearch("");
      setUnmatchedCustomerResults([]);
      await refresh();
    } finally {
      setUnmatchedResolveBusy(false);
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
      setShowNewMessage(false);
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

  const toggleConversationSelection = (conversationId: string) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) next.delete(conversationId);
      else next.add(conversationId);
      return next;
    });
  };

  const toggleAllVisibleConversations = () => {
    const visibleIds = visibleRows.map((row) => row.conversation_id);
    const allVisibleSelected =
      visibleIds.length > 0 && visibleIds.every((id) => selectedConversationIds.has(id));
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) {
        if (allVisibleSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const applyClosedState = async () => {
    if (!pendingClosedState) return;
    const { conversationIds, closed } = pendingClosedState;
    setConversationActionBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/conversations/closed-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ conversation_ids: conversationIds, closed }),
      });
      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(error.error ?? `Could not ${closed ? "close" : "reopen"} the conversation.`);
      }
      const result = (await res.json()) as {
        updated_ids?: string[];
        failures?: Array<{ conversation_id: string; error: string }>;
      };
      const updatedIds = new Set(result.updated_ids ?? []);
      setRows((current) =>
        current.map((row) =>
          updatedIds.has(row.conversation_id) ? { ...row, closed } : row,
        ),
      );
      setSelectedRow((current) =>
        current && updatedIds.has(current.conversation_id) ? { ...current, closed } : current,
      );
      setSelectedConversationIds(new Set());
      const failureCount = result.failures?.length ?? 0;
      if (updatedIds.size > 0) {
        toast(
          `${updatedIds.size} conversation${updatedIds.size === 1 ? "" : "s"} ${closed ? "closed" : "reopened"}.`,
          failureCount > 0 ? "info" : "success",
        );
      }
      if (failureCount > 0) {
        toast(
          `${failureCount} conversation${failureCount === 1 ? "" : "s"} could not be ${closed ? "closed" : "reopened"}.`,
          "error",
        );
      }
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : `Could not ${pendingClosedState.closed ? "close" : "reopen"} the conversation.`,
        "error",
      );
    } finally {
      setConversationActionBusy(false);
      setPendingClosedState(null);
      void refresh({ background: true });
    }
  };

  const activeRows = rows.filter((row) => !row.closed);
  const unreadCount = activeRows.filter((row) => row.unread).length;
  const needsReplyCount = activeRows.filter((row) => row.needs_reply).length;
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
  const hasSystemIssue = Boolean(activeWebhookFailure || syncIssue || historyIncomplete);

  return (
    <div className="ui-page flex flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-app-text">
              Messages
            </h1>
            <IntegrationBrandLogo
              brand="podium"
              kind="icon"
              className="inline-flex rounded-xl border border-app-border bg-app-surface p-2 shadow-sm"
              imageClassName="h-5 w-5 object-contain"
            />
          </div>
          <p className="mt-1 text-sm font-semibold text-app-text-muted">
            Podium Inbox · Read and reply from one shared conversation list.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rows.length > 0 ? (
            <div className="mr-1 hidden items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted lg:flex">
              <span>{rows.length} conversations</span>
              {needsReplyCount > 0 ? (
                <span className="rounded-full bg-app-warning/10 px-2 py-1 text-app-warning">
                  {needsReplyCount} need reply
                </span>
              ) : null}
              {unreadCount > 0 ? (
                <span className="rounded-full bg-app-accent/10 px-2 py-1 text-app-accent">
                  {unreadCount} unread
                </span>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => setShowNewMessage((value) => !value)}
            className="ui-btn-primary ui-touch-target inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            aria-expanded={showNewMessage}
          >
            <UserPlus size={14} aria-hidden />
            New message
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ui-btn-secondary ui-touch-target inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
          >
            <RefreshCw size={13} aria-hidden />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowSystemStatus((value) => !value)}
            className={`ui-btn-secondary ui-touch-target inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest ${
              hasSystemIssue ? "border-app-warning/50 text-app-warning" : ""
            }`}
            aria-expanded={showSystemStatus}
          >
            {showSystemStatus ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            Status
          </button>
        </div>
      </div>

      {!showSystemStatus && hasSystemIssue ? (
        <button
          type="button"
          onClick={() => setShowSystemStatus(true)}
          className="flex w-full items-center gap-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-left text-xs font-semibold text-app-text"
        >
          <AlertTriangle size={15} className="shrink-0 text-app-warning" aria-hidden />
          <span>Podium needs attention. Open Status for details.</span>
        </button>
      ) : null}

      {showSystemStatus && health ? (
        <div className="rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm shadow-sm">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Sync status
              </p>
              <p className="mt-1 font-semibold text-app-text">
                Refreshes every minute while open.
              </p>
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Last inbound: {fullDateTime(health.last_webhook_received_at)} · Last stored message: {fullDateTime(health.last_message_at)} · Last complete history pull: {fullDateTime(health.last_sync_at)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void runSync()}
                disabled={syncBusy}
                className="ui-btn-secondary ui-touch-target inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
              >
                <RefreshCw size={13} className={syncBusy ? "animate-spin" : ""} aria-hidden />
                Pull from Podium
              </button>
              <span
                className={`ui-pill ${
                  health.webhook_secret_configured && health.inbound_ingest_enabled
                    ? "bg-app-success/10 text-app-success"
                    : "bg-app-warning/10 text-app-warning"
                }`}
              >
                {health.webhook_secret_configured && health.inbound_ingest_enabled
                  ? "ROS webhook ready"
                  : "ROS webhook setup needed"}
              </span>
              <span
                className={`ui-pill ${
                  historyIncomplete || syncIssue
                    ? "bg-app-warning/10 text-app-warning"
                    : "bg-app-success/10 text-app-success"
                }`}
              >
                {historyIncomplete || syncIssue
                  ? syncBusy
                    ? "Pulling history"
                    : "History incomplete"
                  : "History current"}
              </span>
            </div>
          </div>
          {activeWebhookFailure ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              Last webhook issue: {fullDateTime(health.last_webhook_failure_at)}
              {health.last_webhook_failure_reason ? ` - ${health.last_webhook_failure_reason}` : ""}
            </p>
          ) : null}
          {syncIssue ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              {syncIssue}
            </p>
          ) : null}
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
      ) : rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-app-border/60 bg-app-surface px-6 py-10 text-center text-app-text-muted">
          <MessageSquare size={40} className="mb-3 opacity-70" />
          <p className="text-sm font-black uppercase tracking-widest italic text-app-text">
            {loadError ? "Podium inbox could not refresh" : "No Podium conversations synced"}
          </p>
          <p className="mt-2 max-w-sm text-sm font-medium normal-case tracking-normal text-app-text-muted">
            {loadError
              ? "Retry is safe. Do not treat the inbox as empty until refresh succeeds."
              : "Check Podium setup if live conversations are missing."}
          </p>
        </div>
      ) : (
        <div className="grid min-h-[360px] flex-1 gap-3 xl:h-[calc(100dvh-17rem)] xl:flex-none xl:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
            <div className="space-y-2 border-b border-app-border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Conversations
                </p>
                <span className="text-[10px] font-bold text-app-text-muted">
                  {visibleRows.length} of {rows.length}
                </span>
              </div>
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
                  aria-hidden
                />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setSelectedConversationIds(new Set());
                  }}
                  placeholder="Search messages"
                  className="ui-input h-10 w-full rounded-xl pl-9 pr-3 text-xs font-bold"
                  aria-label="Search Podium inbox"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={channelFilter}
                  onChange={(event) => {
                    setChannelFilter(event.target.value);
                    setSelectedConversationIds(new Set());
                  }}
                  className="ui-input h-9 min-w-0 rounded-xl px-2 text-[9px] font-black uppercase tracking-wider"
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
                  onChange={(event) => {
                    setTriageFilter(event.target.value as typeof triageFilter);
                    setSelectedConversationIds(new Set());
                  }}
                  className="ui-input h-9 min-w-0 rounded-xl px-2 text-[9px] font-black uppercase tracking-wider"
                  aria-label="Filter Podium inbox by triage state"
                >
                  <option value="active">Open</option>
                  <option value="needs_reply">Needs reply</option>
                  <option value="unread">Unread</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
              {visibleRows.length > 0 ? (
                <div className="flex items-center justify-between gap-2 border-t border-app-border/70 pt-2">
                  <label className="flex items-center gap-2 text-[10px] font-bold text-app-text-muted">
                    <input
                      type="checkbox"
                      checked={visibleRows.every((row) => selectedConversationIds.has(row.conversation_id))}
                      onChange={toggleAllVisibleConversations}
                      className="h-4 w-4 rounded border-app-border accent-app-accent"
                    />
                    Select visible
                  </label>
                  {selectedConversationIds.size > 0 ? (
                    <button
                      type="button"
                      onClick={() => setSelectedConversationIds(new Set())}
                      className="text-[10px] font-black uppercase tracking-wider text-app-accent"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              ) : null}
              {selectedConversationIds.size > 0 ? (
                <div className="rounded-xl border border-app-accent/25 bg-app-accent/5 p-2">
                  <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-app-text">
                    {selectedConversationIds.size} selected
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    <button
                      type="button"
                      onClick={() => void setConversationReadState(Array.from(selectedConversationIds), true, true)}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-wide disabled:opacity-50"
                    >
                      <CheckCheck size={12} aria-hidden /> Read
                    </button>
                    <button
                      type="button"
                      onClick={() => void setConversationReadState(Array.from(selectedConversationIds), false, true)}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-wide disabled:opacity-50"
                    >
                      <Circle size={12} aria-hidden /> Unread
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingClosedState({ conversationIds: Array.from(selectedConversationIds), closed: true })}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-wide disabled:opacity-50"
                    >
                      <Archive size={12} aria-hidden /> Close
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingClosedState({ conversationIds: Array.from(selectedConversationIds), closed: false })}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[9px] font-black uppercase tracking-wide disabled:opacity-50"
                    >
                      <ArchiveRestore size={12} aria-hidden /> Reopen
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            <ul className="min-h-0 flex-1 divide-y divide-app-border overflow-y-auto max-xl:max-h-[640px]">
              {visibleRows.length === 0 ? (
                <li className="px-4 py-8 text-center text-xs font-semibold text-app-text-muted">
                  No conversations match this view.
                </li>
              ) : visibleRows.map((r) => (
                <li key={r.conversation_id} className="flex items-stretch">
                  <label className="flex shrink-0 items-start px-3 py-4">
                    <input
                      type="checkbox"
                      checked={selectedConversationIds.has(r.conversation_id)}
                      onChange={() => toggleConversationSelection(r.conversation_id)}
                      className="mt-3 h-4 w-4 rounded border-app-border accent-app-accent"
                      aria-label={`Select conversation with ${customerName(r)}`}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRow(r);
                      setReplySubject("");
                      setReplyDraft("");
                      if (r.unread) {
                        void setConversationReadState([r.conversation_id], true);
                      }
                    }}
                    className={`flex min-w-0 flex-1 gap-3 py-3 pl-0 pr-4 text-left transition-colors hover:bg-app-surface-2/80 ${
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
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] font-semibold text-app-text-muted">
                        {(() => {
                          const Icon = channelIcon(r.channel);
                          return <Icon size={12} aria-hidden />;
                        })()}
                        <span>{r.channel === "sms" ? "Text message" : "Email"}</span>
                        <span>·</span>
                        <span>{r.customer_code ?? r.contact_identifier ?? "Podium sender"}</span>
                      </div>
                      {r.snippet ? (
                        <p className="mt-1 line-clamp-2 text-xs font-semibold leading-relaxed text-app-text-muted">
                          {r.snippet}
                        </p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                      {r.needs_reply && !r.closed ? (
                        <span className="mt-2 inline-flex rounded-full border border-app-warning/40 bg-app-warning/10 px-2 py-0.5 text-[9px] font-black tracking-wide text-app-warning">
                          Needs reply
                        </span>
                      ) : null}
                      {r.closed ? (
                        <span className="inline-flex rounded-full border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-black tracking-wide text-app-text-muted">
                          Closed
                        </span>
                      ) : null}
                      </div>
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
                      {assigneesLoading ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-text-muted">Checking assigned staff...</p>
                      ) : assignees.length > 0 ? (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-app-text-muted">
                          <Users size={12} aria-hidden />
                          <span>In conversation:</span>
                          {assignees.map((assignee) => (
                            <span
                              key={assignee.provider_user_uid}
                              className={`rounded-full px-2 py-0.5 font-bold ${
                                assignee.linked
                                  ? "bg-app-success/10 text-app-success"
                                  : "bg-app-warning/10 text-app-warning"
                              }`}
                              title={
                                assignee.linked
                                  ? `Podium user ${assignee.provider_name} is linked to Riverside staff member ${assignee.staff_name}.`
                                  : `Podium user ${assignee.provider_name} is not linked to a Riverside staff profile.`
                              }
                            >
                              {assignee.staff_name ?? assignee.provider_name}
                              {assignee.linked ? "" : " · Not linked"}
                            </span>
                          ))}
                        </div>
                      ) : assigneeLoadError && selectedRow.provider_assignee_name ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Assigned in last Podium sync: {selectedRow.provider_assignee_name}. Live assignment could not refresh.
                        </p>
                      ) : assigneeLoadError ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Could not refresh the Podium staff assignment.
                        </p>
                      ) : (
                        <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                          Unassigned in Podium
                        </p>
                      )}
                      {assignees.some((assignee) => !assignee.linked) ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Managers can connect this identity in Staff → open staff profile → Linked Podium Staff Member.
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => void setConversationReadState([selectedRow.conversation_id], selectedRow.unread, true)}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                    >
                      {selectedRow.unread ? <CheckCheck size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
                      {selectedRow.unread ? "Mark read" : "Mark unread"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingClosedState({
                        conversationIds: [selectedRow.conversation_id],
                        closed: !selectedRow.closed,
                      })}
                      disabled={conversationActionBusy}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                    >
                      {selectedRow.closed ? <ArchiveRestore size={14} aria-hidden /> : <Archive size={14} aria-hidden />}
                      {selectedRow.closed ? "Reopen" : "Close"}
                    </button>
                    {selectedRow.customer_id ? (
                      <button
                        type="button"
                        onClick={() => void openCustomer(selectedRow)}
                        className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                      >
                        <UserCircle size={14} aria-hidden />
                        Open Customer
                      </button>
                    ) : null}
                  </div>
                </div>
                {!selectedRow.customer_id && selectedRow.unmatched_id ? (
                  <div className="border-b border-app-border bg-app-surface-2/50 px-5 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-black text-app-text">
                          {selectedRow.contact_identifier ?? "Podium sender"}
                        </p>
                        <p className="mt-0.5 text-[11px] font-semibold text-app-text-muted">
                          Not in Riverside yet. Keep the conversation here, match an existing customer, or add a customer.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setMatchingRow(selectedRow);
                            setUnmatchedCustomerSearch(selectedRow.contact_identifier ?? "");
                            setUnmatchedCustomerResults([]);
                          }}
                          className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                        >
                          <Search size={13} aria-hidden />
                          Match Customer
                        </button>
                        <button
                          type="button"
                          onClick={() => setAddCustomerRow(selectedRow)}
                          className="ui-btn-primary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                        >
                          <UserPlus size={13} aria-hidden />
                          Add Customer
                        </button>
                      </div>
                    </div>
                    {matchingRow?.conversation_id === selectedRow.conversation_id ? (
                      <div className="mt-3 rounded-xl border border-app-border bg-app-surface p-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-black text-app-text">Match an existing customer</p>
                          <button
                            type="button"
                            onClick={() => {
                              setMatchingRow(null);
                              setUnmatchedCustomerResults([]);
                            }}
                            className="ui-btn-ghost px-2 py-1 text-[10px] font-black uppercase tracking-widest"
                          >
                            Cancel
                          </button>
                        </div>
                        <div className="mt-2 flex gap-2">
                          <input
                            value={unmatchedCustomerSearch}
                            onChange={(event) => setUnmatchedCustomerSearch(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") void searchUnmatchedCustomers();
                            }}
                            className="ui-input h-10 min-w-0 flex-1 rounded-xl px-3 text-sm"
                            placeholder="Search by name, code, phone, or email"
                            aria-label="Search customer to match Podium conversation"
                          />
                          <button
                            type="button"
                            onClick={() => void searchUnmatchedCustomers()}
                            disabled={unmatchedSearchBusy}
                            className="ui-btn-secondary inline-flex items-center gap-2 px-3 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
                          >
                            <Search size={13} aria-hidden />
                            {unmatchedSearchBusy ? "Searching..." : "Search"}
                          </button>
                        </div>
                        {unmatchedCustomerResults.length > 0 ? (
                          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                            {unmatchedCustomerResults.map((customer) => (
                              <li key={customer.id}>
                                <button
                                  type="button"
                                  onClick={() => void resolveUnmatchedConversation(selectedRow, customer)}
                                  disabled={unmatchedResolveBusy}
                                  className="w-full rounded-lg border border-app-border px-3 py-2 text-left text-xs hover:bg-app-surface-muted disabled:opacity-50"
                                >
                                  <span className="block font-black text-app-text">
                                    {customer.first_name} {customer.last_name}
                                  </span>
                                  <span className="block text-app-text-muted">
                                    {customer.customer_code} · {customer.phone ?? customer.email ?? "No identifier"}
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div ref={threadScrollRef} className="flex min-h-[180px] flex-1 flex-col gap-2 overflow-y-auto bg-app-surface-2/40 px-4 py-5 sm:px-6">
                  {threadLoading ? (
                    <p className="text-sm font-semibold text-app-text-muted">
                      Loading conversation...
                    </p>
                  ) : selectedMessages.length > 0 ? (
                    selectedMessages.map((message, index) => {
                      const outbound = message.direction === "outbound";
                      const previousMessage = selectedMessages[index - 1];
                      const showDay =
                        !previousMessage ||
                        new Date(previousMessage.created_at).toDateString() !==
                          new Date(message.created_at).toDateString();
                      return (
                        <div key={message.id}>
                          {showDay ? (
                            <div className="my-3 flex items-center gap-3" aria-label={messageDayLabel(message.created_at)}>
                              <span className="h-px flex-1 bg-app-border/70" />
                              <span className="text-[10px] font-bold text-app-text-muted">
                                {messageDayLabel(message.created_at)}
                              </span>
                              <span className="h-px flex-1 bg-app-border/70" />
                            </div>
                          ) : null}
                          <div className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[84%] rounded-[1.35rem] px-4 py-2.5 text-[15px] shadow-sm sm:max-w-[72%] ${
                                outbound
                                  ? "rounded-br-md bg-app-accent text-white"
                                  : "rounded-bl-md bg-app-surface text-app-text ring-1 ring-app-border/70"
                              }`}
                            >
                              <p className="whitespace-pre-wrap leading-relaxed">{message.body}</p>
                              <p
                                className={`mt-1.5 text-[10px] font-medium ${
                                  outbound ? "text-white/70" : "text-app-text-muted"
                                }`}
                              >
                                {outbound
                                  ? message.staff_full_name ?? message.podium_sender_name ?? "Riverside"
                                  : customerName(selectedRow)}{" "}
                                · {fullDateTime(message.created_at)}
                                {outbound ? " · Sent" : ""}
                              </p>
                            </div>
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
                {selectedRow.customer_id ? (
                  <div className="border-t border-app-border bg-app-surface px-4 py-3 sm:px-5">
                    {selectedRow.channel === "email" ? (
                      <input
                        value={replySubject}
                        onChange={(event) => setReplySubject(event.target.value)}
                        className="ui-input mb-2 w-full rounded-xl px-3 py-2 text-sm"
                        placeholder="Email subject"
                      />
                    ) : null}
                    <div className="flex items-end gap-2">
                      <textarea
                        value={replyDraft}
                        onChange={(event) => setReplyDraft(event.target.value)}
                        className="ui-input min-h-12 flex-1 resize-y rounded-[1.4rem] px-4 py-3 text-sm"
                        placeholder={selectedRow.channel === "email" ? "Write an email reply" : "Text message"}
                      />
                      <button
                        type="button"
                        onClick={() => void sendReply()}
                        disabled={
                          replyBusy ||
                          !replyDraft.trim() ||
                          (selectedRow.channel === "email" && !replySubject.trim())
                        }
                        className="ui-btn-primary ui-touch-target inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full p-0 disabled:opacity-50"
                        aria-label={replyBusy ? "Sending message" : "Send message"}
                      >
                        <Send size={17} aria-hidden />
                      </button>
                    </div>
                  </div>
                ) : null}
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

      {showNewMessage ? (
      <div ref={newMessageRef} className="rounded-xl border border-app-accent/30 bg-app-surface px-4 py-4 shadow-sm">
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
          <div className="flex items-center gap-2">
            {directCustomer ? (
              <button
                type="button"
                onClick={clearDirectCustomer}
                className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                Use New Number
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setShowNewMessage(false)}
              className="ui-btn-ghost ui-touch-target px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              Close
            </button>
          </div>
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
      ) : null}

      <AddCustomerDrawer
        isOpen={addCustomerRow !== null}
        onClose={() => setAddCustomerRow(null)}
        onSaved={() => setAddCustomerRow(null)}
        initialDraft={
          addCustomerRow?.channel === "email"
            ? { email: addCustomerRow.contact_identifier ?? "" }
            : { phone: addCustomerRow?.contact_identifier ?? "" }
        }
        onCreatedCustomer={(customer) => {
          if (addCustomerRow) {
            void resolveUnmatchedConversation(addCustomerRow, customer);
          }
        }}
      />
      <ConfirmationModal
        isOpen={pendingClosedState !== null}
        onClose={() => {
          if (!conversationActionBusy) setPendingClosedState(null);
        }}
        onConfirm={() => void applyClosedState()}
        title={pendingClosedState?.closed ? "Close conversation" : "Reopen conversation"}
        message={
          pendingClosedState?.closed
            ? `Close ${pendingClosedState.conversationIds.length} selected conversation${pendingClosedState.conversationIds.length === 1 ? "" : "s"} in Podium? Closed conversations leave the open inbox and can be reopened from the Closed filter.`
            : `Reopen ${pendingClosedState?.conversationIds.length ?? 0} selected conversation${pendingClosedState?.conversationIds.length === 1 ? "" : "s"} in Podium?`
        }
        confirmLabel={pendingClosedState?.closed ? "Close" : "Reopen"}
        variant={pendingClosedState?.closed ? "danger" : "info"}
        loading={conversationActionBusy}
      />
    </div>
  );
}
