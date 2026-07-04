# Isolated Virtual Machine Configuration

## Create the VM and install the OS

- Within VMware Workstation, create a new virtual machine
  - Set a recent version of Ubuntu as the installer image (I'm using ubuntu-26.04-desktop-amd64.iso)
  - 120gb of dynamic disk spacee
  - Select "Customize Hardware" before finishing
    - 12288 MB of static memory (or no more than half of the host machine's memory)
    - 1 processor with 6 cores (ask google for values to use for your specific processor)
    - network left as NAT network for initial setup pre-isolation
  - Do start the VM once its created and initiate OS installation
  - For OS installation, I pick the defaults, except:
    - Uncheck "Require my password to log in" since if someone has access to my VM they already have access to my host and its easier that way. Your password will still be required for things like sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware", it may cause OS installation to stall.
  - Do not try to enable Shared Folders before installing the OS, it may cause OS installation to stall.

## Enable and configure open-vm-tools[-desktop]

Run the following from the VM's terminal. The '-desktop' helps with the VM's screen resolution,
adding to "open-vm-tools"'s support for shared folders and copy'n'paste integration.

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Once that completes, shut down the VM so host-VM integration can be configured:

- dropdown menu VM -> Settings -> Options
  - "Shared Folders"
    - should be disabled, except the vm folder within this repository, which should be read-only
  - "Guest Isolation"
    - consider disabling drag'n'drop and copy'n'paste sharing

Start the VM and verify shared folders show up within '/mnt/hgfs/'. If /mnt/hgfs isn't availabe stop and start folder sharing. If /mnt/hgfs is empty add the following to /etc/fstab and reboot:

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

## Prepare the vm folder to copy to the VM

- Set up the proxy according to [envoy-proxy.md] if you haven't already.
  - cert.pm is added to the vm folder
- Create a fine-grained personal access token at https://github.com/settings/personal-access-tokens/new
  - Scope it to whatever repositories you want
  - For pull/push ability to those repositories, enable read/write access to Contents
- run `pnpm exec configamatron write-github-config` and provide the access token when prompted
  - username and email will also be extracted from current git config

## Install other typical tools

Run these in order, without `sudo` — each script uses `sudo` internally where it actually needs root. Open a **new terminal** wherever noted, so the shell picks up PATH changes the previous step's installer wrote to `~/.bashrc`.

1. `vm/01-apt-packages.sh`
2. `vm/02-install-pnpm.sh`
3. Open a new terminal, then `vm/03-install-tools.sh`
4. Open a new terminal, then `vm/04-configure-tools.sh`

- A browser will open for context7 login. Close it and cancel the script if you don't want to use credentials.

5. `bash vm/05-github-auth.sh`

6. Do the VM-side things from [envoy-proxy](envoy-proxy.md).
7. Change network connection from NAT to host-only
