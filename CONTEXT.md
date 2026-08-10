# susentorno

susentorno creates development environments in which coding agents run inside isolated guests while a host-controlled network boundary limits their destinations and supplies credentials without placing usable secrets in the guests.

## Environments and machines

**Environment**: The complete configuration and generated state for one isolated agent workspace, owned by a single working directory. _Avoid_: Deployment, sandbox, project

**Host**: The trusted machine that owns environments, credentials, VM lifecycle, and the guest's controlled network boundary. _Avoid_: Host machine, proxy machine

**Guest**: An untrusted Windows or Ubuntu virtual machine in which coding agents and development tools run. _Avoid_: Agent, client, sandbox

**Setup phase**: The temporary period in which a guest has general network access so its prerequisites and pre-isolation configuration can be installed. _Avoid_: NAT phase, online phase

**Isolated phase**: The normal operating period in which a guest has no general Internet route and reaches external services only through the proxy stack. _Avoid_: Host-only mode, offline phase

## Network policy

**Proxy stack**: The host-controlled network boundary through which an isolated guest's permitted external traffic flows. _Avoid_: Envoy, proxy container, forwarder

**Network policy**: An environment's combined destination handling, resolved from its allow list, auth list, and block list into the proxy stack's actual configuration. _Avoid_: Allowlist, policy file

**Allow list**: The file naming plain passthrough destinations a guest may reach, with no credential handling. _Avoid_: Allowlist, passthrough list

**Auth list**: The file naming destinations the proxy stack TLS-terminates — either to inject a host credential or to observe an authentication candidate. _Avoid_: Authenticated list, credential list

**Block list**: The file naming destinations that are always denied, overriding a matching entry in the allow list or auth list even if one exists. _Avoid_: Blocklist, denylist, blacklist

**Passthrough destination**: An allow list destination whose encrypted traffic remains end-to-end between the guest and the external service. _Avoid_: Normal host, unprotected destination

**Credential-injected destination**: An auth list destination where the proxy stack may replace a recognized placeholder credential with a host credential. _Avoid_: Authenticated destination, terminated host

**Authentication candidate**: An auth list destination whose requests remain unmodified while limited authentication-header evidence is reported to help classify it later. _Avoid_: Credential candidate, observed host

**Open destination**: A destination reached only because `run-hosting --skip-allow-list` turned off allow list enforcement, not because it appears on the allow list, auth list, or block list. _Avoid_: Unlisted destination, skipped destination

**Blocked destination**: A destination denied specifically because it appears on the block list, as distinct from one denied only for not appearing on the allow list. _Avoid_: Denied destination, blacklisted destination

**Internal switch**: The Hyper-V network shared only by the host and isolated guests, with the host acting as the guests' constrained network edge. _Avoid_: Host-only network, VMnet

**Host network**: The Internal switch plus its host IP assignment and inbound firewall rules, provisioned and torn down together as one unit by `create-host-network`/`delete-host-network`. Distinct from **Internal switch**, which names only the Hyper-V object itself. _Avoid_: Internal switch (when the firewall/IP bundle, not just the switch, is meant)

**Host-run MCP server**: A Model Context Protocol server process that susentorno launches and owns on the host, reachable from an isolated guest at a dedicated hostname through the proxy stack, giving the guest's coding agents host-credentialed tool access without exposing host credentials to the guest itself. _Avoid_: MCP server, tool server

## Credentials

**Host credential**: A usable credential retained on the trusted host and made available to the proxy stack for a specific external service. _Avoid_: Real token, proxy credential

**Placeholder credential**: A deliberately unusable value stored in a guest that preserves a tool's signed-in configuration shape and signals eligibility for host-credential injection. _Avoid_: Fake credential, guest credential

**Host credential channel**: The association between one external service's host credential, placeholder credential, policy destinations, and refresh lifecycle. _Avoid_: Auth type, secret file, credential channel

**Placeholder mount**: A location in the guest environment where a host credential channel's placeholder credential is deposited so a specific tool discovers it. One channel can have more than one placeholder mount (e.g., the codex channel's placeholder can be mounted at both the Codex CLI's `~/.codex/auth.json` and the Pi Coding Agent's `~/.pi/agent/auth.json`); a mount may also occupy only part of a shared, multi-provider file rather than the entire file. _Avoid_: Guest destination, auth file

## Provisioning

**VM share**: An environment's generated, read-only provisioning bundle exposed to a guest. _Avoid_: Template folder, shared folder

**Customization input**: A user-authored script, resource, or settings transform that an environment incorporates when regenerating its VM shares. _Avoid_: Override, custom template

**Pre-isolation step**: A provisioning step that runs during the setup phase, before the guest loses general network access. _Avoid_: Pre-script, setup script

**Post-isolation step**: A provisioning step that runs after general network access has been removed from the guest. _Avoid_: Post-script, offline script

**Home settings transform**: An ordered, declarative customization that merges environment-specific values into a guest user's JSON settings. _Avoid_: jq file, settings patch
