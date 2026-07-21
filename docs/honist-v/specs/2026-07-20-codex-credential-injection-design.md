# Codex Credential Injection — Design

**Date:** 2026-07-20

## Problem

Codex CLI has no credential in the sandboxed VM today — `03-install-tools`
installs it and `04-configure-tools` registers its MCP server, but nothing
provisions `~/.codex/auth.json`, so Codex is unusable inside the sandbox. We
want to inject Codex credentials at the Envoy proxy on the wire, mirroring the
existing Claude and GitHub injection, so the real credential never crosses
into the VM or its share.

## Investigation

Captured via the installed `codex` binary and a live `#pragma auth candidate`
wire capture against `chatgpt.com`:

```
01:47:35  AUTH CANDIDATE  chatgpt.com  https  Authorization=Bearer eyJhb...
01:47:36  AUTH CANDIDATE  chatgpt.com  https  Cookie=__cf_bm=...
```

- Codex calls `https://chatgpt.com/backend-api/codex...` with
  `Authorization: Bearer <access_token>` (a JWT) and a `ChatGPT-Account-Id:
  <account_id>` header (HTTP headers are case-insensitive; the client emits
  this casing internally). `account_id` is not itself a credential — it's an
  account UUID, not a bearer secret — so it needs no gating or injection,
  only to pass through as sent by the VM's placeholder file.
- Codex also sends a `Cookie: __cf_bm=...` (Cloudflare bot-management
  cookie), set by Cloudflare on a prior response and echoed back by the
  client. Not a credential we own; the gate/injector must leave `Cookie`
  untouched in both directions, same as the existing gates already do, and
  it must never appear in access logs (the existing `#pragma auth candidate`
  diagnostic capture already truncates header values to 12 characters for
  exactly this reason — the permanent authenticated chain logs no header
  values at all).
- Token refresh happens against a **different** host,
  `auth.openai.com/oauth/token`, using `tokens.refresh_token`. This mirrors
  Claude exactly: a far-future placeholder `exp` suppresses Codex's
  *proactive* local-expiry check, so the VM's own client has no reason to
  initiate a refresh on its own. This isn't an absolute guarantee against
  every code path (e.g. a refresh retried after some other auth failure) —
  but there's no such path today, and if the VM ever did call
  `auth.openai.com` with the placeholder `refresh_token`, it would simply
  fail (that host isn't allow-listed for the VM at all, so the call never
  reaches OpenAI).
- Unlike Claude's `credentials.json`, `auth.json` has no plain `expiresAt`
  field — the access token is a JWT, and expiry is its `exp` claim. Reading
  real expiry requires decoding the JWT locally (no signature verification
  needed; we trust our own file).
- Codex prefers a WebSocket transport
  (`wss://chatgpt.com/backend-api/codex/responses`) and falls back to plain
  HTTPS on failure. Under a plain TLS-terminating HTTP filter chain (the
  shape Claude/GitHub already use), the WebSocket upgrade gets a 403 from
  Envoy's `http_connection_manager`, which doesn't proxy upgrades by default.
  Codex falls back to HTTPS and still works, but the Codex filter chain will
  add explicit `upgrade_configs` support so the upgrade succeeds instead of
  falling back.
- Verified `codex exec "<prompt>"` runs fully non-interactively (no approval
  or sandbox prompt; `approval: never` / `sandbox: workspace-write` are
  auto-selected), exits 0, and — as expected when the token isn't near
  expiry — does not rewrite `auth.json`. This confirms the same headless
  "nudge" trick used for Claude (`claude -p ... --model haiku`) works for
  Codex. One wrinkle found during verification: `codex exec` prints
  "Reading additional input from stdin..." and appears to peek at stdin even
  when given a prompt argument. It resolved immediately in a shell with
  closed stdin, but `run-proxy`'s nudge call must not rely on that — it will
  explicitly pass `stdin: 'ignore'` to `execa` rather than inherit whatever
  stdin the long-running `run-proxy` process happens to have, so a nudge can
  never hang waiting on it. The nudge runs `codex exec` directly on the
  **host**, using the host's real `auth.json` over the host's own normal
  network path — it never touches the sandboxed VM's proxied traffic (the
  gateway only forwards connections arriving from the VM's host-only
  adapter), so it can't be blocked by the placeholder-only gate.

