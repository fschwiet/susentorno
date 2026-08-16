# Publish Envoy on loopback only; reach it from the guest via a Node forwarder

Docker publishes Envoy on `127.0.0.1` only, and `run-hosting` runs a byte-transparent Node TCP forwarder on the guest-facing (Hyper-V Internal-switch) adapter IP that pipes `:80`/`:443` to loopback. This exists because Docker Desktop's WSL2-backend published-port relay accepts connections arriving on the external (Internal-switch) interface slowly and unreliably — delayed/dropped SYN-ACKs, multi-second connects — while loopback connections to the same ports are instant (confirmed by elimination against the real host).

## Considered Options

- **`netsh portproxy` / IP Helper.** Rejected: adds a Windows service dependency and a reboot-persistent listener that can dangle at a dead Docker; its performance was never validated, and persistence buys little since a working proxy already requires `run-hosting`.
- **WSL2 mirrored networking.** Rejected: couples to a Docker-Desktop-internal detail and is a global machine-wide change that can't live in per-environment templates.

## Consequences

- Forwarding is active only while `run-hosting` runs — acceptable, since token freshness already requires that.
- The forwarder is byte-transparent (no HTTP/TLS awareness), so it serves all three Envoy modes identically, and it later became the stable front door the blue/green swap flips between ([[blue-green-container-swap-for-restarts]]).
- The forwarder has real automated coverage as of [[guest-layer-tested-against-real-hyperv]]: the guest tier binds the Internal-switch adapter and a real Ubuntu guest reaches Envoy through it.
