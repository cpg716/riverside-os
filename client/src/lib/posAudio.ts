/**
 * posAudio — wraps scanSounds to support user-selected sound profiles in the POS.
 */
import { 
  playScanSuccess, 
  playScanWarning, 
  playScanError, 
  playScanChirp, 
  playScanRetro, 
  warmUpAudio as rawWarmUp 
} from "./scanSounds";

export type PosSoundProfile = "classic" | "soft" | "modern" | "retro" | "silent";

function getProfile(): PosSoundProfile {
  const saved = window.localStorage.getItem("ros.pos.soundProfile");
  if (saved === "classic" || saved === "soft" || saved === "modern" || saved === "retro" || saved === "silent") {
    return saved;
  }
  return "classic"; // default
}

export function playPosScanSuccess(): void {
  const p = getProfile();
  if (p === "silent") return;
  
  switch (p) {
    case "soft":
      playScanWarning();
      break;
    case "modern":
      playScanChirp();
      break;
    case "retro":
      playScanRetro();
      break;
    default:
      playScanSuccess();
      break;
  }
}

export function playPosScanError(): void {
  const p = getProfile();
  if (p === "silent") return;
  playScanError(); // Error is always the distinct buzzer even in soft mode, for safety
}

export function warmUpPosAudio(): void {
  rawWarmUp();
}
