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
- An options parameter for `startProxyStack`, defaulting to today's behaviour (see section 2).
- `.image-cache/`, with its `.gitignore` and `.prettierignore` entries.
- Unit tests for the harness's pure functions (stamp hashing, `grub.cfg` generation, `known_hosts` filtering, PowerShell command builders).

**Changed in `src/` — one thing**

`DEFAULT_SHARE_ACCOUNT` (`src/guestSetup/setupAnswers.ts:24`) becomes `susentorno`, replacing `susentorno-share`. See "The share account is renamed" for why the tier forces the question and why there is no migration path.

**Deleted**

- `tests/guest/harness/*.sh` (~430 lines plus the cloud-init seed) and `tests/guest/wsl.ts`.
- `development.md`'s WSL2/KVM prerequisites — mirrored networking, `[experimental] ignoredPorts=67`, `setup-wsl.sh`.
- Four assertions that tested the harness rather than the product (itemised below).

**Explicitly not in scope**

- **Any further change to `src/`.** Spec 1 landed everything the product needed to make the tier possible; the one product change above is a naming decision the tier surfaced, not a capability it required. That distinction is worth holding: a design that needs a *capability* added to make a test work should be re-examined first.
- **A length bound on `ISOLATION_NAME_RE`.** Real (see "The share account is renamed") but unrelated to the guest tier, and it belongs in its own changeset.
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
2. installer    New-VHD 4 GB → Initialize-Disk GPT → New-Partition with
   VHDX         -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}' (EFI System
                Partition — NOT New-Partition's default basic-data type)
                → Format-Volume FAT32 → Mount-DiskImage the ISO
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

The **EFI System Partition GPT type is not optional**. `New-Partition` creates a basic-data partition by default, and a Generation 2 VM's UEFI firmware boots through an ESP. Some firmware will scan the fallback `\EFI\BOOT\BOOTX64.EFI` path on a basic-data FAT32 partition, but the golden build must not rest on that; the type is set explicitly. This remains risk 1 below — it wants a spike before the rest of the pipeline is built, because everything downstream is worthless if the build VM will not boot.

**The build VM has three disks, and autoinstall must not install onto the installer disk.** `storage: { layout: { name: direct, match: { size: largest } } }` disambiguates by size, which is why 40 GB / 4 GB / 64 MB are design constraints rather than arbitrary numbers.

**`late-commands` run in the live installer environment, not the installed system**, with the target mounted at `/target`. Every persistent change in the table below must therefore go through `curtin in-target -- …` (or write explicit `/target/…` paths) — a bare `apt upgrade`, `systemctl mask`, `/etc/default/grub` edit, or `update-grub` would configure the throwaway installer environment and leave the golden image untouched, silently. `update-grub` in particular must run in-target for `console=ttyS0,115200` to reach the installed system's boot configuration at all.

**Secure Boot is OFF for the build VM only.** It boots a hand-assembled disk — the one place a signature policy could bite — during the step we can least observe, and what the installer *writes* (signed shim, GRUB, signed kernel) is identical either way. Per-test guests get Secure Boot **on** with the "Microsoft UEFI Certificate Authority" template, matching `setup-guest.md:34`.

### What the autoinstall bakes in

| Baked in | Why it is load-bearing |
| --- | --- |
| `identity`: username `vmtest`, hostname `susentorno-test-guest`, a locked/random encrypted password | autoinstall's `identity` section requires all three. `vmtest` carries over from `harness/seed/user-data:4` and is what the e2e test's `--guest-username` passes; it is deliberately distinct from the Windows share account (see "The share account is renamed"). The password is never used — `allow-pw: false` plus `NOPASSWD` sudo means nothing prompts for it |
| harness SSH public key, `allow-pw: false` | spec 1's documented precondition — a run makes ~20 ssh/scp calls, each of which would otherwise prompt |
| a **host** keypair generated on the Windows side and installed into `/target/etc/ssh/` | the harness then knows the guest's host key by construction, so it can write an exact `known_hosts` entry rather than trusting whatever answers first. See "Reaching the guests" |
| `jq` | `nn-configure-network.sh:49,51` uses it for the Firefox `policies.json` merge, and `phases` runs `configure-network` without `01-apt-packages.sh`. Firefox is absent in `phases`, so that branch does not fire there — but the dependency is one script edit away from mattering, and the package is trivial |
| `NOPASSWD` sudo | `buildSshRunArgv` passes `-t`, so every remote command gets a fresh pty and sudo's per-tty timestamp never carries |
| `network-manager` + netplan `renderer: NetworkManager` | matches production Desktop; preserves ADR-0010's netplan/renderer coverage |
| `systemd-networkd` masked | two renderers fighting over one link is what the historical `LinkBusy` failures were |
| `linux-cloud-tools-virtual` | `getVmIpAddresses` needs KVP, and KVP cannot be installed before the guest is reachable |
| `apt-daily` + `unattended-upgrades` masked | they hold the dpkg lock shortly after boot, and the e2e test's real `apt install` would otherwise sit squarely in that window. This is deliberate **avoidance**, not coverage — see below |
| `apt upgrade` in `late-commands` | spec 1's lever — the per-run upgrade then usually finds nothing to do |
| `console=ttyS0,115200` in `GRUB_CMDLINE_LINUX_DEFAULT` | every per-test guest gets a boot log for free |
| SSH host keys, generated once at install | deliberately *not* regenerated per guest; one stable key across all three is what makes `known_hosts` manageable |

