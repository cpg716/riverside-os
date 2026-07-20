/**
 * Handles API requests with JWT token authentication.
 */

import { getJwtToken } from "./jwt";
import { getBaseUrl } from "./apiConfig";

export const DEFAULT_READ_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal;
  const onAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getJwtToken();
  if (token) {
    options.headers = {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    };
  }
  return fetch(`${getBaseUrl()}/api${url}`, options);
}

export async function getUser(): Promise<unknown> {
  const response = await fetchWithAuth("/user/current");
  if (!response.ok) {
    throw new Error(`Failed to fetch user: ${response.statusText}`);
  }
  return response.json();
}

// Add more API functions as needed
