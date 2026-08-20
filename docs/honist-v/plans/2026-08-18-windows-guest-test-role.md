# Windows Guest Test Role Implementation Plan

**Goal:** Add a `windowsFresh` role to susentorno's `guest` test tier that boots a real Windows 11 guest on the real Internal switch and asserts it reaches exactly the destinations the network policy permits — plus the `templates/vm-shared-windows/` trim that ADR-0024 deferred until such a role existed.

**Architecture:** A Windows golden VHDX is built once from a locally-supplied evaluation ISO, attached unmodified as a DVD alongside a second one-file ISO carrying `autounattend.xml`. Per-test guests boot from differencing disks off that parent. The harness drives the guest over **PowerShell Direct** (Hyper-V VMBus), not SSH, so a broken guest network — the thing under test — still leaves a diagnostic channel. Everything derives from the `test` isolation name and is swept by name.

**Tech Stack:** TypeScript, Vitest, Node 18+, pnpm, PowerShell 5.1 (via `powershell.exe`), Hyper-V, Windows `IMAPI2FS` and `Msvm_VirtualSystemManagementService` COM/WMI.

**Spec:** [`docs/honist-v/specs/2026-08-18-windows-guest-test-role-design.md`](../specs/2026-08-18-windows-guest-test-role-design.md)

## Global Constraints

- **No changes to `src/`.** Where the role needs something the production modules do not offer for Windows, the harness does it directly. `src/guestSetup/hostTrustStore.ts` and `src/guestSetup/ambientTrust.ts` are *consumed*, never modified.
- **Never use `npx` or `pnpx`.** Use `pnpm vitest run …` / `pnpm exec …`. `pnpx` fetches an isolated copy and ignores the lockfile.
- **Prettier and ESLint gate every commit.** Run `pnpm format` before committing; `pnpm lint` must pass. `.ps1` files are linted by `pnpm lint:ps1`.
- **Isolation name is `test`**; `NAME_PREFIX` is `susentorno-test`. Every host object derives from it.
- **Share account is `susentorno-test`** — 20 characters is `New-LocalUser`'s hard limit.
- **Environment variables:** `SUSENTORNO_WINDOWS_ISO` (path to an **x64, `en-us`** Windows 11 Enterprise evaluation ISO), `SUSENTORNO_WINDOWS_IMAGE_REBUILD=1` (force a rebuild).
- **Maximum golden image age: 60 days.** The evaluation is time-limited and an input-only stamp would otherwise stay valid past expiry.
- **The Windows guest account is the built-in `Administrator`** (RID 500), because `nn-configure-network.ps1` declares `#Requires -RunAsAdministrator`.
- **Revocation must be waived on susentorno-issued leaves only.** `src/ca.ts` issues no CRL/OCSP endpoints. Use `curl.exe --ssl-no-revoke` and `git -c http.schannelCheckRevoke=false`. Passthrough destinations keep revocation checking on.
- **Woven script numbering after this work:** both platforms weave `nn-configure-network` out as `04-configure-network.{sh,ps1}`.

## Deviation from the spec, deliberately

The spec §1.6 says `goldenStamp.ts` "generalises to take a stamp path and an inputs object." This plan instead adds a **new** `tests/guest/hyperv/stampMap.ts` and leaves `goldenStamp.ts` untouched. Same requirement met — per-input digests, so the stale-image error can name what changed — with no risk to the working Ubuntu pipeline. Task 5 covers it.

## File Structure

**Stage 1 — template trim (no Windows-platform risk; land first)**

| File | Responsibility |
| --- | --- |
| `templates/vm-shared-windows/pre-scripts/01-install-packages.ps1` | Modify — reduce to `jq`, `Git.Git`, `GitHub.cli` |
| `templates/vm-shared-windows/pre-scripts/02-install-pnpm.ps1` | Modify — drop `pip install PyYAML` |
| `templates/vm-shared-windows/pre-scripts/03-install-tools.ps1` | Modify — drop dotnet global tools |
| `templates/vm-shared-windows/pre-scripts/04-configure-tools.ps1` | **Delete** |
| `templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1` | Modify — stop printing its own number |
| `templates/vm-shared-windows/verify-config.ps1` | Modify — decouple section labels from numbers |
| `tests/unit/templates.test.ts`, `tests/unit/initEnv.test.ts`, `tests/cli/updateShares.test.ts` | Modify — inventory and renumbering |
| `setup-guest.md`, `development.md`, `testing.md` | Modify — documentation fallout |

**Stage 2 — golden image pipeline**

| File | Responsibility |
| --- | --- |
| `tests/guest/hyperv/imageCache.ts` | Modify — `windowsFresh` role, Windows paths, ISO env resolution |
| `tests/guest/hyperv/sweep.ts` | Modify — stop deleting golden parents |
| `tests/guest/hyperv/stampMap.ts` | Create — per-input digest map, diffing |
| `tests/guest/hyperv/windowsCredential.ts` | Create — generate and persist the guest password |
| `tests/guest/windowsAutounattend.ts` | Create — `autounattend.xml` and the provisioning state machine |
| `tests/guest/hyperv/answerFileIso.ts` | Create — one-file ISO via `IMAPI2FS` |
| `tests/guest/hyperv/vmScreenshot.ts` | Create — RGB565 → BMP, periodic capture |
| `tests/guest/hyperv/vm.ts` | Modify — DVD drive, DVD boot device, Windows Secure Boot template |
| `tests/guest/hyperv/windowsGoldenImage.ts` | Create — build orchestration, stamp, age policy |
| `tests/guest/globalSetup.ts` | Modify — conditional Windows image build |

**Stage 3 — the role**

| File | Responsibility |
| --- | --- |
| `tests/guest/windowsGuestExec.ts` | Create — PowerShell Direct transport |
| `tests/guest/testShare.ts` | Modify — derive share name from the share folder |
| `tests/guest/hyperv/windowsTestGuest.ts` | Create — role VM lifecycle |
| `tests/guest/windowsAmbientTrust.ts` | Create — guest-side ambient root installer |
| `tests/guest/windowsDiagnostics.ts` | Create — failure dumps |
| `tests/guest/windowsFresh.test.ts` | Create — the role |
| `docs/adr/0027-windows-guest-tested-over-powershell-direct.md`, `CONTEXT.md`, `docs/adr/0024-…md` | Create/modify — domain record |

---

# Stage 1 — Template trim

### Task 1: Trim the content of the Windows pre-scripts

Content only. The file deletion and its renumbering fallout are Task 2, so a reviewer can accept this and reject that. This mirrors how the Linux trim was staged (`docs/honist-v/plans/2026-08-15-hyperv-guest-tier-preparation.md`, Tasks 8–9).

**Files:**

- Modify: `templates/vm-shared-windows/pre-scripts/01-install-packages.ps1`
- Modify: `templates/vm-shared-windows/pre-scripts/02-install-pnpm.ps1`
- Modify: `templates/vm-shared-windows/pre-scripts/03-install-tools.ps1`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `01-install-packages.ps1` installs exactly `jqlang.jq`, `Git.Git`, `GitHub.cli`. Later tasks rely on Git being installable but do **not** run this script.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/templates.test.ts`, inside the existing `describe('windows pre-/post-isolation step scripts', …)` block:

```ts
it('windows 01-install-packages ships only the packages a susentorno guest requires', () => {
  const script = readFileSync(
    join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '01-install-packages.ps1'),
    'utf8',
  );
  for (const id of ['jqlang.jq', 'Git.Git', 'GitHub.cli']) expect(script).toContain(id);
  for (const id of [
    'Microsoft.PowerShell',
    'Microsoft.DotNet.SDK',
    'Microsoft.VisualStudioCode',
    'Microsoft.WindowsTerminal',
    'WinMerge.WinMerge',
    'Docker.DockerDesktop',
    'Python.Python',
    'Microsoft.VCRedist',
  ])
    expect(script, id).not.toContain(id);
  expect(script).not.toContain('wsl --update');
});

it('windows 02-install-pnpm installs pnpm and nothing python-related', () => {
  const script = readFileSync(
    join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '02-install-pnpm.ps1'),
    'utf8',
  );
  expect(script).toContain('get.pnpm.io/install.ps1');
  expect(script).not.toContain('pip install');
  expect(script).not.toContain('PyYAML');
});

