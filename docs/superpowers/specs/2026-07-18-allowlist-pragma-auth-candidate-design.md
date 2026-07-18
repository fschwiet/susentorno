# Allowlist pragma commands + auth-candidate logging

## Motivation

Today the allowlist file recognizes two literal comment lines as section
headers (`# passthrough`, `# terminate`) and silently ignores every other
line starting with `#`. Only one credential type (the Claude Code sandbox
bearer token) is ever injected, for hosts in the `# terminate` section.

We want to:

1. Make the `#`-command syntax explicit and robust (`#pragma <command>`),
   rejecting typos instead of silently ignoring them, so the file format has
   room to grow as more credential-injection targets are added.
2. Rename the `# terminate` pragma to `# claude authenticated` (its actual
   meaning — TLS-terminated *and* Claude credentials injected) to make room
   for other kinds of terminated-but-differently-authenticated hosts.
3. Add a new `#pragma auth candidate` section: hosts that get TLS terminated
   (so the real request is visible) but get no credential injection and skip
   the leaked-credential gate — instead, the auth headers the client actually
   sends are logged, to figure out how to support injection for that
   domain's auth scheme later.

## 1. Pragma syntax (`src/allowlist.ts`)

- A line is a **pragma command** only if it starts with the literal
  `#pragma ` (note trailing space). The three recognized commands are:
  - `#pragma passthrough`
  - `#pragma claude authenticated`
  - `#pragma auth candidate`
- If a trimmed line starts with `#pragma ` but doesn't match one of the three
  commands above, `parseAllowlist` throws an `Error` (e.g. `Invalid pragma:
  "#pragma bogus"`). This is a real thrown exception — `parseAllowlist` does
  not catch it, and none of its current callers (`run-proxy`'s file watcher,
  `build-envoy-config`, `generateCa.ts`) catch it either, so a mistyped
  pragma surfaces as an uncaught exception (crashing the one-shot CLI command,
  or crashing the long-running `run-proxy` watcher if it happens on a live
  edit). This matches how you want it to behave for now; the existing
  `invalid[]` array (bad host/wildcard syntax) is untouched and keeps its
  current non-throwing, "collect and let the CLI layer report it" behavior —
  pragma errors are a different, stricter class of error than a bad host
  entry.
- Any other line starting with `#` that does **not** start with `#pragma ` is
  still a free-text comment and is ignored, exactly like today (preserves
  things like `## misc`, `# Windows`, `# added after original import` in
  `current-allow-list.txt`).

## 2. `Allowlist` shape

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];       // populated by "#pragma claude authenticated"
  authCandidate: string[];   // populated by "#pragma auth candidate"
  invalid: string[];
}
```

The in-memory field name stays `terminate` (only the on-disk pragma text
changes) to avoid touching every existing consumer for a cosmetic rename;
we can rename it later when a second "authenticated" credential type
actually exists.

`authCandidate` entries follow the same validation as `terminate` entries:
no wildcards allowed (both need an exact cert SAN for TLS termination), and
non-`:443` entries are rejected the same way.

`formatAllowlist` writes the three sections in order — `#pragma passthrough`,
`#pragma claude authenticated`, `#pragma auth candidate` — using the new
pragma text, each entries list sorted, same as today. The `#pragma auth
candidate` section is omitted (no header, no blank line) when
`authCandidate` is empty, so files that never use this feature don't grow an
empty section.

## 3. Leaf cert SANs (`terminateTlsHosts`)

`terminateTlsHosts` is extended to return `:443` hosts from **both**
`terminate` and `authCandidate`, since both need a SAN on the leaf cert for
TLS termination to work:

```ts
export function terminateTlsHosts(allowlist: Allowlist): string[] {
  return [...allowlist.terminate, ...allowlist.authCandidate]
    .filter((entry) => entry.endsWith(':443'))
    .map((entry) => entry.slice(0, entry.lastIndexOf(':')));
}
```

`generateCa.ts` and `run-proxy`'s `ensureLeaf` call already go through this
function, so auth-candidate hosts get cert coverage automatically with no
separate wiring.

## 4. Envoy config (`src/envoyConfig.ts`)

A new `buildAuthCandidateEntry` builder, parallel to `buildTerminateEntry`,
producing a filter chain + cluster per `authCandidate` host:

- Same SNI-matched filter chain / TLS termination / upstream cluster
  structure as `buildTerminateEntry`.
- **No `envoy.filters.http.lua` gate filter** — that filter exists to reject
  requests where the sandboxed process already presents a real Anthropic
  credential (leak detection specific to `terminate` hosts); it doesn't apply
  here since the whole point is to observe whatever real auth the client
  sends.
- **No `envoy.filters.http.credential_injector` filter** — nothing is
  injected; the client's original headers pass through untouched to the
  upstream.
