# Design: fix four verifier script defects

**Written:** 2026-07-25
**Branch:** `host-side-dns`
**Source:** `docs/honist-v/handoffs/2026-07-25-verifier-script-defects.md`

## Problem

Three verifier scripts — `templates/proxy/verify-proxy.ps1` (copied into each
environment as `.configamatron/proxy/verify-proxy.ps1` by `src/initEnv.ts`;
that generated copy is the one actually run, but the template is the one to
edit), `templates/vm-shared/verify-config.sh`, and
`templates/vm-shared-windows/verify-config.ps1` — have four defects, found
while running the Ubuntu guest checkpoint (2026-07-24)
rather than by reading them. None broke that checkpoint. What they share is worse:
each makes a verifier **report something untrue**, in a situation a first-time user
is more likely to hit than an experienced one. Full context and evidence for each
is in the handoff linked above.

This spec covers all four as one design: each fix is small, independent, and
touches only the file(s) named below. There is no shared code or sequencing
between them.

Firewall-driven additions to `verify-proxy.ps1` are out of scope here — see
`docs/honist-v/specs/2026-07-25-host-firewall-confinement-design.md`, which owns
those assertions separately.

## Fix 1: `verify-proxy.ps1` audits whichever environment you happen to be standing in

**File:** `templates/proxy/verify-proxy.ps1` — the canonical template
(`.configamatron/proxy/verify-proxy.ps1` is a generated copy of this file,
placed there by `src/initEnv.ts`; editing the generated copy alone would not
reach new environments, so the template is the file to change).
"Environment & Docker" section (current defaulting at line 25,
`$EnvDir = (Get-Location).Path`).

**Problem:** The script finds *an* envoy container (container names are global)
and then compares it against `$EnvDir`'s config regardless of whether that
container was started from `$EnvDir`. Run from one checkout while a different
environment's proxy is serving, it reports failures — headlined by a
credential-token-drift message — that are entirely an artifact of comparing
mismatched environments, and it prescribes a fix ("restart the proxy") that
will not help and will interrupt a working guest.

**Fix:** After the existing "envoy container running" check locates the
running envoy container(s) — `docker-compose.yml` defines both
`configamatron-envoy-blue` and `configamatron-envoy-green`, and either or both
can be running during a blue/green transition, so this check runs against
every matching container, not just the first — `docker inspect` each one and
read its `.Mounts` array. Find the mount whose `Destination` is
`/etc/envoy/envoy.yaml` and `Type` is `bind` (this is the one file, among the
four bind-mounted into every envoy container, whose host-side path directly
identifies the environment it belongs to); take the parent directory of that
mount's `Source`, normalize it (resolve to a full path, trim trailing
separators, compare case-insensitively — Windows paths), and compare it
against `$EnvDir\.configamatron\proxy`, normalized the same way.

If any running container's mount doesn't match, FAIL with a message naming
the container, the expected path (`$EnvDir\.configamatron\proxy`), and the
actual mounted path found, stating that this Envoy belongs to a different
environment — not "restart the proxy" — and then **exit the script
immediately** (non-zero), skipping every remaining section. This is a
deliberate exception to the rest of the script's "record a failure and keep
going" behavior: every later section (credential comparison, live proxy
behavior, VM-path checks) assumes the running Envoy belongs to `$EnvDir`, so
once that's known false, continuing only produces more misleading output built
on the same wrong premise.

Edge cases this must handle explicitly: if `docker inspect` itself fails
(e.g. container removed between the `docker ps` and the `docker inspect`
calls), FAIL with that error rather than silently treating it as a match or a
non-match; if the expected mount is missing from a container's `.Mounts`
entirely (unexpected compose drift), FAIL with a message saying the mount
itself wasn't found, distinct from an ownership mismatch; if no envoy
container is running at all, this check does not run (nothing to check) —
the existing "envoy container running" check already FAILs that case on its
own.

