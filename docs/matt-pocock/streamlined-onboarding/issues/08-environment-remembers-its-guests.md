# An environment remembers its guests

Type: grilling
Status: open
Blocked by: 07

## Question

Does an environment persist a record of the guests set up against it, so that rerunning a setup-guest
command stops re-asking what it already knows? If so, what is that record called, what does it hold,
and where does it live?

Half of "go straight to setup-guest" is a documentation problem. The other half is that
`setup-guest-unix` interrogates the user on **every single run**. `src/guestSetup/setupAnswers.ts`
resolves the VM name and connection answers; `setup-guest.md` lists the prompts and the flags that
suppress them:

| Flag | Answers |
| --- | --- |
| `--vm-name <name>` | Hyper-V VM name |
| `--guest-address <host>` | Guest address (hostname or IP) |
| `--guest-username <user>` | Guest username |
| `--share-name <name>` | SMB share name |
| `--share-account <name>` | Share account name |

Each flag suppresses only its own prompt, and the share password is always prompted. Reruns are the
normal case, not the exception — `setup-guest.md` presents "just rerun the whole command" as the
supported recovery path after a failure, so the prompt burden is paid repeatedly.

**This introduces persisted per-guest state that the domain model has no word for.** `CONTEXT.md`
defines **Guest** as a role an untrusted VM plays — "an untrusted Windows or Ubuntu virtual machine
in which coding agents and development tools run" — not as a record an environment keeps. The
closest existing precedent is **Guest role**, but that is explicitly scoped to the guest test tier:
"one disposable guest identity within the guest test tier, from which its VM name, differencing
disk, diagnostic channel, and artifacts directory all derive." A production concept would need a
distinct term, and picking one that does not collide with **Guest role** is part of this ticket.

Questions a resolution must settle:

- **What is remembered**, and what is deliberately not. The share password must not be, by the same
  logic that keeps real secrets out of guests.
- **Where it lives.** `.susentorno` is source-controlled except what its `.gitignore` excludes
  ([ADR 0013](../../../adr/0013-user-customizable-committable-environment.md)). A guest record names
  a VM on one particular machine, which argues for the ignored side; sharing an environment's guest
  layout with a collaborator argues for the committed side. Decide, and say why.
- **How a guest is addressed** on rerun — by VM name, by a user-chosen nickname, or positionally.
- **What happens when the record disagrees with reality** (VM renamed, deleted, or recreated). The
  hard-fail rule applies, but the message has to distinguish "you have no such guest" from "your
  record is stale."
- **Whether flags still override**, and whether a first run for an unknown guest prompts at all, or
  requires flags. The no-inline-prompt rule was framed around *missing manual prerequisites*; asking
  a user to name their VM on first setup is a different category, and the resolution should say so
  explicitly rather than leave it implied.
- **The term itself.** Propose it, check it against `CONTEXT.md`'s existing entries and their
  _Avoid_ lists, and add it to `CONTEXT.md` when resolved.

Blocked by ticket 07 because a per-guest record has to live inside a specific environment, and
where an environment is found is that ticket's question.
