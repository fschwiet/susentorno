# Customizable home-settings jq transforms

**Date:** 2026-07-20
**Status:** Approved (pending implementation)

## Problem

The numbered VM setup scripts hard-code two jq transforms that edit settings files in
the guest's home directory:

- **VS Code settings** (`04-configure-tools.{sh,ps1}`): merges four keys into
  `~/.config/Code/User/settings.json` (Ubuntu) / `%APPDATA%\Code\User\settings.json` (Windows).
- **Claude onboarding** (`08-claude-config.{sh,ps1}`): sets `.hasCompletedOnboarding = true`
  in `~/.claude.json` on both platforms.

Because these transforms live inside the shipped scripts, a user cannot add their own
settings tweaks or change ours without editing the scripts. The goal is to pull these
transforms out into a source-controllable folder that users can freely add to and modify,
and apply them all from a single step that runs last, after network isolation.

## Goals

- Users declare settings transforms in a folder under `.configamatron/` that they can
  commit and edit to taste.
- A single numbered script, run last (after the NAT→host-only switch and reboot), applies
  every declared transform to its target file, seeding an empty `{}` when the target is
  missing.
- Ship the current two transforms as the initial defaults, extracted from the scripts.
- Consolidate the now-thinner post-CA scripts while we are in here.

## Non-goals

- No in-place migration of existing environments. `.configamatron/` is gitignored and not
  committed, so existing environments are rebuilt via `configamatron init`.
- No general templating or scripting language beyond jq. Transforms are jq programs.

## Architecture overview

Three concerns, cleanly separated:

1. **Transform declarations** — a user-editable `home-jq-transforms/` folder (a `manifest.yaml`
   plus flat `.jq` files). This is the source of truth, committed to source control.
2. **One tested TypeScript core** (`src/homeJqTransforms.ts`) that parses the manifest,
   resolves per-OS target paths, and applies transforms by shelling out to `jq`. The host CLI
   and the in-VM applier both use this code.
3. **A bundled in-VM applier** (`apply-home-jq-transforms.mjs`, produced by tsup) invoked by a
   thin numbered wrapper script. Node is available in the guest (installed at step 03), so the
   applier logic is written once in TypeScript rather than duplicated across bash and PowerShell.

### Data flow

```
.configamatron/home-jq-transforms/        <- source of truth (user edits, source-controlled)
   manifest.yaml
   vscode-settings.jq
   claude-onboarding.jq

  (init seeds, update-shares refreshes)
        |
        v
.configamatron/vm-shared/home-jq-transforms/          (visible to Ubuntu guest)
.configamatron/vm-shared-windows/home-jq-transforms/  (visible to Windows guest)

  (in the guest, step 07 runs)
        |
        v
node apply-home-jq-transforms.mjs ./home-jq-transforms
        |
        v
~/.config/Code/User/settings.json, ~/.claude.json, ...
```

The parent of `vm-shared` / `vm-shared-windows` is not mounted into the guest, so the
transforms must be physically copied *inside* each share for the guest to see them.

## File layout and manifest format

Source of truth:

```
.configamatron/home-jq-transforms/
  manifest.yaml
  vscode-settings.jq        # extracted from 04-configure-tools
  claude-onboarding.jq      # extracted from 08-claude-config
```

`.jq` files are flat, named descriptively, referenced by the manifest.

`manifest.yaml` is a top-level list of entries:

```yaml
- transform: vscode-settings.jq
  linux: ~/.config/Code/User/settings.json
  windows: "%APPDATA%/Code/User/settings.json"
- transform: claude-onboarding.jq
  linux: ~/.claude.json
  windows: ~/.claude.json
```

Entry fields:

- `transform` (required) — filename of a `.jq` file in the same folder. Must exist.
- `linux` (optional) — target path applied when running on Ubuntu.
- `windows` (optional) — target path applied when running on Windows.
- At least one of `linux` / `windows` must be present. Omitting one skips that transform on
  that OS (supports platform-specific transforms).

