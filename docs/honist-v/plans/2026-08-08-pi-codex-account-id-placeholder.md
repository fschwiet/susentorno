# Pi Codex Account-ID Placeholder Implementation Plan

**Goal:** Fix the Pi Coding Agent's unconditional `Error: Failed to extract accountId from token` crash by adding a `chatgpt_account_id` claim to the shared codex placeholder JWT, and inject the real account id at the proxy — mirroring how the real Codex bearer token is already injected — instead of leaking a fictitious value alongside the real bearer token.

**Architecture:** The guest-side placeholder JWT gains a fixed, meaningless `chatgpt_account_id` claim so Pi's local JWT decode succeeds. The proxy's existing `chatgpt.com` filter chain gains a second `credential_injector` targeting the `chatgpt-account-id` header, coupled to the existing `Authorization` recognition via a marker/sentinel pair mirroring the one already used for "genuinely no Authorization sent" — so the real account id is only ever attached to the same requests that get the real bearer token, never to a foreign or missing credential. The real account id is read from the host's `~/.codex/auth.json` on the same cadence the bearer token already uses (no new polling/timer machinery).

**Tech Stack:** TypeScript (Node.js), Envoy proxy (Lua filters + file-based SDS secrets), Vitest, `jq` (guest-side settings transforms).

## Global Constraints

- Placeholder JWTs must remain structurally valid 3-segment JWTs so guest clients never decide they need to refresh (existing invariant, unchanged).
- The guest must never hold a real/usable credential — every real value is injected only at the proxy (ADR 0002).
- The pinned Envoy image is `v1.31`, which predates a trailing-newline fix for file-based generic secrets — SDS YAML must keep the exact quoted `inline_string: "..."` shape used by the existing `formatSecret`.
- Every authenticated chain's Lua pre-filter must strip any inbound copy of an internal marker header before using it — a client-sent request must never be able to forge one (existing invariant for `NO_AUTH_MARKER_HEADER`, now also applies to the new marker).
- Widening `CredentialChannelConfig.writeSecret`'s signature must not change the Claude channel's behavior.

---

## Task 1: Add the missing `chatgpt_account_id` claim to the shared codex placeholder

**Files:**

- Modify: `src/codexPlaceholder.ts`
- Test: `tests/unit/codexPlaceholder.test.ts`

**Interfaces:**

