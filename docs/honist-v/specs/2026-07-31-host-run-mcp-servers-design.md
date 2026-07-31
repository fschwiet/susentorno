# Host-run MCP servers, reached through the proxy on loopback

## Purpose

Configamatron can launch MCP (Model Context Protocol) servers on the host and expose each to an isolated guest as an HTTPS endpoint on a dedicated hostname, so a guest's coding agents can use tools backed by host credentials and host filesystem access without those credentials ever entering the guest. This reuses the existing proxy boundary end to end — Envoy already terminates TLS for a small set of hosts and forwards elsewhere (ADR [[egress-through-host-envoy-proxy]]) — rather than opening any new network path.

See ADR [[host-run-mcp-servers]] for the accepted architecture, rejected alternatives, and the trade-offs behind it. This spec is the implementation detail the ADR doesn't carry: file schema, exact sequencing, error conditions, and testing.

## Architecture & data flow

```
.configamatron/mcp-servers.yaml (per environment)
        │  read once at run-proxy startup
        ▼
run-proxy: for each entry — allocate loopback port, spawn `command`
           (shell string, {ip}/{port} substituted, cwd/env applied)
        │
        ├─► (fast, synchronous) ports known ──► resolve MCP/allowlist
        │                                        hostname collisions ──► build
        │                                        envoy.yaml + reissue leaf SANs
        │                                        ──► bring up Envoy, wait ready
        │
        └─► (background, for run-proxy's whole lifetime) per server:
            TCP-connect readiness probe (60s timeout) + process-exit listener
            ──► either signal, at any time ──► fatal(): kill every other MCP
                server, tear down Envoy, exit non-zero, spoken alert

update-shares: reads the same mcp-servers.yaml (independent of run-proxy's
    state), generates a re-runnable guest post-script registering each
    server with the Claude and Codex CLIs

Guest agent ──TLS (SNI=hostname)──► Envoy :443 ──cleartext HTTP──► host.docker.internal:<port> ──► 127.0.0.1:<port> (host process)
```

Envoy runs inside the Docker container, so `127.0.0.1` from its perspective is the *container's* own loopback, not the host's — reaching a host-bound listener requires `host.docker.internal` (already declared as `host.docker.internal:host-gateway` in `templates/proxy/docker-compose.yml`, currently unused). This means **two different addresses exist for one MCP server**: the spawned process itself binds `127.0.0.1` (via the `{ip}` substitution — kept loopback-only so nothing beyond the host and its own Docker networking can reach it directly), while the Envoy cluster's upstream address is `host.docker.internal`. See "Envoy destination kind" below.

