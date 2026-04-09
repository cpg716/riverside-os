import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useBackofficeAuth } from "./BackofficeAuthContext";
import {
  getPosRegisterAuth,
  mergedPosStaffHeaders,
} from "../lib/posRegisterAuth";
import NotificationCenterDrawer from "../components/notifications/NotificationCenterDrawer";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

export type NotificationDeepLink = Record<string, string | undefined> & {
  type?: string;
};

export type NotificationRow = {
  staff_notification_id: string;
  notification_id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  deep_link: NotificationDeepLink;
  source: string;
  read_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
};

type NotificationCenterContextValue = {
  unread: number;
  /** Unread Podium inbound SMS/email staff rows (Operations → Inbox); subset of `unread`. */
  podiumInboxUnread: number;
  refreshUnread: () => Promise<void>;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  canView: boolean;
};

const NotificationCenterContext =
  createContext<NotificationCenterContextValue | null>(null);

export function useNotificationCenter(): NotificationCenterContextValue {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotificationCenter requires NotificationCenterProvider");
  }
  return ctx;
}

/** Optional: returns null when outside `NotificationCenterProvider` (e.g. tests). */
export function useNotificationCenterOptional(): NotificationCenterContextValue | null {
  return useContext(NotificationCenterContext);
}

export function NotificationCenterProvider({
  children,
  onNavigate,
}: {
  children: ReactNode;
  onNavigate: (link: NotificationDeepLink) => void;
}) {
  const { backofficeHeaders, hasPermission, permissionsLoaded, staffCode } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const canView = permissionsLoaded && hasPermission("notifications.view");
  const hasPos = Boolean(getPosRegisterAuth()?.sessionId);
  const canReachApi = staffCode.trim().length > 0 || hasPos;

  const [unread, setUnread] = useState(0);
  const [podiumInboxUnread, setPodiumInboxUnread] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const refreshUnread = useCallback(async () => {
    if (!canView || !canReachApi) {
      setUnread(0);
      setPodiumInboxUnread(0);
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/notifications/unread-count`, {
        headers: apiAuth(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        unread?: number;
        podium_inbox_unread?: number;
      };
      setUnread(typeof data.unread === "number" ? data.unread : 0);
      setPodiumInboxUnread(
        typeof data.podium_inbox_unread === "number" ? data.podium_inbox_unread : 0,
      );
    } catch {
      /* ignore */
    }
  }, [apiAuth, canReachApi, canView]);

  useEffect(() => {
    refreshUnread().catch(() => {});
  }, [refreshUnread]);

  useEffect(() => {
    if (!canView || !canReachApi) return;
    const t = window.setInterval(() => void refreshUnread(), 60_000);
    return () => window.clearInterval(t);
  }, [canReachApi, canView, refreshUnread]);

  const value = useMemo<NotificationCenterContextValue>(
    () => ({
      unread,
      podiumInboxUnread,
      refreshUnread,
      drawerOpen,
      openDrawer: () => setDrawerOpen(true),
      closeDrawer: () => setDrawerOpen(false),
      canView: canView && canReachApi,
    }),
    [unread, podiumInboxUnread, refreshUnread, drawerOpen, canView, canReachApi],
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
        />
      ) : null}
    </NotificationCenterContext.Provider>
  );
}
