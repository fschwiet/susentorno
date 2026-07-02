# Envoy Sandbox Proxy — Design

## Purpose

Sandbox a coding agent that runs inside an Ubuntu VM (VMware, on a Windows host) by forcing all of its network traffic through an Envoy proxy (Docker on the Windows host). Envoy:

1. Restricts outbound network access to an allow list, initially matching `balanced.policy.txt`.
2. Injects real Claude credentials into requests to Anthropic/Claude endpoints, so the VM itself never holds a usable secret.

This document supersedes any prior notes in this repo on proxying/sandboxing (`PROXY.md`, `docker-sbx.md`, `firecracker-on-wsl.md`) — those are considered out of scope and not used as input to this design.

## Non-goals

- Building our own OAuth refresh-token exchange (relies on the Claude Code CLI on the host refreshing its own credentials normally).
- Filtering DNS resolution itself — the VM can resolve arbitrary hostnames; enforcement happens at the TLS/HTTP connection layer in Envoy.
- Changing VMware network mode/topology — routing is enforced entirely via VM-side iptables and Windows-host port publishing.

## Architecture

```
┌─────────────────────────────┐         ┌───────────────────────────────────┐
│  Ubuntu VM (VMware)          │         │  Windows Host                     │
│                              │         │                                   │
│  coding agent (Claude Code)  │         │  Docker Desktop                   │
│  placeholder credentials.json│         │  ┌─────────────────────────────┐  │
│                              │         │  │ Envoy container             │  │
│  iptables (nat/OUTPUT):      │  DNAT   │  │  :443 listener              │  │
│  tcp/443 → hostIP:443 ───────┼────────►│  │   ├─ SNI=Anthropic/Claude   │  │
│  tcp/80  → hostIP:80  ───────┼────────►│  │   │   family → terminate,   │  │
│                              │         │  │   │   Lua gate + inject,    │  │
│  trusts Envoy's CA (for      │         │  │   │   re-encrypt upstream   │  │
│  the terminated domains only)│         │  │   ├─ SNI=other allow-listed │  │
└─────────────────────────────┘         │  │   │   → raw TCP passthrough │  │
                                          │  │   └─ no match → close      │  │
                                          │  │  :80 listener               │  │
                                          │  │   ├─ Host=allow-listed      │  │
                                          │  │   │   → proxy plain HTTP    │  │
                                          │  │   └─ no match → 403         │  │
                                          │  └─────────────────────────────┘  │
                                          │  SDS secret file (bearer token)   │
                                          │       ▲                           │
                                          │       │ written by                │
                                          │  SessionStart hook (~/.claude/    │
                                          │  settings.json) reads             │
                                          │  ~/.claude/credentials.json       │
                                          └───────────────────────────────────┘
```

### Routing

- The VM's traffic is **not** routed via `HTTP_PROXY`/`HTTPS_PROXY` env vars, because the agent inside the VM cannot be trusted to honor them.
- Instead, VM-side `iptables` NAT rules DNAT all outbound `tcp/443` and `tcp/80` traffic (any destination) directly to the Windows host's IP on Envoy's listener ports. This works regardless of what the agent's tools do, since it operates below the application layer.
- No changes to VMware's network mode are required — the VM only needs routable access to the host's IP, which NAT/bridged modes already provide.

### TLS handling (port 443)

- Envoy uses a `tls_inspector` to read the SNI from the TLS ClientHello without decrypting anything.
- **Anthropic/Claude domain family**: the subset of `balanced.policy.txt`'s `default-ai-services` entries under the `anthropic.com` and `claude.com` parent domains — currently `api.anthropic.com`, `claude.com`, `platform.claude.com`, `statsig.anthropic.com`, `mcp-proxy.anthropic.com`, and `downloads.claude.ai`. Envoy terminates TLS for exactly this set using a self-signed CA (trusted by the VM for these domains only), runs an HTTP filter chain (see Credential Injection below), then re-encrypts and forwards upstream to the real service.
- **All other allow-listed domains**: raw TCP passthrough based on SNI match — Envoy never decrypts this traffic. Because Envoy resolves and connects using the SNI-derived hostname itself, a client cannot use a mismatched SNI to reach a different, non-allow-listed destination.
- **No SNI match**: connection is closed immediately, no bytes forwarded.

### Plain HTTP handling (port 80)

- A handful of allow-list entries are plain HTTP (Ubuntu archive mirrors, OCSP/CRL cert-validation endpoints). These have no SNI-equivalent field, so Envoy must parse the HTTP request itself (`http_connection_manager`) and filter by the `Host` header.
- This is not a MITM/decryption concern — there is no encryption on port 80 to begin with, so no additional CA trust is required in the VM for this path.
- **Host header not in allow list**: HTTP 403.

### Credential injection

The VM never holds a usable Claude credential. Instead:

1. The VM's `credentials.json` (or wherever the agent's Claude Code CLI expects it) is seeded with a fixed **placeholder** OAuth bearer token (e.g. `sk-ant-oat-SANDBOX-PLACEHOLDER`), so the CLI believes it is logged in and does not prompt for interactive login.
2. On the terminated Anthropic/Claude domain family, Envoy's HTTP filter chain runs two stages in order:
   - **Gate (Lua filter):** inspects the `Authorization` header.
     - Exactly matches the placeholder → continue to injection.
     - Absent → pass through unchanged (e.g. unauthenticated telemetry calls).
     - Present but does not match the placeholder → reject (403), fail closed. This catches any real or unexpected credential before it can be forwarded, and never has the real secret in its own logic.
   - **Inject (`credential_injector` filter, built into Envoy):** for requests that passed the gate, replaces the `Authorization` header with the real bearer token, sourced from a file-based SDS (Secret Discovery Service) secret. SDS watches the file and hot-reloads on change — no Envoy restart needed.
3. On the Windows host, a Claude Code `SessionStart` hook (configured in `~/.claude/settings.json`) runs a script every time a Claude Code session starts on the host. It reads `~/.claude/credentials.json`, extracts `.claudeAiOauth.accessToken`, and writes it into the SDS secret file. This keeps the injected token in sync with whatever the host's own logged-in session currently has, without a standalone watcher process.

**Known limitation:** this only refreshes at host session start, not mid-session token rotation. If the host credentials go fully stale (e.g. `claude` isn't run on the host for a long time and the refresh window lapses), requests needing injection will start failing with 401 until the host token is refreshed by using `claude` there again. Building an independent OAuth refresh flow is explicitly out of scope for this design.

### Allow-list maintenance

- A simple source-of-truth file (`allowlist.txt` or similar), seeded from `balanced.policy.txt`'s `network allow` rows, lists `host:port` entries, split into *passthrough* (everything except the Anthropic/Claude family) and *terminate* (the Anthropic/Claude family).
- A generator script reads this file and produces the verbose Envoy `envoy.yaml` (filter chains, SNI/Host matches, routes, access log config).
- Updating the allow list later means editing the simple file and re-running the generator, then restarting the Envoy container.

### Logging

- Envoy access logging is configurable at generation time between two modes:
  - **All**: every request and its allow/deny decision is logged.
  - **Denied-only**: only rejected/closed connections are logged.
- Logs are written to a file on the host, useful both for noticing when the agent attempts something outside the allow list and for tuning the list over time.

## Components / Deliverables

- `docker-compose.yml` — runs the Envoy container; publishes 80/443 to the host; bind-mounts config, the CA cert/key, and the SDS secret file.
- `allowlist.txt` — source-of-truth allow list, seeded from `balanced.policy.txt`.
- `scripts/generate-envoy-config.*` — reads `allowlist.txt`, produces `envoy.yaml`.
- `envoy/envoy.yaml` (generated) — Envoy's full config.
- `envoy/gate.lua` — the placeholder-match gate filter (no secret material in it).
- `envoy/ca/` — self-signed CA cert/key used only for the terminated Anthropic/Claude domain family.
- `scripts/host-session-hook.ps1` — invoked via the host's `~/.claude/settings.json` `SessionStart` hook; syncs the real token from `~/.claude/credentials.json` into the SDS secret file.
- `scripts/vm-setup-iptables.sh` — sets up the DNAT rules inside the Ubuntu VM (run at VM boot).
- `scripts/vm-trust-ca.sh` — installs Envoy's CA cert into the VM's trust store.
- `vm/credentials.json.template` — the placeholder OAuth credential to seed inside the VM.
- `envoy-proxy.md` — new setup/walkthrough doc (prerequisites, host-side steps, VM-side steps, verification steps). The existing `README.md` is out of scope and must not be modified.

## Error Handling / Failure Behavior

| Scenario | Behavior |
|---|---|
| SNI not in allow list (443) | Connection closed immediately, no data forwarded |
| Host header not in allow list (80) | HTTP 403 |
| Terminated-domain request with a non-placeholder, non-empty `Authorization` header | Rejected (403) by the Lua gate, before reaching `credential_injector` |
| SDS secret file missing/stale at Envoy startup | Envoy still starts; passthrough domains keep working; injected-credential requests fail until the host hook populates the file (documented as a first-run step) |
| Host token fully expired (host hasn't run `claude` in a long time) | Requests needing injection return 401; resolved by running `claude` on the host again |

## Testing / Verification Plan

- From inside the VM: `curl` an allow-listed domain succeeds; `curl` a non-allow-listed domain fails/resets.
- From inside the VM: run the coding agent against `api.anthropic.com` using only the placeholder credential; confirm it gets real responses (proves injection works without the VM ever holding the real token).
- From inside the VM: manually send a non-placeholder `Authorization` header to `api.anthropic.com` through the proxy; confirm it's rejected (proves the guardrail).
- Confirm Envoy logs reflect allow/deny decisions per the configured log level.
- Confirm an OS package install (`apt-get update`) succeeds through the proxy (validates port 80 handling).
