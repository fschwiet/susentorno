# Fix Pi Coding Agent's missing `chatgpt_account_id` claim, injected at the proxy

## Problem

The Pi Coding Agent (`@earendil-works/pi-coding-agent`, installed in
`templates/vm-shared-linux/pre-scripts/03-install-tools.sh`) fails every request to its
OpenAI-Codex provider with `Error: Failed to extract accountId from token`. This was
reported live in a guest VM.

Root cause, confirmed against both the `earendil-works/pi` GitHub source and the actual
installed build in `~/.pi/agent/npm/node_modules` (version `0.84.1`, matching upstream
`main`): `extractAccountId(apiKey)` in `packages/ai/src/api/openai-codex-responses.ts` is
called on **every** request (not just login/refresh). It decodes the current access-token
JWT and reads the nested claim `payload["https://api.openai.com/auth"].chatgpt_account_id`,
throwing this exact error if the claim is absent. The result is set as the
`chatgpt-account-id` header (`buildBaseCodexHeaders`) on the real outbound HTTP/WebSocket
request to OpenAI's backend — it is not a local-only value.

Per ADR 0018, Pi's `~/.pi/agent/auth.json` is seeded (via
`templates/home-jq-transforms/pi-openai-codex-auth.jq`) with a hardcoded copy of the same
placeholder JWT literal as Codex's `CODEX_PLACEHOLDER_ACCESS_TOKEN`
(`src/codexPlaceholder.ts`, built from `buildJwt(PLACEHOLDER_CLAIMS)`). `PLACEHOLDER_CLAIMS`
has only ever contained `{ sub, email, exp }` — the `chatgpt_account_id` claim was never
part of the original design (Pi's requirement wasn't known when ADR 0018 was written), so
the crash is unconditional, not intermittent.

