# 19: Document `setup-guest-windows` for users

**What to build:** The Windows section of `setup-guest.md` is rewritten around the command, so users follow one documented path instead of the manual console procedure. See the spec's "Further Notes" and ticket 08's documentation list.

- **Prerequisites:**
  - a Windows 11 Enterprise x64 25H2 guest, installed and fully updated;
  - one adapter on the Default Switch;
  - an existing local-administrator guest user account;
  - the host network, SMB share, and VM share account;
  - an elevated host terminal;
  - `run-hosting` running.
- The flags, their defaults, and the prompt order, including the two masked passwords and the paired re-prompts.
- The difference between the guest user account and the VM share account, and the two retained address-keyed share credentials, which users can inspect with `cmdkey /list`.
- What rerunning does: a replay from the Default Switch. It isn't a resume and it doesn't roll back. Customized steps must therefore be idempotent.
- How to read the residual-state footer, and the "restart the guest, then rerun" remediation for a pending reboot.
- Remove the manual `Set-ExecutionPolicy`, `cmdkey`, script-by-script, and "open a new terminal" guidance.

**Blocked by:** 17

**Status:** ready-for-agent

- [ ] `setup-guest.md` describes only the command-driven Windows path, and every documented flag, default, and prompt matches the command's help and behavior.
- [ ] No remaining documentation tells users to change the guest's persistent execution policy or run shipped Windows steps by hand.
