# GitHub Credential Injection Implementation Plan

**Goal:** Inject GitHub credentials at the Envoy proxy on the wire (mirroring the Claude injection) so neither the VM nor the shared folder ever holds a real GitHub credential.

**Architecture:** `github.com` (HTTP Basic) and `api.github.com` (Bearer) are TLS-terminated by Envoy. A per-host inline-Lua **gate** 403s any credential that isn't the fixed placeholder, then `credential_injector` overwrites `Authorization` with the real credential read from a new file-based SDS secret (`github-secret.yaml`) that lives beside — but is never rewritten by — the Claude SDS secret. The host-side `write-github-config` command splits its outputs: identity + a placeholder PAT go to the VM share; the real credential goes only to the proxy's watched secrets dir.

**Tech Stack:** TypeScript + commander (host CLI `configamatron`), Envoy v1.31 (`credential_injector`, file-SDS, inline Lua filter), Docker Compose, Vitest (unit / e2e / integration), pnpm.

## Global Constraints

- Node `>=18` (`package.json` `engines.node`).
- Prettier: single quotes, `printWidth: 100`, `proseWrap: never`, `prettier-plugin-sh` (`.prettierrc`) — run `pnpm format` if unsure.
- Full gate `pnpm test` runs in this order and must stay green after every task: `format:check` → `lint` → `typecheck` → `test:unit` → `build` → `test:e2e` → `test:integration`.
- Real secrets are never committed and never printed: the secret filename is git-ignored and the PAT value never reaches stdout/stderr/logs (matches the `credentials.json` / `secrets/*.yaml` precedent).
- The fixed placeholder PAT is the single constant `ghp-SANDBOX-PLACEHOLDER` (spec §Provisioning). The Claude placeholder is unrelated: `sk-ant-oat-SANDBOX-PLACEHOLDER`.
- `.configamatron/` is generated per-environment and wholly git-ignored; source templates live under `templates/`. Edit `templates/…`, never the generated `.configamatron/…` copies.
- Integration/vm suites require Docker; each integration suite builds its own `.configamatron` env with `init` + `generate-ca` and runs `run-proxy` against a mock upstream via `--upstream-override`.
- Spec: `docs/honist-v/specs/2026-07-19-github-credential-injection-design.md`.

---

### Task 1: Allowlist model — rename `terminate` → `claudeAuthenticated`, add `githubAuthenticated`

Renames the in-memory `terminate` field to `claudeAuthenticated` and adds a parallel `githubAuthenticated` field fed by a new `#pragma github authenticated` section, so the two injection paths read symmetrically. GitHub hosts are TLS-terminated (leaf SANs) like Claude and auth-candidate hosts.

**Files:**

- Modify: `src/allowlist.ts` (whole file below)
- Modify: `src/policyFile.ts:56-61` (return object)
- Modify: `src/envoyConfig.ts:356` (one field reference)
- Test: `tests/unit/allowlist.test.ts`, `tests/unit/envoyConfig.test.ts`, `tests/unit/policyFile.test.ts`

**Interfaces:**

- Produces: `interface Allowlist { passthrough: string[]; claudeAuthenticated: string[]; githubAuthenticated: string[]; authCandidate: string[]; warnings: string[] }`.
- Produces: `parseAllowlist(content: string): Allowlist` — recognizes `#pragma github authenticated`; collision priority high→low is `authCandidate > githubAuthenticated > claudeAuthenticated > passthrough`.
- Produces: `terminateTlsHosts(allowlist): string[]` — now includes `githubAuthenticated` :443 hosts.
- Produces: `formatAllowlist(allowlist): string` — emits a `#pragma github authenticated` section when non-empty.
- Consumed by: Task 4 (`allowlist.githubAuthenticated` in `generateEnvoyConfig`) and Task 5.

- [ ] **Step 1: Rewrite `src/allowlist.ts`**

Replace the whole file with:

