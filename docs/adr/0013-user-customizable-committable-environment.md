# The environment is user-customizable and source-controllable

A generated `.susentorno/` is meant to be committed, but only its user-authored inputs. Its allowlisting `.gitignore` excludes generated state and secrets while re-including `pre-scripts/`, `post-scripts/`, `home-jq-transforms/`, `proxy/allow-list.txt`, `proxy/auth-list.txt`, `proxy/block-list.txt`, `mcp-servers.yaml`, and the `.gitignore` itself.

Two customization mechanisms feed regenerated VM shares: ordered jq transforms merge environment-specific values into guest home settings, while numbered pre- and post-isolation scripts are woven around the shipped scripts. Built-in and custom scripts remain separate blocks, and the `nn-` network script runs last in the pre-isolation phase so every custom pre-script retains setup-phase network access.

## Considered Options

- **Commit everything except an enumerated secret denylist.** Rejected because every new generated file would risk becoming tracked until explicitly excluded. An allowlisted authoring surface fails closed.
- **A general templating language or shared jq helper library.** Rejected in favor of one tested TypeScript application core and jq-only declarative transforms.

## Consequences

- `init` and `update-shares` regenerate both VM-share trees as a validated stage-then-swap transaction, so deleted inputs do not leave stale output behind.
- A `.gitignore` cannot untrack files already indexed; environments created under the former denylist convention require an explicit index cleanup when migrated manually.