## Scope

One host gets TLS-terminated injection: `chatgpt.com:443` (exact host only;
other `*.chatgpt.com` subdomains carry no credentialed traffic and stay
passthrough). Single Bearer scheme, same shape as the existing Claude
injection.

This design is scoped to `auth_mode: "chatgpt"` (ChatGPT-plan sign-in),
confirmed from the real `auth.json` this was designed against. Codex also
supports API-key-based operation (`OPENAI_API_KEY` set, `auth_mode:
"api_key"`), which talks to a different host (`api.openai.com`) with a plain
`Authorization: Bearer <api_key>` and no `ChatGPT-Account-Id`/JWT-expiry
machinery at all — that mode is out of scope here and would need its own
(much simpler, GitHub-PAT-shaped) design if ever needed.

## Architecture — generalizing `run-proxy` to multiple credential channels

`runProxyLoop` is currently hardwired to exactly one credential source (one
file to watch, one secret to write, one nudge command, one refresh-timer/
backoff state machine). Because Envoy's file-based SDS `watched_directory`
does not actually hot-reload in this environment (confirmed in the blue-green
restart design — inotify doesn't cross the bind mount), *every* credential
rotation, for any host, already forces a full blue-green container swap.
Codex's token updates must flow through that same restart pipeline; there is
no viable side-channel that bypasses it.

Everything currently inlined as Claude-specific state and logic in
`runProxyLoop` — `lastAppliedToken`, `lastSeenExpiresAt`, the nudge timer,
`armTimer`/`doNudge`/`handleFailedAttempt`/`onTimer`, `refreshState()` — is
extracted into a new reusable module, `src/runProxy/credentialChannel.ts`,
parameterized by:

```ts
interface CredentialChannelConfig {
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
```

`Credentials` (`{ accessToken, expiresAt }`) and `planNextActions` are
already source-agnostic and need no changes — only credential *extraction*
differs per source. `runProxyLoop` creates one channel instance per
configured source (Claude, Codex), watches each one's file (generalizing the
existing `pendingCredentials` boolean into a per-channel dirty set alongside
the existing `pendingAllowlist`), and in its restart pipeline loops over
whichever channels are dirty, writes their secrets, and — only after a color
swap actually succeeds — tells each applied channel to commit its new token.

