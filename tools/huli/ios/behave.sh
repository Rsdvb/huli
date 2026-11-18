# Runs a flow once per list engine named and copies its screenshots to /tmp/lt-behave/<flow>.
# Usage: [SIM=<udid>] bash behave.sh <flow.yaml> flat flash legend
set -e
export JAVA_HOME="$HOME/.huli-tools/jdk/Contents/Home"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
SIM="${SIM:-84867C9F-5244-4F4E-9470-592E9BE81521}"
FLOW="$1"; shift
OUT=/tmp/lt-behave/$(basename "$FLOW" .yaml); mkdir -p "$OUT"
for LIST in "$@"; do
  D=/tmp/lt-shots/b-$LIST-$(date +%H%M%S)
  "$HOME/.huli-tools/maestro/bin/maestro" --device "$SIM" test --test-output-dir "$D" -e LIST="$LIST" "$HOME/huli-lt/flows/$FLOW" 2>&1 | grep -E 'FAILED|COMPLETED$' | tail -2
  find "$D" -path '*takeScreenshot*' -name '*.png' -exec cp {} "$OUT/" \;
done
ls "$OUT"