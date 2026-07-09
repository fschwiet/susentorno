# Proxy CA / leaf split — design

Date: 2026-07-09

## Problem

The sandbox proxy terminates TLS for an allow-listed set of hosts
(`api.anthropic.com`, `claude.com`, …) so it can gate and credential-inject
requests. Today it does this by serving a **single self-signed certificate**
directly as the TLS leaf for every terminated host.

`src/ca.ts` generates one cert that is simultaneously:

- a CA (`basicConstraints CA:TRUE`), and
- the server certificate (carries the terminated hostnames as SANs),

and `src/envoyConfig.ts` hands that exact file to clients as
`certificate_chain` (`/etc/envoy/ca/cert.pem`).

curl and Node accept this because OpenSSL will treat a trusted self-signed cert
as a valid anchor even when it is also the leaf. **Firefox does not.**
mozilla::pkix refuses to accept a self-signed certificate as the end-entity
server cert — even one installed as trusted — because it requires the leaf to
chain up to a *separate* trust anchor. Result: `claude.com` (terminated) shows
"potentially serious security issue … self-signed certificate" in Firefox,
while `github.com` (passthrough, real chain) loads fine.

Confirmed empirically: the served `cert.pem` has `subject == issuer`,
`CA:TRUE`, and the server SANs; installing it in Firefox (via
`06-trust-ca.sh`'s policy) does not clear the warning.

### Why the obvious "fix" is wrong

Emptying the SAN list does not help: the SANs are what make the served cert
*match* the hostname. Removing them breaks hostname verification for **every**
terminated host — including `api.anthropic.com` — which would break the `claude`
CLI and curl (which currently work), and Firefox would simply swap
"self-signed" for "domain mismatch". There is also no Firefox policy toggle that
waives the self-signed-leaf error.

## Goal

Make Firefox (and any strict TLS client) trust the terminated hosts, without
regressing the clients that already work (curl, Node/`claude` CLI, the
integration and verify checks).

Non-goals: dynamic per-connection certificate minting (mitmproxy-style). The
terminated host set is a known, finite list, so a single leaf covering all of
them is sufficient.

## Design: split the one cert into a root CA + a leaf

Generate **two** certificates instead of one:

- **Root CA** — `CA:TRUE`, `keyUsage = keyCertSign, cRLSign`, **no server
  SANs**. This is the durable trust anchor: installed in the VM trust store, in
  Firefox (via the existing `06-trust-ca.sh` policy), and used as `--cacert` by
  the tests and `verify-proxy.ps1`.
- **Leaf** — `CA:FALSE`, `keyUsage = digitalSignature, keyEncipherment`,
  `extKeyUsage = serverAuth`, carrying the terminated hostnames as SANs, signed
  by the root CA's key. This is what Envoy presents.

Firefox then validates leaf → root, where root is a *separate* installed anchor,
and is satisfied. curl/Node continue to work: they trust the root and receive a
leaf that chains to it.

### SANs are derived from the allowlist

The leaf's SANs are **not** a hardcoded list. They are derived from the
allowlist's `# terminate` section — exactly the hosts Envoy presents the leaf
for:

- Take `allowlist.terminate` entries ending in `:443`, strip the port.
- The parser rejects wildcards in the terminate section
  (`allowlist.ts`), so every SAN is a concrete DNS name.
- Passthrough hosts get the real upstream certificate, so they need no SAN.

A new helper `terminateTlsHosts(allowlist): string[]` in `src/allowlist.ts`
computes this set. `src/ca.ts` no longer owns a SAN constant; the hardcoded
`CA_SANS` (a hand-maintained duplicate of the terminate section) is removed.

This keeps the leaf in sync with the allowlist automatically: adding a
terminated host and re-running `generate-ca` reissues the leaf with the new SAN.

## File layout

Keep `cert.pem` / `key.pem` meaning the **root CA** everywhere they are already
consumed, so nothing that trusts them changes. Add two files for the leaf.

```
.configamatron/proxy/ca/
  cert.pem        # root CA cert  (anchor; content now CA-only, no SANs)
  key.pem         # root CA key
  leaf-cert.pem   # NEW — server leaf cert with the derived SANs
  leaf-key.pem    # NEW — server leaf key
.configamatron/vm-shared/
  cert.pem        # copy of the root CA cert (unchanged)
```

The docker-compose bind mount already maps the whole `ca/` directory
(`./ca:/etc/envoy/ca:ro`), so the leaf files are available inside Envoy with no
compose change.

### What Envoy serves

`src/envoyConfig.ts` changes the terminate filter chains to present the **leaf
only** (not leaf + root):

```
certificate_chain: /etc/envoy/ca/leaf-cert.pem
private_key:        /etc/envoy/ca/leaf-key.pem
```

Every client we have already holds the root as its anchor, so appending the root
to the presented chain is redundant; serving the leaf alone is simpler and
avoids sending a self-signed root in the handshake.

## Regeneration model: durable root, derived leaf

`configamatron generate-ca` treats the root as long-lived key material and the
leaf as derived from it:

- **Root CA** (`cert.pem` / `key.pem`): reused when both are present and a valid
  pair; generated only when **both** are absent. The "exactly one present" and
  "present but not a valid pair" cases error without overwriting — the existing
  key-safety guard, unchanged.
- **Leaf** (`leaf-cert.pem` / `leaf-key.pem`): reused only when it is a valid
  pair, is signed by the current root, **and** its SAN set equals the
  allowlist-derived set. Otherwise it is reissued from the current root.
  Reissuing the leaf never touches the root, so trust already installed in the
  VM / Firefox stays valid across allowlist changes.
- The root `cert.pem` is copied to `vm-shared/cert.pem` on every run (unchanged).
- Edge case: if the allowlist has no terminated `:443` hosts, there is nothing to
  serve a leaf for — `generate-ca` writes the root and skips the leaf (Envoy has
  no terminate chains in that case anyway).

## Library

Switch `src/ca.ts` from `selfsigned` to **`node-forge` directly** (already a
transitive dependency via `selfsigned`). `selfsigned` cannot sign a leaf with a
separate CA key; node-forge can (`cert.setIssuer(caCert.subject.attributes)`,
`cert.sign(caKey, forge.md.sha256.create())`). `ca.ts` is `selfsigned`'s only
consumer, so `selfsigned` is dropped as a direct dependency and `node-forge`
(with `@types/node-forge`) is added.

## Module API

`src/ca.ts`:

- `CA_COMMON_NAME` — unchanged (root CA CN).
- `LEAF_COMMON_NAME` — new constant, e.g. `configamatron-proxy-leaf`.
- Remove `CA_SANS`.
- `generateCaMaterial(sans: string[]): { caCertPem, caKeyPem, leafCertPem, leafKeyPem }`
  — replaces `generateCaPems()`. Builds the root CA and a leaf covering `sans`,
  signed by the root.
- `generateLeaf(caCertPem, caKeyPem, sans): { leafCertPem, leafKeyPem }` — reissue
  a leaf from an existing root (used when the root is reused but the leaf must be
  regenerated).
- `validateCaPair(certPem, keyPem): boolean` — kept (used for both root and leaf
  pair-match).
- `isSignedBy(leafPem, caPem): boolean` — new; verifies the leaf's signature
  against the CA public key.
- `certSans(certPem): string[]` — new small helper to read a cert's DNS SANs,
  used by the leaf-reuse SAN comparison.

`src/allowlist.ts`:

- `terminateTlsHosts(allowlist: Allowlist): string[]` — new helper returning the
  `:443` terminate hosts with the port stripped.

## Touchpoints / testing

Changed:

- `src/ca.ts` — new two-cert API, node-forge.
- `src/allowlist.ts` — `terminateTlsHosts` helper.
- `src/commands/generateCa.ts` — read + parse the allowlist, derive SANs,
  generate/validate root + leaf per the regeneration model, copy root to
  vm-shared.
- `src/envoyConfig.ts` — terminate chains serve `leaf-cert.pem` / `leaf-key.pem`.
- `tests/unit/ca.test.ts` — root has `CA:TRUE` and **no** server SANs; leaf has
  the SANs, `CA:FALSE`, `serverAuth`, and verifies against the root;
  `terminateTlsHosts` derivation; `isSignedBy` / `certSans`.
- `tests/unit/envoyConfig.test.ts` — expect the leaf filenames.
- `tests/unit/allowlist.test.ts` — `terminateTlsHosts` derivation (strips the
  `:443` port; excludes passthrough hosts).
- `tests/e2e/generateCa.test.ts` — four files produced; `vm-shared/cert.pem`
  equals `ca/cert.pem` (root); root has no server SAN; leaf has the terminate
  SANs; reuse; **leaf reissue preserves the root** (delete leaf, re-run, assert
  `cert.pem` unchanged and leaf restored); SAN change reissues the leaf.
- Regenerate committed sample artifacts: `.configamatron/proxy/ca/*`,
  `.configamatron/proxy/envoy.yaml`, `.configamatron/vm-shared/cert.pem`.
- `package.json` — swap `selfsigned` for `node-forge` + `@types/node-forge`.

Automated proof of the fix: the integration test (`tests/integration/proxy.test.ts`)
already trusts `ca/cert.pem` as `--cacert` and hits a terminated host. After the
split, that exercises a real leaf → root chain (leaf ≠ anchor) — precisely the
property Firefox requires. Firefox itself is re-verified manually (the harness
has no browser): load a terminated host and confirm no warning, with the root
listed in `about:policies`.

Unchanged (verified, not modified):

- `templates/vm-shared/06-trust-ca.sh` (including the Firefox policy addition)
  and `templates/vm-shared/verify-config.sh` — they install `cert.pem` = root
  CA, which now correctly validates leaves.
- `templates/proxy/docker-compose.yml` — whole `ca/` dir already mounted.
- `verify-proxy.ps1` / `tests/proxyStack.ts` — `--cacert = ca/cert.pem` = root,
  still the correct anchor.

## Risks

- **node-forge cert construction correctness** (serial numbers, validity,
  extensions, issuer linkage). Mitigated by the unit tests asserting the parsed
  extensions and the signature relationship, plus the integration test proving a
  real client accepts the chain.
- **Stale artifacts**: forgetting to regenerate the committed `.configamatron`
  samples would leave a self-signed cert in the tree. Called out as an explicit
  task; the e2e test regenerates into a temp dir and would catch structural
  drift.