it('windows 03-install-tools ships the three agents and no dotnet global tools', () => {
  const script = readFileSync(
    join(templatesDir(), 'vm-shared-windows', 'pre-scripts', '03-install-tools.ps1'),
    'utf8',
  );
  expect(script).toContain('pnpm runtime set node latest -g');
  expect(script).toContain('@earendil-works/pi-coding-agent');
  expect(script).toContain('Anthropic.ClaudeCode');
  expect(script).toContain('@openai/codex');
  expect(script).not.toContain('dotnet tool install');
  expect(script).not.toContain('VS Code');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts -t "windows 01-install-packages ships only"`

Expected: FAIL — the script still contains `Microsoft.DotNet.SDK.10` and the rest.

- [ ] **Step 3: Rewrite `01-install-packages.ps1`**

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

try {
  winget settings --enable BypassCertificatePinningForMicrosoftStore
  winget upgrade Microsoft.AppInstaller --accept-source-agreements --accept-package-agreements
} finally {
  winget settings --disable BypassCertificatePinningForMicrosoftStore
}

winget upgrade --all --include-unknown --accept-source-agreements --accept-package-agreements

# winget ships with Windows 11. Install non-interactively. Native non-zero exit
# codes (e.g. "package already installed") do not throw in PowerShell, so a
# re-run is safe. Runs while the VM is still on NAT (pre-isolation).
#
# Only what a susentorno guest requires (see ADR-0024): jq for the home settings
# transforms, git for configure-network and 01-auth-config, gh for 01-auth-config.
# Developer tooling belongs in the user's own pre-scripts/.
$packages = @(
  'jqlang.jq',
  'Git.Git',
  'GitHub.cli'
)

foreach ($id in $packages) {
  Write-Host "01-install-packages: installing $id"
  winget install --id $id --exact --silent --accept-source-agreements --accept-package-agreements --source winget
}

Write-Host "01-install-packages: required packages installed. Open a new terminal so PATH updates apply."
```

- [ ] **Step 4: Rewrite `02-install-pnpm.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

# Standalone pnpm (no Node required yet). Mirrors Ubuntu 02-install-pnpm.sh.
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression

Write-Host "02-install-pnpm: pnpm installed. Open a new terminal before running 03-install-tools.ps1 so pnpm is on PATH."
```

- [ ] **Step 5: Rewrite `03-install-tools.ps1`**

```powershell
$ErrorActionPreference = 'Stop'

# Node runtime managed by pnpm (mirrors Ubuntu 03-install-tools.sh).
pnpm runtime set node latest -g

# Pi Coding Agent
pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent

# Claude Code CLI — native Windows installer.
winget install Anthropic.ClaudeCode

# Codex CLI — cross-platform npm package via pnpm.
pnpm add -g @openai/codex

Write-Host "03-install-tools: node runtime, pi-coding-agent, claude, and codex installed. Open a new terminal so PATH updates apply."
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run tests/unit/templates.test.ts`

Expected: PASS.

- [ ] **Step 7: Format, lint, commit**

```bash
pnpm format
pnpm lint
git add templates/vm-shared-windows/pre-scripts/ tests/unit/templates.test.ts
git commit -m "refactor(templates): trim the Windows pre-scripts to what a guest requires"
```

---

### Task 2: Delete `04-configure-tools.ps1` and absorb the renumbering

Deleting the fourth built-in pre-script means `nn-configure-network.ps1` weaves out as `04-` instead of `05-`, closing the divergence ADR-0024 recorded.

**Files:**

- Delete: `templates/vm-shared-windows/pre-scripts/04-configure-tools.ps1`
- Modify: `templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1`
- Modify: `templates/vm-shared-windows/verify-config.ps1`
- Test: `tests/unit/templates.test.ts:33`, `tests/unit/initEnv.test.ts:60`, `tests/cli/updateShares.test.ts`

**Interfaces:**

- Consumes: Task 1's trimmed scripts.
- Produces: the woven Windows pre-script `04-configure-network.ps1`, taking `-HostIp <ip>`. **Task 15 invokes this exact filename.**

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, delete the line `'vm-shared-windows/pre-scripts/04-configure-tools.ps1',` from `expectedTemplateFiles`, and add this alongside the existing Ubuntu pre-script inventory test:

```ts
it('ships exactly the four windows pre-scripts a guest requires', () => {
  const dir = join(templatesDir(), 'vm-shared-windows', 'pre-scripts');
  expect(readdirSync(dir).sort()).toEqual([
    '01-install-packages.ps1',
    '02-install-pnpm.ps1',
    '03-install-tools.ps1',
    'nn-configure-network.ps1',
  ]);
});

it('windows configure-network no longer prints its own woven number', () => {
  const net = readFileSync(
    join(templatesDir(), 'vm-shared-windows', 'pre-scripts', 'nn-configure-network.ps1'),
    'utf8',
  );
  expect(net).not.toContain('05-configure-network');
  expect(net).toContain('configure-network:');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts -t "windows pre-scripts a guest requires"`

Expected: FAIL — actual array still contains `'04-configure-tools.ps1'`.

- [ ] **Step 3: Delete the file**

```bash
git rm templates/vm-shared-windows/pre-scripts/04-configure-tools.ps1
```

Every line in it is preference: `powercfg` timeouts (ADR-0024 removed the GNOME screensaver equivalent), the `ssh-agent` service enablement (supports developing susentorno *inside* a guest, not being one), three VS Code extensions, `codebase-memory-mcp`, and context7 MCP wiring.

- [ ] **Step 4: Stop `nn-configure-network.ps1` printing its number**

Replace every `05-configure-network` occurrence with `configure-network`. The five sites are the `Write-Error` on line 10 and the `Write-Host` calls. After editing, the file's messages read:

```powershell
  Write-Error "configure-network: $CertPath not found. Run 'susentorno generate-ca' on the host first."
```

```powershell
Write-Host "configure-network: imported $CertPath into LocalMachine\Root; NODE_EXTRA_CA_CERTS=$caStable; git sslBackend=schannel"
```

```powershell
Write-Host "configure-network: CA trusted; DNS and addressing come from the host via DHCP"
```

Verify none remain: `grep -c "05-configure-network" templates/vm-shared-windows/pre-scripts/nn-configure-network.ps1` must print `0`.

- [ ] **Step 5: Decouple `verify-config.ps1` section labels from script numbers**

In `templates/vm-shared-windows/verify-config.ps1`, rename the section headers so they name the concern rather than a number:

```powershell
Section 'CA trust (configure-network)'
```

```powershell
Section 'Host DHCP/DNS (configure-network)'
```

```powershell
Section 'Placeholder credential (01-auth-config)'
```

Also update the in-script remediation hint from `run 01-auth-config.ps1` — it already names the file rather than a number, so leave it.

- [ ] **Step 6: Update `tests/unit/initEnv.test.ts`**

At line 60, change:

```ts
        'vm-shared-windows/pre-scripts/05-configure-network.ps1',
```

to:

```ts
        'vm-shared-windows/pre-scripts/04-configure-network.ps1',
```

- [ ] **Step 7: Add a Windows renumbering assertion to the CLI tier**

`tests/cli/updateShares.test.ts` does not currently name either Windows file — its `05-configure-network.sh` at line 102 is a *Linux* case where a custom script shifts the numbering. Add a Windows guard to the `reweaves pre/post scripts` test, right after the existing Linux `wovenPre` assertions:

```ts
      const wovenPreWin = join(dir, '.susentorno', 'vm-shared-windows', 'pre-scripts');
      expect(existsSync(join(wovenPreWin, '04-configure-network.ps1'))).toBe(true);
      expect(existsSync(join(wovenPreWin, '05-configure-network.ps1'))).toBe(false);
```

- [ ] **Step 8: Update `setup-guest.md`**

Line 222 becomes:

```markdown
1. `cd .\pre-scripts` and run every script in order. With no custom steps, the last is `.\04-configure-network.ps1 -HostIp <internal-switch-host-ip>`.
```

Line 229 becomes:

```markdown
When a script asks for `<host-ip>` (`04-configure-network.sh` / `04-configure-network.ps1`), it is the Internal-switch host IP from `setup-machine.md` (`192.168.67.1` here).
```

- [ ] **Step 9: Run the affected tiers**

Run: `pnpm vitest run tests/unit/templates.test.ts tests/unit/initEnv.test.ts`

Expected: PASS.

Run: `pnpm build && pnpm vitest run --config vitest.cli.config.ts tests/cli/updateShares.test.ts`

Expected: PASS.

- [ ] **Step 10: Format, lint, commit**

```bash
pnpm format
pnpm lint
git add -A templates/vm-shared-windows/ tests/unit/ tests/cli/updateShares.test.ts setup-guest.md
git commit -m "refactor(templates): delete Windows 04-configure-tools.ps1 and absorb the renumbering"
```

---

### Task 3: Documentation fallout for the trim

**Files:**

- Modify: `development.md:11-14`
- Modify: `testing.md:52`, `testing.md:77`

**Interfaces:**

- Consumes: Task 2's deletion.
- Produces: nothing consumed by later tasks. Task 16 adds the `SUSENTORNO_WINDOWS_ISO` rows to the same `testing.md` table.

- [ ] **Step 1: Note the `ssh-agent` change in `development.md`**

Append to the `ssh-agent` bullet (after the `Start-Service ssh-agent` code block):

```markdown
  If you develop susentorno from inside a Windows guest, note that `templates/vm-shared-windows/`
  no longer enables this service for you — it was removed as a preference under
  [ADR-0024](docs/adr/0024-shipped-guest-templates-carry-only-requirements.md). Run the two
  commands above manually, or add them to your own `.susentorno/pre-scripts/`.
```

- [ ] **Step 2: Verify no other doc references the deleted script**

Run: `grep -rn "04-configure-tools" --include=*.md . | grep -v node_modules | grep -v docs/honist-v/plans`

Expected: no output. (`docs/honist-v/plans/` holds historical plans and is deliberately not rewritten.)

- [ ] **Step 3: Run formatting**

Run: `pnpm format:check`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add development.md
git commit -m "docs: note that the Windows templates no longer enable ssh-agent"
```

---

# Stage 2 — Golden image pipeline

### Task 4: Windows image-cache paths, the role member, and the sweep hazard

`isSweepableChildVhd()` currently deletes every `susentorno-test-*.vhdx` except literally `susentorno-test-golden.vhdx`. A Windows parent named `susentorno-test-windows-golden.vhdx` would be destroyed at every startup and teardown, silently forcing a multi-hour rebuild. Fix that in the same task that introduces the name.

**Files:**

- Modify: `tests/guest/hyperv/imageCache.ts`
- Modify: `tests/guest/hyperv/sweep.ts:18-23`
- Test: `tests/unit/guest/sweep.test.ts`, `tests/unit/guest/imageCache.test.ts` (create)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type GuestRole = 'phases' | 'e2e' | 'fresh' | 'ambientTrust' | 'windowsFresh'`
  - `windowsGoldenVhdPath: string`, `windowsGoldenStampPath: string`, `windowsCredentialPath: string`, `windowsAnswerIsoPath: string`, `windowsBuildScreenshotDir: string`
  - `GOLDEN_PARENT_VHD_NAMES: readonly string[]`
  - `WINDOWS_ISO_ENV_VAR: string`, `WINDOWS_REBUILD_ENV_VAR: string`
  - `windowsIsoPath(env?: NodeJS.ProcessEnv): string | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/guest/imageCache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { basename } from 'node:path';
import {
  GOLDEN_PARENT_VHD_NAMES,
  WINDOWS_ISO_ENV_VAR,
  windowsGoldenVhdPath,
  windowsIsoPath,
  roleVmName,
} from '../../guest/hyperv/imageCache';

describe('windows image cache', () => {
  it('names the windows golden parent distinctly from the ubuntu one', () => {
    expect(basename(windowsGoldenVhdPath)).toBe('susentorno-test-windows-golden.vhdx');
    expect(GOLDEN_PARENT_VHD_NAMES).toContain('susentorno-test-golden.vhdx');
    expect(GOLDEN_PARENT_VHD_NAMES).toContain('susentorno-test-windows-golden.vhdx');
  });

  it('derives the windows role VM name from the isolation prefix', () => {
    expect(roleVmName('windowsFresh')).toBe('susentorno-test-windowsFresh');
  });

  it('resolves the ISO path from the environment, or null when unset', () => {
    expect(windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: 'C:\\images\\win.iso' })).toBe(
      'C:\\images\\win.iso',
    );
    expect(windowsIsoPath({})).toBeNull();
    expect(windowsIsoPath({ [WINDOWS_ISO_ENV_VAR]: '   ' })).toBeNull();
  });
});
```

Replace the body of `tests/unit/guest/sweep.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { isSweepableChildVhd } from '../../guest/hyperv/sweep';

describe('isSweepableChildVhd', () => {
  it("sweeps only this isolation's disposable VHDXs", () => {
    for (const name of [
      'susentorno-test-phases.vhdx',
      'susentorno-test-e2e.vhdx',
      'susentorno-test-fresh.vhdx',
      'susentorno-test-windowsFresh.vhdx',
      'susentorno-test-golden-installer.vhdx',
      'susentorno-test-golden-seed.vhdx',
    ])
      expect(isSweepableChildVhd(name), name).toBe(true);
    for (const name of [
      'susentorno-test-golden.vhdx',
      'susentorno-test-windows-golden.vhdx',
      'ubuntu-26.04-live-server-amd64.iso',
      'susentorno-test-golden.vhdx.stamp',
      'golden-build-serial.log',
      'harness_ed25519',
      'susentorno-other-e2e.vhdx',
      'my-vm.vhdx',
    ])
      expect(isSweepableChildVhd(name), name).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/unit/guest/sweep.test.ts tests/unit/guest/imageCache.test.ts`

Expected: FAIL — `imageCache.test.ts` cannot resolve `windowsGoldenVhdPath`; `sweep.test.ts` fails on `susentorno-test-windows-golden.vhdx` being swept.

- [ ] **Step 3: Extend `imageCache.ts`**

Change the role union at line 5 and append the Windows block at the end of the file:

```ts
/** The five per-test guests. One differencing disk and one VM each. */
export type GuestRole = 'phases' | 'e2e' | 'fresh' | 'ambientTrust' | 'windowsFresh';
```

```ts
/**
 * Cached parents, never swept. `isSweepableChildVhd` inverts this list rather
 * than excluding one hard-coded filename: with two golden images, an
 * exclusion-of-one predicate silently destroys the other and forces a
 * multi-hour rebuild on every run.
 */
export const GOLDEN_PARENT_VHD_NAMES: readonly string[] = [
  `${NAME_PREFIX}-golden.vhdx`,
  `${NAME_PREFIX}-windows-golden.vhdx`,
];

export const WINDOWS_ISO_ENV_VAR = 'SUSENTORNO_WINDOWS_ISO';
export const WINDOWS_REBUILD_ENV_VAR = 'SUSENTORNO_WINDOWS_IMAGE_REBUILD';

/**
 * Unlike the Ubuntu ISO, the Windows evaluation cannot be downloaded
 * unattended — it sits behind a registration form yielding a short-lived
 * signed URL. The path is therefore supplied, and its absence skips the role
 * rather than failing the tier.
 */
export function windowsIsoPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[WINDOWS_ISO_ENV_VAR];
  return value !== undefined && value.trim() !== '' ? value : null;
}

export const windowsGoldenVhdPath = join(imageCacheDir, `${NAME_PREFIX}-windows-golden.vhdx`);
export const windowsGoldenStampPath = `${windowsGoldenVhdPath}.stamp`;
/** Guest Administrator password, generated once and reused; a stamp input. */
export const windowsCredentialPath = join(
  imageCacheDir,
  `${NAME_PREFIX}-windows-credential.json`,
);
/** The one-file ISO carrying autounattend.xml, attached as a second DVD. */
export const windowsAnswerIsoPath = join(imageCacheDir, `${NAME_PREFIX}-windows-answer.iso`);
/**
 * Deliberately not under test-results/<timestamp>/: like the Ubuntu build's
 * serial log, a failed build's frames have to still be there on the next run.
 */
export const windowsBuildScreenshotDir = join(imageCacheDir, 'windows-build-screenshots');
```

- [ ] **Step 4: Fix `sweep.ts`**

Replace `isSweepableChildVhd` and update the import:

```ts
import { GOLDEN_PARENT_VHD_NAMES, imageCacheDir, NAME_PREFIX } from './imageCache';
```

```ts
export function isSweepableChildVhd(filename: string): boolean {
  return (
    filename.endsWith('.vhdx') &&
    filename.startsWith(`${NAME_PREFIX}-`) &&
    !GOLDEN_PARENT_VHD_NAMES.includes(filename)
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run tests/unit/guest/`

Expected: PASS.

- [ ] **Step 6: Type-check and commit**

```bash
pnpm typecheck
pnpm format
git add tests/guest/hyperv/imageCache.ts tests/guest/hyperv/sweep.ts tests/unit/guest/
git commit -m "test(guest): add the windowsFresh role's cache paths and stop sweeping golden parents"
```

---

### Task 5: Per-input stamp map

The stale-image error must name *which* input changed. A single combined digest cannot support that, so the Windows pipeline stores a map. `goldenStamp.ts` is left untouched — see "Deviation from the spec".

**Files:**

- Create: `tests/guest/hyperv/stampMap.ts`
- Test: `tests/unit/guest/stampMap.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type StampInputs = Record<string, string | number>`
  - `computeStampMap(inputs: StampInputs): Record<string, string>`
  - `readStampMap(path: string): Record<string, string> | null`
  - `writeStampMap(path: string, map: Record<string, string>): void`
  - `clearStampMap(path: string): void`
  - `diffStampMaps(previous: Record<string, string> | null, next: Record<string, string>): string[]`
  - `STAMP_BUILT_AT_KEY: 'builtAt'`, `stampAgeDays(map, now?): number | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/stampMap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearStampMap,
  computeStampMap,
  diffStampMaps,
  readStampMap,
  stampAgeDays,
  STAMP_BUILT_AT_KEY,
  writeStampMap,
} from '../../guest/hyperv/stampMap';

const base = { answerFile: 'answer', provisioning: 'script', isoSha256: 'abc', version: 1 };

describe('computeStampMap', () => {
  it('hashes each input independently and stably', () => {
    const map = computeStampMap(base);
    expect(Object.keys(map).sort()).toEqual([
      'answerFile',
      'isoSha256',
      'provisioning',
      'version',
    ]);
    for (const value of Object.values(map)) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStampMap({ ...base })).toEqual(map);
  });

  it('cannot shift data across a field boundary', () => {
    expect(computeStampMap({ a: 'ab', b: 'c' })).not.toEqual(computeStampMap({ a: 'a', b: 'bc' }));
  });
});

describe('diffStampMaps', () => {
  it('names every changed, added, and removed input', () => {
    const previous = computeStampMap(base);
    expect(diffStampMaps(previous, computeStampMap(base))).toEqual([]);
    expect(diffStampMaps(previous, computeStampMap({ ...base, answerFile: 'other' }))).toEqual([
      'answerFile',
    ]);
    expect(
      diffStampMaps(previous, computeStampMap({ ...base, isoSha256: 'z', version: 2 })).sort(),
    ).toEqual(['isoSha256', 'version']);
  });

  it('reports everything as changed when there is no previous stamp', () => {
    expect(diffStampMaps(null, computeStampMap(base)).sort()).toEqual([
      'answerFile',
      'isoSha256',
      'provisioning',
      'version',
    ]);
  });

  it('ignores the build timestamp, which is metadata rather than an input', () => {
    const previous = { ...computeStampMap(base), [STAMP_BUILT_AT_KEY]: '2026-01-01T00:00:00.000Z' };
    const next = { ...computeStampMap(base), [STAMP_BUILT_AT_KEY]: '2026-06-01T00:00:00.000Z' };
    expect(diffStampMaps(previous, next)).toEqual([]);
  });
});

describe('stampAgeDays', () => {
  it('measures age from the recorded build timestamp', () => {
    const map = { [STAMP_BUILT_AT_KEY]: '2026-01-01T00:00:00.000Z' };
    expect(stampAgeDays(map, new Date('2026-01-31T00:00:00.000Z'))).toBe(30);
    expect(stampAgeDays({}, new Date())).toBeNull();
  });
});

describe('stamp persistence', () => {
  it('round-trips and clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-map-'));
    try {
      const path = join(dir, 'x.stamp');
      expect(readStampMap(path)).toBeNull();
      const map = computeStampMap(base);
      writeStampMap(path, map);
      expect(readStampMap(path)).toEqual(map);
      clearStampMap(path);
      expect(readStampMap(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats a corrupt stamp as absent rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-map-'));
    try {
      const path = join(dir, 'x.stamp');
      writeStampMap(path, computeStampMap(base));
      rmSync(path, { force: true });
      expect(readStampMap(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/stampMap.test.ts`

Expected: FAIL — cannot resolve `../../guest/hyperv/stampMap`.

- [ ] **Step 3: Write `tests/guest/hyperv/stampMap.ts`**

```ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

export type StampInputs = Record<string, string | number>;

/** Metadata, not an input: recorded so a time-limited image can expire. */
export const STAMP_BUILT_AT_KEY = 'builtAt';

/**
 * One digest per input, rather than one digest over all of them. The Ubuntu
 * pipeline's single hash cannot answer "which input changed?", and the Windows
 * pipeline's rebuild costs 60-120 minutes — enough that the error message owes
 * the reader a reason.
 */
export function computeStampMap(inputs: StampInputs): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const text = String(value);
    map[key] = createHash('sha256')
      .update(`${Buffer.byteLength(text, 'utf8')}:`)
      .update(text, 'utf8')
      .digest('hex');
  }
  return map;
}

export function readStampMap(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    );
    return Object.fromEntries(entries);
  } catch {
    // A truncated or hand-edited stamp means "unknown", not "crash the tier".
    return null;
  }
}

/** Write only after a clean build; a partial image is never cache-valid. */
export function writeStampMap(path: string, map: Record<string, string>): void {
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
}

export function clearStampMap(path: string): void {
  rmSync(path, { force: true });
}

/** Input names that differ, including additions and removals. Sorted. */
export function diffStampMaps(
  previous: Record<string, string> | null,
  next: Record<string, string>,
): string[] {
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next)]);
  keys.delete(STAMP_BUILT_AT_KEY);
  return [...keys].filter((key) => (previous ?? {})[key] !== next[key]).sort();
}

/** Whole days since the recorded build, or null when the stamp predates the field. */
export function stampAgeDays(
  map: Record<string, string>,
  now: Date = new Date(),
): number | null {
  const builtAt = map[STAMP_BUILT_AT_KEY];
  if (builtAt === undefined) return null;
  const then = Date.parse(builtAt);
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/stampMap.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm format
git add tests/guest/hyperv/stampMap.ts tests/unit/guest/stampMap.test.ts
git commit -m "test(guest): add a per-input stamp map so a stale image can name what changed"
```

---

### Task 6: The Windows guest credential

**Files:**

- Create: `tests/guest/hyperv/windowsCredential.ts`
- Test: `tests/unit/guest/windowsCredential.test.ts`

**Interfaces:**

- Consumes: `windowsCredentialPath` from Task 4.
- Produces:
  - `interface WindowsCredential { username: string; password: string }`
  - `WINDOWS_GUEST_USERNAME: 'Administrator'`
  - `generateWindowsPassword(): string`
  - `ensureWindowsCredential(path?: string): WindowsCredential`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/windowsCredential.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWindowsCredential,
  generateWindowsPassword,
  WINDOWS_GUEST_USERNAME,
} from '../../guest/hyperv/windowsCredential';

describe('windows guest credential', () => {
  it('uses the built-in Administrator, which is exempt from UAC token filtering', () => {
    expect(WINDOWS_GUEST_USERNAME).toBe('Administrator');
  });

  it('generates distinct passwords meeting Windows complexity policy', () => {
    const password = generateWindowsPassword();
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(generateWindowsPassword()).not.toBe(password);
  });

  it('generates once and reuses thereafter, so a cached image stays reachable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'win-cred-'));
    try {
      const path = join(dir, 'credential.json');
      const first = ensureWindowsCredential(path);
      expect(first.username).toBe('Administrator');
      expect(ensureWindowsCredential(path)).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/windowsCredential.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/hyperv/windowsCredential.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { windowsCredentialPath } from './imageCache';

export interface WindowsCredential {
  username: string;
  password: string;
}

/**
 * The built-in RID-500 account, deliberately. PowerShell Direct runs with the
 * supplied guest credential rather than inheriting the host's elevation, and
 * the built-in Administrator is exempt from the UAC admin-approval-mode
 * filtering that would otherwise hand back a limited token —
 * `nn-configure-network.ps1` declares `#Requires -RunAsAdministrator`.
 * windowsGuestExec asserts elevation at runtime rather than trusting this.
 */
export const WINDOWS_GUEST_USERNAME = 'Administrator';

/** Windows local-account policy wants three of four character classes. */
export function generateWindowsPassword(): string {
  return `${randomBytes(15).toString('base64url')}Aa1!`;
}

/**
 * Generated once and persisted, the same treatment harnessKeys.ts gives the
 * harness private key. It is a stamp input, so deleting this file forces a
 * rebuild rather than leaving an image nobody can log into.
 */
export function ensureWindowsCredential(path: string = windowsCredentialPath): WindowsCredential {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<WindowsCredential>;
    if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
      return { username: parsed.username, password: parsed.password };
    }
  }
  const credential: WindowsCredential = {
    username: WINDOWS_GUEST_USERNAME,
    password: generateWindowsPassword(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  return credential;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/windowsCredential.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm format
git add tests/guest/hyperv/windowsCredential.ts tests/unit/guest/windowsCredential.test.ts
git commit -m "test(guest): generate and persist the Windows guest credential"
```

---

### Task 7: `autounattend.xml` and the resumable provisioning script

The single highest-risk pure module. Two hard constraints: Setup must not stop for any prompt, and provisioning **must survive reboots** — `FirstLogonCommands` does not resume, so a naive script dies at the first Windows Update reboot.

**Files:**

- Create: `tests/guest/windowsAutounattend.ts`
- Test: `tests/unit/guest/windowsAutounattend.test.ts`

**Interfaces:**

- Consumes: `WindowsCredential` from Task 6.
- Produces:
  - `WINDOWS_GUEST_HOSTNAME: 'susentorno-test-win'`
  - `WINDOWS_IMAGE_NAME: 'Windows 11 Enterprise Evaluation'`
  - `PROVISIONING_SCRIPT_PATH: 'C:\\Windows\\Setup\\Scripts\\susentorno-provision.ps1'`
  - `buildProvisioningScript(): string`
  - `buildAutounattendXml(inputs: { password: string; provisioningScript: string }): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/windowsAutounattend.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildAutounattendXml,
  buildProvisioningScript,
  PROVISIONING_SCRIPT_PATH,
  WINDOWS_GUEST_HOSTNAME,
  WINDOWS_IMAGE_NAME,
} from '../../guest/windowsAutounattend';

const xml = buildAutounattendXml({
  password: 'p@ssw0rd-Example',
  provisioningScript: buildProvisioningScript(),
});

describe('buildAutounattendXml', () => {
  it('bypasses every Setup hardware gate, including CPU', () => {
    for (const key of [
      'BypassTPMCheck',
      'BypassSecureBootCheck',
      'BypassRAMCheck',
      'BypassCPUCheck',
    ])
      expect(xml, key).toContain(key);
  });

  it('enables the built-in Administrator and skips OOBE entirely', () => {
    expect(xml).toContain('p@ssw0rd-Example');
    expect(xml).toContain('<HideOnlineAccountScreens>true</HideOnlineAccountScreens>');
    expect(xml).toContain('<HideEULAPage>true</HideEULAPage>');
    expect(xml).toContain('<ProtectYourPC>3</ProtectYourPC>');
    expect(xml).toContain(WINDOWS_GUEST_HOSTNAME);
    expect(xml).toContain(WINDOWS_IMAGE_NAME);
  });

  it('prevents device encryption and quiets the guest, but does NOT disable Windows Update', () => {
    expect(xml).toContain('PreventDeviceEncryption');
    expect(xml).toContain('DisableStoreAutoUpdate');
    expect(xml).toContain('AllowTelemetry');
    expect(xml).toContain('DisableWindowsConsumerFeatures');
    // Disabling Windows Update here would stop the COM update search finding
    // anything; the provisioning script disables it after servicing.
    expect(xml).not.toContain('NoAutoUpdate');
  });

  it('autologs on with headroom for servicing reboots and launches the provisioner', () => {
    expect(xml).toContain('<LogonCount>10</LogonCount>');
    expect(xml).toContain(PROVISIONING_SCRIPT_PATH);
  });

  it('escapes XML metacharacters in the password', () => {
    const escaped = buildAutounattendXml({
      password: 'a<b>&c"d',
      provisioningScript: 'x',
    });
    expect(escaped).toContain('a&lt;b&gt;&amp;c&quot;d');
    expect(escaped).not.toContain('a<b>&c"d');
  });
});

describe('buildProvisioningScript', () => {
  const script = buildProvisioningScript();

  it('persists across reboots rather than relying on FirstLogonCommands', () => {
    expect(script).toContain('CurrentVersion\\Run');
    expect(script).toContain('SusentornoProvision');
  });

  it('drives Windows Update through the built-in COM API and honours RebootRequired', () => {
    expect(script).toContain('Microsoft.Update.Session');
    expect(script).toContain('RebootRequired');
    expect(script).not.toContain('PSWindowsUpdate');
  });

  it('installs git after servicing', () => {
    expect(script).toContain('winget install');
    expect(script).toContain('Git.Git');
  });

  it('finalises in the right order: disable updates, clear autologon, deregister, shut down', () => {
    const order = ['NoAutoUpdate', 'AutoAdminLogon', 'Remove-ItemProperty', 'Stop-Computer'];
    let cursor = -1;
    for (const needle of order) {
      const index = script.indexOf(needle);
      expect(index, needle).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('records a stage marker so a resumed run knows where it left off', () => {
    expect(script).toContain('susentorno-stage.txt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/windowsAutounattend.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/windowsAutounattend.ts`**

```ts
export const WINDOWS_GUEST_HOSTNAME = 'susentorno-test-win';
/** Must match an image in the supplied ISO; see SUSENTORNO_WINDOWS_ISO's x64/en-us contract. */
export const WINDOWS_IMAGE_NAME = 'Windows 11 Enterprise Evaluation';
export const PROVISIONING_SCRIPT_PATH =
  'C:\\Windows\\Setup\\Scripts\\susentorno-provision.ps1';
const STAGE_MARKER_PATH = 'C:\\Windows\\Setup\\Scripts\\susentorno-stage.txt';
const RUN_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE_NAME = 'SusentornoProvision';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Provisioning cannot be a one-shot FirstLogonCommand. Windows Update needs
 * reboots, and a reboot neither resumes an interrupted FirstLogonCommand nor
 * re-runs a consumed RunOnce entry — the process would simply die at the first
 * servicing reboot with Git never installed. Autologon logs the user back in;
 * this Run entry is what actually re-invokes the script, and a stage marker on
 * disk is what tells the resumed run where it left off. The entry removes
 * itself only in the final stage.
 */
export function buildProvisioningScript(): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '$ProgressPreference = "SilentlyContinue"',
    `$stagePath = "${STAGE_MARKER_PATH}"`,
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stagePath) | Out-Null',
    '$stage = if (Test-Path $stagePath) { (Get-Content $stagePath -Raw).Trim() } else { "update" }',
    'function Set-Stage($value) { Set-Content -LiteralPath $stagePath -Value $value -Encoding ascii }',
    '',
    'if ($stage -eq "update") {',
    '  $session = New-Object -ComObject Microsoft.Update.Session',
    '  $searcher = $session.CreateUpdateSearcher()',
    '  $result = $searcher.Search("IsInstalled=0 and IsHidden=0")',
    '  if ($result.Updates.Count -eq 0) {',
    '    Set-Stage "git"; $stage = "git"',
    '  } else {',
    '    $toDownload = New-Object -ComObject Microsoft.Update.UpdateColl',
    '    foreach ($u in $result.Updates) {',
    '      if (-not $u.EulaAccepted) { $u.AcceptEula() }',
    '      $null = $toDownload.Add($u)',
    '    }',
    '    $downloader = $session.CreateUpdateDownloader()',
    '    $downloader.Updates = $toDownload',
    '    $null = $downloader.Download()',
    '    $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl',
    '    foreach ($u in $result.Updates) { if ($u.IsDownloaded) { $null = $toInstall.Add($u) } }',
    '    if ($toInstall.Count -eq 0) {',
    '      Set-Stage "git"; $stage = "git"',
    '    } else {',
    '      $installer = $session.CreateUpdateInstaller()',
    '      $installer.Updates = $toInstall',
    '      $installResult = $installer.Install()',
    '      Write-Host "provision: install resultCode=$($installResult.ResultCode) reboot=$($installResult.RebootRequired)"',
    '      if ($installResult.RebootRequired) { Set-Stage "update"; Restart-Computer -Force; exit 0 }',
    '      Set-Stage "update"; Restart-Computer -Force; exit 0',
    '    }',
    '  }',
    '}',
    '',
    'if ($stage -eq "git") {',
    '  winget install --id Git.Git --exact --silent --accept-source-agreements --accept-package-agreements --source winget',
    '  Set-Stage "finalize"; $stage = "finalize"',
    '}',
    '',
    'if ($stage -eq "finalize") {',
    '  $au = "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU"',
    '  New-Item -Path $au -Force | Out-Null',
    '  Set-ItemProperty -Path $au -Name NoAutoUpdate -Value 1 -Type DWord',
    '  $winlogon = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon"',
    '  Set-ItemProperty -Path $winlogon -Name AutoAdminLogon -Value "0"',
    '  Remove-ItemProperty -Path $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue',
    `  Remove-ItemProperty -Path "${RUN_KEY}" -Name "${RUN_VALUE_NAME}" -ErrorAction SilentlyContinue`,
    '  Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue',
    '  Stop-Computer -Force',
    '}',
    '',
  ].join('\r\n');
}

export interface AutounattendInputs {
  password: string;
  provisioningScript: string;
}

/**
 * Setup finds this on the second DVD drive. Note what is deliberately absent:
 * no Windows Update policy (it would stop the COM search returning anything —
 * the provisioning script applies it after servicing), and no
 * LocalAccountTokenFilterPolicy (it governs network remote administration and
 * would be cargo-culted here; elevation is asserted at runtime instead).
 */
export function buildAutounattendXml(inputs: AutounattendInputs): string {
  const password = escapeXml(inputs.password);
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>3</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>reg add HKLM\\SYSTEM\\Setup\\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
      <UserData>
        <AcceptEula>true</AcceptEula>
      </UserData>
      <ImageInstall>
        <OSImage>
          <InstallFrom>
            <MetaData wcm:action="add">
              <Key>/IMAGE/NAME</Key>
              <Value>${WINDOWS_IMAGE_NAME}</Value>
            </MetaData>
          </InstallFrom>
          <InstallToAvailablePartition>false</InstallToAvailablePartition>
        </OSImage>
      </ImageInstall>
      <DiskConfiguration>
        <WillShowUI>OnError</WillShowUI>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add">
              <Order>1</Order>
              <Type>EFI</Type>
              <Size>260</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>2</Order>
              <Type>MSR</Type>
              <Size>128</Size>
            </CreatePartition>
            <CreatePartition wcm:action="add">
              <Order>3</Order>
              <Type>Primary</Type>
              <Extend>true</Extend>
            </CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add">
              <Order>1</Order>
              <PartitionID>1</PartitionID>
              <Format>FAT32</Format>
              <Label>System</Label>
            </ModifyPartition>
            <ModifyPartition wcm:action="add">
              <Order>2</Order>
              <PartitionID>3</PartitionID>
              <Format>NTFS</Format>
              <Letter>C</Letter>
              <Label>Windows</Label>
            </ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
    </component>
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage>
        <UILanguage>en-US</UILanguage>
      </SetupUILanguage>
      <InputLocale>en-US</InputLocale>
      <SystemLocale>en-US</SystemLocale>
      <UILanguage>en-US</UILanguage>
      <UserLocale>en-US</UserLocale>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>${WINDOWS_GUEST_HOSTNAME}</ComputerName>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\BitLocker /v PreventDeviceEncryption /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>2</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\WindowsStore /v DisableStoreAutoUpdate /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>3</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection /v AllowTelemetry /t REG_DWORD /d 0 /f</Path>
        </RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>reg add HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\CloudContent /v DisableWindowsConsumerFeatures /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <AdministratorPassword>
          <Value>${password}</Value>
          <PlainText>true</PlainText>
        </AdministratorPassword>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>10</LogonCount>
        <Username>Administrator</Username>
        <Password>
          <Value>${password}</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path 'C:\\Windows\\Setup\\Scripts' | Out-Null; [IO.File]::WriteAllText('${PROVISIONING_SCRIPT_PATH}', [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(inputs.provisioningScript, 'utf8').toString('base64')}')))"</CommandLine>
          <Description>Write the provisioning script</Description>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>2</Order>
          <CommandLine>reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v ${RUN_VALUE_NAME} /t REG_SZ /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${PROVISIONING_SCRIPT_PATH}" /f</CommandLine>
          <Description>Register the resumable provisioner</Description>
        </SynchronousCommand>
        <SynchronousCommand wcm:action="add">
          <Order>3</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${PROVISIONING_SCRIPT_PATH}</CommandLine>
          <Description>Run provisioning</Description>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/windowsAutounattend.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/windowsAutounattend.ts tests/unit/guest/windowsAutounattend.test.ts
git commit -m "test(guest): generate autounattend.xml and a reboot-resumable provisioner"
```

---

### Task 8: The answer-file ISO

Windows Setup unambiguously searches a DVD root. Building a one-file ISO needs no new dependency — `IMAPI2FS.MsftFileSystemImage` ships with Windows.

**Files:**

- Create: `tests/guest/hyperv/answerFileIso.ts`
- Test: `tests/unit/guest/answerFileIso.test.ts`

**Interfaces:**

- Consumes: `PowerShellExec` from `src/guestSetup/powerShellExec`.
- Produces:
  - `buildAnswerIsoCommand(isoPath: string, answerXml: string): string`
  - `writeAnswerFileIso(exec: PowerShellExec, isoPath: string, answerXml: string): Promise<void>`
  - `AnswerFileIsoError`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/answerFileIso.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AnswerFileIsoError,
  buildAnswerIsoCommand,
  writeAnswerFileIso,
} from '../../guest/hyperv/answerFileIso';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

describe('buildAnswerIsoCommand', () => {
  const command = buildAnswerIsoCommand('C:\\cache\\answer.iso', '<unattend/>');

  it('uses the built-in IMAPI2FS COM component, not an external ISO writer', () => {
    expect(command).toContain('IMAPI2FS.MsftFileSystemImage');
    expect(command).toContain('CreateResultImage');
    expect(command).not.toContain('oscdimg');
  });

  it('copies the result IStream block by block through a compiled helper', () => {
    expect(command).toContain('SusentornoIsoWriter');
    expect(command).toContain('TotalBlocks');
    expect(command).toContain('BlockSize');
  });

  it('names the file Autounattend.xml at the image root', () => {
    expect(command).toContain('Autounattend.xml');
  });

  it('carries the XML as base64 so no quoting can corrupt it', () => {
    expect(command).toContain(Buffer.from('<unattend/>', 'utf8').toString('base64'));
    expect(command).not.toContain('<unattend/>');
  });

  it('single-quotes the destination path PowerShell-style', () => {
    expect(buildAnswerIsoCommand("C:\\it's\\a.iso", 'x')).toContain("'C:\\it''s\\a.iso'");
  });
});

describe('writeAnswerFileIso', () => {
  it('throws a typed error carrying the PowerShell output', async () => {
    const exec: PowerShellExec = {
      run: async () => ({ exitCode: 1, stdout: 'COM exception 0x80070005' }),
    };
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).rejects.toThrow(AnswerFileIsoError);
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).rejects.toThrow(
      /COM exception 0x80070005/,
    );
  });

  it('resolves silently on success', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: '' }) };
    await expect(writeAnswerFileIso(exec, 'C:\\x.iso', '<a/>')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/answerFileIso.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/hyperv/answerFileIso.ts`**

```ts
import { rmSync } from 'node:fs';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

export class AnswerFileIsoError extends Error {}

/**
 * A one-file ISO carrying Autounattend.xml, attached as the build VM's second
 * DVD drive. A DVD root is unambiguously inside Windows Setup's answer-file
 * search; a SCSI-attached VHDX is not removable and is not clearly searched.
 *
 * IMAPI2FS ships with Windows, so this reintroduces none of the Node
 * ISO-writing dependency ADR-0025 rejected. The XML crosses as base64 for the
 * same reason ambientTrust.ts base64s PEMs: its own newlines and quotes cannot
 * survive shell quoting reliably.
 */
export function buildAnswerIsoCommand(isoPath: string, answerXml: string): string {
  const base64 = Buffer.from(answerXml, 'utf8').toString('base64');
  // CreateResultImage() hands back a COM IStream, which PowerShell cannot
  // write to a file on its own. A tiny compiled helper copies it block by
  // block; IMAPI pads every block to BlockSize, so passing IntPtr.Zero for
  // the bytes-read pointer is safe and keeps the helper out of /unsafe.
  const isoWriter = [
    'public class SusentornoIsoWriter {',
    '  public static void Create(string path, object stream, int blockSize, int totalBlocks) {',
    '    var source = stream as System.Runtime.InteropServices.ComTypes.IStream;',
    '    if (source == null) throw new System.ArgumentException("not an IStream");',
    '    var buffer = new byte[blockSize];',
    '    using (var output = System.IO.File.OpenWrite(path)) {',
    '      while (totalBlocks-- > 0) {',
    '        source.Read(buffer, blockSize, System.IntPtr.Zero);',
    '        output.Write(buffer, 0, blockSize);',
    '      }',
    '      output.Flush();',
    '    }',
    '  }',
    '}',
  ].join('\n');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quoteForPowerShell(base64)}))`,
    '$payload = New-Object -ComObject ADODB.Stream',
    '$payload.Open(); $payload.Type = 1',
    '$payload.Write([Text.Encoding]::UTF8.GetBytes($source)); $payload.Position = 0',
    '$image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage',
    // 3 == ISO9660 + Joliet. Setup reads either; UDF buys nothing for one file.
    '$image.FileSystemsToCreate = 3',
    "$image.VolumeName = 'SUSENTORNO'",
    "$image.Root.AddFile('Autounattend.xml', $payload)",
    '$result = $image.CreateResultImage()',
    `if (-not ('SusentornoIsoWriter' -as [type])) { Add-Type -TypeDefinition ${quoteForPowerShell(isoWriter)} }`,
    `[SusentornoIsoWriter]::Create(${quoteForPowerShell(isoPath)}, $result.ImageStream, $result.BlockSize, $result.TotalBlocks)`,
    '$payload.Close()',
  ].join('; ');
}

export async function writeAnswerFileIso(
  exec: PowerShellExec,
  isoPath: string,
  answerXml: string,
): Promise<void> {
  rmSync(isoPath, { force: true });
  const { exitCode, stdout } = await exec.run(buildAnswerIsoCommand(isoPath, answerXml));
  if (exitCode !== 0) {
    throw new AnswerFileIsoError(
      `answerFileIso: could not build '${isoPath}' (exit ${exitCode}): ${stdout}`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/answerFileIso.test.ts`

Expected: PASS.

- [ ] **Step 5: Verify a real ISO mounts with the file at its root**

Write the ISO with a scratch script, then:

```powershell
Mount-DiskImage -ImagePath "$env:TEMP\answer-probe.iso" -PassThru | Get-Volume
Get-ChildItem "<drive>:\"
Dismount-DiskImage -ImagePath "$env:TEMP\answer-probe.iso"
```

Expected: `Autounattend.xml` listed at the volume root.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/hyperv/answerFileIso.ts tests/unit/guest/answerFileIso.test.ts
git commit -m "test(guest): build the answer-file ISO with the built-in IMAPI2FS component"
```

---

### Task 9: Framebuffer screenshots

Windows Setup writes nothing to serial and PowerShell Direct is unavailable until OOBE, so during the window most likely to fail there is no channel at all. Thumbnails give **state classification** — "at a prompt" vs "installing" vs "bugcheck" — not readable text.

**Files:**

- Create: `tests/guest/hyperv/vmScreenshot.ts`
- Test: `tests/unit/guest/vmScreenshot.test.ts`

**Interfaces:**

- Consumes: `PowerShellExec`.
- Produces:
  - `rgb565ToBmp(pixels: Buffer, width: number, height: number): Buffer`
  - `buildThumbnailCommand(vmName: string, width: number, height: number): string`
  - `interface ScreenshotHandle { stop(): Promise<void> }`
  - `startScreenshotCapture(exec, vmName, dir, opts?): ScreenshotHandle`
  - `SCREENSHOT_WIDTH: 320`, `SCREENSHOT_HEIGHT: 240`, `SCREENSHOT_RETAIN: 10`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/vmScreenshot.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildThumbnailCommand,
  rgb565ToBmp,
  SCREENSHOT_HEIGHT,
  SCREENSHOT_RETAIN,
  SCREENSHOT_WIDTH,
} from '../../guest/hyperv/vmScreenshot';

describe('rgb565ToBmp', () => {
  it('emits a well-formed 24-bit BMP header for the given dimensions', () => {
    const pixels = Buffer.alloc(2 * 2 * 2);
    const bmp = rgb565ToBmp(pixels, 2, 2);
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(bmp.readUInt32LE(2)).toBe(bmp.length);
    expect(bmp.readUInt32LE(10)).toBe(54);
    expect(bmp.readUInt32LE(14)).toBe(40);
    expect(bmp.readInt32LE(18)).toBe(2);
    expect(bmp.readInt32LE(22)).toBe(2);
    expect(bmp.readUInt16LE(28)).toBe(24);
  });

  it('pads each row to a four-byte boundary', () => {
    // 3 px * 3 bytes = 9, padded to 12; 2 rows => 24 bytes of pixel data.
    const bmp = rgb565ToBmp(Buffer.alloc(3 * 2 * 2), 3, 2);
    expect(bmp.length).toBe(54 + 24);
  });

  it('expands RGB565 to BGR with the bottom row first', () => {
    // Row 0 pure red (0xF800), row 1 pure blue (0x001F).
    const pixels = Buffer.alloc(4);
    pixels.writeUInt16LE(0xf800, 0);
    pixels.writeUInt16LE(0x001f, 2);
    const bmp = rgb565ToBmp(pixels, 1, 2);
    // BMP stores bottom-up, so the first stored row is source row 1 (blue).
    expect([bmp[54], bmp[55], bmp[56]]).toEqual([255, 0, 0]);
    expect([bmp[58], bmp[59], bmp[60]]).toEqual([0, 0, 255]);
  });

  it('rejects a buffer that does not match the dimensions', () => {
    expect(() => rgb565ToBmp(Buffer.alloc(6), 2, 2)).toThrow(/expected 8 bytes/);
  });
});

describe('buildThumbnailCommand', () => {
  const command = buildThumbnailCommand('susentorno-test-golden-build', 320, 240);

  it('calls the Hyper-V management service thumbnail method', () => {
    expect(command).toContain('Msvm_VirtualSystemManagementService');
    expect(command).toContain('GetVirtualSystemThumbnailImage');
  });

  it('quotes the VM name and returns base64 for transport', () => {
    expect(command).toContain("'susentorno-test-golden-build'");
    expect(command).toContain('ToBase64String');
  });
});

describe('capture constants', () => {
  it('documents the thumbnail ceiling and the retention window', () => {
    expect(SCREENSHOT_WIDTH).toBe(320);
    expect(SCREENSHOT_HEIGHT).toBe(240);
    expect(SCREENSHOT_RETAIN).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/vmScreenshot.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/hyperv/vmScreenshot.ts`**

```ts
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';

/**
 * Hyper-V's thumbnail capture is capped at a low resolution, so these frames
 * classify state — "at a setup prompt", "installing", "bugcheck", "desktop" —
 * rather than rendering readable text. That is still the difference between
 * knowing which failure mode you are in and knowing nothing, which is what
 * makes iterating on autounattend.xml tractable. Windows Setup writes nothing
 * to serial, so there is no richer channel to prefer.
 */
export const SCREENSHOT_WIDTH = 320;
export const SCREENSHOT_HEIGHT = 240;
export const SCREENSHOT_RETAIN = 10;
const CAPTURE_INTERVAL_MS = 120_000;

/** Raw RGB565, two bytes per pixel, top row first — not an encoded image. */
export function rgb565ToBmp(pixels: Buffer, width: number, height: number): Buffer {
  const expected = width * height * 2;
  if (pixels.length !== expected) {
    throw new Error(`rgb565ToBmp: expected ${expected} bytes, received ${pixels.length}`);
  }
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write('BM', 0, 'ascii');
  bmp.writeUInt32LE(54 + pixelBytes, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y++) {
    // BMP rows are stored bottom-up.
    const destinationRow = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const value = pixels.readUInt16LE((y * width + x) * 2);
      const red = ((value >> 11) & 0x1f) * 255 / 31;
      const green = ((value >> 5) & 0x3f) * 255 / 63;
      const blue = (value & 0x1f) * 255 / 31;
      const offset = 54 + destinationRow * rowStride + x * 3;
      bmp[offset] = Math.round(blue);
      bmp[offset + 1] = Math.round(green);
      bmp[offset + 2] = Math.round(red);
    }
  }
  return bmp;
}

export function buildThumbnailCommand(vmName: string, width: number, height: number): string {
  const name = quoteForPowerShell(vmName);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$service = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_VirtualSystemManagementService",
    `$vm = Get-CimInstance -Namespace root\\virtualization\\v2 -ClassName Msvm_ComputerSystem -Filter ("ElementName='" + ${name}.Replace("'","''") + "'")`,
    '$settings = Get-CimAssociatedInstance -InputObject $vm -ResultClassName Msvm_VirtualSystemSettingData',
    '$result = Invoke-CimMethod -InputObject $service -MethodName GetVirtualSystemThumbnailImage ' +
      `-Arguments @{ TargetSystem = $settings; WidthPixels = ${width}; HeightPixels = ${height} }`,
    '[Convert]::ToBase64String([byte[]]$result.ImageData)',
  ].join('; ');
}

export interface ScreenshotHandle {
  stop(): Promise<void>;
}

/**
 * Frames land wherever the caller says: the build writes to .image-cache/ so a
 * failed build's evidence survives into the next run (the same reasoning
 * goldenBuildSerialLogPath documents), while a role writes to its per-run
 * artifacts directory and is discarded with the rest of that run.
 */
export function startScreenshotCapture(
  exec: PowerShellExec,
  vmName: string,
  dir: string,
  opts: { intervalMs?: number; retain?: number } = {},
): ScreenshotHandle {
  const intervalMs = opts.intervalMs ?? CAPTURE_INTERVAL_MS;
  const retain = opts.retain ?? SCREENSHOT_RETAIN;
  mkdirSync(dir, { recursive: true });
  let stopped = false;

  const prune = (): void => {
    const frames = readdirSync(dir)
      .filter((name) => name.endsWith('.bmp'))
      .sort();
    for (const stale of frames.slice(0, Math.max(0, frames.length - retain))) {
      rmSync(join(dir, stale), { force: true });
    }
  };

  const capture = async (): Promise<void> => {
    // Best-effort diagnostics: a failed frame must never fail a build.
    try {
      const { exitCode, stdout } = await exec.run(
        buildThumbnailCommand(vmName, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT),
      );
      if (exitCode !== 0) return;
      const pixels = Buffer.from(stdout.trim(), 'base64');
      const bmp = rgb565ToBmp(pixels, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(dir, `${stamp}.bmp`), bmp);
      prune();
    } catch {
      // Ignore: the VM may be mid-reboot, off, or not yet rendering.
    }
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      await capture();
      for (let waited = 0; waited < intervalMs && !stopped; waited += 500) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  const running = loop();

  return {
    stop: async () => {
      stopped = true;
      await running;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/vmScreenshot.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/hyperv/vmScreenshot.ts tests/unit/guest/vmScreenshot.test.ts
git commit -m "test(guest): capture Hyper-V framebuffer thumbnails as BMP for build diagnosis"
```

---

### Task 10: DVD and Windows Secure Boot VM builders

`buildSetFirstBootDeviceCommand` resolves a `Get-VMHardDiskDrive` by path and cannot select an optical drive, so the DVD path needs its own builder.

**Files:**

- Modify: `tests/guest/hyperv/vm.ts`
- Test: `tests/unit/guest/vm.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `SECURE_BOOT_WINDOWS_TEMPLATE: 'MicrosoftWindows'`
  - `buildEnableSecureBootWindowsCommand(name: string): string`
  - `buildAddVmDvdDriveCommand(name: string, path: string): string`
  - `buildSetFirstBootDvdCommand(name: string, path: string): string`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/guest/vm.test.ts`:

```ts
import {
  buildAddVmDvdDriveCommand,
  buildEnableSecureBootWindowsCommand,
  buildSetFirstBootDvdCommand,
  SECURE_BOOT_WINDOWS_TEMPLATE,
} from '../../guest/hyperv/vm';

describe('windows VM builders', () => {
  it('uses the Microsoft Windows Secure Boot template, not the UEFI CA one', () => {
    expect(SECURE_BOOT_WINDOWS_TEMPLATE).toBe('MicrosoftWindows');
    expect(buildEnableSecureBootWindowsCommand('vm')).toBe(
      "Set-VMFirmware -VMName 'vm' -EnableSecureBoot On -SecureBootTemplate 'MicrosoftWindows'",
    );
  });

  it('attaches a DVD drive with a quoted path', () => {
    expect(buildAddVmDvdDriveCommand('vm', "C:\\it's\\a.iso")).toBe(
      "Add-VMDvdDrive -VMName 'vm' -Path 'C:\\it''s\\a.iso' | Out-Null",
    );
  });

  it('selects a DVD drive as first boot device, not a hard disk', () => {
    const command = buildSetFirstBootDvdCommand('vm', 'C:\\win.iso');
    expect(command).toContain('Get-VMDvdDrive');
    expect(command).not.toContain('Get-VMHardDiskDrive');
    expect(command).toContain("'C:\\win.iso'");
    expect(command).toContain('Set-VMFirmware');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/vm.test.ts`

Expected: FAIL — the builders do not exist.

- [ ] **Step 3: Extend `tests/guest/hyperv/vm.ts`**

Append:

```ts
/**
 * Windows guests boot with the Microsoft Windows template; the UEFI CA
 * template above is for Ubuntu's shim. No vTPM accompanies it — Secure Boot
 * and vTPM are independent, and omitting the TPM is what keeps automatic
 * device encryption from sealing the golden volume to the build VM (see the
 * spec's section 1.4).
 */
export const SECURE_BOOT_WINDOWS_TEMPLATE = 'MicrosoftWindows';

export function buildEnableSecureBootWindowsCommand(name: string): string {
  return `Set-VMFirmware -VMName ${quoteForPowerShell(name)} -EnableSecureBoot On -SecureBootTemplate ${quoteForPowerShell(SECURE_BOOT_WINDOWS_TEMPLATE)}`;
}

export function buildAddVmDvdDriveCommand(name: string, path: string): string {
  return `Add-VMDvdDrive -VMName ${quoteForPowerShell(name)} -Path ${quoteForPowerShell(path)} | Out-Null`;
}

/**
 * buildSetFirstBootDeviceCommand resolves a Get-VMHardDiskDrive by path and
 * cannot select an optical drive, so the DVD boot path needs its own builder.
 */
export function buildSetFirstBootDvdCommand(name: string, path: string): string {
  const vm = quoteForPowerShell(name);
  return `$dvd = Get-VMDvdDrive -VMName ${vm} | Where-Object { $_.Path -eq ${quoteForPowerShell(path)} }; Set-VMFirmware -VMName ${vm} -FirstBootDevice $dvd`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/vm.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm format
git add tests/guest/hyperv/vm.ts tests/unit/guest/vm.test.ts
git commit -m "test(guest): add DVD attach/boot and Windows Secure Boot VM builders"
```

---

### Task 11: `ensureWindowsGoldenImage` and the globalSetup wiring

The long pole. Everything before this is unit-testable; this is verified by actually building an image.

**Files:**

- Create: `tests/guest/hyperv/windowsGoldenImage.ts`
- Modify: `tests/guest/globalSetup.ts`
- Test: `tests/unit/guest/windowsGoldenImage.test.ts`

**Interfaces:**

- Consumes: Tasks 4–10 in full.
- Produces:
  - `WindowsImageError`
  - `MAX_IMAGE_AGE_DAYS: 60`
  - `buildWindowsStampInputs(args: { answerXml: string; provisioningScript: string; isoSha256: string; password: string }): StampInputs`
  - `describeStaleImage(changed: string[], ageDays: number | null): string`
  - `ensureWindowsGoldenImage(exec: PowerShellExec, credential: WindowsCredential, opts?: { force?: boolean }): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/windowsGoldenImage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeStampMap, diffStampMaps } from '../../guest/hyperv/stampMap';
import {
  buildWindowsStampInputs,
  describeStaleImage,
  MAX_IMAGE_AGE_DAYS,
} from '../../guest/hyperv/windowsGoldenImage';

const args = {
  answerXml: '<unattend/>',
  provisioningScript: 'Write-Host hi',
  isoSha256: 'a'.repeat(64),
  password: 'secret',
};

describe('buildWindowsStampInputs', () => {
  it('covers every input that changes the built image', () => {
    expect(Object.keys(buildWindowsStampInputs(args)).sort()).toEqual([
      'answerXml',
      'buildAlgorithmVersion',
      'isoSha256',
      'password',
      'provisioningScript',
    ]);
  });

  it('moves the stamp when any single input moves, and names that input', () => {
    const previous = computeStampMap(buildWindowsStampInputs(args));
    for (const [key, value] of [
      ['answerXml', '<other/>'],
      ['provisioningScript', 'Write-Host bye'],
      ['isoSha256', 'b'.repeat(64)],
      ['password', 'other'],
    ] as const) {
      const next = computeStampMap(buildWindowsStampInputs({ ...args, [key]: value }));
      expect(diffStampMaps(previous, next), key).toEqual([key]);
    }
  });
});

describe('describeStaleImage', () => {
  it('names the changed inputs and the rebuild switch', () => {
    const message = describeStaleImage(['answerXml', 'isoSha256'], 3);
    expect(message).toContain('answerXml');
    expect(message).toContain('isoSha256');
    expect(message).toContain('SUSENTORNO_WINDOWS_IMAGE_REBUILD');
  });

  it('reports expiry when the image is older than the evaluation window allows', () => {
    const message = describeStaleImage([], MAX_IMAGE_AGE_DAYS + 1);
    expect(message).toContain('evaluation');
    expect(message).toContain(String(MAX_IMAGE_AGE_DAYS));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/windowsGoldenImage.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/hyperv/windowsGoldenImage.ts`**

```ts
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import { buildGetVmCommand, parseGetVmResult } from '../../../src/guestSetup/hyperVQueries';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../../src/guestSetup/quoteForPowerShell';
import {
  buildAutounattendXml,
  buildProvisioningScript,
} from '../windowsAutounattend';
import { writeAnswerFileIso } from './answerFileIso';
import {
  imageCacheDir,
  NAME_PREFIX,
  windowsAnswerIsoPath,
  windowsBuildScreenshotDir,
  windowsGoldenStampPath,
  windowsGoldenVhdPath,
  windowsIsoPath,
  WINDOWS_ISO_ENV_VAR,
  WINDOWS_REBUILD_ENV_VAR,
} from './imageCache';
import {
  clearStampMap,
  computeStampMap,
  diffStampMaps,
  readStampMap,
  stampAgeDays,
  STAMP_BUILT_AT_KEY,
  writeStampMap,
  type StampInputs,
} from './stampMap';
import { startScreenshotCapture } from './vmScreenshot';
import { buildNewVhdCommand } from './vhd';
import {
  buildAddVmDvdDriveCommand,
  buildDisableSecureBootCommand,
  buildAddVmHardDiskCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetFirstBootDvdCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

export class WindowsImageError extends Error {}

/** Increment when the build pipeline, rather than a seed input, changes. */
const BUILD_ALGORITHM_VERSION = 1;
/**
 * The Enterprise evaluation is time-limited. An input-only stamp would stay
 * valid forever while guests inside began shutting down periodically, so the
 * build date is recorded and an old image is refused with a clear reason
 * rather than failing confusingly months later.
 */
export const MAX_IMAGE_AGE_DAYS = 60;
const BUILD_TIMEOUT_MS = 3 * 60 * 60_000;

const buildVmName = `${NAME_PREFIX}-windows-golden-build`;
const targetSize = 127 * 1024 ** 3;

export interface WindowsStampArgs {
  answerXml: string;
  provisioningScript: string;
  isoSha256: string;
  password: string;
}

export function buildWindowsStampInputs(args: WindowsStampArgs): StampInputs {
  return {
    answerXml: args.answerXml,
    provisioningScript: args.provisioningScript,
    isoSha256: args.isoSha256,
    password: args.password,
    buildAlgorithmVersion: BUILD_ALGORITHM_VERSION,
  };
}

export function describeStaleImage(changed: string[], ageDays: number | null): string {
  const reasons: string[] = [];
  if (changed.length > 0) reasons.push(`these build inputs changed: ${changed.join(', ')}`);
  if (ageDays !== null && ageDays > MAX_IMAGE_AGE_DAYS) {
    reasons.push(
      `the image is ${ageDays} days old, past the ${MAX_IMAGE_AGE_DAYS}-day ceiling that keeps it ` +
        'inside the Windows evaluation window',
    );
  }
  return (
    `windowsGoldenImage: the cached image at ${windowsGoldenVhdPath} is stale — ` +
    `${reasons.join('; ')}. Rebuilding takes 60-120 minutes, so it is not done for you: ` +
    `re-run with ${WINDOWS_REBUILD_ENV_VAR}=1 to rebuild.`
  );
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function run(exec: PowerShellExec, command: string, what: string): Promise<string> {
  const { exitCode, stdout } = await exec.run(command);
  if (exitCode !== 0) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${what} failed (exit ${exitCode}): ${stdout || command}`,
    );
  }
  return stdout;
}

async function removeBuildVm(exec: PowerShellExec): Promise<void> {
  await exec.run(buildTurnOffVmCommand(buildVmName));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { stdout } = await exec.run(buildGetVmCommand(buildVmName));
    const vm = parseGetVmResult(stdout, buildVmName);
    if (!vm || vm.state === 'Off') break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  await exec.run(buildRemoveVmCommand(buildVmName));
}

async function waitForOff(exec: PowerShellExec): Promise<void> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { stdout } = await exec.run(buildGetVmCommand(buildVmName));
    if (parseGetVmResult(stdout, buildVmName)?.state === 'Off') return;
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new WindowsImageError(
    `windowsGoldenImage: the build VM never powered off within ${Math.round(
      BUILD_TIMEOUT_MS / 60_000,
    )} minutes.\n` +
      `  Screenshots: ${windowsBuildScreenshotDir}\n` +
      `  Target disk: ${windowsGoldenVhdPath} — mount it offline and read ` +
      'Windows\\Panther\\setupact.log and setuperr.log for detail the thumbnails cannot show.',
  );
}

export async function ensureWindowsGoldenImage(
  exec: PowerShellExec,
  credential: { username: string; password: string },
  opts: { force?: boolean } = {},
): Promise<string> {
  const isoPath = windowsIsoPath();
  if (isoPath === null) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${WINDOWS_ISO_ENV_VAR} is not set. Point it at an x64 en-us Windows 11 ` +
        'Enterprise evaluation ISO (see testing.md).',
    );
  }
  if (!existsSync(isoPath)) {
    throw new WindowsImageError(
      `windowsGoldenImage: ${WINDOWS_ISO_ENV_VAR} points at '${isoPath}', which does not exist.`,
    );
  }

  const provisioningScript = buildProvisioningScript();
  const answerXml = buildAutounattendXml({ password: credential.password, provisioningScript });
  const isoSha256 = await fileSha256(isoPath);
  const inputs = buildWindowsStampInputs({
    answerXml,
    provisioningScript,
    isoSha256,
    password: credential.password,
  });
  const next = computeStampMap(inputs);
  const previous = readStampMap(windowsGoldenStampPath);
  const force = opts.force === true || process.env[WINDOWS_REBUILD_ENV_VAR] === '1';

  if (existsSync(windowsGoldenVhdPath) && !force) {
    const changed = diffStampMaps(previous, next);
    const ageDays = previous === null ? null : stampAgeDays(previous);
    const tooOld = ageDays !== null && ageDays > MAX_IMAGE_AGE_DAYS;
    if (changed.length === 0 && !tooOld) return windowsGoldenVhdPath;
    throw new WindowsImageError(describeStaleImage(changed, ageDays));
  }

  mkdirSync(imageCacheDir, { recursive: true });
  clearStampMap(windowsGoldenStampPath);
  await removeBuildVm(exec);
  rmSync(windowsGoldenVhdPath, { force: true });
  rmSync(windowsBuildScreenshotDir, { recursive: true, force: true });

  await writeAnswerFileIso(exec, windowsAnswerIsoPath, answerXml);
  await run(exec, buildNewVhdCommand(windowsGoldenVhdPath, targetSize), 'create golden disk');
  await run(
    exec,
    buildNewVmCommand(buildVmName, {
      memoryStartupBytes: 4 * 1024 ** 3,
      switchName: 'Default Switch',
    }),
    'create build VM',
  );
  await run(
    exec,
    `Set-VM -Name ${quoteForPowerShell(buildVmName)} -AutomaticCheckpointsEnabled $false`,
    'disable automatic checkpoints',
  );

  let screenshots: ReturnType<typeof startScreenshotCapture> | undefined;
  try {
    for (const [command, what] of [
      [buildAddVmHardDiskCommand(buildVmName, windowsGoldenVhdPath), 'attach target disk'],
      [buildAddVmDvdDriveCommand(buildVmName, isoPath), 'attach installation ISO'],
      [buildAddVmDvdDriveCommand(buildVmName, windowsAnswerIsoPath), 'attach answer-file ISO'],
      [buildSetVmProcessorCommand(buildVmName, 2), 'set processors'],
      // Off for the build, exactly as the Ubuntu build does: it is not a
      // property the installed image persists, and it removes one variable
      // from the least-debuggable phase. The role VM enables it.
      [buildDisableSecureBootCommand(buildVmName), 'disable Secure Boot for the build'],
      [buildSetFirstBootDvdCommand(buildVmName, isoPath), 'boot the installation ISO'],
      [buildStartVmCommand(buildVmName), 'start build VM'],
    ] as const) {
      await run(exec, command, what);
    }
    screenshots = startScreenshotCapture(exec, buildVmName, windowsBuildScreenshotDir);
    await waitForOff(exec);
  } finally {
    await screenshots?.stop();
    await removeBuildVm(exec);
  }

  rmSync(windowsAnswerIsoPath, { force: true });
  writeStampMap(windowsGoldenStampPath, {
    ...next,
    [STAMP_BUILT_AT_KEY]: new Date().toISOString(),
  });
  return windowsGoldenVhdPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/windowsGoldenImage.test.ts`

Expected: PASS.

- [ ] **Step 5: Wire it into `tests/guest/globalSetup.ts`**

Add the imports and the conditional build after `ensureGoldenImage`:

```ts
import { ensureWindowsCredential } from './hyperv/windowsCredential';
import { ensureWindowsGoldenImage } from './hyperv/windowsGoldenImage';
import { harnessKeyPath, ISOLATION_NAME, windowsIsoPath } from './hyperv/imageCache';
```

```ts
  await ensureGoldenImage(exec, keys);

  // Optional by design: the Windows evaluation ISO cannot be fetched
  // unattended, so its absence skips the windowsFresh role rather than
  // failing the tier. See testing.md.
  if (windowsIsoPath() !== null) {
    console.log('guest: building/validating the Windows golden image...');
    await ensureWindowsGoldenImage(exec, ensureWindowsCredential());
  } else {
    console.log(
      'guest: SUSENTORNO_WINDOWS_ISO is not set — skipping the windowsFresh role. ' +
        'Set it to an x64 en-us Windows 11 Enterprise evaluation ISO to enable it (see testing.md).',
    );
  }
```

- [ ] **Step 6: Build the image for real**

From an **elevated** terminal with Docker running and `run-hosting` stopped:

```powershell
$env:SUSENTORNO_WINDOWS_ISO = '\\192.168.67.1\shared-images\26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso'
pnpm build
pnpm vitest run --config vitest.guest.config.ts tests/guest/fresh.test.ts
```

Expected: `globalSetup` builds the Windows image (60–120 minutes; longer under nested virtualization), then the Ubuntu `fresh` role passes as before. Watch `.image-cache/windows-build-screenshots/` if it stalls.

If Setup never picks up the answer file, apply the spec's ordered fallbacks: first move `Autounattend.xml` to a FAT32 seed VHDX reusing `makeSeed()`'s shape, then split the WIM with `Dism /Split-Image /SWMFile:install.swm /FileSize:3800` and build a FAT32 installer volume.

- [ ] **Step 7: Confirm the cached image is reused, not rebuilt**

Re-run the same command. Expected: the second run returns from `ensureWindowsGoldenImage` in seconds.

- [ ] **Step 8: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/hyperv/windowsGoldenImage.ts tests/guest/globalSetup.ts tests/unit/guest/windowsGoldenImage.test.ts
git commit -m "test(guest): build the Windows golden image from a supplied evaluation ISO"
```

---

# Stage 3 — The `windowsFresh` role

### Task 12: PowerShell Direct transport

Nested quoting is the whole problem here: a PowerShell script string, inside a PowerShell `-Command` string, passed to `powershell.exe`. Base64 sidesteps it entirely.

**Files:**

- Create: `tests/guest/windowsGuestExec.ts`
- Test: `tests/unit/guest/windowsGuestExec.test.ts`

**Interfaces:**

- Consumes: `PowerShellExec`, `WindowsCredential`.
- Produces:
  - `interface WindowsGuestExec { run(script): Promise<{exitCode: number; stdout: string}>; capture(script): Promise<{exitCode: number; stdout: string}> }`
  - `buildInvokeDirectCommand(vmName, credential, script): string`
  - `createWindowsGuestExec(exec, vmName, credential): WindowsGuestExec`
  - `waitForPowerShellDirect(guest, opts): Promise<void>`
  - `assertGuestElevated(guest): Promise<void>`
  - `WindowsGuestExecError`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/windowsGuestExec.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertGuestElevated,
  buildInvokeDirectCommand,
  createWindowsGuestExec,
  WindowsGuestExecError,
} from '../../guest/windowsGuestExec';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

const credential = { username: 'Administrator', password: "p'w" };

describe('buildInvokeDirectCommand', () => {
  const command = buildInvokeDirectCommand('vm-1', credential, "Write-Host 'hi'");

  it('addresses the VM by name over the VMBus, never by network address', () => {
    expect(command).toContain('Invoke-Command -VMName');
    expect(command).toContain("'vm-1'");
    expect(command).not.toContain('-ComputerName');
  });

  it('carries the guest script as base64 so nested quoting cannot corrupt it', () => {
    expect(command).toContain(Buffer.from("Write-Host 'hi'", 'utf8').toString('base64'));
    expect(command).not.toContain("Write-Host 'hi'");
    expect(command).toContain('ScriptBlock');
  });

  it('escapes the credential for a PowerShell single-quoted string', () => {
    expect(command).toContain("'p''w'");
  });

  it('round-trips a script containing every awkward metacharacter', () => {
    const nasty = `$x = "a'b`;\n Write-Host \`"$x\`" | Out-Null`;
    const encoded = Buffer.from(nasty, 'utf8').toString('base64');
    expect(buildInvokeDirectCommand('vm', credential, nasty)).toContain(encoded);
  });
});

describe('createWindowsGuestExec', () => {
  it('returns the guest exit code and stdout', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'ok\n' }) };
    const guest = createWindowsGuestExec(exec, 'vm', credential);
    expect(await guest.capture('whoami')).toEqual({ exitCode: 0, stdout: 'ok\n' });
  });
});