Each channel tracks its own `consecutiveFailures`/backoff independently, so
a transient Codex refresh hiccup doesn't reset or interfere with Claude's
timer. The *terminal* outcome stays shared, though: if either channel
exhausts `maxAttempts`, the whole proxy still exits non-zero (today's "loud
failure" behavior), rather than leaving the sandbox silently half-broken
with one channel quietly stale.

## Provisioning — VM placeholder `auth.json`

New `sanitizeCodexCredentials.ts`, mirroring `sanitizeCredentials.ts`, with
one difference: because Codex's own client checks the access token's JWT
`exp` claim locally to decide whether to refresh, the placeholder can't be
an arbitrary opaque string the way Claude's `sk-ant-oat-SANDBOX-PLACEHOLDER`
is — it must be a syntactically valid (garbage-signature) JWT with `exp` set
far in the future (mirroring Claude's year-2100 `expiresAt` trick), so the
VM's own Codex CLI never believes it needs to refresh.

- `tokens.access_token` → a fixed placeholder JWT (dummy header/payload with
  `exp` ≈ year 2100, dummy `sub`/`email`, dummy signature segment — never
  sent to OpenAI, only ever compared against by our own gate). This is the
  exact string the proxy's gate checks for and the credential_injector
  replaces.
- `tokens.id_token` → same treatment (a placeholder JWT), since Codex may
  decode it locally for display without ever transmitting it.
- `tokens.refresh_token` → a fixed placeholder string (never used, since the
  VM's access token never appears expired).
- `tokens.account_id`, `auth_mode`, `OPENAI_API_KEY` → pass through
  **unchanged** from the real file, same as GitHub's real username/email:
  not secrets, and keeping them real preserves Codex's account-scoped UX in
  the sandbox.

**Wiring:**
- `init.ts` gains `--codex-credentials <path>` (default `~/.codex/auth.json`),
  and `initEnvironment` writes the sanitized `auth.json` into both
  `vm-shared` and `vm-shared-windows`, same two-target pattern as
  `credentials.json`.
- `envPaths.ts`: add `authJson` to `VmSharedPaths`; add
  `codexSecret: join(secretsDir, 'codex-secret.yaml')`.
- New `templates/vm-shared/09-codex-config.sh` +
  `templates/vm-shared-windows/09-codex-config.ps1`, mirroring
  `08-claude-config`: `mkdir -p ~/.codex` and symlink the shared placeholder
  `auth.json` into place, so re-running `init` regenerates it without
  re-running the VM script.
- CA trust needs **no changes** — `06-trust-ca.ps1` already sets
  `NODE_EXTRA_CA_CERTS` for "claude/codex" both.
- `codex-secret.yaml` added to `.gitignore`, same as the GitHub secret files.

## Envoy filter chain

New `buildCodexEntry()` in `envoyConfig.ts`, structurally mirroring
`buildClaudeEntry()`:

- `envoy.filters.http.lua` gate — exact-match against `Authorization: Bearer
  <CODEX_PLACEHOLDER>`, same shape as `templates/proxy/gate.lua`, emitted as
  an **inline** Lua source string (following GitHub's precedent) rather than
  a new mounted file, so `docker-compose.yml` is unchanged.
- `envoy.filters.http.credential_injector` pointing at a new SDS resource
  `codex_bearer_token`, file `.configamatron/proxy/secrets/codex-secret.yaml`
  (same `Bearer <token>` shape as `sds-secret.yaml`; `writeSecret`/
  `formatSecret` are generalized to take a resource name instead of adding a
  near-duplicate module).
- `upgrade_configs: [{ upgrade_type: 'websocket' }]` added to this chain's
  `http_connection_manager` only — Claude/GitHub chains are untouched. The
  gate and credential_injector both run on the initial upgrade request's
  headers, same as any normal request. `route.timeout: 0s` bounds only the
  route timeout, not idle-connection reaping — the implementation needs to
  check `stream_idle_timeout` behavior for the upgraded connection too (same
  concern already noted for Claude's long-lived streaming responses).
- `Cookie` is never touched by the gate or injector — it passes through
  unmodified in both directions.
- Route `timeout: '0s'` (same rationale as Claude: don't cut a long-lived
  connection).

## Allowlist wiring

New `#pragma codex authenticated` section in `allowlist.ts`, mirroring
`githubAuthenticated`: a `codexAuthenticated: string[]` field on `Allowlist`,
parsed/formatted/prioritized alongside the existing sections, and folded
into `terminateTlsHosts()`. Contents: `chatgpt.com:443`.

## Testing

- **Unit:** `readCodexCredentials` (JWT decode: valid/malformed/missing
  fields), `sanitizeCodexCredentials` (placeholder JWT construction, real
  fields pass through unchanged), `credentialChannel` (state machine
  exercised generically, then once each for a Claude-shaped and
  Codex-shaped config, including independent failure/backoff isolation
  between two channels), `envoyConfig` additions (Codex gate + injector +
  `upgrade_configs` present in rendered config), generalized
  `writeSecret`/`formatSecret`.
- **Integration:** extend the existing proxy integration tests to bring up
  Envoy with both a fake Claude and fake Codex credential file, confirm both
  inject correctly against a mock upstream, confirm a leaked real Bearer
  value from the VM is 403'd on the Codex chain (same as Claude's), and
  confirm a WebSocket upgrade request through the Codex chain reaches the
  upstream instead of 403ing.
- **Manual:** end-to-end sandboxed `codex exec`/interactive session through
  the real proxy, confirming injection and that the WebSocket path no
  longer falls back to HTTPS.
- `nudgeCodexRefresh`'s actual refresh-on-near-expiry behavior can only be
  fully confirmed by observing a real proxy run up to a real token's expiry
  window — not something to fake in tests, same as `nudgeRefresh.ts` is
  trusted today without forcing Claude's real expiry either.
