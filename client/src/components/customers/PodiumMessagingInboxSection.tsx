import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Circle,
  ExternalLink,
  Image as ImageIcon,
  Mail,
  MessageCircle,
  MessageSquare,
  Phone,
  PhoneCall,
  PhoneMissed,
  RefreshCw,
  Search,
  Send,
  SmilePlus,
  Star,
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
import PodiumResponderPinModal from "./PodiumResponderPinModal";

const baseUrl = getBaseUrl();
const INBOX_LOCAL_REFRESH_MS = 60_000;
const PROVIDER_PULL_STALE_MS = 30 * 60 * 1000;
const MULTIPLE_ASSIGNMENT_VALUE = "__multiple_podium_assignees__";
const MESSAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const MESSAGE_EMOJI_CHOICES = ["🙂", "👍", "🙏", "👔", "📸"];
const MESSAGE_EMOJI_LABELS: Record<string, string> = {
  "🙂": "smile",
  "👍": "thumbs up",
  "🙏": "thank you",
  "👔": "necktie",
  "📸": "camera",
};

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
  responder_staff_id: string | null;
  responder_staff_name: string | null;
  latest_activity_kind: "message" | "call" | "review" | null;
  snippet: string | null;
};

type ResponderStaff = {
  id: string;
  full_name: string;
};

type PodiumConversationAssignee = {
  provider_user_uid: string;
  provider_name: string;
  staff_id: string | null;
  staff_name: string | null;
  linked: boolean;
};

type PodiumAssignmentStaff = {
  staff_id: string;
  staff_name: string;
  provider_user_uid: string;
  provider_name: string;
};

type PodiumHealth = {
  credentials_configured: boolean;
  sms_send_enabled: boolean;
  location_uid_configured: boolean;
  webhook_secret_configured: boolean;
  inbound_ingest_enabled: boolean;
  local_conversation_count: number;
  local_message_count: number;
  local_call_event_count: number;
  incomplete_history_count: number;
  unmatched_conversation_count: number;
  pending_webhook_delivery_count: number;
  failed_webhook_delivery_count: number;
  last_webhook_received_at: string | null;
  last_webhook_failure_at: string | null;
  last_webhook_failure_reason: string | null;
  last_message_at: string | null;
  last_call_event_at: string | null;
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

type PodiumCallEventRow = {
  id: string;
  conversation_id: string | null;
  provider_call_uid: string;
  event_type: string;
  direction: string;
  contact_phone_e164: string | null;
  contact_name: string | null;
  duration_seconds: number | null;
  has_voicemail: boolean;
  occurred_at: string;
};

type PodiumReviewActivityRow = {
  id: string;
  provider_review_uid: string;
  last_event_type: string;
  transaction_id: string | null;
  display_id: string | null;
  customer_id: string | null;
  customer_code: string | null;
  first_name: string | null;
  last_name: string | null;
  conversation_id: string | null;
  author_name: string | null;
  rating: number | null;
  review_body: string | null;
  review_url: string | null;
  site_name: string | null;
  is_recommendation: boolean;
  needs_response: boolean;
  published_at: string;
  last_activity_at: string;
  response_count: number;
  latest_response_body: string | null;
  latest_response_author_name: string | null;
  latest_response_at: string | null;
};

type PodiumThreadActivity =
  | { kind: "message"; id: string; created_at: string; message: PodiumMessageRow }
  | { kind: "call"; id: string; created_at: string; call: PodiumCallEventRow }
  | { kind: "review"; id: string; created_at: string; review: PodiumReviewActivityRow };

type DirectSmsCustomerResult = {
  id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  email: string | null;
};

function customerName(row: InboxRow) {
  if (!row.customer_id) return row.contact_identifier?.trim() || "Unknown sender";
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Customer";
}

function initials(row: InboxRow) {
  if (!row.customer_id) return "?";
  const first = row.first_name?.trim().charAt(0) ?? "";
  const last = row.last_name?.trim().charAt(0) ?? "";
  return `${first}${last}`.toUpperCase() || "C";
}

function fileToBase64Payload(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file-read"));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      resolve(value.includes(",") ? value.split(",").pop() ?? "" : value);
    };
    reader.readAsDataURL(file);
  });
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

