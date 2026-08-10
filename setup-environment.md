# Environment setup

Per-environment setup, done from the environment directory (e.g. `e:\repo`) after completing [setup-machine.md](setup-machine.md). An environment is the complete configuration and generated state for one isolated agent workspace, owned by that working directory (see [CONTEXT.md](CONTEXT.md)).

If you run more than one environment on this machine, give each one distinct share and share-account names in the steps below — the defaults used here (`vm-shared-linux`, `vm-shared-windows`, `susentorno-share`) collide if reused across environments. You don't need to redo this setup each time you switch which environment you're actively using, but you do need to keep track of which share name belongs to which environment.

## Initialize the environment's directory

1. `susentorno init` — creates `.susentorno/` scaffolding. Its `.gitignore` is an allowlist: commit only `.gitignore`, `pre-scripts/`, `post-scripts/`, `home-jq-transforms/`, and `proxy/allowlist.txt`; generated files and secrets remain ignored. Run `susentorno update-shares` after changing authored inputs.
2. `susentorno generate-ca` — writes the root certificate authority the proxy's https certificates chain to. Run once per environment; `run-hosting` reissues the per-host leaf certificate automatically as the allow list changes.
3. `susentorno write-github-config` — prompts for a GitHub fine-grained personal access token and writes `vm-shared-linux/github-config.txt` (username/email come from your global git config). Create the token at https://github.com/settings/personal-access-tokens/new, scoped to the repositories the agent should use, with read/write permission to 'Contents'.
4. `susentorno run-hosting` — builds `proxy/envoy.yaml` from `proxy/allowlist.txt` and launches the proxy in a docker container with the latest Claude credentials. While it runs it watches both files: editing the allow list takes effect live (config rebuilt, leaf certificate reissued if the TLS-terminated hosts changed, proxy restarted), and credential rotations propagate automatically. It also streams the proxy's access log inline (see [diagnostics.md](diagnostics.md#watching-proxy-traffic)) and forwards the Hyper-V Internal-switch interface's `:80`/`:443` to Envoy on loopback, so it must stay running for the VM to reach the proxy (Envoy is published on `127.0.0.1` only). Pass `--no-forward` to disable forwarding, or `--forward-listen <ip>` to override the bind address.

When upgrading an older environment, remember that `.gitignore` does not untrack indexed files. Either delete and re-run `init`, or run `git rm -r --cached .susentorno && git add .susentorno`, then commit, to re-apply the allowlist while keeping files on disk.

## Enable shared drives

Once the directory is ready, the appropriate sub-directories are turned into shares. They'll be locked down to a user account whose password you'll need to save for use when setting up the guest VMs.

### Create the environment's share account

Storing a host credential inside the VM is a real exposure: the isolation boundary is **code running in the VM vs. the host**, and the SMB credential has to sit in a file the guest reads at boot — so VM-resident code can read it too. Make the account powerless so a leak grants nothing beyond the folder read the VM already has. Remember this password for when you set up guests against this environment.

```powershell
$pw = Read-Host -AsSecureString "Password for susentorno-share"
New-LocalUser -Name "susentorno-share" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
```

Then, in **Local Security Policy** (`secpol.msc`) → Local Policies → User Rights Assignment, add `susentorno-share` to **Deny log on locally** and **Deny log on through Remote Desktop Services**.

Then in **Computer Management** -> "Local Users and Groups" -> "susentorno-share" -> "MemberOf" add the Users group and ensure no other group is added (which only grants "Access this computer from the network").

Do not enable guest/anonymous SMB access as an alternative — modern Windows blocks insecure guest auth by default and enabling it weakens the whole host.

## Share the environment folders (read-only)

Create SMB shares for **both** `vm-shared-linux` and `vm-shared-windows`, each granting only this environment's share account read access. A guest mounts whichever one matches its OS.

```powershell
$env_dir = "E:\repo\.susentorno"   # this environment's .susentorno folder
New-SmbShare -Name "vm-shared-linux"         -Path "$env_dir\vm-shared-linux"         -ReadAccess "susentorno-share"
New-SmbShare -Name "vm-shared-windows" -Path "$env_dir\vm-shared-windows" -ReadAccess "susentorno-share"
```

`susentorno create-host-network` (see [setup-machine.md](setup-machine.md)) already scoped SMB (TCP 445) to the Internal-switch and Default Switch adapters when you ran it — no separate firewall rule is needed here. It is never exposed on the external NIC.

Why the shared folder must be **live** rather than copied in: the guest's `~/.claude/.credentials.json` is symlinked to the shared `credentials.json`, and the proxy rotates that file as credentials refresh; a one-time copy-in (ISO, `Copy-VMFile`) would freeze the credential and is not an option. The credential files synced to the guest do not contain real credentials, only placeholders — the proxy injects the real values on the wire.

### Security note: the share account

The isolation boundary susentorno enforces is **code running in the VM vs. the host**, not merely a human operator. Because the SMB credential must be stored where the guest can read it at boot, code inside the VM can read it too. That is why `susentorno-share` is scoped to read-only access on the two shared folders and denied interactive logon: even if VM-resident code exfiltrates the credential, all it grants is the folder read the VM already had.

The shared `credentials.json` and GitHub `github-config.txt` are both **placeholders** — the real Claude token and the real GitHub PAT are injected on the wire by the proxy, never stored in the VM. `susentorno-share` is the only credential anywhere in the VM — one more reason to keep it as inert as possible.

## Next step

Continue to [setup-guest.md](setup-guest.md) to create and configure the guest VM(s) that pair with this environment.
