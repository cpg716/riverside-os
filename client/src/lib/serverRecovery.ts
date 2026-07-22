import { getBaseUrl } from "./apiConfig";
import {
  getPosRegisterAuth,
  hasStaffOrPosAuthHeaders,
  posRegisterAuthHeaders,
  sessionPollAuthHeaders,
} from "./posRegisterAuth";

export type ServerRecoveryKind =
  | "checkout_offline"
  | "checkout_unconfirmed"
  | "pickup_after_payment"
  | "receipt_print"
  | "exchange_settlement";

export type ServerRecoveryStatus =
  "pending" | "blocked" | "resolved" | "dismissed";

export type ServerRecoveryJob = {
  client_job_key: string;
  kind: ServerRecoveryKind;
  status: ServerRecoveryStatus;
  register_session_id?: string | null;
  transaction_id?: string | null;
  checkout_client_id?: string | null;
  station_key?: string | null;
  label?: string | null;
  payload: unknown;
  last_error?: string | null;
  attempt_count: number;
  first_seen_at?: string;
  last_seen_at?: string;
};

export type ServerRecoveryUpsert = {
  client_job_key: string;
  kind: ServerRecoveryKind;
  status: "pending" | "blocked";
  register_session_id?: string;
  transaction_id?: string;
  checkout_client_id?: string;
  label?: string;
  payload: unknown;
  last_error?: string;
  attempt_count?: number;
};

function parseRecoveryJob(value: unknown): ServerRecoveryJob | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ServerRecoveryJob>;
  if (
    typeof candidate.client_job_key !== "string" ||
    ![
      "checkout_offline",
      "checkout_unconfirmed",
      "pickup_after_payment",
      "receipt_print",
      "exchange_settlement",
    ].includes(candidate.kind ?? "") ||
    !["pending", "blocked", "resolved", "dismissed"].includes(
      candidate.status ?? "",
    ) ||
    typeof candidate.attempt_count !== "number" ||
    !("payload" in candidate)
  ) {
    return null;
  }
  return candidate as ServerRecoveryJob;
}

const RECONCILING_SESSION_KEY = "ros.pos.reconciling_session";

export function isRegisterReconciliationLocked(sessionId: string): boolean {
  return window.sessionStorage.getItem(RECONCILING_SESSION_KEY) === sessionId;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validRecoveryUuid(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized && UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function recoveryRequestContext(): {
  baseUrl: string;
  headers: Record<string, string>;
} | null {
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  // Recovery records belong to the open Register session. Prefer its opaque token so a
  // simultaneously persisted Back Office identity cannot change server-side scoping.
  const posHeaders = posRegisterAuthHeaders();
  const headers = hasStaffOrPosAuthHeaders(posHeaders)
    ? posHeaders
    : sessionPollAuthHeaders();
  if (!hasStaffOrPosAuthHeaders(headers)) return null;
  return { baseUrl: getBaseUrl(), headers };
}

function staffRecoveryRequestContext(staffHeaders: HeadersInit): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const headers = Object.fromEntries(new Headers(staffHeaders).entries());
  // A global recovery request must be authorized as Staff, never accidentally
  // narrowed to the currently open till group by an attached POS token.
  delete headers["x-riverside-pos-session-id"];
  delete headers["x-riverside-pos-session-token"];
  if (!hasStaffOrPosAuthHeaders(headers)) {
    throw new Error(
      "Staff Access is required to review recovery from prior till groups.",
    );
  }
  return { baseUrl: getBaseUrl(), headers };
}

async function recoveryResponseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error?.trim() || `${fallback} (${response.status}).`);
}

