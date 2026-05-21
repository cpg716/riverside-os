# Metrics System Guide

## Overview

Riverside OS includes a comprehensive metrics collection system providing business KPIs, technical metrics, and multiple export formats for enterprise-grade monitoring and observability.

## Table of Contents

1. [Architecture](#architecture)
2. [Business Metrics](#business-metrics)
3. [Technical Metrics](#technical-metrics)
4. [Collection System](#collection-system)
5. [Export Formats](#export-formats)
6. [Configuration](#configuration)
7. [Monitoring Setup](#monitoring-setup)
8. [Best Practices](#best-practices)

---

## Architecture

### Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Application   │───▶│ Metrics         │───▶│   Exporters     │
│                 │    │ Collector       │    │                 │
│ API Requests    │    │                 │    │ Prometheus      │
│ Database        │    │ ┌─────────────┐ │    │ JSON            │
│ Cache           │    │ │   Registry  │ │    │ InfluxDB        │
│ Jobs            │    │ │ Collection  │ │    │ Graphite        │
│                 │    │ │ Aggregation │ │    └─────────────────┘
└─────────────────┘    │ └─────────────┘ │
                       └─────────────────┘
```

### Key Features

- **Business KPIs**: Revenue, customers, inventory, financial metrics
- **Technical Metrics**: System resources, database performance, API metrics
- **Real-time Collection**: Configurable collection intervals
- **Multiple Export Formats**: Prometheus, JSON, InfluxDB, Graphite
- **Automatic Aggregation**: Sum, average, percentiles, min/max
- **Retention Policies**: Configurable data retention and cleanup

---

## Business Metrics

### Sales KPIs

#### Revenue Metrics
```rust
pub struct SalesMetrics {
    pub total_revenue_today: Decimal,
    pub total_transactions_today: u64,
    pub average_transaction_value: Decimal,
    pub revenue_by_hour: HashMap<String, Decimal>,
    pub top_selling_products: Vec<ProductSales>,
    pub sales_by_category: HashMap<String, Decimal>,
}
```

**SQL Queries**:
```sql
-- Total revenue today
SELECT COALESCE(SUM(total_amount), 0)
FROM transactions
WHERE DATE(created_at) = CURRENT_DATE
AND status = 'completed';

-- Revenue by hour
SELECT EXTRACT(HOUR FROM created_at)::text as hour, 
       COALESCE(SUM(total_amount), 0)
FROM transactions
WHERE DATE(created_at) = CURRENT_DATE
AND status = 'completed'
GROUP BY EXTRACT(HOUR FROM created_at)
ORDER BY hour;
```

#### Product Performance
```sql
-- Top selling products
SELECT 
    p.id,
    COALESCE(p.name, 'Unknown'),
    COALESCE(SUM(tl.quantity), 0),
    COALESCE(SUM(tl.quantity * tl.unit_price), 0)
FROM transaction_lines tl
INNER JOIN transactions t ON t.id = tl.transaction_id
INNER JOIN product_variants pv ON pv.id = tl.variant_id
INNER JOIN products p ON p.id = tl.product_id
WHERE DATE(t.created_at) = CURRENT_DATE
AND t.status = 'completed'
GROUP BY p.id, p.name
ORDER BY SUM(tl.quantity) DESC
LIMIT 10;
```

### Customer KPIs

#### Customer Analytics
```rust
pub struct CustomerMetrics {
    pub new_customers_today: u64,
    pub active_customers_today: u64,
    pub customer_retention_rate: f64,
    pub average_customer_lifetime_value: Decimal,
    pub customers_by_segment: HashMap<String, u64>,
}
```

**Key Metrics**:
- **New Customers**: Daily customer registration count
- **Active Customers**: Customers with transactions today
- **Retention Rate**: Percentage of customers who return within 30 days
- **Lifetime Value**: Average total spend per customer
- **Segmentation**: Customer segments by spending (Low, Medium, High, VIP)

### Inventory KPIs

#### Inventory Performance
```rust
pub struct InventoryMetrics {
    pub total_inventory_value: Decimal,
    pub low_stock_products: u64,
    pub out_of_stock_products: u64,
    pub inventory_turnover_rate: f64,
    pub days_of_inventory: f64,
}
```

**Calculations**:
```sql
-- Inventory turnover rate
WITH last_30_days_sales AS (
    SELECT COALESCE(SUM(tl.quantity), 0) as total_sold
    FROM transaction_lines tl
    INNER JOIN transactions t ON t.id = tl.transaction_id
    WHERE t.created_at >= NOW() - INTERVAL '30 days'
    AND t.status = 'completed'
),
avg_inventory AS (
    SELECT COALESCE(AVG(stock_on_hand), 0) as avg_stock
    FROM product_variants pv
    INNER JOIN products p ON p.id = pv.product_id
)
SELECT 
    CASE 
        WHEN avg_inventory = 0 THEN 0
        ELSE (total_sold::float / avg_inventory::float)
    END
FROM last_30_days_sales, avg_inventory;
```

### Financial KPIs

#### Financial Performance
```rust
pub struct FinancialMetrics {
    pub gross_profit_today: Decimal,
    pub gross_profit_margin: f64,
    pub daily_expenses: Decimal,
    pub net_profit_today: Decimal,
    pub accounts_receivable: Decimal,
    pub cash_flow_today: Decimal,
}
```

**Profit Calculations**:
```sql
-- Gross profit today
SELECT COALESCE(SUM(tl.quantity * (tl.unit_price - p.cost_price)), 0)
FROM transaction_lines tl
INNER JOIN transactions t ON t.id = tl.transaction_id
INNER JOIN product_variants pv ON pv.id = tl.variant_id
INNER JOIN products p ON p.id = tl.product_id
WHERE DATE(t.created_at) = CURRENT_DATE
AND t.status = 'completed';

-- Gross profit margin
SELECT (gross_profit / revenue) * 100
FROM (
    SELECT 
        SUM(CASE WHEN t.status = 'completed' THEN total_amount ELSE 0 END) as revenue,
        SUM(CASE WHEN t.status = 'completed' THEN 
            tl.quantity * (tl.unit_price - p.cost_price) ELSE 0 END) as gross_profit
    FROM transactions t
    LEFT JOIN transaction_lines tl ON t.id = tl.transaction_id
    LEFT JOIN product_variants pv ON pv.id = tl.variant_id
    LEFT JOIN products p ON p.id = tl.product_id
    WHERE DATE(t.created_at) = CURRENT_DATE
) financials;
```

---

## Technical Metrics

### System Metrics

#### Resource Utilization
```rust
pub struct SystemMetrics {
    pub cpu_usage_percent: f64,
    pub memory_usage_mb: u64,
    pub memory_usage_percent: f64,
    pub disk_usage_mb: u64,
    pub disk_usage_percent: f64,
    pub network_bytes_sent: u64,
    pub network_bytes_received: u64,
    pub uptime_seconds: u64,
    pub load_average: Option<f64>,
}
```

**Collection Methods**:
```rust
// CPU usage (would use sysinfo crate in production)
async fn get_cpu_usage() -> f64 {
    // Placeholder implementation
    45.0
}

// Memory usage
async fn get_memory_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    // Would read from /proc/meminfo or use sysinfo
    Ok(2048) // 2GB
}

// Disk usage
async fn get_disk_usage() -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    // Would use sysinfo or statvfs
    Ok(51200) // 50GB
}
```

### Database Metrics

#### PostgreSQL Performance
```rust
pub struct DatabaseMetrics {
    pub active_connections: u32,
    pub idle_connections: u32,
    pub total_connections: u32,
    pub connection_utilization_percent: f64,
    pub query_duration_avg_ms: f64,
    pub slow_queries_count: u64,
    pub database_size_mb: u64,
    pub wal_size_mb: u64,
    pub cache_hit_ratio: f64,
}
```

**Database Queries**:
```sql
-- Connection metrics
SELECT 
    COUNT(*) FILTER (WHERE state = 'active') as active_connections,
    COUNT(*) FILTER (WHERE state = 'idle') as idle_connections,
    COUNT(*) as total_connections
FROM pg_stat_activity;

-- Query performance
SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (query_end - query_start)) * 1000), 0)
FROM pg_stat_statements
WHERE calls > 0;

-- Slow queries
SELECT COUNT(*)
FROM pg_stat_statements
WHERE mean_exec_time > 1000;

-- Database size
SELECT pg_database_size(current_database()) / 1024 / 1024;

-- Cache hit ratio
SELECT 
    CASE 
        WHEN (blks_hit + blks_read) = 0 THEN 0
        ELSE (blks_hit::float / (blks_hit + blks_read)::float) * 100
    END
FROM pg_stat_database
WHERE datname = current_database();
```

### API Metrics

#### HTTP Performance
```rust
pub struct ApiMetrics {
    pub requests_per_second: f64,
    pub average_response_time_ms: f64,
    pub p95_response_time_ms: f64,
    pub p99_response_time_ms: f64,
    pub error_rate_percent: f64,
    pub status_codes: HashMap<String, u64>,
    pub endpoints_by_latency: HashMap<String, f64>,
    pub active_connections: u32,
}
```

**Middleware Integration**:
```rust
pub async fn metrics_middleware(
    State(state): axum::extract::State<AppState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let start_time = std::time::Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    
    let response = next.run(request).await;
    
    let status_code = response.status().as_u16();
    let duration_ms = start_time.elapsed().as_secs_f64() * 1000.0;
    
    // Record metrics
    if let Some(metrics_collector) = &state.metrics_collector {
        metrics_collector.record_request(&method, &path, status_code, duration_ms).await;
    }
    
    response
}
```

### Cache Metrics

#### Redis Performance
```rust
pub struct CacheMetrics {
    pub hit_rate_percent: f64,
    pub miss_rate_percent: f64,
    pub total_operations: u64,
    pub memory_usage_mb: u64,
    pub evicted_keys: u64,
    pub expired_keys: u64,
    pub connected_clients: u32,
}
```

**Redis Commands**:
```bash
# Cache statistics
redis-cli info stats | grep keyspace
redis-cli info memory | grep used_memory
redis-cli info stats | grep evicted

# Hit rate calculation
redis-cli info stats | grep -E "(keyspace_hits|keyspace_misses)"
```

### Job Queue Metrics

#### Job Processing Performance
```rust
pub struct JobMetrics {
    pub jobs_enqueued: u64,
    pub jobs_dequeued: u64,
    pub jobs_completed: u64,
    pub jobs_failed: u64,
    pub average_processing_time_seconds: f64,
    pub pending_jobs: u64,
    pub processing_jobs: u64,
    pub dead_letter_jobs: u64,
}
```

---

## Collection System

### Metrics Registry

```rust
pub struct MetricRegistry {
    metrics: HashMap<String, Vec<MetricValue>>,
    config: MetricsConfig,
}

impl MetricRegistry {
    pub fn record_counter(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Counter);
    }
    
    pub fn record_gauge(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Gauge);
    }
    
    pub fn record_histogram(&mut self, name: &str, value: f64, tags: HashMap<String, String>) {
        self.record_metric(name, value, tags, MetricType::Histogram);
    }
    
    pub fn record_timer(&mut self, name: &str, duration: Duration, tags: HashMap<String, String>) {
        self.record_metric(name, duration.as_secs_f64(), tags, MetricType::Timer);
    }
}
```

### Metrics Collector

```rust
pub struct MetricsCollector {
    registry: Arc<RwLock<MetricRegistry>>,
    config: MetricsConfig,
    db_pool: PgPool,
    cache: Option<CacheService>,
    is_running: Arc<RwLock<bool>>,
}

impl MetricsCollector {
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let registry = self.registry.clone();
        let config = self.config.clone();
        let db_pool = self.db_pool.clone();
        let cache = self.cache.clone();
        let is_running = self.is_running.clone();
        
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(config.collection_interval);
            
            while *is_running.read().await {
                interval.tick().await;
                
                // Collect business metrics
                if config.enable_business_metrics {
                    if let Err(e) = BusinessMetrics::collect(&db_pool, &mut registry.write().await).await {
                        error!("Failed to collect business metrics: {}", e);
                    }
                }
                
                // Collect technical metrics
                if config.enable_technical_metrics {
                    if let Err(e) = TechnicalMetrics::collect(&db_pool, cache.as_ref(), &mut registry.write().await).await {
                        error!("Failed to collect technical metrics: {}", e);
                    }
                }
                
                // Cleanup old metrics
                registry.write().await.cleanup_old_metrics(config.retention_period);
            }
        });
        
        Ok(())
    }
}
```

### Configuration

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsConfig {
    pub collection_interval: Duration,
    pub retention_period: Duration,
    pub max_values_per_metric: usize,
    pub enable_business_metrics: bool,
    pub enable_technical_metrics: bool,
    pub export_formats: Vec<ExportFormat>,
}

impl Default for MetricsConfig {
    fn default() -> Self {
        Self {
            collection_interval: Duration::from_secs(60), // 1 minute
            retention_period: Duration::from_secs(86400 * 7), // 7 days
            max_values_per_metric: 10000,
            enable_business_metrics: true,
            enable_technical_metrics: true,
            export_formats: vec![ExportFormat::Prometheus, ExportFormat::Json],
        }
    }
}
```

