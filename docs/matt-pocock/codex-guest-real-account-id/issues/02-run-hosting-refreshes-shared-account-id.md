# 02: `run-hosting` keeps the shared Codex `auth.json` account id current

**What to build:** When `run-hosting` starts, and whenever the host's ChatGPT account id changes (for example, after a workspace switch on the host), both shared Codex `auth.json` files are rewritten with the host's current account id. Existing environments created before ticket 01 are migrated with no manual step. A Linux guest sees the new id immediately through its symlink. A Windows guest picks it up by re-running `01-auth-config.ps1`. See `../spec.md`.

The codex host credential channel gets an optional account-id-changed hook. It fires once on the startup read, and again whenever a later read sees an account id different from the last one applied, following the channel's existing account-id change detection. It never fires on a token-only change or a failed read. The Claude channel doesn't supply it. Run-hosting connects the hook to a rewrite of the shared `auth.json` in every VM-shared target:
- It regenerates each file from the host's current `~/.codex/auth.json` through the same sanitizer `init` uses, so for the same input the output is byte-identical to what `init` writes.
- It writes atomically (temp file + rename).
- If the rewrite fails, it's reported like other credential-write failures, and proxy header injection is not blocked.

The proxy stack's `chatgpt.com` gate is unchanged.

**Blocked by:** 01 (`init` writes the real ChatGPT account id into the Codex placeholder mount)

**Status:** ready-for-agent

- [ ] `unit`: the credential channel test asserts the hook fires on the startup read; fires when a later read has a different account id; does not fire when only the token or expiry changes; does not fire when a read fails.
- [ ] `proxy-stack`: the stack lifecycle test asserts that starting run-hosting against an environment whose shared `auth.json` holds the placeholder account id rewrites both shared copies with the host's account id.
- [ ] `proxy-stack`: the stack lifecycle test asserts that after the host `auth.json`'s `account_id` changes, both shared copies are rewritten with the new id.
- [ ] The shared-file rewrite is atomic, and a rewrite failure doesn't stop credential injection.
- [ ] The Codex sections of the guest `01-auth-config` post-scripts get a comment saying that re-running the script refreshes the account id after a host workspace switch (Windows) or that it tracks the share automatically (Linux).
