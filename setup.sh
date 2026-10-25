#!/bin/sh
# One-time setup for Compost: logs in to Cloudflare, deploys the Worker (which
# creates the database) and sets the passcode. Safe to run again.
set -e
cd "$(dirname "$0")"

if ! command -v npx >/dev/null 2>&1; then
  echo "Compost needs Node.js 18 or newer. Install it from https://nodejs.org and run this again."
  exit 1
fi

WRANGLER="npx --yes wrangler@4"

if ! $WRANGLER whoami 2>/dev/null | grep -q "You are logged in"; then
  echo "Opening the browser to log in to Cloudflare..."
  $WRANGLER login
fi

echo
echo "Deploying Compost. The first deploy also creates its database."
$WRANGLER deploy

echo
echo "Now choose the passcode each device will ask for once."
$WRANGLER secret put PASSCODE

echo
echo "Done. Open the workers.dev address printed above, enter your passcode,"
echo "and visit /bookmarklet on that address to add the desktop bookmarklet."
