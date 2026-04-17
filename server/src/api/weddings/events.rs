// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use super::helpers::require_weddings_view;
use super::WeddingError;
use crate::api::AppState;
use axum::{
    extract::State,
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
    routing::get,
    Router,
};
use futures_core::stream::Stream;
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

pub fn router() -> Router<AppState> {
    Router::new().route("/events", get(wedding_events_stream))
}

async fn wedding_events_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>> + Send>, WeddingError> {
    require_weddings_view(&state, &headers).await?;
    let rx = state.wedding_events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|item| match item {
        Ok(json) => Some(Ok(Event::default().data(json))),
        Err(BroadcastStreamRecvError::Lagged(n)) => {
            tracing::debug!(skipped = n, "wedding sse client lagged");
            None
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
