# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `docs/matt-pocock/`.

## Conventions

- One feature per directory: `docs/matt-pocock/<feature-slug>/`
- The spec is `docs/matt-pocock/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `docs/matt-pocock/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `docs/matt-pocock/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket. Every operation below ends with a commit: the working tree is the store, and wayfinder expects concurrent sessions, so an uncommitted write is invisible to them and to the next session.

- **Map**: `docs/matt-pocock/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `docs/matt-pocock/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `docs/matt-pocock/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
