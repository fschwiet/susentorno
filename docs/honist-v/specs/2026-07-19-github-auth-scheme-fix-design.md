# GitHub Credential Injection — Auth Scheme Fix

**Date:** 2026-07-19

**Corrects:** `docs/honist-v/specs/2026-07-19-github-credential-injection-design.md`

## Problem

The original design assumed `api.github.com` traffic uses `Authorization: Bearer <PAT>`, citing GitHub's REST API docs ("if you are passing a JSON web token (JWT), you must use `Authorization: Bearer`"). That citation describes what GitHub's server *requires for JWTs* — it does not describe what the `gh` CLI actually sends for a personal access token. Live traffic capture through `#pragma auth candidate` on `api.github.com` shows `gh auth login --with-token` actually sends `Authorization: token ghp-SA...` — the classic `token` scheme, not `Bearer`.

Because the `api.github.com` gate (`GITHUB_BEARER_GATE_LUA` in `src/envoyConfig.ts`) exact-matches only `Bearer ghp-SANDBOX-PLACEHOLDER`, the real placeholder request never matches, the gate 403s it before the credential injector runs, and `gh auth login` fails with `HTTP 403: 403 Forbidden (https://api.github.com/)`.

Separately, `templates/vm-shared-windows/05-github-auth.ps1` doesn't check `$LASTEXITCODE` after `gh auth login --with-token` / `gh auth setup-git`. `$ErrorActionPreference = 'Stop'` only converts terminating *PowerShell* errors — it does not turn a non-zero exit code from a native executable into a terminating error. So the script printed its "git identity and gh auth configured" success line even though `gh auth login` had just failed. (The bash twin, `05-github-auth.sh`, is unaffected: `set -euo pipefail` already fails the script when the piped `gh auth login` fails.)

## Scope

Two independent fixes, both to already-shipped code from the 2026-07-19 GitHub injection feature:

1. **`api.github.com` gate + injected credential scheme.**
2. **`05-github-auth.ps1` exit-code handling.**

Explicitly out of scope: `src/runProxy/classify.ts`'s `ALLOW CRED` tag for the `'term'` access-log path. It reflects which filter chain a request landed on (credential-injection chain), not whether the gate accepted the credential — that's accurate to what the proxy did and is not being changed here.

## Fix 1: `api.github.com` gate accepts `token` or `Bearer`; injection always writes `token`

`gh` today sends `token`. GitHub's cli/cli tracks an open, unshipped request (#12828) to add `Bearer` support for JWT/GitHub-App alignment — so a client-side scheme change is plausible later. The gate should tolerate either without another proxy fix being needed.

Preserving whichever scheme the client actually sent (echoing `token` back for `token`, `Bearer` back for `Bearer`) was considered, but Envoy's `credential_injector` filter has no per-route config message (confirmed against the v1.31/latest proto and docs) — so there is no supported way to pick between two SDS-backed credential values based on request content within one route. The only way to preserve the exact scheme would be to have the Lua gate itself rewrite the header, which requires the real PAT to be embedded directly in the generated `envoy.yaml`'s Lua source. That reintroduces exactly what the file-based SDS `watched_directory` design exists to avoid: the real secret landing in a generated config file, and every credential rotation requiring a full config regen instead of a hot-reloadable file swap. Not worth it.

Instead: the gate accepts either `token ghp-SANDBOX-PLACEHOLDER` or `Bearer ghp-SANDBOX-PLACEHOLDER` as valid placeholders, and the injector always overwrites `Authorization` with `token <realPAT>`. GitHub's REST API accepts `token` for any PAT-based credential unconditionally — the `Bearer`-required carve-out is specific to JWTs (GitHub App installation tokens), which a PAT is never. So normalizing to `token` on the way out is safe regardless of which scheme `gh` used on the way in, today or after any future `gh` upgrade.

**`src/envoyConfig.ts`:**
- Rename `GITHUB_BEARER_GATE_LUA` → `GITHUB_API_TOKEN_GATE_LUA` (no longer Bearer-specific); update its adjacent comment.
- Gate logic: reject unless `auth == "token " .. PLACEHOLDER or auth == "Bearer " .. PLACEHOLDER`.

**`src/githubSecret.ts`:**
- `formatGithubApiTokenSecret(token)` renders `inline_string: "token ${token}"` instead of `"Bearer ${token}"`.

No change to the `github.com` Basic gate (`GITHUB_BASIC_GATE_LUA`) — that scheme was already verified against live traffic in the original design and is unaffected by this fix.

## Fix 2: `05-github-auth.ps1` fails loudly on `gh` failures

Follow the existing convention already used in `08-claude-config.ps1` / `04-configure-tools.ps1` — check `$LASTEXITCODE` explicitly after each native `gh` invocation and exit non-zero with a clear message instead of falling through to the success line:

```powershell
$cfg['GITHUB_TOKEN'] | gh auth login --with-token
if ($LASTEXITCODE -ne 0) { Write-Error "05-github-auth: gh auth login failed"; exit 1 }
gh auth setup-git
if ($LASTEXITCODE -ne 0) { Write-Error "05-github-auth: gh auth setup-git failed"; exit 1 }
```

`05-github-auth.sh` needs no change.

## Testing

- **Unit (`tests/unit/envoyConfig.test.ts`):** the existing "builds an api.github.com Bearer chain" case is replaced with assertions that the generated gate source contains both `token ghp-SANDBOX-PLACEHOLDER` and `Bearer ghp-SANDBOX-PLACEHOLDER`, and that a non-matching scheme (e.g. `Basic ...`) is not treated as the placeholder.
- **Unit (`tests/unit/githubSecret.test.ts`):** `formatGithubApiTokenSecret` test updated to expect `inline_string: "token ${token}"`.
- **Integration (`tests/integration/githubInjection.test.ts`):** the `api.github.com Bearer injection` describe block is renamed and extended to drive both placeholder schemes (`token ghp-SANDBOX-PLACEHOLDER` and `Bearer ghp-SANDBOX-PLACEHOLDER`) through the running proxy, asserting the upstream sees `token <realPAT>` in both cases; the wrong-token-403 case is retained.
- **No behavioral PowerShell test.** Nothing in the suite drives `05-github-auth.ps1` against a real `gh`/Windows environment — there's no harness to exercise the exit-code path end-to-end, so that stays a known, accepted gap rather than one this fix invents a mock to paper over. It's still cheap to add a static content assertion to `tests/unit/templates.test.ts` in the same style as the existing check at line 72-80 (grep the template for the `$LASTEXITCODE` guard after each `gh` call), which at least catches a regression where the check is later deleted.

## Self-Review

- **Placeholder scan:** no TBDs; both fixes are fully specified down to the exact code changes.
- **Internal consistency:** Fix 1 only touches the `api.github.com` gate/secret; the `github.com` Basic gate and its SDS file are untouched and still match the original design. Fix 2 only touches the Windows script; the bash twin is explicitly called out as needing no change.
- **Scope:** two small, independent, already-diagnosed fixes to shipped code — no decomposition needed.
- **Ambiguity:** "accept both schemes, normalize to `token`" is stated for both the gate (accept) and the secret formatter (emit) sides, so there's no room to implement only one side.