**Validation:** Reproduce the original failure mode — run the script by
absolute path from one checkout while `run-proxy` serves a different
environment — and confirm it now FAILs with the new ownership-mismatch message
instead of the misleading token-drift message, and that the script exits
before reaching later sections. Then confirm a matched environment still
passes cleanly (rerun from the environment `run-proxy` is actually serving),
including the case where both blue and green containers are running for that
same environment.

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

**Fix, line 128:** `resolvectl dns` output has lines like
`Global: 192.168.67.1` or `Link 2 (eth0): 192.168.67.1 8.8.8.8` — a prefix
before a colon, then one or more whitespace-separated server addresses. Parse
each line, split off everything after the colon, tokenize on whitespace, and
check whether `$host_ip` equals one of those tokens exactly — not whether
`$host_ip` appears as a substring anywhere in a token or in the line.

**Validation:** Rerun `verify-config.sh` on the Ubuntu guest and confirm both
checks still PASS for the correct reason. For line 121, add a fixture (or
confirm against a responder configured this way) where a real AAAA record
precedes the A record in `getent`'s output, and confirm the check still reads
the A address correctly — this is the actual scenario `ahostsv4` exists to
handle, not just the substring case. For line 128, confirm two cases: a
resolver value that contains `$host_ip` as a substring but isn't equal to it
(e.g. `$host_ip` with an extra trailing digit) does NOT pass, and a
`resolvectl dns` line carrying multiple server tokens (e.g.
`Link 2 (eth0): 192.168.67.1 8.8.8.8`) still matches correctly on the
whitespace-tokenized value, not the raw line.

## Fix 3: `verify-config.ps1` has no host-IP discovery, but the docs say it does

**Files:** `templates/vm-shared-windows/verify-config.ps1` (line 17),
`usage-hyper-v.md` (line 266).

**Problem:** `usage-hyper-v.md:266` says "Omit the host IP to have the script
discover and report it from the installed config," matching what
`verify-config.sh` actually does. But `verify-config.ps1` has no discovery
branch at all — omitting `-HostIp` is a guaranteed FAIL
(`if ($HostIp) { Ok ... } else { Bad 'host IP supplied' ... }`). The sentence
in the doc covers both scripts but is only true for one.

**Fix:** Add discovery to `verify-config.ps1`, but base it on the DHCP-assigned
DNS server rather than the default route. The script already calls
`Get-DnsClientServerAddress -AddressFamily IPv4` for the "resolver points at
the host" check a few lines below, and on this branch (`host-side-dns`) the
host serves both DNS and gateway from the same address by design — so that
call is already a trustworthy source for "what is the host IP," and reusing
it avoids the reliability problems of picking a "best" default route (Windows
selects among multiple candidate default routes by combined route + interface
metric, not by enumeration order, so a naive `Get-NetRoute | Select-Object
-First 1` can silently pick the wrong one whenever more than one exists — a
VPN adapter, a stale route, etc.).

When `-HostIp` is omitted: call `Get-DnsClientServerAddress -AddressFamily
IPv4`, collect the unique non-empty server addresses. If there is exactly
one, use it as the discovered host IP and report it
(`Ok "discovered host IP $ip from the DHCP-assigned DNS server"`); use it for
the remainder of the script exactly as a supplied `-HostIp` would be used
today. If there are zero or more than one, `Bad 'host IP determinable'` with
guidance to pass `-HostIp` explicitly (zero: no DNS server configured, ambiguous
adapter state; more than one: cannot pick a single host IP with confidence).

This also resolves a consistency gap the review raised: the script's header
comment says a supplied `-HostIp` is "asserted to match" the config, but today
that assertion only ever checks against the DNS server list
(`$dnsServers -contains $HostIp`, line 29) — it never touches the default
route at all. Making discovery DNS-based means discovery and the
supplied-`-HostIp` assertion now use the same signal, closing that gap without
adding a second, redundant route-based assertion.

