# 02: Bring up each color with a copied configuration, not bind mounts

**What to build:** `run-hosting` brings up the proxy stack without any Docker Desktop file-sharing dialogs. Bringing up a color now removes any existing container for that color, creates a fresh one through Compose with the same per-color published ports, copies the environment's proxy configuration into it with `docker cp`, and then starts it. The copy covers the rendered Envoy config, the Lua gate, the CA directory without the root CA private key, and the secrets directory, each at its current container path. The Compose template drops every bind mount. Credential refreshes, policy reloads, and leaf reissues keep working, because each one already brings up a fresh color that gets the current configuration (ADR 0012). See the spec and ADR 0029.

**Blocked by:** 01 (ownership label), because removing the bind mounts would otherwise break `verify-proxy.ps1`'s ownership check.

**Status:** ready-for-review

- [x] The Compose template declares no volumes for the Envoy services. The image, restart policy, host-gateway mapping, command, published ports, and the ownership label from 01 are unchanged.
- [x] Color bring-up keeps its contract with the run-hosting loop: it resolves once the color is started and rejects on any failure, including a failed copy, so the current color keeps serving.
- [x] A file removed from the environment's proxy directory is absent from the next color.
- [x] The root CA private key is never copied into a container. The leaf certificate and key and the upstream trust bundle are.
- [x] `proxy-stack` test: after the first bring-up, and again after a policy-reload swap, each running Envoy container has no bind mounts and no root CA private key at its CA path.
- [x] The existing `proxy-stack` tests (lifecycle, policy reload, injection, allow-list enforcement, upstream validation, MCP server, robustness) pass unchanged.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 05 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
2. `pnpm test:unit`
3. `pnpm build`, then `pnpm test:proxy-stack -- .\tests\proxy-stack\stackLifecycle.test.ts .\tests\proxy-stack\policyReloadLifecycle.test.ts` while iterating
4. Once, when done: the full `pnpm test:proxy-stack` tier. This ticket changes how every container gets its configuration, so every `proxy-stack` file is evidence that the copy is complete.

Skip the `cli`, `host-network` and `guest` tiers. The `proxy-stack` prerequisites in `testing.md` apply, so stop any live `run-hosting` first.
