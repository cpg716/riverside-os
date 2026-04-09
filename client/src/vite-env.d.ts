/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

declare module "*.md?raw" {
  const src: string;
  export default src;
}

declare const __ROS_CLIENT_SEMVER__: string;
declare const __ROS_GIT_SHORT__: string;

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  /** HTTPS redirect URI for Podium OAuth when dev server is HTTP (must match Podium app config). */
  readonly VITE_PODIUM_OAUTH_REDIRECT_URI?: string;
  /** Optional Sentry browser SDK DSN (Tauri/PWA production diagnostics). */
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
