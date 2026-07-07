# VM E2E Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automated e2e tests that run the real `06-trust-ca.sh` / `07-setup-persistence.sh` in a QEMU/KVM Ubuntu guest (inside WSL2) and assert the full DNS-stub → DNAT → Envoy → mock-upstream path across the NAT → host-only → reboot lifecycle.

**Architecture:** Vitest runs on Windows (`pnpm test:vm`); a TS helper shells into WSL2 as root via `wsl.exe -u root`. Bash harness scripts in `tests/vm/harness/` manage a golden Ubuntu cloud image (NetworkManager renderer, mimicking Desktop), a bridge with harness-controlled DHCP (gateway vs host-only mode), socat forwarders that publish the existing integration-test Envoy stack at the bridge IP, and QEMU guest lifecycle. Spec: `docs/superpowers/specs/2026-07-06-vm-e2e-test-harness-design.md`.

**Tech Stack:** QEMU/KVM, cloud-init (NoCloud), dnsmasq, socat, 9p share, vitest, execa, wsl.exe.

## Global Constraints

- All harness scripts run **as root inside WSL** (`wsl.exe -u root ...`); they must not use `sudo`. `lib.sh` enforces this.
- Harness state lives in `/root/.cache/configamatron-vmtest` (`$STATE`), overridable via `CFGM_VMTEST_STATE`. Runtime files (pids, leases, overlays, serial logs) in `$STATE/run` (`$RUN`).
- Bridge `cfgmbr0`, IP `10.213.87.1/24`, DHCP range `10.213.87.50`–`10.213.87.99`. The bridge IP is the `<host-ip>` passed to `07-setup-persistence.sh`.
- Golden image: Ubuntu 26.04 server cloud image, user `vmtest` (NOPASSWD sudo), packages `network-manager` + `dnsmasq` + `bind9-dnsutils`, netplan renderer NetworkManager, 9p share mounted at `/mnt/vm-shared` (ro, nofail).
- Envoy host ports: `18443`/`18080`/`19901` — the same constants as the integration suite; both suites share the compose project, never run them concurrently.
- `pnpm test:vm` is NOT part of `pnpm test`.
- Every new `.sh` file must be LF: add `tests/vm/harness/** text eol=lf` to `.gitattributes` (Task 1). Prettier (prettier-plugin-sh) formats `.sh` files — run `pnpm format` before each commit.
- Tests in `tests/vm/vm.test.ts` run sequentially in declaration order (vitest default within one file); S1 → S2 → S3 order is load-bearing.
- The scenarios come from the spec; do not add scenarios (re-run idempotence of 07 is explicitly out of scope).

---

### Task 1: WSL plumbing — exec helper, preflight, setup script, vitest config

**Files:**

- Modify: `.gitattributes`
- Create: `tests/vm/wsl.ts`
- Create: `tests/vm/harness/lib.sh`
- Create: `tests/vm/harness/preflight.sh`
- Create: `tests/vm/harness/setup-wsl.sh`
- Create: `tests/vm/globalSetup.ts`
- Create: `vitest.vm.config.ts`
- Modify: `package.json` (scripts)

**Interfaces:**