- `http_filters` is just `[envoy.filters.http.router]`.
- A distinct access log (`pathId = 'cand'`) capturing a fixed set of auth
  headers, truncated to 50 characters each via Envoy's `%REQ(HEADER):50%`
  truncation syntax (so truncation happens in the envoy config, not in
  application code):

  ```
  CFGM|cand|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%REQ(AUTHORIZATION):50%|%REQ(COOKIE):50%|%REQ(X-API-KEY):50%|%REQ(X-AUTH-TOKEN):50%|%REQ(PROXY-AUTHORIZATION):50%
  ```

  Envoy emits `-` for any header that's absent on a given request.

`generateEnvoyConfig` gains an `authCandidateBuilt` list (parallel to
`terminateBuilt`) filtered to `:443` entries, whose filter chains and
clusters are spliced into `filter_chains`/`clusters` alongside the existing
`terminateBuilt` ones.

## 5. `run-proxy` log pipeline

The existing pipeline is `logStream` (raw docker log lines) →
`parseLine` → `classify` → `UniqueTracker.shouldPrint` → `formatOutput` →
`deps.log`.

- **`parseLine.ts`**: `PathId` gains `'cand'`. The existing 6-field CFGM
  format stays as-is for `term`/`pass`/`http`/`deny443`. A `'cand'` line has
  11 pipe-delimited fields (the same first 6, plus the 5 truncated header
  values) — `parseLine` checks field count based on whether the parsed
  `pathId` is `'cand'` (11) or one of the others (6), returning `null` for a
  malformed line either way, same as today.

- **`classify.ts`**: return type changes from `Entry` to `Entry[]` (existing
  pathIds keep returning a single-element array — no behavior change for
  them). `Entry` gains optional `protocol?`, `header?`, `value?` fields and
  `Tag` gains `'AUTH CANDIDATE'`. For `pathId === 'cand'`, `classify` emits
  one `Entry` per header field that isn't `-`:

  ```ts
  { time, tag: 'AUTH CANDIDATE', domain, protocol: 'https', header: 'Authorization', value: '...' }
  ```

  (`protocol` is hardcoded `'https'` since auth-candidate only supports
  `:443` termination, same constraint as `terminate`.) A request with no
  matching auth headers present produces zero entries.

- **`uniqueTracker.ts`**: the dedup key becomes
  `` `${tag} ${domain} ${protocol ?? ''} ${header ?? ''} ${value ?? ''}` ``.
  For existing tags (`protocol`/`header`/`value` all `undefined`) this key is
  identical to today's `` `${tag} ${domain}` ``, so existing dedup behavior
  for `ALLOW CRED`/`ALLOW PASS`/etc. is unchanged. For `AUTH CANDIDATE`
  entries it naturally dedups per unique domain+header+value tuple, so the
  same header value seen repeatedly on a hot domain only prints once, but a
  new value (e.g. a rotated token) or a different header prints again.

- **`formatOutput.ts`**: `AUTH CANDIDATE` entries render as
  `HH:MM:SS  AUTH CANDIDATE  <domain>  https  <header>=<value>`; all other
  tags render exactly as today.

- **`runProxyLoop.ts`**: `onLogLine` changes from `classify` returning one
  `Entry` to iterating the returned array, calling `shouldPrint`/`formatOutput`/`deps.log`
  per entry (a no-op change in behavior for non-`cand` lines, since they
  still produce a single-element array).

## 6. Migration of existing allowlist files

This is a breaking format change: any file still using bare `# passthrough`
/ `# terminate` would have those lines silently fall through as ordinary
ignored comments (not recognized section headers), so every entry under them
would be silently dropped. As part of implementation, update every real
allowlist-format file in the repo to the new pragma syntax:

- `current-allow-list.txt`
- `tests/integration/fixtures/allowlist.txt`
- `tests/fixtures/invalid-allowlist.txt`
- Any inline fixtures in `tests/unit/allowlist.test.ts`,
  `tests/unit/envoyConfig.test.ts`, `tests/unit/runProxy/*.test.ts`,
  `tests/e2e/cli.test.ts`, `tests/integration/proxy.test.ts` that build
  allowlist content as literal strings.

## Testing

- `src/allowlist.ts` unit tests: pragma recognition (`#pragma passthrough`,
  `#pragma claude authenticated`, `#pragma auth candidate`), throwing on an
  unrecognized `#pragma ...` line, non-`#pragma` comment lines still ignored,
  `authCandidate` wildcard rejection (same as `terminate`), round-trip
  through `formatAllowlist` including the omitted-when-empty
  `auth candidate` section, `terminateTlsHosts` including `authCandidate`
  hosts.
- `src/envoyConfig.ts` unit tests: an `authCandidate` host produces a filter
  chain with only `envoy.filters.http.router` in `http_filters` (no lua gate,
  no credential injector) and a cluster identical in shape to a `terminate`
  cluster; the access log format string includes the 5 extra truncated
  header fields.
- `src/runProxy/*` unit tests: `parseLine` accepting an 11-field `cand` line
  and rejecting malformed ones; `classify` producing multiple entries for a
  `cand` line with several headers present and skipping `-` headers;
  `uniqueTracker` deduping per domain+header+value while still deduping
  existing tags per domain; `formatOutput` rendering for `AUTH CANDIDATE`.