export async function mirrorRecoveryJob(
  job: ServerRecoveryUpsert,
  requestHeaders?: HeadersInit,
): Promise<ServerRecoveryJob | null> {
  const context = requestHeaders
    ? {
        baseUrl: getBaseUrl(),
        headers: Object.fromEntries(new Headers(requestHeaders).entries()),
      }
    : recoveryRequestContext();
  if (!context) return null;
  try {
    const response = await fetch(`${context.baseUrl}/api/recovery`, {
      method: "POST",
      headers: { ...context.headers, "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    if (!response.ok) return null;
    const mirrored = parseRecoveryJob(await response.json().catch(() => null));
    if (
      mirrored?.client_job_key !== job.client_job_key ||
      mirrored.kind !== job.kind
    ) {
      return null;
    }
    return mirrored;
  } catch {
    return null;
  }
}

export async function resolveRecoveryJob(
  clientJobKey: string,
  status: "resolved" | "dismissed" = "resolved",
  resolutionNote?: string,
): Promise<boolean> {
  const context = recoveryRequestContext();
  if (!context) return false;
  try {
    const response = await fetch(
      `${context.baseUrl}/api/recovery/${encodeURIComponent(clientJobKey)}`,
      {
        method: "PATCH",
        headers: { ...context.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ status, resolution_note: resolutionNote }),
      },
    );
    // A missing record is not a confirmed resolution. Callers retain their
    // local recovery evidence and may first mirror it before retrying PATCH.
    // Treating 404 as success lets a delayed POST recreate an open job after
    // the local copy has already been discarded.
    return response.ok;
  } catch {
    return false;
  }
}

export async function listCurrentRegisterRecoveryJobs(
  requestHeaders?: HeadersInit,
): Promise<ServerRecoveryJob[]> {
  return (await listCurrentRegisterRecoveryJobsAuthoritative(requestHeaders)) ?? [];
}

/**
 * Read the current Register recovery list without treating an unavailable
 * Main Hub as an authoritative empty result.
 */
export async function listCurrentRegisterRecoveryJobsAuthoritative(
  requestHeaders?: HeadersInit,
): Promise<ServerRecoveryJob[] | null> {
  const context = requestHeaders
    ? {
        baseUrl: getBaseUrl(),
        headers: Object.fromEntries(new Headers(requestHeaders).entries()),
      }
    : recoveryRequestContext();
  if (!context || (!requestHeaders && !getPosRegisterAuth()?.sessionId)) return null;
  try {
    const response = await fetch(`${context.baseUrl}/api/recovery`, {
      headers: context.headers,
      cache: "no-store",
    });
    if (!response.ok) return null;
    const jobs = (await response.json()) as unknown;
    return Array.isArray(jobs)
      ? jobs.flatMap((job) => {
          const parsed = parseRecoveryJob(job);
          return parsed ? [parsed] : [];
        })
      : null;
  } catch {
    return null;
  }
}

/**
 * List every open recovery record using Staff Access. Unlike the current-till
 * helper, this rejects unavailable/unauthorized reads so callers cannot present
 * an empty list as authoritative.
 */
export async function listGlobalRegisterRecoveryJobs(
  staffHeaders: HeadersInit,
): Promise<ServerRecoveryJob[]> {
  const context = staffRecoveryRequestContext(staffHeaders);
  let response: Response;
  try {
    response = await fetch(`${context.baseUrl}/api/recovery`, {
      headers: context.headers,
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Main Hub is unavailable; prior till-group recovery was not checked.",
    );
  }
  if (!response.ok) {
    throw await recoveryResponseError(
      response,
      "Prior till-group recovery could not be checked",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(body)) {
    throw new Error(
      "Main Hub returned an invalid prior till-group recovery list.",
    );
  }
  const jobs = body.map(parseRecoveryJob);
  if (jobs.some((job) => job === null)) {
    throw new Error(
      "Main Hub returned an invalid prior till-group recovery list.",
    );
  }
  return jobs as ServerRecoveryJob[];
}

export function recoveryJobsOutsideCurrentTillGroup(
  currentJobs: ServerRecoveryJob[],
  globalJobs: ServerRecoveryJob[],
): ServerRecoveryJob[] {
  const currentKeys = new Set(currentJobs.map((job) => job.client_job_key));
  return globalJobs.filter(
    (job) =>
      !currentKeys.has(job.client_job_key) &&
      (job.kind === "checkout_offline" ||
        job.kind === "checkout_unconfirmed" ||
        job.kind === "pickup_after_payment" ||
        job.kind === "exchange_settlement" ||
        job.kind === "receipt_print"),
  );
}

export async function reportStationCloseStatus(summary: {
  pendingCount: number;
  blockedCount: number;
}): Promise<boolean> {
  const context = recoveryRequestContext();
  const sessionId = getPosRegisterAuth()?.sessionId;
  if (!context || !sessionId) return false;
  try {
    const current = await fetch(`${context.baseUrl}/api/sessions/current`, {
      headers: context.headers,
      cache: "no-store",
    });
    if (!current.ok) return false;
    const currentBody = (await current.json()) as { lifecycle_status?: string };
    if (currentBody.lifecycle_status !== "reconciling") {
      if (isRegisterReconciliationLocked(sessionId)) {
        window.sessionStorage.removeItem(RECONCILING_SESSION_KEY);
      }
      return true;
    }

    // Lock this workstation before acknowledging it to Register #1. If the
    // network drops after acknowledgement, offline checkout remains disabled.
    window.sessionStorage.setItem(RECONCILING_SESSION_KEY, sessionId);
    const response = await fetch(
      `${context.baseUrl}/api/recovery/station-close-status`,
      {
        method: "POST",
        headers: { ...context.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          pending_checkout_count: Math.max(0, summary.pendingCount),
          blocked_checkout_count: Math.max(0, summary.blockedCount),
        }),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function replayCheckoutRecoveryJob(
  clientJobKey: string,
  approval: { managerStaffId: string; managerPin: string; reason: string },
): Promise<{ transactionId: string; displayId: string; postClose: boolean }> {
  const context = recoveryRequestContext();
  if (!context)
    throw new Error("Main Hub is unavailable for checkout recovery.");
  const response = await fetch(
    `${context.baseUrl}/api/recovery/${encodeURIComponent(clientJobKey)}/replay-checkout`,
    {
      method: "POST",
      headers: { ...context.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        manager_staff_id: approval.managerStaffId,
        manager_pin: approval.managerPin,
        reason: approval.reason,
      }),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    transaction_id?: string;
    transaction_display_id?: string;
    post_close_recovery?: boolean;
  };
  if (!response.ok || !body.transaction_id || !body.transaction_display_id) {
    throw new Error(
      body.error ?? `Checkout recovery failed (${response.status}).`,
    );
  }
  return {
    transactionId: body.transaction_id,
    displayId: body.transaction_display_id,
    postClose: body.post_close_recovery === true,
  };
}

/**
 * Complete a durable exchange settlement using its server-owned financial
 * snapshot. The caller supplies only the job identity, current posting
 * Register session, and audited Manager approval.
 */
export async function recoverExchangeSettlementJob(
  clientJobKey: string,
  postingSessionId: string,
  approval: { managerStaffId: string; managerPin: string; reason: string },
): Promise<{ deferredCardRefundDueAmount: string }> {
  const posAuth = getPosRegisterAuth();
  const headers = posRegisterAuthHeaders();
  if (
    !posAuth ||
    posAuth.sessionId !== postingSessionId ||
    !hasStaffOrPosAuthHeaders(headers)
  ) {
    throw new Error(
      "The current Register session could not be authenticated for exchange recovery.",
    );
  }
  let response: Response;
  try {
    response = await fetch(
      `${getBaseUrl()}/api/transactions/exchange-settlement-recovery/${encodeURIComponent(clientJobKey)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          posting_session_id: postingSessionId,
          manager_staff_id: approval.managerStaffId,
          manager_pin: approval.managerPin,
          reason: approval.reason,
        }),
      },
    );
  } catch {
    throw new Error(
      "Main Hub is unavailable for exchange settlement recovery.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    deferred_card_refund_due_amount?: string | number;
  };
  if (!response.ok) {
    throw new Error(
      body.error?.trim() ||
        `Exchange settlement recovery failed (${response.status}).`,
    );
  }
  return {
    deferredCardRefundDueAmount: String(
      body.deferred_card_refund_due_amount ?? "0",
    ),
  };
}

/** Replay a recovery from outside the active till group with Staff Access. */
export async function replayGlobalCheckoutRecoveryJob(
  clientJobKey: string,
  approval: { managerStaffId: string; managerPin: string; reason: string },
  staffHeaders: HeadersInit,
): Promise<{ transactionId: string; displayId: string; postClose: boolean }> {
  const context = staffRecoveryRequestContext(staffHeaders);
  let response: Response;
  try {
    response = await fetch(
      `${context.baseUrl}/api/recovery/${encodeURIComponent(clientJobKey)}/replay-checkout`,
      {
        method: "POST",
        headers: { ...context.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          manager_staff_id: approval.managerStaffId,
          manager_pin: approval.managerPin,
          reason: approval.reason,
        }),
      },
    );
  } catch {
    throw new Error(
      "Main Hub is unavailable for prior till-group checkout recovery.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    transaction_id?: string;
    transaction_display_id?: string;
    post_close_recovery?: boolean;
  };
  if (!response.ok || !body.transaction_id || !body.transaction_display_id) {
    throw new Error(
      body.error ?? `Checkout recovery failed (${response.status}).`,
    );
  }
  return {
    transactionId: body.transaction_id,
    displayId: body.transaction_display_id,
    postClose: body.post_close_recovery === true,
  };
}

/**
 * Resolve an unconfirmed checkout only after Payments Health and the target
 * Transaction Record prove that the original Helcim approval was already
 * recorded elsewhere. This never creates, moves, or retries a payment.
 */
export async function resolveExternallyReconciledCheckoutJob(
  clientJobKey: string,
  evidence: {
    targetTransactionDisplayId: string;
    providerTransactionId: string;
  },
  approval: { managerStaffId: string; managerPin: string; reason: string },
  staffHeaders: HeadersInit,
): Promise<{
  transactionId: string;
  displayId: string;
  providerTransactionId: string;
  checkoutClientId: string;
  registerSessionId: string;
}> {
  const context = staffRecoveryRequestContext(staffHeaders);
  let response: Response;
  try {
    response = await fetch(
      `${context.baseUrl}/api/recovery/${encodeURIComponent(clientJobKey)}/resolve-external`,
      {
        method: "POST",
        headers: { ...context.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          manager_staff_id: approval.managerStaffId,
          manager_pin: approval.managerPin,
          reason: approval.reason,
          target_transaction_display_id: evidence.targetTransactionDisplayId,
          provider_transaction_id: evidence.providerTransactionId,
        }),
      },
    );
  } catch {
    throw new Error(
      "Main Hub is unavailable for exact checkout reconciliation.",
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    transaction_id?: string;
    transaction_display_id?: string;
    provider_transaction_id?: string;
    checkout_client_id?: string;
    register_session_id?: string;
  };
  if (!response.ok) {
    throw new Error(
      body.error?.trim() ||
        `Exact checkout reconciliation failed (${response.status}).`,
    );
  }
  if (
    !body.transaction_id?.trim() ||
    !body.transaction_display_id?.trim() ||
    !body.provider_transaction_id?.trim() ||
    !body.checkout_client_id?.trim() ||
    !body.register_session_id?.trim()
  ) {
    throw new Error(
      "Main Hub resolved the recovery without returning its exact checkout evidence. Keep the recovery record visible and contact support.",
    );
  }
  return {
    transactionId: body.transaction_id,
    displayId: body.transaction_display_id,
    providerTransactionId: body.provider_transaction_id,
    checkoutClientId: body.checkout_client_id,
    registerSessionId: body.register_session_id,
  };
}

/** Verify the recorded Orders/Alterations follow-up before resolving a paid-pickup job. */
export async function verifyGlobalRecoveryFollowUp(
  clientJobKey: string,
  approval: { managerStaffId: string; managerPin: string; reason: string },
  staffHeaders: HeadersInit,
): Promise<void> {
  const context = staffRecoveryRequestContext(staffHeaders);
  let response: Response;
  try {
    response = await fetch(
      `${context.baseUrl}/api/recovery/${encodeURIComponent(clientJobKey)}/verify-follow-up`,
      {
        method: "POST",
        headers: { ...context.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          manager_staff_id: approval.managerStaffId,
          manager_pin: approval.managerPin,
          reason: approval.reason,
        }),
      },
    );
  } catch {
    throw new Error("Main Hub is unavailable for paid follow-up verification.");
  }
  if (!response.ok) {
    throw await recoveryResponseError(
      response,
      "Paid follow-up verification failed",
    );
  }
}
