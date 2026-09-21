# Windows share mount and credential mechanics across the isolation boundary

Type: grilling
Status: open
Blocked by: 01

## Question

How does `setup-guest-windows` mount the VM share, and how does it re-mount after isolation moves
the guest to a different host IP?

The Ubuntu path is settled and automated: `src/guestSetup/mountShare.ts` plus
`src/guestSetup/fstabLine.ts` write `/etc/susentorno-share.cred` (mode 600, root-only) and an
`/etc/fstab` line with `credentials=`, `_netdev`, `x-systemd.automount`. `setup-guest.md` also
records the failure mode: if the share was already mounted against a different host IP, `mount -a`
alone will not notice, so an unmount must come first.

The Windows path is entirely manual today, and its credential model differs in a way that matters:

```powershell
cmdkey /add:192.168.67.1 /user:susentorno /pass:<the password from setup-environment.md>
```

`setup-guest.md` notes that **`cmdkey` entries are per-address**, so a guest that mounts the share
during the setup phase needs one entry for the Default-Switch host IP and another for the
Internal-switch host IP. That is the Windows analogue of the Ubuntu re-mount problem, and it is
worse: two credential entries rather than one file rewritten.

Four distinct addresses are in play across a guest setup, as `setup-guest.md` enumerates: the
guest's DHCP lease on the Default Switch, its different lease on the Internal switch, the host's
address on the Default Switch, and the host's address on the Internal switch.

A resolution must state:

- Whether credentials go in via `cmdkey`, `net use` with inline credentials, or a `New-SmbMapping` —
  and whether both host addresses are registered up front or the setup-phase entry is cleaned up.
- Whether the share is mounted as a drive letter or accessed by UNC path. Today's docs `cd` to a UNC
  path directly (`cd "\\<host-ip>\vm-shared-windows\"`).
- What happens on rerun against an already-configured guest — the idempotency contract, matching the
  Ubuntu path's "rerunning executes all steps from the top" guarantee.
- Whether `Set-ExecutionPolicy Bypass` / `Set-ExecutionPolicy RemoteSigned` stay in the flow, given
  that under PowerShell Direct the transport supplies its own script block rather than invoking
  `.ps1` files from a share. Today's doc has the user set Bypass at the start and restore
  RemoteSigned at the end, which is a footgun if a run fails in between.
- Whether the shipped pre-scripts and post-scripts are invoked from the share by path or streamed
  over the transport — which depends on ticket 01.
