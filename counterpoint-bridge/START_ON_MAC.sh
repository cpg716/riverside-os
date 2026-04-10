#!/bin/bash
# Riverside OS | Counterpoint Bridge Starter for Mac
# This script ensures dependencies are installed and starts the bridge.

echo "🚀 Starting Riverside Counterpoint Bridge..."

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  .env file not found. Creating from .env.example..."
    cp .env.example .env
    echo "Please edit .env and add your SQL_CONNECTION_STRING."
    exit 1
fi

# Install dependencies if node_modules is missing
if [ ! -d node_modules ]; then
    echo "📦 node_modules not found. Installing dependencies..."
    npm install
fi

# Open the Dashboard in the default browser
echo "📊 Opening Dashboard..."
open dashboard.html

echo "⏳ Waiting 5s for Riverside server to settle..."
sleep 5

# Run the bridge
echo "⚡ Running Bridge (press Ctrl+C to stop)..."
node index.mjs
