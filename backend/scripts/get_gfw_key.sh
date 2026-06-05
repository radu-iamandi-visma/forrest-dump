#!/usr/bin/env bash
# Walks the Global Forest Watch Data API auth flow:
#   1. Sign up if needed (name + email — GFW emails you a link to set your password)
#   2. Sign in -> bearer token
#   3. Create an API key
#   4. Offer to append it to backend/.env
#
# First run: signs you up, then exits with instructions to set your password via
# the link GFW emails you. Re-run after you've set it.
#
# Requires: curl, python (used for JSON parsing — works without jq installed).
#
# Usage: bash scripts/get_gfw_key.sh

set -u

API="https://data-api.globalforestwatch.org"

# Flags
SKIP_SIGNUP=false
for arg in "$@"; do
  case "$arg" in
    --skip-signup) SKIP_SIGNUP=true ;;
    -h|--help)
      echo "Usage: bash scripts/get_gfw_key.sh [--skip-signup]"
      echo
      echo "  --skip-signup    Skip step 1 and go straight to sign-in. Use this when"
      echo "                   the account already exists and the password is set."
      exit 0
      ;;
  esac
done

# --- Helpers -----------------------------------------------------------------

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n" "$*"; }

PYTHON=python
command -v python >/dev/null 2>&1 || PYTHON=python3
command -v "$PYTHON" >/dev/null 2>&1 || { red "Need python (or python3) installed."; exit 1; }
command -v curl     >/dev/null 2>&1 || { red "Need curl installed."; exit 1; }

json_get() {
  # json_get <body> <python-dotted-path>
  printf '%s' "$1" | "$PYTHON" -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
keys = '$2'.split('.')
v = data
for k in keys:
    if isinstance(v, dict):
        v = v.get(k, '')
    else:
        v = ''
print(v)
"
}

http_call() {
  # http_call METHOD URL [extra curl args...]
  # Echoes: "<status>\n<body>"
  local method=$1; shift
  local url=$1; shift
  local out
  out=$(curl -sS -w "\n__STATUS__%{http_code}" -X "$method" "$url" "$@")
  local status=${out##*__STATUS__}
  local body=${out%__STATUS__*}
  printf '%s\n%s' "$status" "$body"
}

# --- Inputs ------------------------------------------------------------------

bold "=== Global Forest Watch API key ==="
echo
echo "GFW's flow: you sign up with email + name, then they email you a link to"
echo "set a password. Once that's done, sign-in works and we can create the key."
echo

default_email=$(git config --global user.email 2>/dev/null || echo "")
read -r -p "Email${default_email:+ [$default_email]}: " EMAIL
EMAIL=${EMAIL:-$default_email}
[ -z "$EMAIL" ] && { red "Email is required."; exit 1; }

if [ "$SKIP_SIGNUP" = true ]; then
  NAME="(skipped)"
else
  read -r -p "Full name: " NAME
  [ -z "$NAME" ] && { red "Name is required."; exit 1; }
fi

read -r -p "Organization [Visma]: " ORG
ORG=${ORG:-Visma}

read -r -p "Allowed domains for the API key (comma-separated) [localhost]: " DOMAINS_RAW
DOMAINS_RAW=${DOMAINS_RAW:-localhost}
DOMAINS_JSON=$(printf '%s' "$DOMAINS_RAW" | "$PYTHON" -c "
import sys, json
items = [s.strip() for s in sys.stdin.read().split(',') if s.strip()]
print(json.dumps(items))
")

# --- 1. Sign up (idempotent, skippable) --------------------------------------

if [ "$SKIP_SIGNUP" = true ]; then
  bold "1/3 Sign up — skipped (--skip-signup)"
  JUST_CREATED=false
else

bold "1/3 Sign up"
SIGNUP_PAYLOAD=$("$PYTHON" -c "
import json
print(json.dumps({
    'name': '$NAME',
    'email': '$EMAIL',
}))
")

RESULT=$(http_call POST "$API/auth/sign-up" \
  -H "Content-Type: application/json" \
  -d "$SIGNUP_PAYLOAD")
SIGNUP_STATUS=$(printf '%s' "$RESULT" | head -n1)
SIGNUP_BODY=$(printf '%s' "$RESULT" | tail -n +2)

JUST_CREATED=false
case "$SIGNUP_STATUS" in
  200|201)
    green "  ✓ Account created for $EMAIL."
    JUST_CREATED=true
    ;;
  409)
    dim "  Account already exists — continuing to sign-in."
    ;;
  400)
    # GFW sometimes returns 400 with a body like "email already registered"
    if printf '%s' "$SIGNUP_BODY" | grep -qi "already"; then
      dim "  Account already exists — continuing to sign-in."
    else
      red "  Sign-up failed (HTTP $SIGNUP_STATUS):"
      printf '%s\n' "$SIGNUP_BODY"
      exit 1
    fi
    ;;
  422)
    red "  Sign-up rejected (HTTP 422). The GFW endpoint expects fields we didn't send:"
    printf '%s\n' "$SIGNUP_BODY"
    echo
    echo "  Paste the JSON above into chat and the script can be updated."
    exit 1
    ;;
  *)
    red "  Sign-up returned HTTP $SIGNUP_STATUS:"
    printf '%s\n' "$SIGNUP_BODY"
    exit 1
    ;;
