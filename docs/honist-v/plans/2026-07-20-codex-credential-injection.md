# Codex Credential Injection Implementation Plan

**Goal:** Inject real Codex (ChatGPT-plan) credentials into the sandboxed VM's traffic at the Envoy proxy — mirroring the existing Claude/GitHub injection — so `chatgpt.com` calls from the VM carry the real Bearer token while the secret never crosses into the VM or its share.

**Architecture:** Generalize `runProxyLoop`'s single hardwired credential source into a reusable `CredentialChannel` (its own file-watch → secret-write → blue-green restart → nudge/backoff state machine), then instantiate one channel for Claude and one for Codex. Provision a placeholder `~/.codex/auth.json` into the VM share (the access token must be a syntactically valid far-future JWT so the VM's own Codex never tries to refresh). Add a `chatgpt.com:443` TLS-terminating Envoy filter chain with an inline Lua gate, a `codex_bearer_token` credential injector, and `upgrade_configs` for the WebSocket transport.

**Tech Stack:** TypeScript (ES modules), commander, execa, node-forge, `yaml`, vitest 4, Envoy 1.31 (docker compose blue/green), Node 25 built-ins only for new logic.

## Global Constraints

- **Scope: one host, exact match** — `chatgpt.com:443` only. Other `*.chatgpt.com` subdomains stay passthrough (they carry no credentialed traffic).
- **Auth mode: `chatgpt` only** — API-key mode (`api.openai.com`) is explicitly out of scope.
- **Single Bearer scheme** — gate matches `Authorization: Bearer <placeholder>` exactly; injector overwrites `Authorization` with `Bearer <real token>`. Same shape as Claude.
- **Placeholder access/id tokens must be valid JWTs** with `exp` ≈ year 2100 = `4102444800` seconds (`4102444800000` ms). The far-future `exp` stops the VM's Codex from ever deciding it must refresh.
- **Pass through unchanged** from the real file: `tokens.account_id`, `auth_mode`, `OPENAI_API_KEY`. These are not secrets; keeping them real preserves account-scoped UX.
- **Never touch `Cookie`** (Cloudflare `__cf_bm`) in either direction — default gate/injector behavior already leaves it alone; do not add handling that reads or rewrites it.
- **No header values in the permanent access log** — the `term`-tagged access log format logs no request header values (only the auth-candidate diagnostic truncates to 12 chars). Do not add header logging to the codex chain.
- **`upgrade_configs` on the codex chain only** — Claude/GitHub chains untouched.
- **Sanitized file output**: pretty-printed JSON (2-space), LF line endings only, trailing newline.
- **Codex is a required input, exactly like Claude.** `init` throws if it cannot read the Codex auth file (same shape as the Claude credentials error); `run-proxy` always runs both channels and fatals on a missing/unreadable Codex file at startup (same as Claude). Making *both* Claude and Codex optional-with-parity is intentionally **deferred to a separate work item** — this plan keeps them both mandatory. Consequence: every existing test/site that runs `init` or `run-proxy` must now supply a Codex fixture file (Tasks 12 and 15 update them).

---

## File Map

New source files:

- `src/jwt.ts` — base64url encode/decode, `jwtExpMs`, `buildJwt` (unsigned placeholder JWTs).
- `src/codexPlaceholder.ts` — the fixed placeholder JWT constants + refresh placeholder (analogue of `githubPlaceholder.ts`).
- `src/sanitizeCodexCredentials.ts` — real `auth.json` → VM placeholder copy (analogue of `sanitizeCredentials.ts`).
- `src/runProxy/readCodexCredentials.ts` — parse `auth.json`, derive expiry from the JWT (analogue of `readCredentials.ts`).
- `src/runProxy/nudgeCodexRefresh.ts` — `codex exec` host nudge (analogue of `nudgeRefresh.ts`).
- `src/runProxy/credentialChannel.ts` — the extracted, per-source watch→write→restart→nudge state machine.
- `templates/vm-shared/09-codex-config.sh`, `templates/vm-shared-windows/09-codex-config.ps1` — link/copy the placeholder `auth.json` into `~/.codex/`.

Modified source files:

- `src/runProxy/writeSecret.ts` — `formatSecret`/`writeSecret` take an SDS resource name.
- `src/runProxy/runProxyLoop.ts` — drives an array of `CredentialChannel`s instead of one hardwired source.
- `src/commands/runProxy.ts` — builds the Claude + Codex channel configs; new `--codex-credentials`/`--codex-secret` flags.
- `src/commands/init.ts` + `src/initEnv.ts` — new `--codex-credentials`; write sanitized `auth.json` into both VM-shared targets.
- `src/envPaths.ts` — `authJson` on `VmSharedPaths`; `codexSecret` on `EnvPaths`.
- `src/allowlist.ts` — `codexAuthenticated` section (`#pragma codex authenticated`).
- `src/envoyConfig.ts` — `buildCodexEntry` (inline Lua gate + injector + `upgrade_configs`).
- `.gitignore` — `codex-secret.yaml`.

New test fixture: `tests/fixtures/auth.json` (a real-shaped Codex auth file).

**Deliberately unchanged (spec-confirmed no-ops):**

- `templates/proxy/docker-compose.yml` — the codex gate is inline Lua and the codex secret lands in the already-mounted `./secrets` dir, so no new volume/mount.
- `templates/vm-shared*/06-trust-ca.*` — CA trust already covers "claude/codex" (sets `NODE_EXTRA_CA_CERTS`); no change needed.

---

### Task 1: Generalize `writeSecret`/`formatSecret` to take an SDS resource name

The single Bearer-shaped SDS secret writer is currently hardwired to the resource name `sandbox_bearer_token`. Codex needs the same shape under a different resource name (`codex_bearer_token`), so parameterize it rather than duplicating the module (per spec).

**Files:**

- Modify: `src/runProxy/writeSecret.ts`
- Test: `tests/unit/runProxy/writeSecret.test.ts`

**Interfaces:**

- Produces: `formatSecret(token: string, resourceName: string): string`; `writeSecret(token: string, path: string, resourceName: string): void`.

- [ ] **Step 1: Update the failing test**

Replace the body of `tests/unit/runProxy/writeSecret.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { formatSecret } from '../../../src/runProxy/writeSecret';

describe('formatSecret', () => {
  it('emits the SDS secret structure with a Bearer-prefixed inline_string and the given resource name', () => {
    expect(formatSecret('sk-ant-oat01-xyz', 'sandbox_bearer_token')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: sandbox_bearer_token',
        '    generic_secret:',
        '      secret:',
        '        inline_string: "Bearer sk-ant-oat01-xyz"',
        '',
      ].join('\n'),
    );
  });

  it('uses the codex resource name when asked', () => {
    expect(formatSecret('codex-tok', 'codex_bearer_token')).toContain('name: codex_bearer_token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- writeSecret` Expected: FAIL — `formatSecret` currently takes one argument; the `codex_bearer_token` assertion cannot match.

- [ ] **Step 3: Update the implementation**

Replace `src/runProxy/writeSecret.ts` with:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render an Envoy file-based SDS secret carrying a single `Bearer <token>` generic
 * secret under `resourceName`. Each Envoy SDS subscription watches its own
 * single-resource file, so the resource name is chosen by the caller (Claude uses
 * `sandbox_bearer_token`, Codex uses `codex_bearer_token`).
 */
export function formatSecret(token: string, resourceName: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    `    name: ${resourceName}`,
    '    generic_secret:',
    '      secret:',
    `        inline_string: "Bearer ${token}"`,
    '',
  ].join('\n');
}

export function writeSecret(token: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token, resourceName));
}
```

- [ ] **Step 4: Keep the one existing caller compiling**

In `src/commands/runProxy.ts` the `deps.writeSecret` entry currently passes the bare `writeSecret` reference. It is rewired fully in Task 8; for now, to keep `pnpm typecheck` green in isolation, change that deps entry from `writeSecret,` to:

```ts
        writeSecret: (token: string, path: string) => writeSecret(token, path, 'sandbox_bearer_token'),
```

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test:unit -- writeSecret && pnpm typecheck` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runProxy/writeSecret.ts tests/unit/runProxy/writeSecret.test.ts src/commands/runProxy.ts
git commit -m "refactor(writeSecret): parameterize SDS resource name"
```

---

### Task 2: JWT helpers (`src/jwt.ts`)

Codex's access token is a JWT; expiry lives in its `exp` claim (no separate field). We also need to *build* far-future placeholder JWTs. No signature handling — we only ever read our own tokens and emit garbage-signature placeholders.

**Files:**

- Create: `src/jwt.ts`
- Test: `tests/unit/jwt.test.ts`

**Interfaces:**

- Produces:
  - `encodeBase64Url(value: unknown): string`
  - `decodeJwtClaims(token: string): Record<string, unknown> | null`
  - `jwtExpMs(token: string): number | null` — epoch **milliseconds** from the `exp` claim (which is in seconds), or null when absent/malformed.
  - `buildJwt(claims: Record<string, unknown>): string` — `<b64url header>.<b64url claims>.<garbage sig>`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/jwt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildJwt, decodeJwtClaims, encodeBase64Url, jwtExpMs } from '../../src/jwt';

describe('jwt helpers', () => {
  it('round-trips claims through buildJwt/decodeJwtClaims', () => {
    const token = buildJwt({ sub: 'x', exp: 4102444800 });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'x', exp: 4102444800 });
  });

  it('derives exp in epoch milliseconds', () => {
    const token = buildJwt({ exp: 1751234567 });
    expect(jwtExpMs(token)).toBe(1751234567 * 1000);
  });

  it('produces url-safe base64 with no padding', () => {
    const s = encodeBase64Url(Buffer.from([0xff, 0xff, 0xfe]).toString('binary'));
    expect(s).not.toMatch(/[+/=]/);
  });

  it('returns null for a non-three-part token', () => {
    expect(decodeJwtClaims('not.ajwt')).toBeNull();
    expect(jwtExpMs('not.ajwt')).toBeNull();
  });

  it('returns null when exp is missing or non-numeric', () => {
    expect(jwtExpMs(buildJwt({ sub: 'x' }))).toBeNull();
    expect(jwtExpMs(buildJwt({ exp: 'soon' }))).toBeNull();
  });

  it('returns null when exp decodes to a non-finite number', () => {
    // JSON.parse('1e999') === Infinity, which is typeof 'number'.
    const token = `${encodeBase64Url({ alg: 'none' })}.${encodeBase64Url('{"exp":1e999}')}.sig`;
    expect(jwtExpMs(token)).toBeNull();
  });

  it('returns null on a payload that is not JSON', () => {
    const bad = `${encodeBase64Url({ a: 1 })}.notbase64json!!.sig`;
    expect(decodeJwtClaims(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- jwt` Expected: FAIL with "Cannot find module '../../src/jwt'".

- [ ] **Step 3: Write the implementation**

Create `src/jwt.ts`:

```ts
/**
 * Minimal JWT helpers. We never verify signatures: we only read tokens we already
 * trust (our own auth.json) and emit garbage-signature placeholder tokens for the VM.
 */

/** JSON-encode (unless already a string) then base64url (RFC 7515) with padding stripped. */
export function encodeBase64Url(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  return Buffer.from(json, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decode a JWT's payload claims without verifying the signature. Null on malformed. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Absolute expiry in epoch **milliseconds** from a JWT's `exp` claim (seconds). */
export function jwtExpMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  // NumericDate must be a finite number. Reject Infinity/NaN (e.g. a payload `exp: 1e999`
  // decodes to Infinity and would otherwise suppress refresh forever).
  if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) return null;
  return claims.exp * 1000;
}

/** Build an unsigned-shape JWT (real 3 segments, garbage signature). */
export function buildJwt(claims: Record<string, unknown>): string {
  const header = encodeBase64Url({ alg: 'none', typ: 'JWT' });
  const payload = encodeBase64Url(claims);
  return `${header}.${payload}.sandbox-not-a-real-signature`;
}
```

Note on the "not JSON" test: base64url-decoding `notbase64json!!` yields bytes `JSON.parse` rejects, so `decodeJwtClaims` returns null via the catch.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- jwt` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jwt.ts tests/unit/jwt.test.ts
git commit -m "feat(jwt): add base64url/JWT expiry/build helpers"
```

---

### Task 3: Codex placeholder constants (`src/codexPlaceholder.ts`)

The single fixed placeholder token the VM's Codex sends on the wire. The proxy's gate matches exactly this Bearer value and the injector swaps it out; it is never a real token, so it is safe to ship into the VM share. Access/id tokens must be valid far-future JWTs so the VM's Codex never decides to refresh.

**Files:**

- Create: `src/codexPlaceholder.ts`
- Test: `tests/unit/codexPlaceholder.test.ts`

