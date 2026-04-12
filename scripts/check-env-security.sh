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
    echo -e "${GREEN}[PASS] RIVERSIDE_CORS_ORIGINS is defined: $CORS${NC}"
fi

# 2. Bind Interface Audit
BIND=$(grep "RIVERSIDE_HTTP_BIND" "$ENV_FILE" | cut -d'=' -f2)
if [ -z "$BIND" ]; then
    echo -e "${YELLOW}[WARN] RIVERSIDE_HTTP_BIND is default (127.0.0.1). Server only accessible locally.${NC}"
elif [ "$BIND" == "0.0.0.0" ]; then
    echo -e "${YELLOW}[WARN] RIVERSIDE_HTTP_BIND is 0.0.0.0. Ensure firewall (Tailscale/OrbStack) is active.${NC}"
else
    echo -e "${GREEN}[PASS] RIVERSIDE_HTTP_BIND is set to: $BIND${NC}"
fi

# 3. Database URL Audit
DB_URL=$(grep "DATABASE_URL" "$ENV_FILE" | cut -d'=' -f2)
if [[ "$DB_URL" == *"localhost"* ]]; then
    echo -e "${YELLOW}[INFO] DATABASE_URL points to localhost. Normal for development/OrbStack.${NC}"
fi

# 4. Stripe Key Audit
STRIPE=$(grep "STRIPE_SECRET_KEY" "$ENV_FILE" | cut -d'=' -f2)
if [[ "$STRIPE" == *"sk_test"* ]]; then
    echo -e "${YELLOW}[INFO] STRIPE_SECRET_KEY is a TEST key.${NC}"
elif [[ "$STRIPE" == *"sk_live"* ]]; then
    echo -e "${GREEN}[PASS] STRIPE_SECRET_KEY is a LIVE key.${NC}"
else
    echo -e "${RED}[FAIL] STRIPE_SECRET_KEY appears invalid or missing.${NC}"
fi

# 5. Meilisearch Audit
MEILI=$(grep "RIVERSIDE_MEILISEARCH_API_KEY" "$ENV_FILE" | cut -d'=' -f2)
if [ -z "$MEILI" ]; then
    echo -e "${RED}[FAIL] RIVERSIDE_MEILISEARCH_API_KEY is missing. Production Meilisearch requires auth.${NC}"
else
    echo -e "${GREEN}[PASS] Meilisearch API Key is configured.${NC}"
fi

echo "==========================================="
echo "   Audit Complete."
