# GitHub Auth Scheme Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `api.github.com` Envoy gate to accept the `token` auth scheme `gh` actually sends (not just `Bearer`, which was a mistaken assumption in the original design), and fix `05-github-auth.ps1` to fail loudly instead of silently reporting success when `gh auth login`/`gh auth setup-git` fail.

**Architecture:** The `api.github.com` Lua gate widens its exact-match check to accept either `token ghp-SANDBOX-PLACEHOLDER` or `Bearer ghp-SANDBOX-PLACEHOLDER`; the paired SDS secret always renders the real credential as `token <PAT>` (GitHub's REST API accepts `token` for any PAT unconditionally, so normalizing on the way out is safe regardless of which scheme the placeholder arrived as). `05-github-auth.ps1` adds explicit `$LASTEXITCODE` checks after each `gh` invocation, matching the existing convention in `08-claude-config.ps1`/`04-configure-tools.ps1`.

**Tech Stack:** TypeScript + Vitest (unit/integration), Envoy inline Lua filter, Docker Compose (integration only), PowerShell (VM script).

## Global Constraints

- Node `>=18` (`package.json` `engines.node`).
- Prettier: single quotes, `printWidth: 100`, `proseWrap: never`, `prettier-plugin-sh` (`.prettierrc`) — run `pnpm format` if unsure.
- Full gate `pnpm test` runs in this order and must stay green after every task: `format:check` → `lint` → `typecheck` → `test:unit` → `build` → `test:e2e` → `test:integration`.
- `.configamatron/` is generated per-environment and wholly git-ignored; source templates live under `templates/`. Edit `templates/…`, never the generated `.configamatron/…` copies.
- Integration suites require Docker; `tests/integration/githubInjection.test.ts` builds its own `.configamatron` env with `init` + `generate-ca` and runs `run-proxy` against a mock upstream via `--upstream-override`.
- Spec: `docs/honist-v/specs/2026-07-19-github-auth-scheme-fix-design.md`.
- Out of scope: `src/runProxy/classify.ts`'s `ALLOW CRED` access-log tag stays as-is (it correctly reflects which filter chain a request landed on, not gate outcome — not a bug).

---

### Task 1: `api.github.com` gate accepts `token` or `Bearer`; secret always renders `token`

**Files:**

- Modify: `src/envoyConfig.ts:172-255` (gate constant rename + logic, `GITHUB_INJECTION` reference, comment)
- Modify: `src/githubSecret.ts` (whole file — docstring + `formatGithubApiTokenSecret`)
- Test: `tests/unit/envoyConfig.test.ts:363-376`, `tests/unit/githubSecret.test.ts:29-45`

**Interfaces:**

- Consumes: `GITHUB_PLACEHOLDER_PAT` from `src/githubPlaceholder.ts` (already imported in both files, unchanged).
- Produces: `formatGithubApiTokenSecret(token: string): string` — same signature, now renders `inline_string: "token ${token}"` instead of `"Bearer ${token}"`. Consumed by `src/commands/writeGithubConfig.ts` (unchanged call site — signature is identical) and `tests/integration/githubInjection.test.ts` (Task 2).
- Produces (generated config): the `api.github.com` filter chain's inline Lua gate now contains both `token ghp-SANDBOX-PLACEHOLDER` and `Bearer ghp-SANDBOX-PLACEHOLDER` as accepted placeholder strings.

- [ ] **Step 1: Update the failing unit test for the gate**

In `tests/unit/envoyConfig.test.ts`, replace the `it('builds an api.github.com Bearer chain with an exact-match inline gate', ...)` block (lines 363-376) with:

```ts
  it('builds an api.github.com chain accepting either token or Bearer scheme', () => {
    const chain = githubChain('api.github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('token ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('Bearer ghp-SANDBOX-PLACEHOLDER');
    // Still a plain exact match — no base64 decoder embedded (that's the Basic gate only).
    expect(lua).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const cred = hcm.http_filters[1].typed_config.credential.typed_config.credential;
    expect(cred.name).toBe('github_api_token');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-api-token-secret.yaml',
    );
  });
```

- [ ] **Step 2: Update the failing unit test for the secret formatter**

In `tests/unit/githubSecret.test.ts`, replace the `describe('formatGithubApiTokenSecret', ...)` block (lines 29-45) with:

```ts
describe('formatGithubApiTokenSecret', () => {
  it('renders the single token-scheme SDS resource as an inline string', () => {
    const token = 'github_pat_' + 'B'.repeat(82);

    expect(formatGithubApiTokenSecret(token)).toBe(
      [
        'resources:',
        '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
        '    name: github_api_token',
        '    generic_secret:',
        '      secret:',
        `        inline_string: "token ${token}"`,
        '',
      ].join('\n'),
    );
  });
});
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts tests/unit/githubSecret.test.ts`
Expected: FAIL — the `api.github.com` gate test fails because the generated Lua only contains `Bearer ghp-SANDBOX-PLACEHOLDER`, not `token ghp-SANDBOX-PLACEHOLDER`; the secret formatter test fails because the rendered string still says `Bearer ${token}`.

- [ ] **Step 4: Rename and widen the gate constant in `src/envoyConfig.ts`**

At `src/envoyConfig.ts:172-185`, replace:

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
```

with:

```ts
// api.github.com: exact-match gate accepting either the classic `token` scheme (what
// gh actually sends today, confirmed by wire capture) or `Bearer` (GitHub's documented
// alternative, in case a future gh version switches — see cli/cli#12828, currently
// unshipped). Same overall shape as templates/proxy/gate.lua, just two accepted
// placeholder strings instead of one.
const GITHUB_API_TOKEN_GATE_LUA = `local TOKEN_PLACEHOLDER = "token ${GITHUB_PLACEHOLDER_PAT}"
local BEARER_PLACEHOLDER = "Bearer ${GITHUB_PLACEHOLDER_PAT}"

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  if auth ~= TOKEN_PLACEHOLDER and auth ~= BEARER_PLACEHOLDER then
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
`;
```

- [ ] **Step 5: Update the `GITHUB_INJECTION` reference**

At `src/envoyConfig.ts:241-255`, replace:

```ts
// github.com -> Basic gate + github_basic_auth; api.github.com -> Bearer gate + github_api_token.
// Each SDS resource lives in its own watched file: Envoy's filesystem SDS rejects a
// watched file that holds more than the one resource a given sds_config expects.
const GITHUB_INJECTION: Record<string, { sdsResource: string; sdsFile: string; gate: string }> = {
  'github.com': {
    sdsResource: 'github_basic_auth',
    sdsFile: 'github-basic-secret.yaml',
    gate: GITHUB_BASIC_GATE_LUA,
  },
  'api.github.com': {
    sdsResource: 'github_api_token',
    sdsFile: 'github-api-token-secret.yaml',
    gate: GITHUB_BEARER_GATE_LUA,
  },
};
```

with:

```ts
// github.com -> Basic gate + github_basic_auth; api.github.com -> token/Bearer gate + github_api_token.
// Each SDS resource lives in its own watched file: Envoy's filesystem SDS rejects a
// watched file that holds more than the one resource a given sds_config expects.
const GITHUB_INJECTION: Record<string, { sdsResource: string; sdsFile: string; gate: string }> = {
  'github.com': {
    sdsResource: 'github_basic_auth',
    sdsFile: 'github-basic-secret.yaml',
    gate: GITHUB_BASIC_GATE_LUA,
  },
  'api.github.com': {
    sdsResource: 'github_api_token',
    sdsFile: 'github-api-token-secret.yaml',
    gate: GITHUB_API_TOKEN_GATE_LUA,
  },
};
```

- [ ] **Step 6: Update `formatGithubApiTokenSecret` in `src/githubSecret.ts`**

Replace the whole file:

```ts
/**
 * Render the two Envoy file-based SDS secrets consumed from
 * .configamatron/proxy/secrets/. Each file carries exactly one resource:
 * Envoy's filesystem SDS rejects a watched file that holds more than the one
 * resource a given sds_config subscription expects. `github_basic_auth`
 * (git's Basic auth to github.com) and `github_api_token` (gh's `token`-scheme
 * auth to api.github.com) are therefore two separate files, both derived from
 * one PAT.
 */
export function formatGithubBasicSecret(username: string, token: string): string {
  const basic = 'Basic ' + Buffer.from(`${username}:${token}`).toString('base64');
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_basic_auth',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "${basic}"`,
    '',
  ].join('\n');
}