describe('assertGuestElevated', () => {
  it('passes when the guest reports an administrative token', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'True' }) };
    await expect(
      assertGuestElevated(createWindowsGuestExec(exec, 'vm', credential)),
    ).resolves.toBeUndefined();
  });

  it('throws when the token came back filtered', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: 'False' }) };
    await expect(
      assertGuestElevated(createWindowsGuestExec(exec, 'vm', credential)),
    ).rejects.toThrow(WindowsGuestExecError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/windowsGuestExec.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/windowsGuestExec.ts`**

```ts
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import { quoteForPowerShell } from '../../src/guestSetup/quoteForPowerShell';
import type { WindowsCredential } from './hyperv/windowsCredential';

export class WindowsGuestExecError extends Error {}

export interface WindowsGuestExecResult {
  exitCode: number;
  stdout: string;
}

/**
 * The Windows sibling of guestExec.ts, sharing nothing with it deliberately: a
 * common abstraction over `bash -ic` and `Invoke-Command -VMName` would be a
 * worse module than two honest ones.
 *
 * PowerShell Direct runs over the Hyper-V VMBus with no network involvement,
 * which is the point — the Ubuntu roles reach their guests across the very
 * network under test, survivable only because the serial console keeps
 * logging. Windows writes nothing to serial, so an in-band transport would
 * make a DHCP failure a black box.
 */
export interface WindowsGuestExec {
  vmName: string;
  run(script: string): Promise<WindowsGuestExecResult>;
  capture(script: string): Promise<WindowsGuestExecResult>;
}

/**
 * The guest script crosses as base64 rather than as a quoted literal. It is a
 * PowerShell string inside a PowerShell -Command string inside an argv entry;
 * quoteForPowerShell handles one level of that, not three, and a guest script
 * containing quotes, backticks, `$`, and newlines defeats the nesting outright.
 */
export function buildInvokeDirectCommand(
  vmName: string,
  credential: WindowsCredential,
  script: string,
): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$secure = ConvertTo-SecureString ${quoteForPowerShell(credential.password)} -AsPlainText -Force`,
    `$credential = New-Object System.Management.Automation.PSCredential(${quoteForPowerShell(credential.username)}, $secure)`,
    `$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${quoteForPowerShell(encoded)}))`,
    '$block = [ScriptBlock]::Create($decoded)',
    `Invoke-Command -VMName ${quoteForPowerShell(vmName)} -Credential $credential -ScriptBlock $block`,
  ].join('; ');
}

export function createWindowsGuestExec(
  exec: PowerShellExec,
  vmName: string,
  credential: WindowsCredential,
): WindowsGuestExec {
  const invoke = (script: string): Promise<WindowsGuestExecResult> =>
    exec.run(buildInvokeDirectCommand(vmName, credential, script));
  return { vmName, run: invoke, capture: invoke };
}

/**
 * Replaces the reachability probe the Ubuntu roles need. The guest's address
 * is something this role asks about, not a precondition for asking anything.
 */
export async function waitForPowerShellDirect(
  guest: WindowsGuestExec,
  opts: { timeoutMs?: number; onProgress?: (elapsedMs: number) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { exitCode, stdout } = await guest.capture('"ready"');
    if (exitCode === 0 && stdout.includes('ready')) return;
    opts.onProgress?.(Date.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new WindowsGuestExecError(
    `windowsGuestExec: '${guest.vmName}' never answered PowerShell Direct within ` +
      `${Math.round(timeoutMs / 60_000)} minutes. This is the OOBE-failed signature — check the ` +
      'screenshots for the screen it is stuck on.',
  );
}

/**
 * PowerShell Direct does not inherit the host's elevation; it runs with the
 * supplied guest credential. The built-in RID-500 Administrator normally
 * yields a full administrative token, but 04-configure-network.ps1 declares
 * `#Requires -RunAsAdministrator`, so "normally" is checked rather than assumed.
 */