- Produces: `wslExec(script: string, opts?: { reject?: boolean })` — runs a bash command string as root in WSL, returns execa result (`stdout`, `stderr`, `exitCode`, `all`). `wslPath(winPath: string): Promise<string>` — Windows → WSL path. `harness(script: string, ...args: string[])` — runs `tests/vm/harness/<script>` as root with argv passed verbatim (no shell-quoting layer — args survive as-is into the script's `$1..$n`). All later tasks consume these.
- Produces: `lib.sh` variables for all later harness scripts: `STATE`, `RUN`, `BRIDGE=cfgmbr0`, `BRIDGE_IP=10.213.87.1`, `SUBNET=10.213.87.0/24`, `DHCP_RANGE`, `GOLDEN`, `BASE_IMAGE`, `BASE_IMAGE_URL`, `SSH_KEY`, `SSH_OPTS` (array), `GUEST_USER=vmtest`.

- [ ] **Step 1: Add line-ending rule**

Append to `.gitattributes`:

```
tests/vm/harness/** text eol=lf
```

- [ ] **Step 2: Write `tests/vm/wsl.ts`**

```ts
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const harnessWinDir = fileURLToPath(new URL('./harness', import.meta.url));
let harnessDir: string | undefined;

const wslArgs = ['-u', 'root', '-e'];

// The harness manages bridges, taps, and QEMU, and WSL's default user cannot
// sudo non-interactively — so everything WSL-side runs as root.
export function wslExec(script: string, opts: { reject?: boolean } = {}) {
  return execa('wsl.exe', [...wslArgs, 'bash', '-c', script], {
    reject: opts.reject ?? true,
    all: true,
  });
}

export async function wslPath(winPath: string): Promise<string> {
  const { stdout } = await execa('wsl.exe', [
    ...wslArgs,
    'wslpath',
    '-a',
    winPath.replace(/\\/g, '/'),
  ]);
  return stdout.trim();
}

// Passes args as real argv entries (execa → wsl.exe → bash), so no layer
// re-parses quotes. A guest command like `curl -w '%{http_code}' ...` arrives
// at guest.sh as a single $3 and is only ever parsed by the guest's shell.
export async function harness(script: string, ...args: string[]) {
  harnessDir ??= await wslPath(harnessWinDir);
  return execa('wsl.exe', [...wslArgs, 'bash', `${harnessDir}/${script}`, ...args], { all: true });
}
```

- [ ] **Step 3: Write `tests/vm/harness/lib.sh`**

```bash
#!/usr/bin/env bash
# Shared constants for the VM e2e harness. Source from sibling scripts.
if [ "$(id -u)" != 0 ]; then
  echo "harness scripts must run as root (invoke via: wsl.exe -u root ...)" >&2
  exit 1
fi

STATE="${CFGM_VMTEST_STATE:-/root/.cache/configamatron-vmtest}"
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
```

- [ ] **Step 4: Write `tests/vm/harness/preflight.sh`**

```bash
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
```

(The spec's "Docker usable from WSL" check is deliberately not here: compose runs from Windows via the shared proxy fixture, so what WSL actually needs is *reachability* of the published Envoy ports — asserted by the guard in `vm.test.ts`'s `beforeAll` (Task 6) with an actionable error.)

- [ ] **Step 5: Write `tests/vm/harness/setup-wsl.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils dnsmasq socat curl openssh-client

# The harness runs its own dnsmasq bound to the test bridge; the system
# service must not sit on port 53.
systemctl disable --now dnsmasq 2> /dev/null || true

echo "setup-wsl: done"
```

- [ ] **Step 6: Write `tests/vm/globalSetup.ts`**

```ts
import { harness } from './wsl';

export default async function setup() {
  try {
    await harness('preflight.sh');
  } catch (error) {
    const all = (error as { all?: string }).all ?? String(error);
    throw new Error(`VM e2e preflight failed:\n${all}`);
  }
  // No-op when the golden image already exists; first run downloads the cloud
  // image and boots it once for cloud-init (~10-20 min).
  console.log('vm-e2e: ensuring golden image (first run takes 10-20 minutes)...');
  await harness('build-image.sh');
}
```

(`build-image.sh` arrives in Task 2; until then `pnpm test:vm` fails at this line — expected.)

- [ ] **Step 7: Write `vitest.vm.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/vm/**/*.test.ts'],
    globalSetup: ['tests/vm/globalSetup.ts'],
    // Guest boots and reboots are slow; the beforeAll brings up the entire
    // stack (proxy, bridge, guest) and can take several minutes.
    testTimeout: 300_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
  },
});
```

- [ ] **Step 8: Add the script to `package.json`**

In `"scripts"`, after `"test:integration"`:

```json
"test:vm": "pnpm build && vitest run --config vitest.vm.config.ts",
```

- [ ] **Step 9: Verify preflight behavior**

Run: `pnpm format && pnpm lint && pnpm typecheck`
Expected: PASS (fix any findings).

Run: `pnpm test:vm`
Expected — one of, depending on the machine:

- deps not yet installed: fails with `preflight: <cmd> not installed in WSL` + the fix line;
- deps installed: fails with `bash: .../build-image.sh: No such file or directory` (Task 2 provides it).

Both are correct at this point. If preflight complained, run `wsl.exe -u root bash "$(wslpath -a <repo>)/tests/vm/harness/setup-wsl.sh"` once and re-check that preflight then passes.

- [ ] **Step 10: Commit**

```bash
git add .gitattributes tests/vm vitest.vm.config.ts package.json
git commit -m "feat: vm e2e scaffolding - wsl helper, preflight, test:vm target"
```

---

### Task 2: Golden image builder

**Files:**

- Create: `tests/vm/harness/seed/user-data`
- Create: `tests/vm/harness/seed/meta-data`
- Create: `tests/vm/harness/build-image.sh`

**Interfaces:**

- Consumes: `lib.sh` constants.
- Produces: `$GOLDEN` (`/root/.cache/configamatron-vmtest/golden.qcow2`) — an Ubuntu image with: user `vmtest` + `$SSH_KEY.pub` authorized + NOPASSWD sudo; NetworkManager as netplan renderer; dnsmasq pre-installed but disabled; `bind9-dnsutils` (for `dig`); fstab line mounting the 9p tag `vmshared` at `/mnt/vm-shared` (ro, nofail). Idempotent: exits 0 immediately if `$GOLDEN` exists; `--force` rebuilds (this is the spec's "rebuild image" escape hatch).

- [ ] **Step 1: Write `tests/vm/harness/seed/user-data`** (`__SSH_PUBKEY__` is substituted by build-image.sh)

```yaml
#cloud-config
hostname: cfgm-vmtest
users:
  - name: vmtest
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - __SSH_PUBKEY__
packages:
  - network-manager
  - dnsmasq
  - bind9-dnsutils
write_files:
  # Mimic the Ubuntu Desktop installer: netplan renders through NetworkManager,
  # and the base profile carries only the renderer (no per-device config), so
  # 07's 60-dns-override.yaml merges exactly as it does in production.
  - path: /etc/netplan/01-network-manager-all.yaml
    permissions: '0600'
    content: |
      network:
        version: 2
        renderer: NetworkManager
  # Stop cloud-init regenerating its systemd-networkd profile on later boots.
  - path: /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
    content: |
      network: {config: disabled}
runcmd:
  - rm -f /etc/netplan/50-cloud-init.yaml
  # dnsmasq is pre-installed so 07's `apt-get install -y dnsmasq` is an offline
  # no-op, but production has it absent-therefore-disabled before 07 runs.
  - systemctl disable --now dnsmasq || true
  - mkdir -p /mnt/vm-shared
  - printf 'vmshared /mnt/vm-shared 9p trans=virtio,ro,nofail,version=9p2000.L 0 0\n' >> /etc/fstab
```

- [ ] **Step 2: Write `tests/vm/harness/seed/meta-data`**

```yaml
instance-id: cfgm-vmtest
local-hostname: cfgm-vmtest
```

- [ ] **Step 3: Write `tests/vm/harness/build-image.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib.sh"

if [ -f "$GOLDEN" ] && [ "${1:-}" != "--force" ]; then
  echo "build-image: $GOLDEN exists (pass --force to rebuild)"
  exit 0
fi

[ -f "$SSH_KEY" ] || ssh-keygen -t ed25519 -f "$SSH_KEY" -N '' -q
pubkey="$(cat "$SSH_KEY.pub")"

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
# records. That is expected (production installs dnsmasq the same way).
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
echo "build-image: golden image ready at $GOLDEN"
```

- [ ] **Step 4: Run the build**

Run (from repo root, PowerShell): `wsl.exe -u root bash "$(wsl.exe -e wslpath -a (Get-Location).Path)/tests/vm/harness/build-image.sh"`
Expected: download progress, `waiting for ssh`, `waiting for cloud-init`, then `build-image: golden image ready at /root/.cache/configamatron-vmtest/golden.qcow2`. First run takes 10–20 minutes.

Run it again.
Expected: `build-image: ... exists (pass --force to rebuild)` immediately.

If ssh never comes up, read `/root/.cache/configamatron-vmtest/run/build-serial.log` in WSL for the boot console.

- [ ] **Step 5: Commit**

```bash
pnpm format
git add tests/vm/harness
git commit -m "feat: vm e2e golden image builder (cloud image + NetworkManager renderer)"
```

---

### Task 3: Network fixture — bridge, two-mode DHCP, forwarders, cleanup

**Files:**

- Create: `tests/vm/harness/net.sh`
- Create: `tests/vm/harness/forward.sh`
- Create: `tests/vm/harness/cleanup.sh`

**Interfaces:**

- Consumes: `lib.sh` constants.
- Produces:
  - `net.sh up` — idempotent bridge + NAT masquerade; `net.sh dhcp gateway|hostonly` — (re)starts harness dnsmasq on the bridge in the given mode; `net.sh down` — removes everything.
  - `forward.sh up <target-host> <http-port> <https-port>` — socat listeners on `$BRIDGE_IP:80/443` → target; `forward.sh down`.
  - `cleanup.sh` — kills every pid in `$RUN/*.pid` (guests, dnsmasq, socat), deletes `tap-*` links, the MASQUERADE rule and the bridge. Safe to run when nothing is up. Tests run it before setup (stale state from a killed run) and at teardown.

- [ ] **Step 1: Write `tests/vm/harness/net.sh`**

```bash
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
      echo "dhcp-range=$DHCP_RANGE,12h"
      echo "dhcp-leasefile=$RUN/dnsmasq.leases"
      echo "pid-file=$RUN/dnsmasq.pid"
      if [ "$mode" = gateway ]; then
        # Mimic VMware NAT: the lease carries a router and DNS (this host),
        # and MASQUERADE (net.sh up) provides real internet for apt etc.
        echo "port=53"
        echo "dhcp-option=option:router,$BRIDGE_IP"
        echo "dhcp-option=option:dns-server,$BRIDGE_IP"
      else
        # Mimic VMware host-only: DHCP answers but the lease carries no
        # router and no DNS (empty dhcp-option = suppress the option).
        echo "port=0"
        echo "dhcp-option=option:router"
        echo "dhcp-option=option:dns-server"
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
```

- [ ] **Step 2: Write `tests/vm/harness/forward.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

case "${1:?usage: forward.sh up <target-host> <http-port> <https-port> | down}" in
  up)
    target="${2:?target host}"
    http_port="${3:?http port}"
    https_port="${4:?https port}"
    # setsid + full detach: the socat processes must outlive this wsl.exe call.
    setsid socat "TCP-LISTEN:80,bind=$BRIDGE_IP,fork,reuseaddr" "TCP:$target:$http_port" \
      < /dev/null > /dev/null 2>&1 &
    echo $! > "$RUN/socat-80.pid"
    setsid socat "TCP-LISTEN:443,bind=$BRIDGE_IP,fork,reuseaddr" "TCP:$target:$https_port" \
      < /dev/null > /dev/null 2>&1 &
    echo $! > "$RUN/socat-443.pid"
    echo "forward: $BRIDGE_IP:80 -> $target:$http_port, $BRIDGE_IP:443 -> $target:$https_port"
    ;;
  down)
    for port in 80 443; do
      if [ -f "$RUN/socat-$port.pid" ]; then
        kill "$(cat "$RUN/socat-$port.pid")" 2> /dev/null || true
        rm -f "$RUN/socat-$port.pid"
      fi
    done
    echo "forward: down"
    ;;
esac
```

- [ ] **Step 3: Write `tests/vm/harness/cleanup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# Kill everything the harness may have left behind (guests, dnsmasq, socat).
for pidfile in "$RUN"/*.pid; do
  [ -f "$pidfile" ] || continue
  kill "$(cat "$pidfile")" 2> /dev/null || true
  rm -f "$pidfile"
done

for tap in $(ip -o link show | awk -F': ' '{print $2}' | grep '^tap-' || true); do
  ip link del "${tap%%@*}" 2> /dev/null || true
done

iptables -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2> /dev/null || true
ip link del "$BRIDGE" 2> /dev/null || true
echo "cleanup: done"
```

- [ ] **Step 4: Verify by hand** (all from PowerShell at repo root; `$h = wsl.exe -e wslpath -a (Get-Location).Path` then `wsl.exe -u root bash "$h/tests/vm/harness/<script>"`)

1. `net.sh up` → `net: cfgmbr0 up at 10.213.87.1`
2. `net.sh dhcp gateway` → `net: dhcp mode gateway`; `wsl.exe -u root bash -c "ss -ulpn | grep 10.213.87.1"` shows dnsmasq on :53 and :67 (hostonly mode would show :67 only)
3. `forward.sh up 127.0.0.1 18080 18443` → `forward: ...`; `wsl.exe -u root bash -c "ss -tlpn | grep 10.213.87.1"` shows socat on :80 and :443
4. `cleanup.sh` → `cleanup: done`; re-run `cleanup.sh` → still `cleanup: done` (idempotent)

- [ ] **Step 5: Commit**

```bash
pnpm format
git add tests/vm/harness
git commit -m "feat: vm e2e network fixture - bridge, dual-mode dhcp, forwarders, cleanup"
```

---

### Task 4: Guest lifecycle — start/stop/exec/reboot/diag + share staging

**Files:**

- Create: `tests/vm/harness/guest.sh`
- Create: `tests/vm/harness/share.sh`

**Interfaces:**

- Consumes: `lib.sh`, golden image from Task 2, bridge from Task 3.
- Produces:
  - `guest.sh start <name> --share <wsl-dir>` — boots a fresh overlay of `$GOLDEN` on a tap with a stable per-name MAC; shares `<wsl-dir>` read-only via 9p tag `vmshared`.
  - `guest.sh wait-ssh <name>` / `ip <name>` / `exec <name> <command-string>` / `reboot <name>` / `stop <name>` / `diag <name> <outdir>`.
  - `share.sh <src-dir>` — copies `<src-dir>` into `$RUN/share` (chmod +x on `*.sh`) and prints the share path on stdout. Tests pass a `wslpath` of the repo's `.configamatron/vm-shared`.

- [ ] **Step 1: Write `tests/vm/harness/guest.sh`**

```bash
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
    gexec "$name" 'sudo journalctl -u dnsmasq -u "iptables-rules@*" --no-pager' > "$out/journal.txt" 2>&1 || true
    gexec "$name" 'ip addr; echo; ip -4 route; echo; sudo iptables -t nat -S; echo; resolvectl status' > "$out/network.txt" 2>&1 || true
    echo "guest $name: diagnostics in $out"
    ;;
esac
```

- [ ] **Step 2: Write `tests/vm/harness/share.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

src="${1:?usage: share.sh <src-dir>}"
rm -rf "$RUN/share"
mkdir -p "$RUN/share"
cp -r "$src"/. "$RUN/share/"
chmod +x "$RUN/share"/*.sh
echo "$RUN/share"
```

- [ ] **Step 3: Verify a full boot cycle by hand** (PowerShell, repo root; `$h` as in Task 3)

```powershell
wsl.exe -u root bash "$h/tests/vm/harness/net.sh" up
wsl.exe -u root bash "$h/tests/vm/harness/net.sh" dhcp gateway
wsl.exe -u root bash "$h/tests/vm/harness/share.sh" "$h/templates/vm-shared"
wsl.exe -u root bash "$h/tests/vm/harness/guest.sh" start smoke --share /root/.cache/configamatron-vmtest/run/share
wsl.exe -u root bash "$h/tests/vm/harness/guest.sh" wait-ssh smoke
wsl.exe -u root bash "$h/tests/vm/harness/guest.sh" exec smoke "ls /mnt/vm-shared && touch /mnt/vm-shared/x ; nmcli -t -f DEVICE,STATE device"
wsl.exe -u root bash "$h/tests/vm/harness/guest.sh" stop smoke
wsl.exe -u root bash "$h/tests/vm/harness/cleanup.sh"
```

Expected: `wait-ssh` reports an IP in 10.213.87.50–99; `exec` lists the numbered scripts, the `touch` fails with a read-only-filesystem error (share is ro), and nmcli shows the ethernet device `connected` (NetworkManager owns it — renderer fidelity check). `stop`/`cleanup` succeed.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add tests/vm/harness
git commit -m "feat: vm e2e guest lifecycle and share staging"
```

---

### Task 5: Extract the reusable proxy-stack fixture

**Files:**

- Create: `tests/proxyStack.ts`
- Modify: `tests/integration/proxy.test.ts` (use the fixture; delete the moved code)
- Reference (unchanged): `tests/integration/mockUpstream.ts`, `tests/integration/runProxy.test.ts`

**Interfaces:**

- Produces (consumed by both `tests/integration/proxy.test.ts` and `tests/vm/vm.test.ts`):

```ts
export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const ADMIN_PORT = 19901;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
export const REAL_AUTH = 'Bearer sandbox-test-real-token-12345';
export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
}
export async function startProxyStack(): Promise<ProxyStack>;
export async function stopProxyStack(stack: ProxyStack): Promise<void>;
```

- [ ] **Step 1: Write `tests/proxyStack.ts`**

Move the current `beforeAll` body of `tests/integration/proxy.test.ts` (lines 27–99: `waitForAdminReady`, env rebuild, `init`/`generate-ca`/`build-envoy-config` CLI calls, SDS secret write, `docker compose up`, and the `afterAll` teardown) into this module verbatim, shaped as:

```ts
import { execa } from 'execa';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  startMockUpstream,
  stopMockUpstream,
  type MockUpstream,
} from './integration/mockUpstream';

