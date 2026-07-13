# vm-shared-windows: Windows guest provisioning kit

**Date:** 2026-07-13
**Status:** Approved design, ready for implementation planning

## Goal

Provide a `vm-shared-windows` provisioning kit that does for a **Windows guest VM** what
`templates/vm-shared/` does for an Ubuntu guest: install the toolset and coding agents, trust
the proxy CA, place the placeholder credential, and route all guest egress through the host
Envoy proxy. The motivating use case is running the claude/codex coding agents against
**Windows-specific work** (.NET, PowerShell, Windows software) inside an isolated VM.

The host stays Windows + VMware Workstation; the new guest is a Windows VM (e.g. Windows 11).

## Background / current architecture

`configamatron` isolates a guest VM behind an Envoy proxy running in Docker on the host. The
guest is switched to VMware **host-only** networking, so the host proxy is the only reachable
path off-box — that network isolation is the real security boundary. The host side (Envoy,
allowlist, CA generation, the CLI) is OS-agnostic to the guest.

The Ubuntu kit (`templates/vm-shared/`) is a set of numbered bash scripts plus config files that
run inside the guest:

- `01`–`03` install packages, pnpm, and the node runtime + codex + claude CLIs.
- `04` configures tools (screen lock, Playwright, MCP).
- `05` GitHub auth. `06` trusts the proxy CA (system store + Node + Firefox).
- `07` sets up persistence: a `dnsmasq` DNS stub answers every name with a placeholder IP, and
  `iptables` DNAT redirects all guest tcp/80,443 to the host proxy, made durable by a systemd
  unit and a netplan DNS override.
- `08` sets the claude onboarding flag and links the placeholder credential.
- `verify-config.sh` is a read-only PASS/FAIL/WARN diagnostic.

The Envoy proxy is **transparent**: it listens on `:443`/`:80` and reads the real destination
from the TLS **SNI** (or HTTP `Host`) header — it is *not* a `CONNECT` forward proxy. For guest
traffic to reach it, connections must land on the proxy IP at `:443`/`:80` carrying the real
hostname in SNI.

The CLI copies `templates/vm-shared/` → `.configamatron/vm-shared/` at `init`, and
`generate-ca` / `write-github-config` / `init` drop `cert.pem` / `github-config.txt` /
`credentials.json` into that folder for the guest scripts to consume.

## Security model

Unchanged from Ubuntu. No real credential ever lands in the guest — the guest holds only a
placeholder `credentials.json` (expiry year 2100), and Envoy injects the real token host-side.
All name resolution points at the host proxy IP; the guest runs host-only, so even a compromised
guest that undoes its own DNS config still cannot reach the internet. The socket-level
enforcement Ubuntu uses (`iptables`) is a Linux workaround for the lack of a system-wide proxy
setting, **not** the security guarantee — so the Windows guest does not need to replicate it.

## Networking: DNS redirect (chosen approach)

The Windows guest reaches the transparent proxy via **DNS redirection**, the direct analog of the
Ubuntu `dnsmasq` stub minus the DNAT layer:

1. A DNS responder in the guest answers **every** hostname with the **host proxy IP** (A
   records). AAAA queries return an empty `NOERROR` so apps fall back to IPv4.
2. The guest's active adapter is pointed at the responder
   (`Set-DnsClientServerAddress -ServerAddresses 127.0.0.1`), which statically overrides any
   host-only DHCP-supplied DNS (the native analog of the Ubuntu netplan override). The DNS cache
   is flushed (`Clear-DnsClientCache`).
3. The responder runs at boot, so isolation survives reboot.

An app resolving `api.anthropic.com` gets the host IP, connects to `host:443` with SNI intact,
and Envoy behaves exactly as it does today (terminate + inject, or SNI-passthrough). HTTP/:80
works the same via the `Host` header. **The entire host side is reused unchanged** — no Envoy
changes, no forward-proxy, no system-proxy settings, no firewall rules.

### Rejected alternative: system forward-proxy (WinHTTP/WinINET)

Setting the guest's system proxy + `HTTP(S)_PROXY` to Envoy would require **host-side Envoy
changes** (adding a `CONNECT` forward-proxy listener and making TLS-termination + credential
injection work over `CONNECT`, materially trickier than the current SNI-terminate path), and not
every tool honors the system proxy uniformly. More work, and it disturbs the carefully-built host
side, for the sole benefit of using Windows' native proxy setting. Rejected.

### The DNS responder

A small **C#** catch-all responder that we ship and own (no third-party dependency, fitting the
"we own the boundary" ethos; the .NET SDK is installed anyway):

