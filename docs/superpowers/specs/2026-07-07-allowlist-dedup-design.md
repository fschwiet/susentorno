# Allowlist duplicate-entry tolerance

## Problem

`current-allow-list.txt` (and the per-environment `proxy/allowlist.txt` copied
from it by `init`) is a flat text file with `# passthrough` and `# terminate`
sections, one `host:port` entry per line. Different organizations may each add
the same domain independently, producing an exact-duplicate line within a
section.

`parseAllowlist` (`src/allowlist.ts`) currently pushes every non-comment,
non-blank line verbatim, duplicates included. `generateEnvoyConfig`
(`src/envoyConfig.ts`) then builds one Envoy cluster/filter-chain entry per
array element:

- A duplicate `terminate` entry produces two clusters with the same name
  (`cluster_terminate_<sanitized-host>`) and two filter chains matching the
  same SNI server name.
- A duplicate passthrough `:80` entry produces two virtual hosts with the same
  domain in the same route table.

Envoy config validation rejects duplicate cluster names and duplicate route
domains, so `build-envoy-config` would emit a `envoy.yaml` that fails to load.

## Goal

Tolerate duplicate lines in allowlist source files. Do not require
`current-allow-list.txt` or `proxy/allowlist.txt` to be pre-deduplicated by
hand or by tooling upstream of parsing.

## Design

Dedupe inside `parseAllowlist`, not downstream in `generateEnvoyConfig` or in
the `build-envoy-config` command.

- Scope: per-section. `passthrough` and `terminate` are deduped
  independently of each other. The same host string appearing once in each
  section is unrelated to this change and is left as-is (existing behavior).
- Duplicate definition: exact match of the trimmed line text. No
  normalization (e.g. case-folding) is introduced.
- Ordering: first occurrence wins; later repeats of an already-seen line
  within the same section are dropped. Array order for non-duplicate entries
  is otherwise unchanged (source order, as today).
- Visibility: silent. No console output when a duplicate is dropped —
  duplicate entries from independent org contributions are expected input,
  not a condition worth flagging.

This is the only code change. Because every consumer of `Allowlist`
(`build-envoy-config`, `import-sbx-network-policy`'s round-trip, any future
command) goes through `parseAllowlist`, centralizing the dedup here fixes
`build-envoy-config` without touching `envoyConfig.ts` or
`buildEnvoyConfig.ts`, and removes the foot-gun of a future caller forgetting
to dedupe itself.

`formatAllowlist` is unchanged: it already sorts before writing, and since its
callers pass already-deduped `Allowlist` values (from `parseAllowlist` or from
`parsePolicyFile`, which already uses `Set`s), no duplicate lines will be
written back out in practice. `current-allow-list.txt` itself is not required
to be deduplicated — a human editing it by hand and introducing a duplicate
line is exactly the case this change tolerates.

## Testing

- `tests/unit/allowlist.test.ts`: add a case asserting `parseAllowlist` drops
  an exact-duplicate line within a section, and a case confirming the same
  host string in both `passthrough` and `terminate` is unaffected (both
  entries survive).
- `tests/e2e/cli.test.ts` already has a `build-envoy-config` test
  ("generates envoy.yaml into the environment by default with
  build-envoy-config") that runs the command against
  `tests/fixtures/sample-allowlist.txt` and inspects the resulting
  `envoy.yaml`. Add a duplicate line to that fixture (a repeated `terminate`
  entry, since that's the case that would otherwise produce a duplicate
  cluster name) and assert the output still has exactly one matching
  cluster, proving the fix end-to-end through the real command and yaml
  serialization.

## Out of scope

- Deduplicating across sections (same host in both `passthrough` and
  `terminate`).
- Normalizing/canonicalizing entries (case-folding, whitespace variants,
  `**.` vs bare-domain equivalence).
- Any warning/logging when duplicates are found.
- Changes to `current-allow-list.txt`'s own contents or to
  `import-sbx-network-policy`.
