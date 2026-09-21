# Windows guest transport: PowerShell Direct or SSH

Type: grilling
Status: open
Blocked by: —

## Question

How does a production `setup-guest-windows` command reach into the guest to run its pre-scripts,
isolate it, and run its post-scripts?

This is the load-bearing ticket of the Windows group: tickets 04, 05 and 10 hang off it.

Two established positions in this repo disagree in spirit, and the resolution has to pick one:

- `src/guestSetup/remoteExec.ts` defines `RemoteExec` as an explicitly injectable seam — "Production
  wires this to real ssh/scp; tests/guest/ wires it to the existing QEMU-guest harness; unit tests
  wire it to an in-memory fake." A Windows arm slotting in here would let `mountShare`,
  `runPreScripts` and `runPostScripts` serve both platforms unchanged.
- `tests/guest/windowsGuestExec.ts` says the opposite about its own Windows exec: it is "the Windows
  sibling of guestExec.ts, sharing nothing with it deliberately: a common abstraction over
  `bash -ic` and `Invoke-Command -VMName` would be a worse module than two honest ones."

What the choice decides beyond module shape — this is why it is worth its own ticket:

- **Which guest prerequisites the documentation must demand.** SSH requires `openssh-server` in the
  guest plus, for an unattended run, key-based auth. PowerShell Direct requires neither; it runs over
  the VMBus and needs only a guest credential. The two worst paragraphs of today's `setup-guest.md`
  — SSH key setup and the ~20 sudo prompts — have no Windows counterpart under PowerShell Direct.
- **What the command prompts for.** SSH needs a guest address; PowerShell Direct needs a VM name
  (already prompted) plus a guest username and password. `tests/guest/windowsGuestExec.ts` notes the
  guest's address becomes "something this role asks about, not a precondition for asking anything."
- **Whether a failure is diagnosable.** [ADR 0027](../../../adr/0027-windows-guest-tested-over-powershell-direct.md)
  chose PowerShell Direct for the test tier because Windows Setup writes nothing to serial, so an
  in-band transport makes a DHCP failure a black box. That argument was made about the harness, but
  it applies at least as strongly to a user hitting a failure with no console access.
- **Whether elevation can be assumed.** PowerShell Direct does not inherit the host's elevation; it
  runs with the supplied guest credential. `04-configure-network.ps1` declares
  `#Requires -RunAsAdministrator`, which the harness checks rather than assumes.

A resolution must state: the transport, whether it reuses the `RemoteExec` interface or gets its own,
what the command prompts for and what flags suppress those prompts, and how the elevation
requirement is verified.
