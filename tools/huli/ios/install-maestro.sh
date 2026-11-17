# Installs Maestro, which taps, types and screenshots the app in the simulator, with the Java it
# needs, under ~/.huli-tools so nothing system-wide changes. Run once on the build Mac.
# Undo: rm -rf ~/.huli-tools/jdk ~/.huli-tools/maestro ~/.maestro
set -e
TOOLS="$HOME/.huli-tools"
mkdir -p "$TOOLS"
cd "$TOOLS"

if [ ! -x "$TOOLS/jdk/Contents/Home/bin/java" ]; then
  echo "== java"
  curl -fsSL -o jdk.tar.gz \
    "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
  rm -rf jdk && mkdir jdk
  tar -xzf jdk.tar.gz -C jdk --strip-components 1
  rm jdk.tar.gz
fi
export JAVA_HOME="$TOOLS/jdk/Contents/Home"

if [ ! -x "$TOOLS/maestro/bin/maestro" ]; then
  echo "== maestro"
  curl -fsSL -o maestro.zip "https://github.com/mobile-dev-inc/maestro/releases/latest/download/maestro.zip"
  rm -rf maestro
  unzip -q maestro.zip
  rm maestro.zip
fi
"$TOOLS/maestro/bin/maestro" --version
