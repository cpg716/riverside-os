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
};

export type RosieChatCompletionResponse = {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string;
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
    | "catalog";
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
};

export type RosieGroundedHelpResponse = {
  answer: string;
  sources: RosieHelpGroundingSource[];
  tool_results: RosieToolResult[];
  completion: RosieChatCompletionResponse;
};

export type RosieToolResult = {
  tool_name:
    | "help_search"
    | "help_get_manual"
    | "store_sop_get"
    | "reporting_run"
    | "order_summary"
    | "customer_hub_snapshot"
    | "wedding_actions"
    | "inventory_variant_intelligence"
    | "product_catalog_analyze"
    | "product_catalog_suggest";
  args: Record<string, unknown>;
  result: unknown;
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
    base_url: string;
    host: string;
    port: string;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    sidecar_binary_present: boolean;
    running: boolean;
  };
  stt: {
    engine_name: string;
    provider: string;
    active_engine: string;
    cli_path: string;
    cli_present: boolean;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    fallback_engine_name: string;
    fallback_cli_path: string;
    fallback_cli_present: boolean;
    fallback_model_path?: string | null;
    fallback_model_present: boolean;
  };
  tts: {
    engine_name: string;
    provider: string;
    active_engine: string;
    command_path: string;
    command_present: boolean;
    model_name: string;
    model_path?: string | null;
    model_present: boolean;
    fallback_engine_name: string;
    fallback_command_path: string;
    fallback_command_present: boolean;
    speaking: boolean;
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
      typeof json.error === "string" ? json.error : `ROSIE voice request failed with HTTP ${response.status}`,
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
        runtime?.stt.active_engine !== "unavailable",
      text_to_speech_supported: runtime?.tts.active_engine !== "unavailable",
    };
  } catch {
    return getBrowserRosieVoiceCapabilities();
  }
}

