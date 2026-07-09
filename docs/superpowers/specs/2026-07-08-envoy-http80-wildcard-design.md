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
  virtual host and get a 403. This is the originally reported bug
  (`connectivity-check.ubuntu.com` failing under `**.ubuntu.com:80`).
- the cluster's upstream `socket_address.address` — a `STRICT_DNS` cluster
  that does a real DNS lookup on the literal string `**.ubuntu.com`, which
  isn't a resolvable hostname even if the domain match were fixed.

The same bug already affects allowlist entries that use a *native* single
leading `*.` (e.g. `*.one.au.digicert.com:80`, present in
`.configamatron/proxy/allowlist.txt` today) — Envoy's own suffix-wildcard
syntax matches any depth already, which is exactly what `**.` was invented
to mean, so the two forms are semantically identical and both need the same
fix.

Separately, `.configamatron/proxy/allowlist.txt` also has
`crl*.digicert.com:80` — a wildcard embedded mid-string. Envoy's domain
matcher only supports a wildcard as a full leading (`*.foo.com`) or full
trailing (`foo.*`) segment, never mid-pattern, so this entry can never work
regardless of how `envoyConfig.ts` is changed. It's a malformed entry in the
allowlist source data, not a code bug — handled as a hard validation error
(see below) so it's caught at generation time and fixed at the data layer,
instead of silently producing a broken (or, before this design, silently
ignored) virtual host.

## Design

`parseAllowlist` (`src/allowlist.ts`) becomes the single place that
normalizes and validates raw allowlist text into a clean, generation-ready
`Allowlist`. `envoyConfig.ts` trusts its input completely — same trust
boundary it already has for exact-duplicate lines today.

