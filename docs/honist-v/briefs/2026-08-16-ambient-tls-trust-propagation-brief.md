# Follow-up: propagate the host's ambient TLS trust into provisioned guests

Deferred work, agreed 2026-08-16 while finishing the Hyper-V guest test tier.
Not part of that plan; to be picked up afterwards.

## Problem

`setup-guest-unix` provisions a guest from a pristine base image. If the machine
running it sits behind a TLS-intercepting proxy — a corporate middlebox, a CI
runner behind inspection, or another susentorno installation — the guest inherits
that interception through the host's NAT and DNS, but inherits none of the trust
that makes it workable. The host has the interceptor's CA in its trust store; the
guest has never heard of it.

The result is a partial, confusing failure. Plain HTTP works. Hosts the
interceptor passes through work, because the guest sees the origin's real
certificate. Hosts the interceptor terminates fail certificate verification:

```
curl: (60) SSL certificate OpenSSL verify result: unable to get local issuer certificate (20)
```

This is not hypothetical. It is what blocked a susentorno guest from being
provisioned on a machine that is itself a susentorno guest — the nested case hit
while building the Hyper-V guest test tier. It was worked around at the time by
moving `github.com` and `api.github.com` to passthrough in the outer
environment's allow list, which is a local expedient, not a fix.

### Concrete failure

Pre-scripts run in the **setup** phase, on the Default Switch, before isolation —
so they use the host's ordinary network path, interception included.
`templates/vm-shared-linux/pre-scripts/02-install-pnpm.sh:10` pipes
`https://get.pnpm.io/install.sh` into bash. That fetch succeeds. The installer
then downloads its binary from a different host:

```sh
archive_url="https://github.com/pnpm/pnpm/releases/download/v${version}/${asset_base}"
```

If the outer proxy terminates that host, the download fails, the script exits 1,
and `runPreScripts` aborts the whole provisioning run.

Two dead ends worth recording, because both look plausible:

- **The CA installed by `nn-configure-network.sh` is unrelated and cannot help.**
  It is susentorno's own proxy CA, used only after isolation onto the Internal
  switch. The interception here is upstream of the host and uses a different key
  entirely. Script ordering is not the issue.
- **Allow-listing does not help.** The failing host is typically not blocked — it
  is permitted and deliberately terminated. No allow-list change alters the
  certificate the guest is offered.

## Proposed change

Give `setup-guest-unix` an extra-CA input, and install it into the guest before
anything in the guest makes an HTTPS call — i.e. ahead of `mountShare` and
`runPreScripts`.

Proposed interface: `--extra-ca <path>`, repeatable, defaulting to none. A flag
rather than stdin because a CA certificate is public material, so
[ADR-0022](docs/adr/0022-promptmasked-releases-stdin-explicitly.md)'s
secrets-via-stdin reasoning does not apply.

Installation in the guest should cover the runtimes that ignore the system store,
not just the store itself:

- copy to `/usr/local/share/ca-certificates/` and run `update-ca-certificates`
- point `NODE_EXTRA_CA_CERTS` at the same file via `/etc/profile.d/`, the way
  `nn-configure-network.sh:24` already does for susentorno's own CA

`git`, Python `requests`, and other consumers pick up the system store, so those
two are the load-bearing pair.

**No CA supplied must be an exact no-op**, so a machine that is not behind an
intercepting proxy sees no behaviour change at all.

### Structure

Follow the existing split in `src/guestSetup/`: pure `buildXCommand()` functions
that are unit-testable without a guest, plus a thin executor over the
`RemoteExec` seam. `mountShare.ts` and `kvpDaemon.ts` are the models.

### Harness side — landing with the guest tier, not here

The Hyper-V guest test tier stages the CA into each guest over SSH *before*
invoking anything, driven by an environment variable and a no-op when unset. That
half is being done as part of the guest tier work, because without it the tier
cannot be verified at all on an intercepted machine.

