//! Redis client for caching and distributed locking

use redis::{Client, Connection, RedisError, RedisResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct RedisCache {
    client: Client,
}

impl RedisCache {
    pub fn new(redis_url: &str) -> Result<Self, RedisError> {
        let client = Client::open(redis_url)?;
        Ok(Self { client })
    }

    pub async fn get_connection(&self) -> RedisResult<Connection> {
        self.client.get_connection()
    }

    /// Cache a value with TTL
    pub async fn set<T: Serialize>(&self, key: &str, value: &T, ttl: Duration) -> RedisResult<()> {
        let serialized = serde_json::to_string(value).map_err(|e| {
            RedisError::from((
                redis::ErrorKind::TypeError,
                "Serialization failed",
                e.to_string(),
            ))
        })?;

        let mut conn = self.get_connection().await?;
        let _: () = redis::cmd("SETEX")
            .arg(key)
            .arg(ttl.as_secs())
            .arg(serialized)
            .query(&mut conn)?;

        Ok(())
    }

    /// Get a cached value
    pub async fn get<T: for<'de> Deserialize<'de>>(&self, key: &str) -> RedisResult<Option<T>> {
        let mut conn = self.get_connection().await?;
        let result: Option<String> = redis::cmd("GET").arg(key).query(&mut conn)?;

        match result {
            Some(data) => {
                let deserialized: T = serde_json::from_str(&data).map_err(|e| {
                    RedisError::from((
                        redis::ErrorKind::TypeError,
                        "Deserialization failed",
                        e.to_string(),
                    ))
                })?;
                Ok(Some(deserialized))
            }
            None => Ok(None),
        }
    }

    /// Delete a cached value
    pub async fn del(&self, key: &str) -> RedisResult<bool> {
        let mut conn = self.get_connection().await?;
        let count: i32 = redis::cmd("DEL").arg(key).query(&mut conn)?;

        Ok(count > 0)
    }

    /// Flush all keys in the database
    pub async fn flushdb(&self) -> RedisResult<()> {
        let mut conn = self.get_connection().await?;
        let _: () = redis::cmd("FLUSHDB").query(&mut conn)?;
        Ok(())
    }

    /// Check if key exists
    pub async fn exists(&self, key: &str) -> RedisResult<bool> {
        let mut conn = self.get_connection().await?;
        let count: i32 = redis::cmd("EXISTS").arg(key).query(&mut conn)?;

        Ok(count > 0)
    }

    /// Increment a counter
    pub async fn incr(&self, key: &str) -> RedisResult<i64> {
        let mut conn = self.get_connection().await?;
        redis::cmd("INCR").arg(key).query(&mut conn)
    }

    /// Increment a counter by amount
    pub async fn incr_by(&self, key: &str, amount: i64) -> RedisResult<i64> {
        let mut conn = self.get_connection().await?;
        redis::cmd("INCRBY").arg(key).arg(amount).query(&mut conn)
    }

    /// Set a value only if it doesn't exist
    pub async fn set_nx<T: Serialize>(
        &self,
        key: &str,
        value: &T,
        ttl: Duration,
    ) -> RedisResult<bool> {
        let serialized = serde_json::to_string(value).map_err(|e| {
            RedisError::from((
                redis::ErrorKind::TypeError,
                "Serialization failed",
                e.to_string(),
            ))
        })?;

        let mut conn = self.get_connection().await?;
        let result: Option<String> = redis::cmd("SET")
            .arg(key)
            .arg(serialized)
            .arg("NX")
            .arg("EX")
            .arg(ttl.as_secs())
            .query(&mut conn)?;

        Ok(result.is_some())
    }
}

#[derive(Debug)]
pub struct DistributedLock {
    redis: RedisCache,
    key: String,
    token: String,
    ttl: Duration,
}

impl DistributedLock {
    pub fn new(redis: RedisCache, resource: &str, ttl: Duration) -> Self {
        let token = Uuid::new_v4().to_string();
        Self {
            redis,
            key: format!("lock:{resource}"),
            token,
            ttl,
        }
    }

    /// Try to acquire the lock with timeout
    pub async fn acquire(&self, timeout_ms: u64) -> RedisResult<bool> {
        let deadline = Duration::from_millis(timeout_ms);
        let start = std::time::Instant::now();

        while start.elapsed() < deadline {
            if self.try_acquire().await? {
                return Ok(true);
            }

            // Wait a bit before retrying
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        Ok(false)
    }

    /// Try to acquire the lock once
    pub async fn try_acquire(&self) -> RedisResult<bool> {
        let mut conn = self.redis.get_connection().await?;
        let result: Option<String> = redis::cmd("SET")
            .arg(&self.key)
            .arg(&self.token)
            .arg("NX")
            .arg("PX")
            .arg(self.ttl.as_millis() as u64)
            .query(&mut conn)?;

        Ok(result.is_some())
    }

    /// Release the lock
    pub async fn release(&self) -> RedisResult<bool> {
        let mut conn = self.redis.get_connection().await?;

        // Lua script to safely release lock only if we own it
        let script = r#"
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        "#;

        let result: i64 = redis::Script::new(script)
            .key(&self.key)
            .arg(&self.token)
            .invoke(&mut conn)?;

        Ok(result > 0)
    }

    /// Extend the lock TTL
    pub async fn extend(&self, additional_ttl: Duration) -> RedisResult<bool> {
        let mut conn = self.redis.get_connection().await?;

        let script = r#"
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("pexpire", KEYS[1], ARGV[2])
            else
                return 0
            end
        "#;

        let result: i64 = redis::Script::new(script)
            .key(&self.key)
            .arg(&self.token)
            .arg(additional_ttl.as_millis() as u64)
            .invoke(&mut conn)?;

        Ok(result > 0)
    }
}

/// Cache key utilities
pub mod keys {
    pub fn user_session(user_id: &str) -> String {
        format!("session:user:{user_id}")
    }

    pub fn product_cache(product_id: &str) -> String {
        format!("product:{product_id}")
    }

    pub fn inventory_cache(store_id: &str) -> String {
        format!("inventory:store:{store_id}")
    }

    pub fn rate_limit(ip: &str, window: &str) -> String {
        format!("rate_limit:{ip}:{window}")
    }

    pub fn search_cache(query_hash: &str) -> String {
        format!("search:{query_hash}")
    }

    pub fn metrics_cache(metric_type: &str, time_window: &str) -> String {
        format!("metrics:{metric_type}:{time_window}")
    }
}
