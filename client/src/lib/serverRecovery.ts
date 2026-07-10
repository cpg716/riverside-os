import { getBaseUrl } from "./apiConfig";
import {
  getPosRegisterAuth,
  hasStaffOrPosAuthHeaders,
  sessionPollAuthHeaders,
} from "./posRegisterAuth";

export type ServerRecoveryKind =
  | "checkout_offline"
  | "checkout_unconfirmed"
  | "pickup_after_payment"
  | "receipt_print";

export type ServerRecoveryJob = {
  client_job_key: string;
  kind: ServerRecoveryKind;
  status: "pending" | "blocked";
  register_session_id?: string | null;
  transaction_id?: string | null;
  checkout_client_id?: string | null;
  station_key?: string | null;
  label?: string | null;
  payload: unknown;
  last_error?: string | null;
  attempt_count: number;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validRecoveryUuid(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function recoveryRequestContext(): {
  baseUrl: string;
  headers: Record<string, string>;
} | null {
  if (typeof navigator !== "undefined" && !navigator.onLine) return null;
  const headers = sessionPollAuthHeaders();
  if (!hasStaffOrPosAuthHeaders(headers)) return null;
  return { baseUrl: getBaseUrl(), headers };
}

export async function mirrorRecoveryJob(
  job: ServerRecoveryUpsert,
): Promise<boolean> {
  const context = recoveryRequestContext();
  if (!context) return false;
  try {
    const response = await fetch(`${context.baseUrl}/api/recovery`, {
      method: "POST",
      headers: { ...context.headers, "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
    return response.ok;
  } catch {
    return false;
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
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

export async function listCurrentRegisterRecoveryJobs(): Promise<ServerRecoveryJob[]> {
  const context = recoveryRequestContext();
  if (!context || !getPosRegisterAuth()?.sessionId) return [];
  try {
    const response = await fetch(`${context.baseUrl}/api/recovery`, {
      headers: context.headers,
    });
    if (!response.ok) return [];
    const jobs = (await response.json()) as ServerRecoveryJob[];
    return Array.isArray(jobs) ? jobs : [];
  } catch {
    return [];
  }
}