```ts
export interface Allowlist {
  passthrough: string[];
  claudeAuthenticated: string[];
  githubAuthenticated: string[];
  authCandidate: string[];
  warnings: string[];
}

export const WILDCARD_HOST_PATTERN = /^\*\.[^*]+$/;

function splitHostPort(entry: string): { host: string; port: string } {
  const idx = entry.lastIndexOf(':');
  return { host: entry.slice(0, idx), port: entry.slice(idx + 1) };
}

function prunePassthrough(entries: string[]): string[] {
  const wildcardSuffixesByPort = new Map<string, string[]>();
  for (const entry of entries) {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) {
      const suffixes = wildcardSuffixesByPort.get(port) ?? [];
      suffixes.push(host.slice(1)); // "*.ubuntu.com" -> ".ubuntu.com"
      wildcardSuffixesByPort.set(port, suffixes);
    }
  }

  return entries.filter((entry) => {
    const { host, port } = splitHostPort(entry);
    if (host.startsWith('*.')) return true;
    const suffixes = wildcardSuffixesByPort.get(port);
    return !suffixes?.some((suffix) => host.endsWith(suffix));
  });
}

type Section = 'passthrough' | 'claudeAuthenticated' | 'githubAuthenticated' | 'authCandidate';

export function parseAllowlist(content: string): Allowlist {
  const passthrough = new Set<string>();
  const claudeAuthenticated = new Set<string>();
  const githubAuthenticated = new Set<string>();
  const authCandidate = new Set<string>();
  const warnings = new Set<string>();
  let section: Section | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === '#pragma passthrough') {
      section = 'passthrough';
      continue;
    }
    if (line === '#pragma claude authenticated') {
      section = 'claudeAuthenticated';
      continue;
    }
    if (line === '#pragma github authenticated') {
      section = 'githubAuthenticated';
      continue;
    }
    if (line === '#pragma auth candidate') {
      section = 'authCandidate';
      continue;
    }
    if (line === '# passthrough' || line === '# terminate') {
      const replacement =
        line === '# passthrough' ? '#pragma passthrough' : '#pragma claude authenticated';
      throw new Error(`Legacy allowlist header "${line}"; use "${replacement}"`);
    }
    if (line.startsWith('#pragma ')) {
      throw new Error(`Invalid pragma: "${line}"`);
    }
    if (line.startsWith('#')) continue;
    if (section === null) continue;

    const { host } = splitHostPort(line);
    const hasWildcard = host.includes('*');
    const noWildcards = section !== 'passthrough'; // terminated sections take exact hosts only

    if (hasWildcard && (noWildcards || !WILDCARD_HOST_PATTERN.test(host))) {
      warnings.add(`unsupported wildcard syntax, excluded: '${line}'`);
      continue;
    }

    if (section === 'passthrough') passthrough.add(line);
    else if (section === 'claudeAuthenticated') claudeAuthenticated.add(line);
    else if (section === 'githubAuthenticated') githubAuthenticated.add(line);
    else authCandidate.add(line);
  }

  const passthroughSet = new Set(prunePassthrough([...passthrough]));

  // Resolve exact host:port strings present in more than one section. Priority:
  // authCandidate > githubAuthenticated > claudeAuthenticated > passthrough. Losing
  // copies are dropped so Envoy emits exactly one filter chain per SNI, and each
  // drop is reported as a warning.
  const byPriority: Array<{ name: string; set: Set<string> }> = [
    { name: 'authCandidate', set: authCandidate },
    { name: 'githubAuthenticated', set: githubAuthenticated },
    { name: 'claudeAuthenticated', set: claudeAuthenticated },
    { name: 'passthrough', set: passthroughSet },
  ];
  const displayOrder = [
    'passthrough',
    'claudeAuthenticated',
    'githubAuthenticated',
    'authCandidate',
  ];

  for (const entry of new Set([
    ...passthroughSet,
    ...claudeAuthenticated,
    ...githubAuthenticated,
    ...authCandidate,
  ])) {
    const present = byPriority.filter((s) => s.set.has(entry));
    if (present.length < 2) continue;
    const [winner, ...losers] = present; // byPriority is priority-ordered
    for (const loser of losers) loser.set.delete(entry);
    const listed = displayOrder.filter((name) => present.some((p) => p.name === name));
    warnings.add(`collision: '${entry}' listed in ${listed.join(' and ')}; using ${winner.name}`);
  }

  return {
    passthrough: [...passthroughSet],
    claudeAuthenticated: [...claudeAuthenticated],
    githubAuthenticated: [...githubAuthenticated],
    authCandidate: [...authCandidate],
    warnings: [...warnings],
  };
}

/** Hosts the proxy terminates TLS for (the leaf's SANs): claude + github + authCandidate entries on :443, port stripped. */
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return [
    ...allowlist.claudeAuthenticated,
    ...allowlist.githubAuthenticated,
    ...allowlist.authCandidate,
  ]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}

export function formatAllowlist(allowlist: Allowlist): string {
  const lines: string[] = ['#pragma passthrough'];
  for (const entry of [...allowlist.passthrough].sort()) lines.push(entry);
  lines.push('', '#pragma claude authenticated');
  for (const entry of [...allowlist.claudeAuthenticated].sort()) lines.push(entry);
  if (allowlist.githubAuthenticated.length > 0) {
    lines.push('', '#pragma github authenticated');
    for (const entry of [...allowlist.githubAuthenticated].sort()) lines.push(entry);
  }
  if (allowlist.authCandidate.length > 0) {
    lines.push('', '#pragma auth candidate');
    for (const entry of [...allowlist.authCandidate].sort()) lines.push(entry);
  }
  lines.push('');
  return lines.join('\n');
}
```

- [ ] **Step 2: Update `src/policyFile.ts` return object**

At `src/policyFile.ts:56-61`, replace the returned object so the renamed field is used and the new field is present:

```ts
  return {
    passthrough: [...passthrough].sort(),
    claudeAuthenticated: [...terminate].sort(),
    githubAuthenticated: [],
    authCandidate: [],
    warnings: [...warnings].sort(),
  };
```

(The local `terminate` Set in this file stays — it collects the well-known Claude hosts; only the emitted field name changes.)

- [ ] **Step 3: Update the one `generateEnvoyConfig` field reference**

At `src/envoyConfig.ts:356`, change:

```ts
  const terminateBuilt = allowlist.terminate
```

to:

```ts
  const terminateBuilt = allowlist.claudeAuthenticated
```

- [ ] **Step 4: Run typecheck to surface every test literal that must change**

Run: `pnpm typecheck`
Expected: FAIL — TypeScript errors in `tests/unit/allowlist.test.ts`, `tests/unit/envoyConfig.test.ts`, and `tests/unit/policyFile.test.ts` on `Allowlist` object literals that still use `terminate:` / lack `githubAuthenticated`. The error list is the exact set of literals to fix in Step 5.

- [ ] **Step 5: Mechanically update the three unit-test files**

Apply these transformations. The compiler (Step 6) proves completeness.

**Rule A — every `Allowlist` object literal and every `parseAllowlist(...)`/`parsePolicyFile(...)` expected-result object** in `tests/unit/allowlist.test.ts`, `tests/unit/envoyConfig.test.ts`, `tests/unit/policyFile.test.ts`:
- rename the `terminate: [...]` property to `claudeAuthenticated: [...]` (same value),
- add `githubAuthenticated: []` immediately after it.

Example (from `tests/unit/envoyConfig.test.ts:5-10`) becomes:

```ts
const allowlist: Allowlist = {
  passthrough: ['*.chatgpt.com:443', 'archive.ubuntu.com:80'],
  claudeAuthenticated: ['api.anthropic.com:443'],
  githubAuthenticated: [],
  authCandidate: [],
  warnings: [],
};
```

**Rule B — three collision-warning assertions in `tests/unit/allowlist.test.ts`** whose text contains the word `terminate` must be updated (the priority-name is now `claudeAuthenticated`):

- The `passthrough+terminate collision` test — expected warning becomes:
  `"collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated"`
- The `terminate+authCandidate collision` test — expected warning becomes:
  `"collision: 'shared.example.com:443' listed in claudeAuthenticated and authCandidate; using authCandidate"`
- The `host present in all three sections` test — expected warning becomes:
  `"collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated and authCandidate; using authCandidate"`
- The `invalid-syntax + collision together` test — expected warning becomes:
  `"collision: 'shared.example.com:443' listed in passthrough and claudeAuthenticated; using claudeAuthenticated"`

