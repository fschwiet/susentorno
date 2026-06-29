# Docker sbx sandboxing

- Official docs: https://www.dockerworkshop.com/lab8/overview/

- For windows: https://www.ajeetraina.com/running-coding-agents-in-a-secure-microvm-on-windows-with-sbx/

- to check if dependencies are installed, use an elevated shell:
  > dism /online /get-featureinfo /featurename:HypervisorPlatform
  > dism /online /get-featureinfo /featurename:Microsoft-Windows-Subsystem-Linux
  > dism /online /get-featureinfo /featurename:VirtualMachinePlatform
- if any are missing, install from an elevated shell and reboot:

  > dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
  > dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
  > dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

- install sbx

  > winget install -h Docker.sbx

- problem: sbx requires logging in, I don't want to deal with Docker accounts
