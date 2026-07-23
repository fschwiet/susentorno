#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib.sh"

[ -f "$SSH_KEY" ] || ssh-keygen -t ed25519 -f "$SSH_KEY" -N '' -q
pubkey="$(cat "$SSH_KEY.pub")"

# Everything below is BAKED INTO the image at build time, so a cached image built
# from different inputs is stale. An existence check alone cannot see that: it
# silently reuses an image whose cloud-init config no longer matches the tree,
# which surfaces as guests behaving like an older revision of the harness rather
# than as an obvious failure. Stamp the inputs and rebuild when they move.
stamp="$(
  {
    cat "$script_dir/seed/user-data" "$script_dir/seed/meta-data"
    printf '%s\n%s\n' "$pubkey" "$BASE_IMAGE_URL"
  } | sha256sum | awk '{print $1}'
)"

if [ -f "$GOLDEN" ] && [ "${1:-}" != "--force" ]; then
  if [ "$(cat "$GOLDEN.stamp" 2> /dev/null || true)" = "$stamp" ]; then
    echo "build-image: $GOLDEN is up to date (pass --force to rebuild)"
    exit 0
  fi
  echo "build-image: seed inputs changed since $GOLDEN was built -- rebuilding"
fi

# Drop the stamp before rebuilding: if the build dies part-way, the next run must
# see a missing/stale stamp and try again rather than trust a half-built image.
rm -f "$GOLDEN.stamp"

if [ ! -f "$BASE_IMAGE" ]; then
  echo "build-image: downloading $BASE_IMAGE_URL"
  curl -fL --progress-bar "$BASE_IMAGE_URL" -o "$BASE_IMAGE.tmp"
  mv "$BASE_IMAGE.tmp" "$BASE_IMAGE"
fi

rm -f "$GOLDEN"
cp "$BASE_IMAGE" "$GOLDEN"
qemu-img resize -q "$GOLDEN" 16G

sed "s|__SSH_PUBKEY__|${pubkey}|" "$script_dir/seed/user-data" > "$RUN/user-data"
cp "$script_dir/seed/meta-data" "$RUN/meta-data"
cloud-localds "$RUN/seed.iso" "$RUN/user-data" "$RUN/meta-data"

# The build boot uses QEMU user-mode (slirp) networking: built-in DHCP with a
# gateway plus internet access for the package installs. Test boots use the
# bridge instead (guest.sh).
qemu-system-x86_64 -enable-kvm -m 2048 -smp 2 -cpu host \
  -drive "file=$GOLDEN,if=virtio" \
  -drive "file=$RUN/seed.iso,if=virtio,format=raw,readonly=on" \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2299-:22 \
  -device virtio-net-pci,netdev=n0 \
  -display none -serial "file:$RUN/build-serial.log" \
  -pidfile "$RUN/build.pid" -daemonize

sshb() { ssh "${SSH_OPTS[@]}" -p 2299 "$GUEST_USER@127.0.0.1" "$@"; }

echo "build-image: waiting for ssh"
ok=0
for _ in $(seq 1 120); do
  if sshb true 2> /dev/null; then
    ok=1
    break
  fi
  sleep 5
done
[ "$ok" = 1 ] || {
  echo "build-image: guest never became reachable; see $RUN/build-serial.log" >&2
  exit 1
}

echo "build-image: waiting for cloud-init"
# Exit 2 = done with recoverable errors; the pre-installed dnsmasq's default
# config loses the port-53 race against systemd-resolved, which cloud-init
# records. That is expected and harmless: dnsmasq is present only so the
# "no in-guest dnsmasq" assertion tests something, and it is disabled straight
# after. Nothing in the guest serves DNS any more.
sshb cloud-init status --wait || [ "$?" = 2 ]

sshb sudo poweroff || true
pid="$(cat "$RUN/build.pid" 2> /dev/null || true)"
if [ -n "$pid" ]; then
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2> /dev/null || break
    sleep 2
  done
  kill "$pid" 2> /dev/null || true
fi
rm -f "$RUN/build.pid"

# Written only now, after a clean build, so the stamp can never vouch for an image
# that failed to finish.
printf '%s\n' "$stamp" > "$GOLDEN.stamp"
echo "build-image: golden image ready at $GOLDEN"
