/** Session-scoped CSRF state for Settings → Podium OAuth (must match callback). */
export const PODIUM_OAUTH_STATE_STORAGE_KEY = "ros.podium.oauth.state.v1";

/** Exact redirect URI used in `/oauth/authorize` (must match token exchange). */
export const PODIUM_OAUTH_REDIRECT_STORAGE_KEY = "ros.podium.oauth.redirect.v1";

/** Public Riverside origin registered with the production Podium OAuth app. */
export const PODIUM_PUBLIC_APP_ORIGIN = "https://ros.riversidemens.com";

export const PODIUM_PRODUCTION_OAUTH_REDIRECT_URI = `${PODIUM_PUBLIC_APP_ORIGIN}/callback`;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Callback URL for authorize + token exchange (must match the Podium app exactly).
 * - Production/default: `https://ros.riversidemens.com/callback`, including when staff opened Riverside by LAN IP.
 * - Local loopback development: `${origin}/callback`.
 * - Override with `VITE_PODIUM_OAUTH_REDIRECT_URI` for a different HTTPS deployment.
 */
export function getPodiumOAuthRedirectUri(): string | null {
  const fromEnv = String(import.meta.env.VITE_PODIUM_OAUTH_REDIRECT_URI ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  if (typeof window === "undefined") {
    return null;
  }
  if (isLoopbackHost(window.location.hostname)) {
    return `${window.location.origin}/callback`;
  }
  return PODIUM_PRODUCTION_OAUTH_REDIRECT_URI;
}

/** OAuth state and the Back Office session must remain on the callback's browser origin. */
export function isPodiumOAuthBrowserOriginReady(redirectUri: string | null): boolean {
  if (!redirectUri || typeof window === "undefined") {
    return false;
  }
  try {
    const callback = new URL(redirectUri);
    const current = new URL(window.location.href);
    const secureOrLoopback =
      callback.protocol === "https:" ||
      (callback.protocol === "http:" && isLoopbackHost(callback.hostname));
    return secureOrLoopback && callback.origin === current.origin;
  } catch {
    return false;
  }
}
