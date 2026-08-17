# Machine setup

Per-machine setup for a Windows host, done once before setting up any environment. Complete the [Host prerequisites](README.md#host-prerequisites) first, then this doc, then [setup-environment.md](setup-environment.md).

## 1. Create the host network

A network endpoint on the host machine is used to host an http/https proxy, SMB server, DNS and DHCP for an isolated network environment. Guests are initially use Hyper-V's NAT adapter then switched to the isolated endpoint once ready.

You'll be asked to specify the third-part of the subnet address you'd like to use (192.168.{n}.xx).

In an **Administrator** PowerShell on the host:

```powershell
susentorno create-host-network
```

This creates the Internal switch, assigns it a static host IP, and opens the host firewall (inbound Envoy `80`/`443`, DNS `53`, DHCP `67`, and SMB `445`) for the VM's Internal-switch adapter. The command is safe to rerun, only recreating the firewall rules if the network endpoint is already present. If you want to remove the network later you can run:

```powershell
susentorno delete-host-network
```
