# Design: fix four verifier script defects

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Source:** `docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md`

## Problem

Three verifier scripts (`.configamatron/proxy/verify-proxy.ps1`,
`templates/vm-shared/verify-config.sh`, `templates/vm-shared-windows/verify-config.ps1`)
have four defects, found while running the Ubuntu guest checkpoint (2026-07-24)
rather than by reading them. None broke that checkpoint. What they share is worse:
each makes a verifier **report something untrue**, in a situation a first-time user
is more likely to hit than an experienced one. Full context and evidence for each
is in the handoff linked above.

This spec covers all four as one design: each fix is small, independent, and
touches only the file(s) named below. There is no shared code or sequencing
between them.

Firewall-driven additions to `verify-proxy.ps1` are out of scope here — see
`docs/honist-v/handoffs/2026-07-25-host-firewall-confinement.md`, which owns
those assertions separately.

## Fix 1: `verify-proxy.ps1` audits whichever environment you happen to be standing in

**File:** `.configamatron/proxy/verify-proxy.ps1`, "Environment & Docker" section
(current defaulting at line 25, `$EnvDir = (Get-Location).Path`).

**Problem:** The script finds *an* envoy container (container names are global)
and then compares it against `$EnvDir`'s config regardless of whether that
container was started from `$EnvDir`. Run from one checkout while a different
environment's proxy is serving, it reports failures — headlined by a
credential-token-drift message — that are entirely an artifact of comparing
mismatched environments, and it prescribes a fix ("restart the proxy") that
will not help and will interrupt a working guest.

**Fix:** After the existing "envoy container running" check locates the running
container, inspect its mounts (`docker inspect` on that container) to find the
host path it has bind-mounted as its config directory, and compare that path
against `$EnvDir\.configamatron\proxy`. If they don't match, FAIL immediately
with a message naming both the expected path (`$EnvDir\.configamatron\proxy`)
and the actual mounted path, and stating that the running Envoy belongs to a
different environment — not "restart the proxy." This check runs once, right
after "envoy container running," so a mismatch is caught before any later
check (credential comparison, live proxy behavior, VM-path checks) compares
`$EnvDir`'s config against that container's behavior.

**Validation:** Reproduce the original failure mode — run the script by
absolute path from one checkout while `run-proxy` serves a different
environment — and confirm it now FAILs with the new ownership-mismatch message
instead of the misleading token-drift message. Then confirm a matched
environment still passes cleanly (rerun from the environment `run-proxy` is
actually serving).

## Fix 2: `verify-config.sh` DNS assertions pass for the wrong reasons

**File:** `templates/vm-shared/verify-config.sh`, "Host DNS (05)" section
(lines 121 and 128).

**Problem, line 121:** `getent hosts example.com | awk '{print $1}' | head -n1`
reads the right field only because `getent hosts` lists AAAA first and the host
responder happens to answer AAAA with NOERROR and zero records, so no AAAA line
exists. The VM harness already abandoned this exact call for `ahostsv4`
(`tests/vm/vm.test.ts:119`) when its dnsmasq lacked `no-resolv` and real AAAA
answers appeared. The guest is one responder change away from the same bug.

**Fix, line 121:** Change `getent hosts example.com` to
`getent ahostsv4 example.com`, matching the fix already applied in
`tests/vm/vm.test.ts`.

**Problem, line 128:** `resolvectl dns 2>/dev/null | grep -q "$host_ip"` is a
substring match against the whole command's output. `grep -q "192.168.67.1"`
also matches `192.168.67.164` — a guest pointed at itself as resolver would
PASS this check. This is not hypothetical: `.164` is an address a guest in this
setup can actually hold.

**Fix, line 128:** Parse `resolvectl dns` output per-line and check that a
line's resolver address field equals `$host_ip` exactly (anchored match),
rather than testing whether `$host_ip` appears anywhere as a substring of the
combined output.

