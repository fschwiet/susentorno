# Split allow/auth/block lists, add `--skip-allow-list`

## Purpose

Today's `.susentorno/proxy/allowlist.txt` mixes two different concerns in one file: plain destinations a guest may reach (`#pragma passthrough`) and destinations the proxy stack TLS-terminates for credential injection or auth discovery (`#pragma claude|github|codex authenticated`, `#pragma auth candidate`). This makes the allow list harder to maintain than it needs to be, and gives no way to express "always deny this host" independent of what's currently allow-listed.

This change:
1. Splits the file into `allow-list.txt` (passthrough only) and `auth-list.txt` (everything else, unchanged).
2. Adds `block-list.txt`, which always overrides the other two.
3. Adds `run-hosting --skip-allow-list`, which turns off allow-list enforcement (block-list and auth-list are unaffected) so a user can freely explore some new part of the web, watch the access log to see exactly which hosts got used, and add just those to `allow-list.txt` — rather than guessing up front.
4. Extends the access log so every line shows `domain:port` and so a host allowed only via `--skip-allow-list` is visibly distinguishable from one that matched the allow list.

See [ADR-0021](../../adr/0021-split-allow-auth-block-lists-and-skip-allow-list.md) for the architectural rationale and [CONTEXT.md](../../../CONTEXT.md) for the updated Network policy terminology (**Allow list**, **Auth list**, **Block list**, **Open destination**, **Blocked destination**).

## File formats

All three files live in `.susentorno/proxy/`, alongside `envoy.yaml` and the CA/secrets directories.

**`allow-list.txt`** — flat list of `host:port` lines, one per line. Wildcards allowed in the single leading `*.host` form (existing `WILDCARD_HOST_PATTERN` rule), e.g.:
```
*.ubuntu.com:443
ubuntu.com:80
api.nuget.org:443
```
No pragma headers — a line starting with `#` is a comment and is ignored, including a stray `#pragma passthrough` left over from hand-editing. This is exactly today's `#pragma passthrough` section content, just without the header.

**`auth-list.txt`** — unchanged from today's format: pragma-sectioned, exact hosts only (no wildcards).
```
#pragma claude authenticated
api.anthropic.com:443
claude.com:443

#pragma github authenticated
api.github.com:443
github.com:443

#pragma codex authenticated
chatgpt.com:443

#pragma auth candidate
some-new-host.example.com:443
```
Same two-tier error handling as today: an unrecognized `#pragma` line fails loudly (structural mistake); an unsupported wildcard inside a section is a warning and the entry is dropped (content mistake).

**`block-list.txt`** — flat list of bare hostnames, one per line, no port. Wildcards allowed in the same `*.host` form. Blocks that hostname on both `:80` and `:443`.
```
self.events.data.microsoft.com
*.doubleclick.net
```
A `#`-prefixed line is a comment. A line with a `:port` suffix is a malformed block-list entry — warning logged, entry dropped, same tier as an unsupported wildcard shape elsewhere. Hostname matching across all three files stays exact-string / case-sensitive, matching today's `parseAllowlist` — this design introduces no new canonicalization (e.g. no lowercasing, no trailing-dot stripping).

## Precedence and parsing

1. `block-list.txt` is parsed first into a set of exact/wildcard host patterns.
2. `allow-list.txt` and `auth-list.txt` are parsed into their raw per-section sets (passthrough, claude/github/codex authenticated, auth candidate). Any entry whose host matches a block-list pattern is removed from its section **at this point** — before collision resolution — and a warning is logged. Pruning first (rather than after resolving collisions) means a host that's both block-listed and involved in a cross-section collision produces one clear "blocked, removed from X" warning instead of a collision warning immediately followed by a block warning about the entry that just "won."
3. The existing cross-section collision priority (`auth candidate` > `github authenticated` > `codex authenticated` > `claude authenticated` > passthrough) then runs on what's left, unchanged, just sourced from two files instead of one file's sections.
4. **Host-run MCP servers are not subject to block-list pruning.** `mcp-servers.yaml` is explicit, hands-on configuration — unlike a host arriving via wildcard passthrough or an upstream policy import — so a block-list entry (even a wildcard) never removes an MCP hostname's filter chain. If a block-list pattern would otherwise have matched a declared MCP hostname, that's logged as a warning (mismatch is surfaced, but the MCP server still gets its chain), rather than silently taking down an intentionally configured tool. This preserves today's rule that MCP always wins a hostname collision (`resolveMcpAllowlistCollisions`), now stated for block-list too.
5. There is no migration for an existing `.susentorno/proxy/allowlist.txt`: it is left on disk, untouched, and no longer read. A new environment (or an existing one manually updated by its owner) starts fresh with the three new files.

## `--skip-allow-list` mechanics

Today, Envoy's `listener_443` has a `default_filter_chain` that runs when no explicit filter chain (auth-list, MCP, or allow-list passthrough) matches the SNI — it blackholes the connection. `listener_80`'s catch-all route similarly returns a 403 when no explicit allow-list route matches.

