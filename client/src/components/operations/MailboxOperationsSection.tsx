import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  FolderOpen,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  MessageSquareReply,
  RefreshCw,
  Search,
  Send,
  SquarePen,
  Star,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useNotificationCenterOptional } from "../../context/NotificationCenterContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import type { Customer } from "../pos/CustomerSelector";

const baseUrl = getBaseUrl();

type MailboxRow = {
  id: string;
  message_id: string | null;
  thread_key: string | null;
  direction: string;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: unknown;
  cc_emails: unknown;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  sent_at: string | null;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  staff_full_name: string | null;
  folder: string;
  status: string;
  is_read: boolean;
};

type FolderFilter =
  | "ALL"
  | "INBOX"
  | "IMPORTANT"
  | "FOLLOW_UP"
  | "SENT"
  | "ARCHIVED"
  | "TRASH";

type MailboxThread = {
  key: string;
  rows: MailboxRow[];
  latest: MailboxRow;
};

const FOLDER_FILTERS = [
  { key: "INBOX" as const, label: "Inbox", icon: Inbox },
  { key: "IMPORTANT" as const, label: "Important", icon: Star },
  { key: "FOLLOW_UP" as const, label: "Follow-up", icon: FolderOpen },
  { key: "SENT" as const, label: "Sent", icon: Send },
  { key: "ARCHIVED" as const, label: "Archived", icon: Archive },
  { key: "TRASH" as const, label: "Trash", icon: Trash2 },
  { key: "ALL" as const, label: "All mail", icon: Mail },
];

