# Handoff: verifier script defects

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Blocked on:** nothing. All four are small, independent, and fixable without a guest.
**Resolved:** 2026-07-25. All four defects below were fixed per
`docs/honist-v/specs/2026-07-25-verifier-script-defects-design.md` and
`docs/honist-v/plans/2026-07-25-verifier-script-defects.md`.

## What this is

Four defects in the three verifier scripts, all found while running the Ubuntu
guest checkpoint (2026-07-24) rather than by reading them. Full results are in
`docs/honist-v/specs/2026-07-22-host-side-dns-consolidation-design.md` →
"Validation results — Ubuntu guest checkpoint (2026-07-24)".

None of them broke the checkpoint. What they share is worse than that: each one
makes a verifier **report something untrue**, in a situation a first-time user is
more likely to hit than an experienced one.

Firewall-driven additions to `verify-proxy.ps1` are deliberately *not* here — see
`2026-07-25-host-firewall-confinement.md`, which owns both the assertions and the
reasons for them.

## 1. `verify-proxy.ps1` audits whichever environment you happen to be standing in

`.configamatron/proxy/verify-proxy.ps1:25`

```powershell
[string]$EnvDir = (Get-Location).Path,
```

Run by absolute path from the repo checkout while `run-proxy` was serving
`c:\vm-isolated`, it audited `C:\code\configamatron\.configamatron\proxy` and
reported **4 failures**, headlined by:

```
FAIL  SDS secret matches current host credential -- token drift -- run-proxy is serving a stale token; restart it
```

Every one was an artifact of comparing one environment's config against another
environment's running Envoy. The same command from `c:\vm-isolated` was **24
passed, 0 failed**.

**Why this one matters most.** The Docker checks pass either way, because
container names are global — so the script confirms Envoy is up, then compares it
against config it does not belong to, and blames the credential. The message is
confidently wrong and prescribes a fix (restart the proxy) that will not help and
will interrupt a working guest.

**Suggested fix:** cross-check ownership rather than trusting cwd — the running
container's mounted config path is discoverable, so fail loudly when the Envoy
found does not belong to `$EnvDir`. Defaulting `$EnvDir` to the script's own
location (`$PSScriptRoot\..`) is a smaller change but only narrows the window,
since the deployed script legitimately lives inside the environment it checks.

## 2. `verify-config.sh` DNS assertions pass for the wrong reasons

Both are one coincidence away from being wrong, and both would pass a guest that
was misconfigured in a specific plausible way.

**`templates/vm-shared/verify-config.sh:121`** — `getent hosts`:

```bash
resolved="$(getent hosts example.com 2>/dev/null | awk '{print $1}' | head -n1)"
```

`getent hosts` lists AAAA first. This reads the right field **only because** the
host responder answers AAAA with NOERROR and zero records, so no AAAA line
exists. The VM harness already had to abandon this exact call for `ahostsv4`
(`tests/vm/vm.test.ts:119`) when its dnsmasq lacked `no-resolv` and real AAAA
answers appeared. The guest is one responder change away from the same bug.

**`templates/vm-shared/verify-config.sh:128`** — substring resolver match:

```bash
if [ -n "$host_ip" ] && resolvectl dns 2>/dev/null | grep -q "$host_ip"; then
```

`grep -q "192.168.67.1"` also matches `192.168.67.164`. A guest pointed at
**itself** as resolver would PASS this check. That is not hypothetical: `.164` is
the address this guest actually holds.

**Suggested fix:** `getent ahostsv4`, and an anchored match on the resolver value
rather than a substring of the whole `resolvectl dns` output.

## 3. `verify-config.ps1` has no host-IP discovery, but the docs say it does

`templates/vm-shared-windows/verify-config.ps1:17`

```powershell
if ($HostIp) { Ok "using host IP $HostIp" } else { Bad 'host IP supplied' 'pass the Internal-switch host IP' }
```

There is no discovery branch at all — omitting the argument is a **guaranteed
FAIL**. But `usage-hyper-v.md:266` says:

> Omit the host IP to have the script discover and report it from the installed config.

The `.sh` does discover (verified working in both branches at the checkpoint).
The `.ps1` never did, and the sentence covers both.

**Found by reading, not running** — `sus-windows` was powered off throughout, so
this is the one item here with no execution behind it. Everything else in that
script looks current: `47651a5` did fix its credential gate to `/v1/models` with
`>= 400`, and its inverted check for the removed DNS-responder task is present.

**Suggested fix:** decide which is true. Adding discovery is the better outcome
and the `.sh` shows the shape, but the Windows guest has no default-route
equivalent already in use — so correcting the doc is legitimate if discovery isn't
wanted. Do not leave them contradicting each other.

## 4. The `pypi.org/simple/` check fails on exactly the first run

- `templates/vm-shared/verify-config.sh:184` (`--max-time 30`)
- `templates/vm-shared-windows/verify-config.ps1:46` (`30`)
- the equivalent check in `verify-proxy.ps1`

That document is **44 MB**. Measured in the guest: warm it fetches in ~3.4 s at
~13 MB/s, but a cold first fetch exceeds 30 s and curl returns 28 (timeout) after
the 200 header has arrived — so the failure reads `code=200 curlExit=28`, which
looks like a proxy defect and is not one.

Observed on the **first** run in the guest and the **first** run on the host, then
never again. The first run is the one a new user performs and the one a checkpoint
records.

**Suggested fix:** stop downloading 44 MB to prove a passthrough works. `https://pypi.org/`
is 22 kB and exercises the same path, or keep the URL and discard the body.

## What is deliberately NOT here

- The `getent hosts` / `resolvectl` issues in the **harness** — already fixed
  there (`tests/vm/vm.test.ts`, `ahostsv4` at all four call sites).
- Anything about the credential gate contract. It is correct in both verifiers now
  and was validated end to end on both guests.
