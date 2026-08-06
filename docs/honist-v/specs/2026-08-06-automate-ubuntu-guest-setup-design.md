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
| SMB share password | none, masked | the `susentorno-share` account's password from setup-environment.md. No masked-prompt helper exists in this codebase today (`write-github-config`'s token prompt is plain, unmasked) — this adds a small raw-mode readline helper. Never interpolated into a command string or logged; see "Mount step" for how it's delivered to the Guest. |

**Not prompted** — auto-discovered, since these are derived infrastructure state, not setup decisions the user makes per guest:

- **Default-Switch host IP** — used as the mount's cifs source, since mounting happens during the pre-isolation/NAT phase (setup-guest.md: "Use the Default Switch host IP in that fstab line during the NAT phase"). Resolved via the existing `resolveForwardListenAddress()` helper in `src/runHosting/forwarder.ts`, called with the NAT adapter name instead of its current default — the helper is already parameterized by adapter name, so this is a call-site change, not new lookup logic.
- **Internal-switch host IP** — the `<host-ip>` argument the network-configuration script still validates (see below). Resolved via the same helper, its existing default adapter name.
- If either adapter has no IPv4 address (helper returns `null`), the command exits with a clear error before prompting for anything else — matching `run-hosting`'s existing behavior when `resolveForwardListenAddress()` comes back empty.

## SSH mechanism

Every remote step shells out to the OS `ssh` client via `execa` (no new SSH library dependency). **Every** invocation — mount step and every pre-script — uses the same shape: `-t` (pseudo-terminal allocation) and stdio fully inherited, so the Guest's own login/host-key/sudo prompts appear directly in the user's terminal and this command never handles the Guest login password itself. Without `-t`, a remote `sudo` has no controlling tty to prompt against and fails with "no tty present and no askpass program specified" on a default Ubuntu `sudoers` config, even though stdio is otherwise inherited correctly. Keeping every invocation uniform (no invocation ever needs its stdin free for programmatic input — see "Mount step" for how the one secret-bearing step avoids that) is deliberate: it means there's exactly one remote-execution shape to reason about and test, not two.

The remote command run in each invocation is `bash -ic '<command>'`, not a bare command string. Ubuntu's default `~/.bashrc` returns immediately for a non-interactive shell (`case $- in *i*) ;; *) return;; esac`), so a plain `ssh host 'cmd'` — even with `-t` — skips it, and a PATH change one pre-script makes (`02-install-pnpm.sh` explicitly instructs "open a new terminal" before `03-install-tools.sh` so `pnpm` is on PATH, and `03` says the same for `claude`) would not be visible to the next script's separate `ssh` invocation. `-i` forces bash to treat itself as interactive regardless of tty/stdin detection, so `~/.bashrc` runs and each script sees the previous one's PATH changes, matching what "open a new terminal" achieves when done by hand. The minor cosmetic cost — an interactive shell's own prompt/banner text mixing into the streamed output — is harmless, since nothing here parses stdout for control flow; only the process exit code is examined (see "Failure handling").

For testability, the actual "run this command on the Guest and get its exit code" step is an injectable function, not a hardcoded call to `execa('ssh', ...)`. Production wires it to the `ssh -t`/`bash -ic` invocation above; `tests/guest/` wires it to the existing harness's own `gexec` (which uses key auth and no `-t`, since its QEMU guest has passwordless sudo — see "Testing"); unit tests wire it to a mock. The ordering, argument-selection, and stop-on-failure logic (below) is written once against this seam and exercised by all three.

This mirrors `tests/guest/harness/guest.sh`'s existing `gexec`, which already drives a guest this way (minus `-t`, which its passwordless-sudo guest doesn't need).

## Mount step

Replaces setup-guest.md §2's manual block. Each step runs over SSH and is idempotent, so a retry after a partial failure (see "Failure handling") is safe:

1. `sudo apt-get install -y cifs-utils` — newly automated; previously bundled into the manual `apt install openssh-server cifs-utils` line.
2. Deliver the credentials file without ever needing the `ssh` invocation's stdin for anything but the interactive prompts described above:
   - Write `username=<share account>\npassword=<share password>\n` to a local temp file (mode 600, in the OS temp dir, deleted in a `finally` regardless of outcome).
   - `scp` that file to a temp path in the Guest's home directory (same `-t`-equivalent interactive auth as every other step — `scp` prompts exactly like `ssh` does).
   - `sudo install -m 600 -o root -g root <remote-temp-path> /etc/susentorno-share.cred`, then remove the remote temp file. `install -m 600` sets the file's final permissions atomically at creation, unlike `sudo tee` (which leaves a new file at the process's default `umask`-derived mode, commonly `0644` — today's hand-typed instructions cover this with a separate `sudo chmod 600` right after the `tee`; folding it into one `install` call here removes the gap between "file exists" and "file is locked down" entirely rather than just shortening it).
3. `sudo mkdir -p /mnt/<share-name>`.
4. Replace (not just append) the cifs line in `/etc/fstab`, keyed on the mount point rather than on exact line content: delete any existing line whose second field is `/mnt/<share-name>` (`sudo sed -i '\#[[:space:]]/mnt/<share-name>[[:space:]]#d' /etc/fstab`), then append the correct line fresh. A same-content rerun and a rerun after the Default-Switch host IP changed (that address is regenerated across host reboots, per setup-machine.md) both converge on the same correct line; today's hand-typed instructions use plain `tee -a`, which only ever appends and would both duplicate the line on a same-content rerun and leave a stale source IP in place after a host reboot.
5. `sudo systemctl daemon-reload && sudo mount -a`.

As with pre-scripts (below), the command stops at the first step that exits non-zero — including a failed SSH connection itself (wrong address, wrong username, host unreachable) — and reports it rather than proceeding to later steps.

The mount source is `//<default-switch-host-ip>/<share-name>`, matching setup-guest.md's existing fstab line, just with the share name and host IP substituted from the resolved inputs. `/mnt/<share-name>` (not a fixed `/mnt/vm-shared-linux`) is safe because the numbered scripts already compute their own paths relative to `BASH_SOURCE` rather than assuming an absolute mount point.