export function formatGithubApiTokenSecret(token: string): string {
  return [
    'resources:',
    '  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret',
    '    name: github_api_token',
    '    generic_secret:',
    '      secret:',
    `        inline_string: "token ${token}"`,
    '',
  ].join('\n');
}
```

- [ ] **Step 7: Run both test files to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts tests/unit/githubSecret.test.ts`
Expected: PASS — all tests in both files pass.

- [ ] **Step 8: Confirm no regressions in the full unit suite, lint, and typecheck**

Run: `pnpm typecheck && pnpm lint && pnpm test:unit`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/envoyConfig.ts src/githubSecret.ts tests/unit/envoyConfig.test.ts tests/unit/githubSecret.test.ts
git commit -m "fix(github): api.github.com gate accepts token or Bearer, inject always writes token"
```

---

### Task 2: Integration test drives both `token` and `Bearer` placeholders through the real proxy

**Files:**

- Modify: `tests/integration/githubInjection.test.ts:30`, `:189-206`

**Interfaces:**

- Consumes: `formatGithubApiTokenSecret` (Task 1 — now renders `token <PAT>`), `GITHUB_PLACEHOLDER_PAT` (`src/githubPlaceholder.ts`, unchanged), `requestThrough` (already defined in this file at line 64, unchanged signature `(servername: string, authorization: string) => Promise<{ statusCode?: number }>`).

- [ ] **Step 1: Update the real-credential constant**

At `tests/integration/githubInjection.test.ts:30`, replace:

```ts
const REAL_BEARER = `Bearer ${REAL_TOKEN}`;
```

with:

```ts
const REAL_API_AUTH = `token ${REAL_TOKEN}`;
```

- [ ] **Step 2: Replace the `api.github.com` describe block**

At `tests/integration/githubInjection.test.ts:189-206`, replace:

```ts
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