**Interfaces:**

- Consumes: `buildJwt` from `src/jwt.ts` (Task 2); `jwtExpMs` in the test.
- Produces: `CODEX_PLACEHOLDER_EXP_SECONDS`, `CODEX_PLACEHOLDER_ACCESS_TOKEN`, `CODEX_PLACEHOLDER_ID_TOKEN`, `CODEX_PLACEHOLDER_REFRESH_TOKEN`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/codexPlaceholder.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_EXP_SECONDS,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';
import { jwtExpMs } from '../../src/jwt';

describe('codex placeholder constants', () => {
  it('exp is ~year 2100 (well past any real session)', () => {
    expect(CODEX_PLACEHOLDER_EXP_SECONDS).toBe(4102444800);
  });

  it('access and id tokens are valid JWTs whose exp decodes to the far-future value', () => {
    expect(jwtExpMs(CODEX_PLACEHOLDER_ACCESS_TOKEN)).toBe(4102444800 * 1000);
    expect(jwtExpMs(CODEX_PLACEHOLDER_ID_TOKEN)).toBe(4102444800 * 1000);
  });

  it('carries no real-looking secret material', () => {
    expect(CODEX_PLACEHOLDER_REFRESH_TOKEN).toContain('placeholder');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- codexPlaceholder` Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/codexPlaceholder.ts`:

```ts
import { buildJwt } from './jwt';

/** ~ year 2100 in epoch **seconds** — far past any real session, mirroring Claude's placeholder expiry. */
export const CODEX_PLACEHOLDER_EXP_SECONDS = 4102444800;

const PLACEHOLDER_CLAIMS = {
  sub: 'sandbox-user',
  email: 'sandbox@configamatron.invalid',
  exp: CODEX_PLACEHOLDER_EXP_SECONDS,
};

/**
 * Placeholder JWT the VM's Codex CLI carries in ~/.codex/auth.json. Never sent to
 * OpenAI: the proxy's gate matches `Authorization: Bearer <this>` and the
 * credential_injector swaps it for the real token. The far-future `exp` stops the
 * VM's own client from ever deciding it must refresh.
 */
export const CODEX_PLACEHOLDER_ACCESS_TOKEN = buildJwt(PLACEHOLDER_CLAIMS);

/** Codex may decode id_token locally for display without ever transmitting it. */
export const CODEX_PLACEHOLDER_ID_TOKEN = buildJwt(PLACEHOLDER_CLAIMS);

/** Never used: the access token never appears expired, so no refresh is attempted. */
export const CODEX_PLACEHOLDER_REFRESH_TOKEN = 'sandbox-placeholder-codex-refresh-token';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- codexPlaceholder` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codexPlaceholder.ts tests/unit/codexPlaceholder.test.ts
git commit -m "feat(codex): add placeholder JWT/token constants"
```

---

### Task 4: `readCodexCredentials` (`src/runProxy/readCodexCredentials.ts`)

Parse `~/.codex/auth.json` into the source-agnostic `Credentials` shape, deriving expiry from the access-token JWT's `exp` claim.

**Files:**

- Create: `src/runProxy/readCodexCredentials.ts`
- Test: `tests/unit/runProxy/readCodexCredentials.test.ts`

**Interfaces:**

- Consumes: `Credentials` from `src/runProxy/types.ts`; `jwtExpMs` from `src/jwt.ts` (Task 2); `buildJwt` in the test.
- Produces: `readCodexCredentials(path: string): Credentials | null` — null on missing file, partial/truncated JSON, missing `tokens.access_token`, or an access token with no decodable numeric `exp`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/readCodexCredentials.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexCredentials } from '../../../src/runProxy/readCodexCredentials';
import { buildJwt } from '../../../src/jwt';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-proxy-codex-creds-'));
  path = join(dir, 'auth.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAuth(tokens: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: null, tokens, auth_mode: 'chatgpt' }));
}

describe('readCodexCredentials', () => {
  it('returns the access token and its JWT exp (in ms) from tokens', () => {
    const access = buildJwt({ exp: 1_700_000_000 });
    writeAuth({ access_token: access, account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toEqual({
      accessToken: access,
      expiresAt: 1_700_000_000 * 1000,
    });
  });

  it('returns null when the file does not exist', () => {
    expect(readCodexCredentials(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on a partial / truncated mid-write read', () => {
    writeFileSync(path, '{"tokens": {"access_token": "eyJ');
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when tokens.access_token is missing', () => {
    writeAuth({ account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when the access token has no decodable exp', () => {
    writeAuth({ access_token: buildJwt({ sub: 'x' }) });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null for a non-chatgpt (api_key) auth file', () => {
    writeFileSync(
      path,
      JSON.stringify({
        OPENAI_API_KEY: 'sk-real-api-key',
        tokens: { access_token: buildJwt({ exp: 1_700_000_000 }) },
        auth_mode: 'api_key',
      }),
    );
    expect(readCodexCredentials(path)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- readCodexCredentials` Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/readCodexCredentials.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { Credentials } from './types';
import { jwtExpMs } from '../jwt';

/**
 * Read and parse ~/.codex/auth.json into the source-agnostic Credentials shape. The
 * access token is a JWT whose `exp` claim carries expiry (no separate field like
 * Claude's expiresAt). Returns null on any failure — missing file, invalid JSON from
 * a partial mid-write read, missing tokens.access_token, or a JWT with no decodable
 * numeric `exp` — so the caller can skip the event and wait for the next write.
 */
export function readCodexCredentials(path: string): Credentials | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Scope guard: this channel handles ChatGPT-plan sign-in only. An api_key-mode file
  // has no chatgpt JWT to inject; treat it as unreadable so startup fails loudly rather
  // than silently mis-injecting.
  if ((parsed as { auth_mode?: unknown } | null)?.auth_mode !== 'chatgpt') return null;

  const tokens = (parsed as { tokens?: unknown } | null)?.tokens as
    | { access_token?: unknown }
    | undefined;
  if (!tokens || typeof tokens.access_token !== 'string') return null;

  const expiresAt = jwtExpMs(tokens.access_token);
  if (expiresAt === null) return null;

  return { accessToken: tokens.access_token, expiresAt };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- readCodexCredentials` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/readCodexCredentials.ts tests/unit/runProxy/readCodexCredentials.test.ts
git commit -m "feat(codex): read auth.json + derive JWT expiry"
```

---

### Task 5: `sanitizeCodexCredentials` + shared fixture (`src/sanitizeCodexCredentials.ts`)

Turn a real `auth.json` into the VM placeholder copy: the three token fields become placeholders; everything else passes through. Also lands `tests/fixtures/auth.json`, the shared real-shaped fixture used by init/integration tests later.

**Files:**

- Create: `src/sanitizeCodexCredentials.ts`
- Create: `tests/fixtures/auth.json`
- Test: `tests/unit/sanitizeCodexCredentials.test.ts`

**Interfaces:**

- Consumes: the placeholder constants from `src/codexPlaceholder.ts` (Task 3).
- Produces: `sanitizeCodexCredentials(raw: string): string` — pretty-printed JSON, LF only, trailing newline. Throws `'codex auth file is not valid JSON'` / `'codex auth file has no tokens object'`.

- [ ] **Step 1: Create the shared fixture**

Create `tests/fixtures/auth.json` (a real-shaped file; the token values are dummies — sanitize replaces them without decoding, so no valid JWT is required here):

```json
{
  "OPENAI_API_KEY": null,
  "tokens": {
    "id_token": "real.id.token.value",
    "access_token": "real.access.token.value",
    "refresh_token": "real-refresh-secret",
    "account_id": "acct-uuid-1234"
  },
  "last_refresh": "2026-07-20T00:00:00Z",
  "auth_mode": "chatgpt"
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/sanitizeCodexCredentials.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sanitizeCodexCredentials } from '../../src/sanitizeCodexCredentials';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';

const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));

describe('sanitizeCodexCredentials', () => {
  it('replaces the three token fields with placeholders and passes everything else through', () => {
    const output = sanitizeCodexCredentials(readFileSync(authFixture, 'utf8'));
    const parsed = JSON.parse(output);
    expect(parsed.tokens.access_token).toBe(CODEX_PLACEHOLDER_ACCESS_TOKEN);
    expect(parsed.tokens.id_token).toBe(CODEX_PLACEHOLDER_ID_TOKEN);
    expect(parsed.tokens.refresh_token).toBe(CODEX_PLACEHOLDER_REFRESH_TOKEN);
    // Pass-through: account_id, auth_mode, OPENAI_API_KEY untouched.
    expect(parsed.tokens.account_id).toBe('acct-uuid-1234');
    expect(parsed.auth_mode).toBe('chatgpt');
    expect(parsed.OPENAI_API_KEY).toBeNull();
    expect(output).not.toContain('real.access.token.value');
    expect(output).not.toContain('real-refresh-secret');
  });

  it('emits LF-only output ending with a newline', () => {
    const output = sanitizeCodexCredentials(readFileSync(authFixture, 'utf8'));
    expect(output).not.toContain('\r');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('throws on invalid JSON', () => {
    expect(() => sanitizeCodexCredentials('{nope')).toThrow('not valid JSON');
  });

  it('throws when tokens is missing', () => {
    expect(() => sanitizeCodexCredentials('{"auth_mode":"chatgpt"}')).toThrow('tokens');
  });

  it('refuses an api_key-mode file (would leak a real OPENAI_API_KEY)', () => {
    const apiKeyFile = JSON.stringify({
      OPENAI_API_KEY: 'sk-real-api-key',
      tokens: { access_token: 'whatever' },
      auth_mode: 'api_key',
    });
    expect(() => sanitizeCodexCredentials(apiKeyFile)).toThrow('chatgpt-mode');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test:unit -- sanitizeCodexCredentials` Expected: FAIL — module missing.

- [ ] **Step 4: Write the implementation**

Create `src/sanitizeCodexCredentials.ts`:

```ts
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from './codexPlaceholder';

/**
 * Turn a real ~/.codex/auth.json into the VM placeholder copy: the three fields under
 * `tokens` become placeholders (access/id are far-future placeholder JWTs so the VM's
 * Codex never tries to refresh; refresh_token is a fixed dummy). Everything else —
 * tokens.account_id, auth_mode, OPENAI_API_KEY — passes through so the file matches the
 * user's real account shape and preserves Codex's account-scoped UX. Output is
 * pretty-printed JSON, LF line endings only.
 */
export function sanitizeCodexCredentials(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('codex auth file is not valid JSON');
  }

  // Scope + safety guard: only ChatGPT-plan sign-in is supported. In api_key mode the
  // real OPENAI_API_KEY is a live secret that pass-through would leak into the VM share,
  // so refuse rather than sanitize it.
  if ((parsed as { auth_mode?: unknown } | null)?.auth_mode !== 'chatgpt') {
    throw new Error('codex auth file is not chatgpt-mode (auth_mode must be "chatgpt")');
  }

  const tokens = (parsed as { tokens?: unknown } | null)?.tokens;
  if (!tokens || typeof tokens !== 'object') {
    throw new Error('codex auth file has no tokens object');
  }

  const record = tokens as Record<string, unknown>;
  record.access_token = CODEX_PLACEHOLDER_ACCESS_TOKEN;
  record.id_token = CODEX_PLACEHOLDER_ID_TOKEN;
  record.refresh_token = CODEX_PLACEHOLDER_REFRESH_TOKEN;

  return JSON.stringify(parsed, null, 2) + '\n';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit -- sanitizeCodexCredentials` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sanitizeCodexCredentials.ts tests/unit/sanitizeCodexCredentials.test.ts tests/fixtures/auth.json
git commit -m "feat(codex): sanitize auth.json into VM placeholder"
```

---

### Task 6: `nudgeCodexRefresh` (`src/runProxy/nudgeCodexRefresh.ts`)

Host-side nudge that makes the real `codex` CLI refresh its token, mirroring `nudgeRefresh.ts`. Like `nudgeRefresh`, this is not unit-tested (its real refresh behavior can only be confirmed against a real token near expiry, per spec) — the task is scoped to the module + a typecheck.

**Files:**

- Create: `src/runProxy/nudgeCodexRefresh.ts`

**Interfaces:**

- Consumes: `execa`; `NudgeResult` from `src/runProxy/types.ts`.
- Produces: `nudgeCodexRefresh(): Promise<NudgeResult>`.

- [ ] **Step 1: Write the implementation**

Create `src/runProxy/nudgeCodexRefresh.ts`:

```ts
import { execa } from 'execa';
import type { NudgeResult } from './types';

/** Minimal prompt whose only purpose is to make the CLI perform a token refresh. */
const NUDGE_PROMPT = 'Reply with the single word: ok';

/**
 * Nudge the official `codex` CLI to refresh its token by running a trivial headless
 * `codex exec` on the HOST (over the host's own network path — never the VM's proxied
 * traffic, which the placeholder-only gate would block). We never touch the refresh
 * token ourselves; the CLI stays the sole authority over auth.json. Success here means
 * the process exited 0; whether the token actually advanced is observed by the watcher
 * seeing a new JWT exp.
 *
 * `stdin: 'ignore'` is mandatory: `codex exec` peeks at stdin ("Reading additional
 * input from stdin...") even with a prompt argument, and run-proxy's own long-lived
 * stdin must never let a nudge hang waiting on it.
 */
export async function nudgeCodexRefresh(): Promise<NudgeResult> {
  try {
    await execa('codex', ['exec', NUDGE_PROMPT], { stdin: 'ignore' });
    return { ok: true, stderr: '' };
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr)
        : String(error);
    return { ok: false, stderr };
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/runProxy/nudgeCodexRefresh.ts
git commit -m "feat(codex): add host-side codex exec refresh nudge"
```

---

### Task 7: Extract the reusable `CredentialChannel` (`src/runProxy/credentialChannel.ts`)

Everything currently inlined as Claude-specific state and logic in `runProxyLoop` — `lastAppliedToken`, `lastSeenExpiresAt`, the nudge timer, `armTimer`/`doNudge`/`handleFailedAttempt`/`onTimer`, `refreshState()` — moves into one reusable class parameterized by source. `planNextActions` and the `Credentials` shape are already source-agnostic and unchanged. This task builds and fully unit-tests the class **standalone**; Task 8 wires it into the loop.

Each channel owns its own `consecutiveFailures`/backoff and nudge timer, so a transient Codex hiccup can't reset Claude's timer. The *terminal* outcome is shared via a callback: exhausting `maxAttempts` calls `onExhausted`, which the loop treats as fatal (whole proxy exits non-zero).

**Files:**

- Create: `src/runProxy/credentialChannel.ts`
- Test: `tests/unit/runProxy/credentialChannel.test.ts`

**Interfaces:**

- Consumes: `planNextActions` from `./planNextActions`; `Credentials`, `NudgeResult`, `RefreshState` from `./types`.
- Produces:

```ts
export interface CredentialChannelConfig {
  name: string;
  credentialsPath: string;
  secretPath: string;
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (token: string, path: string) => void;
  nudgeRefresh: () => Promise<NudgeResult>;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface CredentialChannelDeps {
  now: () => number;
  /** Called when this channel exhausts maxAttempts consecutive failed nudges. */
  onExhausted: (message: string) => void;
  /** True once the loop has begun shutting down; the channel stops acting on async outcomes. */
  isSettled: () => boolean;
}

export interface PrepareResult {
  /** The credential changed and its secret was (re)written — a restart is needed. */
  restartNeeded: boolean;
  /** The file was readable this cycle (so this channel's timer may be re-armed). */
  readable: boolean;
}

export class CredentialChannel {
  readonly name: string;
  readonly credentialsPath: string;
  constructor(config: CredentialChannelConfig, deps: CredentialChannelDeps);
  /** Startup read: reads creds (null = unreadable), writes the secret, stages the token, records expiry. */
  startupRead(): Credentials | null;
  /** A file event landed: re-read; if the token changed, write the secret + stage it. Resets backoff on advance. */
  prepareRestart(): PrepareResult;
  /** After a successful swap (or startup ready): the staged token is now the live/applied token. */
  commit(): void;
  /** (Re)arm the nudge timer from the last-read creds. No-op if refresh disabled or nothing read yet. */
  armTimer(): void;
  /** Stop the nudge timer. */
  clearTimer(): void;
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/runProxy/credentialChannel.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CredentialChannel,
  type CredentialChannelConfig,
  type CredentialChannelDeps,
} from '../../../src/runProxy/credentialChannel';
import type { Credentials } from '../../../src/runProxy/types';

const MIN = 60_000;

function makeChannel(
  initial: Credentials,
  overrides: Partial<CredentialChannelConfig> = {},
  depsOverrides: Partial<CredentialChannelDeps> = {},
) {
  const creds = { value: initial as Credentials | null };
  const mocks = {
    readCredentials: vi.fn(() => creds.value),
    writeSecret: vi.fn(),
    nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
    onExhausted: vi.fn(),
  };
  const config: CredentialChannelConfig = {
    name: 'test',
    credentialsPath: '/fake/creds',
    secretPath: '/fake/secret.yaml',
    readCredentials: mocks.readCredentials,
    writeSecret: mocks.writeSecret,
    nudgeRefresh: mocks.nudgeRefresh,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
  const deps: CredentialChannelDeps = {
    now: () => Date.now(),
    onExhausted: mocks.onExhausted,
    isSettled: () => false,
    ...depsOverrides,
  };
  return { channel: new CredentialChannel(config, deps), creds, mocks };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CredentialChannel startup + propagation', () => {
  it('startupRead writes the secret and stages the token; commit makes it applied', () => {
    const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
    expect(channel.startupRead()).toEqual({ accessToken: 'A', expiresAt: 60 * MIN });
    expect(mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/secret.yaml');
    channel.commit();

    // Same token after commit -> no restart.
    expect(channel.prepareRestart()).toEqual({ restartNeeded: false, readable: true });
  });

  it('startupRead returns null when the file is unreadable', () => {
    const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
    creds.value = null;
    expect(channel.startupRead()).toBeNull();
  });

  it('prepareRestart writes + stages a changed token and needs a restart', () => {
    const { channel, creds, mocks } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
    channel.startupRead();
    channel.commit();
    mocks.writeSecret.mockClear();

    creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    expect(channel.prepareRestart()).toEqual({ restartNeeded: true, readable: true });
    expect(mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/secret.yaml');
  });

  it('prepareRestart reports unreadable without a restart', () => {
    const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
    channel.startupRead();
    channel.commit();
    creds.value = null;
    expect(channel.prepareRestart()).toEqual({ restartNeeded: false, readable: false });
  });

  it('does not need a restart when only expiry moves (same token)', () => {
    const { channel, creds } = makeChannel({ accessToken: 'A', expiresAt: 60 * MIN });
    channel.startupRead();
    channel.commit();
    creds.value = { accessToken: 'A', expiresAt: 90 * MIN };
    expect(channel.prepareRestart().restartNeeded).toBe(false);
  });
});

describe('CredentialChannel refresh nudging', () => {
  it('exits via onExhausted after maxAttempts consecutive no-advance nudges', async () => {
    const { channel, mocks } = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN });
    channel.startupRead();
    channel.commit();
    channel.armTimer(); // expiry within refresh window -> nudge immediately

    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    expect(mocks.nudgeRefresh).toHaveBeenCalledTimes(3);
    expect(mocks.onExhausted).toHaveBeenCalledTimes(1);
    expect(mocks.onExhausted.mock.calls[0][0]).toContain('did not refresh after 3 attempts');
  });

  it('resets the failure counter when a refreshed (advanced-expiry) token appears', async () => {
    const { channel, creds, mocks } = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN });
    channel.startupRead();
    channel.commit();
    channel.armTimer();
    await vi.advanceTimersByTimeAsync(2 * MIN); // one failed-outcome cycle in flight

    creds.value = { accessToken: 'A', expiresAt: 90 * MIN }; // refresh landed (advanced)
    channel.prepareRestart();
    channel.armTimer();

    await vi.advanceTimersByTimeAsync(80 * MIN);
    expect(mocks.onExhausted).not.toHaveBeenCalled();
  });

  it('never nudges when refresh is disabled', async () => {
    const { channel, mocks } = makeChannel(
      { accessToken: 'A', expiresAt: 1 * MIN },
      { refreshEnabled: false },
    );
    channel.startupRead();
    channel.commit();
    channel.armTimer();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(mocks.nudgeRefresh).not.toHaveBeenCalled();
  });
});

describe('CredentialChannel isolation between two channels', () => {
  it('one channel exhausting does not touch the other channel timer/backoff', async () => {
    const a = makeChannel({ accessToken: 'A', expiresAt: 1 * MIN }, { name: 'claude' });
    const b = makeChannel({ accessToken: 'B', expiresAt: 60 * MIN }, { name: 'codex' });
    for (const h of [a, b]) {
      h.channel.startupRead();
      h.channel.commit();
      h.channel.armTimer();
    }

    // Drive A to exhaustion; B's token is far from expiry so it never nudges.
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    expect(a.mocks.onExhausted).toHaveBeenCalledTimes(1);
    expect(b.mocks.onExhausted).not.toHaveBeenCalled();
    expect(b.mocks.nudgeRefresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- credentialChannel` Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Create `src/runProxy/credentialChannel.ts`:

```ts
import { planNextActions } from './planNextActions';
import type { Credentials, NudgeResult, RefreshState } from './types';

export interface CredentialChannelConfig {
  name: string;
  credentialsPath: string;
  secretPath: string;
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (token: string, path: string) => void;
  nudgeRefresh: () => Promise<NudgeResult>;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}

export interface CredentialChannelDeps {
  now: () => number;
  /** Called when this channel exhausts maxAttempts consecutive failed nudges. */
  onExhausted: (message: string) => void;
  /** True once the loop has begun shutting down; the channel stops acting on async outcomes. */
  isSettled: () => boolean;
}

export interface PrepareResult {
  restartNeeded: boolean;
  readable: boolean;
}

/**
 * One credential source's full state machine, extracted verbatim from the old
 * Claude-only runProxyLoop: watched file -> secret write -> restart signalling, plus
 * the independent nudge timer / retry-backoff. The loop owns the blue-green restart;
 * a channel only decides *whether* a restart is needed and, after the swap succeeds,
 * commits its new token as applied.
 */
export class CredentialChannel {
  readonly name: string;
  readonly credentialsPath: string;

  private readonly config: CredentialChannelConfig;
  private readonly deps: CredentialChannelDeps;

  private lastAppliedToken: string | null = null;
  private lastSeenExpiresAt: number | null = null;
  private lastReadCreds: Credentials | null = null;
  private pendingToken: string | null = null;
  private awaitingOutcome = false;
  private consecutiveFailures = 0;
  private lastNudgeAt: number | null = null;
  private lastNudgeStderr: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: CredentialChannelConfig, deps: CredentialChannelDeps) {
    this.config = config;
    this.deps = deps;
    this.name = config.name;
    this.credentialsPath = config.credentialsPath;
  }

  startupRead(): Credentials | null {
    const creds = this.config.readCredentials(this.config.credentialsPath);
    if (creds === null) return null;
    this.config.writeSecret(creds.accessToken, this.config.secretPath);
    this.pendingToken = creds.accessToken;
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    return creds;
  }

  prepareRestart(): PrepareResult {
    const creds = this.config.readCredentials(this.config.credentialsPath);
    if (creds === null) return { restartNeeded: false, readable: false };

    const advanced = this.lastSeenExpiresAt !== null && creds.expiresAt > this.lastSeenExpiresAt;
    const plan = planNextActions({
      creds,
      lastAppliedToken: this.lastAppliedToken,
      now: this.deps.now(),
      config: this.planConfig(),
      refresh: this.refreshState(),
    });

    let restartNeeded = false;
    if (plan.propagate) {
      this.config.writeSecret(creds.accessToken, this.config.secretPath);
      this.pendingToken = creds.accessToken;
      restartNeeded = true;
    }
    if (advanced) {
      // Refresh landed: reset failure tracking and stop awaiting an outcome.
      this.consecutiveFailures = 0;
      this.awaitingOutcome = false;
    }
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    return { restartNeeded, readable: true };
  }

  commit(): void {
    if (this.pendingToken !== null) {
      this.lastAppliedToken = this.pendingToken;
      this.pendingToken = null;
    }
  }

  armTimer(): void {
    if (this.lastReadCreds === null) return;
    const plan = planNextActions({
      creds: this.lastReadCreds,
      lastAppliedToken: this.lastAppliedToken,
      now: this.deps.now(),
      config: this.planConfig(),
      refresh: this.refreshState(),
    });
    this.armAt(plan.nudgeAt);
  }

  clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private planConfig() {
    return {
      refreshWindowMs: this.config.refreshWindowMs,
      retryIntervalMs: this.config.retryIntervalMs,
    };
  }

  private refreshState(): RefreshState {
    return {
      enabled: this.config.refreshEnabled,
      awaitingOutcome: this.awaitingOutcome,
      lastNudgeAt: this.lastNudgeAt,
    };
  }

  private armAt(nudgeAt: number | null): void {
    this.clearTimer();
    if (nudgeAt === null) return;
    const delay = Math.max(0, nudgeAt - this.deps.now());
    this.timer = setTimeout(() => {
      void this.onTimer();
    }, delay);
  }

  private async onTimer(): Promise<void> {
    if (this.deps.isSettled()) return;
    if (this.awaitingOutcome) {
      // Outcome deadline reached with no observed advance -> failed attempt.
      this.handleFailedAttempt();
    } else {
      await this.doNudge();
    }
  }

  private async doNudge(): Promise<void> {
    this.awaitingOutcome = true;
    this.lastNudgeAt = this.deps.now();
    // Arm the outcome deadline: retryInterval from now.
    this.armAt(this.lastNudgeAt + this.config.retryIntervalMs);
    const result = await this.config.nudgeRefresh();
    if (this.deps.isSettled() || !this.awaitingOutcome) return;
    if (result.ok) {
      this.lastNudgeStderr = null;
    } else {
      this.lastNudgeStderr = result.stderr;
      this.handleFailedAttempt();
    }
  }

  private handleFailedAttempt(): void {
    this.clearTimer();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.config.maxAttempts) {
      this.deps.onExhausted(
        this.lastNudgeStderr ??
          `${this.name}: token did not refresh after ${this.config.maxAttempts} attempts`,
      );
      return;
    }
    void this.doNudge();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- credentialChannel` Expected: PASS (all groups, including the two-channel isolation case).

- [ ] **Step 5: Commit**

```bash
git add src/runProxy/credentialChannel.ts tests/unit/runProxy/credentialChannel.test.ts
git commit -m "refactor(run-proxy): extract reusable CredentialChannel state machine"
```

---

### Task 8: Drive an array of `CredentialChannel`s from `runProxyLoop`

Replace the single hardwired credential source in `runProxyLoop` with `config.channels: CredentialChannelConfig[]`. The loop builds one `CredentialChannel` per config, watches each one's file (a per-channel dirty **set** replacing the `pendingCredentials` boolean, alongside the existing `pendingAllowlist`), and in its restart pipeline loops over whichever channels are dirty, then — only after a color swap actually succeeds — commits each applied channel's new token. This task keeps behavior identical for the single Claude channel; the Codex channel is added at the command layer in Task 15.

**Files:**

- Modify: `src/runProxy/runProxyLoop.ts` (full rewrite of the file, below)
- Modify: `src/commands/runProxy.ts` (build one Claude channel; drop the moved deps)
- Test: `tests/unit/runProxy/runProxyLoop.test.ts` (new harness + two assertion-string edits)

**Interfaces:**

- Consumes: `CredentialChannel`, `CredentialChannelConfig` from `./credentialChannel` (Task 7).
- Produces:
  - `RunProxyConfig = { channels: CredentialChannelConfig[]; allowlistPath: string; readyTimeoutMs: number; drainTimeoutMs: number }`
  - `RunProxyDeps` — same as today **minus** `readCredentials`, `writeSecret`, `nudgeRefresh` (now per-channel in each `CredentialChannelConfig`).

- [ ] **Step 1: Rewrite `src/runProxy/runProxyLoop.ts`**

Replace the whole file with:

```ts
import { parseAllowlist, terminateTlsHosts, type Allowlist } from '../allowlist';
import { parseLine } from './parseLine';
import { classify } from './classify';
import { formatOutput } from './formatOutput';
import { UniqueTracker } from './uniqueTracker';
import { CredentialChannel, type CredentialChannelConfig } from './credentialChannel';
import type { Color, ColorPorts } from './types';
import { otherColor } from './types';
import type { WaitResult } from './waitColorReady';

export interface RunProxyConfig {
  /** One entry per credential source (Claude, Codex). Each drives its own file watch, secret, and nudge timer. */
  channels: CredentialChannelConfig[];
  allowlistPath: string;
  /** How long to wait for a freshly-started color's admin /ready before giving up. */
  readyTimeoutMs: number;
  /** How long to let the old color's connections finish before force-closing them. */
  drainTimeoutMs: number;
}

export interface RunProxyDeps {
  /** Raw allowlist file content, or null when unreadable. */
  readAllowlist: (path: string) => string | null;
  /** Render and write envoy.yaml (upstream overrides are baked in by the caller). */
  buildConfig: (allowlist: Allowlist) => void;
  /** Ensure the leaf covers `sans` (reissue if needed); returns a status line. */
  ensureLeaf: (sans: string[]) => string;
  /** Allocate three distinct free loopback ports for the next color to bring up. */
  allocatePorts: () => Promise<ColorPorts>;
  /** Force-recreate the given color's container, published on `ports`. */
  bringUpColor: (color: Color, ports: ColorPorts) => Promise<void>;
  /** Poll the color's own admin /ready; ready once it serves, else exited/timeout. */
  waitColorReady: (
    color: Color,
    ports: ColorPorts,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<WaitResult>;
  /** Point the gateway forwarder at this color's backend ports (the flip). */
  setActiveBackend: (ports: ColorPorts) => void;
  /** Wait for the old color's connections to drain, force-closing at timeout. */
  drainBackend: (ports: ColorPorts, timeoutMs: number, signal: AbortSignal) => Promise<void>;
  /** Stop the given color's container. */
  stopColor: (color: Color) => Promise<void>;
  /** File watcher; used for each channel's credentials file and the allowlist. */
  watch: (path: string, onEvent: () => void) => { close: () => void };
  startLogStream: (color: Color, onLine: (raw: string) => void) => void;
  /** Resolves once the current log-follow child is fully gone; no-op when none. */
  stopLogStream: () => Promise<void>;
  onSigint: (handler: () => void) => void;
  log: (message: string) => void;
  error: (message: string) => void;
  now: () => number;
}

/**
 * Long-running orchestrator. Owns the proxy end to end: builds envoy.yaml from the
 * allowlist, keeps every channel's SDS secret fresh, watches all files, restarts the
 * container on changes (serialized, coalescing bursts), and streams the tagged access
 * log inline (each host+handling once). Resolves with a process exit code: 0 on SIGINT
 * (container left running), 1 on any fatal error (including any channel exhausting its
 * refresh attempts).
 */
export function runProxyLoop(config: RunProxyConfig, deps: RunProxyDeps): Promise<number> {
  return new Promise<number>((resolve) => {
    let settled = false;
    let restarting = false;
    let pendingAllowlist = false;
    const dirtyChannels = new Set<CredentialChannel>();
    let sigintSeen = false;
    let activeColor: Color = 'blue';
    let activePorts: ColorPorts | null = null;
    const unique = new UniqueTracker();
    const shutdownAbort = new AbortController();
    const watchers: { close: () => void }[] = [];

    /**
     * Tear down every long-lived handle, then resolve. `settled` flips synchronously so
     * no callback can act after shutdown begins; the log child is stopped asynchronously
     * before resolving so it cannot outlive us.
     */
    const shutdown = (code: number): void => {
      if (settled) return;
      settled = true;
      shutdownAbort.abort();
      for (const channel of channels) channel.clearTimer();
      for (const watcher of watchers) watcher.close();
      void deps.stopLogStream().then(() => resolve(code));
    };

    const fatal = (message: string): void => {
      if (settled) return;
      deps.error(`run-proxy: ${message}`);
      shutdown(1);
    };

    // Built after fatal so onExhausted can reference it; used only inside async callbacks
    // that run well after this synchronous setup completes.
    const channels = config.channels.map(
      (channelConfig) =>
        new CredentialChannel(channelConfig, {
          now: deps.now,
          onExhausted: (message) => fatal(message),
          isSettled: () => settled,
        }),
    );

    const onLogLine = (raw: string): void => {
      if (settled) return;
      const access = parseLine(raw);
      if (!access) return;
      for (const entry of classify(access)) {
        if (!unique.shouldPrint(entry)) continue;
        deps.log(formatOutput(entry));
      }
    };

    /** Read+parse the allowlist; null only when the file is unreadable (keep previous config). */
    const readParsedAllowlist = (): Allowlist | null => {
      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        deps.error(
          `run-proxy: could not read allowlist at ${config.allowlistPath}, keeping previous config`,
        );
        return null;
      }
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);
      return allowlist;
    };

    /** Reissue the leaf if the TLS-terminated hosts changed and rewrite envoy.yaml. */
    const applyAllowlist = (allowlist: Allowlist): void => {
      deps.log(`run-proxy: ${deps.ensureLeaf(terminateTlsHosts(allowlist))}`);
      deps.buildConfig(allowlist);
    };

    const requestRestart = (source: CredentialChannel | 'allowlist'): void => {
      if (settled) return;
      if (source === 'allowlist') pendingAllowlist = true;
      else dirtyChannels.add(source);
      if (!restarting) void drainRestarts();
    };

    /**
     * Serialized restart pipeline: at most one force-recreate runs at a time. Events
     * landing mid-restart only set pending flags/dirty entries; the while loop collapses
     * any burst into a single follow-up restart that re-reads every dirty source fresh.
     */
    const drainRestarts = async (): Promise<void> => {
      restarting = true;
      try {
        while (!settled && (dirtyChannels.size > 0 || pendingAllowlist)) {
          const allowlistDirty = pendingAllowlist;
          const channelsThisPass = [...dirtyChannels];
          pendingAllowlist = false;
          dirtyChannels.clear();

          let restartNeeded = false;
          let clearUnique = false;
          const reasons: string[] = [];

          if (allowlistDirty) {
            const allowlist = readParsedAllowlist();
            if (allowlist !== null) {
              try {
                applyAllowlist(allowlist);
              } catch (err) {
                fatal(`failed to rebuild the proxy config: ${String(err)}`);
                return;
              }
              restartNeeded = true;
              clearUnique = true; // wholesale reset, per design
              reasons.push('allowlist changed');
            }
          }

          const appliedChannels: CredentialChannel[] = [];
          const readableChannels: CredentialChannel[] = [];
          for (const channel of channelsThisPass) {
            const result = channel.prepareRestart();
            if (result.readable) readableChannels.push(channel);
            else
              deps.error(
                `run-proxy: skipped ${channel.name} credentials event (unreadable or partial write)`,
              );
            if (result.restartNeeded) {
              restartNeeded = true;
              appliedChannels.push(channel);
              reasons.push(`${channel.name} credentials changed`);
            }
          }

          if (restartNeeded && activePorts !== null) {
            deps.log(`run-proxy: restarting proxy — ${reasons.join(', ')}`);
            const idle = otherColor(activeColor);
            const oldColor = activeColor;
            const oldPorts = activePorts;

            const idlePorts = await deps.allocatePorts();
            let broughtUp = true;
            try {
              await deps.bringUpColor(idle, idlePorts);
            } catch (err) {
              broughtUp = false;
              deps.error(
                `run-proxy: could not start the new proxy (${idle}) — keeping the current proxy: ${String(err)}`,
              );
            }
            if (settled) return;

            if (broughtUp) {
              const result = await deps.waitColorReady(
                idle,
                idlePorts,
                config.readyTimeoutMs,
                shutdownAbort.signal,
              );
              if (settled) return;
              if (!result.ready) {
                deps.error(
                  result.reason === 'exited'
                    ? `run-proxy: new proxy (${idle}) exited during startup — likely config issue, check the logs`
                    : `run-proxy: new proxy (${idle}) did not become ready — keeping the current proxy`,
                );
                await deps.stopColor(idle).catch(() => {});
              } else {
                // Flip: new connections now go to the freshly-ready color.
                await deps.stopLogStream();
                deps.setActiveBackend(idlePorts);
                activeColor = idle;
                activePorts = idlePorts;
                for (const channel of appliedChannels) channel.commit();
                if (clearUnique) unique.clear();
                deps.startLogStream(idle, onLogLine);
                // Retire the old color once its connections drain (bounded).
                await deps.drainBackend(oldPorts, config.drainTimeoutMs, shutdownAbort.signal);
                await deps.stopColor(oldColor).catch(() => {});
                deps.log(`run-proxy: swap complete — now serving ${activeColor}`);
              }
            }
          }

          // Re-arm the nudge timer for each channel that produced a fresh read this pass.
          if (!settled) for (const channel of readableChannels) channel.armTimer();
        }
      } finally {
        restarting = false;
      }
    };

    const onSigintOnce = (): void => {
      if (sigintSeen || settled) return;
      sigintSeen = true;
      deps.log('run-proxy: SIGINT received, stopping (container left running)');
      shutdown(0);
    };

    const start = async (): Promise<void> => {
      // Read every channel up front (each also writes its secret + stages its token).
      // Any unreadable credential is fatal on startup, same as the old single source.
      for (const channel of channels) {
        const creds = channel.startupRead();
        if (creds === null) {
          fatal(`could not read ${channel.name} credentials at ${channel.credentialsPath}`);
          return;
        }
      }

      const content = deps.readAllowlist(config.allowlistPath);
      if (content === null) {
        fatal(`could not read allowlist at ${config.allowlistPath}`);
        return;
      }
      const allowlist = parseAllowlist(content);
      for (const warning of allowlist.warnings) deps.error(`run-proxy: ${warning}`);

      // Arm all watchers before the (slow) startup recreate: a change landing
      // mid-startup coalesces into one follow-up restart instead of being dropped.
      for (const channel of channels) {
        watchers.push(deps.watch(channel.credentialsPath, () => requestRestart(channel)));
      }
      watchers.push(deps.watch(config.allowlistPath, () => requestRestart('allowlist')));
      deps.onSigint(onSigintOnce);

      restarting = true; // hold watcher events as pending until the startup bring-up is done
      try {
        try {
          applyAllowlist(allowlist);
        } catch (err) {
          fatal(`failed to build the proxy config: ${String(err)}`);
          return;
        }
        // Secrets were already written by each channel's startupRead().
        const ports = await deps.allocatePorts();
        try {
          await deps.bringUpColor('blue', ports);
        } catch {
          fatal('docker failed to start the proxy on startup');
          return;
        }
        if (settled) return;
        const result = await deps.waitColorReady(
          'blue',
          ports,
          config.readyTimeoutMs,
          shutdownAbort.signal,
        );
        if (settled) return;
        if (!result.ready) {
          fatal(
            result.reason === 'exited'
              ? 'proxy exited during startup — likely config issue, check the logs'
              : 'proxy did not become ready on startup',
          );
          return;
        }
        activeColor = 'blue';
        activePorts = ports;
        deps.setActiveBackend(ports);
        for (const channel of channels) channel.commit();
      } finally {
        restarting = false;
      }

      for (const channel of channels) channel.armTimer();
      deps.log(
        `run-proxy: watching credentials and allowlist; proxy is serving the current token (${activeColor})`,
      );

      // Apply anything that landed during the startup recreate.
      if (dirtyChannels.size > 0 || pendingAllowlist) void drainRestarts();
    };

    void start();
  });
}
```

- [ ] **Step 2: Rewire `src/commands/runProxy.ts` to build one Claude channel**

At the top, replace the three now-per-channel imports. Remove `writeSecret` from the deps object; construct a Claude channel config and pass `channels` in the loop config. Concretely:

- Add imports (keep the existing ones for `readCredentials`, `writeSecret`, `nudgeRefresh`):

```ts
import type { CredentialChannelConfig } from '../runProxy/credentialChannel';
```

- Delete these three entries from the `deps` object (they moved into the channel config): `readCredentials,`, the `writeSecret: (token, path) => writeSecret(token, path, 'sandbox_bearer_token'),` line added in Task 1, and `nudgeRefresh,`.

- Replace the `runProxyLoop({ ... }, deps)` config argument. Where it currently passes `credentialsPath / allowlistPath / secretPath / readyTimeoutMs / drainTimeoutMs / refreshWindowMs / retryIntervalMs / maxAttempts / refreshEnabled`, build the channel first and pass `channels`:

```ts
      const claudeChannel: CredentialChannelConfig = {
        name: 'claude',
        credentialsPath: options.credentials,
        secretPath,
        readCredentials,
        writeSecret: (token, path) => writeSecret(token, path, 'sandbox_bearer_token'),
        nudgeRefresh,
        refreshWindowMs: Number(options.refreshWindow) * 60_000,
        retryIntervalMs: Number(options.retryInterval) * 60_000,
        maxAttempts: Number(options.maxAttempts),
        refreshEnabled: options.refresh,
      };

      const exitCode = await runProxyLoop(
        {
          channels: [claudeChannel],
          allowlistPath: paths.allowlist,
          readyTimeoutMs: 60_000,
          drainTimeoutMs: 30_000,
        },
        deps,
      );
```

(`secretPath` is the existing `options.secret ?? paths.sdsSecret` local.)

- [ ] **Step 3: Rewrite the `runProxyLoop.test.ts` harness**

The harness moves the Claude-specific `readCredentials`/`writeSecret`/`nudgeRefresh` mocks into a channel config. Replace `baseConfig` and the deps construction inside `makeHarness` as follows (everything else in the file — the `flush` helper, the fire/feed closures, the individual `it(...)` bodies — stays, except the two string edits in Step 4).

Replace `baseConfig`:

```ts
function claudeChannelConfig(
  creds: { value: Credentials },
  mocks: { writeSecret: ReturnType<typeof vi.fn>; nudgeRefresh: ReturnType<typeof vi.fn> },
  overrides: Partial<CredentialChannelConfig> = {},
): CredentialChannelConfig {
  return {
    name: 'claude',
    credentialsPath: '/fake/.credentials.json',
    secretPath: '/fake/sds-secret.yaml',
    readCredentials: () => creds.value,
    writeSecret: mocks.writeSecret,
    nudgeRefresh: mocks.nudgeRefresh,
    refreshWindowMs: 3 * MIN,
    retryIntervalMs: 2 * MIN,
    maxAttempts: 3,
    refreshEnabled: true,
    ...overrides,
  };
}

function baseConfig(channels: CredentialChannelConfig[]): RunProxyConfig {
  return {
    channels,
    allowlistPath: '/fake/allowlist.txt',
    readyTimeoutMs: 30_000,
    drainTimeoutMs: 30_000,
  };
}
```

Update the top imports:

```ts
import type { CredentialChannelConfig } from '../../../src/runProxy/credentialChannel';
```

In `makeHarness`, delete the `readCredentials`, `writeSecret`, and `nudgeRefresh` entries from the `deps` object (they now live in the channel config). Keep the `mocks.writeSecret` / `mocks.nudgeRefresh` `vi.fn()`s in the `mocks` record. Build and expose the channel config from the harness so tests can pass it and tweak it:

```ts
  const channelConfig = claudeChannelConfig(creds, mocks);
```

Return `channelConfig` on the harness object alongside `deps`, `creds`, etc.

Then update every call site from `runProxyLoop(baseConfig(), h.deps)` to `runProxyLoop(baseConfig([h.channelConfig]), h.deps)`, and the two refresh tests that used `baseConfig({ maxAttempts: 3 })` to build the channel with that override, e.g.:

```ts
    const h = makeHarness({ accessToken: 'A', expiresAt: 1 * MIN });
    const channel = claudeChannelConfig(h.creds, h.mocks, { maxAttempts: 3 });
    const exit = runProxyLoop(baseConfig([channel]), h.deps);
```

(For the two `maxAttempts: 3` tests, replace `h.channelConfig` with a locally built `channel`; `maxAttempts` is already 3 by default, so these two could also just use `[h.channelConfig]` unchanged — either is fine.)

- [ ] **Step 4: Update the two restart-reason assertions**

Two assertions hard-code the old reason string. Update both occurrences of:

```ts
expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — credentials changed');
```

to:

```ts
expect(h.mocks.log).toHaveBeenCalledWith('run-proxy: restarting proxy — claude credentials changed');
```

(The `maxAttempts` exhaustion test asserts `stringContaining('token did not refresh after 3 attempts')`, which the channel's `"claude: token did not refresh after 3 attempts"` still satisfies — no change needed there. The startup log `'serving the current token'` and the `writeSecret` `toHaveBeenCalledWith('A', '/fake/sds-secret.yaml')` assertions are also unchanged.)

- [ ] **Step 5: Add loop-level two-channel parity tests**

The single-channel harness proves the old behavior is preserved, but the spec's multi-channel guarantees (both dirty channels write/stage then commit after one shared swap; either channel exhausting fatals the whole loop) need loop-level coverage. First generalize the harness `watch` dispatch to key on path (so a second credentials file routes correctly). In `makeHarness`, replace the `watch` closure and the `fireCredentials` closure with a path-keyed map:

```ts
  const credentialCbs = new Map<string, () => void>();
  // ...in deps:
    watch: (path, onEvent) => {
      if (path.endsWith('allowlist.txt')) allowlistCb = onEvent;
      else credentialCbs.set(path, onEvent);
      return { close: watchClose };
    },
  // ...in the returned object:
    fireCredentials: (p = '/fake/.credentials.json') => credentialCbs.get(p)?.(),
```

Then add a second suite that builds two channels sharing one harness. Because the existing harness's `readCredentials`/`writeSecret` are per-channel-config, build two configs with distinct paths and independent creds refs:

```ts
describe('runProxyLoop multi-channel', () => {
  it('coalesces two dirty channels into one swap, writes both secrets, commits both', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const codexCreds = { value: { accessToken: 'X', expiresAt: 60 * MIN } as Credentials };
    const codexWrite = vi.fn();
    const codexChannel: CredentialChannelConfig = {
      name: 'codex',
      credentialsPath: '/fake/auth.json',
      secretPath: '/fake/codex-secret.yaml',
      readCredentials: () => codexCreds.value,
      writeSecret: codexWrite,
      nudgeRefresh: vi.fn().mockResolvedValue({ ok: true, stderr: '' }),
      refreshWindowMs: 3 * MIN,
      retryIntervalMs: 2 * MIN,
      maxAttempts: 3,
      refreshEnabled: true,
    };
    void runProxyLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
    await flush();
    h.mocks.bringUpColor.mockClear();
    h.mocks.writeSecret.mockClear();
    codexWrite.mockClear();

    // Both credentials change; fire both watchers.
    h.creds.value = { accessToken: 'B', expiresAt: 60 * MIN };
    codexCreds.value = { accessToken: 'Y', expiresAt: 60 * MIN };
    h.fireCredentials('/fake/.credentials.json');
    h.fireCredentials('/fake/auth.json');
    await flush();

    // One swap serves both.
    expect(h.mocks.bringUpColor).toHaveBeenCalledTimes(1);
    expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
    expect(codexWrite).toHaveBeenCalledWith('Y', '/fake/codex-secret.yaml');
    expect(h.mocks.log).toHaveBeenCalledWith(
      'run-proxy: swap complete — now serving green',
    );

    // Both are committed: presenting the same tokens again needs no further swap.
    h.mocks.bringUpColor.mockClear();
    h.fireCredentials('/fake/.credentials.json');
    h.fireCredentials('/fake/auth.json');
    await flush();
    expect(h.mocks.bringUpColor).not.toHaveBeenCalled();
  });

  it('one channel exhausting its nudges fatals the whole loop and closes both watchers', async () => {
    const h = makeHarness({ accessToken: 'A', expiresAt: 60 * MIN });
    const codexChannel: CredentialChannelConfig = {
      name: 'codex',
      credentialsPath: '/fake/auth.json',
      secretPath: '/fake/codex-secret.yaml',
      readCredentials: () => ({ accessToken: 'X', expiresAt: 1 * MIN }),
      writeSecret: vi.fn(),
      nudgeRefresh: vi.fn().mockResolvedValue({ ok: false, stderr: 'codex boom' }),
      refreshWindowMs: 3 * MIN,
      retryIntervalMs: 2 * MIN,
      maxAttempts: 3,
      refreshEnabled: true,
    };
    const exit = runProxyLoop(baseConfig([h.channelConfig, codexChannel]), h.deps);
    await flush();

    // Codex's token is inside the refresh window and every nudge fails -> exhaustion.
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    await vi.advanceTimersByTimeAsync(2 * MIN);

    await expect(exit).resolves.toBe(1);
    expect(h.mocks.error).toHaveBeenCalledWith(expect.stringContaining('codex boom'));
    // Both credentials watchers + the allowlist watcher were closed (3 total).
    expect(h.mocks.watchClose).toHaveBeenCalledTimes(3);
  });
});
```

(The exhaustion message uses the failing nudge's stderr — `handleFailedAttempt` passes `lastNudgeStderr ?? "<name>: token did not refresh…"`, and here stderr is `'codex boom'`.)

- [ ] **Step 6: Run the loop tests + typecheck**

Run: `pnpm test:unit -- runProxyLoop && pnpm typecheck` Expected: PASS (all existing behaviors green under the channel-driven loop, plus the two multi-channel cases).

- [ ] **Step 7: Run the full unit suite**

Run: `pnpm test:unit` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/runProxy/runProxyLoop.ts src/commands/runProxy.ts tests/unit/runProxy/runProxyLoop.test.ts
git commit -m "refactor(run-proxy): drive an array of credential channels"
```

---

### Task 9: `envPaths` — `authJson` + `codexSecret`

Add the two new paths: the placeholder `auth.json` in each VM-shared target, and the Codex SDS secret in the proxy secrets dir.

**Files:**

- Modify: `src/envPaths.ts`
- Test: `tests/unit/envPaths.test.ts`

**Interfaces:**

- Produces: `VmSharedPaths.authJson: string`; `EnvPaths.codexSecret: string` (`= join(secretsDir, 'codex-secret.yaml')`).

- [ ] **Step 1: Add the failing assertions**

In `tests/unit/envPaths.test.ts`, add (adapt to the file's existing `paths`/`expect` style — the existing suite builds `envPaths(cwd)` and asserts joins):

```ts
  it('places the codex placeholder auth.json in each vm-shared target', () => {
    const paths = envPaths('/work');
    expect(paths.vmSharedTargets.map((t) => t.authJson)).toEqual([
      join('/work', '.configamatron', 'vm-shared', 'auth.json'),
      join('/work', '.configamatron', 'vm-shared-windows', 'auth.json'),
    ]);
  });

  it('places the codex SDS secret under proxy/secrets', () => {
    const paths = envPaths('/work');
    expect(paths.codexSecret).toBe(
      join('/work', '.configamatron', 'proxy', 'secrets', 'codex-secret.yaml'),
    );
  });
```

Ensure `join` is imported in the test (it already imports from `node:path` if other cases use it; add `import { join } from 'node:path';` if missing).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- envPaths` Expected: FAIL — `authJson`/`codexSecret` do not exist.

- [ ] **Step 3: Implement**

In `src/envPaths.ts`:

- Add `authJson: string;` to the `VmSharedPaths` interface.
- Add `codexSecret: string;` to the `EnvPaths` interface.
- In the `target` factory, add `authJson: join(dir, 'auth.json'),`.
- In the returned `EnvPaths` object (next to `sdsSecret`), add `codexSecret: join(proxy, 'secrets', 'codex-secret.yaml'),`.

Resulting `target` factory and the two interface additions:

```ts
  const target = (dir: string): VmSharedPaths => ({
    dir,
    cert: join(dir, 'cert.pem'),
    credentials: join(dir, 'credentials.json'),
    authJson: join(dir, 'auth.json'),
    githubConfig: join(dir, 'github-config.txt'),
  });
```

```ts
    secretsDir: join(proxy, 'secrets'),
    sdsSecret: join(proxy, 'secrets', 'sds-secret.yaml'),
    codexSecret: join(proxy, 'secrets', 'codex-secret.yaml'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- envPaths && pnpm typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/envPaths.ts tests/unit/envPaths.test.ts
git commit -m "feat(envPaths): add codex auth.json + codex-secret paths"
```

---

### Task 10: Allowlist — `#pragma codex authenticated`

Add a `codexAuthenticated` section mirroring `githubAuthenticated`: parsed/formatted/prioritized alongside the existing sections and folded into `terminateTlsHosts()`. Contents in use: `chatgpt.com:443`.

**Files:**

- Modify: `src/allowlist.ts`
- Test: `tests/unit/allowlist.test.ts`

**Interfaces:**

- Produces: `Allowlist.codexAuthenticated: string[]`; the `#pragma codex authenticated` header; codex included in `terminateTlsHosts`, `formatAllowlist`, and collision priority.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/allowlist.test.ts`:

```ts
  it('parses a codex authenticated section', () => {
    const parsed = parseAllowlist(
      ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
    );
    expect(parsed.codexAuthenticated).toEqual(['chatgpt.com:443']);
  });

  it('includes codex hosts in terminateTlsHosts', () => {
    const parsed = parseAllowlist(
      ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
    );
    expect(terminateTlsHosts(parsed)).toContain('chatgpt.com');
  });

  it('round-trips a codex section through formatAllowlist', () => {
    const parsed = parseAllowlist(
      ['#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
    );
    expect(formatAllowlist(parsed)).toContain('#pragma codex authenticated');
    expect(formatAllowlist(parsed)).toContain('chatgpt.com:443');
  });
```

Ensure `terminateTlsHosts` and `formatAllowlist` are imported in the test (add to the existing import from `../../src/allowlist`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- allowlist` Expected: FAIL — `codexAuthenticated` missing / pragma treated as invalid.

- [ ] **Step 3: Implement**

In `src/allowlist.ts`:

- Add `codexAuthenticated: string[];` to the `Allowlist` interface (after `githubAuthenticated`).
- Extend the `Section` type: `... | 'githubAuthenticated' | 'codexAuthenticated' | 'authCandidate'`.
- In `parseAllowlist`, add `const codexAuthenticated = new Set<string>();` and a pragma branch:

```ts
    if (line === '#pragma codex authenticated') {
      section = 'codexAuthenticated';
      continue;
    }
```

- In the section-dispatch tail, add before the `else authCandidate.add(line)`:

```ts
    else if (section === 'codexAuthenticated') codexAuthenticated.add(line);
```

- Add codex to the priority list (between github and claude) and the collision union + display order:

```ts
  const byPriority: Array<{ name: string; set: Set<string> }> = [
    { name: 'authCandidate', set: authCandidate },
    { name: 'githubAuthenticated', set: githubAuthenticated },
    { name: 'codexAuthenticated', set: codexAuthenticated },
    { name: 'claudeAuthenticated', set: claudeAuthenticated },
    { name: 'passthrough', set: passthroughSet },
  ];
  const displayOrder = [
    'passthrough',
    'claudeAuthenticated',
    'codexAuthenticated',
    'githubAuthenticated',
    'authCandidate',
  ];
```

- Add `codexAuthenticated` to the collision-scan union set:

```ts
  for (const entry of new Set([
    ...passthroughSet,
    ...claudeAuthenticated,
    ...githubAuthenticated,
    ...codexAuthenticated,
    ...authCandidate,
  ])) {
```

- Return `codexAuthenticated: [...codexAuthenticated],` in the result object.
- In `terminateTlsHosts`, add `...allowlist.codexAuthenticated,` to the spread.
- In `formatAllowlist`, add a section after the github block:

```ts
  if (allowlist.codexAuthenticated.length > 0) {
    lines.push('', '#pragma codex authenticated');
    for (const entry of [...allowlist.codexAuthenticated].sort()) lines.push(entry);
  }
```

- [ ] **Step 4: Update every other place that builds or asserts a full `Allowlist`**

`codexAuthenticated` is a **required** field (like `githubAuthenticated`), so every `Allowlist`-shaped object — produced or asserted — must gain it. Do all of these (they will otherwise fail `typecheck` or `toEqual` at runtime):

- **`src/policyFile.ts`** — `parsePolicyFile` returns an `Allowlist` literal; add `codexAuthenticated: [],` next to its `githubAuthenticated: [],`.
- **`tests/unit/policyFile.test.ts`** — the three `toEqual` expectation objects (they list `claudeAuthenticated`/`githubAuthenticated`); add `codexAuthenticated: [],` to each.
- **`tests/unit/allowlist.test.ts`** — every `parseAllowlist(...)` `toEqual` expectation is a full `Allowlist`; add `codexAuthenticated: [],` to each (search the file for `githubAuthenticated:` — every match needs a sibling `codexAuthenticated:`). Where a case specifically tests codex parsing (the Step 1 additions), set the real value instead of `[]`.
- **`tests/unit/envoyConfig.test.ts`** — the top-of-file `const allowlist: Allowlist = { ... }` and the other in-file `Allowlist` literals; add `codexAuthenticated: []` (or the codex host for the Task 11 case).
- Anything else `pnpm typecheck` flags.

- [ ] **Step 5: Enable Codex in the shipped default allowlist**

`init` copies `current-allow-list.txt` verbatim; today it lists `chatgpt.com:443` under `#pragma passthrough` and has **no** codex section, so a default environment builds no Codex chain. In `current-allow-list.txt`:

- Remove the exact `chatgpt.com:443` line from the passthrough block.
- Keep `*.chatgpt.com:443` in passthrough (other subdomains stay passthrough, per scope).
- Add a codex section (place it after the `#pragma claude authenticated` block):

```
#pragma codex authenticated
chatgpt.com:443
```

Add a regression test to `tests/unit/templates.test.ts` (which already reads the packaged allowlist) asserting the shipped list enables codex and does not double-list the host:

```ts
  it('ships chatgpt.com under codex authenticated, not passthrough', () => {
    const parsed = parseAllowlist(readFileSync(packagedAllowlist(), 'utf8'));
    expect(parsed.codexAuthenticated).toContain('chatgpt.com:443');
    expect(parsed.passthrough).not.toContain('chatgpt.com:443');
    expect(parsed.passthrough).toContain('*.chatgpt.com:443');
  });
```

(Import `parseAllowlist` from `../../src/allowlist`, `packagedAllowlist` from `../../src/templates`, and `readFileSync` from `node:fs` if not already present in the test.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test:unit -- allowlist policyFile templates && pnpm typecheck` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/allowlist.ts src/policyFile.ts current-allow-list.txt tests/unit/allowlist.test.ts tests/unit/policyFile.test.ts tests/unit/envoyConfig.test.ts tests/unit/templates.test.ts
git commit -m "feat(allowlist): add codex authenticated section + enable it by default"
```

---

### Task 11: Envoy filter chain — `buildCodexEntry`

Add a TLS-terminating chain for `chatgpt.com:443` structurally mirroring `buildClaudeEntry`: an **inline** Lua gate (GitHub's precedent — no new mounted file, so `docker-compose.yml` is unchanged), a `credential_injector` pointing at SDS resource `codex_bearer_token` (file `codex-secret.yaml`), and `upgrade_configs: [{ upgrade_type: 'websocket' }]` on this chain's HCM only. Route `timeout: '0s'` (same rationale as Claude). `Cookie` is never referenced, so it passes through untouched. Note (spec): `route.timeout: 0s` bounds only the route timeout, not idle-connection reaping — Envoy's `stream_idle_timeout` (5m default) still applies to the upgraded WebSocket connection. Confirm during the manual end-to-end run that a live upgraded stream is not reaped (same concern already noted for Claude's long-lived streaming); if it is, set `stream_idle_timeout: 0s` on this HCM.

**Decision — exact-host scope is enforced by the curated allowlist, not the parser (codex review finding #2).** `generateEnvoyConfig` builds a codex injection chain for *every* `:443` entry in `codexAuthenticated`, exactly as `buildClaudeEntry` does for `claudeAuthenticated` — neither hard-restricts the host. The spec's "exact `chatgpt.com:443` only" scope is met by the shipped `current-allow-list.txt` (Task 10 Step 5) listing only that host, and by codex injection being opt-in per allowlist entry (symmetric with Claude's trust model). Hard-coding `chatgpt.com` into the parser or `buildCodexEntry` would diverge from that precedent and is intentionally **not** done here. If stricter runtime enforcement is later wanted, the clean place is a `parseAllowlist` warning-and-exclude for non-`chatgpt.com` entries under the codex pragma — call it out before implementing.

**Files:**

- Modify: `src/envoyConfig.ts`
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: `CODEX_PLACEHOLDER_ACCESS_TOKEN` from `../src/codexPlaceholder` (Task 3); `allowlist.codexAuthenticated` (Task 10).
- Produces: codex filter chains + clusters (`cluster_codex_<sanitized host>`) in `generateEnvoyConfig`.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/envoyConfig.test.ts` a codex-focused case (uses a local allowlist with the codex host):

```ts
  it('builds a codex filter chain with an inline lua gate, credential injector, router, and websocket upgrade', () => {
    const codexAllowlist: Allowlist = {
      passthrough: [],
      claudeAuthenticated: [],
      githubAuthenticated: [],
      codexAuthenticated: ['chatgpt.com:443'],
      authCandidate: [],
      warnings: [],
    };
    const config = generateEnvoyConfig(codexAllowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const codexChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('chatgpt.com'),
    );
    expect(codexChain).toBeDefined();

    const hcm = codexChain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);
    // Inline gate (not a mounted file) referencing the placeholder Bearer.
    expect(hcm.http_filters[0].typed_config.default_source_code.inline_string).toContain('Bearer ');
    // Codex-only websocket upgrade support.
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }]);
    // Long-lived streaming: no route timeout.
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');

    const injector = hcm.http_filters[1].typed_config;
    expect(injector.credential.typed_config.credential.name).toBe('codex_bearer_token');
    expect(injector.credential.typed_config.credential.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/codex-secret.yaml',
    );

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_codex_chatgpt_com',
    );
    expect(cluster).toBeDefined();
  });

  it('does not add websocket upgrade support to the claude chain', () => {
    const config = generateEnvoyConfig(allowlist) as any;
    const listener443 = config.static_resources.listeners.find(
      (l: any) => l.name === 'listener_443',
    );
    const claudeChain = listener443.filter_chains.find((fc: any) =>
      fc.filter_chain_match?.server_names?.includes('api.anthropic.com'),
    );
    expect(claudeChain.filters[0].typed_config.upgrade_configs).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- envoyConfig` Expected: FAIL — no codex chain / `cluster_codex_chatgpt_com`.

- [ ] **Step 3: Implement `buildCodexEntry` + the gate + wiring**

In `src/envoyConfig.ts`:

- Add the import at the top:

```ts
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from './codexPlaceholder';
```

- Add the inline gate constant near the GitHub gate constants (exact-match against the placeholder Bearer, same shape as `templates/proxy/gate.lua` but inline):

```ts
// chatgpt.com: exact-match gate accepting only the placeholder Bearer. Emitted inline
// (GitHub's precedent) so docker-compose.yml needs no new mounted gate file. Cookie is
// never read here, so it passes through untouched in both directions.
const CODEX_GATE_LUA = `local PLACEHOLDER = "Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}"

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
```

- Add `buildCodexEntry` right after `buildClaudeEntry`. It is `buildClaudeEntry` with: cluster/stat names `codex`; the Lua gate as `default_source_code: { inline_string: CODEX_GATE_LUA }` (not a filename); the injector `credential.name: 'codex_bearer_token'` and SDS path `/etc/envoy/secrets/codex-secret.yaml`; and `upgrade_configs: [{ upgrade_type: 'websocket' }]` added to the HCM `typed_config`:

```ts
function buildCodexEntry(entry: string, overrides: UpstreamOverride[]) {
  const [sniHost, portStr] = entry.split(':');
  const override = overrides.find((o) => o.sniHost === sniHost);
  const clusterName = `cluster_codex_${sanitizeName(sniHost)}`;

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
          stat_prefix: `codex_${sanitizeName(sniHost)}`,
          access_log: accessLog('term'),
          // Codex prefers wss://chatgpt.com/backend-api/codex/responses; without this the
          // upgrade 403s at the HCM and Codex silently falls back to HTTPS. The gate and
          // injector still run on the upgrade request's headers.
          upgrade_configs: [{ upgrade_type: 'websocket' }],
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'codex',
                domains: ['*'],
                routes: [
                  { match: { prefix: '/' }, route: { cluster: clusterName, timeout: '0s' } },
                ],
              },
            ],
          },
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: CODEX_GATE_LUA },
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
                      name: 'codex_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/codex-secret.yaml',
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

- In `generateEnvoyConfig`, build the codex entries next to `claudeBuilt`:

```ts
  const codexBuilt = allowlist.codexAuthenticated
    .filter((e) => e.endsWith(':443'))
    .map((e) => buildCodexEntry(e, overrides));
```

- Add `...codexBuilt.map((b) => b.filterChain),` to the `filter_chains` array (right after `...claudeBuilt.map(...)`), and `...codexBuilt.map((b) => b.cluster),` to the `clusters` array (right after `...claudeBuilt.map(...)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- envoyConfig && pnpm typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(envoy): add codex chatgpt.com injection chain with websocket upgrade"
```

---

### Task 12: Provision the placeholder `auth.json` at `init`

`initEnvironment` gains a required `codexCredentialsPath` (mirrors `credentialsPath`): read → sanitize → write into both `vm-shared` and `vm-shared-windows`. Validate both credentials before writing anything (a failed init leaves no partial environment). The `init` command gains `--codex-credentials <path>` (default `~/.codex/auth.json`).

**Files:**

- Modify: `src/initEnv.ts`, `src/commands/init.ts`
- Test: `tests/unit/initEnv.test.ts`
- Modify (test call sites, so `init` keeps working): `tests/e2e/init.test.ts`, `tests/e2e/generateCa.test.ts`, `tests/e2e/writeGithubConfig.test.ts`, `tests/e2e/cli.test.ts`, `tests/proxyStack.ts`

**Interfaces:**

- Consumes: `sanitizeCodexCredentials` (Task 5); `VmSharedPaths.authJson` (Task 9).
- Produces: `InitOptions.codexCredentialsPath: string`; `init --codex-credentials <path>`.

- [ ] **Step 1: Update the initEnv unit test**

In `tests/unit/initEnv.test.ts`:

- Add near the top: `const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));`
- Add `codexCredentialsPath: authFixture,` to the `options()` helper defaults (so all existing cases pass it).
- Add these cases:

```ts
  it('writes the sanitized placeholder auth.json into both shared folders', () => {
    initEnvironment(options());
    const root = join(dir, ENV_DIR_NAME);
    for (const folder of ['vm-shared', 'vm-shared-windows']) {
      const auth = readFileSync(join(root, folder, 'auth.json'), 'utf8');
      const parsed = JSON.parse(auth);
      expect(parsed.tokens.account_id, folder).toBe('acct-uuid-1234'); // pass-through
      expect(auth, folder).not.toContain('real.access.token.value'); // secret gone
    }
  });

  it('fails without writing anything when the codex auth file is missing', () => {
    expect(() =>
      initEnvironment(options({ codexCredentialsPath: join(dir, 'nope.json') })),
    ).toThrow('could not read codex credentials');
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });

  it('fails without writing anything when the codex auth file is unparseable', () => {
    const badPath = join(dir, 'bad-auth.json');
    writeFileSync(badPath, '{nope');
    expect(() => initEnvironment(options({ codexCredentialsPath: badPath }))).toThrow(
      'invalid codex auth file',
    );
    expect(existsSync(join(dir, ENV_DIR_NAME))).toBe(false);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- initEnv` Expected: FAIL — `codexCredentialsPath` unknown / no `auth.json` written.

- [ ] **Step 3: Implement `initEnv.ts`**

In `src/initEnv.ts`:

- Add `import { sanitizeCodexCredentials } from './sanitizeCodexCredentials';`
- Add `codexCredentialsPath: string;` to `InitOptions`.
- After the existing Claude read+sanitize block (and before the `cpSync` calls), add the codex read+sanitize (so both are validated before any write):

```ts
  let rawCodex: string;
  try {
    rawCodex = readFileSync(options.codexCredentialsPath, 'utf8');
  } catch {
    throw new Error(
      `could not read codex credentials at ${options.codexCredentialsPath} — log in with the codex CLI first, or pass --codex-credentials`,
    );
  }

  let sanitizedCodex: string;
  try {
    sanitizedCodex = sanitizeCodexCredentials(rawCodex);
  } catch (error) {
    throw new Error(
      `invalid codex auth file at ${options.codexCredentialsPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
```

- In the final write loop, write the codex file alongside credentials:

```ts
  for (const target of paths.vmSharedTargets) {
    writeFileSync(target.credentials, sanitized);
    writeFileSync(target.authJson, sanitizedCodex);
  }
```

- [ ] **Step 4: Implement the `init` command flag**

In `src/commands/init.ts`:

- Add `codexCredentials: string;` to `InitCommandOptions`.
- Add the option:

```ts
    .option(
      '--codex-credentials <path>',
      'Codex auth.json to sanitize into the VM placeholder credential',
      join(homedir(), '.codex', 'auth.json'),
    )
```

- Pass it through: add `codexCredentialsPath: options.codexCredentials,` to the `initEnvironment({ ... })` call.

- [ ] **Step 5: Update the CLI test call sites**

In each of `tests/e2e/init.test.ts`, `tests/e2e/generateCa.test.ts`, `tests/e2e/writeGithubConfig.test.ts`, `tests/e2e/cli.test.ts`, `tests/proxyStack.ts`: define an `authFixture` alongside the existing `credentialsFixture` (same `fileURLToPath(new URL('../fixtures/auth.json', import.meta.url))` pattern — adjust the `..` depth to match each file's existing `credentialsFixture`), and append `'--codex-credentials', authFixture` to every `init` invocation's argument array. In `tests/e2e/init.test.ts` the negative "missing credentials" case (line ~50) passes a missing `--credentials`; leave its `--codex-credentials` pointing at the valid `authFixture` so the test still exercises the Claude-missing path specifically.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test:unit -- initEnv && pnpm typecheck` Expected: PASS. (The e2e suite runs later via `pnpm test:e2e`; verify it in Step 7.)

- [ ] **Step 7: Build + e2e**

Run: `pnpm build && pnpm test:e2e` Expected: PASS (init sites now supply the codex fixture).

- [ ] **Step 8: Commit**

```bash
git add src/initEnv.ts src/commands/init.ts tests/unit/initEnv.test.ts tests/e2e/*.ts tests/proxyStack.ts
git commit -m "feat(init): provision placeholder codex auth.json into vm-shared"
```

---

### Task 13: VM config scripts — link/copy the placeholder `auth.json`

New `09-codex-config.sh` / `09-codex-config.ps1` mirror `08-claude-config` but only handle the credential (no onboarding flag): create `~/.codex` and link (Linux) or copy (Windows) the shared placeholder `auth.json`. Re-running `init` regenerates the shared file; the symlink/copy tracks it. These ship via the existing `cpSync` of the templates dir.

**Files:**

- Create: `templates/vm-shared/09-codex-config.sh`
- Create: `templates/vm-shared-windows/09-codex-config.ps1`
- Test: `tests/unit/initEnv.test.ts` (assert both are copied)

- [ ] **Step 1: Add the failing assertion**

In `tests/unit/initEnv.test.ts`, the first case iterates a list of expected copied files. Add these two entries to that list:

```ts
      'vm-shared/09-codex-config.sh',
      'vm-shared-windows/09-codex-config.ps1',
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- initEnv` Expected: FAIL — the two scripts do not exist yet, so they are not copied.

- [ ] **Step 3: Create `templates/vm-shared/09-codex-config.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.codex"

# Symlink the placeholder credential into place instead of copying it, so it tracks
# the shared auth.json (regenerated whenever the environment is re-initialized)
# rather than snapshotting it. -f replaces any prior file or symlink, so re-running
# is safe. The target lives on the read-only share; the placeholder's access-token
# JWT never expires (exp is year 2100), so Codex never tries to rewrite it.
ln -sfn "${script_dir}/auth.json" "$HOME/.codex/auth.json"

echo "09-codex-config: linked ~/.codex/auth.json -> ${script_dir}/auth.json"
```

- [ ] **Step 4: Create `templates/vm-shared-windows/09-codex-config.ps1`**

```powershell
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$codexDir = Join-Path $env:USERPROFILE '.codex'
New-Item -ItemType Directory -Force -Path $codexDir | Out-Null

# Copy the placeholder credential into place. A plain copy (not a symlink, which needs
# admin/Developer Mode) is safe: the placeholder's access-token JWT never expires, so
# Codex never rewrites it. Re-running after `init` regenerates the file re-copies it.
$src = Join-Path $scriptDir 'auth.json'
Copy-Item -Force $src (Join-Path $codexDir 'auth.json')

Write-Host "09-codex-config: copied placeholder auth.json into $codexDir"
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test:unit -- initEnv` Expected: PASS.

- [ ] **Step 6: Format check (shell/prettier)**

Run: `pnpm format:check` Expected: PASS (prettier-plugin-sh formats the `.sh`; if it reports diffs, run `pnpm format` then re-check).

- [ ] **Step 7: Commit**

```bash
git add templates/vm-shared/09-codex-config.sh templates/vm-shared-windows/09-codex-config.ps1 tests/unit/initEnv.test.ts
git commit -m "feat(vm): link/copy placeholder codex auth.json in the guest"
```

---

### Task 14: `.gitignore` the codex secret

Belt-and-suspenders on top of `.configamatron/` (matching the GitHub secret precedent).

**Files:**

- Modify: `.gitignore`

- [ ] **Step 1: Add the entry**

Under the existing GitHub proxy-credential block in `.gitignore`, add:

```
codex-secret.yaml
```

- [ ] **Step 2: Verify it's ignored**

Run: `git check-ignore codex-secret.yaml` Expected: prints `codex-secret.yaml`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore(gitignore): ignore codex-secret.yaml"
```

---

### Task 15: Wire the Codex channel into `run-proxy`

Add the second channel. `run-proxy` builds both a Claude and a Codex `CredentialChannelConfig` and passes `channels: [claude, codex]`. New flags `--codex-credentials <path>` (default `~/.codex/auth.json`) and `--codex-secret <path>` (default `paths.codexSecret`). The shared `--refresh-window`/`--retry-interval`/`--max-attempts`/`--no-refresh` apply to both channels; each still tracks its own backoff. Both channels are required (a missing/unreadable codex file fatals at startup, same as Claude — parity deferred).

**Files:**

- Modify: `src/commands/runProxy.ts`
- Modify (integration harnesses, so run-proxy boots): `tests/proxyStack.ts`, `tests/integration/runProxy.test.ts`, `tests/integration/runProxyRobustness.test.ts`, `tests/integration/githubInjection.test.ts`
- Test (help output): `tests/e2e/cli.test.ts`

**Interfaces:**

- Consumes: `readCodexCredentials` (Task 4), `nudgeCodexRefresh` (Task 6), `writeSecret` w/ resource name (Task 1), `paths.codexSecret` (Task 9), `CredentialChannelConfig` (Task 7).

- [ ] **Step 1: Add the CLI flags + codex channel in `src/commands/runProxy.ts`**

- Add imports:

```ts
import { readCodexCredentials } from '../runProxy/readCodexCredentials';
import { nudgeCodexRefresh } from '../runProxy/nudgeCodexRefresh';
```

- Add to `RunProxyOptions`: `codexCredentials: string;` and `codexSecret?: string;`.
- Add the options (near `--credentials`/`--secret`):

```ts
    .option(
      '--codex-credentials <path>',
      'Codex auth.json to watch',
      join(homedir(), '.codex', 'auth.json'),
    )
    .option(
      '--codex-secret <path>',
      'Codex SDS secret output path (default: .configamatron/proxy/secrets/codex-secret.yaml)',
    )
```

- Build the two channels and pass them. Replace the Task 8 `claudeChannel` + `runProxyLoop(...)` block with:

```ts
      const refreshWindowMs = Number(options.refreshWindow) * 60_000;
      const retryIntervalMs = Number(options.retryInterval) * 60_000;
      const maxAttempts = Number(options.maxAttempts);

      const claudeChannel: CredentialChannelConfig = {
        name: 'claude',
        credentialsPath: options.credentials,
        secretPath,
        readCredentials,
        writeSecret: (token, path) => writeSecret(token, path, 'sandbox_bearer_token'),
        nudgeRefresh,
        refreshWindowMs,
        retryIntervalMs,
        maxAttempts,
        refreshEnabled: options.refresh,
      };

      const codexChannel: CredentialChannelConfig = {
        name: 'codex',
        credentialsPath: options.codexCredentials,
        secretPath: options.codexSecret ?? paths.codexSecret,
        readCredentials: readCodexCredentials,
        writeSecret: (token, path) => writeSecret(token, path, 'codex_bearer_token'),
        nudgeRefresh: nudgeCodexRefresh,
        refreshWindowMs,
        retryIntervalMs,
        maxAttempts,
        refreshEnabled: options.refresh,
      };

      const exitCode = await runProxyLoop(
        {
          channels: [claudeChannel, codexChannel],
          allowlistPath: paths.allowlist,
          readyTimeoutMs: 60_000,
          drainTimeoutMs: 30_000,
        },
        deps,
      );
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` Expected: PASS.

- [ ] **Step 3: Add the `--codex-credentials` help assertion**

In `tests/e2e/cli.test.ts`, the "lists run-proxy with its flags" test asserts `--credentials`/`--no-refresh`. Add:

```ts
    expect(stdout).toContain('--codex-credentials');
```

- [ ] **Step 4: Give every run-proxy integration harness a valid codex file**

Each integration harness that spawns `run-proxy` must now write a codex `auth.json` with a **decodable** JWT (far-future exp) and pass `--codex-credentials`. Add a helper in each (or import `buildJwt` from `src/jwt`), e.g. in `tests/proxyStack.ts`, `tests/integration/runProxy.test.ts`, `tests/integration/runProxyRobustness.test.ts`, `tests/integration/githubInjection.test.ts`:

```ts
import { buildJwt } from '../../src/jwt'; // adjust depth: '../src/jwt' from tests/proxyStack.ts

function writeCodexAuthFile(path: string, accessToken: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: accessToken,
        refresh_token: 'itest-codex-refresh',
        account_id: 'acct-itest',
      },
      auth_mode: 'chatgpt',
    }),
  );
}
```

In each harness's setup, create the file next to the existing credentials file and add `'--codex-credentials', codexCredentialsPath` to the `run-proxy` args. For suites that do not exercise the codex chain (proxyStack, runProxy, runProxyRobustness, githubInjection), the access token can be any far-future JWT, e.g.:

```ts
  const codexCredentialsPath = join(tempDir, 'auth.json'); // or join(envRoot, 'run-proxy-auth.json') in proxyStack
  writeCodexAuthFile(codexCredentialsPath, buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }));
```

(These suites keep no `#pragma codex authenticated` host in their allowlist, so no codex chain is built — the channel just watches/writes an unused secret. The point is only that startup can read the codex file.)

- [ ] **Step 5: Build + integration (requires Docker)**

Run: `pnpm build && pnpm test:integration` Expected: PASS — existing Claude/GitHub suites still green with the codex channel present. (If Docker is unavailable in this environment, defer to a machine that has it and note it in the commit.)

- [ ] **Step 6: Commit**

```bash
git add src/commands/runProxy.ts tests/e2e/cli.test.ts tests/proxyStack.ts tests/integration/runProxy.test.ts tests/integration/runProxyRobustness.test.ts tests/integration/githubInjection.test.ts
git commit -m "feat(run-proxy): add codex credential channel"
```

---

### Task 16: Integration test — codex injection + WebSocket upgrade

New `tests/integration/codexInjection.test.ts` (mirrors `githubInjection.test.ts`): bring up Envoy with both a fake Claude and a fake Codex credential file, confirm both inject against the mock upstream, confirm a leaked real Bearer from the VM is 403'd on the codex chain, and confirm a WebSocket upgrade through the codex chain reaches the upstream instead of 403ing. Extend `mockUpstream` with a recording upgrade handler.

**Files:**

- Modify: `tests/integration/mockUpstream.ts`
- Create: `tests/integration/codexInjection.test.ts`

**Interfaces:**

- Consumes: `CODEX_PLACEHOLDER_ACCESS_TOKEN` (Task 3); `buildJwt` (Task 2); `MockUpstream`.

- [ ] **Step 1: Extend `mockUpstream` to record upgrades**

In `tests/integration/mockUpstream.ts`, add `receivedUpgradeAuthorizationHeaders: string[]` to the `MockUpstream` interface and, in `startMockUpstream`, register a handler that records the header and completes a minimal 101 handshake (so Envoy's websocket upgrade proxying has a peer that accepts it):

```ts
  const receivedUpgradeAuthorizationHeaders: string[] = [];
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.end();
  });
```

Return `receivedUpgradeAuthorizationHeaders` in the resolved object and add it to the interface. (The plain-HTTP request handler and `receivedAuthorizationHeaders` are unchanged, so `githubInjection`/`runProxy` suites are unaffected.)

- [ ] **Step 2: Write the test**

Create `tests/integration/codexInjection.test.ts`. Structure mirrors `githubInjection.test.ts` (init → stage allowlist with a codex section → generate-ca → pre-seed the codex secret via run-proxy watching a real-JWT auth.json → assert). Key pieces:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa, type ResultPromise } from 'execa';
import { createInterface } from 'node:readline';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree } from '../../src/runProxy/killProcessTree';
import { rmEnvRoot } from '../rmEnvRoot';
import { buildJwt } from '../../src/jwt';
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from '../../src/codexPlaceholder';
import { startMockUpstream, stopMockUpstream, type MockUpstream } from './mockUpstream';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliPath = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const credentialsFixture = fileURLToPath(new URL('../fixtures/credentials.json', import.meta.url));
const authFixture = fileURLToPath(new URL('../fixtures/auth.json', import.meta.url));
const envRoot = join(repoRoot, '.configamatron');
const proxyDir = join(envRoot, 'proxy');

// Distinct from the other integration suites' ports.
const HTTPS_PORT = 18449;
const HTTP_PORT = 18186;
const envoyEnv = { ENVOY_HTTPS_PORT: String(HTTPS_PORT), ENVOY_HTTP_PORT: String(HTTP_PORT) };

const REAL_CODEX_TOKEN = buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
const REAL_CODEX_BEARER = `Bearer ${REAL_CODEX_TOKEN}`;

let mockUpstream: MockUpstream;
let tempDir: string;
let codexCredentialsPath: string;
let claudeCredentialsPath: string;
let caCertPem: string;
let proxyProc: ResultPromise | null = null;
const stdoutLines: string[] = [];

function writeCodexAuth(token: string): void {
  writeFileSync(
    codexCredentialsPath,
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: buildJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }),
        access_token: token,
        refresh_token: 'itest-refresh',
        account_id: 'acct-itest',
      },
      auth_mode: 'chatgpt',
    }),
  );
}

async function waitForLine(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (stdoutLines.some((l) => l.includes(needle))) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for '${needle}'\n${stdoutLines.join('\n')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function requestThrough(servername: string, authorization: string): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path: '/', headers: { authorization } },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Raw TLS upgrade request; resolves with the first response line (e.g. "HTTP/1.1 101 ..."). */
function upgradeThrough(servername: string, authorization: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem },
      () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            `Authorization: ${authorization}\r\n\r\n`,
        );
      },
    );
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\r\n')) {
        resolve(buf.split('\r\n')[0]);
        socket.end();
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => reject(new Error('upgrade timed out')));
  });
}

beforeAll(async () => {
  mockUpstream = await startMockUpstream();
  tempDir = mkdtempSync(join(tmpdir(), 'codex-inj-'));
  claudeCredentialsPath = join(tempDir, '.credentials.json');
  codexCredentialsPath = join(tempDir, 'auth.json');
  writeFileSync(
    claudeCredentialsPath,
    JSON.stringify({ claudeAiOauth: { accessToken: 'claude-int', expiresAt: Date.now() + 86400000 } }),
  );
  writeCodexAuth(REAL_CODEX_TOKEN);

  await rmEnvRoot(envRoot);
  await execa('node', [
    cliPath, 'init', '--credentials', credentialsFixture, '--codex-credentials', authFixture,
  ], { cwd: repoRoot });

  writeFileSync(
    join(proxyDir, 'allowlist.txt'),
    ['#pragma claude authenticated', 'api.anthropic.com:443', '',
     '#pragma codex authenticated', 'chatgpt.com:443', ''].join('\n'),
  );
  await execa('node', [cliPath, 'generate-ca'], { cwd: repoRoot });

  proxyProc = execa(
    'node',
    [
      cliPath, 'run-proxy', '--no-refresh', '--no-forward',
      '--credentials', claudeCredentialsPath,
      '--codex-credentials', codexCredentialsPath,
      '--upstream-override', `api.anthropic.com=host.docker.internal:${mockUpstream.port}`,
      '--upstream-override', `chatgpt.com=host.docker.internal:${mockUpstream.port}`,
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
  if (proxyProc?.pid !== undefined) await killProcessTree(proxyProc.pid, 'SIGINT');
  try { await proxyProc; } catch { /* ignore */ }
  await execa('docker', ['compose', 'down'], { cwd: proxyDir, env: { ...process.env, ...envoyEnv }, reject: false });
  await stopMockUpstream(mockUpstream);
  rmSync(tempDir, { recursive: true, force: true });
}, 60000);

describe('chatgpt.com codex Bearer injection', () => {
  it('injects the real token when the placeholder Bearer is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`);
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_CODEX_BEARER]);
  });

  it('403s a leaked real Bearer that is not the placeholder', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });

  it('still injects on the claude chain (both channels live)', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('api.anthropic.com', 'Bearer sk-ant-oat-SANDBOX-PLACEHOLDER');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual(['Bearer claude-int']);
  });

  it('proxies a WebSocket upgrade to the upstream with the injected token (no 403 fallback)', async () => {
    const before = mockUpstream.receivedUpgradeAuthorizationHeaders.length;
    const statusLine = await upgradeThrough('chatgpt.com', `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`);
    expect(statusLine).toContain('101');
    expect(mockUpstream.receivedUpgradeAuthorizationHeaders.slice(before)).toEqual([REAL_CODEX_BEARER]);
  });
});
```

Note: the claude-chain assertion uses `sk-ant-oat-SANDBOX-PLACEHOLDER` (Claude's placeholder) and expects `Bearer claude-int` (the token written to `claudeCredentialsPath`).

- [ ] **Step 3: Build + run the new suite (requires Docker)**

Run: `pnpm build && pnpm test:integration -- codexInjection` Expected: PASS — both chains inject, the leaked Bearer 403s, and the upgrade reaches the upstream (status line `101`, injected token recorded). If the upgrade case is flaky under the local Envoy build, confirm the manual end-to-end path (spec "Manual") and keep the injection/403 assertions as the gating ones.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/mockUpstream.ts tests/integration/codexInjection.test.ts
git commit -m "test(integration): codex injection + websocket upgrade through the proxy"
```

---

## Final Verification

- [ ] **Run the full gate:** `pnpm test` (format, lint, typecheck, unit, build, e2e, integration). Expected: PASS. (Integration requires Docker; run on a Docker-capable machine.)
- [ ] **Manual (spec "Manual"):** in a real sandboxed VM, run `codex exec "<prompt>"` and an interactive session through the real proxy; confirm the injected credential works and that the WebSocket path no longer falls back to HTTPS (watch the access log — the codex chain should serve the upgraded connection rather than 403ing it).
- [ ] **Refresh behavior (spec):** `nudgeCodexRefresh`'s real refresh-on-near-expiry can only be confirmed by observing a real proxy run up to a real token's expiry window — not faked in tests, same as `nudgeRefresh` today.