**Validation:** A Windows guest (`sus-windows`) is currently up and
`.\verify-config.ps1 192.168.67.1` passes 100% with the host IP supplied
explicitly. After adding discovery, rerun `.\verify-config.ps1` on that same
guest **with no argument** and confirm it discovers `192.168.67.1` from the
DNS server address and still passes 100%. This is a live-guest verification,
not a read-only inference.

## Fix 4: the `pypi.org/simple/` check fails on exactly the first run

**Files:** `templates/vm-shared/verify-config.sh` (line 184),
`templates/vm-shared-windows/verify-config.ps1` (line 46), and the equivalent
check in `templates/proxy/verify-proxy.ps1` (the canonical template — see Fix
1 on why the generated `.configamatron/proxy/verify-proxy.ps1` copy is not the
file to edit).

**Problem:** `https://pypi.org/simple/` is a 44 MB document. Warm, it fetches
in ~3.4s at ~13 MB/s; a cold first fetch exceeds the 30s `--max-time` and curl
returns exit 28 (timeout) after the 200 header has already arrived — so the
failure reads `code=200 curlExit=28`, which looks like a proxy defect and is
not one. This was observed on the first run in the guest and the first run on
the host, then never again — meaning it is the run a new user performs and the
run a checkpoint records.

Separately, the Windows guest verifier's `HttpCode` helper
(`templates/vm-shared-windows/verify-config.ps1`) only returns curl's printed
status code — its caller never checks `$LASTEXITCODE`. So today, a timed-out
transfer that had already printed `200` before timing out would read as a
PASS on the Windows guest, not the `code=200 curlExit=28` failure described
above. That's a second, smaller defect in the same check: the Windows
verifier's pass condition doesn't actually require the request to have
succeeded, only that a `<400` status was printed before it (possibly)
timed out.

**Fix:** Change the URL from `https://pypi.org/simple/` to `https://pypi.org/`
in all three files. The smaller page (22 kB) still exercises the same
allow-listed-`:443`-passthrough path the check exists to validate; it no
longer needs to prove anything about the specific `/simple/` package index.
No `--max-time` values change. Additionally, fix the Windows `HttpCode` helper
(or its call site) to also capture and assert `$LASTEXITCODE -eq 0` for this
check, so a partial/timed-out transfer can no longer read as a pass on
Windows — matching what the `.sh` script already does today by chaining
`curl_code ... &&` before treating the result as a pass.

**Validation:** Rerun all three verifiers' "live egress" / "live proxy
behavior" sections and confirm the pypi.org check passes, on all three,
asserting both the status code and (for the Windows check) a zero curl exit
code. A deliberately cold run isn't a meaningful extra step here — restarting
the guest or proxy doesn't reliably clear the caches involved (PyPI/CDN, host
DNS, network), so it wouldn't reproduce the original cold/warm distinction on
demand. The point of switching the URL is to remove the timeout risk
entirely regardless of cache state, so a normal rerun plus the added exit-code
assertion is the validation, not an attempt to engineer a cold cache.

## Regression check

After all four fixes land, rerun each verifier script end-to-end (not just the
touched sections) in its applicable environment — `verify-proxy.ps1` on the
Windows host, `verify-config.sh` on the Ubuntu guest, `verify-config.ps1` on
the Windows guest (`sus-windows`) — confirming existing passes remain passes
and no new failures are introduced. (The three scripts are platform-specific;
none of them runs against more than one of these environments.)

## Out of scope

- The `getent hosts` / `resolvectl` issues in the harness itself — already
  fixed there (`tests/vm/vm.test.ts`, `ahostsv4` at all four call sites).
- The credential gate contract — correct in both verifiers already, validated
  end to end on both guests at the 2026-07-24 checkpoint.
- Firewall-driven additions to `verify-proxy.ps1` — owned by
  `docs/honist-v/specs/2026-07-25-host-firewall-confinement-design.md`.