A separate, unrelated finding while investigating: the JWT literal hardcoded in
`pi-openai-codex-auth.jq` is already stale relative to `codexPlaceholder.ts` — it decodes to
`sub: "configamatron-user"` / `email: "configamatron@configamatron.invalid"`, an artifact of
an old project name, while the live constant now produces `"susentorno-user"` /
`"susentorno@susentorno.invalid"`. This is genuine drift (unlike the missing claim), exactly
the risk ADR 0018 flagged ("revisit if hand-syncing the duplicated literal causes drift
pain") — it had already occurred silently, with no test catching it.

## Why the fix isn't just "add any placeholder value"

The `chatgpt-account-id` header reaches OpenAI's real backend unmodified: the proxy's
`CODEX_GATE_LUA` filter only inspects/swaps the `Authorization` header. If the JWT claim
carried an arbitrary made-up string, every real request would carry the real (injected)
bearer token alongside a fictitious account-id header — a mismatch of unknown consequence
against OpenAI's private backend validation.

This codebase already answered the equivalent question for Codex CLI's own guest file:
`sanitizeCodexCredentials.ts` deliberately does **not** placeholder `tokens.account_id` — it
passes the real value through, "to preserve Codex's account-scoped UX" (a design choice made
in a single commit, `4f65d16`, never validated as strictly necessary and not backed by an
ADR). That precedent is the only signal in this codebase about whether OpenAI's backend
cares about this value; treating it as significant is the conservative choice.

Rather than pass a *real* per-environment account id into a placeholder JWT (which would
require new per-environment generation machinery, breaking Pi's placeholder mount's
current shape as a static, git-committed template per ADR 0013, and would put a real value
in the guest, cutting against ADR 0002's "the guest never holds a usable credential"), the
real account id is injected **at the proxy**, exactly like the Authorization bearer token
already is. The guest-side placeholder only needs to be well-shaped enough to satisfy each
client's local validity checks (ADR 0002's existing stated principle) — it does not need to
carry real data.

## Design

### 1. Guest-side placeholder (static, no per-environment plumbing)

- Add a new constant to `src/codexPlaceholder.ts`:
  ```ts
  export const CODEX_PLACEHOLDER_ACCOUNT_ID = 'susentorno-placeholder-account-id';
  ```
- Add the missing claim to `PLACEHOLDER_CLAIMS`:
  ```ts
  const PLACEHOLDER_CLAIMS = {
    sub: 'susentorno-user',
    email: 'susentorno@susentorno.invalid',
    exp: CODEX_PLACEHOLDER_EXP_SECONDS,
    'https://api.openai.com/auth': { chatgpt_account_id: CODEX_PLACEHOLDER_ACCOUNT_ID },
  };
  ```
  This flows automatically into `CODEX_PLACEHOLDER_ACCESS_TOKEN` / `CODEX_PLACEHOLDER_ID_TOKEN`
  and into `CODEX_GATE_LUA` (generated from the constant at config-build time — no manual
  sync needed there).
- Regenerate the `"access"` literal in `pi-openai-codex-auth.jq` to exactly match the new
  `CODEX_PLACEHOLDER_ACCESS_TOKEN` byte-for-byte. This also fixes the stale
  `configamatron`/`susentorno` drift as a side effect. The template's existing top-level
  `"accountId"` field (currently `"susentorno-placeholder-account-id"`, already unused by
  Pi's request path) keeps the same string value, now formally sharing
  `CODEX_PLACEHOLDER_ACCOUNT_ID`'s value for consistency, even though nothing reads it.

### 2. Guest-side consistency: `sanitizeCodexCredentials.ts`

- Replace `tokens.account_id` with `CODEX_PLACEHOLDER_ACCOUNT_ID` alongside the existing
  three placeholdered fields (`access_token`, `id_token`, `refresh_token`). Update the
  function's doc comment: it no longer passes account_id through; four `tokens` fields
  become placeholders, only `auth_mode` and `OPENAI_API_KEY` (sibling to `tokens`) still
  pass through.
- Rationale: once the proxy can inject the real account id (below), the special-cased real
  value pass-through is unnecessary, and removing it means the fix works correctly whether
  or not Codex CLI's own binary happens to use this header the same way Pi does — something
  this design does not need to verify, because both clients now present the same fixed
  placeholder and get the same proxy-side treatment.

### 3. Proxy-side injection (new `chatgpt-account-id` credential_injector)

In `src/envoyConfig.ts`'s `buildCodexEntry` (the `chatgpt.com` filter chain, the only place
`CODEX_GATE_LUA` and the existing Authorization `credential_injector` are wired up):

- Add a second `envoy.filters.http.credential_injector` filter in the same filter chain,
  with its own explicit `name` (e.g. `susentorno.credential_injector.account_id`, following
  the repo's existing `susentorno.auth_pre`/`susentorno.auth_post` naming precedent — two
  filters both named `envoy.filters.http.credential_injector` in one chain is untested
  territory and unnecessary to risk), configured with `header: 'chatgpt-account-id'` (the
  generic credential injector's `header` field is configurable and defaults to
  `Authorization` — confirmed against Envoy's `Generic` extension API, and matches how the
  existing Authorization filter sets `credential.typed_config.header: 'Authorization'`
  explicitly), sourced from a new SDS resource (e.g. `codex_account_id`) via the same
  `sds_config` / watched-directory pattern already used for the bearer-token secret.
  Ordering in `http_filters`: `auth_pre` (Lua) → existing Authorization
  `credential_injector` → new `chatgpt-account-id` `credential_injector` →
  `auth_post` (Lua, extended per below) → `router`.

- **The naive version of this is wrong and must not be built.** `CODEX_GATE_LUA`'s
  `auth == nil` branch `return`s immediately (`src/envoyConfig.ts:529-546`); a
  `chatgpt-account-id` placeholder check appended after that block would never run when
  `Authorization` is absent, leaking the placeholder header upstream unmodified in that
  case. Worse: with `overwrite:false`, the new injector fires whenever
  `chatgpt-account-id` is **absent**, regardless of what `Authorization` was doing — so an
  independent placeholder-strip-and-inject for this header would also attach the real
  account id to requests carrying a foreign real Bearer token (the existing "credential
  pass-through" test scenario) or no credential at all (the existing "missing
  authentication" test scenario). Both are real, already-tested scenarios in
  `codexInjection.test.ts`, and both would newly leak the real account id onto a request
  that isn't ours.

- The fix is to **couple** the two injectors, reusing the marker/sentinel technique already
  built for `Authorization`'s genuinely-absent case (`NO_AUTH_MARKER_HEADER`,
  `NO_AUTH_SENTINEL_VALUE`, `AUTH_POST_FILTER_LUA` — `src/envoyConfig.ts:10-38`), extended
  with an analogous `NO_ACCOUNT_ID_MARKER_HEADER`/`NO_ACCOUNT_ID_SENTINEL_VALUE` pair:
  - In `CODEX_GATE_LUA`, first resolve whether `Authorization` is recognized as *our*
    placeholder (`auth == PLACEHOLDER`), independently of removing it.
  - Only when the bearer is recognized: strip `chatgpt-account-id` if it equals
    `CODEX_PLACEHOLDER_ACCOUNT_ID` (or is already absent), letting the new injector fire.
  - When the bearer is **not** recognized (foreign real value, or genuinely absent — the
    same two cases the existing `authorization` logic distinguishes) and
    `chatgpt-account-id` is absent: force it present via the new sentinel + marker, exactly
    mirroring the existing `NO_AUTH_SENTINEL`/`NO_AUTH_MARKER` dance, so the injector skips
    it.
  - Extend the **shared** `AUTH_POST_FILTER_LUA` (used by every authenticated chain —
    Claude, Codex, both GitHub gates) to also strip the new marker/sentinel pair, mirroring
    its existing `NO_AUTH_MARKER` cleanup. This keeps the post-filter host-agnostic exactly
    as today: the new marker is only ever set by `CODEX_GATE_LUA`, so this is a harmless
    no-op on the Claude/GitHub chains.
  - Net effect: the real account id is only ever injected on the same requests that get the
    real bearer token injected — never on a foreign-credential or no-credential request.

### 4. Real account id source: read and written on the existing credential-read cadence

Rather than a separate one-time read outside the existing channel machinery (which would go
stale if the user re-authenticates Codex CLI as a *different* account while `run-hosting` is
running — the bearer token would update via the existing file watch, but a one-time
account-id secret would not, reintroducing exactly the real-bearer/fictitious-account-id
mismatch this design exists to avoid), fold the account id into the **existing** codex
credential read/write path:

- Add `codexAccountIdSecret: join(proxy, 'secrets', 'codex-account-id-secret.yaml')` to
  `envPaths.ts`, alongside the existing `codexSecret` path.
- Add a plain-value secret writer alongside `writeSecret.ts`'s `formatSecret`/`writeSecret`
  (which hardcode a `Bearer <token>` value) — e.g. `formatPlainSecret(value, resourceName)` /
  `writePlainSecret(...)` that writes the raw string with no prefix, preserving the same
  quoted `inline_string: "..."` YAML shape (the pinned Envoy image, `v1.31`, predates a fix
  for trailing-newline handling in file-based generic secrets, so the exact quoting matters).
  `formatSecret` can be reimplemented in terms of `formatPlainSecret(`Bearer ${token}`,
  resourceName)` to avoid duplicating the SDS YAML shape.
- Add an optional `accountId?: string` field to the `Credentials` interface
  (`src/runHosting/types.ts`). Only the codex path populates it; Claude's `readCredentials`
  leaves it `undefined`.
- Extend `readCodexCredentials.ts` to also read `tokens.account_id` and include it as
  `accountId` in the returned `Credentials`. Fold the "is it a non-empty string" check into
  the function's existing fail-closed guards (alongside the current `auth_mode`/
  `access_token`/`exp` checks) — a missing or malformed `account_id` makes the function
  return `null`, exactly like today's other malformed-file cases. This means no new error
  path is needed: `null` already flows through `CredentialChannel.startupRead()`/
  `prepareRestart()`'s existing `creds === null` handling, which `runHostingLoop`'s startup
  logic already turns into a clean `fatal()` exit with teardown. (The original draft of this
  design proposed a separate `throw` at the `codexChannel`-wiring call site in
  `runHosting.ts` — that would have bypassed `services.closeAll()` since the proxy's other
  services are already running by that point. Folding the check into `readCodexCredentials`
  avoids inventing a second, inconsistent failure path.)
