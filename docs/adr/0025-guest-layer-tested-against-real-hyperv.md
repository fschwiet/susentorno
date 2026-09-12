# The guest layer is tested against real Hyper-V VMs

The guest tier boots disposable Hyper-V virtual machines on a real Internal switch served by the real `run-hosting`, then asserts behavior from inside the guests. This supersedes the QEMU-in-WSL2 harness ([[vm-tests-via-qemu-in-wsl2]]) so DNS, DHCP, gateway forwarding, firewall confinement, VM switching, and guest setup run through the production Windows/Hyper-V path rather than harness substitutes.

The Ubuntu harness builds its golden image from the Ubuntu installer and creates a differencing disk per guest role. Its sole command substitution is `gh`, shadowed so the shipped authentication post-script needs no real GitHub credential. The Windows role and its deliberate harness substitutions are recorded separately in [[windows-guest-tested-over-powershell-direct]].

Per-run host state and guest roles derive from the `test` isolation name: host network, share account, SMB share, guest VMs, differencing disks, and artifact locations. Startup and teardown sweep that live state, while each role's differencing disk prevents writes from leaking between tests. Golden images remain in the separate cache. Fidelity to the supported platform is preferred over portability.

## Considered Options

- **Keep QEMU inside WSL2.** Rejected because its own DNS, DHCP, and forwarding services could not verify the production host services or Hyper-V switching behavior.
- **Use a manually prepared Ubuntu golden VM or cloud-image conversion.** Rejected because the Ubuntu image must be defined and bootstrappable from repository-controlled installer inputs without a new conversion dependency.
- **Split end-to-end scenarios out of the guest tier.** Rejected because behavior observed from inside a disposable guest belongs in that tier even when it crosses the CLI and proxy stack.

## Consequences

- The default pipeline requires an elevated Windows host with Hyper-V, Docker, and an `ssh-agent`; it no longer requires WSL2, KVM, mirrored networking, or port-sharing exceptions.
- The guest tier binds the real gateway ports and shares the global Envoy container names, so it refuses to run alongside a live `run-hosting`.
- Golden images are cached in repository-local `.image-cache/`; live tiers and their shared host state cannot run safely in parallel worktrees.
- Ubuntu guests use SSH for the production setup path, making the harness key and the invoking SSH client's configuration part of the test prerequisites.
