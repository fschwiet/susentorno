# Automate Ubuntu guest setup via SSH

## Purpose

setup-guest.md §2–3 walks the user through hand-typing a heredoc (credentials file, `/etc/fstab` line, mount) and then `cd`-ing into `pre-scripts/` to run every numbered script in order, once for the Ubuntu guest. It's copy-paste-heavy and error-prone (escaping, remembering which host IP goes where), and has to be repeated per guest.

This change adds `susentorno setup-guest-unix`, a Host-side CLI command that drives that same sequence over SSH instead of the user typing it by hand. It covers Ubuntu only — Windows-guest automation is a separate future effort (PowerShell remoting instead of SSH, different prompts).

## Scope

Automates from right after `openssh-server` is installed on the Guest through the end of `pre-scripts/`. Stops before network isolation: isolating the VM's adapter, rebooting, and running `post-scripts/` stay manual, as documented today. Isolation already changes the Guest's reachable address and has its own timing uncertainty (setup-guest.md's documented ~5 minute DHCP wait), so it's a distinct follow-up increment rather than folded into this one.

Still manual: installing `openssh-server` (and, until this change, `cifs-utils`) at the Hyper-V console — there is no network path into the Guest before `openssh-server` exists. `cifs-utils` no longer needs to be installed by hand; once SSH is reachable, this command installs it remotely as its first step.

## Command

`susentorno setup-guest-unix`, run from the environment directory on the Host, same invocation pattern as `init`, `run-hosting`, etc. Takes no required flags — every value it needs is either prompted for interactively or auto-discovered (see below). Two optional flags exist purely as overrides for a non-default Hyper-V switch name, mirroring `host-allow-vm-inbound.ps1`:

```
--adapter-alias <name>       Internal-switch adapter (default: "vEthernet (susentorno-internal)")
--nat-adapter-alias <name>   Default-Switch adapter (default: "vEthernet (Default Switch)")
```

## Inputs

Prompted interactively, in order, each blocking on the previous:

| Prompt | Default | Notes |
| --- | --- | --- |
| Guest address (hostname or IP) | none | first-use info, nothing to suggest |
| Guest username | none | first-use info |
| SMB share name | `vm-shared-linux` | Enter accepts the default; override if this environment used a custom name (setup-environment.md §"Enable shared drives") |
| Share account name | `susentorno-share` | same as above |
| SMB share password | none, masked | the `susentorno-share` account's password from setup-environment.md. No masked-prompt helper exists in this codebase today (`write-github-config`'s token prompt is plain, unmasked) — this adds a small raw-mode readline helper. The value is piped directly into the remote `ssh` command's stdin, never interpolated into a command string, logged, or otherwise held longer than needed. |

**Not prompted** — auto-discovered, since these are derived infrastructure state, not setup decisions the user makes per guest:

- **Default-Switch host IP** — used as the mount's cifs source, since mounting happens during the pre-isolation/NAT phase (setup-guest.md: "Use the Default Switch host IP in that fstab line during the NAT phase"). Resolved via the existing `resolveForwardListenAddress()` helper in `src/runHosting/forwarder.ts`, called with the NAT adapter name instead of its current default — the helper is already parameterized by adapter name, so this is a call-site change, not new lookup logic.
- **Internal-switch host IP** — the `<host-ip>` argument the network-configuration script still validates (see below). Resolved via the same helper, its existing default adapter name.
- If either adapter has no IPv4 address (helper returns `null`), the command exits with a clear error before prompting for anything else — matching `run-hosting`'s existing behavior when `resolveForwardListenAddress()` comes back empty.

## SSH mechanism

Every remote step shells out to the OS `ssh` client via `execa` (no new SSH library dependency), stdio inherited so the Guest's own login/host-key/sudo prompts appear directly in the user's terminal — this command never handles the Guest login password itself. Each invocation passes `-t` to force pseudo-terminal allocation: without it, a remote `sudo` has no controlling tty to prompt against and fails with "no tty present and no askpass program specified" on a default Ubuntu `sudoers` config, even though stdio is otherwise inherited correctly. This mirrors `tests/guest/harness/guest.sh`'s existing `gexec`, which already drives a guest the same way.

## Mount step

Replaces setup-guest.md §2's manual block. Each step runs over SSH and is idempotent, so a retry after a partial failure (see "Failure handling") is safe:

1. `sudo apt-get install -y cifs-utils` — newly automated; previously bundled into the manual `apt install openssh-server cifs-utils` line.
2. Write `/etc/susentorno-share.cred` (mode 600) via `sudo tee`, with `username=<share account>\npassword=<share password>\n` piped through the local `ssh` process's stdin rather than embedded in the remote command string.
3. `sudo mkdir -p /mnt/<share-name>`.
4. Append the cifs line to `/etc/fstab` **only if not already present**: `grep -qF '/mnt/<share-name>' /etc/fstab || echo '...' | sudo tee -a /etc/fstab`. Today's hand-typed instructions use plain `tee -a`, which would duplicate the line on a second run — this fixes that latent idempotency gap as part of automating the step (a retried automated run is far more likely to hit this than a careful manual run).
5. `sudo systemctl daemon-reload && sudo mount -a`.

