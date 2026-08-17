#!/bin/bash
# Reads the Meta token from your clipboard straight into .env.
# The token is never printed, never echoed, never leaves this machine.
#
#   1. Copy the token from Business Manager
#   2. ./save-token.sh
#
# Pass a different key name to set another credential, e.g.
#   ./save-token.sh GOOGLE_ADS_DEVELOPER_TOKEN

set -euo pipefail
cd "$(dirname "$0")"

KEY="${1:-META_ACCESS_TOKEN}"
TOKEN="$(pbpaste | tr -d '\r\n' | xargs)"

if [ -z "$TOKEN" ]; then
  echo "Clipboard is empty. Copy the token first, then run this again."
  exit 1
fi

# Guard against saving whatever else happened to be on the clipboard.
if [ "$KEY" = "META_ACCESS_TOKEN" ] && [[ "$TOKEN" != EA* ]]; then
  echo "That doesn't look like a Meta token (they start with 'EA')."
  echo "Copy the token again, then re-run."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi

# Replace the line if the key exists, otherwise append it.
if grep -q "^${KEY}=" .env; then
  TOKEN="$TOKEN" KEY="$KEY" python3 - <<'PY'
import os, re
key, token = os.environ['KEY'], os.environ['TOKEN']
with open('.env') as f:
    text = f.read()
text = re.sub(rf'^{re.escape(key)}=.*$', f'{key}={token}', text, count=1, flags=re.M)
with open('.env', 'w') as f:
    f.write(text)
PY
else
  printf '\n%s=%s\n' "$KEY" "$TOKEN" >> .env
fi

chmod 600 .env
echo "Saved ${KEY} to .env (${#TOKEN} characters). Nothing was displayed."
echo "Now run:  npm start"
