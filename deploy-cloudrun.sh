#!/usr/bin/env bash
# Deploy Meetble to Google Cloud Run with the gcloud CLI, so anyone can use it with their Google account.
# Easiest place to run it: Google Cloud Shell (https://shell.cloud.google.com), already signed in:
#   git clone https://github.com/yukeidaro/meetble && cd meetble
#   nano .env                                   # your API keys (same as .env.example)
#   ./deploy-cloudrun.sh                         # 1st run: prints the URL + how to make the Google sign-in client
#   GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com ./deploy-cloudrun.sh   # 2nd run: turns on sign-in
# Settings (env vars): PROJECT (default: gcloud's current project), REGION (asia-east1 = Taiwan), SERVICE, BUCKET.
# Delete everything afterwards: gcloud run services delete meetble --region asia-east1; gcloud storage rm -r gs://$BUCKET
set -euo pipefail
cd "$(dirname "$0")"
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-east1}"
SERVICE="${SERVICE:-meetble}"
BUCKET="${BUCKET:-${PROJECT}-meetble-data}"
[ -n "$PROJECT" ] || { echo "No project. Run: gcloud config set project <your-project-id>"; exit 1; }
[ -f .env ] || { echo ".env not found. Copy .env.example to .env and paste your API keys."; exit 1; }
echo "Project $PROJECT · region $REGION · service $SERVICE · bucket gs://$BUCKET"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com --project "$PROJECT"
gcloud storage buckets describe "gs://$BUCKET" --project "$PROJECT" >/dev/null 2>&1 \
  || gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access

# The server's env: API keys from .env, plus a session/encryption secret kept in the bucket so it survives redeploys.
SECRET_FILE="$(mktemp)"; ENV_FILE="$(mktemp --suffix .yaml)"; trap 'rm -f "$SECRET_FILE" "$ENV_FILE"' EXIT
if ! gcloud storage cp "gs://$BUCKET/.meetble_secret" "$SECRET_FILE" >/dev/null 2>&1; then
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$SECRET_FILE"
  gcloud storage cp "$SECRET_FILE" "gs://$BUCKET/.meetble_secret" >/dev/null
fi
{
  grep -E '^[A-Z_][A-Z0-9_]*=' .env | while IFS='=' read -r k v; do
    v="${v%\"}"; v="${v#\"}"; [ -n "$v" ] && printf '%s: "%s"\n' "$k" "${v//\"/\\\"}"
  done
  echo "MEETBLE_SECRET: \"$(cat "$SECRET_FILE")\""
  if [ -n "${GOOGLE_CLIENT_ID:-}" ]; then echo "GOOGLE_CLIENT_ID: \"$GOOGLE_CLIENT_ID\""
  else echo "MEETBLE_TOKEN: \"$({ printf token; cat "$SECRET_FILE"; } | sha256sum | cut -c1-24)\""; fi  # until sign-in is on, a token keeps strangers off your API keys
  [ -n "${MEETBLE_ALLOWED_EMAILS:-}" ] && echo "MEETBLE_ALLOWED_EMAILS: \"$MEETBLE_ALLOWED_EMAILS\""
  true
} > "$ENV_FILE"

# One instance: runs live in memory and accounts are files in the bucket. No CPU throttling: the pipeline runs in
# child processes while the browser listens on a stream. 60 min request timeout for the live stream.
gcloud run deploy "$SERVICE" --source . --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --execution-environment gen2 \
  --cpu 2 --memory 4Gi --no-cpu-throttling --timeout 3600 --concurrency 40 --min-instances 0 --max-instances 1 \
  --env-vars-file "$ENV_FILE" \
  --add-volume name=data,type=cloud-storage,bucket="$BUCKET" --add-volume-mount volume=data,mount-path=/data

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "Meetble is live: $URL"
if [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
  cat <<MSG

For now it is locked with a token: $URL/?token=$({ printf token; cat "$SECRET_FILE"; } | sha256sum | cut -c1-24)
Sign-in is OFF until you give it a Google OAuth client (one time, ~2 minutes):
  1) https://console.cloud.google.com/auth/overview?project=$PROJECT  -> Get started (app name Meetble, External, your email)
  2) https://console.cloud.google.com/auth/clients/create?project=$PROJECT
       Application type: Web application
       Authorized JavaScript origins: $URL
  3) Copy the Client ID, then run:
       GOOGLE_CLIENT_ID=<client id> ./deploy-cloudrun.sh
  While the consent screen is in "Testing", add each tester under Audience; press "Publish app" to let anyone in.
MSG
fi
