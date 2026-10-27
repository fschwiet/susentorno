# 01: Keep the root CA private key outside the proxy directory

**What to build:** The root CA private key lives in its own private directory in the environment, `.susentorno/ca-private/`, not in the proxy CA directory. Nothing the proxy stack mounts or copies can then contain it.
- A new environment gets the key there from `generate-ca`.
- An existing environment has its key moved there, unchanged, the next time `generate-ca` runs, which reports the move.
- If a key exists at both the old and new locations, `generate-ca` stops, names both paths, and changes neither.
- `run-hosting` reads the key from the new location for leaf reissues. If it finds the key only at the old location, it stops before any Docker or network work and tells the user to run `generate-ca`.

The proxy stack still receives its configuration by copy in this ticket. The copy's CA allowlist continues to exclude the key. See the spec's "Root CA key location", "`generate-ca` owns the move" and "`run-hosting` detects but never moves" decisions.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] The environment paths name the root CA private key at `.susentorno/ca-private/key.pem` and expose the old proxy-CA-directory location separately for detection. The environment's `.gitignore` template is unchanged and still ignores the new directory.
- [ ] `cli` test: `generate-ca` in a fresh environment writes the key to the private directory and no key file to the proxy CA directory.
- [ ] `cli` test: `generate-ca` in an environment with the key only at the old location leaves the identical key at the new location and none at the old one. It reports the move, leaves the root CA certificate unchanged, and keeps a still-valid leaf.
- [ ] `cli` test: `generate-ca` with keys at both locations exits with a failure naming both paths and leaves both files byte-for-byte unchanged.
- [ ] The existing `generate-ca` CLI tests (one-of-pair failure, invalid pair, never overwriting, reuse) use the new key path and pass.
- [ ] `cli` test: `run-hosting` in an environment whose key exists only at the old location exits with a failing code and an error naming `generate-ca`, without needing Docker.
- [ ] `run-hosting`'s existing "CA not found, run `generate-ca`" message still appears when there is no key at either location.
- [ ] `generate-ca`'s command description names where the root CA certificate and key are written.
- [ ] The environment-paths unit test expects the new key path.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 03 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
2. `pnpm test:unit`
3. `pnpm build`, then `pnpm test:cli -- .\tests\cli\generateCa.test.ts` and the file holding the new `run-hosting` early-exit test
4. Once, when done: `pnpm test:proxy-stack -- .\tests\proxy-stack\stackLifecycle.test.ts .\tests\proxy-stack\policyReloadLifecycle.test.ts`. These show that leaf issuance through the new key location and the proxy stack still work.

Skip the `host-network` and `guest` tiers. The `proxy-stack` prerequisites in `testing.md` apply, so stop any live `run-hosting` first.
