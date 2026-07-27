# Configamatron

Configamatron creates development environments in which coding agents run inside isolated guests while a host-controlled network boundary limits their destinations and supplies credentials without placing usable secrets in the guests.

## Environments and machines

**Environment**: The complete configuration and generated state for one isolated agent workspace, owned by a single working directory. _Avoid_: Deployment, sandbox, project

**Host**: The trusted machine that owns environments, credentials, VM lifecycle, and the guest's controlled network boundary. _Avoid_: Host machine, proxy machine

**Guest**: An untrusted Windows or Ubuntu virtual machine in which coding agents and development tools run. _Avoid_: Agent, client, sandbox

**Setup phase**: The temporary period in which a guest has general network access so its prerequisites and pre-isolation configuration can be installed. _Avoid_: NAT phase, online phase

**Isolated phase**: The normal operating period in which a guest has no general Internet route and reaches external services only through the proxy stack. _Avoid_: Host-only mode, offline phase

## Network policy

**Proxy stack**: The host-controlled network boundary through which an isolated guest's permitted external traffic flows. _Avoid_: Envoy, proxy container, forwarder

**Allowlist**: An environment's policy describing which external destinations a guest may reach and how the proxy stack handles each one. _Avoid_: Allow list, network policy, firewall list

**Passthrough destination**: An allowed destination whose encrypted traffic remains end-to-end between the guest and the external service. _Avoid_: Normal host, unprotected destination

**Credential-injected destination**: An allowed destination where the proxy stack may replace a recognized placeholder credential with a host credential. _Avoid_: Authenticated destination, terminated host

**Authentication candidate**: An allowed destination whose requests remain unmodified while limited authentication-header evidence is reported to help classify it later. _Avoid_: Credential candidate, observed host

**Internal switch**: The Hyper-V network shared only by the host and isolated guests, with the host acting as the guests' constrained network edge. _Avoid_: Host-only network, VMnet

## Credentials

**Host credential**: A usable credential retained on the trusted host and made available to the proxy stack for a specific external service. _Avoid_: Real token, proxy credential

**Placeholder credential**: A deliberately unusable value stored in a guest that preserves a tool's signed-in configuration shape and signals eligibility for host-credential injection. _Avoid_: Fake credential, guest credential

**Credential channel**: The association between one external service's host credential, placeholder credential, policy destinations, and refresh lifecycle. _Avoid_: Auth type, secret file

## Provisioning

**VM share**: An environment's generated, read-only provisioning bundle exposed to a guest. _Avoid_: Template folder, shared folder

**Customization input**: A user-authored script, resource, or settings transform that an environment incorporates when regenerating its VM shares. _Avoid_: Override, custom template

**Pre-isolation step**: A provisioning step that runs during the setup phase, before the guest loses general network access. _Avoid_: Pre-script, setup script

**Post-isolation step**: A provisioning step that runs after general network access has been removed from the guest. _Avoid_: Post-script, offline script

**Home settings transform**: An ordered, declarative customization that merges environment-specific values into a guest user's JSON settings. _Avoid_: jq file, settings patch
