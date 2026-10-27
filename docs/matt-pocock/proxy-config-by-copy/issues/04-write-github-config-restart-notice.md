# 04: write-github-config tells the user to restart run-hosting

**What to build:** After `write-github-config` writes a new GitHub host credential, its success output tells the user that `run-hosting` must be restarted for the proxy stack to start injecting the new credential. `run-hosting` doesn't watch the GitHub secret files, so without a restart the old credential keeps being injected until some unrelated color swap happens. The command's comment that calls the secrets directory "watched" is corrected.

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] The success output says that `run-hosting` must be restarted for the new GitHub credential to take effect. It still never echoes the token.
- [x] No comment in the command describes the secrets directory as watched.
- [x] `cli` `write-github-config` test asserts the restart notice.

**Verification:** Don't run `pnpm check` or the full `pnpm test`; ticket 05 runs the whole pipeline once at the end. Run these, in this order:

1. `pnpm format:check`, `pnpm lint`, `pnpm typecheck`
2. `pnpm build`, then only `pnpm test:cli -- .\tests\cli\writeGithubConfig.test.ts`

No `unit`, `proxy-stack`, `host-network` or `guest` runs are needed: this changes only the command's output and a comment.
