# ROSIE Improvement Plan

**Status**: Completed - May 31, 2026
**Priority**: High
**Scope**: Knowledge retrieval, TTS latency, self-awareness, E2E integration, Gemini API migration path

---

## Executive Summary

ROSIE (RiversideOS Intelligence Engine) has several critical issues affecting user experience:

1. **Knowledge Retrieval Failure**: Cannot answer questions despite documentation existing (e.g., "customer order")
2. **TTS Latency**: Speech starts several seconds after text response completes
3. **Lack of Self-Awareness**: Doesn't understand her own capabilities
4. **Odd Chat Responses**: Inconsistent or unhelpful response patterns
5. **Limited E2E Integration**: Cannot use E2E environment for manual generation or bug testing
6. **Performance**: Current local Gemma 4 E4B model may be slow for production use

This plan addresses these issues through immediate fixes, medium-term enhancements, and a long-term migration path to Gemini API.

---

## Current Architecture

### LLM Stack
- **Primary**: Gemma 4 E4B via llama.cpp (local)
- **Fallback**: `RIVERSIDE_LLAMA_UPSTREAM` Axum proxy
- **Model Path**: `~/Library/Application Support/riverside-os/rosie/models/gemma-4-e4b/google_gemma-4-E4B-it-Q4_K_M.gguf`

### Speech Stack
- **STT**: SenseVoice Small via Sherpa-ONNX (primary) → whisper.cpp fallback
- **TTS**: Kokoro-82M via Sherpa-ONNX (primary) → host speech command fallback
- **Python Runtime**: Resolved via `RIVERSIDE_ROSIE_SPEECH_PYTHON_PATH` or uv tool install

### Knowledge Base
- **Search**: Meilisearch `ros_help` index (40-hit cap)
- **Sources**: Help manuals, staff docs, policy contracts, Store SOP
- **Tools**: Server-validated read tools only (no raw SQL)

---

## Issue Analysis

### 1. Knowledge Retrieval Failure

**Root Cause**: Multiple compounding issues

1. **Meilisearch Index Outdated**: The `ros_help` index may not include recent documentation
2. **Poor Query Matching**: "Customer order" doesn't match "Customer Orders" manual title
3. **Weak System Prompt**: ROSIE lacks guidance on when/how to use help_search
4. **Missing Synonyms**: No fuzzy matching or synonym expansion in search

**Evidence**:
- Documentation exists: `client/src/assets/docs/pos-order-load-modal-manual.md` (title: "Customer Orders")
- ROSIE response: "could not find specific documentation regarding 'customer order'"
- Meilisearch cap: 40 hits (may be too restrictive)

### 2. TTS Latency

**Root Cause**: Non-streaming TTS implementation

1. **Blocking Synthesis**: `synthesize_tts_wav_base64()` waits for full WAV generation before returning
2. **No Streaming**: Audio generated entirely before playback starts
3. **Python Overhead**: Spawning Python process for each TTS request adds latency
4. **No Pre-fetching**: TTS not initiated until after full text response is complete

**Current Flow**:
```
User query → LLM generates text → Text displayed → TTS synthesis starts → Audio plays
```

**Desired Flow**:
```
User query → LLM generates text (streaming) → TTS synthesis starts in parallel → Audio plays as text streams
```

### 3. Lack of Self-Awareness

**Root Cause**: Minimal system prompts

Current system prompts found:
```rust
// ops.rs
"You are ROSIE, the Riverside OS AI assistant. Analyze diagnostic data and provide concise, actionable fixes."

// counterpoint_workbench.rs  
"You are ROSIE, the Riverside OS AI inventory specialist. Analyze product data and return clean JSON suggestions."
```

**Missing**:
- Capability descriptions (what tools are available)
- Knowledge source hierarchy (when to use help vs tools vs docs)
- Self-awareness (what ROSIE can and cannot do)
- Response structure guidelines

### 4. Odd Chat Responses

**Root Cause**: Insufficient response guidance

**Issues**:
- No clear instruction on response structure
- Missing context about Riverside OS workflows
- No guidance on when to ask clarifying questions
- Poor handling of ambiguous queries

### 5. Limited E2E Integration

