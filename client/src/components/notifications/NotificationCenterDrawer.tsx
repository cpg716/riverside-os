import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { 
  ArrowRight, 
  ChevronRight, 
  X as CloseIcon, 
  MessageSquare, 
  Star, 
  Package, 
  ClipboardList, 
  AlertTriangle, 
  Megaphone,
  History,
  Inbox,
  Send,
  Bell,
  CheckCircle2
} from "lucide-react";
import DetailDrawer from "../layout/DetailDrawer";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  type NotificationDeepLink,
  type NotificationRow,
} from "../../context/NotificationCenterContextLogic";
import { parseNotificationBundle } from "../../lib/notificationBundle";
import { isActionableNotificationDeepLink } from "../../lib/notificationDeepLink";
import { useToast } from "../ui/ToastProviderLogic";
import { staffAvatarUrl } from "../../lib/staffAvatars";
import StaffSearchInput, { StaffSearchResult } from "../ui/StaffSearchInput";

const baseUrl = getBaseUrl();

function parseBroadcastSender(
  deepLink: NotificationRow["deep_link"],
): { fullName: string; avatarKey: string } | null {
  const raw = deepLink as Record<string, unknown>;
  const bf = raw.broadcast_from;
  if (!bf || typeof bf !== "object" || Array.isArray(bf)) return null;
  const o = bf as Record<string, unknown>;
  const fullName =
    typeof o.full_name === "string" && o.full_name.trim()
      ? o.full_name.trim()
      : "";
  const avatarKey =
    typeof o.avatar_key === "string" && o.avatar_key.trim()
      ? o.avatar_key.trim()
      : "ros_default";
  if (!fullName) return null;
  return { fullName, avatarKey };
}

