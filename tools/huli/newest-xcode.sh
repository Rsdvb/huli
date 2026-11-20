#!/usr/bin/env bash
# Huli: selects the newest Xcode on one of GitHub's macOS runners, whose default may be older.
# App Store Connect takes uploads built with the newest major SDK only (ITMS-90725: iOS 27 from
# April 2027). Prints the version it chose. Huli's own; see tools/huli/README.md.
set -euo pipefail
newest="$(ls -d /Applications/Xcode_*.app 2>/dev/null | grep -E 'Xcode_[0-9.]+\.app$' | sort -V | tail -1 || true)"
if [ -n "$newest" ]; then
  sudo xcode-select -s "$newest/Contents/Developer"
fi
# Read in full first: cutting xcodebuild's output short makes it abort on the closed pipe.
version="$(xcodebuild -version)"
sed -n 1p <<<"$version"
echo "iOS SDK $(xcrun --sdk iphoneos --show-sdk-version)"
