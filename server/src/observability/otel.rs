//! Optional OpenTelemetry OTLP trace export via the existing `tracing` pipeline.

use opentelemetry::global;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::SpanExporter;
use opentelemetry_sdk::resource::Resource;
use opentelemetry_sdk::runtime::Tokio;
use opentelemetry_sdk::trace::TracerProvider;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter, Registry};

use super::ServerLogRing;
use super::ServerLogRingLayer;

fn env_is_explicitly_disabled(key: &str) -> bool {
    std::env::var(key)
        .map(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "0" | "false" | "no" | "off"
            )
        })
        .unwrap_or(false)
}

fn env_is_explicitly_enabled(key: &str) -> bool {
    std::env::var(key)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

/// Export is active when not disabled by `RIVERSIDE_OTEL_ENABLED` and at least one of:
/// - `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is non-empty, or
/// - `RIVERSIDE_OTEL_ENABLED` is truthy (defaults to collector `http://localhost:4317` for gRPC).
pub fn otel_export_configured() -> bool {
    if env_is_explicitly_disabled("RIVERSIDE_OTEL_ENABLED") {
        return false;
    }
    for key in [
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    ] {
        if std::env::var(key)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }
    env_is_explicitly_enabled("RIVERSIDE_OTEL_ENABLED")
}

fn build_span_exporter() -> Result<SpanExporter, opentelemetry::trace::TraceError> {
    let proto = std::env::var("OTEL_EXPORTER_OTLP_PROTOCOL")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if proto == "http/protobuf" {
        SpanExporter::builder().with_http().build()
    } else {
        SpanExporter::builder().with_tonic().build()
    }
}

/// Subscribes `tracing` with optional OTLP export, then logs OTLP setup errors (bootstrap never uses
/// `eprintln!`).
pub fn init_tracing_with_optional_otel(server_log_ring: ServerLogRing, env_filter: EnvFilter) {
    let ring_layer = ServerLogRingLayer::new(server_log_ring);

    if !otel_export_configured() {
        Registry::default()
            .with(env_filter)
            .with(fmt::layer().with_target(false))
            .with(ring_layer)
            .init();
        return;
    }

    let exporter = match build_span_exporter() {
        Ok(e) => e,
        Err(e) => {
            Registry::default()
                .with(env_filter)
                .with(fmt::layer().with_target(false))
                .with(ring_layer)
                .init();
            tracing::error!(
                error = %e,
                "OpenTelemetry OTLP init failed; continuing without trace export"
            );
            return;
        }
    };

    let service_name = std::env::var("OTEL_SERVICE_NAME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "riverside-server".to_string());

    let resource =
        Resource::new_with_defaults([KeyValue::new("service.name", service_name.clone())]);

    let provider = TracerProvider::builder()
        .with_batch_exporter(exporter, Tokio)
        .with_resource(resource)
        .build();

    let tracer = provider.tracer(service_name);
    let _previous = global::set_tracer_provider(provider);
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);

    Registry::default()
        .with(env_filter)
        .with(otel_layer)
        .with(fmt::layer().with_target(false))
        .with(ring_layer)
        .init();

    tracing::info!("OpenTelemetry OTLP trace export enabled");
}
