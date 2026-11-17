# Builds the iOS app from ~/huli/mobile (prepare-ios.sh puts it there) for the simulator, signed to
# run locally so its keychain and App Group entitlements apply, and installs and launches it on one,
# for screenshots of every screen without a phone.
# Usage: [SIM="iPhone 18 Pro Max"] [APPEARANCE=dark|light] bash sim.sh
# Then: xcrun simctl io booted screenshot /tmp/shot.png
set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
APP_DIR="${APP_DIR:-$HOME/huli/mobile}"
OUT="${OUT:-$HOME/huli/out-sim}"
SIM="${SIM:-iPhone 18 Pro Max}"
mkdir -p "$OUT"

cd "$APP_DIR/ios"
echo "== pods"
pod install > "$OUT/pod.log" 2>&1 || { tail -30 "$OUT/pod.log"; exit 1; }

echo "== build"
xcodebuild -workspace Huli.xcworkspace -scheme Huli -configuration Release \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$OUT/dd" \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER= \
  DEVELOPMENT_TEAM=Z5C6TTY2YF CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  build > "$OUT/build.log" 2>&1 \
  || { grep -E "error:" "$OUT/build.log" | sort -u | head -30; tail -15 "$OUT/build.log"; exit 1; }
APP=$(ls -d "$OUT"/dd/Build/Products/Release-iphonesimulator/Huli.app)

echo "== simulator"
xcrun simctl boot "$SIM" 2>/dev/null || true
xcrun simctl bootstatus "$SIM" -b > /dev/null
xcrun simctl ui "$SIM" appearance "${APPEARANCE:-dark}"
xcrun simctl status_bar "$SIM" override --time 9:41 --batteryState charged --batteryLevel 100 \
  --cellularBars 4 --wifiBars 3 2>/dev/null || true
xcrun simctl terminate "$SIM" io.github.rsdvb.huli 2>/dev/null || true
xcrun simctl install "$SIM" "$APP"
xcrun simctl launch "$SIM" io.github.rsdvb.huli -huliNoAsk YES
