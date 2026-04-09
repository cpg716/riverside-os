import type { NotificationRow } from "../context/NotificationCenterContextLogic";

/** Wedding morning-compass row (matches `GET /api/weddings/morning-compass` lists). */
export interface CompassActionRow {
  wedding_party_id: string;
  wedding_member_id: string;
  party_name: string;
  customer_name: string;
  role: string;
  status: string;
  event_date: string;
}

export type CompassQueueBand = "overdue" | "needs_order" | "needs_measure";

export type MorningCompassQueueItem =
  | {
      kind: "wedding";
      id: string;
      sortKey: number;
      tier: "urgent" | "soon" | "normal";
      band: CompassQueueBand;
      row: CompassActionRow;
    }
  | {
      kind: "task";
      id: string;
      sortKey: number;
      tier: "urgent" | "soon" | "normal";
      taskId: string;
      title: string;
      dueDate: string | null;
    }
  | {
      kind: "notification";
      id: string;
      sortKey: number;
      tier: "urgent" | "soon" | "normal";
      row: NotificationRow;
    };

function parseLocalYmd(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Days until event: negative = overdue. */
export function daysUntilWeddingEvent(eventDate: string, now = new Date()): number | null {
  const ev = parseLocalYmd(eventDate);
  if (!ev) return null;
  const delta = startOfLocalDay(ev) - startOfLocalDay(now);
  return Math.round(delta / 86_400_000);
}

function taskDueSortKey(due: string | null, now = new Date()): { sortKey: number; tier: MorningCompassQueueItem["tier"] } {
  if (!due || !due.trim()) {
    return { sortKey: 460, tier: "normal" };
  }
  const d = parseLocalYmd(due.length >= 10 ? due.slice(0, 10) : due);
  if (!d) return { sortKey: 460, tier: "normal" };
  const days = Math.round((startOfLocalDay(d) - startOfLocalDay(now)) / 86_400_000);
  if (days < 0) return { sortKey: 152, tier: "urgent" };
  if (days === 0) return { sortKey: 250, tier: "soon" };
  if (days <= 7) return { sortKey: 280 + days, tier: "soon" };
  return { sortKey: 450 + Math.min(days, 60), tier: "normal" };
}

function notificationSortKey(row: NotificationRow): { sortKey: number; tier: MorningCompassQueueItem["tier"] } {
  const k = (row.kind || "").toLowerCase();
  if (
    k.includes("backup") ||
    k.includes("integration") ||
    k.includes("auth_failure") ||
    k.includes("rms_r2s") ||
    k.includes("morning_digest")
  ) {
    return { sortKey: 125, tier: "urgent" };
  }
  if (k.includes("task_due") || k.includes("refund") || k.includes("review")) {
    return { sortKey: 220, tier: "soon" };
  }
  if (!row.read_at) {
    return { sortKey: 410, tier: "normal" };
  }
  return { sortKey: 900, tier: "normal" };
}

/**
 * Ranked “do this first” queue from existing dashboard signals (no ML).
 * Lower `sortKey` = earlier in the list.
 */
export function buildMorningCompassQueue(input: {
  overduePickups: CompassActionRow[];
  needsOrder: CompassActionRow[];
  needsMeasure: CompassActionRow[];
  openTasks: { id: string; title_snapshot: string; due_date: string | null }[];
  notifications: NotificationRow[];
  /** Max items returned (POS uses ~7, Operations ~12). */
  limit: number;
}): MorningCompassQueueItem[] {
  const items: MorningCompassQueueItem[] = [];
  const now = new Date();

  input.overduePickups.forEach((row, i) => {
    const late = daysUntilWeddingEvent(row.event_date, now);
    const bump = late != null && late < 0 ? Math.min(-late, 30) : 0;
    items.push({
      kind: "wedding",
      id: `w-overdue-${row.wedding_member_id}`,
      sortKey: 100 + bump * 2 + i * 0.01,
      tier: "urgent",
      band: "overdue",
      row,
    });
  });

  input.needsOrder.forEach((row, i) => {
    const du = daysUntilWeddingEvent(row.event_date, now);
    const urgency = du != null && du >= 0 && du <= 14 ? (14 - du) * 3 : 0;
    items.push({
      kind: "wedding",
      id: `w-order-${row.wedding_member_id}`,
      sortKey: 200 - Math.min(urgency, 40) + i * 0.01,
      tier: du != null && du <= 7 ? "soon" : "normal",
      band: "needs_order",
      row,
    });
  });

  input.needsMeasure.forEach((row, i) => {
    const du = daysUntilWeddingEvent(row.event_date, now);
    const urgency = du != null && du >= 0 && du <= 30 ? (30 - du) : 0;
    items.push({
      kind: "wedding",
      id: `w-measure-${row.wedding_member_id}`,
      sortKey: 300 - Math.min(urgency, 25) + i * 0.01,
      tier: du != null && du <= 14 ? "soon" : "normal",
      band: "needs_measure",
      row,
    });
  });

  for (const t of input.openTasks) {
    const { sortKey, tier } = taskDueSortKey(t.due_date, now);
    items.push({
      kind: "task",
      id: `t-${t.id}`,
      sortKey,
      tier,
      taskId: t.id,
      title: t.title_snapshot,
      dueDate: t.due_date,
    });
  }

  for (const n of input.notifications) {
    if (n.archived_at) continue;
    const { sortKey, tier } = notificationSortKey(n);
    items.push({
      kind: "notification",
      id: `n-${n.staff_notification_id}`,
      sortKey,
      tier,
      row: n,
    });
  }

  items.sort((a, b) => a.sortKey - b.sortKey || a.id.localeCompare(b.id));
  return items.slice(0, Math.max(1, input.limit));
}

export function compassBandLabel(band: CompassQueueBand): string {
  switch (band) {
    case "overdue":
      return "Overdue pickup";
    case "needs_order":
      return "Needs order";
    case "needs_measure":
      return "Needs measure";
    default:
      return band;
  }
}
