# VM GitHub Auth Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the VM's git/`gh` be authenticated against GitHub with a fine-grained personal access token (PAT), scripted end-to-end except for the one step GitHub itself requires to be manual (creating the token in the web UI).

**Architecture:** A new `configamatron write-github-config` CLI command (host side) prompts for the PAT, validates its form, reads the host's git identity, and writes a gitignored `vm/github-config.txt`. Because the whole `vm/` folder is already copied to the VM via the shared folder, a new `vm/05-github-auth.sh` script picks that file up on the VM, installs `gh`, and configures git + `gh auth` from it.

**Tech Stack:** TypeScript/commander (host CLI, existing `configamatron` project), bash (VM scripts, existing `vm/0N-*.sh` convention).

## Global Constraints

- Node >=18 (`package.json` `engines.node`).
- `pnpm test` (`format:check` → `lint` → `typecheck` → `test:unit` → `build` → `test:e2e` → `test:integration`) must stay green after every task.
- Prettier: single quotes, 100-char print width (`.prettierrc`) — run `pnpm format` if unsure.
- `vm/0N-*.sh` scripts are invoked directly, without a leading `sudo`; a script uses `sudo` internally only for the specific commands that need root (established by `vm/01-apt-packages.sh`).
- Real secrets are never committed: add the exact filename to `.gitignore` and never print the secret value to stdout/stderr/logs (matches the existing `vm/cert.pem`, `envoy/secrets/*.yaml` precedent).
- Spec: `docs/superpowers/specs/2026-07-03-vm-github-auth-design.md`.

---

### Task 1: Token format validation

**Files:**
- Create: `src/githubToken.ts`
- Test: `tests/unit/githubToken.test.ts`

**Interfaces:**
- Produces: `validateGithubTokenFormat(token: string): string | null` — returns `null` if `token` matches GitHub's fine-grained PAT format, otherwise a human-readable reason string. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/githubToken.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateGithubTokenFormat } from '../../src/githubToken';

