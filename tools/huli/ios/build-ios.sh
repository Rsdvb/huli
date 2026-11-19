set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
KEY_ID=Y945SS5C89
ISSUER=87f439b2-db97-4066-b695-34ff182c5842
# Where the app and these scripts are, and where the build goes; the defaults are the manual run's.
APP_DIR="${APP_DIR:-$HOME/huli/mobile}"
HULI_TOOLS="${HULI_TOOLS:-$HOME/huli}"
OUT="${OUT:-$HOME/huli/out}"
KC=huli-build.keychain-db
PASS_FILE="$HOME/.huli-keys/build-keychain.pass"
[ -f "$PASS_FILE" ] || (umask 077; openssl rand -hex 24 > "$PASS_FILE")
KPASS="$(cat "$PASS_FILE")"
[ -f "$HOME/Library/Keychains/$KC" ] || security create-keychain -p "$KPASS" "$KC"
security unlock-keychain -p "$KPASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
OTHERS=$(security list-keychains -d user | tr -d '"' | grep -v "$KC" | xargs)
security list-keychains -d user -s "$KC" $OTHERS

cd "$APP_DIR/ios"
echo "== pods"
pod install > /tmp/huli-pod.log 2>&1 || { tail -30 /tmp/huli-pod.log; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT"

echo "== signing"
BUNDLES=$(ruby -rxcodeproj -e 'p=Xcodeproj::Project.open("Huli.xcodeproj"); puts p.targets.select{|t| %i[application app_extension].include?(t.symbol_type)}.map{|t| t.build_configurations.find{|c| c.name=="Release"}.build_settings["PRODUCT_BUNDLE_IDENTIFIER"]}.join(" ")')
OUT="$OUT" node "$HULI_TOOLS/signing.mjs" "$KC" "$PASS_FILE" $BUNDLES > "$OUT/signing.log" 2>&1 || { cat "$OUT/signing.log"; exit 1; }
ruby "$HULI_TOOLS/manual-signing.rb" Huli.xcodeproj "$OUT/signing.json"

PROFILES=$(node -e 'const s=require(process.argv[1]);for(const[k,v]of Object.entries(s.profiles))console.log(`<key>${k}</key><string>${v.name}</string>`)' "$OUT/signing.json")
cat > "$OUT/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>Z5C6TTY2YF</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>$PROFILES</dict>
</dict>
</plist>
EOF

echo "== archive"
xcodebuild -workspace Huli.xcworkspace -scheme Huli -configuration Release \
  -destination generic/platform=iOS -archivePath "$OUT/Huli.xcarchive" \
  OTHER_CODE_SIGN_FLAGS="--keychain $HOME/Library/Keychains/$KC" archive > "$OUT/archive.log" 2>&1 \
  || { grep -E "error:|errSec" "$OUT/archive.log" | sort -u | head -30; tail -15 "$OUT/archive.log"; exit 1; }

echo "== export"
xcodebuild -exportArchive -archivePath "$OUT/Huli.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -exportPath "$OUT/export" > "$OUT/export.log" 2>&1 \
  || { grep -iE "error" "$OUT/export.log" | sort -u | head -30; tail -15 "$OUT/export.log"; exit 1; }
ls -l "$OUT/export"

# The same archive for the registered devices too, which install it from the update channel. It is
# optional: without it the App Store build still uploads, and the channel keeps its last iOS build.
if [ "${ADHOC:-0}" = 1 ]; then
  echo "== ad-hoc export"
  ARCHIVE="$OUT/Huli.xcarchive" OUT="$OUT/adhoc" bash "$HULI_TOOLS/export-adhoc.sh" $BUNDLES \
    || echo "::warning::The ad-hoc export failed; the update channel keeps its last iOS build"
fi

if [ "${UPLOAD:-1}" = 0 ]; then
  echo "== no upload (UPLOAD=0)"
  exit 0
fi
echo "== upload"
mkdir -p ~/.appstoreconnect/private_keys
ln -sf "$HOME/.huli-keys/AuthKey_$KEY_ID.p8" ~/.appstoreconnect/private_keys/
# altool sometimes fails on a cache file it cannot open; a second try goes through.
for attempt in 1 2 3; do
  xcrun altool --upload-app -f "$OUT"/export/*.ipa -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER" > "$OUT/upload.log" 2>&1 || true
  grep -q 'UPLOAD SUCCEEDED' "$OUT/upload.log" && break
  [ $attempt = 3 ] && { tail -15 "$OUT/upload.log"; exit 1; }
  sleep 20
done
grep -E 'UPLOAD SUCCEEDED|Delivery UUID' "$OUT/upload.log"
