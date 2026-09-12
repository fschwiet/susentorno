# `setup-guest-unix` propagates the host's ambient TLS trust into the guest

Before running any provisioning step that can access the network, `setup-guest-unix` installs into the Ubuntu guest every server-authentication root trusted by the Windows host but absent from the guest. A guest inherits the host's network path—including corporate or nested TLS interception—but a pristine image does not inherit the trust that makes that path usable, producing partial HTTPS failures for intercepted destinations. Detection is automatic because requiring an operator to identify and export an interception CA would make guest provisioning depend on hidden per-machine setup.

Candidates come from the host's Local Machine and Current User root stores, excluding roots present in either Disallowed store and roots restricted away from server authentication. The guest comparison uses SHA-256 fingerprints over DER bytes so PEM formatting cannot create false differences. Installed roots remain in the guest, and `NODE_EXTRA_CA_CERTS` points at the resulting system bundle.

## Considered Options

- **Require a repeatable `--extra-ca` option.** Rejected because it turns ambient network configuration into a manual prerequisite that users and automated test runs must discover and maintain separately.
- **Detect only the currently presented interception certificate through live handshakes.** Rejected because it couples provisioning to a selected probe set and can miss interception applied to destinations not exercised by those probes.
- **Remove the propagated roots after the setup phase.** Rejected because an isolated guest's passthrough traffic still exits through the host's network path and may encounter the same ambient interceptor.

## Consequences

- Windows and Ubuntu do not have identical public-root sets, so propagation may include legitimate Windows-only roots or inactive private roots in addition to an active interceptor. This is accepted: those roots grant no new destination reachability, the host already trusts them, and network policy remains independently enforced by the proxy stack.
- Ambient trust reflects the host at provisioning time. A later CA rotation or network change is picked up only by rerunning `setup-guest-unix`.
- The integrity of the host trust store is part of the security boundary. The same filtered enumeration also contributes to the proxy stack's upstream trust bundle, as recorded in [[validate-upstream-certificates-against-ambient-trust]].