function activityIcon(row: InboxRow) {
  if (row.latest_activity_kind === "call") return PhoneCall;
  if (row.latest_activity_kind === "review") return Star;
  return channelIcon(row.channel);
}

function activityLabel(row: InboxRow) {
  if (row.latest_activity_kind === "call") return "Call";
  if (row.latest_activity_kind === "review") return "Review";
  return row.channel === "email" ? "Email" : "Text message";
}

function callEventLabel(call: PodiumCallEventRow) {
  if (call.event_type === "call.voicemail_left" || call.has_voicemail) {
    return "Voicemail received";
  }
  if (call.event_type === "call.missed") return "Missed call";
  if (call.event_type === "call.received") return "Incoming call";
  if (call.direction === "outbound") return "Outgoing call completed";
  return "Call completed";
}

function callDurationLabel(seconds: number | null) {
  if (seconds === null || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
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
  const { backofficeHeaders, staffId } = useBackofficeAuth();
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
  const [threadCalls, setThreadCalls] = useState<PodiumCallEventRow[]>([]);
  const [threadReviews, setThreadReviews] = useState<PodiumReviewActivityRow[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [assignees, setAssignees] = useState<PodiumConversationAssignee[]>([]);
  const [assigneesLoading, setAssigneesLoading] = useState(false);
  const [assigneeLoadError, setAssigneeLoadError] = useState(false);
  const [assignmentRoster, setAssignmentRoster] = useState<PodiumAssignmentStaff[]>([]);
  const [assignmentRosterLoading, setAssignmentRosterLoading] = useState(true);
  const [assignmentRosterLoadError, setAssignmentRosterLoadError] = useState(false);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [pendingResponder, setPendingResponder] = useState<{
    conversationId: string;
    staff: ResponderStaff;
  } | null>(null);
  const [selectedConversationIds, setSelectedConversationIds] = useState<Set<string>>(new Set());
  const [conversationActionBusy, setConversationActionBusy] = useState(false);
  const [pendingClosedState, setPendingClosedState] = useState<{
    conversationIds: string[];
    closed: boolean;
  } | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyAttachment, setReplyAttachment] = useState<{
    name: string;
    dataBase64: string;
  } | null>(null);
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
  const selectedConversationId = selectedRow?.conversation_id ?? null;
  const autoProviderPullKeyRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshSeqRef = useRef(0);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const replyAttachmentInputRef = useRef<HTMLInputElement>(null);
  const newMessageRef = useRef<HTMLDivElement>(null);
  const selectedConversationIdRef = useRef<string | null>(null);
  selectedConversationIdRef.current = selectedConversationId;

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
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-inbox?limit=500`, {
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
    let cancelled = false;
    const loadAssignmentRoster = async () => {
      setAssignmentRosterLoading(true);
      setAssignmentRosterLoadError(false);
      try {
        const res = await fetch(`${baseUrl}/api/customers/podium/assignment-staff`, {
          headers: apiAuth(),
          cache: "no-store",
        });
        if (!res.ok) {
          if (!cancelled) setAssignmentRosterLoadError(true);
          return;
        }
        const data = (await res.json()) as PodiumAssignmentStaff[];
        if (!cancelled) setAssignmentRoster(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) {
          setAssignmentRoster([]);
          setAssignmentRosterLoadError(true);
        }
      } finally {
        if (!cancelled) setAssignmentRosterLoading(false);
      }
    };
    void loadAssignmentRoster();
    return () => {
      cancelled = true;
    };
  }, [apiAuth]);

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
  }, [threadCalls, threadMessages, threadReviews, threadLoading]);

  useEffect(() => {
    if (showNewMessage) {
      newMessageRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [showNewMessage]);

  useEffect(() => {
    if (!selectedConversationId) {
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
          `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(selectedConversationId)}/assignees`,
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
  }, [apiAuth, lastLoadedAt, selectedConversationId]);

  useEffect(() => {
    if (!selectedRow) {
      setThreadMessages([]);
      setThreadCalls([]);
      setThreadReviews([]);
      return;
    }
    let cancelled = false;
    setThreadMessages([]);
    setThreadCalls([]);
    setThreadReviews([]);
    const loadThread = async () => {
      setThreadLoading(true);
      try {
        const conversationUrl = `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(selectedRow.conversation_id)}`;
        const [messagesResponse, callsResponse, reviewsResponse] = await Promise.all([
          fetch(`${conversationUrl}/messages`, { headers: apiAuth(), cache: "no-store" }),
          fetch(`${conversationUrl}/calls`, { headers: apiAuth(), cache: "no-store" }),
          fetch(`${conversationUrl}/reviews`, { headers: apiAuth(), cache: "no-store" }),
        ]);
        const messages = messagesResponse.ok
          ? ((await messagesResponse.json()) as PodiumMessageRow[])
          : [];
        const calls = callsResponse.ok
          ? ((await callsResponse.json()) as PodiumCallEventRow[])
          : [];
        const reviews = reviewsResponse.ok
          ? ((await reviewsResponse.json()) as PodiumReviewActivityRow[])
          : [];
        if (!cancelled) {
          setThreadMessages(Array.isArray(messages) ? messages : []);
          setThreadCalls(Array.isArray(calls) ? calls : []);
          setThreadReviews(Array.isArray(reviews) ? reviews : []);
        }
      } catch {
        if (!cancelled) {
          setThreadMessages([]);
          setThreadCalls([]);
          setThreadReviews([]);
        }
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
        body: JSON.stringify({ limit: 500 }),
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
    if ((health?.failed_webhook_delivery_count ?? 0) > 0) return true;
    if (!health?.last_webhook_failure_at) return false;
    if (!health.last_webhook_received_at) return true;
    return new Date(health.last_webhook_failure_at).getTime() >
      new Date(health.last_webhook_received_at).getTime();
  }, [
    health?.failed_webhook_delivery_count,
    health?.last_webhook_failure_at,
    health?.last_webhook_received_at,
  ]);

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
      const res = await fetch(
        `${baseUrl}/api/customers/podium/conversations/${selectedRow.conversation_id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            channel,
            subject,
            body,
            attachment_png_base64: replyAttachment?.dataBase64,
          }),
        },
      );
      if (!res.ok) {
        const error = (await res.json().catch(() => ({}))) as { error?: string };
        toast(error.error ?? "Could not send Podium reply.", "error");
        return;
      }
      toast(channel === "email" ? "Email sent" : "Podium SMS sent", "success");
      setReplyDraft("");
      setReplySubject("");
      setReplyAttachment(null);
      await setConversationReadState([selectedRow.conversation_id], true);
      await refresh();
    } finally {
      setReplyBusy(false);
    }
  };

  const draftInboxReply = (kind: "check_in" | "pickup") => {
    if (!selectedRow) return;
    const name = selectedRow.customer_id
      ? selectedRow.first_name?.trim() || "there"
      : "there";
    if (selectedRow.channel === "email") {
      setReplySubject("Quick update from Riverside");
      setReplyDraft(
        kind === "pickup"
          ? `Hi ${name},\n\nWe are checking in with an update from Riverside before pickup. Please reply here or call the shop with any questions.\n\nThank you,\nRiverside Men's Shop`
          : `Hi ${name},\n\nWe are checking in from Riverside. Please reply here or call the shop if you need anything from us.\n\nThank you,\nRiverside Men's Shop`,
      );
      return;
    }
    setReplyDraft(
      kind === "pickup"
        ? `Hi ${name}, Riverside here. We are checking in with an update before pickup. Reply here or call the shop with any questions.`
        : `Hi ${name}, Riverside here. Checking in—reply here or call the shop if you need anything.`,
    );
  };

  const handleReplyAttachment = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "image/png") {
      toast("Message image upload currently supports PNG files.", "error");
      return;
    }
    if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
      toast("Image is too large to send.", "error");
      return;
    }
    try {
      setReplyAttachment({
        name: file.name,
        dataBase64: await fileToBase64Payload(file),
      });
    } catch {
      toast("Could not read the selected image.", "error");
    }
  };

  const confirmResponder = async (pin: string) => {
    const pending = pendingResponder;
    if (!pending) return;
    const res = await fetch(
      `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(pending.conversationId)}/responder`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ staff_id: pending.staff.id, pin }),
      },
    );
    const result = (await res.json().catch(() => ({}))) as {
      error?: string;
      staff_id?: string;
      full_name?: string;
    };
    if (!res.ok || !result.staff_id || !result.full_name) {
      throw new Error(result.error ?? "Access PIN could not be verified.");
    }
    const applyResponder = (row: InboxRow): InboxRow =>
      row.conversation_id === pending.conversationId
        ? {
            ...row,
            responder_staff_id: result.staff_id ?? null,
            responder_staff_name: result.full_name ?? null,
          }
        : row;
    setRows((current) => current.map(applyResponder));
    setSelectedRow((current) => (current ? applyResponder(current) : current));
    setPendingResponder(null);
    toast(`${result.full_name} will be credited on replies in this conversation.`, "success");
  };

  const assignConversation = async (staff: PodiumAssignmentStaff | null) => {
    if (!selectedRow || assignmentBusy) return;
    const conversationId = selectedRow.conversation_id;
    setAssignmentBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/podium/conversations/${encodeURIComponent(conversationId)}/assignees`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ staff_id: staff?.staff_id ?? null }),
        },
      );
      const result = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(result.error ?? "Could not update the Podium assignment.", "error");
        return;
      }

      const nextAssignees: PodiumConversationAssignee[] = staff
        ? [
            {
              provider_user_uid: staff.provider_user_uid,
              provider_name: staff.provider_name,
              staff_id: staff.staff_id,
              staff_name: staff.staff_name,
              linked: true,
            },
          ]
        : [];
      if (selectedConversationIdRef.current === conversationId) {
        setAssignees(nextAssignees);
      }
      const applyAssignment = (row: InboxRow): InboxRow =>
        row.conversation_id === conversationId
          ? { ...row, provider_assignee_name: staff?.staff_name ?? null }
          : row;
      setRows((current) => current.map(applyAssignment));
      setSelectedRow((current) => (current ? applyAssignment(current) : current));
      toast(
        staff
          ? `Conversation assigned to ${staff.staff_name}.`
          : "Conversation is now unassigned.",
        "success",
      );
    } catch {
      toast("Could not update the Podium assignment.", "error");
    } finally {
      setAssignmentBusy(false);
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
  const triageCountLabel =
    triageFilter === "active"
      ? "open"
      : triageFilter === "needs_reply"
        ? "need reply"
        : triageFilter;
  const responderOptions = assignmentRoster.map((staff) => ({
    id: staff.staff_id,
    full_name: staff.staff_name,
  }));
  const currentResponder =
    responderOptions.find(
      (staff) => staff.id === selectedRow?.responder_staff_id,
    ) ??
    responderOptions.find((staff) => staff.id === staffId) ??
    null;
  const currentResponderId = currentResponder?.id ?? "";
  const assignmentOptions = [...assignmentRoster];
  for (const assignee of assignees) {
    if (
      assignee.linked &&
      assignee.staff_id &&
      assignee.staff_name &&
      !assignmentOptions.some(
        (candidate) => candidate.provider_user_uid === assignee.provider_user_uid,
      )
    ) {
      assignmentOptions.push({
        staff_id: assignee.staff_id,
        staff_name: assignee.staff_name,
        provider_user_uid: assignee.provider_user_uid,
        provider_name: assignee.provider_name,
      });
    }
  }
  const currentAssignmentValue =
    assignees.length > 1
      ? MULTIPLE_ASSIGNMENT_VALUE
      : assignees[0]?.provider_user_uid ?? "";
  const selectedMessages =
    selectedRow &&
    threadMessages.length === 0 &&
    threadCalls.length === 0 &&
    threadReviews.length === 0 &&
    selectedRow.snippet
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
  const selectedActivity: PodiumThreadActivity[] = [
    ...selectedMessages.map((message) => ({
      kind: "message" as const,
      id: message.id,
      created_at: message.created_at,
      message,
    })),
    ...threadCalls.map((call) => ({
      kind: "call" as const,
      id: call.id,
      created_at: call.occurred_at,
      call,
    })),
    ...threadReviews.map((review) => ({
      kind: "review" as const,
      id: review.id,
      created_at: review.last_activity_at,
      review,
    })),
  ].sort(
    (left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime(),
  );
  const SelectedActivityIcon = selectedRow ? activityIcon(selectedRow) : MessageCircle;
  const callEventsMissing = health !== null && health.local_call_event_count === 0;
  const historyNeedsAttention =
    !syncBusy && Boolean(syncIssue || historyIncomplete);
  const hasSystemIssue = Boolean(
    activeWebhookFailure || historyNeedsAttention || callEventsMissing,
  );

  return (
    <div
      className="ui-page flex flex-1 flex-col gap-3 p-4"
      style={{ "--app-accent": "var(--app-info)" } as CSSProperties}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-app-text">
              Inbox
            </h1>
            <IntegrationBrandLogo
              brand="podium"
              kind="icon"
              className="inline-flex rounded-xl border border-app-border bg-app-surface p-2 shadow-sm"
              imageClassName="h-5 w-5 object-contain"
            />
          </div>
          <p className="mt-1 text-sm font-semibold text-app-text-muted">
            Customer messages, calls, and linked reviews in one shared list.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rows.length > 0 ? (
            <div className="mr-1 hidden items-center gap-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted lg:flex">
              <span>{activeRows.length} open conversations</span>
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
          <span>
            {health?.failed_webhook_delivery_count
              ? "Podium webhook processing needs attention. Open Status for details."
              : callEventsMissing
              ? "Podium call delivery needs attention. Open Status for details."
              : "Podium needs attention. Open Status for details."}
          </span>
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
              <p className="mt-1 text-xs font-semibold text-app-text-muted">
                Stored calls: {health.local_call_event_count} · Last call: {fullDateTime(health.last_call_event_at)}
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
                  ? "ROS webhook receiving"
                  : "ROS webhook setup needed"}
              </span>
              <span
                className={`ui-pill ${
                  health.failed_webhook_delivery_count > 0
                    ? "bg-app-warning/10 text-app-warning"
                    : "bg-app-success/10 text-app-success"
                }`}
              >
                {health.failed_webhook_delivery_count > 0
                  ? `${health.failed_webhook_delivery_count} processing failed`
                  : health.pending_webhook_delivery_count > 0
                    ? `${health.pending_webhook_delivery_count} processing`
                    : "Processing current"}
              </span>
              <span
                className={`ui-pill ${
                  syncBusy
                    ? "bg-app-info/10 text-app-info"
                    : historyIncomplete || syncIssue
                      ? "bg-app-warning/10 text-app-warning"
                      : "bg-app-success/10 text-app-success"
                }`}
              >
                {syncBusy
                  ? "Pulling history"
                  : historyIncomplete || syncIssue
                    ? "History incomplete"
                    : "History current"}
              </span>
            </div>
          </div>
          {activeWebhookFailure ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              Webhook delivery or processing issue: {fullDateTime(health.last_webhook_failure_at)}
              {health.last_webhook_failure_reason ? ` - ${health.last_webhook_failure_reason}` : ""}
            </p>
          ) : null}
          {syncIssue ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              {syncIssue}
            </p>
          ) : null}
          {callEventsMissing ? (
            <p className="mt-2 rounded-xl border border-app-warning/30 bg-app-warning/10 px-3 py-2 text-xs font-semibold text-app-text">
              No Podium call events have reached Riverside. If calls exist in Podium, update the provider webhook in Settings → Connected Services → Podium. Pull from Podium restores message history only; it cannot backfill calls.
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
                  {visibleRows.length} {triageCountLabel}
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
                      setReplyAttachment(null);
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
                          const Icon = activityIcon(r);
                          return <Icon size={12} aria-hidden />;
                        })()}
                        <span>{activityLabel(r)}</span>
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
                        <SelectedActivityIcon size={13} aria-hidden />
                        {activityLabel(selectedRow)} · Last activity {relativeTime(selectedRow.last_message_at)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label className="flex min-w-0 items-center gap-2 text-xs font-black text-app-text">
                          <Users size={13} className="shrink-0" aria-hidden />
                          <span className="shrink-0">Assigned to</span>
                          <select
                            value={currentAssignmentValue}
                            onChange={(event) => {
                              if (event.target.value === MULTIPLE_ASSIGNMENT_VALUE) return;
                              const next = assignmentOptions.find(
                                (staff) => staff.provider_user_uid === event.target.value,
                              );
                              void assignConversation(next ?? null);
                            }}
                            disabled={
                              assignmentBusy || assigneesLoading || assignmentRosterLoading
                            }
                            className="ui-input h-9 min-w-44 rounded-xl px-3 text-xs font-black disabled:opacity-60"
                            aria-label="Assign Podium conversation to staff member"
                          >
                            <option value="">Unassigned</option>
                            {assignees.length > 1 ? (
                              <option value={MULTIPLE_ASSIGNMENT_VALUE} disabled>
                                Multiple Podium users
                              </option>
                            ) : null}
                            {assignmentOptions.map((staff) => (
                              <option key={staff.provider_user_uid} value={staff.provider_user_uid}>
                                {staff.staff_name}
                              </option>
                            ))}
                            {assignees
                              .filter(
                                (assignee) =>
                                  !assignee.linked &&
                                  !assignmentOptions.some(
                                    (staff) =>
                                      staff.provider_user_uid === assignee.provider_user_uid,
                                  ),
                              )
                              .map((assignee) => (
                                <option
                                  key={assignee.provider_user_uid}
                                  value={assignee.provider_user_uid}
                                  disabled
                                >
                                  {assignee.provider_name} · Not linked
                                </option>
                              ))}
                          </select>
                        </label>
                        {assignmentBusy ? (
                          <span className="text-[10px] font-semibold text-app-text-muted">
                            Saving assignment...
                          </span>
                        ) : null}
                      </div>
                      {assigneeLoadError && selectedRow.provider_assignee_name ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Assigned in last Podium sync: {selectedRow.provider_assignee_name}. Live assignment could not refresh.
                        </p>
                      ) : assigneeLoadError ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Could not refresh the Podium staff assignment.
                        </p>
                      ) : assignmentRosterLoadError ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          Linked staff choices could not be loaded. The current Podium assignment is unchanged.
                        </p>
                      ) : !assignmentRosterLoading && assignmentOptions.length === 0 ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-text-muted">
                          No active staff profiles have a Linked Podium Staff Member yet.
                        </p>
                      ) : null}
                      {assignees.some((assignee) => !assignee.linked) ? (
                        <p className="mt-1 text-[10px] font-semibold text-app-warning">
                          The current Podium identity is not a selectable Riverside staff member. Managers can connect it in Staff → open staff profile → Linked Podium Staff Member.
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
                          Not linked to a Riverside customer. Reply here now, or match/add the customer for profile history.
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
                  ) : selectedActivity.length > 0 ? (
                    selectedActivity.map((activity, index) => {
                      const previousActivity = selectedActivity[index - 1];
                      const showDay =
                        !previousActivity ||
                        new Date(previousActivity.created_at).toDateString() !==
                          new Date(activity.created_at).toDateString();
                      if (activity.kind === "review") {
                        const review = activity.review;
                        const reviewTitle = review.rating
                          ? `${review.rating}-star ${review.site_name ?? "customer"} review`
                          : `${review.site_name ?? "Customer"} review`;
                        return (
                          <div key={`review-${review.id}`}>
                            {showDay ? (
                              <div className="my-3 flex items-center gap-3" aria-label={messageDayLabel(review.last_activity_at)}>
                                <span className="h-px flex-1 bg-app-border/70" />
                                <span className="text-[10px] font-bold text-app-text-muted">
                                  {messageDayLabel(review.last_activity_at)}
                                </span>
                                <span className="h-px flex-1 bg-app-border/70" />
                              </div>
                            ) : null}
                            <div className="flex justify-center py-1">
                              <div className={`max-w-[94%] rounded-2xl border px-4 py-3 shadow-sm sm:max-w-[82%] ${
                                review.needs_response
                                  ? "border-amber-300/70 bg-amber-50 text-amber-950"
                                  : "border-app-border bg-app-surface text-app-text"
                              }`}>
                                <div className="flex items-start gap-3">
                                  <span className={`rounded-xl p-2 ${review.needs_response ? "bg-amber-100" : "bg-app-surface-muted"}`}>
                                    <Star size={18} fill="currentColor" aria-hidden />
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="text-sm font-black">{reviewTitle}</p>
                                      {review.needs_response ? (
                                        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-amber-900">
                                          Needs response
                                        </span>
                                      ) : null}
                                    </div>
                                    {review.review_body ? (
                                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                                        {review.review_body}
                                      </p>
                                    ) : null}
                                    <p className={`mt-1.5 text-[10px] font-semibold ${review.needs_response ? "text-amber-800" : "text-app-text-muted"}`}>
                                      {review.author_name ?? customerName(selectedRow)} · {fullDateTime(review.published_at)}
                                    </p>
                                    {review.latest_response_body ? (
                                      <div className="mt-2 rounded-xl border border-app-border/70 bg-app-surface/80 px-3 py-2 text-xs text-app-text">
                                        <span className="font-black">Riverside response: </span>
                                        {review.latest_response_body}
                                        {review.latest_response_at ? (
                                          <span className="ml-1 text-app-text-muted">
                                            · {fullDateTime(review.latest_response_at)}
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : null}
                                    {review.review_url ? (
                                      <a
                                        href={review.review_url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="mt-2 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-app-accent underline underline-offset-4"
                                      >
                                        Open review
                                        <ExternalLink size={11} aria-hidden />
                                      </a>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      if (activity.kind === "call") {
                        const call = activity.call;
                        const missedOrVoicemail =
                          call.event_type === "call.missed" ||
                          call.event_type === "call.voicemail_left" ||
                          call.has_voicemail;
                        const CallIcon = missedOrVoicemail ? PhoneMissed : PhoneCall;
                        const duration = callDurationLabel(call.duration_seconds);
                        return (
                          <div key={`call-${call.id}`}>
                            {showDay ? (
                              <div className="my-3 flex items-center gap-3" aria-label={messageDayLabel(call.occurred_at)}>
                                <span className="h-px flex-1 bg-app-border/70" />
                                <span className="text-[10px] font-bold text-app-text-muted">
                                  {messageDayLabel(call.occurred_at)}
                                </span>
                                <span className="h-px flex-1 bg-app-border/70" />
                              </div>
                            ) : null}
                            <div className="flex justify-center py-1">
                              <div
                                className={`flex max-w-[92%] items-center gap-3 rounded-2xl border px-4 py-3 shadow-sm sm:max-w-[76%] ${
                                  missedOrVoicemail
                                    ? "border-amber-300/70 bg-amber-50 text-amber-950"
                                    : "border-app-border bg-app-surface text-app-text"
                                }`}
                              >
                                <span className={`rounded-xl p-2 ${missedOrVoicemail ? "bg-amber-100" : "bg-app-surface-muted"}`}>
                                  <CallIcon size={18} aria-hidden />
                                </span>
                                <span className="min-w-0">
                                  <span className="block text-sm font-black">{callEventLabel(call)}</span>
                                  <span className={`block text-[11px] font-semibold ${missedOrVoicemail ? "text-amber-800" : "text-app-text-muted"}`}>
                                    {[
                                      call.contact_name ??
                                        (selectedRow.customer_id ? customerName(selectedRow) : null),
                                      call.contact_phone_e164,
                                      duration,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ") ||
                                      (call.direction === "outbound" ? "Outbound" : "Inbound")}
                                    {" · "}{fullDateTime(call.occurred_at)}
                                  </span>
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      }
                      const message = activity.message;
                      const outbound = message.direction === "outbound";
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
                        No messages, calls, or reviews loaded for this conversation yet.
                      </p>
                      <p className="mt-1 max-w-sm text-xs font-semibold">
                        Pull from Podium or open the customer record if this thread needs more history.
                      </p>
                    </div>
                  )}
                </div>
                <div className="border-t border-app-border bg-app-surface px-4 py-3 sm:px-5">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <label className="flex min-w-0 items-center gap-2 text-xs font-black text-app-text">
                        <span className="shrink-0">Replying as</span>
                        <select
                          value={currentResponderId}
                          onChange={(event) => {
                            const next = responderOptions.find(
                              (staff) => staff.id === event.target.value,
                            );
                            if (!next || next.id === currentResponderId) return;
                            setPendingResponder({
                              conversationId: selectedRow.conversation_id,
                              staff: next,
                            });
                          }}
                          disabled={replyBusy || assignmentRosterLoading}
                          className="ui-input h-9 min-w-44 rounded-xl px-3 text-xs font-black disabled:opacity-60"
                          aria-label="Replying as staff member"
                        >
                          {!currentResponderId ? (
                            <option value="" disabled>
                              Select linked staff member
                            </option>
                          ) : null}
                          {responderOptions.map((staff) => (
                            <option key={staff.id} value={staff.id}>
                              {staff.full_name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="text-[10px] font-semibold text-app-text-muted">
                        Remembered for this conversation · Access PIN only when changing
                      </p>
                    </div>
                    {!assignmentRosterLoading && !currentResponderId ? (
                      <p className="mb-2 text-[10px] font-semibold text-app-warning">
                        Choose a staff member with a Linked Podium Staff Member
                        before replying.
                      </p>
                    ) : null}
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => draftInboxReply("check_in")}
                        disabled={replyBusy}
                        className="rounded-xl border border-app-accent/25 bg-app-accent/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent disabled:opacity-40"
                      >
                        Check-in
                      </button>
                      <button
                        type="button"
                        onClick={() => draftInboxReply("pickup")}
                        disabled={replyBusy}
                        className="rounded-xl border border-app-accent/25 bg-app-accent/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-accent disabled:opacity-40"
                      >
                        Pickup update
                      </button>
                      {selectedRow.channel !== "email" ? (
                        <button
                          type="button"
                          onClick={() => replyAttachmentInputRef.current?.click()}
                          disabled={replyBusy}
                          className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-40"
                        >
                          <ImageIcon size={14} aria-hidden />
                          Image
                        </button>
                      ) : null}
                      <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        <SmilePlus size={14} aria-hidden />
                        Emoji
                      </span>
                      {MESSAGE_EMOJI_CHOICES.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => setReplyDraft((current) => `${current}${emoji}`)}
                          disabled={replyBusy}
                          className="ui-touch-target inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-app-border bg-app-surface-2 px-2 text-sm disabled:opacity-40"
                          aria-label={`Insert ${MESSAGE_EMOJI_LABELS[emoji] ?? "emoji"}`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                    <input
                      ref={replyAttachmentInputRef}
                      type="file"
                      accept="image/png"
                      className="hidden"
                      onChange={(event) => {
                        void handleReplyAttachment(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                    {replyAttachment ? (
                      <div className="mb-2 flex items-center justify-between rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-xs font-semibold text-app-text-muted">
                        <span className="truncate">{replyAttachment.name}</span>
                        <button
                          type="button"
                          onClick={() => setReplyAttachment(null)}
                          className="ui-touch-target px-2 text-[10px] font-black uppercase tracking-widest text-app-text"
                        >
                          Remove
                        </button>
                      </div>
                    ) : null}
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
                          !currentResponderId ||
                          !replyDraft.trim() ||
                          (selectedRow.channel === "email" &&
                            !replySubject.trim())
                        }
                        className="ui-btn-primary ui-touch-target inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full p-0 disabled:opacity-50"
                        aria-label={replyBusy ? "Sending message" : "Send message"}
                      >
                        <Send size={17} aria-hidden />
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
      <PodiumResponderPinModal
        isOpen={pendingResponder !== null}
        staffName={pendingResponder?.staff.full_name ?? "Staff member"}
        onClose={() => setPendingResponder(null)}
        onConfirm={confirmResponder}
      />
    </div>
  );
}
