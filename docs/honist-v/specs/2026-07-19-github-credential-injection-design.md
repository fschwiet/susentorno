# GitHub Credential Injection — Design

**Date:** 2026-07-19

## Problem

GitHub credentials are currently copied onto the client VM (`github-config.txt`
holds a real PAT, consumed by `05-github-auth.sh` / `.ps1`). We want to inject
GitHub credentials at the Envoy proxy on the wire instead — mirroring the Claude
credential injection — so neither the VM nor the shared folder ever holds a real
credential.

`#pragma auth candidate` on github.com confirmed the wire auth scheme:

```
05:07:34 AUTH CANDIDATE github.com https Authorization=Basic ZnNjaH
```

`Basic ZnNjaH…` decodes to `fsch…` — git's smart-HTTP uses HTTP Basic auth
(`Basic base64(user:token)`) against github.com.

## Scope

Two hosts get TLS-terminated injection:

| Host          | Scheme on the wire                    | Injected `Authorization` value |
|---------------|---------------------------------------|--------------------------------|
| `github.com`  | HTTP Basic (`Basic base64(user:tok)`) | `Basic <base64(user:token)>`   |
| `api.github.com` | Bearer (`Bearer <PAT>`)            | `Bearer <PAT>`                 |

- `www.github.com` is **not** injected — it 301-redirects to github.com and
  carries no credentialed traffic (verified: no www.github.com AUTH CANDIDATE
  line appears during git operations).
- `api.github.com` uses **Bearer**, not `token`. Per GitHub docs: "In most cases
  you can use `Authorization: Bearer` or `Authorization: token`… if you are
  passing a JSON web token (JWT), you must use `Authorization: Bearer`." We
  standardize on Bearer.

One PAT feeds both hosts: `gh auth setup-git` installs gh as git's credential
helper, so git's Basic auth to github.com and gh's Bearer auth to api.github.com
both derive from the single stored PAT.

## Architecture

Identical shape to the existing Claude injection:

1. Envoy TLS-terminates the GitHub host (SNI match).
2. A Lua **gate** rejects any real credential leaked from the VM — it 403s any
   `Authorization` header that isn't the expected placeholder. For the Bearer
   host the gate is an exact string match; for the Basic host it validates only
   the *token half* of the credential (see "Envoy filter chains" below).
3. `envoy.filters.http.credential_injector` (Generic) overwrites `Authorization`
   with the real credential, read from a file-based SDS secret.
4. Envoy's `watched_directory` on `/etc/envoy/secrets` hot-reloads the secret
   file, so credentials can be updated on a running proxy.

## Provisioning — repurpose `write-github-config`

The command splits its two outputs so real secrets stay host-side:

**Client identity → vm-shared placeholders.** Writes only `GITHUB_USERNAME` and
`GITHUB_EMAIL` (for `git config user.name` / `user.email`) plus a **placeholder
PAT** — the fixed constant `ghp-SANDBOX-PLACEHOLDER` — into the vm-shared
`github-config.txt` files. No real secret crosses to the VM or share. This one
placeholder PAT is what the VM's `gh`/git will send on the wire to *both* hosts,
and it is the value both gates below check for.

**Real credential → proxy watched dir.** Writes a **new sibling SDS file**
`.configamatron/proxy/secrets/github-secret.yaml`. It is deliberately *not*
`sds-secret.yaml`, which run-proxy rewrites on every Claude token rotation and
would clobber a GitHub credential. Envoy's `watched_directory` reloads any file
in `/etc/envoy/secrets`, so a sibling file gets the same live-update behavior
without conflict. Re-running `write-github-config` updates a live proxy.

The file holds two SDS resources:

```yaml
resources:
  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: github_basic_auth
    generic_secret:
      secret:
        inline_string: "Basic <base64(user:token)>"
  - "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.Secret
    name: github_api_token
    generic_secret:
      secret:
        inline_string: "Bearer <PAT>"
```

Constraints:
- `github-secret.yaml` added to `.gitignore`.
- Command validates PAT format (reuse `validateGithubTokenFormat` from the
  superseded 2026-07-03 plan).
- The PAT value is never echoed to stdout/stderr/logs.

## Envoy filter chains

Two new builders in `src/envoyConfig.ts` parallel to `buildTerminateEntry`, each
producing `gate → credential_injector → router`, each pointing at its own SDS
resource and its own gate:

| Host             | SDS resource        | Scheme | Gate behavior                                        |
|------------------|---------------------|--------|------------------------------------------------------|
| `github.com`     | `github_basic_auth` | Basic  | base64-decode; 403 unless the token half == placeholder PAT |
| `api.github.com` | `github_api_token`  | Bearer | exact string match against `Bearer ghp-SANDBOX-PLACEHOLDER`  |

