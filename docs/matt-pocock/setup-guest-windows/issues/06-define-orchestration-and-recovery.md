# Define end-to-end orchestration and recovery

Type: grilling
Status: resolved
Blocked by: 03, 04, 05, 09

## Question

What is the exact phase machine for a complete `setup-guest-windows` run, and what state is intentionally left after failure at each boundary?

Place preflight, reconciliation to the Default Switch, VM startup, PowerShell Direct readiness and elevation checks, ambient-trust propagation, setup-phase share access, pre-isolation scripts, `run-hosting` readiness, isolation, post-restart PowerShell Direct readiness, isolated-phase share access, and post-isolation scripts in an explicit order. Decide timeout and progress behavior, credential cleanup, whether any failure triggers rollback, and what rerunning from each possible residual state does.

The settled retry rule is a complete replay through the Default Switch, not phase detection or resume. The answer must say how that rule remains predictable when the VM begins off, running, already isolated, or left midway by a prior failure.

## Answer

A run is one linear **phase machine**. It never detects or resumes a prior run's phase. Every run begins by reconciling the VM to the Default Switch, and every failure stops in place with no rollback. The predictability comes from three rules: all prompts precede any trust or provisioning mutation; each boundary leaves a nameable, observable residual state; and every residual state is a valid starting state for the next complete replay.

### Phase machine

| # | Phase | Guest mutation |
| --- | --- | --- |
| H1 | Host prerequisites from ticket 01: elevation, environment and Windows VM share, isolation name, NAT adapter alias, both switches and host IPv4 addresses. Prompt for a missing VM name and share name. | – |
| H2 | Host checks: VM exists, is `Running` or `Off` with exactly one adapter on an expected switch; the SMB share resolves to this environment's Windows VM share; `run-hosting` DHCP and DNS listeners are bound. Discover and validate both phase plans (ticket 04): filenames, ordering, exactly one `configure-network`. | – |
| H3 | Prompt `Windows development user` and masked `Guest password`. | – |
| G1 | Reconcile to the Default Switch and start (see below). | power, switch |
| G2 | PowerShell Direct readiness and authentication through a new credential-scoped executor. Authentication rejection disposes it and returns to H3 (paired re-prompt, EOF exits cleanly). | – |
| G3 | Guest structural checks: supported guest platform, enabled local Administrators member, elevated token, no pending-reboot marker, and a discoverable, usable WinGet at the supported version with a usable source. | – |
| G4 | Prompt `VM share account` and masked `VM share password`. Host-check the account and its share read access. Replace and verify the Default-Switch VM share credential (ticket 03), with the paired SMB re-prompt loop. | Credential Manager |
| G5 | Windows guest trust reconciliation (ticket 05). | trust store, managed trust files, `NODE_EXTRA_CA_CERTS` |
| G6 | Run pre-isolation steps from `\\<default-switch-host-ip>\<share>\pre-scripts` (ticket 04). Close the selected-share connection. | provisioning |
| G7 | Isolation gate: no pending-reboot marker, and `run-hosting` listeners still bound. | – |
| G8 | Replace the Internal-switch VM share credential, marked unverified. | Credential Manager |
| G9 | Isolate: graceful stop, confirm `Off`, connect the adapter to the selected Internal switch, start. | power, switch |
| G10 | PowerShell Direct readiness with the **same** executor. Authentication rejection here is structural, not a re-prompt. | – |
| G11 | Isolated-network readiness (below). | – |
| G12 | Establish and verify Internal-switch UNC share access (ticket 03). | – |
| G13 | Run post-isolation steps from `\\<internal-switch-host-ip>\<share>\post-scripts`. Close the selected-share connection. | provisioning |
| G14 | Dispose the executor and print the success summary. | – |

Plan discovery sits in H2 so a malformed generated share fails before either secret is requested. G8 is deliberately late: ticket 03's delete-then-write for the Internal-switch target happens only once isolation is imminent, so a replay whose pre-isolation step fails does not discard a previously verified Internal-switch entry.

### VM starting states (G1)

- `Off` on either expected switch: connect to the Default Switch if needed, then start.
- `Running` on the selected Internal switch: graceful stop, confirm `Off`, connect, start.
- `Running` on the Default Switch: reuse without restarting, matching `setup-guest-unix`. G3's pending-reboot check and ticket 03's close-and-recreate share handling cover state left by an earlier run.
- Saved, paused, or transitional state, a disconnected adapter, an unrelated switch, or extra adapters: fail with remediation (ticket 01).

