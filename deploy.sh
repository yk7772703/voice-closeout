#!/bin/bash
# One-shot deploy. Keys come from environment variables, never from this file.
#   export CLOUDFLARE_API_TOKEN=...   (Cloudflare > Account API tokens > "Edit Cloudflare Workers")
#   export CLOUDFLARE_ACCOUNT_ID=...
#   export ANTHROPIC_API_KEY=...      (platform.claude.com/settings/keys)
#   export ACCESS_CODE=...            (beta code you give to technicians)
#   bash deploy.sh
set -e
cd "$(dirname "$0")"
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID ANTHROPIC_API_KEY ACCESS_CODE; do
  [ -n "${!v}" ] || { echo "Missing $v"; exit 1; }
done
npx --yes wrangler@4 deploy
printf '%s' "$ANTHROPIC_API_KEY" | npx --yes wrangler@4 secret put ANTHROPIC_API_KEY
printf '%s' "$ACCESS_CODE"       | npx --yes wrangler@4 secret put ACCESS_CODE
echo "Deployed."