Because the two schemes gate differently, the gate is parametrized per host
rather than reusing the single `templates/proxy/gate.lua`. Each builder emits its
gate as an **inline Lua source string** in the generated `envoy.yaml`
(`http.lua`'s `default_source_code.inline_string`), so no new file needs to be
mounted into the container and `docker-compose.yml` is unchanged. TLS upstream
clusters use the existing `buildTlsUpstreamCluster` helper.

### Why the Basic gate is username-agnostic

git's Basic credential to `github.com` is `Basic base64(<login>:<PAT>)`, where the
username is the **GitHub account login** that `gh auth setup-git`'s credential
helper supplies — not a value we control or know at config-generation time
(`envoyConfig.ts` sees only the parsed allowlist). Rather than introduce a
separate configuration point for the login, or force the VM to use a fixed
username (which would bypass gh's helper), the `github.com` gate decodes the
Basic credential and checks **only the password half** against the fixed
placeholder PAT `ghp-SANDBOX-PLACEHOLDER`, ignoring the username entirely. This
lets GitHub's own auth component decide when/what username to send, keeps `gh
auth setup-git` as the single credential mechanism, and needs no login discovery
or validation on our side.

Envoy's Lua runtime has no built-in base64 decoder, so the `github.com` gate
embeds a small pure-Lua base64 decode helper (inline in the emitted source
string). Concretely the gate:

1. Reads the `authorization` header; returns (allows) if it is absent.
2. 403s if the value does not start with `Basic `.
3. base64-decodes the remainder; 403s if decoding fails.
4. Splits the decoded `user:pass` on the first `:`; 403s unless the `pass`
   portion equals `ghp-SANDBOX-PLACEHOLDER`.

The `api.github.com` gate keeps the existing exact-match shape (identical logic
to `templates/proxy/gate.lua`, only the placeholder constant differs), 403ing any
`authorization` value that isn't exactly `Bearer ghp-SANDBOX-PLACEHOLDER`.

Note the injected **real** credentials are unaffected by this choice: the
`github_basic_auth` SDS resource still carries `Basic base64(user:token)` built by
`write-github-config`, and the injector overwrites the header wholesale on the
wire (GitHub ignores the Basic username when the password is a PAT).

## Allowlist wiring

A new pragma section for GitHub injection (mirrors `#pragma claude
authenticated`) — e.g. `#pragma github authenticated`. It feeds these hosts into
the terminate-TLS SNI set and the new filter chains. github.com and
api.github.com move out of `#pragma auth candidate` into this section.

While wiring the mirror, rename the existing in-memory `terminate` field and related values to `claudeAuthenticated` and name the new mirroring field and related values `githubAuthenticated`, so
the two injection paths read symmetrically throughout the allowlist model and its
consumers.

## VM script 05 changes + reordering

`05-github-auth.sh` / `.ps1` currently install `gh`, set git identity, run
`gh auth login --with-token`, and `gh auth setup-git` — using the real PAT from
`github-config.txt`. Under the new design they use the **placeholder** PAT.

`gh auth login --with-token` validates the token against api.github.com, so the
script only succeeds once the network is proxied (the proxy injects the real
Bearer token, making the placeholder validate). The script therefore moves from
step 5 to **after** network isolation: after `07-setup-network`, the switch to
host-only networking, and the reboot.

## Docs

- `usage-windows-vm.md`: renumber / reorder so `05-github-auth.ps1` runs after
  network isolation and reboot.
- `usage-hyper-v-host.md`: remove the caveat (~line 223) that "the VM does still
  hold a real GitHub token" — after this change neither the VM nor the share
  holds a real credential.

## Testing

- **Unit:** `github-secret.yaml` formatter (both resources), PAT validation,
  envoy config splicing for the two new chains (each chain carries its own inline
  gate source, SDS resource name, and cluster).
- **Integration:** Envoy accepts the generated config with both GitHub chains
  (mirrors the recent auth-candidate integration test). Because the Basic gate
  embeds hand-written base64-decode Lua, also drive the `github.com` chain
  behaviorally through the running proxy: a `Basic base64(<anyuser>:ghp-SANDBOX-PLACEHOLDER)`
  request is injected and reaches the upstream, while `Basic base64(<anyuser>:some-other-token)`
  and a malformed/non-Basic `Authorization` are 403'd before the upstream — and
  confirm the injected upstream request carries the real credential from the SDS
  file.
- **Manual:** end-to-end `git push` and a `gh` API call through the proxy with a
  real PAT in `github-secret.yaml`, confirming injection and that a leaked real
  credential from the VM is gated (403).

## Superseded

Replaces `docs/superpowers/plans/2026-07-03-vm-github-auth.md`, which copied the
real PAT onto the VM. Reuses that plan's `validateGithubTokenFormat` logic.
