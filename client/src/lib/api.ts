/**
 * Handles API requests with JWT token authentication.
 */

import { getJwtToken } from "./jwt";
import { getBaseUrl } from "./apiConfig";

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
