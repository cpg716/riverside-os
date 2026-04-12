//! Bounded in-memory buffer of formatted `tracing` events for bug reports and support.

use std::collections::VecDeque;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};

use tracing::field::Visit;
use tracing::Event;
use tracing::Subscriber;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// Shared ring buffer; clone the [`Arc`] into [`AppState`](crate::api::AppState) and the tracing layer.
#[derive(Clone)]
pub struct ServerLogRing {
    inner: Arc<Mutex<RingInner>>,
}

struct RingInner {
    lines: VecDeque<String>,
    max_lines: usize,
    max_line_chars: usize,
}

impl ServerLogRing {
    pub fn new(max_lines: usize, max_line_chars: usize) -> Self {
        Self { inner: Arc::new(Mutex::new(RingInner {
            lines: VecDeque::new(),
            max_lines: max_lines.max(16),
            max_line_chars: max_line_chars.clamp(256, 16_384),
        })) }
    }

    fn push_line(&self, mut line: String) {
        let mut g = match self.inner.lock() {
            Ok(x) => x,
            Err(e) => e.into_inner(),
        };
        if line.len() > g.max_line_chars {
            line.truncate(g.max_line_chars);
            line.push('…');
        }
        g.lines.push_back(line);
        while g.lines.len() > g.max_lines {
            g.lines.pop_front();
        }
    }

    /// Newest lines last (chronological), joined with newlines. Truncates to `max_bytes` UTF-8.
    pub fn snapshot_text(&self, max_bytes: usize) -> String {
        let g = match self.inner.lock() {
            Ok(x) => x,
            Err(e) => e.into_inner(),
        };
        let cap = max_bytes.max(1024);
        let mut out = String::new();
        for line in g.lines.iter() {
            let add = line.len() + if out.is_empty() { 0 } else { 1 };
            if out.len() + add > cap {
                let _ = writeln!(out, "… [server log truncated at {cap} bytes]");
                break;
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(line);
        }
        if out.is_empty() {
            return "(no server log lines captured yet — tracing may not be initialized)"
                .to_string();
        }
        out
    }

    fn push_event(&self, event: &Event<'_>) {
        let meta = event.metadata();
        let level = meta.level();
        let target = meta.module_path().unwrap_or_else(|| meta.target());
        let mut fields = FieldWriter::default();
        event.record(&mut fields);
        let ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ");
        let body = fields.0;
        let line = if body.is_empty() {
            format!("{ts} {level:5} {target}")
        } else {
            format!("{ts} {level:5} {target} {body}")
        };
        self.push_line(line);
    }
}

pub struct ServerLogRingLayer {
    ring: ServerLogRing,
}

impl ServerLogRingLayer {
    pub fn new(ring: ServerLogRing) -> Self {
        Self { ring }
    }
}

impl<S> Layer<S> for ServerLogRingLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        self.ring.push_event(event);
    }
}

#[derive(Default)]
struct FieldWriter(String);

impl FieldWriter {
    fn push_kv(&mut self, k: &str, v: &str) {
        if !self.0.is_empty() {
            self.0.push_str(", ");
        }
        let _ = write!(&mut self.0, "{k}={v}");
    }
}

impl Visit for FieldWriter {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.push_kv(field.name(), value);
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.push_kv(field.name(), if value { "true" } else { "false" });
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.push_kv(field.name(), &value.to_string());
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.push_kv(field.name(), &value.to_string());
    }

    fn record_i128(&mut self, field: &tracing::field::Field, value: i128) {
        self.push_kv(field.name(), &value.to_string());
    }

    fn record_u128(&mut self, field: &tracing::field::Field, value: u128) {
        self.push_kv(field.name(), &value.to_string());
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.push_kv(field.name(), &value.to_string());
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.push_kv(field.name(), &format!("{value:?}"));
    }
}
