#!/bin/bash
# Riverside OS: Emergency Admin PIN Reset
# Usage: ./scripts/ros-reset-admin-pin.sh "Full Name" "New4DigitPIN"

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 \"Staff Name\" \"1234\""
  exit 1
fi

STAFF_NAME="$1"
NEW_PIN="$2"

if [[ ! $NEW_PIN =~ ^[0-9]{4}$ ]]; then
  echo "Error: PIN must be exactly 4 digits."
  exit 1
fi

# Load DB URL from .env if available
if [ -f "server/.env" ]; then
  export $(grep -v '^#' server/.env | xargs)
fi

if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not found in .env"
  exit 1
fi

echo "Resetting PIN for '$STAFF_NAME' to '$NEW_PIN'..."

# We use a temporary Rust script or just a SQL update if we can hash it.
# Since we need Argon2, we'll try to use a small Rust snippet via cargo run --example if possible, 
# or just update the DB to move it to 'Legacy' mode (NULL pin_hash) which ignores the pin check 
# and just uses the cashier_code for verification.

psql "$DATABASE_URL" -c "UPDATE staff SET pin_hash = NULL, cashier_code = '$NEW_PIN' WHERE full_name = '$STAFF_NAME';"

echo "Done. Staff member '$STAFF_NAME' can now log in using code '$NEW_PIN'."
echo "NOTE: Once logged in, please update your profile to set a permanent hashed PIN."
