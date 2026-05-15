import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  FolderOpen,
  Forward,
  Inbox,
  Mail,
  MessageSquareReply,
  RefreshCw,
  Search,
  Send,
  Star,
  UserRound,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
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
};

type FolderFilter = "ALL" | "INBOX" | "IMPORTANT" | "FOLLOW_UP" | "SENT" | "ARCHIVED";

type MailboxThread = {
  key: string;
  rows: MailboxRow[];
  latest: MailboxRow;
};

const FOLDER_FILTERS: { key: FolderFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "INBOX", label: "Inbox" },
  { key: "IMPORTANT", label: "Important" },
  { key: "FOLLOW_UP", label: "Follow-up" },
  { key: "SENT", label: "Sent" },
  { key: "ARCHIVED", label: "Archived" },
];

function toEmailList(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function bodyPreview(row: MailboxRow): string {
  const body = row.body_text || row.body_html || "";
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

function folderMatches(row: MailboxRow, filter: FolderFilter): boolean {
  if (filter === "ALL") return true;
  if (filter === "SENT") return row.direction !== "inbound" && row.status !== "archived";
  if (filter === "ARCHIVED") return row.status === "archived" || row.folder === "ARCHIVED";
  return row.folder === filter && row.status !== "archived";
}

function customerDisplayName(customer: Customer): string {
  return [customer.first_name, customer.last_name].filter(Boolean).join(" ").trim() || customer.company_name || "Customer";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export default function MailboxOperationsSection({
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
  const [rows, setRows] = useState<MailboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [signature, setSignature] = useState("");
  const [draftTo, setDraftTo] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [recipientSuggestions, setRecipientSuggestions] = useState<Customer[]>([]);
  const [recipientSearchBusy, setRecipientSearchBusy] = useState(false);
  const [showRecipientSuggestions, setShowRecipientSuggestions] = useState(false);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>("ALL");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/mailbox?limit=120${unmatchedOnly ? "&unmatched_only=true" : ""}`,
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

  const visibleThreads = useMemo<MailboxThread[]>(() => {
    const threadMap = new Map<string, MailboxRow[]>();
    for (const row of visibleRows) {
      const key = getThreadKey(row);
      threadMap.set(key, [...(threadMap.get(key) ?? []), row]);
    }
    return Array.from(threadMap.entries())
      .map(([key, threadRows]) => {
        const rowsSorted = [...threadRows].sort((a, b) => sortTimeValue(a) - sortTimeValue(b));
        return {
          key,
          rows: rowsSorted,
          latest: rowsSorted[rowsSorted.length - 1],
        };
      })
      .sort((a, b) => sortTimeValue(b.latest) - sortTimeValue(a.latest));
  }, [visibleRows]);

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
    () => visibleRows.find((row) => row.id === selectedRowId) ?? null,
    [selectedRowId, visibleRows],
  );

  const selectedThread = useMemo(() => {
    if (!selectedRow) return null;
    return (
      visibleThreads.find((thread) =>
        thread.rows.some((row) => row.id === selectedRow.id),
      ) ?? null
    );
  }, [selectedRow, visibleThreads]);

  const stats = useMemo(() => {
    const inbound = rows.filter((row) => row.direction === "inbound").length;
    const matched = rows.filter((row) => row.customer_id).length;
    return {
      inbound,
      matched,
      unmatched: rows.length - matched,
      sent: rows.length - inbound,
      folders: Object.fromEntries(
        FOLDER_FILTERS.map((filter) => [
          filter.key,
          rows.filter((row) => folderMatches(row, filter.key)).length,
        ]),
      ) as Record<FolderFilter, number>,
    };
  }, [rows]);

  const startReply = (row: MailboxRow) => {
    const to = row.from_email?.trim();
    if (!to) {
      toast("This email does not have a reply address.", "error");
      return;
    }
    setDraftTo(to);
    setDraftSubject(replySubject(row.subject));
    setDraftBody("");
    setReplyToMessageId(row.id);
  };

  const startForward = (row: MailboxRow) => {
    const preview = bodyPreview(row);
    setDraftTo("");
    setDraftSubject(forwardSubject(row.subject));
    setReplyToMessageId(null);
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
  };

  const updateMessageState = async (
    row: MailboxRow,
    patch: { folder?: string; status?: string },
  ) => {
    try {
      const res = await fetch(`${baseUrl}/api/mailbox/${row.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast(payload.error ?? "Message could not be updated.", "error");
        return;
      }
      const updated = (await res.json()) as MailboxRow;
      setRows((current) =>
        current.map((existing) => (existing.id === updated.id ? updated : existing)),
      );
      setSelectedRowId(updated.id);
      toast("Message updated.", "success");
    } catch {
      toast("Message could not be updated.", "error");
    }
  };

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
      toast("Email sent.", "success");
      await refresh();
    } catch {
      toast("Email could not be sent.", "error");
    } finally {
      setSendBusy(false);
    }
  };

  return (
    <div className="ui-page flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-app-border bg-app-surface text-app-accent">
              <Mail className="h-5 w-5" aria-hidden />
            </div>
            <h1 className="text-lg font-black uppercase tracking-tight text-app-text">
              Mailbox
            </h1>
          </div>
          <p className="max-w-2xl text-xs font-semibold leading-5 text-app-text-muted">
            Store email from info@riversidemens.com. Matched customer email also appears
            in that customer&apos;s Messages tab; unmatched email stays here for staff follow-up.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void syncInbox()}
            disabled={syncBusy}
            className="ui-btn-primary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncBusy ? "animate-spin" : ""}`} aria-hidden />
            Sync inbox
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

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Inbox", value: stats.inbound, icon: Inbox },
          { label: "Matched", value: stats.matched, icon: UserRound },
          { label: "Unmatched", value: stats.unmatched, icon: AlertTriangle },
          { label: "Sent", value: stats.sent, icon: Send },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="rounded-xl border border-app-border bg-app-surface px-4 py-3"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {item.label}
                </span>
                <Icon className="h-4 w-4 text-app-accent" aria-hidden />
              </div>
              <p className="text-2xl font-black text-app-text">{item.value}</p>
            </div>
          );
        })}
      </section>

      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <Send className="h-3.5 w-3.5" aria-hidden />
          Quick email
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_minmax(0,1fr)_auto] lg:items-end">
          <label className="relative block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              To
            </span>
            <input
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
          </label>
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

      <div className="flex flex-wrap gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-3">
        {FOLDER_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            onClick={() => setFolderFilter(filter.key)}
            className={`rounded-xl border px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${
              folderFilter === filter.key
                ? "border-app-accent bg-app-accent/15 text-app-accent"
                : "border-app-border bg-app-surface-2 text-app-text-muted hover:text-app-text"
            }`}
          >
            {filter.label}
            <span className="ml-2 rounded-full bg-app-surface px-2 py-0.5 text-[9px]">
              {stats.folders[filter.key]}
            </span>
          </button>
        ))}
      </div>

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
            placeholder="Search sender, customer, subject, message, inbound, sent, matched"
            className="ui-input h-10 w-full rounded-xl pl-9 pr-3 text-xs font-bold"
          />
        </div>
        <label className="flex h-10 items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <input
            type="checkbox"
            checked={unmatchedOnly}
            onChange={(event) => setUnmatchedOnly(event.target.checked)}
            className="h-4 w-4 accent-app-accent"
          />
          Unmatched only
        </label>
        <span className="whitespace-nowrap text-xs font-bold text-app-text-muted">
          {visibleThreads.length} threads / {visibleRows.length} messages
        </span>
      </div>

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
      ) : visibleThreads.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-app-border bg-app-surface px-6 py-12 text-center">
          <Mail size={42} className="mb-3 text-app-text-muted opacity-60" />
          <p className="text-sm font-black uppercase tracking-widest text-app-text">
            No email in this view
          </p>
          <p className="mt-2 max-w-sm text-xs font-semibold leading-5 text-app-text-muted">
            Sync inbox to pull new messages from IONOS. Matched customer email will
            appear here and in Customer Messages.
          </p>
        </div>
      ) : (
        <div className="grid min-h-[32rem] flex-1 overflow-hidden rounded-xl border border-app-border bg-app-surface lg:grid-cols-[minmax(20rem,0.9fr)_minmax(0,1.1fr)]">
          <ul className="max-h-[70vh] divide-y divide-app-border overflow-auto">
            {visibleThreads.map((thread) => {
              const row = thread.latest;
              const inbound = row.direction === "inbound";
              const selected = selectedThread?.key === thread.key;
              return (
                <li key={thread.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedRowId(row.id)}
                    className={`block w-full px-4 py-3 text-left transition ${
                      selected ? "bg-app-accent/10" : "hover:bg-app-surface-2"
                    }`}
                  >
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${
                          inbound
                            ? "border-app-accent/30 bg-app-accent/10 text-app-accent"
                            : "border-app-success/30 bg-app-success/10 text-app-success"
                        }`}
                      >
                        {inbound ? "Inbound" : "Sent"}
                      </span>
                      {row.customer_name ? (
                        <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                          Matched
                        </span>
                      ) : (
                        <span className="rounded border border-app-warning/30 bg-app-warning/10 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-warning">
                          Unmatched
                        </span>
                      )}
                      {row.folder !== "INBOX" ? (
                        <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                          {row.folder.replace("_", " ")}
                        </span>
                      ) : null}
                      {thread.rows.length > 1 ? (
                        <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                          {thread.rows.length} messages
                        </span>
                      ) : null}
                      <span className="ml-auto text-[10px] font-bold text-app-text-muted">
                        {messageTime(row)}
                      </span>
                    </div>
                    <p className="truncate text-sm font-black text-app-text">
                      {row.subject || "(No subject)"}
                    </p>
                    <p className="mt-1 truncate text-xs font-semibold text-app-text-muted">
                      {inbound
                        ? row.from_name || row.from_email || "Unknown sender"
                        : `To ${toEmailList(row.to_emails) || "recipient"}`}
                    </p>
                    {row.customer_name ? (
                      <p className="mt-1 truncate text-xs font-bold text-app-text">
                        {row.customer_name} {row.customer_code ? `- ${row.customer_code}` : ""}
                      </p>
                    ) : null}
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-app-text-muted">
                      {bodyPreview(row) || "No message preview."}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
          <section className="flex min-h-0 flex-col border-t border-app-border bg-app-surface-2 lg:border-l lg:border-t-0">
            {selectedRow ? (
              <>
                <div className="border-b border-app-border p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {selectedRow.direction === "inbound" ? "Inbound" : "Sent"}
                    </span>
                    <span className="rounded border border-app-border bg-app-surface px-2 py-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {selectedRow.status}
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
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 border-b border-app-border p-4">
                  <label className="flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Move
                    <select
                      value={selectedRow.status === "archived" ? "ARCHIVED" : selectedRow.folder}
                      onChange={(event) => {
                        const folder = event.target.value;
                        void updateMessageState(selectedRow, {
                          folder,
                          status:
                            folder === "ARCHIVED"
                              ? "archived"
                              : selectedRow.direction === "inbound"
                                ? "received"
                                : "sent",
                        });
                      }}
                      className="bg-transparent text-app-text outline-none"
                    >
                      <option value="INBOX">Inbox</option>
                      <option value="IMPORTANT">Important</option>
                      <option value="FOLLOW_UP">Follow-up</option>
                      <option value="ARCHIVED">Archived</option>
                    </select>
                  </label>
                  {selectedRow.direction === "inbound" ? (
                    <button
                      type="button"
                      onClick={() => startReply(selectedRow)}
                      className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                    >
                      <MessageSquareReply className="h-3.5 w-3.5" aria-hidden />
                      Reply
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => startForward(selectedRow)}
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Forward className="h-3.5 w-3.5" aria-hidden />
                    Forward
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateMessageState(selectedRow, {
                        folder:
                          selectedRow.folder === "IMPORTANT" ? "INBOX" : "IMPORTANT",
                      })
                    }
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Star className="h-3.5 w-3.5" aria-hidden />
                    {selectedRow.folder === "IMPORTANT" ? "Unstar" : "Important"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateMessageState(selectedRow, {
                        folder:
                          selectedRow.folder === "FOLLOW_UP" ? "INBOX" : "FOLLOW_UP",
                      })
                    }
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <FolderOpen className="h-3.5 w-3.5" aria-hidden />
                    {selectedRow.folder === "FOLLOW_UP" ? "Inbox" : "Follow-up"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void updateMessageState(selectedRow, {
                        folder:
                          selectedRow.status === "archived" ? "INBOX" : "ARCHIVED",
                        status:
                          selectedRow.status === "archived"
                            ? selectedRow.direction === "inbound"
                              ? "received"
                              : "sent"
                            : "archived",
                      })
                    }
                    className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <Archive className="h-3.5 w-3.5" aria-hidden />
                    {selectedRow.status === "archived" ? "Restore" : "Archive"}
                  </button>
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
                    {(selectedThread?.rows ?? [selectedRow]).map((threadRow) => (
                      <article
                        key={threadRow.id}
                        className={`rounded-xl border p-4 ${
                          threadRow.id === selectedRow.id
                            ? "border-app-accent bg-app-accent/5"
                            : "border-app-border bg-app-surface"
                        }`}
                      >
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className="rounded border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                            {threadRow.direction === "inbound" ? "Inbound" : "Sent"}
                          </span>
                          <span className="text-[10px] font-bold text-app-text-muted">
                            {messageTime(threadRow)}
                          </span>
                        </div>
                        <p className="mb-2 text-xs font-black text-app-text">
                          {threadRow.direction === "inbound"
                            ? threadRow.from_name || threadRow.from_email || "Unknown sender"
                            : `To ${toEmailList(threadRow.to_emails) || "recipient"}`}
                        </p>
                        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-app-text">
                          {bodyPreview(threadRow) || "No message body."}
                        </pre>
                      </article>
                    ))}
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
    </div>
  );
}
