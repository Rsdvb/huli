# Builds a development copy of the iOS app from ~/huli/mobile (prepare-ios.sh puts it there) and
# installs it on a connected iPhone, registering the phone with the team first.
# Usage: DEVICE=<udid> [DEVICE_NAME=<name>] bash install-dev.sh
set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
: "${DEVICE:?the iPhone's UDID}"
APP_DIR="${APP_DIR:-$HOME/huli/mobile}"
HULI_TOOLS="${HULI_TOOLS:-$HOME/huli}"
OUT="${OUT:-$HOME/huli/out-dev}"
KC=huli-build.keychain-db
PASS_FILE="$HOME/.huli-keys/build-keychain.pass"
KPASS="$(cat "$PASS_FILE")"
security unlock-keychain -p "$KPASS" "$KC"
OTHERS=$(security list-keychains -d user | tr -d '"' | grep -v "$KC" | xargs)
security list-keychains -d user -s "$KC" $OTHERS
rm -rf "$OUT" && mkdir -p "$OUT"

echo "== register the device"
printf '{"data":{"type":"devices","attributes":{"name":"%s","platform":"IOS","udid":"%s"}}}' \
  "${DEVICE_NAME:-iPhone}" "$DEVICE" > "$OUT/device.json"
RAW=1 node "$HULI_TOOLS/asc.mjs" POST /v1/devices "$OUT/device.json" > "$OUT/device.log" 2>&1 || true
head -1 "$OUT/device.log" # 201 when new, 409 when the team has it already

cd "$APP_DIR/ios"
echo "== pods"
pod install > "$OUT/pod.log" 2>&1 || { tail -30 "$OUT/pod.log"; exit 1; }

echo "== signing"
BUNDLES=$(ruby -rxcodeproj -e 'p=Xcodeproj::Project.open("Huli.xcodeproj"); puts p.targets.select{|t| %i[application app_extension].include?(t.symbol_type)}.map{|t| t.build_configurations.find{|c| c.name=="Release"}.build_settings["PRODUCT_BUNDLE_IDENTIFIER"]}.join(" ")')
SIGNING=development OUT="$OUT" node "$HULI_TOOLS/signing.mjs" "$KC" "$PASS_FILE" $BUNDLES > "$OUT/signing.log" 2>&1 || { cat "$OUT/signing.log"; exit 1; }
ruby "$HULI_TOOLS/manual-signing.rb" Huli.xcodeproj "$OUT/signing.json"

echo "== build"
xcodebuild -workspace Huli.xcworkspace -scheme Huli -configuration Release \
  -destination generic/platform=iOS -derivedDataPath "$OUT/dd" \
  OTHER_CODE_SIGN_FLAGS="--keychain $HOME/Library/Keychains/$KC" build > "$OUT/build.log" 2>&1 \
  || { grep -E "error:|errSec" "$OUT/build.log" | sort -u | head -30; tail -15 "$OUT/build.log"; exit 1; }
APP=$(ls -d "$OUT"/dd/Build/Products/Release-iphoneos/Huli.app)

echo "== install"
xcrun devicectl device install app --device "$DEVICE" "$APP" 2>&1 | tail -3
xcrun devicectl device process launch --device "$DEVICE" io.github.rsdvb.huli 2>&1 | tail -2 || true
