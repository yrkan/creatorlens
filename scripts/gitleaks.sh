#!/bin/sh
# Runs a pinned gitleaks with this repository's rules (.gitleaks.toml). The binary is downloaded once into .tools/
# (ignored by git) from the official release and checked against the release's SHA-256 before it runs.
#   sh scripts/gitleaks.sh git      scan the whole git history (CI)
#   sh scripts/gitleaks.sh staged   scan the staged changes (the pre-commit hook)
set -eu

VERSION=8.30.1
ROOT=$(cd "$(dirname "$0")/.." && pwd)

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ASSET=darwin_arm64; SUM=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  Darwin-x86_64) ASSET=darwin_x64; SUM=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  Linux-x86_64) ASSET=linux_x64; SUM=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *) echo "No pinned gitleaks for $(uname -s)-$(uname -m)." >&2; exit 2 ;;
esac

DIR="$ROOT/.tools/gitleaks-$VERSION"
BIN="$DIR/gitleaks"
if [ ! -x "$BIN" ]; then
  mkdir -p "$DIR"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  URL="https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_${ASSET}.tar.gz"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/gitleaks.tar.gz" "$URL"
  echo "$SUM  $TMP/gitleaks.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xzf "$TMP/gitleaks.tar.gz" -C "$DIR" gitleaks
  chmod 755 "$BIN"
fi

MODE=${1:-git}
case "$MODE" in
  git) exec "$BIN" git --config "$ROOT/.gitleaks.toml" --redact --verbose --no-banner "$ROOT" ;;
  staged) exec "$BIN" git --config "$ROOT/.gitleaks.toml" --pre-commit --staged --redact --no-banner "$ROOT" ;;
  *) echo "Usage: sh scripts/gitleaks.sh git|staged" >&2; exit 2 ;;
esac
