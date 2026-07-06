# Configamatron Per-Directory Environments — Design

Date: 2026-07-05
Status: Approved

## Problem

Deployment-specific working files (generated envoy config, CA material, SDS secrets,
`vm/cert.pem`, `vm/github-config.txt`, allowlists) live inside this repository, mixed
with source. Running `pnpm test` regenerates several of them, clobbering the files a
live deployment depends on. There is exactly one place a deployment can live: the repo
checkout itself.

## Goal

Make an *environment* a property of the working directory. `configamatron` run in
`e:\repo` manages `e:\repo\.configamatron`; the test suite uses this repository's own
gitignored `.configamatron`. Settings files for one environment never clobber another's.
After the change, **no working file exists outside a `.configamatron` folder** — every
file the proxy or VM references lives there.

### Explicit non-goals / accepted constraints

- Only one proxy container can bind the host interface. Environments share it; whoever
  runs `run-proxy` (or the integration tests) replaces the running container. The user
  is responsible for running one environment at a time.
- No `.configamatron` versioning or upgrade story. `init` refuses to touch an existing
  folder; environments are rebuilt from scratch. Generation steps reuse already-present
  files (certs, credentials) when they validate.
- VMs are created and pointed at their environment's `vm-shared` folder by the user.
- `legacy/` and `docs/superpowers/` remain untouched (archive/reference only).

## Invocation model

