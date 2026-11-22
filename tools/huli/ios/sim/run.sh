# Runs the phone app against a live computer on GitHub's macOS runner (huli-sim.yml): a fresh
# simulator, a daemon of this checkout with the fake agent and its own data folder, the app paired
# with it alone, then each flow under flows/ (or those named in FLOWS) while the screen is
# recorded. Everything lands in $OUT/results for the run's artifact. Huli's own; see
# tools/huli/README.md.
set -euo pipefail
OUT="${OUT:?}"
RESULTS="$OUT/results"
mkdir -p "$RESULTS"
APP=$(ls -d "$OUT"/dd/Build/Products/Release-iphonesimulator/Huli.app)
export JAVA_HOME="$HOME/.huli-tools/jdk/Contents/Home"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
MAESTRO="$HOME/.huli-tools/maestro/bin/maestro"

# The newest iOS runtime, on the newest Pro Max it offers.
RUNTIME=$(xcrun simctl list runtimes -j | node -e '
  const r = JSON.parse(require("fs").readFileSync(0, "utf8")).runtimes
    .filter((x) => x.platform === "iOS" && x.isAvailable)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
  console.log(r.at(-1).identifier)')
TYPE=$(xcrun simctl list devicetypes -j | node -e '
  const t = JSON.parse(require("fs").readFileSync(0, "utf8")).devicetypes
    .filter((x) => /^iPhone \d+ Pro Max$/.test(x.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  console.log(t.at(-1).identifier)')
echo "simulator: $TYPE on $RUNTIME"
UDID=$(xcrun simctl create huli-sim "$TYPE" "$RUNTIME")
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b > /dev/null
# The Pinyin keyboard first, whose candidate bar changes the keyboard's height as Chinese users see.
xcrun simctl spawn "$UDID" defaults write -g AppleKeyboards -array \
  "zh_Hans-Pinyin@sw=Pinyin;hw=Automatic" "en_US@sw=QWERTY;hw=Automatic"
xcrun simctl spawn "$UDID" defaults write -g AppleKeyboardsExpanded -int 1
xcrun simctl install "$UDID" "$APP"

# The computer: this checkout's daemon with the fake agent, in a data folder of its own.
export KETTU_DAEMON_DATA="$OUT/daemon"
export KETTU_DIRECT_PORT=47231
# The fake agent bundled into one file. Started from its TypeScript, each start stripped the types
# of its modules and resolved its packages anew, which while the simulator and Maestro's driver
# loaded the runner outlasted the 30 s the host gives an agent to answer `initialize`: the first
# session failed, and with its prompt left in the new-session box, every session flow after it.
node tools/huli/ios/sim/bundle-fake-agent.mjs "$OUT/fake-agent"
export KETTU_FAKE_AGENT="$OUT/fake-agent/fake-agent.mjs"
# A run of it first (it ends with its closed input), with Node's compile cache kept for the
# daemon's own starts, leaves only the quick part.
export NODE_COMPILE_CACHE="$OUT/node-compile-cache"
mkdir -p "$NODE_COMPILE_CACHE"
started=$(date +%s)
node "$KETTU_FAKE_AGENT" < /dev/null > /dev/null 2>&1 || true
echo "fake agent warm-up: $(($(date +%s) - started)) s"
mkdir -p "$KETTU_DAEMON_DATA"
# Huli: a manager-mode roster of the fake agent, for the manager flow, in a fresh data folder.
[ -f "$KETTU_DAEMON_DATA/settings.json" ] ||
  node tools/huli/ios/sim/seed-manager.mjs "$KETTU_DAEMON_DATA/settings.json"
node out/daemon/main.cjs run > "$RESULTS/daemon.log" 2>&1 &
DAEMON=$!
# What loads the runner while the flows run, every 5 s, to tell a slow start from a stuck one.
while kill -0 "$DAEMON" 2> /dev/null; do
  { date -u +%T; ps -Ao pcpu=,rss=,etime=,comm= -r | head -6 || true; } >> "$RESULTS/load.log"
  sleep 5
done &
# Remote access starts a while after the daemon does; a code asked for before then fails.
for _ in $(seq 1 120); do
  node out/daemon/main.cjs status 2>/dev/null | grep -Eq '^Remote host: +ready' && break
  sleep 1
done
node out/daemon/main.cjs status
for attempt in 1 2 3; do
  node tools/huli/ios/sim/pair.mjs "$UDID" | tee -a "$RESULTS/pair.log" && break
  [ "$attempt" = 3 ] && exit 1
  sleep 10
done
sleep 5
xcrun simctl io "$UDID" screenshot "$RESULTS/paired.png"

# A dev server on the loopback for the preview flow, only when it runs.
DEV_SERVER=
if [ -z "${FLOWS:-}" ] || [[ "$FLOWS" == *dev-preview* ]]; then
  node tools/huli/ios/sim/dev-server.mjs > "$RESULTS/dev-server.log" 2>&1 &
  DEV_SERVER=$!
fi

failed=0
for flow in ${FLOWS:-$(ls tools/huli/ios/sim/flows/*.yaml)}; do
  # What the app costs at rest, sampled without a recording, which would load the runner.
  if [ "$flow" = measure ]; then
    echo "== measure"
    UDID="$UDID" MAESTRO="$MAESTRO" RESULTS="$RESULTS" bash tools/huli/ios/sim/measure.sh
    continue
  fi
  # A long finished reply opened afresh, sampled the same way (long-reply.sh).
  if [ "$flow" = long-reply ]; then
    echo "== long-reply"
    UDID="$UDID" MAESTRO="$MAESTRO" RESULTS="$RESULTS" bash tools/huli/ios/sim/long-reply.sh
    continue
  fi
  [ -f "$flow" ] || flow="tools/huli/ios/sim/flows/$flow.yaml"
  name=$(basename "$flow" .yaml)
  echo "== $name"
  xcrun simctl io "$UDID" recordVideo --codec h264 --force "$RESULTS/$name.mp4" > /dev/null 2>&1 &
  REC=$!
  sleep 1
  if ! "$MAESTRO" --device "$UDID" test --test-output-dir "$RESULTS/$name" \
    -e PROJECT="$OUT/project" "$flow" > "$RESULTS/$name.log" 2>&1; then
    failed=1
    tail -15 "$RESULTS/$name.log"
  fi
  # A flow that ends on a screen to see in both appearances says so, as the system's own viewers
  # follow the system's appearance rather than the app's theme.
  if grep -q '^# Ends: both appearances' "$flow"; then
    xcrun simctl ui "$UDID" appearance dark
    sleep 2
    xcrun simctl io "$UDID" screenshot "$RESULTS/$name-dark.png"
    xcrun simctl ui "$UDID" appearance light
    sleep 2
    xcrun simctl io "$UDID" screenshot "$RESULTS/$name-light.png"
  fi
  sleep 1
  kill -INT "$REC" || true
  wait "$REC" 2>/dev/null || true
done

# What the developer's frame meter counted in the flows that ran it (FrameMeter.tsx).
DATA=$(xcrun simctl get_app_container "$UDID" io.github.rsdvb.huli data 2>/dev/null || true)
[ -n "$DATA" ] && cp "$DATA/Documents/huli-frames.json" "$RESULTS/" 2>/dev/null || true

# The same screen in the dark appearance.
xcrun simctl ui "$UDID" appearance dark
sleep 2
xcrun simctl io "$UDID" screenshot "$RESULTS/last-dark.png"
xcrun simctl ui "$UDID" appearance light
sleep 2
xcrun simctl io "$UDID" screenshot "$RESULTS/last-light.png"

cp -R "$KETTU_DAEMON_DATA/logs" "$RESULTS/daemon-logs" 2>/dev/null || true
[ -n "$DEV_SERVER" ] && kill "$DEV_SERVER" 2>/dev/null || true
kill "$DAEMON" || true
xcrun simctl shutdown "$UDID" || true
xcrun simctl delete "$UDID" || true
exit $failed
