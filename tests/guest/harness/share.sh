#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

src="${1:?usage: share.sh <src-dir>}"
rm -rf "$RUN/share"
mkdir -p "$RUN/share"
cp -r "$src"/. "$RUN/share/"
find "$RUN/share" -name '*.sh' -exec chmod +x {} +
echo "$RUN/share"
