# An environment is a `.susentorno` folder owned by the working directory

Environment-scoped commands operate on `<cwd>/.susentorno`, with no parent-directory search or `--dir` override, and fail fast when it is absent. `init` creates that environment; `import-sbx-network-policy` and the host-level `create-host-network`/`delete-host-network` commands do not require one. There is no in-place environment upgrade: `init` refuses an existing `.susentorno`, while durable CA material is reused only by the commands that regenerate its derived state.

Only one proxy stack can run on a host at a time because its Compose project and container names are fixed. The proxy-stack and guest suites use `test-results/.susentorno`, not a repository-root environment, and reject the standard conflict when `run-hosting` is already serving the gateway ports; they still share the same single proxy-stack identity.

## Consequences

- A repository-root `.susentorno` may be a manually created, long-running environment and is not test residue.
- The user is responsible for running one environment's proxy stack at a time.
- Keeping generated state under the owning working directory prevents different environments from overwriting each other's files even though their runtime proxy stack is host-global.
