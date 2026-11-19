# Checks the IPA export-adhoc.sh made before it goes to the update channel: the app and each of its
# extensions carry an ad-hoc profile, one that lists devices and allows no debugger. Prints names,
# counts and dates only, never a device's UDID, since the repository's logs are public.
# Usage: bash check-ipa.sh <Huli.ipa>
set -euo pipefail
ipa="${1:?usage: check-ipa.sh <Huli.ipa>}"
if [ ! -s "$ipa" ]; then
  echo "::warning::No ad-hoc iOS build; the update channel keeps its last one."
  exit 1
fi
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$ipa" -d "$work"
app="$(ls -d "$work"/Payload/*.app)"
bundles=0
while IFS= read -r bundle; do
  name="$(basename "$bundle")"
  if [ ! -f "$bundle/embedded.mobileprovision" ]; then
    echo "::error::$name carries no provisioning profile"
    exit 1
  fi
  security cms -D -i "$bundle/embedded.mobileprovision" > "$work/profile.plist"
  devices="$(plutil -extract ProvisionedDevices json -o - "$work/profile.plist" 2>/dev/null \
    | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).length)' 2>/dev/null \
    || echo 0)"
  debug="$(plutil -extract Entitlements.get-task-allow raw -o - "$work/profile.plist" 2>/dev/null || echo missing)"
  profile="$(plutil -extract Name raw -o - "$work/profile.plist")"
  ends="$(plutil -extract ExpirationDate raw -o - "$work/profile.plist")"
  echo "$name: $profile, $devices devices, get-task-allow $debug, until $ends"
  if [ "$devices" -lt 1 ] || { [ "$debug" != false ] && [ "$debug" != 0 ]; }; then
    echo "::error::$name is not signed ad hoc"
    exit 1
  fi
  bundles=$((bundles + 1))
done < <(find "$app" -type d \( -name '*.app' -o -name '*.appex' \))
echo "$bundles bundles signed ad hoc"
