# Prints what the frame meter of Huli's developer screens kept on a simulator (FrameMeter.tsx).
# Usage: [SIM=booted] bash frames.sh [--clear]
set -e
DATA=$(xcrun simctl get_app_container "${SIM:-booted}" io.github.rsdvb.huli data)
FILE="$DATA/Documents/huli-frames.json"
if [ "$1" = "--clear" ]; then rm -f "$FILE"; exit 0; fi
cat "$FILE"
