# Never implement OAuth refresh; piggyback on the host provider CLIs

`susentorno` never calls a provider's token endpoint or handles refresh tokens itself. The official host-side CLIs (`claude`, `codex`) remain the sole authority over their own credential files; `run-hosting` only reads the current token out of those files and injects it. To keep the token fresh even when the host runs no interactive session, `run-hosting` proactively **nudges** the host CLI shortly before expiry (`claude -p … --model haiku`, `codex exec …`) so the CLI refreshes its own file, which `run-hosting` then picks up.

## Consequences

- Refresh stays safe even when interactive sessions run on the same host — there is no refresh-token rotation race, because we never rotate anything.
- If the host token fully lapses (the CLI hasn't run there in a very long time), injected requests fail until the host CLI is used again. Accepted: building an independent OAuth refresh flow is explicitly out of scope.
- Depends on [[credential-injection-at-proxy]]; the nudge lifecycle is owned by [[run-hosting-owns-hosting-lifecycle]].
