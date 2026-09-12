# Network policy uses separate allow, auth, and block lists

An environment's network policy is assembled from three files: `allow-list.txt` names passthrough `host:port` destinations, `auth-list.txt` groups credential-injected and authentication-candidate destinations under provider pragmas, and `block-list.txt` names bare hosts or leading-wildcard hosts denied on both `:80` and `:443`. The split lets the block list override external entries in both other files and lets `run-hosting --skip-allow-list` open only unmatched traffic while credential handling and explicit blocks remain active.

The policy parsers are the trust boundary for their files. They trim and deduplicate entries, prune allow-list entries covered by a wildcard, reject unsupported wildcard shapes from the result with warnings, and reject structural auth-list errors such as unknown pragmas. `combinePolicy` first removes block-list matches and then resolves exact cross-list collisions by `auth candidate > GitHub > Codex > Claude > passthrough`, so Envoy receives at most one external route for an SNI.

## Considered Options

- **Keep one pragma-sectioned file.** Rejected because an unconditional block and an optional open default are policy-wide operations rather than another peer routing section.
- **Automatically migrate the former `allowlist.txt`.** Rejected because reliably separating its hand-maintained sections would add a one-off upgrade mechanism to an environment model that otherwise rebuilds generated state from scratch.

## Consequences

- Invalid individual entries warn and are excluded while valid survivors remain usable. Structural errors fail configuration; a temporarily unreadable file during a watch event leaves the currently serving configuration in place.
- `--skip-allow-list` changes only the unmatched HTTP/TLS route to open passthrough. It never disables auth-list termination or block-list denial.
- Access logs distinguish `ALLOW OPEN` from ordinary passthrough and print `domain:port`, allowing a discovered destination to be copied directly into `allow-list.txt` ([[envoy-access-log-contract]]).
- `import-sbx-network-policy` is the boundary for upstream policy syntax and normalizes supported `**.` wildcards to the policy's single-leading-`*.` form.
