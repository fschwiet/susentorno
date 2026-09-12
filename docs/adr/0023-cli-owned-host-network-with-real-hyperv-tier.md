# Host network setup is CLI-owned and tested against real Hyper-V

The **host network**—its Internal switch, host IP assignment, and inbound firewall rules—is created and removed by the host-level `susentorno create-host-network` and `susentorno delete-host-network` commands. Both require elevation. Creation refuses to replace an existing switch but safely refreshes its firewall rules; deletion independently sweeps matching adapter and share rules before removing the switch, making it both an undo operation and recovery from partial host state.

The default host-network objects use the `susentorno` name. `--isolation-name <name>` derives a parallel switch, adapter, and firewall-rule prefix; `run-hosting`, host-network commands, and guest setup resolve the switch and adapter through the same rule. This lets automated tests use `susentorno-test` without touching the unnamed default environment.

The dedicated `host-network` test tier exercises these commands against real Hyper-V and Windows Firewall state. It remains separate from `cli` because only this surface requires an elevated Hyper-V host, and separate from `guest` because it verifies host orchestration without booting a guest. The guest tier independently verifies the resulting network path with real Hyper-V VMs ([[guest-layer-tested-against-real-hyperv]]).

## Considered Options

- **Leave switch and firewall setup as manual instructions.** Rejected because isolation names make this host state safely testable without touching a developer's default objects.
- **Put the tests in the ordinary CLI tier.** Rejected because unrelated packaged-CLI tests should not require elevation and Hyper-V.
- **Keep the real-host tier out of `pnpm test`.** Rejected because routine verification should exercise the security boundary's creation rather than leave it opt-in.

## Consequences

- Host-network creation is a machine-level prerequisite rather than a per-environment templated script.
- The `host-network` tier is part of the default pipeline, fails fast when its elevation prerequisite is absent, and does not require Docker.
- In the guest tier, the same isolation name also derives VM, differencing-disk, account, and share identities, allowing its live test artifacts to be swept by name.