**Target path expansion** — the entire vocabulary. Expansion is performed by the
TypeScript core itself (not the OS shell), so it behaves identically on Ubuntu and Windows:

- A leading `~` (or `~/`) expands to the guest user's home directory (via `os.homedir()`).
- `%NAME%` expands to environment variable `NAME` (a regex replace of `%NAME%` →
  `process.env.NAME`, e.g. `%APPDATA%`). This is our own portable convention, not the OS
  shell's syntax, so `%APPDATA%` on a Windows target and `~` on both platforms resolve the
  same way regardless of the shell that launched the applier.

The two seeded `.jq` files reproduce the current inline transforms exactly:

`vscode-settings.jq`:

```jq
.["files.autoSave"] = "afterDelay"
| .["editor.formatOnSave"] = true
| .["editor.defaultFormatter"] = "esbenp.prettier-vscode"
| .["[csharp]"] = {"editor.defaultFormatter": "csharpier.csharpier-vscode"}
```

`claude-onboarding.jq`:

```jq
.hasCompletedOnboarding = true
```

## Core module: `src/homeJqTransforms.ts`

The single real implementation, exercised by vitest.

- `loadManifest(dir)` — read and parse `manifest.yaml`; validate each entry (referenced
  `.jq` file exists; at least one platform target present). Throws with a clear message on
  malformed input.
- `resolveTarget(entry, platform, env, home)` — expand `~` and `%NAME%` for the given
  platform's target. Returns `null` when the entry has no target for that platform.
- `applyTransforms({ dir, platform, ... })` — for each entry with a target for `platform`:
  read the target file (seed `{}` if missing or unparsable), run `jq -f <transform>` on it,
  write the result atomically (temp file + rename), creating parent directories as needed.
  Returns a per-file result list (target path, created-vs-updated, ok/error).
- `previewTransforms(dir)` — run each transform against `{}` and return
  `{ transform, linuxTarget, windowsTarget, output | error }` for host-side display.

The jq invocation goes through an **injectable runner** so unit tests can stub jq;
integration tests use the real `jq` binary.

## In-VM applier: `src/vmApplyHomeJqTransforms.ts`

Thin entrypoint: parse argv (the transforms directory), detect platform via
`process.platform` (`win32` → Windows targets, else Linux targets), call `applyTransforms`,
print a summary, exit non-zero if any transform failed.

tsup bundles it (with the `yaml` dependency inlined) into a standalone
`apply-home-jq-transforms.mjs`, emitted into `templates/vm-shared/` and
`templates/vm-shared-windows/`. These bundle files are build artifacts, gitignored like
`dist/`, and carried into an environment by `init` (which copies the template share dirs).
The npm-published package includes them because `templates/` is in `package.json` `files`
and the bundle is built before packing.

## Script consolidation and new run order

The two *home-settings* jq blocks are **deleted** from `04-configure-tools` (VS Code) and
`08-claude-config` (claude onboarding); that work moves to the new final applier step. The
Firefox-policy jq merge in `06-trust-ca` targets a system path (`/etc/firefox/policies`), not
a home dotfile, and stays in the script.

Scripts are renumbered and combined:

- **`05-configure-network.{sh,ps1}`** = old `06-trust-ca` + old `07-setup-persistence`
  (Ubuntu) / `07-setup-network` (Windows). Signature: `<host-ip>` required; CA cert defaults
  to `cert.pem` beside the script (optional 2nd positional on bash, `-CertPath` on Windows).
  Trusts the CA first, then installs dnsmasq + egress/netplan (Ubuntu) or the DNS responder
  (Windows). Runs pre-isolation.
- **`06-auth-config.{sh,ps1}`** = old `05-github-auth` + old `08-claude-config` (minus its jq
  block) + old `09-codex-config`. No args; reads `github-config.txt` beside it. Does gh/git
  auth, the claude credential symlink/copy, and the codex credential symlink/copy. Runs
  post-reboot.
