#![allow(warnings)]
#![allow(clippy::all)]
//! Riverside OS backend library.

pub mod api;
pub mod auth;
pub mod cache;
pub mod db_migrations;
pub mod db_startup_diag;
pub mod embedded_migrations;
pub mod jobs;
pub mod launcher;
pub mod logic;
pub mod metrics;
pub mod middleware;
pub mod models;
pub mod observability;
pub mod runtime_config;
pub mod schema_bootstrap;
pub mod services;
