#!/bin/bash
set -euo pipefail

client="$(cd "$(dirname "$0")/.." && pwd)"
backend="$client/../harmony-backend"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "请在 Mac 上运行此脚本。" >&2
  exit 1
fi
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 14)) { console.error("需要 Node.js 22.14 或更高版本"); process.exit(1); }'

stage="$(mktemp -d "${TMPDIR:-/tmp}/harmony-mac.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir "$stage/harmony" "$stage/harmony-backend"
cp -R "$client"/package*.json "$client/desktop" "$client/web" "$stage/harmony/"
cp "$backend"/package*.json "$stage/harmony-backend/"
npm --prefix "$stage/harmony-backend" ci --no-audit --no-fund
npm --prefix "$stage/harmony" ci --no-audit --no-fund

cd "$stage/harmony"
rm desktop/main-account.cjs
# Install the local backend entry and its dependencies as real files inside the app.
local_backend=node_modules/harmony-backend
test -L "$local_backend"
unlink "$local_backend"
mkdir -p "$local_backend/src"
cp -R "$stage/harmony-backend/node_modules" "$local_backend/"
cp "$backend/package.json" "$local_backend/"
cp -R "$backend/src/"{app-core.js,local-app.js,db.js,security.js,playlist-transfer.js,providers} "$local_backend/src/"
node - "$local_backend/package.json" <<'JS'
const fs = require('node:fs');
const manifest = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
pkg.main = pkg.exports['./local'];
pkg.exports = { './local': pkg.main };
delete pkg.scripts;
fs.writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n');
JS

args=(--mac dmg --arm64 --x64 --config.directories.output=../output --publish never)
if [ -n "${HARMONY_ELECTRON_DIST:-}" ]; then
  args+=("--config.electronDist=$HARMONY_ELECTRON_DIST")
fi
./node_modules/.bin/electron-builder "${args[@]}"

version="$(node -p "require('./package.json').version")"
destination="${HARMONY_MAC_OUTPUT:-$client/release/$version}"
mkdir -p "$destination"
for arch in arm64 x64; do
  name="Harmony-$version-macOS-$arch.dmg"
  hdiutil verify "$stage/output/$name" >/dev/null 2>&1
done
for arch in arm64 x64; do
  name="Harmony-$version-macOS-$arch.dmg"
  mv "$stage/output/$name" "$destination/$name"
done
echo "Mac 安装包位于 $destination"
