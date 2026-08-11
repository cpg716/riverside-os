import { getBaseUrl } from "../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBackofficeAuth } from "./BackofficeAuthContextLogic";
import {
  getPosRegisterAuth,
  mergedPosStaffHeaders,
} from "../lib/posRegisterAuth";
import NotificationCenterDrawer from "../components/notifications/NotificationCenterDrawer";
import { useToast } from "../components/ui/ToastProviderLogic";
import {
  inboundMessageNotificationFingerprint,
  inboundMessagePopupTitle,
} from "../lib/inboundMessageNotifications";
import {
  NotificationCenterContext,
  type NotificationCenterContextValue,
  type NotificationDeepLink,
  type NotificationRow,
} from "./NotificationCenterContextLogic";

const baseUrl = getBaseUrl();

export function NotificationCenterProvider({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate: (link: NotificationDeepLink) => void;
}) {
  const { backofficeHeaders, hasPermission, permissionsLoaded, staffCode } =
    useBackofficeAuth();
  const { toast } = useToast();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const canView = permissionsLoaded && hasPermission("notifications.view");
  const hasPos = Boolean(getPosRegisterAuth()?.sessionId);
  const canReachApi = staffCode.trim().length > 0 || hasPos;

  const [unread, setUnread] = useState(0);
  const [podiumInboxUnread, setPodiumInboxUnread] = useState(0);
  const [mailboxUnread, setMailboxUnread] = useState(0);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const unreadRefreshInFlightRef = useRef(false);
  const popupBaselineReadyRef = useRef(false);
  const inboundFingerprintsRef = useRef(new Map<string, string>());

  const refreshUnread = useCallback(async () => {
    if (!canView || !canReachApi) {
      setUnread(0);
      setPodiumInboxUnread(0);
      setMailboxUnread(0);
      setNotifications([]);
      popupBaselineReadyRef.current = false;
      inboundFingerprintsRef.current.clear();
      return;
    }
    if (unreadRefreshInFlightRef.current) return;
    unreadRefreshInFlightRef.current = true;
    try {
      const [countRes, previewRes] = await Promise.all([
        fetch(`${baseUrl}/api/notifications/unread-count`, { headers: apiAuth() }),
        fetch(`${baseUrl}/api/notifications?limit=50`, { headers: apiAuth() }),
      ]);
      if (countRes.ok) {
        const data = (await countRes.json()) as {
          unread?: number;
          podium_inbox_unread?: number;
          mailbox_unread?: number;
        };
        setUnread(typeof data.unread === "number" ? data.unread : 0);
        setPodiumInboxUnread(
          typeof data.podium_inbox_unread === "number" ? data.podium_inbox_unread : 0,
        );
        setMailboxUnread(
          typeof data.mailbox_unread === "number" ? data.mailbox_unread : 0,
        );
      }
      if (previewRes.ok) {
        const preview = (await previewRes.json()) as NotificationRow[];
        const nextRows = Array.isArray(preview) ? preview : [];
        const now = Date.now();
        const popupRows = nextRows.filter((row) => {
          const popupTitle = inboundMessagePopupTitle(row);
          if (!popupTitle || row.read_at) return false;
          const fingerprint = inboundMessageNotificationFingerprint(row);
          const previous = inboundFingerprintsRef.current.get(row.notification_id);
          inboundFingerprintsRef.current.set(row.notification_id, fingerprint);
          if (!popupBaselineReadyRef.current || previous === fingerprint) return false;
          if (previous) return true;
          const createdAt = new Date(row.created_at).getTime();
          return Number.isFinite(createdAt) && now - createdAt <= 2 * 60_000;
        });

        if (popupBaselineReadyRef.current) {
          if (popupRows.length === 1) {
            const popupTitle = inboundMessagePopupTitle(popupRows[0]);
            if (popupTitle) toast(popupTitle, "info");
          } else if (popupRows.length > 1) {
            toast(
              `${popupRows.length} new customer messages. Open Notifications to review.`,
              "info",
            );
          }
        }
        popupBaselineReadyRef.current = true;
        setNotifications(nextRows.slice(0, 8));
      }
    } catch {
      /* ignore */
    } finally {
      unreadRefreshInFlightRef.current = false;
    }
  }, [apiAuth, canReachApi, canView, toast]);

  useEffect(() => {
    refreshUnread().catch(() => {});
  }, [refreshUnread]);

  useEffect(() => {
    if (!canView || !canReachApi) return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshUnread();
      }
    }, 30_000);
    return () => window.clearInterval(t);
  }, [canReachApi, canView, refreshUnread]);

  useEffect(() => {
    if (!canView || !canReachApi) return;

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshUnread();
      }
    };

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [canReachApi, canView, refreshUnread]);

  const value = useMemo<NotificationCenterContextValue>(
    () => ({
      unread,
      notifications,
      podiumInboxUnread,
      mailboxUnread,
      refreshUnread,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      canView: canView && canReachApi,
    }),
    [
      unread,
      notifications,
      podiumInboxUnread,
      mailboxUnread,
      refreshUnread,
      drawerOpen,
      canView,
      canReachApi,
    ],
  );

  return (
    <NotificationCenterContext.Provider value={value}>
      {children}
      {canView && canReachApi ? (
        <NotificationCenterDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          apiAuth={apiAuth}
          onNavigate={onNavigate}
          onCountsChanged={() => void refreshUnread()}
          unread={unread}
        />
      ) : null}
    </NotificationCenterContext.Provider>
  );
}
