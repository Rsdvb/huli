# Runs the phone app in an Android emulator against a live computer on GitHub's Linux runner
# (huli-sim.yml with platform android), inside the emulator runner's script: installs the app
# built from `ref`, starts this checkout's daemon with the fake agent in a data folder of its own,
# pairs the app with it alone, then measures what the app costs at rest (../ios/sim/measure.sh,
# with sample.mjs here). Everything lands in $OUT/results. Huli's own; see tools/huli/README.md.
set -euo pipefail
OUT="${OUT:?}"
RESULTS="$OUT/results"
mkdir -p "$RESULTS"
APK=mobile/android/app/build/outputs/apk/release/app-release.apk
MAESTRO="$HOME/.huli-tools/maestro/bin/maestro"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true

adb wait-for-device
# Root reads SurfaceFlinger's /proc; a google_apis image allows it.
adb root > /dev/null 2>&1 || true
sleep 3
adb wait-for-device
adb shell getprop ro.build.version.release
adb install -r "$APK" > /dev/null
adb shell pm grant io.github.rsdvb.huli android.permission.POST_NOTIFICATIONS 2> /dev/null || true

export KETTU_DAEMON_DATA="$OUT/daemon"
export KETTU_DIRECT_PORT=47231
node tools/huli/ios/sim/bundle-fake-agent.mjs "$OUT/fake-agent"
export KETTU_FAKE_AGENT="$OUT/fake-agent/fake-agent.mjs"
export NODE_COMPILE_CACHE="$OUT/node-compile-cache"
mkdir -p "$NODE_COMPILE_CACHE" "$KETTU_DAEMON_DATA"
node "$KETTU_FAKE_AGENT" < /dev/null > /dev/null 2>&1 || true
node out/daemon/main.cjs run > "$RESULTS/daemon.log" 2>&1 &
DAEMON=$!
for _ in $(seq 1 120); do
  node out/daemon/main.cjs status 2> /dev/null | grep -Eq '^Remote host: +ready' && break
  sleep 1
done
adb shell am start -W -n io.github.rsdvb.huli/.MainActivity > /dev/null || true
sleep 5
for attempt in 1 2 3; do
  node tools/huli/android/pair.mjs | tee -a "$RESULTS/pair.log" && break
  if [ "$attempt" = 3 ]; then
    adb exec-out screencap -p > "$RESULTS/pair-failed.png" || true
    adb logcat -d -s ReactNativeJS:W ReactNative:W AndroidRuntime:E > "$RESULTS/logcat.txt" || true
    cp -R "$KETTU_DAEMON_DATA/logs" "$RESULTS/daemon-logs" 2> /dev/null || true
    exit 1
  fi
  sleep 10
done
sleep 5
adb exec-out screencap -p > "$RESULTS/paired.png"

adb logcat -d -s ReactNativeJS:W AndroidRuntime:E > "$RESULTS/logcat-paired.txt" || true

DEVICE=$(adb get-serialno) SAMPLER=tools/huli/android/sample.mjs MAESTRO="$MAESTRO" \
  RESULTS="$RESULTS" MEASURE_ALT=default bash tools/huli/ios/sim/measure.sh

cp -R "$KETTU_DAEMON_DATA/logs" "$RESULTS/daemon-logs" 2> /dev/null || true
kill "$DAEMON" || true
