# Auth Gate Passthrough Implementation Plan

**Goal:** Replace the sandbox proxy's reject-on-mismatch Lua gates (Claude, Codex, GitHub Basic, GitHub token) with pass-through behavior — inject the real credential only when the sandbox placeholder is present, otherwise forward the client's original `Authorization` header (or its absence) to the real upstream completely unmodified.

**Architecture:** Each authenticated Envoy filter chain gets a second, generic Lua filter inserted after `credential_injector` (now `overwrite: false` instead of `true`). The existing per-host Lua "gate" becomes a pre-filter: on an exact placeholder match it clears `Authorization` (so the injector, seeing it absent, injects); on a non-matching value it leaves `Authorization` untouched (so the injector, seeing it present, skips); on a genuinely absent header it sets a fixed sentinel value plus an internal marker header (so the injector skips), and the new shared post-filter strips both back off before the request reaches the router. Every pre-filter first strips any inbound copy of the marker header so a client can never spoof it.

**Tech Stack:** TypeScript (ES modules), Envoy 1.31 Lua filter (`envoy.filters.http.lua`) + `credential_injector`, vitest 4 (unit + docker-backed integration suites).

## Global Constraints

- **Marker header:** `x-configamatron-no-auth` (exported as `NO_AUTH_MARKER_HEADER` from `src/envoyConfig.ts`).
- **Sentinel `Authorization` value:** `sandbox-no-credential` (exported as `NO_AUTH_SENTINEL_VALUE` from `src/envoyConfig.ts`).
- **Lua filter names:** the pre-filter is always named `configamatron.auth_pre`; the shared post-filter is always named `configamatron.auth_post` — never reuse the bare `envoy.filters.http.lua` extension-type string as a filter `name` now that two Lua filters exist per chain.
- **`credential_injector` `overwrite: false`** in all three builders that use it (`buildClaudeEntry`, `buildGithubEntry`, `buildCodexEntry`). `buildAuthCandidateEntry` is untouched — it has no gate and no injector today and stays that way.
- **Every pre-filter unconditionally strips any inbound `x-configamatron-no-auth` header before evaluating anything else** — it is a proxy-internal control signal and must never be something a client-sent request can forge.
- **No change** to how the real credential is stored, mounted, or delivered via SDS; no change to the placeholder values themselves (`PLACEHOLDER_ACCESS_TOKEN`, `GITHUB_PLACEHOLDER_PAT`, `CODEX_PLACEHOLDER_ACCESS_TOKEN`).
- **`gate.lua`'s existing `logInfo` diagnostic call is removed, not reworded** — nothing is rejected anymore, so there is no rejection event left to log.

---

## File Map

Modified source files:

- `src/envoyConfig.ts` — new shared constants (`NO_AUTH_MARKER_HEADER`, `NO_AUTH_SENTINEL_VALUE`, `AUTH_POST_FILTER_LUA`); rewritten `CODEX_GATE_LUA`, `GITHUB_API_TOKEN_GATE_LUA`, `GITHUB_BASIC_GATE_LUA`; rewired `http_filters` arrays and `overwrite` flags in `buildCodexEntry`, `buildGithubEntry`, `buildClaudeEntry`.
- `templates/proxy/gate.lua` — rewritten to pass through instead of reject; same marker/sentinel literals as the TS constants (this file is a static asset, not template-rendered, so the literals are duplicated by hand and guarded by a test).

Modified test files:

- `tests/unit/envoyConfig.test.ts` — filter-name-list and `overwrite` assertions updated for all three authenticated builders.
- `tests/unit/templates.test.ts` — new test asserting `gate.lua`'s literals match the TS constants and that the old reject strings are gone.
- `tests/integration/mockUpstream.ts` — new `receivedHeaders` field (full headers per request) alongside the existing `receivedAuthorizationHeaders`.
- `tests/integration/proxy.test.ts`, `tests/integration/codexInjection.test.ts`, `tests/integration/githubInjection.test.ts` — reject-on-mismatch tests rewritten as passthrough tests; new absent-header and marker-spoofing tests; local `requestThrough` helpers made auth-optional and given an `extraHeaders` parameter.

**Deliberately unchanged:** `templates/proxy/docker-compose.yml` (no new mounted file — the post-filter is inlined like the GitHub/Codex gates already are), `src/allowlist.ts`, `buildAuthCandidateEntry`, all SDS secret plumbing.

