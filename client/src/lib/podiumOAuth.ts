/** Session-scoped CSRF state for Settings → Podium OAuth (must match callback). */
export const PODIUM_OAUTH_STATE_STORAGE_KEY = "ros.podium.oauth.state.v1";

/** Exact redirect URI used in `/oauth/authorize` (must match token exchange). */
export const PODIUM_OAUTH_REDIRECT_STORAGE_KEY = "ros.podium.oauth.redirect.v1";

/**
 * Callback URL for authorize + token exchange (must match the Podium app exactly).
 * - Default: `${origin}/callback` (works for `http://localhost:5173/callback` in dev if Podium allows it).
 * - Override with `VITE_PODIUM_OAUTH_REDIRECT_URI` when Podium only accepts HTTPS (Vite `server.https`, tunnel, or prod).
 */
export function getPodiumOAuthRedirectUri(): string | null {
  const fromEnv = String(import.meta.env.VITE_PODIUM_OAUTH_REDIRECT_URI ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (typeof window === "undefined") {
    return null;
  }
  return `${window.location.origin}/callback`;
}