**Quoting**: the share name, account name, and guest username are user-supplied and end up inside remote command strings that the Guest's shell parses. Each is POSIX-single-quoted (embedded `'` escaped as `'\''`) wherever it's interpolated, the same way a shell script would guard against metacharacters in an untrusted argument — the SSH argv itself never goes through a *local* shell (`execa` avoids that), but the remote command string is still guest-shell-interpreted, so local argv-safety alone isn't sufficient.

## Running pre-scripts

The command reads `pre-scripts/*.sh` from the environment's local `.susentorno/vm-shared-linux/pre-scripts/` directory (already on the Host filesystem — no need to `ls` remotely), sorted by the numeric prefix `update-shares` already assigned them. This is not a hardcoded script list: any custom pre-scripts woven in via `.susentorno/pre-scripts/` (README's "Customizing setup scripts") run in their already-resolved position automatically. Each filename is quoted the same way as the other user-influenced values above when it's interpolated into the remote command string.

Each script runs over SSH from `/mnt/<share-name>/pre-scripts/`, in order, output streamed live to the terminal (via the same `bash -ic`/inherited-stdio `ssh` invocation described above, which is also what makes each script see the previous one's PATH changes).

- **Argument handling**: a script whose descriptive remainder — the part `weaveScripts.ts` preserves through renumbering, i.e. its filename with the `NN-`/`nn-` prefix and extension stripped — is **exactly** `configure-network` gets the Internal-switch host IP as its sole argument; this is the one documented special case today (setup-guest.md: "it is the Internal-switch host IP from setup-machine.md"). Matching on the exact remainder, not a substring, avoids a custom script like `preconfigure-network-tools.sh` (remainder `preconfigure-network-tools`) being mistaken for it. Every other script runs with no arguments. A custom pre-script that needs its own arguments isn't supported by this automation in this increment; it's a documented limitation, not a silent failure — such a script still runs (with no args) and can fail loudly if it requires one, same as it would running unmodified today. If more than one script resolves to the exact remainder `configure-network` (a custom script deliberately reusing that name), the command fails fast before running anything, rather than guessing which one is the built-in.
- **Failure handling**: stop at the first non-zero exit, print which script failed and its output, exit non-zero. Because the mount step is idempotent (above) and the built-in numbered scripts are already idempotent in practice (`apt install`, `mkdir -p`, `update-ca-certificates`, etc.), fixing the Guest-side issue and rerunning the whole command from the top is safe for the built-ins and is the documented recovery path — no separate "resume from step N" mechanism is needed. This idempotent-rerun guarantee covers the built-in scripts only: a woven-in custom pre-script's idempotency is not something this command can verify, and is the same responsibility the user already has today when authoring one (README's "Customizing setup scripts" documents the mechanism but makes no idempotency promise). A custom script that isn't safe to rerun is a pre-existing risk of using the customization mechanism at all, not a new one this automation introduces — worth a one-line callout in the command's own `--help`/output so it isn't a surprise.

## Testing

- **Unit tests** (`tests/unit/`, `pnpm test:unit`): the pure logic — building the ordered script list from a directory listing, the idempotent fstab-line command, the ssh/scp argv construction — with `execa` mocked, following existing patterns in this codebase.
- **`tests/guest/`**: already drives a real QEMU Ubuntu guest over SSH (`guest.sh`'s `gexec`) and already runs `pre-scripts/05-configure-network.sh` directly (see `guest.test.ts`'s "provisioning during the setup phase" block). This gets new coverage for the orchestration logic itself — ordering, exact-remainder argument selection, and stop-on-failure — run against that real guest through the injectable-transport seam (above), wired to the harness's existing `gexec` rather than the production `ssh -t`/`bash -ic` invocation (the harness guest uses key auth and passwordless sudo, so it doesn't need `-t`, and doesn't exercise the interactive-prompt path at all — that part stays a manual check).
- **Known gap**: the SMB-specific mount step (`cifs`, `/etc/fstab`, the credentials file) can't be exercised in `tests/guest/`, since its harness shares files into the QEMU guest via 9p virtfs, not a real SMB server. That step needs manual verification against a real Hyper-V guest — a residual fidelity gap in the same spirit as the ones ADR-0010 already documents for this harness.

## `pnpm test` grows the guest tier

Unrelated to `setup-guest-unix` itself, but bundled into this change since it directly affects how the new `tests/guest/` coverage above gets run: `.github/workflows/ci.yml` is deleted (it has not been passing, and its `ubuntu-latest` runner cannot run the WSL2/QEMU guest harness regardless — `wsl.exe` doesn't exist on Linux). With no CI depending on `pnpm test`'s current tier selection, the guest tier is folded into the default local pipeline:

- `package.json`'s `"test"` script gains `&& pnpm test:guest` after `test:proxy-stack`.
- **testing.md**: the "Default verification pipeline" section is rewritten — `pnpm test` now runs all four tiers (`unit`, `cli`, `proxy-stack`, `guest`); the "run it separately... when changing `templates/vm-shared-linux/`" guidance is removed since it always runs as part of `pnpm test` now.
- **development.md**: the "Verification pipeline" table's step 8 row drops the "not part of `pnpm test`" caveat; "Run the full pipeline (steps 1–7)" becomes "steps 1–8". The existing WSL2 setup instructions are unchanged in content, but are now a prerequisite for any full `pnpm test` run rather than an opt-in extra for guest-tier work specifically.

## Documentation

setup-guest.md's Ubuntu path (§2–3) is rewritten to lead with `susentorno setup-guest-unix` as the normal path, covering everything from "openssh-server is installed" through the end of `pre-scripts/`. The manual heredoc/fstab block and the per-script `cd`-and-run instructions move to a "manual fallback" callout rather than being deleted outright — useful for diagnosing a failure or for anyone who wants to see exactly what the command does. Nothing about §1 (VM creation) or §4 (isolation) changes, since neither is in scope here.

## Out of scope (future increments)

- Windows Guest automation (PowerShell remoting, different credential/prompt handling).
- Automating network isolation, reboot, and `post-scripts/` — the address change and DHCP-wait uncertainty across isolation deserve their own design.
- A persisted Guest registry (remembering address/username across commands) — every prompt in this design is asked fresh each run, by choice (see the design discussion this spec was built from), so there's no config file to introduce, keep in sync, or go stale when a VM is recreated.
