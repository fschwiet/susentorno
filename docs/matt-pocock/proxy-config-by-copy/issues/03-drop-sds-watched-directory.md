# 03: Drop watched directories from the rendered SDS sources

**What to build:** The Envoy config that `run-hosting` renders stops suggesting that secrets hot-reload. Every file-based SDS source keeps its secret file path and drops its watched-directory setting. Under ADR 0012 and ADR 0029, nothing in a running container's secrets directory ever changes; every change arrives through a fresh color. Injection behavior stays the same.

**Blocked by:** None (can start immediately).

**Status:** ready-for-review

- [x] No rendered SDS source declares a watched directory. Each one still names its secret file.
- [x] `unit` proxy config tests assert the SDS file paths and the absence of a watched directory.
- [x] The existing `proxy-stack` injection tests (Anthropic, Codex, GitHub) pass unchanged.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 05 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
2. `pnpm test:unit` (iterate with `pnpm test:unit -- .\tests\unit\proxyConfig.test.ts`)
3. `pnpm build`, then only the `proxy-stack` files that exercise secret injection: `pnpm test:proxy-stack -- .\tests\proxy-stack\stackLifecycle.test.ts .\tests\proxy-stack\codexInjection.test.ts .\tests\proxy-stack\githubInjection.test.ts`

The `proxy-stack` prerequisites in `testing.md` apply, so stop any live `run-hosting` first.
