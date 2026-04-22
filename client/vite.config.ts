import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf-8"),
) as {
  version: string;
};

function gitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

const pwaManifest = JSON.parse(
  readFileSync(path.join(__dirname, "public/manifest.json"), "utf-8"),
) as Record<string, unknown>;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [
    nodePolyfills({
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    react(),
    {
      name: "ros-manifest-link-dev",
      transformIndexHtml(html, ctx) {
        if (ctx.server && !html.includes('rel="manifest"')) {
          return html.replace(
            "<head>",
            '<head>\n    <link rel="manifest" href="/manifest.json" />',
          );
        }
        return html;
      },
    },
    VitePWA({
      registerType: "prompt",
      manifest: pwaManifest,
      manifestFilename: "manifest.json",
      includeAssets: ["icon-192.png", "icon-512.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,woff2}"],
        // The main app bundle is slightly above Workbox's default 2 MiB precache ceiling.
        // Keep precache behavior intact and raise the limit modestly instead of excluding the bundle.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/metabase(\/|$)/],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      util: "util",
      stream: "stream-browserify",
      buffer: "buffer",
      process: "process/browser",
      path: "path-browserify",
      string_decoder: "string_decoder",
    },
  },
  optimizeDeps: {
    include: ["util", "stream-browserify", "buffer", "process/browser", "path-browserify", "string_decoder"],
  },
  envPrefix: ["VITE_", "TAURI_"],
  define: {
    __ROS_CLIENT_SEMVER__: JSON.stringify(pkg.version),
    __ROS_GIT_SHORT__: JSON.stringify(gitShort()),
    global: "globalThis",
  },
  server: {
    port: 5173,
    strictPort: true,
    // Listen on all interfaces so other machines on LAN / Tailscale can open :5173 (use http://, not https://).
    host: true,
    // Avoid stale index.html pointing at old hashed chunks after rebuild (index-*.js / vendor-*.js 404).
    headers: { "Cache-Control": "no-store" },
    // When VITE_API_BASE is empty (see .env.development), the app calls /api/* on this host; proxy forwards to local Rust.
    // That fixes "Failed to fetch" when opening http://<LAN-IP>:5173 from another device (127.0.0.1:3000 would be wrong there).
    proxy: {
      "/api": {
        target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
        // Catalog CSV import can run for many minutes (large Lightspeed exports + long DB transaction).
        timeout: 1_800_000,
        proxyTimeout: 1_800_000,
      },
      // Same-origin Metabase iframe (Insights): forward to Axum, which proxies to RIVERSIDE_METABASE_UPSTREAM.
      "/metabase": {
        target: process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    // Main + lazy exceljs chunks exceed default 500 kB; intentional for this app.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "lucide-react"],
        },
      },
    },
  },
});
