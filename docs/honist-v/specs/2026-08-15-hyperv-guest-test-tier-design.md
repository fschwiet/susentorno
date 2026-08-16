# The Hyper-V guest test tier

## Purpose

The `guest` tier boots a QEMU/KVM Ubuntu guest inside WSL2 ([ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md)), with the harness's own `dnsmasq` and `socat` standing in for the production gateway forwarder, DNS responder, and DHCP server. This design replaces that harness with real Hyper-V VMs on a real Internal switch served by the real `run-hosting`, so the tier exercises the production Windows network path instead of substituting for it.

The claim the tier makes afterwards: **a real Ubuntu guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, reaches exactly the destinations the network policy permits and nothing else.**

The concrete, measurable outcome is one edit. `tests/proxyStack.ts:157` loses `--no-forward` and gains `--isolation-name test`. That single flag currently disables the gateway's non-loopback listener, the DNS responder, and the DHCP server together (`src/commands/runHosting.ts:213`, `:222`, `:253`). Dropping it turns [ADR-0014](../../adr/0014-host-side-dns-and-dhcp.md)'s "covered only by manual Hyper-V checkpoints" and [ADR-0011](../../adr/0011-loopback-publish-with-node-forwarder.md)'s forwarder into real automated coverage.

**Substitutions go from three to one.** Afterwards the only thing the tier fakes is `gh`, shadowed at `/usr/local/bin/gh` so `post-scripts/01-auth-config.sh` does not need a real GitHub token. Everything else is production code on production mechanisms.

```
BEFORE                                    AFTER
┌──────── Windows ────────┐               ┌──────────── Windows ────────────┐
│ run-hosting --no-forward│               │ run-hosting --isolation-name test│
│   gateway :18080/:18443 │               │   gateway  :80/:443             │
│   (loopback only)       │               │   DNS      :53   ← real         │
│   ✗ DNS  ✗ DHCP         │               │   DHCP     :67   ← real         │
└───────────┬─────────────┘               └────────────┬────────────────────┘
            │                                          │ vEthernet
   ┌────────▼────────┐ WSL2                            │ (susentorno-test-internal)
   │ socat  + dnsmasq│ ← the three substitutions  ┌────▼──────────────────┐
   │ bridge 10.213…  │                            │ Hyper-V Internal switch│
   └────────┬────────┘                            └────┬──────────────────┘
   ┌────────▼────────┐                        ┌────────┼────────┬─────────┐
   │ QEMU/KVM guest  │                     phases     e2e     fresh
   └─────────────────┘                     (Gen 2, differencing VHDX ×3)
```

### Dependency

This consumes `run-hosting --isolation-name` and `setup-guest-unix`'s answer flags, both added by the [spec-1 preparation design](2026-08-15-hyperv-guest-tier-preparation-design.md), which has landed in full (`5fea3d6` through `1e082df`).

## Scope

**Added**

- `tests/guest/` rewritten: a Hyper-V harness (golden-image build, VM lifecycle, SMB share provisioning, serial-log capture, residue sweep) plus three test files.
- Three tests relocated into `proxy-stack` (see "Disposition of the current assertions").
- A strict single-port variant of `checkNoRunningProxy` for this tier.
- `.image-cache/`, with its `.gitignore` and `.prettierignore` entries.
- Unit tests for the harness's pure functions (stamp hashing, `grub.cfg` generation, `known_hosts` filtering, PowerShell command builders).

**Deleted**

- `tests/guest/harness/*.sh` (~430 lines plus the cloud-init seed) and `tests/guest/wsl.ts`.
- `development.md`'s WSL2/KVM prerequisites — mirrored networking, `[experimental] ignoredPorts=67`, `setup-wsl.sh`.
- Four assertions that tested the harness rather than the product (itemised below).

**Explicitly not in scope**

- **Any change to `src/`.** Spec 1 landed everything the product needed. This spec is tests and documentation only, and that constraint is worth holding: a design that needs a product change to make a test work should be re-examined first.
- **Windows guests and `templates/vm-shared-windows/`.** Spec 1 deferred the Windows template trim partly because a Windows guest *might* later enter the test mix; building one now would invert a decision made eight commits ago. A Windows golden image also means a 90-day evaluation ISO driven by `autounattend.xml` — a second image pipeline, not an increment on this one. The Windows `nn-configure-network.ps1`'s hardcoded script numbers (`:9`, `:29`, `:35`) stay as spec 1 left them.

## Two properties the design is organised around

Both are patterns this repository already establishes, and most of the decisions below fall out of holding them.

- **Bootstrappable from clean.** No manual prerequisite beyond an elevated shell, Hyper-V, Docker, and a running `ssh-agent`. The tier builds its own golden image, its own host network, and its own SMB share. This is what ruled out a hand-built golden VM plus checkpoints, and a documented one-time share-account setup.
- **Safe to rerun, sweeps residue regardless of origin.** [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md)'s `delete-host-network` discipline, applied to VMs, differencing disks, the local account, the SMB share, and `known_hosts` entries.

## 1. The golden image pipeline

