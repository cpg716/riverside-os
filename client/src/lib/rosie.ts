import { invoke, isTauri } from "@tauri-apps/api/core";
import { getBaseUrl } from "./apiConfig";

export type RosieVerbosity = "concise" | "detailed";

export type RosieSettings = {
  enabled: boolean;
  local_first: boolean;
  response_style: RosieVerbosity;
  show_citations: boolean;
  voice_enabled: boolean;
  speak_responses: boolean;
  selected_voice: string;
  speech_rate: number;
  microphone_enabled: boolean;
  microphone_mode: "push_to_talk" | "toggle";
  cost_comparison_provider: string;
  cost_comparison_model: string;
  external_input_cost_per_1m_tokens: number;
  external_output_cost_per_1m_tokens: number;
};

export type RosieChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type RosieChatCompletionRequest = {
  model?: string;
  messages: RosieChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  reasoning?: boolean;
  chat_template_kwargs?: {
    enable_thinking?: boolean;
    [key: string]: unknown;
  };
};

export type RosieChatCompletionResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  answer?: string;
  content?: string;
  response?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    text?: string;
    content?: string;
    message?: {
      role?: string;
      text?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: Record<string, unknown>;
};

export type RosieHelpGroundingSource = {
  kind:
    | "manual"
    | "store_sop"
    | "report"
    | "order"
    | "customer"
    | "wedding"
    | "inventory"
    | "catalog"
    | "rosie_read_tool"
    | "workflow";
  title: string;
  excerpt: string;
  content: string;
  manual_id?: string;
  manual_title?: string;
  section_slug?: string;
  section_heading?: string;
  anchor_id?: string;
  report_spec_id?: string;
  report_route?: string;
  route?: string;
  entity_id?: string;
};

export type RosieGroundedHelpRequest = {
  question: string;
  mode?: "help" | "conversation";
  settings: Pick<RosieSettings, "enabled" | "response_style" | "show_citations">;
  client_context?: RosieClientContext;
};

export type RosieGroundedHelpResponse = {
  answer: string;
  sources: RosieHelpGroundingSource[];
  tool_results: RosieToolResult[];
  suggested_actions: RosieSuggestedAction[];
  completion: RosieChatCompletionResponse;
};

export type RosieClientContext = {
  current_surface?: string;
  active_manual_id?: string;
  active_manual_title?: string;
  active_customer_id?: string;
  active_transaction_id?: string;
  active_inventory_variant_id?: string;
  last_user_question?: string;
  last_assistant_summary?: string;
};

export type RosieSuggestedAction = {
  id: string;
  label: string;
  description: string;
  target: string;
};

export type RosieToolResult = {
  tool_name:
    | "help_corpus_review"
    | "rosie_knowledge_retrieval"
    | "help_manual_section"
    | "store_sop_get"
    | "client_workflow_context"
    | "operational_playbook"
    | "reporting_run"
    | "order_summary"
    | "customer_hub_snapshot"
    | "wedding_actions"
    | "inventory_variant_intelligence"
    | "rosie_read_tool"
    | "rosie_tool_planner"
    | "product_catalog_analyze"
    | "product_catalog_suggest";
  args: Record<string, unknown>;
  result: unknown;
};

export type RosieInsightSurface =
  | "customer_snapshot"
  | "transaction_readiness"
  | "inventory_cleanup"
  | "capacity_outlook"
  | "counterpoint_status"
  | "daily_operational_briefing"
  | "receiving_review"
  | "product_cleanup_review"
  | "follow_up_opportunities"
  | "register_close_review"
  | "qbo_staging_review"
  | "rms_charge_review"
  | "wedding_readiness_review";

export type RosieInsightMode = "summary" | "explain" | "next_steps";

export type RosieInsightFacts = {
  title: string;
  bullets?: { id: string; label: string; severity?: string }[];
  metrics?: { id: string; label: string; value: string; tone?: string }[];
  warnings?: string[];
  disclaimers?: string[];
};

export type RosieInsightSummaryRequest = {
  surface: RosieInsightSurface;
  mode: RosieInsightMode;
  facts: RosieInsightFacts;
  allowed_actions?: { id: string; label: string; target: string }[];
};

export type RosieInsightSummaryResponse = {
  status: "available" | "unavailable";
  bullets: { text: string; source_fact_ids: string[]; tone?: string }[];
  suggested_actions?: { id: string; label: string }[];
};

export type RosieSearchShortcutId =
  | "open_orders"
  | "inventory_cleanup"
  | "alterations_queue"
  | "pickup_queue"
  | "daily_sales";

export type RosieSearchIntentRequest = {
  query: string;
  available_shortcuts: {
    id: RosieSearchShortcutId;
    label: string;
    description: string;
  }[];
  deterministic_context?: {
    exact_sku_found?: boolean;
    result_counts?: Partial<
      Record<
        "customers" | "orders" | "products" | "shipments" | "weddings" | "alterations",
        number
      >
    >;
  };
};

export type RosieSearchIntentResponse = {
  status: "available" | "unavailable";
  shortcut_ids: RosieSearchShortcutId[];
};

export type RosieProductCatalogParsedFields = {
  vendor?: string | null;
  brand?: string | null;
  supplier_code?: string | null;
  product_type?: string | null;
  color?: string | null;
  size?: string | null;
  fit?: string | null;
};

export type RosieProductCatalogAnalysisResponse = {
  tool_name: "product_catalog_analyze";
  product_id: string;
  product_name: string;
  source_route: string;
  parsed_fields: RosieProductCatalogParsedFields;
  issues_detected: string[];
  confidence_score: number;
  unresolved_parts: string[];
};

export type RosieProductCatalogSuggestedVariantFields = {
  color?: string | null;
  size?: string | null;
  fit?: string | null;
};

export type RosieProductCatalogSuggestionResponse = {
  tool_name: "product_catalog_suggest";
  product_id: string;
  product_name: string;
  source_route: string;
  suggested_parent_title?: string | null;
  suggested_variant_fields: RosieProductCatalogSuggestedVariantFields;
  suggestion_issues: string[];
  suggestion_confidence: number;
  unresolved_parts: string[];
};

export type RosieToolContextResponse = {
  question: string;
  settings: Pick<RosieSettings, "enabled" | "response_style" | "show_citations">;
  sources: RosieHelpGroundingSource[];
  tool_results: RosieToolResult[];
  suggested_actions: RosieSuggestedAction[];
};

type RosieReadToolResponseLike = {
  basis?: string;
  filters_applied?: Record<string, unknown>;
  row_count?: number;
  limited?: boolean;
  warnings?: string[];
  data_freshness?: string;
  data?: unknown[];
};

export type RosieIntelligenceSourceGroup = {
  key: string;
  label: string;
  description: string;
  source_count: number;
  source_paths: string[];
};

export type RosieIntelligenceIssue = {
  path: string;
  issue: string;
};

export type RosieIntelligencePack = {
  policy_pack_version: string;
  intelligence_pack_version: string;
  approved_source_groups: RosieIntelligenceSourceGroup[];
  excluded_source_rules: string[];
  issues_detected: RosieIntelligenceIssue[];
  last_generated_at?: string | null;
};

export type RosieIntelligenceStatus = {
  pack: RosieIntelligencePack;
  last_reindex_at?: string | null;
  meilisearch_configured: boolean;
  node_available: boolean;
  refresh_capabilities: {
    generate_help_manifest: boolean;
    reindex_search: boolean;
  };
};

export type RosieIntelligenceRefreshResponse = {
  status: RosieIntelligenceStatus;
  generate_manifest?: {
    ok: boolean;
    exit_code?: number | null;
    stdout: string;
    stderr: string;
  } | null;
  reindex_search?: {
    ok: boolean;
    exit_code?: number | null;
    stdout: string;
    stderr: string;
  } | null;
  dry_run: boolean;
};

export type RosieVoiceCapabilities = {
  speech_to_text_supported: boolean;
  text_to_speech_supported: boolean;
};

export type RosieLocalRuntimeStatus = {
  llm: {
    runtime_name: string;
    provider: string;
    deployment_kind?: string;
    base_url: string;
    host: string;
    port: string;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    sidecar_binary_present: boolean;
    running: boolean;
    available?: boolean;
    unavailable_reason?: string | null;
    context_hint?: string | null;
    api_key_configured?: boolean | null;
  };
  stt: {
    engine_name: string;
    provider: string;
    deployment_kind?: string;
    active_engine: string;
    cli_path: string;
    cli_present: boolean;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    available?: boolean;
    unavailable_reason?: string | null;
    api_key_configured?: boolean | null;
  };
  tts: {
    engine_name: string;
    provider: string;
    deployment_kind?: string;
    active_engine: string;
    command_path: string;
    command_present: boolean;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    speaking: boolean;
    available?: boolean;
    unavailable_reason?: string | null;
    api_key_configured?: boolean | null;
  };
};