### `Allowlist` gains an `invalid` field

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  invalid: string[];
}
```

`parseAllowlist` classifies each line while building the per-section `Set`s:

- **Invalid** if it's in the `terminate` section and contains any `*`
  (terminate names one real host for TLS termination and credential
  injection — a wildcard there is always a mistake), or if its host portion
  contains a `*` that isn't a single leading wildcard matching
  `/^\*{1,2}\.[^*]+$/` (so `**.host`/`*.host` are fine; `crl*.digicert.com`
  is not).
- Invalid lines are added to `invalid` (deduped per the same `Set` approach
  as the other sections) instead of `passthrough`/`terminate` — they never
  reach the arrays `envoyConfig.ts` consumes.

`buildEnvoyConfig.ts` checks `allowlist.invalid` immediately after
`parseAllowlist`: if non-empty, it `console.error`s a message listing every
invalid entry and sets `process.exitCode = 1`, returning before calling
`generateEnvoyConfig` — no `envoy.yaml` is written. This follows the same
try/catch-and-report shape already used in `commands/init.ts`.

`parsePolicyFile` (`src/policyFile.ts`) always returns `invalid: []` — it
doesn't perform this validation itself. An entry with bad wildcard syntax
that originates from the source policy file is still caught later, when the
environment's copied `allowlist.txt` is parsed by `build-envoy-config`.

### `**.` / `*.` normalization

Once an entry's wildcard shape is confirmed valid, `parseAllowlist`
canonicalizes it to Envoy's native single-star form (`**.host` → `*.host`)
before adding it to the section's `Set`. This has two effects:

- The existing exact-duplicate dedup gets a free upgrade: `**.ubuntu.com:80`
  and `*.ubuntu.com:80` — semantically identical, since Envoy's own
  suffix-wildcard already matches any depth — now collapse into one entry,
  because they normalize to the same string before insertion into the
  `Set`.
- Downstream code (pruning, and `envoyConfig.ts`) only ever has to deal
  with one wildcard prefix form (`*.`).

`toEnvoyWildcard` in `envoyConfig.ts` is deleted — its job moves entirely
into `parseAllowlist`. Port 443's `passthroughServerNames` and port 80's
merged wildcard virtual host (see below) both use the host exactly as
stored, no conversion needed at generation time.

This normalization is in-memory only; it does not rewrite files on disk.
`current-allow-list.txt` is produced by `import-sbx-network-policy` via
`parsePolicyFile` + `formatAllowlist`, a path that never goes through
`parseAllowlist`, so its `**.`-convention content is unaffected.

### Redundancy pruning

Within `passthrough` only (the one section that can contain wildcards),
`parseAllowlist` makes a second pass per exact port: for each (now
normalized) wildcard entry `*.host:port`, drop any exact entry
`sub.host:port` at the *same port* where `sub.host` ends with `.host` (a
strict subdomain — `archive.ubuntu.com` is covered by `*.ubuntu.com`, but
bare `ubuntu.com` is not, since `*.host` only matches strings with at least
one label before `.host`). `terminate` is never pruned, and a `passthrough`
wildcard never prunes a `terminate` entry — sections stay fully
independent, so a host can still be an exact `terminate` target even if a
`passthrough` wildcard would otherwise cover it.

Pruning is silent — no console output — matching the existing
exact-duplicate-dedup precedent. It does not rewrite `allowlist.txt` on
disk; a human-maintained `archive.ubuntu.com:80` line can stay in the file
for documentation purposes even though it no longer produces its own
virtual host or cluster once `*.ubuntu.com:80` is also present. This also
means there's never a real "exact entry vs. wildcard" overlap left for
`generateEnvoyConfig` to resolve — the redundant exact entry simply isn't
in the `Allowlist` it receives.

Wildcard-vs-wildcard redundancy (e.g. a hypothetical `*.archive.ubuntu.com`
alongside `*.ubuntu.com`) is out of scope — not present in the current
allowlist, and left for a future change if it comes up.

### Port 443

No behavior change beyond now being covered by validation/normalization
upstream (previously, a malformed wildcard here would have silently
produced a broken passthrough entry rather than failing loudly; and
`**.`/`*.` duplicates weren't deduped).

### Port 80

`buildHttp80Entry`'s port-80 passthrough entries split into two groups
(both operating on the already-validated, already-pruned, already-normalized
`passthrough` array):

- **Exact hosts** (no `*`): unchanged — one static `STRICT_DNS` cluster and
  one virtual host per host, as today.
- **Wildcard hosts** (`*.host`, post-normalization): merged into a single
  virtual host, `domains: [...wildcardHosts]`, routed to one new shared
  cluster, `dynamic_forward_proxy_cluster_http`. This mirrors how port 443
  already merges all passthrough SNI names into one filter chain rather
  than one per host.

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

## Testing

**Unit (`tests/unit/allowlist.test.ts`):**

- A mid-string wildcard (e.g. `crl*.digicert.com:80`) ends up in `invalid`,
  not in `passthrough`.
- Any `*` in a `terminate` entry ends up in `invalid`, not in `terminate`.
- `**.ubuntu.com:80` and `*.ubuntu.com:80` both present in the same section
  collapse to a single normalized `*.ubuntu.com:80` entry.
- `archive.ubuntu.com:80` is pruned when `**.ubuntu.com:80` is also present
  (same section, same port); `archive.ubuntu.com:443` is not pruned by a
  `:80` wildcard; a `terminate` entry equal to a covered host is not pruned.
- Bare `ubuntu.com:80` is **not** pruned by `**.ubuntu.com:80` — it isn't a
  subdomain, so there's no overlap (regression test for the mistaken
  overlap example caught during design review).
- Update the existing "round-trips through formatAllowlist" test: writing
  `**.chatgpt.com:443` and parsing the result now yields `*.chatgpt.com:443`
  (normalized), not the original `**.` string.

**Unit (`tests/unit/envoyConfig.test.ts`):**

- Update the test fixture's wildcard entry from `**.chatgpt.com:443` to
  `*.chatgpt.com:443` (this test constructs an `Allowlist` literal directly,
  bypassing `parseAllowlist`'s normalization, so the fixture itself must
  already be in normalized form now that `toEnvoyWildcard` is gone).
- Wildcard `:80` entries merge into one virtual host routed to
  `dynamic_forward_proxy_cluster_http`; exact `:80` entries keep their
  existing one-cluster-per-host shape.
- `dynamic_forward_proxy_cluster_http` and `dynamic_forward_proxy_cache_config_http`
  are present only when the allowlist has at least one wildcard `:80` entry;
  the HTTP filter is inserted before `envoy.filters.http.router` in that
  case.

**Unit (`tests/unit/policyFile.test.ts`):** update the existing `toEqual`
assertion to include `invalid: []`.

**CLI/e2e:** `build-envoy-config` against an allowlist containing
`crl*.digicert.com:80` exits 1 with a clean error message (no stack trace),
no `envoy.yaml` written.

**Integration (`tests/integration/proxy.test.ts` + `fixtures/allowlist.txt`):**

- Add `archive.ubuntu.com:80` and `**.ubuntu.com:80` to the fixture
  allowlist. A real HTTP request with `Host: connectivity-check.ubuntu.com`
  (never explicitly listed) succeeds via the new dynamic path — this
  reproduces and proves the fix for the originally reported bug.

## Out of scope

- Fixing `crl*.digicert.com` itself in `.configamatron/proxy/allowlist.txt`
  — that's a data change (e.g. enumerate `crl1.digicert.com`,
  `crl2.digicert.com`, ... or widen to `**.digicert.com` if not too broad),
  tracked separately from this design.
- Wildcard-vs-wildcard redundancy pruning (e.g. a narrower wildcard made
  redundant by a broader one).
- Supporting trailing-wildcard syntax (`foo.*`) — not used anywhere in the
  current allowlist; Envoy supports it, but nothing in this design generates
  or validates it.
- Sharing the port-443 dynamic-forward-proxy cluster/cache with port 80
  (considered and rejected in favor of keeping the two ports' dynamic
  resolution independent — see "Port 80" above).
- Having `parsePolicyFile`/`import-sbx-network-policy` perform the same
  wildcard-shape validation at import time — deferred to whenever
  `build-envoy-config` parses the resulting allowlist.
