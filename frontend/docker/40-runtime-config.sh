#!/bin/sh
# Writes assets/runtime-config.json from the environment, so one image serves every deployment.
set -eu
: "${API_BASE:?API_BASE must be set}"
: "${KEYCLOAK_URL:?KEYCLOAK_URL must be set}"
: "${KEYCLOAK_REALM:?KEYCLOAK_REALM must be set}"
: "${KEYCLOAK_CLIENT_ID:?KEYCLOAK_CLIENT_ID must be set}"
keycloak_url="$KEYCLOAK_URL"
while [ "${keycloak_url%/}" != "$keycloak_url" ]; do
  keycloak_url="${keycloak_url%/}"
done
mkdir -p /usr/share/nginx/html/assets
jq -n \
  --arg apiBase "$API_BASE" \
  --arg keycloakUrl "$keycloak_url" \
  --arg realm "$KEYCLOAK_REALM" \
  --arg clientId "$KEYCLOAK_CLIENT_ID" \
  '{apiBase: $apiBase, keycloakUrl: $keycloakUrl, realm: $realm, clientId: $clientId}' \
  > /usr/share/nginx/html/assets/runtime-config.json
echo "runtime-config.json written for realm ${KEYCLOAK_REALM}"