export type RosieVoiceCaptureCallbacks = {
  on_start?: () => void;
  on_partial_transcript?: (value: string) => void;
  on_final_transcript?: (value: string) => void;
  on_error?: (message: string) => void;
  on_end?: () => void;
};

export type RosieVoiceCaptureSession = {
  stop: () => void;
};

export type RosieSpeechPlayback = {
  stop: () => void;
};

const ROSIE_SETTINGS_STORAGE_KEY = "ros.rosie.settings.v1";
const ROSIE_KOKORO_VOICE_COUNT = 53;
const ROSIE_OPTIONAL_INSIGHT_TIMEOUT_MS = 120_000;

export const DEFAULT_ROSIE_VOICE = "5";

export const ROSIE_VOICE_TEST_SENTENCE =
  "Hello, I am ROSIE. This is the selected Kokoro voice preview for Riverside OS.";

export const ROSIE_KOKORO_VOICE_OPTIONS = [
  { value: "5", label: "ROSIE Classic" },
  { value: "6", label: "ROSIE Calm" },
  { value: "7", label: "ROSIE Bright" },
  { value: "8", label: "ROSIE Clear" },
] as const;

const ROSIE_KOKORO_VOICE_VALUES = new Set<string>(
  ROSIE_KOKORO_VOICE_OPTIONS.map((voice) => voice.value),
);

const ROSIE_LEGACY_VOICE_ALIASES: Record<string, string> = {
  adam: "5",
  michael: "6",
  emma: "7",
  isabella: "8",
};

export function rosieVoiceLabel(voiceValue: string | null | undefined): string {
  return (
    ROSIE_KOKORO_VOICE_OPTIONS.find((voice) => voice.value === voiceValue)?.label ??
    ROSIE_KOKORO_VOICE_OPTIONS.find((voice) => voice.value === DEFAULT_ROSIE_VOICE)?.label ??
    "ROSIE Classic"
  );
}

function normalizeRosieVoice(rawVoice: unknown): string {
  if (typeof rawVoice !== "string") {
    return DEFAULT_ROSIE_VOICE;
  }
  const normalized = rawVoice.trim().toLowerCase();
  if (normalized in ROSIE_LEGACY_VOICE_ALIASES) {
    return ROSIE_LEGACY_VOICE_ALIASES[
      normalized as keyof typeof ROSIE_LEGACY_VOICE_ALIASES
    ];
  }
  if (/^\d+$/.test(normalized)) {
    const numericVoice = Number(normalized);
    if (
      Number.isInteger(numericVoice) &&
      numericVoice >= 0 &&
      numericVoice < ROSIE_KOKORO_VOICE_COUNT
    ) {
      const voiceValue = String(numericVoice);
      return ROSIE_KOKORO_VOICE_VALUES.has(voiceValue)
        ? voiceValue
        : DEFAULT_ROSIE_VOICE;
    }
  }
  return DEFAULT_ROSIE_VOICE;
}

export const DEFAULT_ROSIE_SETTINGS: RosieSettings = {
  enabled: true,
  local_first: true,
  response_style: "concise",
  show_citations: true,
  voice_enabled: true,
  speak_responses: false,
  selected_voice: DEFAULT_ROSIE_VOICE,
  speech_rate: 1,
  microphone_enabled: true,
  microphone_mode: "push_to_talk",
  cost_comparison_provider: "custom_external_api",
  cost_comparison_model: "set_model_in_settings",
  external_input_cost_per_1m_tokens: 0,
  external_output_cost_per_1m_tokens: 0,
};

function normalizeRosieSettings(raw: unknown): RosieSettings {
  const source = typeof raw === "object" && raw !== null ? raw as Partial<RosieSettings> : {};
  const legacy = source as Partial<RosieSettings> & {
    direct_mode_enabled?: boolean;
    verbosity?: RosieVerbosity;
    voice_input_enabled?: boolean;
    voice_output_enabled?: boolean;
    speak_replies?: boolean;
  };
  const rawSpeechRate =
    typeof source.speech_rate === "number" ? source.speech_rate : Number(source.speech_rate);
  const speechRate =
    Number.isFinite(rawSpeechRate) && rawSpeechRate >= 0.8 && rawSpeechRate <= 1.2
      ? Math.round(rawSpeechRate * 10) / 10
      : 1;
  const microphoneMode =
    source.microphone_mode === "toggle" ? "toggle" : "push_to_talk";
  const inputCost = Number(source.external_input_cost_per_1m_tokens);
  const outputCost = Number(source.external_output_cost_per_1m_tokens);
  return {
    enabled: source.enabled !== false,
    local_first: source.local_first ?? legacy.direct_mode_enabled ?? true,
    response_style:
      (source.response_style ?? legacy.verbosity) === "detailed" ? "detailed" : "concise",
    show_citations: source.show_citations !== false,
    voice_enabled: source.voice_enabled ?? legacy.voice_output_enabled ?? true,
    speak_responses: source.speak_responses ?? legacy.speak_replies ?? false,
    selected_voice: normalizeRosieVoice(source.selected_voice),
    speech_rate: speechRate,
    microphone_enabled: source.microphone_enabled ?? legacy.voice_input_enabled ?? true,
    microphone_mode: microphoneMode,
    cost_comparison_provider:
      typeof source.cost_comparison_provider === "string" &&
      source.cost_comparison_provider.trim().length > 0
        ? source.cost_comparison_provider.trim()
        : "custom_external_api",
    cost_comparison_model:
      typeof source.cost_comparison_model === "string" &&
      source.cost_comparison_model.trim().length > 0
        ? source.cost_comparison_model.trim()
        : "set_model_in_settings",
    external_input_cost_per_1m_tokens:
      Number.isFinite(inputCost) && inputCost >= 0 ? inputCost : 0,
    external_output_cost_per_1m_tokens:
      Number.isFinite(outputCost) && outputCost >= 0 ? outputCost : 0,
  };
}

export function loadLocalRosieSettings(): RosieSettings {
  if (typeof window === "undefined") return DEFAULT_ROSIE_SETTINGS;
  try {
    const raw = window.localStorage.getItem(ROSIE_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_ROSIE_SETTINGS;
    return normalizeRosieSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_ROSIE_SETTINGS;
  }
}

function createRosieOptionalTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => globalThis.clearTimeout(timeoutId),
  };
}

export function saveLocalRosieSettings(settings: RosieSettings): RosieSettings {
  const normalized = normalizeRosieSettings(settings);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      ROSIE_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  }
  return normalized;
}

export function mergeRosieSettings(
  localSettings?: Partial<RosieSettings> | null,
  storeDefaults?: Partial<RosieSettings> | null,
): RosieSettings {
  return normalizeRosieSettings({
    ...DEFAULT_ROSIE_SETTINGS,
    ...(storeDefaults ?? {}),
    ...(localSettings ?? {}),
  });
}

function rosieDirectEnabled(): boolean {
  const flag = import.meta.env.VITE_ROSIE_LLM_DIRECT;
  if (typeof flag !== "string") return true;
  const normalized = flag.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
}

function rosieDirectTransportAllowed(settings: RosieSettings): boolean {
  return isTauri() && settings.local_first && rosieDirectEnabled();
}

type BrowserSpeechRecognitionAlternative = {
  transcript: string;
};

type BrowserSpeechRecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
};

type BrowserSpeechRecognitionResultList = {
  length: number;
  [index: number]: BrowserSpeechRecognitionResult;
};

type BrowserSpeechRecognitionEvent = {
  resultIndex: number;
  results: BrowserSpeechRecognitionResultList;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onstart: null | (() => void);
  onresult: null | ((event: BrowserSpeechRecognitionEvent) => void);
  onerror: null | ((event: { error?: string }) => void);
  onend: null | (() => void);
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
    __ROSIE_TEST_HOST_WAV_BASE64__?: string;
  }
}

type RosieRequestOptions = {
  headers?: Record<string, string>;
};

let activeRosieSpeechPoller: number | null = null;
let activeRosieSpeechAudio: HTMLAudioElement | null = null;

function getSpeechRecognitionConstructor():
  | BrowserSpeechRecognitionConstructor
  | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function getBrowserRosieVoiceCapabilities(): RosieVoiceCapabilities {
  if (typeof window === "undefined") {
    return {
      speech_to_text_supported: false,
      text_to_speech_supported: false,
    };
  }

  return {
    speech_to_text_supported:
      navigator.mediaDevices?.getUserMedia != null ||
      getSpeechRecognitionConstructor() != null,
    text_to_speech_supported: false,
  };
}

function rosieVoiceApiUrl(path: string): string {
  return `${getBaseUrl()}/api/help/rosie/v1${path}`;
}

async function fetchRosieVoiceJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(rosieVoiceApiUrl(path), init);
  const json = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(
      typeof json.error === "string"
        ? json.error
        : `ROSIE voice request to ${path} failed with HTTP ${response.status}`,
    );
  }
  return json;
}

