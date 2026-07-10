# Single `*` wildcard syntax — design

**Date:** 2026-07-10

## Problem

The allow-list format historically accepted two equivalent spellings for a
leading-subdomain wildcard: `*.host` and `**.host`. `parseAllowlist`
(`src/allowlist.ts`) tolerated both, normalizing `**.` to `*.`. Upstream
sandbox network-policy files use `**.`, and `parsePolicyFile`
(`src/policyFile.ts`) passed those through verbatim, so
`current-allow-list.txt` ended up full of `**.` entries.

Two spellings for one concept is needless surface area. We want a single
wildcard syntax — `*.host` — across the whole codebase.

## Goals

- Only `*.host` is a valid wildcard anywhere in the codebase. `**.host` is no
  longer a recognized allow-list spelling.
- `import-sbx-network-policy` is the single boundary that ingests upstream
  policy (which uses `**.`). It translates `**.host` → `*.host` on the way in,
  and **warns and skips** any wildcard pattern it cannot support (e.g.
  `foo*.bar.com`), rather than emitting something downstream will reject.

## Non-goals

- Rewriting `current-allow-list.txt`. The maintainer has already converted its
  `**.` entries to `*.` by hand; this change does not touch that file (no
  rewrite, no re-sort).

## Design

### 1. `parseAllowlist` (`src/allowlist.ts`) — drop `**` support

- Tighten `WILDCARD_HOST_PATTERN` from `/^\*{1,2}\.[^*]+$/` to
  `/^\*\.[^*]+$/`: a single leading `*.` followed by at least one non-`*`
  character, no other `*` anywhere.
- Delete `normalizeWildcardHost` and its call site. With only `*.` accepted
  there is nothing to normalize; valid entries are used as-is.
- Consequence: any `**.host` now fails the pattern and lands in `invalid[]`.
  `build-envoy-config` already reports `invalid[]` entries and exits 1, so an
  environment `proxy/allowlist.txt` that still contains `**.` fails the build
  loudly with a clear message. This is the intended end state — one syntax, no
  silent normalization safety net.

The prune logic (`prunePassthrough`) is unchanged: it already keys off `*.`
hosts.

### 2. `parsePolicyFile` (`src/policyFile.ts`) — normalize at the import boundary

This is the one place that ingests upstream sandbox policy, so it owns the
`**.` → `*.` translation. Update the resource-collection path so each wildcard
host is classified before being kept:

- Valid front-anchored wildcard — `**.host` or `*.host` — is normalized to
  `*.host` and kept.
- Any other host containing `*` (mid-string like `foo*.bar.com`, a bare `*`,
  multiple stars) is **skipped** (excluded from output) and recorded so the
  command can warn about it.
- A host with no `*` is kept unchanged.

Non-wildcard uses of `**` in the source (filesystem resources such as
`default-fs-read-allow-all ... **`) never reach classification: the existing
`network`/`allow` guard already filters non-network rows out.

Skipped patterns are returned via the existing `Allowlist.invalid[]` field
rather than a new return shape. `invalid[]` is already the "entries we could
not use" channel; each command decides whether that means warn
(`import-sbx-network-policy`) or fatal error (`build-envoy-config`).

Normalization and skip apply to both the passthrough and terminate buckets
before the terminate/passthrough split, so a normalized host is bucketed on its
real name.

### 3. `import-sbx-network-policy` command (`src/commands/importSbxNetworkPolicy.ts`)

After parsing, if `allowlist.invalid` is non-empty, print a warning to stderr:

```
import-sbx-network-policy: skipping unsupported wildcard pattern(s):
  - foo*.bar.com:443
```

Then still write the output file and exit 0. Warn + skip + continue: an
unsupported pattern is a maintenance heads-up, not a reason to abort the import.

## Testing

- `parsePolicyFile` unit tests:
  - normalizes `**.host` → `*.host` in the output.
  - keeps an already-`*.host` entry as-is.
  - skips `foo*.bar.com` (and other mid-string / malformed wildcards),
    excluding it from `passthrough`/`terminate` and recording it in `invalid`.
- `parseAllowlist` unit tests: the cases that currently assert `**.` is
  normalized are changed to assert `**.` is reported as `invalid` and excluded
  from `passthrough`. A plain `*.host` entry continues to pass through.
- CLI/e2e: `import-sbx-network-policy` on a policy file containing an
  unsupported wildcard writes the output file (valid entries present) and emits
  the skip warning on stderr, exiting 0.