(These four tests build their input with `#pragma claude authenticated`, which is unchanged; only the expected warning strings change.)

- [ ] **Step 6: Run typecheck + unit suite to verify existing coverage is green**

Run: `pnpm typecheck && pnpm exec vitest run tests/unit/allowlist.test.ts tests/unit/envoyConfig.test.ts tests/unit/policyFile.test.ts`
Expected: PASS — no type errors, all existing tests pass.

- [ ] **Step 7: Add the failing tests for the new `#pragma github authenticated` behavior**

Append this `describe` block at the end of `tests/unit/allowlist.test.ts`:

```ts
describe('parseAllowlist github authenticated', () => {
  it('parses the #pragma github authenticated section as its own field', () => {
    const content = [
      '#pragma passthrough',
      'pypi.org:443',
      '',
      '#pragma claude authenticated',
      'api.anthropic.com:443',
      '',
      '#pragma github authenticated',
      'github.com:443',
      'api.github.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: ['pypi.org:443'],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      authCandidate: [],
      warnings: [],
    });
  });

  it('flags a wildcard in the github section as invalid', () => {
    const content = [
      '#pragma github authenticated',
      '*.github.com:443',
      'github.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: ['github.com:443'],
      authCandidate: [],
      warnings: ["unsupported wildcard syntax, excluded: '*.github.com:443'"],
    });
  });

  it('resolves a claude+github collision to github with a warning', () => {
    const content = [
      '#pragma claude authenticated',
      'shared.example.com:443',
      '',
      '#pragma github authenticated',
      'shared.example.com:443',
      '',
    ].join('\n');

    expect(parseAllowlist(content)).toEqual({
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: ['shared.example.com:443'],
      authCandidate: [],
      warnings: [
        "collision: 'shared.example.com:443' listed in claudeAuthenticated and githubAuthenticated; using githubAuthenticated",
      ],
    });
  });

  it('round-trips the github section through formatAllowlist', () => {
    const allowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      authCandidate: [],
      warnings: [],
    };
    const formatted = formatAllowlist(allowlist);
    expect(formatted).toBe(
      [
        '#pragma passthrough',
        '',
        '#pragma claude authenticated',
        'api.anthropic.com:443',
        '',
        '#pragma github authenticated',
        'api.github.com:443',
        'github.com:443',
        '',
      ].join('\n'),
    );
    expect(parseAllowlist(formatted)).toEqual({
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['api.github.com:443', 'github.com:443'],
      authCandidate: [],
      warnings: [],
    });
  });

  it('includes github :443 hosts in terminateTlsHosts', () => {
    const allowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: ['api.anthropic.com:443'],
      githubAuthenticated: ['github.com:443', 'api.github.com:443'],
      authCandidate: [],
      warnings: [],
    };
    expect(terminateTlsHosts(allowlist)).toEqual([
      'api.anthropic.com',
      'github.com',
      'api.github.com',
    ]);
  });
});
```

- [ ] **Step 8: Run the new tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/allowlist.test.ts`
Expected: PASS — all existing plus the 5 new `github authenticated` tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/allowlist.ts src/policyFile.ts src/envoyConfig.ts tests/unit/allowlist.test.ts tests/unit/envoyConfig.test.ts tests/unit/policyFile.test.ts
git commit -m "feat(allowlist): rename terminate->claudeAuthenticated, add #pragma github authenticated"
```

---

### Task 2: Placeholder constant + `github-secret.yaml` formatter

The single source of truth for the placeholder PAT, plus the formatter that renders the two-resource SDS secret (Basic for `github.com`, Bearer for `api.github.com`).

**Files:**

- Create: `src/githubPlaceholder.ts`
- Create: `src/githubSecret.ts`
- Test: `tests/unit/githubSecret.test.ts`

**Interfaces:**

- Produces: `GITHUB_PLACEHOLDER_PAT = 'ghp-SANDBOX-PLACEHOLDER'` from `src/githubPlaceholder.ts`. Consumed by Task 3 (VM config value) and Task 4 (gate Lua constants).
- Produces: `formatGithubSecret(username: string, token: string): string` from `src/githubSecret.ts` — renders `github_basic_auth` = `Basic base64(username:token)` and `github_api_token` = `Bearer token`. Consumed by Task 3 and Task 5.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/githubSecret.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatGithubSecret } from '../../src/githubSecret';

