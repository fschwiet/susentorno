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

- A file directly inside `.configamatron/pre-scripts/` / `.configamatron/post-scripts/` is a
  runnable step if it matches `^[0-9]{2}[-_].+\.(sh|ps1)$` — a two-digit prefix, a `-` or `_`
  separator, a **non-empty** name, and a **lowercase** `.sh`/`.ps1` extension. Validated up
  front: any `.sh`/`.ps1` file that doesn't match is a hard error (fail loud, list every
  offending filename), not a silent skip. This catches an empty name (`01-.sh`), an uppercase
  `.SH`/`.PS1` (use lowercase), and the reserved `nn` sentinel below.
- The `nn` sentinel prefix is **reserved for built-in scripts** and is a hard error in a custom
  folder. Custom scripts never need it: because the built-in `nn-configure-network` sentinels
  network isolation to the very end of the pre phase, every custom pre-script (any normal `NN`
  number) automatically runs *before* isolation — exactly the network-access guarantee in Goals.
  Reserving `nn` from custom folders is also what keeps configure-network unambiguously last
  (see "Weaving algorithm").
- Anything that isn't a runnable step — other extensions, subfolders and their contents — is
  passed through untouched. A script must reference such a resource **relative to its own file
  location** (via `$script_dir`, e.g. `$script_dir/lib/helper.sh`), never relative to the
  caller's working directory — that isn't guaranteed for a manually-invoked script.
- `.sh` and `.ps1` files are ordered independently by their own two-digit prefix; a tie (two
  same-extension files sharing a prefix) breaks by full filename, byte-ordinal ascending. A
  folder can hold both platforms' version of the "same" conceptual step side by side. Prefixes
  need not be contiguous — they only establish sort order.

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

One function orders a single folder's scripts, taking an `allowSentinel` flag:

- **Classify** each file: a name matching `^(nn|[0-9]{2})[-_].+\.(sh|ps1)$` (lowercase
  extension) is a script; everything else is passthrough.
- **Validate** (hard error, listing offenders): any `.sh`/`.ps1` file that isn't a valid script
  name, any uppercase `.SH`/`.PS1`, and — when `allowSentinel` is false — any `nn` sentinel.
- **Sort** scripts by two-digit prefix ascending, ties broken by full filename (byte-ordinal);
  the `nn` sentinel sorts after all numbered scripts.

It has no built-in/custom knowledge beyond the `allowSentinel` knob, so built-in scripts can be
renamed/renumbered/reordered later without touching this code.

Assembly for one phase (pre or post) and one platform (extension `.sh` or `.ps1`):

1. Weave the platform's built-in template phase folder (`templates/vm-shared/<phase>` for `.sh`,
   `templates/vm-shared-windows/<phase>` for `.ps1`) with `allowSentinel: true`, filtered to the
   target extension. A built-in platform folder must contain only its own platform's script
   extension; an opposite-extension script there is a template authoring error (hard error, not
   a silent drop).
2. Weave the user's `.configamatron/pre-scripts/` or `.configamatron/post-scripts/` folder with
   `allowSentinel: false`, filtered to the same extension.
3. Concatenate: built-in list, then custom list. Because only built-in folders may carry an `nn`
   sentinel (step 2 forbids custom ones), the built-in `nn-configure-network` is the sole
   sentinel and lands **strictly last** in the pre phase — after every built-in and custom step
   — which is the network-isolation-runs-last guarantee. Custom pre-scripts, being normal
   numbers, always precede it.
4. Renumber the concatenated list contiguously (`01`, `02`, `03`, ...). Each output filename is
   the new two-digit number + `-` + the original text after the source prefix-and-separator (the
   separator normalizes to `-`). If the combined count exceeds 99, the generator fails loud
   rather than overflow two digits.
5. Write the renumbered scripts into **exactly one share** — the one that owns the extension:
   `.sh` → `vm-shared/<phase>/`, `.ps1` → `vm-shared-windows/<phase>/`. A script is never
   duplicated across platforms.

## Resource split and collision handling

Passthrough files (everything that is not a validated script under the
`^(nn|[0-9]{2})[-_].+\.(sh|ps1)$` pattern — other extensions, subfolders and their contents)
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

**Collision rule (this resolves the previously-deferred open issue).** Collisions are evaluated
per share, on the **normalized destination-relative path** each item would occupy under that
share's `<phase>/` folder — not merely top-level filenames, since whole subtrees pass through.
The Windows share is compared **case-insensitively** (its guest filesystem is), so
`DNS-Responder/` and `dns-responder/` collide there; the Linux share compares case-sensitively.
A **hard error** (list every conflict, copy nothing — no partial output) is raised when, at the
same destination path:

- two files land — built-in vs. custom, or a custom passthrough vs. a generated renumbered
  script name; or
- a file and a directory land (either order), or an ancestor conflicts (e.g. a built-in file
  `lib` vs. a custom `lib/helper.sh`).

