#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://get.pnpm.io/install.sh | bash -

sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0

echo "02-install-pnpm: pnpm installed. Open a new terminal before running vm/03-install-tools.sh, so pnpm is on PATH."
