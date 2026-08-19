# The Windows guest layer is tested against a real Hyper-V guest over PowerShell Direct

The `guest` tier gains a `windowsFresh` role: a real Windows 11 guest, booted from a differencing disk off a self-built golden image, on the real `susentorno-test-internal` switch, served by the real `run-hosting`.

The claim is: **a real Windows guest, on a real Hyper-V Internal switch, served by the real `run-hosting`, takes its entire network configuration from the host and reaches exactly the destinations the network policy permits and nothing else.**

The harness reaches the guest over **PowerShell Direct**, not SSH. The Ubuntu roles reach their guests across the network under test, which is survivable only because the serial console keeps logging when that network fails; Windows Setup writes nothing to serial, so an in-band transport would make a DHCP failure a black box. PowerShell Direct runs over the VMBus and is unaffected. It also deletes the OpenSSH server, harness keypair, `known_hosts`, and reachability-probe machinery the Ubuntu path needs, and there is no fidelity argument for SSH here because no automated Windows setup path exists to mirror.

Unlike the Ubuntu pipeline, this one is **not bootstrappable from clean**. The Windows Enterprise evaluation sits behind a registration form yielding a short-lived signed URL, so `SUSENTORNO_WINDOWS_ISO` names a locally-supplied ISO and the role self-skips when it is unset. Windows Update runs during the build, which means the image is a function of the calendar and no rebuild is byte-reproducible — a patched baseline was judged worth more than a reproducible one for a guest whose job is to reach the network. The stamp therefore records per-input digests plus a build date, and refuses an image older than 60 days so a time-limited evaluation cannot stay stamp-valid past expiry.

The build ships **no vTPM**. Automatic device encryption requires a TPM; with none present it cannot engage, so it cannot seal the golden volume to the build VM's protector and strand every differencing child behind a recovery prompt. Secure Boot is independent and stays on for role VMs with the `MicrosoftWindows` template. This diverges from `setup-guest.md`, which has real users enable a vTPM; the divergence is accepted because nothing in this role's test surface is TPM-dependent.

## Status

accepted (2026-08-18)

## Considered Options

- **Copy the ISO tree onto a FAT32 installer VHDX, as the Ubuntu build does.** Rejected on a hard fact: `sources/install.wim` is 5.80 GB against FAT32's 4 GiB per-file limit. The Ubuntu build only copies because it must edit `grub.cfg`; Windows requires no media edit, so the ISO is attached unmodified with `autounattend.xml` on a second one-file ISO built by the built-in `IMAPI2FS` component.
- **The pre-built dev VHDX from `aka.ms/windev_VM_hyperv`.** Rejected: no published checksum, a hard expiry, and preloaded with Visual Studio — the cloud-image-versus-installer fidelity gap [[guest-layer-tested-against-real-hyperv]] rejected for Ubuntu.
- **A hand-built golden VHDX.** Rejected: it discards the property the stamp depends on — that the image is defined by the repo — and keeps only unattended acquisition, which matters least.
- **OpenSSH Server in the guest.** Rejected: in-band with the network under test, with no serial fallback.
- **Stubbing `git`**, mirroring [[guest-layer-tested-against-real-hyperv]]'s `gh`. Rejected: it buys tidiness by deleting the assertion with the most to say about the network boundary.
- **A separate `guest-windows` tier.** Rejected by `testing.md`'s placement rule — the observable surface is still behaviour observed inside a disposable guest.
- **A Windows arm of `propagateAmbientTrust` in `src/`.** Rejected: it would ship a product feature with no caller until a `setup-guest-windows` command exists. The guest-side installer lives in the harness; the host-side enumerator is production code.

## Consequences

- Two substitutions, both named: Git is preinstalled in the golden image rather than arriving from `01-install-packages.ps1` (pre-scripts run pre-isolation, so winget has never run through the proxy in production), and the guest-side ambient-root installer is harness code.
- Ambient trust propagation is **required**, not optional flake-proofing: susentorno is developed from inside a susentorno guest, and `current-auth-list.txt` terminates `github.com:443`, so the `git ls-remote` assertion fails without it.
- Revocation checking is waived on susentorno-issued leaves — `src/ca.ts` emits no CRL or OCSP endpoint and Schannel fails closed on unknown status. Chain validation stays active.
- Windows Setup diagnostics are framebuffer thumbnails at roughly 320×240: state classification, not readable text. Offline `Panther\setupact.log` salvage is the named escalation.
- `.image-cache/` grows by roughly 50–60 GB. A cold build takes 60–120 minutes, longer under nested virtualisation.
- This discharges [[shipped-guest-templates-carry-only-requirements]]'s deferred Windows exception. Both platforms now weave `nn-configure-network` out as `04-`.
