# PLAN — Zero-Touch Help Center (ROSIE Screenshot Engine)

**Document owner:** Product + Engineering  
**System:** Riverside OS (ROS)  
**Date:** 2026-04-11  
**Status:** Strategic Proposal / Draft  

## 1) Vision
Transform the ROS Help Center from a static document repository into a **living, visual manual** that "takes its own pictures." By leveraging ROSIE's intelligence and browser-agent technology, we eliminate the burden of manual documentation maintenance and screenshot capture.

---

## 2) The "Zero-Touch" Workflow

### Phase 1: The Mapping Phase (ROSIE Reader)
- **Logic:** ROSIE parses the source `.md` files in `client/src/assets/docs/*.md`.
- **Target:** Identify "Action Points" (e.g., standard POS/BO navigation patterns).
- **Output:** Generate a **Shot List** (JSON) containing:
  - Navigation path (e.g., `Customers -> Relationship Hub -> Payments`).
  - Target UI elements to highlight.
  - Contextual anchor in the Markdown (Line number/ID).

### Phase 2: The Execution Phase (Stagehand Agent)
- **Driver:** [Stagehand](https://stagehand.browserbase.com/) (Agentic Browser Automation).
- **Mechanism:** Stagehand launches a headless ROS instance.
- **Intelligence:** Unlike Playwright, Stagehand uses semantic vision/descriptors to find buttons. If the "Refund" button moves to a different corner, the agent finds it automatically.
- **Wait Policy:** Uses "Observe & Verify" to ensure the page has hydrated before triggering the camera.

### Phase 3: The Capture Phase (The Rust "Camera")
- **Mechanism:** `tauri-plugin-screenshot` (Native Rust capture).
- **Process:** 
  1. The Agent signals the backend via a hidden "Monitor" socket.
  2. Rust captures a high-fidelity, pixel-perfect screenshot of the OS window.
  3. **Auto-Naming:** Images are saved to `docs/help-assets/` with deterministic IDs (e.g., `cust-vault-step-1.png`).

### Phase 4: The Injection Phase (Markdown Assembly)
- **Script:** A post-execution processor (`scripts/inject-screenshots.mjs`).
- **Logic:** Appends/Inserts the captured image links into the source Markdown at the exact "Action Point" location.
- **Cleanup:** ROSIE performs a "Polishing Pass" on the text to ensure descriptions align with the newly captured visuals.

### Phase 5: The Build Phase (Starlight + Pagefind)
- **Site Generator:** [Starlight](https://starlight.astro.build/) (Astro-native documentation framework).
- **Search:** [Pagefind](https://pagefind.app/) (Rust-based, zero-server-side search index).
- **Outcome:** A lightning-fast, sidebar-driven docs site bundled inside the ROS installer that works 100% offline on the local network.

---

## 3) Recommended Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **SSG** | Starlight (Astro) | Best-in-class performance; ships 0kb JS by default. |
| **Automation** | Stagehand | Self-healing, semantic navigation (not brittle selectors). |
| **Search** | Pagefind | Rust-powered; indexes content into fragments for instant local search. |
| **Capture** | `tauri-plugin-screenshot` | Native Rust pixel-perfect window capture. |
| **Orchestrator** | ROSIE | Provides the domain knowledge to bridge text to UI. |

---

## 4) Implementation Phases

### Phase 1: Infrastructure & Scaffolding (W1-W2)
- Initialize Starlight in a `docs-site/` subdirectory.
- Configure Pagefind for local indexing.
- Install and verify `tauri-plugin-screenshot`.

### Phase 2: The Agentic Pilot (W3-W4)
- Implement `doc-parser.rs` to extract Action Points.
- Develop the Stagehand "Shot List" interpreter.
- Verify headless navigation on the core v0.1.9 POS/CRM workflows.

### Phase 3: Auto-Injection Engine (W5-W6)
- Build the the injection script to map Shot List anchors to `![Image]()` tags.
- Implement the "Screenshot Manager" UI inside the Help Center Manager.

---

## 5) Why this fits ROS perfectly
1. **Local-First Reliability:** Pagefind and Starlight ensure the Help Center is available even if the internet goes down (Store SOP requirement).
2. **Maintenance-Free Docs:** When the UI changes, an Admin hits "Rebuild," and the OS updates its own manual. No developer time required.
3. **Rust Integrity:** Using Pagefind and Tauri Native capture aligns with the project's "Performance-First" Rust core.

---

## 6) Decision Requests
1. **Approval of Stagehand vs Playwright**: Stagehand is significantly lower maintenance for non-developers but requires a Browserbase/LLM API key.
2. **Site Location**: Should the built artifacts (`starlight/dist`) be served at `/api/help/browse` or bundled and opened in a native window?
3. **ROSIE Integration**: Confirm ROSIE has the necessary context to map arbitrary text descriptions to valid ROS route paths.

---
**Status:** Ready for Pilot implementation.
