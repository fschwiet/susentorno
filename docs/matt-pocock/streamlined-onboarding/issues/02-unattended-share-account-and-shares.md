# What of the share account, its rights, and the SMB shares can be created unattended

Type: research
Status: open
Blocked by: —

## Question

`setup-environment.md` currently asks the user to perform four host operations by hand. Which of
them can a command perform non-interactively, and which genuinely require a human?

The answer moves each step across the line drawn while charting — **auto-create** (derivable, needs
no secret and no GUI) versus **detect-and-fail** (needs a human, so the command errors naming the
exact missing step). Ticket 06 turns that line into an inventory; this ticket supplies the facts it
needs, and is the only AFK ticket on the map.

The four operations, as `setup-environment.md` states them today:

1. `New-LocalUser -Name "susentorno" -Password $pw -PasswordNeverExpires -UserMayNotChangePassword`,
   where `$pw` comes from `Read-Host -AsSecureString`.
2. In `secpol.msc` → Local Policies → User Rights Assignment, adding the account to **Deny log on
   locally** and **Deny log on through Remote Desktop Services**.
3. In Computer Management, setting the account's group membership to `Users` and nothing else.
4. `New-SmbShare` for `vm-shared-linux` and `vm-shared-windows`, each granting the share account
   read access.

Specific things to establish:

- **Can `secedit` apply User Rights Assignment non-interactively?** It was asserted while charting
  that step 2 needs the GUI; that assertion is unverified and `secedit /export` + `/configure` with
  an INF template is the obvious counter-example. Confirm against primary Microsoft documentation,
  including whether it is safe against concurrent policy edits and what it does to rights already
  assigned to other principals — a User Rights Assignment line in an INF is a *replacement* set, not
  an addition, which is the failure mode to check for.
- **Does the account password have to come from a human?** A generated password stored on the host
  would remove a prompt, but the guest also needs it (`/etc/susentorno-share.cred` on Ubuntu,
  `cmdkey` on Windows). Establish whether there is any supported way to avoid a human-known secret
  here, given that guest-side storage is by definition untrusted.
- **What `New-SmbShare` requires**, including behaviour when the share name already exists, and
  whether changing an existing share's path or ACL is possible idempotently or needs a remove-first.
- **Isolation-name interaction.** `create-host-network --isolation-name <name>` implies a
  `susentorno-<name>` account, and Windows caps a local account name at 20 characters — about nine
  for the isolation name. Confirm the cap and whether anything else in the chain is length-bound.

Record findings as a Markdown file in the repo and link it from this ticket's answer.
