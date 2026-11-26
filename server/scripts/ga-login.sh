#!/usr/bin/env bash
# One-time Google login for Filmroom's Analytics tools, kept in its OWN folder so it can never touch (or be mixed up with) any other
# Google credentials on this machine. Run it from a normal terminal:   bash server/scripts/ga-login.sh
# Needs ~/.config/gcloud-filmroom/client.json (the Desktop OAuth client downloaded from the Cloud Console, project filmroom-app-4919).
set -euo pipefail
D="$HOME/.config/gcloud-filmroom"
if [ ! -f "$D/client.json" ]; then
  echo "Missing $D/client.json"
  echo "Cloud Console (personal account, project filmroom-app-4919) -> APIs & Services -> Credentials -> Create credentials ->"
  echo "OAuth client ID -> Desktop app -> Download JSON, then save it as that file."
  exit 1
fi
export CLOUDSDK_CONFIG="$D"
echo "Sign in with your PERSONAL Google account (the one that owns Filmroom's Analytics)."
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/analytics.edit,https://www.googleapis.com/auth/cloud-platform \
  --client-id-file="$D/client.json"
# optional: the Analytics APIs work without a quota project, and this step needs the Cloud Resource Manager API enabled
gcloud auth application-default set-quota-project filmroom-app-4919 </dev/null || echo "(skipped the optional quota-project step, that is fine)"
echo
echo "Done. Credentials are in $D/application_default_credentials.json (outside the repo). Tell Claude."
