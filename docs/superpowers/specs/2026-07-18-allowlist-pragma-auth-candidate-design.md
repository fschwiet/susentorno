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
   the leaked-credential gate — instead, a short prefix of the auth headers
   the client actually sends is logged, to figure out how to support
   injection for that domain's auth scheme later. Only a scheme-revealing
   prefix is logged, never a full credential (see §4).

## 1. Pragma syntax (`src/allowlist.ts`)

- A line is a **pragma command** only if it starts with the literal
  `#pragma ` (note trailing space). The three recognized commands are:
  - `#pragma passthrough`
  - `#pragma claude authenticated`
  - `#pragma auth candidate`
- If a trimmed line starts with `#pragma ` but doesn't match one of the three
  commands above, `parseAllowlist` throws an `Error` (e.g. `Invalid pragma:
  "#pragma bogus"`).
- A trimmed line that is exactly the **legacy** header `# passthrough` or
  `# terminate` also throws, with a migration hint (e.g. `Legacy allowlist
  header "# terminate"; use "#pragma claude authenticated"`). Without this
  special case those two lines would fall through as ordinary ignored
  comments and every host beneath them would be silently dropped — and for
  `# terminate` that means `api.anthropic.com` et al. silently lose TLS
  termination and Claude credential injection. Since a mid-migration file
  still carrying the old bare headers is the single most likely mistake, and
  its failure mode is both silent and catastrophic, we detect it and fail
  loudly with a fix instead. (Bare `# claude authenticated` / `# auth
  candidate` are *not* special-cased — those spellings never existed on
  disk, so there is no silent-drop legacy to protect against; they remain
  ordinary comments.)
- These are real thrown exceptions. `parseAllowlist` does not catch them, and
  neither of its callers does either:
  - `src/commands/generateCa.ts` (`parseAllowlist(readFileSync(...))`) — a
    one-shot CLI command, which exits non-zero.
  - `src/runProxy/runProxyLoop.ts`, both at startup (`start()`) and on every
    live edit via the file watcher (`readValidAllowlist`) — the throw
    propagates out of the `void drainRestarts()` / `void start()` chain as an
    unhandled rejection and crashes the long-running proxy.

  (There is no `build-envoy-config` caller; `src/runProxy/buildConfig.ts`
  receives an already-parsed `Allowlist` and never calls `parseAllowlist`.)

  This is intentionally stricter than the existing `invalid[]` handling. A bad
  host/wildcard entry is collected in `invalid[]` and the CLI/run-proxy layer
  keeps the previous config (non-crashing). A pragma error or a legacy header
  is a *structural* mistake about the whole file's meaning, not one bad line,
  so it fails loudly. For the live-edit case this is strictly better than the
  status quo it replaces (a silent drop of every terminate host).