It deliberately requires no `src/` change, so the plan's global constraint holds
and this brief keeps its full scope: making the **command itself** responsible for
installing the CA, via `--extra-ca`.

Once `setup-guest-unix` grows the flag, `tests/guest/e2e.test.ts` should pass it
through instead of staging beforehand — that is what turns the flag into covered
behaviour rather than merely present behaviour.

#### The manual export step should not survive

As shipped, running the tier on an intercepted machine requires a developer to
export the interceptor's CA by hand and point `SUSENTORNO_TEST_EXTRA_CA` at it:

```powershell
$ca = Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -like '*proxy-certificate-authority*' } | Select-Object -First 1
$pem = "-----BEGIN CERTIFICATE-----`n" +
  [Convert]::ToBase64String($ca.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"
Set-Content -Path .image-cache\outer-proxy-ca.pem -Value $pem -Encoding ascii -NoNewline
```

That is a per-machine setup step nobody will remember, and it breaks the
bootstrappable-from-clean property the rest of this tier is careful about — the
same objection that ruled out a hand-built golden VM. It should be **detected,
not configured**: enumerate the host's trusted roots, keep the ones that are not
part of the public root program, and stage those automatically, with the
environment variable surviving only as an override for the cases detection
cannot reach.

Deferred rather than done because auto-detection on Windows needs care to avoid
sweeping in unrelated enterprise roots, and the explicit path was enough to
unblock the tier.

Neither `SUSENTORNO_TEST_EXTRA_CA` nor the exported `.image-cache/outer-proxy-ca.pem`
is mentioned in `development.md` or `testing.md`, and that is deliberate: the
guest tier is in the default `pnpm test` pipeline, so anything written there
reads as a standing prerequisite alongside elevation, Hyper-V, Docker, and
`ssh-agent`. Documenting a step we intend to delete would be worse than leaving
it here. **If detection is not built and the environment variable becomes the
permanent answer, it must be documented in both files at that point** — an
undocumented per-machine setup step that the default pipeline silently depends
on is the failure mode to avoid.

## Test coverage — read this before relying on the tier

The guest tier will exercise this path **only on a machine that is actually
behind an intercepting proxy**. On a clean machine the bundle is empty and the
whole path no-ops, so the tier would prove nothing there. Coverage would be
accidental: real on one developer's box, absent in CI and on everyone else's.

So the mechanism needs deterministic coverage of its own:

- unit tests over the command builders, in `tests/unit/guest/`
- a phase test that installs a **throwaway self-signed CA** into a guest and
  asserts it lands in the system store and in `NODE_EXTRA_CA_CERTS` —
  deterministic regardless of the host's network

The end-to-end run is then integration proof on top of that, not the only proof.

## Split out: Envoy does not validate upstream certificates

Done. Designed in
`docs/honist-v/specs/2026-08-17-envoy-upstream-certificate-validation-design.md`
and recorded as
[ADR-0026](../../adr/0026-validate-upstream-certificates-against-ambient-trust.md).

## Generalisation

The underlying rule is not susentorno-specific:

> A tool that provisions an execution environment must propagate the ambient TLS
> trust of the machine it runs on into the environments it creates.

Docker builds, CI runners, and devcontainers behind corporate TLS inspection all
hit this, and the conventions are settled: system store first, then the
per-runtime overrides that bypass it (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
`SSL_CERT_FILE`, `http.sslCAInfo`). The inner environment is built from a pristine
base image precisely so that it is clean — and being clean is exactly what makes
it distrust the boundary it now sits behind.

A standalone, repository-independent write-up of the underlying problem exists as
`nested-guest-tls-interception.md`, suitable for reporting elsewhere.

## Scope note

This amends the Hyper-V guest test tier plan's Global Constraint "No changes to
`src/` beyond one line"
(`docs/honist-v/plans/2026-08-15-hyperv-guest-test-tier.md:13`). That constraint
was written before this problem was known. The amendment is deliberate.