export const HTTPS_PORT = 18443;
export const HTTP_PORT = 18080;
export const ADMIN_PORT = 19901;
export const PLACEHOLDER_AUTH = 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER';
export const REAL_AUTH = 'Bearer sandbox-test-real-token-12345';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'dist', 'cli.js');
const allowlistFixture = join(repoRoot, 'tests', 'integration', 'fixtures', 'allowlist.txt');
const credentialsFixture = join(repoRoot, 'tests', 'fixtures', 'credentials.json');
const envRoot = join(repoRoot, '.configamatron');

export interface ProxyStack {
  mockUpstream: MockUpstream;
  caCertPem: string;
  proxyDir: string;
  composeEnv: NodeJS.ProcessEnv;
}

async function waitForAdminReady(timeoutMs: number): Promise<void> {
  // ... moved verbatim from proxy.test.ts lines 27-46
}

export async function startProxyStack(): Promise<ProxyStack> {
  const mockUpstream = await startMockUpstream();
  const proxyDir = join(envRoot, 'proxy');
  const composeEnv = {
    ...process.env,
    ENVOY_HTTPS_PORT: String(HTTPS_PORT),
    ENVOY_HTTP_PORT: String(HTTP_PORT),
    ENVOY_ADMIN_PORT: String(ADMIN_PORT),
  };

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  rmSync(envRoot, { recursive: true, force: true });
  // ... init, generate-ca, build-envoy-config with --upstream-override, SDS
  // secret write, `docker compose up -d` with composeEnv — moved verbatim
  // from proxy.test.ts lines 53-92.
  await waitForAdminReady(30000);
  const caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
  return { mockUpstream, caCertPem, proxyDir, composeEnv };
}

