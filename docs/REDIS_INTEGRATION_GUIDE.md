# Redis Integration Guide

## Overview

Riverside OS integrates Redis for distributed caching and locking, providing enterprise-grade performance and reliability for production deployments.

## Table of Contents

1. [Architecture](#architecture)
2. [Installation and Setup](#installation-and-setup)
3. [Configuration](#configuration)
4. [Caching Patterns](#caching-patterns)
5. [Distributed Locking](#distributed-locking)
6. [Performance Optimization](#performance-optimization)
7. [Monitoring and Troubleshooting](#monitoring-and-troubleshooting)
8. [Best Practices](#best-practices)

---

## Architecture

### Components

- **Redis Client**: Connection pooling and retry logic
- **Cache Service**: High-level caching interface
- **Distributed Locks**: Lua script-based locking
- **Graceful Fallback**: Operation continues if Redis unavailable

### Integration Points

```
Application Layer
    ↓
Cache Service (cache/mod.rs)
    ↓
Redis Client (cache/redis_client.rs)
    ↓
Redis Server
```

---

## Installation and Setup

### Redis Installation

#### Ubuntu/Debian
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
```

#### CentOS/RHEL
```bash
sudo yum install epel-release
sudo yum install redis
sudo systemctl enable redis
sudo systemctl start redis
```

#### Docker
```bash
docker run -d --name redis \
  -p 6379:6379 \
  -v redis-data:/data \
  redis:7-alpine redis-server --appendonly yes
```

### Redis Cluster Setup

For production deployments, set up Redis Cluster:

```bash
# Create cluster with 6 nodes (3 masters, 3 replicas)
redis-cli --cluster create \
  192.168.1.10:7000 192.168.1.10:7001 \
  192.168.1.11:7000 192.168.1.11:7001 \
  192.168.1.12:7000 192.168.1.12:7001 \
  --cluster-replicas 1
```

---

## Configuration

### Environment Variables

```bash
# Redis connection URL
RIVERSIDE_REDIS_URL=redis://localhost:6379

# Cluster configuration (for Redis Cluster)
RIVERSIDE_REDIS_CLUSTER_NODES=192.168.1.10:7000,192.168.1.11:7000,192.168.1.12:7000

# Connection settings
RIVERSIDE_REDIS_MAX_CONNECTIONS=20
RIVERSIDE_REDIS_MIN_CONNECTIONS=5
RIVERSIDE_REDIS_CONNECTION_TIMEOUT=5000
```

### Redis Configuration

Edit `/etc/redis/redis.conf`:

```conf
# Memory management
maxmemory 2gb
maxmemory-policy allkeys-lru

# Persistence
save 900 1
save 300 10
save 60 10000
appendonly yes
appendfsync everysec

# Security
requirepass your_strong_password
bind 0.0.0.0

# Performance
tcp-keepalive 300
timeout 0
```

---

## Caching Patterns

### Basic Caching

```rust
use crate::cache::CacheService;

// Initialize cache service
let cache = CacheService::from_env()?;

// Cache a product
let product_data = Product { id: 123, name: "Widget" };
cache.set_with_retry(
    "product_123", 
    &product_data, 
    Some(Duration::from_secs(300))
).await?;

// Retrieve cached product
let cached: Option<Product> = cache.get_with_retry("product_123").await?;
```

### Cache-Aside Pattern

```rust
pub async fn get_product_cached(
    cache: &CacheService,
    db_pool: &PgPool,
    product_id: i32
) -> Result<Option<Product>, Error> {
    let cache_key = format!("product:{}", product_id);
    
    // Try cache first
    if let Some(product) = cache.get_with_retry::<Product>(&cache_key).await? {
        return Ok(Some(product));
    }
    
    // Cache miss - fetch from database
    let product = sqlx::query_as!(
        Product,
        "SELECT * FROM products WHERE id = $1",
        product_id
    ).fetch_optional(db_pool).await?;
    
    // Cache the result
    if let Some(ref p) = product {
        cache.set_with_retry(&cache_key, p, Some(Duration::from_secs(300))).await?;
    }
    
    Ok(product)
}
```

### Write-Through Caching

```rust
pub async fn update_product_cached(
    cache: &CacheService,
    db_pool: &PgPool,
    product_id: i32,
    update_data: UpdateProductData
) -> Result<Product, Error> {
    // Update database
    let product = sqlx::query_as!(
        Product,
        r#"
        UPDATE products 
        SET name = $2, price = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING *
        "#,
        product_id,
        update_data.name,
        update_data.price
    ).fetch_one(db_pool).await?;
    
    // Update cache
    let cache_key = format!("product:{}", product_id);
    cache.set_with_retry(&cache_key, &product, Some(Duration::from_secs(300))).await?;
    
    Ok(product)
}
```

### Cache Invalidation

```rust
pub async fn invalidate_product_cache(
    cache: &CacheService,
    product_id: i32
) -> Result<(), Error> {
    let cache_key = format!("product:{}", product_id);
    cache.redis().del(&cache_key).await?;
    
    // Also invalidate related caches
    let inventory_key = format!("inventory:product:{}", product_id);
    cache.redis().del(&inventory_key).await?;
    
    Ok(())
}
```

---

## Distributed Locking

### Basic Lock Usage

```rust
use crate::cache::DistributedLock;

// Create lock
let lock = cache.lock("product_update_123");

// Acquire lock with timeout
if lock.acquire(Duration::from_secs(30)).await? {
    // Critical section
    update_product_inventory(product_id, quantity).await?;
    
    // Release lock
    lock.release().await?;
} else {
    return Err("Could not acquire lock".into());
}
```

### Lock with Extension

```rust
let lock = cache.lock("long_running_task");

if lock.acquire(Duration::from_secs(60)).await? {
    // Extend lock if needed
    lock.extend(Duration::from_secs(30)).await?;
    
    // Continue processing
    process_long_task().await?;
    
    lock.release().await?;
}
```

### Lock with Retry Logic

```rust
pub async fn acquire_with_retry(
    lock: &DistributedLock,
    max_attempts: u32,
    delay: Duration
) -> Result<(), Error> {
    for attempt in 1..=max_attempts {
        if lock.acquire(Duration::from_secs(30)).await? {
            return Ok(());
        }
        
        if attempt < max_attempts {
            tokio::time::sleep(delay).await;
        }
    }
    
    Err("Failed to acquire lock after retries".into())
}
```

---

## Performance Optimization

### Connection Pooling

```rust
// Optimized cache configuration
let config = CacheConfig {
    redis_url: "redis://localhost:6379".to_string(),
    default_ttl: Duration::from_secs(300),
    lock_timeout: Duration::from_secs(30),
    max_retries: 3,
};

let cache = CacheService::new(config)?;
```

### Batch Operations

```rust
pub async fn cache_multiple_products(
    cache: &CacheService,
    products: Vec<Product>
) -> Result<(), Error> {
    for product in products {
        let key = format!("product:{}", product.id);
        cache.set_with_retry(&key, &product, Some(Duration::from_secs(300))).await?;
    }
    Ok(())
}
```

### Memory Management

```redis
# Monitor memory usage
redis-cli info memory

# Check memory fragmentation
redis-cli info memory | grep mem_fragmentation_ratio

# View key space stats
redis-cli info keyspace
```

---

## Monitoring and Troubleshooting

### Health Checks

```rust
pub async fn check_redis_health(cache: &CacheService) -> Result<bool, Error> {
    // Test basic connectivity
    let test_key = "health_check";
    cache.set(test_key, &"test", Some(Duration::from_secs(1))).await?;
    
    let result: Option<String> = cache.get(test_key).await?;
    Ok(result.is_some())
}
```

### Performance Metrics

```bash
# Redis command stats
redis-cli info commandstats

# Slow queries
redis-cli slowlog get 10

# Connection info
redis-cli info clients
```

### Common Issues

#### Connection Timeouts
```bash
# Check Redis server
redis-cli ping

# Check network connectivity
telnet redis-server 6379

# Review timeout settings
redis-cli config get timeout
```

#### Memory Issues
```bash
# Check memory usage
redis-cli info memory | grep used_memory_human

# Monitor eviction
redis-cli config get maxmemory-policy

# Check expired keys
redis-cli info keyspace | grep expired
```

#### Lock Contention
```rust
// Monitor lock timeouts
let lock = cache.lock("resource_name");
if !lock.acquire(Duration::from_secs(5)).await? {
    tracing::warn!("Lock contention detected for resource");
}
```

---

## Best Practices

### Key Naming Conventions

```rust
pub mod cache_keys {
    pub fn user_session(user_id: &str) -> String {
        format!("session:user:{}", user_id)
    }
    
    pub fn product_cache(product_id: &str) -> String {
        format!("product:{}", product_id)
    }
    
    pub fn inventory_cache(store_id: &str) -> String {
        format!("inventory:store:{}", store_id)
    }
    
    pub fn rate_limit(ip: &str, window: &str) -> String {
        format!("rate_limit:{}:{}", ip, window)
    }
}
```

### TTL Strategies

```rust
pub mod cache_ttl {
    use std::time::Duration;
    
    pub const USER_SESSION: Duration = Duration::from_secs(3600);      // 1 hour
    pub const PRODUCT_DATA: Duration = Duration::from_secs(300);       // 5 minutes
    pub const INVENTORY_DATA: Duration = Duration::from_secs(60);      // 1 minute
    pub const REPORT_DATA: Duration = Duration::from_secs(1800);       // 30 minutes
    pub const STATIC_CONFIG: Duration = Duration::from_secs(86400);    // 24 hours
}
```

### Error Handling

```rust
pub async fn safe_cache_get<T>(
    cache: &CacheService,
    key: &str
) -> Result<Option<T>, Error> 
where 
    T: serde::de::DeserializeOwned 
{
    match cache.get_with_retry::<T>(key).await {
        Ok(value) => Ok(value),
        Err(e) => {
            tracing::warn!(key = %key, error = %e, "Cache get failed, continuing without cache");
            Ok(None)
        }
    }
}
```

### Graceful Degradation

```rust
pub async fn get_data_with_fallback(
    cache: &CacheService,
    db_pool: &PgPool,
    cache_key: &str,
    fallback_query: impl FnOnce(&PgPool) -> futures::future::BoxFuture<'_, Result<Data, Error>>
) -> Result<Data, Error> {
    // Try cache first
    if let Ok(Some(data)) = safe_cache_get::<Data>(cache, cache_key).await {
        return Ok(data);
    }
    
    // Fallback to database
    let data = fallback_query(db_pool).await?;
    
    // Try to cache for next time (fire and forget)
    if let Err(e) = cache.set_with_retry(cache_key, &data, Some(Duration::from_secs(300))).await {
        tracing::warn!(key = %cache_key, error = %e, "Failed to cache data");
    }
    
    Ok(data)
}
```

---

## Security Considerations

### Authentication

```conf
# In redis.conf
requirepass your_strong_password
auth your_strong_password
```

### Network Security

```conf
# Bind to specific interfaces
bind 127.0.0.1 10.0.0.1

# Disable dangerous commands
rename-command FLUSHDB ""
rename-command FLUSHALL ""
rename-command CONFIG ""
```

### TLS Configuration

```conf
# Enable TLS
tls-port 6380
port 0
tls-cert-file /path/to/redis.crt
tls-key-file /path/to/redis.key
tls-ca-cert-file /path/to/ca.crt
```

---

## Production Deployment

### Docker Compose

```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD}
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf
    environment:
      - REDIS_PASSWORD=${REDIS_PASSWORD}
    restart: unless-stopped

volumes:
  redis-data:
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        ports:
        - containerPort: 6379
        env:
        - name: REDIS_PASSWORD
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: password
        command:
        - redis-server
        - --requirepass
        - $(REDIS_PASSWORD)
        - --appendonly
        - "yes"
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "2Gi"
            cpu: "500m"
        volumeMounts:
        - name: redis-data
          mountPath: /data
      volumes:
      - name: redis-data
        persistentVolumeClaim:
          claimName: redis-pvc
```

---

## Conclusion

Redis integration provides Riverside OS with enterprise-grade caching and distributed locking capabilities. Follow these guidelines to ensure optimal performance, reliability, and security in production deployments.

For additional support, refer to the Redis documentation or contact the development team.
