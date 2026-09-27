# Codex guest carries the real ChatGPT account id

Status: ready-for-agent

## Problem Statement

Codex CLI 0.156.0 and later fails to start in a guest:

```
Error: account/read failed during TUI bootstrap: account/read failed: selected workspace missing from routing discovery (code -32603)
```

At startup, Codex calls `GET https://chatgpt.com/backend-api/wham/accounts/check` and checks that its "selected workspace" appears among the returned accounts. It takes the selected workspace from `tokens.account_id` in `~/.codex/auth.json`. In a guest, that value is the fixed placeholder `susentorno-placeholder-account-id`. The request itself succeeds, because the proxy stack injects the codex host credential channel's real token and account id. The workspaces it returns carry real ids, so the placeholder never matches and Codex exits.

Downgrading Codex is not a workable fix. GPT-6 models reportedly need Codex 0.156.1 or later, and the guest installs track the latest release. Upstream reports of the same problem with placeholder-credential gateways: openai/codex#47374, onecli/onecli#577, ndycode/codex-multi-auth#700, okou-ai/okou#36399 (fixed in okou-ai/okou#36402 by giving the guest the real workspace id).

We confirmed this by hand on a Windows guest: putting the host's real `tokens.account_id` into the guest's `~/.codex/auth.json` is enough to make Codex work. The placeholder id_token and its `chatgpt_account_id` claim can stay as they are.

## Solution

The Codex CLI's placeholder mount (`~/.codex/auth.json`) carries the host's **real** ChatGPT account id in `tokens.account_id`. Every token field stays a placeholder credential.

- When `susentorno init` sanitizes the host's `~/.codex/auth.json`, it keeps the real `tokens.account_id`, so both shared `auth.json` files carry it from the start.
- The codex host credential channel in `run-hosting` rewrites both shared `auth.json` files at startup and whenever the host's account id changes. Existing environments therefore pick up the real id the next time `run-hosting` starts, and a host workspace switch reaches the shares automatically.
- The guest post-scripts are unchanged. On Linux, `~/.codex/auth.json` stays a symlink into the read-only VM share, so a changed id is visible immediately. On Windows, the post-script already copies the shared file. After a host workspace switch, re-running `01-auth-config.ps1` refreshes the copy.
- The proxy stack's `chatgpt.com` gate is unchanged. It still removes the guest-supplied `chatgpt-account-id` header when it recognizes the placeholder bearer, and injects the host's current account id. The proxy stays authoritative, even when a guest copy is stale.

## User Stories

1. As a developer in a guest, I want `codex` 0.156+ to start without the "selected workspace missing from routing discovery" error, so that I can use Codex (and GPT-6 models) inside the isolated VM.
2. As a developer, I want `susentorno init` to put my real ChatGPT account id into the shared Codex `auth.json`, so that a freshly built guest works without manual edits.
3. As a developer with an environment created before this change, I want starting `run-hosting` to update the shared `auth.json` with my real account id, so that I don't have to delete and re-init `.susentorno`.
4. As a developer on a Linux guest, I want `~/.codex/auth.json` to keep tracking the shared file, so that a host-side account id change is visible without re-running post-scripts.
5. As a developer on a Windows guest, I want the existing `01-auth-config.ps1` copy step to install the real account id, so that no Windows-specific script change is needed.
6. As a developer who switches ChatGPT workspace on the host, I want run-hosting to notice the new account id and rewrite the shared `auth.json`, so that the guest can pick it up (automatically on Linux, by re-running `01-auth-config.ps1` on Windows).
7. As a developer, I want the guest's `auth.json` to keep holding only placeholder tokens, so that no live credential ever enters the guest.
8. As a developer, I want `init` to keep refusing a non-`chatgpt`-mode Codex auth file, so that a real `OPENAI_API_KEY` is never copied into the share.
9. As a developer, I want the proxy stack to keep replacing the `chatgpt-account-id` header with the host's current id, so that requests go to the right account even while a guest copy is stale.
10. As a developer using the Pi Coding Agent, I want Pi's placeholder mount to stay unchanged, so that Pi, which already works, isn't disturbed.
11. As a developer, I want run-hosting to leave the shared `auth.json` alone when only the host token refreshes, so that the file visible over SMB changes only when its contents actually change.
12. As a developer, I want the shared `auth.json` rewrite to be atomic, so that a guest reading through the symlink never sees a half-written file.
13. As a maintainer, I want ADR 0002 to explain why the guest now holds one real, non-credential, per-environment value, so that nobody later "fixes" it back to a placeholder and breaks Codex.
14. As a maintainer, I want the rejected alternatives recorded (proxy rewrite of the `accounts/check` response, pinning Codex below 0.156, patching the id into a guest-side copy from a side file), so that the trade-off is visible.
15. As a maintainer, I want the codex host credential channel to expose an "account id changed" event, so that the rewrite logic is unit-testable separately from token propagation.