---

## Export Formats

### Prometheus Exporter

```rust
#[derive(Debug, Clone)]
pub struct PrometheusExporter {
    namespace: String,
    subsystem: Option<String>,
}

#[async_trait]
impl MetricsExporter for PrometheusExporter {
    async fn export(&self, registry: &MetricRegistry) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let mut output = String::new();
        let metrics = registry.get_all_metrics();

        for (metric_name, values) in metrics {
            if values.is_empty() {
                continue;
            }

            let sanitized_name = self.sanitize_metric_name(metric_name);
            let full_name = self.format_metric_name(&sanitized_name);

            // Export metric type
            if let Some(latest_value) = values.last() {
                let metric_type = match latest_value.metric_type {
                    MetricType::Counter => "counter",
                    MetricType::Gauge => "gauge",
                    MetricType::Histogram => "histogram",
                    MetricType::Timer => "histogram",
                };

                output.push_str(&format!("# TYPE {} {}\n", full_name, metric_type));

                // For histograms, export buckets
                if matches!(latest_value.metric_type, MetricType::Histogram | MetricType::Timer) {
                    let mut sorted_values: Vec<f64> = values.iter().map(|v| v.value).collect();
                    sorted_values.sort_by(|a, b| a.partial_cmp(b).unwrap());

                    let buckets = vec![0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, f64::INFINITY];

                    for bucket in &buckets {
                        let count = sorted_values.iter().filter(|&&v| v <= *bucket).count() as f64;
                        output.push_str(&format!(
                            "{}_bucket{} {}\n",
                            full_name,
                            self.format_tags(&latest_value.tags),
                            count
                        ));
                    }

                    // Export sum and count
                    let sum: f64 = values.iter().map(|v| v.value).sum();
                    let count = values.len() as f64;

                    output.push_str(&format!(
                        "{}_sum{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        sum
                    ));
                    output.push_str(&format!(
                        "{}_count{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        count
                    ));
                } else {
                    // For counters and gauges
                    output.push_str(&format!(
                        "{}{} {}\n",
                        full_name,
                        self.format_tags(&latest_value.tags),
                        latest_value.value
                    ));
                }
            }
        }

        Ok(output)
    }
}
```

