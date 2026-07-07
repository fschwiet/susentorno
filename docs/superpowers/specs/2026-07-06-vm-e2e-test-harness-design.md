# VM end-to-end test harness

2026-07-06

## Problem

The VM-side network setup (`templates/vm-shared/06-trust-ca.sh`, `07-setup-persistence.sh` and the dnsmasq/netplan/iptables templates behind it) has regressed more than once — both the DNS layer (dnsmasq stub, netplan resolver override) and the routing layer (DNAT rules, guarded host-only default route). Nothing tests this layer today: the integration tests cover only the host-side Envoy stack, and verifying the VM side means manually building a VMware VM, which is slow enough that it doesn't happen per change.

Containers cannot cover the regression classes involved (systemd boot ordering, netplan merge, DHCP-without-gateway behavior). A real Ubuntu guest can.

## Goal

Automated end-to-end tests that run the real, unmodified `06-trust-ca.sh` and `07-setup-persistence.sh` inside a QEMU/KVM Ubuntu guest, exercise the production lifecycle (NAT-phase setup → switch to host-only → reboot), and assert the full path: DNS stub → DNAT → Envoy → mock upstream.

## Platform decision

- The harness runs inside **WSL2** (QEMU/KVM via nested virtualization), an accepted hard dependency for this suite, the way Docker is for the integration tests.
- Firecracker-style microVMs were rejected: their value comes from minimal rootfs/no full device model, but the scripts under test need full systemd + netplan + a DHCP-configured NIC. Plain QEMU/KVM booting an Ubuntu cloud image is the right shape.
- Multipass and libvirt were rejected because they manage networking themselves; the gateway-less DHCP lease is the test subject and must be fully harness-controlled.

## Architecture

New code lives under `tests/vm/`, driven by `pnpm test:vm` (vitest, `vitest.vm.config.ts`). The suite is **not** part of the default `pnpm test` pipeline. Vitest runs on Windows like the rest of the suite; a thin TS helper executes harness commands through `wsl.exe`; the harness itself is bash inside WSL2.

### 1. Golden image builder (one-time, cached)

- Pinned Ubuntu cloud image + cloud-init NoCloud seed.
- Seed adds an ssh key, installs NetworkManager and sets it as the netplan renderer (mimicking the Ubuntu Desktop installer used in production), and pre-installs dnsmasq so `07`'s `apt-get install -y dnsmasq` is a fast no-op during tests.
- Test runs boot throwaway qcow2 overlays of the golden image (~15–20 s per boot); the golden image is never mutated.
- `--rebuild-image` escape hatch for bumping the Ubuntu release or changing the seed.

### 2. Network fixture

- A harness-owned Linux bridge; the harness runs its own dnsmasq as DHCP server in one of two modes:
  - **gateway mode** — lease includes router + DNS, NAT-masqueraded to the internet (mimics VMware NAT);
  - **host-only mode** — lease with no router option (mimics VMware host-only, the case the guarded default route exists for).
- Mode switch + guest reboot reproduces the production NAT → host-only transition.

### 3. Proxy fixture

- Reuses the existing integration-test fixture: `.configamatron` built from `tests/fixtures/credentials.json`, Envoy via docker compose on transient ports, mock upstream.
- Two `socat` forwarders publish Envoy at bridge-IP:80/443, so the bridge IP plays the Windows host and is the `<host-ip>` argument passed to `07-setup-persistence.sh`.

### 4. Guest lifecycle

- QEMU/KVM boots an overlay with a tap on the bridge.
- `templates/vm-shared/` is mounted in the guest as a **read-only** virtiofs/9p share, mimicking the read-only `/mnt/hgfs` share; scripts run unmodified from that mount.
- Helpers: start / stop / reboot / exec-over-ssh / collect-diagnostics.

## Test scenarios

S1 and S2 share one guest (the transition is the point); S3 boots a fresh overlay.

### S1 — Setup during NAT phase

Boot in gateway mode. Run `06-trust-ca.sh`, then `07-setup-persistence.sh <bridge-ip>` from the read-only share. Assert:

- Both scripts exit 0.
- A DNS query from the guest (e.g. `dig example.com`) returns the stub placeholder `203.0.113.1` — validating the netplan merge took effect through the NetworkManager renderer, not just that the file landed.
- The nat table contains the two DNAT rules (`:443`, `:80` → bridge IP).
- The DHCP default route is untouched (the guarded `ip route replace` must not fire while a route exists).

### S2 — Switch to host-only and reboot

Flip harness DHCP to host-only mode, reboot the guest. Assert after boot:

- `dnsmasq` and `iptables-rules@<bridge-ip>.service` are both active (boot-time persistence).
- The default route points at the bridge IP (the guard fired: no DHCP gateway).
- The resolver still answers via the stub.
- Curl matrix through the real Envoy: allow-listed `:443` succeeds (guest trusts the test CA from `06`), non-allow-listed `:443` fails/resets, allow-listed `:80` succeeds, non-allow-listed `:80` gets the 403.

### S3 — Fresh setup with no default route

Boot a fresh overlay directly in host-only mode and run `07`. Exercises the interface-discovery fallback branch (`07-setup-persistence.sh` lines 22–24). Assert the script succeeds and picks the right interface, the stub answers DNS, the DNAT rules are present, and the default route via the bridge IP was installed (unlike S1, no DHCP route exists, so here the guard must fire).

### Out of scope

- Scripts 01–05 (tool installs, GitHub auth — no network-regression surface).
- Re-run idempotence of `07` (it currently appends duplicate DNAT rules on re-run; harmless, and fixing it is a separate change).
- open-vm-tools / hgfs sharing (stays manual-only).

## Diagnostics, preflight, cleanup

**Failure diagnostics.** On any test failure the harness collects into a per-run, gitignored artifacts directory (path printed in the failure message): QEMU serial console log; guest-side `journalctl -u dnsmasq -u 'iptables-rules@*'`, `ip addr`, `ip route`, `iptables -t nat -S`, `resolvectl status`; and the Envoy container logs (the `CFGM|` access lines identify which path each request took). A curl-matrix failure should point at which hop broke.

**Preflight.** `pnpm test:vm` verifies: WSL2 distro reachable, `/dev/kvm` present, `qemu-system-x86_64` + `cloud-image-utils` + `socat` + `dnsmasq` installed, Docker usable from WSL. Any missing piece fails fast with the exact fix (`tests/vm/setup-wsl.sh` installs the packages; missing KVM points at nested-virtualization settings). No silent skips.

**Cleanup.** `trap`-based teardown regardless of outcome: kill QEMU, delete tap/bridge, stop harness dnsmasq and socat, compose down. Only the cloud image and golden image persist between runs. Same convention as the integration tests: the run may replace a running proxy container; re-run `configamatron run-proxy` to restore an environment.

## Documentation changes

- README verification pipeline gains a step 7 row: `pnpm test:vm`, required when touching `templates/vm-shared/` or proxy config.
- technical-notes.md gets a section on the harness, including the residual fidelity gap: a cloud image with NetworkManager as renderer approximates the Desktop installer's netplan profile but is not identical to a real VMware Desktop VM.
