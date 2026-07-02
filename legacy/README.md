# notes

be sure to run as a non-root user account when developing electron

Should I disable side channel mitigations? https://kb.vmware.com/s/article/79832

# Create a Virtual Machine

## Create a new VM in VM Workstation Pro

- 12288 MB of static memory
- 127gb of dynamic disk spacee
- 1 processor with 6 cores
- default network switch

# Copy and run setup.bash

## Enable open-vm-tools

```
sudo apt update && sudo apt install -y open-vm-tools-desktop
```

VMware > VM Settings > Options > Isolation:

- Uncheck Enable copy and paste
- Uncheck Enable drag and drop
- Disable Shared Folders

## Script 1

The first sudo will request a password.

```
#!/bin/bash
# Exit immediately if a command exits with a non-zero status
set -e

sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential
curl -fsSL https://get.pnpm.io/install.sh | sh -
source /home/username/.bashrc
pnpm runtime set node latest -g

```

Install Claude and add to path

```
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude mcp add --transport http context7 https://mcp.context7.com/mcp
```

Install codex

```
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

## Misc Scripts

```
sudo apt update && sudo apt install okular  # another markdown reader
```

## Skipped Scripts

I'm not going to run these

```

# Fix for the Ubuntu dark screen / color profile prompt bug in XRDP

sudo bash -c "cat > /etc/polkit-1/localauthority/50-local.d/45-allow-colord.pkla" <<EOF
[Allow Colord all Users]
Identity=unix-user:\*
Action=org.freedesktop.color-manager.create-device;org.freedesktop.color-manager.create-profile;org.freedesktop.color-manager.modify-device;org.freedesktop.color-manager.modify-profile
ResultAny=no
ResultInactive=no
ResultActive=yes
EOF

echo "=== 6. Generating Isolated SSH Key for GitHub ==="

# Generates a key pair; hit Enter to accept defaults or pass a passphrase

ssh-keygen -t ed25519 -C "vm-agent@local" -N "" -f ~/.ssh/id_ed25519

echo "=================================================="
echo " SETUP COMPLETE! Please restart the VM to finish. "
echo "=================================================="
echo ""
echo "Your new GitHub Public SSH Key is below. Copy and add it to GitHub Settings:"
cat ~/.ssh/id_ed25519.pub


```

# Network Lockdown

Method 3: The Hyper-V "Internal Switch" + Windows Firewall (Most Secure)

If you want bulletproof, tamper-proof network isolation where the agent cannot bypass the restrictions (even if it gains root access to the VM), you must move off the Default Switch:Create an Internal Switch: In Hyper-V Manager, open the Virtual Switch Manager and create a new Internal switch. Name it Isolated-Switch.Assign it to the VM: Swap your Ubuntu VM's network adapter from the Default Switch to Isolated-Switch.Set up Routing: The VM now has zero internet. You then use Windows Internet Connection Sharing (ICS) or a Windows loopback tool to bridge the connection, allowing you to use Windows Defender Firewall with Advanced Security on your host machine to explicitly write outbound rules for that specific virtual adapter.