export async function stopProxyStack(stack: ProxyStack): Promise<void> {
  await execa('docker', ['compose', 'down'], { cwd: stack.proxyDir });
  await stopMockUpstream(stack.mockUpstream);
}
```

("moved verbatim" = cut the exact statements from proxy.test.ts; no behavior change. The two `// ...` comments above are move instructions for this step, not code to keep.)

- [ ] **Step 2: Refactor `tests/integration/proxy.test.ts`**

Replace the constant declarations, `waitForAdminReady`, and the `beforeAll`/`afterAll` bodies with:

```ts
import {
  startProxyStack,
  stopProxyStack,
  HTTPS_PORT,
  HTTP_PORT,
  PLACEHOLDER_AUTH,
  REAL_AUTH,
  type ProxyStack,
} from '../proxyStack';

let stack: ProxyStack;
let mockUpstream: MockUpstream;
let caCertPem: string;

beforeAll(async () => {
  stack = await startProxyStack();
  mockUpstream = stack.mockUpstream;
  caCertPem = stack.caCertPem;
}, 90000);

afterAll(async () => {
  await stopProxyStack(stack);
}, 30000);
```

Keep `mockUpstream`/`caCertPem` as local aliases so the test bodies are untouched. The `readEnvoyLogs` helper keeps working via `stack.proxyDir` and `stack.composeEnv` — update its `cwd`/`env` to use them. Delete the now-unused imports (`writeFileSync`, `mkdirSync`, `rmSync`, port constants, fixture paths).