export async function getRosieLocalRuntimeStatus(
  options?: RosieRequestOptions,
): Promise<RosieLocalRuntimeStatus | null> {
  try {
    return await fetchRosieVoiceJson<RosieLocalRuntimeStatus>("/runtime-status", {
      headers: options?.headers,
    });
  } catch (error) {
    if (!isTauri()) {
      throw error;
    }
  }

  return invoke<RosieLocalRuntimeStatus>("rosie_local_runtime_status");
}

export async function getRosieVoiceCapabilities(
  options?: RosieRequestOptions,
): Promise<RosieVoiceCapabilities> {
  try {
    const runtime = await getRosieLocalRuntimeStatus(options);
    return {
      speech_to_text_supported:
        runtime != null &&
        (runtime.stt.available ?? runtime.stt.active_engine !== "unavailable"),
      text_to_speech_supported:
        runtime != null &&
        (runtime.tts.available ?? runtime.tts.active_engine !== "unavailable"),
    };
  } catch {
    return getBrowserRosieVoiceCapabilities();
  }
}

function rosieRuntimeProviderIsLocal(runtime: RosieLocalRuntimeStatus): boolean {
  const provider = runtime.llm.provider.trim().toLowerCase();
  return (
    (runtime.llm.deployment_kind == null || runtime.llm.deployment_kind === "local") &&
    ["local", "local_llm", "local-gemma", "local_gemma", "llama.cpp"].includes(provider)
  );
}

function rosieRuntimeUsesServerGovernedTransport(
  runtime: RosieLocalRuntimeStatus | null,
): boolean {
  if (!runtime) return false;
  const provider = runtime.llm.provider.trim().toLowerCase();
  return (
    ["remote_lmstudio", "remote-lmstudio", "openai", "gemini"].includes(provider) ||
    runtime.llm.deployment_kind === "cloud" ||
    runtime.llm.deployment_kind === "private_remote"
  );
}

async function ensureRosieLocalLlmRunning(): Promise<void> {
  if (!isTauri()) return;
  const runtime = await getRosieLocalRuntimeStatus();
  if (!runtime) return;
  if (!rosieRuntimeProviderIsLocal(runtime)) return;
  if (!runtime.llm.sidecar_binary_present) {
    throw new Error("ROSIE local runtime is not installed for this desktop shell.");
  }
  if (!runtime.llm.model_present) {
    throw new Error(
      "ROSIE local model is not configured. Set RIVERSIDE_LLAMA_MODEL_PATH or install the pinned local model.",
    );
  }
  if (!runtime.llm.running) {
    await invoke("rosie_llama_start");
  }
}

function floatTo16BitPCM(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(offset, floatTo16BitPCM(samples[index]), true);
    offset += 2;
  }

  return new Uint8Array(buffer);
}

function arrayBufferToBase64(buffer: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < buffer.length; index += chunkSize) {
    const chunk = buffer.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function transcribeCapturedAudio(chunks: Float32Array[], sampleRate: number): Promise<string> {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const wavPayload = encodeWav(merged, sampleRate);
  return arrayBufferToBase64(wavPayload);
}

async function requestHostTranscription(
  audioBase64: string,
  options?: RosieRequestOptions,
): Promise<string> {
  const response = await fetchRosieVoiceJson<{ transcript: string }>("/voice/transcribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify({
      audio_base64: audioBase64,
    }),
  });
  return response.transcript;
}

function startHostRosieVoiceCapture(
  callbacks: RosieVoiceCaptureCallbacks,
  options?: RosieRequestOptions,
): RosieVoiceCaptureSession {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Voice input is unavailable on this workstation.");
  }

  const seededWav = window.__ROSIE_TEST_HOST_WAV_BASE64__;
  if (seededWav) {
    let ended = false;
    callbacks.on_start?.();
    return {
      stop: () => {
        if (ended) return;
        ended = true;
        callbacks.on_end?.();
        void requestHostTranscription(seededWav, options)
          .then((transcript) => {
            callbacks.on_final_transcript?.(transcript);
          })
          .catch((error) => {
            callbacks.on_error?.(
              error instanceof Error
                ? error.message
                : "ROSIE voice input could not transcribe that request.",
            );
          });
      },
    };
  }

  let ended = false;
  let audioContext: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let stream: MediaStream | null = null;
  let chunks: Float32Array[] = [];

  const finish = async () => {
    if (ended) return;
    ended = true;
    try {
      processor?.disconnect();
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      await audioContext?.close();
    } catch {
      // noop
    }
    callbacks.on_end?.();
    if (chunks.length === 0) {
      callbacks.on_error?.("No speech was detected. Try again when you are ready.");
      return;
    }
    try {
      const audioBase64 = await transcribeCapturedAudio(
        chunks,
        audioContext?.sampleRate ?? 44100,
      );
      const transcript = await requestHostTranscription(audioBase64, options);
      callbacks.on_final_transcript?.(transcript);
    } catch (error) {
      callbacks.on_error?.(
        error instanceof Error
          ? error.message
          : "ROSIE voice input could not transcribe that request.",
      );
    } finally {
      chunks = [];
    }
  };

  void navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((mediaStream) => {
      if (ended) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = mediaStream;
      audioContext = new window.AudioContext();
      source = audioContext.createMediaStreamSource(mediaStream);
      processor = audioContext.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      callbacks.on_start?.();
    })
    .catch((error) => {
      ended = true;
      callbacks.on_error?.(
        error instanceof Error && /denied|not allowed|permission|secure/i.test(error.message)
          ? "Microphone access was not granted for ROSIE voice input."
          : "ROSIE voice input could not start on this workstation.",
      );
      callbacks.on_end?.();
    });

  return {
    stop: () => {
      void finish();
    },
  };
}

export function startRosieVoiceCapture(
  callbacks: RosieVoiceCaptureCallbacks,
  options?: RosieRequestOptions,
): RosieVoiceCaptureSession {
  try {
    return startHostRosieVoiceCapture(callbacks, options);
  } catch (error) {
    if (isTauri()) {
      throw error;
    }
  }

  const RecognitionCtor = getSpeechRecognitionConstructor();
  if (!RecognitionCtor) {
    throw new Error("Voice input is unavailable on this workstation.");
  }

  const recognition = new RecognitionCtor();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-US";
  recognition.maxAlternatives = 1;

  let ended = false;

  recognition.onstart = () => {
    callbacks.on_start?.();
  };
  recognition.onresult = (event) => {
    let partial = "";
    let finalTranscript = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result[0]?.transcript?.trim() ?? "";
      if (!transcript) continue;
      if (result.isFinal) {
        finalTranscript = transcript;
      } else {
        partial = transcript;
      }
    }
    if (partial) {
      callbacks.on_partial_transcript?.(partial);
    }
    if (finalTranscript) {
      callbacks.on_final_transcript?.(finalTranscript);
    }
  };
  recognition.onerror = (event) => {
    const code = event.error ?? "speech_recognition_failed";
    const message =
      code === "not-allowed"
        ? "Microphone access was not granted for ROSIE voice input."
        : code === "no-speech"
          ? "No speech was detected. Try again when you are ready."
          : "ROSIE voice input could not transcribe that request.";
    callbacks.on_error?.(message);
  };
  recognition.onend = () => {
    if (ended) return;
    ended = true;
    callbacks.on_end?.();
  };
  recognition.start();

  return {
    stop: () => {
      if (ended) return;
      ended = true;
      recognition.stop();
      callbacks.on_end?.();
    },
  };
}

async function stopHostRosieSpeechPlayback(options?: RosieRequestOptions): Promise<void> {
  if (activeRosieSpeechPoller != null && typeof window !== "undefined") {
    window.clearInterval(activeRosieSpeechPoller);
    activeRosieSpeechPoller = null;
  }
  await fetchRosieVoiceJson<{ message: string }>("/voice/stop", {
    method: "POST",
    headers: options?.headers,
  });
}

export function stopRosieSpeechPlayback(options?: RosieRequestOptions): void {
  if (activeRosieSpeechPoller != null && typeof window !== "undefined") {
    window.clearInterval(activeRosieSpeechPoller);
    activeRosieSpeechPoller = null;
  }
  if (activeRosieSpeechAudio) {
    activeRosieSpeechAudio.pause();
    activeRosieSpeechAudio.src = "";
    activeRosieSpeechAudio = null;
  }

  void stopHostRosieSpeechPlayback(options).catch(() => {
    if (isTauri()) {
      void invoke("rosie_tts_stop").catch(() => {});
    }
  });
}