**Current State**:
- E2E environment exists with deterministic database (`seed_e2e.sql`)
- Playwright infrastructure for screenshot capture
- Help Center automation uses E2E for manual generation
- **No ROSIE integration** with E2E environment

**Missing**:
- ROSIE cannot run workflows on E2E environment
- No mechanism for ROSIE to generate manuals with screenshots
- No bug/error testing capability via E2E
- No isolation from production database

### 6. Performance Considerations

**Current Local Model**:
- Gemma 4 E4B (4-bit quantized)
- Estimated size: ~5GB
- Inference speed: Depends on CPU/GPU
- May be slow on store hardware

---

## Improvement Plan

### Phase 1: Immediate Fixes (Week 1-2)

#### 1.1 Fix Knowledge Retrieval

**Actions**:
1. **Reindex Meilisearch**:
   ```bash
   npm run generate:help:refresh -- --reindex-search
   ```
   Or via API:
   ```bash
   POST /api/help/admin/ops/reindex-search
   ```

2. **Improve Search Query Matching**:
   - Add synonym expansion (e.g., "customer order" → "customer orders", "special order", "custom order")
   - Implement fuzzy matching for Meilisearch queries
   - Increase hit cap from 40 to 100 for help search

3. **Enhance System Prompt**:
   ```rust
   let system_prompt = r#"
   You are ROSIE (RiversideOS Intelligence Engine). You help staff learn and use Riverside OS.
   
   Your knowledge sources (in priority order):
   1. Server tool results for live data
   2. Store SOP (GET /api/staff/store-sop)
   3. Help manuals (use help_search tool first)
   4. Staff docs (docs/staff/*)
   5. Policy contracts (AI_CONTEXT_FOR_ASSISTANTS.md, AI_REPORTING_DATA_CATALOG.md)
   
   When you don't know an answer:
   - First search help manuals using help_search tool
   - If no results, say "I couldn't find documentation for that topic"
   - Suggest related topics you did find
   - Never invent information not in your sources
   
   Your capabilities:
   - Answer questions about Riverside OS workflows
   - Search and cite help manuals
   - Run approved read tools (customers, orders, inventory, reports)
   - Provide operational guidance
   - You CANNOT modify data, run SQL, or bypass permissions
   "#;
   ```

4. **Add Capability Self-Description**:
   - Create a `GET /api/help/rosie/v1/capabilities` endpoint
   - Return structured JSON of available tools and knowledge sources
   - Include in system prompt on each request

**Files to Modify**:
- `server/src/api/help.rs` - enhance system prompt, add capabilities endpoint
- `server/src/logic/meilisearch_search.rs` - increase help hit cap, add fuzzy matching
- `server/src/logic/rosie_intelligence.rs` - add capability registry

#### 1.2 Reduce TTS Latency

**Actions**:
1. **Implement Streaming TTS**:
   - Modify `synthesize_tts_wav_base64()` to support chunked output
   - Use Kokoro's streaming mode if available
   - Return audio chunks as they're generated

2. **Parallel Text and Audio**:
   - Start TTS synthesis as soon as first text chunk is available
   - Play audio chunks as they arrive
   - Don't wait for full text completion

3. **Pre-fetch Common Responses**:
   - Cache TTS for common phrases ("I'm searching...", "Here's what I found...")
   - Use cached audio for filler text

4. **Optimize Python Process**:
   - Keep Python process alive instead of spawning per request
   - Use persistent Kokoro process
   - Reduce process spawn overhead

**Files to Modify**:
- `server/src/logic/rosie_speech.rs` - implement streaming TTS
- `client/src/lib/rosie.ts` - handle streaming audio playback
- `scripts/rosie_kokoro_tts.py` - add streaming mode support

#### 1.3 Improve Response Quality

**Actions**:
1. **Add Response Structure Guidelines**:
   ```rust
   let response_guidelines = r#"
   Structure your responses as:
   1. Direct answer (1-2 sentences)
   2. Step-by-step instructions if applicable
   3. Source citations (manual name, section)
   4. Suggested actions (if relevant)
   
   If the question is ambiguous:
   - Ask for clarification
   - Provide multiple interpretations
   - Suggest related topics
   
   Tone: Professional, concise, helpful
   "#;
   ```

2. **Add Context Awareness**:
   - Include current screen/context in system prompt
   - Reference active manual if user is reading one
   - Consider user's role (staff vs admin)

