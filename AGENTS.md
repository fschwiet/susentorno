** DO NOT USE WORKTREES OR PARALLEL AGENTS FOR EDITS ** Making changes reliably in this project requires tests and this project's tests do not work in parallel.

susentorno is a project to support deploying isolated VMs for agentic development. When working on this project you may be running on the susentorno host or within a VM isolated by susentorno.

The test suites build their throwaway susentorno environment under `test-results/.susentorno` (gitignored test residue), not at the repository root. A bare `.susentorno` at the repository root is not created by normal test runs and does not represent a long-running deployment. If you find one, do not assume it is disposable — it may be an environment someone created by running the CLI manually. Leave it alone unless you know it is stale test residue.

Tests are split across the `unit`, `cli`, `host-network`, `proxy-stack`, and `guest` tiers, named for the highest interface each exercises. Before adding a test, read `testing.md` for the tier surfaces, placement rules, and per-tier prerequisites.

## Agent skills

### Issue tracker

Issues, specs, and wayfinder maps live as markdown files under `docs/matt-pocock/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as `Status:` values. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
