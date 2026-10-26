# Spec: proxy containers receive their configuration by copy, not bind mount

Status: ready-for-agent

## Problem Statement

When the proxy stack starts, Docker Desktop on the Hyper-V backend shows a file-sharing permission dialog for each host path the Envoy containers bind-mount: the rendered Envoy config, the Lua gate, the CA directory, and the secrets directory. This happens for every new environment directory, including the throwaway environment each `proxy-stack` and `guest` test run creates under `test-results`, so `pnpm check` stalls on a series of dialogs that a person has to click through. Real users meet the same dialogs the first time they run `run-hosting` in a new environment. Each grant also leaves an entry in Docker Desktop's settings that the user never asked for.

As a side effect of the bind mounts, the root CA private key, which can sign certificates for any host a guest trusts, is also visible inside the internet-facing Envoy container, even though Envoy never reads it.

## Solution

Envoy containers no longer bind-mount anything from the host. When `run-hosting` brings up a color, it creates the container, copies the environment's proxy configuration into the container's own filesystem through the Docker API, and then starts it. Docker Desktop file sharing never comes into play, so no dialogs appear on either Docker backend, and no Docker settings are touched.

The environment's proxy directory on the host stays the single source of truth. A container holds a snapshot of it taken when the container was created. That matches how changes already reach Envoy: every credential refresh and policy edit is applied by bringing up a fresh color (ADR 0012), so the fresh color receives the current configuration.

The root CA private key is left out of the copy. Each container carries a label that names its environment, which replaces the bind-mount source as the way `verify-proxy.ps1` proves that a running Envoy belongs to the environment it is checking.

## User Stories

1. As a susentorno user, I want `run-hosting` to start the proxy stack in a new environment directory without any Docker Desktop dialogs, so that I can set up an environment without clicking through permission prompts.
2. As a developer, I want `pnpm check` to run the `proxy-stack` and `guest` tiers without Docker Desktop dialogs, so that the suite can run unattended.
3. As a coding agent, I want the test tiers to run without any interactive Docker prompts, so that I can validate changes without a human present.
4. As a susentorno user on the Hyper-V Docker backend, I want the proxy stack to work without adding any of my directories to Docker's file-sharing list, so that my Docker settings stay as I configured them.
5. As a susentorno user on the WSL 2 Docker backend, I want the proxy stack to behave exactly as before, so that the change costs me nothing.
6. As a susentorno user, I want susentorno never to edit Docker Desktop's own settings files, so that a Docker update can't break susentorno and susentorno can't damage my Docker configuration.
7. As a susentorno user, I want edits to my allow list, auth list, or block list to still reach the proxy stack through the usual policy-reload swap, so that changing policy works as it does today.
8. As a susentorno user, I want automatic host credential refreshes to keep reaching the proxy stack without dropped connections, so that guests keep working through credential rotations.
9. As a susentorno user, I want the Codex host credential and account id to keep reaching the proxy stack after each refresh, so that Codex keeps working in the guest.
10. As a susentorno user, I want a leaf certificate reissued because the TLS-terminated hosts changed to reach the next color, so that newly terminated destinations are served with a valid certificate.
11. As a susentorno user, I want the upstream trust bundle to keep reaching Envoy, so that upstream certificate validation against ambient trust keeps working.
12. As a susentorno user, I want host-run MCP server routing to keep working, so that guests keep their host-credentialed tool access.
13. As a susentorno user, I want a file I removed from the environment's proxy directory to be absent from the next color, so that stale secrets or config don't linger in a running container.
14. As a susentorno user, I want the root CA private key to stay on the host and out of the Envoy container, so that compromising Envoy doesn't expose a key that can impersonate any terminated destination.
15. As a susentorno user, I want the proxy stack to come back after a Docker Desktop restart with the configuration it had before, so that a Docker restart doesn't leave Envoy without its config.
16. As a susentorno user, I want `verify-proxy.ps1` to confirm that the running Envoy belongs to my environment, so that I don't validate the wrong environment's proxy.
17. As a susentorno user, I want `verify-proxy.ps1` to fail when it can't prove ownership of a running Envoy, including when the container has no environment label, so that a container started by an older susentorno is never mistaken for mine.
18. As a susentorno user who upgrades while a proxy stack started by the old version is still running, I want the next bring-up to replace those containers with copy-based ones, so that I don't need a manual migration step.
19. As a susentorno user, I want a failure while copying configuration into a new color to leave the current color serving, so that a bad copy behaves like any other failed bring-up.
20. As a susentorno user, I want `write-github-config` to tell me that `run-hosting` must be restarted for the new GitHub token to take effect, so that I'm not surprised when the old token is still injected.
21. As a maintainer, I want the rendered Envoy config to stop declaring watched directories for SDS secrets, so that the config doesn't suggest a hot-reload path that never happens.
22. As a maintainer, I want an automated check that Envoy containers have no bind mounts, so that a regression is caught by tests and not by a user seeing a dialog.
23. As a maintainer, I want the reasoning recorded in ADRs (0029, plus the updated 0012), so that nobody brings bind mounts or hot-reload back without knowing why they were removed.