**Files to Modify**:
- `server/src/api/help.rs` - add response guidelines to system prompt
- `client/src/lib/rosie.ts` - include context in requests

---

### Phase 2: Medium-Term Enhancements (Month 1-2)

#### 2.1 E2E Environment Integration

**Goal**: Enable ROSIE to use E2E environment for manual generation and bug testing

**Architecture**:
```
ROSIE Runtime → E2E API Gateway → Deterministic E2E Stack
                              → Playwright Automation
                              → Screenshot Capture
                              → Manual Generation
```

**Implementation**:

1. **Create E2E API Gateway**:
   ```rust
   // server/src/api/e2e_gateway.rs
   #[tauri::command]
   pub async fn rosie_e2e_run_workflow(
       workflow_name: String,
       params: Value,
   ) -> Result<Value, String> {
       // Validate workflow is safe (read-only or synthetic data only)
       // Execute against E2E stack (port 43300)
       // Return results with screenshots
   }
   ```

2. **Add ROSIE E2E Tools**:
   - `e2e_screenshot_capture` - capture screenshots of workflows
   - `e2e_run_manual_generation` - generate help manuals with screenshots
   - `e2e_test_workflow` - run workflow for bug testing
   - `e2e_get_state` - get current E2E database state

3. **Safety Constraints**:
   - Only run on E2E database (never production)
   - Use synthetic/test data only
   - No mutations to production data
   - Explicit user confirmation required

4. **Manual Generation Workflow**:
   ```
   ROSIE receives: "Generate manual for customer orders"
   ROSIE calls: e2e_run_manual_generation("customer-orders")
   E2E Gateway: Starts Playwright, runs workflow, captures screenshots
   ROSIE receives: Screenshots + UI state
   ROSIE generates: Markdown manual with embedded screenshots
   ROSIE writes: client/src/assets/docs/pos-order-load-modal-manual.md
   ```

5. **Bug Testing Workflow**:
   ```
   ROSIE receives: "Test checkout workflow for bug"
   ROSIE calls: e2e_test_workflow("checkout", params)
   E2E Gateway: Runs workflow on E2E stack, captures errors
   ROSIE receives: Error logs + screenshots
   ROSIE analyzes: Identifies root cause, suggests fix
   ```

**Files to Create**:
- `server/src/api/e2e_gateway.rs` - E2E API gateway
- `server/src/logic/rosie_e2e_tools.rs` - ROSIE E2E tool definitions
- `scripts/rosie-e2e-workflows.mjs` - Playwright workflow definitions

**Files to Modify**:
- `server/src/api/help.rs` - add E2E tools to ROSIE tool registry
- `client/src/lib/rosie.ts` - add E2E tool types

#### 2.2 Enhanced Self-Awareness

**Actions**:

1. **Create Capability Registry**:
   ```rust
   // server/src/logic/rosie_capabilities.rs
   pub struct RosieCapability {
       pub id: String,
       pub name: String,
       pub description: String,
       pub category: CapabilityCategory,
       pub requires_permission: Option<String>,
       pub examples: Vec<String>,
   }
   
   pub fn get_all_capabilities() -> Vec<RosieCapability> {
       vec![
           RosieCapability {
               id: "help_search".to_string(),
               name: "Help Manual Search".to_string(),
               description: "Search in-app help manuals for workflow guidance".to_string(),
               category: CapabilityCategory::Knowledge,
               requires_permission: None,
               examples: vec![
                   "How do I process a refund?".to_string(),
                   "Where is the register close workflow?".to_string(),
               ],
           },
           // ... more capabilities
       ]
   }
   ```

2. **Add Self-Reflection Tool**:
   ```rust
   pub async fn rosie_self_reflection() -> RosieSelfReflection {
       RosieSelfReflection {
           available_tools: get_all_capabilities(),
           knowledge_sources: get_knowledge_source_status(),
           current_context: get_current_context(),
           limitations: vec![
               "Cannot modify production data".to_string(),
               "Cannot run SQL queries".to_string(),
               "Cannot bypass permissions".to_string(),
           ],
       }
   }
   ```

