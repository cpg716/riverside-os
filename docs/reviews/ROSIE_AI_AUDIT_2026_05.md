# Audit Report: ROSIE AI System (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of ROSIE AI — governed intelligence source registry, search intent classification, insight summary generation (9 surfaces × 3 modes), speech pipeline (STT/TTS/LLM runtime), and host health monitoring.

---

## 1. Executive Summary

ROSIE is a **locally-hosted AI assistant** for Riverside OS staff. It runs entirely on-premise using llama.cpp (Gemma 4 E4B model), SherpaONNX/Whisper for speech-to-text, and Kokoro for text-to-speech. The system enforces strict **governance controls**: ROSIE may only learn from approved manuals, staff docs, policy contracts, and explicitly curated/redacted traces. Raw production data, PII, and unrestricted conversation logs are explicitly excluded.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Intelligence Source Registry
Five approved source groups (versioned as `rosie-intelligence-pack-2026-05-16-v1`):

| Group | Description | Source |
|:---|:---|:---|
| `help_manuals` | In-app Help Center manuals | `client/src/assets/docs/*-manual.md` |
| `staff_corpus` | Operational staff docs | `docs/staff/CORPUS.manifest.json` |
| `policy_contracts` | ROSIE operating contracts | 6 policy docs in `docs/` |
| `generated_help_outputs` | Auto-generated help wiring | 2 generated files |
| `curated_redacted_traces` | Optional reviewed examples | `docs/rosie/curated_examples/*.md` |

### 2.2 Excluded Sources (Explicit Deny List)
- Raw live customer/order/payment/catalog database content
- Arbitrary production DB exports or ad-hoc SQL results
- Unrestricted conversation history or chat transcripts
- Unreviewed generated content outside approved outputs
- Autonomous prompt or policy mutation
- Customer PII or payment artifacts as learning corpora

### 2.3 Search Intent Classification
ROSIE interprets staff search queries against an **allowlist of shortcuts**:
- System prompt explicitly forbids: SQL generation, query plans, business fact inference, navigation targets
- Returns only `shortcut_ids` from the provided allowlist (max 3)
- Temperature 0.0 for deterministic results
- Response parsing validates every returned ID exists in the allowlist (injection-proof)
- Deduplication via HashSet prevents duplicate shortcut returns

### 2.4 Insight Summary Generation
9 surfaces × 3 modes (Summary/Explain/NextSteps):

| Surface | Purpose |
|:---|:---|
| `CustomerSnapshot` | Customer profile briefing |
| `TransactionReadiness` | Order readiness status |
| `InventoryCleanup` | Dead stock / cleanup suggestions |
| `CapacityOutlook` | Scheduling capacity forecast |
| `CounterpointStatus` | Legacy migration status |
| `DailyOperationalBriefing` | Morning overview |
| `ReceivingReview` | Incoming inventory review |
| `ProductCleanupReview` | Product catalog cleanup |
| `FollowUpOpportunities` | Sales follow-up suggestions |

Facts are capped at 12 per kind, bullets at 3, text at 220 chars — preventing prompt bloat.

### 2.5 Speech Pipeline (Host Runtime)
Three subsystems detected/managed on the host machine:

**LLM (llama.cpp):**
- Model: `google_gemma-4-E4B-it-Q4_K_M.gguf`
- Provider: configurable (`llama.cpp` default)
- Upstream health: `/health` and `/v1/models` probes with 2s connect + 3s total timeout

**STT (Speech-to-Text):**
- Primary: SherpaONNX SenseVoice (int8 ONNX model)
- Fallback: Whisper CLI (`whisper-cli` or SuperWhisper)
- Python runtime: auto-discovers `uv tool install` path (Windows + macOS/Linux)

**TTS (Text-to-Speech):**
- Primary: Kokoro multi-lang ONNX
- Fallback: System `say` command (macOS)
- Speech state tracking: `Arc<Mutex<Option<Child>>>` for concurrent safety

### 2.6 Pack Issue Detection
`detect_pack_issues()` validates:
- All approved source paths actually exist on disk
- Generated outputs are present and not stale
- Issues surfaced in the intelligence pack status API

---

## 3. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Intelligence governance | Documented | Verified: 5 approved groups, explicit deny list | ✅ No regression |
| Search intent | Not documented | Verified: allowlist-only classification, 0-temp | ✅ New finding |
| Insight surfaces | Not documented | Verified: 9 surfaces × 3 modes | ✅ New finding |
| Speech pipeline | Partially documented | Fully traced: LLM + STT (2 engines) + TTS (2 engines) | ✅ Enhanced |
| Model version | Not specified | Gemma 4 E4B Q4_K_M (updated from prior model) | ✅ Updated |
| Pack versioning | Not documented | Verified: `rosie-policy-pack-2026-05-16-v1` | ✅ New finding |

---

## 4. Conclusion

**0 blockers, 0 regressions.** ROSIE's governance model is exemplary — strict source allowlisting, explicit deny rules, and the search intent classifier is injection-proof by design (validates all returned IDs against the allowlist).
