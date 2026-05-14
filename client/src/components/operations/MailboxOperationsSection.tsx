import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Mail, RefreshCw, Search, Send } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import type { Customer } from "../pos/CustomerSelector";

const baseUrl = getBaseUrl();

type MailboxRow = {
  id: string;
  direction: string;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_emails: unknown;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  sent_at: string | null;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  staff_full_name: string | null;
  status: string;
};

function toEmailList(value: unknown): string {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function bodyPreview(row: MailboxRow): string {
  const body = row.body_text || row.body_html || "";
  return body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/mailbox/?limit=120${unmatchedOnly ? "&unmatched_only=true" : ""}`,
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

  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [
        row.subject,
        row.from_email,
        row.from_name,
        toEmailList(row.to_emails),
        row.customer_code,
        row.customer_name,
        row.staff_full_name,
        bodyPreview(row),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [rows, search]);

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
      const res = await fetch(`${baseUrl}/api/mailbox/`, {
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

      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <div className="mb-3 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <Send className="h-3.5 w-3.5" aria-hidden />
          Quick email
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_minmax(0,1fr)_auto] lg:items-end">
          <label className="block">
            <span className="mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              To
            </span>
            <input
              value={draftTo}
              onChange={(event) => setDraftTo(event.target.value)}
              className="ui-input h-10 w-full px-3 text-sm"
              placeholder="customer@email.com"
            />
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
            placeholder="Search sender, customer, subject, or message"
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
          {visibleRows.length} / {rows.length} messages
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
      ) : visibleRows.length === 0 ? (
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
        <div className="flex-1 overflow-hidden rounded-xl border border-app-border bg-app-surface">
          <ul className="divide-y divide-app-border">
            {visibleRows.map((row) => {
              const inbound = row.direction === "inbound";
              const timestamp = row.received_at || row.sent_at;
              return (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[9px] font-black uppercase ${
                            inbound
                              ? "border-app-accent/30 bg-app-accent/10 text-app-accent"
                              : "border-app-success/30 bg-app-success/10 text-app-success"
                          }`}
                        >
                          {inbound ? "Inbound" : "Sent"}
                        </span>
                        <span className="truncate text-sm font-black text-app-text">
                          {row.subject || "(No subject)"}
                        </span>
                        {row.customer_name ? (
                          <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                            Matched customer
                          </span>
                        ) : (
                          <span className="rounded border border-app-warning/30 bg-app-warning/10 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-warning">
                            Unmatched
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-semibold text-app-text-muted">
                        {inbound
                          ? `${row.from_name || row.from_email || "Unknown sender"}${row.from_email ? ` <${row.from_email}>` : ""}`
                          : `To ${toEmailList(row.to_emails) || "recipient"}`}
                      </p>
                      {row.customer_name ? (
                        <p className="mt-1 text-xs font-bold text-app-text">
                          {row.customer_name} {row.customer_code ? `- ${row.customer_code}` : ""}
                        </p>
                      ) : null}
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-app-text-muted">
                        {bodyPreview(row) || "No message preview."}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                      {timestamp ? (
                        <span className="text-[10px] font-bold text-app-text-muted">
                          {new Date(timestamp).toLocaleString()}
                        </span>
                      ) : null}
                      {row.customer_id && row.customer_name ? (
                        <button
                          type="button"
                          onClick={() =>
                            onOpenCustomerHub({
                              id: row.customer_id!,
                              customer_code: row.customer_code ?? "",
                              first_name: row.customer_name ?? "Customer",
                              last_name: "",
                              company_name: null,
                              email: row.from_email,
                              phone: null,
                            })
                          }
                          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
                        >
                          Open customer
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