Two **directories** at the same path **merge** — their contents recurse and are re-checked by
this same rule — which is what lets a custom `lib/` coexist with a future built-in `lib/`. So
the possible conflicts are broader than "a custom name equal to a built-in name": they include
file-vs-directory, ancestor, resource-vs-generated-script, and case-only clashes on Windows.
Failing loud rather than last-writer-wins matters because a clobber could silently replace a
security-relevant file (e.g. `dnsmasq-stub.conf`, which configures network isolation); the error
names both sides so the fix is obvious.

## Environment-specific share-root files

A separate class of file lives once at the **share root** and is written there directly by
`init` / `generate-ca` / `write-github-config` — never by the weave, never duplicated into
`pre-scripts/`/`post-scripts/`:

```
vm-shared/          cert.pem  credentials.json  auth.json  github-config.txt  home-jq-transforms/
vm-shared-windows/  cert.pem  credentials.json  auth.json  github-config.txt  home-jq-transforms/
```

Today the built-in scripts live at the share root too, so they read these as
`$script_dir/<file>`. Under this design the scripts move one level down into `<phase>/`, so the
built-in scripts that consume them — **in both shares, in both the `.sh` and `.ps1`
implementation** — change to read from the **script's parent directory**. Each row below is one
conceptual step with two implementations that change identically:

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
- `init` scaffolds empty `.configamatron/pre-scripts/` and `.configamatron/post-scripts/`
  folders — each seeded with a short placeholder `README.md`, since git does not track empty
  directories and the customization points must survive commit/clone and stay discoverable —
  then runs the same weave-and-copy logic as `update-shares`. With the custom folders empty the
  generated shares contain only the woven built-ins, so a freshly initialized environment is
  runnable without an extra manual step. (`init` still refuses to run over an existing
  `.configamatron/`, so these folders only ever come into being through `init` itself.)
- **Whole-transaction regeneration.** `update-shares`/`init` run *all* preflight first — script
  naming, resource collisions, and the jq-transform previews — across both phases and both
  platforms, and mutate nothing until every check passes; a violation aborts the whole run
  before any share is touched. Each generated `<phase>/` directory is then **replaced**
  (stage-then-swap, as `update-shares` already does for `home-jq-transforms`), not overlaid, so a
  script or resource the user deletes disappears from the output instead of lingering. Swaps
  happen only after all staging succeeds, minimizing the window; a failure mid-swap restores
  from the staged backup, matching the existing per-target recovery.

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

**Migration note.** A `.gitignore` never untracks files already in the git index. A user who
committed an older, denylist-era `.configamatron/` has generated share scripts tracked, and
shipping the new allowlist alone won't drop them from future commits. Because environments are
rebuilt fresh via `init` (which refuses to run over an existing `.configamatron/`), the clean
path is delete-and-re-init; for an in-place upgrade the README should instruct
`git rm -r --cached .configamatron && git add .configamatron` (then commit), which re-applies the
new `.gitignore` so previously-tracked generated files leave the index while staying on disk and
only the allowlisted inputs are re-added.

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

- New unit tests for the weave function: naming validation (empty name, uppercase extension,
  bad prefix), `nn` rejected when `allowSentinel:false` and honored when true, tie-break by
  filename, contiguous renumbering + output-name construction, `>99` overflow error,
  opposite-extension script in a built-in platform folder rejected, independent `.sh`/`.ps1`
  ordering, and `nn-configure-network` landing strictly last even with custom pre-scripts
  present.
- New tests for resource routing and collision handling: built-in resources land only in their
  own platform share, custom resources land in both, and each collision class fails loud (no
  partial copy, names both sides) — file-vs-file, file-vs-directory, ancestor conflict,
  passthrough-vs-generated-script, and a case-only clash on the Windows share; two same-named
  directories merge instead of colliding.
- New tests for whole-transaction regeneration: a naming/collision/jq violation aborts before
  any share is mutated; a resource or script the user deletes disappears from the regenerated
  `<phase>/` (replace, not overlay).
- New tests for `init` scaffolding: it creates empty `pre-scripts/`/`post-scripts/` with
  placeholder READMEs, and a freshly initialized environment is runnable with built-ins only.
- Re-introduce a `.gitignore` content-assertion test. The old one was removed for being
  unstable against the churning denylist; the allowlist only names the rarely-changing
  user-authored inputs, so it is stable enough to assert on again.
- Update the built-in scripts' environment-file references to the script's parent directory
  (`cert.pem`, `github-config.txt`, `credentials.json`, `auth.json`, `home-jq-transforms/`) in
  both the `.sh` and `.ps1` implementations, and cover that the woven scripts resolve them
  correctly from `<phase>/`.
- `tests/vm/vm.test.ts` and other VM-harness references to `01-apt-packages.sh` etc. move to the
  new `pre-scripts/`/`post-scripts/` paths.
- `README.md`, `usage-windows-vm.md`, `technical-notes.md` updated for the new folder structure,
  restart-at-01 numbering, the inverted `.gitignore` guidance, and the index-migration step for
  users upgrading an already-committed denylist-era environment.
