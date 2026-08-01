#!/usr/bin/env bash
# Shared constants for the guest test harness. Source from sibling scripts.
if [ "$(id -u)" != 0 ]; then
  echo "harness scripts must run as root (invoke via: wsl.exe -u root ...)" >&2
  exit 1
fi

STATE="${CFGM_VMTEST_STATE:-/root/.cache/susentorno-vmtest}"
RUN="$STATE/run"
BRIDGE=cfgmbr0
BRIDGE_IP=10.213.87.1
SUBNET=10.213.87.0/24
DHCP_RANGE=10.213.87.50,10.213.87.99
GOLDEN="$STATE/golden.qcow2"
BASE_IMAGE_URL="https://cloud-images.ubuntu.com/releases/26.04/release/ubuntu-26.04-server-cloudimg-amd64.img"
BASE_IMAGE="$STATE/base-ubuntu-26.04.img"
SSH_KEY="$STATE/id_ed25519"
SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o LogLevel=ERROR)
GUEST_USER=vmtest

mkdir -p "$RUN"
