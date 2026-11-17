# Runs a Maestro flow against the booted simulator, with the tools install-maestro.sh put in place.
# Usage: bash maestro.sh <flow.yaml> [more maestro args]
# Screenshots land in $SHOTS (/tmp/shots by default), named as the flow names them.
set -e
export JAVA_HOME="$HOME/.huli-tools/jdk/Contents/Home"
export MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
SIM=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
SHOTS="${SHOTS:-/tmp/shots}"
rm -rf "$SHOTS" && mkdir -p "$SHOTS"
exec "$HOME/.huli-tools/maestro/bin/maestro" --device "$SIM" test --test-output-dir "$SHOTS" "$@"
