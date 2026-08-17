# Environment setup

An environment folder is used to track configuration for a group of guests. One environment is probably sufficient for most people, you might have different environments if you're sharing the configurations with others and want to keep them separated. Susentorno's own internal testing requires an isolated environment.

Create a directory where you'll keep your environment. I recommend initializing it as a git respository so you can keep your guest configurations in source control. Personally I keep my environment at 'c:\my-susentorno'.

If you run more than one environment on this machine, give each one distinct share and share-account names in the steps below — the defaults used here (`vm-shared-linux`, `vm-shared-windows`, `susentorno`) collide if reused across environments. You don't need to redo this setup each time you switch which environment you're actively using, but you do need to keep track of which share name belongs to which environment.

## Initialize the environment's directory

Run the following command from your environment directory:

```powershell
susentorno create-host-network
```

This creates a `.susentorno` directory. Guest machine configuration goes into folders `pre-scripts/`, `post-scripts/`, `home-jq-transforms/`. An apprpropriate .gitignore file is created at `.susentorno` to include those directories and nothing else in commits.

`generate-ca` is ran the certificates used by susentorno's proxy when signing traffic with injected credentials

```powershell
susentorno generate-ca
```

`write-github-config` is ran to extract the currently configured username/email to configure git and establish which personal access token (PAT) is injected by the proxy.

You will be prompted for that PAC, one can be created at https://github.com/settings/personal-access-tokens/new. When creating your personal access token, be sure to give it access to the repositories you want to work with and read+write permission to `Contents` to actually push changes to those repositories. Personally I also give permissions to read/write `Issues`.

```powershell
susentorno write-github-config
```

## Enable shared drives

Once the directory is ready, the appropriate sub-directories are shared so the guest's can access the contained setup scripts. They'll be locked down to a user account whose password you'll need to save for use when setting up the guest VMs.

### Create the environment's share account

Create a user account which will be used by the VMs to access the shared drives. Restrict this accounts permission since it will be available to the guest machines. Remember this password for when you set up guests against this environment.

```powershell
$pw = Read-Host -AsSecureString "Password for susentorno"
New-LocalUser -Name "susentorno" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword
```

If you run this installation under an isolation name — `susentorno create-host-network --isolation-name <name>` — name the account `susentorno-<name>` instead, and pass it to `setup-guest-unix --share-account`. Windows caps a local account name at 20 characters, so an isolation name has about nine to work with.

### Set the share account's permissions

In **Local Security Policy** (`secpol.msc`) → Local Policies → User Rights Assignment, add `susentorno` to **Deny log on locally** and **Deny log on through Remote Desktop Services**.

Then in **Computer Management** -> "Local Users and Groups" -> "Users" -> "susentorno" -> "MemberOf" add the Users group and ensure no other group is added (which only grants "Access this computer from the network").

Do not enable guest/anonymous SMB access as an alternative — modern Windows blocks insecure guest auth by default and enabling it weakens the whole host.

## Share the environment folders (read-only)

Create SMB shares for **both** `vm-shared-linux` and `vm-shared-windows`, each granting only this environment's share account read access. A guest mounts whichever one matches its OS.

```powershell
$env_dir = "E:\repo\.susentorno"   # this environment's .susentorno folder
New-SmbShare -Name "vm-shared-linux"         -Path "$env_dir\vm-shared-linux"         -ReadAccess "susentorno"
New-SmbShare -Name "vm-shared-windows" -Path "$env_dir\vm-shared-windows" -ReadAccess "susentorno"
```

These folders are shared live rather than copied over because their contents can change. Customizations to the guest configurations script may be applied. The injected authentication configurations are also copied here (with placeholders for the secure tokens that the proxy will inject).

## Run the environment

The environment is active when the 'run-hosting' command is running. This runs the DHCP and DNS servers as well as the http/https proxy.

```powershell
susentorno write-github-config
```

## Next step

Continue to [setup-guest.md](setup-guest.md) to create and configure the guest VM(s) that pair with this environment.