- A console app that binds UDP `127.0.0.1:53`, replies to every A query with `<host-ip>`, and
  returns empty `NOERROR` for AAAA. `07` publishes it to an exe (`dotnet publish`).
- Run at boot via a **startup Scheduled Task** (`Register-ScheduledTask`: at startup, highest
  privileges, restart-on-failure). Native, no third-party service wrapper.
- `<host-ip>` is written by `07` into a config file next to the exe (the analog of Ubuntu's
  `dnsmasq-stub.conf`), which the responder reads on startup. `07` takes the value as its script
  argument, sourced from what proxy setup step 5 prints — same input as Ubuntu's `07`. `verify`
  reads this same config file to discover the configured host IP.

Rejected for the initial build: **Acrylic DNS Proxy** (third-party binary to download and trust)
and a **.NET Worker Service** (a real auto-restarting service; more moving parts than a
restart-on-failure task warrants for the initial build — a candidate later hardening step).

## Host-side CLI plumbing

The host proxy, Envoy config, allowlist, and CA logic are **unchanged**. The only host-side code
change is making the three existing commands also populate a Windows folder, so one environment
serves either guest type; the user shares whichever folder matches the VM they built.

- `envPaths.ts` gains `vmSharedWindows` plus its `cert.pem` / `github-config.txt` /
  `credentials.json` paths.
- `initEnv.ts` (`init`) copies `templates/vm-shared-windows/` → `.configamatron/vm-shared-windows/`
  alongside the Ubuntu copy, and writes the sanitized `credentials.json` into both folders.
- `generate-ca` copies `cert.pem` into both folders.
- `write-github-config` writes `github-config.txt` into both folders.

Decision: **always populate both folders, no mode flag.** Simpler than an init `--guest windows`
flag, keeps every command's behavior uniform, and costs only a few KB for a user who never builds
a Windows VM. The Ubuntu path is otherwise untouched.

## The provisioning scripts

PowerShell scripts under `templates/vm-shared-windows/`, run **from an elevated (Administrator)
PowerShell** inside the guest, in number order. One elevation up front replaces Ubuntu's
per-command `sudo` (several steps need admin: cert store, machine env vars, the DNS service).
Per-user steps still write to the running user's `%USERPROFILE%`.

| # | Script | What it does | Windows mechanism |
|---|--------|--------------|-------------------|
| 01 | `01-install-packages.ps1` | git, PowerShell 7, .NET SDK, `gh` | `winget install` (VM still on NAT, pre-isolation) |
| 02 | `02-install-pnpm.ps1` | pnpm (standalone) | `get.pnpm.io/install.ps1`; open a new shell for PATH |
| 03 | `03-install-tools.ps1` | node runtime + claude + codex CLIs | `pnpm runtime set node latest -g`, then the claude/codex Windows installers |
| 04 | `04-configure-tools.ps1` | disable screen lock/sleep; register context7 MCP for claude & codex | `powercfg` + `claude mcp add` / `codex mcp add` |
| 05 | `05-github-auth.ps1` | git identity + `gh` token login | parse `github-config.txt`; `git config --global`; `gh auth login --with-token`; `gh auth setup-git` |
| 06 | `06-trust-ca.ps1` | trust proxy CA (3 surfaces) | see below |
| 07 | `07-setup-network.ps1 <host-ip>` | DNS-redirect networking (persistence) | publish + register the C# responder; point adapter DNS at `127.0.0.1`; flush cache |
| 08 | `08-claude-config.ps1` | onboarding flag + placeholder credential | see below |

Plus `verify-config.ps1` (read-only diagnostics) and the shipped C# responder project.

### `06-trust-ca.ps1` — three trust surfaces

- **Windows cert store:** `Import-Certificate cert.pem → Cert:\LocalMachine\Root`. Covers .NET
  (uses the store) and anything on schannel.
- **Node tools (claude/codex):** copy the CA to a stable path
  (`C:\ProgramData\configamatron\proxy-ca.pem`) and set `NODE_EXTRA_CA_CERTS` as a **machine** env
  var so new shells pick it up (mirrors the Ubuntu `profile.d` step).
- **git:** `git config --global http.sslBackend schannel`, so Git for Windows uses the Windows
  store (now trusting the CA) instead of its bundled OpenSSL CA list.

No Firefox/NSS registration — no browser is in scope.

### `08-claude-config.ps1`

- Create `%USERPROFILE%\.claude`.
- Merge `hasCompletedOnboarding=true` into `%USERPROFILE%\.claude.json` (read → set → write;
  start fresh if missing or unparsable — mirrors the Ubuntu python step).
