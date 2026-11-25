# Windows guest trust is reconciled by one host-driven owner

Before any pre-isolation step, `setup-guest-windows` reconciles guest trust in one operation that owns every trust mutation: host ambient roots (selected by the policy in [[setup-guest-unix-propagates-ambient-trust]]), the environment's proxy CA, and Node's supplemental bundle. The shipped `configure-network` step only verifies the result. Ubuntu's `update-ca-certificates` yields one system bundle Node can point at; Windows has no such PEM artifact, so the reconciler maintains a combined bundle of managed ambient roots plus the current proxy CA and points machine `NODE_EXTRA_CA_CERTS` at it. Pointing Node at the proxy CA alone left it trusting different roots than Windows and Git.

Certificates go into `LocalMachine\Root` only. Ambient trust is additive. The proxy CA is replaceable, and a superseded one is removed only when the managed manifest proves susentorno installed that exact fingerprint, never inferred from subject text; ambiguous ownership fails without deleting anything.

## Considered Options

- **Keep proxy-CA installation in `configure-network`.** Rejected: two owners of guest trust.
- **Windows branches in the Unix ambient-trust installer.** Rejected: the platforms' trust artifacts differ; only host enumeration and the SHA-256 diff are shared.

## Consequences

- The host trust snapshot is taken once per run; host trust changes take effect on the next replay.
