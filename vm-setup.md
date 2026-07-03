# Create a Virtual Machine

## Create a new VM in VM Workstation Pro

- 12288 MB of static memory
- 127gb of dynamic disk spacee
- 1 processor with 6 cores
- NAT network for initial setup pre-isolation

# Copy and run setup.bash

## Enable open-vm-tools

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Consider isolation options (VMware > VM Settings > Options > Isolation)

- Uncheck Enable copy and paste
- Uncheck Enable drag and drop
- Disable Shared Folders (except for a place to drop in configuration scripts)

## Fixing shared folders

Shared should be mounted to /mnt/hgfs. If they don't show up, add the following to /etc/fstab and reboot:

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

## Install other typical tools

Run these in order, without `sudo` — each script uses `sudo` internally where it actually needs root. Open a **new terminal** wherever noted, so the shell picks up PATH changes the previous step's installer wrote to `~/.bashrc`.

1. `bash vm/01-apt-packages.sh`
2. `bash vm/02-install-pnpm.sh`
3. Open a new terminal, then `bash vm/03-install-tools.sh`
4. Open a new terminal, then `bash vm/04-configure-tools.sh`