**Example Output**:
```
# TYPE riverside_sales_revenue_today gauge
riverside_sales_revenue_today{currency="USD"} 15420.50

# TYPE riverside_api_requests_total counter
riverside_api_requests_total{method="GET",path="/api/products",status="200"} 1250

# TYPE riverside_api_request_duration_ms histogram
riverside_api_request_duration_ms_bucket{method="GET",path="/api/products",status="200",le="100"} 1100
riverside_api_request_duration_ms_bucket{method="GET",path="/api/products",status="200",le="500"} 1230
riverside_api_request_duration_ms_bucket{method="GET",path="/api/products",status="200",le="1000"} 1245
riverside_api_request_duration_ms_bucket{method="GET",path="/api/products",status="200",le="+Inf"} 1250
riverside_api_request_duration_ms_sum{method="GET",path="/api/products",status="200"} 125000
riverside_api_request_duration_ms_count{method="GET",path="/api/products",status="200"} 1250
```

### JSON Exporter

```rust
#[derive(Debug, Clone)]
pub struct JsonExporter {
    pretty_print: bool,
}

#[async_trait]
impl MetricsExporter for JsonExporter {
    async fn export(&self, registry: &MetricRegistry) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
        let metrics = registry.get_all_metrics();
        let mut output = HashMap::new();

        for (metric_name, values) in metrics {
            let metric_data: Vec<serde_json::Value> = values
                .iter()
                .map(|v| serde_json::json!({
                    "value": v.value,
                    "timestamp": v.timestamp,
                    "tags": v.tags,
                    "type": match v.metric_type {
                        MetricType::Counter => "counter",
                        MetricType::Gauge => "gauge",
                        MetricType::Histogram => "histogram",
                        MetricType::Timer => "timer",
                    }
                }))
                .collect();

            output.insert(metric_name.clone(), metric_data);
        }

        if self.pretty_print {
            Ok(serde_json::to_string_pretty(&output)?)
        } else {
            Ok(serde_json::to_string(&output)?)
        }
    }
}
```

