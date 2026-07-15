# Use jq for JSON writes in VM provisioning scripts

**Date:** 2026-07-15
**Status:** Approved design

## Problem

Several provisioning scripts under `templates/vm-shared/` (Ubuntu) and
`templates/vm-shared-windows/` (Windows) write JSON config files. Each site
currently rolls its own JSON manipulation:

- Ubuntu uses inline `python3` heredocs.
- Windows uses `ConvertFrom-Json` / `ConvertTo-Json`.

`jq` is now available on both VMs (Windows installs `jqlang.jq` in
`01-install-packages.ps1`; Ubuntu will get it — see prerequisite below). We want
JSON writes to go through `jq` for one consistent tool across both platforms.

## Scope

Convert all five JSON-writing sites:

| # | Script | File written | Current tool | Operation |
|---|--------|--------------|--------------|-----------|
| 1 | `vm-shared/08-claude-config.sh` | `~/.claude.json` | python3 | set one key |
| 2 | `vm-shared/04-configure-tools.sh` | VS Code `settings.json` | python3 | set four keys |
| 3 | `vm-shared/06-trust-ca.sh` | Firefox `policies.json` (sudo) | python3 | array: drop stale path, ensure CA present once |
| 4 | `vm-shared-windows/08-claude-config.ps1` | `.claude.json` | ConvertFrom/To-Json | set one key |
| 5 | `vm-shared-windows/04-configure-tools.ps1` | VS Code `settings.json` | ConvertFrom/To-Json | set four keys |

Out of scope: the credential copy/symlink steps in the two `08` scripts (not
JSON edits); every other script.

## Prerequisite

Add `jq` to the `apt install` line in `vm-shared/01-apt-packages.sh`. jq was
observed already present on the current Ubuntu image, but adding it explicitly
keeps provisioning correct on any base image. Windows already installs it.

## Approach

Per-site inline jq. Each script keeps its own small merge block, matching the
existing convention that every `NN-*` script runs standalone and idempotently. A
shared helper was rejected: it couples deliberately-independent scripts, and the
Firefox array case needs a custom filter anyway, so a generic helper would cover
only 4 of 5 sites.

### Ubuntu idiom (bash)

Replaces each python3 heredoc:

```bash
base=$(jq . "$file" 2>/dev/null || echo '{}')   # missing OR unparsable -> fresh {}
tmp=$(mktemp)
printf '%s' "$base" | jq 'FILTER' > "$tmp"
mv "$tmp" "$file"                                # atomic; never leaves a truncated file
```

### Windows idiom (PowerShell)

Replaces each ConvertFrom/To-Json block:

```powershell
$base = jq . $file 2>$null
if ($LASTEXITCODE -ne 0) { $base = '{}' }        # missing OR unparsable -> fresh {}
$tmp = [System.IO.Path]::GetTempFileName()
$base | jq 'FILTER' | Set-Content -Path $tmp -Encoding utf8
Move-Item -Force $tmp $file
```

### Per-site filters

- **08 (`.claude.json`)** — `.hasCompletedOnboarding = true`
- **04 (VS Code `settings.json`)** —
  `.["files.autoSave"]="afterDelay" | .["editor.formatOnSave"]=true | .["editor.defaultFormatter"]="esbenp.prettier-vscode" | .["[csharp]"]={"editor.defaultFormatter":"csharpier.csharpier-vscode"}`
- **06 (Firefox `policies.json`, sudo)** —
  `.policies.Certificates.Install = ((.policies.Certificates.Install // []) - [$stale,$ca] + [$ca])`
  passed `--arg ca "$ca_for_firefox" --arg stale "$ca_stale"`.
  Because the file is root-owned in `/etc/firefox/policies`, read via `sudo jq`,
  write the temp file as the normal user (jq reads stdin, needs no file access),
  then `sudo cp "$tmp" "$policy_file"` and `sudo chmod 644 "$policy_file"`.

## Behavior: preserved vs. changed

Preserved across all sites:

- **Merge into existing file** rather than clobbering it.
- **Start fresh (`{}`) only if the file is missing or unparsable** — never fail
  provisioning on a corrupt file.
- For #06, **drop the stale `/usr/local/...` path and ensure the CA appears
  exactly once**.

Changed (minor, #06 only):

- The CA now always lands at the *end* of the `Install` array (removed-then-
  appended) rather than keeping its original index when already present.
  Functionally identical for trust — CA present exactly once, stale path gone —
  and the operation is idempotent.

## Verification

The idiom was validated empirically with jq 1.8.2 before writing this spec:

- **Missing file** → fresh `{}`, key set.
- **Existing valid file** → merged, other keys preserved.
- **Unparsable file** → fresh `{}`, provisioning does not fail.
- **Firefox array** → stale path removed, unrelated CA preserved, our CA present
  exactly once, and a second run produces identical output (idempotent).

(During testing, Git Bash on Windows mangled `--arg` values that look like Unix
paths via MSYS2 path translation; this does not occur on Ubuntu, nor on Windows
where jq is called from PowerShell rather than Git Bash.)

Implementation should re-run each affected script (or its provisioning step) and
confirm the resulting JSON matches the pre-change output for the merge and
already-configured (idempotent re-run) cases.

## Tradeoffs

- On Ubuntu this *adds* a dependency (jq) where python3 was already free in the
  base system — accepted in exchange for one consistent JSON tool across both
  platforms.
- Everything else (merge semantics, atomic write) is equivalent to or slightly
  more robust than the current implementation.
