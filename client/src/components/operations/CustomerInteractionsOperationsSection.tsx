import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Mail,
  MessageSquareText,
  RefreshCw,
  Search,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";
import PodiumMessagingInboxSection from "../customers/PodiumMessagingInboxSection";
import MailboxOperationsSection from "./MailboxOperationsSection";
import NotificationQueueOperationsSection from "./NotificationQueueOperationsSection";

const baseUrl = getBaseUrl();

type WorkspaceMode = "activity" | "podium" | "mailbox" | "automation";
type ActivityFilter = "all" | "sms" | "email" | "automated" | "attention";

type CustomerInteractionRow = {
  interaction_key: string;
  source_id: string;
  source: "notification" | "podium" | "mailbox";
  channel: string;
  direction: string;
  occurred_at: string;
  customer_id: string | null;
  customer_code: string | null;
  customer_name: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  contact: string | null;
  title: string;
  preview: string | null;
  actor: string | null;
  status: string;
  needs_attention: boolean;
  unread: boolean;
  conversation_id: string | null;
  thread_key: string | null;
};

type CustomerInteractionPage = {
  rows: CustomerInteractionRow[];
  has_more: boolean;
  next_before_at: string | null;
  next_before_key: string | null;
  manual_channels_available: boolean;
};

function interactionTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function sourceLabel(source: CustomerInteractionRow["source"]): string {
  if (source === "podium") return "Podium";
  if (source === "mailbox") return "Store email";
  return "Automation queue";
}

function directionLabel(direction: string): string {
  if (direction === "inbound") return "Customer to store";
  if (direction === "outbound") return "Staff to customer";
  return "Automated";
}

function channelLabel(channel: string): string {
  if (channel === "sms") return "SMS";
  if (channel === "email") return "Email";
  if (channel === "both") return "SMS + Email";
  return "Automation";
}

function statusTone(row: CustomerInteractionRow): string {
  if (row.needs_attention || row.status === "failed") {
    return "border-app-danger/25 bg-app-danger/10 text-app-danger";
  }
  if (row.unread) {
    return "border-app-accent/25 bg-app-accent/10 text-app-accent";
  }
  return "border-app-success/20 bg-app-success/10 text-app-success";
}

