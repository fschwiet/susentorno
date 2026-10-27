# Spec: proxy containers bind-mount their configuration again, with the root CA key kept outside the mounted tree

Status: ready-for-agent

## Problem Statement

To avoid Docker Desktop's file-sharing dialogs on the Hyper-V Docker backend, the proxy stack stopped bind-mounting its configuration (ADR 0029). Each color bring-up now removes the old container, creates a new one, runs four `docker cp` calls through a temporary staging folder that filters the CA directory, and then starts it. That is seven Docker CLI calls where there used to be one `compose up`. They run at every `run-hosting` start, credential refresh, and policy-reload swap.

Running Docker Desktop on the Hyper-V backend turned out to cause problems for other applications on the host, so it is no longer a target. Only the WSL 2 backend is supported. On that backend bind mounts never prompt, so the copy path is cost and complexity with nothing in return.

The copy path also delivered one benefit that is worth keeping: it kept the root CA private key out of the internet-facing Envoy container. With a plain revert, the key would be visible inside the container again, because it lives in the CA directory that gets mounted. That key can sign certificates for any host a guest trusts.

## Solution

Envoy colors go back to bind-mounting the environment's proxy configuration, read-only, and a color is brought up with a single force-recreating `compose up`. The root CA private key moves out of the proxy directory into a private directory of its own in the environment, so nothing mounted into a container contains it.

`generate-ca` moves a key it finds at the old location to the new one. `run-hosting` never moves it. If it finds a key only at the old location, it stops and tells the user to run `generate-ca`.

The parts of the earlier work that don't depend on the Docker backend stay as they are:
- the `susentorno.environment` ownership label and `verify-proxy.ps1`'s label-based ownership check
- SDS sources without watched directories
- `write-github-config`'s notice to restart `run-hosting`

The WSL 2 Docker backend is documented as the supported Docker Desktop backend.

## User Stories

1. As a susentorno user, I want each proxy color to come up with a single Docker Compose call, so that starting `run-hosting` is as fast as before the copy change.
2. As a susentorno user, I want credential refreshes and policy-reload swaps to bring up the next color without the extra copy work, so that swaps finish sooner.
3. As a susentorno user, I want the root CA private key never to be visible inside an Envoy container, so that compromising Envoy doesn't expose a key that can impersonate any terminated destination.
4. As a susentorno user, I want the root CA private key kept outside every directory the proxy stack mounts, so that a later change to the mounts can't expose it by accident.
5. As a susentorno user, I want the root CA private key kept outside the VM-shared directories, so that a guest can never read it.
6. As a susentorno user, I want the root CA private key excluded from source control by the environment's `.gitignore`, as it is today, so that committing my `.susentorno` folder never publishes it.
7. As a susentorno user creating a new environment, I want `generate-ca` to write the root CA private key to its new location, so that a fresh environment never has a key in the mounted CA directory.
8. As a susentorno user upgrading an existing environment, I want `generate-ca` to move my existing root CA private key to the new location unchanged, so that guests that already trust my root CA keep working without reinstalling a certificate.
9. As a susentorno user upgrading an existing environment, I want `generate-ca` to report that it moved the key, so that I know my environment changed.
10. As a susentorno user upgrading an existing environment, I want `generate-ca` to keep reusing my root CA after moving the key, and to reissue the leaf only when its usual rules call for it, so that the move changes nothing else.
11. As a susentorno user whose environment somehow has a root CA private key at both the old and new locations, I want `generate-ca` to stop and name both paths without changing either, so that it never picks the wrong key or destroys one silently.
12. As a susentorno user upgrading an existing environment, I want `run-hosting` to tell me to run `generate-ca` when it finds the root CA private key only at the old location, so that I know the one step that fixes it.
13. As a susentorno user upgrading an existing environment, I want `run-hosting` never to start a proxy stack while the root CA private key is still in the mounted CA directory, so that an upgrade can't quietly mount the key into Envoy.
14. As a susentorno user with no root CA at all, I want `run-hosting` to keep telling me to run `generate-ca`, so that the first-run experience is unchanged.
15. As a susentorno user, I want `generate-ca`'s existing safety rules to keep applying at the new location: it fails when only one of the certificate and key exists, fails when they don't form a valid pair, and never overwrites existing key material. That way moving the key doesn't weaken them.
16. As a susentorno user, I want `generate-ca`'s description to name where the root CA certificate and key are written, so that I can find them.
17. As a susentorno user, I want leaf reissues during `run-hosting` to keep signing with the root CA private key from its new location, so that adding a terminated host still works.
18. As a susentorno user, I want the leaf certificate and key and the upstream trust bundle to keep reaching Envoy through the mounted CA directory, so that TLS termination and upstream validation keep working.
19. As a susentorno user, I want the Envoy config, the Lua gate, and the secrets directory to reach Envoy through read-only mounts, so that a container can't modify the host's configuration.
20. As a susentorno user, I want edits to my allow list, auth list, or block list to keep reaching the proxy stack through the policy-reload swap, so that changing policy works as it does today.
21. As a susentorno user, I want automatic host credential refreshes to keep reaching the proxy stack without dropped connections, so that guests keep working through credential rotations.
22. As a susentorno user, I want the Codex host credential and account id to keep reaching the proxy stack after each refresh, so that Codex keeps working in the guest.
23. As a susentorno user, I want host-run MCP server routing to keep working, so that guests keep their host-credentialed tool access.
24. As a susentorno user, I want the proxy stack to come back after a Docker Desktop restart with its configuration, so that a Docker restart doesn't leave Envoy without its config.
25. As a susentorno user, I want a failed color bring-up to leave the current color serving, so that a bad bring-up behaves as it does today.
26. As a susentorno user, I want `verify-proxy.ps1` to keep proving that the running Envoy belongs to my environment through its environment label, so that I don't validate the wrong environment's proxy.
27. As a susentorno user who upgrades while a proxy stack started by the copy-based version is still running, I want the next bring-up to replace those containers with mount-based ones, so that I don't need a manual migration step for the containers.
28. As a susentorno user on Windows, I want the documentation to say that Docker Desktop must use the WSL 2 backend, so that I don't set it up in a way that prompts for file sharing or disturbs other applications.
29. As a developer, I want `pnpm check` to run the `proxy-stack` and `guest` tiers with the WSL 2 Docker backend and no file-sharing dialogs, so that the suite runs unattended.
30. As a maintainer, I want the bring-up code to have no copy step or staging folder, so that there is less to maintain.
31. As a maintainer, I want an automated check that no running Envoy container has the root CA private key at its CA path, so that a regression in the mounts or the key location is caught by tests.
32. As a maintainer, I want the reasoning recorded in an ADR that supersedes ADR 0029, with ADR 0012 updated to match, so that nobody reintroduces copying, or puts the key back in the mounted directory, without knowing why.

