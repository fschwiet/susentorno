#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils dnsmasq socat curl openssh-client

# The harness runs its own dnsmasq bound to the test bridge; the system
# service must not sit on port 53.
systemctl disable --now dnsmasq 2> /dev/null || true

echo "setup-wsl: done"
