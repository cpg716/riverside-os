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
  rosieVoiceLabel,
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
      const status = await getRosieLocalRuntimeStatus({
        headers: backofficeHeaders() as Record<string, string>,
      });
      setLocalRuntimeStatus(status);
    } catch {
      setLocalRuntimeStatus(null);
    } finally {
      setLocalRuntimeLoaded(true);
      setLocalRuntimeBusy(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void loadLocalRuntime();
  }, [loadLocalRuntime]);

  useEffect(() => {
    return () => {
      stopRosieSpeechPlayback({ headers: backofficeHeaders() as Record<string, string> });
    };
  }, [backofficeHeaders]);

  const updateLocalSettings = (patch: Partial<RosieSettings>) => {
    setLocalSettings((prev) => mergeRosieSettings({ ...prev, ...patch }, null));
  };

  const testSelectedVoice = () => {
    stopRosieSpeechPlayback({ headers: backofficeHeaders() as Record<string, string> });
    setVoicePreviewSpeaking(false);
    try {
      speakRosieText(ROSIE_VOICE_TEST_SENTENCE, {
        rate: localSettings.speech_rate,
        voice: localSettings.selected_voice,
        headers: backofficeHeaders() as Record<string, string>,
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
    stopRosieSpeechPlayback({ headers: backofficeHeaders() as Record<string, string> });
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
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-app-border bg-app-surface-2 text-app-accent">
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

        <div className="mt-6 rounded-2xl border border-app-border bg-app-surface p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black uppercase tracking-widest text-app-text">
                Host Runtime Status
              </p>
              <p className="mt-2 text-sm font-medium text-app-text-muted">
                Visibility into the host ROSIE LLM, speech-to-text, and
                speech output path serving this workstation.
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
              Checking host ROSIE runtime…
            </p>
          ) : localRuntimeStatus == null ? (
            <p className="mt-4 text-sm font-medium text-app-text-muted">
              The host ROSIE runtime could not be reached from this workstation.
            </p>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-black uppercase tracking-widest text-app-text">LLM</p>
                  <div className={`h-2 w-2 rounded-full ${localRuntimeStatus.llm.model_present && localRuntimeStatus.llm.running ? "bg-green-500" : "bg-red-500"}`} />
                </div>
                <p className="mt-3 text-sm font-bold text-app-text">{localRuntimeStatus.llm.model_name}</p>
                <p className="mt-1 text-xs text-app-text-muted">{localRuntimeStatus.llm.runtime_name}</p>
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className="text-app-text-muted">Status:</span>
                  <span className={`font-medium ${localRuntimeStatus.llm.model_present && localRuntimeStatus.llm.running ? "text-green-600" : "text-red-600"}`}>
                    {localRuntimeStatus.llm.model_present ? (localRuntimeStatus.llm.running ? "Running" : "Stopped") : "Missing"}
                  </span>
                </div>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-black uppercase tracking-widest text-app-text">Speech To Text</p>
                  <div className={`h-2 w-2 rounded-full ${localRuntimeStatus.stt.model_present ? "bg-green-500" : "bg-red-500"}`} />
                </div>
                <p className="mt-3 text-sm font-bold text-app-text">{localRuntimeStatus.stt.engine_name}</p>
                <p className="mt-1 text-xs text-app-text-muted">Active: {localRuntimeStatus.stt.active_engine}</p>
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className="text-app-text-muted">Status:</span>
                  <span className={`font-medium ${localRuntimeStatus.stt.model_present ? "text-green-600" : "text-red-600"}`}>
                    {localRuntimeStatus.stt.model_present ? "Ready" : "Missing Model"}
                  </span>
                </div>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-black uppercase tracking-widest text-app-text">Speech Output</p>
                  <div className={`h-2 w-2 rounded-full ${localRuntimeStatus.tts.model_present ? "bg-green-500" : "bg-red-500"}`} />
                </div>
                <p className="mt-3 text-sm font-bold text-app-text">{localRuntimeStatus.tts.engine_name}</p>
                <p className="mt-1 text-xs text-app-text-muted">Active: {localRuntimeStatus.tts.active_engine}</p>
                <div className="mt-3 flex items-center gap-2 text-xs">
                  <span className="text-app-text-muted">State:</span>
                  <span className={`font-medium ${localRuntimeStatus.tts.speaking ? "text-blue-600" : "text-gray-600"}`}>
                    {localRuntimeStatus.tts.speaking ? "Speaking" : "Idle"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Enable ROSIE</p>
              <p className="mt-1 text-xs text-app-text-muted">Chat transport for this workstation</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.enabled}
              onChange={(e) => updateLocalSettings({ enabled: e.target.checked })}
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Local First</p>
              <p className="mt-1 text-xs text-app-text-muted">Try Host stack first, then Axum fallback</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.local_first}
              onChange={(e) =>
                updateLocalSettings({ local_first: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent"
            />
          </label>

          <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col justify-between">
            <div>
              <p className="text-sm font-bold text-app-text">Response Style</p>
              <p className="mt-1 text-xs text-app-text-muted">Concise or detailed answers</p>
            </div>
            <select
              value={localSettings.response_style}
              onChange={(e) =>
                updateLocalSettings({
                  response_style: e.target.value === "detailed" ? "detailed" : "concise",
                })
              }
              className="ui-input mt-3 w-full"
            >
              <option value="concise">Concise</option>
              <option value="detailed">Detailed</option>
            </select>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Show Citations</p>
              <p className="mt-1 text-xs text-app-text-muted">Show manual and policy references</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.show_citations}
              onChange={(e) =>
                updateLocalSettings({ show_citations: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Voice Enabled</p>
              <p className="mt-1 text-xs text-app-text-muted">Voice input/output controls</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ voice_enabled: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent"
            />
          </label>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface/60 p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Speak Responses</p>
              <p className="mt-1 text-xs text-app-text-muted">Speak text after answering</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.speak_responses}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ speak_responses: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-bold text-app-text">Voice</p>
                <div className={`h-2 w-2 rounded-full ${kokoroVoiceControlsAvailable ? "bg-green-500" : "bg-yellow-500"}`} />
              </div>
              <p className="mt-1 text-xs text-app-text-muted">
                {kokoroVoiceControlsAvailable ? "Kokoro voices available" : "TTS unavailable"}
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
              className="ui-input mt-3 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ROSIE_KOKORO_VOICE_OPTIONS.map((voice) => (
                <option key={voice.value} value={voice.value}>
                  {voice.label}
                </option>
              ))}
            </select>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={testSelectedVoice}
                disabled={
                  !localSettings.voice_enabled ||
                  !kokoroVoiceControlsAvailable ||
                  localRuntimeStatus?.tts.model_present === false
                }
                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              >
                Test
              </button>
              <button
                type="button"
                onClick={stopVoicePreview}
                disabled={!voicePreviewSpeaking}
                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest disabled:cursor-not-allowed disabled:opacity-50"
              >
                Stop
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col justify-between">
            <div>
              <p className="text-sm font-bold text-app-text">Speech Rate</p>
              <p className="mt-1 text-xs text-app-text-muted">Control the TTS speed</p>
            </div>
            <select
              value={String(localSettings.speech_rate)}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ speech_rate: Number(e.target.value) })
              }
              className="ui-input mt-3 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="0.8">Slow</option>
              <option value="1">Normal</option>
              <option value="1.2">Fast</option>
            </select>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-xl border border-app-border bg-app-surface p-4 cursor-pointer">
            <div>
              <p className="text-sm font-bold text-app-text">Microphone Enabled</p>
              <p className="mt-1 text-xs text-app-text-muted">Capture audio for transcription</p>
            </div>
            <input
              type="checkbox"
              checked={localSettings.microphone_enabled}
              disabled={!localSettings.voice_enabled}
              onChange={(e) =>
                updateLocalSettings({ microphone_enabled: e.target.checked })
              }
              className="h-5 w-5 rounded border-app-input-border bg-app-input-bg text-app-accent focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <div className="rounded-xl border border-app-border bg-app-surface p-4 flex flex-col justify-between">
            <div>
              <p className="text-sm font-bold text-app-text">Microphone Mode</p>
              <p className="mt-1 text-xs text-app-text-muted">Push to talk or toggle behavior</p>
            </div>
            <select
              value={localSettings.microphone_mode}
              disabled={!localSettings.voice_enabled || !localSettings.microphone_enabled}
              onChange={(e) =>
                updateLocalSettings({
                  microphone_mode: e.target.value === "toggle" ? "toggle" : "push_to_talk",
                })
              }
              className="ui-input mt-3 w-full disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="push_to_talk">Push To Talk</option>
              <option value="toggle">Toggle</option>
            </select>
          </div>
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

          <div className="mt-6 rounded-2xl border border-app-border bg-app-surface p-5 text-sm font-medium text-app-text-muted">
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
                      ? rosieVoiceLabel(storeDefaults.selected_voice)
                      : "Off"}
                  </strong>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {canManageIntelligence && (
        <section className="ui-card p-6" data-testid="rosie-intelligence-section">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Governed Intelligence Pack
              </h3>
              <p className="mt-1 text-xs text-app-text-muted">
                Approved knowledge sources and governance rules for ROSIE
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadIntelligenceStatus()}
                disabled={intelligenceBusy}
                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-reload"
              >
                <RefreshCw
                  className={`h-3 w-3 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Reload
              </button>
              <button
                type="button"
                onClick={() => void runIntelligenceRefresh(false)}
                disabled={intelligenceBusy}
                className="ui-btn-secondary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-refresh"
              >
                <RefreshCw
                  className={`h-3 w-3 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Refresh
              </button>
              <button
                type="button"
                onClick={() => void runIntelligenceRefresh(true)}
                disabled={intelligenceBusy}
                className="ui-btn-primary px-3 py-1.5 text-[10px] font-black uppercase tracking-widest"
                data-testid="rosie-intelligence-refresh-reindex"
              >
                <RefreshCw
                  className={`h-3 w-3 ${intelligenceBusy ? "animate-spin" : ""}`}
                />
                Refresh + Reindex
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-app-border bg-app-surface/60 p-4 text-sm font-medium text-app-text-muted">
            {!intelligenceLoaded && "Loading intelligence status…"}
            {intelligenceLoaded && intelligenceStatus == null && (
              <span>Requires help.manage permission</span>
            )}
            {intelligenceStatus != null && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Policy Pack</p>
                    <p className="mt-1 text-sm font-bold text-app-text">{intelligenceStatus.pack.policy_pack_version}</p>
                  </div>
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Intelligence Pack</p>
                    <p className="mt-1 text-sm font-bold text-app-text">{intelligenceStatus.pack.intelligence_pack_version}</p>
                  </div>
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Last Generated</p>
                    <p className="mt-1 text-sm font-bold text-app-text">{formatTimestamp(intelligenceStatus.pack.last_generated_at)}</p>
                  </div>
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Last Reindex</p>
                    <p className="mt-1 text-sm font-bold text-app-text">{formatTimestamp(intelligenceStatus.last_reindex_at)}</p>
                  </div>
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Runtime</p>
                    <p className={`mt-1 text-sm font-bold ${intelligenceStatus.node_available ? "text-green-600" : "text-red-600"}`}>
                      {intelligenceStatus.node_available ? "Available" : "Unavailable"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-app-surface-2 p-3">
                    <p className="text-[10px] uppercase tracking-widest text-app-text-muted">Meilisearch</p>
                    <p className={`mt-1 text-sm font-bold ${intelligenceStatus.meilisearch_configured ? "text-green-600" : "text-red-600"}`}>
                      {intelligenceStatus.meilisearch_configured ? "Configured" : "Not configured"}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {intelligenceStatus.pack.approved_source_groups.map((group) => (
                    <div
                      key={group.key}
                      className="rounded-xl border border-app-border bg-app-surface p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="text-xs font-bold text-app-text">{group.label}</h4>
                        <span className="rounded-full bg-app-surface-2 px-2 py-0.5 text-[10px] font-bold text-app-text">
                          {group.source_count}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-app-text-muted">{group.description}</p>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="rounded-xl border border-app-border bg-app-surface p-3">
                    <h4 className="text-xs font-bold text-app-text">Excluded Sources</h4>
                    <div className="mt-2 space-y-1 text-xs text-app-text-muted">
                      {intelligenceStatus.pack.excluded_source_rules.map((rule) => (
                        <p key={rule}>- {rule}</p>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-app-border bg-app-surface p-3">
                    <h4 className="text-xs font-bold text-app-text">Governance Issues</h4>
                    <div className="mt-2 space-y-1 text-xs text-app-text-muted">
                      {intelligenceStatus.pack.issues_detected.length === 0 && (
                        <p className="text-green-600">No issues detected</p>
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

      {canManageIntelligence && (
        <section className="ui-card p-8">
          <RosieTokenMonitor backofficeHeaders={backofficeHeaders} />
        </section>
      )}
    </div>
  );
}

interface RosieTokenMonitorProps {
  backofficeHeaders: () => HeadersInit;
}

function RosieTokenMonitor({ backofficeHeaders }: RosieTokenMonitorProps) {
  const [metrics, setMetrics] = useState({ daily: 0, monthly: 0, cost: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/settings/rosie/token-metrics`, {
          headers: backofficeHeaders(),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        setMetrics({
          daily: data.daily_tokens || 0,
          monthly: data.monthly_tokens || 0,
          cost: Number(data.estimated_monthly_cost) || 0,
        });
      } catch (error) {
        console.error("Failed to fetch ROSIE token metrics:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
  }, [backofficeHeaders]);

  return (
    <div>
      <h3 className="text-sm font-black uppercase tracking-widest text-app-text mb-4">
        ROSIE Intelligence Usage
      </h3>
      {loading ? (
        <p className="text-sm font-medium text-app-text-muted">Loading token metrics…</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="space-y-1">
            <p className="text-sm text-app-text-muted">Daily Token Use</p>
            <p className="text-2xl font-mono text-app-text">{metrics.daily.toLocaleString()}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-app-text-muted">Actual Monthly Usage</p>
            <p className="text-2xl font-mono text-app-text">{metrics.monthly.toLocaleString()}</p>
          </div>
          <div className="space-y-1">
            <p className="text-sm text-app-text-muted">Estimated Monthly Cost</p>
            <p className="text-2xl font-mono text-green-600">${Number(metrics.cost).toFixed(2)}</p>
          </div>
        </div>
      )}
      <p className="mt-4 text-[10px] text-app-text-muted">
        * Estimates based on current provider rates ($0.50 per 1M tokens placeholder).
      </p>
    </div>
  );
}
