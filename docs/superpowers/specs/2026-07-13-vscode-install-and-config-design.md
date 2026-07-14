# VS Code install and configuration for vm-shared guests

**Date:** 2026-07-13
**Status:** Approved design, ready for implementation planning

## Goal

Install VS Code in both guest provisioning kits (`templates/vm-shared/` for Ubuntu,
`templates/vm-shared-windows/` for Windows) as part of the `03` tool-install step, and
configure it in the `04` configure-tools step: install the Prettier extension
(`esbenp.prettier-vscode`) and set three user-level editor settings.

## Ubuntu (`templates/vm-shared/`)

### `03-install-tools.sh`

Add a snap install line alongside the existing tool installs:

```bash
sudo snap install code --classic
```

Chosen over the official Microsoft apt repo (key + source + `apt update`, more setup) and a
direct `.deb` download (no update mechanism) for consistency with this script's existing
minimal, single-command style.

Update the trailing `echo` to mention VS Code.

### `04-configure-tools.sh`

Add a new `## VS Code` section, matching the file's existing `## Screen Locking` /
`## Agent configurations` section style:

```bash
code --install-extension esbenp.prettier-vscode
```

Then merge the three settings into `~/.config/Code/User/settings.json`, creating the `User`
directory first with `mkdir -p`. Use the same "merge into existing JSON, start fresh if
unparsable" `python3` heredoc pattern already used in `06-trust-ca.sh` (Firefox
`policies.json`) and `08-claude-config.sh` (`.claude.json`), so any settings the user/image
already has are preserved.

## Windows (`templates/vm-shared-windows/`)

### `03-install-tools.ps1`

Add a winget install call, using the same flags already used in `01-install-packages.ps1`:

```powershell
winget install --id Microsoft.VisualStudioCode --exact --silent --accept-source-agreements --accept-package-agreements
```

Update the trailing `Write-Host` to mention VS Code.

### `04-configure-tools.ps1`

Add:

```powershell
code --install-extension esbenp.prettier-vscode
```

Then merge the three settings into `$env:APPDATA\Code\User\settings.json`, creating the
`User` directory first with `New-Item -ItemType Directory -Force`. Use the same
`ConvertFrom-Json -AsHashtable` / merge / `ConvertTo-Json | Set-Content` pattern already used
for `.claude.json` in `08-claude-config.ps1`.

## Settings content (both platforms)

Both merges set exactly these three keys, preserving anything else already in the file:

```json
{
  "files.autoSave": "afterDelay",
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode"
}
```

## Out of scope

- No change to the `01`-package-install scripts. VS Code is installed in `03` (alongside the
  other developer tools) per explicit request, even though it could arguably be categorized as
  a package like Git/`gh`/PowerShell 7 in `01`.
- No `verify-config.sh` / `verify-config.ps1` check for VS Code, the extension, or the
  settings. `verify-config` is scoped to the security/network boundary (CA trust, DNS
  redirect, placeholder credentials) — no other installed CLI (`claude`, `codex`, `git`,
  `pnpm`) gets a presence check there either, so this is consistent with existing scope.
- No automated test coverage. These are guest-provisioning shell/PowerShell scripts with no
  existing automated test harness (per the Windows kit's design doc, guest scripts are
  verified manually in a real VM); this follows the same pattern.

## Testing

Manual: run the updated `03` and `04` scripts in a fresh guest VM (Ubuntu and Windows), then
confirm `code --list-extensions` shows `esbenp.prettier-vscode` and the three keys are present
in the respective `settings.json`.