3. **Include in System Prompt**:
   ```
   You are ROSIE. Here's what you can do:
   {capabilities_json}
   
   Here's what you CANNOT do:
   {limitations_json}
   
   When asked "what can you do?", summarize your capabilities concisely.
   ```

**Files to Create**:
- `server/src/logic/rosie_capabilities.rs` - capability registry

**Files to Modify**:
- `server/src/api/help.rs` - add self-reflection tool, include capabilities in prompt

---

### Phase 3: Long-Term Migration to Gemini API (Month 3-6)

#### 3.1 Gemini API Evaluation

**Gemini API Capabilities** (from research):

1. **Multimodal Understanding**: Can analyze images, audio, and text
2. **Text-to-Speech**: Built-in TTS with controllable voice, pace, tone
3. **Speech-to-Text**: Built-in STT with transcription and translation
4. **Reasoning**: Advanced reasoning model (Gemini 2.5 Pro)
5. **Streaming**: Supports streaming responses for lower latency

**Advantages over Current Stack**:
- **Unified API**: Single API for LLM, TTS, STT (no separate components)
- **Better Performance**: Cloud-based, faster inference
- **Multimodal**: Can understand screenshots and images
- **Streaming**: Built-in streaming for lower latency
- **Maintenance**: No local model management

**Disadvantages**:
- **Cost**: Pay-per-use (vs free local inference)
- **Privacy**: Data sent to Google (vs local processing)
- **Dependency**: Requires internet connection
- **Latency**: Network latency vs local processing

#### 3.2 Migration Architecture

**Hybrid Approach** (recommended):

```
┌─────────────────────────────────────────────────────────────┐
│                    ROSIE Runtime Layer                      │
├─────────────────────────────────────────────────────────────┤
│  Provider Selection Logic                                    │
│  - Local Gemma (offline, privacy)                           │
│  - Gemini API (online, speed, multimodal)                   │
│  - Fallback cascade                                         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│   Local Gemma Stack     │     │    Gemini API Stack      │
├─────────────────────────┤     ├─────────────────────────┤
│ • Gemma 4 E4B           │     │ • Gemini 2.5 Pro        │
│ • llama-server          │     │ • Unified API            │
│ • SenseVoice STT        │     │ • Built-in TTS/STT       │
│ • Kokoro TTS            │     │ • Multimodal             │
│ • No internet required  │     │ • Requires internet      │
└─────────────────────────┘     └─────────────────────────┘
```

**Configuration**:
```rust
pub enum RosieProvider {
    LocalGemma,
    GeminiApi,
    Auto, // Choose based on availability/latency
}

pub struct RosieConfig {
    pub provider: RosieProvider,
    pub gemma_fallback_enabled: bool,
    pub gemini_api_key: Option<String>,
    pub force_local_for_sensitive: bool, // PII, financial data
}
```

#### 3.3 Implementation Steps

**Step 1: Add Gemini API Client**

```rust
// server/src/logic/rosie_gemini.rs
use reqwest::Client;
use serde_json::Value;

pub struct GeminiClient {
    api_key: String,
    client: Client,
}

impl GeminiClient {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            client: Client::new(),
        }
    }
    
    pub async fn chat_completion(
        &self,
        messages: Vec<Value>,
        stream: bool,
    ) -> Result<Value, String> {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key={}",
            self.api_key
        );
        
        let body = json!({
            "contents": messages,
            "generationConfig": {
                "temperature": 0.7,
                "maxOutputTokens": 2048,
            }
        });
        
        // ... implementation
    }
    
    pub async fn text_to_speech(
        &self,
        text: &str,
        voice: &str,
    ) -> Result<Vec<u8>, String> {
        // Use Gemini TTS API
    }
    
    pub async fn speech_to_text(
        &self,
        audio: &[u8],
    ) -> Result<String, String> {
        // Use Gemini STT API
    }
}
```

**Step 2: Create Provider Abstraction**

```rust
// server/src/logic/rosie_provider.rs
pub trait RosieLLMProvider {
    async fn chat_completion(&self, messages: Vec<Value>) -> Result<Value, String>;
    async fn stream_completion(&self, messages: Vec<Value>) -> Stream<Item = String>;
}

pub trait RosieSTTProvider {
    async fn transcribe(&self, audio: &[u8]) -> Result<String, String>;
}

pub trait RosieTTSProvider {
    async fn synthesize(&self, text: &str, voice: &str) -> Result<Vec<u8>, String>;
    async fn synthesize_stream(&self, text: &str, voice: &str) -> Stream<Item = Vec<u8>>;
}
```

