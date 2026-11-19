# Exports the archive build-ios.sh made for the App Store once more, signed ad hoc for the team's
# registered devices, which install it from the update channel through an itms-services link
# (TestFlight cannot reach them). Same archive, same version and build number; only the profiles
# differ, which signing.mjs makes or keeps (SIGNING=adhoc). build-ios.sh runs it with the build
# keychain unlocked and on the search list.
# Usage: ARCHIVE=<Huli.xcarchive> OUT=<folder> bash export-adhoc.sh <bundle id>...
# The IPA lands in $OUT/export/Huli.ipa.
set -euo pipefail
: "${ARCHIVE:?set ARCHIVE to the .xcarchive}"
: "${OUT:?set OUT to the output folder}"
TOOLS="$(cd "$(dirname "$0")" && pwd)"
KC=huli-build.keychain-db
PASS_FILE="$HOME/.huli-keys/build-keychain.pass"
rm -rf "$OUT" && mkdir -p "$OUT"

SIGNING=adhoc OUT="$OUT" node "$TOOLS/signing.mjs" "$KC" "$PASS_FILE" "$@" > "$OUT/signing.log" 2>&1 \
  || { cat "$OUT/signing.log"; exit 1; }
grep -E '^(kept|made) ' "$OUT/signing.log" || true

PROFILES=$(node -e 'const s=require(process.argv[1]);for(const[k,v]of Object.entries(s.profiles))console.log(`<key>${k}</key><string>${v.name}</string>`)' "$OUT/signing.json")
CERT=$(node -e 'console.log(require(process.argv[1]).signing)' "$OUT/signing.json")
# release-testing is the ad-hoc method's name since Xcode 15.3.
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>release-testing</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>Z5C6TTY2YF</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$CERT</string>
  <key>provisioningProfiles</key><dict>$PROFILES</dict>
  <key>thinning</key><string>&lt;none&gt;</string>
</dict>
</plist>
EOF

xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" > "$OUT/export.log" 2>&1 \
  || { grep -iE "error" "$OUT/export.log" | sort -u | head -30; tail -15 "$OUT/export.log"; exit 1; }
ls -l "$OUT/export"