---

### Task 1: Shared constants, shared post-filter, and the Codex chain

Codex is the simplest authenticated chain — single inline gate, single fixed Bearer placeholder, no base64 decoding — so it's the best place to introduce the shared constants and prove the pre/injector/post shape before reusing it on GitHub and Claude.

**Files:**

- Modify: `src/envoyConfig.ts`
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Produces (used by Tasks 2 and 3): `export const NO_AUTH_MARKER_HEADER = 'x-configamatron-no-auth'`, `export const NO_AUTH_SENTINEL_VALUE = 'sandbox-no-credential'`, `export const AUTH_POST_FILTER_LUA: string`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/envoyConfig.test.ts`, replace the `'builds a codex filter chain with an inline lua gate, credential injector, router, and websocket upgrade'` test (inside `describe('generateEnvoyConfig github authenticated', ...)`) with:

```ts
  it('builds a codex filter chain with pre/injector/post lua filters, router, and websocket upgrade', () => {
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
      'configamatron.auth_pre',
      'envoy.filters.http.credential_injector',
      'configamatron.auth_post',
      'envoy.filters.http.router',
    ]);
    // Inline gate (not a mounted file) referencing the placeholder Bearer and the
    // shared no-auth marker/sentinel.
    const preLua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(preLua).toContain('Bearer ');
    expect(preLua).toContain(NO_AUTH_MARKER_HEADER);
    expect(preLua).toContain(NO_AUTH_SENTINEL_VALUE);
    expect(preLua).not.toContain('403');
    // Shared, host-agnostic post-filter.
    const postLua = hcm.http_filters[2].typed_config.default_source_code.inline_string;
    expect(postLua).toBe(AUTH_POST_FILTER_LUA);
    // Codex-only websocket upgrade support.
    expect(hcm.upgrade_configs).toEqual([{ upgrade_type: 'websocket' }]);
    // Long-lived streaming: no route timeout.
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');

    const injector = hcm.http_filters[1].typed_config;
    expect(injector.overwrite).toBe(false);
    expect(injector.credential.typed_config.credential.name).toBe('codex_bearer_token');
    expect(injector.credential.typed_config.credential.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/codex-secret.yaml',
    );

    const cluster = config.static_resources.clusters.find(
      (c: any) => c.name === 'cluster_codex_chatgpt_com',
    );
    expect(cluster).toBeDefined();
  });
```

Add the new imports at the top of the file, alongside the existing `generateEnvoyConfig` import:

```ts
import {
  generateEnvoyConfig,
  NO_AUTH_MARKER_HEADER,
  NO_AUTH_SENTINEL_VALUE,
  AUTH_POST_FILTER_LUA,
} from '../../src/envoyConfig';
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts` Expected: FAIL — `NO_AUTH_MARKER_HEADER` etc. are not exported yet, and the codex chain still has 3 filters named `envoy.filters.http.lua` / `envoy.filters.http.credential_injector` / `envoy.filters.http.router`.

- [ ] **Step 3: Add the shared constants and post-filter**

In `src/envoyConfig.ts`, immediately after the existing `export interface UpstreamOverride { ... }` block (before `export type InjectFault = ...`), add:

```ts
/**
 * Proxy-internal marker header. A pre-filter sets it (alongside a sentinel
 * `Authorization` value) only when the client sent no Authorization header at all,
 * so the credential_injector (overwrite:false) sees a header present and skips
 * injecting. The shared post-filter strips both back off before the router. Every
 * pre-filter must remove any inbound copy of this header first — it must never be
 * something a client-sent request can forge.
 */
export const NO_AUTH_MARKER_HEADER = 'x-configamatron-no-auth';

/** Placeholder Authorization value used only to make the header non-absent for the
 * injector's benefit; its content is never inspected — only NO_AUTH_MARKER_HEADER
 * controls whether the post-filter strips it. */
export const NO_AUTH_SENTINEL_VALUE = 'sandbox-no-credential';