- Widen `CredentialChannelConfig.writeSecret`'s signature from `(token: string, path: string)
  => void` to `(creds: Credentials, path: string) => void` — a small, mechanical change to
  `CredentialChannel`'s two call sites (`startupRead()`, `prepareRestart()`, both of which
  already have the full `creds` object in scope, not just `creds.accessToken`). Update the
  two existing `writeSecret` closures in `runHosting.ts`:
  - Claude's closure is unchanged in behavior, just destructures `creds.accessToken`.
  - Codex's closure additionally writes the account-id secret when `creds.accountId` is
    present: `writePlainSecret(creds.accountId, paths.codexAccountIdSecret,
    'codex_account_id')`, alongside the existing bearer-token write.
  This reuses the exact same read/write cadence the bearer token already has — the account
  id secret gets rewritten every time fresh codex credentials are read, including after a
  full re-login — with no new timer, polling, or restart-triggering logic. (It also avoids a
  second, independent JSON-parsing/`auth_mode`-checking code path outside
  `readCodexCredentials`, which the original draft would have needed.)

### 5. Testing

- `tests/unit/codexPlaceholder.test.ts`: add a test asserting the full decoded claim set of
  `CODEX_PLACEHOLDER_ACCESS_TOKEN` as an explicit object literal (`sub`, `email`, `exp`, and
  the new `https://api.openai.com/auth.chatgpt_account_id` claim) — documents the exact
  values for future changes, per explicit request.
