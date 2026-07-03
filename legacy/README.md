# notes

be sure to run as a non-root user account when developing electron

Should I disable side channel mitigations? https://kb.vmware.com/s/article/79832

# Create a Virtual Machine

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