describe('formatGithubSecret', () => {
  it('renders both SDS resources with Basic and Bearer inline strings', () => {
    const token = 'github_pat_' + 'A'.repeat(82);
    const basic = 'Basic ' + Buffer.from(`octocat:${token}`).toString('base64');

    expect(formatGithubSecret('octocat', token)).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_basic_auth',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "${basic}"`,
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_api_token',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "Bearer ${token}"`,
        '',
      ].join('\n'),
    );
  });

  it('base64-encodes the username:token pair for the Basic resource', () => {
    const out = formatGithubSecret('Test User', 'github_pat_xyz');
    const expected = Buffer.from('Test User:github_pat_xyz').toString('base64');
    expect(out).toContain(`inline_string: "Basic ${expected}"`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/githubSecret.test.ts`
Expected: FAIL — `Cannot find module '../../src/githubSecret'`.

- [ ] **Step 3: Write the placeholder constant**

Create `src/githubPlaceholder.ts`:

```ts
/**
 * The single fixed placeholder PAT the VM's git/gh sends on the wire to both
 * github.com and api.github.com. The proxy's gates check for exactly this value
 * and the credential_injector swaps it for the real credential. It is never a
 * real token, so it is safe to ship into the VM share.
 */
export const GITHUB_PLACEHOLDER_PAT = 'ghp-SANDBOX-PLACEHOLDER';
```

- [ ] **Step 4: Write the formatter**

Create `src/githubSecret.ts`:

```ts
/**
 * Render the Envoy file-based SDS secret consumed from
 * .configamatron/proxy/secrets/github-secret.yaml. It carries two resources:
 * `github_basic_auth` (git's Basic auth to github.com) and `github_api_token`
 * (gh's Bearer auth to api.github.com), both derived from one PAT.
 */
export function formatGithubSecret(username: string, token: string): string {
  const basic = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_basic_auth',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${basic}"`,
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_api_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/githubSecret.test.ts`
Expected: PASS — 2 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/githubPlaceholder.ts src/githubSecret.ts tests/unit/githubSecret.test.ts
git commit -m "feat(github): add placeholder PAT constant and github-secret.yaml formatter"
```

---

### Task 3: Repurpose `write-github-config` to split its outputs

The command now writes only identity + the placeholder PAT to the VM share, and the real credential to the proxy's watched secrets dir (`github-secret.yaml`, a sibling of `sds-secret.yaml` that `run-proxy` never rewrites). The PAT is validated but never echoed.

**Files:**

- Modify: `src/envPaths.ts` (add `githubSecret` path)
- Modify: `src/commands/writeGithubConfig.ts` (whole action below)
- Modify: `.gitignore` (ignore the secret filename)
- Test: `tests/unit/envPaths.test.ts`, `tests/e2e/cli.test.ts`

**Interfaces:**

- Consumes: `validateGithubTokenFormat` (`src/githubToken.ts`), `formatGithubConfig` (`src/githubConfig.ts`), `formatGithubSecret` (Task 2), `GITHUB_PLACEHOLDER_PAT` (Task 2), `requireEnvPathsOrExit` (`src/envPaths.ts`).
- Produces: `EnvPaths.githubSecret: string` = `<root>/proxy/secrets/github-secret.yaml`.
- Produces: VM-share `github-config.txt` files whose `GITHUB_TOKEN` is the placeholder; and `github-secret.yaml` holding the real Basic + Bearer credentials.

- [ ] **Step 1: Add the failing envPaths test**

In `tests/unit/envPaths.test.ts`, add a `githubSecret` assertion. Find the block that asserts on `sdsSecret` and add alongside it (adjust the surrounding variable name if it differs — the test builds `envPaths(cwd)` and checks joined paths):

```ts
  it('locates github-secret.yaml beside the Claude SDS secret', () => {
    const paths = envPaths('/tmp/project');
    expect(paths.githubSecret).toBe(
      join('/tmp/project', '.configamatron', 'proxy', 'secrets', 'github-secret.yaml'),
    );
  });
```

(If `tests/unit/envPaths.test.ts` does not already import `join` from `node:path`, add it to the imports.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — `paths.githubSecret` is `undefined` (property does not exist yet) / type error.

- [ ] **Step 3: Add `githubSecret` to `EnvPaths`**

In `src/envPaths.ts`, add the field to the `EnvPaths` interface right after `sdsSecret: string;` (line 28):

```ts
  sdsSecret: string;
  githubSecret: string;
```

And in the returned object in `envPaths()`, add it right after the `sdsSecret` line (line 59):

```ts
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    githubSecret: join(proxy, 'secrets', 'github-secret.yaml'),
```

- [ ] **Step 4: Run the envPaths test to verify it passes**

Run: `pnpm exec vitest run tests/unit/envPaths.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewrite the command action**

Replace the whole body of `src/commands/writeGithubConfig.ts` with:

```ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { validateGithubTokenFormat } from '../githubToken';
import { formatGithubConfig } from '../githubConfig';
import { formatGithubSecret } from '../githubSecret';
import { GITHUB_PLACEHOLDER_PAT } from '../githubPlaceholder';
import { requireEnvPathsOrExit } from '../envPaths';

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
      'Prompt for a GitHub fine-grained PAT. Write identity + a placeholder PAT to the VM ' +
        'share, and the real credential only to the proxy secret github-secret.yaml.',
    )
    .action(async () => {
      const paths = requireEnvPathsOrExit('write-github-config');
      if (!paths) return;

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

      // VM share: identity + the placeholder PAT only. No real secret crosses to the VM.
      for (const target of paths.vmSharedTargets) {
        mkdirSync(dirname(target.githubConfig), { recursive: true });
        writeFileSync(
          target.githubConfig,
          formatGithubConfig({ username, email, token: GITHUB_PLACEHOLDER_PAT }),
        );
      }

      // Proxy watched dir: the real credential, in a sibling SDS file run-proxy never rewrites.
      mkdirSync(dirname(paths.githubSecret), { recursive: true });
      writeFileSync(paths.githubSecret, formatGithubSecret(username, token));

      // Never echo the token.
      console.log(
        `write-github-config: wrote placeholder github-config.txt to vm-shared and vm-shared-windows, ` +
          `and the real credential to github-secret.yaml for ${username} <${email}>`,
      );
    });
}
```

- [ ] **Step 6: Ignore the secret filename**

In `.gitignore`, add a line under the `.NET project builds` block's precedent — append at the end of the file:

```
# GitHub proxy credential (real PAT); belt-and-suspenders on top of .configamatron/
github-secret.yaml
```

- [ ] **Step 7: Rewrite the e2e tests for the split outputs**

In `tests/e2e/cli.test.ts`, replace the three `it(...)` cases inside the `describe('write-github-config', ...)` block (lines 140-219) with these. The success case now asserts the placeholder in the VM file, the real token only in `github-secret.yaml`, and that stdout never contains the real token:

```ts
  it('writes a placeholder VM config and the real credential to github-secret.yaml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n');

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stdout } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: `${validToken}\n`,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
      });

      expect(exitCode).toBe(0);
      // The real token is never printed.
      expect(stdout).not.toContain(validToken);

      // VM share gets identity + the placeholder PAT, never the real token.
      const vmConfig = readFileSync(
        join(dir, '.configamatron', 'vm-shared', 'github-config.txt'),
        'utf8',
      );
      expect(vmConfig).toBe(
        [
          'GITHUB_USERNAME="Test User"',
          'GITHUB_EMAIL="test@example.com"',
          'GITHUB_TOKEN="ghp-SANDBOX-PLACEHOLDER"',
          '',
        ].join('\n'),
      );
      expect(vmConfig).not.toContain(validToken);

      // The real credential lands only in the proxy secret.
      const secret = readFileSync(
        join(dir, '.configamatron', 'proxy', 'secrets', 'github-secret.yaml'),
        'utf8',
      );
      expect(secret).toContain('name: github_basic_auth');
      expect(secret).toContain('name: github_api_token');
      expect(secret).toContain(`inline_string: "Bearer ${validToken}"`);
      const expectedBasic = 'Basic ' + Buffer.from(`Test User:${validToken}`).toString('base64');
      expect(secret).toContain(`inline_string: "${expectedBasic}"`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a malformed token without writing either output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '[user]\n\tname = Test User\n\temail = test@example.com\n');

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa('node', [cliPath, 'write-github-config'], {
        cwd: dir,
        input: 'not-a-real-token\n',
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath },
        reject: false,
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('invalid token');
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt'))).toBe(false);
      expect(
        existsSync(join(dir, '.configamatron', 'proxy', 'secrets', 'github-secret.yaml')),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when git user.name/user.email are not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const gitConfigPath = join(dir, 'gitconfig');
    writeFixtureGitConfig(gitConfigPath, '');

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
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
```

- [ ] **Step 8: Build and run the e2e tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.e2e.config.ts -t "write-github-config"`
Expected: PASS — 3 tests passed.

- [ ] **Step 9: Confirm no e2e regressions**

Run: `pnpm test:e2e`
Expected: PASS — all e2e tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/envPaths.ts src/commands/writeGithubConfig.ts .gitignore tests/unit/envPaths.test.ts tests/e2e/cli.test.ts
git commit -m "feat(write-github-config): split placeholder VM config from real proxy secret"
```

---

### Task 4: Envoy GitHub filter chains (inline Lua gates + injectors)

Two builders parallel to `buildTerminateEntry`, each emitting `gate (inline Lua) → credential_injector → router`. `github.com` uses a username-agnostic Basic gate (base64-decode, check only the password half against the placeholder PAT); `api.github.com` uses an exact-match Bearer gate. Both read from `github-secret.yaml`.

**Files:**

- Modify: `src/envoyConfig.ts` (add gate constants, `buildGithubEntry`, wire into `generateEnvoyConfig`)
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: `allowlist.githubAuthenticated` (Task 1), `GITHUB_PLACEHOLDER_PAT` (Task 2), existing `buildTlsUpstreamCluster`, `sanitizeName`, `accessLog`.
- Produces (in the generated config): per github host a filter chain matching its SNI with an inline-Lua gate, a `credential_injector` whose SDS credential name is `github_basic_auth` (github.com) or `github_api_token` (api.github.com) read from `/etc/envoy/secrets/github-secret.yaml`, and a cluster `cluster_github_<sanitized host>`.

- [ ] **Step 1: Write the failing unit tests**

Append this `describe` block at the end of `tests/unit/envoyConfig.test.ts`:

```ts
describe('generateEnvoyConfig github authenticated', () => {
  const ghAllowlist: Allowlist = {
    passthrough: [],
    claudeAuthenticated: ['api.anthropic.com:443'],
    githubAuthenticated: ['github.com:443', 'api.github.com:443'],
    authCandidate: [],
    warnings: [],
  };

  function githubChain(host: string) {
    const config = generateEnvoyConfig(ghAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    return listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes(host),
    );
  }

  it('builds a github.com Basic chain: inline lua gate, injector, router', () => {
    const chain = githubChain('github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);
    // Gate is inline (no mounted file) and embeds a base64 decoder + placeholder check.
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
    expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBeUndefined();
    // Injector reads the Basic SDS resource from the sibling github secret file.
    const injector = hcm.http_filters[1].typed_config;
    expect(injector.overwrite).toBe(true);
    const cred = injector.credential.typed_config.credential;
    expect(cred.name).toBe('github_basic_auth');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-secret.yaml',
    );
    expect(cred.sds_config.path_config_source.watched_directory.path).toBe('/etc/envoy/secrets');
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_github_github_com',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
  });

  it('builds an api.github.com Bearer chain with an exact-match inline gate', () => {
    const chain = githubChain('api.github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('Bearer ghp-SANDBOX-PLACEHOLDER');
    // Bearer gate is a plain exact match — no base64 decoder embedded.
    expect(lua).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const cred = hcm.http_filters[1].typed_config.credential.typed_config.credential;
    expect(cred.name).toBe('github_api_token');
  });

  it('serves the leaf cert and builds override-aware github clusters', () => {
    const config = generateEnvoyConfig(ghAllowlist, {
      overrides: [{ sniHost: 'github.com', target: '127.0.0.1:9443' }],
    }) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const chain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('github.com'),
    );
    const tls = chain.transport_socket.typed_config.common_tls_context.tls_certificates[0];
    expect(tls.certificate_chain.filename).toBe('/etc/envoy/ca/leaf-cert.pem');

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_github_github_com',
    );
    expect(
      cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
    ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    expect(
      cluster.transport_socket.typed_config.common_tls_context.validation_context
        .trust_chain_verification,
    ).toBe('ACCEPT_UNTRUSTED');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts -t "github authenticated"`
Expected: FAIL — no `github.com` filter chain exists yet (`chain` is `undefined`).

- [ ] **Step 3: Add the gate constants and builder**

In `src/envoyConfig.ts`, add this import at the top (after the existing `import type { Allowlist }` line):

```ts
import { GITHUB_PLACEHOLDER_PAT } from './githubPlaceholder';
```

Then add these module-level constants and the builder immediately above `buildTerminateEntry` (before line 171):

```ts
// api.github.com: exact-match Bearer gate (same shape as templates/proxy/gate.lua,
// only the placeholder constant differs).
const GITHUB_BEARER_GATE_LUA = `local PLACEHOLDER = "Bearer ${GITHUB_PLACEHOLDER_PAT}"

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  if auth ~= PLACEHOLDER then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
`;

// github.com: git sends Basic base64(<login>:<PAT>). The login is chosen by gh's
// credential helper and unknown at config time, so this gate decodes the credential
// and checks ONLY the password half against the placeholder PAT, ignoring the user.
// Envoy's Lua has no base64 decoder, so one is embedded inline.
const GITHUB_BASIC_GATE_LUA = `local PLACEHOLDER_PAT = "${GITHUB_PLACEHOLDER_PAT}"
local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function b64decode(data)
  if #data % 4 ~= 0 or string.match(data, "[^" .. B64 .. "=]") then
    return nil
  end
  data = string.gsub(data, "=", "")
  local bits = string.gsub(data, ".", function(c)
    local f = B64:find(c, 1, true) - 1
    local r = ""
    for i = 6, 1, -1 do
      r = r .. (f % (2 ^ i) - f % (2 ^ (i - 1)) > 0 and "1" or "0")
    end
    return r
  end)
  return (string.gsub(bits, "%d%d%d?%d?%d?%d?%d?%d?", function(x)
    if #x ~= 8 then
      return ""
    end
    local c = 0
    for i = 1, 8 do
      c = c + (x:sub(i, i) == "1" and 2 ^ (8 - i) or 0)
    end
    return string.char(c)
  end))
end

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  local encoded = string.match(auth, "^Basic (.+)$")
  if encoded == nil then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
    return
  end
  local decoded = b64decode(encoded)
  if decoded == nil then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
    return
  end
  local password = string.match(decoded, "^[^:]*:(.*)$")
  if password ~= PLACEHOLDER_PAT then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
`;

// github.com -> Basic gate + github_basic_auth; api.github.com -> Bearer gate + github_api_token.
const GITHUB_INJECTION: Record<string, { sdsResource: string; gate: string }> = {
  'github.com': { sdsResource: 'github_basic_auth', gate: GITHUB_BASIC_GATE_LUA },
  'api.github.com': { sdsResource: 'github_api_token', gate: GITHUB_BEARER_GATE_LUA },
};

function buildGithubEntry(
  entry: string,
  overrides: UpstreamOverride[],
  sdsResource: string,
  gateSource: string,
) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_github_${sanitizeName(sniHost)}`;

  const filterChain = {
    filter_chain_match: { server_names: [sniHost] },
    transport_socket: {
      name: 'envoy.transport_sockets.tls',
      typed_config: {
        '@type':
          'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext',
        common_tls_context: {
          tls_certificates: [
            {
              certificate_chain: { filename: '/etc/envoy/ca/leaf-cert.pem' },
              private_key: { filename: '/etc/envoy/ca/leaf-key.pem' },
            },
          ],
        },
      },
    },
    filters: [
      {
        name: 'envoy.filters.network.http_connection_manager',
        typed_config: {
          '@type':
            'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
          stat_prefix: `github_${sanitizeName(sniHost)}`,
          // Reuse the 'term' access-log tag: github chains are credential-injected
          // terminate chains, so they classify as ALLOW CRED like the Claude host.
          access_log: accessLog('term'),
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'terminate',
                domains: ['*'],
                routes: [{ match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } }],
              },
            ],
          },
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: gateSource },
              },
            },
            {
              name: 'envoy.filters.http.credential_injector',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: true,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'Authorization',
                    credential: {
                      name: sdsResource,
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/github-secret.yaml',
                          watched_directory: { path: '/etc/envoy/secrets' },
                        },
                        resource_api_version: 'V3',
                      },
                    },
                  },
                },
              },
            },
            {
              name: 'envoy.filters.http.router',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
              },
            },
          ],
        },
      },
    ],
  };

  const cluster = buildTlsUpstreamCluster(clusterName, sniHost, portStr, override);

  return { filterChain, cluster };
}
```

- [ ] **Step 4: Wire the github chains into `generateEnvoyConfig`**

In `src/envoyConfig.ts`, inside `generateEnvoyConfig`, add a `githubBuilt` array right after the `authCandidateBuilt` block (after line 361):

```ts
  const githubBuilt = allowlist.githubAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => {
      const host = e.split(':')[0];
      const cfg = GITHUB_INJECTION[host];
      return cfg ? buildGithubEntry(e, overrides, cfg.sdsResource, cfg.gate) : null;
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
```

Then splice its filter chains into `listener_443` — change the `filter_chains` array head (currently lines 392-393) to include github chains after the auth-candidate chains:

```ts
          filter_chains: [
            ...terminateBuilt.map((b) => b.filterChain),
            ...authCandidateBuilt.map((b) => b.filterChain),
            ...githubBuilt.map((b) => b.filterChain),
```

And splice its clusters into the `clusters` array (currently lines 490-491), after the auth-candidate clusters:

```ts
      clusters: [
        ...terminateBuilt.map((b) => b.cluster),
        ...authCandidateBuilt.map((b) => b.cluster),
        ...githubBuilt.map((b) => b.cluster),
```

- [ ] **Step 5: Run the github unit tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts`
Expected: PASS — all existing plus the 3 new `github authenticated` tests pass.

- [ ] **Step 6: Confirm lint + full unit suite are green**

Run: `pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(envoy): add github.com Basic and api.github.com Bearer injection chains"
```

---

### Task 5: Integration — drive the GitHub chains through a running proxy

Behaviorally validates the hand-written Basic gate and both injectors against a real Envoy container. Because the Basic gate embeds hand-written base64 Lua, this must run through the proxy, not just assert on generated YAML. Uses its own isolated environment (own ports, own allowlist, own `github-secret.yaml`) so it does not perturb the shared `proxyStack` or the vm suite's cold-cache probe.

**Files:**

- Create: `tests/integration/githubInjection.test.ts`

**Interfaces:**

- Consumes: `startMockUpstream`/`stopMockUpstream` (`tests/integration/mockUpstream.ts`), `formatGithubSecret` (Task 2), `GITHUB_PLACEHOLDER_PAT` (Task 2), the built CLI `dist/cli.js`, `killProcessTree`, `rmEnvRoot`.

- [ ] **Step 1: Write the integration test**

Create `tests/integration/githubInjection.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { formatGithubSecret } from '../../src/githubSecret';
import { GITHUB_PLACEHOLDER_PAT } from '../../src/githubPlaceholder';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other integration suites' ports.
const HTTPS_PORT = 18447;
const HTTP_PORT = 18184;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

// The real credential the proxy injects (written straight into github-secret.yaml).
const REAL_TOKEN = 'github_pat_' + 'R'.repeat(82);
const REAL_USER = 'proxied-user';
const REAL_BASIC = 'Basic ' + Buffer.from(`${REAL_USER}:${REAL_TOKEN}`).toString('base64');
const REAL_BEARER = `Bearer ${REAL_TOKEN}`;

const basicOf = (user: string, pass: string) =>
  'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

let mockUpstream: MockUpstream;
let tempDir: string;
let credentialsPath: string;
let caCertPem: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

function writeCredentials(token: string): void {
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: { accessToken: token, expiresAt: Date.now() + 24 * 60 * 60 * 1000 },
    }),
  );
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for '${needle}'\n--- output ---\n${stdoutLines.join('\n')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(
  servername: string,
  authorization: string,
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername,
        ca: caCertPem,
        path: '/',
        headers: { authorization },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'github-inj-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-github-int');

  await rmEnvRoot(envRoot);
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });

  // Stage an allowlist with both github hosts under the new pragma so generate-ca
  // puts them in the leaf SANs and run-proxy builds the two injection chains.
  writeFileSync(
    join(proxyDir, 'allowlist.txt'),
    [
      '#pragma github authenticated',
      'github.com:443',
      'api.github.com:443',
      '',
    ].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

  // The proxy's watched secrets dir must hold the github secret before Envoy starts,
  // since both chains reference its SDS resources.
  writeFileSync(
    join(proxyDir, 'secrets', 'github-secret.yaml'),
    formatGithubSecret(REAL_USER, REAL_TOKEN),
  );

  proxyProc = execa(
    'node',
    [
      cliPath,
      'run-proxy',
      '--no-refresh',
      '--no-forward',
      '--credentials',
      credentialsPath,
      '--upstream-override',
      `github.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override',
      `api.github.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, buffer: false, reject: false },
  );
  for (const stream of [proxyProc.stdout, proxyProc.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => stdoutLines.push(line));
  }

  await waitForLine('serving the current token', 60000);
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');
}, 120000);

afterAll(async () => {
  if (proxyProc?.pid !== undefined) {
    await killProcessTree(proxyProc.pid, 'SIGINT');
  }
  try {
    await proxyProc;
  } catch {
    // ignore kill/non-zero
  }
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
    reject: false,
  });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('github.com Basic injection', () => {
  it('injects the real Basic credential when the placeholder token is presented (any username)', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'github.com',
      basicOf('whoever', GITHUB_PLACEHOLDER_PAT),
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_BASIC]);
  });

  it('403s a Basic credential whose token half is not the placeholder', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'github.com',
      basicOf('whoever', 'some-other-token'),
    );
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });

  it('403s a non-Basic Authorization on github.com', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('github.com', 'Bearer not-basic-at-all');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
});

