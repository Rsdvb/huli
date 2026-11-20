# A long finished reply opened afresh, for run.sh when FLOWS names `long-reply`: such a reply once
# left the session screen blank with the app at over a core for minutes. A session gets the fake
# agent's reply of REPLY_SIZE (120k), streamed while the app is closed again, so it is finished
# when the app opens it from the session list. After the tap nothing reads the app's view tree:
# the screen is captured at moments after it while the app's processes are sampled (sample.mjs),
# then while the conversation is flung up and down through the reply. The app, launched with
# -huliDev, adds `conversation-shown` to huli-frames.json once its list shows the rows: the time
# from the list's mount. Results land in $RESULTS/long-reply. Huli's own; see tools/huli/README.md.
set -uo pipefail
: "${UDID:?}" "${MAESTRO:?}" "${RESULTS:?}"
L="$RESULTS/long-reply"
mkdir -p "$L"
DIR=tools/huli/ios/sim/long-reply
SIZE="${REPLY_SIZE:-120k}"
OUT_JSON="$L/samples.jsonl"
: > "$OUT_JSON"
export MAESTRO_DRIVER_STARTUP_TIMEOUT=300000
FLOW_LIMIT=300

# flow <file> <log name> [-e KEY=value ...]: stopped after FLOW_LIMIT seconds should Maestro hang.
flow() {
  local file=$1 name=$2 pid dog
  shift 2
  "$MAESTRO" --device "$UDID" test --test-output-dir "$L/$name" "$@" "$file" > "$L/$name.log" 2>&1 &
  pid=$!
  (
    sleep "$FLOW_LIMIT"
    echo "flow $name stopped after $FLOW_LIMIT s" >> "$L/$name.log"
    kill "$pid" 2> /dev/null
  ) &
  dog=$!
  if wait "$pid"; then
    kill "$dog" 2> /dev/null
    return 0
  fi
  kill "$dog" 2> /dev/null
  echo "flow $name failed"
  grep -v '^\s*at ' "$L/$name.log" | tail -12
  return 1
}

# About 2.5 KB a second, so the reply is short while Maestro still reads the screen.
flow "$DIR/start.yaml" start -e "PROMPT=/long-stream perflong --size $SIZE --rate 25" || exit 0
flow "$DIR/home.yaml" home -e SHOT=r01-home-streaming
started=$(date +%s)
bytes=$(node -e 'const s = process.argv[1]; console.log(parseFloat(s) * (/k$/i.test(s) ? 1024 : 1))' "$SIZE")
wait_s=$((bytes / 2500 + 25))
echo "waiting ${wait_s} s for the reply to finish"
sleep "$wait_s"

opening=$(date +%s)
flow "$DIR/open.yaml" open -e WORD=perflong || exit 0
# The moments below count from the end of the flow, a second or two after its tap.
tapped=$(date +%s)
node tools/huli/ios/sim/sample.mjs long-reply-open 20 "$OUT_JSON" &
SAMPLER=$!
for at in 1 2 4 8 15; do
  sleep $((at - ($(date +%s) - tapped))) 2> /dev/null || true
  xcrun simctl io "$UDID" screenshot "$L/after-${at}s.png" > /dev/null 2>&1
done
wait "$SAMPLER"
node tools/huli/ios/sim/sample.mjs long-reply-open-later 20 "$OUT_JSON"
xcrun simctl io "$UDID" screenshot "$L/after-45s.png" > /dev/null 2>&1

# Flung through the reply, whose parts mount as they come into view.
flow tools/huli/ios/sim/measure/scroll.yaml scroll -e SHOT=r04-flung > /dev/null &
SCROLL=$!
sleep 5
node tools/huli/ios/sim/sample.mjs long-reply-flung 20 "$OUT_JSON"
wait "$SCROLL"
xcrun simctl io "$UDID" screenshot "$L/after-flung.png" > /dev/null 2>&1

DATA=$(xcrun simctl get_app_container "$UDID" io.github.rsdvb.huli data 2> /dev/null || true)
SHOWN=$(node -e '
  const all = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  const shown = all.filter((r) => r.label === "conversation-shown" && r.at >= Number(process.argv[2]) * 1000)
  console.log(shown.length ? shown.map((r) => `${r.ms} ms (${r.rows} rows)`).join(", ") : "never")
' "$DATA/Documents/huli-frames.json" "$opening" 2> /dev/null || echo "never")
{
  echo "Conversation shown, from its list's mount: $SHOWN"
  echo
  node tools/huli/ios/sim/summary.mjs "$OUT_JSON"
} | tee "$L/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "## Long reply opened afresh"; cat "$L/summary.md"; } >> "$GITHUB_STEP_SUMMARY"
echo "the reply streamed for $((opening - started)) s before its session was opened"
exit 0
