#!/bin/bash
# check-env-security.sh — Audit script for Riverside OS production readiness

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "==========================================="
echo "   Riverside OS: Production Security Audit"
echo "==========================================="

ENV_FILE="server/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}[FAIL] server/.env not found!${NC}"
    exit 1
fi

# 1. CORS Audit
CORS=$(grep "RIVERSIDE_CORS_ORIGINS" "$ENV_FILE" | cut -d'=' -f2)
if [ -z "$CORS" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_CORS_ORIGINS is not set. API will be inaccessible.${NC}"
elif [ "$CORS" == "*" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_CORS_ORIGINS is set to '*'. This is insecure for production!${NC}"
else
    echo -e "${GREEN}[PASS] RIVERSIDE_CORS_ORIGINS is defined.${NC}"
fi

# 2. Bind Interface Audit
BIND=$(grep "RIVERSIDE_HTTP_BIND" "$ENV_FILE" | cut -d'=' -f2)
if [ -z "$BIND" ]; then
    echo -e "${YELLOW}[WARN] RIVERSIDE_HTTP_BIND is default (127.0.0.1). Server only accessible locally.${NC}"
elif [ "$BIND" == "0.0.0.0" ]; then
    echo -e "${YELLOW}[WARN] RIVERSIDE_HTTP_BIND is 0.0.0.0. Ensure firewall (Tailscale/OrbStack) is active.${NC}"
else
    echo -e "${GREEN}[PASS] RIVERSIDE_HTTP_BIND is set.${NC}"
fi

# 3. Database URL Audit
DB_URL=$(grep "DATABASE_URL" "$ENV_FILE" | cut -d'=' -f2)
if [[ "$DB_URL" == *"localhost"* ]]; then
    echo -e "${YELLOW}[INFO] DATABASE_URL points to localhost. Normal for development/OrbStack.${NC}"
fi

# 4. Helcim Key Audit
HELCIM=$(grep "HELCIM_API_TOKEN" "$ENV_FILE" | cut -d'=' -f2)
if [[ -n "$HELCIM" && "$HELCIM" != "replace_me" && "$HELCIM" != "dummy" ]]; then
    echo -e "${GREEN}[PASS] HELCIM_API_TOKEN is configured.${NC}"
else
    HELCIM_DB_COUNT=0
    if command -v psql >/dev/null 2>&1 && [[ -n "$DB_URL" ]]; then
        HELCIM_DB_COUNT=$(psql "$DB_URL" -Atc "SELECT count(*) FROM integration_credentials WHERE integration_key = 'helcim';" 2>/dev/null || echo 0)
    fi
    if [[ "$HELCIM_DB_COUNT" =~ ^[0-9]+$ && "$HELCIM_DB_COUNT" -gt 0 ]]; then
        echo -e "${GREEN}[PASS] Helcim credentials are configured in the encrypted credential store.${NC}"
    else
        echo -e "${RED}[FAIL] Helcim credentials appear invalid or missing.${NC}"
    fi
fi

# 5. Meilisearch Audit
MEILI=$(grep "RIVERSIDE_MEILISEARCH_API_KEY" "$ENV_FILE" | cut -d'=' -f2)
if [ -z "$MEILI" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_MEILISEARCH_API_KEY is missing. Production Meilisearch requires auth.${NC}"
else
    echo -e "${GREEN}[PASS] Meilisearch API Key is configured.${NC}"
fi

# 6. Backup Directory Audit
BACKUP_DIR=$(grep "RIVERSIDE_BACKUP_DIR" "$ENV_FILE" | cut -d'=' -f2 | sed -e 's/^"//' -e 's/"$//')
if [ -z "$BACKUP_DIR" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_BACKUP_DIR is not set. Production backups need an explicit durable directory.${NC}"
elif [[ "$BACKUP_DIR" != /* ]]; then
    echo -e "${RED}[FAIL] RIVERSIDE_BACKUP_DIR must be an absolute path for production: $BACKUP_DIR${NC}"
elif [ ! -d "$BACKUP_DIR" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_BACKUP_DIR does not exist: $BACKUP_DIR${NC}"
elif [ ! -w "$BACKUP_DIR" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_BACKUP_DIR is not writable: $BACKUP_DIR${NC}"
else
    echo -e "${GREEN}[PASS] RIVERSIDE_BACKUP_DIR is explicit and writable.${NC}"
fi

BACKUP_ENCRYPTION_ENABLED=0
if command -v psql >/dev/null 2>&1 && [[ -n "$DB_URL" ]]; then
    BACKUP_ENCRYPTION_ENABLED=$(psql "$DB_URL" -Atc "SELECT COALESCE(backup_settings->>'encryption_enabled', 'false') FROM store_settings WHERE id = 1;" 2>/dev/null || echo 0)
fi
BACKUP_ENC_KEY=$(grep "RIVERSIDE_BACKUP_ENCRYPTION_KEY" "$ENV_FILE" | cut -d'=' -f2 | sed -e 's/^"//' -e 's/"$//')
if [[ "$BACKUP_ENCRYPTION_ENABLED" == "true" && ${#BACKUP_ENC_KEY} -lt 32 ]]; then
    echo -e "${RED}[FAIL] Backup archive encryption is enabled but RIVERSIDE_BACKUP_ENCRYPTION_KEY is missing or too short.${NC}"
elif [[ "$BACKUP_ENCRYPTION_ENABLED" == "true" ]]; then
    echo -e "${GREEN}[PASS] Backup archive encryption key is configured.${NC}"
else
    echo -e "${YELLOW}[WARN] Backup archive encryption is not enabled in store settings.${NC}"
fi

echo "==========================================="
echo "   Audit Complete."
