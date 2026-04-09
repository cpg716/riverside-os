//! Cross-cutting runtime hooks (logging buffers, etc.).

mod otel;
mod server_log_ring;

pub use otel::{init_tracing_with_optional_otel, otel_export_configured};
pub use server_log_ring::{ServerLogRing, ServerLogRingLayer};
