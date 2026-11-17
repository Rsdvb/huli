set -e
export PATH="$HOME/.huli-tools/ruby/bin:$HOME/.huli-tools/node/bin:$HOME/.huli-tools/gems/bin:$PATH"
export GEM_HOME="$HOME/.huli-tools/gems"
export LANG=en_US.UTF-8
cd ~/huli
rm -rf mobile src && tar -xf /tmp/huli-src.tar && rm /tmp/huli-src.tar
cd mobile
npm ci --legacy-peer-deps --no-audit --no-fund > /tmp/huli-npm.log 2>&1 || { tail -20 /tmp/huli-npm.log; exit 1; }
BUILD=$(date -u +%Y%m%d%H%M)
node -e 'const fs=require("fs");const a=JSON.parse(fs.readFileSync("app.json","utf8"));a.expo.ios.buildNumber=process.argv[1];fs.writeFileSync("app.json",JSON.stringify(a,null,2))' "$BUILD"
echo "build number $BUILD"
CI=1 npx expo prebuild --platform ios --no-install --clean > /tmp/huli-prebuild.log 2>&1 || { tail -20 /tmp/huli-prebuild.log; exit 1; }
ls ios