- **Copy** the placeholder `credentials.json` to `%USERPROFILE%\.claude\.credentials.json`
  (not a symlink: Windows symlinks need admin/Developer Mode, and the placeholder never expires,
  so a copy is simpler and safe). `init` regenerates the shared file and re-running `08`
  re-copies, so a stale copy is one rerun away from fixed.

## Deliberate differences from the Ubuntu kit (YAGNI)

- **No Playwright / browser CA registration.** Not asked for in the Windows guest; drops the
  Playwright install and the Firefox/NSS trust wrangling. Easy to add later.
- **No `build-essential`/`okular` analog.** The .NET SDK is this guest's build toolchain.
- **Codex** is installed but its credentials are not injected yet (a future goal) — same partial
  state as Ubuntu.
- **Placeholder credential copied, not symlinked** (see `08` above).

## Toolset installed in the guest

Beyond the claude and codex CLIs: **git, pnpm, PowerShell 7, and the .NET SDK** (plus `gh` for
GitHub auth and a pnpm-managed node runtime the agents/pnpm need).

## `verify-config.ps1`

Read-only diagnostics, one `PASS`/`FAIL`/`WARN` line per check, non-zero exit on any FAIL
(mirrors `verify-config.sh`), adapted to Windows:

- **Host IP:** take `[host-ip]` arg; if omitted, discover it from the installed responder
  task/config and report it (no DNAT rules to read, so the responder config is the source of
  truth).
- **CA trust:** CA present in `LocalMachine\Root`; `NODE_EXTRA_CA_CERTS` set and file exists;
  `git config http.sslBackend` = `schannel`.
- **DNS redirect:** responder task exists and is running; the active adapter's DNS = `127.0.0.1`
  and *only* that; `Resolve-DnsName example.com -Server 127.0.0.1` returns the host IP.
- **Placeholder credential:** `.credentials.json` exists and contains the placeholder token;
  **FAIL** if a non-placeholder token is present (a real token must never live in the guest).
- **Live egress** (via `curl.exe`, which ships with Windows): allow-listed `:80` and `:443`
  succeed; a blocked `:443` host is dropped; blocked `:80` → 403; wrong-auth to
  `api.anthropic.com` → 403 (gate rejects, no token spent).

## Testing

- **Host-side TS changes → automated unit tests (existing vitest).** The `envPaths` additions and
  the "populate both folders" behavior in `init` / `generate-ca` / `write-github-config` are pure
  TypeScript; extend the existing unit suites so they run in `pnpm test`.
- **Guest scripts, C# responder, `verify-config.ps1` → manual verification in a real Windows
  guest.** `verify-config.ps1` is the automated acceptance check run inside the VM (its DNS check
  doubles as the responder smoke test). A runbook documents provisioning a fresh VM repeatably.
- **No automated Windows-VM harness (out of scope).** The Ubuntu `test:vm` uses QEMU + cloud-init
  in WSL2; there is no comparably cheap path for a licensed Windows guest, and building one would
  dwarf this project.
- *Optional, low priority:* PSScriptAnalyzer linting of the `.ps1` files — a nice-to-have, not a
  commitment.

## Documentation

- Rename the existing `windows-usage.md` stub to **`usage-windows-vm.md`** and expand it into the
  full Windows-guest runbook: install VMware Tools; share the `vm-shared-windows` folder (appears
  at `\\vmware-host\Shared Folders\vm-shared-windows` in a Windows guest — the analog of
  `/mnt/hgfs`); open an **elevated** PowerShell; run `01`–`08` in order; then switch to host-only
  networking and reboot. Mirrors the Ubuntu "VM setup" section.
- Add a short pointer from `README.md`'s VM-setup section: "For a Windows guest, see
  `usage-windows-vm.md`."
- Host-side docs (proxy setup, `verify-proxy.ps1`) are unchanged.

## Out of scope

- Codex credential injection (future goal, tracked separately).
- Playwright / browser automation in the Windows guest.
- An automated Windows-VM test harness.
- Any change to the host proxy, Envoy config, allowlist, or CA generation.

## Deliverables summary

1. `templates/vm-shared-windows/` — PowerShell scripts `01`–`08`, `verify-config.ps1`, and the
   shipped C# DNS responder project.
2. Host-side plumbing: `envPaths.ts`, `initEnv.ts`, `generate-ca`, `write-github-config` populate
   the `vm-shared-windows` folder; extended unit tests.
3. `usage-windows-vm.md` runbook (renamed + expanded from `windows-usage.md`); README pointer.
