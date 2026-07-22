//! Caching layer with Redis backend

pub mod redis_client;

pub use redis_client::{DistributedLock, RedisCache};

use redis::RedisError;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

/// Cache configuration
#[derive(Debug, Clone)]
pub struct CacheConfig {
    pub redis_url: String,
    pub default_ttl: Duration,
    pub lock_timeout: Duration,
    pub max_retries: u32,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            redis_url: std::env::var("RIVERSIDE_REDIS_URL")
                .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
            default_ttl: Duration::from_secs(300), // 5 minutes
            lock_timeout: Duration::from_secs(30), // 30 seconds
            max_retries: 3,
        }
    }
}

/// Cache service wrapper
#[derive(Debug, Clone)]
pub struct CacheService {
    redis: RedisCache,
    config: CacheConfig,
    lookup_telemetry: Arc<CacheLookupTelemetry>,
}

#[derive(Debug, Default)]
struct CacheLookupTelemetry {
    hits: AtomicU64,
    misses: AtomicU64,
}

impl CacheService {
    pub fn new(config: CacheConfig) -> Result<Self, RedisError> {
        let redis = RedisCache::new(&config.redis_url)?;
        Ok(Self {
            redis,
            config,
            lookup_telemetry: Arc::new(CacheLookupTelemetry::default()),
        })
    }

    pub fn from_env() -> Result<Self, RedisError> {
        let redis_url = std::env::var("RIVERSIDE_REDIS_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                RedisError::from((
                    redis::ErrorKind::InvalidClientConfig,
                    "RIVERSIDE_REDIS_URL is not configured",
                    "optional cache disabled".to_string(),
                ))
            })?;
        let mut config = CacheConfig::default();
        config.redis_url = redis_url;
        Self::new(config)
    }

    pub fn redis(&self) -> &RedisCache {
        &self.redis
    }

    /// Create a distributed lock
    pub fn lock(&self, resource: &str) -> DistributedLock {
        DistributedLock::new(self.redis.clone(), resource, self.config.lock_timeout)
    }

    /// Cache with retry logic
    pub async fn set_with_retry<T: serde::Serialize>(
        &self,
        key: &str,
        value: &T,
        ttl: Option<Duration>,
    ) -> Result<(), RedisError> {
        let ttl = ttl.unwrap_or(self.config.default_ttl);
        let mut retries = 0;

        loop {
            match self.redis.set(key, value, ttl).await {
                Ok(_) => return Ok(()),
                Err(e) if retries < self.config.max_retries => {
                    retries += 1;
                    tracing::warn!(error = %e, retry = retries, "Cache set failed, retrying");
                    tokio::time::sleep(Duration::from_millis(100 * retries as u64)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Get with retry logic
    pub async fn get_with_retry<T: for<'de> serde::Deserialize<'de>>(
        &self,
        key: &str,
    ) -> Result<Option<T>, RedisError> {
        let mut retries = 0;

        loop {
            match self.redis.get(key).await {
                Ok(value) => {
                    if value.is_some() {
                        self.lookup_telemetry.hits.fetch_add(1, Ordering::Relaxed);
                    } else {
                        self.lookup_telemetry.misses.fetch_add(1, Ordering::Relaxed);
                    }
                    return Ok(value);
                }
                Err(e) if retries < self.config.max_retries => {
                    retries += 1;
                    tracing::warn!(error = %e, retry = retries, "Cache get failed, retrying");
                    tokio::time::sleep(Duration::from_millis(100 * retries as u64)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Set a value in cache (convenience method)
    pub async fn set<T: serde::Serialize>(
        &self,
        key: &str,
        value: &T,
        ttl: Option<Duration>,
    ) -> Result<(), RedisError> {
        self.set_with_retry(key, value, ttl).await
    }

    /// Get a value from cache (convenience method)
    pub async fn get<T: for<'de> serde::Deserialize<'de>>(
        &self,
        key: &str,
    ) -> Result<Option<T>, RedisError> {
        self.get_with_retry(key).await
    }

    /// Successful application GET outcomes since this server process started. Redis' global
    /// keyspace counters include other clients and direct Redis commands, so they are not a
    /// truthful application cache hit ratio.
    pub fn lookup_counts(&self) -> (u64, u64) {
        (
            self.lookup_telemetry.hits.load(Ordering::Relaxed),
            self.lookup_telemetry.misses.load(Ordering::Relaxed),
        )
    }

    /// Flush the cache database
    pub async fn flush(&self) -> Result<(), RedisError> {
        self.redis.flushdb().await
    }
}
