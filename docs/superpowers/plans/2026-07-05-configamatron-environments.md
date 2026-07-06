# Configamatron Per-Directory Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an environment a property of the working directory: `configamatron` commands operate on `<cwd>/.configamatron`, all working files live there, and `pnpm test` uses this repo's own gitignored `.configamatron` instead of clobbering deployment files.

**Architecture:** A shared `envPaths` module maps cwd → environment paths; a `templates/` tree in the repo (shipped in the npm package) mirrors the `.configamatron` layout and is copied by a new `init` command; `generate-ca` replaces the bash CA script with a Node implementation; existing commands switch their defaults to environment paths; docker compose runs from `.configamatron/proxy` with a fixed project name.

**Tech Stack:** TypeScript (ESM, Node >= 18), commander, execa, `selfsigned` (moves to runtime deps), node:crypto for cert validation, vitest, tsup, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-07-05-configamatron-environments-design.md`

## Global Constraints

- Placeholder values are exact and shared with the proxy's gate.lua: accessToken `sk-ant-oat-SANDBOX-PLACEHOLDER`, refreshToken `sandbox-placeholder-refresh-token`, expiresAt `4102444800000`.
- Generated files are written with LF line endings, never CRLF (`JSON.stringify`/template literals with `\n` only; never `os.EOL`).
- Commands resolve the environment from `process.cwd()` only — no parent-directory walking, no `--dir` flag.
- Every command except `init` and `import-sbx-network-policy` exits 1 with `no .configamatron in <cwd> — run 'configamatron init' first` when the folder is missing.
- `init` never overwrites: it exits 1 if `.configamatron` exists.
- Never silently overwrite key material: `generate-ca` reuses a valid existing pair and fails loudly on an invalid one.
- Compose project name is fixed (`name: configamatron`) so any `run-proxy`/test replaces the running proxy container (accepted single-proxy semantics).
- Package `files` ends as `["dist", "templates", "current-allow-list.txt"]`.
- Verification per task: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e` (that is `pnpm test` minus `test:integration`).
- **Known-red window:** the integration suite (`pnpm test:integration`) breaks at Task 7 (commands start requiring an environment) and is rewritten in Task 11. Do not run `test:integration` for Tasks 7–10; run it at Tasks 11 and 14.
- `legacy/` and `docs/superpowers/` are never modified (except adding this plan's checkmarks).
- Commit at the end of every task.

---

### Task 1: envPaths module

**Files:**
- Create: `src/envPaths.ts`
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `ENV_DIR_NAME = '.configamatron'`
  - `interface EnvPaths { root, vmShared, proxy, allowlist, envoyConfig, caDir, caCert, caKey, secretsDir, sdsSecret, vmCert, vmCredentials, githubConfig: string }`
  - `envPaths(cwd: string): EnvPaths`
  - `hasEnvironment(cwd: string): boolean`
  - `requireEnvPathsOrExit(commandName: string, cwd?: string): EnvPaths | null` — prints the standard error, sets `process.exitCode = 1`, returns null when missing.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/envPaths.test.ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_DIR_NAME, envPaths, hasEnvironment } from '../../src/envPaths';

