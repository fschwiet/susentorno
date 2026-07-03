#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://get.pnpm.io/install.sh | bash -

echo "02-install-pnpm: pnpm installed. Open a new terminal before running vm/03-install-tools.sh, so pnpm is on PATH."
