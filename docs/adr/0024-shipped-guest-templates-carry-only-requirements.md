# Shipped guest templates carry only what a susentorno guest requires

The Linux and Windows templates install only software required by susentorno's own guest behavior: tools invoked by shipped scripts, the Node runtime needed by generated settings tooling, and the coding agents for which the product supplies placeholder mounts and host credential injection ([[credential-injection-at-proxy]]). Developer preferences belong in user-authored `pre-scripts/`, `post-scripts/`, and `home-jq-transforms/` ([[user-customizable-committable-environment]]).

The test for “required” is whether removal breaks a product behavior. Git, GitHub CLI, jq, pnpm as the Node-runtime vehicle, Codex, Claude, and Pi meet that test; previously bundled IDEs, SDKs, extensions, desktop preferences, and unrelated tools did not. Operating-system updates remain part of preparing a real guest rather than being optimized around disposable test-image build time.

## Considered Options

- **Keep empty preference scripts as extension slots.** Rejected because user customization inputs already provide ordered slots and empty built-ins would only perturb generated numbering.
- **Retain platform-specific preferences.** Rejected because the product requirement boundary applies equally to Linux and Windows; platform-specific user preferences still belong in customization inputs.

## Consequences

- Both platforms ship three built-in pre-isolation scripts followed by `nn-configure-network`, which weaves to `04-configure-network`.
- Adding a package to a shipped template requires identifying the susentorno behavior that depends on it.
