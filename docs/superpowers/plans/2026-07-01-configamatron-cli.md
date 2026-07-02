# Configamatron CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `configamatron`, a pnpm/TypeScript CLI at the repo root, and give it a working `import-sbx-network-policy` command that turns a policy file (like `balanced.policy.txt`) into the source-of-truth `allowlist.txt`.

**Architecture:** Scaffold the repo root as a pnpm/TypeScript project copied from `C:\code\e2e-starter-projects` (commander CLI, ESLint/Prettier, tsup build, Vitest unit + e2e tests). Two pure modules — `src/allowlist.ts` (the `allowlist.txt` format) and `src/policyFile.ts` (the policy-file parser) — do the real work; `src/commands/importSbxNetworkPolicy.ts` wires them into a commander subcommand. This plan does **not** implement `build-envoy-config` — that command depends on the Envoy/docker-compose file layout introduced in the follow-on plan (`docs/superpowers/plans/2026-07-01-envoy-proxy-stack.md`), so it's out of scope here. `src/allowlist.ts`'s `Allowlist` type and `parseAllowlist`/`formatAllowlist` functions are the interface that plan will consume.

**Tech Stack:** Node.js >=18, TypeScript, pnpm, commander, tsup, Vitest, ESLint (flat config), Prettier.

## Global Constraints

