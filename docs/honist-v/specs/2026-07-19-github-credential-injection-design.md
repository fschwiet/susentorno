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
   `Authorization` header that isn't the known placeholder.
3. `envoy.filters.http.credential_injector` (Generic) overwrites `Authorization`
   with the real credential, read from a file-based SDS secret.
4. Envoy's `watched_directory` on `/etc/envoy/secrets` hot-reloads the secret
   file, so credentials can be updated on a running proxy.

## Provisioning — repurpose `write-github-config`

The command splits its two outputs so real secrets stay host-side:

**Client identity → vm-shared placeholders.** Writes only `GITHUB_USERNAME` and
`GITHUB_EMAIL` (for `git config user.name` / `user.email`) plus a **placeholder
PAT** into the vm-shared `github-config.txt` files. No real secret crosses to the
VM or share.

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
producing `gate.lua → credential_injector → router`, each pointing at its own SDS
resource and its own placeholder gate:

| Host          | SDS resource        | Gate placeholder                        |
|---------------|---------------------|-----------------------------------------|
| `github.com`  | `github_basic_auth` | `Basic <base64(user:PLACEHOLDER)>`      |
| `api.github.com` | `github_api_token` | `Bearer ghp-SANDBOX-PLACEHOLDER`       |

Because the two schemes need distinct placeholders, the gate must be
parametrized per host rather than reusing the single `templates/proxy/gate.lua`.
TLS upstream clusters use the existing `buildTlsUpstreamCluster` helper.

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
  envoy config splicing for the two new chains.
- **Integration:** Envoy accepts the generated config with both GitHub chains
  (mirrors the recent auth-candidate integration test).
- **Manual:** end-to-end `git push` and a `gh` API call through the proxy with a
  real PAT in `github-secret.yaml`, confirming injection and that a leaked real
  credential from the VM is gated (403).

## Superseded

Replaces `docs/superpowers/plans/2026-07-03-vm-github-auth.md`, which copied the
real PAT onto the VM. Reuses that plan's `validateGithubTokenFormat` logic.