// Shared by every authenticated chain (Claude, Codex, both GitHub gates): runs after
// credential_injector to undo the marker/sentinel a pre-filter sets for a genuinely
// absent Authorization header, so "no credential sent" reaches the real upstream as
// absent rather than as the sentinel. Host-agnostic — never inspects any placeholder.
export const AUTH_POST_FILTER_LUA = `local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  if headers:get(NO_AUTH_MARKER) ~= nil then
    headers:remove(NO_AUTH_MARKER)
    headers:remove("authorization")
  end
end
`;
```

- [ ] **Step 4: Rewrite `CODEX_GATE_LUA`**

Replace the existing `CODEX_GATE_LUA` constant:

```ts
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

with:

```ts
const CODEX_GATE_LUA = `local PLACEHOLDER = "Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
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
`;
```

- [ ] **Step 5: Rewire `buildCodexEntry`'s `http_filters` and `overwrite` flag**

In `buildCodexEntry`, replace the `http_filters` array:

```ts
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
```

with:

```ts
          http_filters: [
            {
              name: 'configamatron.auth_pre',
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
              name: 'configamatron.auth_post',
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

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts` Expected: PASS. (The Claude and GitHub blocks in this same file still pass too — their production code hasn't changed yet.)

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck` Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(proxy): pass non-placeholder codex credentials through instead of 403ing"
```

---

### Task 2: GitHub chain (both `api.github.com` token gate and `github.com` Basic gate)

**Files:**

- Modify: `src/envoyConfig.ts`
- Test: `tests/unit/envoyConfig.test.ts`

**Interfaces:**

- Consumes: `NO_AUTH_MARKER_HEADER`, `NO_AUTH_SENTINEL_VALUE`, `AUTH_POST_FILTER_LUA` from Task 1.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/envoyConfig.test.ts`, replace the `'builds a github.com Basic chain: inline lua gate, injector, router'` test with:

```ts
  it('builds a github.com Basic chain: inline lua pre-filter, injector, shared post-filter, router', () => {
    const chain = githubChain('github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'configamatron.auth_pre',
      'envoy.filters.http.credential_injector',
      'configamatron.auth_post',
      'envoy.filters.http.router',
    ]);
    // Gate is inline (no mounted file) and embeds a base64 decoder + placeholder check.
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');
    expect(lua).toContain(NO_AUTH_MARKER_HEADER);
    expect(lua).toContain(NO_AUTH_SENTINEL_VALUE);
    expect(lua).not.toContain('403');
    expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBeUndefined();
    expect(hcm.http_filters[2].typed_config.default_source_code.inline_string).toBe(
      AUTH_POST_FILTER_LUA,
    );
    // Injector reads the Basic SDS resource from its own single-resource secret file.
    const injector = hcm.http_filters[1].typed_config;
    expect(injector.overwrite).toBe(false);
    const cred = injector.credential.typed_config.credential;
    expect(cred.name).toBe('github_basic_auth');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-basic-secret.yaml',
    );
    expect(cred.sds_config.path_config_source.watched_directory.path).toBe('/etc/envoy/secrets');
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.cluster).toBe(
      'cluster_github_github_com',
    );
    expect(hcm.route_config.virtual_hosts[0].routes[0].route.timeout).toBe('0s');
  });
