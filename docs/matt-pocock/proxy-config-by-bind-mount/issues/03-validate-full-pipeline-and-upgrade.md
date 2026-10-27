# 03: Validate the full pipeline and an upgraded environment

**What to build:** Confirm on the maintainer's host, with Docker Desktop on the WSL 2 backend, that the whole suite passes with bind-mounted configuration and no file-sharing dialogs. Also confirm that an environment created before ticket 01 upgrades cleanly. This needs a human: the upgrade check uses a real environment and a real guest that already trusts its root CA.

**Blocked by:** 01, 02.

**Status:** ready-for-human

- [ ] Docker Desktop is confirmed to be on the WSL 2 backend, and `pnpm check` runs to completion with no Docker Desktop file-sharing dialog.
- [ ] In an environment created before ticket 01, `run-hosting` stops and says to run `generate-ca`. `generate-ca` then reports moving the root CA private key, and the root CA certificate is unchanged.
- [ ] `run-hosting` then starts in that environment, and an existing guest that already trusts the root CA reaches a terminated destination without reinstalling a certificate.
- [ ] `docker inspect` on the running Envoy shows the four read-only bind mounts and the environment label. No root CA private key is present at the container's CA path.
- [ ] The spec and tickets 01–03 are marked resolved.

**Verification:** This is the one ticket that runs the full `pnpm check`. It also serves as the end-to-end check for tickets 01 and 02, which each run only their own part of the pipeline.
