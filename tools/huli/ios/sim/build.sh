# Builds the phone app for the iOS simulator on GitHub's macOS runner (huli-sim.yml), after
# `expo prebuild`: Release, arm64, signed ad hoc so its keychain and app group work in the
# simulator. Leaves Huli.app under $OUT/dd. Huli's own; see tools/huli/README.md.
set -euo pipefail
OUT="${OUT:?}"
mkdir -p "$OUT"
cd mobile/ios
pod install > "$OUT/pod.log" 2>&1 || { tail -30 "$OUT/pod.log"; exit 1; }
xcodebuild -workspace Huli.xcworkspace -scheme Huli -configuration Release \
  -destination "generic/platform=iOS Simulator" -derivedDataPath "$OUT/dd" \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER= \
  DEVELOPMENT_TEAM=Z5C6TTY2YF CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  build > "$OUT/build.log" 2>&1 \
  || { grep -E "error:" "$OUT/build.log" | sort -u | head -30; tail -20 "$OUT/build.log"; exit 1; }
ls -d "$OUT"/dd/Build/Products/Release-iphonesimulator/Huli.app