describe('validateGithubTokenFormat', () => {
  it('accepts a well-formed fine-grained token', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    expect(validateGithubTokenFormat(token)).toBeNull();
  });

  it('rejects a token with the wrong prefix', () => {
    const token = 'ghp_' + 'A'.repeat(89);
    expect(validateGithubTokenFormat(token)).toBe('token must start with "github_pat_"');
  });

  it('rejects a truncated token', () => {
    const token = 'github_pat_' + 'A'.repeat(40);
    expect(validateGithubTokenFormat(token)).toBe('token must be 93 characters long, got 51');
  });

  it('rejects a token with invalid characters after the prefix', () => {
    const token = 'github_pat_' + 'A'.repeat(81) + '!';
    expect(validateGithubTokenFormat(token)).toBe(
      'token must contain only letters, digits, and underscores after the prefix',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/githubToken.test.ts`
Expected: FAIL — `Cannot find module '../../src/githubToken'` (or similar resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `src/githubToken.ts`:

```ts
const TOKEN_PREFIX = 'github_pat_';
const TOKEN_LENGTH = 93;

export function validateGithubTokenFormat(token: string): string | null {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return `token must start with "${TOKEN_PREFIX}"`;
  }
  if (token.length !== TOKEN_LENGTH) {
    return `token must be ${TOKEN_LENGTH} characters long, got ${token.length}`;
  }
  const body = token.slice(TOKEN_PREFIX.length);
  if (!/^[A-Za-z0-9_]+$/.test(body)) {
    return 'token must contain only letters, digits, and underscores after the prefix';
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/githubToken.test.ts`
Expected: PASS — 4 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/githubToken.ts tests/unit/githubToken.test.ts
git commit -m "Add GitHub fine-grained PAT format validation"
```

---

### Task 2: Config file formatting

**Files:**
- Create: `src/githubConfig.ts`
- Test: `tests/unit/githubConfig.test.ts`

**Interfaces:**
- Produces: `interface GithubConfig { username: string; email: string; token: string }` and `formatGithubConfig(config: GithubConfig): string` from `src/githubConfig.ts`. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/githubConfig.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatGithubConfig } from '../../src/githubConfig';

describe('formatGithubConfig', () => {
  it('writes username, email, and token as quoted shell variable assignments', () => {
    const content = formatGithubConfig({
      username: 'Test User',
      email: 'test@example.com',
      token: 'github_pat_abc123',
    });

    expect(content).toBe(
      [
        'GITHUB_USERNAME="Test User"',
        'GITHUB_EMAIL="test@example.com"',
        'GITHUB_TOKEN="github_pat_abc123"',
        '',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/githubConfig.test.ts`
Expected: FAIL — `Cannot find module '../../src/githubConfig'` (or similar resolution error).

- [ ] **Step 3: Write minimal implementation**

Create `src/githubConfig.ts`:

```ts
export interface GithubConfig {
  username: string;
  email: string;
  token: string;
}

export function formatGithubConfig(config: GithubConfig): string {
  return [
    `GITHUB_USERNAME="${config.username}"`,
    `GITHUB_EMAIL="${config.email}"`,
    `GITHUB_TOKEN="${config.token}"`,
    '',
  ].join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/githubConfig.test.ts`
Expected: PASS — 1 test passed.

- [ ] **Step 5: Commit**

```bash
git add src/githubConfig.ts tests/unit/githubConfig.test.ts
git commit -m "Add GitHub VM config file formatting"
```

---

### Task 3: `write-github-config` CLI command

**Files:**
- Create: `src/commands/writeGithubConfig.ts`
- Modify: `src/cli.ts`
- Modify: `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: `validateGithubTokenFormat(token: string): string | null` from `src/githubToken.ts` (Task 1); `formatGithubConfig(config: GithubConfig): string` and `GithubConfig` from `src/githubConfig.ts` (Task 2).
- Produces: `registerWriteGithubConfig(program: Command): void` from `src/commands/writeGithubConfig.ts`, registered in `src/cli.ts`. Writes `vm/github-config.txt` (relative to CWD) with keys `GITHUB_USERNAME`, `GITHUB_EMAIL`, `GITHUB_TOKEN` — these exact key names are consumed by Task 5's `vm/05-github-auth.sh`.

This command reads real host state (`git config --global`) and prompts on stdin, so its tests isolate that state with git's `GIT_CONFIG_GLOBAL` environment variable (verified to work: pointing it at a fixture file makes `git config --global` read only that file, regardless of the machine's real `~/.gitconfig`) instead of mocking.

- [ ] **Step 1: Write the failing e2e tests**

In `tests/e2e/cli.test.ts`, change the top `node:fs` import to also pull in `existsSync`:

```ts
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
```

Then append this new `describe` block at the end of the file (after the existing `describe('configamatron CLI', ...)` block's closing `});`):

```ts
describe('write-github-config', () => {
  const validToken = 'github_pat_' + 'A'.repeat(82);

  function writeFixtureGitConfig(path: string, contents: string): void {
    writeFileSync(path, contents);
  }

  it('writes vm/github-config.txt from a valid token and host git identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n');

    try {
      const { exitCode, stdout } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
      });

      expect(exitCode).toBe(0);
      expect(stdout).toContain('wrote vm/github-config.txt for Test User <test@example.com>');
      expect(readFileSync(join(dir, 'vm', 'github-config.txt'), 'utf8')).toBe(
        [
          'GITHUB_USERNAME="Test User"',
          'GITHUB_EMAIL="test@example.com"',
          `GITHUB_TOKEN="${validToken}"`,
          '',
        ].join('\n'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed token without writing the file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n');

    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: 'not-a-real-token\n',
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid token');
      expect(existsSync(join(dir, 'vm', 'github-config.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when git user.name/user.email are not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '');

    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('user.name/user.email');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts -t "write-github-config"`
Expected: FAIL — commander reports an unknown command (`write-github-config` isn't registered yet), so all 3 new tests fail.

- [ ] **Step 3: Write the command**

Create `src/commands/writeGithubConfig.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { validateGithubTokenFormat } from '../githubToken';
import { formatGithubConfig } from '../githubConfig';

const OUTPUT_PATH = 'vm/github-config.txt';

function readGitConfigValue(key: string): string {
  try {
    return execFileSync('git', ['config', '--global', key], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export function registerWriteGithubConfig(program: Command): void {
  program
    .command('write-github-config')
    .description(
      'Prompt for a GitHub fine-grained PAT and write vm/github-config.txt for the VM setup scripts',
    )
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const token = (await rl.question('GitHub fine-grained PAT: ')).trim();
      rl.close();

      const tokenError = validateGithubTokenFormat(token);
      if (tokenError) {
        console.error(`write-github-config: invalid token - ${tokenError}`);
        process.exitCode = 1;
        return;
      }

      const username = readGitConfigValue('user.name');
      const email = readGitConfigValue('user.email');
      if (!username || !email) {
        console.error(
          'write-github-config: git config --global user.name/user.email must be set first',
        );
        process.exitCode = 1;
        return;
      }

      mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, formatGithubConfig({ username, email, token }));

      console.log(`write-github-config: wrote ${OUTPUT_PATH} for ${username} <${email}>`);
    });
}
```

- [ ] **Step 4: Register the command and switch to async parsing**

Replace the full contents of `src/cli.ts`:

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';
import { registerBuildEnvoyConfig } from './commands/buildEnvoyConfig';
import { registerWriteGithubConfig } from './commands/writeGithubConfig';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerImportSbxNetworkPolicy(program);
registerBuildEnvoyConfig(program);
registerWriteGithubConfig(program);

await program.parseAsync();
```

(Switching `program.parse()` to `await program.parseAsync()` is required because `write-github-config`'s action is `async`; the existing synchronous commands are unaffected.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts -t "write-github-config"`
Expected: PASS — 3 tests passed.

- [ ] **Step 6: Run the full e2e suite to confirm no regressions**

Run: `pnpm build && pnpm test:e2e`
Expected: PASS — all tests in `tests/e2e/cli.test.ts` pass, including the pre-existing ones.

- [ ] **Step 7: Commit**

```bash
git add src/commands/writeGithubConfig.ts src/cli.ts tests/e2e/cli.test.ts
git commit -m "Add configamatron write-github-config command"
```

---

### Task 4: Gitignore and checked-in template

**Files:**
- Modify: `.gitignore`
- Create: `vm/github-config.txt.template`

**Interfaces:**
- None (no code interfaces; documents the file `write-github-config` (Task 3) produces and `05-github-auth.sh` (Task 5) consumes).

- [ ] **Step 1: Add the real config file to `.gitignore`**

Modify `.gitignore`, adding a line after `vm/cert.pem`:

```
vm/cert.pem
vm/github-config.txt
```

- [ ] **Step 2: Create the checked-in template**

Create `vm/github-config.txt.template`:

```
GITHUB_USERNAME="your-github-username"
GITHUB_EMAIL="you@example.com"
GITHUB_TOKEN="github_pat_REPLACE_WITH_REAL_TOKEN"
```

- [ ] **Step 3: Verify the ignore rule and that the template is tracked**

Run: `git check-ignore -v vm/github-config.txt`
Expected: prints a match against the `.gitignore` line just added (confirms a real config file at that path would be ignored).

Run: `git status --short vm/github-config.txt.template`
Expected: `?? vm/github-config.txt.template` (untracked, not ignored — ready to be added).

- [ ] **Step 4: Commit**

```bash
git add .gitignore vm/github-config.txt.template
git commit -m "Ignore vm/github-config.txt, add its template"
```

---

### Task 5: VM-side auth script

**Files:**
- Create: `vm/05-github-auth.sh`

**Interfaces:**
- Consumes: `vm/github-config.txt` (produced by Task 3's `write-github-config` command) with shell variables `GITHUB_USERNAME`, `GITHUB_EMAIL`, `GITHUB_TOKEN`.

This script only runs meaningfully on the Ubuntu VM (it calls `apt`/`gh`/`git config --global`, which would mutate whatever machine runs it), so there is no automated test for its behavior — only a syntax check here, plus a manual verification checklist to run once on the actual VM.

- [ ] **Step 1: Write the script**

Create `vm/05-github-auth.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
config_path="$dir/github-config.txt"

if [ ! -f "$config_path" ]; then
  echo "05-github-auth: $config_path not found. Run 'pnpm exec configamatron write-github-config' on the host first, then re-copy vm/ to the VM." >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$config_path"

if [ -z "${GITHUB_USERNAME:-}" ] || [ -z "${GITHUB_EMAIL:-}" ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "05-github-auth: $config_path is missing GITHUB_USERNAME, GITHUB_EMAIL, or GITHUB_TOKEN" >&2
  exit 1
fi

sudo apt install -y gh

git config --global user.name "$GITHUB_USERNAME"
git config --global user.email "$GITHUB_EMAIL"
echo "$GITHUB_TOKEN" | gh auth login --with-token
gh auth setup-git

echo "05-github-auth: git identity and gh auth configured for $GITHUB_USERNAME <$GITHUB_EMAIL>"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n vm/05-github-auth.sh`
Expected: no output, exit code 0.

- [ ] **Step 3: Manually verify on the VM (not automated)**

After running Task 3's command on the host and copying `vm/` over:
1. On the VM, run `bash vm/05-github-auth.sh` — expect it to install `gh`, then print the `05-github-auth: git identity and gh auth configured for ...` confirmation.
2. Run `git config --global user.name` and `git config --global user.email` — expect them to match the host identity.
3. Run `gh auth status` — expect it to report as logged in.
4. Run `git ls-remote https://github.com/<a repo the token has access to>.git` — expect it to list refs without prompting for credentials.
5. Remove `vm/github-config.txt` from the VM and re-run `bash vm/05-github-auth.sh` — expect it to fail with the "not found" message from Step 1, without installing `gh` or touching git config.

- [ ] **Step 4: Commit**

```bash
git add vm/05-github-auth.sh
git commit -m "Add vm/05-github-auth.sh to configure git/gh from github-config.txt"
```

---

### Task 6: Update `vm-setup.md`

**Files:**
- Modify: `vm-setup.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add the prerequisite note and step 5**

In `vm-setup.md`, replace the `## Install other typical tools` section:

```markdown
## Install other typical tools

Run these in order, without `sudo` — each script uses `sudo` internally where it actually needs root. Open a **new terminal** wherever noted, so the shell picks up PATH changes the previous step's installer wrote to `~/.bashrc`.

Before step 5, create a fine-grained personal access token at https://github.com/settings/personal-access-tokens/new (scoped to whichever repos the VM needs to clone/push), then on the host run `pnpm exec configamatron write-github-config` and paste the token when prompted.

1. `bash vm/01-apt-packages.sh`
2. `bash vm/02-install-pnpm.sh`
3. Open a new terminal, then `bash vm/03-install-tools.sh`
4. Open a new terminal, then `bash vm/04-configure-tools.sh`
5. `bash vm/05-github-auth.sh`
```

- [ ] **Step 2: Verify the referenced scripts all exist**

Run: `ls vm/01-apt-packages.sh vm/02-install-pnpm.sh vm/03-install-tools.sh vm/04-configure-tools.sh vm/05-github-auth.sh`
Expected: all 5 paths printed, no "No such file or directory" errors.

- [ ] **Step 3: Commit**

```bash
git add vm-setup.md
git commit -m "Document vm/05-github-auth.sh in vm-setup.md"
```
