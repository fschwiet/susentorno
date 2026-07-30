# Pi Coding Agent's placeholder mount reuses Codex's placeholder literal, not its own

The Pi Coding Agent's `~/.pi/agent/auth.json` (`openai-codex` key) is seeded, via a static `home-jq-transforms` filter, with the exact same placeholder access token string as `~/.codex/auth.json` — `CODEX_PLACEHOLDER_ACCESS_TOKEN` from `src/codexPlaceholder.ts` — rather than giving Pi its own placeholder and widening the proxy's `chatgpt.com` gate (`CODEX_GATE_LUA` in `src/envoyConfig.ts`) to match either. This lets Pi's `chatgpt.com` requests get the codex [[host-credential-channel]]'s real token injected with no proxy-code changes, at the cost of that JWT literal now existing in two unlinked places that must be kept in sync by hand.

## Considered Options

- Giving Pi its own placeholder constant and an `or` in `CODEX_GATE_LUA`. Rejected for now to keep this change guest-side only; revisit if hand-syncing the duplicated literal causes drift pain.

## Consequences

- If `codexPlaceholder.ts`'s claims or `buildJwt` ever change, `templates/home-jq-transforms/pi-openai-codex-auth.jq` must be updated by hand, or Pi's `chatgpt.com` requests silently stop matching the gate and fail upstream un-injected.
