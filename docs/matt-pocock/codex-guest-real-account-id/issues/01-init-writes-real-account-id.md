# 01: `init` writes the real ChatGPT account id into the Codex placeholder mount

**What to build:** A freshly initialized environment gives both guests a Codex `auth.json` whose `tokens.account_id` is the host's real ChatGPT account id, while every token field stays a placeholder credential. A new guest built from it starts Codex 0.156+ without the "selected workspace missing from routing discovery" error, with no manual edits. See `../spec.md`.

The Codex auth sanitizer passes `tokens.account_id` through unchanged. It still replaces the access, id and refresh tokens with the fixed placeholders, and still refuses files that aren't in `chatgpt` mode or have no `tokens` object. The placeholder JWTs, the proxy stack's `chatgpt.com` gate, Pi's placeholder mount, and the guest post-scripts are all unchanged. ADR 0002 gets a consequence recording why the Codex CLI's placeholder mount now carries the real account id.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `unit`: the sanitizer test asserts `account_id` is preserved, the three tokens become placeholders, and non-chatgpt-mode input is still refused.
- [ ] `cli`: the `init` test asserts both shared `auth.json` files (Linux and Windows) contain the fixture's real `tokens.account_id` and placeholder tokens.
- [ ] `guest`: the Linux e2e test, next to the existing `01-auth-config` symlink assertion, asserts the guest reads the host's real `tokens.account_id` through `~/.codex/auth.json`.
- [ ] Existing fixtures and tests that assumed the shared `auth.json` carries the placeholder account id are updated. The placeholder account id constant stays, because Pi and the placeholder JWT claims still use it.
- [ ] The sanitizer's doc comment describes the new behavior.
- [ ] ADR 0002 has a consequence covering:
  - Codex ≥0.156 checks `tokens.account_id` against routing discovery.
  - The account id is an identifier, not a credential, so the guest still holds no usable credential.
  - Pi's mount keeps the placeholder id.
  - Rejected alternatives: rewriting the proxy's `accounts/check` response, pinning Codex below 0.156, and patching the id from a side file in the post-scripts.
- [ ] No `CONTEXT.md` change.
