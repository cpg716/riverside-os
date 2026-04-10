#!/usr/bin/env bash
# Riverside OS — Mac Startup Script
set -e

# Add common local paths to PATH
export PATH=$PATH:/usr/local/bin

echo "🚀 Starting Riverside OS on Mac..."

# 1. Ensure OrbStack is the active context
echo "📌 Setting Docker context to orbstack..."
docker context use orbstack || echo "⚠️ Could not set context (OrbStack might not be installed)"

# 2. Start containers
echo "🐘 Starting database sidecars..."
docker compose up -d

# 3. Wait for DB to be ready
echo "⏳ Waiting for database to be ready on port 5433..."
# Use a simple loop with nc. We know nc is in /usr/bin or /usr/local/bin
until nc -z 127.0.0.1 5433; do
  printf "."
  sleep 1
done
echo " [OK]"

# 4. Cleanup any hanging processes
echo "🧹 Cleaning up previous processes..."
lsof -ti:3000,5173 | xargs kill -9 2>/dev/null || true

# 5. Open Bridge Commander dashboard
echo "📊 Waiting for Bridge Commander UI..."
(npx wait-on -t 30000 tcp:127.0.0.1:3002 && open http://127.0.0.1:3002) &

# 6. Start the app
echo "🌟 Launching dev environment (API + UI + Bridge)..."
npm run dev
