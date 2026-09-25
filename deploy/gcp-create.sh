#!/usr/bin/env bash
# Create the free-tier VM and install the app. Run this in Google Cloud Shell
# (https://shell.cloud.google.com), which is already signed in to your Google account:
#
#   BRANCH=main bash <(curl -fsSL https://raw.githubusercontent.com/javongithub/tutoring-web/main/deploy/gcp-create.sh)
#
# Safe to re-run: existing firewall rule / VM are reused and the app is updated.
set -euo pipefail

ZONE=${ZONE:-us-west1-b}              # us-west1 / us-central1 / us-east1 are the Always Free regions
NAME=${NAME:-tutoring}
BRANCH=${BRANCH:-main}
REPO=${REPO:-https://github.com/javongithub/tutoring-web}
PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}

if [[ -z "$PROJECT" ]]; then
  echo "No Google Cloud project selected. Create one (and link billing — required even for the free tier):"
  echo "  https://console.cloud.google.com/projectcreate  then: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
echo "==> Project $PROJECT, zone $ZONE, VM $NAME, branch $BRANCH"

gcloud services enable compute.googleapis.com --project "$PROJECT"

if ! gcloud compute firewall-rules describe allow-web --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create allow-web --project "$PROJECT" \
    --allow tcp:80,tcp:443 --target-tags web --description "HTTP/HTTPS for the tutoring app"
fi

if ! gcloud compute instances describe "$NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  # e2-micro + 30 GB standard disk in these regions = Always Free tier.
  gcloud compute instances create "$NAME" --project "$PROJECT" --zone "$ZONE" \
    --machine-type e2-micro --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 30GB --boot-disk-type pd-standard --tags web
  echo "==> Waiting for the VM to boot…"
  sleep 30
fi

for i in 1 2 3 4 5 6; do
  if gcloud compute ssh "$NAME" --zone "$ZONE" --project "$PROJECT" --quiet --command \
    "curl -fsSL https://raw.githubusercontent.com/javongithub/tutoring-web/$BRANCH/deploy/setup-vm.sh | sudo BRANCH='$BRANCH' REPO='$REPO' DOMAIN='${DOMAIN:-}' bash"; then
    exit 0
  fi
  echo "SSH not ready yet, retrying in 15s ($i/6)…"; sleep 15
done
echo "Could not reach the VM over SSH. Try again in a minute (the script is safe to re-run)."
exit 1
