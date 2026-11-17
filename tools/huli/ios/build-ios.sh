set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
KEY_ID=Y945SS5C89
ISSUER=87f439b2-db97-4066-b695-34ff182c5842
OUT="$HOME/huli/out"
KC=huli-build.keychain-db
PASS_FILE="$HOME/.huli-keys/build-keychain.pass"
[ -f "$PASS_FILE" ] || (umask 077; openssl rand -hex 24 > "$PASS_FILE")
KPASS="$(cat "$PASS_FILE")"
[ -f "$HOME/Library/Keychains/$KC" ] || security create-keychain -p "$KPASS" "$KC"
security unlock-keychain -p "$KPASS" "$KC"
security set-keychain-settings -lut 21600 "$KC"
OTHERS=$(security list-keychains -d user | tr -d '"' | grep -v "$KC" | xargs)
security list-keychains -d user -s "$KC" $OTHERS

cd ~/huli/mobile/ios
echo "== pods"
pod install > /tmp/huli-pod.log 2>&1 || { tail -30 /tmp/huli-pod.log; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT"

echo "== signing"
BUNDLES=$(ruby -rxcodeproj -e 'p=Xcodeproj::Project.open("Huli.xcodeproj"); puts p.targets.select{|t| %i[application app_extension].include?(t.symbol_type)}.map{|t| t.build_configurations.find{|c| c.name=="Release"}.build_settings["PRODUCT_BUNDLE_IDENTIFIER"]}.join(" ")')
node ~/huli/signing.mjs "$KC" "$PASS_FILE" $BUNDLES > "$OUT/signing.log" 2>&1 || { cat "$OUT/signing.log"; exit 1; }
ruby ~/huli/manual-signing.rb Huli.xcodeproj "$OUT/signing.json"

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
  <key>testFlightInternalTestingOnly</key><true/>
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

echo "== upload"
mkdir -p ~/.appstoreconnect/private_keys
ln -sf "$HOME/.huli-keys/AuthKey_$KEY_ID.p8" ~/.appstoreconnect/private_keys/
xcrun altool --upload-app -f "$OUT"/export/*.ipa -t ios --apiKey "$KEY_ID" --apiIssuer "$ISSUER" 2>&1 | tail -15
