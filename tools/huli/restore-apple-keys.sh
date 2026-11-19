#!/usr/bin/env bash
# Huli: puts the Apple signing material into ~/.huli-keys on one of GitHub's macOS runners, where
# the owner's Mac keeps it. APPLE_KEYS is the HULI_APPLE_KEYS secret: a base64 gzip tar of
#   build-keychain.pass          the password the build keychain and the iOS .p12 use
#   AuthKey_Y945SS5C89.p8        the App Store Connect API key (notarizing, TestFlight, profiles)
#   ios-distribution.p12/.serial the Apple Distribution certificate, so no build makes a new one
#   mac-developer-id.p12/.pass   the Developer ID Application certificate and its password
#   mac-developer-id.pem         that certificate alone, for its name
# Nothing of it is printed. Huli's own; see tools/huli/README.md.
set -euo pipefail

if [ -z "${APPLE_KEYS:-}" ]; then
  echo 'HULI_APPLE_KEYS is not set: no Apple keys for this build' >&2
  exit 1
fi
keys="$HOME/.huli-keys"
mkdir -p "$keys"
chmod 700 "$keys"
(umask 077 && printf '%s' "$APPLE_KEYS" | base64 --decode | tar -xzf - -C "$keys")
for file in build-keychain.pass AuthKey_Y945SS5C89.p8 ios-distribution.p12 ios-distribution.serial \
  mac-developer-id.p12 mac-developer-id.pass mac-developer-id.pem; do
  [ -s "$keys/$file" ] || { echo "HULI_APPLE_KEYS lacks $file" >&2; exit 1; }
done
echo "Apple keys restored ($(ls "$keys" | wc -l | tr -d ' ') files)"