- [ ] **Step 3: Verify no regression**

Run: `pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test:integration`
Expected: all integration tests PASS, exactly as before the refactor.

- [ ] **Step 4: Commit**

```bash
git add tests/proxyStack.ts tests/integration/proxy.test.ts
git commit -m "refactor: extract reusable proxy-stack fixture from integration tests"
```

---

### Task 6: vm.test.ts — wiring + Scenario S1 (setup during NAT phase)

**Files:**

- Create: `tests/vm/vm.test.ts`

**Interfaces:**

- Consumes: `harness`/`wslExec`/`wslPath` (Task 1), harness scripts (Tasks 2–4), `startProxyStack`/`stopProxyStack`/`HTTP_PORT`/`HTTPS_PORT`/`PLACEHOLDER_AUTH` (Task 5).
- Produces: `guest(name, cmd)` helper and the shared `beforeAll`/`afterAll` that S2/S3 (Tasks 7–8) extend.

- [ ] **Step 1: Write `tests/vm/vm.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness, wslExec, wslPath } from './wsl';
import { startProxyStack, stopProxyStack, HTTP_PORT, HTTPS_PORT, type ProxyStack } from '../proxyStack';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const BRIDGE_IP = '10.213.87.1';
// Docker Desktop's WSL integration republishes container ports on localhost
// inside integrated distros. If that is off, point this at the Windows host
// IP as seen from WSL instead.
const ENVOY_HOST = process.env.CFGM_VMTEST_ENVOY_HOST ?? '127.0.0.1';
const artifactsDir = join(
  repoRoot,
  'test-results',
  'vm',
  new Date().toISOString().replace(/[:.]/g, '-'),
);

let stack: ProxyStack;
let shareDir: string;

function guest(name: string, cmd: string) {
  return harness('guest.sh', 'exec', name, cmd);
}

beforeAll(async () => {
  await harness('cleanup.sh'); // stale bridges/guests from a killed run
  stack = await startProxyStack();

  await harness('net.sh', 'up');
  await harness('net.sh', 'dhcp', 'gateway');
  await harness('forward.sh', 'up', ENVOY_HOST, String(HTTP_PORT), String(HTTPS_PORT));

  // Guard: the bridge IP must reach Envoy through the forwarders before we
  // involve a guest. 403 = Envoy's port-80 default deny answered us.
  const guard = await wslExec(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: not-allow-listed.example.com' http://${BRIDGE_IP}:80/`,
    { reject: false },
  );
  if (guard.stdout.trim() !== '403') {
    throw new Error(
      `WSL cannot reach Envoy at ${ENVOY_HOST}:${HTTP_PORT} via ${BRIDGE_IP}:80 (got '${guard.all}'). ` +
        `Enable Docker Desktop WSL integration, or set CFGM_VMTEST_ENVOY_HOST to the Windows host IP.`,
    );
  }

  // Stage the environment's real vm-shared folder (numbered scripts + the
  // generate-ca cert.pem) as the guest's read-only share, mimicking hgfs.
  const wslVmShared = await wslPath(join(repoRoot, '.configamatron', 'vm-shared'));
  shareDir = (await harness('share.sh', wslVmShared)).stdout.trim();

  await harness('guest.sh', 'start', 'g1', '--share', shareDir);
  await harness('guest.sh', 'wait-ssh', 'g1');
}, 1_200_000);

