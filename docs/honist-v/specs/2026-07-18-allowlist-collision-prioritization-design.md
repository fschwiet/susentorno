# Allowlist collision prioritization and non-fatal warnings

**Date:** 2026-07-18
**Status:** Approved design

## Background

`parseAllowlist` (`src/allowlist.ts`) splits an allowlist into three sections:

- **passthrough** — TLS is not terminated; traffic flows through unread. No inspection,
  no credential injection. Wildcards allowed.
- **terminate** (`#pragma claude authenticated`) — TLS terminated with the leaf cert;
  Claude's access token is injected (credential_injector + lua gate).
- **authCandidate** (`#pragma auth candidate`) — TLS terminated and inspected, but no
  credential injection. Observes/logs the client's own auth to discover what a host needs.
  Diagnostic; expected to be used rarely.

In `envoyConfig.ts` each terminate/authCandidate host emits its own filter chain with
`filter_chain_match: { server_names: [host] }`, while all passthrough `:443` hosts share
one chain. If the exact same `host:port` string appears in two sections, Envoy sees two
filter chains matching the same SNI and rejects the config at load
("multiple filter chains with the same matching rules"). The container starts but Envoy
never opens its admin port.

Today the parser only de-conflicts one of the three cross-section overlaps
(terminate ∩ authCandidate, marked `invalid`), and `invalid` entries are treated as fatal:
run-proxy aborts at startup or keeps the previous config on reload. A companion fix
(issue #2, already landed) makes readiness/drain waits abort on shutdown so a rejected
config can no longer wedge Ctrl+C.

## Goal

Replace the "reject on conflict" behavior with **deterministic prioritization plus
non-fatal warnings**, and extend the same "warn, don't fail" philosophy to invalid-syntax
entries:

- A `host:port` appearing in more than one section is resolved by a fixed priority order;
  the losing copies are dropped so Envoy sees exactly one filter chain per SNI.
- Invalid-syntax entries are excluded from the generated config (as before) but no longer
  fail the proxy.
- Every dropped entry (collision loser or invalid syntax) produces a warning shown in the
  run-proxy output. The proxy always builds the best valid config it can from the
  surviving entries.

The proxy only fails / keeps the previous config when the allowlist **file is unreadable**
(there is genuinely no config to build). Allowlist *content* problems never kill the proxy.

## Scope

Only **exact `host:port` strings appearing in two or more sections** are collisions. A
wildcard passthrough entry (e.g. `*.example.com:443`) that merely *covers* an explicit
`foo.example.com:443` in terminate is **not** a collision — Envoy matches the more-specific
SNI first, and this is already intentionally allowed (see `allowlist.test.ts:258`). This
design preserves that behavior. Because terminate/authCandidate reject wildcards outright,
every exact cross-section collision involves plain (non-wildcard) hosts.

## Design

### 1. Parser: `Allowlist` shape and resolution

Change the interface in `src/allowlist.ts`:

```ts
export interface Allowlist {
  passthrough: string[];
  terminate: string[];
  authCandidate: string[];
  warnings: string[]; // replaces `invalid`
}
```

`parseAllowlist` keeps its current line parsing, then runs two resolution passes over the
collected sets before returning:

1. **Invalid-syntax pass** (existing logic, re-homed): a wildcard where none is allowed, or
   a malformed wildcard, is excluded from its section and pushed to `warnings` as:

   ```
   unsupported wildcard syntax, excluded: '<entry>'
   ```

2. **Collision pass** (new): for each exact `host:port` present in more than one section,
   keep it in the highest-priority section and delete it from the others. Priority:

   ```
   authCandidate > terminate > passthrough
   ```

   Rationale: authCandidate is a deliberate, rare diagnostic override — when investigating
   an authenticated domain's auth, listing it under `#pragma auth candidate` should shadow
   its terminate entry so the client's own auth is observed untouched. terminate outranks
   passthrough so an explicit "inject Claude credentials" intent is not silently downgraded
   to bypass.

   Each dropped copy appends one warning naming the sections the entry appeared in
   (listed in stable order: passthrough, terminate, authCandidate) and the winner:

   ```
   collision: '<entry>' listed in <sectionA> and <sectionB>; using <winner>
   ```

   A host present in all three sections lists all three and resolves to authCandidate.

**Ordering:** the collision pass runs **after** `prunePassthrough` and the invalid-syntax
exclusion, so only entries that actually survive into a section are reconciled. Warnings are
emitted in a deterministic order (invalid-syntax entries first, then collisions) so tests
are stable.

`terminateTlsHosts` and `formatAllowlist` are unaffected — they read only the three section
arrays.

### 2. run-proxy behavior (`src/runProxy/runProxyLoop.ts`)

Allowlist *content* is no longer fatal. Both call sites change:

- **Startup (`start`, ~line 368–375).** Remove the `invalid.length > 0 → fatal()` block.
  After `parseAllowlist`, if `warnings.length > 0`, print each warning (prefixed
  `run-proxy:`) via `deps.error`, then continue the normal bring-up from the resolved
  sections. The only remaining startup-fatal allowlist case is unreadable content
  (`content === null`).

- **Reload (`readValidAllowlist`, ~line 194–200).** Remove the `invalid.length > 0 →
  return null` block. Print any warnings, then return the parsed allowlist whenever the file
  is readable. The function now returns null **only** when the file cannot be read; its name
  / doc comment is updated to reflect that narrowed contract.

Warnings print one per line, prefixed, and never gate `applyAllowlist` / `buildConfig`:

```
run-proxy: collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate
run-proxy: unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'
```

**Consequence:** if every entry is bad, the proxy still starts, with a thin/empty config
and the warnings printed. This is accepted as consistent with "warn, don't fail."

### 3. Other consumers of `Allowlist`

- **`src/policyFile.ts` (`parsePolicyFile`).** Returns an `Allowlist`; its `invalid` set
  becomes `warnings`, populated with the same `unsupported wildcard syntax, excluded:
  '<entry>'` string. It has no pragmas that can collide (each host lands in exactly one of
  terminate/passthrough), so it needs no collision pass — only the field rename and message
  formatting.

- **`src/commands/importSbxNetworkPolicy.ts`.** Switches from reading `allowlist.invalid`
  (with its own header + bullets) to iterating `allowlist.warnings`, printing each with its
  `import-sbx-network-policy:` prefix. It already did not fail on invalid entries, so its
  behavior is unchanged in spirit.

- **`formatAllowlist`.** Unaffected.

### 4. Warning message format

Presentation-neutral (no tool-name prefix — the caller adds `run-proxy:` /
`import-sbx-network-policy:`). Entries are wrapped in single quotes so it is clear what to
search for in the allowlist:

```
collision: 'shared.example.com:443' listed in passthrough and terminate; using terminate
unsupported wildcard syntax, excluded: 'crl*.digicert.com:80'
```

## Testing

### `tests/unit/allowlist.test.ts`

Existing `invalid: [...]` assertions become `warnings: [...]` with the quoted messages. Two
tests flip meaning:

- `:145` ("keeps the same host in both passthrough and terminate independently") → the host
  survives **only** in `terminate`, with a `collision:` warning.
- `:375` ("moves a host present in both terminate and auth candidate to invalid") → the host
  survives **only** in `authCandidate`, with a `collision:` warning.

New parser tests:

- passthrough ∩ terminate → terminate wins + warning
- passthrough ∩ authCandidate → authCandidate wins + warning
- terminate ∩ authCandidate → authCandidate wins + warning
- host in all three → authCandidate wins; warning names all three sections
- collision + invalid-syntax together → both warnings present, deterministic order
- a passthrough host that only *wildcard-overlaps* an explicit terminate host is **not** a
  collision (guards the `:258` behavior)

### `tests/unit` policyFile tests

Rename `invalid` assertions to `warnings` with the new message string.

### `runProxyLoop` tests

Using the existing `deps.error` / `deps.log` spies:

- startup with an invalid or colliding allowlist now **brings up the proxy** and emits
  warnings (no `fatal`)
- reload with warnings **applies** the new resolved config (not keep-previous)
- unreadable file still fatal (startup) / keep-previous (reload)

### e2e (optional)

Confirm a passthrough ∩ terminate allowlist that previously wedged Envoy now starts cleanly
with a warning. Placement (whether the existing crash-config e2e suite is the right home) is
decided during planning.

## Out of scope

- Issue #2 (readiness/drain waits aborting on shutdown) — already landed.
- Any change to wildcard SNI matching semantics in Envoy.
- Changing how `formatAllowlist` serializes sections.