export default function CustomerInteractionsOperationsSection({
  surface = "backoffice",
  onOpenCustomerHub,
  onOpenCustomerProfile = onOpenCustomerHub,
}: {
  surface?: "backoffice" | "pos";
  onOpenCustomerHub: (customer: Customer) => void;
  onOpenCustomerProfile?: (customer: Customer) => void;
}) {
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [mode, setMode] = useState<WorkspaceMode>("activity");
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<CustomerInteractionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [manualChannelsAvailable, setManualChannelsAvailable] = useState<
    boolean | null
  >(null);
  const [podiumFocusId, setPodiumFocusId] = useState<string | null>(null);
  const [mailboxFocusId, setMailboxFocusId] = useState<string | null>(null);
  const [notificationFocusId, setNotificationFocusId] = useState<string | null>(
    null,
  );
  const requestRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<{ beforeAt: string; beforeKey: string } | null>(null);

  const canViewManualChannels =
    permissionsLoaded && hasPermission("customers.hub_view");

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const loadActivity = useCallback(
    async (append = false) => {
      if (mode !== "activity") return;
      if (!append) {
        requestRef.current?.abort();
      }
      const controller = new AbortController();
      requestRef.current = controller;
      if (append) setLoadingMore(true);
      else {
        cursorRef.current = null;
        setLoading(true);
      }
      setLoadError(null);
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (filter === "sms" || filter === "email") {
          params.set("channel", filter);
        } else if (filter === "automated") {
          params.set("direction", "automated");
        } else if (filter === "attention") {
          params.set("needs_attention", "true");
        }
        if (search) params.set("search", search);
        const cursor = append ? cursorRef.current : null;
        if (cursor) {
          params.set("before_at", cursor.beforeAt);
          params.set("before_key", cursor.beforeKey);
        }
        const response = await fetch(
          `${baseUrl}/api/customer-interactions?${params.toString()}`,
          {
            headers: apiAuth(),
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            payload?.error ?? "Customer interactions could not refresh.",
          );
        }
        const page = (await response.json()) as CustomerInteractionPage;
        setRows((current) =>
          append ? [...current, ...(page.rows ?? [])] : (page.rows ?? []),
        );
        setHasMore(Boolean(page.has_more));
        cursorRef.current =
          page.next_before_at && page.next_before_key
            ? {
                beforeAt: page.next_before_at,
                beforeKey: page.next_before_key,
              }
            : null;
        setManualChannelsAvailable(page.manual_channels_available);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "Customer interactions could not refresh.",
        );
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoading(false);
          setLoadingMore(false);
        }
      }
    }, [apiAuth, filter, mode, search]);

  useEffect(() => {
    if (mode !== "activity") return;
    void loadActivity(false);
    return () => requestRef.current?.abort();
  }, [loadActivity, mode]);

  const stats = useMemo(
    () => ({
      loaded: rows.length,
      sms: rows.filter((row) => row.channel === "sms" || row.channel === "both")
        .length,
      email: rows.filter(
        (row) => row.channel === "email" || row.channel === "both",
      ).length,
      attention: rows.filter((row) => row.needs_attention).length,
    }),
    [rows],
  );

  const openCustomer = (row: CustomerInteractionRow) => {
    if (!row.customer_id) return;
    onOpenCustomerHub({
      id: row.customer_id,
      customer_code: row.customer_code ?? "",
      first_name: row.customer_first_name ?? row.customer_name ?? "Customer",
      last_name: row.customer_last_name ?? "",
      company_name: null,
      email: row.customer_email,
      phone: row.customer_phone,
    });
  };

  const continueInteraction = (row: CustomerInteractionRow) => {
    if (row.source === "podium") {
      setPodiumFocusId(row.conversation_id);
      setMode("podium");
    } else if (row.source === "mailbox") {
      setMailboxFocusId(row.source_id);
      setMode("mailbox");
    } else {
      setNotificationFocusId(row.source_id);
      setMode("automation");
    }
  };

  const workspaceTabs: {
    id: WorkspaceMode;
    label: string;
    disabled?: boolean;
  }[] = [
    { id: "activity", label: "All activity" },
    { id: "podium", label: "Text messages", disabled: !canViewManualChannels },
    { id: "mailbox", label: "Email", disabled: !canViewManualChannels },
    { id: "automation", label: "Automated queue" },
  ];

  const activityFilters: { id: ActivityFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "sms", label: "SMS" },
    { id: "email", label: "Email" },
    { id: "automated", label: "Automated" },
    { id: "attention", label: "Needs attention" },
  ];

  return (
    <section className="ui-page flex min-h-0 flex-1 flex-col bg-transparent p-0">
      <div className="border-b border-app-border bg-app-surface/80 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
              <MessageSquareText size={20} aria-hidden />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Operations
              </p>
              <h2 className="text-xl font-black tracking-tight text-app-text">
                Customer Interactions
              </h2>
              <p className="mt-1 max-w-3xl text-sm font-semibold leading-relaxed text-app-text-muted">
                Review current customer SMS and email activity, then continue the
                conversation in its authoritative channel workspace.
              </p>
              {surface === "pos" ? (
                <p className="mt-1 text-xs font-black uppercase tracking-widest text-app-accent">
                  POS staff workspace
                </p>
              ) : null}
            </div>
          </div>
          {mode === "activity" ? (
            <button
              type="button"
              onClick={() => void loadActivity(false)}
              disabled={loading}
              className="ui-btn-secondary min-h-11 gap-2 px-4 disabled:opacity-50"
            >
              <RefreshCw
                size={15}
                className={loading ? "animate-spin" : ""}
                aria-hidden
              />
              Refresh
            </button>
          ) : null}
        </div>

        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Customer interaction workspaces">
          {workspaceTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={mode === tab.id}
              disabled={tab.disabled}
              title={
                tab.disabled
                  ? "Customer messaging access is required for this channel."
                  : undefined
              }
              onClick={() => setMode(tab.id)}
              className={`rounded-full border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                mode === tab.id
                  ? "border-app-accent/30 bg-app-accent/10 text-app-accent"
                  : "border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface-3 hover:text-app-text"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "podium" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <PodiumMessagingInboxSection
            onOpenCustomerHub={onOpenCustomerHub}
            initialFocusId={podiumFocusId}
            onInitialFocusConsumed={() => setPodiumFocusId(null)}
          />
        </div>
      ) : mode === "mailbox" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <MailboxOperationsSection
            onOpenCustomerHub={onOpenCustomerHub}
            initialMessageId={mailboxFocusId}
            onInitialMessageConsumed={() => setMailboxFocusId(null)}
          />
        </div>
      ) : mode === "automation" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <NotificationQueueOperationsSection
            surface={surface}
            embedded
            initialFocusId={notificationFocusId}
            onOpenCustomerHub={onOpenCustomerProfile}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-3 sm:p-6">
          {manualChannelsAvailable === false ? (
            <div className="mb-4 flex items-start gap-3 rounded-2xl border border-app-warning/25 bg-app-warning/10 px-4 py-3 text-sm font-semibold text-app-text">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-app-warning" aria-hidden />
              <p>
                Automated activity is available. Customer messaging access is
                required to include Podium texts and store email.
              </p>
            </div>
          ) : null}

          <div className="grid shrink-0 grid-cols-2 gap-3 xl:grid-cols-4">
            {[
              { label: "Loaded activity", value: stats.loaded, icon: Inbox },
              { label: "SMS", value: stats.sms, icon: MessageSquareText },
              { label: "Email", value: stats.email, icon: Mail },
              {
                label: "Needs attention",
                value: stats.attention,
                icon: AlertTriangle,
              },
            ].map((stat) => (
              <div key={stat.label} className="ui-card flex items-center gap-3 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-app-border bg-app-surface-2 text-app-accent">
                  <stat.icon size={18} aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    {stat.label}
                  </p>
                  <p className="text-xl font-black tabular-nums text-app-text">
                    {stat.value.toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="ui-card mt-4 flex min-h-[28rem] flex-col overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-app-border bg-app-surface-2 p-4">
              <div className="relative min-w-0 flex-1">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
                  aria-hidden
                />
                <input
                  value={searchDraft}
                  onChange={(event) => setSearchDraft(event.target.value)}
                  placeholder="Search customer, contact, subject, message, or staff…"
                  className="ui-input w-full pl-10 text-sm font-bold"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                {activityFilters.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={filter === item.id}
                    onClick={() => setFilter(item.id)}
                    className={`rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest ${
                      filter === item.id
                        ? "border-app-accent/25 bg-app-accent/10 text-app-accent"
                        : "border-app-border bg-app-surface text-app-text-muted"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {loading ? (
              <div className="flex flex-1 flex-col items-center justify-center p-12 text-app-text-muted">
                <RefreshCw size={34} className="mb-3 animate-spin opacity-40" aria-hidden />
                <p className="text-xs font-black uppercase tracking-widest">
                  Loading customer interactions…
                </p>
              </div>
            ) : loadError ? (
              <div className="flex flex-1 flex-col items-center justify-center p-12 text-center">
                <AlertTriangle size={40} className="mb-3 text-app-danger" aria-hidden />
                <p className="font-black text-app-text">Interactions could not load</p>
                <p className="mt-1 max-w-lg text-sm font-semibold text-app-text-muted">
                  {loadError}
                </p>
                <button
                  type="button"
                  onClick={() => void loadActivity(false)}
                  className="ui-btn-secondary mt-4 px-4 py-2"
                >
                  Try again
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center p-12 text-center text-app-text-muted">
                <MessageSquareText size={42} className="mb-3 opacity-25" aria-hidden />
                <p className="text-sm font-black uppercase tracking-widest">
                  No matching interactions
                </p>
                <p className="mt-2 text-xs font-semibold">
                  Change the filter or search, then refresh.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-app-border bg-app-surface">
                {rows.map((row) => (
                  <article
                    key={row.interaction_key}
                    className="grid gap-3 p-4 transition-colors hover:bg-app-surface-2/60 lg:grid-cols-[minmax(12rem,0.8fr)_minmax(18rem,1.5fr)_auto] lg:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                            row.unread ? "bg-app-accent" : "bg-app-success"
                          }`}
                          aria-hidden
                        />
                        <p className="truncate font-black text-app-text">
                          {row.customer_name ?? row.contact ?? "Unmatched customer"}
                        </p>
                      </div>
                      <p className="mt-1 truncate text-xs font-semibold text-app-text-muted">
                        {row.contact ?? row.customer_code ?? "No contact linked"}
                      </p>
                      <p className="mt-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                        {interactionTime(row.occurred_at)}
                      </p>
                    </div>

                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          {channelLabel(row.channel)}
                        </span>
                        <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          {directionLabel(row.direction)}
                        </span>
                        <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          {sourceLabel(row.source)}
                        </span>
                      </div>
                      <p className="mt-2 font-black text-app-text">{row.title}</p>
                      <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm font-semibold leading-relaxed text-app-text-muted">
                        {row.preview ?? "No message preview was stored."}
                      </p>
                      {row.actor ? (
                        <p className="mt-1 text-[10px] font-bold text-app-text-muted">
                          Staff: {row.actor}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-wider ${statusTone(row)}`}
                      >
                        {row.needs_attention ? (
                          <AlertTriangle size={11} aria-hidden />
                        ) : (
                          <CheckCircle2 size={11} aria-hidden />
                        )}
                        {row.status}
                      </span>
                      {row.customer_id ? (
                        <button
                          type="button"
                          onClick={() => openCustomer(row)}
                          className="ui-btn-secondary inline-flex items-center gap-1.5 px-3 py-2 text-[9px] font-black uppercase tracking-widest"
                        >
                          <UserRound size={13} aria-hidden />
                          Customer
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={
                          row.source !== "notification" && !canViewManualChannels
                        }
                        onClick={() => continueInteraction(row)}
                        className="ui-btn-primary px-3 py-2 text-[9px] font-black uppercase tracking-widest disabled:opacity-45"
                      >
                        {row.source === "notification" ? "Review queue" : "Open thread"}
                      </button>
                    </div>
                  </article>
                ))}
                {hasMore ? (
                  <div className="flex justify-center border-t border-app-border p-4">
                    <button
                      type="button"
                      disabled={loadingMore}
                      onClick={() => void loadActivity(true)}
                      className="ui-btn-secondary px-5 py-2 disabled:opacity-50"
                    >
                      {loadingMore ? "Loading…" : "Load earlier activity"}
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
