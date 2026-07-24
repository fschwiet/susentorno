## VM setup

May be repeated for any number of VMs; each VM pairs with one environment via its shared folder.

> For a **Windows** guest instead of Ubuntu, follow `usage-windows-vm.md` and share the `.configamatron\vm-shared-windows` folder. The steps below cover the Ubuntu guest.
>
> To run either guest under **Hyper-V** instead of VMware, follow `usage-hyper-v.md` — it covers the switch, static-IP, and SMB-share differences, then hands back to the numbered scripts here (Ubuntu) or in `usage-windows-vm.md` (Windows).

### Create the VM and install the OS

- In VMware Workstation, create a new virtual machine:
  - Set a recent Ubuntu release as the installer image (ubuntu-26.04-desktop-amd64.iso is known to work).
  - 120 GB of dynamic disk space (or ask google for values for your intended use cases).
  - Select "Customize Hardware" before finishing: 12288 MB of static memory (or no more than half of the host machine's memory), 1 processor with 6 cores (or ask google for values for your specific processor). Leave the network as NAT for initial setup, pre-isolation.
- Start the VM and install the OS. Pick the defaults, except:
  - Uncheck "Require my password to log in" — anyone with access to the VM already has access to the host, and it is easier this way. Your password is still required for sudo.
  - Do not select "Install third-party apps for graphics and wi-fi hardware"; it may stall OS installation.
  - Do not enable Shared Folders before the OS is installed; it may stall OS installation.

### Enable open-vm-tools and share the environment folder

Run in the VM's terminal ('-desktop' helps with screen resolution on top of open-vm-tools' shared folders and copy'n'paste integration).

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

Shut the VM down, then in VM -> Settings -> Options:

- "Shared Folders": enable only the environment's `.configamatron\vm-shared` folder, read-only.
- "Guest Isolation": consider disabling drag'n'drop and copy'n'paste sharing.

### Fix Shared Folders

#### The Inevitable Fix

Add the following line to '/etc/fstab' and restart the VM.

```
vmhgfs-fuse   /mnt/hgfs    fuse    defaults,allow_other    0    0
```

#### Not Sure The Inevitable Fix Is Right For You?

Maybe someday the fix above won't make sense. Is today that day? Start the VM and verify the share appears under `/mnt/hgfs/`. If there is no `/mnt/hgfs`, stop and restart folder sharing. If `/mnt/hgfs` doesn't contain your shared drive then do The Inevitable Fix above.

### Run the numbered scripts from the VM

Complete "Proxy setup" first, so `vm-shared` contains `cert.pem`, `github-config.txt`, and `credentials.json`.

Run without `sudo`; each script elevates internally where needed. The exact count may vary when custom steps are present.

1. `cd` into `vm-shared/pre-scripts/` and run every script in number order. The last step is `05-configure-network.sh <host-ip>` when there are no custom scripts.
2. Switch the VM network from NAT to host-only, then reboot.
3. `cd` into `vm-shared/post-scripts/` and run every script in order: normally `01-auth-config.sh`, then `02-apply-home-jq-transforms.sh`.