## Implementation Decisions

- **Color bring-up becomes create → copy → start.** The single function that brings up a color stops using a force-recreating `compose up`. It removes any existing container for that color, creates a fresh one through Compose with the same per-color published ports, copies the configuration into it with `docker cp`, and starts it through Compose. Its signature and its contract with the run-hosting loop stay the same: it resolves once the color has been started, and it rejects on failure, so the loop's existing "keep the current proxy" handling covers copy failures too. Stopping a color is unchanged.
- **What is copied:** the rendered Envoy config, the Lua gate, the CA directory without the root CA private key, and the secrets directory, each at the same container path it is mounted at today. The leaf certificate and key and the upstream trust bundle travel with the CA directory. The root CA certificate may be copied; only the root private key is excluded.
- **The Compose template drops every bind mount.** The Envoy service definition keeps its image, restart policy, host-gateway mapping, command, and per-color published ports.
- **Ownership label.** Each Envoy container gets a label naming the environment directory it was created from, set through the Compose template and filled in from the bring-up environment. The label name is in the `susentorno.` namespace.
- **`verify-proxy.ps1` ownership check** reads the label instead of the bind-mount source and compares it, after path normalization, with the environment it was invoked for. A missing label, an inspect failure, or a mismatch all fail closed and exit immediately, the same as the current check. Comments in the script that describe bind mounts are updated.
- **Source of truth is unchanged.** Every host-side writer — `run-hosting`'s config rendering and credential refresh, `generate-ca`, `write-github-config` — keeps writing to the environment's proxy directory. A container's copy is never written back or synced while it runs.
- **Rendered Envoy config:** every file-based SDS source keeps its file path and drops its watched-directory setting.
- **`write-github-config`** adds to its success output that `run-hosting` must be restarted for the new GitHub credential to take effect. Its comment that calls the secrets directory "watched" is corrected. `run-hosting` does not gain a watcher for the GitHub secret files.
- **No Docker settings handling.** susentorno doesn't read or write Docker Desktop's settings, doesn't detect the Docker backend, and doesn't migrate existing file-sharing entries.
- **Upgrade:** no migration step. Containers started by an older version are replaced at the next bring-up.
- **ADRs:** ADR 0029 records this decision. ADR 0012 has been updated so its rejection of hot-reload no longer depends on the bind mount. Both are already written. `CONTEXT.md` is unchanged.

## Testing Decisions

- Good tests here observe external behavior: what Docker reports about the running containers, what the proxy stack actually serves, what the rendered config contains, and what a CLI command prints. They don't assert the sequence of Docker commands that bring-up issues.
- **`proxy-stack` tier (main seam):** through the real `run-hosting` CLI and `docker inspect`, assert that each running Envoy container has no bind mounts, carries the environment label naming this test environment, and has no root CA private key at its CA path. Assert this both after the first bring-up and after a policy-reload swap. Prior art: the stack lifecycle and policy reload lifecycle tests. The existing injection, allow-list enforcement, upstream validation, MCP server and robustness tests must keep passing unchanged; they are the evidence that the copied configuration is complete.
- **`unit` tier, proxy config rendering:** the SDS sources keep their file paths and have no watched-directory setting. Prior art: the existing proxy config tests that assert SDS secret paths.
- **`unit` tier, templates:** `verify-proxy.ps1` checks ownership through the environment label and no longer looks for a bind mount. Prior art: the existing string-level checks of that script. `verify-proxy.ps1` isn't run live, because it also needs the host network.
- **`cli` tier, `write-github-config`:** its output tells the user to restart `run-hosting`. Prior art: the existing `write-github-config` CLI tests.
- The run-hosting loop's unit tests (proxy stack supervisor) mock bring-up and need no changes, since the bring-up contract is unchanged.
- **Manual validation, once implementation is done:** with Docker Desktop quit, remove only the four `test-results\.susentorno\proxy\…` entries from Docker Desktop's `FilesharingDirectories`. Restart Docker Desktop, run `pnpm check`, and confirm no file-sharing dialog appears and no new entries are added.

## Out of Scope

- Hot-reloading secrets or policy without a color swap.
- Making `run-hosting` watch the GitHub secret files and swap when they change.
- Moving the root CA private key, or protecting host secrets at rest (for example DPAPI encryption or a per-user location outside the environment).
- Any detection of, or handling for, the Docker Desktop backend, and any edits to Docker Desktop's settings by susentorno.
- Cleaning up file-sharing entries left behind on other users' machines.

## Further Notes

- Background: Docker Desktop's Hyper-V backend requires a file-sharing grant for bind-mount sources and prompts per path. `docker cp` streams over the Docker API, so it isn't subject to that.
- Running more than one environment at a time is still not possible, because container names are fixed. The label only lets `verify-proxy.ps1` tell which environment a running Envoy belongs to.
- See ADR 0029 (proxy containers receive configuration by copy) and ADR 0012 (blue/green container swap for restarts).
