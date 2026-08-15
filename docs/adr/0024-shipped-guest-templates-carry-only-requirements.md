# Shipped guest templates carry only what a susentorno guest requires

The templates susentorno ships install only what a guest needs to *be* a susentorno guest — the packages the product's own scripts call (`curl`, `git`, `jq`, `gh`), the node runtime its home-settings applier needs, and the three coding agents the product has host credential channels and placeholder mounts for. Everything else that had accumulated in `templates/vm-shared-linux/` was one developer's tooling preference — the .NET SDK and its global tools, `okular`, `build-essential`, VS Code and four named extensions, GNOME screensaver settings, and extra MCP wiring — and is removed. Preferences belong on the user side of the line [[user-customizable-committable-environment]] already draws: `pre-scripts/`, `post-scripts/`, and `home-jq-transforms/`, which are exactly the surface a user commits and susentorno weaves in.

The test for "required" is whether removing it breaks a product behavior: `gh` is called by `post-scripts/01-auth-config.sh`; `jq` and node are needed by the home settings transforms; pnpm survives solely as the vehicle for `pnpm runtime set node latest -g`. The three agent installs stay because shipping credential injection ([[credential-injection-at-proxy]], [[pi-agent-reuses-codex-placeholder-literal]]) for an agent the templates do not install would be incoherent. `apt upgrade -y` stays: it is a legitimate step in setting up a real user's guest, and its cost belongs to whoever builds a disposable test image, not to every user.

## Status

accepted (2026-08-15)

## Considered Options

- **Empty the preference scripts but keep the files**, so users have a numbered slot to fill. Rejected: the woven output already gives users their own numbered slots via `pre-scripts/`, so an empty built-in is a file with no reason to exist and a number that shifts everything after it.
- **Keep the VS Code settings transform for Windows only**, splitting its `manifest.yaml` entry. Rejected: it would leave a transform naming extensions only the Windows templates install — a worse thing to hand to the later Windows cleanup than a clean deletion. Deleting the whole entry is the one place this rule's first application reaches a Windows guest.

## Consequences

- `templates/vm-shared-windows/` is a known, deliberate exception on the day this is written: it still ships VS Code, extensions, and .NET tooling. The same treatment is intended there, deferred because the Windows guest path is covered by no test tier — the trim would be unverifiable beyond review, and a Windows guest may enter the test mix later, which would change what "required" means there.
- Users who want the removed tooling add it to their own `pre-scripts/`, which is where it already belonged; nothing about how they do that is new.
- With four built-in Linux pre-scripts reduced to three, `nn-configure-network.sh` weaves out as `04-configure-network.sh` rather than `05-`. Windows keeps four built-ins and stays `05-`, so the two platforms' woven numbering legitimately diverges. The script no longer prints its own number, so nothing downstream can couple to it again.
