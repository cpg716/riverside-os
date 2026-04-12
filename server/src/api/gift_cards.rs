//! Gift card management API.
//!
//! Issue/activate cards (purchased, loyalty-load, donated), list inventory,
//! and look up a card by code for the POS.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::api::AppState;
use crate::auth::permissions::GIFT_CARDS_MANAGE;
use crate::logic::gift_card_ops;
use crate::middleware;

#[derive(Debug, Error)]
pub enum GiftCardError {
    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("Not found")]
    NotFound,
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    Forbidden(String),
}

fn map_gc_perm(e: (StatusCode, axum::Json<serde_json::Value>)) -> GiftCardError {
    let (st, axum::Json(v)) = e;
    let msg = v
        .get("error")
        .and_then(|x| x.as_str())
        .unwrap_or("not authorized")
        .to_string();
    match st {
        StatusCode::UNAUTHORIZED => GiftCardError::Unauthorized(msg),
        StatusCode::FORBIDDEN => GiftCardError::Forbidden(msg),
        _ => GiftCardError::InvalidPayload(msg),
    }
}

// ... rest of the file content is identical to original
