import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const rosieClientSource = readFileSync(
  new URL("../src/lib/rosie.ts", import.meta.url),
  "utf8",
);
const serverSpeechSource = readFileSync(
  new URL("../../server/src/logic/rosie_speech.rs", import.meta.url),
  "utf8",
);
const tauriSpeechSource = readFileSync(
  new URL("../src-tauri/src/rosie_voice.rs", import.meta.url),
  "utf8",
);
const windowsSpeechProbeSource = readFileSync(
  new URL("../../deployment/windows/watch-rosie-stack.ps1", import.meta.url),
  "utf8",
);

test("ROSIE uses the English speech profile on every Riverside speech path", () => {
  for (const source of [
    serverSpeechSource,
    tauriSpeechSource,
    windowsSpeechProbeSource,
  ]) {
    expect(source).toContain("--kokoro-lang=en-us");
  }
  for (const source of [serverSpeechSource, tauriSpeechSource]) {
    expect(source).toContain("if valid_wav_artifact(temp_wav)");
    expect(source).toContain("let transcript = parse_sherpa_onnx_offline_output");
  }
  for (const source of [
    serverSpeechSource,
    tauriSpeechSource,
    windowsSpeechProbeSource,
  ]) {
    expect(source).toContain("--sense-voice-language=en");
    expect(source).toContain("--sense-voice-use-itn=1");
  }
  expect(windowsSpeechProbeSource).toContain(
    '"`"Voice recognition is working correctly`""',
  );
  expect(windowsSpeechProbeSource).not.toContain(
    "Riverside Rosie health check",
  );
  expect(windowsSpeechProbeSource).toContain("$process.WaitForExit()");
  expect(windowsSpeechProbeSource).toContain(
    "$wavReady = Test-WavFixture $probeWav",
  );
  expect(windowsSpeechProbeSource).not.toContain(
    "$wavReady = $ttsProbe.success -and",
  );
  expect(windowsSpeechProbeSource).not.toContain(
    "$recognized = $sttProbe.success -and",
  );
  expect(windowsSpeechProbeSource).toContain(
    'stt_error = "Skipped because the TTS fixture was not certified."',
  );
  expect(windowsSpeechProbeSource).toContain(
    'TTS=$ttsResult; STT=$sttResult.',
  );
});

test("ROSIE Chat converts speech engine diagnostics into staff-facing guidance", () => {
  expect(rosieClientSource).toContain("function rosieSpeechErrorForStaff");
  expect(rosieClientSource).toContain(
    "ROSIE voice output could not start. Text chat is still available; ask a manager to check ROSIE Speech in Settings.",
  );
  expect(rosieClientSource).toContain("rosieSpeechErrorForStaff(message)");
});