- Produces: `CODEX_PLACEHOLDER_ACCOUNT_ID: string` (new export from `src/codexPlaceholder.ts`), consumed by Task 2 (regenerating the `.jq` literal), Task 3 (`sanitizeCodexCredentials.ts`), and Task 9 (`CODEX_GATE_LUA`'s post-review-fixed coupling logic — note: per the design, the gate does **not** compare against this constant, it strips unconditionally when the bearer is recognized, but the constant is still needed by `sanitizeCodexCredentials.ts` and the `.jq` template).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/codexPlaceholder.test.ts` (full new file content):

```ts
import { describe, it, expect } from 'vitest';
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  CODEX_PLACEHOLDER_EXP_SECONDS,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';
import { decodeJwtClaims, jwtExpMs } from '../../src/jwt';

describe('Codex placeholder credential constants', () => {
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

  it('documents the exact claim set carried by the placeholder access/id tokens', () => {
    const expectedClaims = {
      sub: 'susentorno-user',
      email: 'susentorno@susentorno.invalid',
      exp: 4102444800,
      'https://api.openai.com/auth': {
        chatgpt_account_id: CODEX_PLACEHOLDER_ACCOUNT_ID,
      },
    };
    expect(decodeJwtClaims(CODEX_PLACEHOLDER_ACCESS_TOKEN)).toEqual(expectedClaims);
    expect(decodeJwtClaims(CODEX_PLACEHOLDER_ID_TOKEN)).toEqual(expectedClaims);
  });

  it('account id placeholder is a fixed, non-empty, obviously-fake string', () => {
    expect(CODEX_PLACEHOLDER_ACCOUNT_ID).toBe('susentorno-placeholder-account-id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/codexPlaceholder.test.ts`
Expected: FAIL — `CODEX_PLACEHOLDER_ACCOUNT_ID` is not exported from `src/codexPlaceholder.ts`, and the "documents the exact claim set" test fails because the current `PLACEHOLDER_CLAIMS` has no `https://api.openai.com/auth` key.

- [ ] **Step 3: Implement**

Replace the full content of `src/codexPlaceholder.ts`:

```ts
import { buildJwt } from './jwt';

/** ~ year 2100 in epoch **seconds** — far past any real session, mirroring Claude's placeholder expiry. */
export const CODEX_PLACEHOLDER_EXP_SECONDS = 4102444800;

/**
 * Placeholder account id, never a real account. Pi Coding Agent's OpenAI-Codex
 * provider decodes this claim on *every* request and sets it as the `chatgpt-account-id`
 * header, throwing "Failed to extract accountId from token" if it's absent — so it must
 * be present for Pi to run at all. The proxy's CODEX_GATE_LUA (src/envoyConfig.ts)
 * strips this header unconditionally whenever it recognizes the placeholder Bearer
 * token, so the real account id (not this value) is what actually reaches OpenAI.
 */
export const CODEX_PLACEHOLDER_ACCOUNT_ID = 'susentorno-placeholder-account-id';

const PLACEHOLDER_CLAIMS = {
  sub: 'susentorno-user',
  email: 'susentorno@susentorno.invalid',
  exp: CODEX_PLACEHOLDER_EXP_SECONDS,
  'https://api.openai.com/auth': { chatgpt_account_id: CODEX_PLACEHOLDER_ACCOUNT_ID },
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
export const CODEX_PLACEHOLDER_REFRESH_TOKEN = 'susentorno-placeholder-codex-refresh-token';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/codexPlaceholder.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/codexPlaceholder.ts tests/unit/codexPlaceholder.test.ts
git commit -m "feat(codex): add chatgpt_account_id claim to the shared placeholder JWT"
```

---

## Task 2: Regenerate the stale `.jq` literal and add a drift-guard test

**Files:**

- Modify: `templates/home-jq-transforms/pi-openai-codex-auth.jq`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: `CODEX_PLACEHOLDER_ACCESS_TOKEN` from Task 1.

- [ ] **Step 1: Write the failing test**

Add this `it` inside the existing `describe('home settings transform manifest', ...)` block in `tests/unit/templates.test.ts` (the block currently ends around line 213 — add before its closing `});`):

```ts
    it('pi-openai-codex-auth.jq mounts the exact same placeholder access token literal as CODEX_PLACEHOLDER_ACCESS_TOKEN', () => {
      const jq = readFileSync(
        join(templatesDir(), 'home-jq-transforms', 'pi-openai-codex-auth.jq'),
        'utf8',
      );
      expect(jq).toContain(`"access": "${CODEX_PLACEHOLDER_ACCESS_TOKEN}"`);
    });
```

Add this import at the top of `tests/unit/templates.test.ts`, alongside the existing imports:

```ts
import { CODEX_PLACEHOLDER_ACCESS_TOKEN } from '../../src/codexPlaceholder';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/templates.test.ts -t "pi-openai-codex-auth.jq mounts"`
Expected: FAIL — the `.jq` file's current literal decodes to `configamatron-user`/no `chatgpt_account_id` claim, so it doesn't match the new `CODEX_PLACEHOLDER_ACCESS_TOKEN`.

- [ ] **Step 3: Implement**

Replace the full content of `templates/home-jq-transforms/pi-openai-codex-auth.jq`:

```
# "access" must stay byte-identical to CODEX_PLACEHOLDER_ACCESS_TOKEN in
# src/codexPlaceholder.ts (docs/adr/0018) — the proxy's chatgpt.com gate matches this
# exact literal to inject the codex host credential channel's real token and real
# account id. "expires" is a far-future epoch-ms so Pi's own client never decides the
# token needs refreshing. tests/unit/templates.test.ts asserts this stays in sync.
.["openai-codex"] = {
  "type": "oauth",
  "access": "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzdXNlbnRvcm5vLXVzZXIiLCJlbWFpbCI6InN1c2VudG9ybm9Ac3VzZW50b3Juby5pbnZhbGlkIiwiZXhwIjo0MTAyNDQ0ODAwLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoic3VzZW50b3Juby1wbGFjZWhvbGRlci1hY2NvdW50LWlkIn19.susentorno-not-a-real-signature",
  "refresh": "susentorno-placeholder-pi-refresh-token",
  "expires": 4102444800000,
  "accountId": "susentorno-placeholder-account-id"
}
```

(This literal is `buildJwt(PLACEHOLDER_CLAIMS)` from Task 1 — verified by the test in Step 4, not by hand.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/templates.test.ts`
Expected: PASS (all tests in the file, including the new one)

- [ ] **Step 5: Commit**

```bash
git add templates/home-jq-transforms/pi-openai-codex-auth.jq tests/unit/templates.test.ts
git commit -m "fix(codex): regenerate stale pi-openai-codex-auth.jq placeholder literal and guard against future drift"
```

---

## Task 3: Placeholder `tokens.account_id` in `sanitizeCodexCredentials.ts`

**Files:**

- Modify: `src/sanitizeCodexCredentials.ts`
- Modify: `tests/unit/sanitizeCodexCredentials.test.ts`
- Modify: `tests/unit/initEnv.test.ts`

**Interfaces:**

- Consumes: `CODEX_PLACEHOLDER_ACCOUNT_ID` from Task 1.

- [ ] **Step 1: Write the failing test**

In `tests/unit/sanitizeCodexCredentials.test.ts`, update the import block to add `CODEX_PLACEHOLDER_ACCOUNT_ID`:

```ts
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from '../../src/codexPlaceholder';
```

Replace the two lines:

```ts
    // Pass-through: account_id, auth_mode, OPENAI_API_KEY untouched.
    expect(parsed.tokens.account_id).toBe('acct-uuid-1234');
```

with:

```ts
    // account_id is now placeholdered too — no real value ever enters the guest.
    expect(parsed.tokens.account_id).toBe(CODEX_PLACEHOLDER_ACCOUNT_ID);
    // auth_mode, OPENAI_API_KEY still pass through untouched.
```

In `tests/unit/initEnv.test.ts`, add this import near the top (alongside the existing imports):

```ts
import { CODEX_PLACEHOLDER_ACCOUNT_ID } from '../../src/codexPlaceholder';
```

Replace:

```ts
        expect(parsed.tokens.account_id, folder).toBe('acct-uuid-1234'); // pass-through
```

with:

```ts
        expect(parsed.tokens.account_id, folder).toBe(CODEX_PLACEHOLDER_ACCOUNT_ID);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/sanitizeCodexCredentials.test.ts tests/unit/initEnv.test.ts`
Expected: FAIL — both now expect `CODEX_PLACEHOLDER_ACCOUNT_ID` but the real fixture value `'acct-uuid-1234'`/`'real.access.token.value'`-adjacent real id still passes through today.

- [ ] **Step 3: Implement**

In `src/sanitizeCodexCredentials.ts`, update the import:

```ts
import {
  CODEX_PLACEHOLDER_ACCESS_TOKEN,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  CODEX_PLACEHOLDER_ID_TOKEN,
  CODEX_PLACEHOLDER_REFRESH_TOKEN,
} from './codexPlaceholder';
```

Update the doc comment and body:

```ts
/**
 * Turn a real ~/.codex/auth.json into the VM placeholder copy: the four fields under
 * `tokens` become placeholders (access/id are far-future placeholder JWTs so the VM's
 * Codex never tries to refresh; refresh_token is a fixed dummy; account_id is a fixed
 * placeholder string — the proxy injects the real one into the chatgpt-account-id
 * header, so the guest never needs to hold it). Everything else — auth_mode,
 * OPENAI_API_KEY — passes through so the file matches the user's real account shape.
 * Output is pretty-printed JSON, LF line endings only.
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
  record.account_id = CODEX_PLACEHOLDER_ACCOUNT_ID;

  return JSON.stringify(parsed, null, 2) + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/sanitizeCodexCredentials.test.ts tests/unit/initEnv.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sanitizeCodexCredentials.ts tests/unit/sanitizeCodexCredentials.test.ts tests/unit/initEnv.test.ts
git commit -m "fix(codex): placeholder tokens.account_id instead of passing the real value into the guest"
```

---

## Task 4: Extend `Credentials` and `readCodexCredentials` with `accountId`

**Files:**

- Modify: `src/runHosting/types.ts`
- Modify: `src/runHosting/readCodexCredentials.ts`
- Modify: `tests/unit/readCodexCredentials.test.ts`

**Interfaces:**

- Produces: `Credentials.accountId?: string` (new optional field; only `readCodexCredentials` ever populates it — `readCredentials.ts` for Claude leaves it `undefined`). Consumed by Task 6 (widened `writeSecret`) and Task 7 (the codex `writeSecret` closure).

- [ ] **Step 1: Write the failing test**

Replace the full content of `tests/unit/readCodexCredentials.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCodexCredentials } from '../../src/runHosting/readCodexCredentials';
import { buildJwt } from '../../src/jwt';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-hosting-codex-creds-'));
  path = join(dir, 'auth.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAuth(tokens: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ OPENAI_API_KEY: null, tokens, auth_mode: 'chatgpt' }));
}

describe('credential reading — codex credential channel (JWT exp + account id)', () => {
  it('returns the access token, its JWT exp (in ms), and the account id from tokens', () => {
    const access = buildJwt({ exp: 1_700_000_000 });
    writeAuth({ access_token: access, account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toEqual({
      accessToken: access,
      expiresAt: 1_700_000_000 * 1000,
      accountId: 'acct-1',
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
    writeAuth({ access_token: buildJwt({ sub: 'x' }), account_id: 'acct-1' });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when tokens.account_id is missing', () => {
    writeAuth({ access_token: buildJwt({ exp: 1_700_000_000 }) });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null when tokens.account_id is an empty string', () => {
    writeAuth({ access_token: buildJwt({ exp: 1_700_000_000 }), account_id: '' });
    expect(readCodexCredentials(path)).toBeNull();
  });

  it('returns null for a non-chatgpt (api_key) auth file', () => {
    writeFileSync(
      path,
      JSON.stringify({
        OPENAI_API_KEY: 'sk-real-api-key',
        tokens: { access_token: buildJwt({ exp: 1_700_000_000 }), account_id: 'acct-1' },
        auth_mode: 'api_key',
      }),
    );
    expect(readCodexCredentials(path)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/readCodexCredentials.test.ts`
Expected: FAIL — the first test's `toEqual` now expects an `accountId` field the function doesn't return; the two new "account_id is missing/empty" tests expect `null` but the function currently returns a valid result regardless of `account_id`.

- [ ] **Step 3: Implement**

Update `src/runHosting/types.ts` — add `accountId` to `Credentials`:

```ts
export interface Credentials {
  /** OAuth access token injected into the VM's requests. */
  accessToken: string;
  /** Absolute expiry, epoch milliseconds. */
  expiresAt: number;
  /**
   * Real account id for the codex host-credential channel, injected into the
   * `chatgpt-account-id` header at the proxy. Only `readCodexCredentials` populates
   * this; Claude's `readCredentials` leaves it `undefined`.
   */
  accountId?: string;
}
```

Replace the full content of `src/runHosting/readCodexCredentials.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { Credentials } from './types';
import { jwtExpMs } from '../jwt';

/**
 * Read and parse ~/.codex/auth.json into the source-agnostic Credentials shape. The
 * access token is a JWT whose `exp` claim carries expiry (no separate field like
 * Claude's expiresAt). tokens.account_id is required too — it's read fresh alongside
 * the access token so the proxy's injected chatgpt-account-id header can never go
 * stale relative to the injected bearer token, even across a full re-login as a
 * different account. Returns null on any failure — missing file, invalid JSON from a
 * partial mid-write read, missing tokens.access_token, missing/empty
 * tokens.account_id, or a JWT with no decodable numeric `exp` — so the caller can skip
 * the event and wait for the next write.
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
    | { access_token?: unknown; account_id?: unknown }
    | undefined;
  if (!tokens || typeof tokens.access_token !== 'string') return null;
  if (typeof tokens.account_id !== 'string' || tokens.account_id.length === 0) return null;

  const expiresAt = jwtExpMs(tokens.access_token);
  if (expiresAt === null) return null;

  return { accessToken: tokens.access_token, expiresAt, accountId: tokens.account_id };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/readCodexCredentials.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full unit suite to check for collateral breakage**

Run: `npx vitest run tests/unit`
Expected: Some failures in `tests/unit/proxyStackSupervisor.test.ts` and `tests/unit/credentialChannel.test.ts` are possible here only if they construct a `Credentials` object missing `accountId` where TypeScript would complain — `accountId` is optional, so this should still compile and pass. Confirm no new failures beyond what Task 3 already touched.

- [ ] **Step 6: Commit**

```bash
git add src/runHosting/types.ts src/runHosting/readCodexCredentials.ts tests/unit/readCodexCredentials.test.ts
git commit -m "feat(codex): require and surface account_id in readCodexCredentials"
```

---

## Task 5: Add `formatPlainSecret`/`writePlainSecret`

**Files:**

- Modify: `src/runHosting/writeSecret.ts`
- Modify: `tests/unit/writeSecret.test.ts`

**Interfaces:**

- Produces: `formatPlainSecret(value: string, resourceName: string): string`, `writePlainSecret(value: string, path: string, resourceName: string): void`. Consumed by Task 7 (`runHosting.ts`'s codex `writeSecret` closure).
- `formatSecret`'s and `writeSecret`'s existing public signatures and byte-for-byte output are unchanged (verified by the existing tests, which must still pass unmodified).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/writeSecret.test.ts` (append after the existing two `it`s, inside the same `describe`):

```ts
  it('formatPlainSecret emits the SDS secret structure with an unprefixed inline_string', () => {
    expect(formatPlainSecret('acct-uuid-1234', 'codex_account_id')).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: codex_account_id',
        '    generic_secret:',
        '      secret:',
        '        inline_string: "acct-uuid-1234"',
        '',
      ].join('\n'),
    );
  });

  it('formatSecret is formatPlainSecret with a Bearer prefix', () => {
    expect(formatSecret('tok', 'r')).toBe(formatPlainSecret('Bearer tok', 'r'));
  });
```

Update the import line at the top of the file:

```ts
import { formatPlainSecret, formatSecret } from '../../src/runHosting/writeSecret';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/writeSecret.test.ts`
Expected: FAIL — `formatPlainSecret` is not exported yet.

- [ ] **Step 3: Implement**

Replace the full content of `src/runHosting/writeSecret.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Render an Envoy file-based SDS secret carrying `value` verbatim as a `generic_secret`
 * under `resourceName`. Each Envoy SDS subscription watches its own single-resource
 * file, so the resource name is chosen by the caller (Claude uses
 * `susentorno_bearer_token`, Codex's bearer token uses `codex_bearer_token`, Codex's
 * account id uses `codex_account_id`). The pinned Envoy image (v1.31) predates a
 * trailing-newline fix for file-based generic secrets, so this exact quoted
 * `inline_string: "..."` shape matters — do not reformat it.
 */
export function formatPlainSecret(value: string, resourceName: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    `    name: ${resourceName}`,
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${value}"`,
    '',
  ].join('\n');
}