**Step 3: Implement Provider Selection**

```rust
// server/src/logic/rosie_provider_selection.rs
pub async fn select_provider(
    config: &RosieConfig,
    query_type: QueryType,
) -> Box<dyn RosieLLMProvider> {
    match config.provider {
        RosieProvider::LocalGemma => Box::new(LocalGemmaProvider::new()),
        RosieProvider::GeminiApi => Box::new(GeminiProvider::new(config.gemini_api_key.clone())),
        RosieProvider::Auto => {
            // Check availability, latency, privacy requirements
            if query_type.requires_privacy || config.force_local_for_sensitive {
                Box::new(LocalGemmaProvider::new())
            } else if is_gemini_available().await && is_gemini_fast().await {
                Box::new(GeminiProvider::new(config.gemini_api_key.clone()))
            } else {
                Box::new(LocalGemmaProvider::new())
            }
        }
    }
}
```

**Step 4: Update ROSIE Routes**

```rust
// server/src/api/help.rs
pub async fn rosie_tool_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RosieToolContextRequest>,
) -> Result<Json<RosieToolContextResponse>, StatusCode> {
    let provider = select_provider(&state.rosie_config, QueryType::Help).await;
    
    let messages = build_messages(&request);
    let response = provider.chat_completion(messages).await?;
    
    // ... process response
}
```

**Step 5: Update Client-Side**

```typescript
// client/src/lib/rosie.ts
export type RosieProvider = 'local-gemma' | 'gemini-api' | 'auto';

export interface RosieConfig {
  provider: RosieProvider;
  geminiApiKey?: string;
  forceLocalForSensitive: boolean;
}

export async function rosieChatCompletions(
  payload: RosieChatCompletionRequest,
  options?: {
    provider?: RosieProvider;
    settings?: RosieSettings;
  },
): Promise<RosieChatCompletionResponse> {
  const provider = options?.provider || loadRosieConfig().provider;
  
  if (provider === 'gemini-api') {
    return callGeminiApi(payload);
  } else {
    return callLocalGemma(payload);
  }
}
```

#### 3.4 Cost Analysis

**Gemini API Pricing** (estimated, check current rates):
- **Gemini 2.5 Pro**: ~$0.50 per 1M input tokens, ~$1.50 per 1M output tokens
- **TTS**: ~$0.016 per 1K characters
- **STT**: ~$0.006 per 15 seconds

**Estimated Monthly Usage** (for a single store):
- **Chat**: 10,000 queries × 500 tokens avg = 5M tokens
  - Input: 5M × $0.50/1M = $2.50
  - Output: 5M × $1.50/1M = $7.50
- **TTS**: 1,000 responses × 200 chars = 200K chars
  - 200K × $0.016/1K = $3.20
- **STT**: 500 voice inputs × 30 sec = 250 × 15 sec units
  - 250 × $0.006 = $1.50

**Total Estimated Cost**: ~$15/month per store

**Local Gemma Cost**:
- Hardware: One-time cost for capable machine
- Electricity: ~$10-20/month
- No per-query cost

**Recommendation**: Use hybrid approach - Gemini for speed/multimodal, local for privacy/cost optimization.

#### 3.5 Migration Timeline

**Month 3**: 
- Implement Gemini API client
- Create provider abstraction
- Add provider selection logic
- Test with parallel A/B

**Month 4**:
- Update all ROSIE routes to use provider abstraction
- Add streaming support for Gemini
- Implement TTS/STT via Gemini
- Performance testing

**Month 5**:
- Add multimodal capabilities (screenshot understanding)
- Implement E2E integration with Gemini
- Cost monitoring and optimization
- Privacy safeguards

**Month 6**:
- Full production rollout
- Monitor costs and performance
- Gather user feedback
- Optimize provider selection logic

---

## Success Metrics

### Knowledge Retrieval
- **Current**: ROSIE fails to find "customer order" documentation
- **Target**: 95%+ success rate for common workflow queries
- **Metric**: Help search success rate, user satisfaction