**Example Output**:
```json
{
  "sales_revenue_today": [
    {
      "value": 15420.50,
      "timestamp": "2024-01-15T10:30:00Z",
      "tags": {"currency": "USD"},
      "type": "gauge"
    }
  ],
  "api_requests_total": [
    {
      "value": 1250,
      "timestamp": "2024-01-15T10:30:00Z",
      "tags": {"method": "GET", "path": "/api/products", "status": "200"},
      "type": "counter"
    }
  ]
}
```

### InfluxDB Exporter

```rust
#[derive(Debug, Clone)]
pub struct InfluxDBExporter {
    url: String,
    database: String,
    username: Option<String>,
    password: Option<String>,
}

impl InfluxDBExporter {
    fn format_line_protocol(&self, measurement: &str, tags: &HashMap<String, String>, value: f64, timestamp: i64) -> String {
        let tag_string = if tags.is_empty() {
            String::new()
        } else {
            let formatted_tags: Vec<String> = tags
                .iter()
                .map(|(key, val)| format!("{}={}", key.replace([' ', ','], "\\ "), val.replace([' ', ','], "\\ ")))
                .collect();
            format!(",{}", formatted_tags.join(","))
        };

        format!(
            "{}{} value={} {}",
            measurement.replace([' ', ','], "\\ "),
            tag_string,
            value,
            timestamp * 1_000_000_000 // Convert to nanoseconds
        )
    }
}
```