**Deliberately not baked in:** `cifs-utils` (so `mountShare` really installs it), node/pnpm/agents (so the e2e test really bootstraps a bare Ubuntu), and `dnsmasq` — today's image installs it purely so the "no in-guest dnsmasq" assertion can fail (`seed/user-data:58-62`), a contrivance not worth carrying into a new image.

### Cache and staleness

`.image-cache/` in the repository, gitignored. Repo-local is safe here specifically because this project avoids git worktrees — its live tiers act on one shared host network adapter, so parallel checkouts could not run tests concurrently anyway, and the usual "each worktree rebuilds its own multi-GB image" objection cannot arise. No environment-variable override; there is no second consumer.

Steady state holds the ISO and the golden VHDX. The installer VHDX and the seed VHDX are deleted as soon as the build succeeds — both are pure derivations, seconds to regenerate. The ISO is kept: re-acquiring it is a 2.7 GB download, and rebuilds happen exactly when someone is iterating on the autoinstall config, which is the worst time to add a download to the loop.

**Stamp:** SHA-256 over **every generated seed file** — `user-data` *and* `meta-data` — plus the `grub.cfg` the harness writes, the ISO URL, the harness SSH public key, the baked guest host public key, and a hand-bumped build-algorithm version (so a change to the pipeline itself, not just its inputs, can force a rebuild). Dropped before the build and written only after a clean finish, so a half-built image can never be vouched for — `tests/guest/harness/build-image.sh:14-19,31,93-95` ported in spirit. The ISO download additionally verifies SHA-256 against `releases.ubuntu.com/26.04/SHA256SUMS`; a truncated 2.7 GB file otherwise surfaces as an inscrutable install hang rather than a download error.

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
| Share account (Windows local user) | `susentorno-test` | new harness |
| SMB share | `susentorno-test-vm-shared-linux` | new harness |

### The share account is renamed, default included

The share account becomes **`susentorno`** by default and **`susentorno-<isolation-name>`** when an isolation name is in play, so this tier uses `susentorno-test`. The account name then says which susentorno installation it belongs to, which matters exactly because a sandboxed installation and a real one can share a machine — the same reason the isolation name exists at all.

This replaces today's `DEFAULT_SHARE_ACCOUNT = 'susentorno-share'` (`src/guestSetup/setupAnswers.ts:24`). It is a **breaking change to shipped behaviour**, accepted deliberately: only one environment is currently deployed, and it will be recreated in full rather than migrated. There is no compatibility shim — consistent with how this project already treats `allowlist.txt` in [ADR-0021](../../adr/0021-split-allow-auth-block-lists-and-skip-allow-list.md), which was abandoned outright rather than auto-migrated.

The brief's `susentorno-test-share` is not available: at 21 characters it exceeds `New-LocalUser -Name`'s 20-character cap. That cap is what drives the shape of the whole scheme, and the two limits differ:

| | Limit | Longest usable isolation name |
| --- | --- | --- |
| Windows local account (`New-LocalUser -Name`) | 20 chars | `susentorno-<name>` → **9**; `susentorno-<name>-share` → **3** |
| Linux user (`useradd`) | 32 chars | not a constraint here |