function toEmailList(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function bodyPreview(row: MailboxRow): string {
  const body = row.body_html || row.body_text || "";
  if (!body) return "";
  if (typeof DOMParser !== "undefined") {
    const parsed = new DOMParser().parseFromString(body, "text/html");
    return (parsed.body.textContent || "").replace(/\s+/g, " ").trim();
  }
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSubject(subject: string | null): string {
  return (subject || "(No subject)").replace(/^(re|fw|fwd):\s*/i, "").trim();
}

function replySubject(subject: string | null): string {
  const clean = subject || "(No subject)";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

function forwardSubject(subject: string | null): string {
  const clean = subject || "(No subject)";
  return /^(fw|fwd):/i.test(clean) ? clean : `Fwd: ${clean}`;
}

function messageTime(row: MailboxRow): string {
  const timestamp = row.received_at || row.sent_at;
  return timestamp ? new Date(timestamp).toLocaleString() : "No timestamp";
}

function rowHaystack(row: MailboxRow): string {
  return [
    row.direction,
    row.status,
    row.folder,
    row.customer_id ? "matched" : "unmatched",
    cleanSubject(row.subject),
    row.from_email,
    row.from_name,
    toEmailList(row.to_emails),
    toEmailList(row.cc_emails),
    row.customer_code,
    row.customer_name,
    row.staff_full_name,
    bodyPreview(row),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sortTimeValue(row: MailboxRow): number {
  return new Date(row.received_at || row.sent_at || 0).getTime();
}

function getThreadKey(row: MailboxRow): string {
  return row.thread_key || row.message_id || `${cleanSubject(row.subject)}:${row.from_email || toEmailList(row.to_emails)}:${row.id}`;
}

function groupThreads(sourceRows: MailboxRow[]): MailboxThread[] {
  const threadMap = new Map<string, MailboxRow[]>();
  for (const row of sourceRows) {
    const key = getThreadKey(row);
    threadMap.set(key, [...(threadMap.get(key) ?? []), row]);
  }
  return Array.from(threadMap.entries())
    .map(([key, threadRows]) => {
      const rowsSorted = [...threadRows].sort((a, b) => sortTimeValue(a) - sortTimeValue(b));
      return { key, rows: rowsSorted, latest: rowsSorted[rowsSorted.length - 1] };
    })
    .sort((a, b) => sortTimeValue(b.latest) - sortTimeValue(a.latest));
}

function folderMatches(row: MailboxRow, filter: FolderFilter): boolean {
  if (filter === "ALL") return row.folder !== "TRASH";
  if (filter === "SENT") {
    return (
      row.direction !== "inbound" &&
      row.folder !== "ARCHIVED" &&
      row.folder !== "TRASH" &&
      row.status !== "archived"
    );
  }
  if (filter === "ARCHIVED") {
    return row.folder !== "TRASH" && (row.status === "archived" || row.folder === "ARCHIVED");
  }
  if (filter === "TRASH") return row.folder === "TRASH";
  if (filter === "INBOX") {
    return row.direction === "inbound" && row.folder === "INBOX" && row.status !== "archived";
  }
  return row.folder === filter && row.status !== "archived";
}

function customerDisplayName(customer: Customer): string {
  return [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() || customer.company_name || "Customer";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function firstEmail(value: unknown): string {
  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string")?.trim() ?? "";
  }
  if (typeof value === "string") return value.split(",")[0]?.trim() ?? "";
  return "";
}

function safeEmailDocument(row: MailboxRow): string {
  const fallbackText = row.body_text || "";
  if (!row.body_html || typeof DOMParser === "undefined") {
    const linked = escapeHtml(fallbackText || "No message body.").replace(
      /(https?:\/\/[^\s<]+)/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; font-src https: data:; form-action 'none'; base-uri 'none'"><style>html,body{margin:0;background:#fff;color:#172033;font:15px/1.65 Inter,Arial,sans-serif}body{padding:20px;overflow-wrap:anywhere}a{color:#6d28d9}pre{margin:0;white-space:pre-wrap;font:inherit}</style></head><body><pre>${linked}</pre></body></html>`;
  }

  const documentValue = new DOMParser().parseFromString(row.body_html, "text/html");
  documentValue
    .querySelectorAll("script,iframe,object,embed,form,input,button,textarea,select,base,meta[http-equiv]")
    .forEach((element) => element.remove());
  documentValue.querySelectorAll("link").forEach((element) => {
    if (element.getAttribute("rel")?.toLowerCase() !== "stylesheet") element.remove();
  });
  documentValue.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "srcdoc") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" && !/^(https?:|mailto:|tel:|#)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
      if (name === "src" && !/^(https?:|data:image\/|cid:)/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  documentValue.querySelectorAll("a").forEach((anchor) => {
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  });
  documentValue.head.insertAdjacentHTML(
    "afterbegin",
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https:; img-src https: http: data: cid:; font-src https: data:; form-action 'none'; base-uri 'none'; frame-src 'none'"><style>html,body{margin:0;background:#fff;color:#172033;font-family:Inter,Arial,sans-serif}body{padding:20px;overflow-wrap:anywhere}img,table{max-width:100%!important;height:auto!important}a{color:#6d28d9}pre{white-space:pre-wrap}</style>`,
  );
  return `<!doctype html>${documentValue.documentElement.outerHTML}`;
}

export default function MailboxOperationsSection({
  onOpenCustomerHub,
}: {
  onOpenCustomerHub: (customer: Customer) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const notificationCenter = useNotificationCenterOptional();
  const refreshNavigationCounts = notificationCenter?.refreshUnread;
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<MailboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [stateBusy, setStateBusy] = useState(false);
  const [signature, setSignature] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [recipientSuggestions, setRecipientSuggestions] = useState<Customer[]>([]);
  const [recipientSearchBusy, setRecipientSearchBusy] = useState(false);
  const [showRecipientSuggestions, setShowRecipientSuggestions] = useState(false);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("INBOX");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [selectedThreadKeys, setSelectedThreadKeys] = useState<Set<string>>(new Set());
  const [trashThreadKeys, setTrashThreadKeys] = useState<string[] | null>(null);
  const [showPlainText, setShowPlainText] = useState(false);
  const composeSectionRef = useRef<HTMLElement | null>(null);
  const composeBodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAutoReadThreadRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/mailbox?limit=200${unmatchedOnly ? "&unmatched_only=true" : ""}`,
        { headers: apiAuth() },
      );
      if (!res.ok) throw new Error("mailbox");
      const data = (await res.json()) as MailboxRow[];
      setRows(Array.isArray(data) ? data : []);
      setLoadError(null);
    } catch {
      setLoadError("Mailbox could not refresh.");
    } finally {
      setLoading(false);
    }
  }, [apiAuth, unmatchedOnly]);

  const loadSignature = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/signature`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { signature_html?: string };
      setSignature(data.signature_html ?? "");
    } catch {
      // The mailbox remains useful without a saved signature.
    }
  }, [apiAuth]);

  useEffect(() => {
    void refresh();
    void loadSignature();
  }, [loadSignature, refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh();
    }, 30 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    const q = draftTo.trim();
    if (q.length < 2 || q.includes(",")) {
      setRecipientSuggestions([]);
      setRecipientSearchBusy(false);
      return;
    }
    let active = true;
    setRecipientSearchBusy(true);
    const timer = window.setTimeout(() => {
      fetch(`${baseUrl}/api/customers/search?q=${encodeURIComponent(q)}&limit=8&offset=0`, {
        headers: apiAuth(),
      })
        .then(async (res) => {
          if (!active) return;
          if (!res.ok) {
            setRecipientSuggestions([]);
            return;
          }
          const data = (await res.json()) as Customer[];
          setRecipientSuggestions(data.filter((customer) => Boolean(customer.email)));
        })
        .catch(() => {
          if (active) setRecipientSuggestions([]);
        })
        .finally(() => {
          if (active) setRecipientSearchBusy(false);
        });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [apiAuth, draftTo]);

  const visibleRows = useMemo(() => {
    const tokens = search
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const scopedRows = rows.filter((row) => folderMatches(row, folderFilter));
    if (tokens.length === 0) return scopedRows;
    return scopedRows.filter((row) => {
      const haystack = rowHaystack(row);
      return tokens.every((token) => haystack.includes(token));
    });
  }, [folderFilter, rows, search]);

  const allThreads = useMemo(() => groupThreads(rows), [rows]);
  const visibleThreads = useMemo(() => groupThreads(visibleRows), [visibleRows]);

  useEffect(() => {
    if (visibleThreads.length === 0) {
      setSelectedRowId(null);
      return;
    }
    if (!selectedRowId || !visibleRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(visibleThreads[0].latest.id);
    }
  }, [selectedRowId, visibleRows, visibleThreads]);

  const selectedRow = useMemo(
    () => rows.find((row) => row.id === selectedRowId) ?? null,
    [rows, selectedRowId],
  );

  const selectedThread = useMemo(() => {
    if (!selectedRow) return null;
    return (
      allThreads.find((thread) =>
        thread.rows.some((row) => row.id === selectedRow.id),
      ) ?? null
    );
  }, [allThreads, selectedRow]);

  const selectedThreadReadIds = useMemo(
    () =>
      selectedThread?.rows
        .filter((row) => row.direction === "inbound")
        .map((row) => row.id) ?? [],
    [selectedThread],
  );
  const selectedThreadHasUnread =
    selectedThread?.rows.some(
      (row) => row.direction === "inbound" && !row.is_read,
    ) ?? false;

  const stats = useMemo(() => {
    return {
      unread: rows.filter(
        (row) => row.direction === "inbound" && !row.is_read && row.folder !== "TRASH",
      ).length,
      unmatched: rows.filter((row) => !row.customer_id && row.folder !== "TRASH").length,
      folders: Object.fromEntries(
        FOLDER_FILTERS.map((filter) => [
          filter.key,
          rows.filter((row) => folderMatches(row, filter.key)).length,
        ]),
      ) as Record<FolderFilter, number>,
    };
  }, [rows]);

  const openNewComposer = () => {
    setDraftTo("");
    setDraftSubject("");
    setDraftBody("");
    setReplyToMessageId(null);
    setComposerOpen(true);
    focusComposer();
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setShowRecipientSuggestions(false);
    setReplyToMessageId(null);
  };

  const startReply = (row: MailboxRow) => {
    const to =
      row.direction === "inbound"
        ? row.from_email?.trim()
        : firstEmail(row.to_emails);
    if (!to) {
      toast("This email does not have a reply address.", "error");
      return;
    }
    setDraftTo(to);
    setDraftSubject(replySubject(row.subject));
    setDraftBody("");
    setReplyToMessageId(row.id);
    setComposerOpen(true);
    focusComposer();
  };

  const startForward = (row: MailboxRow) => {
    const preview = bodyPreview(row);
    setDraftTo("");
    setDraftSubject(forwardSubject(row.subject));
    setReplyToMessageId(null);
    setComposerOpen(true);
    setDraftBody(
      [
        "",
        "",
        "---------- Forwarded message ----------",
        `From: ${row.from_name || row.from_email || "Unknown sender"}`,
        `Date: ${messageTime(row)}`,
        `Subject: ${row.subject || "(No subject)"}`,
        "",
        preview,
      ].join("\n"),
    );
    focusComposer();
  };

  const focusComposer = () => {
    window.setTimeout(() => {
      composeSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      composeBodyRef.current?.focus();
    }, 0);
  };

  const updateMessagesState = useCallback(async (
    ids: string[],
    patch: { folder?: string; status?: string; is_read?: boolean },
    successMessage?: string,
    quiet = false,
  ): Promise<boolean> => {
    if (ids.length === 0) return false;
    if (!quiet) setStateBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/bulk-state`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({ ids, ...patch }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast(payload.error ?? "Email could not be updated.", "error");
        return false;
      }
      const updated = (await res.json()) as MailboxRow[];
      const updatedById = new Map(updated.map((row) => [row.id, row]));
      setRows((current) => current.map((row) => updatedById.get(row.id) ?? row));
      await refreshNavigationCounts?.();
      if (!quiet && successMessage) toast(successMessage, "success");
      return true;
    } catch {
      toast("Email could not be updated.", "error");
      return false;
    } finally {
      if (!quiet) setStateBusy(false);
    }
  }, [apiAuth, refreshNavigationCounts, toast]);

  useEffect(() => {
    if (!selectedThread) {
      lastAutoReadThreadRef.current = null;
      return;
    }
    if (lastAutoReadThreadRef.current === selectedThread.key) return;
    lastAutoReadThreadRef.current = selectedThread.key;
    const unreadIds = selectedThread.rows
      .filter((row) => row.direction === "inbound" && !row.is_read)
      .map((row) => row.id) ?? [];
    if (unreadIds.length > 0) {
      void updateMessagesState(unreadIds, { is_read: true }, undefined, true);
    }
  }, [selectedThread, updateMessagesState]);

  useEffect(() => {
    setShowPlainText(false);
  }, [selectedRowId]);

  useEffect(() => {
    const visibleKeys = new Set(visibleThreads.map((thread) => thread.key));
    setSelectedThreadKeys((current) => {
      const next = new Set([...current].filter((key) => visibleKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [visibleThreads]);

  const syncInbox = async () => {
    if (syncBusy) return;
    setSyncBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/sync`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast(body.error ?? "Mailbox sync could not run.", "error");
        return;
      }
      const data = (await res.json()) as {
        inserted: number;
        matched_customers: number;
      };
      toast(
        `Mailbox synced: ${data.inserted} new, ${data.matched_customers} matched.`,
        "success",
      );
      await refresh();
      await refreshNavigationCounts?.();
    } catch {
      toast("Mailbox sync could not run.", "error");
    } finally {
      setSyncBusy(false);
    }
  };

  const sendEmail = async () => {
    if (sendBusy) return;
    const to = draftTo.trim();
    const subject = draftSubject.trim();
    const body = draftBody.trim();
    if (!to || !subject || !body) {
      toast("Recipient, subject, and message are required.", "error");
      return;
    }
    setSendBusy(true);
    try {
      const htmlBody = `<p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>`;
      const res = await fetch(`${baseUrl}/api/mailbox`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          to_email: to,
          subject,
          html_body: htmlBody,
          signature_html: signature,
          reply_to_message_id: replyToMessageId,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast(payload.error ?? "Email could not be sent.", "error");
        return;
      }
      setDraftTo("");
      setDraftSubject("");
      setDraftBody("");
      setReplyToMessageId(null);
      setComposerOpen(false);
      toast("Email sent.", "success");
      await refresh();
    } catch {
      toast("Email could not be sent.", "error");
    } finally {
      setSendBusy(false);
    }
  };

  const idsForThreadKeys = (keys: Iterable<string>): string[] => {
    const wanted = new Set(keys);
    return allThreads
      .filter((thread) => wanted.has(thread.key))
      .flatMap((thread) => thread.rows.map((row) => row.id));
  };

  const selectedBulkReadIds = allThreads
    .filter((thread) => selectedThreadKeys.has(thread.key))
    .flatMap((thread) =>
      thread.rows
        .filter((row) => row.direction === "inbound")
        .map((row) => row.id),
    );

  const moveMessagesToFolder = async (
    messageRows: MailboxRow[],
    folder: "INBOX" | "IMPORTANT" | "FOLLOW_UP" | "ARCHIVED",
    successMessage: string,
  ) => {
    const inboundIds = messageRows
      .filter((row) => row.direction === "inbound")
      .map((row) => row.id);
    const sentIds = messageRows
      .filter((row) => row.direction !== "inbound")
      .map((row) => row.id);
    setStateBusy(true);
    const results = await Promise.all([
      inboundIds.length > 0
        ? updateMessagesState(
            inboundIds,
            {
              folder,
              status: folder === "ARCHIVED" ? "archived" : "received",
              ...(folder === "ARCHIVED" ? { is_read: true } : {}),
            },
            undefined,
            true,
          )
        : Promise.resolve(true),
      sentIds.length > 0
        ? updateMessagesState(
            sentIds,
            {
              folder,
              status: folder === "ARCHIVED" ? "archived" : "sent",
              ...(folder === "ARCHIVED" ? { is_read: true } : {}),
            },
            undefined,
            true,
          )
        : Promise.resolve(true),
    ]);
    setStateBusy(false);
    if (results.every(Boolean)) toast(successMessage, "success");
  };

  const restoreMessages = (messageRows: MailboxRow[], successMessage: string) =>
    moveMessagesToFolder(messageRows, "INBOX", successMessage);

  const confirmTrash = async () => {
    if (!trashThreadKeys) return;
    const ids = idsForThreadKeys(trashThreadKeys);
    const updated = await updateMessagesState(
      ids,
      { folder: "TRASH", is_read: true },
      `${trashThreadKeys.length === 1 ? "Conversation" : "Conversations"} moved to Trash.`,
    );
    if (updated) {
      setSelectedThreadKeys(new Set());
      setTrashThreadKeys(null);
    }
  };

  return (
    <div className="ui-page flex flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight text-app-text">Mail</h1>
          <p className="mt-1 text-xs font-semibold text-app-text-muted">
            info@riversidemens.com · {stats.unread} unread · {stats.unmatched} unmatched
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={openNewComposer}
            className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs font-black"
          >
            <SquarePen className="h-4 w-4" aria-hidden />
            New email
          </button>
          <button
            type="button"
            onClick={() => void syncInbox()}
            disabled={syncBusy}
            className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            {syncBusy ? "Syncing..." : "Sync"}
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            className="ui-btn-secondary px-3 py-2 text-xs font-black"
          >
            Refresh
          </button>
        </div>
      </div>

      {composerOpen ? (
        <section ref={composeSectionRef} className="rounded-xl border border-app-accent/40 bg-app-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-black text-app-text">
            <Send className="h-4 w-4 text-app-accent" aria-hidden />
            {replyToMessageId ? "Reply" : draftSubject.startsWith("Fwd:") ? "Forward" : "New email"}
          </div>
          <button
            type="button"
            onClick={closeComposer}
            className="ui-touch-target rounded-lg text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
            aria-label="Close composer"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_minmax(0,1fr)_auto] lg:items-end">
          <div className="relative block">
            <label
              htmlFor="mailbox-quick-email-recipient"
              className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
            >
              To
            </label>
            <input
              id="mailbox-quick-email-recipient"
              value={draftTo}
              onFocus={() => setShowRecipientSuggestions(true)}
              onChange={(event) => {
                setDraftTo(event.target.value);
                setShowRecipientSuggestions(true);
              }}
              className="ui-input h-10 w-full px-3 text-sm"
              placeholder="Search customer or enter email"
            />
            {showRecipientSuggestions && (recipientSuggestions.length > 0 || recipientSearchBusy) ? (
              <div className="absolute z-30 mt-2 max-h-56 w-full overflow-auto rounded-xl border border-app-border bg-app-surface shadow-2xl">
                {recipientSearchBusy ? (
                  <div className="px-3 py-2 text-xs font-bold text-app-text-muted">
                    Searching customers...
                  </div>
                ) : null}
                {recipientSuggestions.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setDraftTo(customer.email ?? "");
                      setShowRecipientSuggestions(false);
                    }}
                    className="block w-full border-b border-app-border px-3 py-2 text-left last:border-b-0 hover:bg-app-surface-2"
                  >
                    <span className="block text-xs font-black text-app-text">
                      {customerDisplayName(customer)}
                    </span>
                    <span className="block text-[11px] font-semibold text-app-text-muted">
                      {customer.email}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Subject
            </span>
            <input
              value={draftSubject}
              onChange={(event) => setDraftSubject(event.target.value)}
              className="ui-input h-10 w-full px-3 text-sm"
              placeholder="Riverside Men's Shop"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Message
            </span>
            <textarea
              ref={composeBodyRef}
              value={draftBody}
              onChange={(event) => setDraftBody(event.target.value)}
              className="ui-input min-h-10 w-full resize-y px-3 py-2 text-sm"
              placeholder="Write a quick message..."
            />
          </label>
          <button
            type="button"
            onClick={() => void sendEmail()}
            disabled={sendBusy || !draftTo.trim() || !draftSubject.trim() || !draftBody.trim()}
            className="ui-btn-primary h-10 px-5 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
          >
            {sendBusy ? "Sending..." : "Send"}
          </button>
        </div>
        </section>
      ) : null}

      {loadError ? (
        <div className="rounded-xl border border-app-warning/40 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-app-warning" />
            <div>
              <p className="font-black">{loadError}</p>
              <p className="text-xs text-app-text-muted">
                Retry before treating the mailbox as empty.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-app-text-muted">Loading mailbox...</p>
      ) : (
        <div className="grid min-h-[40rem] flex-1 rounded-xl border border-app-border bg-app-surface lg:grid-cols-[10rem_minmax(17rem,0.8fr)_minmax(22rem,1.2fr)]">
          <aside className="flex gap-2 overflow-x-auto border-b border-app-border bg-app-surface-2 p-3 lg:block lg:border-b-0 lg:border-r">
            {FOLDER_FILTERS.map((filter) => {
              const Icon = filter.icon;
              const active = folderFilter === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => {
                    setFolderFilter(filter.key);
                    setSelectedThreadKeys(new Set());
                  }}
                  className={`mb-0 flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-xs font-black transition lg:mb-1 lg:w-full ${
                    active
                      ? "bg-app-accent text-white"
                      : "text-app-text-muted hover:bg-app-surface hover:text-app-text"
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="flex-1">{filter.label}</span>
                  <span className={active ? "text-white/80" : "text-app-text-muted"}>
                    {stats.folders[filter.key]}
                  </span>
                </button>
              );
            })}
            <label className="mt-3 flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted lg:w-full">
              <input
                type="checkbox"
                checked={unmatchedOnly}
                onChange={(event) => setUnmatchedOnly(event.target.checked)}
                className="h-4 w-4 rounded border-app-border accent-app-accent"
              />
              Unmatched only
            </label>
          </aside>

          <section className="flex min-h-0 flex-col border-b border-app-border lg:border-b-0 lg:border-r">
            <div className="border-b border-app-border p-3">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-text-muted" aria-hidden />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  className="ui-input h-9 w-full pl-9 pr-3 text-xs"
                  placeholder="Search mail"
                  aria-label="Search mail"
                />
              </label>
              <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                <span>{visibleThreads.length} conversations</span>
                {selectedThreadKeys.size > 0 ? (
                  <button
                    type="button"
                    onClick={() => setSelectedThreadKeys(new Set())}
                    className="text-app-accent hover:underline"
                  >
                    Clear selection
                  </button>
                ) : null}
              </div>
            </div>

            {selectedThreadKeys.size > 0 ? (
              <div className="flex flex-wrap gap-2 border-b border-app-border bg-app-accent/5 p-2">
                <button
                  type="button"
                  onClick={() =>
                    void updateMessagesState(
                      selectedBulkReadIds,
                      { is_read: true },
                      "Selected conversations marked read.",
                    )
                  }
                  disabled={stateBusy || selectedBulkReadIds.length === 0}
                  className="ui-btn-secondary px-2.5 py-1.5 text-[10px] font-black disabled:opacity-50"
                >
                  Read
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void updateMessagesState(
                      selectedBulkReadIds,
                      { is_read: false },
                      "Selected conversations marked unread.",
                    )
                  }
                  disabled={stateBusy || selectedBulkReadIds.length === 0}
                  className="ui-btn-secondary px-2.5 py-1.5 text-[10px] font-black disabled:opacity-50"
                >
                  Unread
                </button>
                <button
                  type="button"
                  disabled={stateBusy}
                  onClick={() =>
                    void moveMessagesToFolder(
                      allThreads
                        .filter((thread) => selectedThreadKeys.has(thread.key))
                        .flatMap((thread) => thread.rows),
                      "ARCHIVED",
                      "Selected conversations archived.",
                    )
                  }
                  className="ui-btn-secondary px-2.5 py-1.5 text-[10px] font-black"
                >
                  Archive
                </button>
                <button
                  type="button"
                  disabled={stateBusy}
                  onClick={() => setTrashThreadKeys([...selectedThreadKeys])}
                  className="ui-btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-black text-app-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Delete
                </button>
              </div>
            ) : null}

            {visibleThreads.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
                <Mail size={36} className="mb-3 text-app-text-muted opacity-60" />
                <p className="text-sm font-black text-app-text">No email in this view</p>
                <p className="mt-2 max-w-xs text-xs leading-5 text-app-text-muted">
                  Choose another folder or sync to pull new messages.
                </p>
              </div>
            ) : (
              <ul className="max-h-[70vh] min-h-0 flex-1 divide-y divide-app-border overflow-auto">
                {visibleThreads.map((thread) => {
                  const row = thread.latest;
                  const inbound = row.direction === "inbound";
                  const selected = selectedThread?.key === thread.key;
                  const unread = thread.rows.some(
                    (threadRow) => threadRow.direction === "inbound" && !threadRow.is_read,
                  );
                  const checked = selectedThreadKeys.has(thread.key);
                  return (
                    <li key={thread.key} className="relative flex items-start">
                      <label className="flex h-full shrink-0 items-start px-3 pt-4">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => {
                            setSelectedThreadKeys((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(thread.key);
                              else next.delete(thread.key);
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-app-border accent-app-accent"
                          aria-label={`Select ${row.subject || "email conversation"}`}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => setSelectedRowId(row.id)}
                        className={`min-w-0 flex-1 px-1 py-3 pr-4 text-left transition ${
                          selected ? "bg-app-accent/10" : "hover:bg-app-surface-2"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {unread ? (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-app-accent" aria-label="Unread" />
                          ) : (
                            <span className="h-2 w-2 shrink-0" aria-hidden />
                          )}
                          <p className={`truncate text-xs text-app-text ${unread ? "font-black" : "font-semibold"}`}>
                            {inbound
                              ? row.from_name || row.from_email || "Unknown sender"
                              : `To ${toEmailList(row.to_emails) || "recipient"}`}
                          </p>
                          <span className="ml-auto shrink-0 text-[9px] font-bold text-app-text-muted">
                            {messageTime(row)}
                          </span>
                        </div>
                        <p className={`mt-1 truncate text-sm text-app-text ${unread ? "font-black" : "font-bold"}`}>
                          {row.subject || "(No subject)"}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-app-text-muted">
                          {bodyPreview(row) || "No message preview."}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${
                            inbound
                              ? "border-app-accent/30 bg-app-accent/10 text-app-accent"
                              : "border-app-success/30 bg-app-success/10 text-app-success"
                          }`}>
                            {inbound ? "Inbound" : "Sent"}
                          </span>
                          {!row.customer_name ? (
                            <span className="rounded border border-app-warning/30 bg-app-warning/10 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-warning">
                              Unmatched
                            </span>
                          ) : null}
                          {thread.rows.length > 1 ? (
                            <span className="text-[9px] font-black uppercase text-app-text-muted">
                              {thread.rows.length} messages
                            </span>
                          ) : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="flex min-h-0 flex-col bg-app-surface-2">
            {selectedRow ? (
              <>
                <div className="border-b border-app-border p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {selectedRow.direction === "inbound" ? "Inbound" : "Sent"}
                    </span>
                    <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {selectedThreadHasUnread ? "Unread" : "Read"}
                    </span>
                    <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {selectedRow.folder.replace("_", " ")}
                    </span>
                    {selectedThread && selectedThread.rows.length > 1 ? (
                      <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Thread: {selectedThread.rows.length} messages
                      </span>
                    ) : null}
                  </div>
                  <h2 className="text-lg font-black text-app-text">
                    {selectedRow.subject || "(No subject)"}
                  </h2>
                  <p className="mt-2 text-xs font-semibold leading-5 text-app-text-muted">
                    {selectedRow.direction === "inbound"
                      ? `${selectedRow.from_name || selectedRow.from_email || "Unknown sender"}${selectedRow.from_email ? ` <${selectedRow.from_email}>` : ""}`
                      : `To ${toEmailList(selectedRow.to_emails) || "recipient"}`}
                  </p>
                  <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                    {messageTime(selectedRow)}
                    {selectedRow.staff_full_name ? ` · Sent by ${selectedRow.staff_full_name}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 border-b border-app-border p-4">
                  <label className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Move
                    <select
                      value={
                        selectedRow.folder === "TRASH"
                          ? "TRASH"
                          : selectedRow.status === "archived"
                            ? "ARCHIVED"
                            : selectedRow.folder
                      }
                      onChange={(event) => {
                        const folder = event.target.value as FolderFilter;
                        if (!selectedThread) return;
                        if (folder === "TRASH") {
                          setTrashThreadKeys([selectedThread.key]);
                          return;
                        }
                        if (
                          folder === "INBOX" ||
                          folder === "IMPORTANT" ||
                          folder === "FOLLOW_UP" ||
                          folder === "ARCHIVED"
                        ) {
                          void moveMessagesToFolder(
                            selectedThread.rows,
                            folder,
                            `Conversation moved to ${folder.toLowerCase().replace("_", "-")}.`,
                          );
                        }
                      }}
                      disabled={stateBusy}
                      className="bg-transparent text-app-text outline-none"
                    >
                      <option value="INBOX">Inbox</option>
                      <option value="IMPORTANT">Important</option>
                      <option value="FOLLOW_UP">Follow-up</option>
                      <option value="ARCHIVED">Archived</option>
                      <option value="TRASH">Trash</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => startReply(selectedRow)}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <MessageSquareReply className="h-3.5 w-3.5" aria-hidden />
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => startForward(selectedRow)}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Forward className="h-3.5 w-3.5" aria-hidden />
                    Forward
                  </button>
                  {selectedThreadReadIds.length > 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        void updateMessagesState(
                          selectedThreadReadIds,
                          { is_read: !selectedThreadHasUnread },
                          `Conversation marked ${selectedThreadHasUnread ? "read" : "unread"}.`,
                        )
                      }
                      disabled={stateBusy}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      {selectedThreadHasUnread ? (
                        <MailOpen className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <Mail className="h-3.5 w-3.5" aria-hidden />
                      )}
                      Mark {selectedThreadHasUnread ? "read" : "unread"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() =>
                      selectedThread &&
                      void moveMessagesToFolder(
                        selectedThread.rows,
                        selectedRow.folder === "IMPORTANT" ? "INBOX" : "IMPORTANT",
                        selectedRow.folder === "IMPORTANT"
                          ? "Conversation moved to Inbox."
                          : "Conversation marked important.",
                      )
                    }
                    disabled={stateBusy}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Star className="h-3.5 w-3.5" aria-hidden />
                    {selectedRow.folder === "IMPORTANT" ? "Unstar" : "Important"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      selectedThread &&
                      void moveMessagesToFolder(
                        selectedThread.rows,
                        selectedRow.folder === "FOLLOW_UP" ? "INBOX" : "FOLLOW_UP",
                        selectedRow.folder === "FOLLOW_UP"
                          ? "Conversation moved to Inbox."
                          : "Conversation marked for follow-up.",
                      )
                    }
                    disabled={stateBusy}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    {selectedRow.folder === "FOLLOW_UP" ? "Inbox" : "Follow-up"}
                  </button>
                  {selectedRow.folder === "TRASH" || selectedRow.status === "archived" ? (
                    <button
                      type="button"
                      disabled={stateBusy}
                      onClick={() =>
                        selectedThread &&
                        void restoreMessages(selectedThread.rows, "Conversation restored to Inbox.")
                      }
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      <Inbox className="h-3.5 w-3.5" aria-hidden />
                      Restore
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={stateBusy}
                      onClick={() =>
                        selectedThread &&
                        void moveMessagesToFolder(
                          selectedThread.rows,
                          "ARCHIVED",
                          "Conversation archived.",
                        )
                      }
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      <Archive className="h-3.5 w-3.5" aria-hidden />
                      Archive
                    </button>
                  )}
                  {selectedRow.folder !== "TRASH" && selectedThread ? (
                    <button
                      type="button"
                      disabled={stateBusy}
                      onClick={() => setTrashThreadKeys([selectedThread.key])}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-danger"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      Delete
                    </button>
                  ) : null}
                  {selectedRow.customer_id && selectedRow.customer_name ? (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenCustomerHub({
                          id: selectedRow.customer_id!,
                          customer_code: selectedRow.customer_code ?? "",
                          first_name: selectedRow.customer_name ?? "Customer",
                          last_name: "",
                          company_name: null,
                          email: selectedRow.from_email,
                          phone: null,
                        })
                      }
                      className="ui-btn-primary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      <UserRound className="h-3.5 w-3.5" aria-hidden />
                      Customer
                    </button>
                  ) : null}
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  {selectedRow.customer_name ? (
                    <div className="mb-4 rounded-xl border border-app-border bg-app-surface px-3 py-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                        Matched customer
                      </p>
                      <p className="mt-1 text-sm font-black text-app-text">
                        {selectedRow.customer_name}
                      </p>
                      {selectedRow.customer_code ? (
                        <p className="text-xs font-bold text-app-text-muted">
                          {selectedRow.customer_code}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="space-y-3">
                    {(selectedThread?.rows ?? [selectedRow]).map((threadRow) => {
                      const active = threadRow.id === selectedRow.id;
                      return (
                        <article
                          key={threadRow.id}
                          className={`overflow-hidden rounded-xl border ${
                            active
                              ? "border-app-accent bg-app-accent/5"
                              : "border-app-border bg-app-surface"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedRowId(threadRow.id)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left"
                          >
                            {threadRow.direction === "inbound" && !threadRow.is_read ? (
                              <span className="h-2 w-2 shrink-0 rounded-full bg-app-accent" aria-label="Unread" />
                            ) : null}
                            <span className="min-w-0 flex-1 truncate text-xs font-black text-app-text">
                              {threadRow.direction === "inbound"
                                ? threadRow.from_name || threadRow.from_email || "Unknown sender"
                                : `To ${toEmailList(threadRow.to_emails) || "recipient"}`}
                            </span>
                            <span className="shrink-0 text-[10px] font-bold text-app-text-muted">
                              {messageTime(threadRow)}
                            </span>
                          </button>
                          {active ? (
                            <div className="border-t border-app-border p-3">
                              {threadRow.body_html && threadRow.body_text ? (
                                <div className="mb-2 flex justify-end">
                                  <button
                                    type="button"
                                    onClick={() => setShowPlainText((current) => !current)}
                                    className="text-[10px] font-black uppercase tracking-widest text-app-accent hover:underline"
                                  >
                                    View {showPlainText ? "formatted email" : "plain text"}
                                  </button>
                                </div>
                              ) : null}
                              <iframe
                                title={`Email message from ${threadRow.from_name || threadRow.from_email || "Riverside"}`}
                                sandbox="allow-popups allow-popups-to-escape-sandbox"
                                referrerPolicy="no-referrer"
                                srcDoc={safeEmailDocument(
                                  showPlainText ? { ...threadRow, body_html: null } : threadRow,
                                )}
                                className="h-[30rem] w-full rounded-lg border border-app-border bg-white"
                              />
                            </div>
                          ) : (
                            <p className="truncate border-t border-app-border px-4 py-2 text-xs text-app-text-muted">
                              {bodyPreview(threadRow) || "No message preview."}
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center p-8 text-center text-sm font-bold text-app-text-muted">
                Select a message.
              </div>
            )}
          </section>
        </div>
      )}
      <ConfirmationModal
        isOpen={trashThreadKeys !== null}
        onClose={() => setTrashThreadKeys(null)}
        onConfirm={() => void confirmTrash()}
        title="Move email to Trash?"
        message="The selected conversation stays recoverable in Trash. No email record is permanently removed."
        confirmLabel="Move to Trash"
        variant="danger"
        loading={stateBusy}
      />
    </div>
  );
}
