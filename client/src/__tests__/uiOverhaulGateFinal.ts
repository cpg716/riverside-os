// Final UI Overhaul gate test - asserts both flag states deterministically
import { uiOverhaulGatingCheck } from './uiOverhaulGate';

export function runUIOverhaulFinalGateTest(): boolean {
  const enabled = uiOverhaulGatingCheck(true);
  const disabled = uiOverhaulGatingCheck(false);

  if (enabled !== 'PLACEHOLDER_RENDER') {
    throw new Error(`Final gate: enabled should return PLACEHOLDER_RENDER, got ${enabled}`);
  }

  if (disabled !== 'OLD_UI_RENDER') {
    throw new Error(`Final gate: disabled should return OLD_UI_RENDER, got ${disabled}`);
  }

  return true;
}