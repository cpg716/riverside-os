/**
 * Handles JWT token storage and retrieval for authenticated requests.
 */

const TOKEN_KEY = "ros_store_customer_jwt";

export function setJwtToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getJwtToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function removeJwtToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
