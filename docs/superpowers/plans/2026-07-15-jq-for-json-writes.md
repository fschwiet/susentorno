# jq for JSON Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ad-hoc JSON manipulation (python3 heredocs on Ubuntu, ConvertFrom/To-Json on Windows) in the five VM provisioning scripts that write JSON with `jq`, for one consistent JSON tool across both platforms.

**Architecture:** Each of the five sites keeps its own inline jq block (no shared helper). Every site reads the existing file with `jq`, falling back to `{}` when the file is missing or unparsable, applies a merge filter, writes to a temp file, then atomically moves it into place. A prerequisite task adds `jq` to the Ubuntu apt install (Windows already installs it). Tests are content-assertions in the existing `tests/unit/templates.test.ts` vitest suite.

**Tech Stack:** bash + jq (Ubuntu), PowerShell + jq (Windows), vitest (tests), prettier with `prettier-plugin-sh` (formatting).

## Global Constraints

- Preserve the existing semantics at every site: **merge into any existing file**, and **start fresh (`{}`) only when the file is missing or unparsable** — never fail provisioning on a corrupt file.
- Each site must write via a temp file then move/rename into place (atomic; never leave a truncated destination).
- Shell scripts are formatted by `prettier` (`prettier-plugin-sh`); the repo's `test` script runs `prettier --check .`, so every edited `.sh` and `.ts` file must stay prettier-clean. `.ps1` files have no prettier parser and are not format-checked.
- Run a single test file with: `pnpm exec vitest run tests/unit/templates.test.ts`, and filter by name with `-t "<substring>"`.
- Reference paths are relative to repo root `C:/code/fschwiet-agent`.

---

### Task 1: Add jq to the Ubuntu apt install

**Files:**
- Modify: `templates/vm-shared/01-apt-packages.sh:6`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `jq` present on the Ubuntu VM PATH for Tasks 2–4. (Windows already installs `jqlang.jq` in `01-install-packages.ps1`.)

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside the `describe('templates', ...)` in `tests/unit/templates.test.ts`, just before the closing `});` of the describe:

```ts
  it('ubuntu 01-apt-packages installs jq for JSON edits', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '01-apt-packages.sh'), 'utf8');
    expect(s).toContain('jq');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "installs jq"`
Expected: FAIL — `01-apt-packages.sh` does not yet contain `jq`.

- [ ] **Step 3: Add jq to the apt install line**

In `templates/vm-shared/01-apt-packages.sh`, change line 6 from:

```bash
sudo apt install -y curl git build-essential okular
```

to:

