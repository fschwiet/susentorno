# DNS responder: build off the read-only share

## Problem

`07-setup-network.ps1` publishes the shipped C# DNS responder inside the guest VM:

```powershell
dotnet publish (Join-Path $scriptDir 'dns-responder') -c Release -o $installDir
```

`dotnet publish` writes intermediate build outputs (`obj/`, and a `bin/` unless fully
redirected) **into the project source folder**. Inside the VM that folder is the VMware
shared folder mounted **read-only** (`\\vmware-host\Shared Folders\vm-shared-windows`),
so the build cannot write there and fails.

Three related issues stem from this:

1. **Read-only build (VM runtime):** publish needs a writable location for `obj/`; the
   source directory is read-only.
2. **Template pollution:** `initEnv.ts` copies the templates with
   `cpSync(..., { recursive: true })`, which pulls stale local build artifacts
   (`dns-responder/bin`, `dns-responder/obj`) into `.configamatron/vm-shared-windows`
   and thus onto the share. Git ignores `bin`, but `cpSync` copies straight off disk and
   ignores gitignore.
3. **Local testing:** building or running the project locally (how those `bin`/`obj`
   folders appear) regenerates them in the source directory every time.

The VM installs .NET SDK 10 (`01-install-packages.ps1`), so building in the guest is
viable — the "ship source, build in guest" architecture is sound; it only needs a
writable build location.

## Approach

Keep building in the guest, but build from a writable copy of the source, and stop
copying build artifacts into the environment in the first place.

### 1. `07-setup-network.ps1` — build from a writable scratch copy

- Introduce a writable scratch/build directory:
  `C:\ProgramData\configamatron\dns-responder-build`.
- Copy the `dns-responder` source from the read-only share into that build directory.
  The copy excludes any `bin`/`obj` that might exist on the share (defense in depth;
  after fix #2 they will not be there anyway).
- Run `dotnet publish` from the build directory into the existing install directory:
  - Build source: `C:\ProgramData\configamatron\dns-responder-build`
  - Publish output (`-o`): `C:\ProgramData\configamatron\dns-responder` (unchanged)
- All `obj`/`bin` intermediates land in the writable build directory; nothing writes to
  the read-only share.

Unchanged and still required:

- The install dir `C:\ProgramData\configamatron\dns-responder` remains the stable
  location the scheduled task runs from and where `responder-config.txt` is written.
- The existing "stop the running task before publishing" logic (Windows locks the
  running exe) stays — publish still overwrites the exe in the install dir.

The scratch directory should be cleared/refreshed on each run so a rerun starts from the
shipped source, not a stale copy.

### 2. `initEnv.ts` — do not copy `bin`/`obj`

Give the `vm-shared-windows` `cpSync` call a `filter` that rejects any path segment named
`bin` or `obj` under `dns-responder` (keep everything else, including `Program.cs` and
`ConfigamatronDnsResponder.csproj`). This keeps stale build artifacts off the share
regardless of what a developer built locally.

## Paths

| Purpose | Path | Status |
| --- | --- | --- |
| Read-only source on share (VM) | `\\vmware-host\Shared Folders\vm-shared-windows\dns-responder` | unchanged |
| Writable build/scratch dir (VM) | `C:\ProgramData\configamatron\dns-responder-build` | new |
| Install/publish output (VM) | `C:\ProgramData\configamatron\dns-responder` | unchanged |

## Testing

Existing constraints that must continue to hold:

- `templates.test.ts` / `initEnv.test.ts` require `dns-responder/Program.cs` and
  `ConfigamatronDnsResponder.csproj` to exist and be copied — the `cpSync` filter must
  keep source files and only drop `bin`/`obj`.
- `templates.test.ts` greps `07-setup-network.ps1` for `Register-ScheduledTask`,
  `ConfigamatronDnsResponder`, `responder-config.txt`, `Set-DnsClientServerAddress`, and
  `'127.0.0.1'` — all preserved by the edits.

New coverage:

- Add an assertion (in `initEnv.test.ts`) that after `initEnvironment`, the copied
  `vm-shared-windows/dns-responder/bin` and `.../obj` directories are **absent** — locks
  in the pollution fix so it cannot silently regress.

The Windows 07 flow itself has no execution test (the `tests/vm` e2e harness is
Linux-only), so the guest-internal scratch path is validated by inspection, not by an
automated run.

## Out of scope

- Prebuilding the responder on the host (would add a dotnet SDK dependency to host init).
- Redirecting dotnet output paths in place via `--artifacts-path` (fragile across SDK
  versions with a read-only source).
