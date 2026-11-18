#!/bin/sh
# Points this clone's git hooks at .githooks/ (the gitleaks pre-commit hook). Run once after cloning.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
chmod 755 "$ROOT/.githooks/pre-commit"
git -C "$ROOT" config core.hooksPath .githooks
echo "Hooks installed: every commit is scanned by gitleaks first."
