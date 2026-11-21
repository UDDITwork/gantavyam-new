#!/usr/bin/env bash
# Stores the backend's secrets in Google Secret Manager.
#
# You type or paste the values at the prompts below. They go straight to Secret Manager and are
# never written to a file, to the shell history or to the repository.
#
#   GCP_PROJECT=<project-id> GCP_ACCOUNT=<you@example.com> TURSO_DATABASE_URL=libsql://... \
#     bash hosting/create-secrets.sh
#
# SKIP_OPTIONAL=1 skips the Cloudinary / Twilio / Fast2SMS questions.
# Re-running is safe: a secret only gets a new version when you type a new value, and the JWT
# secret is only generated if it does not exist yet.
set -euo pipefail

: "${GCP_PROJECT:?Set GCP_PROJECT to your Google Cloud project id}"
: "${GCP_ACCOUNT:?Set GCP_ACCOUNT to the Google account to use}"

g() { gcloud "$@" --project "$GCP_PROJECT" --account "$GCP_ACCOUNT" --quiet; }
secret_exists() { g secrets describe "$1" >/dev/null 2>&1; }

put_secret() {
  local name="$1" value="$2"
  if secret_exists "$name"; then
    printf %s "$value" | g secrets versions add "$name" --data-file=- >/dev/null
    echo "  updated  $name"
  else
    printf %s "$value" | g secrets create "$name" --replication-policy=automatic --data-file=- >/dev/null
    echo "  created  $name"
  fi
}

# Same rule the Admin model uses for e-mail addresses
EMAIL_RE='^[A-Za-z0-9_]+([.-]?[A-Za-z0-9_]+)*@[A-Za-z0-9_]+([.-]?[A-Za-z0-9_]+)*(\.[A-Za-z0-9_]{2,3})+$'

# ask_optional <secret-name> <label> <hidden|visible>  (Enter skips)
ask_optional() {
  local name="$1" label="$2" mode="$3" value=""
  if [ "$mode" = "hidden" ]; then read -rsp "$label (Enter to skip): " value; echo; else read -rp "$label (Enter to skip): " value; fi
  if [ -z "$value" ]; then echo "  skipped  $name"; else put_secret "$name" "$value"; fi
}

echo "=============================================================="
echo " Gantavyam backend secrets"
echo " Project: $GCP_PROJECT"
echo " Account: $GCP_ACCOUNT"
echo
echo " Hidden prompts show nothing while you type or paste - that is"
echo " normal. Paste, then press Enter."
echo "=============================================================="
echo

echo "1) Database (Turso)"
TURSO_URL="${TURSO_DATABASE_URL:-}"
if [ -z "$TURSO_URL" ]; then read -rp "   Turso database URL: " TURSO_URL; fi
TURSO_URL="${TURSO_URL/libsql:\/\//https://}"   # always store the HTTPS form
case "$TURSO_URL" in
  https://*) ;;
  *) echo "The database URL must start with libsql:// or https://" >&2; exit 1 ;;
esac
echo "   Connecting over: $TURSO_URL"
put_secret turso-database-url "$TURSO_URL"

TURSO_TOKEN=""
while [ -z "$TURSO_TOKEN" ]; do
  read -rsp "   Turso database token (hidden): " TURSO_TOKEN; echo
  if [ -z "$TURSO_TOKEN" ] && secret_exists turso-auth-token; then echo "  kept existing turso-auth-token"; break; fi
  case "$TURSO_TOKEN" in
    eyJ*.*.*) ;;
    "") ;;
    *) echo "   That does not look like a Turso token (it should start with eyJ). Try again."; TURSO_TOKEN="" ;;
  esac
done
[ -n "$TURSO_TOKEN" ] && put_secret turso-auth-token "$TURSO_TOKEN"
unset TURSO_TOKEN

echo
echo "2) Admin login for the dashboard"
ADMIN_EMAIL=""
while [ -z "$ADMIN_EMAIL" ]; do
  read -rp "   Admin e-mail: " ADMIN_EMAIL
  if ! [[ "$ADMIN_EMAIL" =~ $EMAIL_RE ]]; then echo "   Please enter a valid e-mail address (for example name@gmail.com)."; ADMIN_EMAIL=""; fi
done
put_secret default-admin-email "$ADMIN_EMAIL"

ADMIN_PASS=""
while [ -z "$ADMIN_PASS" ]; do
  read -rsp "   Admin password, at least 8 characters (hidden): " ADMIN_PASS; echo
  if [ "${#ADMIN_PASS}" -lt 8 ]; then echo "   Too short, try again."; ADMIN_PASS=""; continue; fi
  read -rsp "   Repeat the password (hidden): " ADMIN_PASS2; echo
  if [ "$ADMIN_PASS" != "$ADMIN_PASS2" ]; then echo "   The two passwords differ, try again."; ADMIN_PASS=""; fi
done
put_secret default-admin-password "$ADMIN_PASS"
unset ADMIN_PASS ADMIN_PASS2

echo
echo "3) Login security"
if secret_exists jwt-secret; then
  echo "   jwt-secret already exists, keeping it (changing it would log everyone out)"
else
  if ! command -v openssl >/dev/null 2>&1; then echo "openssl is needed to generate the JWT secret" >&2; exit 1; fi
  put_secret jwt-secret "$(openssl rand -hex 48)"
fi

if [ "${SKIP_OPTIONAL:-}" != "1" ]; then
  echo
  echo "4) Optional services"
  ask_optional cloudinary-api-secret "Cloudinary API secret (image uploads)" hidden
  ask_optional twilio-auth-token "Twilio auth token (SMS)" hidden
  ask_optional fast2sms-api-key "Fast2SMS API key (SMS)" hidden
fi

echo
echo "All done. Secrets now in Secret Manager:"
g secrets list --format="value(name)" | sed 's/^/  - /'
echo
echo "You can close this window and tell Claude it is finished."