So `susentorno-<isolation>-share` is effectively unusable, while `susentorno-<isolation>` leaves comfortable headroom. Note that `ISOLATION_NAME_RE` (`src/hostNetwork/hostNetworkNames.ts:7`) is `/^[A-Za-z0-9-]+$/` with **no length bound**, so a 10-plus-character isolation name would today produce a confusing `New-LocalUser` failure far from its cause. Adding a length cap there is a small, well-placed product fix, but it is **not** in this changeset — it is unrelated to the guest tier and deserves its own.

The guest's own Linux account stays **`vmtest`**, carried over from `harness/seed/user-data:4`. It is deliberately *not* renamed to match: it lives in a different namespace on a different machine, and giving it the same string as the Windows share account would make `mountShare`'s credential handling and the fstab entry harder to read, not easier.

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
3. checkGatewayPortsFree()    ~1s       new, strict: EITHER :80 or :443 held is fatal
4. ensureHarnessKeys()        instant   generate the client + guest-host keypairs into
                                        .image-cache/ if absent; both feed the stamp
5. ensureSshAgentIdentity()   ~1s       ssh-add the client key, then ssh-add -l and
                                        assert the fingerprint is listed
6. sweepIsolationResidue()    seconds   VMs, child VHDXs, SMB shares, local account
7. ensureGoldenImage()        up to 30 min on a cold cache
8. deleteHostNetwork() → createHostNetwork()   isolationName 'test', called as modules
```

**Ordering rationale.** Keys come before the image because the stamp hashes both public keys — deriving a stamp from a key that does not exist yet is not a thing. The agent probe comes before the 30-minute build so an agent problem is not discovered at the end of it. And the host network is created **last**, after the build, so a failed `ensureGoldenImage` leaves no switch or firewall rules behind: it is the one step that can plausibly fail for half an hour, and reordering costs nothing because the golden build attaches to the Default Switch, never the Internal one.

That reordering is a mitigation, not a guarantee. `globalSetup` must also **export a named `teardown`** rather than returning a teardown function from `setup`: Vitest only registers a *returned* teardown once `setup` resolves, so a rejection inside `setup` would leave anything it had already created stranded. A named export is loaded up front and runs regardless. Today's `tests/guest/globalSetup.ts` has no teardown at all, so this is new ground rather than a change.

Steps 6 use the **modules**, not the CLI, exactly as `tests/host-network/createDeleteHostNetwork.test.ts:38-48` already does — the CLI would prompt for a subnet, while the module takes an injectable `promptSubnet`. The tier owning its host network rather than requiring one keeps the bootstrappable-from-clean property; requiring it would be the "documented one-time manual prerequisite" already rejected for the SMB share, and rejecting it there while accepting it here would be incoherent.

`sweepIsolationResidue('test')` is name-driven and origin-blind: `Get-VM -Name 'susentorno-test-*'` → `Stop-VM -TurnOff` → `Remove-VM -Force`; delete `.image-cache/susentorno-test-*.vhdx` **except** `-golden.vhdx` and the key pair; `Remove-SmbShare susentorno-test-*`; `Remove-LocalUser susentorno-test`.

It runs at startup **and** teardown: startup makes a Ctrl-C'd run recoverable, teardown keeps a passing run from leaving a local account and three VMs on the machine.

**`known_hosts` is handled per-IP, never per-subnet.** An earlier draft swept every entry in the Internal- and Default-Switch subnets; that is both under-specified and over-destructive. `resolveForwardListenAddress` returns an address and no netmask (`src/runHosting/forwarder.ts`), so the Default Switch subnet is not derivable from it at all; a textual prefix match would miss hashed entries; and wiping a whole Default-Switch subnet would delete trust records for a developer's *other* Hyper-V VMs, which are not this tier's residue by any definition.

Instead, because the guest host key is baked into the golden image (above), the harness **knows** the key. For each guest, immediately after it becomes reachable and before any `ssh` runs against it:

```
ssh-keygen -R <ip>                              drop any stale entry for this exact IP
echo "<ip> <baked host public key>" >> known_hosts
```

and `ssh-keygen -R <ip>` again at teardown. Exact IPs only, no wildcards, and the entry is the key we generated rather than trust-on-first-use. This also closes a hole the subnet sweep created: production `ssh` runs with OpenSSH's default `StrictHostKeyChecking=ask`, so having *removed* the entry, the e2e run would have hit an interactive authenticity prompt with no answer available — its stdin carries only the SMB password, which `promptMasked` consumes.

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
beforeAll:  startProxyStack({ forward: { isolationName: 'test' } })
            reconcileShareAccount() remove-if-exists, then New-LocalUser
                                  susentorno-test with a random password
            createShare()         remove-if-exists, then New-SmbShare
                                  susentorno-test-vm-shared-linux
                                  → <envRoot>/vm-shared-linux, ReadAccess that account
                                  + an explicit NTFS read/execute ACE for it
            createTestGuest(role) New-VHD -Differencing -ParentPath <golden>
                                  New-VM -Generation 2, Secure Boot ON
                                  (Microsoft UEFI Certificate Authority)
                                  Set-VMComPort 1 → \\.\pipe\susentorno-test-<role>
                                  Start-VM, stream serial, wait for :22
                                  trustGuestHostKey(ip)
afterAll:   collectDiagnostics()  serial log + journal/route/resolver dumps
            untrustGuestHostKey(ip)
            destroyTestGuest()    Stop-VM -TurnOff, Remove-VM, delete child VHDX
            removeShare(), removeShareAccount(), stopProxyStack()
```

