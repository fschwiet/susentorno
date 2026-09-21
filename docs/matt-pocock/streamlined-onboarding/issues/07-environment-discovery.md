# Environment discovery: where `.susentorno` comes from when setup-guest runs in an arbitrary directory

Type: grilling
Status: open
Blocked by: —

## Question

When a user runs a setup-guest command, which environment does it act on, and under what
circumstances may it create one?

This is where "go straight to setup-guest" collides with
[ADR 0007](../../../adr/0007-per-directory-environment-model.md), the per-directory environment
model. `CONTEXT.md` defines an **Environment** as "the complete configuration and generated state
for one isolated agent workspace, **owned by a single working directory**." `susentorno init`
scaffolds `.susentorno` into the current directory, and `requireEnvPathsOrExit` is how every
env-dependent command resolves it today.

The tension is direct: if ensure auto-creates a missing environment, and the user happens to be in
their home directory or a source repo when they run setup-guest, it scaffolds an environment
somewhere they did not intend — and generated state, a CA keypair, and a `.gitignore` land in a
directory that may already be a git repository with its own ideas.

Candidate resolutions:

- **Refuse unless the cwd already has one.** Safest, and preserves ADR 0007 exactly, but it means
  the user still has to know about `init` — which is most of what this effort set out to remove.
- **Search upward from the cwd**, like `git` or `node_modules` resolution. Makes running from a
  subdirectory work, but does not help a user starting from nothing.
- **Auto-create in the cwd, with a confirmation.** A confirmation prompt is a prompt, which sits
  awkwardly against this effort's no-inline-prompt rule — though that rule was framed around
  *missing manual prerequisites*, and this is arguably a different kind of question.
- **A default environment at a known path** under the user's profile, used when the cwd has none.
  Most convenient, and the largest departure from ADR 0007 — it would make "one environment per
  directory" no longer the whole story, and likely needs a superseding ADR.

Note the interaction with **isolation name**, already in `CONTEXT.md`: it "selects which parallel set
of susentorno host objects a command acts on," so there is already a mechanism for addressing one of
several parallel installations. Whether environment selection should ride on that, or stay a
separate axis, is part of this question.

A resolution must state the lookup rule, whether creation is ever implicit, what happens when the
cwd is inside a git repository that is not an environment, and whether ADR 0007 survives unchanged,
needs amending, or needs superseding.
