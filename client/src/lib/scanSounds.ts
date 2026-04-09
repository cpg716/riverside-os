/**
 * scanSounds — synthesized audio feedback using Web Audio API.
 * Zero dependencies, zero audio files.
 */

let _ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  // Resume if suspended (browser policy requires user gesture first)
  if (_ctx.state === "suspended") {
    void _ctx.resume();
  }
  return _ctx;
}

function playTone(
  frequency: number,
  duration: number,
  type: OscillatorType = "sine",
  gain = 0.3,
  startDelay = 0,
): void {
  try {
    const ctx = getCtx();
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + startDelay);

    gainNode.gain.setValueAtTime(0, ctx.currentTime + startDelay);
    gainNode.gain.linearRampToValueAtTime(gain, ctx.currentTime + startDelay + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(
      0.001,
      ctx.currentTime + startDelay + duration,
    );

    oscillator.start(ctx.currentTime + startDelay);
    oscillator.stop(ctx.currentTime + startDelay + duration);
  } catch {
    // Audio not available — silent fallback
  }
}

/**
 * Plays a pleasant chime for a successful scan.
 * Two ascending tones: 880Hz → 1046Hz (A5 → C6).
 */
export function playScanSuccess(): void {
  playTone(880, 0.12, "sine", 0.28, 0);
  playTone(1046, 0.15, "sine", 0.22, 0.1);
}

/**
 * Plays a distinct error buzzer for an unknown item scan.
 * Two descending square-wave pulses at 220Hz (low, harsh).
 */
export function playScanError(): void {
  playTone(280, 0.18, "square", 0.25, 0);
  playTone(220, 0.2, "square", 0.2, 0.22);
}

/**
 * Plays a soft single beep for a "needs review" / qty-maxed warning.
 */
export function playScanWarning(): void {
  playTone(440, 0.18, "triangle", 0.2, 0);
}

/**
 * Plays a modern, high-frequency pleasant chirp for a successful scan.
 * Fast rise/fall on sine sweep.
 */
export function playScanChirp(): void {
  playTone(1661, 0.08, "sine", 0.15, 0);
  playTone(2093, 0.1, "sine", 0.12, 0.04);
}

/**
 * Plays a retro, arcade-style blip.
 * Square wave with descending pitch.
 */
export function playScanRetro(): void {
  playTone(1000, 0.15, "square", 0.1, 0);
}

/**
 * Warms up the AudioContext (must be called from a user gesture handler).
 * Call this once on first user interaction to avoid browser policy blocks.
 */
export function warmUpAudio(): void {
  try {
    const ctx = getCtx();
    void ctx.resume();
  } catch {
    // AudioContext unavailable
  }
}
