# Custom scripts for VM setup

**Date:** 2026-07-21
**Status:** Draft. The previously-deferred open issue (resource-file location and collision
handling for built-in scripts) is now resolved — see "Resource split and collision handling"
and "Environment-specific share-root files" below. Pending codex + user review before
implementation.

## Problem

`templates/vm-shared/` and `templates/vm-shared-windows/` ship hardcoded numbered setup
scripts (today `01`–`07`) that a user runs by hand, in order, inside the VM guest. There is no
way for a user to add or change what gets installed/configured without editing the shipped
scripts directly — any such edits are lost or diverge the next time the environment is
regenerated, the same problem `home-jq-transforms/` already solved for settings files (see
`docs/honist-v/specs/2026-07-20-customizable-jq-transforms-design.md`).

## Goals

- Users declare their own setup scripts in a folder they can commit and edit, without touching
  the built-in scripts.
- Custom scripts show up in the same numbered sequence the user already runs by hand today — no
  new mechanism to learn, no attempt to chain scripts programmatically.
- Custom scripts that need full network access can rely on running before the point where the
  VM's network gets constrained to the egress allowlist.

## Non-goals

- No propagation of shell/environment state between scripts. Each script is a normal, manual
  invocation exactly like today's workflow — including "open a new terminal" wherever a script
  writes a PATH change that only takes effect in a fresh process.
- No fine-grained interleaving of custom scripts among built-ins by matching numeric prefixes.
  Built-ins and customs are two solid blocks — easier for a user to reason about than a shared
  numbering namespace, at the cost of not letting a custom script insert itself between two
  specific built-in steps.
- No general shared-helper-library mechanism beyond simple file passthrough.

## Source layout (committed, user-edited)

```
.configamatron/pre-scripts/
  01_docker.sh
  01_docker.ps1
  lib/
    helper.sh
.configamatron/post-scripts/
  01_dotfiles.ps1
```

- Only files directly inside `.configamatron/pre-scripts/` / `.configamatron/post-scripts/`
  matching `^(nn|[0-9]{2})[-_].*\.(sh|ps1)$` are treated as runnable steps — the same uniform
  pattern the weave applies to every folder (see "Weaving algorithm"). Both `-` and `_`
  separators are accepted; built-ins conventionally use `-`, and these custom examples use `_`.
  Validated up front — any `.sh`/`.ps1` file in the folder that doesn't match is a hard error
  (fail loud, list every offending filename), not a silent skip.
- Anything else in the folder — other extensions, subfolders and their contents — is passed
  through untouched, so a numbered script can reference it by relative path (e.g.
  `lib/helper.sh` above).
- `.sh` and `.ps1` files are ordered independently by their own two-digit prefix. A folder can
  hold both platforms' version of the "same" conceptual step side by side.
- Prefixes don't need to be contiguous — they only establish sort order.
- The `nn` sentinel ("run last within this phase") is accepted in a custom folder too, but is
  rarely needed: because the built-in `nn-configure-network` already sentinels network isolation
  to the very end, every *normally-numbered* custom pre-script automatically runs before
  isolation — which is exactly the network-access guarantee in Goals. Naming a custom `nn` opts
  it into the final block alongside network-config (order among multiple `nn` scripts falls back
  to their prefix/name sort), which is usually not what you want.

## Built-in template layout

The built-in scripts are **internal to the tool** — they stay under `templates/`, are never
materialized into `.configamatron/`, and are woven straight into the generated shares. Each
platform template folder splits its numbered scripts (and co-located resource files) into
`pre-scripts/` and `post-scripts/` subfolders, matching the phase they already run in today:

