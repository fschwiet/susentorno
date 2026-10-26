# 05: Validate that pnpm check runs without Docker file-sharing prompts

**What to build:** Confirm on the maintainer's Hyper-V-backend Docker Desktop that the proxy stack no longer triggers file-sharing dialogs, starting from clean Docker settings. This needs a human: Docker Desktop has to be quit and restarted around the settings edit, because it rewrites its settings file from memory while running.

**Blocked by:** 01, 02, 03, 04.

**Status:** ready-for-human

- [ ] With Docker Desktop quit, only the four `test-results\.susentorno\proxy\…` entries are removed from `FilesharingDirectories` in Docker Desktop's settings store. Nothing else in the file changes.
- [ ] Docker Desktop is restarted, then `pnpm check` runs to completion with no file-sharing dialog.
- [ ] After the run, `FilesharingDirectories` has gained no new entries.

**Verification:** This is the one ticket that runs the full `pnpm check`. It also serves as the end-to-end check for tickets 01–04, which each run only their own part of the pipeline.
