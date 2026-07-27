# Real credentials are injected at the proxy; the guest holds only placeholders

The guest never holds a usable credential. Each supported provider seeds the guest with a fixed **placeholder** (Claude `sk-ant-oat-SANDBOX-PLACEHOLDER`, GitHub `ghp-SANDBOX-PLACEHOLDER`, a far-future placeholder JWT for Codex), so the CLI believes it is logged in; the host proxy TLS-terminates that provider's host(s) and swaps in the real credential from a file-based SDS secret before forwarding upstream. This is a **per-provider pattern**: each provider gets its own placeholder, its own Lua pre-filter, its own SDS resource/secret file, and its own `#pragma <provider> authenticated` allowlist section (real auth schemes were discovered empirically via [[allowlist-format-and-parse-trust-boundary]]'s `#pragma auth candidate`). The real token never enters the guest, never appears on any guest-reachable network surface, and is never written to the access log ([[envoy-access-log-contract]]).

## Status

accepted — began Claude-only (2026-07-01), generalized to GitHub (2026-07-19) and Codex (2026-07-20); the per-credential state machine lives in `src/runProxy/credentialChannel.ts`.

## Considered Options

- **The Lua filter as a fail-closed gate that 403s any non-placeholder credential** (the original design). Reversed 2026-07-21 to **pass-through**: the filter injects the real credential *only* when the header exactly matches the placeholder, and otherwise leaves the request's own `Authorization` untouched (and injects nothing when it is absent). The gate was never the security boundary — the guest has no real credential to protect against, so rejection bought nothing and broke legitimate second-credential flows (e.g. Claude's `sk-ant-si-` session token, and endpoints that expect no auth at all).

## Consequences

- Placeholders must satisfy each client's *own* local validity checks so the guest never tries to refresh on its own — hence Codex's placeholder is a structurally valid JWT with a year-2100 `exp`, and Claude's `expiresAt` is set far in the future.
- GitHub's `github.com` Basic-auth gate checks only the password half of `Basic base64(user:pass)`, because the username is chosen by git's credential helper and unknown at config-generation time.
- Each provider's real secret is a separate SDS file so a Claude token rotation (which rewrites its file) never clobbers another provider's credential.
- Choosing to inject at the proxy rather than reverse-engineer OAuth is [[no-oauth-refresh-piggyback-host-cli]].
