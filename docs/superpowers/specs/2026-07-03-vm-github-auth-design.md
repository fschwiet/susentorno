# VM GitHub Auth Setup

## Problem

The VM setup sequence (`vm-setup.md`) installs git via apt but has no way to authenticate it against GitHub. `legacy/github permissions.md` documents a manual, interactive flow (`gh auth login`, typed by hand on the VM). We want this scripted and consistent with the rest of the `vm/0N-*.sh` sequence, using a fine-grained personal access token (PAT) rather than a classic OAuth login.

Fine-grained PATs can only be created through the GitHub web UI (Settings → Developer settings → Fine-grained tokens) — there is no API or `gh` CLI command that creates one. So token *creation* stays manual; this design only automates getting a token you've already created onto the VM and configuring git/`gh` to use it.

## Architecture

A `configamatron` CLI command prompts for the PAT (created manually via the web UI), reads your host's git identity, and writes a gitignored config file into `vm/`. Since the whole `vm/` folder is already copied to the VM via the shared folder, that config file travels along with it. A new numbered VM script consumes it.

```
[GitHub web UI]              [host]                                  [VM, via /mnt/hgfs]
create fine-grained   -->    pnpm exec configamatron            -->  vm/05-github-auth.sh
PAT (manual)                 write-github-config                     (installs gh, configures
                              (prompts for token, validates                git identity + auth)
                              its form, reads git config
                              user.name/user.email,
                              writes vm/github-config.txt)
```

## Components

### `configamatron write-github-config` (host, TypeScript, new `src/commands/writeGithubConfig.ts`)

Run manually, once per token, after creating the PAT in the GitHub web UI. No arguments. Registered in `src/cli.ts` alongside the existing `import-sbx-network-policy` and `build-envoy-config` commands.

- Prompts for the token with a plain (visible) `readline` prompt — it's typed/pasted interactively, so it never lands in shell history, and visibility on screen is acceptable
- Validates the pasted token's *form* before using it (catches a truncated/partial paste, not whether GitHub considers it valid): must start with `github_pat_`, be exactly 93 characters total, and consist only of `[A-Za-z0-9_]` after the prefix — matching GitHub's documented fine-grained PAT format. On failure, prints an error and exits without writing the file. This check lives in a small pure function (e.g. `src/githubToken.ts`) so it's unit-testable the same way `policyFile.ts`/`allowlist.ts` are.
- Reads `git config --global user.name` and `git config --global user.email` via `execFileSync('git', ...)`; fails with a clear error if either is unset
- Writes `vm/github-config.txt` (resolved relative to the repo root, same as the other commands' file outputs):
  ```
  GITHUB_USERNAME="<user.name>"
  GITHUB_EMAIL="<user.email>"
  GITHUB_TOKEN="<token>"
  ```
- Prints a confirmation that does **not** echo the token (e.g. `write-github-config: wrote vm/github-config.txt for <username> <email>`)
- Overwrites any existing `vm/github-config.txt` without prompting (re-running to rotate a token is the expected use case)

### `vm/05-github-auth.sh` (VM, bash)

Run directly (no `sudo` prefix), matching the `01`/`04` convention established earlier in this sequence — it uses `sudo` internally only where needed.

- Locates `github-config.txt` next to itself (`dir="$(cd "$(dirname "$0")" && pwd)"`); if missing, fails with a message pointing back at `pnpm exec configamatron write-github-config`
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

- Add a prerequisite step before the numbered sequence: create a fine-grained PAT via the GitHub web UI, then run `pnpm exec configamatron write-github-config` on the host.
- Add step 5: `bash vm/05-github-auth.sh` (no new-terminal note needed, per above).

## Error handling

- `write-github-config`: fails fast if `user.name`/`user.email` are unset on the host, if the token prompt is left empty, or if the pasted token fails the format check (wrong prefix, wrong length, or unexpected characters — most likely an incomplete paste).
- `05-github-auth.sh`: fails fast if `github-config.txt` isn't present next to the script, or if any of the three fields are empty after sourcing it.
- Neither component echoes the token to logs; `write-github-config`'s confirmation message omits it (it is visible once, at the prompt, while typed/pasted).

## Out of scope

- Automating fine-grained PAT *creation* (not possible via API/CLI today).
- Token rotation/expiry reminders.
- Any use case beyond "VM clones and pushes to specific repos owned by this GitHub account."
