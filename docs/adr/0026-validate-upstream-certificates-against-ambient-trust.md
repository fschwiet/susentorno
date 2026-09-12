# Validate upstream certificates against public and ambient trust

Every TLS-terminated external upstream is verified against an **upstream trust bundle** assembled at `run-hosting` startup from Node's bundled public root program and the host's ambient trusted roots. Envoy also requires a DNS SAN matching the configured SNI hostname. Without both chain and name validation, the proxy could send a host credential to an attacker-controlled upstream and then hide that substitution behind the proxy CA trusted by the guest.

The host-root enumeration is shared with guest ambient-trust propagation: `enumerateHostTrustedRoots` reads the Windows Root and Disallowed stores, and the upstream bundle combines its usable roots with Node's public roots. This keeps the host's direct trust assumptions, the guest's propagated ambient trust, and the proxy stack's upstream validation aligned without a second discovery mechanism.

## Considered Options

- **Use only the Envoy container's CA bundle.** Rejected because it omits ambient interception roots trusted by the host.
- **Use only the Windows Root store.** Rejected because Windows lazily retrieves parts of its public root program, which Envoy cannot trigger reliably.
- **Validate the chain without the DNS name.** Rejected because a valid certificate for an unrelated domain would still be sufficient to receive an injected credential.

## Consequences

- The integrity of the host trust store is a security boundary: any ambient CA trusted there can mint a certificate the proxy accepts for a credential-injected destination.
- Bundle assembly occurs once per `run-hosting` process; policy-driven Envoy swaps reuse the file, and host trust changes require restarting the command.
- Validation covers chain and DNS name, not leaf revocation. Filtering against the Windows Disallowed stores is best-effort because an empty result cannot be distinguished from an unreadable-but-nonthrowing store.
- Test-only upstream overrides remain unverified unless `--verify-upstream-overrides` supplies an additional CA; `run-hosting` warns when an override is left unverified.
- Passthrough destinations remain end-to-end TLS and are validated by the guest, while host-run MCP routes terminate to local cleartext rather than an external TLS upstream.