describe('api.github.com Bearer injection', () => {
  it('injects the real Bearer token when the placeholder Bearer is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'api.github.com',
      `Bearer ${GITHUB_PLACEHOLDER_PAT}`,
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_BEARER]);
  });

  it('403s a non-placeholder Bearer before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
});
```

- [ ] **Step 2: Build and run the integration test to verify it passes**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/githubInjection.test.ts`
Expected: PASS — 5 tests passed. (Requires Docker; the `beforeAll` builds an env, brings up Envoy, and confirms it accepts the config with both github chains by reaching `serving the current token`.)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/githubInjection.test.ts
git commit -m "test(github): integration drive Basic/Bearer gates and injection through Envoy"
```

---

### Task 6: Wire production allowlist, reorder VM script 05, update docs

Moves `github.com` / `api.github.com` into the production allowlist's github section, documents that `05-github-auth` runs after network isolation + reboot (its `gh auth login --with-token` validates against api.github.com, which only works once the proxy injects the real Bearer), and removes the now-false "VM holds a real GitHub token" caveat.

**Files:**

- Modify: `current-allow-list.txt`
- Modify: `usage-windows-vm.md`
- Modify: `usage-hyper-v-host.md:223`
- Modify: `README.md` (VM script order, around line 94)

**Interfaces:**

- None (data/docs only). `05-github-auth.sh`/`.ps1` need no code change: they read whatever `GITHUB_TOKEN` is in `github-config.txt`, which is now the placeholder.

- [ ] **Step 1: Move github hosts into the github-authenticated section of the production allowlist**

In `current-allow-list.txt`:
1. Delete the line `github.com:443` from the `#pragma passthrough` section (it is at ~line 136, between `ghcr.io:443` and `gitlab.com:443`).
2. Add a new section immediately before the `#pragma claude authenticated` line (~line 222). Insert:

```
#pragma github authenticated
api.github.com:443
github.com:443

```

(Leave the passthrough wildcard `*.github.com:443` as-is — Envoy prefers the exact `api.github.com` terminate chain over the wildcard passthrough match, and `github.com` is the bare domain the wildcard never covered.)

- [ ] **Step 2: Verify the edited allowlist parses with github hosts terminated**

Run: `node -e "const {parseAllowlist,terminateTlsHosts}=require('./dist/allowlist.js');const fs=require('fs');const a=parseAllowlist(fs.readFileSync('current-allow-list.txt','utf8'));console.log('github:',a.githubAuthenticated);console.log('warnings:',a.warnings);console.log('term hosts include github.com:',terminateTlsHosts(a).includes('github.com'),'api.github.com:',terminateTlsHosts(a).includes('api.github.com'));"`
Expected: `github:` lists `api.github.com:443` and `github.com:443`; `warnings:` is `[]`; both `term hosts include` checks print `true`. (If `dist/` is stale, run `pnpm build` first.)

- [ ] **Step 3: Reorder the Windows VM setup steps so 05 runs after isolation**

In `usage-windows-vm.md`, replace the numbered list (lines 24-32) with this order — `05-github-auth.ps1` moves to run only after the network is host-only and the VM has rebooted:

```markdown
1. `.\01-install-packages.ps1`
2. `.\02-install-pnpm.ps1`
3. New terminal, then `.\03-install-tools.ps1`
4. New terminal, then `.\04-configure-tools.ps1`
5. `.\06-trust-ca.ps1` — trusts the proxy CA (defaults to the `cert.pem` beside the script).
6. `.\07-setup-network.ps1 <host-ip>` — `<host-ip>` is printed by proxy setup step 5. Publishes the DNS responder, registers it as a startup task, and points the VM's DNS at it.
7. `.\08-claude-config.ps1` — sets the onboarding flag and installs the placeholder credential.
8. Switch the VM's network from NAT to **host-only**, then reboot so the isolation takes effect.
9. `.\05-github-auth.ps1` — run **after** isolation + reboot: it configures git/gh from the placeholder PAT and validates the token against api.github.com, which only succeeds once the proxy is injecting the real credential on the wire.
```

- [ ] **Step 4: Reorder the README VM script list**

In `README.md`, find the numbered VM-script list containing `5. \`05-github-auth.sh\`` (~line 94). Move `05-github-auth.sh` so it is the last step, after the host-only switch + reboot, mirroring Step 3. Add a short parenthetical: `05-github-auth.sh (run last, after network isolation + reboot — it validates the token against api.github.com through the proxy)`. Renumber the surrounding items so `06-trust-ca.sh`, `07-setup-persistence.sh`, and `08-claude-config.sh` keep their relative order ahead of the isolation/reboot step.