with:

```ts
describe('api.github.com token/Bearer injection', () => {
  it('injects the real token when the placeholder token scheme is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'api.github.com',
      `token ${GITHUB_PLACEHOLDER_PAT}`,
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
  });

  it('injects the real token when the placeholder Bearer scheme is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'api.github.com',
      `Bearer ${GITHUB_PLACEHOLDER_PAT}`,
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
  });

  it('403s a non-placeholder credential before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
});
```

- [ ] **Step 3: Build, then run the integration suite**

Run: `pnpm build && pnpm test:integration`
Expected: PASS — all `githubInjection.test.ts` cases pass, including the two new token/Bearer injection cases (both assert the upstream receives `token <REAL_TOKEN>`). Requires Docker Desktop running.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/githubInjection.test.ts
git commit -m "test(github): drive both token and Bearer placeholder schemes through the proxy"
```

---

### Task 3: `05-github-auth.ps1` fails loudly when `gh` fails

**Files:**

- Modify: `templates/vm-shared-windows/05-github-auth.ps1`
- Test: `tests/unit/templates.test.ts` (new `it` after the existing `it('windows 05-github-auth parses the double-quoted github-config format', ...)` block at line 72-80)

**Interfaces:**

- None (script-only change; no TypeScript interfaces produced or consumed).

- [ ] **Step 1: Write the failing test**

In `tests/unit/templates.test.ts`, add this `it` immediately after the block ending at line 80 (still inside the same top-level `describe`):

```ts
  it('windows 05-github-auth fails loudly when gh auth login or setup-git fails', () => {
    const script = readFileSync(
      join(templatesDir(), 'vm-shared-windows', '05-github-auth.ps1'),
      'utf8',
    );
    // $ErrorActionPreference = 'Stop' does not catch a native exe's non-zero exit code,
    // so each gh call must be followed by an explicit $LASTEXITCODE check.
    expect(script).toMatch(/gh auth login --with-token\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
    expect(script).toMatch(/gh auth setup-git\r?\n\s*if \(\$LASTEXITCODE -ne 0\)/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/templates.test.ts -t "fails loudly"`
Expected: FAIL — neither `gh` call in the current script is followed by a `$LASTEXITCODE` check.

- [ ] **Step 3: Add the exit-code checks**

Replace the end of `templates/vm-shared-windows/05-github-auth.ps1` (currently):

```powershell
git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
gh auth setup-git

Write-Host "05-github-auth: git identity and gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>"
```

with:

```powershell
git config --global user.name  $cfg['GITHUB_USERNAME']
git config --global user.email $cfg['GITHUB_EMAIL']
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
if ($LASTEXITCODE -ne 0) { Write-Error "05-github-auth: gh auth login failed"; exit 1 }
gh auth setup-git
if ($LASTEXITCODE -ne 0) { Write-Error "05-github-auth: gh auth setup-git failed"; exit 1 }

Write-Host "05-github-auth: git identity and gh auth configured for $($cfg['GITHUB_USERNAME']) <$($cfg['GITHUB_EMAIL'])>"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/templates.test.ts`
Expected: PASS — all tests in the file pass, including the new one.

- [ ] **Step 5: Sanity-check the script still parses as valid PowerShell**

Run: `pwsh -NoProfile -Command "$errs = $null; [System.Management.Automation.Language.Parser]::ParseFile('templates/vm-shared-windows/05-github-auth.ps1', [ref]$null, [ref]$errs) | Out-Null; if ($errs) { $errs } else { 'OK' }"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add templates/vm-shared-windows/05-github-auth.ps1 tests/unit/templates.test.ts
git commit -m "fix(vm): 05-github-auth.ps1 fails loudly when gh auth login or setup-git fails"
```

---

### Task 4: Full-suite green + final verification

- [ ] **Step 1: Run the complete gate**

Run: `pnpm test`
Expected: PASS — `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, `test:integration` all succeed (Docker required for the integration stage).

- [ ] **Step 2: Manual end-to-end (documented, not automated)**

On a real Windows VM setup, after `configamatron write-github-config` with a real PAT and the proxy running:
1. Run `.\05-github-auth.ps1` after network isolation + reboot, per `usage-windows-vm.md` step 9 — `gh auth login --with-token` should now succeed (the gate accepts the `token` scheme it actually sends).
2. `git push` to a repo the PAT can write, and a `gh api user` call — both succeed through injection.
3. Deliberately break `github-config.txt`'s placeholder or stop the proxy, and confirm `05-github-auth.ps1` now exits non-zero with the new `gh auth login failed` / `gh auth setup-git failed` message instead of printing the success line.

- [ ] **Step 3: Commit any doc tweaks from the manual pass (if needed), otherwise done.**