/** Same as formatPlainSecret, but for a bearer token — the `Bearer ` prefix is added here so every Authorization-header caller doesn't have to remember to add it themselves. */
export function formatSecret(token: string, resourceName: string): string {
  return formatPlainSecret(`Bearer ${token}`, resourceName);
}

export function writePlainSecret(value: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatPlainSecret(value, resourceName));
}

export function writeSecret(token: string, path: string, resourceName: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, formatSecret(token, resourceName));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/writeSecret.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/runHosting/writeSecret.ts tests/unit/writeSecret.test.ts
git commit -m "feat(secrets): add formatPlainSecret/writePlainSecret for non-bearer SDS values"
```

---

## Task 6: Widen `CredentialChannelConfig.writeSecret` to take the full `Credentials`

**Files:**

- Modify: `src/runHosting/credentialChannel.ts`
- Modify: `tests/unit/credentialChannel.test.ts`
- Modify: `tests/unit/proxyStackSupervisor.test.ts`

**Interfaces:**

- Consumes: `Credentials` from Task 4.
- Produces: `CredentialChannelConfig.writeSecret: (creds: Credentials, path: string) => void` (was `(token: string, path: string) => void`). Consumed by Task 7 (`runHosting.ts`'s two `writeSecret` closures).

- [ ] **Step 1: Write the failing test**

In `tests/unit/credentialChannel.test.ts`, replace these two lines:

```ts
      expect(mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/secret.yaml');
```

(there are two occurrences, one in the `startupRead` test and one in the `prepareRestart` test — update both) with the widened-signature equivalents:

```ts
      expect(mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'A', expiresAt: 60 * MIN },
        '/fake/secret.yaml',
      );
```

and:

```ts
      expect(mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'B', expiresAt: 60 * MIN },
        '/fake/secret.yaml',
      );
```

respectively (match each to the `creds.value` set immediately above it in that test).

In `tests/unit/proxyStackSupervisor.test.ts`:

Replace the `writeSecret` type in the `claudeChannelConfig` helper's `mocks` parameter (around line 28):

```ts
    writeSecret: (creds: Credentials, path: string) => void;