## Implementation Decisions

- **Codex auth sanitizer**: passes `tokens.account_id` through unchanged. It still replaces `access_token`, `id_token` and `refresh_token` with the fixed placeholders, and still rejects files that aren't `auth_mode: "chatgpt"` or that have no `tokens` object. Its doc comment is updated. The placeholder account id constant stays, because the Pi placeholder mount and the Codex placeholder JWT claims still use it.
- **Placeholder JWTs are unchanged**: the access token and id_token literals, including their `chatgpt_account_id` claim, stay shared and fixed. The proxy's exact-match gate and Pi's static jq transform are unaffected. Manual testing confirmed Codex does not require the id_token claim to match `tokens.account_id`.
- **Codex host credential channel, new hook**: the channel config gets an optional account-id-changed hook. It fires once on the startup read, and again whenever a later read sees an account id that differs from the last one applied. It does **not** fire when only the token changes. The channel already tracks account id changes to rewrite the `codex_account_id` proxy secret, so the hook follows that existing change detection. The Claude channel doesn't supply the hook.
- **Run-hosting wiring**: run-hosting connects the codex channel's hook to a rewrite of the shared `auth.json` in every VM-shared target (Linux and Windows). It regenerates each file by running the host's current `~/.codex/auth.json` through the same sanitizer, and writes atomically (temp file + rename). If the rewrite fails, it's reported the same way as other credential-write failures, and header injection is not blocked.
- **Guest templates**: no change. Linux keeps the symlink (the VM share is mounted read-only in the guest, and only the host writes it). Windows keeps the copy. The post-script comments may note that re-running them refreshes the account id after a host workspace switch.
- **Proxy stack**: no change to the `chatgpt.com` gate or credential injection.
- **ADR**: this amends ADR 0002 ("Host credentials are injected at the proxy; the guest holds only placeholders"), which now also covers the Codex/Pi placeholder mounts formerly in ADR 0018. Add a consequence covering: the Codex CLI's placeholder mount carries the real ChatGPT account id, because Codex ≥0.156 checks it against routing discovery; the account id is an identifier, not a credential, so the guest still holds no usable credential; Pi's mount keeps the placeholder id; and the rejected alternatives. The title's claim still holds for credentials. No `CONTEXT.md` change is needed. The account id is not a placeholder credential, and the **Placeholder credential** and **Placeholder mount** definitions still hold.

## Testing Decisions

- Tests assert externally observable behavior at the highest stable interface: generated files, proxy-stack artifacts, and what the guest reads. They don't assert internal call sequences.
- **`unit`, Codex auth sanitizer** (extend the existing sanitizer test): `account_id` is preserved, the three tokens become placeholders, and non-chatgpt-mode input is still refused.
- **`unit`, credential channel** (extend the existing credential channel test, using its fake reader and writer): the account-id-changed hook fires on the startup read; fires when a later read has a different account id; does not fire when only the token or expiry changes; does not fire when a read fails.
- **`cli`, `init`** (extend the existing init CLI test): both shared `auth.json` files contain the fixture's real `tokens.account_id` and placeholder tokens.
- **`proxy-stack`, stack lifecycle** (extend the existing lifecycle test, which already runs `init` then `run-hosting` with a codex `auth.json`):
  - Starting from a shared `auth.json` that holds the placeholder id (the pre-change state of an environment), run-hosting's startup rewrites both shared copies with the host's account id.
  - After the host `auth.json`'s `account_id` changes, both shared copies are rewritten.
- **`guest`, Linux e2e** (extend the existing `01-auth-config` symlink assertion): the guest reads the host's real `tokens.account_id` through `~/.codex/auth.json`.
- Existing fixtures and tests that assume the shared `auth.json` carries the placeholder account id are updated to expect the real one.
- The Windows guest tier is not extended: the Windows copy path doesn't change.

## Out of Scope

- Rewriting the `accounts/check` response (or any other response body) in the proxy stack.
- Pinning or downgrading the Codex CLI version in guest templates.
- Changing the Pi Coding Agent's placeholder mount.
- Automatically refreshing a Windows guest's copied `~/.codex/auth.json` after a host workspace switch; the user re-runs `01-auth-config.ps1`.
- Supporting Codex's `forced_chatgpt_workspace_id` or multi-workspace selection beyond "whatever account id the host's `auth.json` holds".
- The `cli_auth_credentials_store = "file"` setting in a guest's `config.toml`. It was a local fix for a dummy API key entered during setup, not part of this change.

## Further Notes

- The `init` path and the run-hosting path must produce byte-identical shared `auth.json` for the same host input, which means both go through the one sanitizer.
- Existing environments migrate without a manual step: their shared `auth.json` still holds the placeholder id until `run-hosting` next starts, and the startup hook rewrites it.