function audioBase64ToObjectUrl(audioBase64: string, mimeType: string): string {
  const binary = window.atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

export function speakRosieText(
  text: string,
  options?: {
    rate?: number;
    voice?: RosieSettings["selected_voice"];
    headers?: Record<string, string>;
    on_start?: () => void;
    on_end?: () => void;
    on_error?: (message: string) => void;
  },
): RosieSpeechPlayback {
  let ended = false;
  let stopped = false;
  const finishEnd = () => {
    if (ended) return;
    ended = true;
    options?.on_end?.();
  };

  const startSatellitePlayback = async () => {
    if (typeof window === "undefined") {
      throw new Error("ROSIE voice playback requires a workstation browser.");
    }

    const synthesized = await fetchRosieVoiceJson<{
      audio_base64: string;
      mime_type?: string;
    }>("/voice/synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify({
        text,
        rate: typeof options?.rate === "number" ? options.rate : 1,
        voice: options?.voice ?? DEFAULT_ROSIE_VOICE,
      }),
    });

    if (stopped) {
      finishEnd();
      return;
    }

    const objectUrl = audioBase64ToObjectUrl(
      synthesized.audio_base64,
      synthesized.mime_type ?? "audio/wav",
    );
    const audio = new Audio(objectUrl);
    activeRosieSpeechAudio?.pause();
    activeRosieSpeechAudio = audio;
    audio.onended = () => {
      if (activeRosieSpeechAudio === audio) {
        activeRosieSpeechAudio = null;
      }
      URL.revokeObjectURL(objectUrl);
      finishEnd();
    };
    audio.onerror = () => {
      if (activeRosieSpeechAudio === audio) {
        activeRosieSpeechAudio = null;
      }
      URL.revokeObjectURL(objectUrl);
      if (!stopped && !ended) {
        ended = true;
        options?.on_error?.("ROSIE could not play voice output on this workstation.");
      }
    };
    options?.on_start?.();
    await audio.play();
  };

  void startSatellitePlayback().catch((error) => {
    const message =
      error instanceof Error
        ? error.message
        : "ROSIE could not play voice output on this workstation.";

    if (!ended) {
      ended = true;
      options?.on_error?.(
        /HTTP 405/i.test(message)
          ? "The running RiversideOS host build does not expose the ROSIE voice synthesis route yet. Restart or update the host build so satellite playback can use the approved ROSIE voice."
          : message,
      );
    }
  });

  return {
    stop: () => {
      if (stopped || ended) return;
      stopped = true;
      stopRosieSpeechPlayback({ headers: options?.headers });
      finishEnd();
    },
  };
}

export async function rosieChatCompletions(
  payload: RosieChatCompletionRequest,
  options?: {
    headers?: Record<string, string>;
    settings?: RosieSettings;
    signal?: AbortSignal;
  },
): Promise<RosieChatCompletionResponse> {
  const settings = normalizeRosieSettings(options?.settings ?? loadLocalRosieSettings());
  const rosiePayload: RosieChatCompletionRequest = {
    ...payload,
    reasoning: false,
    chat_template_kwargs: {
      ...(payload.chat_template_kwargs ?? {}),
      enable_thinking: false,
    },
  };

  if (!settings.enabled) {
    throw new Error("ROSIE is disabled for this workstation.");
  }

  if (rosiePayload.stream) {
    throw new Error("Streaming ROSIE completions are not wired yet.");
  }

  if (rosieDirectTransportAllowed(settings)) {
    const runtime = await getRosieLocalRuntimeStatus(options).catch(() => null);
    if (rosieRuntimeUsesServerGovernedTransport(runtime)) {
      // Private remote and cloud providers are server-governed so secrets and routing stay server-side.
    } else {
      await ensureRosieLocalLlmRunning();
      return await invoke<RosieChatCompletionResponse>(
        "rosie_llama_chat_completions",
        { payload: rosiePayload },
      );
    }
  }

  const response = await fetch(
    `${getBaseUrl()}/api/help/rosie/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(rosiePayload),
    },
  );

  const json = (await response.json().catch(() => ({}))) as
    | RosieChatCompletionResponse
    | { error?: string };

  if (!response.ok) {
    const rawMessage =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE request failed with HTTP ${response.status}`;
    const normalizedRawMessage = rawMessage ?? "";
    const message =
      response.status === 502 &&
      /upstream request failed|upstream is unavailable/i.test(normalizedRawMessage)
        ? "ROSIE is unavailable right now. The Host LLM service could not be reached."
        : rawMessage;
    throw new Error(message);
  }

  return json as RosieChatCompletionResponse;
}

function buildGroundedHelpSystemPrompt(
  request: RosieGroundedHelpRequest,
  context: RosieToolContextResponse,
): string {
  const conversationMode = request.mode === "conversation";
  return [
    conversationMode
      ? "You are ROSIE (RiversideOS Intelligence Engine), the full conversational assistant for Riverside OS staff."
      : "You are ROSIE (RiversideOS Intelligence Engine) inside the Riverside OS Help Center.",
    conversationMode
      ? "Answer from the provided RiversideOS Help Center, store playbook, reporting results, and approved operational tool results."
      : "Answer Help Center and workflow questions from the provided structured Help Center and store playbook.",
    "",
    "Your knowledge sources (in priority order):",
    "1. Server tool results for live data (numbers, permission errors, truncated flags)",
    "2. Store SOP (GET /api/staff/store-sop) markdown",
    "3. Help corpus review results selected from current visible manuals",
    "4. Staff docs (docs/staff/*)",
    "5. Policy contracts (AI_CONTEXT_FOR_ASSISTANTS.md, AI_REPORTING_DATA_CATALOG.md)",
    "",
    "Your capabilities:",
    "- Help Corpus Review: Use current approved Riverside manuals supplied by the server for workflow guidance",
    "- Customer Lookup: Search and retrieve customer information from the CRM",
    "- Order Lookup: Search and retrieve order information including special orders, custom orders, and wedding orders",
    "- Inventory Lookup: Search catalog inventory and check stock levels",
    "- Curated Reports: Run approved reporting queries for sales, inventory, and financial data",
    "- Workflow Guidance: Provide step-by-step guidance for Riverside OS workflows",
    "- Alteration Lookup: Search and retrieve alteration work information",
    "- Wedding Lookup: Search and retrieve wedding party information",
    "",
    "Your limitations:",
    "- Cannot modify production data or business logic",
    "- Cannot execute SQL queries directly",
    "- Cannot bypass permissions or access controls",
    "- Cannot write to database tables",
    "- Cannot learn from raw production data or PII",
    "- Cannot autonomously mutate application code",
    "- Cannot perform financial transactions",
    "- Cannot access customer payment information",
    "",
    "Response structure:",
    "1. Direct answer first",
    "2. Step-by-step instructions when the user asks how to do something",
    "3. Short caveat only when the provided sources are genuinely incomplete",
    "",
    "If the question is ambiguous:",
    "- Ask for clarification",
    "- Provide multiple interpretations",
    "- Suggest related topics",
    "",
    "Tone: Professional, concise, helpful",
    "",
    "Context awareness:",
    "- Consider the current screen/surface if provided in client_workflow_context",
    "- Reference the active manual if user is reading one",
    "- Adapt responses based on user's role (staff vs admin)",
    "",
    "When you don't know an answer:",
    "- Use any relevant source snippets, workflow playbooks, client context, and operational tool results before saying you do not know",
    "- If the exact answer is missing, give the closest safe next step in Riverside OS and name what information is missing",
    "- Never invent information not in your sources",
    "",
    "When rosie_knowledge_retrieval is present, treat it as ROSIE's local approved knowledge index over current Help manuals, staff docs, and policy docs.",
    "Use retrieved sections to answer directly; sources are evidence for the UI, not homework for the staff member.",
    "When operational_playbook results are present, use them as the primary recovery checklist for the named workflow.",
    "When client_workflow_context is present, use it only as short-session UI context; it is not a source of business truth.",
    "Use reporting numbers only when they appear in a reporting_run or rosie_read_tool result.",
    "Use order, customer, wedding, inventory, appointment, alteration, loyalty, or operational data only when they appear in the provided operational/read-only tool results.",
    "Do not use SQL, hidden routes, non-approved tools, or any imaginary data beyond the provided results.",
    "Do not infer missing business data or recompute values that are not explicitly returned.",
    conversationMode
      ? "If the provided grounding is not enough, say what ROSIE could not access and suggest the exact kind of lookup, report, customer, order, wedding, or inventory context needed."
      : "If the provided grounding is thin, still answer the user's workflow question from the best available Riverside source. Do not tell the user to browse, search, read, or check a manual as the primary answer.",
    conversationMode
      ? "ROSIE should help staff with RiversideOS usage and accessible store data, while preserving every permission boundary enforced by the returned tool results."
      : "Keep the answer focused on Help Center guidance rather than acting like a broad data assistant.",
    "Store playbook guidance should override generic manual guidance when the two differ.",
    context.tool_results.some((tool) => tool.tool_name === "reporting_run")
      ? "A reporting_run result is present. Narrate only the returned report JSON and keep the answer tightly scoped to that approved report."
      : "No reporting_run result is present.",
    context.tool_results.some((tool) =>
      [
        "order_summary",
        "customer_hub_snapshot",
        "wedding_actions",
        "inventory_variant_intelligence",
        "rosie_read_tool",
      ].includes(tool.tool_name),
    )
      ? "Approved operational/read-only tool results are present. Narrate only those returned JSON fields, include basis/limit caveats when present, and keep the answer operationally grounded."
      : "No approved operational/read-only tool results are present.",
    context.tool_results.some((tool) => tool.tool_name === "rosie_read_tool")
      ? "A ROSIE read-only data tool result is present. Do not say ROSIE lacks access to that data category. If row_count is zero, say the approved lookup returned no matching rows for the filters."
      : "If no ROSIE read-only data tool result is present, do not invent live database facts.",
    request.settings.response_style === "detailed"
      ? "Response style: detailed but practical."
      : "Response style: concise and practical.",
    request.settings.show_citations
      ? "Sources are shown separately by the UI. Do not write 'Source:' lines in the answer body unless the user explicitly asks."
      : "Do not add inline citation formatting in the answer.",
    conversationMode
      ? "For normal staff chat, answer naturally in 2-4 direct sentences unless the user explicitly asks for detail."
      : "Keep the answer concise enough for a Help Center drawer, but include the actual steps when the user asks how to complete a workflow.",
    "Never answer with 'look in the manual', 'search the help manuals', or 'please check the manual' unless the user explicitly asked where documentation lives.",
    "Avoid markdown decoration that sounds unnatural when spoken. Prefer simple sentences over bold-heavy bullets.",
    "Do not output a thinking process, reasoning trace, or hidden analysis.",
    "Answer with the final response only.",
    "Use markdown for readability.",
  ].join("\n");
}

