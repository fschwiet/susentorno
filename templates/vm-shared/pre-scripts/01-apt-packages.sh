#!/usr/bin/env bash
set -euo pipefail

sudo apt update
sudo apt upgrade -y
sudo apt install -y curl git build-essential okular jq gh

echo "01-apt-packages: system packages installed"