As with pre-scripts (below), the command stops at the first step that exits non-zero — including a failed SSH connection itself (wrong address, wrong username, host unreachable) — and reports it rather than proceeding to later steps.

The mount source is `//<default-switch-host-ip>/<share-name>`, matching setup-guest.md's existing fstab line, just with the share name and host IP substituted from the resolved inputs. `/mnt/<share-name>` (not a fixed `/mnt/vm-shared-linux`) is safe because the numbered scripts already compute their own paths relative to `BASH_SOURCE` rather than assuming an absolute mount point.

## Running pre-scripts

The command reads `pre-scripts/*.sh` from the environment's local `vm-shared-linux/pre-scripts/` directory (already on the Host filesystem — no need to `ls` remotely), sorted by the numeric prefix `update-shares` already assigned them. This is not a hardcoded script list: any custom pre-scripts woven in via `.susentorno/pre-scripts/` (README's "Customizing setup scripts") run in their already-resolved position automatically.

Each script runs over SSH from `/mnt/<share-name>/pre-scripts/`, in order, output streamed live to the terminal (via the same inherited-stdio `ssh` invocation described above).

- **Argument handling**: a script whose filename contains `configure-network` (matching on the descriptive remainder `weaveScripts.ts` preserves through renumbering, not the numeric prefix, which varies with how many custom scripts are woven in) gets the Internal-switch host IP as its sole argument — the one documented special case today (setup-guest.md: "it is the Internal-switch host IP from setup-machine.md"). Every other script runs with no arguments. A custom pre-script that needs its own arguments isn't supported by this automation in this increment; it's a documented limitation, not a silent failure — such a script still runs (with no args) and can fail loudly if it requires one, same as it would running unmodified today.
- **Failure handling**: stop at the first non-zero exit, print which script failed and its output, exit non-zero. Because the mount step is idempotent (above) and the existing numbered scripts are already idempotent in practice (`apt install`, `mkdir -p`, `update-ca-certificates`, etc.), simply fixing the Guest-side issue and rerunning the whole command from the top is safe and is the documented recovery path — no separate "resume from step N" mechanism is needed.

## Testing

- **Unit tests** (`tests/unit/`, `pnpm test:unit`): the pure logic — building the ordered script list from a directory listing, the idempotent fstab-line command, the ssh/scp argv construction — with `execa` mocked, following existing patterns in this codebase.
- **`tests/guest/`**: already drives a real QEMU Ubuntu guest over SSH (`guest.sh`'s `gexec`) and already runs `pre-scripts/05-configure-network.sh` directly (see `guest.test.ts`'s "provisioning during the setup phase" block). This gets new coverage for the orchestration path itself: running the full ordered `pre-scripts/` sequence through the new command's script-selection and argument logic, and the stop-on-failure / safe-rerun behavior, against that real guest.
- **Known gap**: the SMB-specific mount step (`cifs`, `/etc/fstab`, the credentials file) can't be exercised in `tests/guest/`, since its harness shares files into the QEMU guest via 9p virtfs, not a real SMB server. That step needs manual verification against a real Hyper-V guest — a residual fidelity gap in the same spirit as the ones ADR-0010 already documents for this harness.

## `pnpm test` grows the guest tier

Unrelated to `setup-guest-unix` itself, but bundled into this change since it directly affects how the new `tests/guest/` coverage above gets run: `.github/workflows/ci.yml` is deleted (it has not been passing, and its `ubuntu-latest` runner cannot run the WSL2/QEMU guest harness regardless — `wsl.exe` doesn't exist on Linux). With no CI depending on `pnpm test`'s current tier selection, the guest tier is folded into the default local pipeline:

- `package.json`'s `"test"` script gains `&& pnpm test:guest` after `test:proxy-stack`.
- **testing.md**: the "Default verification pipeline" section is rewritten — `pnpm test` now runs all four tiers (`unit`, `cli`, `proxy-stack`, `guest`); the "run it separately... when changing `templates/vm-shared-linux/`" guidance is removed since it always runs as part of `pnpm test` now.
- **development.md**: the "Verification pipeline" table's step 8 row drops the "not part of `pnpm test`" caveat; "Run the full pipeline (steps 1–7)" becomes "steps 1–8". The existing WSL2 setup instructions are unchanged in content, but are now a prerequisite for any full `pnpm test` run rather than an opt-in extra for guest-tier work specifically.

## Out of scope (future increments)

- Windows Guest automation (PowerShell remoting, different credential/prompt handling).
- Automating network isolation, reboot, and `post-scripts/` — the address change and DHCP-wait uncertainty across isolation deserve their own design.
- A persisted Guest registry (remembering address/username across commands) — every prompt in this design is asked fresh each run, by choice (see the design discussion this spec was built from), so there's no config file to introduce, keep in sync, or go stale when a VM is recreated.
