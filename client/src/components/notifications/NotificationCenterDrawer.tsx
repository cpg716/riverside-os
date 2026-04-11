import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
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
import { X as CloseIcon } from "lucide-react";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

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

function shortKindLabel(kind: string): string {
  const k = kind.replace(/_/g, " ").trim();
  return k.length > 28 ? `${k.slice(0, 26)}…` : k;
}

type Tab = "inbox" | "history";

// Unused UUID_RE removed

// parseStaffUuidList removed

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
      k === "messaging_unread_nudge"
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
    const bundle = parseNotificationBundle(r.deep_link);
    if (bundle != null) {
      void markRead(r.staff_notification_id);
      setExpandedSnId((prev) =>
        prev === r.staff_notification_id ? null : r.staff_notification_id,
      );
      return;
    }
    if (r.kind === "admin_broadcast") {
      void markRead(r.staff_notification_id);
      setExpandedSnId((prev) =>
        prev === r.staff_notification_id ? null : r.staff_notification_id,
      );
      return;
    }
    const dl = r.deep_link;
    if (isActionableNotificationDeepLink(dl)) {
      navigateFromItem(r, dl);
      return;
    }
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
      title="Notifications"
      subtitle="Tap a row to open in ROS, or expand for details"
      panelMaxClassName="max-w-lg"
      noPadding
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div className="flex gap-2">
          {(["inbox", "history"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-black uppercase tracking-wide ${
                tab === t
                  ? "bg-app-accent text-white"
                  : "border border-app-border bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {t === "inbox" ? "Inbox" : "History"}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-app-text-muted">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-app-text-muted">No items.</p>
          ) : (
            rows.map((r) => {
              const bundleItems = parseNotificationBundle(r.deep_link);
              const isBundle = bundleItems != null;
              const expanded = expandedSnId === r.staff_notification_id;
              const actionable = isActionableNotificationDeepLink(r.deep_link);
              return (
                <div
                  key={r.staff_notification_id}
                  className={`rounded-lg border border-app-border bg-app-surface-2 p-2 ${
                    r.read_at ? "opacity-90" : "ring-1 ring-app-accent/20"
                  }`}
                >
                  <button
                    type="button"
                    className="flex w-full items-start gap-1.5 text-left"
                    onClick={() => onRowActivate(r)}
                  >
                    <ChevronRight
                      className={`mt-0.5 h-4 w-4 shrink-0 text-app-text-muted transition-transform ${
                        expanded ? "rotate-90" : ""
                      }`}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                        {shortKindLabel(r.kind)}
                      </p>
                      <p className="truncate text-sm font-bold leading-tight text-app-text">
                        {r.title}
                      </p>
                      {!expanded && isBundle ? (
                        <p className="mt-0.5 text-[10px] text-app-text-muted">
                          {bundleItems.length} items — expand to open each
                        </p>
                      ) : null}
                      {!expanded &&
                      !isBundle &&
                      r.kind === "admin_broadcast" &&
                      r.body ? (
                        <p className="mt-0.5 text-[10px] text-app-text-muted">
                          Tap to read message
                        </p>
                      ) : null}
                      {!expanded &&
                      !isBundle &&
                      r.kind !== "admin_broadcast" &&
                      actionable ? (
                        <p className="mt-0.5 text-[10px] text-app-accent">
                          Open in app
                        </p>
                      ) : null}
                    </div>
                  </button>

                  {expanded ? (
                    <div className="mt-2 border-t border-app-border/50 pt-2 pl-5">
                      {isBundle && bundleItems ? (
                        <div className="max-h-52 overflow-y-auto rounded-md border border-app-border bg-app-surface">
                          <ul className="divide-y divide-app-border">
                            {bundleItems.map((it, idx) => (
                              <li key={`${it.title}-${idx}`}>
                                <button
                                  type="button"
                                  className="w-full px-2.5 py-1.5 text-left text-xs hover:bg-app-surface-2"
                                  onClick={() => {
                                    void navigateFromItem(r, it.deep_link);
                                  }}
                                >
                                  <span className="font-semibold text-app-text">
                                    {it.title}
                                  </span>
                                  {it.subtitle ? (
                                    <span className="mt-0.5 block text-[10px] text-app-text-muted">
                                      {it.subtitle}
                                    </span>
                                  ) : null}
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : (
                        <>
                          {r.body ? (
                            <p className="whitespace-pre-wrap text-xs text-app-text">
                              {r.body}
                            </p>
                          ) : (
                            <p className="text-xs text-app-text-muted">
                              No additional text.
                            </p>
                          )}
                          {r.kind === "admin_broadcast" ? (() => {
                            const sender = parseBroadcastSender(r.deep_link);
                            return sender ? (
                              <div className="mt-2 flex items-center gap-2">
                                <img
                                  src={staffAvatarUrl(sender.avatarKey)}
                                  alt=""
                                  className="h-7 w-7 shrink-0 rounded-full border border-app-border object-cover"
                                />
                                <p className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                                  From{" "}
                                  <span className="text-app-text">
                                    {sender.fullName}
                                  </span>
                                </p>
                              </div>
                            ) : null;
                          })() : null}
                        </>
                      )}
                    </div>
                  ) : null}

                  <div className="mt-1.5 flex flex-wrap gap-1 border-t border-app-border/40 pt-1.5">
                    {!r.read_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[9px]"
                        onClick={() => void markRead(r.staff_notification_id)}
                      >
                        Read
                      </button>
                    ) : null}
                    {!r.completed_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[9px]"
                        onClick={() =>
                          void markComplete(r.staff_notification_id)
                        }
                      >
                        Complete
                      </button>
                    ) : null}
                    {tab === "inbox" && !r.archived_at ? (
                      <button
                        type="button"
                        className="ui-btn-secondary px-2 py-0.5 text-[9px]"
                        onClick={() => void markArchive(r.staff_notification_id)}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {_canBroadcast ? (
          <div className="border-t border-app-border pt-4">
            <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Admin broadcast
            </p>
            <label className="mb-2 block text-[10px] font-bold uppercase text-app-text-muted">
              Title
              <input
                value={broadcastTitle}
                onChange={(e) => setBroadcastTitle(e.target.value)}
                className="ui-input mt-1 w-full text-sm"
              />
            </label>
            <label className="mb-2 block text-[10px] font-bold uppercase text-app-text-muted">
              Message
              <textarea
                value={broadcastBody}
                onChange={(e) => setBroadcastBody(e.target.value)}
                className="ui-input mt-1 min-h-[72px] w-full text-sm"
              />
            </label>
            <label className="mb-2 block text-[10px] font-bold uppercase text-app-text-muted">
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
                  <div className="flex flex-wrap gap-2 rounded-xl border border-app-border bg-app-surface-2 p-3 shadow-inner">
                    {selectedStaff.map((s) => (
                      <div
                        key={s.id}
                        className="flex items-center gap-1.5 rounded-lg bg-app-surface px-2 py-1.5 border border-app-border shadow-sm group animate-in zoom-in-95 duration-200"
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
                          className="ml-1 text-app-text-muted hover:text-red-500 transition-colors"
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
              className="ui-btn-primary w-full py-2 text-sm"
            >
              Send broadcast
            </button>
          </div>
        ) : null}
      </div>
    </DetailDrawer>
  );
}
