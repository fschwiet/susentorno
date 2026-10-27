# 02: Bring up each color with its configuration bind-mounted again

**What to build:** `run-hosting` brings up each Envoy color with a single force-recreating `compose up` again. The environment's rendered Envoy config, Lua gate, CA directory, and secrets directory are bind-mounted read-only at their existing container paths. The copy step, the CA staging folder, and the separate remove/create/start sequence go away. Startup, credential refreshes, and policy-reload swaps each cost one Compose call per color.

These stay as they are:
- the `susentorno.environment` ownership label and `verify-proxy.ps1`'s label-based check
- SDS sources without watched directories
- `write-github-config`'s restart notice

Ticket 01 already keeps the root CA private key out of the mounted CA directory. This ticket also records the decision and documents WSL 2 as the supported Docker Desktop backend. See the spec's "Color bring-up", "Compose template", "Kept from the copy-based work" and "Docs and ADRs" decisions.

**Blocked by:** 01 (keep the root CA private key outside the proxy directory). Without it, mounting the CA directory would expose the key inside Envoy.

**Status:** ready-for-review

- [ ] The Compose template's shared Envoy definition bind-mounts the four configuration paths read-only. It keeps the ownership label, image, restart policy, host-gateway mapping, command, and per-color published ports.
- [ ] Color bring-up keeps its contract with the run-hosting loop: same inputs, including the environment directory for the label. It resolves once the color is started and rejects on failure, so the current color keeps serving.
- [ ] No copy or staging code remains in bring-up. Comments elsewhere that describe bind mounts as gone or describe the copy step are updated, including in `verify-proxy.ps1`.
- [ ] `proxy-stack` test: after the first bring-up, and again after a policy-reload swap, each running Envoy container carries this environment's label, has the leaf certificate, leaf key, and upstream trust bundle at its CA path, and has no root CA private key there. The "no mounts" assertion is removed.
- [ ] `unit` template tests: "declares no volumes" is replaced by a check that the four configuration paths are mounted read-only and that the CA mount source is the proxy CA directory. The ownership-label and `verify-proxy.ps1` label checks still pass.
- [ ] The existing `proxy-stack` tests pass unchanged: lifecycle, policy reload, injection, allow-list enforcement, upstream validation, MCP server, robustness, serving-state detection, and skip-allow-list.
- [ ] A new ADR records the move back to read-only bind mounts, the WSL 2 Docker backend requirement, and the root CA key living outside every mounted directory. It rejects keeping the copy path for its per-bring-up cost and complexity. ADR 0029 is marked superseded by it. ADR 0012's reference to configuration by copy is reworded so its rejection of hot-reload doesn't depend on how configuration reaches the container.
- [ ] `README.md`'s host prerequisites and `development.md`'s Docker Desktop prerequisite state that Docker Desktop must use the WSL 2 backend.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 03 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
2. `pnpm test:unit`
3. `pnpm build`, then `pnpm test:proxy-stack -- .\tests\proxy-stack\stackLifecycle.test.ts .\tests\proxy-stack\policyReloadLifecycle.test.ts` while iterating
4. Once, when done: the full `pnpm test:proxy-stack` tier. This ticket changes how every container gets its configuration, so every `proxy-stack` file shows whether the mounted configuration is complete.

Skip the `cli`, `host-network` and `guest` tiers. The `proxy-stack` prerequisites in `testing.md` apply, so stop any live `run-hosting` first.