```

Replace the `'builds an api.github.com chain accepting either token or Bearer scheme'` test with:

```ts
  it('builds an api.github.com chain accepting either token or Bearer scheme', () => {
    const chain = githubChain('api.github.com');
    expect(chain).toBeDefined();
    const hcm = chain.filters[0].typed_config;
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'configamatron.auth_pre',
      'envoy.filters.http.credential_injector',
      'configamatron.auth_post',
      'envoy.filters.http.router',
    ]);
    const lua = hcm.http_filters[0].typed_config.default_source_code.inline_string;
    expect(lua).toContain('token ghp-SANDBOX-PLACEHOLDER');
    expect(lua).toContain('Bearer ghp-SANDBOX-PLACEHOLDER');
    // Still a plain exact match — no base64 decoder embedded (that's the Basic gate only).
    expect(lua).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    const injector = hcm.http_filters[1].typed_config;
    expect(injector.overwrite).toBe(false);
    const cred = injector.credential.typed_config.credential;
    expect(cred.name).toBe('github_api_token');
    expect(cred.sds_config.path_config_source.path).toBe(
      '/etc/envoy/secrets/github-api-token-secret.yaml',
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts` Expected: FAIL on both new/updated github tests (still 3 old-named filters, `overwrite: true`).

- [ ] **Step 3: Rewrite `GITHUB_API_TOKEN_GATE_LUA`**

Replace:

```ts
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

with:

```ts
const GITHUB_API_TOKEN_GATE_LUA = `local TOKEN_PLACEHOLDER = "token ${GITHUB_PLACEHOLDER_PAT}"
local BEARER_PLACEHOLDER = "Bearer ${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
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

- [ ] **Step 4: Rewrite `GITHUB_BASIC_GATE_LUA`**

Replace the `envoy_on_request` function at the end of `GITHUB_BASIC_GATE_LUA` (the `b64decode` helper above it is unchanged) and add the two new locals up top. Replace the whole constant:

```ts
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
```

with:

```ts
const GITHUB_BASIC_GATE_LUA = `local PLACEHOLDER_PAT = "${GITHUB_PLACEHOLDER_PAT}"
local NO_AUTH_MARKER = "${NO_AUTH_MARKER_HEADER}"
local NO_AUTH_SENTINEL = "${NO_AUTH_SENTINEL_VALUE}"
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

- [ ] **Step 5: Rewire `buildGithubEntry`'s `http_filters` and `overwrite` flag**

`buildGithubEntry` is used for both GitHub hosts, so one change covers both. Replace its `http_filters` array:

```ts
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
                          path: `/etc/envoy/secrets/${sdsFile}`,
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
```

with:

```ts
          http_filters: [
            {
              name: 'configamatron.auth_pre',
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
                overwrite: false,
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
                          path: `/etc/envoy/secrets/${sdsFile}`,
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
              name: 'configamatron.auth_post',
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

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts` Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck` Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/envoyConfig.ts tests/unit/envoyConfig.test.ts
git commit -m "feat(proxy): pass non-placeholder github credentials through instead of 403ing"
```

---

### Task 3: Claude chain (`buildClaudeEntry` + `templates/proxy/gate.lua`)

**Files:**

- Modify: `src/envoyConfig.ts`
- Modify: `templates/proxy/gate.lua`
- Test: `tests/unit/envoyConfig.test.ts`
- Test: `tests/unit/templates.test.ts`

**Interfaces:**

- Consumes: `NO_AUTH_MARKER_HEADER`, `NO_AUTH_SENTINEL_VALUE`, `AUTH_POST_FILTER_LUA` from Task 1.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/envoyConfig.test.ts`, replace the `'builds a claude filter chain and cluster for each claude-authenticated host'` test's filter-list assertion. Find:

```ts
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'envoy.filters.http.lua',
      'envoy.filters.http.credential_injector',
      'envoy.filters.http.router',
    ]);
```

and replace with:

```ts
    expect(hcm.http_filters.map((f: any) => f.name)).toEqual([
      'configamatron.auth_pre',
      'envoy.filters.http.credential_injector',
      'configamatron.auth_post',
      'envoy.filters.http.router',
    ]);
    expect(hcm.http_filters[0].typed_config.default_source_code.filename).toBe(
      '/etc/envoy/gate.lua',
    );
    expect(hcm.http_filters[1].typed_config.overwrite).toBe(false);
    expect(hcm.http_filters[2].typed_config.default_source_code.inline_string).toBe(
      AUTH_POST_FILTER_LUA,
    );