async function ensureRosieLocalLlmRunning(): Promise<void> {
  if (!isTauri()) return;
  const runtime = await getRosieLocalRuntimeStatus();
  if (!runtime) return;
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

  void stopHostRosieSpeechPlayback(options).catch(() => {
    if (isTauri()) {
      void invoke("rosie_tts_stop").catch(() => {});
    }
  });
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

  const startHostPlayback = async () => {
    await fetchRosieVoiceJson<{ message: string }>("/voice/speak", {
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
      await stopHostRosieSpeechPlayback({ headers: options?.headers }).catch(() => {});
      finishEnd();
      return;
    }

    options?.on_start?.();
    if (typeof window !== "undefined") {
      activeRosieSpeechPoller = window.setInterval(() => {
        void fetchRosieVoiceJson<{ speaking: boolean }>("/voice/status", {
          headers: options?.headers,
        })
          .then(({ speaking }) => {
            if (speaking || stopped) return;
            if (activeRosieSpeechPoller != null) {
              window.clearInterval(activeRosieSpeechPoller);
              activeRosieSpeechPoller = null;
            }
            finishEnd();
          })
          .catch((error) => {
            if (activeRosieSpeechPoller != null) {
              window.clearInterval(activeRosieSpeechPoller);
              activeRosieSpeechPoller = null;
            }
            if (!stopped && !ended) {
              ended = true;
              options?.on_error?.(
                error instanceof Error
                  ? error.message
                  : "ROSIE could not play voice output on this workstation.",
              );
            }
          });
      }, 300);
    }
  };

  void startHostPlayback().catch((error) => {
    if (isTauri()) {
      const tauriStopped = false;
      void invoke("rosie_tts_speak", {
        text,
        rate: typeof options?.rate === "number" ? options.rate : 1,
        voice: options?.voice ?? DEFAULT_ROSIE_VOICE,
      })
        .then(() => {
          if (tauriStopped || stopped) return;
          options?.on_start?.();
          if (typeof window !== "undefined") {
            activeRosieSpeechPoller = window.setInterval(() => {
              void invoke<boolean>("rosie_tts_status")
                .then((speaking) => {
                  if (speaking || tauriStopped || stopped) return;
                  if (activeRosieSpeechPoller != null) {
                    window.clearInterval(activeRosieSpeechPoller);
                    activeRosieSpeechPoller = null;
                  }
                  finishEnd();
                })
                .catch(() => {
                  if (activeRosieSpeechPoller != null) {
                    window.clearInterval(activeRosieSpeechPoller);
                    activeRosieSpeechPoller = null;
                  }
                  if (!tauriStopped && !stopped && !ended) {
                    ended = true;
                    options?.on_error?.("ROSIE could not play voice output on this workstation.");
                  }
                });
            }, 300);
          }
        })
        .catch((tauriError) => {
          if (!stopped && !ended) {
            ended = true;
            options?.on_error?.(
              tauriError instanceof Error
                ? tauriError.message
                : "ROSIE could not play voice output on this workstation.",
            );
          }
        });

      return;
    }

    if (!ended) {
      ended = true;
      options?.on_error?.(
        error instanceof Error
          ? error.message
          : "ROSIE could not play voice output on this workstation.",
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
  },
): Promise<RosieChatCompletionResponse> {
  const settings = normalizeRosieSettings(options?.settings ?? loadLocalRosieSettings());

  if (!settings.enabled) {
    throw new Error("ROSIE is disabled for this workstation.");
  }

  if (payload.stream) {
    throw new Error("Streaming ROSIE completions are not wired yet.");
  }

  if (rosieDirectTransportAllowed(settings)) {
    try {
      await ensureRosieLocalLlmRunning();
      return await invoke<RosieChatCompletionResponse>(
        "rosie_llama_chat_completions",
        { payload },
      );
    } catch (error) {
      console.warn("ROSIE direct transport failed, falling back to Axum:", error);
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
      body: JSON.stringify(payload),
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
    "Use reporting numbers only when they appear in a reporting_run tool result.",
    "Use order, customer, wedding, or inventory data only when they appear in the provided operational tool results.",
    "Do not use SQL, hidden routes, non-approved tools, or any imaginary data beyond the provided results.",
    "Do not infer missing business data or recompute values that are not explicitly returned.",
    conversationMode
      ? "If the provided grounding is not enough, say what ROSIE could not access and suggest the exact kind of lookup, report, customer, order, wedding, or inventory context needed."
      : "If the provided grounding is not enough, say that clearly and direct the user to Browse or Search in Help Center.",
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
      ].includes(tool.tool_name),
    )
      ? "Approved operational tool results are present. Narrate only those returned JSON fields and keep the answer operationally grounded."
      : "No approved operational tool results are present.",
    request.settings.response_style === "detailed"
      ? "Response style: detailed but practical."
      : "Response style: concise and practical.",
    request.settings.show_citations
      ? "When helpful, mention the source title or section in the answer."
      : "Do not add inline citation formatting in the answer.",
    "Do not output a thinking process, reasoning trace, or hidden analysis.",
    "Answer with the final response only.",
    "Use markdown for readability.",
  ].join(" ");
}

function buildGroundedHelpUserPrompt(
  request: RosieGroundedHelpRequest,
  context: RosieToolContextResponse,
): string {
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
    .slice(0, 4)
    .map((tool, index) =>
      [
        `Tool ${index + 1}: ${tool.tool_name}`,
        `Args: ${summarizeJson(tool.args, 320)}`,
        `Result summary: ${summarizeJson(tool.result, 900)}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");

  const sources = context.sources
    .slice(0, 4)
    .map((source, index) =>
      [
        `Source ${index + 1}: ${source.title}`,
        `Kind: ${source.kind}`,
        source.manual_id ? `Manual ID: ${source.manual_id}` : null,
        source.section_heading ? `Section: ${source.section_heading}` : null,
        source.excerpt ? `Excerpt: ${source.excerpt}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
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

  return json as RosieToolContextResponse;
}

export async function askRosieGroundedHelp(
  request: RosieGroundedHelpRequest,
  options?: {
    headers?: Record<string, string>;
  },
): Promise<RosieGroundedHelpResponse> {
  const context = await fetchRosieToolContext(request, options);
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
        ? 640
        : 420
      : request.mode === "conversation"
        ? 320
        : 180;
  let completion = await runCompletion(initialMaxTokens);
  let answer = completion.choices?.[0]?.message?.content?.trim();

  if (!answer) {
    completion = await runCompletion(
      request.settings.response_style === "detailed" ? 560 : 260,
      true,
    );
    answer = completion.choices?.[0]?.message?.content?.trim();
  }

  if (!answer) {
    throw new Error("ROSIE returned an empty Help Center response.");
  }

  return {
    answer,
    sources: context.sources,
    tool_results: context.tool_results,
    completion,
  };
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