## Implementation Decisions

- **Root CA key location.** The environment's path for the root CA private key moves from the proxy CA directory to `.susentorno/ca-private/key.pem`, a directory of its own beside `proxy/`. The root CA certificate, the leaf certificate and key, and the upstream trust bundle stay in the proxy CA directory. The environment's ignore-everything-by-default `.gitignore` already covers the new directory, so the template doesn't change. The environment-paths module gains a path for the old key location so that `generate-ca` and `run-hosting` can find it.
- **`generate-ca` owns the move.** Before its existing checks, `generate-ca` looks at both key locations:
  - Key only at the old location: create the private directory, move the file there byte-for-byte, and say so in its output. Then continue as today, which reuses the root CA.
  - Keys at both locations: fail with an error naming both paths, change neither, and set a failing exit code.
  - Key only at the new location, or at neither: behave as today.

  After the move, the existing certificate/key pairing, validation, and never-overwrite rules apply unchanged. It never writes a key to the old location. Its command description names where the certificate and key are written.
- **`run-hosting` detects but never moves.** Its existing startup check that the root CA is present keeps checking the certificate and the key at the new location. If the key is missing there but present at the old location, it fails before doing any Docker or network work, with an error telling the user to run `generate-ca` to move the key. When there is no key at either location, it keeps its existing message. Leaf reissues read the key from the new location.
- **Color bring-up goes back to one force-recreating `compose up`.** The bring-up function removes the copy step, the CA staging folder, and the separate remove/create/start sequence. Its signature and its contract with the run-hosting loop don't change: it still takes the environment directory, which feeds the ownership label; it resolves once the color is started; and it rejects on failure. Stopping a color is unchanged.
- **Compose template.** The shared Envoy definition bind-mounts the rendered Envoy config, the Lua gate, the CA directory, and the secrets directory, each read-only, at the same container paths the copy path used. It keeps the `susentorno.environment` label, image, restart policy, host-gateway mapping, command, and per-color published ports.
- **Kept from the copy-based work, unchanged:**
  - the ownership label and `verify-proxy.ps1`'s label-based ownership check (a missing label, inspect failure, or mismatch still fails closed)
  - SDS sources without watched directories
  - `write-github-config`'s restart notice

  Comments that describe bind mounts as gone, or that describe the copy step, are updated.
