# VM claude-config script (`08-claude-config.sh`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a numbered VM script that sets `hasCompletedOnboarding` in `~/.claude.json` and symlinks the placeholder credential into place, replacing the manual `cp` in `usage.md`, and cover both its JSON edit and `06-trust-ca.sh`'s Firefox-policy merge with VM tests.

**Architecture:** A new `templates/vm-shared/08-claude-config.sh` follows the `06`/`07` idiom (`set -euo pipefail`, `script_dir` from `BASH_SOURCE`). It merges one key into `~/.claude.json` via a `python3` heredoc and `ln -sfn`s `~/.claude/.credentials.json` to the sibling `credentials.json`. The `pnpm test:vm` harness boots a real Linux guest with the environment's `vm-shared` mounted read-only at `/mnt/vm-shared`, runs the script, and asserts the results — the honest place to test the embedded python.

**Tech Stack:** Bash, `python3` (Ubuntu base), Node/vitest VM harness (QEMU guest over WSL).

## Global Constraints

- Placeholder access token, verbatim: `sk-ant-oat-SANDBOX-PLACEHOLDER`.
- The CLI reads `~/.claude.json` (with the leading dot), not `~/claude.json`.
- Shell scripts use LF line endings and the repo idiom: `#!/usr/bin/env bash`, `set -euo pipefail`, `script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`.
- No new package dependencies — `python3` only (already relied on by `06`/`07`).
- `.configamatron/` is gitignored and generated from `templates/`; the VM harness stages `.configamatron/vm-shared/`, so any new template file must be copied there too for `pnpm test:vm` to see it (this copy is local-only, never committed).
- The guest mounts the share at `/mnt/vm-shared`; the script's `script_dir` resolves there, so the symlink target under test is `/mnt/vm-shared/credentials.json`.

---

### Task 1: Create `08-claude-config.sh`

**Files:**
- Create: `templates/vm-shared/08-claude-config.sh`
- Modify: `tests/unit/templates.test.ts:6-22` (add the new file to `expectedTemplateFiles`)
- Sync (local only, not committed): copy the new script into `.configamatron/vm-shared/08-claude-config.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a script that, when run with its sibling `credentials.json` present, sets `hasCompletedOnboarding: true` in `$HOME/.claude.json` (merging, not clobbering) and creates the symlink `$HOME/.claude/.credentials.json -> <script_dir>/credentials.json`. Prints a line beginning `08-claude-config:`.

- [ ] **Step 1: Add the failing template-manifest assertion**

In `tests/unit/templates.test.ts`, add the new file to the `expectedTemplateFiles` array (right after the `07` entry):

```ts
  'vm-shared/06-trust-ca.sh',
  'vm-shared/07-setup-persistence.sh',
  'vm-shared/08-claude-config.sh',
  'vm-shared/dnsmasq-stub.conf',
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test:unit -- templates`
Expected: FAIL — `ships every template file` fails on `vm-shared/08-claude-config.sh` (file does not exist yet).

- [ ] **Step 3: Create the script**

Create `templates/vm-shared/08-claude-config.sh` with exactly this content (LF line endings):

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.claude"

# The claude CLI refuses to run until ~/.claude.json records that onboarding
# completed. Merge the single flag into any existing file rather than clobbering
# it (starting fresh only if the file is unparsable), mirroring 06-trust-ca.sh.
# python3 is part of the Ubuntu base system, so this adds no package dependency.
claude_json="$HOME/.claude.json"
python3 - "$claude_json" <<'PY'
import json, os, sys

path = sys.argv[1]
data = {}
if os.path.exists(path):
    with open(path) as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError:
            data = {}  # unparsable file: start fresh rather than fail provisioning

data["hasCompletedOnboarding"] = True

with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY

# Symlink the placeholder credential into place instead of copying it, so it
# tracks the shared credentials.json (regenerated whenever the environment is
# re-initialized) rather than snapshotting it. -f replaces any prior file or
# symlink, so re-running is safe. The target lives on the read-only share; the
# placeholder never expires (expiresAt is year 2100), so the CLI never tries to
# rewrite it.
ln -sfn "${script_dir}/credentials.json" "$HOME/.claude/.credentials.json"

echo "08-claude-config: set hasCompletedOnboarding in ${claude_json}; linked ~/.claude/.credentials.json -> ${script_dir}/credentials.json"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:unit -- templates`
Expected: PASS — `ships every template file` now passes.

