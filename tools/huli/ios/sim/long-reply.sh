# A long finished reply opened afresh, for run.sh when FLOWS names `long-reply`: such a reply once
# left the session screen blank with the app at over a core for minutes. A session gets the fake
# agent's reply of REPLY_SIZE (120k), streamed while the app is closed again, so it is finished
# when the app opens it from the session list. After the tap nothing reads the app's view tree:
# the screen is captured, as often as simctl can for the first seconds, while the app's processes
# are sampled (sample.mjs), then while the conversation is flung up and down through the reply.
# The app, launched with -huliDev, adds to huli-frames.json when its list shows the rows
# (`conversation-shown`, maybe of the thread it kept from before) and when it has laid out the
# long reply (`long-reply-drawn`); both and each capture count from Maestro's tap. Results land
# in $RESULTS/long-reply. Huli's own; see tools/huli/README.md.
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
node tools/huli/ios/sim/sample.mjs long-reply-open 20 "$OUT_JSON" &
SAMPLER=$!
# The screen as often as simctl captures it for the first seconds, then now and then, each with
# when its capture began, to count from the tap in open.yaml's commands.json.
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
shot() {
  local at
  at=$(now_ms)
  xcrun simctl io "$UDID" screenshot "$L/$1.png" > /dev/null 2>&1 && echo "$1 $at" >> "$L/shots.txt"
}
: > "$L/shots.txt"
first=$(date +%s)
n=0
while [ $(($(date +%s) - first)) -lt 4 ]; do
  n=$((n + 1))
  shot "early-$n"
done
for at in 8 15; do
  sleep $((at - ($(date +%s) - first))) 2> /dev/null || true
  shot "after-${at}s"
done
wait "$SAMPLER"
node tools/huli/ios/sim/sample.mjs long-reply-open-later 20 "$OUT_JSON"
shot after-45s

# Flung through the reply, whose parts mount as they come into view.
flow tools/huli/ios/sim/measure/scroll.yaml scroll -e SHOT=r04-flung > /dev/null &
SCROLL=$!
sleep 5
node tools/huli/ios/sim/sample.mjs long-reply-flung 20 "$OUT_JSON"
wait "$SCROLL"
shot after-flung

DATA=$(xcrun simctl get_app_container "$UDID" io.github.rsdvb.huli data 2> /dev/null || true)
COMMANDS=$(find "$L/open" -name commands.json | head -1)
{
  node -e '
    const fs = require("fs")
    const [frames, shots, commands, opening] = process.argv.slice(1)
    const read = (file, empty) => { try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return empty } }
    const tapped = read(commands, []).filter((c) => c.command.tapOnElement).at(-1)?.metadata
    const tap = tapped ? tapped.timestamp + tapped.duration : null
    const since = (at) => (tap === null ? "?" : `${((at - tap) / 1000).toFixed(1)} s`)
    const mine = read(frames, []).filter((r) => r.at >= Number(opening) * 1000)
    for (const label of ["conversation-shown", "long-reply-drawn"]) {
      const r = mine.find((x) => x.label === label)
      console.log(r ? `${label}: ${since(r.at)} after the tap, ${r.ms} ms after the list mounted, ${r.rows} rows` : `${label}: never`)
    }
    const list = fs.existsSync(shots) ? fs.readFileSync(shots, "utf8").trim().split("\n") : []
    console.log("screens: " + list.map((line) => { const [name, at] = line.split(" "); return `${name} ${since(Number(at))}` }).join(", "))
  ' "$DATA/Documents/huli-frames.json" "$L/shots.txt" "$COMMANDS" "$opening"
  echo
  node tools/huli/ios/sim/summary.mjs "$OUT_JSON"
} | tee "$L/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && { echo "## Long reply opened afresh"; cat "$L/summary.md"; } >> "$GITHUB_STEP_SUMMARY"
echo "the reply streamed for $((opening - started)) s before its session was opened"
exit 0