function buildGroundedHelpUserPrompt(
  request: RosieGroundedHelpRequest,
  context: RosieToolContextResponse,
): string {
  const conversationMode = request.mode === "conversation";
  const maxToolResults = conversationMode ? 6 : 5;
  const maxSources = conversationMode ? 5 : 5;
  const argsChars = conversationMode ? 180 : 320;
  const resultChars = conversationMode ? 700 : 900;
  const excerptChars = conversationMode ? 520 : 700;
  const summarizeJson = (value: unknown, maxChars: number): string => {
    try {
      const raw = JSON.stringify(value);
      if (!raw) return "null";
      if (raw.length <= maxChars) return raw;
      return `${raw.slice(0, maxChars)}...`;
    } catch {
      return String(value);
    }
  };

  const toolResults = context.tool_results
    .slice(0, maxToolResults)
    .map((tool, index) =>
      [
        `Tool ${index + 1}: ${tool.tool_name}`,
        `Args: ${summarizeJson(tool.args, argsChars)}`,
        `Result summary: ${summarizeJson(tool.result, resultChars)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  const sources = context.sources
    .slice(0, maxSources)
    .map((source, index) =>
      [
        `Source ${index + 1}: ${source.title}`,
        `Kind: ${source.kind}`,
        source.manual_id ? `Manual ID: ${source.manual_id}` : null,
        source.section_heading ? `Section: ${source.section_heading}` : null,
        source.excerpt ? `Excerpt: ${source.excerpt.slice(0, excerptChars)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n---\n\n");
  const suggestedActions = (context.suggested_actions ?? [])
    .slice(0, 5)
    .map((action, index) =>
      [
        `Action ${index + 1}: ${action.label}`,
        `Target: ${action.target}`,
        `Description: ${action.description}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  return [
    `User question: ${request.question}`,
    "",
    "Structured tool results:",
    toolResults || "No tool results were provided.",
    "",
    "Grounding sources:",
    sources || "No sources were provided.",
    "",
    "Suggested staff actions:",
    suggestedActions || "No deterministic actions were suggested.",
  ].join("\n");
}

async function fetchRosieToolContext(
  request: RosieGroundedHelpRequest,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<RosieToolContextResponse> {
  const response = await fetch(`${getBaseUrl()}/api/help/rosie/v1/tool-context`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify(request),
  });

  const json = (await response.json().catch(() => ({}))) as
    | RosieToolContextResponse
    | { error?: string };

  if (!response.ok) {
    const message =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE tool context failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const context = json as RosieToolContextResponse;
  return {
    ...context,
    sources: Array.isArray(context.sources) ? context.sources : [],
    tool_results: Array.isArray(context.tool_results) ? context.tool_results : [],
    suggested_actions: Array.isArray(context.suggested_actions)
      ? context.suggested_actions
      : [],
  };
}

function extractRosieCompletionAnswer(
  completion: RosieChatCompletionResponse,
): string {
  for (const value of [completion.answer, completion.content, completion.response]) {
    const sanitized = sanitizeRosieAnswerText(value);
    if (sanitized) {
      return sanitized;
    }
  }
  for (const choice of completion.choices ?? []) {
    const choiceContent = sanitizeRosieAnswerText(choice.content);
    if (choiceContent) {
      return choiceContent;
    }
    const content = choice.message?.content;
    const messageContent = sanitizeRosieAnswerText(content);
    if (messageContent) {
      return messageContent;
    }
    if (Array.isArray(content)) {
      const text = sanitizeRosieAnswerText(
        content
        .map((part) => part.text)
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          .join("\n"),
      );
      if (text) return text;
    }
    const choiceText = sanitizeRosieAnswerText(choice.text);
    if (choiceText) {
      return choiceText;
    }
    const messageText = sanitizeRosieAnswerText(choice.message?.text);
    if (messageText) {
      return messageText;
    }
  }
  return "";
}

function sanitizeRosieAnswerText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .trim();
  const finalAnswer = text.match(
    /(?:^|\n)\s*(?:final answer|answer|response)\s*:\s*([\s\S]+)$/i,
  );
  if (finalAnswer?.[1]?.trim()) {
    text = finalAnswer[1].trim();
  }
  text = text
    .replace(
      /^\s*(?:thinking process|analysis|reasoning|chain of thought)\s*:\s*[\s\S]*$/i,
      "",
    )
    .replace(/^\s*source\s*:\s*.*$/gim, "")
    .replace(/^\s*sources\s*:\s*.*$/gim, "")
    .trim();
  return text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatRosieIsoDate(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return text;
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return text;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRosieRange(filters: Record<string, unknown>): string {
  const from = formatRosieIsoDate(filters.from);
  const to = formatRosieIsoDate(filters.to);
  if (from && to) return `${from} through ${to}`;
  if (from) return `starting ${from}`;
  if (to) return `through ${to}`;
  return "the selected period";
}

function readToolEnvelope(tool: RosieToolResult): {
  toolName: string;
  response: RosieReadToolResponseLike;
} | null {
  if (tool.tool_name !== "rosie_read_tool") return null;
  const args = asRecord(tool.args);
  const toolName = asText(args?.tool_name);
  const response = asRecord(tool.result);
  if (!toolName || !response) return null;
  return {
    toolName,
    response: response as RosieReadToolResponseLike,
  };
}

function readReportingRun(tool: RosieToolResult): {
  specId: string;
  params: Record<string, unknown>;
  data: Record<string, unknown>;
} | null {
  if (tool.tool_name !== "reporting_run") return null;
  const args = asRecord(tool.args);
  const result = asRecord(tool.result);
  const specId = asText(args?.spec_id);
  const params = asRecord(args?.params) ?? {};
  const data = asRecord(result?.data);
  if (!specId || !data) return null;
  return { specId, params, data };
}

function readPlannerDecision(tool: RosieToolResult): Record<string, unknown> | null {
  if (tool.tool_name !== "rosie_tool_planner") return null;
  return asRecord(tool.result);
}

function directPlannerDecisionAnswer(decision: Record<string, unknown>): string | null {
  const decisionType = asText(decision.decision);
  const domain = asText(decision.domain) ?? "Riverside OS";
  const reason = asText(decision.reason);
  const suggestedTool = asText(decision.suggested_tool);
  if (decisionType === "ask_clarifying_question") {
    return asText(decision.clarifying_question) ?? "I need one more detail before I can answer safely.";
  }
  if (decisionType === "refuse_mutation") {
    return "ROSIE can explain or summarize this, but cannot change Riverside OS data. Use the approved Riverside OS workflow for that action.";
  }
  if (decisionType === "unsupported_safe_gap") {
    const gap = reason ?? `No approved read-only tool currently answers this ${domain} question.`;
    const suggestion = suggestedTool ? ` Suggested future tool: ${labelFromKey(suggestedTool)}.` : "";
    return `${gap}${suggestion}`;
  }
  return null;
}

function rowsFrom(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    : [];
}

function formatBasis(value: unknown): string {
  const basis = asText(value);
  if (basis === "completed" || basis === "pickup") return "completed/pickup sales";
  if (basis === "sale" || basis === "booked") return "booked sales";
  return basis ? basis.replace(/_/g, " ") : "approved data";
}

function labelFromKey(value: string): string {
  return value
    .replace(/^get_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatScalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function summarizeRecord(record: Record<string, unknown>, maxFields = 4): string {
  const preferredKeys = [
    "customer_name",
    "transaction_display_id",
    "product_name",
    "sku",
    "vendor_name",
    "wedding_name",
    "event_date",
    "status",
    "quantity",
    "units_sold",
    "available_stock",
    "current_points",
    "balance",
    "count",
    "row_count",
  ];
  const pairs: string[] = [];
  for (const key of preferredKeys) {
    const value = formatScalar(record[key]);
    if (value) pairs.push(`${labelFromKey(key)}: ${value}`);
    if (pairs.length >= maxFields) return pairs.join(", ");
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.endsWith("_id") || key === "id") continue;
    const formatted = formatScalar(value);
    if (formatted) pairs.push(`${labelFromKey(key)}: ${formatted}`);
    if (pairs.length >= maxFields) break;
  }
  return pairs.join(", ");
}

function directBestSellersAnswer(data: Record<string, unknown>, params: Record<string, unknown>): string {
  const rows = rowsFrom(data.rows);
  const range = formatRosieRange({
    from: data.from ?? params.from,
    to: data.to ?? params.to,
  });
  const basis = formatBasis(data.reporting_basis ?? params.basis);
  if (rows.length === 0) {
    return `I found no best-selling items for ${range} using ${basis}.`;
  }

  const top = rows[0];
  const name = asText(top.product_name) ?? asText(top.sku) ?? "the top item";
  const sku = asText(top.sku);
  const units = asNumber(top.units_sold);
  const unitsText = units > 0 ? ` with ${units} unit${units === 1 ? "" : "s"} sold` : "";
  const skuText = sku ? ` (${sku})` : "";
  const runnersUp = rows
    .slice(1, 4)
    .map((row) => {
      const runnerName = asText(row.product_name) ?? asText(row.sku) ?? "item";
      const runnerSku = asText(row.sku);
      const runnerUnits = asNumber(row.units_sold);
      return `${runnerName}${runnerSku ? ` (${runnerSku})` : ""}: ${runnerUnits}`;
    })
    .join("; ");
  return `${name}${skuText} was the best-selling item for ${range}${unitsText}. ${runnersUp ? `Next: ${runnersUp}. ` : ""}This uses ${basis}.`.trim();
}

function directGenericReportAnswer(
  specId: string,
  data: Record<string, unknown>,
  params: Record<string, unknown>,
): string {
  const rows = rowsFrom(data.rows);
  const reportName = labelFromKey(specId);
  const range = formatRosieRange({
    from: data.from ?? params.from,
    to: data.to ?? params.to,
  });
  if (rows.length > 0) {
    const examples = rows
      .slice(0, 3)
      .map((row) => summarizeRecord(row))
      .filter(Boolean)
      .join("; ");
    return `I found ${rows.length} ${reportName.toLowerCase()} row${rows.length === 1 ? "" : "s"} for ${range}. ${examples ? `First matches: ${examples}. ` : ""}This uses the approved ${reportName} report.`;
  }

  const summary = summarizeRecord(data, 5);
  if (summary) {
    return `${reportName} for ${range}: ${summary}. This uses the approved report result.`;
  }
  return `The approved ${reportName} report returned no rows for ${range}.`;
}

function directProductSalesAnswer(
  request: RosieGroundedHelpRequest,
  response: RosieReadToolResponseLike,
): string | null {
  const filters = asRecord(response.filters_applied) ?? {};
  const query = asText(filters.query) ?? request.question.trim();
  const rows = rowsFrom(response.data);
  const units = rows.reduce((sum, row) => sum + asNumber(row?.units_sold), 0);
  const transactions = rows.reduce((sum, row) => sum + asNumber(row?.transaction_count), 0);
  const range = formatRosieRange(filters);
  const basis = response.basis === "booked_at_sales_quantity"
    ? "booked sales quantity"
    : response.basis?.replace(/_/g, " ") ?? "approved sales data";
  const caveat = "Cancelled transactions are excluded.";
  const limited = response.limited ? " The result was limited, so review the report for the full list." : "";

  if (rows.length === 0 || units === 0) {
    return `I found 0 units sold for “${query}” from ${range}. This uses ${basis}. ${caveat}${limited}`.trim();
  }

  const topRows = rows
    .slice(0, 3)
    .map((row) => {
      const name = asText(row?.product_name) ?? asText(row?.sku) ?? "matching item";
      const sku = asText(row?.sku);
      const label = sku ? `${name} (${sku})` : name;
      return `${label}: ${asNumber(row?.units_sold)}`;
    })
    .join("; ");
  const transactionText = transactions > 0 ? ` across ${transactions} transaction${transactions === 1 ? "" : "s"}` : "";
  return `I found ${units} unit${units === 1 ? "" : "s"} sold for “${query}” from ${range}${transactionText}. ${topRows ? `Top matches: ${topRows}. ` : ""}This uses ${basis}. ${caveat}${limited}`.trim();
}

function directReadyPickupAnswer(response: RosieReadToolResponseLike): string {
  const rows = rowsFrom(response.data);
  const lineCount = rows.length;
  const itemCount = rows.reduce((sum, row) => sum + asNumber(row.quantity), 0);
  const limited = response.limited ? " The result was limited, so open Orders for the full list." : "";
  if (lineCount === 0) {
    return "I found 0 open order lines marked ready for pickup.";
  }

  const firstRows = rows
    .slice(0, 3)
    .map((row) => {
      const order = asText(row.transaction_display_id) ?? "order";
      const customer = asText(row.customer_name);
      const item = asText(row.product_name) ?? asText(row.sku) ?? "item";
      return `${order}${customer ? ` for ${customer}` : ""}: ${item}`;
    })
    .join("; ");
  return `I found ${lineCount} open order line${lineCount === 1 ? "" : "s"} ready for pickup, covering ${itemCount || lineCount} item${(itemCount || lineCount) === 1 ? "" : "s"}. ${firstRows ? `First matches: ${firstRows}. ` : ""}This uses line-level ready-for-pickup status.${limited}`.trim();
}

function directOpenOrdersAnswer(response: RosieReadToolResponseLike): string {
  const rows = rowsFrom(response.data);
  const lineCount = rows.length;
  const itemCount = rows.reduce((sum, row) => sum + asNumber(row.quantity), 0);
  const limited = response.limited ? " The result was limited, so open Orders for the full list." : "";
  if (lineCount === 0) {
    return "I found 0 open order lines right now.";
  }

  const statusCounts = rows.reduce<Record<string, number>>((counts, row) => {
    const status = asText(row.order_lifecycle_status) ?? "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const statusSummary = Object.entries(statusCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${labelFromKey(status)}`)
    .join(", ");
  const firstRows = rows
    .slice(0, 3)
    .map((row) => {
      const order = asText(row.transaction_display_id) ?? "order";
      const customer = asText(row.customer_name);
      const item = asText(row.product_name) ?? asText(row.sku) ?? "item";
      return `${order}${customer ? ` for ${customer}` : ""}: ${item}`;
    })
    .join("; ");
  return `I found ${lineCount} open order line${lineCount === 1 ? "" : "s"} right now, covering ${itemCount || lineCount} item${(itemCount || lineCount) === 1 ? "" : "s"}. ${statusSummary ? `Status summary: ${statusSummary}. ` : ""}${firstRows ? `First matches: ${firstRows}. ` : ""}This uses non-cancelled order lines that are not picked up.${limited}`.trim();
}

function directCandidateSearchAnswer(toolName: string, response: RosieReadToolResponseLike): string {
  const rows = rowsFrom(response.data);
  const filters = asRecord(response.filters_applied) ?? {};
  const query = asText(filters.query) ?? "that search";
  const limited = response.limited ? " The result was limited, so narrow the search for the full list." : "";
  const target =
    toolName === "search_weddings_for_rosie"
      ? "wedding parties"
      : toolName === "search_vendors_for_rosie"
        ? "vendors"
        : "customers";
  if (rows.length === 0) {
    return `I found no matching ${target} for “${query}”. Try a more specific name, code, phone, or account detail.`;
  }
  const examples = rows
    .slice(0, 5)
    .map((row) => summarizeRecord(row, 4))
    .filter(Boolean)
    .join("; ");
  return `I found ${rows.length} matching ${target} for “${query}”. ${examples ? `Matches: ${examples}. ` : ""}Select the correct record so I can answer the sensitive question safely.${limited}`.trim();
}

function directGenericReadToolAnswer(toolName: string, response: RosieReadToolResponseLike): string {
  const rows = rowsFrom(response.data);
  const title = labelFromKey(toolName);
  const basis = formatBasis(response.basis);
  const limited = response.limited ? " The result was limited, so open the owning workspace for the full list." : "";
  if (rows.length === 0) {
    return `I found 0 matching rows for ${title}. This uses ${basis}.${limited}`.trim();
  }

  const examples = rows
    .slice(0, 3)
    .map((row) => summarizeRecord(row))
    .filter(Boolean)
    .join("; ");
  return `I found ${rows.length} matching row${rows.length === 1 ? "" : "s"} for ${title}. ${examples ? `First matches: ${examples}. ` : ""}This uses ${basis}.${limited}`.trim();
}

function questionLooksLikeDataRequest(question: string): boolean {
  const lower = question.toLowerCase();
  return /\b(how many|how much|what was|what is|do we have|which|who has|show me|list|count|total|balance|points|sales|sold|best selling|best-selling|inventory|stock|orders?|pickup|appointments?|alterations?|weddings?|customers?|vendors?|purchase orders?|receiving|gift cards?|store credit|qbo|register close)\b/.test(lower);
}

function questionLooksLikeOrderRequest(question: string): boolean {
  const lower = question.toLowerCase();
  return /\b(open orders?|orders? open|orders? ready|ready for pickup|ready to pick up|any orders?|order count)\b/.test(
    lower,
  );
}

function wrongDomainToolAnswer(question: string, toolName: string): string | null {
  const lower = question.toLowerCase();
  if (questionLooksLikeOrderRequest(question) && toolName === "get_inventory_availability") {
    return "I found an inventory result, but your question appears to be about open orders. I will not answer an order question from inventory data.";
  }
  if ((lower.includes("qbo") || lower.includes("quickbooks") || lower.includes("accounting")) && /sales|best_sellers|product_sales/.test(toolName)) {
    return "I found a sales result, but your question appears to be about accounting or QBO. I will not answer an accounting question from sales data.";
  }
  if ((lower.includes("store credit") || lower.includes("gift card")) && toolName === "get_customer_loyalty_balance") {
    return "I found a loyalty result, but your question appears to be about store credit or gift cards. I will not answer that from loyalty data.";
  }
  if ((lower.includes("received") || lower.includes("receiving") || lower.includes("purchase order") || lower.includes(" po ")) && toolName === "get_inventory_availability") {
    return "I found an inventory availability result, but your question appears to be about receiving or purchase orders. I will not answer a receiving or PO question from inventory data.";
  }
  if ((lower.includes("wedding") || lower.includes("measurements")) && toolName === "search_customers_for_rosie") {
    return "I found a customer search result, but your question appears to be about wedding readiness. I will not answer a wedding readiness question from customer search alone.";
  }
  return null;
}

function hasStructuredDataResult(context: RosieToolContextResponse): boolean {
  return context.tool_results.some((tool) =>
    [
      "reporting_run",
      "order_summary",
      "customer_hub_snapshot",
      "wedding_actions",
      "inventory_variant_intelligence",
      "rosie_read_tool",
    ].includes(tool.tool_name),
  );
}

function clarificationForDataQuestion(
  request: RosieGroundedHelpRequest,
  context: RosieToolContextResponse,
): string | null {
  if (!questionLooksLikeDataRequest(request.question) || hasStructuredDataResult(context)) {
    return null;
  }
  const lower = request.question.toLowerCase();
  if (lower.includes("loyalty") || lower.includes("points")) {
    return "Which customer record should I use for the loyalty points check? Open or select the customer record so I can use the approved customer lookup.";
  }
  if (lower.includes("customer") || lower.includes("balance")) {
    return "Which customer or account should I check? I need a customer record or clearer search detail before I can answer safely.";
  }
  if (questionLooksLikeOrderRequest(request.question)) {
    return "Which order view should I check: all open orders, ready-for-pickup orders, or one customer’s orders?";
  }
  if (lower.includes("inventory") || lower.includes("stock") || lower.includes("do we have")) {
    return "Which item, SKU, barcode, size, or color should I check in inventory?";
  }
  if (lower.includes("sales") || lower.includes("sold") || lower.includes("best")) {
    return "Which item/category and date range should I use for the sales question?";
  }
  return "I need one more detail before I can answer safely. Which customer, item/SKU, date range, or workflow should I use?";
}

function directDataAnswer(
  request: RosieGroundedHelpRequest,
  context: RosieToolContextResponse,
): string | null {
  for (const tool of context.tool_results) {
    const decision = readPlannerDecision(tool);
    if (!decision) continue;
    const plannerAnswer = directPlannerDecisionAnswer(decision);
    if (plannerAnswer) return plannerAnswer;
  }

  for (const tool of context.tool_results) {
    const report = readReportingRun(tool);
    if (!report) continue;
    const mismatch = wrongDomainToolAnswer(request.question, report.specId);
    if (mismatch) return mismatch;
    if (report.specId === "best_sellers") {
      return directBestSellersAnswer(report.data, report.params);
    }
    return directGenericReportAnswer(report.specId, report.data, report.params);
  }

  for (const tool of context.tool_results) {
    const envelope = readToolEnvelope(tool);
    if (!envelope) continue;
    const mismatch = wrongDomainToolAnswer(request.question, envelope.toolName);
    if (mismatch) return mismatch;
    if (envelope.toolName === "get_product_sales_by_query") {
      return directProductSalesAnswer(request, envelope.response);
    }
    if (
      envelope.toolName === "search_customers_for_rosie" ||
      envelope.toolName === "search_weddings_for_rosie" ||
      envelope.toolName === "search_vendors_for_rosie"
    ) {
      return directCandidateSearchAnswer(envelope.toolName, envelope.response);
    }
    if (envelope.toolName === "get_open_orders") {
      return directOpenOrdersAnswer(envelope.response);
    }
    if (envelope.toolName === "get_open_orders_ready_for_pickup") {
      return directReadyPickupAnswer(envelope.response);
    }
    return directGenericReadToolAnswer(envelope.toolName, envelope.response);
  }
  return clarificationForDataQuestion(request, context);
}

function rosieConversationalGreeting(question: string): string | null {
  const normalized = question.trim().toLowerCase().replace(/[!.?]+$/g, "");
  if (!/^(hi|hello|hey|good morning|good afternoon|good evening|yo|howdy)$/.test(normalized)) {
    return null;
  }
  return "Hi, I’m ROSIE. I can help with RiversideOS workflows, store data, reports, customers, inventory, wedding orders, and Help Center guidance. What would you like to work on?";
}

const RIVERSIDEOS_CREATOR_ANSWER =
  "RiversideOS was designed by Christopher Garcia and released first on June of 2026.";

function rosieCreatorAnswer(question: string): string | null {
  const normalized = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const asksCreator =
    /\b(who|whom)\b/.test(normalized) &&
    /\b(created|made|designed|built|founded|invented|released)\b/.test(normalized);
  const asksOrigin =
    /\bcreator|designer|founder|author|origin|history\b/.test(normalized);
  const namesProduct =
    /\briversideos\b/.test(normalized) ||
    /\briverside os\b/.test(normalized) ||
    /\bros\b/.test(normalized) ||
    /\brosie\b/.test(normalized);
  return namesProduct && (asksCreator || asksOrigin) ? RIVERSIDEOS_CREATOR_ANSWER : null;
}

export async function askRosieGroundedHelp(
  request: RosieGroundedHelpRequest,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<RosieGroundedHelpResponse> {
  const creatorAnswer = rosieCreatorAnswer(request.question);
  if (creatorAnswer) {
    return {
      answer: creatorAnswer,
      sources: [],
      tool_results: [],
      suggested_actions: [],
      completion: { choices: [{ message: { role: "assistant", content: creatorAnswer } }] },
    };
  }

  if (request.mode === "conversation") {
    const greeting = rosieConversationalGreeting(request.question);
    if (greeting) {
      return {
        answer: greeting,
        sources: [],
        tool_results: [],
        suggested_actions: [],
        completion: { choices: [{ message: { role: "assistant", content: greeting } }] },
      };
    }
  }

  const context = await fetchRosieToolContext(request, options);
  const directAnswer = directDataAnswer(request, context);
  if (directAnswer) {
    return {
      answer: directAnswer,
      sources: context.sources,
      tool_results: context.tool_results,
      suggested_actions: context.suggested_actions ?? [],
      completion: { choices: [{ message: { role: "assistant", content: directAnswer } }] },
    };
  }
  const messages: RosieChatMessage[] = [
    {
      role: "system",
      content: buildGroundedHelpSystemPrompt(request, context),
    },
    {
      role: "user",
      content: buildGroundedHelpUserPrompt(request, context),
    },
  ];

  const runCompletion = async (maxTokens: number, retrying = false) =>
    rosieChatCompletions(
      {
        model: "local",
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: retrying
          ? [
              ...messages,
              {
                role: "user",
                content:
                  "Your previous attempt did not include a final answer. Reply now with only the final answer in 2-4 concise sentences.",
              },
            ]
          : messages,
      },
      {
        headers: options?.headers,
      },
    );

  const initialMaxTokens =
    request.settings.response_style === "detailed"
      ? request.mode === "conversation"
        ? 320
        : 420
      : request.mode === "conversation"
        ? 180
        : 180;
  let completion = await runCompletion(initialMaxTokens);
  let answer = extractRosieCompletionAnswer(completion);

  if (!answer) {
    completion = await runCompletion(
      request.settings.response_style === "detailed"
        ? request.mode === "conversation"
          ? 260
          : 360
        : 160,
      true,
    );
    answer = extractRosieCompletionAnswer(completion);
  }

  if (!answer) {
    throw new Error("ROSIE local Gemma returned no usable answer after retry.");
  }

  return {
    answer,
    sources: context.sources,
    tool_results: context.tool_results,
    suggested_actions: context.suggested_actions ?? [],
    completion,
  };
}

export async function askRosieGroundedHelpStream(
  request: RosieGroundedHelpRequest,
  options?: {
    headers?: Record<string, string>;
    on_delta?: (delta: string) => void;
    on_context?: (context: RosieToolContextResponse) => void;
  },
): Promise<RosieGroundedHelpResponse> {
  const creatorAnswer = rosieCreatorAnswer(request.question);
  if (creatorAnswer) {
    options?.on_delta?.(creatorAnswer);
    return {
      answer: creatorAnswer,
      sources: [],
      tool_results: [],
      suggested_actions: [],
      completion: { choices: [{ message: { role: "assistant", content: creatorAnswer } }] },
    };
  }

  if (request.mode === "conversation") {
    const greeting = rosieConversationalGreeting(request.question);
    if (greeting) {
      options?.on_delta?.(greeting);
      return {
        answer: greeting,
        sources: [],
        tool_results: [],
        suggested_actions: [],
        completion: { choices: [{ message: { role: "assistant", content: greeting } }] },
      };
    }
  }

  const context = await fetchRosieToolContext(request, options);
  options?.on_context?.(context);
  const directAnswer = directDataAnswer(request, context);
  if (directAnswer) {
    options?.on_delta?.(directAnswer);
    return {
      answer: directAnswer,
      sources: context.sources,
      tool_results: context.tool_results,
      suggested_actions: context.suggested_actions ?? [],
      completion: { choices: [{ message: { role: "assistant", content: directAnswer } }] },
    };
  }
  const messages: RosieChatMessage[] = [
    {
      role: "system",
      content: buildGroundedHelpSystemPrompt(request, context),
    },
    {
      role: "user",
      content: buildGroundedHelpUserPrompt(request, context),
    },
  ];
  const maxTokens =
    request.settings.response_style === "detailed"
      ? request.mode === "conversation"
        ? 320
        : 420
      : request.mode === "conversation"
        ? 180
        : 180;

  let completion = await rosieChatCompletions(
    {
      model: "local",
      temperature: 0.2,
      max_tokens: maxTokens,
      messages,
    },
    {
      headers: options?.headers,
    },
  );
  let answer = extractRosieCompletionAnswer(completion);
  if (answer) {
    options?.on_delta?.(answer);
  }

  if (!answer) {
    completion = await rosieChatCompletions(
      {
        model: "local",
        temperature: 0.2,
        max_tokens:
          request.settings.response_style === "detailed"
            ? request.mode === "conversation"
              ? 260
              : 360
            : 160,
        messages: [
          ...messages,
          {
            role: "user",
            content:
              "Your previous attempt did not include a final answer. Reply now with only the final answer in 2-4 concise sentences.",
          },
        ],
      },
      {
        headers: options?.headers,
      },
    );
    answer = extractRosieCompletionAnswer(completion);
  }

  if (!answer) {
    throw new Error("ROSIE local Gemma returned no usable answer after retry.");
  }

  return {
    answer,
    sources: context.sources,
    tool_results: context.tool_results,
    suggested_actions: context.suggested_actions ?? [],
    completion,
  };
}

export async function requestRosieInsightSummary(
  request: RosieInsightSummaryRequest,
  options?: {
    headers?: Record<string, string>;
    settings?: RosieSettings;
  },
): Promise<RosieInsightSummaryResponse> {
  const settings = normalizeRosieSettings(options?.settings ?? loadLocalRosieSettings());
  if (!settings.enabled) {
    return { status: "unavailable", bullets: [] };
  }

  const timeout = createRosieOptionalTimeoutSignal(ROSIE_OPTIONAL_INSIGHT_TIMEOUT_MS);
  try {
    const response = await fetch(`${getBaseUrl()}/api/help/rosie/v1/insight-summary`, {
      method: "POST",
      signal: timeout.signal,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      return { status: "unavailable", bullets: [] };
    }
    const json = (await response.json().catch(() => null)) as RosieInsightSummaryResponse | null;
    if (!json || json.status !== "available") {
      return { status: "unavailable", bullets: [] };
    }
    return {
      status: "available",
      bullets: (json.bullets ?? []).slice(0, 3),
      suggested_actions: (json.suggested_actions ?? []).slice(0, 3),
    };
  } catch {
    return { status: "unavailable", bullets: [] };
  } finally {
    timeout.clear();
  }
}

export async function requestRosieSearchIntent(
  request: RosieSearchIntentRequest,
  options?: {
    headers?: Record<string, string>;
    settings?: RosieSettings;
    signal?: AbortSignal;
  },
): Promise<RosieSearchIntentResponse> {
  const settings = normalizeRosieSettings(options?.settings ?? loadLocalRosieSettings());
  if (!settings.enabled) {
    return { status: "unavailable", shortcut_ids: [] };
  }

  const allowedIds = new Set(request.available_shortcuts.map((shortcut) => shortcut.id));
  try {
    const response = await fetch(`${getBaseUrl()}/api/help/rosie/v1/search-intent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify(request),
      signal: options?.signal,
    });
    if (!response.ok) {
      return { status: "unavailable", shortcut_ids: [] };
    }
    const json = (await response.json().catch(() => null)) as RosieSearchIntentResponse | null;
    if (!json || json.status !== "available") {
      return { status: "unavailable", shortcut_ids: [] };
    }
    return {
      status: "available",
      shortcut_ids: (json.shortcut_ids ?? [])
        .filter((id): id is RosieSearchShortcutId => allowedIds.has(id))
        .slice(0, 3),
    };
  } catch {
    return { status: "unavailable", shortcut_ids: [] };
  }
}

export async function getRosieIntelligenceStatus(
  headers?: Record<string, string>,
): Promise<RosieIntelligenceStatus> {
  const response = await fetch(`${getBaseUrl()}/api/help/rosie/v1/intelligence/status`, {
    headers: headers ?? {},
  });

  const json = (await response.json().catch(() => ({}))) as
    | RosieIntelligenceStatus
    | { error?: string };

  if (!response.ok) {
    const message =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE intelligence status failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json as RosieIntelligenceStatus;
}

export async function refreshRosieIntelligence(options?: {
  headers?: Record<string, string>;
  reindex_search?: boolean;
  dry_run?: boolean;
}): Promise<RosieIntelligenceRefreshResponse> {
  const response = await fetch(`${getBaseUrl()}/api/help/rosie/v1/intelligence/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
    body: JSON.stringify({
      reindex_search: options?.reindex_search === true,
      dry_run: options?.dry_run === true,
    }),
  });

  const json = (await response.json().catch(() => ({}))) as
    | RosieIntelligenceRefreshResponse
    | { error?: string };

  if (!response.ok) {
    const message =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE intelligence refresh failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json as RosieIntelligenceRefreshResponse;
}

export async function rosieProductCatalogAnalyze(
  productId: string,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<RosieProductCatalogAnalysisResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/help/rosie/v1/product-catalog-analyze`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify({ product_id: productId }),
    },
  );

  const json = (await response.json().catch(() => ({}))) as
    | RosieProductCatalogAnalysisResponse
    | { error?: string };

  if (!response.ok) {
    const message =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE catalog analysis failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json as RosieProductCatalogAnalysisResponse;
}

export async function rosieProductCatalogSuggest(
  productId: string,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<RosieProductCatalogSuggestionResponse> {
  const response = await fetch(
    `${getBaseUrl()}/api/help/rosie/v1/product-catalog-suggest`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      body: JSON.stringify({ product_id: productId }),
    },
  );

  const json = (await response.json().catch(() => ({}))) as
    | RosieProductCatalogSuggestionResponse
    | { error?: string };

  if (!response.ok) {
    const message =
      typeof (json as { error?: string }).error === "string"
        ? (json as { error?: string }).error
        : `ROSIE catalog suggestion failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return json as RosieProductCatalogSuggestionResponse;
}
