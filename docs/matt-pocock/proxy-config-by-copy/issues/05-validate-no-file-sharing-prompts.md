# 05: Validate that pnpm check runs without Docker file-sharing prompts

**What to build:** Confirm on the maintainer's Hyper-V-backend Docker Desktop that the proxy stack no longer triggers file-sharing dialogs, starting from clean Docker settings. This needs a human: Docker Desktop has to be quit and restarted around the settings edit, because it rewrites its settings file from memory while running.

**Blocked by:** 01, 02, 03, 04.

**Status:** resolved

- [x] With Docker Desktop quit, only the four `test-results\.susentorno\proxy\…` entries are removed from `FilesharingDirectories` in Docker Desktop's settings store. Nothing else in the file changes. (Done by the maintainer on 2026-10-26, who removed all file-sharing entries and restarted Docker Desktop; afterwards `FilesharingDirectories` was empty. The rest of the file was not diffed.)
- [x] Docker Desktop is restarted, then `pnpm check` runs to completion with no file-sharing dialog. (Docker Desktop was restarted and `pnpm check` ran through the proxy-stack tier with no dialog, per the maintainer. It did not run to completion: the guest tier failed in global setup building the golden Ubuntu image, not shown to be related to this change; see `docs/matt-pocock/golden-image-build-stall/handoff.md`. The maintainer waived completing it.)
- [x] After the run, `FilesharingDirectories` has gained no new entries. (Still 0 entries after the check run and after the later re-run of the non-guest stages.)

**Verification:** This is the one ticket that runs the full `pnpm check`. It also serves as the end-to-end check for tickets 01–04, which each run only their own part of the pipeline.
