# Unpacks the app's source into a work folder, installs its packages and generates the iOS project.
# Usage: [WORK=~/huli] [SRC=/tmp/huli-src.tar] bash prepare-ios.sh
# A second WORK (e.g. ~/huli-phone with APP_DIR=~/huli-phone/mobile for install-dev.sh) lets a
# phone build run beside a simulator one without either wiping the other's files.
set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
WORK="${WORK:-$HOME/huli}"
SRC="${SRC:-/tmp/huli-src.tar}"
LOGS="${WORK}/logs"
mkdir -p "$WORK" "$LOGS"
cd "$WORK"
rm -rf mobile src && tar -xf "$SRC" && rm "$SRC"
cd mobile
npm ci --legacy-peer-deps --no-audit --no-fund > "$LOGS/npm.log" 2>&1 || { tail -20 "$LOGS/npm.log"; exit 1; }
BUILD=$(date -u +%Y%m%d%H%M)
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("app.json","utf8"));a.expo.ios.buildNumber=process.argv[1];fs.writeFileSync("app.json",JSON.stringify(a,null,2))' "$BUILD"
echo "build number $BUILD"
CI=1 npx expo prebuild --platform ios --no-install --clean > "$LOGS/prebuild.log" 2>&1 || { tail -20 "$LOGS/prebuild.log"; exit 1; }
ls ios
