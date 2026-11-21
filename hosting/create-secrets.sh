#!/usr/bin/env bash
# Creates (or updates) the Secret Manager secrets the backend needs on Cloud Run.
#
# Values are typed into this prompt and sent straight to Secret Manager. They are never written to
# a file, to the shell history or to the repository.
#
#   GCP_PROJECT=<project-id> GCP_ACCOUNT=<you@example.com> bash hosting/create-secrets.sh
#
# Press Enter to skip an optional value. Re-running is safe: existing secrets get a new version
# only when you type a new value, and the JWT secret is only generated if it does not exist yet.
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

# ask <secret-name> <label> <required|optional> <hidden|visible>
ask() {
  local name="$1" label="$2" need="$3" mode="$4" value=""
  if [ "$mode" = "hidden" ]; then
    read -rsp "$label: " value; echo
  else
    read -rp "$label: " value
  fi
  if [ -z "$value" ]; then
    if [ "$need" = "required" ] && ! secret_exists "$name"; then
      echo "  $name is required." >&2
      exit 1
    fi
    echo "  skipped  $name"
    return 0
  fi
  put_secret "$name" "$value"
}

echo "Project: $GCP_PROJECT   Account: $GCP_ACCOUNT"
echo
echo "== Database (Turso) =="
ask turso-database-url "Turso database URL (libsql://...)" required visible
ask turso-auth-token "Turso auth token" required hidden

echo
echo "== Login security =="
if secret_exists jwt-secret; then
  echo "  jwt-secret already exists, keeping it (changing it would log everyone out)"
else
  if ! command -v openssl >/dev/null 2>&1; then echo "openssl is needed to generate the JWT secret" >&2; exit 1; fi
  put_secret jwt-secret "$(openssl rand -hex 48)"
fi
ask default-admin-password "Password for the default admin account (8+ characters)" required hidden

echo
echo "== Optional services (Enter to skip) =="
ask cloudinary-api-secret "Cloudinary API secret (image uploads)" optional hidden
ask twilio-auth-token "Twilio auth token (SMS)" optional hidden
ask fast2sms-api-key "Fast2SMS API key (SMS)" optional hidden

echo
echo "Done. Secrets now in Secret Manager:"
g secrets list --format="value(name)" | sed 's/^/  - /'