```

In `tests/unit/templates.test.ts`, add the import at the top:

```ts
import { NO_AUTH_MARKER_HEADER, NO_AUTH_SENTINEL_VALUE } from '../../src/envoyConfig';
```

and add this new test inside `describe('templates', ...)`:

```ts
  it('gate.lua uses the same no-auth marker/sentinel literals as envoyConfig.ts and no longer rejects', () => {
    const gate = readFileSync(join(templatesDir(), 'proxy', 'gate.lua'), 'utf8');
    expect(gate).toContain(`"${NO_AUTH_MARKER_HEADER}"`);
    expect(gate).toContain(`"${NO_AUTH_SENTINEL_VALUE}"`);
    expect(gate).not.toContain('403');
    expect(gate).not.toContain('unexpected credential');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts tests/unit/templates.test.ts` Expected: FAIL — claude chain still has the old 3-filter list, and `gate.lua` still contains `403`/`"unexpected credential"` and no marker/sentinel literals.

- [ ] **Step 3: Rewrite `templates/proxy/gate.lua`**

Replace the entire file:

```lua
local PLACEHOLDER = "Bearer sk-ant-oat-SANDBOX-PLACEHOLDER"

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  if auth ~= PLACEHOLDER then
    request_handle:logInfo("sandbox: rejected credential len=" .. tostring(#auth) .. " prefix=" .. auth:sub(1, 24))
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
```

with:

```lua
local PLACEHOLDER = "Bearer sk-ant-oat-SANDBOX-PLACEHOLDER"
local NO_AUTH_MARKER = "x-configamatron-no-auth"
local NO_AUTH_SENTINEL = "sandbox-no-credential"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
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

(The marker/sentinel literals here must exactly match `NO_AUTH_MARKER_HEADER`/`NO_AUTH_SENTINEL_VALUE` in `src/envoyConfig.ts` — this file is a static mounted asset, not template-rendered, so the two can't share a literal source; the test added in Step 1 guards against drift.)

- [ ] **Step 4: Rewire `buildClaudeEntry`'s `http_filters` and `overwrite` flag**

Replace:

```ts
          http_filters: [
            {
              name: 'envoy.filters.http.lua',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { filename: '/etc/envoy/gate.lua' },
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
                      name: 'sandbox_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/sds-secret.yaml',
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
```

with:

```ts
          http_filters: [
            {
              name: 'configamatron.auth_pre',
              typed_config: {
                '@type': 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua',
                default_source_code: { filename: '/etc/envoy/gate.lua' },
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
                      name: 'sandbox_bearer_token',
                      sds_config: {
                        path_config_source: {
                          path: '/etc/envoy/secrets/sds-secret.yaml',
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
              name: 'configamatron.auth_post',
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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run tests/unit/envoyConfig.test.ts tests/unit/templates.test.ts` Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck` Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/envoyConfig.ts templates/proxy/gate.lua tests/unit/envoyConfig.test.ts tests/unit/templates.test.ts
git commit -m "feat(proxy): pass non-placeholder claude credentials through instead of 403ing"
```

This is the actual fix for the `/remote-control` bug: the `sk-ant-si-` session token, once it reaches `api.anthropic.com`, now passes through instead of getting 403'd.

---

### Task 4: Claude integration tests (`mockUpstream.ts` + `proxy.test.ts`)

**Files:**

- Modify: `tests/integration/mockUpstream.ts`
- Modify: `tests/integration/proxy.test.ts`

**Interfaces:**

- Produces (used by Tasks 5 and 6): `MockUpstream.receivedHeaders: IncomingHttpHeaders[]` — the full headers object per request, recorded alongside the existing `receivedAuthorizationHeaders`.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/proxy.test.ts`, replace `requestThroughClaudeHost`:

```ts
function requestThroughClaudeHost(
  authorization: string | undefined,
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: caCertPem,
        path: '/',
        headers: authorization ? { authorization } : {},
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
```

with:

```ts
function requestThroughClaudeHost(
  authorization: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: '127.0.0.1',
        port: HTTPS_PORT,
        servername: 'api.anthropic.com',
        ca: caCertPem,
        path: '/',
        headers: { ...(authorization ? { authorization } : {}), ...extraHeaders },
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
```

Replace the `'rejects a non-placeholder Authorization header before reaching the upstream'` test:

```ts
  it('rejects a non-placeholder Authorization header before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughClaudeHost('Bearer something-else');

    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
```

with:

```ts
  it('passes a non-placeholder Authorization header through to the upstream unmodified, with no marker leak or unrelated-header changes', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThroughClaudeHost('Bearer something-else', {
      'x-test-probe': 'keep-me',
    });

    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe('Bearer something-else');
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
    expect(received[0]['x-test-probe']).toBe('keep-me');
  });

  it('passes a request through with no Authorization header when the client sent none', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThroughClaudeHost(undefined);

    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('strips a client-forged no-auth marker header instead of trusting it', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThroughClaudeHost('Bearer something-else', {
      'x-configamatron-no-auth': '1',
    });

    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    // The forged marker must not cause the post-filter to strip this credential.
    expect(received[0].authorization).toBe('Bearer something-else');
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughClaudeHost(PLACEHOLDER_AUTH, {
      'x-configamatron-no-auth': '1',
    });

    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });
```

Also strengthen the pre-existing happy-path test so the placeholder-match branch is checked for marker leaks too, not just the new adversarial branches. Replace:

```ts
  it('injects the real credential when the placeholder Authorization header is presented', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThroughClaudeHost(PLACEHOLDER_AUTH);

    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_AUTH]);
  });
```

with:

```ts
  it('injects the real credential when the placeholder Authorization header is presented, with no marker leak', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThroughClaudeHost(PLACEHOLDER_AUTH);

    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe(REAL_AUTH);
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/proxy.test.ts` Expected: FAIL — `mockUpstream.receivedHeaders` does not exist yet (TypeScript compile error surfaces as a test failure), and the old gate still 403s.

- [ ] **Step 3: Extend `mockUpstream.ts`**

Replace `tests/integration/mockUpstream.ts`:

```ts
import { createServer, type Server } from 'node:https';
import forge from 'node-forge';

export interface MockUpstream {
  port: number;
  server: Server;
  receivedAuthorizationHeaders: string[];
  receivedUpgradeAuthorizationHeaders: string[];
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

  const server = createServer({ key: pems.key, cert: pems.cert }, (req, res) => {
    receivedAuthorizationHeaders.push(req.headers.authorization ?? '');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('mock upstream ok');
  });

  const receivedUpgradeAuthorizationHeaders: string[] = [];
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
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

with:

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
  server.on('upgrade', (req, socket) => {
    receivedUpgradeAuthorizationHeaders.push(req.headers.authorization ?? '');
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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/proxy.test.ts` Expected: PASS (this spins up the real docker-compose Envoy stack — allow a minute or two).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/mockUpstream.ts tests/integration/proxy.test.ts
git commit -m "test(proxy): cover claude passthrough for non-placeholder, absent, and forged-marker auth"
```

---

### Task 5: Codex integration tests

**Files:**

- Modify: `tests/integration/codexInjection.test.ts`

**Interfaces:**

- Consumes: `MockUpstream.receivedHeaders` from Task 4.

- [ ] **Step 1: Write the failing tests**

Replace `requestThrough`:

```ts
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
```

with:

```ts
function requestThrough(
  servername: string,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path: '/', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
```

Replace the `'403s a leaked real Bearer that is not the placeholder'` test:

```ts
  it('403s a leaked real Bearer that is not the placeholder', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
```

with:

```ts
  it('passes a leaked real Bearer that is not the placeholder through unmodified', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
      'Bearer some-other-real-token',
    ]);
  });

  it('passes a request through with no Authorization header when the client sent none', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com');
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('strips a client-forged no-auth marker header instead of trusting it', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('chatgpt.com', 'Bearer some-other-real-token', {
      'x-configamatron-no-auth': '1',
    });
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe('Bearer some-other-real-token');
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'chatgpt.com',
      `Bearer ${CODEX_PLACEHOLDER_ACCESS_TOKEN}`,
      { 'x-configamatron-no-auth': '1' },
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_CODEX_BEARER]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/codexInjection.test.ts` Expected: FAIL against the pre-Task-1 behavior; since Task 1 already landed, this should actually mostly PASS already except any test relying on the old `requestThrough(servername, authorization)` two-arg-required shape breaking type inference — run it anyway to confirm the new tests specifically pass for the right reason before moving on.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/codexInjection.test.ts` Expected: PASS, including the pre-existing `'injects the real token when the placeholder Bearer is presented'`, `'still injects on the claude chain'`, and `'proxies a WebSocket upgrade...'` tests (unchanged, still green).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/codexInjection.test.ts
git commit -m "test(codex): cover passthrough for non-placeholder, absent, and forged-marker auth"
```

---

### Task 6: GitHub integration tests

**Files:**

- Modify: `tests/integration/githubInjection.test.ts`

**Interfaces:**

- Consumes: `MockUpstream.receivedHeaders` from Task 4.

- [ ] **Step 1: Write the failing tests**

Replace `requestThrough`:

```ts
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
```

with:

```ts
function requestThrough(
  servername: string,
  authorization?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode?: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
    if (authorization !== undefined) headers.authorization = authorization;
    const req = httpsRequest(
      { host: '127.0.0.1', port: HTTPS_PORT, servername, ca: caCertPem, path: '/', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ statusCode: res.statusCode }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
```

Replace the whole `describe('github.com Basic injection', ...)` block:

```ts
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
```

with:

```ts
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

  it('passes a Basic credential whose token half is not the placeholder through unmodified', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const sent = basicOf('whoever', 'some-other-token');
    const { statusCode } = await requestThrough('github.com', sent);
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([sent]);
  });

  it('passes a non-Basic Authorization on github.com through unmodified', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('github.com', 'Bearer not-basic-at-all');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
      'Bearer not-basic-at-all',
    ]);
  });

  it('passes a malformed-base64 Basic credential through unmodified without crashing', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('github.com', 'Basic not-valid-base64!!!');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([
      'Basic not-valid-base64!!!',
    ]);
  });

  it('passes a request through with no Authorization header when the client sent none', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('github.com');
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('strips a client-forged no-auth marker header instead of trusting it', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const sent = basicOf('whoever', 'some-other-token');
    const { statusCode } = await requestThrough('github.com', sent, {
      'x-configamatron-no-auth': '1',
    });
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe(sent);
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'github.com',
      basicOf('whoever', GITHUB_PLACEHOLDER_PAT),
      { 'x-configamatron-no-auth': '1' },
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_BASIC]);
  });
});
```

Replace the `'403s a non-placeholder credential before reaching the upstream'` test inside `describe('api.github.com token/Bearer injection', ...)`:

```ts
  it('403s a non-placeholder credential before reaching the upstream', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token');
    expect(statusCode).toBe(403);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([]);
  });
```

with:

```ts
  it('passes a non-placeholder credential through to the upstream unmodified', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token');
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual(['Bearer wrong-token']);
  });

  it('passes a request through with no Authorization header when the client sent none', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('api.github.com');
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBeUndefined();
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('strips a client-forged no-auth marker header on a non-matching credential instead of trusting it', async () => {
    const before = mockUpstream.receivedHeaders.length;
    const { statusCode } = await requestThrough('api.github.com', 'Bearer wrong-token', {
      'x-configamatron-no-auth': '1',
    });
    expect(statusCode).toBe(200);
    const received = mockUpstream.receivedHeaders.slice(before);
    expect(received[0].authorization).toBe('Bearer wrong-token');
    expect(received[0]['x-configamatron-no-auth']).toBeUndefined();
  });

  it('still injects the real credential when the placeholder is presented alongside a forged no-auth marker header', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const { statusCode } = await requestThrough(
      'api.github.com',
      `token ${GITHUB_PLACEHOLDER_PAT}`,
      { 'x-configamatron-no-auth': '1' },
    );
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([REAL_API_AUTH]);
  });
```

Also add a GitHub Basic lowercase-scheme edge case. In the `describe('github.com Basic injection', ...)` block added above, add one more test after `'passes a malformed-base64 Basic credential through unmodified without crashing'`:

```ts
  it('passes a lowercase "bearer" scheme through unmodified (only exact "Basic " is decoded)', async () => {
    const before = mockUpstream.receivedAuthorizationHeaders.length;
    const sent = `bearer ${GITHUB_PLACEHOLDER_PAT}`;
    const { statusCode } = await requestThrough('github.com', sent);
    expect(statusCode).toBe(200);
    expect(mockUpstream.receivedAuthorizationHeaders.slice(before)).toEqual([sent]);
  });
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm build && pnpm exec vitest run --config vitest.integration.config.ts tests/integration/githubInjection.test.ts` Expected: PASS, including the unchanged happy-path injection tests.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/githubInjection.test.ts
git commit -m "test(github): cover passthrough for non-placeholder, malformed, absent, and forged-marker auth"
```

---

### Task 7: Full verification pass

**Files:** none (verification only — no commit).

- [ ] **Step 1: Run the full project test pipeline**

Run: `pnpm test`

Expected: `format:check`, `lint`, `typecheck`, `test:unit`, `build`, `test:e2e`, and `test:integration` all pass. This exercises every test file touched in Tasks 1–6 plus the untouched suites (`tests/e2e/cli.test.ts`, `tests/vm/vm.test.ts` is not part of `pnpm test` — leave it alone) to confirm nothing else regressed.

- [ ] **Step 2: Spot-check the original bug scenario**

If you have a real sandboxed VM available: run `/remote-control` from inside it and confirm it connects successfully (no more `Transport closed: server rejected connection (code 403)`). This isn't automatable in this repo's test suite (it requires Claude Code's real `/remote-control` flow), but it's the scenario from `docs/investigations/2026-07-22-remote-control-session-token-rejected-by-claude-gate.md` that motivated this whole plan — worth confirming by hand if the environment is available.