- [ ] **Step 5: Sync the script into the local `.configamatron` env (so VM tests can stage it)**

Run: `cp templates/vm-shared/08-claude-config.sh .configamatron/vm-shared/08-claude-config.sh`
Expected: no output; `.configamatron/vm-shared/08-claude-config.sh` now exists. (This path is gitignored — it is not part of the commit; it just lets `pnpm test:vm` in Task 3 pick the script up.)

- [ ] **Step 6: Commit**

```bash
git add templates/vm-shared/08-claude-config.sh tests/unit/templates.test.ts
git commit -m "feat: add 08-claude-config.sh (onboarding flag + credential symlink)"
```

---

### Task 2: Wire the script into the documented workflow

**Files:**
- Modify: `usage.md:86-90` (replace the manual `cp` step 8)
- Modify: `templates/vm-shared/verify-config.sh:180` (update the failure hint)

**Interfaces:**
- Consumes: the `08-claude-config.sh` script from Task 1.
- Produces: nothing consumed by later tasks (documentation/diagnostic text only).

- [ ] **Step 1: Replace `usage.md` step 8**

In `usage.md`, replace the current step 8 block (the `cp` fenced code block, lines 86-90):

```markdown
8. Put the placeholder credential where the Claude Code CLI expects it:

   ```
   cp /mnt/hgfs/vm-shared/credentials.json ~/.claude/.credentials.json
   ```
```

with:

```markdown
8. `08-claude-config.sh` — sets `hasCompletedOnboarding` in `~/.claude.json` (the CLI refuses to run otherwise) and symlinks `~/.claude/.credentials.json` to the shared `credentials.json`, replacing the old manual copy.
```

- [ ] **Step 2: Update the `verify-config.sh` failure hint**

In `templates/vm-shared/verify-config.sh`, change the line at the "Placeholder credential" check (currently:)

```bash
  bad 'placeholder credential in place' "missing $cred -- copy vm-shared/credentials.json to it"
```

to:

```bash
  bad 'placeholder credential in place' "missing $cred -- run 08-claude-config.sh to link vm-shared/credentials.json"
```

- [ ] **Step 3: Sync the updated verify script into the local `.configamatron` env**

Run: `cp templates/vm-shared/verify-config.sh .configamatron/vm-shared/verify-config.sh`
Expected: no output. (Keeps the local env consistent; gitignored, not committed.)

- [ ] **Step 4: Verify no other references to the manual copy remain**

Run: `grep -rn "cp /mnt/hgfs/vm-shared/credentials.json" usage.md README.md technical-notes.md`
Expected: no matches (exit status 1). If any match remains, update it to reference `08-claude-config.sh`.

- [ ] **Step 5: Commit**

```bash
git add usage.md templates/vm-shared/verify-config.sh
git commit -m "docs: run 08-claude-config.sh instead of manual credential copy"
```

---

### Task 3: VM test coverage for `08` and `06`'s JSON merges

**Files:**
- Modify: `tests/vm/vm.test.ts` (add a new `describe` block between the `S1` block ending at line 109 and the `S2` block starting at line 111)

**Interfaces:**
- Consumes: the `guest(name, cmd)` helper (`vm.test.ts:31`) and the already-booted `g1` guest with the share mounted at `/mnt/vm-shared`; the `08-claude-config.sh` synced into `.configamatron/vm-shared/` in Task 1.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the failing test block**

Insert this `describe` block into `tests/vm/vm.test.ts` immediately after the closing `});` of the `S1: setup during NAT phase` block (after line 109) and before `describe('S2: ...`. These checks need no network and run on `g1` during the NAT phase:

