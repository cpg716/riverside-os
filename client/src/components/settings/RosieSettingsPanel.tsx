import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Save, RefreshCw } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import {
  DEFAULT_ROSIE_SETTINGS,
  getRosieIntelligenceStatus,
  getRosieLocalRuntimeStatus,
  ROSIE_KOKORO_VOICE_OPTIONS,
  ROSIE_VOICE_TEST_SENTENCE,
  type RosieSettings,
  type RosieIntelligenceStatus,
  type RosieLocalRuntimeStatus,
  mergeRosieSettings,
  refreshRosieIntelligence,
  loadLocalRosieSettings,
  saveLocalRosieSettings,
  speakRosieText,
  stopRosieSpeechPlayback,
} from "../../lib/rosie";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = getBaseUrl();

export default function RosieSettingsPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canManageStoreDefaults = hasPermission("settings.admin");
  const canManageIntelligence = hasPermission("help.manage");

  const [storeDefaults, setStoreDefaults] = useState<RosieSettings | null>(null);
  const [localSettings, setLocalSettings] = useState<RosieSettings>(() =>
    loadLocalRosieSettings(),
  );
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const [intelligenceStatus, setIntelligenceStatus] =
    useState<RosieIntelligenceStatus | null>(null);
  const [intelligenceBusy, setIntelligenceBusy] = useState(false);
  const [intelligenceLoaded, setIntelligenceLoaded] = useState(false);
  const [localRuntimeStatus, setLocalRuntimeStatus] =
    useState<RosieLocalRuntimeStatus | null>(null);
  const [localRuntimeBusy, setLocalRuntimeBusy] = useState(false);
  const [localRuntimeLoaded, setLocalRuntimeLoaded] = useState(false);
  const [voicePreviewSpeaking, setVoicePreviewSpeaking] = useState(false);

  const effectiveSettings = useMemo(
    () => mergeRosieSettings(localSettings, storeDefaults),
    [localSettings, storeDefaults],
  );
  const activeTtsEngine = localRuntimeStatus?.tts.active_engine ?? "unavailable";
  const kokoroVoiceControlsAvailable = activeTtsEngine === "kokoro";
  const ttsFallbackActive =
    localRuntimeStatus != null &&
    activeTtsEngine !== "kokoro" &&
    activeTtsEngine !== "unavailable";
  const desktopVoiceRuntimeAvailable = localRuntimeStatus != null;

  useEffect(() => {
    saveLocalRosieSettings(localSettings);
  }, [localSettings]);

  const loadStoreDefaults = useCallback(async () => {
    if (!canManageStoreDefaults) {
      setStoreDefaults(null);
      setStoreLoaded(true);
      return;
    }
    setStoreBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/rosie`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const json = (await res.json()) as RosieSettings;
      setStoreDefaults(mergeRosieSettings(json, DEFAULT_ROSIE_SETTINGS));
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not load ROSIE store defaults",
        "error",
      );
    } finally {
      setStoreLoaded(true);
      setStoreBusy(false);
    }
  }, [backofficeHeaders, canManageStoreDefaults, toast]);

  useEffect(() => {
    void loadStoreDefaults();
  }, [loadStoreDefaults]);

  const loadIntelligenceStatus = useCallback(async () => {
    if (!canManageIntelligence) {
      setIntelligenceStatus(null);
      setIntelligenceLoaded(true);
      return;
    }
    setIntelligenceBusy(true);
    try {
      const status = await getRosieIntelligenceStatus(
        backofficeHeaders() as Record<string, string>,
      );
      setIntelligenceStatus(status);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not load ROSIE intelligence status",
        "error",
      );
    } finally {
      setIntelligenceLoaded(true);
      setIntelligenceBusy(false);
    }
  }, [backofficeHeaders, canManageIntelligence, toast]);

  useEffect(() => {
    void loadIntelligenceStatus();
  }, [loadIntelligenceStatus]);

  const loadLocalRuntime = useCallback(async () => {
    setLocalRuntimeBusy(true);
    try {
      const status = await getRosieLocalRuntimeStatus();
      setLocalRuntimeStatus(status);
    } catch {
      setLocalRuntimeStatus(null);
    } finally {
      setLocalRuntimeLoaded(true);
      setLocalRuntimeBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadLocalRuntime();
  }, [loadLocalRuntime]);

  useEffect(() => {
    return () => {
      stopRosieSpeechPlayback();
    };
  }, []);

  const updateLocalSettings = (patch: Partial<RosieSettings>) => {
    setLocalSettings((prev) => mergeRosieSettings({ ...prev, ...patch }, null));
  };

  const testSelectedVoice = () => {
    stopRosieSpeechPlayback();
    setVoicePreviewSpeaking(false);
    try {
      speakRosieText(ROSIE_VOICE_TEST_SENTENCE, {
        rate: localSettings.speech_rate,
        voice: localSettings.selected_voice,
        on_start: () => setVoicePreviewSpeaking(true),
        on_end: () => setVoicePreviewSpeaking(false),
        on_error: (message) => {
          setVoicePreviewSpeaking(false);
          toast(message, "error");
        },
      });
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "ROSIE could not preview the selected voice.",
        "error",
      );
    }
  };

  const stopVoicePreview = () => {
    stopRosieSpeechPlayback();
    setVoicePreviewSpeaking(false);
  };

  const saveStoreDefaults = async () => {
    if (!canManageStoreDefaults) return;
    setStoreBusy(true);
    try {
      const payload = mergeRosieSettings(localSettings, null);
      const res = await fetch(`${baseUrl}/api/settings/rosie`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as RosieSettings;
      setStoreDefaults(saved);
      toast("ROSIE store defaults saved", "success");
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not save ROSIE store defaults",
        "error",
      );
    } finally {
      setStoreBusy(false);
    }
  };

  const runIntelligenceRefresh = async (reindexSearch: boolean) => {
    if (!canManageIntelligence) return;
    setIntelligenceBusy(true);
    try {
      const refreshed = await refreshRosieIntelligence({
        headers: backofficeHeaders() as Record<string, string>,
        reindex_search: reindexSearch,
      });
      setIntelligenceStatus(refreshed.status);
      toast(
        reindexSearch
          ? "ROSIE intelligence refreshed and Help search reindexed"
          : "ROSIE intelligence refreshed",
        "success",
      );
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not refresh ROSIE intelligence",
        "error",
      );
    } finally {
      setIntelligenceBusy(false);
    }
  };

  const formatTimestamp = (value?: string | null) => {
    if (!value) return "Not run yet";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString();
  };

  return (
    <div className="space-y-10" data-testid="rosie-settings-panel">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-border bg-app-surface/70 text-app-accent">
            <Bot className="h-7 w-7" aria-hidden />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              ROSIE
            </h2>
            <p className="max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
              Minimal runtime controls for RiversideOS Intelligence Engine.
              These settings change chat transport and answer presentation only.
              They do not grant model access to the database, raw SQL, or any
              mutation path.
            </p>
          </div>
        </div>
      </header>

      <section className="ui-card p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Workstation Settings
            </h3>
            <p className="mt-2 text-sm font-medium text-app-text-muted">
              Saved in this workstation browser profile for the current lane.
            </p>
          </div>
          <div className="rounded-xl border border-app-border bg-app-surface-2 px-4 py-3 text-xs font-bold uppercase tracking-widest text-app-text-muted">
            Effective mode:{" "}
            <span className="text-app-text">
              {effectiveSettings.local_first ? "Local host first" : "Axum fallback only"}
            </span>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-app-border bg-app-surface/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Local Runtime Status
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Visibility into the pinned local LLM, speech-to-text, and
                speech output path for this workstation.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadLocalRuntime()}
              disabled={localRuntimeBusy}
              className="ui-btn-secondary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
            >
              <RefreshCw className={`h-4 w-4 ${localRuntimeBusy ? "animate-spin" : ""}`} />
              Reload Runtime
            </button>
          </div>

          {!localRuntimeLoaded ? (
            <p className="mt-4 text-sm font-medium text-app-text-muted">
              Checking local ROSIE runtime…
            </p>
          ) : localRuntimeStatus == null ? (
            <p className="mt-4 text-sm font-medium text-app-text-muted">
              This browser session is not running inside a local Tauri shell, so
              workstation runtime status is unavailable here.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4 text-sm">
                <p className="font-black uppercase tracking-widest text-app-text">LLM</p>
                <p className="mt-2 font-medium text-app-text-muted">
                  Runtime: <span className="text-app-text">{localRuntimeStatus.llm.runtime_name}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Model: <span className="text-app-text">{localRuntimeStatus.llm.model_name}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Status: <span className="text-app-text">{localRuntimeStatus.llm.model_present ? (localRuntimeStatus.llm.running ? "Loaded" : "Not loaded") : "Missing"}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Provider: <span className="text-app-text">{localRuntimeStatus.llm.provider}</span>
                </p>
                <p className="mt-1 break-all text-xs font-medium text-app-text-muted">
                  {localRuntimeStatus.llm.model_path ?? "No model path configured"}
                </p>
              </div>
              <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4 text-sm">
                <p className="font-black uppercase tracking-widest text-app-text">Speech To Text</p>
                <p className="mt-2 font-medium text-app-text-muted">
                  Engine: <span className="text-app-text">{localRuntimeStatus.stt.engine_name}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Status: <span className="text-app-text">{localRuntimeStatus.stt.model_present ? "Ready" : "Missing"}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Active path: <span className="text-app-text">{localRuntimeStatus.stt.active_engine}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Fallback: <span className="text-app-text">{localRuntimeStatus.stt.fallback_engine_name}</span>
                </p>
                <p className="mt-1 break-all text-xs font-medium text-app-text-muted">
                  {localRuntimeStatus.stt.model_path ?? "No STT model path configured"}
                </p>
              </div>
              <div className="rounded-2xl border border-app-border bg-app-surface-2/70 p-4 text-sm">
                <p className="font-black uppercase tracking-widest text-app-text">Speech Output</p>
                <p className="mt-2 font-medium text-app-text-muted">
                  Engine: <span className="text-app-text">{localRuntimeStatus.tts.engine_name}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Status: <span className="text-app-text">{localRuntimeStatus.tts.model_present ? "Ready" : "Missing"}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  Active path: <span className="text-app-text">{localRuntimeStatus.tts.active_engine}</span>
                </p>
                <p className="mt-1 font-medium text-app-text-muted">
                  State: <span className="text-app-text">{localRuntimeStatus.tts.speaking ? "Speaking" : "Idle"}</span>
                </p>
                <p className="mt-1 break-all text-xs font-medium text-app-text-muted">
                  {localRuntimeStatus.tts.model_path ?? localRuntimeStatus.tts.command_path}
                </p>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Enable ROSIE
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Allows chat transport for this workstation.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.enabled}
              onChange={(e) => updateLocalSettings({ enabled: e.target.checked })}
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Local First
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Tauri tries the approved Host stack first, then falls back to
                Axum if direct transport fails.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.local_first}
              onChange={(e) =>
                updateLocalSettings({ local_first: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <p className="text-sm font-black uppercase tracking-widest text-app-text">
              Response Style
            </p>
            <p className="mt-2 text-sm font-medium text-app-text-muted">
              Controls whether ROSIE answers stay concise or add more context.
            </p>
            <select
              value={localSettings.response_style}
              onChange={(e) =>
                updateLocalSettings({
                  response_style: e.target.value === "detailed" ? "detailed" : "concise",
                })
              }
              className="ui-input mt-4 w-full"
            >
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Show Citations
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Keeps manual and policy references visible when the Ask ROSIE UI
                is wired on top of this transport.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.show_citations}
              onChange={(e) =>
                updateLocalSettings({ show_citations: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Voice Enabled
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Enables ROSIE voice input/output controls for this workstation.
                Voice replies run only through the Riverside desktop runtime.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ voice_enabled: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Speak Responses
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Speaks the normal text response after ROSIE finishes answering
                when the desktop voice runtime is available.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.speak_responses}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ speak_responses: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <label className="rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Voice
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Selects the Kokoro speaker preset for spoken ROSIE replies.
              </p>
            </div>
            <div className="mt-4 rounded-2xl border border-app-border bg-app-surface/70 p-4 text-xs font-medium text-app-text-muted">
              <p>
                TTS engine status:{" "}
                <strong className="text-app-text">
                  {!desktopVoiceRuntimeAvailable
                    ? "Desktop runtime required"
                    : kokoroVoiceControlsAvailable
                    ? "Using Kokoro speaker IDs"
                    : ttsFallbackActive
                      ? "Using native desktop fallback"
                      : "TTS unavailable"}
                </strong>
              </p>
              <p className="mt-2">
                {!desktopVoiceRuntimeAvailable
                  ? "This browser session is outside the Riverside desktop runtime, so ROSIE voice replies are unavailable here."
                  : kokoroVoiceControlsAvailable
                  ? "This workstation is on the approved Kokoro path, so speaker selection and preview use real Kokoro voices."
                  : ttsFallbackActive
                    ? "This workstation is not currently using Kokoro. Spoken replies may still work through the native desktop fallback, but speaker selection is disabled because that path does not map cleanly to Kokoro speaker IDs."
                    : "Speech output is currently unavailable on this workstation."}
              </p>
            </div>
            <select
              value={localSettings.selected_voice}
              disabled={!localSettings.voice_enabled || !kokoroVoiceControlsAvailable}
              onChange={(e) =>
                updateLocalSettings({
                  selected_voice: e.target.value,
                })
              }
              className="ui-input mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ROSIE_KOKORO_VOICE_OPTIONS.map((voice) => (
                <option key={voice.value} value={voice.value}>
                  {voice.label}
                </option>
              ))}
            </select>
            <p className="mt-3 text-xs font-medium text-app-text-muted">
              This Kokoro bundle exposes 53 speakers. Sherpa-ONNX reports the
              speaker count, but not a full friendly-name catalog for this
              bundle, so ROSIE shows numeric speaker IDs.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={testSelectedVoice}
                disabled={
                  !localSettings.voice_enabled ||
                  !kokoroVoiceControlsAvailable ||
                  localRuntimeStatus?.tts.model_present === false
                }
                className="ui-btn-secondary px-4 py-2 text-[11px] font-black uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              >
                Test Selected Voice
              </button>
              <button
                type="button"
                onClick={stopVoicePreview}
                disabled={!voicePreviewSpeaking}
                className="ui-btn-secondary px-4 py-2 text-[11px] font-black uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              >
                Stop Preview
              </button>
            </div>
            <p className="mt-3 text-xs font-medium text-app-text-muted">
              Test sentence: {ROSIE_VOICE_TEST_SENTENCE}
            </p>
          </label>

          <label className="rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <p className="text-sm font-black uppercase tracking-widest text-app-text">
              Speech Rate
            </p>
            <p className="mt-2 text-sm font-medium text-app-text-muted">
              Narrow playback range for ROSIE voice replies.
            </p>
            <select
              value={String(localSettings.speech_rate)}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ speech_rate: Number(e.target.value) })
              }
              className="ui-input mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="0.8">Slow</option>
              <option value="1">Normal</option>
              <option value="1.2">Fast</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-4 rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Microphone Enabled
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Lets Ask ROSIE capture audio and transcribe it into the normal text flow.
              </p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.microphone_enabled}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ microphone_enabled: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-border text-app-accent focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <label className="rounded-2xl border border-app-border bg-app-surface/60 p-5">
            <p className="text-sm font-black uppercase tracking-widest text-app-text">
              Microphone Mode
            </p>
            <p className="mt-2 text-sm font-medium text-app-text-muted">
              Push-to-talk starts recording while you hold the mic button. Toggle starts and stops on tap.
            </p>
            <select
              value={localSettings.microphone_mode}
              disabled={!localSettings.voice_enabled || !localSettings.microphone_enabled}
              onChange={(e) =>
                updateLocalSettings({
                  microphone_mode: e.target.value === "toggle" ? "toggle" : "push_to_talk",
                })
              }
              className="ui-input mt-4 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="push_to_talk">Push To Talk</option>
              <option value="toggle">Toggle</option>
            </select>
          </label>
        </div>
      </section>

      {canManageStoreDefaults && (
        <section className="ui-card p-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Store Default
              </h3>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Optional baseline saved in store settings for admin-managed
                defaults across workstations.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  if (storeDefaults) {
                    setLocalSettings(storeDefaults);
                    toast("ROSIE store default applied to this workstation", "success");
                  }
                }}
                disabled={storeBusy || storeDefaults == null}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
              >
                <RefreshCw className="h-4 w-4" />
                Apply To Workstation
              </button>
              <button
                type="button"
                onClick={() => void loadStoreDefaults()}
                disabled={storeBusy}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
              >
                <RefreshCw
                  className={`h-4 w-4 ${storeBusy ? "animate-spin" : ""}`}
                />
                Reload
              </button>
              <button
                type="button"
                onClick={() => void saveStoreDefaults()}
                disabled={storeBusy}
                className="ui-btn-primary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
              >
                <Save className="h-4 w-4" />
                Save Store Default
              </button>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-app-border bg-app-surface/60 p-5 text-sm font-medium text-app-text-muted">
            {!storeLoaded && "Loading store default…"}
            {storeLoaded && storeDefaults == null && (
              <span>No ROSIE store default has been saved yet.</span>
            )}
            {storeLoaded && storeDefaults != null && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <span>
                  Enabled:{" "}
                  <strong className="text-app-text">
                    {storeDefaults.enabled ? "On" : "Off"}
                  </strong>
                </span>
                <span>
                  Local first:{" "}
                  <strong className="text-app-text">
                    {storeDefaults.local_first ? "On" : "Off"}
                  </strong>
                </span>
                <span>
                  Response style:{" "}
                  <strong className="text-app-text capitalize">
                    {storeDefaults.response_style}
                  </strong>
                </span>
                <span>
                  Citations:{" "}
                  <strong className="text-app-text">
                    {storeDefaults.show_citations ? "On" : "Off"}
                  </strong>
                </span>
                <span>
                  Voice:{" "}
                  <strong className="text-app-text">
                    {storeDefaults.voice_enabled
                      ? `Speaker ${storeDefaults.selected_voice}`
                      : "Off"}
                  </strong>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {canManageIntelligence && (
        <section className="ui-card p-8" data-testid="rosie-intelligence-section">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Governed Intelligence Pack
              </h3>
              <p className="mt-2 max-w-3xl text-sm font-medium text-app-text-muted">
                ROSIE improves only from approved manuals, staff docs, contract
                docs, generated Help outputs, and optional curated redacted
                traces. It does not learn from raw production data, unrestricted
                conversation history, or autonomous prompt mutation.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void loadIntelligenceStatus()}
                disabled={intelligenceBusy}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-reload"
              >
                <RefreshCw
                  className={`h-4 w-4 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Reload
              </button>
              <button
                type="button"
                onClick={() => void runIntelligenceRefresh(false)}
                disabled={intelligenceBusy}
                className="ui-btn-secondary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-refresh"
              >
                <RefreshCw
                  className={`h-4 w-4 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Refresh Pack
              </button>
              <button
                type="button"
                onClick={() => void runIntelligenceRefresh(true)}
                disabled={intelligenceBusy}
                className="ui-btn-primary flex items-center gap-2 px-4 py-2 text-[11px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-refresh-reindex"
              >
                <RefreshCw
                  className={`h-4 w-4 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Refresh + Reindex Help
              </button>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-app-border bg-app-surface/60 p-5 text-sm font-medium text-app-text-muted">
            {!intelligenceLoaded && "Loading governed intelligence status…"}
            {intelligenceLoaded && intelligenceStatus == null && (
              <span>You need help.manage permission to review ROSIE intelligence governance.</span>
            )}
            {intelligenceStatus != null && (
              <div className="space-y-6">
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <span>
                    Policy pack:{" "}
                    <strong className="text-app-text">
                      {intelligenceStatus.pack.policy_pack_version}
                    </strong>
                  </span>
                  <span>
                    Intelligence pack:{" "}
                    <strong className="text-app-text">
                      {intelligenceStatus.pack.intelligence_pack_version}
                    </strong>
                  </span>
                  <span>
                    Last generated Help artifact:{" "}
                    <strong className="text-app-text">
                      {formatTimestamp(intelligenceStatus.pack.last_generated_at)}
                    </strong>
                  </span>
                  <span>
                    Last Help reindex:{" "}
                    <strong className="text-app-text">
                      {formatTimestamp(intelligenceStatus.last_reindex_at)}
                    </strong>
                  </span>
                  <span>
                    Node available:{" "}
                    <strong className="text-app-text">
                      {intelligenceStatus.node_available ? "Yes" : "No"}
                    </strong>
                  </span>
                  <span>
                    Meilisearch configured:{" "}
                    <strong className="text-app-text">
                      {intelligenceStatus.meilisearch_configured ? "Yes" : "No"}
                    </strong>
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  {intelligenceStatus.pack.approved_source_groups.map((group) => (
                    <div
                      key={group.key}
                      className="rounded-2xl border border-app-border bg-app-surface p-4"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                          {group.label}
                        </h4>
                        <span className="rounded-full border border-app-border bg-app-surface-2 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-app-text">
                          {group.source_count} source{group.source_count === 1 ? "" : "s"}
                        </span>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
                        {group.description}
                      </p>
                      <div className="mt-3 rounded-xl border border-app-border/70 bg-app-surface-2/80 p-3">
                        <p className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">
                          Paths
                        </p>
                        <div className="mt-2 space-y-1 font-mono text-[11px] text-app-text-muted">
                          {group.source_paths.slice(0, 4).map((path) => (
                            <p key={path}>{path}</p>
                          ))}
                          {group.source_paths.length > 4 && (
                            <p>+{group.source_paths.length - 4} more approved paths</p>
                          )}
                          {group.source_paths.length === 0 && <p>No approved files enabled.</p>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-2xl border border-app-border bg-app-surface p-4">
                    <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                      Excluded Sources
                    </h4>
                    <div className="mt-3 space-y-2 text-sm text-app-text-muted">
                      {intelligenceStatus.pack.excluded_source_rules.map((rule) => (
                        <p key={rule}>- {rule}</p>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-app-border bg-app-surface p-4">
                    <h4 className="text-xs font-black uppercase tracking-widest text-app-text">
                      Governance Issues
                    </h4>
                    <div className="mt-3 space-y-2 text-sm text-app-text-muted">
                      {intelligenceStatus.pack.issues_detected.length === 0 && (
                        <p>No approved-source drift is currently detected.</p>
                      )}
                      {intelligenceStatus.pack.issues_detected.map((issue) => (
                        <p key={`${issue.path}:${issue.issue}`}>
                          - <span className="font-mono">{issue.path}</span>: {issue.issue}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
