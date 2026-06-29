Firecracker "is to enable secure, multi-tenant, minimal-overhead execution of container and function workloads."

I found the documentatino too onerous, going back to docker-sbx for now.

https://github.com/firecracker-microvm/firecracker

Firecracker runs within WSL, using nested virtualization which leverages Hyper-V. To see if KVM ( Kernel-based Virtual Machine) is available, run

> ls /dev/kvm

The following commands might be sufficient to enable it (requires restart):

> dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
> dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
> dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

You can check if those services are already available with:

> dism /online /get-featureinfo /featurename:HypervisorPlatform
> dism /online /get-featureinfo /featurename:Microsoft-Windows-Subsystem-Linux
> dism /online /get-featureinfo /featurename:VirtualMachinePlatform
