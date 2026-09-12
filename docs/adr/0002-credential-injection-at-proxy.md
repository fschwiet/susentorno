# Host credentials are injected at the proxy; the guest holds only placeholders

The guest never holds a usable external-service credential. Each **host credential channel** owns a deliberately unusable placeholder pattern, its auth-list destinations ([[split-allow-auth-block-lists-and-skip-allow-list]]), proxy gate, host secret material, and refresh lifecycle. When a request presents the recognized placeholder, Envoy TLS-terminates the destination and replaces it with the host credential before forwarding upstream; absent or foreign credentials pass through unchanged. The real credential never enters the guest or the access log ([[envoy-access-log-contract]]).

A channel may have several **placeholder mounts**. The Codex channel seeds both `~/.codex/auth.json` and Pi Coding Agent's `~/.pi/agent/auth.json` with the same access-token literal, allowing both clients to use one exact-match proxy gate. Pi's transform is static rather than generated from `src/codexPlaceholder.ts`, so those copies must stay byte-identical; the shared JWT claim shape must also satisfy both clients. This guest-only reuse was chosen over adding a second proxy placeholder and widening the security-sensitive gate.

## Considered Options

- **Reject every non-placeholder credential at the proxy.** Rejected because the guest has no host credential to protect and some clients legitimately use a second credential or no authentication on related endpoints. Injection is exact-match and fail-closed with respect to releasing the host credential, but otherwise preserves the guest's request.

## Consequences

- Placeholders satisfy each client's local validity checks so clients do not initiate their own refresh. Codex uses structurally valid JWTs with a year-2100 expiry and a placeholder account-id claim needed by Pi.
- GitHub's `github.com` gate checks the password half of Basic authentication because git's credential helper chooses the username. GitHub secret shapes use separate SDS files so independent values cannot overwrite one another.
- Codex injection couples `Authorization` and `chatgpt-account-id`: the real account id is attached only when the bearer matches the Codex placeholder, never to an absent or foreign credential.
- The host-side CLI refresh strategy is recorded in [[no-oauth-refresh-piggyback-host-cli]].