- [ ] **Step 5: Remove the stale GitHub-token caveat**

In `usage-hyper-v-host.md`, replace line 223:

```markdown
The shared `credentials.json` and GitHub `github-config.txt` are both **placeholders** — the real Claude token and the real GitHub PAT are injected on the wire by the proxy, never stored in the VM. `configamatron-share` is the only credential anywhere in the VM — one more reason to keep it as inert as possible.
```

- [ ] **Step 6: Verify the referenced scripts still exist and docs have no dangling references**

Run: `ls templates/vm-shared-windows/05-github-auth.ps1 templates/vm-shared/05-github-auth.sh && grep -n "real GitHub token\|does still hold a real GitHub" usage-hyper-v-host.md`
Expected: both script paths print; the `grep` prints nothing (exit 1) — the stale caveat is gone.

- [ ] **Step 7: Commit**

```bash
git add current-allow-list.txt usage-windows-vm.md usage-hyper-v-host.md README.md
git commit -m "docs(github): wire github hosts into allowlist, run 05-github-auth after isolation"
```

---

### Task 7: Full-suite green + final verification

- [ ] **Step 1: Run the complete gate**

Run: `pnpm test`
Expected: PASS — `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration` all succeed (Docker required for the integration stage).

- [ ] **Step 2: Manual end-to-end (documented, not automated)**

On a real setup, after `configamatron write-github-config` with a real PAT:
1. Confirm `.configamatron/vm-shared/github-config.txt` contains `GITHUB_TOKEN="ghp-SANDBOX-PLACEHOLDER"` (not the real PAT) and `.configamatron/proxy/secrets/github-secret.yaml` holds the real Basic + Bearer resources.
2. With the proxy running and the VM isolated, run `05-github-auth` on the VM, then `git push` to a repo the PAT can write, and a `gh api user` call — both succeed through injection.
3. From the VM, send a **non-placeholder** `Authorization` to `https://github.com/` and `https://api.github.com/` (e.g. a made-up Basic/Bearer) — the proxy returns 403 before the upstream (leaked-credential gate).

- [ ] **Step 3: Commit any doc tweaks from the manual pass (if needed), otherwise done.**

---

## Self-Review

**1. Spec coverage**

- Problem / wire scheme (Basic for github.com, Bearer for api.github.com) → Task 4 (gates + injectors), Task 5 (behavioral).
- `www.github.com` not injected → not added anywhere (Task 6 leaves it out); nothing to do.
- One PAT feeds both hosts → Task 2 `formatGithubSecret(username, token)` derives both resources from one token.
- Architecture (TLS-terminate, gate, injector, watched_directory hot-reload) → Task 4; `github-secret.yaml` shares `/etc/envoy/secrets` watched dir (Task 4 injector config).
- Provisioning split (placeholder to VM share, real to sibling SDS file, not `sds-secret.yaml`) → Task 3.
- `github-secret.yaml` in `.gitignore`, PAT format reuse `validateGithubTokenFormat`, PAT never echoed → Task 3 (Steps 6, 5, 7).
- Two builders parallel to `buildTerminateEntry`, per-host SDS + gate, inline Lua, no new mounted file, `docker-compose.yml` unchanged, `buildTlsUpstreamCluster` reused → Task 4.
- Username-agnostic Basic gate (decode, password-half check, inline base64) with the 4 documented steps → Task 4 `GITHUB_BASIC_GATE_LUA`; api gate exact-match → `GITHUB_BEARER_GATE_LUA`.
- Injected real credential unaffected by gate choice (injector overwrites wholesale) → Task 4 injector `overwrite: true`; Task 5 asserts upstream sees the real Basic/Bearer.
- Allowlist wiring: new `#pragma github authenticated`, rename `terminate`→`claudeAuthenticated`, `githubAuthenticated` field, hosts moved into the section → Task 1 (model), Task 6 (production file).
- VM script 05 reorder (after 07 + host-only + reboot) → Task 6 Steps 3-4.
- Docs (`usage-windows-vm.md` reorder, `usage-hyper-v-host.md` caveat removal) → Task 6 Steps 3, 5.
- Testing: unit (secret formatter, envoy splicing) → Tasks 2, 4; integration (config accept + behavioral Basic/Bearer) → Task 5; manual → Task 7 Step 2.
- Superseded plan's `validateGithubTokenFormat` reused → Task 3 Step 5 (import, unchanged).

**2. Placeholder scan** — No `TBD`/"add error handling"/"similar to Task N"/"write tests for the above" left; every code step carries full code and every run step an exact command + expected result.

**3. Type consistency** — `Allowlist.claudeAuthenticated` / `.githubAuthenticated` used identically in `allowlist.ts`, `policyFile.ts`, `envoyConfig.ts`, tests. `formatGithubSecret(username, token)` signature identical in Tasks 2, 3, 5. `GITHUB_PLACEHOLDER_PAT` single definition (Task 2) imported by Tasks 3, 4, 5. SDS resource names `github_basic_auth` / `github_api_token` match between the formatter (Task 2) and the injector `credential.name` (Task 4). Secret path `/etc/envoy/secrets/github-secret.yaml` matches `EnvPaths.githubSecret` basename (`github-secret.yaml`). Cluster names `cluster_github_<sanitized>` consistent between builder and unit assertions.

**Note for the implementer:** Task 1's rename is the widest-reaching change; do it first and lean on `pnpm typecheck` (Step 4) to enumerate exactly which test literals still need the field — the compiler is the checklist.
