// Force refresh: Fri Apr 17 15:02:09 EDT 2026
use crate::api::AppState;
use axum::Router;

pub mod duplicates;
pub mod helpers;
pub mod list;
pub mod read;
pub mod rms;
pub mod write;

pub use helpers::CustomerError;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(list::router())
        .merge(read::router())
        .merge(write::router())
        .merge(duplicates::router())
        .merge(rms::router())
}
