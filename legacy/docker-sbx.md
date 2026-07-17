# Docker sbx sandboxing

- Official docs: https://www.dockerworkshop.com/lab8/overview/

- For windows: https://www.ajeetraina.com/running-coding-agents-in-a-secure-microvm-on-windows-with-sbx/

- to check if dependencies are installed, use an elevated shell:

```
dism /online /get-featureinfo /featurename:HypervisorPlatform
dism /online /get-featureinfo /featurename:Microsoft-Windows-Subsystem-Linux
dism /online /get-featureinfo /featurename:VirtualMachinePlatform
```

- if any are missing, install from an elevated shell and reboot:

dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

- install sbx

  > winget install -h Docker.sbx

- login

  > sbx login

- set Claude credentials

  > "sk-ant-..." > sbx secret set -g claude

- create a sandbox (Make sure Docker Desktop is open!)

  > sbx create --name=onion claude .

- run the agent in the sandbox

  > sbx run onion

- clear sandbox login, secrets, everything

  > sbx reset -f

### Troubleshooting

> sbx create --name=onion claude .

observed failing with out of storage:

```
ERROR: failed to pull image: failed to extract layer (application/vnd.oci.image.layer.v1.tar+gzip sha256:81e2f2053c8fa702b6863110b55c09e67f6adeb78b4672745958c4d8b3d056c5) to erofs as "extract-99778100-KrZn sha256:e8c084c1b320c172e8be941d735d77298e49986014213a8282c9b533ee216a61": failed to convert tar to erofs: erofs apply failed: <E> erofs: main() Line[1940] failed to initialize diskbuf: No space left on device
<E> erofs: main() Line[2160]    Could not format the device : [Error 28] No space left on device
```

Maybe resolved by running:

> $env:DOCKER_SANDBOXES_DOCKER_SIZE="80G"
> sbx reset -f

The fix may also have been starting Docker Desktop...