```ts
describe('S1b: claude config (08) and firefox policy merge (06), offline', () => {
  it('08 sets hasCompletedOnboarding on a fresh ~/.claude.json', async () => {
    await guest('g1', 'rm -f "$HOME/.claude.json" && bash /mnt/vm-shared/08-claude-config.sh');
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.claude.json')))['hasCompletedOnboarding'])"`,
    );
    expect(stdout.trim()).toBe('True');
  });

  it('08 merges into an existing ~/.claude.json without clobbering, idempotently', async () => {
    await guest(
      'g1',
      `printf '%s' '{"someExisting": 123}' > "$HOME/.claude.json" && bash /mnt/vm-shared/08-claude-config.sh && bash /mnt/vm-shared/08-claude-config.sh`,
    );
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.claude.json')));print(d['hasCompletedOnboarding'], d['someExisting'])"`,
    );
    expect(stdout.trim()).toBe('True 123');
  });

  it('08 symlinks the placeholder credential into place', async () => {
    const link = await guest('g1', 'readlink "$HOME/.claude/.credentials.json"');
    expect(link.stdout.trim()).toBe('/mnt/vm-shared/credentials.json');
    const body = await guest('g1', 'cat "$HOME/.claude/.credentials.json"');
    expect(body.stdout).toContain('sk-ant-oat-SANDBOX-PLACEHOLDER');
  });

  it('06 merges the CA into an existing firefox policies.json, preserving other keys', async () => {
    await guest(
      'g1',
      `printf '#!/bin/sh\\n' | sudo tee /usr/local/bin/firefox >/dev/null && sudo chmod +x /usr/local/bin/firefox && sudo mkdir -p /etc/firefox/policies && printf '%s' '{"policies":{"SomeOther":true,"Certificates":{"Install":["/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt"]}}}' | sudo tee /etc/firefox/policies/policies.json >/dev/null && bash /mnt/vm-shared/06-trust-ca.sh`,
    );
    const { stdout } = await guest(
      'g1',
      `python3 -c "import json;d=json.load(open('/etc/firefox/policies/policies.json'));i=d['policies']['Certificates']['Install'];print(d['policies']['SomeOther'], '/etc/firefox/policies/configamatron-proxy-certificate-authority.pem' in i, '/usr/local/share/ca-certificates/configamatron-proxy-certificate-authority.crt' in i)"`,
    );
    expect(stdout.trim()).toBe('True True False');
  });
});
```

- [ ] **Step 2: Run the VM suite to verify the new tests pass**

Run: `pnpm test:vm`
Expected: PASS for all four new `S1b` tests:
- `08 sets hasCompletedOnboarding on a fresh ~/.claude.json` → the fresh-file merge produced `True`.
- `08 merges into an existing ~/.claude.json without clobbering, idempotently` → `True 123` (flag set, `someExisting` preserved, two runs stable).
- `08 symlinks the placeholder credential into place` → link target `/mnt/vm-shared/credentials.json`, contents contain the placeholder token.
- `06 merges the CA into an existing firefox policies.json, preserving other keys` → `True True False` (unrelated key preserved, CA pem added, stale crt removed).

The existing `S1`/`S2`/`S3` tests must still pass. If the guest cannot reach Envoy, this is the harness prerequisite (Docker Desktop WSL integration / `CFGM_VMTEST_ENVOY_HOST`) called out in `vm.test.ts:49-54`, not a fault in the new tests.

- [ ] **Step 3: Commit**

```bash
git add tests/vm/vm.test.ts
git commit -m "test(vm): cover 08 onboarding/symlink and 06 firefox policy merge"
```

---

## Self-Review

**Spec coverage:**
- New `08-claude-config.sh` setting `hasCompletedOnboarding` + symlink → Task 1. ✓
- `usage.md` step 8 replacement → Task 2. ✓
- `verify-config.sh` hint update → Task 2. ✓
- VM tests: 08 fresh / merge+idempotent / symlink → Task 3. ✓
- VM test: 06 firefox policy merge (stub firefox, preserve unrelated key, add pem, remove stale crt) → Task 3. ✓
- Read-only-share / `~/.claude.json` (dot) notes captured in the script comments and Global Constraints. ✓
- Non-goal (no python-from-bash refactor) respected — tests exercise the real scripts. ✓

**Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to Task N" — every step has concrete content and commands. ✓

**Type/name consistency:** Test target path `/mnt/vm-shared/credentials.json` matches the guest mount; `expectedTemplateFiles` entry `vm-shared/08-claude-config.sh` matches the created file; the placeholder token string is identical everywhere. ✓
