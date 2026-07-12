# VM e2e Suite Under WSL Mirrored Networking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm test:vm` run green with WSL in mirrored networking mode, with the machine requirements enforced by fail-fast preflight guards instead of tribal knowledge.

**Architecture:** No product code changes. One machine-config change (`.wslconfig` `ignoredPorts` exempts UDP 67 from mirrored-mode port sharing so dnsmasq's wildcard DHCP bind succeeds), two preflight guards in `tests/vm/vm.test.ts` (networking-mode assertion + an empirical wildcard UDP:67 bind probe), and documentation updates. Implementation is spike-first: Task 1 demonstrates every claimed port conflict on the machine before any test code changes.

**Tech Stack:** WSL2 (mirrored networking), dnsmasq/socat inside WSL, Vitest (`tests/vm/`), PowerShell on the Windows side.

**Spec:** `docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md`

## Global Constraints

- WSL stays in **mirrored** networking mode (user decision; do not switch to NAT).
- No changes to `src/` — run-proxy and the gateway are out of scope.
- DHCP stays on port 67 (fixed by RFC 2131; the guest's systemd-networkd client has no nonstandard-port option).
- Commit directly to `main` (repo convention — no feature branches).
- Commit messages are detailed and narrative for non-trivial changes (why + evidence), per repo convention.
- `%USERPROFILE%` is `C:\Users\username`; the repo is `C:\code\fschwiet-agent`.
- **Fallback rule:** if the spike (Task 1) or the full run (Task 4) hits a failure `ignoredPorts` cannot cover — most plausibly guest egress misbehaving under mirrored routing — STOP, report to the user, and do not improvise; the fallback design (network namespace isolation) is a separate plan.

---

### Task 1: Spike — apply `ignoredPorts` and demonstrate every bind

Machine configuration only — no repo file changes, no commit. The evidence gathered here (especially Step 1's failing probe) is the spec's demonstration that the Task 2 port guard fires in the broken state.

**Files:**
- Modify: `C:\Users\username\.wslconfig` (machine config, not in the repo)

**Interfaces:**
- Consumes: `tests/vm/harness/{net.sh,forward.sh,cleanup.sh}` as-is.
- Produces: a working machine state (port 67 bindable in WSL) and the final `ignoredPorts` list that Task 2's guard message and Task 3's docs must name. If the list grows beyond `67`, adjust those tasks' text to match and note it in their commit messages.

- [ ] **Step 1: Demonstrate the pre-fix failure (this is the port guard's fire evidence)**

Run (PowerShell):

```powershell
wsl.exe -u root -e bash -c "timeout 1 socat -u UDP4-RECVFROM:67 /dev/null 2>&1; echo exit=`$?"
```

Expected: a socat error containing `Address already in use` and `exit=1`. Save the exact output — it goes in the Task 2 commit message as evidence the probe detects the broken state. (socat is guaranteed present: `setup-wsl.sh` installs it.)

- [ ] **Step 2: Add `ignoredPorts` to `.wslconfig`**

Current content of `C:\Users\username\.wslconfig` is exactly:

```ini
[wsl2]
networkingMode = mirrored
```

Append the experimental section (PowerShell):

```powershell
Add-Content -Path "$env:USERPROFILE\.wslconfig" -Value "`n[experimental]`nignoredPorts=67"
```

Then verify the file reads:

```ini
[wsl2]
networkingMode = mirrored

[experimental]
ignoredPorts=67
```

- [ ] **Step 3: Restart WSL and confirm mode survived**

`wsl --shutdown` kills every running WSL session **including Docker Desktop's backend distro** — expect Docker to need a moment (or a manual restart) afterward.

```powershell
wsl.exe --shutdown
wsl.exe wslinfo --networking-mode
```

Expected: `mirrored`.

- [ ] **Step 4: Confirm Docker recovered**

```powershell
docker info --format '{{.ServerVersion}}'
```

Expected: a version string. If it errors, start Docker Desktop and poll until it answers:

```powershell
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
# then re-run `docker info --format '{{.ServerVersion}}'` every ~10s until it prints a version
```

- [ ] **Step 5: Re-run the probe — port 67 must now bind**

```powershell
wsl.exe -u root -e bash -c "timeout 1 socat -u UDP4-RECVFROM:67 /dev/null 2>&1; echo exit=`$?"
```

Expected: `exit=124` (bind succeeded; timeout killed socat while it waited for a packet). `exit=0` also counts as success (a stray DHCP packet arrived within the second). Any other outcome: STOP per the fallback rule.

- [ ] **Step 6: Demonstrate the real dnsmasq bind (the step that originally failed)**

```powershell
wsl.exe -u root -e bash -c "bash /mnt/c/code/fschwiet-agent/tests/vm/harness/net.sh up && bash /mnt/c/code/fschwiet-agent/tests/vm/harness/net.sh dhcp gateway"
```

Expected: `net: cfgmbr0 up at 10.213.87.1` then `net: dhcp mode gateway` with **no** `failed to bind DHCP server socket` error. This also demonstrates the port-53 DNS bind (gateway mode sets `port=53` on `10.213.87.1`); confirm both sockets:

```powershell
wsl.exe -u root -e bash -c "ss -ulpn | grep -E ':(53|67) ' "
```

Expected: dnsmasq lines for `0.0.0.0:67` and `10.213.87.1:53`.

- [ ] **Step 7: Demonstrate the socat forwarder binds (possible collision with Windows wildcard :80/:443 listeners)**

```powershell
wsl.exe -u root -e bash -c "bash /mnt/c/code/fschwiet-agent/tests/vm/harness/forward.sh up 127.0.0.1 18080 18443 && systemctl is-active cfgm-fwd-80.service cfgm-fwd-443.service && ss -tlpn | grep 10.213.87.1"
```

Expected: `forward: 10.213.87.1:80 -> 127.0.0.1:18080, ...`, two `active` lines, and socat listeners on `10.213.87.1:80` and `10.213.87.1:443`. (Nothing needs to listen on the Windows 18080/18443 side — socat connects onward only when a client arrives, so the listen-side bind is testable alone.) If either unit is `failed` with an address-in-use error in `journalctl -u cfgm-fwd-80`, add `,80,443` to `ignoredPorts` in `.wslconfig`, repeat Steps 3–5, and re-run this step; record the final list for Tasks 2–3.

- [ ] **Step 8: Tear the spike network down**

```powershell
wsl.exe -u root -e bash -c "bash /mnt/c/code/fschwiet-agent/tests/vm/harness/cleanup.sh"
```

Expected: cleanup output, no errors. Machine is left configured (`.wslconfig` keeps the new section) but with no harness network state.

---

### Task 2: Preflight guards + stale comment in `tests/vm/vm.test.ts`

**Files:**
- Modify: `tests/vm/vm.test.ts:19-23` (stale `ENVOY_HOST` comment) and `tests/vm/vm.test.ts:56-58` (guards at the top of `beforeAll`)

**Interfaces:**
- Consumes: `wslExec(script, { reject: false })` from `tests/vm/wsl.ts` — returns an execa result with `.stdout` and `.all` (the harness runs everything WSL-side as root, so the probe needs no sudo).
- Produces: nothing consumed by later tasks; Task 4 exercises these guards implicitly.

There is no cheap failing-test cycle here: the guards *are* test infrastructure, and their only true exercise is the full `pnpm test:vm` run (Task 4). The broken-state behavior of the port probe was already demonstrated empirically in Task 1 Step 1. What this task verifies directly: typecheck/lint/format pass, and the guard messages render correctly on the throw paths (Step 3).

- [ ] **Step 1: Replace the stale `ENVOY_HOST` comment**

In `tests/vm/vm.test.ts`, replace lines 20–22:

```ts
// Docker Desktop's WSL integration republishes container ports on localhost
// inside integrated distros. If that is off, point this at the Windows host
// IP as seen from WSL instead.
```

with:

```ts
// Under WSL mirrored networking (required — see the beforeAll guards), WSL
// shares the Windows localhost, so the gateway's 127.0.0.1 listener is
// directly reachable. Override only for unusual setups.
```

(The old comment described Docker Desktop republishing Docker-published container ports — a mechanism the blue-green redesign removed when the listener became a plain Windows process.)

- [ ] **Step 2: Add the two guards at the top of `beforeAll`**

In `tests/vm/vm.test.ts`, the `beforeAll` currently begins:

```ts
beforeAll(async () => {
  await harness('cleanup.sh'); // stale bridges/guests from a killed run
  stack = await startProxyStack();
```

Insert the guards between `cleanup.sh` and `startProxyStack()` — after cleanup (so a stale harness dnsmasq can't fake a conflict) and before the expensive stack start:

```ts
beforeAll(async () => {
  await harness('cleanup.sh'); // stale bridges/guests from a killed run

  // Guard: mirrored networking is required. Under NAT mode WSL cannot reach
  // run-proxy's gateway at all — it is a plain Windows process on loopback,
  // and only mirrored mode shares the Windows localhost with WSL. See
  // docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md.
  const mode = await wslExec('wslinfo --networking-mode', { reject: false });
  if (mode.stdout.trim() !== 'mirrored') {
    throw new Error(
      `WSL networking mode is '${mode.stdout.trim()}', not 'mirrored'. ` +
        `In %USERPROFILE%\\.wslconfig set [wsl2] networkingMode=mirrored, ` +
        `then run 'wsl --shutdown' (Docker Desktop will need to restart).`,
    );
  }

  // Guard: mirrored mode pools WSL's ports with Windows', and Windows' own
  // Hyper-V Default Switch DHCP holds port 67 — dnsmasq's wildcard DHCP bind
  // fails unless .wslconfig exempts the port from sharing. Probe the actual
  // bind instead of parsing .wslconfig: that also catches the setting being
  // present but not applied yet, or dropped by a future WSL update.
  // exit=124: bind ok, timeout expired waiting for a packet (the normal case).
  // exit=0: bind ok, a stray packet arrived within the second.
  const probe = await wslExec(
    'timeout 1 socat -u UDP4-RECVFROM:67 /dev/null 2>&1; echo exit=$?',
    { reject: false },
  );
  if (!/exit=(124|0)\b/.test(probe.stdout)) {
    throw new Error(
      `WSL cannot bind UDP 0.0.0.0:67, so dnsmasq's DHCP bind will fail (got: ${probe.all}). ` +
        `In %USERPROFILE%\\.wslconfig add:\n[experimental]\nignoredPorts=67\n` +
        `then run 'wsl --shutdown' (Docker Desktop will need to restart).`,
    );
  }

  stack = await startProxyStack();
```

If Task 1 Step 7 grew the `ignoredPorts` list, name the full list in the second error message.

- [ ] **Step 3: Verify both throw paths render a sane message**

Run this scratch check (PowerShell, from the repo root) — it replicates each guard's conditional against a canned bad input and prints the message a user would see:

```powershell
node -e "const mode='nat'; if (mode.trim() !== 'mirrored') console.log(new Error(\"WSL networking mode is '\" + mode.trim() + \"', not 'mirrored'. In %USERPROFILE%\\.wslconfig set [wsl2] networkingMode=mirrored, then run 'wsl --shutdown' (Docker Desktop will need to restart).\").message)"
node -e "const stdout='... socat E bind(...): Address already in use exit=1'; if (!/exit=(124|0)\b/.test(stdout)) console.log('port guard fires, as it must, on: ' + stdout)"
```

Expected: the first prints the full mode-guard message naming `nat`; the second prints the fires-line. Also confirm the regex does NOT fire on success inputs: change `exit=1` to `exit=124` in the second command and expect no output.

- [ ] **Step 4: Typecheck, lint, format**

```powershell
pnpm typecheck && pnpm lint && pnpm format:check
```

Expected: all pass (verified script names — package.json defines `typecheck`, `lint`, and `format:check`).

- [ ] **Step 5: Commit**

```powershell
git add tests/vm/vm.test.ts
```

Then commit with a narrative message covering: the two guards and why probing beats parsing `.wslconfig`; the Task 1 Step 1 evidence (paste the actual failing-probe output) showing the port guard's signal detects the real broken state; and the comment rewrite (Docker-published-port republishing no longer exists post blue-green).

---

### Task 3: Document the machine requirement in `technical-notes.md`

**Files:**
- Modify: `technical-notes.md:49` (the one-time WSL setup paragraph)

**Interfaces:**
- Consumes: the final `ignoredPorts` list from Task 1.
- Produces: nothing; documentation only.

- [ ] **Step 1: Extend the one-time-setup paragraph**

In `technical-notes.md`, replace line 49:

```markdown
One-time WSL setup: `wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/vm/<timestamp>/`.
```

with:

```markdown
One-time WSL setup: `wsl.exe -u root bash <repo>/tests/vm/harness/setup-wsl.sh`; the first run then builds a golden image (~10-20 min, cached in `/root/.cache/configamatron-vmtest`). WSL must use **mirrored networking** (`%USERPROFILE%\.wslconfig`: `[wsl2] networkingMode=mirrored`) — the gateway is a plain Windows loopback listener, reachable from WSL only in that mode — and `[experimental] ignoredPorts=67` must exempt the DHCP port from mirrored port sharing, since Windows' Hyper-V Default Switch DHCP already holds port 67 and dnsmasq needs a wildcard bind (RFC 2131 fixes the port; `bind-interfaces` scopes only DNS sockets). Both requirements are enforced by fail-fast guards in `tests/vm/vm.test.ts`'s `beforeAll`; changes take effect after `wsl --shutdown` (Docker Desktop restarts too). On failure, diagnostics (serial console, guest journal, route/NAT/resolver dumps) land in `test-results/vm/<timestamp>/`. See `docs/superpowers/specs/2026-07-12-vm-test-wsl-mirrored-networking-design.md`.
```

If Task 1 grew the `ignoredPorts` list, write the actual final list instead of `67`.

- [ ] **Step 2: Format check**

```powershell
pnpm format:check
```

Expected: pass (run `pnpm format` first if prettier wants to rewrap the paragraph).

- [ ] **Step 3: Commit**

```powershell
git add technical-notes.md
git commit -m "docs: record WSL mirrored-mode + ignoredPorts requirements for test:vm"
```

---

### Task 4: Full verification run

**Files:** none modified.

**Interfaces:**
- Consumes: everything above; the machine state from Task 1.

- [ ] **Step 1: Fast pipeline**

```powershell
pnpm test
```

Expected: all green (format, lint, typecheck, unit, build, e2e, integration). Docker must be running.

- [ ] **Step 2: The VM suite — the deliverable**

```powershell
pnpm test:vm
```

Expected: fully green (budget 30–60 min; golden image is already cached). This exercises both guards on their success paths, dnsmasq under `ignoredPorts`, the socat forwarders, guest egress through MASQUERADE under mirrored routing (the least-charted claim — if egress fails here, STOP per the fallback rule), and the full S1–S3 + S2b/S2c scenario set. On failure, diagnostics land in `test-results/vm/<timestamp>/` — include the relevant excerpt in any report rather than paraphrasing.

- [ ] **Step 3: Report**

Summarize to the user: the final `ignoredPorts` list, the spike evidence (before/after probe outputs), and the green `pnpm test` + `pnpm test:vm` results. Note that `temp.md` (the untracked session-handoff note this work came from) is now superseded by the spec, plan, and commits — suggest deleting it, but leave that to the user.