**Validation:** Rerun `verify-config.sh` on the Ubuntu guest and confirm both
checks still PASS for the correct reason. For line 128, additionally confirm
that a resolver value which contains `$host_ip` as a substring but isn't equal
to it (e.g. `$host_ip` with an extra trailing digit) does NOT pass — this is
the false-positive case being closed.

## Fix 3: `verify-config.ps1` has no host-IP discovery, but the docs say it does

**Files:** `templates/vm-shared-windows/verify-config.ps1` (line 17),
`usage-hyper-v.md` (line 266).

**Problem:** `usage-hyper-v.md:266` says "Omit the host IP to have the script
discover and report it from the installed config," matching what
`verify-config.sh` actually does. But `verify-config.ps1` has no discovery
branch at all — omitting `-HostIp` is a guaranteed FAIL
(`if ($HostIp) { Ok ... } else { Bad 'host IP supplied' ... }`). The sentence
in the doc covers both scripts but is only true for one.

**Fix:** Add discovery to `verify-config.ps1`, matching the `.sh` script's
shape. When `-HostIp` is omitted, discover it from the default route on the
guest's active adapter (e.g.
`Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1 -ExpandProperty NextHop`),
report it (`Ok "discovered host IP $ip from the default route"`), and use it
for the remainder of the script exactly as a supplied `-HostIp` would be used
today. If discovery finds no default route, `Bad 'host IP determinable'` with
guidance to check whether the adapter got a DHCP lease — mirroring the `.sh`
script's message for the same condition. This makes the doc's claim true
instead of correcting the claim away.

**Validation:** A Windows guest (`sus-windows`) is currently up and
`.\verify-config.ps1 192.168.67.1` passes 100% with the host IP supplied
explicitly. After adding discovery, rerun `.\verify-config.ps1` on that same
guest **with no argument** and confirm it discovers `192.168.67.1` from the
default route and still passes 100%. This is a live-guest verification, not a
read-only inference.

## Fix 4: the `pypi.org/simple/` check fails on exactly the first run

**Files:** `templates/vm-shared/verify-config.sh` (line 184),
`templates/vm-shared-windows/verify-config.ps1` (line 46), and the equivalent
check in `.configamatron/proxy/verify-proxy.ps1`.

**Problem:** `https://pypi.org/simple/` is a 44 MB document. Warm, it fetches
in ~3.4s at ~13 MB/s; a cold first fetch exceeds the 30s `--max-time` and curl
returns exit 28 (timeout) after the 200 header has already arrived — so the
failure reads `code=200 curlExit=28`, which looks like a proxy defect and is
not one. This was observed on the first run in the guest and the first run on
the host, then never again — meaning it is the run a new user performs and the
run a checkpoint records.

**Fix:** Change the URL from `https://pypi.org/simple/` to `https://pypi.org/`
in all three files. The smaller page (22 kB) still exercises the same
allow-listed-`:443`-passthrough path the check exists to validate; it no
longer needs to prove anything about the specific `/simple/` package index.
No `--max-time` values change.

**Validation:** Rerun all three verifiers' "live egress" / "live proxy
behavior" sections and confirm the pypi.org check passes on a cold run (first
invocation after guest/proxy start) as well as a warm one.

## Regression check

After all four fixes land, rerun each verifier script end-to-end (not just the
touched sections) against both the Ubuntu guest and the Windows guest
(`sus-windows`), confirming existing passes remain passes and no new failures
are introduced.

## Out of scope

- The `getent hosts` / `resolvectl` issues in the harness itself — already
  fixed there (`tests/vm/vm.test.ts`, `ahostsv4` at all four call sites).
- The credential gate contract — correct in both verifiers already, validated
  end to end on both guests at the 2026-07-24 checkpoint.
- Firewall-driven additions to `verify-proxy.ps1` — owned by
  `docs/honist-v/handoffs/2026-07-25-host-firewall-confinement.md`.
