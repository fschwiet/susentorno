# Custom scripts for VM setup

**Date:** 2026-07-21
**Status:** Draft. One open issue (resource-file location for built-in scripts) is explicitly
deferred — see below. Pausing here for further discussion before this moves to implementation.

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
  matching `^[0-9]{2}_.*\.(sh|ps1)$` are treated as runnable steps. Validated up front — any
  `.sh`/`.ps1` file in the folder that doesn't match is a hard error (fail loud, list every
  offending filename), not a silent skip.
- Anything else in the folder — other extensions, subfolders and their contents — is passed
  through untouched, so a numbered script can reference it by relative path (e.g.
  `lib/helper.sh` above).
- `.sh` and `.ps1` files are ordered independently by their own two-digit prefix. A folder can
  hold both platforms' version of the "same" conceptual step side by side.
- Prefixes don't need to be contiguous — they only establish sort order.

## Built-in template layout

`templates/vm-shared/` and `templates/vm-shared-windows/` each split their numbered scripts
(and co-located resource files) into `pre-scripts/` and `post-scripts/` subfolders, matching the
phase they already run in today:

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
`.../post-scripts/`), keeping today's `.ps1` content and the `dns-responder/` folder.

Built-in scripts keep the existing hyphen naming style (`NN-name.ext`), and reserve
`nn-name.ext` as a sentinel meaning "always run last within this phase, regardless of how many
other scripts precede it." Today exactly one script uses it: `nn-configure-network`. It trusts
the proxy CA, installs the DNS/egress rules, and points the VM's resolver at the local stub —
once applied, later network activity is already constrained to the allowlist, so it must run
only after every other pre-isolation script (built-in or custom) that might need broader
network access.

## Weaving algorithm

One function orders a single folder's scripts: validate naming, sort by numeric prefix, pull
any `nn-`/`nn_` sentinel to the end. It has no notion of "built-in" vs. "custom" — it just
orders whatever folder it's given, which is what lets built-in scripts be renamed/renumbered/
reordered later without touching this code.

Assembly for one phase (pre or post) and one platform (extension `.sh` or `.ps1`):

1. Run the weave function over the built-in template phase folder, filtered to the target
   extension.
2. Run the weave function over the corresponding `.configamatron/pre-scripts/` or
   `.configamatron/post-scripts/` folder, filtered to the same extension.
3. Concatenate: built-in list, then custom list.
4. Re-run the sentinel-to-end pass and contiguous renumbering (`01`, `02`, `03`, ...) over the
   concatenated result.
5. Write the renumbered scripts into `vm-shared/pre-scripts/` (or `post-scripts/`) /
   `vm-shared-windows/pre-scripts/` (or `post-scripts/`) as appropriate — only matching-extension
   scripts land in a given share.

Passthrough files (everything that isn't a validated `NN_`/`NN-`/`nn-` script, from both the
built-in template folder and the user's source folder) are copied into **both** shares'
corresponding `pre-scripts/`/`post-scripts/` folder, regardless of which platform "owns" them.
This avoids needing logic to decide which extra file belongs to which platform — the cost is a
Linux share ending up with a stray Windows-only resource file (or vice versa) that nothing on
that platform references, which is harmless.

## Known open issue (deferred)

Built-in scripts currently expect certain resource files to be reachable at a specific location
relative to themselves — e.g. `nn-configure-network` reads `dnsmasq-stub.conf`,
`configamatron-egress.service`, and `60-dns-override.yaml` from beside itself; the post-scripts
applier reads `apply-home-jq-transforms.mjs` from beside itself. Duplicating passthrough files
from *both* the built-in template and the user's custom folder into both shares' generated
`pre-scripts/`/`post-scripts/` folder should keep "beside itself" relative-path resolution
working, but there is no concrete rule yet for:

- what happens when a built-in resource file and a user passthrough file share the same name in
  the generated output, and
- whether resource files should be namespaced or scoped in some way to avoid this rather than
  relying on filename luck.

**Not resolved in this version.** Revisit before implementation finalizes this part of the
design.

## Generated output (gitignored, regenerated by `init` and `update-shares`)

```
vm-shared/pre-scripts/            vm-shared-windows/pre-scripts/
vm-shared/post-scripts/           vm-shared-windows/post-scripts/
```

- Never hand-edited. A user who wants to change behavior edits `.configamatron/pre-scripts/` or
  `.configamatron/post-scripts/` and re-runs `update-shares` (or `init` for a fresh
  environment).
- Added to `.configamatron/.gitignore`: `vm-shared/pre-scripts/`, `vm-shared/post-scripts/`,
  `vm-shared-windows/pre-scripts/`, `vm-shared-windows/post-scripts/`.
- `init` runs the same weave-and-copy logic as `update-shares` (against an initially empty
  `.configamatron/pre-scripts/` / `.configamatron/post-scripts/`), so a freshly initialized
  environment is runnable without an extra manual step.
- `update-shares` validates `.configamatron/pre-scripts/` and `.configamatron/post-scripts/`
  naming up front and fails loud — no partial copy — on a violation, consistent with how it
  already blocks the copy on a bad jq transform.

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

- `tests/vm/vm.test.ts` and other VM-harness references to `01-apt-packages.sh` etc. move to the
  new `pre-scripts/`/`post-scripts/` paths.
- `README.md`, `usage-windows-vm.md`, `technical-notes.md` updated for the new folder structure
  and restart-at-01 numbering.
- New unit tests for the weave function (naming validation, sentinel handling, contiguous
  renumbering, independent `.sh`/`.ps1` ordering) and for `update-shares`/`init` writing the
  four generated locations correctly.