**Example Output**:
```
riverside_sales_revenue_today,currency=USD value=15420.5 1705316200000000000
riverside_api_requests_total,method=GET,path=/api/products,status=200 value=1250 1705316200000000000
```

---

## Configuration

### Environment Variables

```bash
# Metrics Collection
RIVERSIDE_METRICS_ENABLED=true
RIVERSIDE_METRICS_COLLECTION_INTERVAL=60
RIVERSIDE_METRICS_RETENTION_DAYS=7
RIVERSIDE_METRICS_MAX_VALUES_PER_METRIC=10000

# Business Metrics
RIVERSIDE_METRICS_BUSINESS_ENABLED=true
RIVERSIDE_METRICS_BUSINESS_INTERVAL=300

# Technical Metrics
RIVERSIDE_METRICS_TECHNICAL_ENABLED=true
RIVERSIDE_METRICS_TECHNICAL_INTERVAL=60

# Export Configuration
RIVERSIDE_METRICS_EXPORT_FORMATS=prometheus,json
RIVERSIDE_METRICS_PROMETHEUS_NAMESPACE=riverside_os
RIVERSIDE_METRICS_PROMETHEUS_SUBSYSTEM=production

# InfluxDB (optional)
RIVERSIDE_METRICS_INFLUXDB_URL=http://localhost:8086
RIVERSIDE_METRICS_INFLUXDB_DATABASE=riverside_metrics
RIVERSIDE_METRICS_INFLUXDB_USERNAME=admin
RIVERSIDE_METRICS_INFLUXDB_PASSWORD=password
```

