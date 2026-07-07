#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

fail() {
  echo "preflight: $1" >&2
  echo "  fix: $2" >&2
  exit 1
}

[ -e /dev/kvm ] || fail "/dev/kvm missing (KVM unavailable in WSL2)" \
  "Windows 11 WSL2 enables nested virtualization by default; check %UserProfile%\\.wslconfig has no nestedVirtualization=false, then run: wsl --shutdown"

for cmd in qemu-system-x86_64 qemu-img cloud-localds dnsmasq socat curl ssh ssh-keygen; do
  command -v "$cmd" > /dev/null || fail "$cmd not installed in WSL" \
    "run once: wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh"
done

echo "preflight: ok"