describe('envPaths', () => {
  it('maps a cwd to the environment layout', () => {
    const paths = envPaths('/some/dir');
    const root = join('/some/dir', ENV_DIR_NAME);
    expect(paths.root).toBe(root);
    expect(paths.vmShared).toBe(join(root, 'vm-shared'));
    expect(paths.proxy).toBe(join(root, 'proxy'));
    expect(paths.allowlist).toBe(join(root, 'proxy', 'allowlist.txt'));
    expect(paths.envoyConfig).toBe(join(root, 'proxy', 'envoy.yaml'));
    expect(paths.caDir).toBe(join(root, 'proxy', 'ca'));
    expect(paths.caCert).toBe(join(root, 'proxy', 'ca', 'cert.pem'));
    expect(paths.caKey).toBe(join(root, 'proxy', 'ca', 'key.pem'));
    expect(paths.secretsDir).toBe(join(root, 'proxy', 'secrets'));
    expect(paths.sdsSecret).toBe(join(root, 'proxy', 'secrets', 'sds-secret.yaml'));
    expect(paths.vmCert).toBe(join(root, 'vm-shared', 'cert.pem'));
    expect(paths.vmCredentials).toBe(join(root, 'vm-shared', 'credentials.json'));
    expect(paths.githubConfig).toBe(join(root, 'vm-shared', 'github-config.txt'));
  });

  it('hasEnvironment reflects whether .configamatron exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'envpaths-'));
    try {
      expect(hasEnvironment(dir)).toBe(false);
      mkdirSync(join(dir, ENV_DIR_NAME));
      expect(hasEnvironment(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — cannot resolve `../../src/envPaths`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/envPaths.ts
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ENV_DIR_NAME = '.configamatron';

export interface EnvPaths {
  root: string;
  vmShared: string;
  proxy: string;
  allowlist: string;
  envoyConfig: string;
  caDir: string;
  caCert: string;
  caKey: string;
  secretsDir: string;
  sdsSecret: string;
  vmCert: string;
  vmCredentials: string;
  githubConfig: string;
}

export function envPaths(cwd: string): EnvPaths {
  const root = join(resolve(cwd), ENV_DIR_NAME);
  const vmShared = join(root, 'vm-shared');
  const proxy = join(root, 'proxy');
  return {
    root,
    vmShared,
    proxy,
    allowlist: join(proxy, 'allowlist.txt'),
    envoyConfig: join(proxy, 'envoy.yaml'),
    caDir: join(proxy, 'ca'),
    caCert: join(proxy, 'ca', 'cert.pem'),
    caKey: join(proxy, 'ca', 'key.pem'),
    secretsDir: join(proxy, 'secrets'),
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    vmCert: join(vmShared, 'cert.pem'),
    vmCredentials: join(vmShared, 'credentials.json'),
    githubConfig: join(vmShared, 'github-config.txt'),
  };
}

export function hasEnvironment(cwd: string): boolean {
  return existsSync(join(resolve(cwd), ENV_DIR_NAME));
}

/**
 * Resolve the environment for a command, or report the standard missing-environment
 * error. Commands must bail (`return`) when this returns null.
 */
export function requireEnvPathsOrExit(commandName: string, cwd = process.cwd()): EnvPaths | null {
  if (!hasEnvironment(cwd)) {
    console.error(`${commandName}: no ${ENV_DIR_NAME} in ${cwd} — run 'configamatron init' first`);
    process.exitCode = 1;
    return null;
  }
  return envPaths(cwd);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/envPaths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat: add envPaths module mapping cwd to .configamatron layout"
```

---

### Task 2: sanitizeCredentials module

**Files:**
- Create: `src/sanitizeCredentials.ts`
- Test: `tests/unit/sanitizeCredentials.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `PLACEHOLDER_ACCESS_TOKEN = 'sk-ant-oat-SANDBOX-PLACEHOLDER'`
  - `PLACEHOLDER_REFRESH_TOKEN = 'sandbox-placeholder-refresh-token'`
  - `PLACEHOLDER_EXPIRES_AT = 4102444800000`
  - `sanitizeCredentials(raw: string): string` — throws `Error` with a human message on invalid input; returns pretty-printed JSON ending in `\n`, LF only.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sanitizeCredentials.test.ts
import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_ACCESS_TOKEN,
  PLACEHOLDER_EXPIRES_AT,
  PLACEHOLDER_REFRESH_TOKEN,
  sanitizeCredentials,
} from '../../src/sanitizeCredentials';

const realCredentials = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-REAL-SECRET',
    refreshToken: 'real-refresh-secret',
    expiresAt: 1751234567890,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'pro',
    rateLimitTier: 'default_claude_ai',
  },
});

describe('sanitizeCredentials', () => {
  it('replaces tokens and expiry with placeholders, passing other fields through', () => {
    const output = sanitizeCredentials(realCredentials);
    const parsed = JSON.parse(output);
    expect(parsed.claudeAiOauth.accessToken).toBe(PLACEHOLDER_ACCESS_TOKEN);
    expect(parsed.claudeAiOauth.refreshToken).toBe(PLACEHOLDER_REFRESH_TOKEN);
    expect(parsed.claudeAiOauth.expiresAt).toBe(PLACEHOLDER_EXPIRES_AT);
    expect(parsed.claudeAiOauth.scopes).toEqual(['user:inference', 'user:profile']);
    expect(parsed.claudeAiOauth.subscriptionType).toBe('pro');
    expect(parsed.claudeAiOauth.rateLimitTier).toBe('default_claude_ai');
    expect(output).not.toContain('REAL-SECRET');
    expect(output).not.toContain('real-refresh-secret');
  });

  it('emits LF-only output ending with a newline', () => {
    const output = sanitizeCredentials(realCredentials);
    expect(output).not.toContain('\r');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => sanitizeCredentials('{nope')).toThrow('not valid JSON');
  });

  it('throws when claudeAiOauth is missing', () => {
    expect(() => sanitizeCredentials('{"other": true}')).toThrow('claudeAiOauth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sanitizeCredentials.test.ts`
Expected: FAIL — cannot resolve `../../src/sanitizeCredentials`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/sanitizeCredentials.ts

/**
 * Placeholder values written into the VM's credentials file. The accessToken value
 * must match exactly what the proxy's gate.lua swaps for the real token.
 */
export const PLACEHOLDER_ACCESS_TOKEN = 'sk-ant-oat-SANDBOX-PLACEHOLDER';
export const PLACEHOLDER_REFRESH_TOKEN = 'sandbox-placeholder-refresh-token';
export const PLACEHOLDER_EXPIRES_AT = 4102444800000;

/**
 * Turn a real host credentials file into the VM placeholder copy: tokens and expiry
 * become placeholders, every other field passes through so the file matches the
 * user's real account shape. Output is pretty-printed JSON, LF line endings only.
 */
export function sanitizeCredentials(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('credentials file is not valid JSON');
  }

  const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') {
    throw new Error('credentials file has no claudeAiOauth object');
  }

  const record = oauth as Record<string, unknown>;
  record.accessToken = PLACEHOLDER_ACCESS_TOKEN;
  record.refreshToken = PLACEHOLDER_REFRESH_TOKEN;
  record.expiresAt = PLACEHOLDER_EXPIRES_AT;

  return JSON.stringify(parsed, null, 2) + '\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/sanitizeCredentials.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sanitizeCredentials.ts tests/unit/sanitizeCredentials.test.ts
git commit -m "feat: add credential sanitization for the VM placeholder file"
```

---

### Task 3: CA generation module

**Files:**
- Modify: `package.json` (move `selfsigned` from devDependencies to dependencies)
- Create: `src/ca.ts`
- Test: `tests/unit/ca.test.ts`

**Interfaces:**
- Consumes: `selfsigned` (npm), `node:crypto`.
- Produces:
  - `CA_COMMON_NAME = 'sbx-sandbox-proxy-ca'`
  - `CA_SANS: string[]` — the six terminate hostnames.
  - `generateCaPems(): { certPem: string; keyPem: string }`
  - `validateCaPair(certPem: string, keyPem: string): boolean`

- [ ] **Step 1: Move `selfsigned` to runtime dependencies**

In `package.json`, remove `"selfsigned": "^2.4.1"` from `devDependencies` and add it to `dependencies` (keep the same version range). Then run:

Run: `pnpm install`
Expected: lockfile updates, exit 0.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/ca.test.ts
import { describe, it, expect } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { CA_COMMON_NAME, CA_SANS, generateCaPems, validateCaPair } from '../../src/ca';

describe('generateCaPems', () => {
  // Key generation is slow; generate once and share across assertions.
  const pair = generateCaPems();

  it('generates a self-signed cert with the sandbox CN and all terminate hostnames', () => {
    const cert = new X509Certificate(pair.certPem);
    expect(cert.subject).toContain(CA_COMMON_NAME);
    for (const san of CA_SANS) {
      expect(cert.subjectAltName).toContain(`DNS:${san}`);
    }
    expect(CA_SANS).toContain('api.anthropic.com');
    expect(CA_SANS).toContain('downloads.claude.ai');
  });

  it('generates a matching cert/key pair', () => {
    expect(validateCaPair(pair.certPem, pair.keyPem)).toBe(true);
  });
});

describe('validateCaPair', () => {
  it('rejects garbage and mismatched pairs', () => {
    const a = generateCaPems();
    const b = generateCaPems();
    expect(validateCaPair('garbage', a.keyPem)).toBe(false);
    expect(validateCaPair(a.certPem, 'garbage')).toBe(false);
    expect(validateCaPair(a.certPem, b.keyPem)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/ca.test.ts`
Expected: FAIL — cannot resolve `../../src/ca`.

- [ ] **Step 4: Write the implementation**

Same CN, SANs, key size, digest, and lifetime as the retired `scripts/generate-ca.sh` (`openssl req -x509 -newkey rsa:2048 -sha256 -days 3650`).

```typescript
// src/ca.ts
import { X509Certificate, createPrivateKey } from 'node:crypto';
import selfsigned from 'selfsigned';

export const CA_COMMON_NAME = 'sbx-sandbox-proxy-ca';

/** Hostnames the proxy terminates TLS for; the cert must cover all of them. */
export const CA_SANS = [
  'api.anthropic.com',
  'claude.com',
  'platform.claude.com',
  'statsig.anthropic.com',
  'mcp-proxy.anthropic.com',
  'downloads.claude.ai',
];

export function generateCaPems(): { certPem: string; keyPem: string } {
  const pems = selfsigned.generate([{ name: 'commonName', value: CA_COMMON_NAME }], {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      {
        name: 'subjectAltName',
        altNames: CA_SANS.map((value) => ({ type: 2, value })),
      },
    ],
  });
  return { certPem: pems.cert, keyPem: pems.private };
}

/** True when both PEMs parse and the private key matches the certificate. */
export function validateCaPair(certPem: string, keyPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/ca.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/ca.ts tests/unit/ca.test.ts
git commit -m "feat: add Node CA generation module (replaces generate-ca.sh logic)"
```

---

### Task 4: templates/ tree and template resolver

Copies (does **not** move — originals are deleted in Task 12 after the integration tests stop using them) the VM and proxy assets into a `templates/` tree that mirrors the `.configamatron` layout.

**Files:**
- Create: `templates/vm-shared/01-apt-packages.sh` … `templates/vm-shared/05-github-auth.sh` (copies of `vm/01-…05-…`, one edit in 05)
- Create: `templates/vm-shared/06-trust-ca.sh` (from `vm/vm-trust-ca.sh`, cert path now optional)
- Create: `templates/vm-shared/07-setup-persistence.sh` (from `vm/vm-setup-persistence.sh`, renamed in messages)
- Create: `templates/vm-shared/dnsmasq-stub.conf`, `templates/vm-shared/60-dns-override.yaml`, `templates/vm-shared/iptables-rules@.service` (verbatim copies from `vm/`)
- Create: `templates/proxy/gate.lua` (verbatim copy of `envoy/gate.lua`)
- Create: `templates/proxy/host-allow-vm-inbound.ps1` (verbatim copy of `scripts/host-allow-vm-inbound.ps1`)
- Create: `templates/proxy/docker-compose.yml` (new content below)
- Create: `.gitattributes`, `src/templates.ts`
- Modify: `.prettierignore` (add `templates/`)
- Test: `tests/unit/templates.test.ts`

**Interfaces:**
- Consumes: nothing at runtime; files at `templates/`.
- Produces:
  - `packageRoot(): string`
  - `templatesDir(): string`
  - `packagedAllowlist(): string` — absolute path of the shipped `current-allow-list.txt`.

- [ ] **Step 1: Copy the verbatim template files**

```bash
mkdir -p templates/vm-shared templates/proxy
cp vm/01-apt-packages.sh vm/02-install-pnpm.sh vm/03-install-tools.sh vm/04-configure-tools.sh vm/05-github-auth.sh templates/vm-shared/
cp vm/dnsmasq-stub.conf vm/60-dns-override.yaml "vm/iptables-rules@.service" templates/vm-shared/
cp vm/vm-trust-ca.sh templates/vm-shared/06-trust-ca.sh
cp vm/vm-setup-persistence.sh templates/vm-shared/07-setup-persistence.sh
cp envoy/gate.lua templates/proxy/
cp scripts/host-allow-vm-inbound.ps1 templates/proxy/
```

- [ ] **Step 2: Edit the copied scripts**

In `templates/vm-shared/05-github-auth.sh`, the not-found message no longer needs the "re-copy" instruction (vm-shared is a live shared folder). Replace the echo line:

```bash
  echo "05-github-auth: $config_path not found. Run 'configamatron write-github-config' on the host first." >&2
```

Replace the full contents of `templates/vm-shared/06-trust-ca.sh` (cert path argument becomes optional, defaulting to the cert beside the script):

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cert_path="${1:-${script_dir}/cert.pem}"

cp "$cert_path" /usr/local/share/ca-certificates/sbx-sandbox-proxy-ca.crt
update-ca-certificates

echo "06-trust-ca: installed and trusted $cert_path"
```

In `templates/vm-shared/07-setup-persistence.sh`, update the three self-references (usage string, error prefix, final echo prefix) from `vm-setup-persistence` to `07-setup-persistence`:

```bash
host_ip="${1:?usage: 07-setup-persistence.sh <host-ip>}"
```

```bash
  echo "07-setup-persistence: could not determine the VM's network interface." >&2
```

```bash
echo "07-setup-persistence: dnsmasq and iptables-rules@${host_ip}.service enabled and started; netplan DNS override applied"
```

(The rest of both scripts is byte-identical to the originals.)

- [ ] **Step 3: Write the compose template**

`templates/proxy/docker-compose.yml` — fixed project name; volume paths are relative to `proxy/` where all mounted files now sit:

```yaml
name: configamatron
services:
  envoy:
    image: envoyproxy/envoy:v1.31-latest
    restart: always
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    ports:
      - '${ENVOY_HTTPS_PORT:-443}:443'
      - '${ENVOY_HTTP_PORT:-80}:80'
      - '${ENVOY_ADMIN_PORT:-9901}:9901'
    volumes:
      - ./envoy.yaml:/etc/envoy/envoy.yaml:ro
      - ./gate.lua:/etc/envoy/gate.lua:ro
      - ./ca:/etc/envoy/ca:ro
      - ./secrets:/etc/envoy/secrets:ro
    command: ['-c', '/etc/envoy/envoy.yaml', '--log-level', 'info']
```

- [ ] **Step 4: Protect the templates from line-ending and formatter churn**

Create `.gitattributes`:

```
templates/** text eol=lf
```

Append to `.prettierignore`:

```
templates/
```

- [ ] **Step 5: Write the failing resolver test**

```typescript
// tests/unit/templates.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagedAllowlist, templatesDir } from '../../src/templates';

const expectedTemplateFiles = [
  'vm-shared/01-apt-packages.sh',
  'vm-shared/02-install-pnpm.sh',
  'vm-shared/03-install-tools.sh',
  'vm-shared/04-configure-tools.sh',
  'vm-shared/05-github-auth.sh',
  'vm-shared/06-trust-ca.sh',
  'vm-shared/07-setup-persistence.sh',
  'vm-shared/dnsmasq-stub.conf',
  'vm-shared/60-dns-override.yaml',
  'vm-shared/iptables-rules@.service',
  'proxy/docker-compose.yml',
  'proxy/gate.lua',
  'proxy/host-allow-vm-inbound.ps1',
];

describe('templates', () => {
  it('ships every template file', () => {
    for (const file of expectedTemplateFiles) {
      expect(existsSync(join(templatesDir(), file)), file).toBe(true);
    }
  });

  it('ships the packaged allowlist', () => {
    expect(existsSync(packagedAllowlist())).toBe(true);
  });

  it('pins the compose project name so environments replace each other', () => {
    const compose = readFileSync(join(templatesDir(), 'proxy', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('name: configamatron');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: FAIL — cannot resolve `../../src/templates`.

- [ ] **Step 7: Write the resolver**

```typescript
// src/templates.ts
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Package root resolved relative to this module. Works both from src/ (vitest runs
 * the TypeScript directly) and from the bundled dist/cli.js (tsup), because each
 * sits exactly one directory below the package root.
 */
export function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

export function templatesDir(): string {
  return join(packageRoot(), 'templates');
}

export function packagedAllowlist(): string {
  return join(packageRoot(), 'current-allow-list.txt');
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/templates.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add templates .gitattributes .prettierignore src/templates.ts tests/unit/templates.test.ts
git commit -m "feat: add templates/ tree mirroring the .configamatron layout"
```

---

### Task 5: init command

**Files:**
- Create: `src/initEnv.ts`, `src/commands/init.ts`, `tests/fixtures/credentials.json`
- Modify: `src/cli.ts` (register the command)
- Test: `tests/unit/initEnv.test.ts`, `tests/e2e/init.test.ts`

**Interfaces:**
- Consumes: `envPaths`/`ENV_DIR_NAME` (Task 1), `sanitizeCredentials` (Task 2), `templatesDir()`/`packagedAllowlist()` (Task 4).
- Produces:
  - `interface InitOptions { cwd: string; credentialsPath: string; templatesDir: string; allowlistSource: string }`
  - `initEnvironment(options: InitOptions): void` — throws `Error` with a human message on any failure; validates everything before writing anything.
  - CLI command `init` with `--credentials <path>` (default `~/.claude/.credentials.json`).
  - Test fixture `tests/fixtures/credentials.json` (reused by Tasks 6–8 and 11).

- [ ] **Step 1: Create the credentials fixture**

```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat-test-fixture-token",
    "refreshToken": "test-fixture-refresh-token",
    "expiresAt": 1751234567890,
    "scopes": ["user:inference", "user:profile"],
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_ai"
  }
}
```

Save as `tests/fixtures/credentials.json`.

- [ ] **Step 2: Write the failing unit test**

```typescript
// tests/unit/initEnv.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEnvironment } from '../../src/initEnv';
import { templatesDir, packagedAllowlist } from '../../src/templates';
import { ENV_DIR_NAME } from '../../src/envPaths';

const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'init-env-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof initEnvironment>[0]> = {}) {
  return {
    cwd: dir,
    credentialsPath: credentialsFixture,
    templatesDir: templatesDir(),
    allowlistSource: packagedAllowlist(),
    ...overrides,
  };
}

describe('initEnvironment', () => {
  it('copies vm-shared and proxy templates, the allowlist, and sanitized credentials', () => {
    initEnvironment(options());

    const root = join(dir, ENV_DIR_NAME);
    for (const file of [
      'vm-shared/01-apt-packages.sh',
      'vm-shared/06-trust-ca.sh',
      'vm-shared/07-setup-persistence.sh',
      'vm-shared/iptables-rules@.service',
      'vm-shared/credentials.json',
      'proxy/docker-compose.yml',
      'proxy/gate.lua',
      'proxy/host-allow-vm-inbound.ps1',
      'proxy/allowlist.txt',
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }

    const credentials = readFileSync(join(root, 'vm-shared', 'credentials.json'), 'utf8');
    expect(credentials).not.toContain('\r');
    expect(credentials).not.toContain('sk-ant-oat-test-fixture-token');
    expect(JSON.parse(credentials).claudeAiOauth.accessToken).toBe(
      'sk-ant-oat-SANDBOX-PLACEHOLDER',
    );
  });

  it('refuses to run when .configamatron already exists', () => {
    initEnvironment(options());
    expect(() => initEnvironment(options())).toThrow('already exists');
  });

  it('fails without writing anything when the credentials file is missing', () => {
    expect(() => initEnvironment(options({ credentialsPath: join(dir, 'nope.json') }))).toThrow(
      'could not read credentials',
    );
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });

  it('fails without writing anything when the credentials file is unparseable', () => {
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{nope');
    expect(() => initEnvironment(options({ credentialsPath: badPath }))).toThrow(
      'invalid credentials file',
    );
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });
});
```

(The fs import at the top of the file is
`import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';` —
`writeFileSync` is used by the unparseable-credentials test.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/initEnv.test.ts`
Expected: FAIL — cannot resolve `../../src/initEnv`.

- [ ] **Step 4: Write the core implementation**

```typescript
// src/initEnv.ts
import { copyFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envPaths } from './envPaths';
import { sanitizeCredentials } from './sanitizeCredentials';

export interface InitOptions {
  cwd: string;
  credentialsPath: string;
  templatesDir: string;
  allowlistSource: string;
}

/**
 * Scaffold <cwd>/.configamatron. Validates all inputs before writing anything so a
 * failed init leaves no partial environment behind. Throws on any failure.
 */
export function initEnvironment(options: InitOptions): void {
  const paths = envPaths(options.cwd);
  if (existsSync(paths.root)) {
    throw new Error(
      `${paths.root} already exists — delete it to rebuild the environment from scratch`,
    );
  }

  let rawCredentials: string;
  try {
    rawCredentials = readFileSync(options.credentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read credentials at ${options.credentialsPath} — log in with the claude CLI first, or pass --credentials`,
    );
  }

  let sanitized: string;
  try {
    sanitized = sanitizeCredentials(rawCredentials);
  } catch (error) {
    throw new Error(
      `invalid credentials file at ${options.credentialsPath}: ${(error as Error).message}`,
    );
  }

  cpSync(join(options.templatesDir, 'vm-shared'), paths.vmShared, { recursive: true });
  cpSync(join(options.templatesDir, 'proxy'), paths.proxy, { recursive: true });
  copyFileSync(options.allowlistSource, paths.allowlist);
  writeFileSync(paths.vmCredentials, sanitized);
}
```

- [ ] **Step 5: Run unit test to verify it passes**

Run: `pnpm vitest run tests/unit/initEnv.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Write the command and register it**

```typescript
// src/commands/init.ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { ENV_DIR_NAME } from '../envPaths';
import { initEnvironment } from '../initEnv';
import { packagedAllowlist, templatesDir } from '../templates';

interface InitCommandOptions {
  credentials: string;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(`Scaffold ${ENV_DIR_NAME} in the current directory for a new environment`)
    .option(
      '--credentials <path>',
      'Claude credentials file to sanitize into the VM placeholder credential',
      join(homedir(), '.claude', '.credentials.json'),
    )
    .action((options: InitCommandOptions) => {
      try {
        initEnvironment({
          cwd: process.cwd(),
          credentialsPath: options.credentials,
          templatesDir: templatesDir(),
          allowlistSource: packagedAllowlist(),
        });
      } catch (error) {
        console.error(`init: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`init: created ${ENV_DIR_NAME}. Next steps:`);
      console.log('  1. configamatron generate-ca');
      console.log('  2. configamatron build-envoy-config');
      console.log('  3. configamatron write-github-config');
      console.log('  4. configamatron run-proxy');
      console.log(
        `  (Windows) admin PowerShell: powershell -File ${ENV_DIR_NAME}/proxy/host-allow-vm-inbound.ps1`,
      );
      console.log(`  Then share ${ENV_DIR_NAME}/vm-shared into the VM — see usage.md`);
    });
}
```

In `src/cli.ts`, add the import and registration (before `registerImportSbxNetworkPolicy` so `--help` lists setup commands in flow order):

```typescript
import { registerInit } from './commands/init';
```

```typescript
registerInit(program);
```

- [ ] **Step 7: Write the failing e2e test**

```typescript
// tests/e2e/init.test.ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

describe('configamatron init', () => {
  it('scaffolds .configamatron and prints next steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      const { exitCode, stdout } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture],
        { cwd: dir },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain('generate-ca');
      expect(existsSync(join(dir, '.configamatron', 'proxy', 'allowlist.txt'))).toBe(true);
      expect(existsSync(join(dir, '.configamatron', 'vm-shared', 'credentials.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when .configamatron already exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'init', '--credentials', credentialsFixture],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('already exists');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with a pointer at the claude CLI when credentials are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-init-'));
    try {
      const { exitCode, stderr } = await execa(
        'node',
        [cliPath, 'init', '--credentials', join(dir, 'missing.json')],
        { cwd: dir, reject: false },
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain('could not read credentials');
      expect(existsSync(join(dir, '.configamatron'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 8: Build, then run the e2e test**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/init.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green. If `format:check` complains about new files, run `pnpm format` and re-check.

- [ ] **Step 10: Commit**

```bash
git add src/initEnv.ts src/commands/init.ts src/cli.ts tests/unit/initEnv.test.ts tests/e2e/init.test.ts tests/fixtures/credentials.json
git commit -m "feat: add init command scaffolding .configamatron environments"
```

---

### Task 6: generate-ca command

**Files:**
- Create: `src/commands/generateCa.ts`
- Modify: `src/cli.ts` (register after `registerInit`)
- Test: `tests/e2e/generateCa.test.ts`

**Interfaces:**
- Consumes: `requireEnvPathsOrExit` (Task 1), `generateCaPems`/`validateCaPair` (Task 3).
- Produces: CLI command `generate-ca` writing `proxy/ca/{cert,key}.pem` and `vm-shared/cert.pem`.

- [ ] **Step 1: Write the failing e2e test**

```typescript
// tests/e2e/generateCa.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));

let dir: string;
const caCert = () => join(dir, '.configamatron', 'proxy', 'ca', 'cert.pem');
const caKey = () => join(dir, '.configamatron', 'proxy', 'ca', 'key.pem');
const vmCert = () => join(dir, '.configamatron', 'vm-shared', 'cert.pem');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'configamatron-ca-'));
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('configamatron generate-ca', () => {
  it('writes the CA pair and copies cert.pem into vm-shared', async () => {
    const { exitCode } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(existsSync(caKey())).toBe(true);
    expect(readFileSync(vmCert(), 'utf8')).toBe(readFileSync(caCert(), 'utf8'));

    const cert = new X509Certificate(readFileSync(caCert(), 'utf8'));
    expect(cert.subject).toContain('sbx-sandbox-proxy-ca');
    expect(cert.subjectAltName).toContain('DNS:api.anthropic.com');
    expect(cert.subjectAltName).toContain('DNS:downloads.claude.ai');
  });

  it('reuses an existing valid pair instead of regenerating', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    const before = readFileSync(caCert(), 'utf8');

    const { exitCode, stdout } = await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('reusing');
    expect(readFileSync(caCert(), 'utf8')).toBe(before);
  });

  it('fails loudly on an unparseable existing pair without overwriting it', async () => {
    await execa('node', [cliPath, 'generate-ca'], { cwd: dir });
    writeFileSync(caKey(), 'garbage');

    const { exitCode, stderr } = await execa('node', [cliPath, 'generate-ca'], {
      cwd: dir,
      reject: false,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('key.pem');
    expect(readFileSync(caKey(), 'utf8')).toBe('garbage');
  });

  it('exits 1 without an environment', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'configamatron-bare-'));
    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'generate-ca'], {
        cwd: bare,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron init' first");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/generateCa.test.ts`
Expected: FAIL — `generate-ca` is an unknown command.

- [ ] **Step 3: Write the command**

```typescript
// src/commands/generateCa.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { requireEnvPathsOrExit } from '../envPaths';
import { generateCaPems, validateCaPair } from '../ca';

export function registerGenerateCa(program: Command): void {
  program
    .command('generate-ca')
    .description(
      'Generate the proxy CA into .configamatron/proxy/ca and copy cert.pem into vm-shared. ' +
        'Reuses an existing valid pair.',
    )
    .action(() => {
      const paths = requireEnvPathsOrExit('generate-ca');
      if (!paths) return;

      const certExists = existsSync(paths.caCert);
      const keyExists = existsSync(paths.caKey);

      if (certExists !== keyExists) {
        console.error(
          `generate-ca: found only one of ${paths.caCert} / ${paths.caKey} — delete it and re-run`,
        );
        process.exitCode = 1;
        return;
      }

      if (certExists && keyExists) {
        const certPem = readFileSync(paths.caCert, 'utf8');
        const keyPem = readFileSync(paths.caKey, 'utf8');
        if (!validateCaPair(certPem, keyPem)) {
          console.error(
            `generate-ca: existing ${paths.caCert} / ${paths.caKey} are not a valid pair — ` +
              'delete them to regenerate (existing key material is never overwritten)',
          );
          process.exitCode = 1;
          return;
        }
        copyFileSync(paths.caCert, paths.vmCert);
        console.log(`generate-ca: reusing valid CA in ${paths.caDir}; copied cert.pem to vm-shared`);
        return;
      }

      const { certPem, keyPem } = generateCaPems();
      mkdirSync(paths.caDir, { recursive: true });
      writeFileSync(paths.caCert, certPem);
      writeFileSync(paths.caKey, keyPem);
      copyFileSync(paths.caCert, paths.vmCert);
      console.log(`generate-ca: wrote CA to ${paths.caDir}; copied cert.pem to vm-shared`);
    });
}
```

In `src/cli.ts`:

```typescript
import { registerGenerateCa } from './commands/generateCa';
```

```typescript
registerGenerateCa(program);
```

(placed right after `registerInit(program);`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/generateCa.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/generateCa.ts src/cli.ts tests/e2e/generateCa.test.ts
git commit -m "feat: add generate-ca command (Node replacement for generate-ca.sh)"
```

---

### Task 7: build-envoy-config uses environment defaults

From here through Task 10 the **integration suite is expected red** (it still exercises the old layout); it is rewritten in Task 11.

**Files:**
- Modify: `src/commands/buildEnvoyConfig.ts`
- Test: `tests/e2e/cli.test.ts` (the `build-envoy-config` test)

**Interfaces:**
- Consumes: `requireEnvPathsOrExit` (Task 1).
- Produces: `build-envoy-config [allowlistFile] [-o path]` — defaults resolve to `paths.allowlist` / `paths.envoyConfig`; requires an environment even when explicit paths are passed.

- [ ] **Step 1: Update the e2e test to run inside an initialized environment**

In `tests/e2e/cli.test.ts`, add the fixture path constant near the top:

```typescript
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
```

Replace the `generates envoy.yaml from allowlist.txt with build-envoy-config` test with:

```typescript
  it('generates envoy.yaml into the environment by default with build-envoy-config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    const fixturePath = fileURLToPath(new URL('../fixtures/sample-allowlist.txt', import.meta.url));

    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode } = await execa(
        'node',
        [cliPath, 'build-envoy-config', fixturePath, '--upstream-override', 'api.anthropic.com=127.0.0.1:9443'],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      const outputPath = join(dir, '.configamatron', 'proxy', 'envoy.yaml');
      const config = parse(readFileSync(outputPath, 'utf8')) as any;
      const cluster = config.static_resources.clusters.find(
        (c: any) => c.name === 'cluster_terminate_api_anthropic_com',
      );
      expect(
        cluster.load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address,
      ).toEqual({ address: '127.0.0.1', port_value: 9443 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('build-envoy-config exits 1 without an environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      const { exitCode, stderr } = await execa('node', [cliPath, 'build-envoy-config'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron init' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: FAIL — the two build-envoy-config tests (old behavior writes to the static default / doesn't require an environment).

- [ ] **Step 3: Update the command**

Replace the contents of `src/commands/buildEnvoyConfig.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { stringify } from 'yaml';
import { parseAllowlist } from '../allowlist';
import { generateEnvoyConfig, type UpstreamOverride } from '../envoyConfig';
import { requireEnvPathsOrExit } from '../envPaths';

function collectOverride(value: string, previous: UpstreamOverride[]): UpstreamOverride[] {
  const [sniHost, target] = value.split('=');
  return [...previous, { sniHost, target }];
}

export function registerBuildEnvoyConfig(program: Command): void {
  program
    .command('build-envoy-config')
    .description("Generate the environment's envoy.yaml from its allowlist")
    .argument('[allowlistFile]', 'allowlist path (default: .configamatron/proxy/allowlist.txt)')
    .option('-o, --output <path>', 'output path (default: .configamatron/proxy/envoy.yaml)')
    .option(
      '--upstream-override <sniHost=host:port>',
      'redirect a terminate cluster to a different upstream (test use only)',
      collectOverride,
      [] as UpstreamOverride[],
    )
    .action(
      (
        allowlistFile: string | undefined,
        options: { output?: string; upstreamOverride: UpstreamOverride[] },
      ) => {
        const paths = requireEnvPathsOrExit('build-envoy-config');
        if (!paths) return;

        const inputPath = allowlistFile ?? paths.allowlist;
        const outputPath = options.output ?? paths.envoyConfig;
        if (!existsSync(inputPath)) {
          console.error(
            `build-envoy-config: ${inputPath} not found — 'configamatron init' creates the default allowlist`,
          );
          process.exitCode = 1;
          return;
        }
        const content = readFileSync(inputPath, 'utf8');
        const allowlist = parseAllowlist(content);
        const config = generateEnvoyConfig(allowlist, { overrides: options.upstreamOverride });
        writeFileSync(outputPath, stringify(config));
        console.log(`build-envoy-config: wrote ${outputPath} from ${inputPath}`);
      },
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green. (Do not run `test:integration` — known red until Task 11.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/buildEnvoyConfig.ts tests/e2e/cli.test.ts
git commit -m "feat: build-envoy-config defaults to the environment's proxy files"
```

---

### Task 8: write-github-config writes into vm-shared

**Files:**
- Modify: `src/commands/writeGithubConfig.ts`
- Test: `tests/e2e/cli.test.ts` (the `write-github-config` describe block)

**Interfaces:**
- Consumes: `requireEnvPathsOrExit` (Task 1); the `credentialsFixture` constant Task 7 added near the top of `tests/e2e/cli.test.ts` (`fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url))`).
- Produces: `write-github-config` writing `paths.githubConfig` (`.configamatron/vm-shared/github-config.txt`).

- [ ] **Step 1: Update the e2e tests**

In the `write-github-config` describe block of `tests/e2e/cli.test.ts`, each of the three tests creates a temp dir; add an init call right after creating it (before invoking `write-github-config`) in **all three tests**:

```typescript
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
```

(This makes the two failure tests still meaningful: they now fail on token/git-identity validation, not on the missing environment.)

In the success test, update the expectations:

```typescript
      expect(stdout).toContain('github-config.txt for Test User <test@example.com>');
      expect(
        readFileSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt'), 'utf8'),
      ).toBe(
        [
          'GITHUB_USERNAME="Test User"',
          'GITHUB_EMAIL="test@example.com"',
          `GITHUB_TOKEN="${validToken}"`,
          '',
        ].join('\n'),
      );
```

In the invalid-token test, update the file-absence check:

```typescript
      expect(
        existsSync(join(dir, '.configamatron', 'vm-shared', 'github-config.txt')),
      ).toBe(false);
```

Also rename the success test to match reality: `it('writes vm-shared/github-config.txt from a valid token and host git identity', ...)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: FAIL — write-github-config still writes `vm/github-config.txt`.

- [ ] **Step 3: Update the command**

In `src/commands/writeGithubConfig.ts`:

- Delete the `const OUTPUT_PATH = 'vm/github-config.txt';` line.
- Add the import: `import { requireEnvPathsOrExit } from '../envPaths';`
- At the top of the action (before creating the readline interface), add:

```typescript
      const paths = requireEnvPathsOrExit('write-github-config');
      if (!paths) return;
```

- Replace the two `OUTPUT_PATH` usages at the bottom of the action:

```typescript
      mkdirSync(dirname(paths.githubConfig), { recursive: true });
      writeFileSync(paths.githubConfig, formatGithubConfig({ username, email, token }));

      console.log(`write-github-config: wrote ${paths.githubConfig} for ${username} <${email}>`);
```

- Update the command description string to: `'Prompt for a GitHub fine-grained PAT and write .configamatron/vm-shared/github-config.txt for the VM setup scripts'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/writeGithubConfig.ts tests/e2e/cli.test.ts
git commit -m "feat: write-github-config targets the environment's vm-shared folder"
```

---

### Task 9: run-proxy runs compose from the environment's proxy folder

**Files:**
- Modify: `src/runProxy/recreateContainer.ts`, `src/commands/runProxy.ts`, `src/runProxy/writeSecret.ts` (comment only)

**Interfaces:**
- Consumes: `requireEnvPathsOrExit` (Task 1).
- Produces: `recreateContainer(serviceName: string, composeDir: string): Promise<void>`. The `RunProxyDeps.recreateContainer` signature `(serviceName: string) => Promise<void>` is **unchanged** — the command layer binds `composeDir` when building deps, so `runProxyLoop` and its unit tests are untouched.

- [ ] **Step 1: Update recreateContainer**

Replace the function in `src/runProxy/recreateContainer.ts`:

```typescript
import { execa } from 'execa';

/**
 * Recreate the Envoy container so it re-reads the on-disk SDS secret.
 * `--force-recreate` is required: writing the secret does not change the compose
 * config, so a plain `up -d` would leave a running container untouched with its
 * stale in-memory token. Idempotent across absent/running/stopped/dead states.
 * Runs in `composeDir` (the environment's .configamatron/proxy folder, which holds
 * docker-compose.yml); inherits process.env so ENVOY_* port overrides flow through.
 */
export async function recreateContainer(serviceName: string, composeDir: string): Promise<void> {
  await execa('docker', ['compose', 'up', '-d', '--force-recreate', serviceName], {
    cwd: composeDir,
  });
}
```

- [ ] **Step 2: Update the run-proxy command**

In `src/commands/runProxy.ts`:

- Add the import: `import { requireEnvPathsOrExit } from '../envPaths';`
- Change the `--secret` option to have no static default:

```typescript
    .option('--secret <path>', 'SDS secret output path (default: .configamatron/proxy/secrets/sds-secret.yaml)')
```

- Change the `RunProxyOptions` interface field to `secret?: string;`
- Add the import: `import { existsSync } from 'node:fs';`
- At the top of the action, resolve the environment and defaults, preflight the files earlier commands produce (naming the producing command), and bind `composeDir` into the deps:

```typescript
    .action(async (options: RunProxyOptions) => {
      const paths = requireEnvPathsOrExit('run-proxy');
      if (!paths) return;
      if (!existsSync(paths.envoyConfig)) {
        console.error(
          `run-proxy: ${paths.envoyConfig} not found — run 'configamatron build-envoy-config' first`,
        );
        process.exitCode = 1;
        return;
      }
      if (!existsSync(paths.caCert)) {
        console.error(
          `run-proxy: ${paths.caCert} not found — run 'configamatron generate-ca' first`,
        );
        process.exitCode = 1;
        return;
      }
      const secretPath = options.secret ?? paths.sdsSecret;

      const deps: RunProxyDeps = {
        readCredentials,
        writeSecret,
        recreateContainer: (serviceName) => recreateContainer(serviceName, paths.proxy),
        nudgeRefresh,
        watch: watchCredentials,
        onSigint: (handler) => process.on('SIGINT', handler),
        log: (message) => console.log(message),
        error: (message) => console.error(message),
        now: () => Date.now(),
      };

      const exitCode = await runProxyLoop(
        {
          credentialsPath: options.credentials,
          secretPath,
          serviceName: options.service,
          refreshWindowMs: Number(options.refreshWindow) * 60_000,
          retryIntervalMs: Number(options.retryInterval) * 60_000,
          maxAttempts: Number(options.maxAttempts),
          refreshEnabled: options.refresh,
        },
        deps,
      );

      process.exitCode = exitCode;
    });
```

- [ ] **Step 3: Fix the stale comment in writeSecret.ts**

In `src/runProxy/writeSecret.ts`, replace the doc comment's first line:

```typescript
/**
 * Render the Envoy file-based SDS secret consumed from
 * .configamatron/proxy/secrets/sds-secret.yaml.
 */
```

- [ ] **Step 4: Add an e2e test for the preflight errors**

Append to the first describe block in `tests/e2e/cli.test.ts` (uses the `credentialsFixture` constant added in Task 7; `run-proxy` exits before touching docker, so no docker needed):

```typescript
  it('run-proxy names the missing prerequisite command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'configamatron-'));
    try {
      await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: dir });
      const { exitCode, stderr } = await execa('node', [cliPath, 'run-proxy'], {
        cwd: dir,
        reject: false,
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("run 'configamatron build-envoy-config' first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 5: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green (`runProxyLoop` unit tests unaffected; e2e `run-proxy --help` still lists `--credentials`, `--no-refresh`, `--service`; the new preflight test passes).

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/recreateContainer.ts src/commands/runProxy.ts src/runProxy/writeSecret.ts tests/e2e/cli.test.ts
git commit -m "feat: run-proxy operates on the environment's proxy folder"
```

---

### Task 10: import-sbx-network-policy becomes the allow-list maintenance command

**Files:**
- Modify: `src/commands/importSbxNetworkPolicy.ts`
- Test: `tests/e2e/cli.test.ts` (the import test)

**Interfaces:**
- Consumes: nothing new. Deliberately does **not** require an environment (maintainer command run in this repo).
- Produces: default output `current-allow-list.txt` (cwd-relative).

- [ ] **Step 1: Update the e2e test**

In `tests/e2e/cli.test.ts`, in the `parses a policy file into allowlist.txt with import-sbx-network-policy` test: rename it to `parses a policy file into current-allow-list.txt with import-sbx-network-policy`, and exercise the default output instead of `-o`:

```typescript
      const { exitCode } = await execa(
        'node',
        [cliPath, 'import-sbx-network-policy', fixturePath],
        { cwd: dir },
      );

      expect(exitCode).toBe(0);
      expect(readFileSync(join(dir, 'current-allow-list.txt'), 'utf8')).toBe(
```

(keep the same expected file body; drop the `outputPath` constant).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: FAIL — default output is still `allowlist.txt`.

- [ ] **Step 3: Update the command**

In `src/commands/importSbxNetworkPolicy.ts`:

```typescript
    .command('import-sbx-network-policy')
    .description(
      'Maintainer command: parse a network policy file into current-allow-list.txt ' +
        '(the tracked default allow list copied into environments by init)',
    )
    .argument('<policyFile>', 'path to the source policy file')
    .option('-o, --output <path>', 'output allow list path', 'current-allow-list.txt')
```

(The action body is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm build && pnpm vitest run --config vitest.e2e.config.ts tests/e2e/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the task-level verification**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/commands/importSbxNetworkPolicy.ts tests/e2e/cli.test.ts
git commit -m "feat: import-sbx-network-policy defaults to current-allow-list.txt"
```

---

### Task 11: rewrite the integration tests against the environment layout

**Files:**
- Modify: `tests/integration/proxy.test.ts`, `tests/integration/runProxy.test.ts`
- Delete: `tests/integration/generateCa.test.ts` (superseded by `tests/e2e/generateCa.test.ts`), `tests/integration/gitBash.ts`

**Interfaces:**
- Consumes: CLI commands `init`, `generate-ca`, `build-envoy-config`, `run-proxy` (Tasks 5–9); fixture `tests/fixtures/credentials.json` (Task 5).
- Produces: an integration suite that builds this repo's own gitignored `.configamatron` and runs compose from `.configamatron/proxy`.

- [ ] **Step 1: Delete the superseded files**

```bash
git rm tests/integration/generateCa.test.ts tests/integration/gitBash.ts
```

- [ ] **Step 2: Rewrite proxy.test.ts setup**

In `tests/integration/proxy.test.ts`:

- Remove the `gitBash` import; add `join`:

```typescript
import { join } from 'node:path';
```

- Replace the path constants block:

```typescript
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const allowlistFixture = fileURLToPath(new URL('./fixtures/allowlist.txt', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');
```

- Replace `beforeAll` (ports, `waitForAdminReady`, and everything from `describe(...)` down stay as they are):

```typescript
beforeAll(async () => {
  mockUpstream = await startMockUpstream();

  // Fresh environment per run: environments are rebuilt from scratch, never migrated.
  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
  caCertPem = readFileSync(join(proxyDir, 'ca', 'cert.pem'), 'utf8');

  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );

  mkdirSync(join(proxyDir, 'secrets'), { recursive: true });
  writeFileSync(
    join(proxyDir, 'secrets', 'sds-secret.yaml'),
    [
      'resources:',
      '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
      '    name: sandbox_bearer_token',
      '    generic_secret:',
      '      secret:',
      `        inline_string: "${REAL_AUTH}"`,
      '',
    ].join('\n'),
  );

  await execa('docker', ['compose', 'up', '-d'], {
    cwd: proxyDir,
    env: {
      ...process.env,
      ENVOY_HTTPS_PORT: String(HTTPS_PORT),
      ENVOY_HTTP_PORT: String(HTTP_PORT),
      ENVOY_ADMIN_PORT: String(ADMIN_PORT),
    },
  });

  await waitForAdminReady(30000);
}, 90000);
```

- Update the fs import to include `rmSync`:

```typescript
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
```

- In `afterAll`, change the compose cwd:

```typescript
  await execa('docker', ['compose', 'down'], { cwd: proxyDir });
```

- [ ] **Step 3: Rewrite runProxy.test.ts setup**

In `tests/integration/runProxy.test.ts`:

- Remove the `gitBash` import.
- Add below the existing constants:

```typescript
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');
```

- Replace `beforeAll`:

```typescript
beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'run-proxy-int-'));
  credentialsPath = join(tempDir, '.credentials.json');
  writeCredentials('token-initial');

  rmSync(envRoot, { recursive: true, force: true });
  await execa('node', [cliPath, 'init', '--credentials', credentialsFixture], { cwd: repoRoot });
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });
  await execa(
    'node',
    [
      cliPath,
      'build-envoy-config',
      allowlistFixture,
      '--upstream-override',
      `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
    ],
    { cwd: repoRoot },
  );

  // Start run-proxy in the background with refresh disabled (no real auth/network).
  // No --secret flag: exercises the environment default secret path.
  proxyProc = execa(
    'node',
    [cliPath, 'run-proxy', '--no-refresh', '--credentials', credentialsPath],
    { cwd: repoRoot, env: { ...process.env, ...envoyEnv }, reject: false },
  );

  // run-proxy performs the startup writeSecret + force-recreate; wait for admin readiness.
  await waitFor(
    () => adminConfigDump(),
    (dump) => secretLastUpdated(dump) !== null,
    60000,
  );
}, 120000);
```

- In `afterAll`, change the compose cwd:

```typescript
  await execa('docker', ['compose', 'down'], {
    cwd: proxyDir,
    env: { ...process.env, ...envoyEnv },
  });
```

- In the test body, update the secret-path assertion:

```typescript
    expect(readFileSync(join(proxyDir, 'secrets', 'sds-secret.yaml'), 'utf8')).toContain(
      'Bearer token-rotated',
    );
```

- [ ] **Step 4: Run the integration suite**

Docker must be running. This replaces any live proxy container (accepted semantics).

Run: `pnpm build && pnpm test:integration`
Expected: PASS — both files, run serially.

- [ ] **Step 5: Verify no working files landed outside .configamatron**

Run: `git status --porcelain`
Expected: only the intentionally modified/deleted files from this task; **no** entries under `envoy/`, no root `allowlist.txt`, no `vm/` changes. (`.configamatron/` is gitignored as of Task 12; if it shows as untracked here, that is expected until Task 12 updates `.gitignore`.)

- [ ] **Step 6: Run the task-level verification and commit**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

```bash
git add tests/integration
git commit -m "test: integration suite builds and uses the repo's own .configamatron"
```

---

### Task 12: delete the old layout

**Files:**
- Delete (tracked): `vm/` (all tracked files), `envoy/gate.lua`, `docker-compose.yml`, `scripts/generate-ca.sh`, `scripts/host-allow-vm-inbound.ps1`, `balanced.policy.txt`
- Delete (untracked working files): `envoy/` leftovers (`envoy.yaml`, `ca/`, `secrets/`), `allowlist.txt`, `vm/` leftovers (`cert.pem`, `github-config.txt`, `.credentials.json`)
- Modify: `.gitignore`, `package.json` (`files`)

**Interfaces:**
- Consumes: everything moved to `templates/` in Task 4 and the rewritten tests of Task 11.
- Produces: a repo tree with no runtime-written files outside `.configamatron/`.

- [ ] **Step 1: Confirm nothing references the old paths**

Run: `grep -rn "envoy/" src tests --include="*.ts" ; grep -rn "vm/" src tests --include="*.ts" ; grep -rn "balanced" src tests README.md --include="*"`
Expected: no matches in source or tests (documentation matches are handled in Task 13). Investigate and fix any hit before deleting.

- [ ] **Step 2: Remove the tracked files**

```bash
git rm -r vm envoy docker-compose.yml scripts balanced.policy.txt
```

(`scripts/` contains only `generate-ca.sh` and `host-allow-vm-inbound.ps1`, both superseded. `git rm -r envoy` removes only tracked files — `gate.lua`.)

- [ ] **Step 3: Remove the untracked working files**

```bash
rm -rf envoy vm allowlist.txt
```

- [ ] **Step 4: Rewrite .gitignore**

Replace the full contents of `.gitignore`:

```
node_modules/
dist/
test-results/
.configamatron/
```

- [ ] **Step 5: Ship templates and the allow list in the package**

In `package.json`, change:

```json
  "files": [
    "dist",
    "templates",
    "current-allow-list.txt"
  ],
```

- [ ] **Step 6: Verify and commit**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

Run: `git status --porcelain`
Expected: only staged deletions plus `.gitignore`/`package.json` modifications; `.configamatron/` no longer listed.

```bash
git add .gitignore package.json
git commit -m "chore: remove pre-environment layout (vm/, envoy/, compose, scripts)"
```

---

### Task 13: consolidated documentation

**Files:**
- Create: `usage.md`, `technical-notes.md`
- Delete: `envoy-proxy.md`, `vm-setup.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: final command behavior from Tasks 5–10.
- Produces: `usage.md` (host prerequisites → proxy setup → VM setup) and `technical-notes.md` (maintainer/technical spill-over).

- [ ] **Step 1: Write usage.md**

```markdown
# configamatron usage

configamatron sets up isolated environments for coding agents. An Ubuntu VM is
isolated behind an Envoy proxy running in Docker on the host; the proxy restricts
network access to an allow list and injects real credentials so the VM never holds
them. Each environment lives in a `.configamatron` folder inside a working directory
you choose. Every file the proxy or VM uses lives there, so environments never
clobber each other's settings.

Only one proxy container can exist on the host (it binds ports 80/443). Starting any
environment's proxy — or running this repo's test suite — replaces whichever proxy
container was running. Run one environment at a time; re-run `configamatron
run-proxy` in an environment's directory to restore its proxy.

## Host prerequisites

- Docker and Docker Compose.
- Node.js >= 18 and pnpm.
- The `claude` CLI installed and logged in (so `~/.claude/.credentials.json` exists).
- VMware Workstation, for the VM.
- configamatron installed globally from a checkout of this repository:

  ```
  pnpm install
  pnpm build
  pnpm install -g .
  ```

## Proxy setup

Usually done once per environment. Run every command from the environment directory
(the folder that owns the environment, e.g. `e:\repo`):

1. `configamatron init` — creates `.configamatron/` containing `vm-shared/`
   (everything the VM consumes) and `proxy/` (everything the proxy consumes), copies
   the packaged allow list to `proxy/allowlist.txt`, and writes
   `vm-shared/credentials.json` — a copy of your host Claude credential with the
   tokens replaced by sandbox placeholders. Refuses to run if `.configamatron`
   already exists; delete the folder to rebuild from scratch.
2. `configamatron generate-ca` — writes `proxy/ca/cert.pem` + `key.pem` and copies
   the cert to `vm-shared/cert.pem`. An existing valid pair is reused, so restoring
   a previously generated CA into `proxy/ca/` before this step preserves it.
3. `configamatron build-envoy-config` — builds `proxy/envoy.yaml` from
   `proxy/allowlist.txt`. Edit this environment's allow list and re-run to change
   what the VM may reach.
4. `configamatron write-github-config` — prompts for a GitHub fine-grained personal
   access token and writes `vm-shared/github-config.txt` (username/email come from
   your global git config). Create the token at
   https://github.com/settings/personal-access-tokens/new, scoped to the
   repositories the agent should use, with read/write access to Contents.
5. `configamatron run-proxy` — writes the SDS secret from your current Claude
   credential, (re)creates the Envoy container so it serves that token, then stays
   in the foreground: it watches `~/.claude/.credentials.json`, recreates the
   container whenever the token changes, and nudges the `claude` CLI to refresh the
   token shortly before it expires. Leave it running (like `docker compose up`
   without `-d`); Ctrl-C stops it and leaves the container running.
   - Must run on the host with the `claude` CLI installed and logged in (it is the
     sole authority over `credentials.json`).
   - Pass `--no-refresh` to only watch and propagate without nudging the CLI.
     `configamatron run-proxy --help` lists all flags.
6. **Windows hosts only:** in an **Administrator** PowerShell, run
   `powershell -File .configamatron\proxy\host-allow-vm-inbound.ps1`. Windows
   Firewall blocks inbound connections by default, which silently breaks the VM's
   DNAT'd traffic to Envoy even though everything else is configured correctly.
   This opens inbound TCP 80/443 (Envoy) from the VM's host-only network adapter,
   and prints the host IP to use in VM-side setup. It defaults to the
   `VMware Network Adapter VMnet1` interface; pass `-AdapterAlias` if your host-only
   network uses a different adapter (`Get-NetIPConfiguration` lists them). Safe to
   re-run if the host's IP on that network changes.
   - Mac/Linux hosts: not yet scripted — allow inbound tcp/80 and tcp/443 from the
     VM through your host firewall equivalent (`pfctl`/`ufw`) and determine the
     host-only interface's IP yourself.

## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its
shared folder.

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image
    (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space.
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no
    more than half of the host machine's memory), 1 processor with 6 cores (ask
    google for values for your specific processor). Leave the network as NAT for
    initial setup, pre-isolation.
- Start the VM and install the OS. Pick the defaults, except:
  - Uncheck "Require my password to log in" — anyone with access to the VM already
    has access to the host, and it is easier this way. Your password is still
    required for sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware"; it may
    stall OS installation.
  - Do not enable Shared Folders before the OS is installed; it may stall OS
    installation.

### Enable open-vm-tools and share the environment folder

Run in the VM's terminal ('-desktop' helps with screen resolution on top of
open-vm-tools' shared folders and copy'n'paste integration):

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Shut the VM down, then in VM -> Settings -> Options:

- "Shared Folders": enable only the environment's `.configamatron\vm-shared` folder,
  read-only.
- "Guest Isolation": consider disabling drag'n'drop and copy'n'paste sharing.

Start the VM and verify the share appears under `/mnt/hgfs/`. If it doesn't, stop
and restart folder sharing. If `/mnt/hgfs` stays empty, add this line to
`/etc/fstab` and reboot:

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

### Run the numbered scripts

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`,
`github-config.txt`, and `credentials.json`.

Run the scripts from the shared folder in number order. Run them without `sudo`
except where noted — each script uses `sudo` internally where it needs root. Open a
**new terminal** where noted so the shell picks up PATH changes written to
`~/.bashrc`:

1. `01-apt-packages.sh`
2. `02-install-pnpm.sh`
3. Open a new terminal, then `03-install-tools.sh`
4. Open a new terminal, then `04-configure-tools.sh` — a browser opens for context7
   login; close it and cancel the script if you don't want to use credentials.
5. `05-github-auth.sh`
6. `sudo <path>/06-trust-ca.sh` — trusts the proxy CA. Defaults to the `cert.pem`
   sitting next to the script.
7. `sudo <path>/07-setup-persistence.sh <host-ip>` — `<host-ip>` is printed by proxy
   setup step 6. Installs and starts dnsmasq (local DNS stub) and the
   `iptables-rules@<host-ip>.service` DNAT rules, and points the VM's resolver at
   the local stub via a netplan override. Both units start automatically on every
   future VM boot.
8. Put the placeholder credential where the Claude Code CLI expects it:

   ```
   mkdir -p ~/.claude && cp /mnt/hgfs/vm-shared/credentials.json ~/.claude/.credentials.json
   ```

### Isolate and verify

- Switch the VM's network from NAT to host-only, then **reboot the VM** so the
  boot-time rules unit installs the host-only default route (host-only mode has no
  DHCP gateway). `sudo systemctl restart iptables-rules@<host-ip>.service` is an
  alternative to a reboot.
- Verify from inside the VM:
  - `curl` to an allow-listed domain succeeds; a non-allow-listed domain
    fails/resets.
  - The coding agent works against `api.anthropic.com` using only the placeholder
    credential.
  - `apt-get update` succeeds (validates port 80 handling).
```

- [ ] **Step 2: Write technical-notes.md**

```markdown
# Technical notes

Maintainer and background material. Day-to-day setup lives in [usage.md](usage.md).

## Maintaining the allow list

`current-allow-list.txt` (repo root, source controlled) is the default allow list
that `configamatron init` copies into every new environment. To refresh it from an
upstream network policy file:

```
configamatron import-sbx-network-policy <policy-file>
```

It writes `current-allow-list.txt` in the current directory by default (`-o` to
override). Run it in a checkout of this repository and commit the result. It is a
maintenance command — not part of environment setup — and it never touches an
environment's own `proxy/allowlist.txt` (edit that file directly for
per-environment changes and re-run `configamatron build-envoy-config`).

## Environment model

- The working directory owns the environment: every command (except `init` and
  `import-sbx-network-policy`) operates on `<cwd>/.configamatron` and exits 1 if it
  is missing. There is no parent-directory search.
- There is no upgrade path for `.configamatron` folders. Rebuild from scratch:
  delete the folder and re-run the setup commands. Previously generated CA material
  can be restored into `proxy/ca/` before running `generate-ca` — a valid pair is
  reused, an invalid one fails loudly (key material is never overwritten).
- The compose project name is pinned (`name: configamatron` in
  `proxy/docker-compose.yml`), so `docker compose up` for any environment replaces
  the running proxy container instead of colliding with it on ports 80/443. Running
  the test suite does the same. This is deliberate: one proxy at a time, and
  switching environments (or recovering after tests) is just re-running
  `configamatron run-proxy` in the environment directory.
- The VM placeholder credential (`vm-shared/credentials.json`) is derived from the
  host's real `~/.claude/.credentials.json` at init time: `accessToken` becomes
  `sk-ant-oat-SANDBOX-PLACEHOLDER` (the exact value the proxy's gate.lua swaps for
  the real token), `refreshToken` becomes `sandbox-placeholder-refresh-token`,
  `expiresAt` is set far in the future, and every other field passes through so the
  file matches the account's real shape. The file is written with LF line endings.

## How the proxy works

Envoy runs in Docker on the host and is the VM's only network path. Allow-listed
hosts are either passed through by SNI (TLS) / Host header (port 80), or
TLS-terminated for credential injection: requests presenting the placeholder
Authorization header get the real bearer token injected from a file-based SDS
secret; anything else is rejected before reaching the upstream. `run-proxy` owns
the secret lifecycle: it writes the SDS secret from the host credential and
force-recreates the container whenever the token rotates.

Design history (reference only, not updated):

- `docs/superpowers/specs/2026-07-01-envoy-sandbox-proxy-design.md`
- `docs/superpowers/specs/2026-07-05-run-proxy-credential-monitor-design.md`
- `docs/superpowers/specs/2026-07-05-configamatron-environments-design.md`

## VM networking details

`07-setup-persistence.sh` installs two persistent units:

- **dnsmasq** answers the VM's DNS queries locally so name resolution works without
  outbound DNS; a netplan override pins the VM's resolver to the local stub. See
  `docs/superpowers/specs/2026-07-04-vm-dns-stub-dnsmasq-design.md` and
  `docs/superpowers/specs/2026-07-04-vm-dns-netplan-merge-and-iptables-path-design.md`.
- **iptables-rules@\<host-ip\>.service** DNATs the VM's outbound 80/443 traffic to
  Envoy on the host and installs a guarded host-only default route at boot
  (host-only networking hands out no DHCP gateway). See
  `docs/superpowers/specs/2026-07-05-vm-host-only-default-route-design.md`. A live
  NAT→host-only switch does not re-run the unit: reboot, or
  `sudo systemctl restart iptables-rules@<host-ip>.service`.

## Testing

`pnpm test` runs, in fail-fast order: format check, lint, typecheck, unit tests,
build, e2e tests (against `dist/cli.js`), and integration tests. The integration
tests build this repository's own gitignored `.configamatron` (using
`tests/fixtures/credentials.json`, never your real credential file) and bring the
Envoy stack up against a mock upstream on transient ports. Docker must be running;
no VM or real credential is required. The suite replaces any running proxy
container, but never touches another environment's files.
```

- [ ] **Step 3: Delete the superseded docs and update README**

```bash
git rm envoy-proxy.md vm-setup.md
```

In `README.md`, replace the two "See ..." lines:

```markdown
See [usage.md](usage.md) for setting up environments (proxy + VM).
See [technical-notes.md](technical-notes.md) for maintainer notes.
```

- [ ] **Step 4: Check for dangling references**

Run: `grep -rn "envoy-proxy.md\|vm-setup.md" README.md usage.md technical-notes.md src tests templates`
Expected: no matches.

- [ ] **Step 5: Format, verify, commit**

Run: `pnpm format`
Then: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test:unit && pnpm build && pnpm test:e2e`
Expected: all green.

```bash
git add usage.md technical-notes.md README.md
git commit -m "docs: consolidate setup guides into usage.md + technical-notes.md"
```

---

### Task 14: full-pipeline verification

**Files:** none (verification only; fix-forward if anything fails).

- [ ] **Step 1: Run the complete pipeline**

Docker must be running. This replaces any live proxy container.

Run: `pnpm test`
Expected: every stage green, including `test:integration`.

- [ ] **Step 2: Verify the success criterion — no working files outside .configamatron**

Run: `git status --porcelain`
Expected: **empty output.** Anything listed means a runtime path still writes outside `.configamatron/` — find and fix it before finishing.

- [ ] **Step 3: Global-install smoke test**

```bash
pnpm install -g .
```

Then in a scratch directory (e.g. under the system temp dir), with a copy of `tests/fixtures/credentials.json` at `<scratch>/creds.json`:

```bash
cd <scratch>
configamatron init --credentials creds.json
configamatron generate-ca
configamatron build-envoy-config
```

Expected: all exit 0; `<scratch>/.configamatron/proxy/envoy.yaml` exists. This proves the installed package ships and resolves `templates/` and `current-allow-list.txt`. Clean up the scratch directory afterwards.

- [ ] **Step 4: Commit any stragglers and finish**

```bash
git status
```

If clean, the plan is complete. Use superpowers:finishing-a-development-branch to wrap up.