```

Replace the `writeSecret` type in the `Harness.mocks` interface (around line 72):

```ts
    writeSecret: ReturnType<typeof vi.fn<(creds: Credentials, path: string) => void>>;
```

Replace the mock construction (around line 114):

```ts
    writeSecret: vi.fn<(creds: Credentials, path: string) => void>(),
```

Replace the three assertions:

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('A', '/fake/sds-secret.yaml');
```

(line ~227, in the startup test — the harness's initial creds are `{ accessToken: 'A', expiresAt: 60 * MIN }`) with:

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'A', expiresAt: 60 * MIN },
        '/fake/sds-secret.yaml',
      );
```

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
```

(line ~426, in the credential-change test — `h.creds.value` was just set to `{ accessToken: 'B', expiresAt: 60 * MIN }`) with:

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'B', expiresAt: 60 * MIN },
        '/fake/sds-secret.yaml',
      );
```

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith('B', '/fake/sds-secret.yaml');
      expect(codexWrite).toHaveBeenCalledWith('Y', '/fake/codex-secret.yaml');
```

(line ~779-780, in the "multiple credential channels" test — `h.creds.value` is `{ accessToken: 'B', expiresAt: 60 * MIN }`, `codexCreds.value` is `{ accessToken: 'Y', expiresAt: 60 * MIN }`) with:

```ts
      expect(h.mocks.writeSecret).toHaveBeenCalledWith(
        { accessToken: 'B', expiresAt: 60 * MIN },
        '/fake/sds-secret.yaml',
      );
      expect(codexWrite).toHaveBeenCalledWith(
        { accessToken: 'Y', expiresAt: 60 * MIN },
        '/fake/codex-secret.yaml',
      );
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/credentialChannel.test.ts tests/unit/proxyStackSupervisor.test.ts`
Expected: FAIL — `CredentialChannel` still calls `writeSecret` with just the token string, not the full `Credentials` object, so the updated assertions don't match yet.

- [ ] **Step 3: Implement**

In `src/runHosting/credentialChannel.ts`, update the `CredentialChannelConfig` interface:

```ts
export interface CredentialChannelConfig {
  name: string;
  credentialsPath: string;
  secretPath: string;
  readCredentials: (path: string) => Credentials | null;
  writeSecret: (creds: Credentials, path: string) => void;
  nudgeRefresh: () => Promise<NudgeResult>;
  refreshWindowMs: number;
  retryIntervalMs: number;
  maxAttempts: number;
  refreshEnabled: boolean;
}
```

Update `startupRead()`:

```ts
  startupRead(): Credentials | null {
    const creds = this.config.readCredentials(this.config.credentialsPath);
    if (creds === null) return null;
    this.config.writeSecret(creds, this.config.secretPath);
    this.pendingToken = creds.accessToken;
    this.lastReadCreds = creds;
    this.lastSeenExpiresAt = creds.expiresAt;
    return creds;
  }
```

Update `prepareRestart()`'s `writeSecret` call:

```ts
    let restartNeeded = false;
    if (plan.propagate) {
      this.config.writeSecret(creds, this.config.secretPath);
      this.pendingToken = creds.accessToken;
      restartNeeded = true;
    }
```