- **Docker backend.** susentorno still doesn't detect the Docker backend or touch Docker Desktop's settings. The WSL 2 backend is a documented requirement, not a checked one.
- **Docs and ADRs:**
  - A new ADR records the move back to read-only bind mounts, the WSL 2 backend requirement, and the root CA key living outside every mounted directory. Its considered options include keeping the copy path, rejected for its per-bring-up cost and complexity.
  - ADR 0029 is marked superseded by it.
  - ADR 0012's reference to configuration by copy is reworded so its rejection of hot-reload doesn't depend on how configuration reaches the container.
  - The host prerequisites in `README.md` and the Docker Desktop prerequisite in `development.md` state that Docker Desktop must use the WSL 2 backend.
  - `CONTEXT.md` is unchanged.

## Testing Decisions

- Good tests here observe external behavior: what a CLI command writes, prints, and exits with; what Docker reports about running containers; and what the proxy stack serves. They don't assert the Docker commands bring-up issues or how the key file is moved.
- **`cli` tier, `generate-ca` (main seam).** Through the real built CLI, building on the existing `generate-ca` CLI tests:
  - A fresh environment gets the key in the private directory and no key file in the proxy CA directory.
  - An environment with the key only at the old location ends with the identical key at the new location and none at the old one, reports the move, keeps the root CA certificate unchanged, and keeps the leaf when it is still valid.
  - With keys at both locations, it fails, names both paths, and leaves both files unchanged.
  - The existing tests (one-of-pair failure, invalid pair, never overwriting, reuse) are updated to the new key path and keep passing.
- **`cli` tier, `run-hosting` early exit.** Through the real built CLI, in an environment whose key exists only at the old location, `run-hosting` exits with a failing code and an error that names `generate-ca`, before any Docker work. Prior art: the existing CLI tests that exercise a command's argument and environment checks without live infrastructure.
- **`proxy-stack` tier.** The shared container assertions keep checking that each running Envoy carries the environment label for this test environment, has the leaf certificate, leaf key, and upstream trust bundle at its CA path, and has no root CA private key there. This runs after the first bring-up and after a policy-reload swap. The "no mounts" assertion is removed. The other proxy-stack tests must keep passing unchanged; they show that the mounted configuration is complete:
  - lifecycle, policy reload, injection, allow-list enforcement
  - upstream validation, MCP server, robustness, serving-state detection
- **`unit` tier:**
  - The environment-paths test expects the new key path and the old-location path.
  - The template tests change from "declares no volumes" to checking that the four configuration paths are mounted read-only and that the CA mount source is the proxy CA directory. The ownership-label and `verify-proxy.ps1` label checks stay.
  - The proxy-stack supervisor's unit tests mock bring-up and need no changes.
- **Manual validation, once done:** on a host with Docker Desktop on the WSL 2 backend, run `pnpm check` and confirm no file-sharing dialog appears. In an existing environment created before this change, run `generate-ca`, confirm the key moved and the guest still trusts the root CA, then run `run-hosting`.

## Out of Scope

- Supporting Docker Desktop's Hyper-V backend, or detecting which backend is in use.
- Hot-reloading secrets or policy without a color swap.
- Making `run-hosting` move the key itself.
- Protecting host secrets at rest, such as encrypting the root CA key with DPAPI or storing it in a per-user location outside the environment.
- Moving the root CA certificate, leaf material, or upstream trust bundle out of the proxy CA directory.
- Cleaning up Docker Desktop file-sharing entries left by the earlier Hyper-V-backend work.
- Running more than one environment at once; container names are still fixed.

## Further Notes

- This partly reverses `docs/matt-pocock/proxy-config-by-copy/` (ADR 0029). Only the bring-up mechanism and the compose mounts go back. The ownership label, the SDS watched-directory removal, the `write-github-config` restart notice, and the guarantee that the root CA key never enters Envoy all stay.
- Bind mounts let a running container see host writes to its configuration, but the blue/green swap (ADR 0012) stays the only supported way a change reaches Envoy. That was also how it worked before ADR 0029. Every writer already triggers, or tells the user to trigger, a fresh color.
- See ADR 0012 (blue/green container swap for restarts), ADR 0029 (to be superseded), and the new ADR this spec calls for.
