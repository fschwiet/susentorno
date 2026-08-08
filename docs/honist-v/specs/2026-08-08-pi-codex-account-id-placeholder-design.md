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

- Extend `CODEX_GATE_LUA` to also match-and-strip a `chatgpt-account-id` header equal to
  `CODEX_PLACEHOLDER_ACCOUNT_ID` (same shape as the existing `authorization` check, minus
  the `Bearer ` prefix — this header carries the raw value).
- Add a second `envoy.filters.http.credential_injector` filter in the same filter chain,
  configured with `header: 'chatgpt-account-id'` (the generic credential injector's `header`
  field is configurable — confirmed from the existing Authorization filter's
  `credential.typed_config.header: 'Authorization'`), sourced from a new SDS resource
  (e.g. `codex_account_id`) via the same `sds_config` / watched-directory pattern already
  used for the bearer-token secret.
- No `NO_AUTH_MARKER`/sentinel handling is needed for this header: that dance exists because
  many legitimate requests genuinely lack an `Authorization` header. `chatgpt-account-id` is
  a narrow, Codex/Pi-specific header where "absent" and "should be injected" coincide, so the
  injector's default `overwrite:false` (inject only when absent) is sufficient — a header
  that already holds any *other* real value (e.g. a future client's own valid account id)
  passes through untouched, matching the pass-through precedent for Authorization.

### 4. Real account id source: written once at `run-hosting` startup

- Add `codexAccountIdSecret: join(proxy, 'secrets', 'codex-account-id-secret.yaml')` to
  `envPaths.ts`, alongside the existing `codexSecret` path.
- Add a plain-value secret writer alongside `writeSecret.ts`'s `formatSecret`/`writeSecret`
  (which hardcode a `Bearer <token>` value) — e.g. `formatPlainSecret(value, resourceName)` /
  `writePlainSecret(...)` that writes the raw string with no prefix. `formatSecret` can be
  reimplemented in terms of `formatPlainSecret(`Bearer ${token}`, resourceName)` to avoid
  duplicating the SDS YAML shape.
- In `src/commands/runHosting.ts`, where the codex channel is wired up: read
  `tokens.account_id` from the real `options.codexCredentials` file directly (same file
  already read for the bearer-token channel) and write it once via `writePlainSecret` to
  `codexAccountIdSecret`. This does **not** join the `CredentialChannel` refresh/nudge/
  blue-green-restart state machine (`Credentials`/`CredentialChannelConfig` stay untouched,
  shared as-is with the Claude channel) — account id is static for a given login, unlike the
  access token, so a one-time read-and-write before envoy starts is sufficient. Fail loudly
  (throw, matching `readCodexCredentials`'s existing fail-closed philosophy) if the field is
  missing or the file isn't `auth_mode: "chatgpt"`.

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
  injection, and stays as-is). Add a new case sending placeholder `Authorization` and
  placeholder `chatgpt-account-id` headers together, asserting the upstream mock receives the
  real bearer token *and* `chatgpt-account-id: acct-itest` — mirroring the existing
  Bearer-injection tests.

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

- No changes to `CredentialChannel`, `Credentials`, or `CredentialChannelConfig` (shared
  Claude/Codex refresh machinery) — account id needs no refresh/rotation handling.
- No verification of whether Codex CLI's own binary actually sends or needs a
  `chatgpt-account-id` header — the design is correct either way, since both consumers now
  present the same fixed placeholder and get the same proxy-side treatment.
- No change to Pi's inert top-level `"accountId"` JSON field beyond keeping its existing
  string value consistent — it is not read by Pi's request path and is left in place rather
  than removed, since its use in other Pi code paths (if any) is unknown.