`ensureGoldenImage()` returns the path to a golden VHDX matching the current inputs, building it if it does not exist or is stale. Every other part of the tier treats it as a cached fact.

### Why an installer, and why this one

Ubuntu publishes no VHD/VHDX for 26.04 — `cloud-images.ubuntu.com/releases/26.04/release/` offers only `.img` (qcow2), `.ova`, `.vmdk`, `.squashfs`, `.tar.gz`, and `.tar.xz`, with no raw image, and `Convert-VHD` handles VHD↔VHDX only. Converting the cloud image would need `qemu-img` on Windows — a new non-Hyper-V dependency — and would keep the cloud-image-vs-installer fidelity gap that autoinstall closes. So: `ubuntu-26.04-live-server-amd64.iso` (2.7 GB) driven by an unattended autoinstall.

**Server, made to look like Desktop's network stack.** Production guests are Ubuntu Desktop (`setup-guest.md:16-21`), and Desktop uses NetworkManager while Server defaults to the `networkd` renderer. The netplan-merge-under-NetworkManager regression class is the reason [ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) gives for needing a real guest at all, so the image installs `network-manager`, sets the netplan renderer to NetworkManager, and masks `systemd-networkd` — the same three deliberate choices today's WSL image makes at `tests/guest/harness/seed/user-data:10,32-42,57`. Stock Server would be a fidelity *regression* against the harness being replaced, which would be a strange outcome. Full Ubuntu Desktop (6.1 GB ISO, 15–30 minute install, real Firefox so the `policies.json` test need not stub it) was tempting for that one assertion, but not worth tripling the build.

### Getting `autoinstall` onto the kernel command line

