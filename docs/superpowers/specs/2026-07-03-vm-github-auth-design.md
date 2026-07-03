# VM GitHub Auth Setup

## Problem

The VM setup sequence (`vm-setup.md`) installs git via apt but has no way to authenticate it against GitHub. `legacy/github permissions.md` documents a manual, interactive flow (`gh auth login`, typed by hand on the VM). We want this scripted and consistent with the rest of the `vm/0N-*.sh` sequence, using a fine-grained personal access token (PAT) rather than a classic OAuth login.

Fine-grained PATs can only be created through the GitHub web UI (Settings → Developer settings → Fine-grained tokens) — there is no API or `gh` CLI command that creates one. So token *creation* stays manual; this design only automates getting a token you've already created onto the VM and configuring git/`gh` to use it.

## Architecture

A host-side script prompts for the PAT (created manually via the web UI), reads your host's git identity, and writes a gitignored config file into `vm/`. Since the whole `vm/` folder is already copied to the VM via the shared folder, that config file travels along with it. A new numbered VM script consumes it.

```
[GitHub web UI]              [host]                          [VM, via /mnt/hgfs]
create fine-grained   -->    scripts/write-github-config.sh   -->  vm/05-github-auth.sh
PAT (manual)                 (prompts for token, reads              (installs gh, configures
                              git config --global                   git identity + auth)
                              user.name/user.email,
                              writes vm/github-config.txt)
```

## Components

### `scripts/write-github-config.sh` (host, bash)

Run manually, once per token, after creating the PAT in the GitHub web UI. No arguments.

- Prompts for the token with hidden input: `read -s -p "GitHub fine-grained PAT: " token` (echo a newline after, since `-s` suppresses it)
- Reads `git config --global user.name` and `git config --global user.email`; fails with a clear error if either is unset
- Writes `vm/github-config.txt` (relative to repo root, following the `repo_root="$(cd "$(dirname "$0")/.." && pwd)"` pattern already used in `scripts/host-session-hook.sh`):
  ```
  GITHUB_USERNAME="<user.name>"
  GITHUB_EMAIL="<user.email>"
  GITHUB_TOKEN="<token>"
  ```
- Prints a confirmation that does **not** echo the token (e.g. `write-github-config: wrote vm/github-config.txt for <username> <email>`)
- Overwrites any existing `vm/github-config.txt` without prompting (re-running to rotate a token is the expected use case)

### `vm/05-github-auth.sh` (VM, bash)

Run directly (no `sudo` prefix), matching the `01`/`04` convention established earlier in this sequence — it uses `sudo` internally only where needed.

- Locates `github-config.txt` next to itself (`dir="$(cd "$(dirname "$0")" && pwd)"`); if missing, fails with a message pointing back at `scripts/write-github-config.sh`
- `sudo apt install -y gh` — apt-installed, so (unlike the curl-installed pnpm/codex/claude in steps 2-3) it's on `PATH` immediately in the same shell; no new-terminal step required
- Sources `github-config.txt`, then:
  - `git config --global user.name "$GITHUB_USERNAME"`
  - `git config --global user.email "$GITHUB_EMAIL"`
  - `echo "$GITHUB_TOKEN" | gh auth login --with-token`
  - `gh auth setup-git` (points git's credential helper at gh's stored token)
- Prints a confirmation on success

### `vm/github-config.txt.template` (checked in)

A placeholder mirroring the existing `vm/credentials.json.template` pattern, documenting the three expected fields with dummy values, so the format is discoverable without reading the scripts.

### `.gitignore`

Add `vm/github-config.txt` — it holds a real credential and must never be committed.

### `vm-setup.md`

- Add a prerequisite step before the numbered sequence: create a fine-grained PAT via the GitHub web UI, then run `bash scripts/write-github-config.sh` on the host.
- Add step 5: `bash vm/05-github-auth.sh` (no new-terminal note needed, per above).

## Error handling

- `write-github-config.sh`: fails fast (`set -euo pipefail`) if `user.name`/`user.email` are unset on the host, or if the token prompt is left empty.
- `05-github-auth.sh`: fails fast if `github-config.txt` isn't present next to the script, or if any of the three fields are empty after sourcing it.
- Neither script echoes the token to the terminal or logs.

## Out of scope

- Automating fine-grained PAT *creation* (not possible via API/CLI today).
- Token rotation/expiry reminders.
- Any use case beyond "VM clones and pushes to specific repos owned by this GitHub account."
