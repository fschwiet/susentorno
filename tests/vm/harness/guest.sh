#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

mac_for() { printf '52:54:00:%s' "$(echo -n "$1" | md5sum | sed 's/^\(..\)\(..\)\(..\).*/\1:\2:\3/')"; }

ip_for() {
  local mac
  mac="$(mac_for "$1")"
  awk -v mac="$mac" '$2 == mac {ip = $3} END {print ip}' "$RUN/dnsmasq.leases" 2> /dev/null
}

gexec() {
  local gip
  gip="$(ip_for "$1")"
  if [ -z "$gip" ]; then
    echo "guest $1: no DHCP lease yet" >&2
    return 1
  fi
  shift
  ssh "${SSH_OPTS[@]}" "$GUEST_USER@$gip" "$@"
}

cmd="${1:?usage: guest.sh <start|stop|ip|wait-ssh|exec|reboot|diag> <name> ...}"
name="${2:?guest name required}"
tap="tap-$name"

case "$cmd" in
  start)
    [ "${3:-}" = "--share" ] || {
      echo "usage: guest.sh start <name> --share <dir>" >&2
      exit 1
    }
    share="${4:?share dir required}"
    overlay="$RUN/$name.qcow2"
    rm -f "$overlay"
    qemu-img create -q -f qcow2 -F qcow2 -b "$GOLDEN" "$overlay"
    ip tuntap add dev "$tap" mode tap 2> /dev/null || true
    ip link set "$tap" master "$BRIDGE" up
    qemu-system-x86_64 -enable-kvm -m 2048 -smp 2 -cpu host \
      -drive "file=$overlay,if=virtio" \
      -netdev "tap,id=n0,ifname=$tap,script=no,downscript=no" \
      -device "virtio-net-pci,netdev=n0,mac=$(mac_for "$name")" \
      -virtfs "local,path=$share,mount_tag=vmshared,security_model=none,readonly=on" \
      -display none -serial "file:$RUN/$name-serial.log" \
      -pidfile "$RUN/$name.pid" -daemonize
    echo "guest $name: started (mac $(mac_for "$name"))"
    ;;
  wait-ssh)
    for _ in $(seq 1 60); do
      if gexec "$name" true 2> /dev/null; then
        echo "guest $name: ssh ready at $(ip_for "$name")"
        exit 0
      fi
      sleep 5
    done
    echo "guest $name: ssh never became ready; see $RUN/$name-serial.log" >&2
    exit 1
    ;;
  ip)
    ip_for "$name"
    ;;
  exec)
    shift 2
    gexec "$name" "$@"
    ;;
  reboot)
    gexec "$name" sudo reboot || true
    # Give sshd time to actually stop so wait-ssh can't hit the old boot.
    sleep 10
    exec "$0" wait-ssh "$name"
    ;;
  stop)
    if [ -f "$RUN/$name.pid" ]; then
      kill "$(cat "$RUN/$name.pid")" 2> /dev/null || true
      rm -f "$RUN/$name.pid"
    fi
    ip link del "$tap" 2> /dev/null || true
    rm -f "$RUN/$name.qcow2"
    echo "guest $name: stopped"
    ;;
  diag)
    out="${3:?usage: guest.sh diag <name> <outdir>}"
    mkdir -p "$out"
    cp "$RUN/$name-serial.log" "$out/serial.log" 2> /dev/null || true
    gexec "$name" 'sudo journalctl -u dnsmasq -u configamatron-egress.service --no-pager' > "$out/journal.txt" 2>&1 || true
    gexec "$name" 'ip addr; echo; ip -4 route; echo; sudo iptables -t nat -S; echo; resolvectl status' > "$out/network.txt" 2>&1 || true
    echo "guest $name: diagnostics in $out"
    ;;
esac
