#!/bin/bash
# Phase 1 — Backup Drill Verification Script
# This script performs a pg_dump to verify that the backup process is working.

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DRILL_FILE="/Users/cpg/riverside-os/server/backups/drill_${TIMESTAMP}.dump"

echo "Starting Phase 1 Backup Drill..."

# Create backups directory if missing
mkdir -p /Users/cpg/riverside-os/server/backups

# Execute pg_dump via Docker (assuming the container name is correct from migration script)
docker exec riverside-os-db pg_dump -U postgres -Fc riverside_os > "$DRILL_FILE"

if [ -f "$DRILL_FILE" ] && [ -s "$DRILL_FILE" ]; then
    SIZE=$(du -h "$DRILL_FILE" | cut -f1)
    echo "SUCCESS: Backup drill completed."
    echo "Backup file: $DRILL_FILE"
    echo "Size: $SIZE"
    
    # Check for basic table presence in the dump (optional but good)
    # Since it's a custom-format dump (-Fc), we check strings or just rely on size for now.
    
    # Cleanup drill file
    rm "$DRILL_FILE"
    echo "Cleanup: Temporary drill file removed."
else
    echo "FAILURE: Backup drill failed or produced an empty file."
    exit 1
fi
