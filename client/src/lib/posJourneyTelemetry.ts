import { getBaseUrl } from "./apiConfig";
import { getClientRuntimeSurface } from "./clientDiagnostics";
import { getPosRegisterAuth, posRegisterAuthHeaders } from "./posRegisterAuth";

export const POS_JOURNEY_PHASES = [
  "search_to_result",
  "scan_to_line",
  "pay_open",
  "tender_confirmed",
  "receipt_ready",
  "close_complete",
] as const;

export type PosJourneyPhase = (typeof POS_JOURNEY_PHASES)[number];

type PosJourneySample = {
  phase: PosJourneyPhase;
  duration_ms: number;
  success: boolean;
  runtime_surface: "tauri_desktop" | "pwa_standalone" | "browser_tab";
  online: boolean;
};

type ActiveTiming = { startedAt: number; generation: number };

const activeTimings = new Map<PosJourneyPhase, ActiveTiming>();
const pendingSamples: PosJourneySample[] = [];
let flushScheduled = false;
let flushInProgress = false;
let timingGeneration = 0;

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function scheduleFlush(): void {
  if (flushScheduled || flushInProgress) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    void flushPendingSamples();
  });
}

async function flushPendingSamples(): Promise<void> {
  if (flushInProgress || pendingSamples.length === 0) return;
  const auth = getPosRegisterAuth();
  if (!auth?.sessionId || !auth.token) {
    pendingSamples.length = 0;
    return;
  }

  flushInProgress = true;
  const samples = pendingSamples.splice(0, 20);
  try {
    await fetch(`${getBaseUrl()}/api/pos/journey-metrics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...posRegisterAuthHeaders(),
      },
      body: JSON.stringify({ register_session_id: auth.sessionId, samples }),
      keepalive: true,
    });
  } catch {
    // Performance telemetry is best-effort and must never interrupt a sale.
  } finally {
    flushInProgress = false;
    if (pendingSamples.length > 0) scheduleFlush();
  }
}

export function startPosJourneyTiming(phase: PosJourneyPhase): void {
  activeTimings.set(phase, {
    startedAt: monotonicNow(),
    generation: ++timingGeneration,
  });
}

export function ensurePosJourneyTimingStarted(phase: PosJourneyPhase): void {
  if (!activeTimings.has(phase)) startPosJourneyTiming(phase);
}

export function cancelPosJourneyTiming(phase: PosJourneyPhase): void {
  activeTimings.delete(phase);
}

export function finishPosJourneyTiming(
  phase: PosJourneyPhase,
  success: boolean,
): void {
  const active = activeTimings.get(phase);
  if (active == null) return;
  activeTimings.delete(phase);
  const durationMs = monotonicNow() - active.startedAt;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  pendingSamples.push({
    phase,
    duration_ms: Math.round(durationMs * 10) / 10,
    success,
    runtime_surface: getClientRuntimeSurface(),
    online: typeof navigator !== "undefined" ? navigator.onLine : false,
  });
  scheduleFlush();
}

export function finishPosJourneyTimingAfterPaint(
  phase: PosJourneyPhase,
  success: boolean,
): void {
  if (typeof window === "undefined") {
    finishPosJourneyTiming(phase, success);
    return;
  }
  const generation = activeTimings.get(phase)?.generation;
  if (generation == null) return;
  window.requestAnimationFrame(() =>
    window.requestAnimationFrame(() => {
      if (activeTimings.get(phase)?.generation === generation) {
        finishPosJourneyTiming(phase, success);
      }
    }),
  );
}