The Windows graceful stop allows about 3 minutes for `Stop-VM`, then up to 60 seconds of polling to confirm `Off`. This replaces the Unix defaults of 60 and 30 seconds. Failing to reach `Off` fails the phase. The command never force-stops the VM.

### Deadlines

Deadlines are fixed defaults with no flags, and there is no overall command deadline:

| Wait | Deadline |
| --- | --- |
| PowerShell Direct readiness after a start (G2, G10) | 5 minutes, probing about every 5 seconds |
| Each structural-check or trust-reconciliation invocation | 2 minutes |
| Each share replacement/verification | 1 minute |
| Each pre- or post-isolation step | 30 minutes |
| Isolated-network readiness (G11) | 3 minutes, polled |
| Graceful stop / confirm off | about 3 minutes / 60 seconds |

The customization README documents the 30-minute per-step limit.

### Isolated-network readiness (G11)

Before verifying the share, poll through the executor until all three hold:

1. the guest adapter holds a DHCP lease in `run-hosting`'s subnet with the Internal-switch host IP as default gateway;
2. the guest's DNS server is the host and a lookup of a known name succeeds; and
3. the guest can open a TCP connection to the proxy stack at the Internal-switch host IP.

Expiry is a structural failure that names the unmet condition and points at `run-hosting`. Positive egress to an allowed destination is left to the post-isolation steps, which exercise it (for example, GitHub authentication). Proving that no direct Internet route exists is a guest-tier test assertion, not a setup check.

### Reboot boundary

The first version never reboots the guest. A pending-reboot marker at G3 or G7 fails with the remediation "restart the guest, then rerun". G7 guarantees the command never isolates a guest with a pending reboot. If guest-tier testing proves a supported installer unavoidably needs a reboot, the sanctioned extension is a controlled Default-Switch reboot followed by PowerShell Direct readiness and replay of the complete pre-isolation plan, never resumption after the individual step (ticket 09).

### Progress and failure reporting

- Each phase announces `setup-guest-windows: <phase>...`.
- Readiness and stop waits print an elapsed-time heartbeat about every 15 seconds.
- Steps keep ticket 04's announce-then-emit-captured-output contract.
- Every failure prints a **residual-state footer**: the failed phase (and step filename, if any); the VM's actual queried power state and switch; which VM share credentials this run left verified and which it removed; and the instruction to rerun `setup-guest-windows` to replay from the Default Switch. The footer queries Hyper-V after the failure instead of inferring state.
- Exit code `1` for any failure, `130` for cancellation.

### Failure, cancellation, and cleanup

Nothing rolls back: no VM stop or switch-back, no trust removal, no undoing of provisioning. On handled failure, cleanup is exactly ticket 03's: close any open selected-share connection, and remove any VM share credential written by this run that has not passed verification. Verified entries stay. The executor is always disposed in `finally`.

On Ctrl+C, abort the in-flight executor invocation (ticket 02 reaps the guest child under supervision). Then run the same cleanup, bounded to about 30 seconds, print the residual-state footer, and exit `130`. A second Ctrl+C skips remaining cleanup and exits immediately. Cancellation mid-isolation may leave the VM `Off`, or still stopping, with its adapter on either switch; G1 of the next run handles every such state except a transitional one, which fails with a "wait, then rerun" remediation.

### Residual state and rerun

| Failure boundary | Residual state | Next run |
| --- | --- | --- |
| H1–H3, G1–G3 | VM unchanged, or started on the Default Switch; no credential or trust change | Full replay; G1 reuses or starts the VM |
| G4 | Default-Switch VM share credential removed if unverified | Full replay rewrites it |
| G5 | Imported roots and valid managed PEMs retained; the previous Node bundle stays active unless publication completed (ticket 05) | Replay re-snapshots and converges |
| G6 | Partial provisioning from steps before the failed one | Replay reruns every step; steps must be idempotent |
| G7 | Provisioned guest on the Default Switch with a pending reboot or no `run-hosting` | User restarts the guest or `run-hosting`; full replay |
| G8–G9 | Internal-switch entry removed if unverified; VM `Running` or `Off` on either switch | G1 stops or reconnects as needed; full replay |
| G10–G12 | VM running on the Internal switch; unverified Internal-switch entry removed | G1 stops and returns to the Default Switch; full replay |
| G13 | Isolated guest with partial post-isolation provisioning; both entries verified | Full replay, including the pre-isolation steps |

A successful run's end state (running on the Internal switch, both entries verified, trust reconciled) is itself a valid starting state, so a deliberate rerun on a completed guest follows the same replay path.