```bash
sudo apt install -y curl git build-essential okular jq
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "installs jq"`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm exec prettier --write templates/vm-shared/01-apt-packages.sh tests/unit/templates.test.ts
git add templates/vm-shared/01-apt-packages.sh tests/unit/templates.test.ts
git commit -m "feat: install jq on the Ubuntu VM"
```

---

### Task 2: Ubuntu 08-claude-config.sh writes .claude.json with jq

**Files:**
- Modify: `templates/vm-shared/08-claude-config.sh:8-30`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `jq` on PATH (Task 1).
- Produces: `~/.claude.json` with `hasCompletedOnboarding = true` merged in. No behavior other tasks depend on.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside `describe('templates', ...)`:

```ts
  it('ubuntu 08-claude-config writes .claude.json with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '08-claude-config.sh'), 'utf8');
    expect(s).toContain('jq . "$claude_json"');
    expect(s).toContain('.hasCompletedOnboarding = true');
    expect(s).not.toContain('python3');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "08-claude-config writes"`
Expected: FAIL — script still uses the python3 heredoc.

- [ ] **Step 3: Replace the python3 heredoc with jq**

In `templates/vm-shared/08-claude-config.sh`, replace the comment-plus-heredoc block currently at lines 8–30 (from the `# The claude CLI refuses...` comment through the closing `PY`) with:

```bash
# The claude CLI refuses to run until ~/.claude.json records that onboarding
# completed. Merge the single flag into any existing file with jq rather than
# clobbering it, starting fresh only if the file is missing or unparsable. Write
# to a temp file and move it into place so a failure never truncates the target.
claude_json="$HOME/.claude.json"
base=$(jq . "$claude_json" 2> /dev/null || echo '{}')
tmp=$(mktemp)
printf '%s' "$base" | jq '.hasCompletedOnboarding = true' > "$tmp"
mv "$tmp" "$claude_json"
```

Leave the rest of the file (the `ln -sfn ...` credential symlink and the final `echo`) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "08-claude-config writes"`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm exec prettier --write templates/vm-shared/08-claude-config.sh tests/unit/templates.test.ts
git add templates/vm-shared/08-claude-config.sh tests/unit/templates.test.ts
git commit -m "refactor: write .claude.json with jq on Ubuntu"
```

---

### Task 3: Ubuntu 04-configure-tools.sh writes settings.json with jq

**Files:**
- Modify: `templates/vm-shared/04-configure-tools.sh:24-47`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `jq` on PATH (Task 1).
- Produces: VS Code `settings.json` with the four required keys merged in.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside `describe('templates', ...)`:

```ts
  it('ubuntu 04-configure-tools writes settings.json with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '04-configure-tools.sh'), 'utf8');
    expect(s).toContain('jq . "$vscode_settings"');
    expect(s).toContain('.["editor.defaultFormatter"] = "esbenp.prettier-vscode"');
    expect(s).not.toContain('python3');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "04-configure-tools writes"`
Expected: FAIL — script still uses the python3 heredoc.

- [ ] **Step 3: Replace the python3 heredoc with jq**

In `templates/vm-shared/04-configure-tools.sh`, replace the comment-plus-heredoc block currently at lines 24–47 (from the `# Merge our required settings...` comment through the closing `PY`) with:

```bash
# Merge our required settings into any existing file with jq rather than
# clobbering it, starting fresh only if the file is missing or unparsable. Write
# to a temp file and move it into place so a failure never truncates the target.
base=$(jq . "$vscode_settings" 2> /dev/null || echo '{}')
tmp=$(mktemp)
printf '%s' "$base" | jq '
  .["files.autoSave"] = "afterDelay"
  | .["editor.formatOnSave"] = true
  | .["editor.defaultFormatter"] = "esbenp.prettier-vscode"
  | .["[csharp]"] = {"editor.defaultFormatter": "csharpier.csharpier-vscode"}
' > "$tmp"
mv "$tmp" "$vscode_settings"
```

Leave the `vscode_settings_dir` / `mkdir` / `vscode_settings` assignment lines above the block, and everything below it (codebase-memory-mcp install, mcp add commands), unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "04-configure-tools writes"`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm exec prettier --write templates/vm-shared/04-configure-tools.sh tests/unit/templates.test.ts
git add templates/vm-shared/04-configure-tools.sh tests/unit/templates.test.ts
git commit -m "refactor: write VS Code settings.json with jq on Ubuntu"
```

---

### Task 4: Ubuntu 06-trust-ca.sh merges the Firefox CA with jq

**Files:**
- Modify: `templates/vm-shared/06-trust-ca.sh:41-66`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `jq` on PATH (Task 1); the surrounding shell variables `policy_file`, `ca_for_firefox`, `ca_stale` already defined earlier in the script.
- Produces: `policies.json` with `.policies.Certificates.Install` containing our CA exactly once and the stale `/usr/local/...` path removed.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside `describe('templates', ...)`:

```ts
  it('ubuntu 06-trust-ca merges the Firefox CA with jq, not python3', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared', '06-trust-ca.sh'), 'utf8');
    expect(s).toContain('sudo jq . "$policy_file"');
    expect(s).toContain('.policies.Certificates.Install');
    expect(s).not.toContain('python3');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "06-trust-ca merges"`
Expected: FAIL — script still uses the `sudo python3` heredoc.

- [ ] **Step 3: Replace the sudo python3 heredoc with jq**

In `templates/vm-shared/06-trust-ca.sh`, replace the comment-plus-heredoc block currently at lines 41–66 (from the `# Merge our CA into any existing policy...` comment through the closing `PY`) with:

```bash
  # Merge our CA into any existing policy with jq rather than clobbering it, and
  # drop the snap-unreadable /usr/local path earlier revisions of this script
  # wrote. The policy file is root-owned, so read and write it under sudo; jq's
  # merge itself runs as the normal user (it only reads stdin). Removing then
  # re-appending the CA keeps it present exactly once and makes the update
  # idempotent. Start fresh only if the file is missing or unparsable.
  base=$(sudo jq . "$policy_file" 2> /dev/null || echo '{}')
  tmp=$(mktemp)
  printf '%s' "$base" | jq \
    --arg ca "$ca_for_firefox" \
    --arg stale "$ca_stale" \
    '.policies.Certificates.Install = ((.policies.Certificates.Install // []) - [$stale, $ca] + [$ca])' \
    > "$tmp"
  sudo cp "$tmp" "$policy_file"
  rm -f "$tmp"
```

Leave the lines above the block (the `if command -v firefox ...` guard, `policy_dir`/`policy_file`/`ca_for_firefox`/`ca_stale` assignments, `sudo mkdir`, `sudo cp` of the cert, `sudo chmod 644 "$ca_for_firefox"`) unchanged, and leave the lines below unchanged (`sudo chmod 644 "$policy_file"`, the `echo`, the `else`/`fi`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "06-trust-ca merges"`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
pnpm exec prettier --write templates/vm-shared/06-trust-ca.sh tests/unit/templates.test.ts
git add templates/vm-shared/06-trust-ca.sh tests/unit/templates.test.ts
git commit -m "refactor: merge Firefox CA policy with jq on Ubuntu"
```

---

### Task 5: Windows 08-claude-config.ps1 writes .claude.json with jq

**Files:**
- Modify: `templates/vm-shared-windows/08-claude-config.ps1:7-16`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `jq` on PATH (installed by Windows `01-install-packages.ps1`).
- Produces: `.claude.json` with `hasCompletedOnboarding = true` merged in. The existing template test at "windows CA + claude scripts cover all trust surfaces" still expects this file to contain `hasCompletedOnboarding` and `.credentials.json` — both remain true after this change.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside `describe('templates', ...)`:

```ts
  it('windows 08-claude-config writes .claude.json with jq', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared-windows', '08-claude-config.ps1'), 'utf8');
    expect(s).toContain('jq . $claudeJson');
    expect(s).toContain('.hasCompletedOnboarding = true');
    expect(s).not.toContain('ConvertTo-Json');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "windows 08-claude-config writes"`
Expected: FAIL — script still uses `ConvertTo-Json`.

- [ ] **Step 3: Replace the ConvertFrom/To-Json block with jq**

In `templates/vm-shared-windows/08-claude-config.ps1`, replace the comment-plus-code block currently at lines 7–16 (from the `# The claude CLI refuses...` comment through the `$data | ConvertTo-Json ...` line) with:

```powershell
# The claude CLI refuses to run until ~/.claude.json records onboarding completed.
# Merge the single flag into any existing file with jq; start fresh if missing or
# unparsable. Write to a temp file and move it into place so a failure never
# truncates the target.
$claudeJson = Join-Path $env:USERPROFILE '.claude.json'
$base = jq . $claudeJson 2>$null
if ($LASTEXITCODE -ne 0) { $base = '{}' }
$tmp = [System.IO.Path]::GetTempFileName()
$base | jq '.hasCompletedOnboarding = true' | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force $tmp $claudeJson
```

Leave the lines above (`$ErrorActionPreference`, `$scriptDir`, `$claudeDir`, `New-Item ...`) and below (the credential `Copy-Item` and the final `Write-Host`) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "windows 08-claude-config writes"`
Expected: PASS.

- [ ] **Step 5: Format the test file and commit**

(`.ps1` files have no prettier parser, so only the `.ts` file is formatted.)

```bash
pnpm exec prettier --write tests/unit/templates.test.ts
git add templates/vm-shared-windows/08-claude-config.ps1 tests/unit/templates.test.ts
git commit -m "refactor: write .claude.json with jq on Windows"
```

---

### Task 6: Windows 04-configure-tools.ps1 writes settings.json with jq

**Files:**
- Modify: `templates/vm-shared-windows/04-configure-tools.ps1:19-32`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: `jq` on PATH (installed by Windows `01-install-packages.ps1`); `$vscodeUserDir` already defined earlier in the script.
- Produces: VS Code `settings.json` with the four required keys merged in.

- [ ] **Step 1: Write the failing test**

Add this `it(...)` block inside `describe('templates', ...)`:

```ts
  it('windows 04-configure-tools writes settings.json with jq', () => {
    const s = readFileSync(join(templatesDir(), 'vm-shared-windows', '04-configure-tools.ps1'), 'utf8');
    expect(s).toContain('jq . $vscodeSettings');
    expect(s).not.toContain('ConvertTo-Json');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "windows 04-configure-tools writes"`
Expected: FAIL — script still uses `ConvertTo-Json`.

- [ ] **Step 3: Replace the ConvertFrom/To-Json block with jq**

In `templates/vm-shared-windows/04-configure-tools.ps1`, replace the comment-plus-code block currently at lines 19–32 (from the `$vscodeSettings = Join-Path ...` line through the `$settingsData | ConvertTo-Json ...` line) with:

```powershell
$vscodeSettings = Join-Path $vscodeUserDir 'settings.json'

# Merge our required settings into any existing file with jq; start fresh if
# missing or unparsable. Write to a temp file and move it into place so a failure
# never truncates the target.
$base = jq . $vscodeSettings 2>$null
if ($LASTEXITCODE -ne 0) { $base = '{}' }
$tmp = [System.IO.Path]::GetTempFileName()
$base | jq '.["files.autoSave"]="afterDelay" | .["editor.formatOnSave"]=true | .["editor.defaultFormatter"]="esbenp.prettier-vscode" | .["[csharp]"]={"editor.defaultFormatter":"csharpier.csharpier-vscode"}' | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force $tmp $vscodeSettings
```

Leave the lines above (`$vscodeUserDir` assignment and its `New-Item`) and everything below (codebase-memory-mcp install, `claude mcp add`, `codex mcp add`, final `Write-Host`) unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "windows 04-configure-tools writes"`
Expected: PASS.

- [ ] **Step 5: Format the test file and commit**

```bash
pnpm exec prettier --write tests/unit/templates.test.ts
git add templates/vm-shared-windows/04-configure-tools.ps1 tests/unit/templates.test.ts
git commit -m "refactor: write VS Code settings.json with jq on Windows"
```

---

### Task 7: Full verification

**Files:**
- Test: `tests/unit/templates.test.ts` (whole suite) and repo-wide checks.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green bar confirming formatting, lint, types, and the full template suite pass together.

- [ ] **Step 1: Run the full template unit suite**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS — including all six new assertions and the pre-existing "windows CA + claude scripts cover all trust surfaces" test.

- [ ] **Step 2: Run format check, lint, and typecheck**

```bash
pnpm exec prettier --check .
pnpm lint
pnpm typecheck
```
Expected: all pass with no errors.

- [ ] **Step 3: Manual runtime verification (optional, requires the VM harness)**

The jq idioms were validated empirically during design (missing → fresh `{}`; existing valid → merged, other keys preserved; unparsable → fresh; Firefox array → stale removed, CA present once, idempotent). To confirm end-to-end on a real image, re-run each affected script on its VM and inspect the resulting JSON, checking:
- a first run on a machine with no prior file produces the expected keys,
- a re-run is idempotent (same output),
- an existing unrelated key in the file survives the merge.

There is no code change in this step — record the observation if performed.

- [ ] **Step 4: Final commit (only if Step 2 required formatting fixes)**

```bash
git add -A
git commit -m "chore: formatting/lint cleanup for jq JSON writes"
```
