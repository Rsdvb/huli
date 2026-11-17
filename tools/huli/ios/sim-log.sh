# Prints the simulator's recent log lines from Huli that look like trouble.
# Usage: [MINUTES=5] bash sim-log.sh
xcrun simctl spawn booted log show --last "${MINUTES:-5}m" --style compact \
  --predicate 'process == "Huli"' 2>/dev/null \
  | grep -iE 'keychain|secitem|error|exception|-34018|warn|fatal' | tail -${LINES:-20}
