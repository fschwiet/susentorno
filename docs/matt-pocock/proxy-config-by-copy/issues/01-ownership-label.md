# 01: Envoy containers carry an environment ownership label that verify-proxy checks

**What to build:** Every Envoy color container started by `run-hosting` carries a label naming the environment directory it was brought up for. `verify-proxy.ps1` proves that a running Envoy belongs to the environment it is checking by reading that label, not the bind-mount source of the Envoy config. This prefactor lands while bind mounts still exist, so the ownership check stops depending on them before ticket 02 removes them. See the spec, `docs/matt-pocock/proxy-config-by-copy/spec.md`, and ADR 0029.

**Blocked by:** None (can start immediately).

**Status:** ready-for-review

- [x] The Compose template sets a `susentorno.`-namespaced label on both colors. Its value is the environment directory, filled in from the bring-up environment.
- [x] `verify-proxy.ps1` compares the label, after path normalization, with the environment it was invoked for. A missing label, an inspect failure, or a mismatch each fail closed and exit immediately, as the current check does.
- [x] `verify-proxy.ps1` no longer reads bind mounts to decide ownership, and its comments no longer describe bind mounts as the ownership signal.
- [x] `proxy-stack` test: after `run-hosting` brings up the stack, and again after a policy-reload swap, each running Envoy container's label names this test environment.
- [x] `unit` templates test: `verify-proxy.ps1` checks ownership through the label and doesn't look for a bind mount.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 05 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint` (this covers `lint:ps1` for `verify-proxy.ps1`), `pnpm typecheck`
2. `pnpm test:unit`
3. `pnpm build`, then only the affected `proxy-stack` files: `pnpm test:proxy-stack -- .\tests\proxy-stack\stackLifecycle.test.ts .\tests\proxy-stack\policyReloadLifecycle.test.ts`

The `proxy-stack` prerequisites in `testing.md` apply, so stop any live `run-hosting` first.