esac

if [ "$JUST_CREATED" = true ]; then
  echo
  bold "  → Check your inbox at $EMAIL — GFW sent a link to set your password."
  echo "    Click it, set the password, then come back here."
  echo
  read -r -p "  Press Enter once you've set your password (or Ctrl+C to abort): " _
fi

fi  # end of SKIP_SIGNUP guard

# --- 2. Sign in --------------------------------------------------------------

bold "2/3 Sign in"
echo "  Using the password you set via the email link from GFW."
printf "  Password: "
stty -echo
read -r PASSWORD
stty echo
echo
[ -z "$PASSWORD" ] && { red "Password is required."; exit 1; }

RESULT=$(http_call POST "$API/auth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=$EMAIL" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "grant_type=password")
TOKEN_STATUS=$(printf '%s' "$RESULT" | head -n1)
TOKEN_BODY=$(printf '%s' "$RESULT" | tail -n +2)

if [ "$TOKEN_STATUS" != "200" ]; then
  red "  Sign-in failed (HTTP $TOKEN_STATUS):"
  printf '%s\n' "$TOKEN_BODY"
  echo
  echo "  Likely causes:"
  echo "    - You haven't clicked the email-verification link from GFW yet."
  echo "    - The password is wrong. Re-run the script and try again."
  exit 1
fi

TOKEN=$(json_get "$TOKEN_BODY" "access_token")
[ -z "$TOKEN" ] && TOKEN=$(json_get "$TOKEN_BODY" "data.access_token")
if [ -z "$TOKEN" ]; then
  red "  Could not find access_token in response:"
  printf '%s\n' "$TOKEN_BODY"
  exit 1
fi
green "  ✓ Signed in (${TOKEN:0:20}…)"

# --- 3. Create API key -------------------------------------------------------

bold "3/3 Create API key"

ALIAS="forest-watch-$(date +%Y%m%d%H%M%S)"
KEY_PAYLOAD=$("$PYTHON" -c "
import json
print(json.dumps({
    'alias': '$ALIAS',
    'organization': '$ORG',
    'email': '$EMAIL',
    'domains': $DOMAINS_JSON,
    'never_expires': False,
}))
")

RESULT=$(http_call POST "$API/auth/apikey" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$KEY_PAYLOAD")
KEY_STATUS=$(printf '%s' "$RESULT" | head -n1)
KEY_BODY=$(printf '%s' "$RESULT" | tail -n +2)

if [ "$KEY_STATUS" != "200" ] && [ "$KEY_STATUS" != "201" ]; then
  red "  Create-key request failed (HTTP $KEY_STATUS):"
  printf '%s\n' "$KEY_BODY"
  exit 1
fi

API_KEY=$(json_get "$KEY_BODY" "data.api_key")
[ -z "$API_KEY" ] && API_KEY=$(json_get "$KEY_BODY" "api_key")
if [ -z "$API_KEY" ]; then
  red "  Created — but could not find api_key in response:"
  printf '%s\n' "$KEY_BODY"
  exit 1
fi

green "  ✓ Got key: $API_KEY"
echo

# --- 4. Write to .env --------------------------------------------------------

ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

if [ -f "$ENV_FILE" ]; then
  bold "Save to $ENV_FILE?"
  read -r -p "  [Y/n] " save
  save=${save:-y}
  if [ "$save" = "y" ] || [ "$save" = "Y" ]; then
    "$PYTHON" -c "
import os
path = r'$ENV_FILE'
key = '$API_KEY'
lines = []
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip().startswith('GFW_API_KEY='):
                lines.append(line.rstrip('\n'))
lines.append('GFW_API_KEY=' + key)
with open(path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines) + '\n')
print('  ✓ Updated', path)
"
    echo
    dim "  Restart the container so it picks up the new env:"
    dim "      cd backend && docker compose down && make dev"
  fi
else
  dim "No .env file at $ENV_FILE — add this line yourself:"
  echo
  echo "      GFW_API_KEY=$API_KEY"
fi

echo
green "Done."