export async function assertGuestElevated(guest: WindowsGuestExec): Promise<void> {
  const { exitCode, stdout } = await guest.capture(
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  );
  if (exitCode !== 0 || !/true/i.test(stdout)) {
    throw new WindowsGuestExecError(
      `windowsGuestExec: the PowerShell Direct session on '${guest.vmName}' is not elevated ` +
        `(exit ${exitCode}): ${stdout.trim()}. 04-configure-network.ps1 requires an administrative token.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/windowsGuestExec.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/windowsGuestExec.ts tests/unit/guest/windowsGuestExec.test.ts
git commit -m "test(guest): drive the Windows guest over PowerShell Direct"
```

---

### Task 13: Share-name derivation and the Windows role VM

**Files:**

- Modify: `tests/guest/testShare.ts`
- Modify: `tests/guest/hyperv/sweep.ts:36-37`
- Create: `tests/guest/hyperv/windowsTestGuest.ts`
- Test: `tests/unit/guest/testShare.test.ts`

**Interfaces:**

- Consumes: Tasks 4, 9, 10, 12.
- Produces:
  - `shareNameFor(folder: string): string`, `ALL_SHARE_NAMES: readonly string[]` (replaces the `SHARE_NAME` constant)
  - `createTestShare(exec, sharePath)` — unchanged signature; derives the share name from the folder
  - `interface WindowsTestGuest { role: GuestRole; vmName: string; screenshots: ScreenshotHandle }`
  - `createWindowsTestGuest(exec, role, switchName, artifactsDir): Promise<WindowsTestGuest>`
  - `destroyWindowsTestGuest(exec, guest): Promise<void>`

- [ ] **Step 1: Write the failing test**

In `tests/unit/guest/testShare.test.ts`, replace the `SHARE_NAME` import and its assertion:

```ts
import { ALL_SHARE_NAMES, shareNameFor } from '../../guest/testShare';
```

```ts
  it('uses a local-account-safe, machine-global-share-safe name per share folder', () => {
    expect(SHARE_ACCOUNT).toBe('susentorno-test');
    expect(SHARE_ACCOUNT.length).toBeLessThanOrEqual(20);
    expect(shareNameFor('vm-shared-linux')).toBe('susentorno-test-vm-shared-linux');
    expect(shareNameFor('vm-shared-windows')).toBe('susentorno-test-vm-shared-windows');
    expect(ALL_SHARE_NAMES).toEqual([
      'susentorno-test-vm-shared-linux',
      'susentorno-test-vm-shared-windows',
    ]);
  });
```

Replace every other `SHARE_NAME` reference in that file with `shareNameFor('vm-shared-linux')`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/testShare.test.ts`

Expected: FAIL — `shareNameFor` is not exported.

- [ ] **Step 3: Parameterize `testShare.ts`**

Replace the `SHARE_NAME` constant, and derive the name inside create/remove so **no call site changes**:

```ts
import { basename } from 'node:path';
```

```ts
/** SMB share names are machine-global, so these are deliberately namespaced. */
export function shareNameFor(shareFolder: string): string {
  return `susentorno-test-${shareFolder}`;
}

/** Both shares this tier can create; sweep removes them by name regardless of origin. */
export const ALL_SHARE_NAMES: readonly string[] = [
  shareNameFor('vm-shared-linux'),
  shareNameFor('vm-shared-windows'),
];
```

In `createTestShare` and `removeTestShare`, derive the name from the path rather than taking a new parameter — the Linux callers stay untouched:

```ts
export async function createTestShare(exec: PowerShellExec, sharePath: string): Promise<TestShare> {
  const shareName = shareNameFor(basename(sharePath));
  const password = generateSharePassword();
  await exec.run(buildRemoveSmbShareCommand(shareName));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
  const created = await exec.run(buildNewLocalUserCommand(SHARE_ACCOUNT, password));
  if (created.exitCode !== 0)
    throw new Error(`testShare: could not create '${SHARE_ACCOUNT}': ${created.stdout}`);
  const granted = await exec.run(buildGrantNtfsReadExecuteCommand(sharePath, SHARE_ACCOUNT));
  if (granted.exitCode !== 0)
    throw new Error(`testShare: could not grant NTFS access on '${sharePath}': ${granted.stdout}`);
  const shared = await exec.run(buildNewSmbShareCommand(shareName, sharePath, SHARE_ACCOUNT));
  if (shared.exitCode !== 0)
    throw new Error(`testShare: could not create share '${shareName}': ${shared.stdout}`);
  return { account: SHARE_ACCOUNT, shareName, password };
}

export async function removeTestShare(exec: PowerShellExec, sharePath: string): Promise<void> {
  await exec.run(buildRemoveSmbShareCommand(shareNameFor(basename(sharePath))));
  await exec.run(buildRevokeNtfsAceCommand(sharePath, SHARE_ACCOUNT));
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
}
```

- [ ] **Step 4: Update `sweep.ts` to remove both shares**

Replace the existing `../testShare` import block — `SHARE_NAME` no longer exists:

```ts
import {
  ALL_SHARE_NAMES,
  buildRemoveLocalUserCommand,
  buildRemoveSmbShareCommand,
  SHARE_ACCOUNT,
} from '../testShare';
```

Then replace the two trailing lines of `sweepIsolationResidue`:

```ts
  for (const shareName of ALL_SHARE_NAMES) {
    await exec.run(buildRemoveSmbShareCommand(shareName));
  }
  await exec.run(buildRemoveLocalUserCommand(SHARE_ACCOUNT));
```

- [ ] **Step 5: Write `tests/guest/hyperv/windowsTestGuest.ts`**

```ts
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildStartVmCommand } from '../../../src/guestSetup/hyperVOperations';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';
import { roleVhdPath, roleVmName, windowsGoldenVhdPath, type GuestRole } from './imageCache';
import { buildNewDifferencingVhdCommand } from './vhd';
import { startScreenshotCapture, type ScreenshotHandle } from './vmScreenshot';
import {
  buildAddVmHardDiskCommand,
  buildEnableSecureBootWindowsCommand,
  buildNewVmCommand,
  buildRemoveVmCommand,
  buildSetVmDynamicMemoryCommand,
  buildSetVmProcessorCommand,
  buildTurnOffVmCommand,
} from './vm';

export interface WindowsTestGuest {
  role: GuestRole;
  vmName: string;
  screenshots: ScreenshotHandle;
}

/**
 * Secure Boot on with the MicrosoftWindows template, no vTPM. The two are
 * independent settings; omitting the TPM is what keeps automatic device
 * encryption from ever sealing a volume to one VM's protector and stranding
 * every differencing child behind a recovery prompt.
 */
export async function createWindowsTestGuest(
  exec: PowerShellExec,
  role: GuestRole,
  switchName: string,
  artifactsDir: string,
): Promise<WindowsTestGuest> {
  const vmName = roleVmName(role);
  const vhdPath = roleVhdPath(role);
  await exec.run(buildTurnOffVmCommand(vmName));
  await exec.run(buildRemoveVmCommand(vmName));
  rmSync(vhdPath, { force: true });
  for (const [command, what] of [
    [
      buildNewDifferencingVhdCommand(vhdPath, windowsGoldenVhdPath),
      'create the differencing disk',
    ],
    [
      buildNewVmCommand(vmName, { memoryStartupBytes: 4096 * 1024 ** 2, switchName }),
      'create the VM',
    ],
    [buildAddVmHardDiskCommand(vmName, vhdPath), 'attach the differencing disk'],
    [buildSetVmProcessorCommand(vmName, 2), 'set the processor count'],
    [
      buildSetVmDynamicMemoryCommand(vmName, 2048 * 1024 ** 2, 6144 * 1024 ** 2),
      'enable dynamic memory',
    ],
    [buildEnableSecureBootWindowsCommand(vmName), 'enable Secure Boot'],
  ] as const) {
    const { exitCode, stdout } = await exec.run(command);
    if (exitCode !== 0) {
      throw new Error(
        `windowsTestGuest(${role}): could not ${what} (exit ${exitCode}): ${stdout || command}`,
      );
    }
  }
  const screenshots = startScreenshotCapture(exec, vmName, join(artifactsDir, role, 'screenshots'), {
    intervalMs: 60_000,
  });
  const started = await exec.run(buildStartVmCommand(vmName));
  if (started.exitCode !== 0) {
    await screenshots.stop();
    throw new Error(`windowsTestGuest(${role}): Start-VM failed: ${started.stdout}`);
  }
  return { role, vmName, screenshots };
}

export async function destroyWindowsTestGuest(
  exec: PowerShellExec,
  guest: WindowsTestGuest,
): Promise<void> {
  await guest.screenshots.stop().catch(() => {});
  await exec.run(buildTurnOffVmCommand(guest.vmName));
  await exec.run(buildRemoveVmCommand(guest.vmName));
  rmSync(roleVhdPath(guest.role), { force: true });
}
```

- [ ] **Step 6: Run the unit tier**

Run: `pnpm vitest run tests/unit/`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/testShare.ts tests/guest/hyperv/sweep.ts tests/guest/hyperv/windowsTestGuest.ts tests/unit/guest/testShare.test.ts
git commit -m "test(guest): derive share names per folder and add the Windows role VM lifecycle"
```

---

### Task 14: Guest-side ambient trust for Windows

Without this, `git ls-remote` fails on any host that is itself behind a terminating proxy — including a susentorno guest, where `current-auth-list.txt` puts `github.com:443` under `#pragma github authenticated`.

**Files:**

- Create: `tests/guest/windowsAmbientTrust.ts`
- Test: `tests/unit/guest/windowsAmbientTrust.test.ts`

**Interfaces:**

- Consumes: `enumerateHostTrustedRoots` and `diffAmbientCandidates` from `src/` (unmodified), `WindowsGuestExec` from Task 12.
- Produces:
  - `buildListGuestRootSha256Script(): string`
  - `parseGuestRootSha256(stdout: string): string[]`
  - `buildImportRootScript(pem: string): string`
  - `propagateAmbientTrustToWindows(exec, guest, onStep?): Promise<string[]>`
  - `WindowsAmbientTrustError`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/guest/windowsAmbientTrust.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildImportRootScript,
  buildListGuestRootSha256Script,
  parseGuestRootSha256,
  propagateAmbientTrustToWindows,
} from '../../guest/windowsAmbientTrust';
import type { WindowsGuestExec } from '../../guest/windowsGuestExec';
import type { PowerShellExec } from '../../../src/guestSetup/powerShellExec';

describe('buildListGuestRootSha256Script', () => {
  it('reads LocalMachine\\Root via X509Store, not the Cert:\\ PSDrive', () => {
    const script = buildListGuestRootSha256Script();
    expect(script).toContain('X509Store');
    expect(script).toContain("'Root'");
    expect(script).toContain('LocalMachine');
    expect(script).not.toContain('Cert:\\');
  });

  it('reports SHA-256 over DER, matching the host-side diff key', () => {
    expect(buildListGuestRootSha256Script()).toContain('SHA256');
    expect(buildListGuestRootSha256Script()).toContain('RawData');
  });
});

describe('parseGuestRootSha256', () => {
  it('keeps only well-formed lowercase digests', () => {
    expect(parseGuestRootSha256(`${'A'.repeat(64)}\n  ${'b'.repeat(64)}  \nnope\n\n`)).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
    ]);
  });
});