- Any other line starting with `#` that does **not** start with `#pragma `
  (and isn't one of the two legacy headers above) is still a free-text comment
  and is ignored, exactly like today (preserves things like `## misc`,
  `# Windows`, `# added after original import` in `current-allow-list.txt`).

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

`authCandidate` is a **required** field. Both `parseAllowlist` and
`parsePolicyFile` (`src/policyFile.ts`) always populate it — empty array when
unused — so the returned shape is uniform and exact-equality assertions in
tests stay simple. `src/policyFile.ts` never produces auth-candidate hosts
(policy files have no such concept), so it always returns `authCandidate: []`;
it still must be updated to include the field or it stops type-checking.

`authCandidate` entries follow the same validation as `terminate` entries:
no wildcards allowed (both need an exact cert SAN for TLS termination), and
non-`:443` entries are rejected the same way.

**Cross-section conflict:** a host that appears in *both* `terminate` and
`authCandidate` would generate two SNI filter chains with the same
`server_names` in the 443 listener, which Envoy rejects at startup with an
opaque duplicate-filter-chain error. `parseAllowlist` guards against this: an
entry present in both sections is removed from both and added to `invalid[]`,
so run-proxy keeps the previous config (consistent with existing
bad-entry handling) rather than producing a config Envoy refuses to load.
(Overlap between `passthrough:443` and either terminate-class section is a
pre-existing, out-of-scope condition and is not newly guarded here.)

`formatAllowlist` writes the sections in order — `#pragma passthrough`,
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
  structure as `buildTerminateEntry`, but with distinct names so stats and
  clusters don't collide: cluster `cluster_authcandidate_<host>` and
  `stat_prefix: authcandidate_<host>` (vs. `cluster_terminate_<host>` /
  `terminate_<host>`).
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
  headers, each truncated in the envoy config to a short **12-character
  prefix** via Envoy's `%REQ(HEADER):12%` truncation syntax:

  ```
  CFGM|cand|%START_TIME(%Y-%m-%dT%H:%M:%S)%|%REQUESTED_SERVER_NAME%|%REQ(:AUTHORITY)%|%RESPONSE_CODE_DETAILS%|%REQ(AUTHORIZATION):12%|%REQ(COOKIE):12%|%REQ(X-API-KEY):12%|%REQ(X-AUTH-TOKEN):12%|%REQ(PROXY-AUTHORIZATION):12%
  ```

  Envoy emits `-` for any header that's absent on a given request.

  **Why 12 chars, and why truncate in envoy.** This is the first feature that
  puts real request credential material into a log at all — today's access
  logs only carry server name / authority / response detail, never header
  values. The actual leak surface is the *envoy access log line itself*: it is
  written to the container's stdout and read back via the docker log stream,
  so it lands in docker logs, terminal scrollback, and any CI capture.
  Truncating in the envoy config (rather than in application code) is
  therefore load-bearing for security, not just tidiness — the raw secret must
  never leave the container. Twelve characters is enough to reveal the *scheme
  and format signature* an injection design needs (`Bearer eyJhbG…` = a JWT,
  `sk-ant-api03` = an Anthropic-style key, `Basic ` + a few base64 chars, a
  session cookie's `name=` prefix) while being far too short to reconstruct a
  usable credential (e.g. `Basic ` + 6 base64 chars decodes to ~4 bytes of
  `user:pass`). The investigative goal is "which header, which scheme," which
  a 12-char prefix answers; the full value is pure liability.

  This short prefix also happens to bound two downstream problems (see §5):
  rotated credentials of the same scheme share their leading bytes (a JWT's
  header, a key's fixed prefix), so value-keyed dedup collapses rotations
  instead of growing without bound; and scheme prefixes don't contain `|`, so
  the pipe-delimited log format stays unambiguous in practice.

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
  prefixes) — `parseLine` checks field count based on whether the parsed
  `pathId` is `'cand'` (exactly 11) or one of the others (exactly 6),
  returning `null` for a malformed line either way, same as today. Because the
  five header fields are now short scheme prefixes (§4), a `|` embedded in a
  logged value — which would push the count off and drop the line — is a
  negligible, accepted edge; scheme keywords and their base64/JWT/`sk-`
  prefixes don't contain pipes. (This is the payoff of truncating short: it
  removes the need for fragile positional re-parsing to survive a pipe in a
  full credential value.)

- **`classify.ts`**: return type changes from `Entry` to `Entry[]` (existing
  pathIds keep returning a single-element array — no behavior change for
  them). `Entry` gains optional `protocol?`, `header?`, `value?` fields and
  `Tag` gains `'AUTH CANDIDATE'`. For `pathId === 'cand'`, `classify` emits
  one `Entry` per header field that isn't `-`:

  ```ts
  { time, tag: 'AUTH CANDIDATE', domain, protocol: 'https', header: 'Authorization', value: 'Bearer eyJhb' }
  ```

  (`protocol` is hardcoded `'https'` since auth-candidate only supports
  `:443` termination, same constraint as `terminate`.) A request with no
  matching auth headers present produces zero entries.

- **`uniqueTracker.ts`**: the dedup key becomes
  `` `${tag} ${domain} ${protocol ?? ''} ${header ?? ''} ${value ?? ''}` ``.
  For existing tags (`protocol`/`header`/`value` all `undefined`) this key is
  identical to today's `` `${tag} ${domain}` ``, so existing dedup behavior
  for `ALLOW CRED`/`ALLOW PASS`/etc. is unchanged. For `AUTH CANDIDATE`
  entries it dedups per unique domain+header+value tuple, so a hot domain
  prints each distinct prefix once, but a genuinely different prefix (a new
  scheme, a different header) prints again.

  This does add `value` to a key that was previously bounded by tag×domain
  (a finite set). In principle the `seen` set could grow with distinct
  values, and it is only cleared on an *allowlist* change (`clearUnique`), not
  on credential rotation. In practice the 12-char prefix keeps cardinality low
  — rotated tokens of one scheme collapse to a shared prefix — so per domain
  you print roughly one line per header per scheme, not per token. That is an
  acceptable, effectively-bounded footprint for what is a temporary
  investigation feature.

- **`formatOutput.ts`**: `AUTH CANDIDATE` entries render as
  `HH:MM:SS  AUTH CANDIDATE  <domain>  https  <header>=<value>`; all other
  tags render exactly as today.

- **`runProxyLoop.ts`**: `onLogLine` changes from `classify` returning one
  `Entry` to iterating the returned array, calling
  `shouldPrint`/`formatOutput`/`deps.log` per entry (a no-op change in
  behavior for non-`cand` lines, since they still produce a single-element
  array).

## 6. Migration of existing allowlist files and consumers

This is a breaking format change. Two kinds of migration are needed.

**On-disk allowlist files** must move to the new pragma syntax. A file still
using bare `# passthrough` / `# terminate` now throws the legacy-header error
from §1 (rather than silently dropping entries), so it must be updated:

- `current-allow-list.txt`
- `tests/integration/fixtures/allowlist.txt`
- `tests/fixtures/invalid-allowlist.txt`
- Any inline fixtures built as literal strings in `tests/unit/allowlist.test.ts`,
  `tests/unit/envoyConfig.test.ts`, `tests/unit/runProxy/*.test.ts`,
  `tests/e2e/cli.test.ts`, `tests/integration/proxy.test.ts`.

**In-code `Allowlist` consumers and assertions** must account for the new
required `authCandidate` field:

- `src/policyFile.ts` returns an `Allowlist` object literal — add
  `authCandidate: []` (§2).
- Every `toEqual(...)` assertion comparing a whole `Allowlist` object gains
  `authCandidate: []` (or a populated array): `tests/unit/allowlist.test.ts`
  (~20 sites), `tests/unit/envoyConfig.test.ts`, and
  `tests/unit/policyFile.test.ts` (including the
  `toEqual({ passthrough: [], terminate: [], invalid: [] })` case, which is
  exact and will otherwise fail).

**`import-sbx-network-policy` help text.** `formatAllowlist` only emits the
sorted section entries; it does not preserve the free-text comments (`## misc`,
`# Windows`, etc.) that `current-allow-list.txt` carries by hand. Regenerating
that file via `import-sbx-network-policy` therefore drops those comments —
known and out of scope to fix here. Document it in the command's
`.description()` (`src/commands/importSbxNetworkPolicy.ts`) so it doesn't
resurface as a surprise in review: note that regeneration overwrites the file
and does not preserve hand-added comments.

## Testing

- `src/allowlist.ts` unit tests: pragma recognition (`#pragma passthrough`,
  `#pragma claude authenticated`, `#pragma auth candidate`); throwing on an
  unrecognized `#pragma ...` line; **throwing with a migration hint on the
  legacy `# passthrough` / `# terminate` headers**; non-`#pragma` comment
  lines still ignored; `authCandidate` wildcard rejection (same as
  `terminate`); **a host present in both `terminate` and `authCandidate`
  landing in `invalid[]` and out of both sections**; round-trip through
  `formatAllowlist` including the omitted-when-empty `auth candidate` section;
  `terminateTlsHosts` including `authCandidate` hosts.
- `src/envoyConfig.ts` unit tests: an `authCandidate` host produces a filter
  chain with only `envoy.filters.http.router` in `http_filters` (no lua gate,
  no credential injector), a distinctly-named cluster
  (`cluster_authcandidate_*`) otherwise identical in shape to a `terminate`
  cluster, and an access log format string that includes the 5 extra header
  fields each with the `:12` truncation suffix.
- `src/runProxy/*` unit tests: `parseLine` accepting an 11-field `cand` line
  and rejecting malformed ones (wrong field count for the pathId); `classify`
  producing multiple entries for a `cand` line with several headers present
  and skipping `-` headers; `uniqueTracker` deduping per domain+header+value
  while still deduping existing tags per domain; `formatOutput` rendering for
  `AUTH CANDIDATE`.
- `tests/integration/proxy.test.ts` (real Envoy stack against the mock
  upstream): add one auth-candidate host to
  `tests/integration/fixtures/allowlist.txt`, routed to the mock upstream via
  the existing upstream-override mechanism. Cover only what unit tests
  can't — behaviors that depend on the live filter chain:
  - **Gate absent.** A request with a non-placeholder `Authorization`
    reaches the upstream and succeeds (contrast: the same request to a
    `terminate` host is 403'd by the lua gate). This proves the auth-candidate
    chain really omits the gate.
  - **No injection / original headers preserved.** The upstream receives the
    client's original auth header unchanged (no `credential_injector`
    overwrite). Assert against the mock upstream's recorded headers.
  - **Truncation happens in Envoy.** Send a header value longer than 12
    characters and assert the emitted `cand` access-log line carries only the
    12-char prefix. This is the one end-to-end check that validates the §4
    security claim — that the raw secret never leaves the container — which a
    unit test on the format string cannot establish.
