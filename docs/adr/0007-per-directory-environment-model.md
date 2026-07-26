# An environment is a `.configamatron` folder owned by the working directory

Every command except `init` and `import-sbx-network-policy` treats the current working directory as the environment root, operating on `<cwd>/.configamatron` and failing fast if it is absent — no parent-directory search, no `--dir` flag. There is **no upgrade path** for a `.configamatron` folder: it is rebuilt from scratch (`init` refuses to touch an existing one), though already-present valid CA/credential material is reused and never silently overwritten. Only **one proxy container can run at a time**: the compose project name is pinned (`name: configamatron`), so bringing up any environment's proxy — or running the test suite — deterministically replaces whichever proxy was running instead of colliding on the host ports.

## Consequences

- Running `pnpm test` replaces a running deployment's proxy container (accepted single-proxy semantics), but no longer corrupts its files; re-running `run-proxy` in the environment directory restores it.
- The user is responsible for running one environment at a time.
- Motivated by the original problem that generated files lived mixed into the repo and `pnpm test` clobbered live deployment files; the fix was to make an environment a property of the directory.