(Only the `writeSecret(...)` call argument changes in both methods — everything else in `credentialChannel.ts` is untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/credentialChannel.test.ts tests/unit/proxyStackSupervisor.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full unit suite**

Run: `npx vitest run tests/unit`
Expected: PASS — this is the last place `writeSecret`'s old signature was assumed inside test doubles; `src/commands/runHosting.ts`'s real closures haven't been updated yet (Task 7), so `npx tsc --noEmit` may still show a type error there until Task 7 lands — that's expected and fixed next.

- [ ] **Step 6: Commit**

```bash
git add src/runHosting/credentialChannel.ts tests/unit/credentialChannel.test.ts tests/unit/proxyStackSupervisor.test.ts
git commit -m "refactor(credentials): widen CredentialChannelConfig.writeSecret to take full Credentials"
```

---

## Task 7: Wire the real account id secret into `run-hosting`

**Files:**

- Modify: `src/envPaths.ts`
- Modify: `src/commands/runHosting.ts`

**Interfaces:**

- Consumes: `writePlainSecret` from Task 5; the widened `writeSecret` signature from Task 6; `Credentials.accountId` from Task 4.
- Produces: `EnvPaths.codexAccountIdSecret: string`, and the file `<envRoot>/proxy/secrets/codex-account-id-secret.yaml` at runtime. Consumed by Task 9's Envoy config (the new `credential_injector`'s SDS path must match this file's mount path exactly: `/etc/envoy/secrets/codex-account-id-secret.yaml`).

- [ ] **Step 1: Write the failing test**

There is no existing unit test file for `envPaths.ts`'s path shape beyond `tests/unit/envPaths.test.ts` — check it first:

Run: `npx vitest run tests/unit/envPaths.test.ts --reporter=verbose` to see its current assertions, then add a new `it` alongside whatever pattern it already uses for `codexSecret`, e.g.:

```ts
  it('includes a codexAccountIdSecret path alongside codexSecret', () => {
    const paths = envPaths('/fake/cwd');
    expect(paths.codexAccountIdSecret).toBe(
      join('/fake/cwd', '.susentorno', 'proxy', 'secrets', 'codex-account-id-secret.yaml'),
    );
  });
```

(Match the exact style/imports already used in that file — read it first and mirror its existing `codexSecret`-style assertion precisely; if the file asserts on the whole `EnvPaths` object with `toEqual` instead of per-field `it`s, add `codexAccountIdSecret` to that expected object instead of writing a new standalone `it`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/envPaths.test.ts`
Expected: FAIL — `codexAccountIdSecret` doesn't exist on `EnvPaths` yet.

- [ ] **Step 3: Implement — `envPaths.ts`**

Add `codexAccountIdSecret: string;` to the `EnvPaths` interface, immediately after `codexSecret: string;`:

```ts
export interface EnvPaths {
  root: string;
  vmShared: string;
  vmSharedWindows: string;
  vmSharedTargets: VmSharedPaths[];
  homeJqTransforms: string;
  preScripts: string;
  postScripts: string;
  gitignore: string;
  proxy: string;
  allowList: string;
  authList: string;
  blockList: string;
  mcpServers: string;
  envoyConfig: string;
  caDir: string;
  caCert: string;
  caKey: string;
  caLeafCert: string;
  caLeafKey: string;
  secretsDir: string;
  sdsSecret: string;
  codexSecret: string;
  codexAccountIdSecret: string;
  githubBasicSecret: string;
  githubApiTokenSecret: string;
  vmCert: string;
  vmCredentials: string;
  githubConfig: string;
}
```

Add the corresponding entry to `envPaths()`'s return object, immediately after `codexSecret`:

```ts
    codexSecret: join(proxy, 'secrets', 'codex-secret.yaml'),
    codexAccountIdSecret: join(proxy, 'secrets', 'codex-account-id-secret.yaml'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/envPaths.test.ts`
Expected: PASS

- [ ] **Step 5: Update `src/commands/runHosting.ts`'s writeSecret closures**

Add `writePlainSecret` to the existing `writeSecret` import:

```ts
import { writeSecret, writePlainSecret } from '../runHosting/writeSecret';
```

Replace the two `CredentialChannelConfig` objects:

```ts
        const claudeChannel: CredentialChannelConfig = {
          name: 'claude',
          credentialsPath: options.credentials,
          secretPath,
          readCredentials,
          writeSecret: (creds, path) => writeSecret(creds.accessToken, path, 'susentorno_bearer_token'),
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
          writeSecret: (creds, path) => {
            writeSecret(creds.accessToken, path, 'codex_bearer_token');
            // readCodexCredentials guarantees accountId is populated whenever it
            // returns a non-null Credentials at all — see src/runHosting/readCodexCredentials.ts.
            writePlainSecret(creds.accountId!, paths.codexAccountIdSecret, 'codex_account_id');
          },
          nudgeRefresh: nudgeCodexRefresh,
          refreshWindowMs,
          retryIntervalMs,
          maxAttempts,
          refreshEnabled: options.refresh,
        };
```

- [ ] **Step 6: Build to confirm the type error from Task 6 is now resolved**

Run: `npx tsc --noEmit`
Expected: No errors related to `writeSecret`'s signature.

- [ ] **Step 7: Run the full unit suite**

Run: `npx vitest run tests/unit`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/envPaths.ts src/commands/runHosting.ts tests/unit/envPaths.test.ts
git commit -m "feat(codex): write the real account id to its own SDS secret on the existing credential-read cadence"
```

---

## Task 8: Add the account-id marker/sentinel constants and extend the shared post-filter

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Produces: `NO_ACCOUNT_ID_MARKER_HEADER: string`, `NO_ACCOUNT_ID_SENTINEL_VALUE: string` (new exports). Consumed by Task 9 (`CODEX_GATE_LUA`) and Task 11 (Claude's `gate.lua` template + the two GitHub gates).
- `AUTH_POST_FILTER_LUA`'s exported value changes (still the same export name) — every existing test asserting `postLua === AUTH_POST_FILTER_LUA` (by reference to the constant, not a hardcoded string) continues to pass automatically.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/proxyConfig.test.ts`, inside the top-level `describe('proxy configuration generation', ...)` block (anywhere at the top level, e.g. right after the `import`s and before `describe('claude credential channel', ...)`):

```ts
describe('shared post-filter account-id cleanup', () => {
  it('AUTH_POST_FILTER_LUA also strips the account-id marker and header', () => {
    expect(AUTH_POST_FILTER_LUA).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
    expect(AUTH_POST_FILTER_LUA).toContain('chatgpt-account-id');
  });
});
```

Update the import at the top of the file:

```ts
import {
  generateEnvoyConfig,
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  NO_ACCOUNT_ID_MARKER_HEADER,
  NO_ACCOUNT_ID_SENTINEL_VALUE,
  AUTH_POST_FILTER_LUA,
} from '../../src/envoyConfig';
```

(`NO_ACCOUNT_ID_SENTINEL_VALUE` isn't used yet in this task's test but is imported now since Task 9's tests need it too and this keeps the import block settled in one place.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfig.test.ts -t "AUTH_POST_FILTER_LUA also strips"`
Expected: FAIL — `NO_ACCOUNT_ID_MARKER_HEADER` isn't exported yet, and `AUTH_POST_FILTER_LUA` doesn't mention it.

- [ ] **Step 3: Implement**

In `src/envoyConfig.ts`, add after the existing `NO_AUTH_SENTINEL_VALUE` export:

```ts
/**
 * Proxy-internal marker header, parallel to NO_AUTH_MARKER_HEADER but for the codex
 * chain's `chatgpt-account-id` header: CODEX_GATE_LUA sets it (alongside a sentinel
 * value) whenever Authorization was NOT recognized as the codex placeholder, so the
 * account-id credential_injector (overwrite:false) never attaches the real account id
 * to a foreign or absent credential. The shared post-filter strips both back off
 * before the router. Every authenticated chain's pre-filter must remove any inbound
 * copy first, exactly like NO_AUTH_MARKER_HEADER — it must never be something a
 * client-sent request can forge.
 */
export const NO_ACCOUNT_ID_MARKER_HEADER = 'x-susentorno-no-account-id';

/** Placeholder chatgpt-account-id value used only to make the header non-absent for
 * the injector's benefit; its content is never inspected — only
 * NO_ACCOUNT_ID_MARKER_HEADER controls whether the post-filter strips it. */
export const NO_ACCOUNT_ID_SENTINEL_VALUE = 'susentorno-no-account-id';
```

Update `AUTH_POST_FILTER_LUA`:

```ts
// Shared by every authenticated chain (Claude, Codex, both GitHub gates): runs after
// credential_injector to undo the marker/sentinel a pre-filter sets for a genuinely
// absent Authorization header (or, on the codex chain, an unrecognized/absent
// chatgpt-account-id), so "no credential sent" reaches the real upstream as absent
// rather than as the sentinel. Host-agnostic — never inspects any placeholder.
export const AUTH_POST_FILTER_LUA = `local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_ACCOUNT_ID_MARKER = "${NO_ACCOUNT_ID_MARKER_HEADER}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  if headers:get(NO_AUTH_MARKER) ~= nil then
    headers:remove(NO_AUTH_MARKER)
    headers:remove("authorization")
  end
  if headers:get(NO_ACCOUNT_ID_MARKER) ~= nil then
    headers:remove(NO_ACCOUNT_ID_MARKER)
    headers:remove("chatgpt-account-id")
  end
end
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: PASS — including every pre-existing test in this file (`postLua === AUTH_POST_FILTER_LUA` assertions still hold since they compare against the same, now-updated, constant).

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/proxyConfig.test.ts
git commit -m "feat(proxy): add account-id marker/sentinel constants and extend the shared post-filter"
```

---

## Task 9: Couple `chatgpt-account-id` handling into `CODEX_GATE_LUA`

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Consumes: `NO_ACCOUNT_ID_MARKER_HEADER`, `NO_ACCOUNT_ID_SENTINEL_VALUE` from Task 8.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('codex credential channel', ...)` block in `tests/unit/proxyConfig.test.ts` (after the existing `it`, before that `describe`'s closing `});`):

```ts
    it('the codex pre-filter couples chatgpt-account-id handling to bearer recognition', () => {
      const codexAllowlist: Allowlist = {
        passthrough: [],
        claudeAuthenticated: [],
        githubAuthenticated: [],
        codexAuthenticated: ['chatgpt.com:443'],
        authCandidate: [],
        blocked: [],
        warnings: [],
      };
      const config = generateEnvoyConfig(codexAllowlist) as any;
      const listener443 = config.static_resources.listeners.find(
        (l: any) => l.name === 'listener_443',
      );
      const codexChain = listener443.filter_chains.find((fc: any) =>
        fc.filter_chain_match?.server_names?.includes('chatgpt.com'),
      );
      const preLua = codexChain.filters[0].typed_config.default_source_code.inline_string;
      expect(preLua).toContain('chatgpt-account-id');
      expect(preLua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
      expect(preLua).toContain(NO_ACCOUNT_ID_SENTINEL_VALUE);
      // No unconditional early return before the account-id logic: verified indirectly
      // by the integration test in tests/proxy-stack/codexInjection.test.ts, which
      // exercises this Lua for real against a running Envoy.
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfig.test.ts -t "couples chatgpt-account-id"`
Expected: FAIL — `CODEX_GATE_LUA` doesn't mention `chatgpt-account-id` yet.

- [ ] **Step 3: Implement**

Replace `CODEX_GATE_LUA` in `src/envoyConfig.ts`:

```ts
// chatgpt.com: exact-match gate accepting only the placeholder Bearer, and coupling
// the chatgpt-account-id header's handling to that same recognition (see docs/adr/0002
// and the 2026-08-08 design doc): the real account id must only ever be attached to
// the same requests that get the real bearer token, never to a foreign or missing
// credential. Emitted inline (GitHub's precedent) so docker-compose.yml needs no new
// mounted gate file. Cookie is never read here, so it passes through untouched in both
// directions.
const CODEX_GATE_LUA = `local PLACEHOLDER = "Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"
local NO_ACCOUNT_ID_MARKER = "${NO_ACCOUNT_ID_MARKER_HEADER}"
local NO_ACCOUNT_ID_SENTINEL = "${NO_ACCOUNT_ID_SENTINEL_VALUE}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  headers:remove(NO_ACCOUNT_ID_MARKER)

  local auth = headers:get("authorization")
  local recognized = false
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
  elseif auth == PLACEHOLDER then
    headers:remove("authorization")
    recognized = true
  end

  if recognized then
    -- Unconditional: this is definitely one of our own guest processes about to get
    -- the real bearer token, so whatever it put in chatgpt-account-id (placeholder,
    -- something else, or nothing) must always be overridden to match.
    headers:remove("chatgpt-account-id")
  else
    if headers:get("chatgpt-account-id") == nil then
      headers:replace("chatgpt-account-id", NO_ACCOUNT_ID_SENTINEL)
      headers:replace(NO_ACCOUNT_ID_MARKER, "1")
    end
  end
end
`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: PASS — including the pre-existing codex tests (`preLua` still contains `'Bearer '`, `NO_AUTH_MARKER_HEADER`, `NO_AUTH_SENTINEL_VALUE`, still excludes `'403'`).

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/proxyConfig.test.ts
git commit -m "fix(proxy): couple chatgpt-account-id injection to codex bearer recognition"
```

---

## Task 10: Add the `chatgpt-account-id` `credential_injector` filter

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Consumes: `codexAccountIdSecret`'s mount path from Task 7 (`/etc/envoy/secrets/codex-account-id-secret.yaml` inside the container — same directory as `codex-secret.yaml`, just a different file).

- [ ] **Step 1: Write the failing test**

Replace the existing `it('builds a codex filter chain with pre/injector/post lua filters, router, and websocket upgrade', ...)` test body in `tests/unit/proxyConfig.test.ts` (inside `describe('codex credential channel', ...)`) — specifically these two assertions:

```ts
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
```

and:

```ts
      const injector = hcm.http_filters[1].typed_config;
      expect(injector.overwrite).toBe(false);
      expect(injector.credential.typed_config.credential.name).toBe('codex_bearer_token');
      expect(injector.credential.typed_config.credential.sds_config.path_config_source.path).toBe(
        '/etc/envoy/secrets/codex-secret.yaml',
      );
```

with:

```ts
      expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
        'susentorno.auth_pre',
        'envoy.filters.http.credential_injector',
        'susentorno.credential_injector.account_id',
        'susentorno.auth_post',
        'envoy.filters.http.router',
      ]);
```

and:

```ts
      const injector = hcm.http_filters[1].typed_config;
      expect(injector.overwrite).toBe(false);
      expect(injector.credential.typed_config.header).toBe('Authorization');
      expect(injector.credential.typed_config.credential.name).toBe('codex_bearer_token');
      expect(injector.credential.typed_config.credential.sds_config.path_config_source.path).toBe(
        '/etc/envoy/secrets/codex-secret.yaml',
      );

      const accountIdInjector = hcm.http_filters[2].typed_config;
      expect(accountIdInjector.overwrite).toBe(false);
      expect(accountIdInjector.credential.typed_config.header).toBe('chatgpt-account-id');
      expect(accountIdInjector.credential.typed_config.credential.name).toBe('codex_account_id');
      expect(
        accountIdInjector.credential.typed_config.credential.sds_config.path_config_source.path,
      ).toBe('/etc/envoy/secrets/codex-account-id-secret.yaml');
```

Also update the post-filter index reference a few lines below in the same test (it currently reads `hcm.http_filters[2]` for the post-lua check) — change to `hcm.http_filters[3]`:

```ts
      const postLua = hcm.http_filters[3].typed_config.default_source_code.inline_string;
      expect(postLua).toBe(AUTH_POST_FILTER_LUA);
```

(The `preLua` check stays `hcm.http_filters[0]` — unaffected.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/proxyConfig.test.ts -t "builds a codex filter chain"`
Expected: FAIL — `buildCodexEntry` only emits 4 `http_filters` today; the new injector and its properties don't exist.

- [ ] **Step 3: Implement**

In `src/envoyConfig.ts`'s `buildCodexEntry`, insert a new filter object into the `http_filters` array, between the existing `envoy.filters.http.credential_injector` entry and the `susentorno.auth_post` entry:

```ts
          http_filters: [
            {
              name: 'susentorno.auth_pre',
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
                overwrite: false,
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
              name: 'susentorno.credential_injector.account_id',
              typed_config: {
                '@type':
                  'type.googleapis.com/envoy.extensions.filters.http.credential_injector.v3.CredentialInjector',
                overwrite: false,
                credential: {
                  name: 'envoy.http.injected_credentials.generic',
                  typed_config: {
                    '@type':
                      'type.googleapis.com/envoy.extensions.http.injected_credentials.generic.v3.Generic',
                    header: 'chatgpt-account-id',
                    credential: {
                      name: 'codex_account_id',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/codex-account-id-secret.yaml',
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
              name: 'susentorno.auth_post',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { inline_string: AUTH_POST_FILTER_LUA },
              },
            },
            {
              name: 'envoy.filters.http.router',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
              },
            },
          ],
```

(Everything outside `http_filters` in `buildCodexEntry` is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/proxyConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/envoyConfig.ts tests/unit/proxyConfig.test.ts
git commit -m "feat(proxy): add the chatgpt-account-id credential_injector to the codex chain"
```

---

## Task 11: Strip the new marker on every other authenticated chain

**Files:**

- Modify: `templates/proxy/gate.lua`
- Modify: `src/envoyConfig.ts` (both GitHub gates)
- Modify: `tests/unit/templates.test.ts`
- Modify: `tests/unit/proxyConfig.test.ts`

**Interfaces:**

- Consumes: `NO_ACCOUNT_ID_MARKER_HEADER` from Task 8.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/templates.test.ts`, extend the existing `gate.lua uses the same no-auth marker/sentinel literals` test (add a line to it, and update its import):

```ts
import {
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  NO_ACCOUNT_ID_MARKER_HEADER,
} from '../../src/envoyConfig';
```

```ts
    it('gate.lua uses the same no-auth marker/sentinel literals as envoyConfig.ts and no longer rejects', () => {
      const gate = readFileSync(join(templatesDir(), 'proxy', 'gate.lua'), 'utf8');
      expect(gate).toContain(`"${NO_AUTH_MARKER_HEADER}"`);
      expect(gate).toContain(`"${NO_AUTH_SENTINEL_VALUE}"`);
      expect(gate).toContain(`"${NO_ACCOUNT_ID_MARKER_HEADER}"`);
      expect(gate).not.toContain('403');
      expect(gate).not.toContain('unexpected credential');
    });
```

In `tests/unit/proxyConfig.test.ts`, extend the two existing github tests (`'builds a github.com Basic chain...'` and `'builds an api.github.com chain...'`) by adding one assertion to each, right after their existing `expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);`-equivalent lines:

For the `github.com` Basic chain test, add after `expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);`:

```ts
      expect(lua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
```

For the `api.github.com` chain test, add after the existing `lua` assertions (this test doesn't currently check `NO_AUTH_MARKER_HEADER`/`NO_AUTH_SENTINEL_VALUE` explicitly, so add all three fresh, right after `expect(lua).toContain('Bearer ghp-susentorno-PLACEHOLDER');`):

```ts
      expect(lua).toContain(NO_AUTH_MARKER_HEADER);
      expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);
      expect(lua).toContain(NO_ACCOUNT_ID_MARKER_HEADER);
```

Update the import in `tests/unit/proxyConfig.test.ts` (from Task 8, already includes `NO_ACCOUNT_ID_MARKER_HEADER` — no further change needed here since Task 8 already added it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/templates.test.ts tests/unit/proxyConfig.test.ts`
Expected: FAIL — neither `templates/proxy/gate.lua` nor the two GitHub gates mention the new marker yet.

- [ ] **Step 3: Implement — `templates/proxy/gate.lua`**

Replace its full content:

```
local PLACEHOLDER = "Bearer sk-ant-oat-susentorno-PLACEHOLDER"
local NO_AUTH_MARKER = "x-susentorno-no-auth"
local NO_AUTH_SENTINEL = "susentorno-no-credential"
local NO_ACCOUNT_ID_MARKER = "x-susentorno-no-account-id"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  headers:remove(NO_ACCOUNT_ID_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  if auth == PLACEHOLDER then
    headers:remove("authorization")
  end
end
```

- [ ] **Step 4: Implement — `src/envoyConfig.ts`'s two GitHub gates**

In `GITHUB_API_TOKEN_GATE_LUA`, add a `NO_ACCOUNT_ID_MARKER` local and strip it at the top:

```ts
const GITHUB_API_TOKEN_GATE_LUA = `local TOKEN_PLACEHOLDER = "token ${GITHUB_PLACEHOLDER_PAT}"
local BEARER_PLACEHOLDER = "Bearer ${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"
local NO_ACCOUNT_ID_MARKER = "${NO_ACCOUNT_ID_MARKER_HEADER}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  headers:remove(NO_ACCOUNT_ID_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  if auth == TOKEN_PLACEHOLDER or auth == BEARER_PLACEHOLDER then
    headers:remove("authorization")
  end
end
`;
```

In `GITHUB_BASIC_GATE_LUA`, same pattern:

```ts
const GITHUB_BASIC_GATE_LUA = `local PLACEHOLDER_PAT = "${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"
local NO_ACCOUNT_ID_MARKER = "${NO_ACCOUNT_ID_MARKER_HEADER}"
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
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  headers:remove(NO_ACCOUNT_ID_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  local encoded = string.match(auth, "^Basic (.+)$")
  if encoded == nil then
    return
  end
  local decoded = b64decode(encoded)
  if decoded == nil then
    return
  end
  local password = string.match(decoded, "^[^:]*:(.*)$")
  if password == PLACEHOLDER_PAT then
    headers:remove("authorization")
  end
end
`;
```

(Only the two new lines — the `local NO_ACCOUNT_ID_MARKER = ...` declaration and the `headers:remove(NO_ACCOUNT_ID_MARKER)` call — are added to each; everything else in both gates is unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/templates.test.ts tests/unit/proxyConfig.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add templates/proxy/gate.lua src/envoyConfig.ts tests/unit/templates.test.ts tests/unit/proxyConfig.test.ts
git commit -m "fix(proxy): strip inbound copies of the new account-id marker on every authenticated chain"
```

---

## Task 12: Capture full headers on the mock upstream's WebSocket upgrade path

**Files:**

- Modify: `tests/proxy-stack/mockUpstream.ts`

**Interfaces:**

- Produces: `MockUpstream.receivedUpgradeHeaders: IncomingHttpHeaders[]` (new field, alongside the existing `receivedUpgradeAuthorizationHeaders`). Consumed by Task 13's new WebSocket-path account-id assertion.

There is no separate unit test for this file — it's exercised directly by `tests/proxy-stack/*.test.ts`'s docker-based integration suites. Verification happens in Task 13.

- [ ] **Step 1: Implement**

Replace the full content of `tests/proxy-stack/mockUpstream.ts`:

```ts
import { createServer, type Server } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import forge from 'node-forge';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
  receivedUpgradeAuthorizationHeaders: string[];
  /** Full headers object for every request, in order — for asserting on headers
   * other than Authorization (e.g. that no internal marker header ever leaks). */
  receivedHeaders: IncomingHttpHeaders[];
  /** Same as receivedHeaders, but for WebSocket upgrade requests. */
  receivedUpgradeHeaders: IncomingHttpHeaders[];
}

function generateSelfSignedCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'mock-upstream' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert),
  };
}

export function startMockUpstream(): Promise<MockUpstream> {
  const pems = generateSelfSignedCert();
  const receivedAuthorizationHeaders: string[] = [];
  const receivedHeaders: IncomingHttpHeaders[] = [];

  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  const receivedUpgradeAuthorizationHeaders: string[] = [];
  const receivedUpgradeHeaders: IncomingHttpHeaders[] = [];
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
    receivedUpgradeHeaders.push(req.headers);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('failed to bind mock upstream');
      }
      resolve({
        port: address.port,
        server,
        receivedAuthorizationHeaders,
        receivedUpgradeAuthorizationHeaders,
        receivedHeaders,
        receivedUpgradeHeaders,
      });
    });
  });
}

