# Port-80 wildcard allowlist entries

## Problem

`allowlist.txt`'s `**.host` convention means "any subdomain, any depth." On
the port-443 passthrough path, `generateEnvoyConfig` (`src/envoyConfig.ts`)
converts this correctly via `toEnvoyWildcard` (`**.host` → `*.host`) before
using it as an SNI `server_names` match — and because that path routes
through `sni_dynamic_forward_proxy`, which resolves the actual requested
hostname dynamically, it works for any subdomain, not just ones enumerated in
the allowlist.

The port-80 path (`buildHttp80Entry`, `envoyConfig.ts:164-196`) has no
equivalent. It uses the raw host string for both:

- the virtual host's `domains: [host]` — a literal `**.ubuntu.com` never
  matches Envoy's domain matcher (which only recognizes a single leading
  `*.` as a suffix wildcard), so requests fall through to the `default_deny`
  virtual host and get a 403.
- the cluster's upstream `socket_address.address` — a `STRICT_DNS` cluster
  that does a real DNS lookup on the literal string `**.ubuntu.com`, which
  isn't a resolvable hostname even if the domain match were fixed.

The same bug already affects allowlist entries that use a *native* single
leading `*.` (e.g. `*.one.au.digicert.com:80`, present in
`.configamatron/proxy/allowlist.txt` today): Envoy's domain matcher accepts
the suffix wildcard fine, but the cluster is still a `STRICT_DNS` lookup on
the literal wildcard string. Both forms are the same underlying problem and
are fixed the same way.

Separately, `.configamatron/proxy/allowlist.txt` also has
`crl*.digicert.com:80` — a wildcard embedded mid-string. Envoy's domain
matcher only supports a wildcard as a full leading (`*.foo.com`) or full
trailing (`foo.*`) segment, never mid-pattern, so this entry cannot be made
to work by any change to `envoyConfig.ts`. It's a malformed entry in the
allowlist source data, not a code bug — handled as a validation error (see
below), so it gets caught at generation time and fixed at the data layer,
not silently generate broken config.

## Design

### Validation

A new check runs at the start of `generateEnvoyConfig`, before any config is
built, over every entry in both `allowlist.passthrough` and
`allowlist.terminate`, at every port:

- No `*` in the host → valid (exact entry), unaffected by this change.
- Host matches `/^\*{1,2}\.[^*]+$/` (a single leading `**.` or `*.` followed
  by a non-wildcard, non-empty remainder) → valid wildcard entry.
- Anything else containing a `*` (e.g. `crl*.digicert.com`) → invalid.
- Any `*` at all in a `terminate` entry → invalid. `terminate` names one real
  host for TLS termination and credential injection; a wildcard there is
  always a mistake.

If any entry is invalid, `generateEnvoyConfig` throws a single `Error`
listing every offending entry (not just the first), so the allowlist can be
fixed in one pass. `buildEnvoyConfig.ts`'s command action wraps the call in
a try/catch (matching the existing pattern in `commands/init.ts`) and exits
with `process.exitCode = 1` and a clean `console.error` message — no stack
trace surfaced to the user.

### Port 443

No behavior change. Now covered by the validation above (previously,
a malformed wildcard here would have silently produced a broken passthrough
entry rather than failing loudly).

### Port 80

`buildHttp80Entry`'s port-80 passthrough entries split into two groups:

- **Exact hosts** (no `*`): unchanged — one static `STRICT_DNS` cluster and
  one virtual host per host, as today.
- **Wildcard hosts** (`**.host` or `*.host`): merged into a single virtual
  host, `domains: [...wildcardHosts.map(toEnvoyWildcard)]`, routed to one
  new shared cluster, `dynamic_forward_proxy_cluster_http`. This mirrors how
  port 443 already merges all passthrough SNI names into one filter chain
  rather than one per host.

`dynamic_forward_proxy_cluster_http` is a `CLUSTER_PROVIDED` cluster
(`cluster_type: envoy.clusters.dynamic_forward_proxy`) with its own DNS
cache config, `dynamic_forward_proxy_cache_config_http` — independent from
port 443's `dynamic_forward_proxy_cache_config`, so the two ports' dynamic
resolution behavior can't affect each other. Listener 80's
`http_connection_manager` gains the `envoy.filters.http.dynamic_forward_proxy`
HTTP filter, referencing that same cache, inserted before
`envoy.filters.http.router`.

This filter only resolves DNS for requests whose route points at the
dynamic-forward-proxy cluster; for requests routed to the existing static
per-host clusters it's a no-op passthrough, so exact-host entries behave
exactly as before.

Both the cluster/cache and the HTTP filter are only added to the generated
config when the allowlist contains at least one wildcard `:80` entry —
`build-envoy-config` output stays minimal when nobody uses one.

### Exact + wildcard overlap

The real allowlist already has cases like `ubuntu.com:80` (exact) and
`**.ubuntu.com:80` (wildcard) coexisting. This requires no special-casing:
Envoy's own virtual host domain matching always prefers the most specific
match — an exact domain wins over a wildcard suffix regardless of
declaration order. So `ubuntu.com` keeps routing through its own static
cluster unchanged, and only other, unlisted subdomains
(`connectivity-check.ubuntu.com`, etc.) fall through to the merged wildcard
virtual host and the new dynamic cluster.

## Testing

**Unit (`tests/unit/envoyConfig.test.ts`):**

- Wildcard `:80` entries merge into one virtual host routed to
  `dynamic_forward_proxy_cluster_http`; exact `:80` entries keep their
  existing one-cluster-per-host shape.
- `dynamic_forward_proxy_cluster_http` and `dynamic_forward_proxy_cache_config_http`
  are present only when the allowlist has at least one wildcard `:80` entry;
  the HTTP filter is inserted before `envoy.filters.http.router` in that
  case.
- A malformed entry (e.g. `crl*.digicert.com:80`) makes `generateEnvoyConfig`
  throw, and the message lists every offending entry when there's more than
  one.
- A `*` anywhere in a `terminate` entry throws.

**Integration (`tests/integration/proxy.test.ts` + `fixtures/allowlist.txt`):**

- Add `ubuntu.com:80` and `**.ubuntu.com:80` to the fixture allowlist. A real
  HTTP request with `Host: connectivity-check.ubuntu.com` (never explicitly
  listed) succeeds via the new dynamic path — this reproduces and proves the
  fix for the originally reported bug. A request with `Host: ubuntu.com`
  also still succeeds, proving the exact/wildcard overlap resolves
  correctly.

**CLI:** `build-envoy-config` against an allowlist containing
`crl*.digicert.com:80` exits 1 with a clean error message, no `envoy.yaml`
written.

## Out of scope

- Fixing `crl*.digicert.com` itself in `.configamatron/proxy/allowlist.txt`
  — that's a data change (e.g. enumerate `crl1.digicert.com`,
  `crl2.digicert.com`, ... or widen to `**.digicert.com` if not too broad),
  tracked separately from this design.
- Supporting trailing-wildcard syntax (`foo.*`) — not used anywhere in the
  current allowlist; Envoy supports it, but nothing in this design generates
  or validates it.
- Sharing the port-443 dynamic-forward-proxy cluster/cache with port 80
  (considered and rejected in favor of keeping the two ports' dynamic
  resolution independent — see "Port 80" above).