Subiquity checks for the `autoinstall` **kernel parameter** before destructively modifying disks; without it the installer stops at a confirmation prompt regardless of how the config was delivered ([Autoinstall quick start](https://canonical-subiquity.readthedocs-hosted.com/en/latest/howto/autoinstall-quickstart.html)). A `CIDATA` volume supplies the *config*, but not the consent — so "stock ISO plus a FAT32 seed disk, no ISO tooling" hangs at a TUI prompt.

The harness therefore **extracts the ISO onto a FAT32 VHDX and writes its own `boot/grub/grub.cfg`**. This is the path Ubuntu supports as first-class UEFI install media (extract the ISO to a FAT32 USB stick), so it is well-trodden rather than clever, and every step is a Windows built-in — no `xorriso`, no `qemu-img`, no new dependency:

```
1. ISO          download ubuntu-26.04-live-server-amd64.iso, verify against
                releases.ubuntu.com/26.04/SHA256SUMS            → .image-cache/
2. installer    New-VHD 4 GB → Initialize-Disk GPT → New-Partition
   VHDX         → Format-Volume FAT32 → Mount-DiskImage the ISO
                → Copy-Item the whole tree → overwrite boot/grub/grub.cfg
3. seed VHDX    New-VHD 64 MB → FAT32, volume label CIDATA
                → write user-data + meta-data
4. target       New-VHD 40 GB dynamic — the future golden
5. build VM     New-VM -Generation 2, Default Switch (autoinstall needs ICS
                internet), Secure Boot OFF, boot order = installer VHDX,
                Set-VMComPort 1 → \\.\pipe\susentorno-test-golden-build
6. run          Start-VM; stream serial to the build log; wait for the VM to
                reach Off (autoinstall ends with `shutdown: poweroff`)
7. finish       Remove-VM; delete installer + seed VHDXs; write the stamp
```

The `grub.cfg` the harness writes is the whole mechanism:

```
set timeout=1
menuentry "autoinstall" {
  linux  /casper/vmlinuz autoinstall console=ttyS0,115200 ---
  initrd /casper/initrd
}
```

`console=ttyS0,115200` is what makes step 6 observable rather than a 20-minute black box.

**The build VM has three disks, and autoinstall must not install onto the installer disk.** `storage: { layout: { name: direct, match: { size: largest } } }` disambiguates by size, which is why 40 GB / 4 GB / 64 MB are design constraints rather than arbitrary numbers.

**Secure Boot is OFF for the build VM only.** It boots a hand-assembled disk — the one place a signature policy could bite — during the step we can least observe, and what the installer *writes* (signed shim, GRUB, signed kernel) is identical either way. Per-test guests get Secure Boot **on** with the "Microsoft UEFI Certificate Authority" template, matching `setup-guest.md:34`.

### What the autoinstall bakes in

| Baked in | Why it is load-bearing |
| --- | --- |
| harness SSH public key, `allow-pw: false` | spec 1's documented precondition — a run makes ~20 ssh/scp calls, each of which would otherwise prompt |
| `NOPASSWD` sudo | `buildSshRunArgv` passes `-t`, so every remote command gets a fresh pty and sudo's per-tty timestamp never carries |
| `network-manager` + netplan `renderer: NetworkManager` | matches production Desktop; preserves ADR-0010's netplan/renderer coverage |
| `systemd-networkd` masked | two renderers fighting over one link is what the historical `LinkBusy` failures were |
| `linux-cloud-tools-virtual` | `getVmIpAddresses` needs KVP, and KVP cannot be installed before the guest is reachable |
| `apt-daily` + `unattended-upgrades` masked | they hold the dpkg lock shortly after boot, and the e2e test's real `apt install` sits squarely in that window |
| `apt upgrade` in `late-commands` | spec 1's lever — the per-run upgrade then usually finds nothing to do |
| `console=ttyS0,115200` in `GRUB_CMDLINE_LINUX_DEFAULT` | every per-test guest gets a boot log for free |
| SSH host keys, generated once at install | deliberately *not* regenerated per guest; one stable key across all three is what makes `known_hosts` manageable |

**Deliberately not baked in:** `cifs-utils` (so `mountShare` really installs it), node/pnpm/agents (so the e2e test really bootstraps a bare Ubuntu), and `dnsmasq` — today's image installs it purely so the "no in-guest dnsmasq" assertion can fail (`seed/user-data:58-62`), a contrivance not worth carrying into a new image.

### Cache and staleness

`.image-cache/` in the repository, gitignored. Repo-local is safe here specifically because this project avoids git worktrees — its live tiers act on one shared host network adapter, so parallel checkouts could not run tests concurrently anyway, and the usual "each worktree rebuilds its own multi-GB image" objection cannot arise. No environment-variable override; there is no second consumer.

Steady state holds the ISO and the golden VHDX. The installer VHDX and the seed VHDX are deleted as soon as the build succeeds — both are pure derivations, seconds to regenerate. The ISO is kept: re-acquiring it is a 2.7 GB download, and rebuilds happen exactly when someone is iterating on the autoinstall config, which is the worst time to add a download to the loop.

**Stamp:** SHA-256 over the autoinstall `user-data`, the `grub.cfg` the harness writes, the ISO URL, and the harness SSH public key. Dropped before the build and written only after a clean finish, so a half-built image can never be vouched for — `tests/guest/harness/build-image.sh:14-19,31,93-95` ported in spirit. The ISO download additionally verifies SHA-256 against `releases.ubuntu.com/26.04/SHA256SUMS`; a truncated 2.7 GB file otherwise surfaces as an inscrutable install hang rather than a download error.

**No maximum image age.** The e2e test still runs `01-apt-packages.sh`'s real `apt upgrade -y`, so a stale golden image costs *time*, never correctness. A max age would trade an occasional slow run for a guaranteed rebuild every N days, buy no coverage, and bake in an arbitrary constant. The existing `--force` escape hatch covers a deliberate refresh. Revisit only if runtime measurably degrades.

## 2. The sandbox

Brief decision 5 holds: one isolation name derives everything the tier touches on the host, so all of it is discoverable and sweepable from one string.

| Object | Name | Owner |
| --- | --- | --- |
| Internal switch | `susentorno-test-internal` | `create-host-network` (exists) |
| Firewall rules | `susentorno-test …` | `create-host-network` (exists) |
| VMs | `susentorno-test-phases` / `-e2e` / `-fresh` | new harness |
| Differencing VHDXs | `.image-cache/susentorno-test-<role>.vhdx` | new harness |
| Golden VHDX | `.image-cache/susentorno-test-golden.vhdx` | new harness (cached, survives sweeps) |
| Local account | `susentorno-test-share` | new harness |
| SMB share | `susentorno-test-vm-shared-linux` | new harness |

The share name is the one that changes guest-visible behaviour: `mountShare` mounts at `/mnt/<shareName>` and `runPreScripts` runs `/mnt/<shareName>/pre-scripts`, so the guest mounts `/mnt/susentorno-test-vm-shared-linux` rather than production's `/mnt/vm-shared-linux`. Every script resolves its own directory relatively (`script_dir` / `dirname`), so nothing breaks. It is forced rather than chosen: an SMB share name is machine-global and would otherwise collide with a developer's real `vm-shared-linux`.

### Three guests, one golden parent

```
susentorno-test-golden.vhdx          ← built once, cached, never booted again
   ├── susentorno-test-phases.vhdx   ← New-VHD -Differencing -ParentPath <golden>
   ├── susentorno-test-e2e.vhdx
   └── susentorno-test-fresh.vhdx
```

The direct analogue of today's `qemu-img create -f qcow2 -b "$GOLDEN"` (`harness/guest.sh:37`) — three independent copy-on-write overlays, no test able to see another's writes. The golden VHDX is never booted or modified after the build; Hyper-V stamps parent identity into each child, so touching the parent invalidates all of them.

Each guest is created fresh at the start of its test file and destroyed with the file. **Strictly sequential** (`fileParallelism: false`), the precedent every stateful tier here already sets. Concurrency would put two guests on one DHCP server and one SMB share, and DHCP lease and IP-discovery races are exactly the bug class this tier exists to catch — the harness should not be generating them.

**Guest sizing:** Generation 2, 2 vCPU, dynamic memory 2048–4096 MB. Production uses 12288 MB (`setup-guest.md:26`), but only one guest runs at a time and nothing here is memory-hungry.

Considered and rejected: folding `fresh` into `e2e`'s VM by recreating its differencing disk. It saves a VM object but not a boot, and makes two tests share a name — worse for an orphan sweep that finds VMs by name. Premature optimisation.

### `globalSetup` — cheapest guard first, slowest work last

Matching the ordering rationale already written at `tests/guest/globalSetup.ts:11-14`:

```
1. checkElevated()            instant   (moves up from tests/host-network/ — now shared)
2. checkDockerRunning()       instant
3. checkSshAgentRunning()     instant   new
4. checkGatewayPortsFree()    ~1s       new, strict: EITHER :80 or :443 held is fatal
5. sweepIsolationResidue()    seconds   VMs, child VHDXs, shares, account, known_hosts
6. deleteHostNetwork() → createHostNetwork()   isolationName 'test', called as modules
7. ensureGoldenImage()        up to 30 min on a cold cache
```

Steps 6 use the **modules**, not the CLI, exactly as `tests/host-network/createDeleteHostNetwork.test.ts:38-48` already does — the CLI would prompt for a subnet, while the module takes an injectable `promptSubnet`. The tier owning its host network rather than requiring one keeps the bootstrappable-from-clean property; requiring it would be the "documented one-time manual prerequisite" already rejected for the SMB share, and rejecting it there while accepting it here would be incoherent.

`sweepIsolationResidue('test')` is name-driven and origin-blind: `Get-VM -Name 'susentorno-test-*'` → `Stop-VM -TurnOff` → `Remove-VM -Force`; delete `.image-cache/susentorno-test-*.vhdx` **except** `-golden.vhdx` and the key pair; `Remove-SmbShare susentorno-test-*`; `Remove-LocalUser susentorno-test-share`; then rewrite `~/.ssh/known_hosts` dropping lines whose host matches the internal subnet or the Default Switch subnet (the first derivable from the switch's host IP, the second from `resolveForwardListenAddress('vEthernet (Default Switch)')`). It runs at startup **and** teardown: startup makes a Ctrl-C'd run recoverable, teardown keeps a passing run from leaving a local account and three VMs on the machine.

### Why the gateway must bind real `:80`/`:443`

`runHosting.ts:206-207` reads `ENVOY_HTTP_PORT`/`ENVOY_HTTPS_PORT` — misleadingly named, because they are the **gateway's** listen ports, and `startGateway` opens one port pair across every address in `listenAddresses`. That array is seeded with `'127.0.0.1'` unconditionally and the isolation network's IP is appended, so there is no way to give the adapter `:443` and loopback `:18443`.

The guest resolves every name to the host IP (the DNS responder answers with it) and then connects on the standard port from the URL. The adapter listener must therefore be on 80/443, and the shared port pair puts loopback there too. The loopback listener is not vestigial: `templates/proxy/verify-proxy.ps1:273-300`, the user-facing host diagnostic, probes the proxy entirely through `--resolve <host>:443:127.0.0.1`. Splitting the ports in the product was rejected — a product change with one test consumer, weakening the "the tier runs what a user runs" property that justifies this spec.

This is not new exposure: a developer running `susentorno run-hosting` already binds `127.0.0.1:80`/`:443`.

**`checkNoRunningProxy:28-29` deliberately requires *both* ports** before failing, so "an unrelated `:80` listener (IIS, some dev server)" does not trip it. Once this tier binds those ports for real, that tolerance becomes a defect — IIS holding `:80` alone would sail past the guard and fail inside `startGateway` as an opaque `EADDRINUSE`, which is the "symptom lands a long way from the cause" failure the existing comment says it was written to prevent. So `checkGatewayPortsFree` keeps two messages: **both** ports held is almost certainly `run-hosting` (today's message, still accurate); **one** port held is IIS or a dev server and needs a different sentence. `proxy-stack` keeps the lenient version — it still uses 18080/18443 and genuinely does not care about a stray `:80`.

### Two `run-hosting` instances are impossible, not merely guarded

`templates/proxy/docker-compose.yml:18,25` pins `container_name: susentorno-envoy-blue` / `-green` — fixed, global names. Two `run-hosting` instances cannot coexist on one machine regardless of isolation name, environment directory, or adapter. `checkNoRunningProxy`'s successor therefore stays, and this is a documented consequence rather than a design choice.

It also usefully bounds the isolation name: it sandboxes the *host network* and the tier's own objects, never the Envoy containers or the loopback ports.

### Per-file lifecycle

```
beforeAll:  startProxyStack(['--isolation-name', 'test'])   ← --no-forward is gone
            createShareAccount()  New-LocalUser susentorno-test-share, random password
            createShare()         New-SmbShare susentorno-test-vm-shared-linux
                                  → <envRoot>/vm-shared-linux, ReadAccess that account
            createTestGuest(role) New-VHD -Differencing -ParentPath <golden>
                                  New-VM -Generation 2, Secure Boot ON
                                  (Microsoft UEFI Certificate Authority)
                                  Set-VMComPort 1 → \\.\pipe\susentorno-test-<role>
                                  Start-VM, stream serial, wait for :22
afterAll:   collectDiagnostics()  serial log + journal/route/resolver dumps
            destroyTestGuest()    Stop-VM -TurnOff, Remove-VM, delete child VHDX
            removeShare(), removeShareAccount(), stopProxyStack()
```

Three files, each self-contained, each starting its own `run-hosting`. `tests/proxy-stack/` already sets this precedent — eight files each start their own stack, and `githubInjection.test.ts:23` notes it picks ports "distinct from the other proxy-stack suites'." Here all three need 80/443, which sequential execution makes fine.

The share is created **per file, after `startProxyStack`**, not in `globalSetup`: `startProxyStack` calls `rmEnvRoot(envRoot)` and re-runs `init` (`tests/proxyStack.ts:126-132`), so a share created earlier would point at a directory deleted underneath it. The account goes with it rather than being global, keeping each file independently runnable; the origin-blind sweep covers the crash case either way.

### Reaching the guests

**IP discovery.** `getVmIpAddresses` depends on the KVP daemon, and `kvpDaemon.ts:4-8` records that its service starts cleanly only once the guest reboots. In production the *user* types the first address and KVP supplies candidates afterwards; there is no user here, and KVP cannot be installed before the guest is reachable. So `linux-cloud-tools-virtual` is baked into the golden image. The fidelity cost is that `ensureKvpDaemon` in the e2e test hits the already-installed path — small, since its contract is "guarantee it is installed", and it still runs and still must succeed. A static MAC plus `Get-NetNeighbor` was the alternative (no fidelity cost, mirroring `harness/guest.sh:5-11`'s deterministic-MAC trick) but its data is best-effort: neighbour entries expire and only exist once the guest has sent traffic.

**Host-key trust.** `remoteExec.ts:52,58` spawns bare `ssh`/`scp` with no `-o` options, inheriting the developer's `~/.ssh/config` and `known_hosts`. All three guests come off one golden image and so share one host key, while their IPs vary per run and get recycled — a golden rebuild (new key, recycled IP) would then produce a hard `REMOTE HOST IDENTIFICATION HAS CHANGED` failure. Hence: one stable host key in the image, plus the `known_hosts` sweep described above at both startup and teardown. `phases` and `fresh` build their own `RemoteExec` and pass `-o StrictHostKeyChecking=no -o UserKnownHostsFile=…` explicitly, as `harness/lib.sh`'s `SSH_OPTS` does today, so only the e2e path touches the real `known_hosts`. Redirecting `USERPROFILE`/`HOME` for the spawned child was the alternative; it leans on Win32-OpenSSH resolving `~` from `%USERPROFILE%`, which is true but not documented firmly enough to be load-bearing under a 20-minute test.

**Key delivery.** The e2e test runs the real `createSshRemoteExec`, so `ssh` must *find* the private key — and the harness cannot write `IdentityFile` into the developer's `~/.ssh/config`, nor name the key `~/.ssh/id_ed25519` and clobber theirs. `ssh-agent` is the only non-invasive answer: `globalSetup` runs `ssh-add` on the harness key from `.image-cache/`, teardown runs `ssh-add -d`. `ssh` tries agent identities by default, so no production code changes and no file is edited. Windows ships the `ssh-agent` service disabled on some SKUs, so `checkSshAgentRunning` fails fast with a fix-it message — the treatment `checkWslDhcpPortIgnored` gives its prerequisite today.

## 3. The three test files

### One refinement to the brief's decision 3

The brief has `phases` driving `runPostScripts` as well. It cannot: both post-scripts depend on pre-scripts `phases` does not run — `02-apply-home-jq-transforms.sh` needs node (from `03-install-tools.sh`) and `01-auth-config.sh` needs `git` (from `01-apt-packages.sh`). Today's WSL harness hides this by apt-installing `nodejs` into its image, and `seed/user-data:13-17` admits exactly that. Putting node back would undo what the e2e test exists to prove.

So `phases` drives the **four** operations that need intermediate observation and stops; `runPostScripts` is covered by `e2e`, where its dependencies genuinely exist. This is new information rather than a reversal — the decision predates spec 1's template trim.

### `phases.test.ts` — `susentorno-test-phases`, boots on the Default Switch

Drives the modules directly: `mountShare` → `runPreScripts` → `isolateVmToSwitch` → `mountShare`.

The second `mountShare` is the prize. It re-points the same mount at a different host IP (`defaultSwitchHostIp` → `internalSwitchHostIp`), which is exactly the condition `mountShare.ts:76-90` describes — a live autofs mount against a now-unreachable IP, where "merely stat'ing it (which `mkdir -p` does) trips ENODEV." **Nothing tests that today.** Nor does anything test `cifs-utils` installation, `/etc/susentorno-share.cred`, or the `x-systemd.automount` fstab entry; the 9p `virtfs` mount at `harness/guest.sh:44` has nothing in common with any of it.

`runPreScripts` is filtered to `configure-network` only, as today — running the full set is `e2e`'s job and paying for it twice would be the dominant cost in the tier.

### `e2e.test.ts` — `susentorno-test-e2e`, boots on the Default Switch

Stages `github-config.txt` with `GITHUB_PLACEHOLDER_PAT`, shadows `gh` at `/usr/local/bin/gh`, then spawns the real command with the password piped in — the mechanism [ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md) exists to guarantee:

```ts
execa('node', [cliPath, 'setup-guest-unix',
  '--isolation-name', 'test', '--vm-name', 'susentorno-test-e2e',
  '--guest-address', ip, '--guest-username', GUEST_USER,
  '--share-name', 'susentorno-test-vm-shared-linux',
  '--share-account', 'susentorno-test-share'],
  { cwd: envParent, input: `${sharePassword}\n` });
```

Every spec-1 flag in one call. It runs the **real, untrimmed** script set: real `apt upgrade`, real pnpm, real Codex/Claude/Pi installers, real `runPostScripts`. Assertions land on the outcome — the placeholder credential symlinks, git identity, `hasCompletedOnboarding` — plus one re-run of the transform applier against a pre-seeded `~/.claude.json` to cover the merge-without-clobbering case.

**Why `gh` is shadowed.** `post-scripts/01-auth-config.sh` hard-exits without `github-config.txt` (`:10-13`) and then runs `gh auth login --with-token` against real GitHub (`:25`). No clean-machine test can supply a valid GitHub token. `/usr/local/bin` precedes `/usr/bin`, so the stub shadows the real `gh` that `01-apt-packages.sh` installs. Today's suite already does this (`guest.test.ts:211-228`); it is one well-understood substitution.

Considered and rejected: pointing `api.github.com` at `mockUpstream` via `--upstream-override`, as `api.anthropic.com` already is (`proxyStack.ts:166-167`). It would exercise GitHub credential injection from inside a guest, which nothing does — but `gh auth login` validates the token by parsing `/user` and reading `X-Oauth-Scopes`, so the mock would have to imitate a real API and would break whenever a third-party CLI's internals change.

Also considered and rejected: `e2e` running only `configure-network` and the post-scripts, as today's suite does. It is fast, but node returns to the golden image, `mountShare`'s `cifs-utils` install becomes the tier's only real `apt`, and the dpkg-lock race is never exercised — so the tier stops proving the thing it exists to prove.

### `fresh.test.ts` — `susentorno-test-fresh`, created **on the Internal switch**

Boots and asserts, *before anything runs*, that DHCP alone configured it; then runs `configure-network` and asserts nothing changed. It must never have touched the Default Switch, which is why `phases` structurally cannot prove this.

### Disposition of the current assertions

| Current test | Disposition |
| --- | --- |
| `:133` runPreScripts → CA cert present | **phases**, unchanged |
| `:151` runs `04-configure-network.sh` from the share | **phases**, path now `/mnt/susentorno-test-vm-shared-linux/…` |
| `:159` setup-phase resolver is `BRIDGE_IP` | **deleted** — asserted harness topology. The real setup phase is ICS on the Default Switch, so this becomes "ICS works", a precondition. Demoted to a `beforeAll` reachability guard. |
| `:174` no DNAT rules | **phases**, unchanged (deleted-layer guard) |
| `:179` setup-phase route still `proto dhcp` | **phases**, unchanged |
| `:187`, `:199` home settings transforms | **e2e** — need node |
| `:211` auth-config symlinks placeholder (gh stubbed) | **e2e** — needs git; the `gh` stub survives |
| `:230` firefox `policies.json` merge | **phases**, unchanged (firefox still stubbed) |
| `:244` no in-guest dnsmasq after reboot | **deleted** — meaningful only because `seed/user-data:58-62` installs dnsmasq *so it can fail*; not carrying a contrivance into a new image |
| `:253` default route from DHCP | **phases** — now proves the real DHCP server's option 3 |
| `:262` host is the effective resolver | **phases** — now proves the real DNS responder |
| `:267` CA trusted / unexpected auth passes through / placeholder injected | **phases** — now through the real gateway forwarder |
| `:299`, `:312`, `:320`, `:329` passthrough, `:80` allow, `:443` deny, `:80` 403 | **phases** — same, real forwarder |
| `:337` `NODE_EXTRA_CA_CERTS` for login shells | **phases** — set by `nn-configure-network.sh:24`, no node needed |
| `:364` passthrough warmup probe | **deleted** — an artifact of `docs/investigations/2026-07-11-proxy-restart-swap-window-race.txt`, not a regression test |
| `:382` unique tagged log lines | **→ `proxy-stack`**, host-driven traffic |
| `:389` allowlist edit restarts, re-attaches the follow, resets unique tracking | **→ `proxy-stack`** |
| `:413` credential rotation restarts and preserves unique tracking | **→ `proxy-stack`** |
| `:439` fresh guest configured by DHCP alone | **fresh**, unchanged |
| — | **new in phases**: cred-file mode and ownership, the fstab automount entry, the stale-autofs unwind |

Net: 23 assertions become about 19 in the guest tier, 3 relocated, 4 deleted, 3 added — and what remains asserts the product rather than the harness.

**The three relocated tests are rewritten, not merely deleted.** `tests/proxy-stack/stackLifecycle.test.ts` covers the blue/green swap and token rotation, but **not** the allowlist-edit restart, the log-follow re-attachment, or unique-tracking reset/preserve. They move to `proxy-stack` driving traffic at `127.0.0.1:HTTPS_PORT` instead of from a guest. The cost is real if small: that traffic currently originates in a guest, so "the follow re-attached" is today proven end-to-end through the forwarder. The benefit is three fewer tests — including two with 300-second timeouts — on the expensive tier, and it corrects a tier placement `testing.md:29-36` already forbids.

## 4. Modules

```
tests/
  checkElevated.ts          ← moved up from tests/host-network/ (now shared by two tiers)
  checkGatewayPortsFree.ts  ← strict variant; checkNoRunningProxy stays for proxy-stack
  checkSshAgent.ts
  guest/
    globalSetup.ts
    phases.test.ts  e2e.test.ts  fresh.test.ts
    guestExec.ts            harness RemoteExec (ssh with explicit -o options)
    testShare.ts            local account + SMB share, create/remove
    diagnostics.ts          serial log + SSH dumps → test-results/guest/<ts>/<role>/
    hyperv/
      vhd.ts                New-VHD / Initialize-Disk / New-Partition / Format-Volume
      isoCache.ts           download + SHA256 verify
      installerDisk.ts      ISO → FAT32 VHDX + grub.cfg
      seedDisk.ts           CIDATA VHDX
      goldenImage.ts        stamp + build orchestration
      testGuest.ts          create/destroy one differencing-disk VM
      serialLog.ts          named-pipe reader → file
      sweep.ts              sweepIsolationResidue(isolationName)
    autoinstall/            user-data, meta-data, grub.cfg
```

Every PowerShell-facing module goes through the existing `powerShellExec.ts` seam and follows the split `hyperVQueries.ts` already establishes — **pure `buildXCommand()` / `parseX()` functions** wrapped by a thin executor. That is what makes the interesting logic testable in the `unit` tier without Hyper-V; only the executors need a real host.

## 5. Verification

| Tier | Coverage |
| --- | --- |
| `unit` | Stamp hashing (same inputs → same stamp; any input moves it), `grub.cfg` generation, the `known_hosts` subnet filter, and every new PowerShell command builder and output parser |
| `guest` | The three files above, against real Hyper-V |
| `proxy-stack` | The three relocated lifecycle tests |

The harness's own executors — `New-VHD`, `Mount-DiskImage`, `New-VM` — are verified by the tier running at all. That is the same bargain `tests/host-network/` already accepts.

### Failure and diagnostics

- **Preflight failures name the fix**, per `testing.md:56`'s "a missing live-tier prerequisite is an environmental failure, not a product failure."
- **Golden-build failure:** the stamp is not written, the build VM's serial log is retained at a stable path, and the thrown error names it. A failed build always retries next run rather than half-vouching for an image.
- **A guest that never reaches `:22`:** the serial log is the entire diagnostic. The error names it explicitly, the equivalent of `harness/guest.sh:57`'s "see `$RUN/$name-serial.log`".
- **Teardown is best-effort and independent** — each step separately caught so one failure does not strand the rest, matching `guest.test.ts:125,128`. Diagnostics are collected *before* teardown.
- **Diagnostics layout** stays `test-results/guest/<timestamp>/<role>/`, gaining `serial.log` alongside today's `journal.txt` and `network.txt`.

Boot diagnostics use `Set-VMComPort` to a named pipe with a Node reader. It pays off twice: because the harness authors the installer's `grub.cfg`, the golden build's subiquity output streams out live, and `GRUB_CMDLINE_LINUX_DEFAULT` gives every per-test guest a boot log thereafter — the most opaque step in the design becomes the best-instrumented one. A console thumbnail via `Msvm_VirtualSystemManagementService.GetVirtualSystemThumbnailImage` was considered and dropped: it helps only when serial produces nothing at all, and a low-resolution PNG is enough to see "it is sitting at a GRUB prompt" but not to read a stack trace.

### Pipeline placement

The tier **stays in the default `pnpm test`**. The marginal cost is smaller than it looks — `pnpm test` already requires an elevated shell and real Hyper-V because [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md) put `host-network` in the default pipeline — and that ADR explicitly rejected opt-in on the grounds it "would leave regressions uncaught by routine test runs, undermining the point of writing real tests instead of a checklist." That argument applies here with more force: this tier is the only automated coverage of ADR-0011's forwarder and ADR-0014's DNS/DHCP.

What the pipeline *drops*: WSL2, nested virtualization, KVM, `.wslconfig` mirrored networking, and `ignoredPorts=67`.

Rough budget per run, steady state:

| Step | Estimate |
| --- | --- |
| host network create + `run-hosting` start (×3 files) | ~3 min |
| 3 VM boots + 1 reboot through isolation | 5–8 min |
| e2e's real `apt upgrade`, pnpm, three agent installers | 5–10 min |
| everything else | 2–3 min |
| **total** | **~15–25 min**, plus a one-off ~20–30 min golden build |

Splitting the tier — `phases` + `fresh` in the default pipeline, `e2e` opt-in — was considered as a hedge against the e2e test's network-dependent flakiness. Rejected: it would make `setup-guest-unix`'s own wiring, the thing spec 1 was built for, the one part nobody runs by default. A flaky e2e test should be made robust, not moved.

## 6. Records and documentation

| Record | Change |
| --- | --- |
| [ADR-0010](../../adr/0010-vm-tests-via-qemu-in-wsl2.md) | **Superseded** by ADR-0025 — not amended. Its decision ("Hyper-V remains the production guest platform and is not the test runtime") is reversed outright, not qualified. It stays in the tree as the record of why QEMU-in-WSL2 was right at the time. |
| **ADR-0025** (new) | The guest layer is tested against real Hyper-V VMs: fidelity over portability, the autoinstall → golden VHDX → differencing-disk mechanism, and one substitution (`gh`) in place of three |
| [ADR-0011](../../adr/0011-loopback-publish-with-node-forwarder.md) | Consequence: the forwarder now has real automated coverage |
| [ADR-0014](../../adr/0014-host-side-dns-and-dhcp.md) | Consequence: "covered only by manual Hyper-V checkpoints" becomes automated for host-side DNS/DHCP |
| [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md) | Consequence: the isolation name now also scopes VM names, the share account, and the SMB share name. Its `:15` mention of `setup-guest-unix-isolation-checklist.md` stays — it is an accurate record of a rejected option's reasoning at the time. |
| `CONTEXT.md:43` | **Isolation name** amended past "the Internal switch and its firewall rules" to cover the guest VMs, share account, and share names it now derives |
| `testing.md` | Guest-tier rows rewritten (`:13`, `:25`, `:52`); the dangling `setup-guest-unix-isolation-checklist.md` link removed, since the behaviour it stood in for — VM stop/reassign/start, the elevation check, the `run-hosting` readiness check — is now automated |
| `development.md` | WSL2/KVM/mirrored-networking/`ignoredPorts=67`/`setup-wsl.sh` prerequisites deleted; elevated shell, Hyper-V, and a running `ssh-agent` documented |

**Isolation name** (`CONTEXT.md`, replacing the current definition): *The name that selects which parallel set of susentorno host objects a command acts on — the Internal switch and its firewall rules, and, for the test tiers, the guest VMs, SMB share, and share account derived from the same name — so a sandboxed installation can coexist with the default one on the same machine. Omitting it selects the unnamed default.* _Avoid_: sandbox name, test name.

Spec 1 wrote the narrower definition and said it would be amended here if spec 2 extended the term. It does, so it is.

## 7. Risks

Recorded rather than smoothed over.

1. **FAT32's 4 GB per-file limit** on the installer disk. Fine at a 2.7 GB ISO today, with headroom that shrinks each release. It fails loudly rather than subtly.
2. **Autoinstall specifics on 26.04** — `storage.match.size: largest` and the exact `late-commands` want a short spike during implementation, not a spec assertion.
3. **Named-pipe COM port timing** — Hyper-V creates the pipe only while the VM runs, so the reader must retry-connect and tolerate losing the earliest bytes.
4. **Runtime is a real cost** — ~15–25 min steady state, ~20–30 min more on a cold cache, with the e2e test's install traffic the variable part.
5. **`ssh-agent` availability** on Windows SKUs where the service ships disabled. Mitigated by a fail-fast preflight, not by a workaround.

## 8. Considered and rejected

**Porting the harness to Hyper-V while keeping the substitutions.** The alternative was dropping the WSL dependency but keeping `dnsmasq` and `socat`. Rejected: accepting a real-Hyper-V, elevation-requiring, host-state-touching tier without buying the fidelity means paying ADR-0023's price for none of its return.

**A manually-built golden VM plus checkpoints.** Cheap, but it makes the suite un-bootstrappable from source — a real cost for a tier in the default pipeline.

**Converting the cloud image to VHDX.** Needs `qemu-img` on Windows, a new non-Hyper-V dependency, and keeps the cloud-image-vs-installer fidelity gap that autoinstall closes.

**Repacking the ISO with a Node ISO-writing library.** Conceptually the simplest route to the `autoinstall` kernel parameter. Rejected as inconsistent: a new dependency existing purely for tests is the same objection that ruled out `qemu-img`.

**Answering subiquity's confirmation prompt over the serial console.** Screen-scraping and keystroke-injecting a TUI is the most fragile thing available here, and it would make the diagnostics channel load-bearing for the build rather than merely diagnostic.

**Driving everything through the real `setup-guest-unix`.** Leaves no seam for intermediate assertions — specifically the second `mountShare`'s stale-autofs unwind.

**Driving nothing through it.** Leaves the command's own wiring untested.

**A maximum golden-image age.** Buys no coverage; a stale image costs time, not correctness.

**Keeping both harnesses temporarily.** `pnpm test` would run two full guest tiers (~45 min), WSL prerequisites would stay mandatory in `development.md`, and the relocated assertions would exist in two places during exactly the window they are being re-dispositioned.