- `tests/unit/templates.test.ts`: add a case to the `home settings transform manifest`
  describe block, mirroring the existing `gate.lua uses the same ... literals as
  envoyConfig.ts` test — parse `pi-openai-codex-auth.jq`'s `"access"` literal and assert it
  equals `CODEX_PLACEHOLDER_ACCESS_TOKEN` byte-for-byte. This is the guardrail that would
  have caught both the missing claim and the naming drift at CI time.
- `tests/unit/sanitizeCodexCredentials.test.ts` and `tests/unit/initEnv.test.ts`: update the
  existing assertions that expect real pass-through (`'acct-uuid-1234'`) to instead expect
  `CODEX_PLACEHOLDER_ACCOUNT_ID` — an explicit, deliberate behavior change from today's code.
- `tests/proxy-stack/codexInjection.test.ts`: its `writeCodexAuth` fixture already sets a
  *host-side, real* `account_id: 'acct-itest'` (this is the value `run-hosting` reads for
  injection, and stays as-is). Add cases covering the coupling behavior from §3, not just
  the happy path:
  - Placeholder `Authorization` + placeholder `chatgpt-account-id` together → upstream
    receives the real bearer token *and* `chatgpt-account-id: acct-itest` (mirrors the
    existing Bearer-injection tests).
  - A foreign real Bearer (the existing "credential pass-through" scenario) with no
    `chatgpt-account-id` header sent → upstream must **not** receive a `chatgpt-account-id`
    header at all (this is the regression the naive design would have introduced).
  - No `Authorization` header at all (the existing "missing authentication" scenario) → same
    assertion: no `chatgpt-account-id` header reaches upstream.
  - The existing WebSocket-upgrade Bearer-injection test only asserts on
    `mockUpstream.receivedUpgradeAuthorizationHeaders`; extend `tests/proxy-stack/mockUpstream.ts`
    to also capture `chatgpt-account-id` on upgrade requests, and add a WebSocket-path
    assertion, since Pi's WebSocket path (`buildWebSocketHeaders`) sets this header exactly
    like its SSE path does.

### 6. Docs

- ADR 0002: note the `chatgpt.com` chain now injects two headers (`Authorization` and
  `chatgpt-account-id`) via two `credential_injector` filters sharing one Lua pre-filter, and
  that Codex's own guest auth file no longer carries any real value at all (account id
  included) — full consistency between the two consumers, no special cases.
- ADR 0018: no mechanism change, but note the `chatgpt_account_id` claim addition and that
  real-value injection for any claim/header this placeholder needs is the proxy's
  responsibility, not the placeholder's — closing the question ADR 0018 left open about
  future consumer requirements.

## Out of scope

- No new refresh/nudge/blue-green-restart logic for account id specifically — it rides the
  existing `CredentialChannel` cadence via the widened `writeSecret` signature (§4), not a
  parallel mechanism.
- No verification of whether Codex CLI's own binary actually sends or needs a
  `chatgpt-account-id` header — the design is correct either way, since both consumers now
  present the same fixed placeholder and get the same proxy-side treatment.
- No change to Pi's inert top-level `"accountId"` JSON field beyond keeping its existing
  string value consistent — it is not read by Pi's request path and is left in place rather
  than removed, since its use in other Pi code paths (if any) is unknown.
