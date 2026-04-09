# Podium storefront widget: CSP and privacy

Use this checklist when enabling **`VITE_STOREFRONT_EMBEDS=true`** on a public bundle that loads **`GET /api/public/storefront-embeds`** (see **`StorefrontEmbedHost`** in the client shell). For the first-party **`/shop`** surface and store APIs, see **`docs/ONLINE_STORE.md`**.

## Content-Security-Policy (CSP)

Podium’s embed typically loads **third-party scripts** and may open **WebSocket** or **XHR** connections to Podium-controlled hosts. Exact hostnames change over time; confirm the current list in **Podium dashboard** embed instructions and [Podium documentation](https://docs.podium.com/docs/getting-started).

Typical CSP directives to review:

- **`script-src`**: allow Podium script origins (often `https://connect.podium.com` or similar — verify in your snippet).
- **`connect-src`**: allow the same API/WebSocket hosts the widget uses for chat/SMS handoff.
- **`frame-src` / `child-src`**: if the embed uses iframes.
- **`img-src`**: if the widget loads avatars or assets from Podium CDNs.

Start from a **report-only** CSP (`Content-Security-Policy-Report-Only`) on staging, collect violations, then tighten **`enforce`** rules.

## Privacy / policy copy

Public storefront privacy policies should mention:

- Use of a **third-party messaging widget** (Podium) for web chat and related SMS flows.
- What data the widget may collect (e.g. page context, messages, device metadata) per Podium’s terms and your jurisdiction (GDPR/CCPA as applicable).
- How customers can **opt out** or contact the store outside the widget.

This document is **operational guidance** only; legal review is the store’s responsibility.
