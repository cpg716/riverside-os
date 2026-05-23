# Riverside OS Deployment Guide

## Overview

This guide provides comprehensive instructions for deploying Riverside OS in production environments with all enterprise-grade features including monitoring, caching, job queues, and metrics collection.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Database Configuration](#database-configuration)
4. [Redis Setup](#redis-setup)
5. [Application Deployment](#application-deployment)
6. [Monitoring Configuration](#monitoring-configuration)
7. [Load Balancer Setup](#load-balancer-setup)
8. [Security Configuration](#security-configuration)
9. [Maintenance Procedures](#maintenance-procedures)

---

## Prerequisites

### System Requirements

#### Minimum Requirements
- **CPU**: 4 cores
- **Memory**: 8GB RAM
- **Storage**: 100GB SSD
- **Network**: 1Gbps

#### Recommended Production
- **CPU**: 8+ cores
- **Memory**: 16GB+ RAM
- **Storage**: 500GB+ SSD
- **Network**: 10Gbps

#### Software Dependencies
- **PostgreSQL**: 14+ with WAL archiving
- **Redis**: 7+ (Cluster for HA)
- **Docker**: 20.10+ (optional)
- **Kubernetes**: 1.24+ (optional)

### Infrastructure Components

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Load Balancer  │───▶│  App Servers    │───▶│   PostgreSQL    │
│   (Nginx/HAProxy)│    │   (3+ nodes)    │    │  (Primary/Replica)│
└─────────────────┘    └─────────────────┘    └─────────────────┘
                              │
                              ▼
                       ┌─────────────────┐
                       │     Redis       │
                       │    (Cluster)    │
                       └─────────────────┘
```

---

## Environment Setup

### Environment Variables

Create `.env` file:

```bash
# =============================================================================
# Database Configuration
# =============================================================================
DATABASE_URL=postgres://riverside:secure_password@db-primary:5432/riverside_os
RIVERSIDE_DATABASE_MAX_CONNECTIONS=30

# =============================================================================
# Redis Configuration
# =============================================================================
RIVERSIDE_REDIS_URL=redis://redis-cluster:6379
RIVERSIDE_REDIS_CLUSTER_NODES=redis-1:7000,redis-2:7000,redis-3:7000
RIVERSIDE_REDIS_MAX_CONNECTIONS=20

# =============================================================================
# Application Configuration
# =============================================================================
RIVERSIDE_ENVIRONMENT=production
RIVERSIDE_CORS_ORIGINS=https://retail.riverside.com,https://admin.riverside.com
RIVERSIDE_STRICT_PRODUCTION=true

# =============================================================================
# Security Configuration
# =============================================================================
RIVERSIDE_STORE_CUSTOMER_JWT_SECRET=your-super-secure-jwt-secret-here
RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE=1000
RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE=5000

# =============================================================================
# Metrics Configuration
# =============================================================================
RIVERSIDE_METRICS_ENABLED=true
RIVERSIDE_METRICS_COLLECTION_INTERVAL=60
RIVERSIDE_METRICS_RETENTION_DAYS=7
RIVERSIDE_METRICS_EXPORT_FORMATS=prometheus,json
RIVERSIDE_METRICS_PROMETHEUS_NAMESPACE=riverside_os
RIVERSIDE_METRICS_PROMETHEUS_SUBSYSTEM=production

# =============================================================================
# Job Queue Configuration
# =============================================================================
RIVERSIDE_JOB_QUEUE_ENABLED=true
RIVERSIDE_JOB_WORKERS=3
RIVERSIDE_JOB_MAX_CONCURRENT=10
RIVERSIDE_JOB_POLL_INTERVAL=5
RIVERSIDE_JOB_TIMEOUT=300

# =============================================================================
# External Integrations
# =============================================================================
# Meilisearch (optional)
RIVERSIDE_MEILISEARCH_URL=http://meilisearch:7700

# CoreCard (optional)
RIVERSIDE_CORECARD_ENVIRONMENT=production
RIVERSIDE_CORECARD_MERCHANT_ID=your_merchant_id
RIVERSIDE_CORECARD_API_KEY=your_production_api_key

# QBO (optional)
RIVERSIDE_QBO_CLIENT_ID=your_qbo_client_id
RIVERSIDE_QBO_CLIENT_SECRET=your_qbo_client_secret

# =============================================================================
# Logging Configuration
# =============================================================================
RUST_LOG=info,riverside_server=debug
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317
OTEL_SERVICE_NAME=riverside-os
```

---

## Database Configuration

### PostgreSQL Setup

#### Primary Server Configuration

Edit `/etc/postgresql/14/main/postgresql.conf`:

```conf
# Connection Settings
listen_addresses = '*'
port = 5432
max_connections = 200

# Memory Settings
shared_buffers = 4GB
effective_cache_size = 12GB
work_mem = 256MB
maintenance_work_mem = 1GB

# WAL Configuration for Archiving
wal_level = replica
max_wal_senders = 3
max_replication_slots = 3
archive_mode = on
archive_command = 'cp %p /var/lib/postgresql/wal_archive/%f'
archive_timeout = 300
wal_keep_segments = 64

# Checkpoint Settings
checkpoint_completion_target = 0.9
wal_buffers = 64MB
checkpoint_segments = 32

# Logging
log_destination = 'stderr'
logging_collector = on
log_directory = 'pg_log'
log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'
log_statement = 'all'
log_min_duration_statement = 1000

# Performance
random_page_cost = 1.1
effective_io_concurrency = 200
```

#### pg_hba.conf Configuration

```conf
# TYPE  DATABASE        USER            ADDRESS                 METHOD

# Local connections
local   all             postgres                                peer
local   all             all                                     md5

# IPv4 local connections:
host    all             all             127.0.0.1/32            md5
host    all             all             10.0.0.0/8              md5

# IPv6 local connections:
host    all             all             ::1/128                 md5

# Replication connections
host    replication     replicator      10.0.0.0/8              md5
```

#### WAL Archive Setup

```bash
# Create archive directory
sudo mkdir -p /var/lib/postgresql/wal_archive
sudo chown postgres:postgres /var/lib/postgresql/wal_archive
sudo chmod 750 /var/lib/postgresql/wal_archive

# Test archive command
sudo -u postgres bash -c 'cp /var/lib/postgresql/14/main/pg_wal/000000010000000000000001 /var/lib/postgresql/wal_archive/000000010000000000000001'
```

#### Database Initialization

```bash
# Create database and user
sudo -u postgres psql << EOF
CREATE USER riverside WITH PASSWORD 'secure_password';
CREATE DATABASE riverside_os OWNER riverside;
GRANT ALL PRIVILEGES ON DATABASE riverside_os TO riverside;
\c riverside_os;
GRANT ALL ON SCHEMA public TO riverside;
EOF

# Run migrations
export DATABASE_URL="postgres://riverside:secure_password@localhost:5432/riverside_os"
sqlx migrate run --source migrations/

# Create replication user
sudo -u postgres psql << EOF
CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicator_password';
EOF
```

### Replication Setup (Optional)

#### Standby Server Configuration

```bash
# On standby server
sudo systemctl stop postgresql
sudo -u postgres rm -rf /var/lib/postgresql/14/main/*

# Base backup from primary
sudo -u postgres pg_basebackup -h db-primary -D /var/lib/postgresql/14/main -U replicator -v -P -W
```

Edit standby `postgresql.conf`:

```conf
# Standby settings
hot_standby = on
max_standby_streaming_delay = 30s
wal_receiver_status_interval = 10s
hot_standby_feedback = on
```

Create standby `recovery.conf`:

```conf
standby_mode = 'on'
primary_conninfo = 'host=db-primary port=5432 user=replicator password=replicator_password'
trigger_file = '/tmp/postgresql.trigger'
```

---

## Redis Setup

### Redis Cluster Configuration

#### Redis Configuration

Create `redis.conf`:

```conf
# Network
bind 0.0.0.0
port 7000
cluster-enabled yes
cluster-config-file nodes.conf
cluster-node-timeout 5000
appendonly yes
appendfsync everysec

# Memory
maxmemory 2gb
maxmemory-policy allkeys-lru

# Persistence
save 900 1
save 300 10
save 60 10000

# Security
requirepass your_redis_password
protected-mode yes

# Performance
tcp-keepalive 300
timeout 0
```

#### Cluster Setup Script

```bash
#!/bin/bash
# setup-redis-cluster.sh

REDIS_NODES=("redis-1:7000" "redis-2:7000" "redis-3:7000" "redis-4:7000" "redis-5:7000" "redis-6:7000")

# Create cluster
redis-cli --cluster create \
  "${REDIS_NODES[@]}" \
  --cluster-replicas 1 \
  -a your_redis_password

echo "Redis cluster created successfully"
```

#### Docker Compose Redis

```yaml
version: '3.8'
services:
  redis-1:
    image: redis:7-alpine
    command: redis-server /usr/local/etc/redis/redis.conf
    ports:
      - "7001:7000"
    volumes:
      - redis-1-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf
    environment:
      - REDIS_PASSWORD=your_redis_password
    restart: unless-stopped

  redis-2:
    image: redis:7-alpine
    command: redis-server /usr/local/etc/redis/redis.conf
    ports:
      - "7002:7000"
    volumes:
      - redis-2-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf
    environment:
      - REDIS_PASSWORD=your_redis_password
    restart: unless-stopped

  redis-3:
    image: redis:7-alpine
    command: redis-server /usr/local/etc/redis/redis.conf
    ports:
      - "7003:7000"
    volumes:
      - redis-3-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf
    environment:
      - REDIS_PASSWORD=your_redis_password
    restart: unless-stopped

volumes:
  redis-1-data:
  redis-2-data:
  redis-3-data:
```

---

## Application Deployment

### Build Application

```bash
# Clone repository
git clone https://github.com/your-org/riverside-os.git
cd riverside-os

# Build release binary
cargo build --release

# Create deployment package
mkdir -p deployment/package
cp target/release/riverside-server deployment/package/
cp -r migrations deployment/package/
cp .env deployment/package/
cp deployment/systemd/riverside-server.service deployment/package/
tar -czf riverside-os-deployment.tar.gz -C deployment/package .
```

### Systemd Service

Create `/etc/systemd/system/riverside-server.service`:

```ini
[Unit]
Description=Riverside OS Server
After=network.target postgresql.service redis.service
Requires=postgresql.service redis.service

[Service]
Type=simple
User=riverside
Group=riverside
WorkingDirectory=/opt/riverside-os
Environment=NODE_ENV=production
EnvironmentFile=/opt/riverside-os/.env
ExecStart=/opt/riverside-os/riverside-server
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=10
LimitNOFILE=65536

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/riverside-os/logs

[Install]
WantedBy=multi-user.target
```

### Deployment Script

```bash
#!/bin/bash
# deploy.sh

set -e

APP_USER="riverside"
APP_DIR="/opt/riverside-os"
BACKUP_DIR="/opt/backups/riverside-os"
SERVICE_NAME="riverside-server"

echo "Starting Riverside OS deployment..."

# Create backup
if [ -d "$APP_DIR" ]; then
    echo "Creating backup..."
    sudo mkdir -p "$BACKUP_DIR"
    sudo tar -czf "$BACKUP_DIR/riverside-os-$(date +%Y%m%d-%H%M%S).tar.gz" -C "$APP_DIR" .
fi

# Create user if not exists
if ! id "$APP_USER" &>/dev/null; then
    echo "Creating application user..."
    sudo useradd -r -s /bin/false -d "$APP_DIR" "$APP_USER"
fi

# Create directories
echo "Setting up directories..."
sudo mkdir -p "$APP_DIR"/{logs,config}
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Extract application
echo "Extracting application..."
sudo tar -xzf riverside-os-deployment.tar.gz -C "$APP_DIR"
sudo chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Install systemd service
echo "Installing systemd service..."
sudo cp riverside-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

# Run database migrations
echo "Running database migrations..."
cd "$APP_DIR"
sudo -u "$APP_USER" DATABASE_URL="$DATABASE_URL" ./riverside-server migrate

# Start application
echo "Starting application..."
sudo systemctl start "$SERVICE_NAME"

# Verify deployment
echo "Verifying deployment..."
sleep 5
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "✅ Deployment successful!"
    echo "Service status: $(sudo systemctl is-active "$SERVICE_NAME")"
else
    echo "❌ Deployment failed!"
    echo "Service logs:"
    sudo journalctl -u "$SERVICE_NAME" --no-pager -l
    exit 1
fi
```

### Health Check

```bash
#!/bin/bash
# health-check.sh

HEALTH_URL="http://localhost:8080/api/health"
TIMEOUT=30

echo "Checking application health..."

if curl -f -s --max-time "$TIMEOUT" "$HEALTH_URL" > /dev/null; then
    echo "✅ Application is healthy"
    curl -s "$HEALTH_URL" | jq .
else
    echo "❌ Application health check failed"
    exit 1
fi
```

---

## Monitoring Configuration

### Prometheus Setup

#### Prometheus Configuration

Create `prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

rule_files:
  - "riverside_rules.yml"

alerting:
  alertmanagers:
    - static_configs:
        - targets:
          - alertmanager:9093

scrape_configs:
  - job_name: 'riverside-os'
    static_configs:
      - targets: 
        - 'app-1:8080'
        - 'app-2:8080'
        - 'app-3:8080'
    metrics_path: '/api/metrics'
    scrape_interval: 15s
    scrape_timeout: 10s

  - job_name: 'redis'
    static_configs:
      - targets:
        - 'redis-1:9121'
        - 'redis-2:9121'
        - 'redis-3:9121'

  - job_name: 'postgres'
    static_configs:
      - targets:
        - 'postgres-exporter:9187'

  - job_name: 'node'
    static_configs:
      - targets:
        - 'node-exporter:9100'
```

#### Alerting Rules

Create `riverside_rules.yml`:

```yaml
groups:
- name: riverside_alerts
  rules:
  - alert: RiversideDown
    expr: up{job="riverside-os"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Riverside OS instance is down"
      description: "{{ $labels.instance }} has been down for more than 1 minute"

  - alert: HighErrorRate
    expr: rate(riverside_api_errors_total[5m]) / rate(riverside_api_requests_total[5m]) > 0.05
    for: 5m
    labels:
      severity: warning
    annotations:
      summary: "High API error rate"
      description: "Error rate is {{ $value | humanizePercentage }} on {{ $labels.instance }}"

  - alert: DatabaseConnectionPoolExhaustion
    expr: riverside_database_connection_utilization_percent > 90
    for: 2m
    labels:
      severity: critical
    annotations:
      summary: "Database connection pool exhausted"
      description: "Connection pool utilization is {{ $value }}% on {{ $labels.instance }}"

  - alert: RedisDown
    expr: up{job="redis"} == 0
    for: 1m
    labels:
      severity: critical
    annotations:
      summary: "Redis instance is down"
      description: "{{ $labels.instance }} has been down for more than 1 minute"

  - alert: LowRevenue
    expr: riverside_sales_revenue_today < 1000
    for: 2h
    labels:
      severity: warning
    annotations:
      summary: "Low daily revenue"
      description: "Daily revenue is ${{ $value }} which is below threshold"
```

### Grafana Dashboard

#### Docker Compose Monitoring Stack

```yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml
      - ./monitoring/riverside_rules.yml:/etc/prometheus/riverside_rules.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/etc/prometheus/console_libraries'
      - '--web.console.templates=/etc/prometheus/consoles'
      - '--storage.tsdb.retention.time=200h'
      - '--web.enable-lifecycle'
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/dashboards:/etc/grafana/provisioning/dashboards
      - ./monitoring/grafana/datasources:/etc/grafana/provisioning/datasources
    restart: unless-stopped

  alertmanager:
    image: prom/alertmanager:latest
    ports:
      - "9093:9093"
    volumes:
      - ./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml
      - alertmanager-data:/alertmanager
    restart: unless-stopped

  node-exporter:
    image: prom/node-exporter:latest
    ports:
      - "9100:9100"
    volumes:
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /:/rootfs:ro
    command:
      - '--path.procfs=/host/proc'
      - '--path.rootfs=/rootfs'
      - '--path.sysfs=/host/sys'
      - '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)'
    restart: unless-stopped

  redis-exporter:
    image: oliver006/redis_exporter:latest
    ports:
      - "9121:9121"
    environment:
      - REDIS_ADDR=redis://redis:6379
      - REDIS_PASSWORD=your_redis_password
    restart: unless-stopped

  postgres-exporter:
    image: prometheuscommunity/postgres-exporter:latest
    ports:
      - "9187:9187"
    environment:
      - DATA_SOURCE_NAME=postgresql://riverside:secure_password@postgres:5432/riverside_os?sslmode=disable
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
  alertmanager-data:
```

---

## Load Balancer Setup

### HAProxy Configuration

Create `/etc/haproxy/haproxy.cfg`:

```cfg
global
    daemon
    maxconn 4096
    log stdout local0
    
defaults
    mode http
    timeout connect 5000ms
    timeout client 50000ms
    timeout server 50000ms
    option httplog
    option dontlognull
    
frontend riverside_frontend
    bind *:80
    bind *:443 ssl crt /etc/ssl/certs/riverside.com.pem
    redirect scheme https if !{ ssl_fc }
    
    # Health check endpoint
    acl is_health_check path_beg /api/health
    use_backend health_backend if is_health_check
    
    # API routes
    acl is_api path_beg /api
    use_backend api_backend if is_api
    
    # Static assets
    acl is_static path_end .css .js .png .jpg .jpeg .gif .ico .svg .woff .woff2
    use_backend static_backend if is_static
    
    # Default to application
    default_backend app_backend

backend app_backend
    balance roundrobin
    option httpchk GET /api/health
    server app-1 app-1:8080 check
    server app-2 app-2:8080 check
    server app-3 app-3:8080 check

backend api_backend
    balance roundrobin
    option httpchk GET /api/health
    server api-1 app-1:8080 check
    server api-2 app-2:8080 check
    server api-3 app-3:8080 check

backend health_backend
    balance roundrobin
    option httpchk GET /api/health
    server health-1 app-1:8080 check
    server health-2 app-2:8080 check
    server health-3 app-3:8080 check

backend static_backend
    balance roundrobin
    server static-1 app-1:8080 check
    server static-2 app-2:8080 check
    server static-3 app-3:8080 check

# Statistics dashboard
listen stats
    bind *:8404
    stats enable
    stats uri /stats
    stats refresh 30s
    stats admin if TRUE
```

### Nginx Configuration

Create `/etc/nginx/sites-available/riverside-os`:

```nginx
upstream riverside_backend {
    least_conn;
    server app-1:8080 max_fails=3 fail_timeout=30s;
    server app-2:8080 max_fails=3 fail_timeout=30s;
    server app-3:8080 max_fails=3 fail_timeout=30s;
}

upstream riverside_api {
    least_conn;
    server app-1:8080 max_fails=3 fail_timeout=30s;
    server app-2:8080 max_fails=3 fail_timeout=30s;
    server app-3:8080 max_fails=3 fail_timeout=30s;
}

# Rate limiting
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=5r/s;

server {
    listen 80;
    server_name retail.riverside.com admin.riverside.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name retail.riverside.com;

    ssl_certificate /etc/ssl/certs/riverside.com.crt;
    ssl_certificate_key /etc/ssl/private/riverside.com.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512:ECDHE-RSA-AES256-GCM-SHA384:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header X-XSS-Protection "1; mode=block";
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # API routes with rate limiting
    location /api/ {
        limit_req zone=api_limit burst=20 nodelay;
        proxy_pass http://riverside_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 30s;
        proxy_send_timeout 30s;
        proxy_read_timeout 30s;
    }

    # Auth endpoints with stricter rate limiting
    location /api/store/account/login {
        limit_req zone=auth_limit burst=10 nodelay;
        proxy_pass http://riverside_api;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check endpoint
    location /api/health {
        proxy_pass http://riverside_backend;
        access_log off;
    }

    # Static assets
    location /static/ {
        alias /var/www/riverside-os/static/;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Default route
    location / {
        proxy_pass http://riverside_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Security Configuration

### SSL/TLS Setup

#### Let's Encrypt Certificate

```bash
# Install certbot
sudo apt update
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d retail.riverside.com -d admin.riverside.com

# Auto-renewal
sudo crontab -e
# Add: 0 12 * * * /usr/bin/certbot renew --quiet
```

#### Firewall Configuration

```bash
# UFW firewall setup
sudo ufw enable
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH
sudo ufw allow ssh

# Allow web traffic
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Allow monitoring (internal only)
sudo ufw allow from 10.0.0.0/8 to any port 9090  # Prometheus
sudo ufw allow from 10.0.0.0/8 to any port 3000  # Grafana

# Allow database (internal only)
sudo ufw allow from 10.0.0.0/8 to any port 5432
sudo ufw allow from 10.0.0.0/8 to any port 6379
```

### Application Security

#### Security Headers

The application automatically includes security headers:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`

#### Rate Limiting

Configure rate limiting in environment:
```bash
RIVERSIDE_GLOBAL_RATE_LIMIT_PER_MINUTE=1000
RIVERSIDE_AUTHENTICATED_RATE_LIMIT_PER_MINUTE=5000
```

#### Database Security

```sql
-- Create read-only user for reporting
CREATE USER reporting WITH PASSWORD 'reporting_password';
GRANT CONNECT ON DATABASE riverside_os TO reporting;
GRANT USAGE ON SCHEMA public TO reporting;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting;

-- Create backup user
CREATE USER backup WITH PASSWORD 'backup_password';
GRANT CONNECT ON DATABASE riverside_os TO backup;
GRANT USAGE ON SCHEMA public TO backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup;
```

---

## Maintenance Procedures

### Database Maintenance

#### Daily Backup Script

```bash
#!/bin/bash
# backup-database.sh

BACKUP_DIR="/var/backups/postgresql"
DATE=$(date +%Y%m%d-%H%M%S)
DB_NAME="riverside_os"
RETENTION_DAYS=30

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Create backup
pg_dump -h localhost -U riverside -d "$DB_NAME" | gzip > "$BACKUP_DIR/riverside-os-$DATE.sql.gz"

# Remove old backups
find "$BACKUP_DIR" -name "riverside-os-*.sql.gz" -mtime +$RETENTION_DAYS -delete

echo "Database backup completed: riverside-os-$DATE.sql.gz"
```

#### WAL Archive Cleanup

```bash
#!/bin/bash
# cleanup-wal-archive.sh

WAL_ARCHIVE="/var/lib/postgresql/wal_archive"
RETENTION_DAYS=7

# Remove old WAL files
find "$WAL_ARCHIVE" -name "*.gz" -mtime +$RETENTION_DAYS -delete

echo "WAL archive cleanup completed"
```

### Application Maintenance

#### Log Rotation

Create `/etc/logrotate.d/riverside-os`:

```
/opt/riverside-os/logs/*.log {
    daily
    missingok
    rotate 30
    compress
    delaycompress
    notifempty
    create 644 riverside riverside
    postrotate
        systemctl reload riverside-server
    endscript
}
```

#### Health Monitoring Script

```bash
#!/bin/bash
# monitor-health.sh

HEALTH_URL="http://localhost:8080/api/health"
ALERT_EMAIL="admin@riverside.com"

if ! curl -f -s --max-time 10 "$HEALTH_URL" > /dev/null; then
    echo "Riverside OS health check failed on $(hostname)" | mail -s "Riverside OS Alert" "$ALERT_EMAIL"
    systemctl restart riverside-server
fi
```

#### Update Deployment

```bash
#!/bin/bash
# update-deployment.sh

set -e

NEW_VERSION=$1
if [ -z "$NEW_VERSION" ]; then
    echo "Usage: $0 <version>"
    exit 1
fi

echo "Deploying Riverside OS version $NEW_VERSION..."

# Download new version
wget "https://releases.riverside.com/v$NEW_VERSION/riverside-os-deployment.tar.gz"

# Backup current version
./backup-current.sh

# Deploy new version
./deploy.sh

# Verify deployment
./health-check.sh

echo "Deployment completed successfully!"
```

### Monitoring Maintenance

#### Prometheus Data Retention

Add to `prometheus.yml`:
```yaml
storage:
  tsdb:
    retention.time: 30d
    retention.size: 10GB
```

#### Grafana Backup

```bash
#!/bin/bash
# backup-grafana.sh

GRAFANA_URL="http://admin:admin@localhost:3000"
BACKUP_DIR="/var/backups/grafana"
DATE=$(date +%Y%m%d-%H%M%S)

mkdir -p "$BACKUP_DIR"

# Export dashboards
curl -s "$GRAFANA_URL/api/search" | jq -r '.[] | .uid' | while read uid; do
    curl -s "$GRAFANA_URL/api/dashboards/uid/$uid" | jq '.dashboard' > "$BACKUP_DIR/dashboard-$uid-$DATE.json"
done

# Export datasources
curl -s "$GRAFANA_URL/api/datasources" > "$BACKUP_DIR/datasources-$DATE.json"

echo "Grafana backup completed"
```

---

## Troubleshooting

### Common Issues

#### Application Won't Start

```bash
# Check service status
systemctl status riverside-server

# Check logs
journalctl -u riverside-server -f

# Check configuration
/opt/riverside-os/riverside-server --check-config

# Check database connectivity
psql $DATABASE_URL -c "SELECT 1;"
```

#### Database Connection Issues

```bash
# Check PostgreSQL status
systemctl status postgresql

# Check connection count
psql $DATABASE_URL -c "SELECT count(*) FROM pg_stat_activity;"

# Check connection pool settings
psql $DATABASE_URL -c "SHOW max_connections;"
```

#### Redis Connection Issues

```bash
# Check Redis status
redis-cli ping

# Check cluster status
redis-cli --cluster check redis-1:7000

# Check memory usage
redis-cli info memory
```

#### High Memory Usage

```bash
# Check application memory
ps aux | grep riverside-server

# Check database memory
psql $DATABASE_URL -c "SELECT * FROM pg_stat_activity WHERE state = 'active';"

# Check Redis memory
redis-cli info memory | grep used_memory
```

#### Performance Issues

```bash
# Check slow queries
psql $DATABASE_URL -c "SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;"

# Check API response times
curl -w "@curl-format.txt" -o /dev/null -s "http://localhost:8080/api/health"

# Check system resources
top
iostat -x 1
```

---

## CI/CD and Dependency Automation

Riverside OS uses GitHub Actions for continuous integration and automated dependency management.

### Automated Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `lint.yml` | PR / push to `main` | `cargo fmt`, `cargo clippy` |
| `security-audit.yml` | Weekly (Mon midnight) + manual | `cargo audit` (CVE scan) + `cargo outdated` (stale deps) |
| `tauri-register-updater-release.yml` | Push `v*` tag or manual | Builds signed Windows updater bundle and publishes to GitHub release |
| `windows-deployment-package.yml` | Push `v*` tag or manual | Builds Windows deployment package (server, client, Deployment Manager) and publishes to GitHub release |
| `macos-deployment-manager-release.yml` | Push `v*` tag or manual | Builds macOS universal DMG for the Deployment Manager and publishes to GitHub release |
| `dependabot-auto-merge.yml` | Dependabot PR | Auto-squash merges patch-level dependency updates |

### Releasing a New Version

1. Bump version in all manifests (must match):
   - `package.json` (root)
   - `client/package.json`
   - `client/src-tauri/tauri.conf.json`
   - `server/Cargo.toml`
   - `client/src-tauri/Cargo.toml`
   - `ros-dev/package.json`
   - `ros-dev/src-tauri/tauri.conf.json`
   - `ros-dev/src-tauri/Cargo.toml`
2. Write release notes to `docs/releases/vX.Y.Z-release-notes.md`
3. Commit, tag, and push:
   ```bash
   git commit -m "release: v0.70.3"
   git tag v0.70.3
   git push origin main --tags
   ```
4. The `tauri-register-updater-release` workflow triggers automatically, builds the signed installer, and publishes `latest.json` to the GitHub release — visible to all Tauri auto-updaters.

### Manual Release Override

For hotfixes or special tags, go to **Actions → Tauri register updater release → Run workflow** and specify a custom `release_tag`.

---

## In-App DevOps Center

Riverside OS includes a **DevOps Center** inside **Settings → ROS Dev Center** for staff with `ops.dev_center.view` permission.

### What It Shows

- **Operational status** — DB health, integrations, station connectivity
- **Runtime diagnostics** — memory, disk, service status
- **E2E health** — latest CI test lane status
- **GitHub DevOps** — recent workflow runs, releases, and one-click release builds

### GitHub Integration

The DevOps Center reads from and writes to GitHub via server-side API proxy:

| Feature | Endpoint | Permission Required |
|---------|----------|---------------------|
| View workflow runs | `GET /api/ops/github/workflows` | `ops.dev_center.view` |
| View releases | `GET /api/ops/github/releases` | `ops.dev_center.view` |
| Trigger release build | `POST /api/ops/github/dispatch` | `ops.dev_center.actions` |

### Configuration

Set `RIVERSIDE_GITHUB_TOKEN` in server environment (`.env` or deployment config):
- **Scopes needed**: `repo` (read), `workflow` (write for dispatch)
- **Never expose to client** — the token is server-side only

The token is read at startup and stored in `AppState.github_token`. If not configured, the GitHub section shows a "not configured" message.

---

## Standalone ROS Dev Center (macOS)

A dedicated macOS companion app lives in `ros-dev/` for managing Riverside OS development tasks outside the browser.

### What It Does

- **Auto-discovers servers (Native)** — scans Tailscale peers and local subnet for ROS instances using a high-performance concurrent Rust scanner (limiting concurrent sockets to `40` to prevent starvation).
- **Secure Keychain Storage** — saves staff Access PINs in the macOS Keychain under service `com.riverside.ros-dev-center` (plaintext PINs are stripped from local disk storage).
- **Route Shielded (API)** — backend `/api/ops/*` endpoints are protected by `ops_shield_middleware` to allow connections only from loopback, private subnets (RFC 1918), and Tailscale networks.
- **Server profiles** — save multiple servers (dev, staging, production) and switch instantly.
- **Tailscale-aware** — detects Tailscale status, marks Tailscale profiles, shows tailnet name.
- **Real-time DevOps dashboard** — DB health, stations, alerts, bugs, workflow runs, releases.
- **ROSIE AI analysis** — one-click diagnostic analysis using the local ROSIE LLM.
- **AI-ready** — copy-paste prompts for ChatGPT/Claude/Cursor with full diagnostic context.

### Build

```bash
cd ros-dev
npm install
npm run tauri build
```

The `.dmg` appears in `ros-dev/src-tauri/target/release/bundle/dmg/`.

### Connect

1. Launch the app
2. Check Tailscale status badge (green = connected)
3. Click **"Scan for Riverside Servers"** to auto-discover
4. Click a discovered server, or select a saved profile
5. Enter your staff PIN (must have `ops.dev_center.view`)
6. Click **Connect** — dashboard auto-refreshes every 30 seconds

### Server Profiles

Save multiple connection targets:

| Profile | URL | Use Case |
|---------|-----|----------|
| Local Dev | `http://localhost:3000` | Development on this Mac |
| Production (Tailscale) | `http://riverside-server:3000` | Remote store management |
| Custom | Any URL | Staging, backup server, etc. |

Profiles persist in localStorage. Delete custom profiles at any time.

### Diagnostics & AI Analysis

1. In the dashboard, click **"Run Diagnostics"**
2. The server captures: version, Rust version, DB pool, migrations, recent errors/warnings
3. Click **"Analyze with ROSIE"** to send the prompt to the local Gemma LLM
4. ROSIE returns: root cause analysis, file-level fix suggestions, priority ranking
5. Or click **"Copy"** to paste the prompt into any external AI tool

### API Endpoints (used by the app)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ops/overview` | GET | Health snapshot, stations, alerts |
| `/api/ops/diagnostics` | GET | Full diagnostic snapshot with AI prompt |
| `/api/ops/diagnostics/analyze` | POST | Send prompt to ROSIE LLM for analysis |
| `/api/ops/github/workflows` | GET | Recent GitHub Actions workflow runs |
| `/api/ops/github/releases` | GET | Recent GitHub releases |
| `/api/ops/github/dispatch` | POST | Trigger a workflow dispatch |

---

## Conclusion

This deployment guide provides comprehensive instructions for deploying Riverside OS in production environments with enterprise-grade features. Following these guidelines ensures a secure, scalable, and maintainable deployment.

For additional support or questions, refer to the specific component guides or contact the development team.