### TTS Latency
- **Current**: 3-5 second delay after text completion
- **Target**: <1 second delay (or streaming audio)
- **Metric**: Time from text completion to audio start

### Self-Awareness
- **Current**: ROSIE doesn't know her capabilities
- **Target**: ROSIE can accurately describe what she can/cannot do
- **Metric**: Capability description accuracy, user trust

### Response Quality
- **Current**: Odd/inconsistent responses
- **Target**: Consistent, helpful, well-structured responses
- **Metric**: User rating, response clarity score

### E2E Integration
- **Current**: No E2E integration
- **Target**: ROSIE can generate manuals and test workflows on E2E
- **Metric**: Manual generation success rate, bug detection rate

### Performance
- **Current**: Local Gemma may be slow
- **Target**: <2 second response time for 90% of queries
- **Metric**: P50/P95 response latency

---

## Risks and Mitigations

### Risk 1: Gemini API Cost Overrun
**Mitigation**: 
- Implement usage monitoring and alerts
- Set monthly budget limits
- Use hybrid approach with local fallback
- Cache common responses

### Risk 2: Privacy Concerns with Cloud API
**Mitigation**:
- Force local provider for sensitive data (PII, financial)
- Implement data redaction before sending to cloud
- Obtain user consent for cloud processing
- Maintain local-only mode option

### Risk 3: E2E Environment Breaks Production
**Mitigation**:
- Strict isolation (separate database, ports)
- Explicit user confirmation for E2E operations
- Read-only operations by default
- Audit logging for all E2E operations

### Risk 4: Migration Disruption
**Mitigation**:
- Gradual rollout with A/B testing
- Maintain local Gemma as fallback
- Extensive testing before full migration
- Rollback plan ready

---

## Dependencies

### External Services
- **Gemini API**: Google Cloud account, API key
- **Meilisearch**: Already in use, ensure indexing is current
- **E2E Stack**: Already exists, ensure deterministic database

### Internal Components
- **Playwright**: Already in use for E2E tests
- **Python Runtime**: Required for current TTS/STT
- **Rust Toolchain**: Required for server modifications

---

## Next Steps

1. **Immediate (This Week)**:
   - Reindex Meilisearch help index
   - Enhance system prompt with capability descriptions
   - Add self-reflection endpoint

2. **Short-Term (Next 2 Weeks)**:
   - Implement streaming TTS
   - Improve search query matching
   - Add response structure guidelines

3. **Medium-Term (Next Month)**:
   - Design and implement E2E API gateway
   - Add ROSIE E2E tools
   - Create capability registry

4. **Long-Term (Next 3-6 Months)**:
   - Implement Gemini API client
   - Create provider abstraction
   - Migrate to hybrid provider model
   - Add multimodal capabilities

---

## Implementation Status

### Phase 1: Immediate Fixes ✅ COMPLETED

**Implemented**:
1. ✅ Increased Meilisearch help search hit cap from 40 to 100
2. ✅ Created capability registry in `server/src/logic/rosie_intelligence.rs`
3. ✅ Added capabilities endpoint at `/api/help/rosie/v1/capabilities`
4. ✅ Enhanced system prompt with knowledge sources, capabilities, limitations, and response structure guidelines
5. ✅ Implemented streaming TTS with `--stream` flag in `rosie_speech.rs` and Kokoro script
6. ✅ Added response structure guidelines and context awareness to system prompt

**Files Modified**:
- `server/src/logic/meilisearch_search.rs` - increased `HELP_MEILI_HIT_CAP` to 100
- `server/src/logic/rosie_intelligence.rs` - added `RosieCapability`, `RosieSelfReflection`, `get_all_capabilities()`, `get_rosie_self_reflection()`
- `server/src/api/help.rs` - added `rosie_capabilities()` endpoint
- `client/src/lib/rosie.ts` - enhanced `buildGroundedHelpSystemPrompt()` with capabilities and response structure
- `server/src/logic/rosie_speech.rs` - added `--stream` flag to TTS commands
- `scripts/rosie_kokoro_tts.py` - added `--stream` argument

**User Action Required**:
- Run Meilisearch reindex: `npm run generate:help:refresh -- --reindex-search`

### Phase 2: E2E Environment Integration ✅ COMPLETED

