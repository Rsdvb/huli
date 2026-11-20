# What the phone app costs while it only shows something, for run.sh when FLOWS names `measure`:
# the app is put in each state by a Maestro flow under measure/, then, with Maestro gone, its
# process, the simulator's render server and Maestro's driver are sampled for MEASURE_SECONDS
# (sample.mjs). The states: nothing running, a finished session, a session at work (the fake
# agent's long turn), the home list while it works, the app in the background, a finished session
# while another works, and a reply streaming in, still and scrolled, first with MEASURE_ALT as
# -huliGlass and then with the default surfaces, so the later and longer reply weighs on the
# default. Results land in $RESULTS/measure. The Android run (../../android/run.sh) runs it too,
# with its DEVICE and SAMPLER.
# Huli's own; see tools/huli/README.md.
set -uo pipefail
DEVICE="${DEVICE:-${UDID:-}}"
SAMPLER="${SAMPLER:-tools/huli/ios/sim/sample.mjs}"
: "${DEVICE:?}" "${MAESTRO:?}" "${RESULTS:?}"
M="$RESULTS/measure"
mkdir -p "$M"
DIR=tools/huli/ios/sim/measure
EACH="${MEASURE_SECONDS:-20}"
ALT="${MEASURE_ALT:-glass}"
OUT_JSON="$M/samples.jsonl"
: > "$OUT_JSON"
# The first flow on a loaded runner waited longer than Maestro's 2 minutes for its iOS driver.
export MAESTRO_DRIVER_STARTUP_TIMEOUT=300000
FLOW_LIMIT=300

# flow <file> <log name> [-e KEY=value ...]: tried again once when Maestro's driver did not start
# or the emulator dropped off adb for a moment, and stopped after FLOW_LIMIT seconds, as Maestro hung for good
# once a long streaming reply made the app's view tree take over a minute to read.
flow() {
  local file=$1 name=$2 try pid dog
  shift 2
  for try in 1 2; do
    "$MAESTRO" --device "$DEVICE" test --test-output-dir "$M/$name" "$@" "$DIR/$file.yaml" \
      > "$M/$name.log" 2>&1 &
    pid=$!
    (
      sleep "$FLOW_LIMIT"
      echo "flow $name stopped after $FLOW_LIMIT s" >> "$M/$name.log"
      pkill -f -- "$M/$name " 2> /dev/null
      kill "$pid" 2> /dev/null
    ) &
    dog=$!
    if wait "$pid"; then
      kill "$dog" 2> /dev/null
      return 0
    fi
    kill "$dog" 2> /dev/null
    grep -Eq "driver not ready|device offline|device '.*' not found" "$M/$name.log" || break
    command -v adb > /dev/null && timeout 60 adb wait-for-device
    sleep 5
  done
  echo "flow $name failed"
  grep -v '^\s*at ' "$M/$name.log" | tail -12
  return 1
}

# sample <scenario>: after Maestro has let go, the processes for EACH seconds.
sample() {
  sleep 4
  node "$SAMPLER" "$1" "$EACH" "$OUT_JSON"
}

# scrolled <scenario>: the same while the conversation is flung up and down.
scrolled() {
  flow scroll "scroll-$1" -e "SHOT=$1" > /dev/null &
  local scroll=$!
  sleep 5
  node "$SAMPLER" "$1" "$EACH" "$OUT_JSON"
  wait "$scroll"
}

G=(-e GLASS=default)

flow home idle "${G[@]}" -e SHOT=m01-idle && sample idle-home
flow start done-start "${G[@]}" -e "PROMPT=/basic-turn perfdone" -e SHOT=m02-finished-start &&
  flow done done "${G[@]}" -e SHOT=m02-finished && sample session-finished
flow start run "${G[@]}" -e "PROMPT=/long-turn perfrun" -e SHOT=m03-running &&
  sample session-running
# The same session with the other surfaces, where the app has time to spare for each frame.
flow open run-alt -e "GLASS=$ALT" -e WORD=perfrun -e "SHOT=m03-running-$ALT" &&
  sample "session-running-$ALT"
flow home home "${G[@]}" -e SHOT=m04-home-running && sample home-running
flow background background && sample background-running
flow open finished-busy "${G[@]}" -e WORD=perfdone -e SHOT=m05-finished-busy &&
  sample session-finished-busy

# A reply of about 500 bytes a second, as an agent writes, for some four minutes: the other
# surfaces first, then the default ones.
flow start stream -e "GLASS=$ALT" -e "PROMPT=/long-stream perfstream --size 120k --rate 5" \
  -e "SHOT=m06-streaming-$ALT" && sample "session-streaming-$ALT"
scrolled "session-streaming-scroll-$ALT"
flow open stream-default "${G[@]}" -e WORD=perfstream -e SHOT=m08-streaming &&
  sample session-streaming
scrolled session-streaming-scroll

# Nothing running any more: the long turn stopped from its session.
flow open rest "${G[@]}" -e WORD=perfrun -e SHOT=m10-stopping && flow stop stop
flow home idle-after "${G[@]}" -e SHOT=m11-idle-after && sample idle-home-after

# The session screen in the dark, with each surface, to see the solid one beside the glass.
if command -v xcrun > /dev/null; then
  xcrun simctl ui "$DEVICE" appearance dark
  flow open dark "${G[@]}" -e WORD=perfstream -e SHOT=m12-dark
  flow open dark-alt -e "GLASS=$ALT" -e WORD=perfstream -e "SHOT=m13-dark-$ALT"
  xcrun simctl ui "$DEVICE" appearance light
fi

node tools/huli/ios/sim/summary.mjs "$OUT_JSON" | tee "$M/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "## Phone app cost"; cat "$M/summary.md"; } >> "$GITHUB_STEP_SUMMARY"
exit 0