describe('buildImportRootScript', () => {
  it('carries the PEM as base64 rather than as an embedded literal', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n';
    const script = buildImportRootScript(pem);
    expect(script).toContain(Buffer.from(pem, 'utf8').toString('base64'));
    expect(script).not.toContain('BEGIN CERTIFICATE');
    expect(script).toContain('X509Store');
  });
});

describe('propagateAmbientTrustToWindows', () => {
  const der = Buffer.from('fake-certificate');
  const sha256 = createHash('sha256').update(der).digest('hex');
  const hostStdout = JSON.stringify({
    Roots: [{ Thumbprint: 'AA', RawDataBase64: der.toString('base64') }],
    Disallowed: [],
  });

  it('imports only roots the guest is missing', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: hostStdout }) };
    const imported: string[] = [];
    const guest: WindowsGuestExec = {
      vmName: 'vm',
      run: async (script) => {
        imported.push(script);
        return { exitCode: 0, stdout: '' };
      },
      capture: async () => ({ exitCode: 0, stdout: '' }),
    };
    expect(await propagateAmbientTrustToWindows(exec, guest)).toHaveLength(1);
    expect(imported).toHaveLength(1);
  });

  it('imports nothing when the guest already trusts every host root', async () => {
    const exec: PowerShellExec = { run: async () => ({ exitCode: 0, stdout: hostStdout }) };
    const guest: WindowsGuestExec = {
      vmName: 'vm',
      run: async () => {
        throw new Error('must not import anything');
      },
      capture: async () => ({ exitCode: 0, stdout: sha256 }),
    };
    expect(await propagateAmbientTrustToWindows(exec, guest)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/guest/windowsAmbientTrust.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Write `tests/guest/windowsAmbientTrust.ts`**

```ts
import { diffAmbientCandidates } from '../../src/guestSetup/ambientTrust';
import { enumerateHostTrustedRoots } from '../../src/guestSetup/hostTrustStore';
import type { PowerShellExec } from '../../src/guestSetup/powerShellExec';
import type { WindowsGuestExec } from './windowsGuestExec';

export class WindowsAmbientTrustError extends Error {}

/**
 * The guest half of ambient trust, which production has only for Ubuntu:
 * propagateAmbientTrust is wired solely into setup-guest-unix, and there is no
 * Windows command to call a Windows arm from. Adding one to src/ would ship a
 * feature with no caller, so this lives in the harness — but the *host* half,
 * where the trust-selection policy lives, is the production enumerator.
 *
 * Why it is needed at all: on a developer host that is itself behind a
 * terminating proxy, a passthrough destination in the inner policy can still be
 * TLS-terminated by the outer one. current-auth-list.txt puts github.com:443
 * under `#pragma github authenticated`, so the git assertion fails without this.
 */
export function buildListGuestRootSha256Script(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')",
    "$store.Open('ReadOnly')",
    '$sha = [System.Security.Cryptography.SHA256]::Create()',
    'foreach ($c in $store.Certificates) { ' +
      '($sha.ComputeHash($c.RawData) | ForEach-Object { $_.ToString("x2") }) -join "" }',
    '$store.Close()',
  ].join('; ');
}

export function parseGuestRootSha256(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[0-9a-f]{64}$/.test(line));
}

/** base64 over the wire: a PEM's own newlines cannot survive nested quoting. */
export function buildImportRootScript(pem: string): string {
  const encoded = Buffer.from(pem, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `$bytes = [Convert]::FromBase64String('${encoded}')`,
    '$text = [Text.Encoding]::UTF8.GetString($bytes)',
    '$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(' +
      '[Text.Encoding]::ASCII.GetBytes($text))',
    "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')",
    "$store.Open('ReadWrite')",
    '$store.Add($cert)',
    '$store.Close()',
  ].join('; ');
}

/**
 * Diffs rather than bulk-imports. enumerateHostTrustedRoots returns every
 * accepted host root, not the non-public subset, so importing the lot would
 * be both wasteful and misleading about what "ambient" means.
 */
export async function propagateAmbientTrustToWindows(
  exec: PowerShellExec,
  guest: WindowsGuestExec,
  onStep: (message: string) => void = () => {},
): Promise<string[]> {
  onStep('enumerate host trusted roots');
  const { roots } = await enumerateHostTrustedRoots(exec);

  onStep('fingerprint the guest root store');
  const listed = await guest.capture(buildListGuestRootSha256Script());
  if (listed.exitCode !== 0) {
    throw new WindowsAmbientTrustError(
      `windowsAmbientTrust: could not fingerprint the guest root store (exit ${listed.exitCode}): ${listed.stdout}`,
    );
  }
  const guestFingerprints = parseGuestRootSha256(listed.stdout);

  const toInstall = diffAmbientCandidates(roots, guestFingerprints);
  if (toInstall.length === 0) {
    onStep('no ambient interception detected');
    return [];
  }

  const installed: string[] = [];
  for (const root of toInstall) {
    const { exitCode, stdout } = await guest.run(buildImportRootScript(root.pem));
    if (exitCode !== 0) {
      throw new WindowsAmbientTrustError(
        `windowsAmbientTrust: could not import ${root.sha256.slice(0, 16)} (exit ${exitCode}): ${stdout}`,
      );
    }
    installed.push(root.sha256);
  }
  onStep(`trusted ${installed.length} ambient root(s)`);
  return installed;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/guest/windowsAmbientTrust.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/windowsAmbientTrust.ts tests/unit/guest/windowsAmbientTrust.test.ts
git commit -m "test(guest): propagate the host's ambient roots into a Windows guest by diff"
```

---

### Task 15: The `windowsFresh` role

**Files:**

- Create: `tests/guest/windowsDiagnostics.ts`
- Create: `tests/guest/windowsFresh.test.ts`

**Interfaces:**

- Consumes: every prior task.
- Produces: `collectWindowsDiagnostics(guest: WindowsGuestExec, role: GuestRole): Promise<void>`; the role itself produces nothing.

- [ ] **Step 1: Write `tests/guest/windowsDiagnostics.ts`**

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsDir } from './diagnostics';
import type { GuestRole } from './hyperv/imageCache';
import type { WindowsGuestExec } from './windowsGuestExec';

/** Collect each dump independently so one broken command cannot hide the others. */
export async function collectWindowsDiagnostics(
  guest: WindowsGuestExec,
  role: GuestRole,
): Promise<void> {
  const dir = join(artifactsDir, role);
  mkdirSync(dir, { recursive: true });
  const dumps: [string, string][] = [
    [
      'network.txt',
      'Get-NetIPConfiguration | Out-String; Get-NetIPAddress -AddressFamily IPv4 | ' +
        'Format-List InterfaceAlias,InterfaceIndex,IPAddress,PrefixOrigin,SuffixOrigin | Out-String; ' +
        'Get-NetRoute -AddressFamily IPv4 | Out-String; ' +
        'Get-DnsClientServerAddress -AddressFamily IPv4 | Out-String',
    ],
    [
      'trust.txt',
      "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine'); " +
        "$s.Open('ReadOnly'); $s.Certificates | Select-Object Subject,Thumbprint | Out-String; $s.Close()",
    ],
    [
      'environment.txt',
      "[Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
        'git config --global http.sslBackend; net use',
    ],
    [
      'events.txt',
      "Get-WinEvent -LogName System -MaxEvents 100 -ErrorAction SilentlyContinue | " +
        'Format-Table TimeCreated,Id,LevelDisplayName,Message -AutoSize | Out-String -Width 200',
    ],
  ];
  for (const [filename, script] of dumps) {
    try {
      const { stdout } = await guest.capture(script);
      writeFileSync(join(dir, filename), stdout);
    } catch (error) {
      writeFileSync(join(dir, filename), `diagnostics: dump failed: ${String(error)}\n`);
    }
  }
  console.log(`guest(${role}): diagnostics in ${dir}`);
}
```

- [ ] **Step 2: Write `tests/guest/windowsFresh.test.ts`**

Everything lives inside `describe.skipIf(...)` so the `beforeAll` does not run when the ISO is absent.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRealPowerShellExec } from '../../src/guestSetup/powerShellExec';
import { resolveIsolationNetwork } from '../../src/runHosting/isolationNetwork';
import { resolveHostNetworkNames } from '../../src/hostNetwork/hostNetworkNames';
import { startProxyStack, stopProxyStack, type ProxyStack } from '../proxyStack';
import { envRoot } from '../testEnvRoot';
import { artifactsDir } from './diagnostics';
import { ISOLATION_NAME, windowsIsoPath, WINDOWS_ISO_ENV_VAR } from './hyperv/imageCache';
import { ensureWindowsCredential } from './hyperv/windowsCredential';
import {
  createWindowsTestGuest,
  destroyWindowsTestGuest,
  type WindowsTestGuest,
} from './hyperv/windowsTestGuest';
import { createTestShare, removeTestShare, type TestShare } from './testShare';
import { collectWindowsDiagnostics } from './windowsDiagnostics';
import { propagateAmbientTrustToWindows } from './windowsAmbientTrust';
import {
  assertGuestElevated,
  createWindowsGuestExec,
  waitForPowerShellDirect,
  type WindowsGuestExec,
} from './windowsGuestExec';

const exec = createRealPowerShellExec();
const sharePath = join(envRoot, 'vm-shared-windows');
const { switchName: internalSwitchName } = resolveHostNetworkNames(ISOLATION_NAME);
const isoConfigured = windowsIsoPath() !== null;

if (!isoConfigured) {
  console.log(
    `guest: skipping windowsFresh — ${WINDOWS_ISO_ENV_VAR} is not set. Point it at an x64 en-us ` +
      'Windows 11 Enterprise evaluation ISO to enable this role (see testing.md).',
  );
}

let stack: ProxyStack;
let share: TestShare;
let guest: WindowsTestGuest;
let session: WindowsGuestExec;
let internalHostIp: string;
/** The guest's DHCP interface index; every network assertion is scoped to it. */
let interfaceIndex: string;

describe.skipIf(!isoConfigured)('a fresh Windows guest starting in the isolated phase', () => {
  beforeAll(async () => {
    stack = await startProxyStack({ forward: { isolationName: ISOLATION_NAME } });
    share = await createTestShare(exec, sharePath);
    const internal = resolveIsolationNetwork(ISOLATION_NAME);
    if (!internal.found) throw new Error(`windowsFresh: ${internal.adapterAlias} has no IPv4 address`);
    internalHostIp = internal.address;

    guest = await createWindowsTestGuest(exec, 'windowsFresh', internalSwitchName, artifactsDir);
    session = createWindowsGuestExec(exec, guest.vmName, ensureWindowsCredential());
    await waitForPowerShellDirect(session, {
      onProgress: (ms) =>
        console.log(`windowsFresh: waiting for PowerShell Direct... (${Math.round(ms / 1000)}s)`),
    });
    await assertGuestElevated(session);

    const route = await session.capture(
      "(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | " +
        'Sort-Object RouteMetric | Select-Object -First 1).InterfaceIndex',
    );
    expect(route.exitCode, route.stdout).toBe(0);
    interfaceIndex = route.stdout.trim();
    expect(interfaceIndex, 'the guest must have a default route').toMatch(/^\d+$/);

    // Before any TLS assertion: on a host that is itself behind a terminating
    // proxy, a passthrough destination here is terminated upstream.
    await propagateAmbientTrustToWindows(exec, session, (message) =>
      console.log(`windowsFresh: ambientTrust — ${message}`),
    );

    // cmdkey entries are per-address; the share is reached by UNC with no drive letter.
    const mounted = await session.capture(
      `cmdkey /add:${internalHostIp} /user:${share.account} /pass:${share.password}; ` +
        `Get-ChildItem -LiteralPath '\\\\${internalHostIp}\\${share.shareName}' | Out-Null; ` +
        `Test-Path '\\\\${internalHostIp}\\${share.shareName}\\cert.pem'`,
    );
    expect(mounted.exitCode, mounted.stdout).toBe(0);
    expect(mounted.stdout).toMatch(/True/i);

    // -ExecutionPolicy per invocation rather than mutating machine policy: a
    // .ps1 fetched over UNC lands in the Internet zone, but the test should
    // leave behind no state the manual flow would not.
    const configured = await session.capture(
      `powershell.exe -ExecutionPolicy Bypass -File ` +
        `'\\\\${internalHostIp}\\${share.shareName}\\pre-scripts\\04-configure-network.ps1' ` +
        `-HostIp ${internalHostIp} 2>&1 | Out-String`,
    );
    console.log(`windowsFresh: 04-configure-network |\n${configured.stdout}`);
    expect(configured.exitCode, configured.stdout).toBe(0);
  }, 1_800_000);

  afterAll(async () => {
    if (session) await collectWindowsDiagnostics(session, 'windowsFresh').catch(() => {});
    if (guest) await destroyWindowsTestGuest(exec, guest).catch(() => {});
    if (share) await removeTestShare(exec, sharePath).catch(() => {});
    if (stack) await stopProxyStack(stack).catch(() => {});
  }, 600_000);

  describe('configuration arrived entirely from the host', () => {
    it('took its address from the real DHCP server', async () => {
      const { stdout } = await session.capture(
        `Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex} | ` +
          'ForEach-Object { "$($_.IPAddress) $($_.PrefixOrigin) $($_.SuffixOrigin)" }',
      );
      expect(stdout).toContain('Dhcp');
      const [address] = stdout.trim().split(/\s+/);
      expect(address.split('.').slice(0, 3).join('.')).toBe(
        internalHostIp.split('.').slice(0, 3).join('.'),
      );
    });

    it('took its default route from the DHCP lease alone', async () => {
      const { stdout } = await session.capture(
        `(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -InterfaceIndex ${interfaceIndex}).NextHop`,
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('took the host as its resolver from the DHCP lease alone', async () => {
      const { stdout } = await session.capture(
        `(Get-DnsClientServerAddress -AddressFamily IPv4 -InterfaceIndex ${interfaceIndex}).ServerAddresses`,
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('resolves names through the real DNS responder', async () => {
      const { stdout } = await session.capture(
        "(Resolve-DnsName -Name example.com -Type A -DnsOnly | Where-Object Type -eq 'A' | " +
          'Select-Object -First 1).IPAddress',
      );
      expect(stdout.trim()).toBe(internalHostIp);
    });

    it('has no in-guest DNS responder doing any of it', async () => {
      const { stdout } = await session.capture(
        "if (Get-ScheduledTask -TaskName 'SusentornoDnsResponder' -ErrorAction SilentlyContinue) " +
          "{ 'present' } else { 'absent' }",
      );
      expect(stdout.trim()).toBe('absent');
    });
  });

  describe('the shipped configure-network script did its job', () => {
    it('imported the proxy CA into the machine root store', async () => {
      const { stdout } = await session.capture(
        "$s = [System.Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine'); " +
          "$s.Open('ReadOnly'); " +
          "$found = @($s.Certificates | Where-Object { $_.Subject -like '*susentorno-proxy-certificate-authority*' }).Count; " +
          '$s.Close(); $found',
      );
      expect(Number(stdout.trim())).toBeGreaterThan(0);
    });

    it('pointed NODE_EXTRA_CA_CERTS at a file that exists', async () => {
      const { stdout } = await session.capture(
        "$p = [Environment]::GetEnvironmentVariable('NODE_EXTRA_CA_CERTS','Machine'); " +
          'if ($p -and (Test-Path $p)) { "ok $p" } else { "missing $p" }',
      );
      expect(stdout.trim()).toMatch(/^ok /);
    });

    it('set git to validate through schannel', async () => {
      const { stdout } = await session.capture('git config --global http.sslBackend');
      expect(stdout.trim()).toBe('schannel');
    });
  });

  describe('the network boundary behaves', () => {
    it('allows an allow-listed :80 host', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://archive.ubuntu.com/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('passes through an allow-listed :443 host, validated against public roots', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 30 https://pypi.org/",
      );
      expect(Number(stdout.trim())).toBeLessThan(400);
    });

    it('terminates a TLS-intercepted :443 host with the trusted proxy CA', async () => {
      // --ssl-no-revoke: src/ca.ts issues leaves with no CRL or OCSP endpoint,
      // and Schannel fails closed on unknown revocation status. Chain
      // validation stays active; only revocation is waived, and only where
      // susentorno itself is the issuer. verify-config.ps1 documents the same.
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --ssl-no-revoke --max-time 20 https://api.anthropic.com/",
      );
      expect(stdout.trim()).toBe('200');
    });

    it('lets git speak TLS through the proxy on schannel', async () => {
      const { stdout } = await session.capture(
        'git -c http.schannelCheckRevoke=false ls-remote https://github.com/git/git HEAD 2>&1 | ' +
          'Out-String; "exit=$LASTEXITCODE"',
      );
      expect(stdout, stdout).toContain('exit=0');
      expect(stdout).toMatch(/[0-9a-f]{40}\s+HEAD/);
    });

    it('drops a non-allow-listed :443 connection', async () => {
      const { stdout } = await session.capture(
        '& curl.exe -s -o NUL --max-time 20 https://blocked.example.com/ 2>&1 | Out-Null; ' +
          '"exit=$LASTEXITCODE"',
      );
      expect(stdout.trim()).not.toBe('exit=0');
    });

    it('returns default-deny 403 for a non-allow-listed :80 host', async () => {
      const { stdout } = await session.capture(
        "& curl.exe -s -o NUL -w '%{http_code}' --max-time 20 http://blocked.example.com/",
      );
      expect(stdout.trim()).toBe('403');
    });
  });
});
```

- [ ] **Step 3: Run the role against a real guest**

From an **elevated** terminal, Docker running, `run-hosting` stopped:

```powershell
$env:SUSENTORNO_WINDOWS_ISO = '\\192.168.67.1\shared-images\26200.6584.250915-1905.25h2_ge_release_svc_refresh_CLIENTENTERPRISEEVAL_OEMRET_x64FRE_en-us.iso'
pnpm build
pnpm vitest run --config vitest.guest.config.ts tests/guest/windowsFresh.test.ts
```

Expected: PASS. On failure, read `test-results/guest/<timestamp>/windowsFresh/` — `network.txt`, `trust.txt`, `environment.txt`, `events.txt`, and `screenshots/`.

- [ ] **Step 4: Confirm the skip path**

```powershell
Remove-Item Env:\SUSENTORNO_WINDOWS_ISO
pnpm vitest run --config vitest.guest.config.ts tests/guest/windowsFresh.test.ts
```

Expected: all tests reported skipped, with the prescriptive message naming `SUSENTORNO_WINDOWS_ISO`; no VM is created.

- [ ] **Step 5: Commit**

```bash
pnpm typecheck && pnpm lint && pnpm format
git add tests/guest/windowsFresh.test.ts tests/guest/windowsDiagnostics.ts
git commit -m "test(guest): assert the Windows network boundary from inside a real guest"
```

---

### Task 16: Domain record and prerequisites

**Files:**

- Create: `docs/adr/0027-windows-guest-tested-over-powershell-direct.md`
- Modify: `docs/adr/0024-shipped-guest-templates-carry-only-requirements.md`
- Modify: `CONTEXT.md`
- Modify: `testing.md:52`, `testing.md:77`

**Interfaces:**

- Consumes: Tasks 1–15.
- Produces: nothing.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0027-windows-guest-tested-over-powershell-direct.md`:

```markdown
# The Windows guest layer is tested against a real Hyper-V guest over PowerShell Direct

The `guest` tier gains a `windowsFresh` role: a real Windows 11 guest, booted from a differencing disk off a self-built golden image, on the real `susentorno-test-internal` switch, served by the real `run-hosting`.

The claim is: **a real Windows guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, takes its entire network configuration from the host and reaches exactly the destinations the network policy permits and nothing else.**

The harness reaches the guest over **PowerShell Direct**, not SSH. The Ubuntu roles reach their guests across the network under test, which is survivable only because the serial console keeps logging when that network fails; Windows Setup writes nothing to serial, so an in-band transport would make a DHCP failure a black box. PowerShell Direct runs over the VMBus and is unaffected. It also deletes the OpenSSH server, harness keypair, `known_hosts`, and reachability-probe machinery the Ubuntu path needs, and there is no fidelity argument for SSH here because no automated Windows setup path exists to mirror.

Unlike the Ubuntu pipeline, this one is **not bootstrappable from clean**. The Windows Enterprise evaluation sits behind a registration form yielding a short-lived signed URL, so `SUSENTORNO_WINDOWS_ISO` names a locally-supplied ISO and the role self-skips when it is unset. Windows Update runs during the build, which means the image is a function of the calendar and no rebuild is byte-reproducible — a patched baseline was judged worth more than a reproducible one for a guest whose job is to reach the network. The stamp therefore records per-input digests plus a build date, and refuses an image older than 60 days so a time-limited evaluation cannot stay stamp-valid past expiry.

The build ships **no vTPM**. Automatic device encryption requires a TPM; with none present it cannot engage, so it cannot seal the golden volume to the build VM's protector and strand every differencing child behind a recovery prompt. Secure Boot is independent and stays on for role VMs with the `MicrosoftWindows` template. This diverges from `setup-guest.md`, which has real users enable a vTPM; the divergence is accepted because nothing in this role's test surface is TPM-dependent.

## Status

accepted (2026-08-18)

## Considered Options

- **Copy the ISO tree onto a FAT32 installer VHDX, as the Ubuntu build does.** Rejected on a hard fact: `sources/install.wim` is 5.80 GB against FAT32's 4 GiB per-file limit. The Ubuntu build only copies because it must edit `grub.cfg`; Windows requires no media edit, so the ISO is attached unmodified with `autounattend.xml` on a second one-file ISO built by the built-in `IMAPI2FS` component.
- **The pre-built dev VHDX from `aka.ms/windev_VM_hyperv`.** Rejected: no published checksum, a hard expiry, and preloaded with Visual Studio — the cloud-image-versus-installer fidelity gap [[guest-layer-tested-against-real-hyperv]] rejected for Ubuntu.
- **A hand-built golden VHDX.** Rejected: it discards the property the stamp depends on — that the image is defined by the repo — and keeps only unattended acquisition, which matters least.
- **OpenSSH Server in the guest.** Rejected: in-band with the network under test, with no serial fallback.
- **Stubbing `git`**, mirroring [[guest-layer-tested-against-real-hyperv]]'s `gh`. Rejected: it buys tidiness by deleting the assertion with the most to say about the network boundary.
- **A separate `guest-windows` tier.** Rejected by `testing.md`'s placement rule — the observable surface is still behaviour observed inside a disposable guest.
- **A Windows arm of `propagateAmbientTrust` in `src/`.** Rejected: it would ship a product feature with no caller until a `setup-guest-windows` command exists. The guest-side installer lives in the harness; the host-side enumerator is production code.

## Consequences

- Two substitutions, both named: Git is preinstalled in the golden image rather than arriving from `01-install-packages.ps1` (pre-scripts run pre-isolation, so winget has never run through the proxy in production), and the guest-side ambient-root installer is harness code.
- Ambient trust propagation is **required**, not optional flake-proofing: susentorno is developed from inside a susentorno guest, and `current-auth-list.txt` terminates `github.com:443`, so the `git ls-remote` assertion fails without it.
- Revocation checking is waived on susentorno-issued leaves — `src/ca.ts` emits no CRL or OCSP endpoint and Schannel fails closed on unknown status. Chain validation stays active.
- Windows Setup diagnostics are framebuffer thumbnails at roughly 320×240: state classification, not readable text. Offline `Panther\setupact.log` salvage is the named escalation.
- `.image-cache/` grows by roughly 50–60 GB. A cold build takes 60–120 minutes, longer under nested virtualisation.
- This discharges [[shipped-guest-templates-carry-only-requirements]]'s deferred Windows exception. Both platforms now weave `nn-configure-network` out as `04-`.
```

- [ ] **Step 2: Amend ADR-0024**

Replace its first Consequences bullet with:

```markdown
- `templates/vm-shared-windows/` was a known, deliberate exception on the day this was written: it still shipped VS Code, extensions, and .NET tooling, deferred because the Windows guest path was covered by no test tier. **Discharged on 2026-08-18** by [[windows-guest-tested-over-powershell-direct]], whose `windowsFresh` role supplied the missing tier. The trim removed the same classes named above plus Python/PyYAML, `wsl --update`, and the `ssh-agent` enablement, and deleted `04-configure-tools.ps1` outright.
```

And replace its last Consequences bullet, since the predicted divergence closed:

```markdown
- With four built-in Linux pre-scripts reduced to three, `nn-configure-network.sh` weaves out as `04-configure-network.sh` rather than `05-`. Windows initially kept four built-ins and stayed `05-`; the Windows trim then reduced it to three as well, so both platforms now weave out as `04-` and the divergence this ADR predicted no longer exists. Neither script prints its own number, so nothing downstream can couple to it again.
```

- [ ] **Step 3: Add the CONTEXT.md terms**

Under `## Credentials`, after **Placeholder mount**, add:

```markdown
**Ambient trust**: The host's non-public trusted roots — those a terminating proxy in front of the host introduces — propagated into a guest so it can validate the same upstreams the host can. Distinct from **Upstream trust bundle**, which is what the proxy stack validates *its* upstreams against. _Avoid_: extra CAs, corporate roots
```

Under `## Provisioning`, at the end, add:

```markdown
**Guest role**: One disposable guest identity within the guest test tier, from which its VM name, differencing disk, diagnostic channel, and artifacts directory all derive. Follows **Isolation name** in reaching from domain vocabulary into the test tiers. _Avoid_: test guest, VM name
```

- [ ] **Step 4: Update `testing.md`**

Replace the `guest` row of the prerequisites table (line 52):

```markdown
| `guest` | An elevated (Administrator) PowerShell/terminal, Hyper-V, Docker running, and a running `ssh-agent`. Stop any live `susentorno run-hosting` process first — this tier binds the real `:80`/`:443` and manages the same Envoy containers. The first run builds a golden VM image (~20–30 minutes); later runs reuse it from `.image-cache/`. The `windowsFresh` role additionally needs `SUSENTORNO_WINDOWS_ISO` pointing at an **x64, `en-us`** Windows 11 Enterprise evaluation ISO; without it that one role self-skips and the rest of the tier is unaffected. Its first build takes 60–120 minutes and `.image-cache/` grows by roughly 50–60 GB. |
```

Append to the paragraph at line 77:

```markdown
The `windowsFresh` role is the one part of the tier that is opt-in. The Windows evaluation ISO cannot be downloaded unattended, so `SUSENTORNO_WINDOWS_ISO` doubles as the switch that enables it. A stale Windows image is **not** rebuilt silently the way the Ubuntu one is — the tier stops and names which build input changed, because a rebuild costs 60–120 minutes. Re-run with `SUSENTORNO_WINDOWS_IMAGE_REBUILD=1` to rebuild deliberately.
```

- [ ] **Step 5: Verify the full pipeline**

Run: `pnpm test`

Expected: PASS end to end, including the `windowsFresh` role when the ISO variable is set.

- [ ] **Step 6: Commit**

```bash
pnpm format
git add docs/adr/ CONTEXT.md testing.md
git commit -m "docs: record the Windows guest role as ADR-0027 and discharge ADR-0024's exception"
```

---

## Verification checklist

- [ ] `pnpm test:unit` passes.
- [ ] `pnpm build && pnpm test:cli` passes.
- [ ] `pnpm test:guest` passes with `SUSENTORNO_WINDOWS_ISO` set.
- [ ] `pnpm test:guest` passes with it unset, reporting `windowsFresh` as skipped and creating no Windows VM.
- [ ] A second `pnpm test:guest` reuses the cached Windows image rather than rebuilding.
- [ ] Editing `windowsAutounattend.ts` and re-running produces a stale-image error naming `answerXml`.
- [ ] After a full run, `Get-VM susentorno-test-*` returns nothing and `.image-cache/` retains both golden parents.