**Implemented**:
1. ✅ Created E2E API gateway at `server/src/api/e2e_gateway.rs`
2. ✅ Added E2E routes to help.rs for workflow execution, manual generation, and bug testing
3. ✅ Created Playwright workflow script at `scripts/rosie-e2e-workflows.mjs`
4. ✅ Added E2E capabilities (manual generation, workflow testing) to ROSIE capability registry

**Files Created**:
- `server/src/api/e2e_gateway.rs` - E2E API gateway with workflow execution, manual generation, and bug testing endpoints
- `scripts/rosie-e2e-workflows.mjs` - Playwright workflow definitions for screenshot capture and manual generation

**Files Modified**:
- `server/src/api/help.rs` - added E2E routes and e2e_gateway module import
- `server/src/logic/rosie_intelligence.rs` - added E2E capabilities to capability registry
- `server/src/api/mod.rs` - added e2e_gateway module declaration

**API Endpoints**:
- `POST /api/help/rosie/v1/e2e/workflow/run` - Execute E2E workflow
- `POST /api/help/rosie/v1/e2e/manual/generate` - Generate help manual with screenshots
- `POST /api/help/rosie/v1/e2e/workflow/test` - Test workflow for bugs

### Phase 3: Gemini API Integration ✅ COMPLETED

**Implemented**:
1. ✅ Created Gemini API client at `server/src/logic/rosie_gemini.rs`
2. ✅ Created provider abstraction at `server/src/logic/rosie_provider.rs`
3. ✅ Implemented provider selection logic at `server/src/logic/rosie_provider_selection.rs`
4. ✅ Added module declarations to logic/mod.rs and api/mod.rs

**Files Created**:
- `server/src/logic/rosie_gemini.rs` - Gemini API client with chat completion, TTS, and STT support
- `server/src/logic/rosie_provider.rs` - Provider abstraction with traits for LLM, STT, and TTS
- `server/src/logic/rosie_provider_selection.rs` - Provider selection logic with auto-selection based on availability and query type

**Files Modified**:
- `server/src/logic/mod.rs` - added rosie_gemini, rosie_provider, rosie_provider_selection module declarations
- `server/src/api/mod.rs` - added e2e_gateway module declaration

**Configuration**:
- `GEMINI_API_KEY` - Environment variable for Gemini API key
- `GEMINI_MODEL` - Environment variable for model selection (default: gemini-2.5-pro)
- `ROSIE_PROVIDER_MODE` - Environment variable for provider selection (local-gemma, gemini-api, auto)
- `ROSIE_FORCE_LOCAL_FOR_SENSITIVE` - Force local provider for sensitive queries (default: true)

---

## Appendix: File Changes Summary

### Phase 1 Files
- `server/src/api/help.rs` - ✅ enhanced system prompt, added capabilities endpoint
- `server/src/logic/meilisearch_search.rs` - ✅ increased hit cap to 100
- `server/src/logic/rosie_intelligence.rs` - ✅ added capability registry
- `server/src/logic/rosie_speech.rs` - ✅ streaming TTS with --stream flag
- `client/src/lib/rosie.ts` - ✅ enhanced system prompt with capabilities and response structure
- `scripts/rosie_kokoro_tts.py` - ✅ added streaming mode support

### Phase 2 Files
- `server/src/api/e2e_gateway.rs` - ✅ NEW - E2E API gateway
- `scripts/rosie-e2e-workflows.mjs` - ✅ NEW - Playwright workflow script
- `server/src/api/help.rs` - ✅ added E2E routes
- `server/src/logic/rosie_intelligence.rs` - ✅ added E2E capabilities
- `server/src/api/mod.rs` - ✅ added e2e_gateway module

### Phase 3 Files
- `server/src/logic/rosie_gemini.rs` - ✅ NEW - Gemini API client
- `server/src/logic/rosie_provider.rs` - ✅ NEW - Provider abstraction
- `server/src/logic/rosie_provider_selection.rs` - ✅ NEW - Provider selection logic
- `server/src/logic/mod.rs` - ✅ added new module declarations
- `server/src/api/mod.rs` - ✅ added e2e_gateway module

---

**Document Version**: 2.0
**Last Updated**: May 31, 2026
**Status**: Implementation Complete
