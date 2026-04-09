# Observability: tracing, OTLP, and bug-report snapshots

**Audience:** developers and ops. This doc covers the **Rust Axum** server’s diagnostic pipeline: structured **`tracing`**, optional **OpenTelemetry (OTLP)** export, **HTTP request spans** (`tower-http`), **bug-report log ring**, and how that differs from **browser Sentry** (optional on the client).

## Architecture (server)

| Piece | Role |
|--------|------|
| **`tracing` + `tracing-subscriber`** | Primary log/event API (`RUST_LOG`). Handlers and workers use **`tracing::info!`**, **`warn!`**, **`error!`** with structured fields — never **`eprintln!`**. |
| **`init_tracing_with_optional_otel`** (`server/src/observability/otel.rs`) | Builds the subscriber: **`EnvFilter`** → optional **OpenTelemetry layer** → **fmt** → **`ServerLogRingLayer`**. OTLP failures log after the subscriber starts (no stderr bootstrap spam). |
| **`ServerLogRing` / `ServerLogRingLayer`** (`server/src/observability/server_log_ring.rs`) | Bounded in-memory ring of recent formatted **API-side** lines for **Settings → Bug reports** snapshots — not a full host log. |
| **`TraceLayer::new_for_http()`** (`server/src/main.rs`) | **Outermost** Tower layer (after body limit + CORS) so each HTTP request gets a **`tracing`** span compatible with the OTel bridge. |
| **Shutdown** | **`opentelemetry::global::shutdown_tracer_provider()`** after **`axum::serve`** returns so batch exporters can flush on clean process exit. |

**Client:** optional **`@sentry/react`** when **`VITE_SENTRY_DSN`** is set (**`docs/PLAN_BUG_REPORTS.md`**). That is **independent** of server OTLP; there is no requirement to run both.

## Enabling OTLP traces

Export is **off** unless you opt in:

1. Set a non-empty **`OTEL_EXPORTER_OTLP_ENDPOINT`** and/or **`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`**, **or**
2. Set **`RIVERSIDE_OTEL_ENABLED=true`** (or **`1`**, **`yes`**, **`on`**) to enable with OTel’s default gRPC target (**`http://localhost:4317`**) when no endpoint is set.

**Disable explicitly:** **`RIVERSIDE_OTEL_ENABLED=false`** (also **`0`**, **`no`**, **`off`**) turns OTLP off even if OTLP env vars are present.

| Variable | Notes |
|----------|--------|
| **`OTEL_SERVICE_NAME`** | Resource attribute **`service.name`**; default **`riverside-server`**. |
| **`OTEL_EXPORTER_OTLP_PROTOCOL`** | Omit or use gRPC (**tonic**). Set **`http/protobuf`** for HTTP/protobuf collectors (often port **4318**). |
| **`OTEL_RESOURCE_ATTRIBUTES`**, **`OTEL_*`** | Standard OpenTelemetry environment conventions are merged via the SDK resource detectors where applicable. |

Full commented examples: **`server/.env.example`**.

### Local collector (quick test)

Many teams run the **OpenTelemetry Collector** or **Jaeger** with OTLP gRPC on **4317**. Example (image/version may vary):

```bash
docker run -p 4317:4317 -p 16686:16686 jaegertracing/all-in-one:latest
```

Point **`OTEL_EXPORTER_OTLP_ENDPOINT`** at your collector (or set **`RIVERSIDE_OTEL_ENABLED=true`** for localhost **4317**). Use **`OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`** if the backend expects HTTP on **4318**.

## Production notes

- **Never log secrets** (tokens, PINs, webhook bodies with PII). Follow existing patterns (e.g. Podium: structured events without raw message content).
- **Performance:** traces use a **batch** span processor with the **Tokio** runtime (`opentelemetry_sdk` **`rt-tokio`**).
- **Network:** the API binds **`0.0.0.0`** by default; the OTLP **client** connects **outbound** to your collector — ensure firewall egress allows it.
- **Graceful shutdown:** SIGKILL or abrupt host stop may drop the last batch; acceptable for most retail deployments; use process managers that allow **`SIGTERM`** completion when you care about flush guarantees.

## Related documentation

| Doc | Topic |
|-----|--------|
| **`docs/PLAN_BUG_REPORTS.md`** | **`server_log_snapshot`**, correlation id, optional **`VITE_SENTRY_DSN`** |
| **`DEVELOPER.md`** | **`RUST_LOG`**, repo layout, env var index |
| **`README.md`** | Quick start, doc catalog |
| **`docs/CATALOG_IMPORT.md`** | Example of **`tracing`** logging **`max_json_body_bytes`** at startup |

## Code map

| Path | Purpose |
|------|---------|
| `server/src/observability/otel.rs` | OTLP exporter build, resource, global tracer provider, subscriber wiring |
| `server/src/observability/server_log_ring.rs` | Ring buffer + layer for bug-report snapshots |
| `server/src/observability/mod.rs` | Re-exports |
| `server/src/main.rs` | **`init_tracing_with_optional_otel`**, **`TraceLayer`**, **`shutdown_tracer_provider`** |
| `server/Cargo.toml` | **`opentelemetry*`**, **`tracing-opentelemetry`**, **`tower-http`** **`trace`**, **`opentelemetry-otlp`** features (**`http-proto`**, **`reqwest-rustls`**) for HTTP/protobuf |

**Last reviewed:** 2026-04-08