afterAll(async () => {
  mkdirSync(artifactsDir, { recursive: true });
  const wslArtifacts = await wslPath(artifactsDir);
  for (const name of ['g1', 'g2']) {
    await harness('guest.sh', 'diag', name, `${wslArtifacts}/${name}`).catch(() => {});
  }
  console.log(`vm-e2e: diagnostics collected in ${artifactsDir}`);
  await harness('cleanup.sh').catch(() => {});
  if (stack) await stopProxyStack(stack);
}, 600_000);

describe('S1: setup during NAT phase', () => {
  it('runs 06-trust-ca.sh and 07-setup-persistence.sh from the read-only share', async () => {
    await guest('g1', 'bash /mnt/vm-shared/06-trust-ca.sh');
    const { stdout } = await guest('g1', `bash /mnt/vm-shared/07-setup-persistence.sh ${BRIDGE_IP}`);
    expect(stdout).toContain('07-setup-persistence:');
  });

  it('dnsmasq stub answers every name with the placeholder IP', async () => {
    const { stdout } = await guest('g1', 'dig +short example.com @127.0.0.1');
    expect(stdout.trim()).toBe('203.0.113.1');
  });

  it('netplan override registered the stub as the interface resolver', async () => {
    // In gateway mode the DHCP DNS is still present too, so assert
    // containment; host-only S2 asserts the stub is the effective resolver.
    const { stdout } = await guest('g1', 'resolvectl dns');
    expect(stdout).toContain('127.0.0.1');
  });

  it('installed both DNAT rules', async () => {
    const { stdout } = await guest('g1', 'sudo iptables -t nat -S OUTPUT');
    expect(stdout).toContain(`--dport 443 -j DNAT --to-destination ${BRIDGE_IP}:443`);
    expect(stdout).toContain(`--dport 80 -j DNAT --to-destination ${BRIDGE_IP}:80`);
  });

  it('left the DHCP default route untouched', async () => {
    const { stdout } = await guest('g1', 'ip -4 route show default');
    // Still DHCP's route — the guarded `ip route replace` must not have fired.
    expect(stdout).toContain('proto dhcp');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test:vm`
Expected: globalSetup passes preflight and finds the golden image; S1's five tests PASS. First useful full-harness run — expect ~3–5 minutes.

If the `netplan apply` inside 07 drops the ssh session (NM briefly bounces the connection), the symptom is test 1 failing with an ssh disconnect while the serial log shows the script completed. Mitigation if (and only if) observed: run the script detached and poll —
`guest('g1', 'setsid bash /mnt/vm-shared/07-setup-persistence.sh <ip> > /tmp/07.log 2>&1 < /dev/null & echo started')` then poll `guest('g1', 'grep -q "07-setup-persistence:" /tmp/07.log && echo done || echo pending')` until `done` (timeout 120 s).

- [ ] **Step 3: Verify diagnostics land**

After the run, check `test-results/vm/<timestamp>/g1/` contains `serial.log`, `journal.txt`, `network.txt`.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add tests/vm/vm.test.ts
git commit -m "test: vm e2e S1 - NAT-phase setup of 06/07 against real Envoy stack"
```

---

### Task 7: Scenario S2 — switch to host-only, reboot, curl matrix

**Files:**

- Modify: `tests/vm/vm.test.ts` (append a `describe` block after S1)

**Interfaces:**

- Consumes: `guest()`, `harness()`, `BRIDGE_IP`, `PLACEHOLDER_AUTH` (add it to the existing `../proxyStack` import).

- [ ] **Step 1: Append the S2 describe block**

```ts
describe('S2: switch to host-only and reboot', () => {
  it('reboots into host-only mode with both units active', async () => {
    await harness('net.sh', 'dhcp', 'hostonly');
    await harness('guest.sh', 'reboot', 'g1');

    expect((await guest('g1', 'systemctl is-active dnsmasq')).stdout.trim()).toBe('active');
    expect(
      (await guest('g1', `systemctl is-active iptables-rules@${BRIDGE_IP}.service`)).stdout.trim(),
    ).toBe('active');
  }, 600_000);

  it('installed the guarded host-only default route', async () => {
    const { stdout } = await guest('g1', 'ip -4 route show default');
    expect(stdout).toContain(`default via ${BRIDGE_IP}`);
    expect(stdout).not.toContain('proto dhcp'); // static, installed by the unit
  });

  it('stub is the effective resolver after reboot', async () => {
    const { stdout } = await guest('g1', 'dig +short example.com');
    expect(stdout.trim()).toBe('203.0.113.1');
  });

  it('terminated :443 host works and the CA is trusted', async () => {
    // TLS handshake succeeding at all proves 06's CA install; the gate then
    // 403s a missing placeholder header and 200s a valid one.
    const noAuth = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 https://api.anthropic.com/`,
    );
    expect(noAuth.stdout.trim()).toBe('403');

    const withAuth = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H 'Authorization: ${PLACEHOLDER_AUTH}' https://api.anthropic.com/`,
    );
    expect(withAuth.stdout.trim()).toBe('200');
  });

  it('passthrough :443 host works end-to-end', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 30 https://pypi.org/simple/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('allow-listed :80 host works', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/`,
    );
    expect(Number(stdout.trim())).toBeLessThan(400);
  });

  it('non-allow-listed :443 connection is dropped', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null --max-time 20 https://blocked.example.com/ ; echo exit=$?`,
    );
    expect(stdout).toContain('exit=');
    expect(stdout.trim()).not.toBe('exit=0');
  });

  it('non-allow-listed :80 gets the default-deny 403', async () => {
    const { stdout } = await guest(
      'g1',
      `curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://blocked.example.com/`,
    );
    expect(stdout.trim()).toBe('403');
  });

  it('06 configured NODE_EXTRA_CA_CERTS for login shells', async () => {
    const { stdout } = await guest('g1', `bash -lc 'echo $NODE_EXTRA_CA_CERTS'`);
    expect(stdout).toContain('sbx-sandbox-proxy-ca.crt');
  });
});
```

Import note: extend the existing `../proxyStack` import with `PLACEHOLDER_AUTH`.

Quoting note: guest command strings travel as single argv entries end-to-end (execa → wsl.exe → bash argv → ssh) and are parsed only by the guest's remote shell — so `'%{http_code}'`, `$?`, and `$NODE_EXTRA_CA_CERTS` above are correct as written; the inner single quotes in the `bash -lc` line deliberately defer expansion to the login shell.

- [ ] **Step 2: Run it**

Run: `pnpm test:vm`
Expected: S1 + S2 all PASS. The passthrough and :80 tests need internet from the Docker engine (same requirement as the integration suite).

- [ ] **Step 3: Commit**

```bash
pnpm format
git add tests/vm/vm.test.ts
git commit -m "test: vm e2e S2 - host-only reboot persistence and curl matrix"
```

---

### Task 8: Scenario S3 — fresh setup with no default route

**Files:**

- Modify: `tests/vm/vm.test.ts` (append after S2)

**Interfaces:**

- Consumes: `guest()`, `harness()`, `shareDir`, `BRIDGE_IP`. Relies on S2 having left DHCP in host-only mode; `afterAll` already diagnoses/stops `g2`.

- [ ] **Step 1: Append the S3 describe block**

```ts
describe('S3: fresh setup with no default route', () => {
  it('07 discovers the interface via the fallback and installs the route', async () => {
    // DHCP is still in host-only mode (S2), so g2 boots gateway-less: the
    // interface-discovery fallback branch in 07 is the only path that works.
    await harness('guest.sh', 'start', 'g2', '--share', shareDir);
    await harness('guest.sh', 'wait-ssh', 'g2');

    const before = await guest('g2', 'ip -4 route show default');
    expect(before.stdout.trim()).toBe(''); // precondition: no default route

    const run = await guest('g2', `bash /mnt/vm-shared/07-setup-persistence.sh ${BRIDGE_IP}`);
    expect(run.stdout).toContain('07-setup-persistence:');

    const after = await guest('g2', 'ip -4 route show default');
    expect(after.stdout).toContain(`default via ${BRIDGE_IP}`);

    const nat = await guest('g2', 'sudo iptables -t nat -S OUTPUT');
    expect(nat.stdout).toContain(`--dport 443 -j DNAT --to-destination ${BRIDGE_IP}:443`);
    expect(nat.stdout).toContain(`--dport 80 -j DNAT --to-destination ${BRIDGE_IP}:80`);

    const dns = await guest('g2', 'dig +short example.com @127.0.0.1');
    expect(dns.stdout.trim()).toBe('203.0.113.1');
  }, 900_000);
});
```

- [ ] **Step 2: Run the whole suite**

Run: `pnpm test:vm`
Expected: S1 + S2 + S3 all PASS; `test-results/vm/<timestamp>/` contains `g1/` and `g2/` diagnostics.

- [ ] **Step 3: Commit**

```bash
pnpm format
git add tests/vm/vm.test.ts
git commit -m "test: vm e2e S3 - fresh host-only setup exercises iface-discovery fallback"
```

---

### Task 9: Documentation

**Files:**

- Modify: `README.md` (Verification Pipeline table)
- Modify: `technical-notes.md` (Testing section)

**Interfaces:** none (prose only).

- [ ] **Step 1: Extend the README pipeline table**

After the `pnpm test:e2e` row (step 6), the table currently implies integration tests via `pnpm test`; add:

```markdown
| 7 | `pnpm test:vm` | VM e2e tests (QEMU in WSL2) — required when touching `templates/vm-shared/` or proxy config; not part of `pnpm test` |
```

- [ ] **Step 2: Extend technical-notes.md**

Append to the `## Testing` section:

```markdown
`pnpm test:vm` (not part of `pnpm test`) boots a QEMU/KVM Ubuntu guest inside WSL2 and runs the real `06-trust-ca.sh` and `07-setup-persistence.sh` against the same Envoy stack the integration tests use, published at a harness-owned bridge IP. It covers the NAT-phase setup, the switch to gateway-less DHCP plus reboot (boot-time persistence of dnsmasq, the DNAT rules, and the guarded host-only default route), and a fresh gateway-less setup (interface-discovery fallback). See `docs/superpowers/specs/2026-07-06-vm-e2e-test-harness-design.md`.

One-time WSL setup: `wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/vm/<timestamp>/`.

Residual fidelity gaps vs. a real VMware VM: the guest is an Ubuntu *cloud* image with NetworkManager installed as the netplan renderer (approximating, not equaling, the Desktop installer's profile); the NAT→host-only switch keeps one subnet (production changes subnets); and open-vm-tools/hgfs sharing remains manual-only.
```

- [ ] **Step 3: Full verification**

Run: `pnpm test` (full pipeline) and then `pnpm test:vm`.
Expected: everything PASSES.

- [ ] **Step 4: Commit**

```bash
pnpm format
git add README.md technical-notes.md
git commit -m "docs: document the VM e2e test harness"
```