```
templates/vm-shared/pre-scripts/
  01-apt-packages.sh
  02-install-pnpm.sh
  03-install-tools.sh
  04-configure-tools.sh
  nn-configure-network.sh          (renamed from 05-configure-network.sh)
  dnsmasq-stub.conf
  configamatron-egress.service
  60-dns-override.yaml
templates/vm-shared/post-scripts/
  01-auth-config.sh                (renamed from 06-auth-config.sh)
  02-apply-home-jq-transforms.sh   (renamed from 07-apply-home-jq-transforms.sh)
  apply-home-jq-transforms.mjs
templates/vm-shared/verify-config.sh   (stays at the share root, unaffected — it's a standalone
                                         diagnostic, not part of the numbered sequence)
```

The Windows side gets the same split (`templates/vm-shared-windows/pre-scripts/`,
`.../post-scripts/`), keeping today's `.ps1` content, its `apply-home-jq-transforms.mjs`, and
the `dns-responder/` folder.

Keeping the built-ins platform-split (one folder per platform) rather than merged into a single
combined folder is deliberate: **a predefined resource's platform is known from which template
folder it came out of**, which is what lets predefined resources route to only their own
platform's share (see "Resource split and collision handling"). A merged folder would have no
clean signal to keep e.g. the Windows `dns-responder/` C# tree off the Linux share.

Built-in scripts keep the existing hyphen naming style (`NN-name.ext`), and reserve
`nn-name.ext` as a sentinel meaning "always run last within this phase, regardless of how many
other scripts precede it." Today exactly one script uses it: `nn-configure-network`. It trusts
the proxy CA, installs the DNS/egress rules, and points the VM's resolver at the local stub —
once applied, later network activity is already constrained to the allowlist, so it must run
only after every other pre-isolation script (built-in or custom) that might need broader
network access.

## Weaving algorithm

