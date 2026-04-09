# Audit Report: Online Store, CMS & ROSIE (AI)
**Date:** 2026-04-08
**Status:** Operational (Storefront/CMS) / Planned (ROSIE AI)
**Auditor:** Antigravity

## 1. Executive Summary
The final pillar of Riverside OS bridges the gap between internal operations and the public-facing brand. The Online Store provides a high-performance React storefront, the CMS enables visual design via GrapesJS, and the Help Center provides the structured knowledge base that will eventually power the ROSIE LLM assistant.

## 2. Online Storefront (`/shop`)

### 2.1 Architecture & Identity
- **Decoupled Auth**: Public customer accounts are handled separately from staff PINs, using Argon2 hashing and HS256 JWTs (`server/src/auth/store_customer_jwt.rs`).
- **Cart Persistence**: Uses a hybrid approach with `localStorage` for immediate guest feedback and a server-side `store_guest_cart` (90-day expiry) for persistence across sessions.
- **Rate Limiting**: Aggressive IP-based and customer-based rate limiting (`StoreAccountRateState`) protects against brute-force login and registration attempts.

### 2.2 Financial Logic
- **Web Tax Engine**: Implements a specific New York "Ship-to vs Pickup" policy. It accurately calculates NY sales tax for in-store pickups (NY-sourced) while providing disclaimers for out-of-state shipments.
- **Coupon System**: Supports promotional codes with usage limits and expiration dates, integrated directly into the cart pricing logic.

## 3. Content Management System (CMS)

### 3.1 Visual Editor (GrapesJS)
- **Studio Integration**: The Back Office utilizes the `@grapesjs/studio-sdk` for a premium, drag-and-drop page-building experience.
- **Sanitization Pipeline**: All internally authored HTML is sanitized via the **Ammonia** library on the server before being served to guests, preventing XSS while allowing rich marketing content.
- **Media Assets**: A dedicated `store_media_asset` system handles image uploads (max 3 MiB) for use within the CMS.

## 4. Help Center & ROSIE AI

### 4.1 Help Infrastructure (Operational)
- **Knowledge Base**: Shipped as Markdown manuals in `client/src/assets/docs/`.
- **Search Engine**: Integrated with Meilisearch (`ros_help` index). The system supports full-text search with fuzzy matching and section-level "jump-to" links.
- **Fallback Mode**: Includes a client-side substring search for offline or Meilisearch-disabled environments.

### 4.2 ROSIE AI Engine (In-Planning)
- **Vision**: ROSIE (RiversideOS Intelligence Engine) is planned as a local LLM sidecar (`llama-server`) for Tauri and an Axum-proxied completion engine for the PWA.
- **Grounding**: The AI will be grounded in the existing Help Center manuals and the `AI_REPORTING_DATA_CATALOG.md` constitution, ensuring it handles financial data with the required precision.

## 5. Findings & Recommendations
1. **Security Excellence**: The inclusion of a dedicated sanitization pass (Ammonia) and robust rate limiting on public endpoints demonstrates a mature approach to security.
2. **AI Readiness**: The structured nature of the Help Center manuals means the system is "RAG-ready" (Retrieval-Augmented Generation). Transitioning to an active ROSIE assistant will be straightforward once the LLM inference sidecar is integrated.
3. **Recommendation**: Implement "Abandoned Cart" analytics to track lost online revenue, as the infrastructure for guest carts is already capable of supporting this.

## 6. Conclusion
The Online Store and CMS are **feature-rich and production-ready**. While the ROSIE AI engine is still in the planning phase, the structural foundations (Help Center manuals and Meilisearch indexing) are already operational, making for a direct path to an AI-enhanced staff experience.