Two consumers read `mcp-servers.yaml`: `run-proxy` (launch + Envoy chain + SANs, at its own startup) and `update-shares` (post-script generation, whenever it's run, whether or not run-proxy is up). Both are read-only parses of the same declarative source.

Envoy bring-up does **not** wait for MCP servers to become ready — see "Startup sequencing" below. A guest can therefore see the proxy come up and be reachable before every declared MCP server is confirmed working.

## `mcp-servers.yaml` schema

Location: `.configamatron/mcp-servers.yaml`, one file per environment (matching the per-directory environment model, ADR [[per-directory-environment-model]]). Optional — an environment with no MCP servers simply omits the file.

```yaml
servers:
  - name: filesystem
    hostname: filesystem.internal     # .internal recommended, not enforced
    command: npx -y @modelcontextprotocol/server-filesystem {ip} {port} /host/allowed/path
    cwd: C:\Users\me\projects          # optional
    env:                                # optional
      SOME_TOKEN: abc123
```

Fields:

- **`name`** (required, string): identifier used for log-line prefixes (`[filesystem] ...`), readiness/failure reporting, and as the server identifier passed to `claude mcp add`/`codex mcp add`. Must be unique across all entries in the file.
- **`hostname`** (required, string): the SNI hostname a guest uses to reach this server. Becomes an Envoy `filter_chain_match` server name and a leaf cert SAN. Must be unique across all entries in the file. Not validated against any particular domain suffix — `.internal` is a written recommendation in the file's own template comment, not an enforced rule.
- **`command`** (required, string): a shell string, spawned through a shell (not argv form). `{ip}` and `{port}` are substituted with `127.0.0.1` and the port Configamatron assigned to this server before spawning. Since every substituted value is Configamatron's own (never guest- or network-supplied) input, there is no injection concern in going through a shell here.
- **`cwd`** (optional, string): working directory for the spawned process. Omitted → inherits run-proxy's own working directory.
- **`env`** (optional, map of string→string): extra environment variables. Merged **over** run-proxy's own inherited process environment (so PATH, host tool locations, etc. are still present); on a key collision, the YAML's value wins.

### Validation (fatal at startup, before spawning anything)

- The file must parse as YAML matching this shape (missing/wrong-typed required fields is fatal, same tier as an unreadable file — this is a structural config problem, not content to warn-and-drop, unlike `allowlist.txt`'s per-line tolerance).
- `name` must match a safe-identifier shape (e.g. `^[a-zA-Z0-9_-]+$`) — it's interpolated into `[<name>]` log prefixes and passed as a bare CLI argument to `claude mcp`/`codex mcp`. Fatal if it doesn't.
- `hostname` must look like a valid DNS hostname — it's interpolated into an Envoy SNI match, a leaf cert SAN, and a `https://<hostname>` URL. Fatal if it doesn't.
- Two entries sharing the same `name` is fatal.
- Two entries sharing the same `hostname` is fatal.

These are deliberately **not** warn-and-drop: unlike a bad allowlist line (which can be dropped and the proxy still built from the survivors), an ambiguous MCP declaration has no well-defined "best effort" — there's no principled way to pick which of two same-named or same-hostnamed entries wins.

### Collision with `allowlist.txt`

A declared MCP `hostname` may coincide with a `host:443` entry that also appears in `allowlist.txt` (in any of its sections). This is **not** fatal: MCP wins, resolved by a dedicated step run after both files are parsed and before `generateEnvoyConfig`/SAN derivation:

- The resolved allowlist has the colliding entry removed from whichever section it was in.
- A warning is logged: `collision: '<host>:443' listed in <allowlist section> and mcp-servers.yaml; using mcp-servers.yaml`.

This mirrors the existing intra-allowlist collision priority (`authCandidate > github > codex > claude > passthrough`, in `parseAllowlist`) but lives as a separate function, since `mcp-servers.yaml` is a different file and `parseAllowlist` has no reason to know about it. MCP sits above all five existing tiers.

This resolution only matches exact `host:443` strings, the same granularity `parseAllowlist`'s own collision logic already uses. It does not attempt to detect an MCP hostname falling inside an unrelated passthrough wildcard (e.g. `*.internal:443`) — that's not a new gap this feature introduces: the existing allowlist system doesn't resolve exact-vs-wildcard overlaps as collisions either, relying instead on Envoy's own SNI matching, which already prefers an exact `server_names` match over a wildcard one. An MCP chain's exact hostname match takes precedence over a wildcard passthrough chain for the same reason.

## run-proxy: launch, readiness, and supervision

### Startup sequencing

1. Read and validate `mcp-servers.yaml` (fatal on any of the validation failures above). If the file doesn't exist, there are no MCP servers for this environment — proceed with an empty list.
2. Read and parse `allowlist.txt` as today; run the MCP/allowlist collision-resolution step against the two parsed sources to get the effective allowlist.
3. For each declared server, allocate a free loopback port (same open-ephemeral-socket-then-close pattern as `allocateColorPorts`; all ports for this run held open simultaneously before any is released, so the OS can't hand out the same port twice). This is synchronous and fast — no process has been spawned yet.
4. With ports now known, build `envoy.yaml` (effective allowlist + one filter chain/cluster per MCP server) and reissue the leaf if the SAN set — effective-allowlist-derived hosts unioned with MCP hostnames — changed.
5. Spawn every declared server's `command` **in parallel** (not waiting for any to finish spawning before starting the next). Each spawn applies that entry's `cwd`/`env`.
6. Continue the normal Envoy bring-up (allocate color ports, force-recreate the color container, wait for its own `/ready`) **concurrently** with MCP server startup — Envoy bring-up does not wait on MCP readiness.
7. Independently of Envoy's bring-up, each spawned server gets:
   - A **TCP-connect readiness probe**: poll `127.0.0.1:<port>` (from the host's own perspective this time, not `host.docker.internal` — the probe runs in run-proxy's own process, not inside the Envoy container) until a connect succeeds or 60 seconds elapse (fixed timeout, not configurable per server — matches the existing `readyTimeoutMs` constant Envoy itself uses). The probe stops polling once it either succeeds or times out — it does not keep running afterward.
   - A **process-exit listener**, armed immediately on spawn and staying armed for run-proxy's entire remaining lifetime (not just until the probe resolves).
   - If `spawn` itself fails synchronously (e.g. the command isn't found, or `cwd` doesn't exist), that's treated identically to an immediate process exit — same `fatal()` path.
8. When a server's readiness probe succeeds, log `[<name>] ready in <elapsed>` — informational only, does not block or gate anything.
9. run-proxy finishes its own startup (and logs "serving") as soon as Envoy is ready, independent of whether every MCP server has reported ready yet. A guest reaching an MCP hostname before its server is ready sees connection-refused at the cleartext cluster; this is expected and resolves itself once the server finishes starting.

### Runtime supervision

At any point during startup or afterward, for the life of the run-proxy process:

- If a server's readiness probe times out (60s with no successful connect, and the process is still running) → fatal.
- If a server's process exits, for any reason, at any time (whether or not it was ever confirmed ready) → fatal.

"Fatal" reuses the existing `fatal()`/`shutdown()` machinery in `runProxyLoop` (stop watchers/timers, stop the log stream, resolve with a non-zero exit code), plus one new piece of behavior this feature requires: **today, `shutdown()` never actively stops the running Envoy container** — a clean SIGINT/SIGTERM deliberately leaves it running (logged as "container left running"), and every existing fatal path (bad credentials, config build failure, etc.) just exits the run-proxy process without touching the container either, so the last-successfully-applied config keeps serving. That's fine for those cases, but it defeats the point here: if the container were left running after an MCP failure, every *other* destination (Claude, Codex, GitHub, passthrough) would keep working fine, and only the failed MCP hostname would be dead — exactly the silent partial degradation this feature exists to prevent. So an MCP-triggered fatal additionally **actively stops the currently-active color's container** (and the idle one too, if a blue/green swap was in flight) before exiting, alongside killing every other still-running MCP server via `killProcessTree` (the same mechanism already used for other child processes, since a plain `.kill()` can leave grandchildren behind — e.g. an `npx`-wrapped server). This triggers the existing spoken abnormal-exit alert (ADR [[run-proxy-speaks-on-abnormal-exit]]).

This means "refuses to start if a declared server fails to launch," from the original design intent, now means: run-proxy may *become reachable* before a failing server is caught, then abnormally exit shortly after (within 60s at the outside, sooner if the process exits immediately) — not that it never becomes reachable at all. This was a deliberate simplification (see ADR [[host-run-mcp-servers]]) since gating Envoy's own startup on MCP readiness would need a separate synchronization step this design doesn't otherwise require.

### Console output

Each server's stdout and stderr are streamed line-by-line into run-proxy's own console output, each line prefixed `[<name>] `. This runs for the life of the process (started right after spawn, stopped when the process exits or run-proxy shuts down) — the same idea as the existing Envoy access-log stream, but a separate, simpler source (no parsing/classification, just prefix-and-forward).

### Shutdown

On any exit path — clean (SIGINT/SIGTERM) or abnormal (fatal, uncaught exception) — every still-running MCP server process is killed via `killProcessTree` before run-proxy exits, alongside the existing Envoy container teardown.

### No live watching

`mcp-servers.yaml` is read once at run-proxy startup, like the original design intent. Unlike `allowlist.txt` and the credential files, there is no file watcher on it — a change to the file (added/removed/edited server) takes effect only on the next run-proxy start. This is consistent with MCP server processes not being tied to the blue/green color swap: they start once and live for the whole session, independent of allowlist/credential-triggered Envoy restarts, which just keep re-referencing the same fixed hostnames/ports on every config rebuild.

## Envoy destination kind

Each MCP server gets its own filter chain in `envoy.yaml`'s `listener_443`, alongside the existing Claude/Codex/GitHub/auth-candidate chains and the passthrough catch-all:

- `filter_chain_match: { server_names: [hostname] }`.
- Downstream TLS: terminates on the same leaf cert as every other terminated chain (`/etc/envoy/ca/leaf-cert.pem` / `leaf-key.pem`).
- `http_connection_manager` → single route → a per-server cluster, `timeout: '0s'` (matching the Claude/Codex chains, so a long-lived MCP tool call isn't cut off at Envoy's default 15s route timeout).
- `http_filters`: **router only**. No `configamatron.auth_pre`/`auth_post` lua gates, no `credential_injector` — this destination kind has no auth of any form (see ADR [[host-run-mcp-servers]] for why).
- Access log: new pathId `mcp`, using the same `accessLog()`/`CFGM|...` format as the Claude/Codex/GitHub chains (ADR [[envoy-access-log-contract]]). `classify.ts` maps pathId `mcp` to a new friendly tag `ALLOW MCP`.

Cluster (per server): `STRICT_DNS`, `dns_lookup_family: V4_ONLY`, single endpoint `host.docker.internal:<assigned-port>` — **not** `127.0.0.1`, since that would resolve inside the Envoy container rather than on the host — with **no `transport_socket`** — cleartext upstream. This needs a new small builder distinct from the existing `buildTlsUpstreamCluster` (which unconditionally sets `UpstreamTlsContext`), since every other terminated chain's upstream is itself TLS and this one deliberately isn't.

### SAN integration

`terminateTlsHosts(allowlist)` currently derives the leaf's SAN list purely from the (post-collision-resolution) `Allowlist`. MCP hostnames are unioned into that same list at the `runProxyLoop` call site (`applyAllowlist`, which already calls `ensureLeaf` and the config builder together) — not by changing `terminateTlsHosts`'s signature, since MCP servers aren't part of the `Allowlist` type. Because `mcp-servers.yaml` is read once at startup, the MCP contribution to the SAN set is fixed for run-proxy's lifetime; only the allowlist-derived part can change (and does, on the existing allowlist-watch/reissue path) — including possibly triggering a *new* MCP/allowlist collision on a later allowlist edit, caught the same way as on startup, on that reparse.

## `update-shares` post-script generation

`update-shares` reads `mcp-servers.yaml` independently of whether run-proxy is running (it only needs the declared servers, not their live state). If the file doesn't exist for an environment, no MCP post-script step is emitted — not an error.

If it exists, `update-shares` generates a built-in post-isolation step, woven in via the existing `weaveShares.ts` staging mechanism (one per platform: `.sh` for the Linux share, `.ps1`-equivalent for the Windows share), containing, for every declared server, an unconditional remove-then-add pair:

```sh
claude mcp remove --scope user filesystem || true
claude mcp add --scope user --transport http filesystem https://filesystem.internal
codex mcp remove filesystem || true
codex mcp add filesystem https://filesystem.internal
```

(`codex mcp` has no `--scope` flag; `claude mcp` uses `--scope user` on both the remove and the add.) This is regenerated fresh on every `update-shares` run — same "stage, then atomically swap in" mechanism already used for every other built-in/custom script. The `|| true` on each `remove` absorbs the harmless "not found" case on first run; this is a post-isolation step because the endpoint only resolves-to-host and routes through the proxy once the guest is isolated and run-proxy is up (an earlier, pre-isolation registration attempt would have nothing to reach).

**This converges additions and edits, not removals.** The script only ever mentions servers currently declared in `mcp-servers.yaml` — deleting or renaming an entry means the post-script simply stops mentioning the old name, but never removes its existing guest registration. A stale `claude mcp`/`codex mcp` entry pointing at a hostname that no longer has a server (or a server behind a different name) is left behind until someone removes it by hand in the guest (`claude mcp remove --scope user <old-name>`, `codex mcp remove <old-name>`). This is a known, accepted limitation — automatic removal would need Configamatron to track what it registered on a *previous* run (e.g. a small state file persisted somewhere `update-shares` can read/write across runs), which is more machinery than this feature's first version needs.

The exact Codex CLI subcommand syntax for removal should be double-checked against the installed `codex` CLI version during implementation; the shape (remove-then-add, no scope flag) is expected to hold regardless.

## Error handling summary

| Condition | Handling |
|---|---|
| `mcp-servers.yaml` unreadable or fails schema validation | Fatal at startup |
| Duplicate `name` across entries | Fatal at startup |
| Duplicate `hostname` across entries | Fatal at startup |
| MCP `hostname` collides with an `allowlist.txt` `host:443` entry | Not fatal — MCP wins, warning logged, allowlist entry dropped |
| A server's readiness probe times out (60s) | Fatal — full teardown (all MCP servers + Envoy), non-zero exit, spoken alert |
| A server's process exits, at any time | Fatal — same as above |
| Guest reaches an MCP hostname before that server is ready | Connection-refused at the cleartext cluster; resolves once the server finishes starting; not an error condition |
| A server is deleted/renamed in `mcp-servers.yaml` | Not an error; its guest CLI registration is left stale until manually removed (known limitation, see "update-shares post-script generation") |

Recovery from any fatal MCP condition: comment the broken server out of `mcp-servers.yaml` and restart run-proxy — the same recovery model as a broken allowlist entry.

**Known limitation, deliberately out of scope:** run-proxy does not verify that a spawned server actually bound `127.0.0.1` rather than `0.0.0.0` — the readiness probe connects to `127.0.0.1:<port>`, which succeeds either way, so it can't tell the two apart. A server that ignores the `{ip}` substitution and binds all interfaces could become reachable from beyond the host+guest trust boundary this feature otherwise relies on, depending on the host's own firewall configuration. Confirming the actual bind address cross-platform is nontrivial enough that this is left as an accepted risk rather than solved here; it only matters for a misbehaving or misconfigured server.

## Testing

Following this repo's existing split (`vitest.config.ts` unit, `vitest.proxy-stack.config.ts` Docker/Envoy integration, `vitest.guest.config.ts`/QEMU full VM):

- **Unit:**
  - `mcp-servers.yaml` parsing/validation: valid file, missing required fields, duplicate `name`, duplicate `hostname`.
  - The MCP/allowlist collision-resolution step: MCP wins, correct section reported in the warning text, no false positives when hostnames don't collide.
  - The new Envoy chain/cluster builder: snapshot-style checks matching how the existing per-kind builders (Claude/Codex/GitHub) are tested — filter chain shape, no auth filters, cleartext cluster with no `transport_socket`.
  - `classify.ts`'s new `mcp` pathId → `ALLOW MCP` mapping.
  - `runProxyLoop`'s new fatal triggers (readiness timeout, process exit) via its existing dependency-injection style (`RunProxyDeps`), including that a timeout/exit *after* Envoy has already reported ready still tears everything down.
  - Port allocation reuses the existing ephemeral-port-then-close helper pattern — no new logic to separately unit test beyond confirming it's wired up per-server.
- **Proxy-stack (real Envoy in Docker):** a fake MCP server (trivial HTTP echo) declared in a test `mcp-servers.yaml`, confirming an HTTPS request to its hostname through the real Envoy container reaches it in cleartext, and that the access log emits the `mcp` pathId.
- **Not planned:** VM/guest-level testing of the actual `claude mcp add`/`codex mcp add` post-script commands, since correctness there depends on CLI versions this repo doesn't control. Treated as manually verified rather than automated, consistent with the project not owning those CLIs.
