# The guest layer is tested against real Hyper-V VMs

The guest tier boots real Hyper-V virtual machines on a real Internal switch, served by the real `run-hosting`, and asserts from inside them. It replaces the QEMU-in-WSL2 harness [[vm-tests-via-qemu-in-wsl2]], which supplied `dnsmasq` and `socat` in place of the production DNS responder, DHCP server, and gateway forwarder. The only remaining substitution is `gh`, shadowed at `/usr/local/bin/gh` so `post-scripts/01-auth-config.sh` does not need a real GitHub token.

The claim is: **a real Ubuntu guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, reaches exactly the destinations the network policy permits and nothing else.**

The tier is bootstrappable from clean: it builds an Ubuntu golden image from `ubuntu-26.04-live-server-amd64.iso` with an unattended autoinstall, its own host network via `create-host-network --isolation-name test`, and its own SMB share and local account. Per-test guests boot from differencing disks off that parent, so no test can see another's writes. Everything derives from the `test` isolation name and is swept by name at startup and teardown.

Fidelity over portability is accepted. This tier runs only on a Windows host with Hyper-V, the platform susentorno targets ([[hyper-v-only-target]]).

## Status

accepted (2026-08-15). Supersedes [[vm-tests-via-qemu-in-wsl2]].

## Considered Options

- **Port the old harness to Hyper-V while keeping `dnsmasq` and `socat`.** Rejected: it would pay the cost of a host-state-touching tier without testing the production network services.
- **A manually-built golden VM plus checkpoints.** Rejected: it is not bootstrappable from source.
- **Convert a cloud image or use `qemu-img`.** Rejected: Ubuntu publishes no suitable 26.04 VHD/VHDX, and a new conversion dependency would retain the cloud-image-versus-installer fidelity gap.
- **Repack the ISO with a Node ISO-writing library.** Rejected: the harness writes the supported UEFI installer media directly using Windows built-ins.
- **Split `e2e` out of the default tier.** Rejected: `setup-guest-unix` itself would become the one wiring path that routine verification does not exercise.

## Consequences

- [[loopback-publish-with-node-forwarder]]'s forwarder and [[host-side-dns-and-dhcp]]'s DNS and DHCP servers gain real guest coverage. `startProxyStack` forwards on the test Internal-switch address instead of disabling forwarding.
- The guest tier binds the real `:80`/`:443`, so it rejects even one occupied gateway port before creating host state. A live `run-hosting` remains incompatible because the Envoy container names are global.
- The isolation name also derives test guest VMs, differencing disks, SMB share, and local account. The shipped default account is `susentorno`; an isolated installation uses `susentorno-<name>` explicitly.
- `pnpm test` no longer needs WSL2, KVM, nested virtualization, mirrored networking, or `ignoredPorts=67`. It requires an elevated shell, Hyper-V, Docker, and an `ssh-agent` holding the harness key.
- A warm tier takes roughly 15–25 minutes; a cold golden-image build adds roughly 20–30 minutes. `.image-cache/` is gitignored and repo-local because live tiers cannot safely run in parallel worktrees.
- `ssh-agent` is load-bearing for the e2e test's production bare SSH client. A broad user `IdentitiesOnly yes` SSH configuration can still defeat agent discovery.
