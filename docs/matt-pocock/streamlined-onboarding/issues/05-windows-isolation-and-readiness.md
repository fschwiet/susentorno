# Windows isolation, reboot, and readiness — the KVP-daemon and reachability-wait equivalent

Type: grilling
Status: open
Blocked by: 01

## Question

How does `setup-guest-windows` move the guest onto the Internal switch and decide the guest is ready
to continue?

The Ubuntu path solves this with three pieces of machinery that a Windows guest may not need at all:

- **`src/guestSetup/kvpDaemon.ts`** installs `linux-cloud-tools-virtual` so
  `Get-VMNetworkAdapter`'s reported IP addresses work at all. `setup-guest.md` records that its
  `hv-kvp-daemon.service` only comes up after the guest has rebooted since install. Windows ships
  Hyper-V integration services in-box, so this step likely has no counterpart — worth confirming
  rather than assuming.
- **`src/guestSetup/reachabilityWait.ts`** plus `src/guestSetup/tcpConnect.ts` wait for the guest's
  SSH port to answer at its new address. Under PowerShell Direct there is no address to wait on and
  no port to probe; `tests/guest/windowsGuestExec.ts` replaces it with `waitForPowerShellDirect`,
  which just retries a trivial script until it answers, on the grounds that the guest's address is
  "something this role asks about, not a precondition for asking anything."
- **`src/guestSetup/vmReconcile.ts`** performs the `Stop-VM` / `Connect-VMNetworkAdapter` /
  `Start-VM` sequence. This part is platform-agnostic — it acts on the Hyper-V object, not on the
  guest OS — so it is the piece most likely to be reused unchanged.

The DHCP-lease timing also differs by platform and is already measured in `setup-guest.md`: a
Windows guest with no lease falls back to a `169.254.x.x` APIPA address and re-attempts on roughly a
five-minute cycle (measured 4m55s), whereas Ubuntu has no APIPA fallback and retries every 45s for
three minutes before going quiet for about five. A readiness wait has to be sized against the
Windows figure, not the Ubuntu one.

A resolution must state: whether the KVP step is needed, what the readiness signal is and its
timeout, how much of `vmReconcile.ts` is reused, and what the user sees while waiting — a run that
can legitimately sit silent for five minutes needs progress output, or it reads as a hang.

It may also sharpen the fog entry about the rerun round-trip: `setup-guest-unix` deliberately
reattaches an already-isolated guest to the Default Switch on every rerun, as the recovery path. If
the Windows transport needs no network to reach the guest, that round-trip may be unnecessary here —
if so, say whether that asymmetry is acceptable or whether both platforms should converge.
