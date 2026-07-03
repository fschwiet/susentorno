# configamatron

Utility code to help set up isolated environments for agents on Windows. A proxy is configured to run in Docker to restrict network access and inject necessary credentials.

See [VM setup](vm-setup.md)
See [Envoy proxy setup](envoy-proxy.md).

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [pnpm](https://pnpm.io/) — install with `npm install -g pnpm`

## Install

```
pnpm install
```

## Verification Pipeline

Run these commands in order to verify a change is correct (fail-fast order):

| Step | Command             | What it checks                          |
| ---- | ------------------- | --------------------------------------- |
| 1    | `pnpm format:check` | Prettier formatting                     |
| 2    | `pnpm lint`         | ESLint rules                            |
| 3    | `pnpm typecheck`    | TypeScript types (no emit)              |
| 4    | `pnpm test:unit`    | Unit tests (Vitest)                     |
| 5    | `pnpm build`        | Production build (tsup → `dist/cli.js`) |
| 6    | `pnpm test:e2e`     | End-to-end tests against the built CLI  |

Run the full pipeline in one command:

```
pnpm test
```