### `startProxyStack` needs a real options parameter

As written today, `startProxyStack(extraArgs)` hardcodes `--no-forward` in its argv and **appends** `extraArgs` after it (`tests/proxyStack.ts:155-172`), and unconditionally sets `ENVOY_HTTP_PORT`/`ENVOY_HTTPS_PORT` to 18080/18443 (`:119-123`). So `startProxyStack(['--isolation-name', 'test'])` would pass *both* flags — a combination spec 1 made an explicit error — and would still serve the wrong ports.

Neither can be changed globally: the eight `proxy-stack` files share this helper and depend on both behaviours, and `pnpm test` runs `test:proxy-stack` **before** `test:guest`, so `susentorno-test-internal` does not exist yet when they run.

So the helper gains an options object, defaulting to exactly today's behaviour:

```ts
interface ProxyStackOptions {
  /** Omit for --no-forward on 18080/18443 — today's default, and every proxy-stack caller. */
  forward?: { isolationName: string };
  extraArgs?: string[];
}
```

With `forward` present it drops `--no-forward`, passes `--isolation-name`, and leaves `ENVOY_HTTP_PORT`/`ENVOY_HTTPS_PORT` unset so the gateway takes its 80/443 defaults. This is test-support code, so the "no `src/` changes" scope constraint still holds — but the signature change touches every existing call site, which the plan should sequence as its own step.

### Reconcile before create, not just sweep at the edges

Each file creates and removes the same account and share names, and teardown is best-effort — so a failed `Remove-SmbShare` in the first file would make the second file's `New-SmbShare` fail on a name collision. The origin-blind sweep only runs once, in `globalSetup`, not between files. Both creators therefore **remove-if-exists first**: the same "safe to rerun" discipline, applied at file granularity.

### Share access needs an NTFS ACE, not just `-ReadAccess`

`New-SmbShare -ReadAccess` sets *share* permissions; effective access is the intersection of share and NTFS permissions. The share path is `<envRoot>/vm-shared-linux` — inside the repository checkout (`tests/testEnvRoot.ts`), whose inherited ACLs the suite does not control and which grant `susentorno-test` nothing. Without an explicit NTFS read/execute ACE for that account the guest authenticates successfully and *then* gets access denied — a failure that presents as a credential problem and is not one. The ACE is granted with the share and removed with it.

Three files, each self-contained, each starting its own `run-hosting`. `tests/proxy-stack/` already sets this precedent — eight files each start their own stack, and `githubInjection.test.ts:23` notes it picks ports "distinct from the other proxy-stack suites'." Here all three need 80/443, which sequential execution makes fine.

The share is created **per file, after `startProxyStack`**, not in `globalSetup`: `startProxyStack` calls `rmEnvRoot(envRoot)` and re-runs `init` (`tests/proxyStack.ts:126-132`), so a share created earlier would point at a directory deleted underneath it. The account goes with it rather than being global, keeping each file independently runnable; the origin-blind sweep covers the crash case either way.

### Reaching the guests

