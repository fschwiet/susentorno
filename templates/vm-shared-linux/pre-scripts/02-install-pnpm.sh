#!/usr/bin/env bash
set -euo pipefail

# revisit this- use pipx?
# Error was: error: externally-managed-environment
#
# pip install PyYAML # Used by codex to validate YAML


curl -fsSL https://get.pnpm.io/install.sh | bash -

echo "02-install-pnpm: pnpm installed. Open a new terminal before running vm/03-install-tools.sh, so pnpm is on PATH."