`configamatron` is installed globally (`pnpm build && pnpm install -g .` — deliberate,
so intermediate work in the repo doesn't affect the installed tool). Every command
except `import-sbx-network-policy` treats **cwd as the environment root**: it operates
on `<cwd>/.configamatron` and fails fast if it's missing. No parent-directory walking,
no `--dir` flag (can be added later if wanted).

Template assets ship inside the npm package and are resolved relative to the installed
module. `package.json` `files` becomes `["dist", "templates", "current-allow-list.txt"]`.

## Environment layout

Created by `configamatron init` at `<cwd>/.configamatron`:

```
.configamatron/
  vm-shared/                      # share this folder (read-only) into the VM
    01-apt-packages.sh            # ┐
    02-install-pnpm.sh            # │ copied from package templates,
    03-install-tools.sh           # │ numbered in documented run order
    04-configure-tools.sh         # │ (06/07 are today's vm-trust-ca.sh /
    05-github-auth.sh             # │  vm-setup-persistence.sh)
    06-trust-ca.sh                # │
    07-setup-persistence.sh       # ┘
    dnsmasq-stub.conf             # ┐ support files consumed by the scripts
    60-dns-override.yaml          # │ above — unnumbered, copied from
    iptables-rules@.service       # ┘ templates
    credentials.json              # static placeholder credential, copied by init
    cert.pem                      # written by generate-ca
    github-config.txt             # written by write-github-config
  proxy/                          # everything the host-side proxy needs
    docker-compose.yml            # copied from templates; fixed project name
    gate.lua                      # copied from templates
    host-allow-vm-inbound.ps1     # copied from templates (Windows firewall step)
    allowlist.txt                 # copied from packaged current-allow-list.txt
    envoy.yaml                    # written by build-envoy-config
    ca/cert.pem, ca/key.pem       # written by generate-ca
    secrets/sds-secret.yaml       # written by run-proxy
```

Rules embodied by the layout:

- Everything the user *runs* is numbered; support files consumed by scripts are not.
- `06-trust-ca.sh` drops its path argument and defaults to the `cert.pem` beside it
  (VM scripts already self-locate via `$(dirname "$0")`, so they copy unchanged
  otherwise).
- `docker-compose.yml` gains `name: configamatron` so the compose project name is
  identical across environments — bringing up env B's proxy deterministically replaces
  env A's container instead of colliding on ports.

## Repository layout after cleanup

```
templates/
  vm-shared/               # today's vm/ folder: renamed/renumbered scripts, support
                           #   files, credentials.json (today's credentials.json.template)
  proxy/                   # gate.lua, docker-compose.yml, host-allow-vm-inbound.ps1
current-allow-list.txt     # tracked; the shared default allowlist
usage.md                   # consolidated user guide (replaces envoy-proxy.md + vm-setup.md)
technical-notes.md         # spill-over: technical detail not needed in the user flow
src/                       # + commands/init.ts, commands/generateCa.ts, envPaths.ts
.configamatron/            # gitignored; created by the integration tests
```

Deleted: `balanced.policy.txt`, root `allowlist.txt` (generated), `envoy/` and `vm/`
directories (contents move to `templates/` or are generated per-environment),
root `docker-compose.yml`, `scripts/generate-ca.sh`, `envoy-proxy.md`, `vm-setup.md`,
the stray untracked `vm/.credentials.json`.

`.gitignore` shrinks to: `node_modules/`, `dist/`, `test-results/`, `.configamatron/`.

`selfsigned` moves from devDependencies to dependencies (used by `generate-ca`).

## Commands

| Command | Behavior |
|---|---|
| `init` *(new)* | Refuses if `.configamatron` exists ("delete it to rebuild"). Copies `templates/vm-shared/` and `templates/proxy/` into `.configamatron/`, and copies packaged `current-allow-list.txt` → `proxy/allowlist.txt`. Prints next steps. |
| `generate-ca` *(new; replaces `scripts/generate-ca.sh`)* | Node implementation via `selfsigned`, same CN (`sbx-sandbox-proxy-ca`) and SANs as the bash script. Writes `proxy/ca/{cert,key}.pem`; copies `cert.pem` → `vm-shared/`. If a parseable cert+key pair exists, reuses it and just re-copies the cert; present-but-unparseable fails loudly naming the bad file (never silently overwrites key material). Drops the openssl/Git Bash dependency. |
| `build-envoy-config` | Default input `.configamatron/proxy/allowlist.txt`; default output `.configamatron/proxy/envoy.yaml`. Explicit path arguments/options still accepted. |
| `write-github-config` | Output moves to `.configamatron/vm-shared/github-config.txt`. |
| `run-proxy` | Default secret path `.configamatron/proxy/secrets/sds-secret.yaml`; docker compose is executed with cwd = `.configamatron/proxy`. Credentials watching (`~/.claude/.credentials.json`) unchanged — per-user, not per-environment. |
| `import-sbx-network-policy` | Mechanically unchanged, but repositioned as a **maintainer command run in this repo** to refresh the tracked `current-allow-list.txt` (now its default output; the `allowlist.txt` intermediate goes away). Documented in `technical-notes.md`, not the user flow. |

Path resolution lives in one shared helper (`src/envPaths.ts`); commands get their
defaults from it and produce the "run `configamatron init` first" error consistently.

## User flow (what usage.md documents)

`usage.md` consolidates `envoy-proxy.md` + `vm-setup.md` in this order:

1. **Host prerequisites** (top): Docker + Compose, Node >= 18 + pnpm, logged-in
   `claude` CLI, install with `pnpm build && pnpm install -g .`.
2. **Proxy setup** (usually once per environment): `cd <env-dir>` →
   `configamatron init` → `configamatron generate-ca` →
   `configamatron build-envoy-config` → `configamatron write-github-config` →
   `configamatron run-proxy`; Windows hosts run
   `.configamatron/proxy/host-allow-vm-inbound.ps1` from an admin PowerShell.
3. **VM setup** (may be repeated per VM): create the VM (content from today's
   vm-setup.md), share `.configamatron/vm-shared` read-only into it, run `01`–`07`
   in order, copy `credentials.json` to `~/.claude/.credentials.json`, switch the VM
   to host-only networking, reboot.

Technical background currently mixed into those files (design rationale, DNS/iptables
detail, spec cross-references) moves to `technical-notes.md`.

## Error handling

- Any command without `.configamatron` in cwd (except `init` and
  `import-sbx-network-policy`): exit 1, "no .configamatron here — run
  `configamatron init` first".
- `init` with `.configamatron` present: exit 1, instruct to delete and rebuild.
- `generate-ca`: reuse valid existing pair; fail loudly on unparseable files.
- `run-proxy` / `build-envoy-config` with missing inputs: error names the command
  that produces the missing file.

## Testing

- **Unit:** `envPaths` resolution; init copy manifest; CA generation (expected
  CN/SANs, reuse-if-valid, reject-if-garbage).
- **Integration:** run `init` against the repo root (creating the gitignored
  `.configamatron`), then `generate-ca`, `build-envoy-config` with the fixture
  allowlist + `--upstream-override`, and the compose stack / `run-proxy` from
  `.configamatron/proxy` using the existing `ENVOY_*` port overrides. The Git Bash
  `generate-ca.sh` invocation disappears; the `gitBash.ts` helper likely goes with it.
- Because the compose project name is fixed, `pnpm test` replaces a running
  deployment proxy container — accepted single-proxy semantics. Unlike today it no
  longer corrupts the deployment's files; re-running `run-proxy` in the environment
  directory restores the container.
- **Success criterion for the whole project:** after `pnpm test`, `git status` is
  clean and nothing outside `.configamatron/` changed.

## Migration

One commit series, no back-compat. Existing deployments are rebuilt from scratch via
`init`; previously generated certs/credentials can be dropped back into the new layout
and are reused when they validate.
