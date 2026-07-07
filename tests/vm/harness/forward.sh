#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# The forwarders must outlive this wsl.exe call, but WSL tears down the
# invoking session's processes when the call exits — even setsid'd background
# jobs. dnsmasq and QEMU survive by self-daemonizing; socat cannot, so each
# forwarder runs as a transient systemd service (parented to PID 1, outside
# the doomed session). Bonus: `systemctl stop` kills the whole unit cgroup,
# including socat's per-connection fork children, which a pidfile kill leaks.
fwd_stop() {
  systemctl stop cfgm-fwd-80.service cfgm-fwd-443.service 2> /dev/null || true
}

case "${1:?usage: forward.sh up <target-host> <http-port> <https-port> | down}" in
  up)
    target="${2:?target host}"
    http_port="${3:?http port}"
    https_port="${4:?https port}"
    fwd_stop
    systemd-run --collect --unit=cfgm-fwd-80 \
      socat "TCP-LISTEN:80,bind=$BRIDGE_IP,fork,reuseaddr" "TCP:$target:$http_port"
    systemd-run --collect --unit=cfgm-fwd-443 \
      socat "TCP-LISTEN:443,bind=$BRIDGE_IP,fork,reuseaddr" "TCP:$target:$https_port"
    echo "forward: $BRIDGE_IP:80 -> $target:$http_port, $BRIDGE_IP:443 -> $target:$https_port"
    ;;
  down)
    fwd_stop
    echo "forward: down"
    ;;
esac