### Application Configuration

```rust
// In launcher.rs
let metrics_config = MetricsConfig {
    collection_interval: Duration::from_secs(
        std::env::var("RIVERSIDE_METRICS_COLLECTION_INTERVAL")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60)
    ),
    retention_period: Duration::from_secs(
        std::env::var("RIVERSIDE_METRICS_RETENTION_DAYS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(7) * 86400
    ),
    max_values_per_metric: std::env::var("RIVERSIDE_METRICS_MAX_VALUES_PER_METRIC")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10000),
    enable_business_metrics: std::env::var("RIVERSIDE_METRICS_BUSINESS_ENABLED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(true),
    enable_technical_metrics: std::env::var("RIVERSIDE_METRICS_TECHNICAL_ENABLED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(true),
    export_formats: std::env::var("RIVERSIDE_METRICS_EXPORT_FORMATS")
        .ok()
        .and_then(|s| s.split(',').map(|s| match s.trim() {
            "prometheus" => ExportFormat::Prometheus,
            "json" => ExportFormat::Json,
            "influxdb" => ExportFormat::InfluxDB,
            "graphite" => ExportFormat::Graphite,
            _ => ExportFormat::Json,
        }).collect())
        .unwrap_or(vec![ExportFormat::Prometheus, ExportFormat::Json]),
};
```

---

## Monitoring Setup

### Prometheus Configuration

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'riverside-os'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: '/api/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s

rule_files:
  - "riverside_rules.yml"

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093
```

### Alerting Rules

```yaml
# riverside_rules.yml
groups:
- name: riverside_business
  rules:
  - alert: LowRevenue
    expr: riverside_sales_revenue_today < 1000
    for: 1h
    labels:
      severity: warning
    annotations:
      summary: "Low daily revenue"
      description: "Daily revenue is ${{ $value }} which is below threshold"

  - alert: HighCustomerChurn
    expr: riverside_customers_retention_rate < 70
    for: 2h
    labels:
      severity: critical
    annotations:
      summary: "High customer churn rate"
      description: "Customer retention rate is {{ $value }}%"

- name: riverside_technical
  rules:
  - alert: HighCPUUsage
    expr: riverside_system_cpu_usage_percent > 80
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High CPU usage"
      description: "CPU usage is {{ $value }}%"

  - alert: DatabaseConnectionPoolExhaustion
    expr: riverside_database_connection_utilization_percent > 90
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Database connection pool nearly exhausted"
      description: "Connection pool utilization is {{ $value }}%"

  - alert: HighAPIErrorRate
    expr: rate(riverside_api_errors_total[5m]) / rate(riverside_api_requests_total[5m]) > 0.05
    for: 3m
    labels:
      severity: warning
    annotations:
      summary: "High API error rate"
      description: "API error rate is {{ $value | humanizePercentage }}"
