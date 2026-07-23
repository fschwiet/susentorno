#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

dnsmasq_stop() {
  if [ -f "$RUN/dnsmasq.pid" ]; then
    kill "$(cat "$RUN/dnsmasq.pid")" 2> /dev/null || true
    rm -f "$RUN/dnsmasq.pid"
  fi
}

case "${1:?usage: net.sh up|down|dhcp <gateway|hostonly>}" in
  up)
    ip link add "$BRIDGE" type bridge 2> /dev/null || true
    ip addr replace "$BRIDGE_IP/24" dev "$BRIDGE"
    ip link set "$BRIDGE" up
    sysctl -qw net.ipv4.ip_forward=1
    iptables -t nat -C POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2> /dev/null \
      || iptables -t nat -A POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE
    echo "net: $BRIDGE up at $BRIDGE_IP"
    ;;
  dhcp)
    mode="${2:?usage: net.sh dhcp <gateway|hostonly>}"
    dnsmasq_stop
    {
      echo "interface=$BRIDGE"
      echo "bind-interfaces"
      # WSL2's DNS-tunneling feature aliases 10.255.255.254 onto lo and holds
      # port 53 there; dnsmasq implicitly binds loopback addresses too unless
      # excluded, which collides with that address.
      echo "except-interface=lo"
      echo "dhcp-range=$DHCP_RANGE,12h"
      echo "dhcp-leasefile=$RUN/dnsmasq.leases"
      echo "pid-file=$RUN/dnsmasq.pid"
      if [ "$mode" = gateway ]; then
        # Gateway mode: the lease carries a router and DNS (this host),
        # and MASQUERADE (net.sh up) provides real internet for apt etc.
        echo "port=53"
        echo "dhcp-option=option:router,$BRIDGE_IP"
        echo "dhcp-option=option:dns-server,$BRIDGE_IP"
      else
        # Mirror run-proxy's host-side DHCP and DNS behaviour on the isolated
        # network: the host is router and resolver, and every name resolves to
        # it. `port=53` is load-bearing -- this branch used to set `port=0`
        # (DHCP only, DNS disabled) because the guest ran its own in-guest stub
        # on 127.0.0.1. That stub is gone, so disabling DNS here would advertise
        # a resolver that answers nothing and every lookup in the guest would
        # fail. No upstream is configured, so the catch-all below is the only
        # answer this ever gives -- exactly like the host responder.
        echo "port=53"
        # No upstream, ever. The host responder has none either: it answers A
        # with its own address and NOERROR/no-answer for every other qtype.
        # Without this, dnsmasq forwards whatever the catch-all below does not
        # cover (notably AAAA) to WSL's real resolver, so an isolated guest gets
        # real answers -- both a fidelity gap and a source of confusing results.
        echo "no-resolv"
        echo "dhcp-option=option:router,$BRIDGE_IP"
        echo "dhcp-option=option:dns-server,$BRIDGE_IP"
        echo "address=/#/$BRIDGE_IP"
      fi
    } > "$RUN/dnsmasq.conf"
    dnsmasq --conf-file="$RUN/dnsmasq.conf"
    echo "net: dhcp mode $mode"
    ;;
  down)
    dnsmasq_stop
    iptables -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2> /dev/null || true
    ip link del "$BRIDGE" 2> /dev/null || true
    echo "net: down"
    ;;
esac