- **`07-apply-home-jq-transforms.{sh,ps1}`** — one-liner:
  `node ./apply-home-jq-transforms.mjs ./home-jq-transforms` (paths resolved relative to the
  script directory). Runs post-reboot, last.

Final run order (both platforms), fully sequential:

| Step | Script | Args | When |
|---|---|---|---|
| 1 | 01-packages | | pre-isolation |
| 2 | 02-pnpm | | pre-isolation |
| 3 | 03-tools | | pre-isolation |
| 4 | 04-configure-tools *(VS Code jq removed)* | | pre-isolation |
| 5 | **05-configure-network** | `<host-ip> [cert-path]` | pre-isolation |
| — | **switch NAT→host-only + reboot** | | |
| 6 | **06-auth-config** | | post-reboot |
| 7 | **07-apply-home-jq-transforms** | | post-reboot, last |

Moving claude's onboarding write from step 08 to the final step is safe: nothing between
(github auth, codex credentials) requires the claude CLI to be onboarded. `node` and `jq`
are both installed before step 07 (steps 01 and 03), and the applier makes no network calls,
so it is unaffected by network isolation.

## CLI changes

### `init`

- `templates/` gains a `home-jq-transforms/` folder (manifest + the two extracted `.jq`
  files).
- `initEnvironment` copies it to `.configamatron/home-jq-transforms/` **and** seeds a copy
  into both `vm-shared/home-jq-transforms/` and `vm-shared-windows/home-jq-transforms/`, so a
  freshly initialized environment is runnable without a manual `update-shares` step.
- `init`'s "next steps" output notes that transforms are customizable and that `update-shares`
  refreshes the shares after edits.

### `update-shares` (new command)

Refreshes the share copies after a user edits transforms.

1. Require `.configamatron` (standard missing-environment error otherwise); load and validate
   the manifest.
2. **Preview**: for each transform, print its name, resolved `linux` and `windows` target
   paths, and the result of applying it to `{}`. Both platforms are shown because the host
   does not know which guest will consume the transforms.
3. Copy `home-jq-transforms/` into both shares (replacing prior copies) and list the files
   copied.
4. `-n` / `--dry-run`: preview only, no copy.

A jq error in any transform's `{}` preview is **fatal and blocks the copy**, so a broken
transform is never shipped into a share. The user fixes the `.jq` and re-runs.

`update-shares` needs `jq` on the host for the `{}` preview; if it is missing, the command
exits with a clear message telling the user to install jq.

## Documentation

- Update `README.md` and `usage-windows-vm.md` run-order sections to the new table.
- Add a short "Customizing settings transforms" section to `README.md` explaining
  `home-jq-transforms/`, the manifest format, and `update-shares`.
- Mention transform customization in `init`'s printed next steps.

## Edge cases

- **Missing / empty target file** — seeded with `{}`, then transformed (creates parent dirs).
- **Unparsable target file** — treated as `{}` (matches current script behavior).
- **Invalid jq program** — the in-VM applier fails loudly (non-zero exit) for that transform;
  `update-shares` blocks the copy when the `{}` preview errors.
- **Entry with no target for the current platform** — skipped on that platform.
- **jq missing on host** — `update-shares` exits with a clear install-jq message. (jq is
  always present in the guest via step 01.)

## Testing

- **Unit (vitest, stubbed jq):**
  - manifest parse/validate: valid; malformed YAML; missing `.jq` file; entry with no target.
  - `resolveTarget`: `~` and `%APPDATA%` expansion for both platforms; `null` when no target.
  - `applyTransforms`: seeds `{}` for a missing target; merges into an existing file; writes
    atomically; creates parent directories.
  - `previewTransforms`: output shape; error captured per transform.
- **Integration (real jq):** apply both seeded defaults to temp files and assert the results
  match the JSON the old inline scripts produced.
- **Command tests:** `update-shares` copies into both shares and dry-run copies nothing;
  `update-shares` blocks the copy on a jq error; `init` seeds all three locations.
