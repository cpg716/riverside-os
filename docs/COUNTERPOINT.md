# Counterpoint Documentation Index

**Status:** Canonical Counterpoint front door. Start here when changing Counterpoint import, bridge packaging, staging, mapping, or operator instructions.

Riverside OS treats Counterpoint as a **one-way migration / ingest source**. Counterpoint data flows into ROS through the Node bridge and token-protected sync API; ROS does not write back to Counterpoint. After cutover, ROS is the system of record and the bridge should be retired or kept disabled unless leadership explicitly approves another controlled import.

## Where To Go

| Need | Canonical doc | Notes |
| --- | --- | --- |
| Engineering setup and mapping | [`COUNTERPOINT_SYNC_GUIDE.md`](COUNTERPOINT_SYNC_GUIDE.md) | Main technical guide for server config, bridge install, entity mapping, status, provenance, and troubleshooting. |
| Operator bridge workflow | [`COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`](COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md) | Operator-facing manual for direct vs staging mode, Settings hub, prerequisites, and bridge/API update workflow. |
| One-time migration runbook | [`COUNTERPOINT_ONE_TIME_IMPORT.md`](COUNTERPOINT_ONE_TIME_IMPORT.md) | Cutover checklist, `CP_IMPORT_SINCE`, fixed entity order, store credit, open docs, validation, reset, and bridge retirement. |
| Bridge troubleshooting | [`BRIDGE_SYNC_TROUBLESHOOTING.md`](BRIDGE_SYNC_TROUBLESHOOTING.md) | Connection, retry, away-mode, token, and common sync failures. |
| Implementation roadmap / design trace | [`PLAN_COUNTERPOINT_ROS_SYNC.md`](PLAN_COUNTERPOINT_ROS_SYNC.md) | Historical roadmap and remaining deferred decisions. Do not use it instead of the current guides above. |
| Windows bridge package | [`../counterpoint-bridge/README.md`](../counterpoint-bridge/README.md) | Package-local instructions that travel with the bridge folder / zip. |

## Maintenance Rules

- Keep setup, mapping, and API truth in [`COUNTERPOINT_SYNC_GUIDE.md`](COUNTERPOINT_SYNC_GUIDE.md).
- Keep staff/operator click-paths in [`COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md`](COUNTERPOINT_BRIDGE_OPERATOR_MANUAL.md).
- Keep cutover and retirement evidence in [`COUNTERPOINT_ONE_TIME_IMPORT.md`](COUNTERPOINT_ONE_TIME_IMPORT.md).
- Keep packaged bridge instructions in `counterpoint-bridge/README.md` aligned with this index and the one-time import runbook.
- If a root-level Counterpoint note remains, link it from one of the canonical docs or mark it as historical.