`--skip-allow-list` changes only that *default* branch, for hosts matched by neither the allow list, auth list, nor block list:
- **443 default chain**: instead of blackholing, it becomes an SNI-passthrough chain (the same passthrough mechanism the allow list's own wildcard entries use).
- **80 catch-all route**: instead of a 403, it proxies through via the same dynamic-forward-proxy mechanism already used for wildcard allow-list entries on port 80.

Block-list entries always get their own explicit deny chain/route ahead of this default, in both modes, so `--skip-allow-list` means "open except what's explicitly blocked," never "open, full stop." Auth-list entries are completely unaffected by this flag — they are always TLS-terminated and credential-injected (or, for auth candidates, TLS-terminated and observed) regardless of whether the flag is set.

**Existing latent gap this design must not reproduce:** Envoy treats a `FilterChainMatch` with an empty `server_names` list as "matches any SNI," not "matches nothing." Today's 443 passthrough chain is always emitted, even when `allow-list.txt` has zero `:443` entries — meaning an empty allow list would already accidentally make that chain a catch-all, shadowing `default_filter_chain` entirely (this bug exists today, independent of this change). This design must generate the 443 passthrough chain (and the equivalent 80 route grouping) *only when at least one entry produces it*; when there are none, it's omitted so `default_filter_chain`/the catch-all route is genuinely reached — which is also the scenario the "block-list-only" test case below depends on.

On startup, if `--skip-allow-list` is set, `run-hosting` logs a one-line banner making the mode obvious in the session transcript, e.g.:
```
run-hosting: --skip-allow-list is set — hosts not on allow-list.txt will pass through and be logged as such
```

## Logging

Two new tags join the existing set (`ALLOW CRED`, `ALLOW PASS`, `ALLOW HTTP`, `ALLOW MCP`, `BLOCK TLS`, `BLOCK HTTP`, `AUTH CANDIDATE`):

- **`ALLOW OPEN`** — an open destination: not on the allow list, auth list, or block list; passed through only because `--skip-allow-list` is set.
- **`BLOCK LIST`** — a blocked destination: denied specifically because it matched an entry in `block-list.txt`. `BLOCK TLS`/`BLOCK HTTP` continue to mean "not matched anywhere, and `--skip-allow-list` isn't set."

Every log line now prints `domain:port` rather than a bare domain, for every tag — not just the two new ones — so any line can be copied directly into `allow-list.txt` or `auth-list.txt`. The 443 side is straightforward: `term`, `pass`, `cand`, `mcp`, the new `passopen` (443 open-passthrough default), and the 443-flavored block-list hit are each their own filter chain already, so each can carry its own static path id and the port is simply "443, always."

The 80 side needs a different mechanism than "a new path id per case," because today's port-80 listener has exactly one HTTP connection manager with one access-log configuration shared by every route (matched allow-list routes, the 403 catch-all, and — new — the open-passthrough catch-all and block-list routes all live as routes inside that single filter). To distinguish them in one shared access log, each route is given a distinct name (e.g. `matched`, `blocked`, `open-default`), and the access log format includes Envoy's route-name command operator so the emitted `CFGM|` line carries that name instead of (or alongside) the existing fixed `http` path id. `parseLine.ts`'s contract gains this field for `http`-family lines; `classify.ts` maps route name → tag exactly as it maps 443 path id → tag today. All 80-listener lines report `:80`.

For both ports: when SNI (443) or the `:authority` header (80) already includes an explicit port — `:authority` on an HTTP/1.1 request always does — that existing port is stripped before the statically-known port is appended, so a line is never rendered as `host:80:80`.

## CLI

`run-hosting` gains one new boolean flag:
```
--skip-allow-list   do not enforce allow-list.txt; unmatched hosts pass through and log as ALLOW OPEN (block-list.txt is still enforced)
```
No new path-override flags are needed — like today's allow list, the three files' paths are derived from the environment root (`.susentorno/proxy/{allow-list,auth-list,block-list}.txt`), not independently configurable.

## Seed files and maintainer tooling

The repo-root maintainer seed files mirror the split:
- `current-allow-list.txt` is rewritten to plain lines (no pragma header), keeping only its current passthrough entries.
- A new `current-auth-list.txt` gets the extracted `#pragma claude|github|codex authenticated` and `#pragma auth candidate` sections from today's `current-allow-list.txt`.
- A new `current-block-list.txt` is seeded with one entry, `self.events.data.microsoft.com`, to demonstrate the format.

`susentorno init` copies all three into a new environment's `.susentorno/proxy/`.

`import-sbx-network-policy` (which only ever produces passthrough and claude-authenticated entries from an upstream sandbox policy file) writes its passthrough output to `current-allow-list.txt` and its claude-authenticated output to `current-auth-list.txt`. Its single `-o, --output <path>` option is replaced by two: `--allow-output <path>` (default `current-allow-list.txt`) and `--auth-output <path>` (default `current-auth-list.txt`). It keeps its existing full-overwrite behavior on both files — it does not preserve hand-added `github`/`codex`/`auth candidate` sections in `current-auth-list.txt` across a re-run, same limitation as today (already documented in its `--help` text).

## Documentation

`diagnostics.md`'s "Watching proxy traffic" tag table and "Maintaining the allow list" section are updated to describe the three files, the new `ALLOW OPEN`/`BLOCK LIST` tags, the `domain:port` log format, and `--skip-allow-list`. `README.md`'s one-line mention of "restricts network access to an allow list" needs no change.

## Testing

- Unit tests for the new `allow-list.txt`/`auth-list.txt`/`block-list.txt` parsers, including block-list wildcard matching and the pruning pass that removes blocked hosts from the combined allow/auth entries.
- Unit tests for the cross-file collision priority (unchanged priority order, now sourced from two files).
- Unit tests for `classify.ts`'s two new tags and the domain:port formatting across every existing tag.
- Unit tests for `envoyConfig.ts`'s new default-chain branching: block-list-only, `--skip-allow-list` off, `--skip-allow-list` on, and `--skip-allow-list` on with a block-list entry present (block must still win).
- An integration test in `tests/proxy-stack/` exercising `--skip-allow-list` end-to-end: an unlisted host gets through and logs `ALLOW OPEN`, while a block-listed host is still denied even with the flag set.
- Updated tests for `import-sbx-network-policy` (two output files) and `init` (three files copied instead of one).