function formatKindLabel(kind: string): string {
  if (kind === "admin_broadcast") return "Team Announcement";
  const k = kind
    .replace(/_/g, " ")
    .replace(/\bsms\b/gi, "SMS")
    .replace(/\bemail\b/gi, "Email")
    .replace(/\bqbo\b/gi, "QBO")
    .trim();
  return k
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function KindIcon({ kind, size = 16, className = "" }: { kind: string; size?: number; className?: string }) {
  const k = kind.toLowerCase();
  if (k.startsWith("podium_")) return <MessageSquare size={size} className={className} />;
  if (k.startsWith("review_")) return <Star size={size} className={className} />;
  if (k.includes("inventory") || k.includes("stock") || k.includes("po_")) return <Package size={size} className={className} />;
  if (k.includes("order") || k.includes("task") || k.includes("alteration")) return <ClipboardList size={size} className={className} />;
  if (k.includes("failed") || k.includes("error") || k.includes("discrepancy")) return <AlertTriangle size={size} className={className} />;
  if (k === "admin_broadcast") return <Megaphone size={size} className={className} />;
  return <Bell size={size} className={className} />;
}

function bundleLikeNotifications(rows: NotificationRow[]): NotificationRow[] {
  const unhandled: NotificationRow[] = [];
  const groups: Record<string, NotificationRow[]> = {};

  for (const r of rows) {
    // Only bundle unread, non-broadcast notifications that aren't already bundles
    const isSyntheticBundle = r.deep_link.type === "notification_bundle";
    if (r.kind === "admin_broadcast" || isSyntheticBundle) {
      unhandled.push(r);
      continue;
    }

    const key = `${r.kind}:${r.title}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const result: NotificationRow[] = [...unhandled];
  for (const key in groups) {
    const list = groups[key];
    if (list.length === 1) {
      result.push(list[0]);
    } else {
      const first = list[0];
      const items = list.map((it) => ({
        title: it.title,
        subtitle: it.body,
        deep_link: it.deep_link,
      }));

      result.push({
        ...first,
        title: `${first.title} (${list.length} items)`,
        body: `You have ${list.length} similar notifications.`,
          deep_link: {
            type: "notification_bundle",
            items,
          } as NotificationDeepLink,
        });
    }
  }

  return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

type Tab = "inbox" | "history" | "broadcast";

export default function NotificationCenterDrawer({
  isOpen,
  onClose,
  apiAuth,
  onNavigate,
  onCountsChanged,
}: {
  isOpen: boolean;
  onClose: () => void;
  apiAuth: () => HeadersInit;
  onNavigate: (link: NotificationDeepLink) => void;
  onCountsChanged: () => void;
}) {
  const { toast } = useToast();
  const { hasPermission } = useBackofficeAuth();
  const [tab, setTab] = useState<Tab>("inbox");
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [audienceMode, setAudienceMode] = useState<
    "all_staff" | "roles_admin" | "roles_sales" | "staff_custom"
  >("all_staff");
  // Removed unused customStaffIdsRaw
  const [selectedStaff, setSelectedStaff] = useState<StaffSearchResult[]>([]);
  const [sending, setSending] = useState(false);
  const [expandedSnId, setExpandedSnId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q =
        tab === "history" ? "?include_archived=true&limit=120" : "?limit=120";
      const res = await fetch(`${baseUrl}/api/notifications${q}`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as NotificationRow[]);
    } catch {
      toast("Could not load notifications.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, tab, toast]);

  useEffect(() => {
    if (!isOpen) return;
    void load();
  }, [isOpen, load]);

  useEffect(() => {
    if (!isOpen) setExpandedSnId(null);
  }, [isOpen]);

  const markRead = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/notifications/${id}/read`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) return;
      onCountsChanged();
      void load();
    } catch {
      /* ignore */
    }
  };

  const markComplete = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/notifications/${id}/complete`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) return;
      onCountsChanged();
      void load();
    } catch {
      /* ignore */
    }
  };

  const markArchive = async (id: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/notifications/${id}/archive`, {
        method: "POST",
        headers: apiAuth(),
      });
      if (!res.ok) return;
      onCountsChanged();
      void load();
    } catch {
      /* ignore */
    }
  };

  const sendBroadcast = async () => {
    const title = broadcastTitle.trim();
    if (!title) {
      toast("Enter a broadcast title.", "error");
      return;
    }
    setSending(true);
    try {
      let audience: {
        mode: string;
        roles: string[];
        staff_ids: string[];
      };
      if (audienceMode === "all_staff") {
        audience = { mode: "all_staff", roles: [], staff_ids: [] };
      } else if (audienceMode === "roles_admin") {
        audience = { mode: "roles", roles: ["admin"], staff_ids: [] };
      } else if (audienceMode === "roles_sales") {
        audience = {
          mode: "roles",
          roles: ["salesperson", "sales_support"],
          staff_ids: [],
        };
      } else {
        const staff_ids = selectedStaff.map((s) => s.id);
        if (staff_ids.length === 0) {
          toast("Select at least one staff member.", "error");
          setSending(false);
          return;
        }
        audience = { mode: "staff_ids", roles: [], staff_ids };
      }
      const res = await fetch(`${baseUrl}/api/notifications/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          title,
          body: broadcastBody.trim(),
          audience,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Broadcast failed", "error");
        return;
      }
      toast("Broadcast sent", "success");
      setBroadcastTitle("");
      setBroadcastBody("");
      setSelectedStaff([]);
      onCountsChanged();
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setSending(false);
    }
  };

  const markSharedReadAllIfNeeded = async (r: NotificationRow) => {
    const k = r.kind.toLowerCase();
    if (
      k.startsWith("podium_") ||
      k.startsWith("review_") ||
      k === "messaging_unread_nudge" ||
      k.includes("morning_") ||
      k === "staff_bug_report" ||
      k === "special_order_ready_to_stage" ||
      k === "physical_inventory_count_complete" ||
      k === "register_cash_discrepancy" ||
      k === "catalog_import_rows_skipped" ||
      k === "after_hours_access_digest" ||
      k === "gift_card_expiring_soon" ||
      k.includes("purchase_order") ||
      k.includes("po_") ||
      k.includes("layaway")
    ) {
      try {
        await fetch(
          `${baseUrl}/api/notifications/by-notification/${encodeURIComponent(r.notification_id)}/read-all`,
          { method: "POST", headers: apiAuth() },
        );
      } catch {
        /* ignore */
      }
    }
  };

  const navigateFromItem = async (
    r: NotificationRow,
    link: NotificationDeepLink,
  ) => {
    await markSharedReadAllIfNeeded(r);
    void markRead(r.staff_notification_id);
    onNavigate(link);
    onClose();
  };

  const onRowActivate = (r: NotificationRow) => {
    void markRead(r.staff_notification_id);
    setExpandedSnId((prev) =>
      prev === r.staff_notification_id ? null : r.staff_notification_id,
    );
  };

  const _canBroadcast = hasPermission("notifications.broadcast");

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title="Communications & Alerts"
      subtitle="Notifications, bundles, and team broadcasts"
      panelMaxClassName="max-w-lg"
      noPadding
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Modern Tab Matrix */}
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-app-border bg-app-surface-2 px-6">
          {(["inbox", "history", "broadcast"] as const).map((t) => {
            if (t === "broadcast" && !_canBroadcast) return null;
            const Icon = t === "inbox" ? Inbox : t === "history" ? History : Send;
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex h-full items-center gap-2 border-b-2 px-3 transition-all ${
                  active
                    ? "border-app-accent text-app-accent"
                    : "border-transparent text-app-text-muted hover:text-app-text"
                }`}
              >
                <Icon size={14} className={active ? "animate-in fade-in zoom-in-75 duration-300" : ""} />
                <span className="text-[10px] font-black uppercase tracking-widest">
                  {t === "inbox" ? "Inbox" : t === "history" ? "History" : "Broadcast"}
                </span>
                {t === "inbox" && rows.filter(r => !r.read_at).length > 0 && (
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-app-accent text-[8px] font-black text-white">
                    {rows.filter(r => !r.read_at).length}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-6 py-5">

        {tab === "broadcast" ? (
          <div className="flex-1 overflow-y-auto pr-1">
            <div className="rounded-xl border border-emerald-600/20 bg-emerald-600/5 p-4">
              <p className="mb-4 text-[10px] font-black uppercase tracking-widest text-emerald-700">
                Send Team broadcast
              </p>
              <label className="mb-3 block text-[10px] font-bold uppercase text-app-text-muted">
                Title
                <input
                  value={broadcastTitle}
                  onChange={(e) => setBroadcastTitle(e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  placeholder="Urgent stock update..."
                />
              </label>
              <label className="mb-3 block text-[10px] font-bold uppercase text-app-text-muted">
                Message
                <textarea
                  value={broadcastBody}
                  onChange={(e) => setBroadcastBody(e.target.value)}
                  className="ui-input mt-1 min-h-[100px] w-full text-sm"
                  placeholder="Team, please note that..."
                />
              </label>
              <label className="mb-4 block text-[10px] font-bold uppercase text-app-text-muted">
                Audience
                <select
                  value={audienceMode}
                  onChange={(e) =>
                    setAudienceMode(
                      e.target.value as
                        | "all_staff"
                        | "roles_admin"
                        | "roles_sales"
                        | "staff_custom",
                    )
                  }
                  className="ui-input mt-1 w-full text-sm"
                >
                  <option value="all_staff">All active staff</option>
                  <option value="roles_admin">Admins only</option>
                  <option value="roles_sales">Salesperson + sales support</option>
                  <option value="staff_custom">Specific staff members</option>
                </select>
              </label>

              {audienceMode === "staff_custom" ? (
                <div className="mb-4 space-y-3">
                  <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                    Add staff member
                    <StaffSearchInput
                      className="mt-1"
                      excludeIds={selectedStaff.map((s) => s.id)}
                      onSelect={(s) => setSelectedStaff((prev) => [...prev, s])}
                    />
                  </label>

                  {selectedStaff.length > 0 && (
                    <div className="flex flex-wrap gap-2 rounded-xl border border-app-border bg-app-surface/50 p-3 shadow-inner">
                      {selectedStaff.map((s) => (
                        <div
                          key={s.id}
                          className="group flex animate-in zoom-in-95 items-center gap-1.5 rounded-lg border border-app-border bg-app-surface px-2 py-1.5 shadow-sm duration-200"
                        >
                          <div className="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-app-border bg-app-surface-2">
                            <img
                              src={staffAvatarUrl(s.avatar_key)}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <span className="text-[10px] font-black text-app-text">
                            {s.full_name}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedStaff((prev) =>
                                prev.filter((p) => p.id !== s.id),
                              )
                            }
                            className="ml-1 text-app-text-muted transition-colors hover:text-red-500"
                          >
                            <CloseIcon size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              <button
                type="button"
                disabled={sending}
                onClick={() => void sendBroadcast()}
                className="ui-btn-primary w-full bg-emerald-600 py-3 text-sm font-black uppercase tracking-widest hover:bg-emerald-700"
              >
                {sending ? "Sending..." : "Transmit Broadcast"}
              </button>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {loading ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Synchronizing alerts...</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-3 text-app-text-muted transition-all animate-in fade-in zoom-in-95 duration-500">
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-app-surface-2">
                  <CheckCircle2 size={32} strokeWidth={1.5} className="text-app-success/40" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-app-text">Inbox clear.</p>
                  <p className="text-[10px] font-black uppercase tracking-widest opacity-50">Zero pending actions</p>
                </div>
              </div>
            ) : (
              bundleLikeNotifications(rows).map((r) => {
                const bundleItems = parseNotificationBundle(r.deep_link);
                const isBundle = bundleItems != null;
                const expanded = expandedSnId === r.staff_notification_id;
                const actionable = isActionableNotificationDeepLink(r.deep_link);
                const isAnnouncement = r.kind === "admin_broadcast";

                return (
                  <div
                    key={r.staff_notification_id}
                    className={`overflow-hidden rounded-xl border transition-all duration-200 ${
                      expanded
                        ? "border-app-accent/40 bg-app-surface ring-4 ring-app-accent/5"
                        : "border-app-border bg-app-surface-2 hover:border-app-border-hover hover:bg-app-surface-3"
                    } ${!r.read_at ? "shadow-md" : "opacity-80"}`}
                  >
                    <button
                      type="button"
                      className="group flex w-full items-start gap-3 p-3 text-left"
                      onClick={() => onRowActivate(r)}
                    >
                      <div
                        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border transition-all duration-300 ${
                          expanded
                            ? "border-app-accent bg-app-accent text-white shadow-lg shadow-app-accent/20"
                            : "border-app-border bg-app-surface text-app-text-muted group-hover:border-app-accent group-hover:bg-app-accent/5 group-hover:text-app-accent"
                        }`}
                      >
                        {expanded ? (
                          <ChevronRight className="h-4 w-4 rotate-90" />
                        ) : (
                          <KindIcon kind={r.kind} size={16} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p
                            className={`text-[9px] font-black uppercase tracking-[0.12em] ${
                              isAnnouncement ? "text-emerald-600" : "text-app-text-muted"
                            }`}
                          >
                            {formatKindLabel(r.kind)}
                          </p>
                          {!r.read_at && (
                            <span className="h-1.5 w-1.5 rounded-full bg-app-accent ring-4 ring-app-accent/10" />
                          )}
                        </div>
                        <p
                          className={`mt-0.5 truncate text-sm font-bold leading-tight ${
                            expanded ? "text-app-text" : "text-app-text"
                          }`}
                        >
                          {r.title}
                        </p>
                        {!expanded && (
                          <div className="mt-1 flex items-center gap-2 text-[10px]">
                            {isBundle ? (
                              <span className="font-bold text-app-accent">
                                {bundleItems.length} items bundled
                              </span>
                            ) : (
                              <div className="flex items-center gap-1 text-app-text-muted">
                                <span>View details</span>
                                <ArrowRight size={10} className="transition-transform group-hover:translate-x-0.5" />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </button>

                    {expanded && (
                      <div className="bg-app-surface-2/50 px-4 pb-4">
                        <div className="rounded-xl border border-app-border bg-app-surface p-3 shadow-inner mt-1">
                          {isBundle && bundleItems ? (
                            <div className="space-y-1">
                              <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                                Bundled items
                              </p>
                              <div className="grid gap-1">
                                {bundleItems.map((it, idx) => (
                                  <button
                                    key={`${it.title}-${idx}`}
                                    type="button"
                                    className="group flex w-full flex-col rounded-lg border border-app-border bg-app-surface-2 p-2.5 transition-all hover:border-app-accent/50 hover:bg-app-surface-3 hover:shadow-sm"
                                    onClick={() => {
                                      void navigateFromItem(r, it.deep_link);
                                    }}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <span className="truncate text-[11px] font-black text-app-text group-hover:text-app-accent">
                                        {it.title}
                                      </span>
                                      <ArrowRight
                                        size={12}
                                        className="shrink-0 text-app-text-muted group-hover:text-app-accent"
                                      />
                                    </div>
                                    {it.subtitle && (
                                      <span className="mt-1 text-[10px] text-app-text-muted">
                                        {it.subtitle}
                                      </span>
                                    )}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {r.body ? (
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-app-text">
                                  {r.body}
                                </p>
                              ) : (
                                <p className="text-xs italic text-app-text-muted">
                                  No additional details provided.
                                </p>
                              )}
                              {isAnnouncement && (() => {
                                const sender = parseBroadcastSender(r.deep_link);
                                return sender ? (
                                  <div className="flex items-center gap-3 rounded-lg bg-emerald-600/5 p-2 ring-1 ring-emerald-600/10">
                                    <img
                                      src={staffAvatarUrl(sender.avatarKey)}
                                      alt={sender.fullName}
                                      className="h-8 w-8 shrink-0 rounded-full border-2 border-white shadow-sm object-cover"
                                    />
                                    <div>
                                      <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700">
                                        Sender
                                      </p>
                                      <p className="text-xs font-bold text-app-text">
                                        {sender.fullName}
                                      </p>
                                    </div>
                                  </div>
                                ) : null;
                              })()}
                              {actionable && !isBundle && (
                                <button
                                  type="button"
                                  className="ui-btn-primary w-full py-2 text-xs font-black uppercase tracking-widest"
                                  onClick={() => navigateFromItem(r, r.deep_link)}
                                >
                                  Go to section
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex items-center gap-1 border-t border-app-border/40 bg-app-surface/30 p-1.5 px-3">
                      {!r.read_at && (
                        <button
                          type="button"
                          className="h-6 px-3 text-[10px] font-bold text-app-accent hover:bg-app-accent/5 rounded-md transition-colors"
                          onClick={() => void markRead(r.staff_notification_id)}
                        >
                          Mark Read
                        </button>
                      )}
                      {!r.completed_at && (
                        <button
                          type="button"
                          className="h-6 px-3 text-[10px] font-bold text-emerald-600 hover:bg-emerald-600/5 rounded-md transition-colors"
                          onClick={() => void markComplete(r.staff_notification_id)}
                        >
                          Task Done
                        </button>
                      )}
                      {tab === "inbox" && !r.archived_at && (
                        <button
                          type="button"
                          className="ml-auto h-6 px-3 text-[10px] font-bold text-app-text-muted hover:bg-app-surface-3 rounded-md transition-colors"
                          onClick={() => void markArchive(r.staff_notification_id)}
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                );
              }))}
            </div>
          )}
        </div>
      </div>
    </DetailDrawer>
  );
}