```

### Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Riverside OS Business Metrics",
    "panels": [
      {
        "title": "Daily Revenue",
        "type": "stat",
        "targets": [
          {
            "expr": "riverside_sales_revenue_today",
            "legendFormat": "Revenue Today"
          }
        ]
      },
      {
        "title": "Customer Metrics",
        "type": "row",
        "panels": [
          {
            "title": "New Customers",
            "type": "stat",
            "targets": [
              {
                "expr": "riverside_customers_new_today",
                "legendFormat": "New Customers"
              }
            ]
          },
          {
            "title": "Retention Rate",
            "type": "gauge",
            "targets": [
              {
                "expr": "riverside_customers_retention_rate",
                "legendFormat": "Retention Rate"
              }
            ]
          }
        ]
      },
      {
        "title": "API Performance",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(riverside_api_requests_total[5m])",
            "legendFormat": "Request Rate"
          },
          {
            "expr": "histogram_quantile(0.95, rate(riverside_api_request_duration_ms_bucket[5m]))",
            "legendFormat": "95th Percentile"
          }
        ]
      }
    ]
  }
}
```

---

## Best Practices

### Metric Design

1. **Consistent Naming**: Use consistent naming conventions
2. **Meaningful Labels**: Use descriptive labels for filtering
3. **Appropriate Types**: Choose correct metric types (counter, gauge, histogram)
4. **Cardinality Management**: Avoid high cardinality labels
5. **Documentation**: Document what each metric represents

### Performance Considerations

1. **Collection Frequency**: Balance between accuracy and overhead
2. **Memory Usage**: Monitor memory consumption of metrics storage
3. **Network Overhead**: Consider compression for remote metrics
4. **Database Impact**: Optimize SQL queries for metric collection
5. **Async Processing**: Use async operations for metric collection

### Data Retention

1. **Retention Policies**: Configure appropriate retention periods
2. **Aggregation**: Aggregate old data to save space
3. **Cleanup**: Regular cleanup of expired metrics
4. **Storage Planning**: Plan for storage requirements
5. **Backup**: Backup important metric data

### Monitoring Strategy

1. **SLA Monitoring**: Track service level agreements
2. **Trend Analysis**: Monitor long-term trends
3. **Anomaly Detection**: Set up anomaly detection
4. **Capacity Planning**: Use metrics for capacity planning
5. **Business Intelligence**: Leverage metrics for business insights

---

## Troubleshooting

### Common Issues

#### Metrics Not Collecting
```bash
# Check metrics collector status
curl http://localhost:8080/api/health

# Check configuration
curl http://localhost:8080/api/config | jq .metrics

# Review logs
docker logs riverside-app | grep metrics
```

#### High Memory Usage
```bash
# Check metrics storage
curl http://localhost:8080/api/metrics/storage

# Review retention settings
curl http://localhost:8080/api/config | jq .metrics.retention

# Monitor memory usage
docker stats riverside-app
```

#### Slow Collection
```bash
# Check database query performance
psql $DATABASE_URL -c "EXPLAIN ANALYZE SELECT * FROM pg_stat_statements;"

# Monitor collection times
curl http://localhost:8080/api/metrics/timing

# Review collection intervals
curl http://localhost:8080/api/config | jq .metrics.collection_interval
```

#### Export Issues
```bash
# Test Prometheus endpoint
curl http://localhost:8080/api/metrics

# Test JSON export
curl -H "Accept: application/json" http://localhost:8080/api/metrics

# Check export configuration
curl http://localhost:8080/api/config | jq .metrics.export_formats
```

---

## Conclusion

The metrics system provides comprehensive observability for Riverside OS, enabling data-driven decision making and proactive issue detection. Follow these guidelines to ensure effective monitoring and optimization of both business and technical aspects of the system.

For additional support or questions, refer to the API documentation or contact the development team.
