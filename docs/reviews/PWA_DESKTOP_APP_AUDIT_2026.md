# Audit Report: PWA & Desktop App Subsystems

**Date:** 2026-04-22  
**Status:** Updated after host-mode hardening

## Summary

The original audit correctly identified the Tauri host-mode path as the highest-risk deployment/runtime gap. That gap is now narrowed in the product:

- the Tauri host wrapper resolves and reports an explicit frontend bundle path for satellite clients
- host startup no longer reports success before readiness
- host startup failures are surfaced directly in the Remote Access panel
- operator-facing host flow no longer relies on placeholder Stripe input in the UI

## Important correction to the earlier audit

The earlier note claiming the Tauri updater was “missing or commented out” was stale. The updater is present in the desktop shell and supported by the Windows updater workflow. The larger real gap was the **host-mode startup contract**, not updater wiring.

## Remaining posture

This does **not** mean every deployment/runtime concern is complete. The broader PWA/Tauri surface still needs additional work over time, but the clearest blocker to the intended **Windows host + PWA satellite** model is now addressed more honestly:

- satellite serving is explicit
- failure reporting is explicit
- host-mode docs and help now match the runtime path more closely