**IP discovery.** `getVmIpAddresses` (`src/guestSetup/hyperVQueries.ts:83-85`) `flatMap`s every reported address across every adapter, with no address-family or subnet filtering, and `waitForReachable` returns the first candidate that accepts a connection. During a switch transition that set can include a stale Default-Switch address or a link-local IPv6 address, so the harness **filters to IPv4 addresses inside the subnet it currently expects** before handing candidates to `waitForReachable`, and treats an empty filtered set as "KVP has not caught up yet" rather than as failure. Production tolerates the unfiltered list because a human supplies the address it actually uses; the harness has no such backstop.

`getVmIpAddresses` depends on the KVP daemon, and `kvpDaemon.ts:4-8` records that its service starts cleanly only once the guest reboots. In production the *user* types the first address and KVP supplies candidates afterwards; there is no user here, and KVP cannot be installed before the guest is reachable. So `linux-cloud-tools-virtual` is baked into the golden image. The fidelity cost is that `ensureKvpDaemon` in the e2e test hits the already-installed path — small, since its contract is "guarantee it is installed", and it still runs and still must succeed. A static MAC plus `Get-NetNeighbor` was the alternative (no fidelity cost, mirroring `harness/guest.sh:5-11`'s deterministic-MAC trick) but its data is best-effort: neighbour entries expire and only exist once the guest has sent traffic.

**Host-key trust.** `remoteExec.ts:52,58` spawns bare `ssh`/`scp` with no `-o` options, inheriting the developer's `~/.ssh/config` and `known_hosts`, under OpenSSH's default `StrictHostKeyChecking=ask`. That means **both** failure directions matter: a *stale* entry for a recycled IP after a golden rebuild gives a hard `REMOTE HOST IDENTIFICATION HAS CHANGED`, and a *missing* entry gives an interactive authenticity prompt that the e2e run cannot answer — its piped stdin carries only the SMB password, which `promptMasked` consumes.

The per-IP `trustGuestHostKey` / `untrustGuestHostKey` pair above handles both, and it can only do so because the guest's host key is generated on the Windows side and baked into the image, so the harness knows it rather than discovering it. `phases` and `fresh` build their own `RemoteExec` and pass `-o StrictHostKeyChecking=no -o UserKnownHostsFile=…` explicitly, as `harness/lib.sh`'s `SSH_OPTS` does today, so only the e2e path depends on the real `known_hosts` at all.

Redirecting `USERPROFILE`/`HOME` for the spawned child was the alternative; it leans on Win32-OpenSSH resolving `~` from `%USERPROFILE%`, which is true but not documented firmly enough to be load-bearing under a 20-minute test.

**Key delivery.** The e2e test runs the real `createSshRemoteExec`, so `ssh` must *find* the private key — and the harness cannot write `IdentityFile` into the developer's `~/.ssh/config`, nor name the key `~/.ssh/id_ed25519` and clobber theirs. `ssh-agent` is the only non-invasive answer: `globalSetup` runs `ssh-add` on the harness key from `.image-cache/`, teardown runs `ssh-add -d`. `ssh` tries agent identities by default, so no production code changes and no file is edited.

**The preflight must probe, not merely check a service.** `remoteExec.ts:54,61` resolves `ssh` and `scp` as bare names through `PATH`, and a Windows box commonly has two OpenSSH installations — the Windows one (which talks to the `ssh-agent` *service*) and Git for Windows' (which expects `SSH_AUTH_SOCK`). Confirming the service is running proves nothing about whether the `ssh` that production actually invokes can see the identity. So `ensureSshAgentIdentity` resolves `ssh-add` the same way production resolves `ssh` — bare name through `PATH` — adds the key, then runs `ssh-add -l` and asserts the fingerprint appears. It fails fast with a fix-it message, the treatment `checkWslDhcpPortIgnored` gives its prerequisite today. A user `~/.ssh/config` that restricts accepted identities (`IdentitiesOnly yes` scoped to the test subnet) can still defeat this; the probe cannot detect that, and it is called out in the risks.

## 3. The three test files

### One refinement to the brief's decision 3

The brief has `phases` driving `runPostScripts` as well. It cannot: both post-scripts depend on pre-scripts `phases` does not run — `02-apply-home-jq-transforms.sh` needs node (from `03-install-tools.sh`) and `01-auth-config.sh` needs `git` (from `01-apt-packages.sh`). Today's WSL harness hides this by apt-installing `nodejs` into its image, and `seed/user-data:13-17` admits exactly that. Putting node back would undo what the e2e test exists to prove.

So `phases` drives the **four** operations that need intermediate observation and stops; `runPostScripts` is covered by `e2e`, where its dependencies genuinely exist. This is new information rather than a reversal — the decision predates spec 1's template trim.

### `phases.test.ts` — `susentorno-test-phases`, boots on the Default Switch

Drives the modules directly: `mountShare` → `runPreScripts` → `isolateVmToSwitch` → `mountShare`.

The second `mountShare` is the prize. It re-points the same mount at a different host IP (`defaultSwitchHostIp` → `internalSwitchHostIp`), which is exactly the condition `mountShare.ts:76-90` describes — a live autofs mount against a now-unreachable IP, where "merely stat'ing it (which `mkdir -p` does) trips ENODEV."

**What is new here is live coverage, not coverage.** The brief called `mountShare`'s `cifs-utils` install, `/etc/susentorno-share.cred`, the fstab entry, and the stale-autofs unwind "completely untested today"; that is wrong, and this spec repeated it before checking. `tests/unit/guestSetup/mountShare.test.ts` has eleven tests driving all of it against a fake `RemoteExec`, including the stale-unwind regression at `:207`, and `tests/unit/guestSetup/fstabLine.test.ts:13` asserts the exact `x-systemd.automount` line. What no test does today is *execute* those commands against a real Ubuntu CIFS client, a real systemd automount unit, and a real Windows SMB server — the orchestration is proven, its effect on a live system is not. The 9p `virtfs` mount at `harness/guest.sh:44` shares nothing with that path, so the live half is genuinely absent.

`runPreScripts` is filtered to `configure-network` only, as today — running the full set is `e2e`'s job and paying for it twice would be the dominant cost in the tier. Note that `configure-network`'s Firefox branch (`nn-configure-network.sh:40-58`) does not fire in `phases`, because Firefox is not installed and not stubbed there; the Firefox assertion moves to `e2e` for the same reason the others did.

### `e2e.test.ts` — `susentorno-test-e2e`, boots on the Default Switch

Stages `github-config.txt` with `GITHUB_PLACEHOLDER_PAT`, shadows `gh` at `/usr/local/bin/gh`, then spawns the real command with the password piped in — the mechanism [ADR-0022](../../adr/0022-promptmasked-releases-stdin-explicitly.md) exists to guarantee:

```ts
execa('node', [cliPath, 'setup-guest-unix',
  '--isolation-name', 'test', '--vm-name', 'susentorno-test-e2e',
  '--guest-address', ip, '--guest-username', 'vmtest',
  '--share-name', 'susentorno-test-vm-shared-linux',
  '--share-account', 'susentorno-test'],
  { cwd: envParent, input: `${sharePassword}\n` });
```

Every spec-1 flag in one call, with `vmtest` the guest username the autoinstall `identity` created and `susentorno-test` the Windows share account. It runs the **real, untrimmed** script set: real `apt upgrade`, real pnpm, real Codex/Claude/Pi installers, real `runPostScripts`. Assertions land on the outcome — the placeholder credential symlinks, git identity, `hasCompletedOnboarding` — plus one re-run of the transform applier against a pre-seeded `~/.claude.json` to cover the merge-without-clobbering case.

**The Firefox `policies.json` merge lands here, not in `phases`.** `nn-configure-network.sh:49,51` shells out to `jq`, which `01-apt-packages.sh:6` installs — so the assertion belongs with the other tests that depend on a pre-script's output (git for `01-auth-config.sh`, node for the home transforms). The stub Firefox and a pre-seeded `/etc/firefox/policies/policies.json` are staged over SSH before the command runs, and the merge is asserted afterwards. `jq` is nonetheless baked into the golden image as well, so a future edit that makes `configure-network` need it unconditionally does not fail obscurely in `phases`.

**Why `gh` is shadowed.** `post-scripts/01-auth-config.sh` hard-exits without `github-config.txt` (`:10-13`) and then runs `gh auth login --with-token` against real GitHub (`:25`). No clean-machine test can supply a valid GitHub token. `/usr/local/bin` precedes `/usr/bin`, so the stub shadows the real `gh` that `01-apt-packages.sh` installs. Today's suite already does this (`guest.test.ts:211-228`); it is one well-understood substitution.

Considered and rejected: pointing `api.github.com` at `mockUpstream` via `--upstream-override`, as `api.anthropic.com` already is (`proxyStack.ts:166-167`). It would exercise GitHub credential injection from inside a guest, which nothing does — but `gh auth login` validates the token by parsing `/user` and reading `X-Oauth-Scopes`, so the mock would have to imitate a real API and would break whenever a third-party CLI's internals change.

Also considered and rejected: `e2e` running only `configure-network` and the post-scripts, as today's suite does. It is fast, but node returns to the golden image and `mountShare`'s `cifs-utils` install becomes the tier's only real `apt` — so the tier stops proving the thing it exists to prove.

**On the dpkg lock, precisely:** the golden image *masks* `apt-daily` and `unattended-upgrades`, so the tier **avoids** the race rather than covering it. An earlier draft claimed the e2e test "exercises" it; that contradicted the image design. What e2e does cover is real `apt` execution shortly after boot with those timers masked. Genuine lock-contention recovery — waiting for or retrying a held lock — is covered nowhere, and the product does not currently attempt it, so there is nothing to test until it does.

### `fresh.test.ts` — `susentorno-test-fresh`, created **on the Internal switch**

Boots and asserts, *before anything runs*, that DHCP alone configured it; then runs `configure-network` and asserts nothing changed. It must never have touched the Default Switch, which is why `phases` structurally cannot prove this.

It needs the script, and unlike today's guest it has no 9p share already mounted by fstab (`harness/seed/user-data:63-64`) — `cifs-utils` is deliberately absent from the golden image. So after the pre-configuration DHCP assertions, `fresh` calls `mountShare` itself with the internal-switch host IP. That is a happy accident rather than a cost: it makes `fresh` the one place `mountShare`'s `apt-get install -y cifs-utils` runs **in the isolated phase**, proving `apt` works through the proxy on a guest that has never had general network access. `archive.ubuntu.com:80` is allow-listed in the tier's policy fixture, so this exercises the `ALLOW HTTP` path end to end.

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
| `:230` firefox `policies.json` merge | **e2e** — `nn-configure-network.sh:49,51` needs `jq` from `01-apt-packages.sh`; firefox still stubbed |
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
| — | **new in phases**: live cred-file mode and ownership, a live automount unit, the stale-autofs unwind against a real CIFS client |
| — | **new in fresh**: `apt` reaching `archive.ubuntu.com` through the proxy from a never-un-isolated guest |

Net: of 23 assertions, 17 carry over, 3 relocate to `proxy-stack`, and 3 are deleted; 3 new ones are added, leaving 20 in the guest tier — and what remains asserts the product rather than the harness.

**The three relocated tests are rewritten, not merely deleted.** `tests/proxy-stack/stackLifecycle.test.ts` covers the blue/green swap and token rotation, but **not** the allowlist-edit restart, the log-follow re-attachment, or unique-tracking reset/preserve. They move to `proxy-stack` driving traffic at `127.0.0.1:HTTPS_PORT` instead of from a guest. The cost is real if small: that traffic currently originates in a guest, so "the follow re-attached" is today proven end-to-end through the forwarder. The benefit is three fewer tests — including two with 300-second timeouts — on the expensive tier, and it corrects a tier placement `testing.md:29-36` already forbids.

## 4. Modules

```
tests/
  checkElevated.ts          ← moved up from tests/host-network/ (now shared by two tiers);
                              tests/host-network/globalSetup.ts's import updates with it
  checkGatewayPortsFree.ts  ← strict variant; checkNoRunningProxy stays for proxy-stack
  sshAgentIdentity.ts       add the key, then ssh-add -l and assert the fingerprint
  guest/
    globalSetup.ts          exports named setup AND teardown
    phases.test.ts  e2e.test.ts  fresh.test.ts
    guestExec.ts            harness RemoteExec (ssh with explicit -o options)
    harnessKeys.ts          generate/locate the client and guest-host keypairs
    knownHosts.ts           trustGuestHostKey / untrustGuestHostKey, per exact IP
    testShare.ts            local account + SMB share + NTFS ACE, reconcile/remove
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
| `unit` | Stamp hashing (same inputs → same stamp; **every** seed input moves it), `grub.cfg` generation, the `known_hosts` add/remove round trip against a fixture file, the IPv4-and-expected-subnet candidate filter, and every new PowerShell command builder and output parser |
| `guest` | The three files above, against real Hyper-V |
| `proxy-stack` | The three relocated lifecycle tests |

**One trap in the share-account rename.** `tests/unit/guestSetup/setupAnswers.test.ts:59` asserts the prompt default and **must** change. The eleven occurrences in `tests/unit/guestSetup/mountShare.test.ts` must **not**: every one passes `accountName` explicitly as an arbitrary fixture value, so they are testing `mountShare`, not the default, and rewriting them would be churn that obscures the real change. Spec 1 hit the same distinction with `listScripts.test.ts` and `runPreScripts.test.ts` during the renumbering and called it out for the same reason — synthetic fixtures that merely resemble a production name must not be "fixed".

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
| [ADR-0023](../../adr/0023-cli-owned-host-network-with-real-hyperv-tier.md) | Consequence: the isolation name now also scopes the share account (for every installation, not just tests), plus the test tier's VM names and SMB share name. Its `:15` mention of `setup-guest-unix-isolation-checklist.md` stays — it is an accurate record of a rejected option's reasoning at the time. |
| `CONTEXT.md:43` | **Isolation name** amended past "the Internal switch and its firewall rules" to cover the guest VMs, share account, and share names it now derives |
| `testing.md` | Guest-tier rows rewritten (`:13`, `:25`, `:52`); the dangling `setup-guest-unix-isolation-checklist.md` link removed, since the behaviour it stood in for — VM stop/reassign/start, the elevation check, the `run-hosting` readiness check — is now automated |
| `development.md` | WSL2/KVM/mirrored-networking/`ignoredPorts=67`/`setup-wsl.sh` prerequisites deleted; elevated shell, Hyper-V, and a running `ssh-agent` documented |
| `setup-environment.md` | The share-account rename reaches `:5`, `:25-26`, `:29`, `:31`, `:41-42`, `:51`, `:53` — the `New-LocalUser`/`New-SmbShare` snippets users copy verbatim, the `secpol.msc` deny-logon step, and the two paragraphs of security rationale that name the account |
| `setup-guest.md` | `:117` (the prompt-defaults sentence), `:162` (the `.cred` file's `username=` line), `:191` (`cmdkey /add … /user:`) |
| `src/commands/setupGuestUnix.ts:118` | The `--share-account` help text names the old default in prose |

**Isolation name** (`CONTEXT.md`, replacing the current definition): *The name that selects which parallel set of susentorno host objects a command acts on — the Internal switch and its firewall rules, the share account, and, for the test tiers, the guest VMs and SMB share derived from the same name — so a sandboxed installation can coexist with the default one on the same machine. Omitting it selects the unnamed default.* _Avoid_: sandbox name, test name.

Spec 1 wrote the narrower definition and said it would be amended here if spec 2 extended the term. It does, so it is. The share account is called out separately from the test-tier objects because it is derived for *any* installation, not only a test one — it is the first place the isolation name reaches something a real user creates by hand.

## 7. Risks

Recorded rather than smoothed over.

1. **Will the build VM boot the installer disk at all?** The extracted-ISO-on-an-ESP layout is the load-bearing novelty here, and nothing downstream matters if UEFI will not boot it. Spike this first, before any other implementation work: build the installer VHDX, boot a throwaway Gen 2 VM, and confirm GRUB reaches the menu entry. Related unknowns settle at the same time — whether casper locates its squashfs on a non-ISO9660 volume, and whether the `/casper/vmlinuz` and `/casper/initrd` paths are right for 26.04 live-server.
2. **FAT32's 4 GB per-file limit** on the installer disk. Fine at a 2.7 GB ISO today, with headroom that shrinks each release. It fails loudly rather than subtly.
3. **Autoinstall schema specifics on 26.04** — `storage.match.size: largest`, the `identity` block, and every `curtin in-target` invocation want confirming against the real installer rather than asserted here.
4. **Named-pipe COM port timing** — Hyper-V creates the pipe only while the VM runs, so the reader must retry-connect and tolerate losing the earliest bytes.
5. **Runtime is a real cost** — ~15–25 min steady state, ~20–30 min more on a cold cache, with the e2e test's install traffic the variable part.
6. **`ssh-agent` reachability**, not merely availability: two OpenSSH installations on `PATH` (Windows' and Git for Windows') use different agent transports, and a user `~/.ssh/config` with `IdentitiesOnly yes` covering the test subnet would defeat agent identities entirely. The add-then-list probe catches the first; nothing catches the second short of a full connection test.
7. **`startProxyStack`'s signature change touches every `proxy-stack` call site.** Low risk but wide, and it must land without changing those callers' behaviour.

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
