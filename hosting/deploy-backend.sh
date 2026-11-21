#!/usr/bin/env bash
# Builds the backend in Google Cloud Build and deploys it to Cloud Run.
#
#   GCP_PROJECT=<project-id> GCP_ACCOUNT=<you@example.com> ALLOWED_ORIGINS=https://your-app.vercel.app \
#     bash hosting/deploy-backend.sh
#
# Optional settings (defaults in brackets):
#   REGION [asia-south1]        SERVICE [gantavyam-backend]      DEFAULT_ADMIN_EMAIL [admin@example.com]
#   CLOUDINARY_CLOUD_NAME, TWILIO_ACCOUNT_SID, TWILIO_PHONE_NUMBER (plain settings, not secret)
#
# Run hosting/create-secrets.sh first: the secrets it creates are mounted into the service.
set -euo pipefail

: "${GCP_PROJECT:?Set GCP_PROJECT to your Google Cloud project id}"
: "${GCP_ACCOUNT:?Set GCP_ACCOUNT to the Google account to use}"
REGION="${REGION:-asia-south1}"
SERVICE="${SERVICE:-gantavyam-backend}"
ADMIN_EMAIL="${DEFAULT_ADMIN_EMAIL:-admin@example.com}"
ORIGINS="${ALLOWED_ORIGINS:-}"

g() { gcloud "$@" --project "$GCP_PROJECT" --account "$GCP_ACCOUNT" --quiet; }
secret_exists() { g secrets describe "$1" >/dev/null 2>&1; }

# Secrets are only mounted when they exist
SECRET_ARGS=()
add_secret() { # ENV_NAME secret-name
  if secret_exists "$2"; then SECRET_ARGS+=("$1=$2:latest"); else echo "note: secret $2 not found, $1 will be unset"; fi
}
add_secret TURSO_DATABASE_URL turso-database-url
add_secret TURSO_AUTH_TOKEN turso-auth-token
add_secret JWT_SECRET jwt-secret
add_secret DEFAULT_ADMIN_PASSWORD default-admin-password
add_secret CLOUDINARY_API_SECRET cloudinary-api-secret
add_secret TWILIO_AUTH_TOKEN twilio-auth-token
add_secret FAST2SMS_API_KEY fast2sms-api-key

if [ ${#SECRET_ARGS[@]} -eq 0 ]; then echo "No secrets found. Run hosting/create-secrets.sh first." >&2; exit 1; fi

ENV_VARS="NODE_ENV=production@DEFAULT_ADMIN_EMAIL=${ADMIN_EMAIL}"
[ -n "$ORIGINS" ] && ENV_VARS="${ENV_VARS}@ALLOWED_ORIGINS=${ORIGINS}"
for name in CLOUDINARY_CLOUD_NAME TWILIO_ACCOUNT_SID TWILIO_PHONE_NUMBER; do
  [ -n "${!name:-}" ] && ENV_VARS="${ENV_VARS}@${name}=${!name}"
done

# The runtime identity needs to read the secrets
PROJECT_NUMBER="$(g projects describe "$GCP_PROJECT" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for s in turso-database-url turso-auth-token jwt-secret default-admin-password cloudinary-api-secret twilio-auth-token fast2sms-api-key; do
  if secret_exists "$s"; then
    g secrets add-iam-policy-binding "$s" --member "serviceAccount:${RUNTIME_SA}" --role roles/secretmanager.secretAccessor >/dev/null
  fi
done

# One always-on instance: Socket.IO connections and the background timers live in memory.
g run deploy "$SERVICE" \
  --source server \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 512Mi \
  --min-instances 1 --max-instances 1 \
  --no-cpu-throttling \
  --timeout 3600 \
  --set-env-vars "^@^${ENV_VARS}" \
  --set-secrets "$(IFS=,; echo "${SECRET_ARGS[*]}")"

echo
echo "Service URL:"
g run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
