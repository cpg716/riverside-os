# AI / ROSIE Documentation

Status: **Canonical front door** for RiversideOS AI, ROSIE, assistant-routing, reporting allowlists, and retired ROS-AI history. Start here before editing local LLM runtime behavior, Help Center assistant behavior, AI reporting routes, or old `/api/ai` references.

RiversideOS now separates three ideas that older docs sometimes grouped together:

- **Help Center search**: shipped Help manuals and `GET /api/help/search`, with optional Meilisearch `ros_help`.
- **ROSIE**: RiversideOS Intelligence Engine, the governed assistant stack under `/api/help/rosie/v1/*` plus the Tauri/Host runtime.
- **Retired ROS-AI**: the pre-migration-78 `/api/ai/*`, `ai_doc_chunk`, `ai_saved_report`, and `ros-gemma` worker history.

## Start Here

| Need | Document |
|---|---|
| ROSIE runtime / deployment stack | [ROSIE_HOST_STACK.md](ROSIE_HOST_STACK.md) |
| ROSIE safety and operating contract | [ROSIE_OPERATING_CONTRACT.md](ROSIE_OPERATING_CONTRACT.md) |
| ROSIE product architecture, Help automation, tools, and policy bundle | [PLAN_LOCAL_LLM_HELP.md](PLAN_LOCAL_LLM_HELP.md) |
| Assistant routing, answer policy, and prompt/runtime contract | [AI_CONTEXT_FOR_ASSISTANTS.md](AI_CONTEXT_FOR_ASSISTANTS.md) |
| Curated Reports and NL reporting route allowlist | [AI_REPORTING_DATA_CATALOG.md](AI_REPORTING_DATA_CATALOG.md) |
| Product ideas and rollout evaluation | [AI_INTEGRATION_OUTLOOK.md](AI_INTEGRATION_OUTLOOK.md) |
| Retired ROS-AI stack pointer | [../ROS_AI_INTEGRATION_PLAN.md](../ROS_AI_INTEGRATION_PLAN.md) |
| Retired `/api/ai/*` HTTP contract | [API_AI.md](API_AI.md) |
| Retired `ai_doc_chunk` help corpus guide | [ROS_AI_HELP_CORPUS.md](ROS_AI_HELP_CORPUS.md) |
| Retired `ros-gemma` worker guide | [ROS_GEMMA_WORKER.md](ROS_GEMMA_WORKER.md) |
| Help Center authoring and `ros_help` search | [MANUAL_CREATION.md](MANUAL_CREATION.md), [../PLAN_HELP_CENTER.md](../PLAN_HELP_CENTER.md) |

## Maintenance Rules

- Do not describe `/api/ai/*`, `ai_doc_chunk`, `ai_saved_report`, `ai_assist`, or `ai_reports` as active after migration 78.
- ROSIE runtime behavior must preserve RBAC parity, read-only model tooling, and the operating contract.
- Numeric/reporting answers must map through [AI_REPORTING_DATA_CATALOG.md](AI_REPORTING_DATA_CATALOG.md); never introduce arbitrary SQL as an assistant path.
- Help Center manual generation belongs to [MANUAL_CREATION.md](MANUAL_CREATION.md); retired `reindex:staff-docs` / `/api/ai/admin/reindex-docs` references should not be used for current help search.
- When ROSIE tool policy, route allowlists, or safety behavior changes, update [ROSIE_OPERATING_CONTRACT.md](ROSIE_OPERATING_CONTRACT.md), [AI_CONTEXT_FOR_ASSISTANTS.md](AI_CONTEXT_FOR_ASSISTANTS.md), and [PLAN_LOCAL_LLM_HELP.md](PLAN_LOCAL_LLM_HELP.md) together.