One function orders a single folder's scripts: validate every `.sh`/`.ps1` name against the
uniform pattern `^(nn|[0-9]{2})[-_].*\.(sh|ps1)$` (hard error on any that don't match), sort by
numeric prefix, then pull any `nn` sentinel to the end. It has no notion of "built-in" vs.
"custom" — it just orders whatever folder it's given with the one pattern, which is what lets
built-in scripts be renamed/renumbered/reordered later without touching this code.

Assembly for one phase (pre or post) and one platform (extension `.sh` or `.ps1`):

1. Run the weave function over the platform's built-in template phase folder
   (`templates/vm-shared/<phase>` for `.sh`, `templates/vm-shared-windows/<phase>` for `.ps1`),
   filtered to the target extension.
2. Run the weave function over the user's `.configamatron/pre-scripts/` or
   `.configamatron/post-scripts/` folder, filtered to the same extension.
3. Concatenate: built-in list, then custom list.
4. Re-run the sentinel-to-end pass and contiguous renumbering (`01`, `02`, `03`, ...) over the
   concatenated result.
5. Write the renumbered scripts into **exactly one share** — the one that owns the extension:
   `.sh` → `vm-shared/<phase>/`, `.ps1` → `vm-shared-windows/<phase>/`. A script is never
   duplicated across platforms.

## Resource split and collision handling

Passthrough files (everything that is not a validated script under the
`^(nn|[0-9]{2})[-_].*\.(sh|ps1)$` pattern — other extensions, subfolders and their contents)
split by **origin**, because origin is what tells us whether the platform is known:

- **Built-in passthrough** (from `templates/vm-shared/<phase>` or
  `templates/vm-shared-windows/<phase>`) is copied into **only that platform's** share
  `<phase>/` folder. The platform is known from the source folder, so there are no stray
  wrong-platform files — the Windows `dns-responder/` tree stays off the Linux share, and
  `dnsmasq-stub.conf` / `configamatron-egress.service` / `60-dns-override.yaml` stay off the
  Windows share.
- **Custom passthrough** (from `.configamatron/pre-scripts/` or `.configamatron/post-scripts/`)
  is copied into **both** shares' `<phase>/` folder. A user keeps one folder for both platforms,
  so the platform genuinely isn't known; duplicating a small, user-controlled file into both
  shares is the pragmatic choice and needs no per-file platform inference.

Scripts resolve their resources with `$script_dir/<name>`, and after the weave all of a phase's
scripts sit flat at the top of the output `<phase>/` folder, so resources sit flat beside them.

**Collision rule (this resolves the previously-deferred open issue).** Within a given share's
`<phase>/` folder, if a custom passthrough name collides with a built-in passthrough name, the
weave is a **hard error**: list every colliding name and copy nothing (no partial output) —
the same fail-loud discipline used for bad script names and bad jq transforms. Rationale:

- Collisions are checked **per share**, so a built-in Linux resource and a built-in Windows
  resource can never conflict (they land in different shares). The only conflict possible is a
  custom name equal to a built-in name within one share.
- Last-writer-wins would silently clobber a security-relevant file (e.g. `dnsmasq-stub.conf`,
  which configures network isolation). Failing loud forces the user to rename their file, and
  the error message names the built-in it collided with so the fix is obvious.

## Environment-specific share-root files

A separate class of file lives once at the **share root** and is written there directly by
`init` / `generate-ca` / `write-github-config` — never by the weave, never duplicated into
`pre-scripts/`/`post-scripts/`:

```
vm-shared/cert.pem  credentials.json  auth.json  github-config.txt  home-jq-transforms/
```

Today the built-in scripts live at the share root too, so they read these as
`$script_dir/<file>`. Under this design the scripts move one level down into `<phase>/`, so the
built-in scripts that consume them change to read from the **script's parent directory**:

| File | Consuming built-in script (phase) | Old reference | New reference |
|---|---|---|---|
| `cert.pem` | configure-network (pre) | `$script_dir/cert.pem` | `$script_dir/../cert.pem` |
| `github-config.txt` | auth-config (post) | `$dir/github-config.txt` | `$dir/../github-config.txt` |
| `credentials.json` | auth-config (post) | `$dir/credentials.json` | `$dir/../credentials.json` |
| `auth.json` | auth-config (post) | `$dir/auth.json` | `$dir/../auth.json` |
| `home-jq-transforms/` | apply-home-jq-transforms (post) | `$script_dir/home-jq-transforms` | `$script_dir/../home-jq-transforms` |

- Bash: derive the parent as `$(dirname "$script_dir")` or simply reference `$script_dir/../`.
- PowerShell: `Split-Path -Parent $scriptDir`, e.g.
  `Join-Path (Split-Path -Parent $scriptDir) 'cert.pem'`.

By contrast, **per-step resources travel with their script** and keep the unchanged
`$script_dir/<name>` reference, because they are copied into the same `<phase>/` folder as the
script:

- `dnsmasq-stub.conf`, `configamatron-egress.service`, `60-dns-override.yaml` — beside
  configure-network (Linux pre).
- `apply-home-jq-transforms.mjs` — beside apply-home-jq-transforms (both, post).
- `dns-responder/` — beside configure-network (Windows pre).

`verify-config.{sh,ps1}` stays at the share root, so its `$script_dir/cert.pem` reference is
unchanged — consistent with the rule (root scripts read root files directly).

## Generated output (gitignored, regenerated by `init` and `update-shares`)

```
vm-shared/pre-scripts/            vm-shared-windows/pre-scripts/
vm-shared/post-scripts/           vm-shared-windows/post-scripts/
```

- Never hand-edited. A user who wants to change behavior edits `.configamatron/pre-scripts/` or
  `.configamatron/post-scripts/` and re-runs `update-shares` (or `init` for a fresh
  environment).
- The entire `vm-shared/` and `vm-shared-windows/` trees are now fully regenerated (every
  script woven, every resource copied, credentials seeded), so they are ignored wholesale by the
  new allowlist `.gitignore` (see below) — there are no longer per-folder ignore lines to
  maintain.
- `init` runs the same weave-and-copy logic as `update-shares` (against an initially empty
  `.configamatron/pre-scripts/` / `.configamatron/post-scripts/`), so a freshly initialized
  environment is runnable without an extra manual step.
- `update-shares` validates `.configamatron/pre-scripts/` and `.configamatron/post-scripts/`
  naming up front and fails loud — no partial copy — on a naming violation or a resource
  collision, consistent with how it already blocks the copy on a bad jq transform.

## `.gitignore` strategy (inverted to an allowlist)

Today `.configamatron/.gitignore` is a **denylist**: commit everything except an enumerated set
of secret-bearing and regenerable paths. That list has to grow every time the tool emits a new
generated file, and a new file that isn't listed gets silently committed. Now that the shares
are fully regenerated, the committable surface is just the user's authored inputs, so we invert
to an **allowlist**: ignore everything, then re-include exactly what the user authors.

`templates/configamatron.gitignore` (paths relative to `.configamatron/`):

```gitignore
# .configamatron/ is committed, but only the files you author. Everything the tool
# generates or that holds secrets is ignored by default; the entries below opt the
# user-authored customization surface back into source control across installs.

# Ignore everything by default.
*

# ...except the user-authored inputs:
!/.gitignore
!/pre-scripts/
!/pre-scripts/**
!/post-scripts/
!/post-scripts/**
!/home-jq-transforms/
!/home-jq-transforms/**
!/proxy/
!/proxy/allowlist.txt
```

Two mechanics worth noting:

- The `/**` lines are required: `*` matches at every depth, so `!/pre-scripts/` alone
  re-includes the directory but its contents stay ignored; `!/pre-scripts/**` rescues the files
  inside.
- `!/proxy/` + `!/proxy/allowlist.txt` re-includes the proxy directory just enough for git to
  descend, then rescues only the user-authored egress allowlist. `proxy/secrets/`, `proxy/ca/`,
  and `proxy/envoy.yaml` stay ignored by the default `*` **without being enumerated** — the tool
  no longer maintains a list of secrets to exclude.

Everything else — the fully-generated shares, credential placeholders, public/private certs,
`envoy.yaml`, the bundled applier `.mjs` — is ignored by default.

## Run order changes

Today's `01`–`07` become, per share:

```
pre-scripts/   01, 02, 03, 04 (built-in) ... NN (user customs) ... final number (configure-network)
post-scripts/  01, 02 (built-in) ... NN (user customs)
```

Both phases restart numbering at `01`. `README.md` and `usage-windows-vm.md` change from
"run scripts 1 through 7" to "`cd` into `pre-scripts/`, run every script in order; switch
network + reboot; `cd` into `post-scripts/`, run every script in order" — the exact script count
is no longer fixed, since customs may add more.

## Testing / documentation impact

- New unit tests for the weave function (naming validation, sentinel handling, contiguous
  renumbering, independent `.sh`/`.ps1` ordering) and for `update-shares`/`init` writing the
  four generated locations correctly.
- New tests for resource routing and collision handling: built-in resources land only in their
  own platform share; custom resources land in both; a custom-vs-built-in name collision fails
  loud (no partial copy) and names the offending file(s).
- Re-introduce a `.gitignore` content-assertion test. The old one was removed for being
  unstable against the churning denylist; the allowlist only names the rarely-changing
  user-authored inputs, so it is stable enough to assert on again.
- Update the built-in scripts' environment-file references to the script's parent directory
  (`cert.pem`, `github-config.txt`, `credentials.json`, `auth.json`, `home-jq-transforms/`), and
  cover that the woven scripts resolve them correctly from `<phase>/`.
- `tests/vm/vm.test.ts` and other VM-harness references to `01-apt-packages.sh` etc. move to the
  new `pre-scripts/`/`post-scripts/` paths.
- `README.md`, `usage-windows-vm.md`, `technical-notes.md` updated for the new folder structure,
  restart-at-01 numbering, and the inverted `.gitignore` guidance.