- Node.js >=18 (`package.json` `engines.node`).
- `packageManager: pnpm@11.3.0` (copied from the template's `package.json`).
- CLI binary name is exactly `configamatron`.
- The policy-import subcommand is named exactly `import-sbx-network-policy`.
- `import-sbx-network-policy`'s `<policyFile>` argument is **required** — no default path (the current location/format of `balanced.policy.txt` is temporary, per the design spec).
- `pnpm test` must run, in order: `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e` — this is the project's whole verification pipeline; every task in this plan must leave it green.
- Repo root is the project root (not a subdirectory) — `package.json` etc. live at `C:\code\fschwiet-agent\package.json`.

---

## Task 1: Scaffold the pnpm/TypeScript project

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc`
- Create: `.prettierignore`
- Create: `.gitignore`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `vitest.e2e.config.ts`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `src/cli.ts`
- Test: `tests/e2e/cli.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working `pnpm test` pipeline; `src/cli.ts` exports nothing (it's the commander entry point) but later tasks import `Command` the same way and call `registerX(program)` functions on the `program` instance it constructs.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "configamatron",
  "version": "0.0.1",
  "description": "CLI for building the Envoy sandbox proxy config from a network policy allow list",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "packageManager": "pnpm@11.3.0",
  "repository": "https://github.com/fschwiet/fschwiet-agent",
  "bin": {
    "configamatron": "dist/cli.js"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "test": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "dependencies": {
    "commander": "^15.0.0"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^25.9.3",
    "eslint": "^10.5.0",
    "eslint-config-prettier": "^10.1.8",
    "execa": "^9.6.1",
    "globals": "^17.6.0",
    "prettier": "^3.8.4",
    "tsup": "^8.5.1",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.61.1",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
allowBuilds:
  esbuild: true
```

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "*.config.ts", "*.config.mjs"]
}
```

- [ ] **Step 4: Create `eslint.config.mjs`**

```js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts', '*.config.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
);
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "printWidth": 100
}
```

- [ ] **Step 6: Create `.prettierignore`**

```
dist/
pnpm-lock.yaml
.claude/
docs/
legacy/
```

(`legacy/` and `docs/` hold hand-written markdown that predates or sits outside this CLI project — they're excluded so `prettier --check .` doesn't reformat them.)

- [ ] **Step 7: Create `.gitignore`**

```
node_modules/
dist/

test-results/
```

- [ ] **Step 8: Create `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node18',
  clean: true,
});
```

- [ ] **Step 9: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
```

- [ ] **Step 10: Create `vitest.e2e.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 30000,
  },
});
```

- [ ] **Step 11: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: ['**']
  pull_request:

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Run test suite
        run: pnpm test
```

- [ ] **Step 12: Create `README.md`**

```markdown
# configamatron

CLI that builds the Envoy sandbox proxy's configuration from a network policy allow list.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) — install with `npm install -g pnpm`

## Install

\`\`\`
pnpm install
\`\`\`

## Verification Pipeline

Run these commands in order to verify a change is correct (fail-fast order):

| Step | Command             | What it checks                          |
| ---- | -------------------- | --------------------------------------- |
| 1    | `pnpm format:check` | Prettier formatting                     |
| 2    | `pnpm lint`         | ESLint rules                            |
| 3    | `pnpm typecheck`    | TypeScript types (no emit)              |
| 4    | `pnpm test:unit`    | Unit tests (Vitest)                     |
| 5    | `pnpm build`        | Production build (tsup → `dist/cli.js`) |
| 6    | `pnpm test:e2e`     | End-to-end tests against the built CLI  |

Run the full pipeline in one command:

\`\`\`
pnpm test
\`\`\`

## Commands

- `configamatron import-sbx-network-policy <policyFile> [-o allowlist.txt]` — parses a network
  policy file (e.g. `balanced.policy.txt`) into the source-of-truth `allowlist.txt`.
```

- [ ] **Step 13: Create `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

program.parse();
```

- [ ] **Step 14: Write the e2e test for `--version`**

```ts
// tests/e2e/cli.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

describe('configamatron CLI', () => {
  it('prints the version with --version', async () => {
    const { stdout, exitCode } = await execa('node', [cliPath, '--version']);
    expect(stdout.trim()).toBe('0.0.1');
    expect(exitCode).toBe(0);
  });
});
```

- [ ] **Step 15: Install dependencies and run the full pipeline**

Run: `pnpm install`
Expected: dependencies installed, `pnpm-lock.yaml` created.

Run: `pnpm test`
Expected: `format:check`, `lint`, `typecheck`, `test:unit` (no unit tests yet, passes trivially), `build`, and `test:e2e` (the `--version` test) all PASS.

- [ ] **Step 16: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.json eslint.config.mjs .prettierrc .prettierignore .gitignore tsup.config.ts vitest.config.ts vitest.e2e.config.ts .github/workflows/ci.yml README.md src/cli.ts tests/e2e/cli.test.ts pnpm-lock.yaml
git commit -m "Scaffold configamatron pnpm/TypeScript CLI from e2e-starter-projects template"
```

---

## Task 2: `allowlist.txt` format — `Allowlist` type, `parseAllowlist`, `formatAllowlist`

**Files:**
- Create: `src/allowlist.ts`
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export interface Allowlist { passthrough: string[]; terminate: string[]; }`
  - `export function parseAllowlist(content: string): Allowlist`
  - `export function formatAllowlist(allowlist: Allowlist): string`
  - These are the exact names/signatures Task 3 and Task 4 (and the follow-on Envoy plan's `build-envoy-config`) import from `../allowlist` (or `./allowlist`).

The on-disk `allowlist.txt` format is plain text with two `#`-prefixed section headers, one `host:port` entry per line, entries sorted alphabetically within each section:

```
# passthrough
**.chatgpt.com:443
archive.ubuntu.com:80

# terminate
api.anthropic.com:443
claude.com:443
```

- [ ] **Step 1: Write the failing unit tests**

```ts
// tests/unit/allowlist.test.ts
import { describe, it, expect } from 'vitest';
import { parseAllowlist, formatAllowlist, type Allowlist } from '../../src/allowlist';

describe('formatAllowlist', () => {
  it('writes sorted passthrough and terminate sections', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
    };

    expect(formatAllowlist(allowlist)).toBe(
      [
        '# passthrough',
        '**.chatgpt.com:443',
        'archive.ubuntu.com:80',
        '',
        '# terminate',
        'api.anthropic.com:443',
        'claude.com:443',
        '',
      ].join('\n'),
    );
  });
});

describe('parseAllowlist', () => {
  it('splits entries into passthrough and terminate by section header', () => {
    const content = [
      '# passthrough',
      '**.chatgpt.com:443',
      'archive.ubuntu.com:80',
      '',
      '# terminate',
      'api.anthropic.com:443',
      'claude.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
    });
  });

  it('round-trips through formatAllowlist', () => {
    const allowlist: Allowlist = {
      passthrough: ['archive.ubuntu.com:80', '**.chatgpt.com:443'],
      terminate: ['claude.com:443', 'api.anthropic.com:443'],
    };

    expect(parseAllowlist(formatAllowlist(allowlist))).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
    });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `src/allowlist.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement `src/allowlist.ts`**

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
}

export function parseAllowlist(content: string): Allowlist {
  const passthrough: string[] = [];
  const terminate: string[] = [];
  let section: 'passthrough' | 'terminate' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '# passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '# terminate') {
      section = 'terminate';
      continue;
    }
    if (line.startsWith('#')) continue;
    if (section === 'passthrough') passthrough.push(line);
    else if (section === 'terminate') terminate.push(line);
  }

  return { passthrough, terminate };
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['# passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '# terminate');
  for (const entry of [...allowlist.terminate].sort()) lines.push(entry);
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test:unit`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/allowlist.ts tests/unit/allowlist.test.ts
git commit -m "Add allowlist.txt format: Allowlist type, parseAllowlist, formatAllowlist"
```

---

## Task 3: Policy-file parser — `parsePolicyFile`

**Files:**
- Create: `src/policyFile.ts`
- Test: `tests/unit/policyFile.test.ts`

**Interfaces:**
- Consumes: `Allowlist` type from `./allowlist` (Task 2).
- Produces: `export function parsePolicyFile(content: string): Allowlist` — Task 4 imports this exact name from `../policyFile`.

`balanced.policy.txt`-style files list rules as whitespace-column rows (`PROVENANCE`, `APPLIES_TO`, `POLICY/RULE`, `TYPE`, `DECISION`, `RESOURCES`), where a rule's remaining `RESOURCES` values continue on following lines that are indented and contain nothing but the resource. Only rows where `TYPE` is `network` and `DECISION` is `allow` are relevant; everything else (e.g. `filesystem:read`/`filesystem:write` rows) is ignored. A resource is classified as `terminate` if its hostname (the part before `:port`) is exactly one of the six Anthropic/Claude hosts the design spec names; otherwise it's `passthrough`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// tests/unit/policyFile.test.ts
import { describe, it, expect } from 'vitest';
import { parsePolicyFile } from '../../src/policyFile';

describe('parsePolicyFile', () => {
  it('collects network/allow resources, splitting terminate hosts from passthrough', () => {
    const content = [
      'PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES',
      'local        all             default-ai-services            network            allow      **.chatgpt.com:443',
      '                                                                                          api.anthropic.com:443',
      '                                                                                          claude.com:443',
      '',
      'local        all             default-os-packages            network            allow      archive.ubuntu.com:80',
      '',
      'local        all             default-fs-read-allow-all      filesystem:read    allow      **',
      '',
      'kit          sandbox:onion   kit:onion                      network            allow      claude.com:443',
    ].join('\n');

    expect(parsePolicyFile(content)).toEqual({
      passthrough: ['**.chatgpt.com:443', 'archive.ubuntu.com:80'],
      terminate: ['api.anthropic.com:443', 'claude.com:443'],
    });
  });

  it('returns empty arrays when there are no network/allow rows', () => {
    const content = [
      'PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES',
      'local        all             default-fs-write-allow-all     filesystem:write   allow      **',
    ].join('\n');

    expect(parsePolicyFile(content)).toEqual({ passthrough: [], terminate: [] });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `src/policyFile.ts` does not exist yet (module not found).

- [ ] **Step 3: Implement `src/policyFile.ts`**

```ts
import type { Allowlist } from './allowlist';

const TERMINATE_HOSTS = new Set([
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
]);

export function parsePolicyFile(content: string): Allowlist {
  const passthrough = new Set<string>();
  const terminate = new Set<string>();
  let currentType: string | null = null;
  let currentDecision: string | null = null;

  const addResource = (resource: string | undefined): void => {
    if (!resource) return;
    if (currentType !== 'network' || currentDecision !== 'allow') return;
    const host = resource.split(':')[0];
    if (TERMINATE_HOSTS.has(host)) terminate.add(resource);
    else passthrough.add(resource);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;
    const isContinuation = /^\s/.test(rawLine);
    if (!isContinuation) {
      const fields = rawLine.trim().split(/\s{2,}/);
      if (fields[0] === 'PROVENANCE') continue;
      const [, , , type, decision, firstResource] = fields;
      currentType = type ?? null;
      currentDecision = decision ?? null;
      addResource(firstResource);
    } else {
      addResource(rawLine.trim());
    }
  }

  return {
    passthrough: [...passthrough].sort(),
    terminate: [...terminate].sort(),
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm test:unit`
Expected: PASS (5 tests total, 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/policyFile.ts tests/unit/policyFile.test.ts
git commit -m "Add parsePolicyFile for balanced.policy.txt-style network policy files"
```

---

## Task 4: `import-sbx-network-policy` command

**Files:**
- Create: `src/commands/importSbxNetworkPolicy.ts`
- Modify: `src/cli.ts` (register the new command)
- Create: `tests/fixtures/sample-policy.txt`
- Modify: `tests/e2e/cli.test.ts` (add the new e2e test)

**Interfaces:**
- Consumes: `parsePolicyFile` from `../policyFile` (Task 3), `formatAllowlist` from `../allowlist` (Task 2).
- Produces: `export function registerImportSbxNetworkPolicy(program: Command): void` — registers the `import-sbx-network-policy` subcommand on a commander `Command` instance. Nothing else depends on this in this plan; the follow-on Envoy plan's `build-envoy-config` command is registered the same way but is independent of this one.

- [ ] **Step 1: Create the fixture policy file**

```
# tests/fixtures/sample-policy.txt
PROVENANCE   APPLIES_TO      POLICY/RULE                    TYPE               DECISION   RESOURCES
local        all             default-ai-services            network            allow      **.chatgpt.com:443
                                                                                          api.anthropic.com:443
                                                                                          claude.com:443

local        all             default-os-packages            network            allow      archive.ubuntu.com:80

local        all             default-fs-read-allow-all      filesystem:read    allow      **
```

- [ ] **Step 2: Write the failing e2e test**

```ts
// tests/e2e/cli.test.ts (add to the existing describe block)
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ... inside describe('configamatron CLI', () => { ... }), add:
it('parses a policy file into allowlist.txt with import-sbx-network-policy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
  const outputPath = join(dir, 'allowlist.txt');
  const fixturePath = fileURLToPath(new URL('../fixtures/sample-policy.txt', import.meta.url));

  try {
    const { exitCode } = await execa('node', [
      cliPath,
      'import-sbx-network-policy',
      fixturePath,
      '-o',
      outputPath,
    ]);

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, 'utf8')).toBe(
      [
        '# passthrough',
        '**.chatgpt.com:443',
        'archive.ubuntu.com:80',
        '',
        '# terminate',
        'api.anthropic.com:443',
        'claude.com:443',
        '',
      ].join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the e2e test and verify it fails**

Run: `pnpm build && pnpm test:e2e`
Expected: FAIL — `error: unknown command 'import-sbx-network-policy'`.

- [ ] **Step 4: Implement `src/commands/importSbxNetworkPolicy.ts`**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parsePolicyFile } from '../policyFile';
import { formatAllowlist } from '../allowlist';

export function registerImportSbxNetworkPolicy(program: Command): void {
  program
    .command('import-sbx-network-policy')
    .description('Parse a network policy file into allowlist.txt')
    .argument('<policyFile>', 'path to the source policy file')
    .option('-o, --output <path>', 'output allowlist file path', 'allowlist.txt')
    .action((policyFile: string, options: { output: string }) => {
      const content = readFileSync(policyFile, 'utf8');
      const allowlist = parsePolicyFile(content);
      writeFileSync(options.output, formatAllowlist(allowlist));
    });
}
```

- [ ] **Step 5: Register the command in `src/cli.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander';
import packageJson from '../package.json';
import { registerImportSbxNetworkPolicy } from './commands/importSbxNetworkPolicy';

const program = new Command();

program
  .name('configamatron')
  .description('CLI for building the Envoy sandbox proxy config from a network policy allow list')
  .version(packageJson.version, '-v, --version', 'output the version number');

registerImportSbxNetworkPolicy(program);

program.parse();
```

- [ ] **Step 6: Run the full pipeline and verify it passes**

Run: `pnpm test`
Expected: `format:check`, `lint`, `typecheck`, `test:unit` (5 tests), `build`, `test:e2e` (2 tests) all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/importSbxNetworkPolicy.ts src/cli.ts tests/fixtures/sample-policy.txt tests/e2e/cli.test.ts
git commit -m "Add import-sbx-network-policy command"
```

---

## Self-Review Notes

- **Spec coverage:** Covers the "Allow-list maintenance" bullets for `import-sbx-network-policy` and the pnpm/TypeScript/template tooling shift. `build-envoy-config` and the `--upstream-override` flag are explicitly deferred to the follow-on plan, which depends on `Allowlist`/`parseAllowlist`/`formatAllowlist` from Task 2.
- **Placeholder scan:** None — every step has runnable code and an exact expected result.
- **Type consistency:** `Allowlist`, `parseAllowlist`, `formatAllowlist`, and `parsePolicyFile` are named and typed identically everywhere they're used across Tasks 2–4.
