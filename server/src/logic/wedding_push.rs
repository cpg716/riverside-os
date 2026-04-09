//! In-process broadcast for Wedding Manager live refresh (SSE fan-out).

use serde_json::json;
use tokio::sync::broadcast;

const CHANNEL_CAP: usize = 1024;

#[derive(Clone)]
pub struct WeddingEventBus {
    tx: broadcast::Sender<String>,
}

impl WeddingEventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(CHANNEL_CAP);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }

    pub fn parties_updated(&self, sender_id: Option<&str>) {
        let mut v = json!({ "type": "parties_updated" });
        if let Some(s) = sender_id.filter(|s| !s.is_empty()) {
            v["senderId"] = json!(s);
        }
        let _ = self.tx.send(v.to_string());
    }

    pub fn appointments_updated(&self, sender_id: Option<&str>) {
        let mut v = json!({ "type": "appointments_updated" });
        if let Some(s) = sender_id.filter(|s| !s.is_empty()) {
            v["senderId"] = json!(s);
        }
        let _ = self.tx.send(v.to_string());
    }
}

impl Default for WeddingEventBus {
    fn default() -> Self {
        Self::new()
    }
}