export function stopMockUpstream(mock: MockUpstream): Promise<void> {
  return new Promise((resolve, reject) => {
    mock.server.close((err) => (err ? reject(err) : resolve()));
  });
}
```

- [ ] **Step 2: Compile-check**

Run: `npx tsc --noEmit`
Expected: No new errors (this file has no existing consumers of a now-removed field — only an addition).

- [ ] **Step 3: Commit**

```bash
git add tests/proxy-stack/mockUpstream.ts
git commit -m "test(proxy): capture full headers on the mock upstream's WebSocket upgrade path"
```

---

## Task 13: End-to-end integration tests for the account-id injection coupling

**Files:**

- Modify: `tests/proxy-stack/codexInjection.test.ts`

**Interfaces:**

- Consumes: `MockUpstream.receivedUpgradeHeaders` from Task 12; the full proxy stack built by every prior task.

This is the task that actually proves the design works against a real running Envoy — everything before this was either a pure-function unit test or a Lua-source `toContain` check.

- [ ] **Step 1: Write the failing tests**

In `tests/proxy-stack/codexInjection.test.ts`, first extend `upgradeThrough` to accept extra headers (it currently only sends `Authorization`):

Replace:

```ts
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
```

with:

```ts
/** Raw TLS upgrade request; resolves with the first response line (e.g. "HTTP/1.1 101 ..."). */
function upgradeThrough(
  servername: string,
  authorization: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem },
      () => {
        const extra = Object.entries(extraHeaders)
          .map(([k, v]) => `${k}: ${v}\r\n`)
          .join('');
        socket.write(
          `GET / HTTP/1.1\r\nHost: ${servername}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
            `Authorization: ${authorization}\r\n${extra}\r\n`,
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
```

Then add a new `describe` block at the end of the file, before the final closing `});` of `describe('chatgpt.com codex Bearer injection', ...)`:

```ts
  describe('chatgpt-account-id injection', () => {
    it('injects the real account id alongside the real bearer when both placeholders are presented', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough(
        'chatgpt.com',
        `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
        { 'chatgpt-account-id': CODEX_PLACEHOLDER_ACCOUNT_ID },
      );
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe(REAL_CODEX_BEARER);
      expect(received[0]['chatgpt-account-id']).toBe('acct-itest');
    });

    it('does not attach the real account id to a foreign real Bearer with no chatgpt-account-id sent', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token');
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBe('Bearer some-other-real-token');
      expect(received[0]['chatgpt-account-id']).toBeUndefined();
    });

    it('does not attach the real account id when no Authorization is sent at all', async () => {
      const before = mockUpstream.receivedHeaders.length;
      const { statusCode } = await requestThrough('chatgpt.com');
      expect(statusCode).toBe(200);
      const received = mockUpstream.receivedHeaders.slice(before);
      expect(received[0].authorization).toBeUndefined();
      expect(received[0]['chatgpt-account-id']).toBeUndefined();
    });

    it('injects the real account id on the WebSocket upgrade path too', async () => {
      const before = mockUpstream.receivedUpgradeHeaders.length;
      const statusLine = await upgradeThrough(
        'chatgpt.com',
        `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
        { 'chatgpt-account-id': CODEX_PLACEHOLDER_ACCOUNT_ID },
      );
      expect(statusLine).toContain('101');
      const received = mockUpstream.receivedUpgradeHeaders.slice(before);
      expect(received[0].authorization).toBe(REAL_CODEX_BEARER);
      expect(received[0]['chatgpt-account-id']).toBe('acct-itest');
    });
  });
```

Update the import line to add `CODEX_PLACEHOLDER_ACCOUNT_ID`:

```ts
import { CODEX_PLACEHOLDER_ACCESS_TOKEN, CODEX_PLACEHOLDER_ACCOUNT_ID } from '../../src/codexPlaceholder';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proxy-stack/codexInjection.test.ts`
Expected: FAIL on the new `chatgpt-account-id injection` tests before this task's dependencies (Tasks 1–11) are all in place; if this is the first time running the full suite after completing all of Tasks 1–11, this step should already **pass** since the implementation was built incrementally — run it here specifically to confirm the full stack (guest placeholder + proxy coupling + real secret write) works end to end. If it fails, the most likely causes are: `codexCredentialsPath`'s fixture (`writeCodexAuth`, already setting `account_id: 'acct-itest'`) not being picked up because `run-hosting` wasn't restarted with the new code, or the new SDS secret file not being written before Envoy's first read (check `run-hosting`'s stdout in `stdoutLines` for a startup error referencing `codex-account-id-secret.yaml`).

Note: this test suite spins up real Docker containers (`docker compose`) and takes real time (existing `beforeAll` timeout is 120s) — this is an integration suite, not a fast unit test. Requires Docker running locally.

- [ ] **Step 3: Fix forward, if needed**

If Step 2 fails, work backward through Tasks 7–11 to find the mismatch — the most likely gap is a typo in the SDS resource name or file path between `envPaths.ts` (Task 7), the `credential_injector`'s `sds_config.path_config_source.path` (Task 10), and where `writePlainSecret` actually writes (Task 7's `runHosting.ts` closure) — all three must agree exactly on `codex-account-id-secret.yaml`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proxy-stack/codexInjection.test.ts`
Expected: PASS (all tests in the file, old and new)

- [ ] **Step 5: Run the full proxy-stack suite**

Run: `npx vitest run tests/proxy-stack`
Expected: PASS — confirms no regression in the sibling suites (`githubInjection.test.ts`, `stackLifecycle.test.ts`, `stackRobustness.test.ts`, `mcpServer.test.ts`) that also exercise `run-hosting` and the shared `AUTH_POST_FILTER_LUA`.

- [ ] **Step 6: Commit**

```bash
git add tests/proxy-stack/codexInjection.test.ts
git commit -m "test(proxy): verify chatgpt-account-id injection is coupled to bearer recognition end to end"
```

---

## Task 14: Update ADR 0002 and ADR 0018

**Files:**

- Modify: `docs/adr/0002-credential-injection-at-proxy.md`
- Modify: `docs/adr/0018-pi-agent-reuses-codex-placeholder-literal.md`

No test — documentation only.

- [ ] **Step 1: Update ADR 0002**

Append to the "Consequences" list in `docs/adr/0002-credential-injection-at-proxy.md`:

```markdown
- The codex/`chatgpt.com` chain injects **two** headers, not one: `Authorization` and `chatgpt-account-id`, via two `credential_injector` filters sharing a single Lua pre-filter. The account-id injector is coupled to the Authorization one — the real account id is only ever attached when Authorization was recognized as the codex placeholder, never to a foreign or missing credential (see the 2026-08-08 pi-codex-account-id-placeholder design). Codex's own guest auth file (`~/.codex/auth.json`) no longer carries any real value at all, including account id — full consistency with every other placeholder.
```

- [ ] **Step 2: Update ADR 0018**

Append to the "Consequences" list in `docs/adr/0018-pi-agent-reuses-codex-placeholder-literal.md`:

```markdown
- The shared literal's claim *shape* must satisfy every consumer's requirements, not just the proxy gate's exact-match. Pi's OpenAI-Codex provider decodes the JWT on every request and requires a `chatgpt_account_id` claim under `https://api.openai.com/auth`, which the original literal didn't have — fixed 2026-08-08 by adding a fixed placeholder claim to `PLACEHOLDER_CLAIMS` and injecting the real account id at the proxy (see [[credential-injection-at-proxy]] and the 2026-08-08 design doc), rather than requiring Pi's placeholder to carry real per-environment data.
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0002-credential-injection-at-proxy.md docs/adr/0018-pi-agent-reuses-codex-placeholder-literal.md
git commit -m "docs: update ADR 0002 and ADR 0018 for chatgpt-account-id injection"
```

---

## Final verification

- [ ] Run the full unit suite: `npx vitest run tests/unit`
- [ ] Run the full proxy-stack integration suite (requires Docker): `npx vitest run tests/proxy-stack`
- [ ] Run the CLI suite: `npx vitest run tests/cli`
- [ ] Type-check: `npx tsc --noEmit`
